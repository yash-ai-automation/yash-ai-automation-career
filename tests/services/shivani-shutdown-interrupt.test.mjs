// tests/services/shivani-shutdown-interrupt.test.mjs
// Plan §8.3 — SIGTERM-during-run preserves Shivani queue state. v1 has no
// per-phase checkpoint subcommand on shivani-resume-pipeline.mjs (PR 3 will
// add that additively), so analyzeRebootState() falls through to
// restart_from_scratch on the next boot — the queue row resets to 'queued'
// and the URL re-runs from the top. This test confirms tickOnce() does not
// markFailed / clear-checkpoint when SIGTERM races with the spawn.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDb, closeDb } from '../../services/db.mjs';
import { insertQueueRow, upsertCheckpoint, selectCheckpoint } from '../../services/queue.mjs';
import { tickOnce } from '../../services/pipeline-orchestrator.mjs';
import { analyzeRebootState } from '../../services/reboot-resume.mjs';

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), 'shivani-sd-'));
  mkdirSync(join(dir, 'ops/shivani/checkpoints'), { recursive: true });
  mkdirSync(join(dir, 'ops/shivani/runs'), { recursive: true });
  const db = initDb(join(dir, 'ops/shivani/work-queue.db'));
  return { db, dir, cleanup: () => { closeDb(db); rmSync(dir, { recursive: true, force: true }); } };
}

function withShivaniEnv(fn) {
  const block = {
    AUDIT_LOG_PATH: 'data/shivani-resume-runs.log',
    PREAMBLE_DIR: 'ops/shivani/preambles',
    TENANT: 'shivani',
    TENANT_LABEL: 'shivani-pipeline',
    TENANT_TRACE_NAME: 'shivani-resume-pipeline',
    TMP_CLEANUP_GLOB: '/tmp/shivani-pipeline-*',
  };
  const restore = {};
  for (const k of Object.keys(block)) {
    restore[k] = process.env[k];
    process.env[k] = block[k];
  }
  try { return fn(); }
  finally {
    for (const k of Object.keys(restore)) {
      if (restore[k] === undefined) delete process.env[k];
      else process.env[k] = restore[k];
    }
  }
}

test('Shivani shutdown_interrupt: queue/run/checkpoint stay intact when SIGTERM hits a non-cancelled spawn', async () => {
  const { db, dir, cleanup } = fresh();
  try {
    await withShivaniEnv(async () => {
      const qid = insertQueueRow(db, { url: 'http://shivani-jobs.example.com/role-x', urlHash: 'sh1', addedBy: 1 });
      const notifications = [];
      const r = await tickOnce({
        db, projectRoot: dir,
        capLimits: { dailyMax: 20, weeklyMax: 100 },
        gitSha: 'cafebabe',
        claudeModel: 'claude-sonnet-4-6',
        spawn: async ({ runId }) => {
          // Simulate: claude reached resume_gen_end before SIGTERM.
          upsertCheckpoint(db, { runId, lastPhase: 'resume_gen_end', inputsPath: '/tmp/shivani-pipeline-sh1.json' });
          return { exitCode: 143, error: 'sigterm during shutdown' };
        },
        notify: (m) => notifications.push(m),
        isShuttingDown: () => true,
      });
      assert.equal(r.action, 'shutdown_interrupt');
      assert.equal(r.lastPhase, 'resume_gen_end');
      // State must be preserved.
      const queueRow = db.prepare('SELECT status, attempts FROM queue WHERE id=?').get(qid);
      assert.equal(queueRow.status, 'running');
      assert.equal(queueRow.attempts, 0, 'shutdown_interrupt must NOT bump the 3-strike counter');
      const runRow = db.prepare('SELECT status, ended_at FROM runs WHERE queue_id=?').get(qid);
      assert.equal(runRow.status, 'running');
      assert.equal(runRow.ended_at, null);
      const cp = selectCheckpoint(db, r.runId);
      assert.equal(cp.last_phase, 'resume_gen_end');
      assert.ok(notifications.some(n => /⏸️/.test(n) && /resume_gen_end/.test(n)));
    });
  } finally { cleanup(); }
});

test('Shivani v1 reboot: with no checkpoint on the running row, analyzeRebootState returns restart_from_scratch', async () => {
  const { db, cleanup } = fresh();
  try {
    await withShivaniEnv(async () => {
      const qid = insertQueueRow(db, { url: 'http://shivani-jobs.example.com/role-y', urlHash: 'sh2', addedBy: 1 });
      // Simulate the post-SIGTERM state where the orchestrator never wrote a checkpoint:
      // - queue row in `running`
      // - runs row in `running`
      // - NO checkpoints row for that run
      db.prepare("UPDATE queue SET status='running', assigned_at=datetime('now') WHERE id=?").run(qid);
      const runIns = db.prepare(`INSERT INTO runs(queue_id, url, started_at, status) VALUES(?, ?, ?, 'running')`).run(qid, 'http://shivani-jobs.example.com/role-y', new Date().toISOString());
      const runId = Number(runIns.lastInsertRowid);

      const state = analyzeRebootState(db);
      assert.equal(state.state, 'restart_from_scratch');
      assert.equal(state.queueId, qid);
      assert.equal(state.runId, runId);
      assert.equal(state.url, 'http://shivani-jobs.example.com/role-y');
    });
  } finally { cleanup(); }
});
