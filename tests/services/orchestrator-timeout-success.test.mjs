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
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDb, closeDb } from '../../services/db.mjs';
import { insertQueueRow } from '../../services/queue.mjs';
import {
  tickOnce, resolveRunTimeoutMs, findAuditResult, scanRunArtifacts, verifyRunArtifacts,
  deriveSlugFromArtifacts, findArtifactsBySlug, resolveRunArtifacts, identifyOrphanClaudePids,
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

// ── 2026-05-29 follow-up: filesystem-scan fallback for missing audit paths ──
// Smoke run #93 produced all artifacts but its audit line logged status:ok WITHOUT
// the jd/pdf/cover_letter paths, so the orchestrator saw "incomplete_artifacts" and
// re-queued → duplicate-skip. realSpawn now recovers paths by scanning the tenant's
// output dirs for run-window-fresh files, independent of agent logging fidelity.

test('scanRunArtifacts: recovers in-window artifacts when the audit line omitted paths (run-93 regression)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'scan-'));
  try {
    const startedAt = new Date(Date.now() - 60_000).toISOString(); // 1 min ago
    mkdirSync(join(dir, 'jds/yash'), { recursive: true });
    mkdirSync(join(dir, 'resumes/yash'), { recursive: true });
    mkdirSync(join(dir, 'cover-letters/yash'), { recursive: true });
    writeFileSync(join(dir, 'jds/yash/JD_X.md'), '# jd');
    writeFileSync(join(dir, 'resumes/yash/X.pdf'), '%PDF-1.4 x');
    writeFileSync(join(dir, 'cover-letters/yash/X_CL.pdf'), '%PDF-1.4 cl');
    const scanned = scanRunArtifacts({ projectRoot: dir, tenant: 'yash', startedAt });
    assert.ok(scanned.jd && scanned.pdf && scanned.cover_letter_pdf,
      `all three artifacts recovered: ${JSON.stringify(scanned)}`);
    // The run-93 fix: a result with NO declared paths but scan-recovered paths verifies ok.
    const v = verifyRunArtifacts({
      result: { isSkip: false, jdPath: scanned.jd, resumePdf: scanned.pdf, coverLetterPdf: scanned.cover_letter_pdf },
      projectRoot: dir,
    });
    assert.equal(v.ok, true, 'scan-recovered artifacts must satisfy verifyRunArtifacts');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('scanRunArtifacts: ignores files older than the run window', () => {
  const dir = mkdtempSync(join(tmpdir(), 'scan-old-'));
  try {
    mkdirSync(join(dir, 'jds/yash'), { recursive: true });
    const oldFile = join(dir, 'jds/yash/OLD.md');
    writeFileSync(oldFile, '# old jd');
    const old = new Date(Date.now() - 2 * 3600 * 1000); // 2h ago
    utimesSync(oldFile, old, old);
    const startedAt = new Date(Date.now() - 60_000).toISOString();
    const scanned = scanRunArtifacts({ projectRoot: dir, tenant: 'yash', startedAt });
    assert.equal(scanned.jd, null, 'a file older than startedAt must not be credited to this run');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('scanRunArtifacts: returns nulls when the tenant dirs are absent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'scan-empty-'));
  try {
    const scanned = scanRunArtifacts({ projectRoot: dir, tenant: 'yash', startedAt: new Date().toISOString() });
    assert.deepEqual(scanned, { jd: null, pdf: null, cover_letter_pdf: null });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── deriveSlugFromArtifacts ─────────────────────────────────────────────────

test('deriveSlugFromArtifacts: recovers slug from a JD / resume / cover-letter filename', () => {
  assert.equal(
    deriveSlugFromArtifacts({ scanned: { jd: '/x/jds/yash/JD_Stackadapt_FullStackEngineerIntegrations_Yash_Anghan_2026-05-29.md' }, tenant: 'yash' }),
    'Stackadapt_FullStackEngineerIntegrations',
  );
  assert.equal(
    deriveSlugFromArtifacts({ scanned: { cover_letter_pdf: '/x/cover-letters/yash/Cineplex_SoftwareDeveloper_Yash_Anghan_Cover_Letter_2026-05-29.pdf' }, tenant: 'yash' }),
    'Cineplex_SoftwareDeveloper',
  );
  assert.equal(deriveSlugFromArtifacts({ scanned: { jd: null, pdf: null, cover_letter_pdf: null }, tenant: 'yash' }), null);
});

// ── findArtifactsBySlug + resolveRunArtifacts: the CL-only path ──────────────

test('resolveRunArtifacts: CL-only path recovers a PRE-EXISTING jd+resume via slug scope (Cineplex regression)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cl-only-'));
  try {
    const slug = 'Cineplex_SoftwareDeveloper';
    mkdirSync(join(dir, 'jds/yash'), { recursive: true });
    mkdirSync(join(dir, 'resumes/yash'), { recursive: true });
    mkdirSync(join(dir, 'cover-letters/yash'), { recursive: true });
    // JD + resume are OLD (pre-existing from a prior run) → outside the run window.
    const jd = join(dir, `jds/yash/JD_${slug}_Yash_Anghan_2026-05-29.md`);
    const pdf = join(dir, `resumes/yash/${slug}_Yash_Anghan_Resume_2026-05-29.pdf`);
    writeFileSync(jd, '# jd'); writeFileSync(pdf, '%PDF old');
    const old = new Date(Date.now() - 3 * 3600 * 1000);
    utimesSync(jd, old, old); utimesSync(pdf, old, old);
    // Cover letter is FRESH (just produced this run).
    const cl = join(dir, `cover-letters/yash/${slug}_Yash_Anghan_Cover_Letter_2026-05-29.pdf`);
    writeFileSync(cl, '%PDF fresh cl');

    const startedAt = new Date(Date.now() - 60_000).toISOString();
    // Agent logged nothing (declared all null) — worst case.
    const r = resolveRunArtifacts({ declared: { jd: null, pdf: null, cover_letter_pdf: null }, projectRoot: dir, tenant: 'yash', startedAt });
    assert.equal(r.slug, slug, 'slug derived from the fresh cover letter');
    assert.ok(r.jdPath && r.resumePdf && r.coverLetterPdf,
      `all three resolved (slug scope recovers the old jd+resume): ${JSON.stringify(r)}`);
    // And verifyRunArtifacts now passes for the CL-only run.
    const v = verifyRunArtifacts({ result: { isSkip: false, jdPath: r.jdPath, resumePdf: r.resumePdf, coverLetterPdf: r.coverLetterPdf }, projectRoot: dir });
    assert.equal(v.ok, true, 'CL-only run verifies complete via slug-scoped recovery');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('resolveRunArtifacts: declared paths win over scan/slug when present', () => {
  const dir = mkdtempSync(join(tmpdir(), 'declared-win-'));
  try {
    const r = resolveRunArtifacts({
      declared: { jd: 'jds/yash/declared.md', pdf: 'resumes/yash/declared.pdf', cover_letter_pdf: 'cover-letters/yash/declared.pdf' },
      projectRoot: dir, tenant: 'yash', startedAt: new Date().toISOString(),
    });
    assert.equal(r.jdPath, 'jds/yash/declared.md');
    assert.equal(r.resumePdf, 'resumes/yash/declared.pdf');
    assert.equal(r.coverLetterPdf, 'cover-letters/yash/declared.pdf');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── identifyOrphanClaudePids (boot-time reaper selector) ─────────────────────

test('identifyOrphanClaudePids: selects stale ppid=1 claude -p workers, spares live + young + non-claude', () => {
  const snap = [
    { pid: 100, ppid: 1, etimes: 4000, cmd: 'claude -p You are running the yash-resume-pipeline /root/proj' }, // stale orphan ✓
    { pid: 101, ppid: 999, etimes: 4000, cmd: 'claude -p ... /root/proj' },   // live child (ppid≠1) ✗
    { pid: 102, ppid: 1, etimes: 60, cmd: 'claude -p ... /root/proj' },        // too young ✗
    { pid: 103, ppid: 1, etimes: 9000, cmd: 'node services/pipeline-orchestrator.mjs' }, // not claude ✗
    { pid: 104, ppid: 1, etimes: 5000, cmd: '/usr/bin/claude -p ... /root/proj' }, // stale orphan ✓
  ];
  const pids = identifyOrphanClaudePids(snap, { minAgeSec: 2400, projectRoot: '/root/proj' });
  assert.deepEqual(pids.sort((a, b) => a - b), [100, 104]);
});

test('identifyOrphanClaudePids: projectRoot filter excludes other-project orphans', () => {
  const snap = [
    { pid: 200, ppid: 1, etimes: 5000, cmd: 'claude -p ... /root/projA' },
    { pid: 201, ppid: 1, etimes: 5000, cmd: 'claude -p ... /root/projB' },
  ];
  assert.deepEqual(identifyOrphanClaudePids(snap, { projectRoot: '/root/projA' }), [200]);
});

test('identifyOrphanClaudePids: empty / nullish snapshot → empty list', () => {
  assert.deepEqual(identifyOrphanClaudePids([], {}), []);
  assert.deepEqual(identifyOrphanClaudePids(null, {}), []);
});
