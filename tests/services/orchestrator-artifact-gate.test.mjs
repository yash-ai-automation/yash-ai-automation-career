// tests/services/orchestrator-artifact-gate.test.mjs
//
// Regression suite for the false-success bug discovered 2026-05-25 (run #13):
//   The Yash orchestrator's success branch was gated purely on `result.exitCode
//   === 0`, with NO check that the expected artifacts (JD .md, resume .pdf,
//   cover-letter .pdf) actually existed on disk. When a retry hit the playbook
//   dedup short-circuit and called `mark-skipped`, the orchestrator emitted
//   `formatSuccess` with `Score 0/100 · (role unknown)` even though no work was
//   done and the original failure (missing cover letter) was unresolved.
//
// This file covers two pure helpers + the notifier-layer skip primitive:
//   1. verifyRunArtifacts({ result, projectRoot })
//        - returns { ok: true,  kind: 'skip',     missing: [] } when result.isSkip
//        - returns { ok: true,  kind: 'complete', missing: [] } when all three
//          declared artifacts exist on disk
//        - returns { ok: false, kind: 'complete', missing: [...] } otherwise
//   2. formatSkipped({ runId, hostname, reason })  — emits 🔁 prefix (distinct
//        from formatSuccess's ✅), surfaces the reason verbatim.
//
// Together these make it structurally impossible for a no-op skip or a half-
// done run to be reported as ✅ Score 0/100 again.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyRunArtifacts } from '../../services/pipeline-orchestrator.mjs';
import { formatSkipped } from '../../services/notifier.mjs';

// ── verifyRunArtifacts: skip bypasses artifact check ────────────────────────

test('verifyRunArtifacts: result.isSkip=true returns ok with kind=skip and no missing', () => {
  const r = verifyRunArtifacts({
    result: { isSkip: true, jdPath: null, resumePdf: null, coverLetterPdf: null },
    projectRoot: '/nonexistent/path/should/not/be/touched',
  });
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'skip');
  assert.deepEqual(r.missing, []);
});

// ── verifyRunArtifacts: all artifacts present → ok ──────────────────────────

