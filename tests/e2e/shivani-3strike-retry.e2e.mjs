// tests/e2e/shivani-3strike-retry.e2e.mjs
// Plan §8.4 — three consecutive fake-fail spawns trigger the shared 3-strike
// retry policy. Each tickOnce() call advances the queue row through:
//   attempts=0 → 1 (re-queue), attempts=1 → 2 (re-queue), attempts=2 → 3 (mark failed).
// On the 3rd strike the Telegram message must end with
// "attempt 3/3 — moving to failed".
//
// This run drives the orchestrator under the Shivani env block (AUDIT_LOG_PATH,
// PREAMBLE_DIR, TENANT_LABEL, ...), so the test also confirms the retry policy
// is tenant-agnostic — Shivani benefits exactly the same way Yash does.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDb, closeDb } from '../../services/db.mjs';
import { insertQueueRow } from '../../services/queue.mjs';
import { tickOnce } from '../../services/pipeline-orchestrator.mjs';

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), 'shivani-3strike-'));
  mkdirSync(join(dir, 'ops/shivani/checkpoints'), { recursive: true });
  mkdirSync(join(dir, 'ops/shivani/runs'), { recursive: true });
  const db = initDb(join(dir, 'ops/shivani/work-queue.db'));
  return { db, dir, cleanup: () => { closeDb(db); rmSync(dir, { recursive: true, force: true }); } };
}

const SHIVANI_ENV = {
  AUDIT_LOG_PATH: 'data/shivani-resume-runs.log',
  PREAMBLE_DIR: 'ops/shivani/preambles',
  TENANT: 'shivani',
  TENANT_LABEL: 'shivani-pipeline',
  TENANT_TRACE_NAME: 'shivani-resume-pipeline',
  TMP_CLEANUP_GLOB: '/tmp/shivani-pipeline-*',
};

async function withEnvBlock(block, fn) {
  const restore = {};
  for (const k of Object.keys(block)) {
    restore[k] = process.env[k];
    if (block[k] === undefined) delete process.env[k];
    else process.env[k] = block[k];
  }
  try { return await fn(); }
  finally {
    for (const k of Object.keys(restore)) {
      if (restore[k] === undefined) delete process.env[k];
      else process.env[k] = restore[k];
    }
  }
}

test('e2e: 3 consecutive Shivani failures → 3 Telegram messages, "attempt 3/3 — moving to failed" at the end', async () => {
  const { db, dir, cleanup } = fresh();
  try {
    await withEnvBlock(SHIVANI_ENV, async () => {
      const qid = insertQueueRow(db, {
        url: 'https://shivani-jobs.example.com/fullstack-java-banking',
        urlHash: 'sh-3strike',
        addedBy: 9_000_000_002,
      });
      const notifications = [];
      const baseTick = {
        db, projectRoot: dir,
        capLimits: { dailyMax: 20, weeklyMax: 100 },
        gitSha: 'cafebabe',
        claudeModel: 'claude-opus-4-7',
        spawn: async () => ({
          exitCode: 1,
          error: 'tectonic exit 11',
          failedPhase: 'resume_compile_end',
        }),
        notify: (msg) => notifications.push(msg),
      };

      // Tick 1 — initial failure → re-queue with attempts=1.
      let r = await tickOnce(baseTick);
      assert.equal(r.action, 'requeued', 'tick 1 should re-queue, not finalize');
      assert.equal(r.attempts, 1);
      let qRow = db.prepare('SELECT status, attempts, assigned_at FROM queue WHERE id=?').get(qid);
      assert.equal(qRow.status, 'queued');
      assert.equal(qRow.attempts, 1);
      assert.equal(qRow.assigned_at, null, 'assigned_at must clear so the next tick eligible');

      // Tick 2 — second failure → re-queue with attempts=2.
      r = await tickOnce(baseTick);
      assert.equal(r.action, 'requeued', 'tick 2 should re-queue');
      assert.equal(r.attempts, 2);
      qRow = db.prepare('SELECT status, attempts FROM queue WHERE id=?').get(qid);
      assert.equal(qRow.status, 'queued');
      assert.equal(qRow.attempts, 2);

      // Tick 3 — third failure → final markFailed with attempts=3.
      r = await tickOnce(baseTick);
      assert.equal(r.action, 'completed_fail', 'tick 3 should finalize');
      assert.equal(r.attempts, 3);
      qRow = db.prepare('SELECT status, attempts, completed_at FROM queue WHERE id=?').get(qid);
      assert.equal(qRow.status, 'failed');
      assert.equal(qRow.attempts, 3);
      assert.ok(qRow.completed_at, 'completed_at must be set on final failure');

      // Exactly 3 failure-side notifications (one per attempt), plus the per-attempt
      // start ("🚀") notifications. Filter the warning/❌ stream:
      const failNotices = notifications.filter(n => /(attempt \d\/3|❌)/.test(n));
      assert.equal(
        failNotices.filter(n => /attempt \d\/3/.test(n)).length, 3,
        `expected 3 attempt notifications, got: ${JSON.stringify(failNotices)}`,
      );
      // First two re-queues say "re-queued".
      assert.match(failNotices[0], /attempt 1\/3.*re-queued/i);
      assert.match(failNotices[1], /attempt 2\/3.*re-queued/i);
      // Third (final) has the "moving to failed" wording.
      assert.match(failNotices[2], /attempt 3\/3.*moving to failed/i);
      // The "❌" marker appears only on the final notice (formatFailure prefix).
      const finalIcons = failNotices.filter(n => /❌/.test(n));
      assert.equal(finalIcons.length, 1, 'only the 3rd-strike notice carries the ❌ failure icon');
    });
  } finally { cleanup(); }
});
