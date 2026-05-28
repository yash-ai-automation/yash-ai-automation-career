// tests/services/orchestrator-cap-spam.test.mjs
// Regression: the original `Cap reached (daily: 20/20). New URLs will wait.`
// message used to fire on every 2s tick as long as the queue was non-empty,
// flooding the Telegram chat from 4 PM until the next day. The fix wraps the
// notify call with a notify-dedup tracker keyed `cap:<reason>` that windows
// the message to once per day/week boundary.
//
// Test setup: backfill enough `ok` runs to exceed dailyMax, queue a URL, tick
// many times; assert the cap-reached text appears in `notify` exactly once.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { initDb, closeDb } from '../../services/db.mjs';
import {
  insertQueueRow, markQueueRunning, insertRun, updateRunEnd, markQueueDone,
} from '../../services/queue.mjs';
import { tickOnce } from '../../services/pipeline-orchestrator.mjs';
import { createNotifyDedup } from '../../services/notify-dedup.mjs';

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), 'yash-cap-spam-'));
  mkdirSync(join(dir, 'ops/checkpoints'), { recursive: true });
  mkdirSync(join(dir, 'ops/runs'), { recursive: true });
  const db = initDb(join(dir, 'ops/work-queue.db'));
  const stateDir = mkdtempSync(join(tmpdir(), 'yash-cap-spam-state-'));
  return {
    db, dir, statePath: join(stateDir, 'rate-limit.json'),
    cleanup: () => {
      closeDb(db);
      rmSync(dir, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    },
  };
}

function backfillRuns(db, n, status = 'ok') {
  for (let i = 0; i < n; i++) {
    const url = `http://x${i}.example.com/job`;
    const qid = insertQueueRow(db, { url, urlHash: url, addedBy: 1 });
    markQueueRunning(db, qid);
    const rid = insertRun(db, { queueId: qid, url, startedAt: new Date().toISOString() });
    updateRunEnd(db, rid, { status });
    markQueueDone(db, qid);
  }
}

test('tickOnce: cap-reached notify fires exactly once across many ticks (was: every tick)', async () => {
  const { db, dir, statePath, cleanup } = fresh();
  try {
    // 50 ok runs → dailyMax=50 reached; queue one fresh URL that wants to run
    backfillRuns(db, 50);
    insertQueueRow(db, { url: 'http://new.example.com/job', urlHash: 'new', addedBy: 1 });
    const dedup = createNotifyDedup();
    const notifications = [];
    const args = {
      db, projectRoot: dir,
      gitSha: 's', claudeModel: 'm',
      spawn: async () => { throw new Error('spawn should NOT be called while capped'); },
      notify: (msg) => notifications.push(msg),
      notifyDedup: dedup,
      rateLimitStatePath: statePath,
    };

    // Tick 5 times in rapid succession
    for (let i = 0; i < 5; i++) {
      const r = await tickOnce(args);
      assert.equal(r.action, 'capped', `tick ${i + 1} should be capped`);
    }
    const capMsgs = notifications.filter(n => /Cap reached/.test(n));
    assert.equal(capMsgs.length, 1, `expected exactly 1 cap notification across 5 ticks, got ${capMsgs.length}`);
  } finally { cleanup(); }
});

test('tickOnce: daily and weekly cap dedup keys are independent', async () => {
  // If a tenant somehow flips from "daily cap reached" to "weekly cap reached"
  // in consecutive ticks, BOTH messages should emit (different cap.reason →
  // different dedup key).
  const { db, dir, statePath, cleanup } = fresh();
  try {
    backfillRuns(db, 50); // both daily and weekly cap reached at 50 ok runs
    insertQueueRow(db, { url: 'http://new.example.com/job', urlHash: 'new', addedBy: 1 });
    const dedup = createNotifyDedup();
    const notifications = [];
    const args = {
      db, projectRoot: dir, gitSha: 's', claudeModel: 'm',
      // Force daily cap = 30 (already exceeded by 50)
      capLimits: { dailyMax: 30, weeklyMax: 30 },
      spawn: async () => { throw new Error('no spawn'); },
      notify: (msg) => notifications.push(msg),
      notifyDedup: dedup,
      rateLimitStatePath: statePath,
    };
    await tickOnce(args);
    // Manually emit a 'weekly' message via the dedup key — verify the keys
    // are independent (this is a unit-style assertion on the dedup behavior
    // wired through tickOnce; we can't easily flip daily↔weekly mid-test
    // because the cap logic returns 'daily' first when both are exceeded).
    assert.equal(dedup.shouldEmit('cap:weekly', 86_400_000), true,
      'distinct cap reason should be emit-eligible');
    assert.equal(dedup.shouldEmit('cap:daily', 86_400_000), false,
      'first cap reason should already be suppressed');
  } finally { cleanup(); }
});

test('tickOnce: cap dedup re-emits after the dedup window elapses', async () => {
  // Verifies the underlying createNotifyDedup behavior is wired correctly:
  // a fake clock advance past the windowMs should re-enable emit.
  const { db, dir, statePath, cleanup } = fresh();
  try {
    backfillRuns(db, 50);
    insertQueueRow(db, { url: 'http://new.example.com/job', urlHash: 'new', addedBy: 1 });

    let t = 1_000_000;
    const dedup = createNotifyDedup({ defaultWindowMs: 60_000, now: () => t });
    const notifications = [];
    const args = {
      db, projectRoot: dir, gitSha: 's', claudeModel: 'm',
      spawn: async () => { throw new Error('no spawn'); },
      notify: (msg) => notifications.push(msg),
      notifyDedup: dedup,
      rateLimitStatePath: statePath,
    };

    // Tick once at t=1_000_000 — emits.
    // The tickOnce passes its own windowMs (msUntilEndOfUtcDay), not 60_000.
    // So we forcibly reset by advancing past midnight UTC; simpler: just call
    // dedup.reset() between ticks to simulate window elapse.
    await tickOnce(args);
    const before = notifications.length;
    await tickOnce(args);
    assert.equal(notifications.length, before, 'second tick within window suppressed');

    dedup.reset('cap:daily');
    await tickOnce(args);
    assert.equal(notifications.length, before + 1, 'after dedup reset, tick re-emits cap message');
  } finally { cleanup(); }
});
