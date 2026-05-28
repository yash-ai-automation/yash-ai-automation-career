// tests/services/orchestrator-rate-limit.test.mjs
// End-to-end test for the rate-limit auto-recovery branch in tickOnce.
//
// Verifies, with a fake spawn returning rateLimitHit=true:
//   1. state file is written (resetAt persisted, atomic rename)
//   2. queue row flips back to 'queued' with attempts unchanged
//   3. runs row is written with status='rate_limited' (NOT 'fail')
//   4. the cap-checking primitive treats rate_limited as zero-cost
//   5. the very next tickOnce returns action='rate_limit_paused' and does
//      NOT call spawn() (the fake throws if invoked)
//   6. after the resetAt elapses, the next tick clears the state file,
//      unpauses queue rows, emits the "resumed" notify, and proceeds to spawn

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { initDb, closeDb } from '../../services/db.mjs';
import { insertQueueRow, countByStatus } from '../../services/queue.mjs';
import { checkCap } from '../../services/cap.mjs';
import { tickOnce } from '../../services/pipeline-orchestrator.mjs';
import {
  readState, writeState, clearState, RATE_LIMIT_STATE_PATH,
} from '../../services/rate-limit.mjs';
import { createNotifyDedup } from '../../services/notify-dedup.mjs';

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), 'yash-rl-'));
  mkdirSync(join(dir, 'ops/checkpoints'), { recursive: true });
  mkdirSync(join(dir, 'ops/runs'), { recursive: true });
  const db = initDb(join(dir, 'ops/work-queue.db'));
  const stateDir = mkdtempSync(join(tmpdir(), 'yash-rl-state-'));
  const statePath = join(stateDir, 'rate-limit.json');
  return {
    db, dir, statePath,
    cleanup: () => {
      closeDb(db);
      rmSync(dir, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    },
  };
}

test('tickOnce: rate-limit hit writes state file, re-queues row without attempt bump, runs.status=rate_limited', async () => {
  const { db, dir, statePath, cleanup } = fresh();
  try {
    const qid = insertQueueRow(db, { url: 'http://x.com/job', urlHash: 'h1', addedBy: 1 });
    const notifications = [];
    const resetAt = new Date(Date.now() + 3_600_000); // 1h from now

    const r = await tickOnce({
      db, projectRoot: dir,
      gitSha: 'cafebabe',
      claudeModel: 'claude-sonnet-4-6',
      spawn: async () => ({
        exitCode: 1,
        error: 'claude -p exit 1 signal none',
        failedPhase: 'jd_fetch_end',
        rateLimitHit: true,
        rateLimitResetAt: resetAt,
      }),
      notify: (msg) => notifications.push(msg),
      notifyDedup: createNotifyDedup(),
      rateLimitStatePath: statePath,
    });

    assert.equal(r.action, 'rate_limited');
    // State file written + parseable
    assert.equal(existsSync(statePath), true, 'rate-limit state file should exist');
    const state = readState(statePath);
    assert.ok(state, 'state should parse');
    assert.equal(state.resetAt.toISOString(), resetAt.toISOString());
    assert.equal(state.reason, 'claude-cli usage limit');
    // Queue row back to 'queued' with attempts unchanged (still 0)
    const queueRow = db.prepare('SELECT status, attempts FROM queue WHERE id=?').get(qid);
    assert.equal(queueRow.status, 'queued');
    assert.equal(queueRow.attempts, 0, 'rate-limit retry should NOT consume an attempt');
    // Runs row has status='rate_limited'
    const runRow = db.prepare(`SELECT status, error FROM runs WHERE queue_id=? ORDER BY id DESC LIMIT 1`).get(qid);
    assert.equal(runRow.status, 'rate_limited');
    assert.match(runRow.error, /usage limit/i);
    // User notified with the pause message
    assert.ok(notifications.some(n => /⏸️/.test(n) && /paused/.test(n)), 'expected rate-limit pause notification');
  } finally { cleanup(); }
});

test('tickOnce: rate_limited runs do NOT consume cap budget', async () => {
  const { db, dir, statePath, cleanup } = fresh();
  try {
    insertQueueRow(db, { url: 'http://x.com/a', urlHash: 'h1', addedBy: 1 });
    await tickOnce({
      db, projectRoot: dir,
      gitSha: 's', claudeModel: 'm',
      spawn: async () => ({
        exitCode: 1, error: 'x', rateLimitHit: true,
        rateLimitResetAt: new Date(Date.now() + 60_000),
      }),
      notify: () => {},
      notifyDedup: createNotifyDedup(),
      rateLimitStatePath: statePath,
    });
    // 1 run exists with status='rate_limited'; cap counter sees 0
    const cap = checkCap(db, { dailyMax: 1, weeklyMax: 100 });
    assert.equal(cap.capped, false);
    const allRuns = countByStatus(db, ['ok', 'fail', 'rate_limited'], 'day');
    assert.equal(allRuns, 1, 'one rate_limited run is in the table');
  } finally { cleanup(); }
});

