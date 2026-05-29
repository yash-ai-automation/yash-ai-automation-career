# Yash/Shivani Pipeline — Timeout-Requeue / False-Duplicate Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the autonomous pipeline orchestrator from re-queuing runs that already succeeded — eliminating the false "Skipped: duplicate (all artifacts already exist)" / spurious `failed` outcomes — by (1) raising and making the per-URL timeout configurable and (2) determining run success from ground truth (artifacts on disk + the run-window audit line) instead of the `claude -p` process exit code.

**Architecture:** The fix lives in the shared `services/pipeline-orchestrator.mjs` (used by both the Yash and Shivani daemons) plus a deterministic audit-line write in `yash-resume-pipeline.mjs` / `shivani-resume-pipeline.mjs`. The orchestrator's `tickOnce()` is restructured so a run is "successful" when it legitimately skipped **or** produced all three declared artifacts — regardless of exit code (so a run SIGTERM'd at the wall-clock timeout *after* finishing is credited, not retried). A new pure helper `findAuditResult()` scopes the audit-log match to the current run's time window so a stale prior-attempt line can never falsely credit a later attempt.

**Tech Stack:** Node.js (ESM `.mjs`), `node:test` (built-in, no external runner), `node:sqlite` (`DatabaseSync`), systemd `--user` units, `claude -p` CLI (`--model claude-sonnet-4-6 --effort xhigh`).

---

## Root cause (from systematic-debugging Phase 1 — evidence)

Source of truth: SQLite `runs`/`queue` tables in `ops/work-queue.db`, `data/yash-resume-runs.log`, `ops/runs/<id>/claude.log`, on-disk artifacts.

1. `services/pipeline-orchestrator.mjs:81` — `PER_URL_TIMEOUT_MS = 20 * 60 * 1000`. A full Yash run takes ~16–18+ min (OpenLoop today `total_ms`=18.2 min; one Kindsight `resume_gen_ms` alone was 9.9 min; an Amazon `jd_fetch_ms` was 3.8 min). Long runs are SIGTERM-killed at the 20-min mark (`exit 143`).
2. `tickOnce()` gates success on `result.exitCode === 0` only (`L~423`, helper at `L691` sets `error` whenever `exit.code !== 0`). A run that finished the pipeline and logged `status:ok` but was killed before the process exited (OpenLoop run 88: logged ok 17:22:38, SIGTERM 17:23:03) is treated as a **failure**.
3. Failure → 3-strike re-queue (`L491`). The re-dispatched attempt hits the pipeline's own duplicate detection → surfaces a false **"Skipped: duplicate (all artifacts already exist)"** (OpenLoop run 89), OR duplicate-skips without writing the audit JSONL line → orchestrator sees `incomplete_artifacts: jd (not declared)` → marks **failed** (StackAdapt runs 91/92), OR restarts from scratch and times out again (Cineplex runs 85/86/87).
4. **Ground truth:** all three URLs' artifacts are actually on disk and correct (OpenLoop full; StackAdapt full; Cineplex JD+resume, missing only the cover letter). Content generation is fine; the orchestration logic is the bug.

**Locked decisions (from the operator, 2026-05-29):** keep `--effort xhigh` (do NOT set `max` — more effort = longer runs = more timeouts; model is already `claude-sonnet-4-6`); fix BOTH tenants (shared orchestrator); after deploy re-deliver OpenLoop+StackAdapt PDFs and generate Cineplex's missing cover letter; deploy as soon as tests pass (in-flight Shivani run will re-queue/resume).

## File structure

