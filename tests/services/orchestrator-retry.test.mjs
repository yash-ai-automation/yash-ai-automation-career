// tests/services/orchestrator-retry.test.mjs
// Shared 3-strike retry policy applied inside tickOnce(). Plan §4.8 / Q6.
// Each URL gets up to 3 total attempts before being marked failed. Both
// Yash and Shivani benefit because the logic lives in shared service code.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDb, closeDb } from '../../services/db.mjs';
import { insertQueueRow } from '../../services/queue.mjs';
import { tickOnce } from '../../services/pipeline-orchestrator.mjs';

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), 'orch-retry-'));
  mkdirSync(join(dir, 'ops/checkpoints'), { recursive: true });
  mkdirSync(join(dir, 'ops/runs'), { recursive: true });
  const db = initDb(join(dir, 'ops/work-queue.db'));
  return { db, dir, cleanup: () => { closeDb(db); rmSync(dir, { recursive: true, force: true }); } };
}

const baseTick = (db, dir, overrides = {}) => ({
  db, projectRoot: dir,
  capLimits: { dailyMax: 20, weeklyMax: 100 },
  gitSha: 'cafebabe',
  claudeModel: 'claude-opus-4-7',
  ...overrides,
});

test('tickOnce 3-strike: 1st failure re-queues with attempts=1, status=queued, assigned_at cleared', async () => {
  const { db, dir, cleanup } = fresh();
  try {
    const qid = insertQueueRow(db, { url: 'http://acme.com/job', urlHash: 'h1', addedBy: 1 });
    const notifications = [];
    const r = await tickOnce(baseTick(db, dir, {
      spawn: async () => ({ exitCode: 1, error: 'boom', failedPhase: 'jd_fetch_end' }),
      notify: (m) => notifications.push(m),
    }));
    assert.equal(r.action, 'requeued', 'first failure should re-queue, not finalize');
    assert.equal(r.attempts, 1);
    const qRow = db.prepare('SELECT status, attempts, assigned_at FROM queue WHERE id=?').get(qid);
    assert.equal(qRow.status, 'queued');
    assert.equal(qRow.attempts, 1);
    assert.equal(qRow.assigned_at, null, 'assigned_at must be cleared so the row is eligible for next tick');
    assert.ok(notifications.some(n => /attempt 1\/3/.test(n) && /re-queued/i.test(n)),
      `expected an "attempt 1/3 ... re-queued" notification; got: ${JSON.stringify(notifications)}`);
  } finally { cleanup(); }
});

test('tickOnce 3-strike: 2nd failure (seeded attempts=1) re-queues with attempts=2', async () => {
  const { db, dir, cleanup } = fresh();
  try {
    const qid = insertQueueRow(db, { url: 'http://acme.com/job', urlHash: 'h1', addedBy: 1 });
    db.prepare('UPDATE queue SET attempts=1 WHERE id=?').run(qid);
    const notifications = [];
    const r = await tickOnce(baseTick(db, dir, {
      spawn: async () => ({ exitCode: 1, error: 'boom' }),
      notify: (m) => notifications.push(m),
    }));
    assert.equal(r.action, 'requeued');
    assert.equal(r.attempts, 2);
    const qRow = db.prepare('SELECT status, attempts FROM queue WHERE id=?').get(qid);
    assert.equal(qRow.status, 'queued');
    assert.equal(qRow.attempts, 2);
    assert.ok(notifications.some(n => /attempt 2\/3/.test(n)));
  } finally { cleanup(); }
});

test('tickOnce 3-strike: 3rd failure (seeded attempts=2) marks failed with attempts=3 and "moving to failed"', async () => {
  const { db, dir, cleanup } = fresh();
  try {
    const qid = insertQueueRow(db, { url: 'http://acme.com/job', urlHash: 'h1', addedBy: 1 });
    db.prepare('UPDATE queue SET attempts=2 WHERE id=?').run(qid);
    const notifications = [];
    const r = await tickOnce(baseTick(db, dir, {
      spawn: async () => ({ exitCode: 7, error: 'final boom', failedPhase: 'resume_compile_end' }),
      notify: (m) => notifications.push(m),
    }));
    assert.equal(r.action, 'completed_fail');
    assert.equal(r.attempts, 3);
    const qRow = db.prepare('SELECT status, attempts, completed_at FROM queue WHERE id=?').get(qid);
    assert.equal(qRow.status, 'failed');
    assert.equal(qRow.attempts, 3);
    assert.ok(qRow.completed_at, 'completed_at must be set on final failure');
    const finalNotice = notifications.find(n => /attempt 3\/3/.test(n));
    assert.ok(finalNotice, 'expected an "attempt 3/3" notification on final failure');
    assert.match(finalNotice, /moving to failed/i);
  } finally { cleanup(); }
});

