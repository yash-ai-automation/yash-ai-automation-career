// tests/services/orchestrator-timeout-success.test.mjs
// Regression suite for the 2026-05-29 timeout-requeue / false-duplicate fix.
//
// Root cause: a full run takes ~16-25 min, but PER_URL_TIMEOUT_MS was a hard 20 min,
// so long runs were SIGTERM-killed (exit 143) just as/after they finished. tickOnce
// gated success on exitCode===0 ONLY, so a killed-but-complete run was treated as a
// failure and re-queued — which then surfaced as a false "duplicate (all artifacts
// already exist)" skip (OpenLoop) or an incomplete_artifacts failure (StackAdapt).
//
// The fix: (1) configurable timeout, default 35 min; (2) success is gated on
// ground truth (artifacts on disk or a real skip), NOT exit code; (3) findAuditResult
// scopes the audit-log match to the run window so a stale prior-attempt line can't
// falsely credit a later attempt.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDb, closeDb } from '../../services/db.mjs';
import { insertQueueRow } from '../../services/queue.mjs';
import {
  tickOnce, resolveRunTimeoutMs, findAuditResult,
} from '../../services/pipeline-orchestrator.mjs';

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), 'orch-timeout-'));
  mkdirSync(join(dir, 'ops/checkpoints'), { recursive: true });
  mkdirSync(join(dir, 'ops/runs'), { recursive: true });
  const db = initDb(join(dir, 'ops/work-queue.db'));
  return { db, dir, cleanup: () => { closeDb(db); rmSync(dir, { recursive: true, force: true }); } };
}

function mkArtifacts(dir, { jd = 'jds/yash/x.md', pdf = 'resumes/yash/x.pdf', cl = 'cover-letters/yash/x.pdf' } = {}) {
  mkdirSync(join(dir, 'jds/yash'), { recursive: true });
  mkdirSync(join(dir, 'resumes/yash'), { recursive: true });
  mkdirSync(join(dir, 'cover-letters/yash'), { recursive: true });
  writeFileSync(join(dir, jd), '# fake jd\n');
  writeFileSync(join(dir, pdf), '%PDF-1.4 fake');
  writeFileSync(join(dir, cl), '%PDF-1.4 fake CL');
  return { jdPath: join(dir, jd), resumePdf: join(dir, pdf), coverLetterPdf: join(dir, cl) };
}

const baseTick = (db, dir, overrides = {}) => ({
  db, projectRoot: dir,
  capLimits: { dailyMax: 20, weeklyMax: 100 },
  gitSha: 'cafebabe', claudeModel: 'claude-sonnet-4-6',
  ...overrides,
});

// ── Task 1: resolveRunTimeoutMs ─────────────────────────────────────────────

test('resolveRunTimeoutMs: defaults to 35 minutes when env unset', () => {
  assert.equal(resolveRunTimeoutMs({}), 35 * 60 * 1000);
});

test('resolveRunTimeoutMs: honors a valid positive PER_URL_TIMEOUT_MS override', () => {
  assert.equal(resolveRunTimeoutMs({ PER_URL_TIMEOUT_MS: '600000' }), 600000);
});

test('resolveRunTimeoutMs: ignores non-numeric / non-positive overrides (falls back to default)', () => {
  assert.equal(resolveRunTimeoutMs({ PER_URL_TIMEOUT_MS: 'abc' }), 35 * 60 * 1000);
  assert.equal(resolveRunTimeoutMs({ PER_URL_TIMEOUT_MS: '0' }), 35 * 60 * 1000);
  assert.equal(resolveRunTimeoutMs({ PER_URL_TIMEOUT_MS: '-5' }), 35 * 60 * 1000);
});

// ── Task 2: findAuditResult (run-window scoping) ────────────────────────────

test('findAuditResult: returns the last matching line for the URL', () => {
  const text = [
    JSON.stringify({ timestamp: '2026-05-29T17:00:00.000Z', status: 'ok', url: 'http://a/job', score: '90' }),
    JSON.stringify({ timestamp: '2026-05-29T17:30:00.000Z', status: 'ok', url: 'http://a/job', score: '100' }),
  ].join('\n');
  const r = findAuditResult({ auditText: text, url: 'http://a/job', startedAt: '2026-05-29T17:25:00.000Z' });
  assert.equal(r.score, '100', 'must return the in-window (latest) line');
});