test('tickOnce: next tick after rate-limit reads state file and returns paused without spawning', async () => {
  const { db, dir, statePath, cleanup } = fresh();
  try {
    insertQueueRow(db, { url: 'http://x.com/job', urlHash: 'h1', addedBy: 1 });
    // Pre-seed state file with a future resetAt (no spawn needed)
    writeState(statePath, {
      resetAt: new Date(Date.now() + 60 * 60 * 1000),
      reason: 'manual seed',
      setBy: 'test',
    });
    const dedup = createNotifyDedup();
    const notifications = [];

    const r = await tickOnce({
      db, projectRoot: dir,
      gitSha: 's', claudeModel: 'm',
      spawn: async () => { throw new Error('spawn should NOT be called during pause'); },
      notify: (msg) => notifications.push(msg),
      notifyDedup: dedup,
      rateLimitStatePath: statePath,
    });

    assert.equal(r.action, 'rate_limit_paused');
    assert.ok(notifications.length >= 1, 'first paused tick should notify');
    assert.match(notifications[0], /⏸️/);
    // The queue row should still be queued
    const queueRow = db.prepare('SELECT status FROM queue WHERE id=1').get();
    assert.equal(queueRow.status, 'queued');
  } finally { cleanup(); }
});

test('tickOnce: notify-dedup suppresses repeated pause messages within window', async () => {
  const { db, dir, statePath, cleanup } = fresh();
  try {
    insertQueueRow(db, { url: 'http://x.com/job', urlHash: 'h1', addedBy: 1 });
    writeState(statePath, {
      resetAt: new Date(Date.now() + 60 * 60 * 1000),
      reason: 'seed',
      setBy: 'test',
    });
    const dedup = createNotifyDedup();
    const notifications = [];
    const args = {
      db, projectRoot: dir, gitSha: 's', claudeModel: 'm',
      spawn: async () => { throw new Error('no spawn'); },
      notify: (msg) => notifications.push(msg),
      notifyDedup: dedup,
      rateLimitStatePath: statePath,
    };
    // 3 ticks in a row → only 1 user-facing pause message
    await tickOnce(args);
    await tickOnce(args);
    await tickOnce(args);
    const pauseMsgs = notifications.filter(n => /⏸️.*paused/.test(n));
    assert.equal(pauseMsgs.length, 1, `expected 1 pause msg across 3 ticks, got ${pauseMsgs.length}`);
  } finally { cleanup(); }
});

test('tickOnce: after resetAt elapses, state is cleared + resume notification + normal flow resumes', async () => {
  const { db, dir, statePath, cleanup } = fresh();
  try {
    insertQueueRow(db, { url: 'http://x.com/job', urlHash: 'h1', addedBy: 1 });
    // Pre-seed state with a PAST resetAt (window already elapsed)
    writeState(statePath, {
      resetAt: new Date(Date.now() - 1000),
      reason: 'expired window',
      setBy: 'test',
    });
    const dedup = createNotifyDedup();
    const notifications = [];

    // Lay down fake artifacts so the success path closes cleanly
    mkdirSync(join(dir, 'jds/yash'), { recursive: true });
    mkdirSync(join(dir, 'resumes/yash'), { recursive: true });
    mkdirSync(join(dir, 'cover-letters/yash'), { recursive: true });
    writeFileSync(join(dir, 'jds/yash/x.md'), '# fake');
    writeFileSync(join(dir, 'resumes/yash/x.pdf'), '%PDF');
    writeFileSync(join(dir, 'cover-letters/yash/x.pdf'), '%PDF');

    const r = await tickOnce({
      db, projectRoot: dir,
      gitSha: 's', claudeModel: 'm',
      spawn: async () => ({
        exitCode: 0, durationMs: 100, slug: 'x', score: 90,
        jdPath: join(dir, 'jds/yash/x.md'),
        resumePdf: join(dir, 'resumes/yash/x.pdf'),
        coverLetterPdf: join(dir, 'cover-letters/yash/x.pdf'),
      }),
      notify: (msg) => notifications.push(msg),
      notifyDedup: dedup,
      rateLimitStatePath: statePath,
    });

    assert.equal(r.action, 'completed_ok', 'normal flow should resume after window elapsed');
    // State file removed
    assert.equal(existsSync(statePath), false, 'state file should be cleared after window elapses');
    // Resume notification emitted
    assert.ok(notifications.some(n => /▶️/.test(n) && /resuming/.test(n)),
      'expected resume notification');
  } finally { cleanup(); }
});

test('tickOnce: rate-limit without resetAt hint falls back to defaultResetAt (~5h)', async () => {
  const { db, dir, statePath, cleanup } = fresh();
  try {
    insertQueueRow(db, { url: 'http://x.com/job', urlHash: 'h1', addedBy: 1 });

    const t0 = Date.now();
    await tickOnce({
      db, projectRoot: dir,
      gitSha: 's', claudeModel: 'm',
      spawn: async () => ({
        exitCode: 1, error: 'x',
        rateLimitHit: true,
        rateLimitResetAt: null, // no hint parsed
      }),
      notify: () => {},
      notifyDedup: createNotifyDedup(),
      rateLimitStatePath: statePath,
    });
    const state = readState(statePath);
    assert.ok(state);
    const offsetMs = state.resetAt.getTime() - t0;
    // Allow ±10s slop for clock drift / test scheduling
    assert.ok(offsetMs > 5 * 3600 * 1000 - 10_000 && offsetMs < 5 * 3600 * 1000 + 10_000,
      `expected resetAt ≈ +5h from now, got +${(offsetMs / 1000).toFixed(0)}s`);
  } finally { cleanup(); }
});
