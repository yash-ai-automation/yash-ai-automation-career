// tests/services/resume-inflight.test.mjs
// Coverage for the Phase-2 resume-from-checkpoint path that fills the gap
// where state='resume' previously fell through to markQueueFailed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDb, closeDb } from '../../services/db.mjs';
import { insertQueueRow, markQueueRunning, insertRun, upsertCheckpoint, selectCheckpoint } from '../../services/queue.mjs';
import { analyzeRebootState } from '../../services/reboot-resume.mjs';
import { renderPreamble, formatInputsSummary, resumeInFlightRun } from '../../services/pipeline-orchestrator.mjs';

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), 'yash-resume-'));
  mkdirSync(join(dir, 'ops/checkpoints'), { recursive: true });
  mkdirSync(join(dir, 'ops/preambles'), { recursive: true });
  mkdirSync(join(dir, 'ops/runs'), { recursive: true });
  const dbPath = join(dir, 'ops/work-queue.db');
  const db = initDb(dbPath);
  return { db, dir, dbPath, cleanup: () => { closeDb(db); rmSync(dir, { recursive: true, force: true }); } };
}

function seedInFlight(db, { url = 'https://example.com/job', urlHash = 'abc123', lastPhase = 'resume_gen_end' } = {}) {
  const queueId = insertQueueRow(db, { url, urlHash, addedBy: 42 });
  markQueueRunning(db, queueId);
  const runId = insertRun(db, { queueId, url, startedAt: new Date().toISOString() });
  return { queueId, runId, url, urlHash, lastPhase };
}

function writeResumePreamble(dir) {
  writeFileSync(join(dir, 'ops/preambles/resume-run.md'),
`URL: $URL
Run ID: $RUN_ID
Last completed phase: $LAST_PHASE
Already-produced artifacts on disk (do NOT regenerate):
$INPUTS_SUMMARY

Resume at phase $NEXT_PHASE.
`);
}

function writeFreshPreamble(dir) {
  writeFileSync(join(dir, 'ops/preambles/fresh-run.md'),
`URL: $URL
Run ID: $RUN_ID
URL_HASH: $URL_HASH
PROJECT_ROOT: $PROJECT_ROOT
`);
}

// ── renderPreamble ──────────────────────────────────────────────────────────

test('renderPreamble: fresh mode substitutes URL/RUN_ID/URL_HASH/PROJECT_ROOT', () => {
  const { dir, cleanup } = fresh();
  try {
    writeFreshPreamble(dir);
    const body = renderPreamble({
      projectRoot: dir, mode: 'fresh',
      vars: { URL: 'https://x.test', RUN_ID: 7, URL_HASH: 'h0', PROJECT_ROOT: dir },
    });
    assert.match(body, /URL: https:\/\/x\.test/);
    assert.match(body, /Run ID: 7/);
    assert.match(body, /URL_HASH: h0/);
    // Compare via includes() to avoid having to regex-escape the tmpdir path,
    // which can contain characters that are regex metacharacters.
    assert.ok(body.includes(`PROJECT_ROOT: ${dir}`), `expected PROJECT_ROOT substitution; got: ${body}`);
  } finally { cleanup(); }
});

test('renderPreamble: resume mode substitutes LAST_PHASE/NEXT_PHASE/INPUTS_SUMMARY', () => {
  const { dir, cleanup } = fresh();
  try {
    writeResumePreamble(dir);
    const body = renderPreamble({
      projectRoot: dir, mode: 'resume',
      vars: {
        URL: 'https://x.test', RUN_ID: 99, URL_HASH: 'hX',
        LAST_PHASE: 'resume_gen_end', NEXT_PHASE: 'resume_compile_start',
        INPUTS_SUMMARY: '- jd_path: jds/yash/x.md',
      },
    });
    assert.match(body, /Last completed phase: resume_gen_end/);
    assert.match(body, /Resume at phase resume_compile_start/);
    assert.match(body, /- jd_path: jds\/yash\/x\.md/);
    assert.doesNotMatch(body, /\$LAST_PHASE|\$NEXT_PHASE|\$INPUTS_SUMMARY/);
  } finally { cleanup(); }
});

// ── formatInputsSummary ────────────────────────────────────────────────────

test('formatInputsSummary: empty / null / array → fallback string', () => {
  assert.equal(formatInputsSummary(null), '(no prior artifacts recorded)');
  assert.equal(formatInputsSummary({}), '(no prior artifacts recorded)');
  assert.equal(formatInputsSummary([]), '(no prior artifacts recorded)');
  assert.equal(formatInputsSummary('not an object'), '(no prior artifacts recorded)');
});