test('findAuditResult: ignores a stale line written before the run started', () => {
  const text = JSON.stringify({ timestamp: '2026-05-29T17:00:00.000Z', status: 'ok', url: 'http://a/job', score: '100' });
  const r = findAuditResult({ auditText: text, url: 'http://a/job', startedAt: '2026-05-29T17:25:00.000Z' });
  assert.equal(r, null, 'a line older than startedAt must NOT be credited to this run');
});

test('findAuditResult: with no startedAt, matches by URL only (back-compat)', () => {
  const text = JSON.stringify({ timestamp: '2026-05-29T17:00:00.000Z', status: 'skip', url: 'http://a/job', reason: 'dup' });
  const r = findAuditResult({ auditText: text, url: 'http://a/job' });
  assert.equal(r.status, 'skip');
});

test('findAuditResult: returns null when no line matches the URL', () => {
  const text = JSON.stringify({ timestamp: '2026-05-29T17:30:00.000Z', status: 'ok', url: 'http://other/job' });
  assert.equal(findAuditResult({ auditText: text, url: 'http://a/job', startedAt: '2026-05-29T17:25:00.000Z' }), null);
});

// ── Task 3: ground-truth success determination in tickOnce ──────────────────

test('tickOnce: SIGTERM-killed run (exit 143) with all artifacts on disk → completed_ok, NOT requeued', async () => {
  const { db, dir, cleanup } = fresh();
  try {
    const qid = insertQueueRow(db, { url: 'http://acme.com/job', urlHash: 'h1', addedBy: 1 });
    const artifacts = mkArtifacts(dir);
    const notifications = [];
    const r = await tickOnce(baseTick(db, dir, {
      // The OpenLoop case: pipeline finished + logged ok, but the process was
      // SIGTERM'd at the wall-clock timeout (exit 143) before it could exit.
      spawn: async () => ({ exitCode: 143, error: 'claude -p exit 143 signal SIGTERM', isSkip: false, slug: 'Acme', score: 100, ...artifacts }),
      notify: (m) => notifications.push(m),
    }));
    assert.equal(r.action, 'completed_ok', 'a killed-but-complete run must be credited, not retried');
    const qRow = db.prepare('SELECT status, attempts FROM queue WHERE id=?').get(qid);
    assert.equal(qRow.status, 'done');
    assert.equal(qRow.attempts, 0, 'a credited success must not consume a retry attempt');
    assert.ok(!notifications.some(n => /re-queued/i.test(n)), 'must NOT emit a re-queue notification');
    assert.ok(!notifications.some(n => /duplicate/i.test(n)), 'must NOT surface a false duplicate skip');
  } finally { cleanup(); }
});

test('tickOnce: SIGTERM-killed run (exit 143) that the agent logged as skip → completed_skip', async () => {
  const { db, dir, cleanup } = fresh();
  try {
    const qid = insertQueueRow(db, { url: 'http://acme.com/job', urlHash: 'h1', addedBy: 1 });
    const r = await tickOnce(baseTick(db, dir, {
      spawn: async () => ({ exitCode: 143, isSkip: true, skipReason: 'duplicate (all artifacts already exist)' }),
      notify: () => {},
    }));
    assert.equal(r.action, 'completed_skip');
    assert.equal(db.prepare('SELECT status FROM queue WHERE id=?').get(qid).status, 'done');
  } finally { cleanup(); }
});

test('tickOnce: SIGTERM-killed run (exit 143) with INCOMPLETE artifacts → requeued (not falsely credited)', async () => {
  const { db, dir, cleanup } = fresh();
  try {
    // Cineplex case: JD + resume exist but cover letter never produced.
    mkdirSync(join(dir, 'jds/yash'), { recursive: true });
    mkdirSync(join(dir, 'resumes/yash'), { recursive: true });
    writeFileSync(join(dir, 'jds/yash/x.md'), 'jd');
    writeFileSync(join(dir, 'resumes/yash/x.pdf'), '%PDF');
    const qid = insertQueueRow(db, { url: 'http://acme.com/job', urlHash: 'h1', addedBy: 1 });
    const r = await tickOnce(baseTick(db, dir, {
      spawn: async () => ({
        exitCode: 143, error: 'claude -p exit 143', isSkip: false,
        jdPath: join(dir, 'jds/yash/x.md'), resumePdf: join(dir, 'resumes/yash/x.pdf'), coverLetterPdf: null,
      }),
      notify: () => {},
    }));
    assert.equal(r.action, 'requeued', 'an incomplete killed run must still retry');
    assert.equal(r.attempts, 1);
    assert.equal(db.prepare('SELECT status FROM queue WHERE id=?').get(qid).status, 'queued');
  } finally { cleanup(); }
});
