// tests/services/orchestrator-logging.test.mjs
// Verifies that pipeline-orchestrator's tickOnce + resumeInFlightRun emit
// structured pino log lines (not plain console.error) when accepting an
// injected logger.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';

import { initDb, closeDb } from '../../services/db.mjs';
import { insertQueueRow } from '../../services/queue.mjs';
import { tickOnce, resumeInFlightRun } from '../../services/pipeline-orchestrator.mjs';
import { createLogger } from '../../services/logger.mjs';

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), 'yash-orch-log-'));
  mkdirSync(join(dir, 'ops/checkpoints'), { recursive: true });
  mkdirSync(join(dir, 'ops/runs'), { recursive: true });
  mkdirSync(join(dir, 'ops/preambles'), { recursive: true });
  writeFileSync(join(dir, 'ops/preambles/fresh-run.md'), 'fresh: $URL $RUN_ID');
  writeFileSync(join(dir, 'ops/preambles/resume-run.md'), 'resume: $URL $RUN_ID $LAST_PHASE');
  const db = initDb(join(dir, 'ops/work-queue.db'));
  return { db, dir, cleanup: () => { closeDb(db); rmSync(dir, { recursive: true, force: true }); } };
}

function makeSinkLogger() {
  const chunks = [];
  const stream = new Writable({
    write(chunk, _enc, cb) { chunks.push(chunk.toString()); cb(); }
  });
  const logger = createLogger({ service: 'test-orchestrator' }, stream);
  return {
    logger,
    lines: () => chunks
      .join('')
      .split('\n')
      .filter(Boolean)
      .map((s) => JSON.parse(s)),
  };
}

test('tickOnce: logs structured spawn_start with queue_id and url on success', async () => {
  const { db, dir, cleanup } = fresh();
  try {
    insertQueueRow(db, { url: 'https://acme.com/job/42', urlHash: 'h42', addedBy: 1 });
    const sink = makeSinkLogger();
    await tickOnce({
      db, projectRoot: dir,
      capLimits: { dailyMax: 20, weeklyMax: 100 },
      gitSha: 'cafebabe',
      claudeModel: 'claude-opus-4-7',
      spawn: async () => ({ exitCode: 0, durationMs: 100, slug: 'X', score: 80 }),
      notify: () => {},
      logger: sink.logger,
    });
    const startLine = sink.lines().find((l) => l.event === 'spawn_start');
    assert.ok(startLine, 'expected spawn_start log line');
    assert.equal(startLine.url, 'https://acme.com/job/42');
    assert.equal(typeof startLine.queue_id, 'number');
    assert.equal(typeof startLine.run_id, 'number');
  } finally { cleanup(); }
});

test('tickOnce: logs structured run_failed on non-zero exit (with error field)', async () => {
  const { db, dir, cleanup } = fresh();
  try {
    insertQueueRow(db, { url: 'https://acme.com/x', urlHash: 'hx', addedBy: 1 });
    const sink = makeSinkLogger();
    await tickOnce({
      db, projectRoot: dir,
      capLimits: { dailyMax: 20, weeklyMax: 100 },
      gitSha: 'cafebabe',
      claudeModel: 'claude-opus-4-7',
      spawn: async () => ({ exitCode: 11, error: 'tectonic exit 11', failedPhase: 'resume_compile_end' }),
      notify: () => {},
      logger: sink.logger,
    });
    const failLine = sink.lines().find((l) => l.event === 'run_failed');
    assert.ok(failLine, 'expected run_failed log line');
    assert.equal(failLine.level, 'error');
    assert.equal(failLine.failed_phase, 'resume_compile_end');
    assert.match(failLine.error || '', /tectonic exit 11/);
  } finally { cleanup(); }
});

test('resumeInFlightRun: logs structured error when inputs JSON is corrupt', async () => {
  const { db, dir, cleanup } = fresh();
  try {
    insertQueueRow(db, { url: 'https://x/y', urlHash: 'hxy', addedBy: 1 });
    db.prepare(`UPDATE queue SET status='running' WHERE id=1`).run();
    const r = db.prepare(`INSERT INTO runs(queue_id,url,started_at,status) VALUES(1,'https://x/y',datetime('now'),'running')`).run();
    const runId = Number(r.lastInsertRowid);

    const inputsPath = join(dir, 'ops/checkpoints', `${runId}.inputs.json`);
    writeFileSync(inputsPath, 'not valid json {{{');

    const sink = makeSinkLogger();
    await resumeInFlightRun({
      db, projectRoot: dir, dbPath: join(dir, 'ops/work-queue.db'),
      claudeModel: 'claude-opus-4-7',
      notify: () => {},
      recovery: {
        state: 'resume', queueId: 1, runId, url: 'https://x/y', urlHash: 'hxy',
        lastPhase: 'jd_fetch_end', nextPhase: 'resume_gen_end',
        inputsPath,
      },
      spawn: async () => ({ exitCode: 0, durationMs: 10 }),
      logger: sink.logger,
    });
    const errLine = sink.lines().find((l) => l.event === 'resume_inputs_parse_failed');
    assert.ok(errLine, 'expected resume_inputs_parse_failed log line');
    assert.equal(errLine.level, 'error');
    assert.equal(errLine.run_id, runId);
    assert.ok(errLine.err, 'expected err field with serialized error');
  } finally { cleanup(); }
});