test('formatInputsSummary: object → multiline bullet list', () => {
  const out = formatInputsSummary({
    jd_path: 'jds/yash/Acme_SE_2026-05-24.md',
    resume_pdf: 'resumes/yash/Acme_SE_Resume_2026-05-24.pdf',
    bullets_validated: true,
  });
  assert.match(out, /- jd_path: jds\/yash\/Acme_SE_2026-05-24\.md/);
  assert.match(out, /- resume_pdf: resumes\/yash\/Acme_SE_Resume_2026-05-24\.pdf/);
  assert.match(out, /- bullets_validated: true/);
});

// ── resumeInFlightRun success path ─────────────────────────────────────────

test('resumeInFlightRun: clean exit → marks queue done, run ok, deletes checkpoint', async () => {
  const { db, dir, dbPath, cleanup } = fresh();
  try {
    writeResumePreamble(dir);
    const seeded = seedInFlight(db);
    // Write a checkpoint with a real on-disk inputs JSON
    const inputsPath = join(dir, 'ops/checkpoints', `${seeded.urlHash}.json`);
    writeFileSync(inputsPath, JSON.stringify({ jd_path: 'jds/yash/foo.md' }));
    upsertCheckpoint(db, { runId: seeded.runId, lastPhase: seeded.lastPhase, inputsPath });

    const recovery = analyzeRebootState(db);
    assert.equal(recovery.state, 'resume');

    const notifications = [];
    let spawnCalledWith = null;
    const result = await resumeInFlightRun({
      db, projectRoot: dir, dbPath, claudeModel: 'claude-opus-4-7',
      notify: (msg) => notifications.push(msg),
      recovery,
      spawn: async (ctx /*, hooks */) => {
        spawnCalledWith = ctx;
        return { exitCode: 0, durationMs: 12_345, slug: 'Acme_SE', score: 92, jdPath: 'jds/yash/foo.md' };
      },
    });

    assert.equal(result.action, 'completed_ok');
    assert.equal(result.runId, seeded.runId);
    assert.equal(spawnCalledWith.mode, 'resume');
    assert.equal(spawnCalledWith.resumeContext.LAST_PHASE, seeded.lastPhase);
    assert.equal(spawnCalledWith.resumeContext.NEXT_PHASE, 'resume_compile_start');
    assert.match(spawnCalledWith.resumeContext.INPUTS_SUMMARY, /jd_path: jds\/yash\/foo\.md/);

    // DB state
    const qRow = db.prepare('SELECT status FROM queue WHERE id=?').get(seeded.queueId);
    assert.equal(qRow.status, 'done');
    const rRow = db.prepare('SELECT status FROM runs WHERE id=?').get(seeded.runId);
    assert.equal(rRow.status, 'ok');
    const cp = selectCheckpoint(db, seeded.runId);
    assert.equal(cp, undefined);

    // Notifications
    assert.ok(notifications.some(n => /🚀/.test(n)), 'expected start notification');
    assert.ok(notifications.some(n => /♻️ Resuming run/.test(n)), 'expected resume notification');
    assert.ok(notifications.some(n => /✅/.test(n)), 'expected success notification');
  } finally { cleanup(); }
});

// ── resumeInFlightRun failure path ─────────────────────────────────────────

test('resumeInFlightRun: non-zero exit → marks queue failed, run fail, deletes checkpoint', async () => {
  const { db, dir, dbPath, cleanup } = fresh();
  try {
    writeResumePreamble(dir);
    const seeded = seedInFlight(db, { lastPhase: 'resume_compile_end' });
    const inputsPath = join(dir, 'ops/checkpoints', `${seeded.urlHash}.json`);
    writeFileSync(inputsPath, JSON.stringify({ resume_pdf: 'resumes/yash/x.pdf' }));
    upsertCheckpoint(db, { runId: seeded.runId, lastPhase: seeded.lastPhase, inputsPath });

    const recovery = analyzeRebootState(db);
    const notifications = [];
    const result = await resumeInFlightRun({
      db, projectRoot: dir, dbPath, claudeModel: 'x',
      notify: (msg) => notifications.push(msg),
      recovery,
      spawn: async () => ({ exitCode: 1, error: 'tectonic exit 11', failedPhase: 'cl_compile_end' }),
    });

    assert.equal(result.action, 'completed_fail');
    const qRow = db.prepare('SELECT status FROM queue WHERE id=?').get(seeded.queueId);
    assert.equal(qRow.status, 'failed');
    const rRow = db.prepare('SELECT status, error FROM runs WHERE id=?').get(seeded.runId);
    assert.equal(rRow.status, 'fail');
    assert.match(rRow.error, /tectonic exit 11/);
    assert.equal(selectCheckpoint(db, seeded.runId), undefined);
    assert.ok(notifications.some(n => /❌/.test(n)));
  } finally { cleanup(); }
});