| File | Responsibility | Change |
|---|---|---|
| `services/pipeline-orchestrator.mjs` | Orchestration state machine (`tickOnce`, `realSpawn`) | Add `resolveRunTimeoutMs()` + `findAuditResult()`; restructure `tickOnce` success determination; thread `startedAt` into `realSpawn` |
| `tests/services/orchestrator-timeout-success.test.mjs` | New regression suite for this fix | Create |
| `yash-resume-pipeline.mjs` | Yash pipeline subcommands | `mark-skipped` also appends a `status:skip` audit line |
| `shivani-resume-pipeline.mjs` | Shivani pipeline subcommands | mirror the `mark-skipped` audit-line write |
| `tests/yash-resume-pipeline.test.mjs` | Pipeline subcommand tests | add a `mark-skipped writes audit line` test |
| `.claude/skills/yash-pipeline-autonomous-agent/SKILL.md`, `.claude/skills/shivani-pipeline-autonomous-agent/SKILL.md` | Runbooks | correct stale "6–14 min" latency; document `PER_URL_TIMEOUT_MS` knob |
| `ops/telegram.env.example`, `ops/shivani/telegram.env.example` | Operator env templates | document `PER_URL_TIMEOUT_MS` |
| `docs/superpowers/audits/2026-05-29-yash-timeout-requeue-false-duplicate-rca.md` | Post-mortem | Create |

**Out of scope (documented follow-ups, NOT in this PR):** the cosmetic `slug` slash inconsistency (`Kindsight/SeniorFullstackAiPlatformEngineer` vs underscore) in some audit lines; a dedicated short JD-fetch sub-timeout for Workday-style hangs; checkpoint-resume across the per-URL timeout (the timeout bump makes single-attempt completion the norm, so cross-retry resume is unnecessary now).

---

### Task 1: Make the per-URL timeout configurable and raise the default to 35 min

**Files:**
- Modify: `services/pipeline-orchestrator.mjs` (constant at `:81`; usage at `:638`)
- Test: `tests/services/orchestrator-timeout-success.test.mjs`

- [ ] **Step 1: Write the failing test** (create the new test file with this first block)

```javascript
// tests/services/orchestrator-timeout-success.test.mjs
// Regression suite for the 2026-05-29 timeout-requeue / false-duplicate fix.
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-name-pattern='resolveRunTimeoutMs' tests/services/orchestrator-timeout-success.test.mjs`
Expected: FAIL — `resolveRunTimeoutMs` is not exported (`SyntaxError`/`undefined is not a function`).

- [ ] **Step 3: Implement `resolveRunTimeoutMs` and use it in `realSpawn`**

In `services/pipeline-orchestrator.mjs`, replace the constant (currently `const PER_URL_TIMEOUT_MS = 20 * 60 * 1000;   // 20 min per Q3 default`):

```javascript
// Per-URL wall-clock timeout. Raised 20→35 min (2026-05-29): a full run legitimately
// takes ~16–25 min under Sonnet 4.6 / xhigh, so 20 min guillotined runs that had
// already finished. Configurable via PER_URL_TIMEOUT_MS so the operator can tune
// without a redeploy. See docs/superpowers/plans/2026-05-29-yash-pipeline-timeout-requeue-fix.md.
export function resolveRunTimeoutMs(env = process.env) {
  const raw = parseInt(env.PER_URL_TIMEOUT_MS ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 35 * 60 * 1000;
}
```

Then update the timeout usage inside `realSpawn` (currently `}, PER_URL_TIMEOUT_MS);` at the `// wall-clock timeout: 20 min` block). Replace the comment + setTimeout:

```javascript
  // wall-clock timeout (configurable; default 35 min)
  const runTimeoutMs = resolveRunTimeoutMs();
  const timeout = setTimeout(() => {
    try { child.kill('SIGTERM'); } catch {}
    setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, SIGKILL_GRACE_MS);
  }, runTimeoutMs);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --test-name-pattern='resolveRunTimeoutMs' tests/services/orchestrator-timeout-success.test.mjs`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add services/pipeline-orchestrator.mjs tests/services/orchestrator-timeout-success.test.mjs