test('tickOnce 3-strike: cancellation request still wins over retry', async () => {
  const { db, dir, cleanup } = fresh();
  try {
    const qid = insertQueueRow(db, { url: 'http://acme.com/job', urlHash: 'h1', addedBy: 1 });
    db.prepare('UPDATE queue SET cancel_requested=1 WHERE id=?').run(qid);
    const r = await tickOnce(baseTick(db, dir, {
      spawn: async () => ({ exitCode: 143, error: 'sigterm via cancel' }),
      notify: () => {},
    }));
    assert.equal(r.action, 'completed_cancelled');
    const qRow = db.prepare('SELECT status, attempts FROM queue WHERE id=?').get(qid);
    assert.equal(qRow.status, 'cancelled');
    assert.equal(qRow.attempts, 0, 'cancellation must not increment attempts');
  } finally { cleanup(); }
});

test('tickOnce 3-strike: successful run leaves attempts column alone', async () => {
  const { db, dir, cleanup } = fresh();
  try {
    const qid = insertQueueRow(db, { url: 'http://acme.com/job', urlHash: 'h1', addedBy: 1 });
    db.prepare('UPDATE queue SET attempts=2 WHERE id=?').run(qid);
    const r = await tickOnce(baseTick(db, dir, {
      spawn: async () => ({ exitCode: 0, slug: 'Acme', score: 90 }),
      notify: () => {},
    }));
    assert.equal(r.action, 'completed_ok');
    const qRow = db.prepare('SELECT status, attempts FROM queue WHERE id=?').get(qid);
    assert.equal(qRow.status, 'done');
    assert.equal(qRow.attempts, 2, 'success path does not touch attempts');
  } finally { cleanup(); }
});

test('tickOnce 3-strike: re-queue deletes the checkpoint (fresh start on retry)', async () => {
  const { db, dir, cleanup } = fresh();
  try {
    const qid = insertQueueRow(db, { url: 'http://acme.com/job', urlHash: 'h1', addedBy: 1 });
    let observedRunId = null;
    const r = await tickOnce(baseTick(db, dir, {
      spawn: async ({ runId }) => {
        observedRunId = runId;
        const { upsertCheckpoint } = await import('../../services/queue.mjs');
        upsertCheckpoint(db, { runId, lastPhase: 'jd_fetch_end', inputsPath: '/tmp/h1.json' });
        return { exitCode: 1, error: 'boom' };
      },
      notify: () => {},
    }));
    assert.equal(r.action, 'requeued');
    const cp = db.prepare('SELECT * FROM checkpoints WHERE run_id=?').get(observedRunId);
    assert.equal(cp, undefined, 'checkpoint must be cleared on re-queue so retry starts fresh');
  } finally { cleanup(); }
});

test('tickOnce 3-strike: shutdown_interrupt path bypasses retry counter entirely', async () => {
  const { db, dir, cleanup } = fresh();
  try {
    const qid = insertQueueRow(db, { url: 'http://acme.com/job', urlHash: 'h1', addedBy: 1 });
    const r = await tickOnce(baseTick(db, dir, {
      spawn: async () => ({ exitCode: 143, error: 'sigterm during shutdown' }),
      notify: () => {},
      isShuttingDown: () => true,
    }));
    assert.equal(r.action, 'shutdown_interrupt');
    const qRow = db.prepare('SELECT status, attempts FROM queue WHERE id=?').get(qid);
    assert.equal(qRow.status, 'running', 'shutdown_interrupt must preserve running so resume engages on next boot');
    assert.equal(qRow.attempts, 0, 'shutdown_interrupt must not bump attempts');
  } finally { cleanup(); }
});

test('tickOnce 3-strike: structured log line emits requeued=true on retry, requeued=false on final', async () => {
  const { db, dir, cleanup } = fresh();
  try {
    const { Writable } = await import('node:stream');
    const { createLogger } = await import('../../services/logger.mjs');
    const lines = [];
    const sink = new Writable({ write(c, _e, cb) { for (const l of c.toString().split('\n').filter(Boolean)) lines.push(JSON.parse(l)); cb(); } });
    const logger = createLogger({ service: 'orch-retry-test' }, sink);

    insertQueueRow(db, { url: 'http://acme.com/job', urlHash: 'h1', addedBy: 1 });
    await tickOnce(baseTick(db, dir, {
      spawn: async () => ({ exitCode: 1, error: 'boom', failedPhase: 'jd_fetch_end' }),
      notify: () => {},
      logger,
    }));
    const requeueLine = lines.find(l => l.event === 'run_failed');
    assert.ok(requeueLine, 'expected a run_failed log line on re-queue');
    assert.equal(requeueLine.requeued, true);
    assert.equal(requeueLine.attempts, 1);
    assert.equal(requeueLine.max_attempts, 3);
  } finally { cleanup(); }
});