// ── resumeInFlightRun cancellation path ────────────────────────────────────

test('resumeInFlightRun: cancel_requested + non-zero exit → marks cancelled', async () => {
  const { db, dir, dbPath, cleanup } = fresh();
  try {
    writeResumePreamble(dir);
    const seeded = seedInFlight(db);
    const inputsPath = join(dir, 'ops/checkpoints', `${seeded.urlHash}.json`);
    writeFileSync(inputsPath, JSON.stringify({}));
    upsertCheckpoint(db, { runId: seeded.runId, lastPhase: seeded.lastPhase, inputsPath });

    // Pre-flight: user already requested cancel before reboot
    db.prepare(`UPDATE queue SET cancel_requested=1 WHERE id=?`).run(seeded.queueId);

    const recovery = analyzeRebootState(db);
    const notifications = [];
    const result = await resumeInFlightRun({
      db, projectRoot: dir, dbPath, claudeModel: 'x',
      notify: (msg) => notifications.push(msg),
      recovery,
      spawn: async () => ({ exitCode: 143, error: 'sigterm' }),
    });

    assert.equal(result.action, 'completed_cancelled');
    const qRow = db.prepare('SELECT status FROM queue WHERE id=?').get(seeded.queueId);
    assert.equal(qRow.status, 'cancelled');
    const rRow = db.prepare('SELECT status, error FROM runs WHERE id=?').get(seeded.runId);
    assert.equal(rRow.status, 'cancelled');
    assert.equal(rRow.error, 'user-cancelled');
    assert.ok(notifications.some(n => /🛑/.test(n)));
  } finally { cleanup(); }
});

// ── resumeInFlightRun: corrupt checkpoint JSON degrades gracefully ─────────

test('resumeInFlightRun: corrupt checkpoint JSON → still attempts resume with empty summary', async () => {
  const { db, dir, dbPath, cleanup } = fresh();
  try {
    writeResumePreamble(dir);
    const seeded = seedInFlight(db);
    const inputsPath = join(dir, 'ops/checkpoints', `${seeded.urlHash}.json`);
    writeFileSync(inputsPath, '{not valid json,,,');
    upsertCheckpoint(db, { runId: seeded.runId, lastPhase: seeded.lastPhase, inputsPath });

    const recovery = analyzeRebootState(db);
    let spawnedSummary = null;
    const result = await resumeInFlightRun({
      db, projectRoot: dir, dbPath, claudeModel: 'x',
      notify: () => {},
      recovery,
      spawn: async (ctx) => { spawnedSummary = ctx.resumeContext.INPUTS_SUMMARY; return { exitCode: 0 }; },
    });
    assert.equal(result.action, 'completed_ok');
    assert.equal(spawnedSummary, '(no prior artifacts recorded)');
  } finally { cleanup(); }
});

// ── resumeInFlightRun: spawn throw → falls through to fail ─────────────────

test('resumeInFlightRun: spawn throws → marks queue failed with the error', async () => {
  const { db, dir, dbPath, cleanup } = fresh();
  try {
    writeResumePreamble(dir);
    const seeded = seedInFlight(db);
    const inputsPath = join(dir, 'ops/checkpoints', `${seeded.urlHash}.json`);
    writeFileSync(inputsPath, JSON.stringify({}));
    upsertCheckpoint(db, { runId: seeded.runId, lastPhase: seeded.lastPhase, inputsPath });

    const recovery = analyzeRebootState(db);
    const result = await resumeInFlightRun({
      db, projectRoot: dir, dbPath, claudeModel: 'x',
      notify: () => {},
      recovery,
      spawn: async () => { throw new Error('claude binary missing'); },
    });
    assert.equal(result.action, 'completed_fail');
    const rRow = db.prepare('SELECT status, error FROM runs WHERE id=?').get(seeded.runId);
    assert.equal(rRow.status, 'fail');
    assert.match(rRow.error, /resume spawn failed: claude binary missing/);
  } finally { cleanup(); }
});