git commit -m "fix(orchestrator): make per-URL timeout configurable, raise default 20→35 min"
```

---

### Task 2: Scope the audit-log match to the run window (`findAuditResult`)

**Files:**
- Modify: `services/pipeline-orchestrator.mjs` (`realSpawn` audit parse at `:653-662`; add `startedAt` to the `realSpawn` params and to the `spawn(...)` call in `tickOnce` at `:319`)
- Test: `tests/services/orchestrator-timeout-success.test.mjs`

- [ ] **Step 1: Write the failing test** (append to the test file)

```javascript
test('findAuditResult: returns the last matching line for the URL', () => {
  const text = [
    JSON.stringify({ timestamp: '2026-05-29T17:00:00.000Z', status: 'ok', url: 'http://a/job', score: '90' }),
    JSON.stringify({ timestamp: '2026-05-29T17:30:00.000Z', status: 'ok', url: 'http://a/job', score: '100' }),
  ].join('\n');
  const r = findAuditResult({ auditText: text, url: 'http://a/job', startedAt: '2026-05-29T17:25:00.000Z' });
  assert.equal(r.score, '100', 'must return the in-window (latest) line');
});

test('findAuditResult: ignores a stale line written before the run started', () => {
  // A prior attempt logged ok at 17:00; THIS run started 17:25 and wrote nothing.
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-name-pattern='findAuditResult' tests/services/orchestrator-timeout-success.test.mjs`
Expected: FAIL — `findAuditResult` is not exported.

- [ ] **Step 3: Implement `findAuditResult` and wire it into `realSpawn`**

Add near the other exported helpers (e.g., just below `resolveAuditLogPath`):

```javascript
// Tolerance for clock granularity between tickOnce's startedAt stamp and the
// pipeline's audit-line timestamp (same host; effectively 0, but be generous).
const AUDIT_WINDOW_SKEW_MS = 5_000;

/**
 * Find the audit-log line that belongs to THIS run: the latest JSONL line whose
 * `url` matches and whose `timestamp` is within the run window (>= startedAt).
 * The window guard prevents a stale line from a prior attempt from falsely
 * crediting a later attempt. Returns the raw parsed object or null.
 */
export function findAuditResult({ auditText, url, startedAt = null }) {
  if (!auditText) return null;
  const minTs = startedAt ? Date.parse(startedAt) : null;
  const lines = auditText.trim().split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    let obj;
    try { obj = JSON.parse(lines[i]); } catch { continue; }
    if (obj.url !== url) continue;
    if (minTs !== null && obj.timestamp) {
      const ts = Date.parse(obj.timestamp);
      if (!Number.isNaN(ts) && ts < minTs - AUDIT_WINDOW_SKEW_MS) continue;
    }
    return obj;
  }
  return null;
}
```

Add `startedAt` to the `realSpawn` destructured params (currently `export async function realSpawn({ runId, queueId, url, urlHash, projectRoot, dbPath, claudeModel, mode = 'fresh', resumeContext = null }, ...`):

```javascript
export async function realSpawn({ runId, queueId, url, urlHash, projectRoot, dbPath, claudeModel, startedAt = null, mode = 'fresh', resumeContext = null }, { onPhaseEnd, onSpawn, db }) {
```

Replace the audit parse block (currently the `const auditPath = resolveAuditLogPath(projectRoot); let parsed = null; if (existsSync(auditPath)) { ...for loop... }`):

```javascript
  const auditPath = resolveAuditLogPath(projectRoot);
  let parsed = null;
  if (existsSync(auditPath)) {
    parsed = findAuditResult({ auditText: readFileSync(auditPath, 'utf-8'), url, startedAt });
  }
```

In `tickOnce`, thread `startedAt` into the spawn call (currently `result = await spawn({ runId, queueId: next.id, url: next.url, urlHash: next.url_hash, projectRoot, claudeModel });`):

```javascript
    result = await spawn({
      runId, queueId: next.id, url: next.url, urlHash: next.url_hash,
      projectRoot, claudeModel, startedAt,
    });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --test-name-pattern='findAuditResult' tests/services/orchestrator-timeout-success.test.mjs`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add services/pipeline-orchestrator.mjs tests/services/orchestrator-timeout-success.test.mjs
git commit -m "fix(orchestrator): scope audit-log match to run window via findAuditResult"
```

---

### Task 3: Determine success by ground truth, not exit code (the core fix)

**Files:**
- Modify: `services/pipeline-orchestrator.mjs` (`tickOnce` success block, currently `if (result.exitCode === 0) { ... } ` through the `// failure or cancelled` comment, ~`:423-491`)
- Test: `tests/services/orchestrator-timeout-success.test.mjs`

- [ ] **Step 1: Write the failing tests** (append to the test file)

```javascript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-name-pattern='SIGTERM-killed' tests/services/orchestrator-timeout-success.test.mjs`
Expected: FAIL — the first test fails with `action === 'requeued'` (current code routes exit 143 to the failure branch).

- [ ] **Step 3: Restructure the success determination in `tickOnce`**

Replace the entire block from `if (result.exitCode === 0) {` down to (but NOT including) the `// Shared 3-strike retry policy` comment. The current block contains the `verifyRunArtifacts` call, the `verify.kind === 'skip'` branch, the `!verify.ok` reroute, the `else` success branch (with `formatSuccess` + PDF uploads), the closing `}` of the `if (exitCode===0)`, and the `// failure or cancelled` + `const cancelled = isCancelRequested(...)` block. Replace ALL of it with:

```javascript
  // ── Ground-truth success determination (2026-05-29 fix) ─────────────────────
  // A run is successful when it legitimately skipped OR produced all three
  // declared artifacts on disk — REGARDLESS of the claude -p exit code. Before
  // this, success was gated on exitCode===0, so a run that finished the pipeline
  // but was SIGTERM'd at the wall-clock timeout (exit 143) just before the process
  // exited was misclassified as a failure and re-queued — which then surfaced as a
  // false "duplicate (all artifacts already exist)" skip (OpenLoop) or an
  // incomplete_artifacts failure (StackAdapt) on the retry.
  // findAuditResult (in realSpawn) already scopes result.* to THIS run's window,
  // so stale prior-attempt lines cannot leak in.
  const verify = verifyRunArtifacts({ result, projectRoot });

  if (verify.kind === 'skip') {
    updateRunEnd(db, runId, {
      endedAt, status: 'ok', score: result.score, slug: result.slug,
      jdPath: result.jdPath, resumePdf: result.resumePdf, coverLetterPdf: result.coverLetterPdf,
      tokensIn: result.tokensIn, tokensOut: result.tokensOut, costUsd: result.costUsd,
      phaseTimingsJson: result.phaseTimingsJson,
    });
    markQueueDone(db, next.id);
    deleteCheckpoint(db, runId);
    runLog.info({
      event: 'run_completed_skip', exit_code: result.exitCode, skip_reason: result.skipReason || null,
    }, 'run completed via mark-skipped (no new artifacts)');
    notify(formatSkipped({ runId, hostname: hostnameOf(next.url), reason: result.skipReason }));
    return { action: 'completed_skip', runId };
  }

  if (verify.ok) {
    updateRunEnd(db, runId, {
      endedAt, status: 'ok', score: result.score, slug: result.slug,
      jdPath: result.jdPath, resumePdf: result.resumePdf, coverLetterPdf: result.coverLetterPdf,
      tokensIn: result.tokensIn, tokensOut: result.tokensOut, costUsd: result.costUsd,
      phaseTimingsJson: result.phaseTimingsJson,
    });
    markQueueDone(db, next.id);
    deleteCheckpoint(db, runId);
    runLog.info({
      event: 'run_completed_ok', exit_code: result.exitCode,
      score: result.score ?? null, duration_ms: result.durationMs ?? null,
      company: result.company || null, role: result.role || null,
    }, 'run completed ok');
    notify(formatSuccess({
      runId, company: result.company || hostnameOf(next.url), role: result.role || '(role unknown)',
      score: result.score ?? 0, totalMs: result.durationMs,
    }));
    if (result.resumePdf && existsSync(result.resumePdf) && notifyChatId) {
      try {
        const { sendDocument } = await import('./telegram-client.mjs');
        await sendDocument(result.resumePdf, { chatId: notifyChatId, caption: `Resume #${runId}` });
      } catch (e) {
        runLog.warn({ event: 'pdf_upload_failed', kind: 'resume', err: e }, 'resume PDF upload failed');
        notify(`⚠️ resume upload failed: ${e.message}`);
      }
    }
    if (result.coverLetterPdf && existsSync(result.coverLetterPdf) && notifyChatId) {
      try {
        const { sendDocument } = await import('./telegram-client.mjs');
        await sendDocument(result.coverLetterPdf, { chatId: notifyChatId, caption: `Cover Letter #${runId}` });
      } catch (e) {
        runLog.warn({ event: 'pdf_upload_failed', kind: 'cover_letter', err: e }, 'cover-letter PDF upload failed');
        notify(`⚠️ cover-letter upload failed: ${e.message}`);
      }
    }
    return { action: 'completed_ok', runId };
  }

  // ── No completion evidence on disk ──────────────────────────────────────────
  // Cancellation wins over retry.
  const cancelled = isCancelRequested(db, next.id);
  if (cancelled) {
    updateRunEnd(db, runId, { endedAt, status: 'cancelled', error: 'user-cancelled' });
    markQueueCancelled(db, next.id);
    deleteCheckpoint(db, runId);
    runLog.info({ event: 'run_cancelled' }, 'run cancelled by user');
    notify(formatCancelled({ runId }));
    return { action: 'completed_cancelled', runId };
  }

  // A clean exit (0) that produced nothing is a false success — record the precise
  // missing artifacts so the 3-strike retry reattempts the right work.
  if (result.exitCode === 0) {
    runLog.error({
      event: 'incomplete_artifacts', missing: verify.missing,
      declared_jd: result.jdPath, declared_pdf: result.resumePdf, declared_cl: result.coverLetterPdf,
    }, 'runner reported exit 0 but expected artifacts are missing');
    result = {
      ...result, exitCode: 1,
      error: `incomplete_artifacts: ${verify.missing.join(', ')}`,
      failedPhase: 'verify_artifacts',
    };
  }
