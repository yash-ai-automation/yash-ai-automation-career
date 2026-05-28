// tests/services/cap.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDb, closeDb } from '../../services/db.mjs';
import {
  insertQueueRow, markQueueRunning, insertRun, updateRunEnd,
  markQueueDone, markQueueFailed, markQueueCancelled, markQueueDedupSkipped,
} from '../../services/queue.mjs';
import { checkCap } from '../../services/cap.mjs';

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), 'yash-cap-'));
  const db = initDb(join(dir, 'c.db'));
  return { db, cleanup: () => { closeDb(db); rmSync(dir, { recursive: true, force: true }); } };
}

function addCompletedRun(db, url, status = 'ok') {
  const qid = insertQueueRow(db, { url, urlHash: url, addedBy: 1 });
  markQueueRunning(db, qid);
  const rid = insertRun(db, { queueId: qid, url, startedAt: new Date().toISOString() });
  updateRunEnd(db, rid, { status });
  // Transition queue row out of 'running' so the single-running invariant is satisfied
  if (status === 'ok') markQueueDone(db, qid);
  else if (status === 'fail') markQueueFailed(db, qid);
  else if (status === 'cancelled') markQueueCancelled(db, qid);
  else if (status === 'dedup_skipped') markQueueDedupSkipped(db, qid);
}

test('checkCap clear under daily and weekly limits', () => {
  const { db, cleanup } = fresh();
  try {
    for (let i = 0; i < 5; i++) addCompletedRun(db, `http://x${i}`);
    const r = checkCap(db, { dailyMax: 20, weeklyMax: 100 });
    assert.deepEqual(r, { capped: false });
  } finally { cleanup(); }
});

test('checkCap returns daily reason when daily reached', () => {
  const { db, cleanup } = fresh();
  try {
    for (let i = 0; i < 20; i++) addCompletedRun(db, `http://x${i}`);
    const r = checkCap(db, { dailyMax: 20, weeklyMax: 100 });
    assert.equal(r.capped, true);
    assert.equal(r.reason, 'daily');
  } finally { cleanup(); }
});

test('checkCap excludes cancelled and dedup_skipped from counter', () => {
  const { db, cleanup } = fresh();
  try {
    for (let i = 0; i < 19; i++) addCompletedRun(db, `http://x${i}`);
    // 19 ok; one cancelled — should NOT push us to 20
    const qid = insertQueueRow(db, { url: 'http://c', urlHash: 'http://c', addedBy: 1 });
    markQueueRunning(db, qid);
    const rid = insertRun(db, { queueId: qid, url: 'http://c', startedAt: new Date().toISOString() });
    updateRunEnd(db, rid, { status: 'cancelled' });
    markQueueCancelled(db, qid);
    const r = checkCap(db, { dailyMax: 20, weeklyMax: 100 });
    assert.equal(r.capped, false, 'cancelled run should not count toward cap');
  } finally { cleanup(); }
});

test('checkCap default daily=50 / weekly=250 when no limits and no env', () => {
  const prevDaily = process.env.CAP_DAILY_MAX;
  const prevWeekly = process.env.CAP_WEEKLY_MAX;
  delete process.env.CAP_DAILY_MAX;
  delete process.env.CAP_WEEKLY_MAX;
  const { db, cleanup } = fresh();
  try {
    for (let i = 0; i < 49; i++) addCompletedRun(db, `http://x${i}`);
    let r = checkCap(db);
    assert.equal(r.capped, false, '49 runs < default daily=50');
    addCompletedRun(db, 'http://x49');
    r = checkCap(db);
    assert.equal(r.capped, true);
    assert.equal(r.reason, 'daily');
    assert.equal(r.limit, 50);
  } finally {
    cleanup();
    if (prevDaily !== undefined) process.env.CAP_DAILY_MAX = prevDaily;
    if (prevWeekly !== undefined) process.env.CAP_WEEKLY_MAX = prevWeekly;
  }
});

test('checkCap: CAP_DAILY_MAX env overrides caller limits', () => {
  const prev = process.env.CAP_DAILY_MAX;
  process.env.CAP_DAILY_MAX = '3';
  const { db, cleanup } = fresh();
  try {
    for (let i = 0; i < 3; i++) addCompletedRun(db, `http://x${i}`);
    // Caller passes dailyMax: 100, but env=3 wins → capped
    const r = checkCap(db, { dailyMax: 100, weeklyMax: 1000 });
    assert.equal(r.capped, true);
    assert.equal(r.reason, 'daily');
    assert.equal(r.limit, 3);
  } finally {
    cleanup();
    if (prev === undefined) delete process.env.CAP_DAILY_MAX;
    else process.env.CAP_DAILY_MAX = prev;
  }
});

test('checkCap: CAP_WEEKLY_MAX env overrides caller limits', () => {
  const prev = process.env.CAP_WEEKLY_MAX;
  process.env.CAP_WEEKLY_MAX = '2';
  const { db, cleanup } = fresh();
  try {
    for (let i = 0; i < 2; i++) addCompletedRun(db, `http://x${i}`);
    const r = checkCap(db, { dailyMax: 100, weeklyMax: 100 });
    assert.equal(r.capped, true);
    assert.equal(r.reason, 'weekly');
    assert.equal(r.limit, 2);
  } finally {
    cleanup();
    if (prev === undefined) delete process.env.CAP_WEEKLY_MAX;
    else process.env.CAP_WEEKLY_MAX = prev;
  }
});

test('checkCap: empty-string env var falls back to caller-provided limit', () => {
  const prev = process.env.CAP_DAILY_MAX;
  process.env.CAP_DAILY_MAX = '';
  const { db, cleanup } = fresh();
  try {
    for (let i = 0; i < 20; i++) addCompletedRun(db, `http://x${i}`);
    const r = checkCap(db, { dailyMax: 20, weeklyMax: 100 });
    assert.equal(r.capped, true);
    assert.equal(r.limit, 20, 'caller value used, not 0 from empty env');
  } finally {
    cleanup();
    if (prev === undefined) delete process.env.CAP_DAILY_MAX;
    else process.env.CAP_DAILY_MAX = prev;
  }
});

test('checkCap: rate_limited status does NOT count toward cap', () => {
  const { db, cleanup } = fresh();
  try {
    // Cap at 2 daily. Insert 5 rate_limited runs — none should count.
    // We mimic the orchestrator's actual flow: mark running, insert run with
    // status='rate_limited', then flip queue back to 'queued' (the orchestrator
    // re-queues the URL without consuming an attempt).
    for (let i = 0; i < 5; i++) {
      const qid = insertQueueRow(db, { url: `http://rl${i}`, urlHash: `http://rl${i}`, addedBy: 1 });
      markQueueRunning(db, qid);
      const rid = insertRun(db, { queueId: qid, url: `http://rl${i}`, startedAt: new Date().toISOString() });
      updateRunEnd(db, rid, { status: 'rate_limited', error: 'usage-limit detected' });
      // Flip queue back to 'queued' to satisfy the single-running invariant
      // (the real orchestrator's rate-limit branch does this same UPDATE).
      db.prepare(`UPDATE queue SET status='queued', assigned_at=NULL WHERE id=?`).run(qid);
    }
    const r = checkCap(db, { dailyMax: 2, weeklyMax: 100 });
    assert.equal(r.capped, false, 'rate_limited runs should be invisible to the cap counter');
  } finally { cleanup(); }
});