test('verifyRunArtifacts: all three declared artifacts exist on disk → ok=true, kind=complete', () => {
  const dir = mkdtempSync(join(tmpdir(), 'verify-ok-'));
  try {
    mkdirSync(join(dir, 'jds/yash'), { recursive: true });
    mkdirSync(join(dir, 'resumes/yash'), { recursive: true });
    mkdirSync(join(dir, 'cover-letters/yash'), { recursive: true });
    writeFileSync(join(dir, 'jds/yash/JD_X.md'), 'x');
    writeFileSync(join(dir, 'resumes/yash/X.pdf'), 'x');
    writeFileSync(join(dir, 'cover-letters/yash/X_CL.pdf'), 'x');

    const r = verifyRunArtifacts({
      result: {
        isSkip: false,
        jdPath: 'jds/yash/JD_X.md',
        resumePdf: 'resumes/yash/X.pdf',
        coverLetterPdf: 'cover-letters/yash/X_CL.pdf',
      },
      projectRoot: dir,
    });
    assert.equal(r.ok, true, 'must accept the run when all three artifacts exist');
    assert.equal(r.kind, 'complete');
    assert.deepEqual(r.missing, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── verifyRunArtifacts: cover letter missing → reject ───────────────────────

test('verifyRunArtifacts: cover letter declared but absent → ok=false, missing names cover_letter_pdf', () => {
  const dir = mkdtempSync(join(tmpdir(), 'verify-cl-missing-'));
  try {
    mkdirSync(join(dir, 'jds/yash'), { recursive: true });
    mkdirSync(join(dir, 'resumes/yash'), { recursive: true });
    writeFileSync(join(dir, 'jds/yash/JD_X.md'), 'x');
    writeFileSync(join(dir, 'resumes/yash/X.pdf'), 'x');
    // cover letter file NOT written

    const r = verifyRunArtifacts({
      result: {
        isSkip: false,
        jdPath: 'jds/yash/JD_X.md',
        resumePdf: 'resumes/yash/X.pdf',
        coverLetterPdf: 'cover-letters/yash/X_CL.pdf',
      },
      projectRoot: dir,
    });
    assert.equal(r.ok, false, 'must reject when cover letter is missing on disk');
    assert.equal(r.kind, 'complete');
    assert.ok(
      r.missing.some(m => /cover_letter_pdf/.test(m)),
      `expected missing to mention cover_letter_pdf, got: ${JSON.stringify(r.missing)}`,
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── verifyRunArtifacts: not declared (null path) → reject ───────────────────

test('verifyRunArtifacts: coverLetterPdf is null (never produced) → ok=false', () => {
  const r = verifyRunArtifacts({
    result: {
      isSkip: false,
      jdPath: 'jds/yash/JD_X.md',
      resumePdf: 'resumes/yash/X.pdf',
      coverLetterPdf: null,            // exactly the run-13 case: nothing declared
    },
    projectRoot: '/tmp',
  });
  assert.equal(r.ok, false, 'must reject when cover letter path is null');
  assert.ok(
    r.missing.some(m => /cover_letter_pdf/.test(m)),
    `expected missing to mention cover_letter_pdf, got: ${JSON.stringify(r.missing)}`,
  );
});

// ── verifyRunArtifacts: JD missing on disk → reject ─────────────────────────

test('verifyRunArtifacts: jd declared but absent → ok=false, missing names jd', () => {
  const dir = mkdtempSync(join(tmpdir(), 'verify-jd-missing-'));
  try {
    mkdirSync(join(dir, 'resumes/yash'), { recursive: true });
    mkdirSync(join(dir, 'cover-letters/yash'), { recursive: true });
    writeFileSync(join(dir, 'resumes/yash/X.pdf'), 'x');
    writeFileSync(join(dir, 'cover-letters/yash/X_CL.pdf'), 'x');
    // JD file NOT written

    const r = verifyRunArtifacts({
      result: {
        isSkip: false,
        jdPath: 'jds/yash/JD_X.md',
        resumePdf: 'resumes/yash/X.pdf',
        coverLetterPdf: 'cover-letters/yash/X_CL.pdf',
      },
      projectRoot: dir,
    });
    assert.equal(r.ok, false);
    assert.ok(r.missing.some(m => /\bjd\b/.test(m)), `expected missing to mention jd: ${JSON.stringify(r.missing)}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── verifyRunArtifacts: absolute paths honored as-is ────────────────────────

test('verifyRunArtifacts: absolute artifact path is checked verbatim (no projectRoot join)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'verify-abs-'));
  try {
    mkdirSync(join(dir, 'jds/yash'), { recursive: true });
    mkdirSync(join(dir, 'resumes/yash'), { recursive: true });
    mkdirSync(join(dir, 'cover-letters/yash'), { recursive: true });
    writeFileSync(join(dir, 'jds/yash/JD_X.md'), 'x');
    writeFileSync(join(dir, 'resumes/yash/X.pdf'), 'x');
    writeFileSync(join(dir, 'cover-letters/yash/X_CL.pdf'), 'x');

    const r = verifyRunArtifacts({
      result: {
        isSkip: false,
        jdPath: join(dir, 'jds/yash/JD_X.md'),                    // absolute
        resumePdf: join(dir, 'resumes/yash/X.pdf'),               // absolute
        coverLetterPdf: join(dir, 'cover-letters/yash/X_CL.pdf'), // absolute
      },
      projectRoot: '/different/project/root/that/does/not/matter',
    });
    assert.equal(r.ok, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── formatSkipped: distinct emoji + reason ──────────────────────────────────

test('formatSkipped: returns 🔁 prefix, includes runId, hostname, and reason', () => {
  const msg = formatSkipped({
    runId: 13,
    hostname: 'job-boards.greenhouse.io',
    reason: 'duplicate (jd+pdf already exist)',
  });
  assert.match(msg, /🔁/, 'must use 🔁 to distinguish from ✅ success');
  assert.match(msg, /#13/, 'must include runId');
  assert.match(msg, /job-boards\.greenhouse\.io/, 'must include hostname');
  assert.match(msg, /duplicate.*jd\+pdf/, 'must include the reason verbatim');
});

test('formatSkipped: missing reason falls back to "duplicate" (defensive)', () => {
  const msg = formatSkipped({ runId: 7, hostname: 'example.com', reason: null });
  assert.match(msg, /🔁/);
  assert.match(msg, /duplicate/i);
});

test('formatSkipped: NEVER emits Score X/100 (the format that caused the bug report)', () => {
  const msg = formatSkipped({
    runId: 13,
    hostname: 'job-boards.greenhouse.io',
    reason: 'duplicate',
  });
  assert.doesNotMatch(msg, /Score \d+\/100/, 'a skip notification must not look like a scored success');
  assert.doesNotMatch(msg, /role unknown/i, 'a skip notification must not say role unknown');
  assert.doesNotMatch(msg, /✅/, 'a skip notification must not use ✅');
});