```

> Implementer note: after this replacement the next line is the existing `// Shared 3-strike retry policy ...` comment and `const MAX_ATTEMPTS = 3;`. Do NOT duplicate the cancelled check — it has been moved up into the block above and removed from its old position.

- [ ] **Step 4: Run the new tests, then the FULL existing orchestrator suite**

```bash
node --test --test-name-pattern='SIGTERM-killed' tests/services/orchestrator-timeout-success.test.mjs
node --test tests/services/orchestrator-retry.test.mjs tests/services/orchestrator-artifact-gate.test.mjs tests/services/orchestrator.test.mjs
```
Expected: all PASS. (The retry/artifact-gate/cancellation/shutdown_interrupt tests must remain green — the restructure preserves their behavior.)

- [ ] **Step 5: Commit**

```bash
git add services/pipeline-orchestrator.mjs tests/services/orchestrator-timeout-success.test.mjs
git commit -m "fix(orchestrator): credit completed/skip runs by ground truth, not exit code"
```

---

### Task 4: Make `mark-skipped` deterministically append a `status:skip` audit line

**Files:**
- Modify: `yash-resume-pipeline.mjs` (`SUBCOMMANDS['mark-skipped']`, ~`:313`)
- Modify: `shivani-resume-pipeline.mjs` (its `mark-skipped` subcommand — mirror)
- Test: `tests/yash-resume-pipeline.test.mjs`

Why: StackAdapt runs 91/92 did a duplicate-skip but printed only prose — no audit JSONL line — so `findAuditResult` returned null and the orchestrator saw `incomplete_artifacts`. Making `mark-skipped` itself write the audit line removes the dependence on the agent remembering a separate `log --status skip` call.

- [ ] **Step 1: Write the failing test** (append to `tests/yash-resume-pipeline.test.mjs`, matching that file's existing harness for invoking subcommands; use its established `runCli`/`PROJECT_ROOT` pattern)

```javascript
test('mark-skipped appends a status:skip line to the runs audit log', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'yash-markskip-'));
  try {
    mkdirSync(join(dir, 'data'), { recursive: true });
    writeFileSync(join(dir, 'data/yash-pipeline.md'), '## Pendientes\n- [ ] http://acme.com/job\n\n## Procesadas\n');
    const env = { ...process.env, PROJECT_ROOT: dir, SKIP_QUEUE_AUTO_COMMIT: '1' };
    execFileSync('node', ['yash-resume-pipeline.mjs', 'mark-skipped', '--url', 'http://acme.com/job', '--reason', 'duplicate (all artifacts already exist)'], { env, cwd: process.cwd() });
    const log = readFileSync(join(dir, 'data/yash-resume-runs.log'), 'utf-8').trim();
    const obj = JSON.parse(log.split('\n').pop());
    assert.equal(obj.status, 'skip');
    assert.equal(obj.url, 'http://acme.com/job');
    assert.match(obj.reason, /duplicate/);
    assert.ok(obj.timestamp, 'must include a timestamp so findAuditResult can window-match it');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
```

> Implementer note: ensure the test file imports `execFileSync` from `node:child_process` and `mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync` from `node:fs` (add only the missing ones; reuse the file's existing imports/harness — if it already has a `runSub()` helper, use that instead of `execFileSync`).

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-name-pattern='mark-skipped appends' tests/yash-resume-pipeline.test.mjs`
Expected: FAIL — `data/yash-resume-runs.log` does not exist / has no skip line (mark-skipped currently only writes `pipeline.md`).

- [ ] **Step 3: Append the audit line in `mark-skipped`**

In `yash-resume-pipeline.mjs`, in `SUBCOMMANDS['mark-skipped']`, after `await commitQueueAfterMutation('skipped', url);` and before `ok({});`, add:

```javascript
  // Also record the skip in the run audit log so the orchestrator's findAuditResult
  // sees a deterministic status:skip signal (the agent no longer has to remember a
  // separate `log --status skip` call). Additive — never removes existing lines.
  const skipLogPath = runsLogPath();
  await mkdir(dirname(skipLogPath), { recursive: true });
  await appendFile(skipLogPath, JSON.stringify({
    timestamp: new Date().toISOString(), status: 'skip', url, reason: sanitizeReason(reason),
  }) + '\n');
```

Apply the identical change to `shivani-resume-pipeline.mjs`'s `mark-skipped` (it has its own `runsLogPath()` → `data/shivani-resume-runs.log`; confirm `appendFile`, `mkdir`, `dirname`, `sanitizeReason` are imported there — they follow the same module shape).

- [ ] **Step 4: Run tests**

```bash
node --test --test-name-pattern='mark-skipped appends' tests/yash-resume-pipeline.test.mjs
node --test tests/yash-resume-pipeline.test.mjs tests/shivani-resume-pipeline.test.mjs
```
Expected: PASS (no regressions).

- [ ] **Step 5: Commit**

```bash
git add yash-resume-pipeline.mjs shivani-resume-pipeline.mjs tests/yash-resume-pipeline.test.mjs
git commit -m "fix(pipeline): mark-skipped writes a status:skip audit line (yash+shivani)"
```

---

### Task 5: Docs — correct stale latency, document the timeout knob, write the RCA

**Files:**
- Modify: `.claude/skills/yash-pipeline-autonomous-agent/SKILL.md`, `.claude/skills/shivani-pipeline-autonomous-agent/SKILL.md`
- Modify: `ops/telegram.env.example`, `ops/shivani/telegram.env.example`
- Create: `docs/superpowers/audits/2026-05-29-yash-timeout-requeue-false-duplicate-rca.md`

- [ ] **Step 1: Fix the stale per-URL latency line in both SKILL.md files**

In `.claude/skills/yash-pipeline-autonomous-agent/SKILL.md`, replace `Per-URL latency 6–14 min (preserves the existing /yash-resume-pipeline budget; no improvement).` with:

```
Per-URL latency ~13–25 min (Sonnet 4.6 / xhigh, full JD→resume→cover-letter). The orchestrator's per-URL wall-clock timeout is **35 min** (configurable via `PER_URL_TIMEOUT_MS`); a run that finishes is credited even if SIGTERM'd at the timeout (success is gated on artifacts-on-disk, not exit code).
```
Apply the analogous correction in the Shivani SKILL.md.

- [ ] **Step 2: Document `PER_URL_TIMEOUT_MS` in both env templates**

In `ops/telegram.env.example` (and `ops/shivani/telegram.env.example`), under the Claude model block, add:

```
# ── Per-URL run timeout (default 35 min = 2100000 ms; raise for very slow boards) ──
# PER_URL_TIMEOUT_MS=2100000
```

- [ ] **Step 3: Write the RCA audit doc**

Create `docs/superpowers/audits/2026-05-29-yash-timeout-requeue-false-duplicate-rca.md` containing: the symptom, the evidence table (runs 85–92 with exit 143 / windows), the root-cause chain (20-min timeout → exit-code-only success gate → 3-strike requeue → false duplicate/incomplete), the fix (configurable 35-min timeout + ground-truth success + run-window audit match + deterministic skip logging), and the locked operator decisions.

- [ ] **Step 4: Commit**

```bash
git add .claude/skills/*/SKILL.md ops/telegram.env.example ops/shivani/telegram.env.example docs/superpowers/audits/2026-05-29-yash-timeout-requeue-false-duplicate-rca.md
git commit -m "docs: correct per-URL latency, document PER_URL_TIMEOUT_MS, add RCA"
```

---

### Task 6: Full verification (all gates green before PR)

**Files:** none (verification only)

- [ ] **Step 1: Run the full service test suite**

Run: `npm run test:services`
Expected: all tests PASS (including the new `orchestrator-timeout-success.test.mjs`), zero failures.

- [ ] **Step 2: Run the e2e smoke + secrets check + pipeline verifier**

```bash
npm run smoke
npm run secrets:check
node verify-pipeline.mjs
```
Expected: smoke PASS (~6s, deterministic), secrets check clean, pipeline verifier OK.

- [ ] **Step 3: Confirm no accidental behavior change to effort/model**

Run: `grep -nE "CLAUDE_MODEL|CLAUDE_EFFORT|--effort|--model" services/pipeline-orchestrator.mjs`
Expected: model default still `claude-sonnet-4-6`, effort default still `xhigh` (this PR must NOT change them).

---

### Task 7: Open the PR

**Files:** none

- [ ] **Step 1: Push the branch and open the PR** (run from the worktree/branch)

```bash
git push -u origin fix/orchestrator-timeout-requeue-false-duplicate
gh pr create --base main --title "fix(orchestrator): stop re-queuing completed runs (20-min timeout → false duplicate)" --body "<RCA summary + test evidence + deploy plan>"
```
Expected: PR URL returned; GitHub Actions (`test-all.mjs`, labeler) start.

- [ ] **Step 2: Wait for CI green.** If CI fails, return to systematic-debugging Phase 1 on the CI output before any further change.

---

### Task 8: Deploy (operator-confirmed; restarts both orchestrators)

**Files:** none (operational). **Outward-facing / production — proceed only after CI green.**

- [ ] **Step 1: Land the fix on the live `main` checkout**

Merge the PR (admin), then on the VPS bring the live checkout to the merge commit WITHOUT a destructive reset (respect the 2026-05-25 data-loss RCA — never `git reset --hard` the dirty tree). If the working tree is dirty, stash the unrelated change first:
```bash
cd /yash-superClaudeHuman/projects/yash-ai-automation-career
git stash push -u -m "pre-deploy stash" -- scrapling_fetch.py   # only if dirty & blocking
git fetch origin && git merge --ff-only origin/main
```

- [ ] **Step 2: Restart both orchestrators**

```bash
systemctl --user restart pipeline-orchestrator shivani-pipeline-orchestrator
systemctl --user status pipeline-orchestrator shivani-pipeline-orchestrator --no-pager
```
Expected: both `active (running)`; a `✅ Bot online` Telegram message from each; any in-flight run re-queued/resumed via the shutdown path.

- [ ] **Step 3: Confirm the new code is live**

```bash
journalctl --user -u pipeline-orchestrator -n 20 --no-pager | grep -E "bot_online|git "
grep -n "resolveRunTimeoutMs" services/pipeline-orchestrator.mjs
```
Expected: orchestrator running the merged commit; `resolveRunTimeoutMs` present.

---

### Task 9: Production smoke test via the live bot

**Files:** none (operational). Requires 1–2 operator-supplied fresh smoke URLs (fast boards: Greenhouse/Ashby/Lever).

- [ ] **Step 1: Enqueue a smoke URL** (operator `/add <url>` via Telegram, or insert into the queue) and watch it.

```bash
# tail the orchestrator while it runs
journalctl --user -u pipeline-orchestrator -f --no-pager
```

- [ ] **Step 2: Verify the fix end-to-end.** Expected within one attempt: `spawn_start` → phase pings → `run_completed_ok` with `exit_code: 0`; queue row `done`, `attempts=0`; resume + cover-letter PDFs delivered to Telegram; **no** `re-queued`, **no** "duplicate (all artifacts already exist)", **no** `incomplete_artifacts`.

```bash
sqlite3 ops/work-queue.db "SELECT id,status,attempts,url FROM queue ORDER BY id DESC LIMIT 3;"
sqlite3 ops/work-queue.db "SELECT id,queue_id,status FROM runs ORDER BY id DESC LIMIT 3;"
```

---

### Task 10: Remediate today's three URLs (operator chose "re-deliver + finish Cineplex")

**Files:** none (operational). Each Telegram send is an outward-facing action — confirm before sending.

- [ ] **Step 1: OpenLoop** — artifacts complete; queue already `done` but surfaced as a skip. Re-deliver the resume + cover-letter PDFs to the operator's Telegram chat (use `services/telegram-client.mjs sendDocument`). No recompute.
- [ ] **Step 2: StackAdapt** — artifacts complete; queue row 67 is `failed`. Re-deliver both PDFs; correct the queue row to `done` and fix the `pipeline.md` entry from skipped→processed.
- [ ] **Step 3: Cineplex** — JD + resume exist, cover letter missing; queue row 65 is `failed`. Generate ONLY the missing cover letter (cover-letter prompt over the existing JD/resume), deliver it, then correct the queue row + `pipeline.md`.
- [ ] **Step 4: Verify** all three reflected correctly in `data/yash-pipeline.md`, `ops/work-queue.db`, and `data/yash-resume-runs.log`; operator confirms receipt of PDFs.

---

## Self-review

- **Spec coverage:** root cause (Tasks 1–4) ✓; durability/"never again" (ground-truth success + run-window match + deterministic skip log + configurable timeout) ✓; keep xhigh/sonnet-4-6 (Task 6 Step 3 guard) ✓; both tenants (shared orchestrator + mirrored mark-skipped) ✓; PR on branch (Task 7) ✓; deploy + smoke test (Tasks 8–9) ✓; re-deliver + finish Cineplex (Task 10) ✓; RCA documented (Task 5) ✓.
- **Placeholder scan:** PR body in Task 7 is the only `<...>` (intentional, filled at PR time); RCA doc contents enumerated. No code-step placeholders.
- **Type/name consistency:** `resolveRunTimeoutMs(env)`, `findAuditResult({auditText,url,startedAt})`, `realSpawn({...,startedAt})`, `verifyRunArtifacts({result,projectRoot})`, `result.isSkip`/`skipReason`/`jdPath`/`resumePdf`/`coverLetterPdf` — consistent across tasks and match the existing exports.
