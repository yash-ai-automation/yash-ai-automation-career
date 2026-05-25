// services/pipeline-orchestrator.mjs
// State machine + main daemon entry. Pure orchestration logic is exported as
// tickOnce({db, projectRoot, capLimits, gitSha, claudeModel, spawn, notify})
// so it can be unit-tested without spawning real `claude -p`.
//
// The real daemon is in main() at the bottom; it wires real spawn() + notify()
// into tickOnce() and runs the poll loop with a 2-second cadence.

import { spawn as nodeSpawn } from 'node:child_process';
import { resolve, join } from 'node:path';
import { mkdirSync, createWriteStream, readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';

import { initDb, integrityCheck, closeDb, topHintsByHost } from './db.mjs';
import {
  selectNextQueued, markQueueRunning, markQueueDone, markQueueFailed, markQueueCancelled,
  insertRun, updateRunStart, updateRunEnd, deleteCheckpoint,
  isCancelRequested, selectCheckpoint, selectQueueLen, countByStatus,
  findOrphanedRunning, repairOrphanedRunning,
} from './queue.mjs';
import { checkCap } from './cap.mjs';
import { analyzeRebootState, computeNextPhase, PHASE_ORDER } from './reboot-resume.mjs';
import { formatStart, formatSuccess, formatFailure, formatCapReached, formatPhaseEnd, formatCancelled } from './notifier.mjs';
import { notifyReady, notifyStopping, startWatchdogPinger } from './sd-notify.mjs';
import { createLogger } from './logger.mjs';
import { assertTenantDbConsistency } from './telegram-listener.mjs';
// NOTE: telegram-client.mjs is NOT statically imported here — it doesn't exist until Task 3.1.
// All calls use lazy dynamic import() with try/catch fallback inside main() and tickOnce().

// Tenant is read from process.env at import time — daemons always have TENANT
// set before node loads (systemd EnvironmentFile), so the orchestrator's
// journald lines now carry `tenant=shivani` (or omit the field for Yash). This
// makes cross-tenant misroutes detectable in one `grep tenant=` instead of
// hunting through pid → cgroup → unit.
const defaultLogger = createLogger({
  service: 'pipeline-orchestrator',
  tenant: (process.env.TENANT || '').trim().toLowerCase() || undefined,
});

// ── Healthchecks.io heartbeat ────────────────────────────────────────────────
// Opt-in: set HEALTHCHECK_PING_URL to a Healthchecks.io ping URL.
// When env var is missing, returns a no-op stop function.
// Network errors are swallowed silently so the daemon never crashes on a
// transient outage. The setInterval is unref()'d so tests exit cleanly.
export function startHeartbeat({ httpClient = fetch, intervalMs = 60_000 } = {}) {
  if (!process.env.HEALTHCHECK_PING_URL) return () => {};
  const url = process.env.HEALTHCHECK_PING_URL;
  const handle = setInterval(() => {
    httpClient(url).catch(() => {});
  }, intervalMs);
  if (handle.unref) handle.unref();
  return () => clearInterval(handle);
}

const POLL_MS = 2_000;
const CHECKPOINT_POLL_MS = 2_000;
const PER_URL_TIMEOUT_MS = 20 * 60 * 1000;   // 20 min per Q3 default
const SIGKILL_GRACE_MS = 10_000;

function hostnameOf(url) {
  try { return new URL(url).hostname; } catch { return '(unknown)'; }
}

// ── tenant-aware path resolvers ─────────────────────────────────────────────
// These pull the audit-log path and preamble dir from env vars so a single
// orchestrator codebase serves both Yash (default) and Shivani tenants without
// fork. Both resolvers fall back to Yash defaults when the env var is unset
// or empty.

export function resolveAuditLogPath(projectRoot, env = process.env) {
  const raw = (env.AUDIT_LOG_PATH || '').trim();
  if (!raw) return resolve(projectRoot, 'data/yash-resume-runs.log');
  return raw.startsWith('/') ? raw : resolve(projectRoot, raw);
}

export function resolvePreambleDir(projectRoot, env = process.env) {
  const raw = (env.PREAMBLE_DIR || '').trim();
  if (!raw) return resolve(projectRoot, 'ops/preambles');
  return raw.startsWith('/') ? raw : resolve(projectRoot, raw);
}

// ── preamble helpers ────────────────────────────────────────────────────────
// Exported so tests can verify substitution without spawning claude.

// renderPreambleWithHints: pure string transform.
// When FEATURE_FAILURE_KB=1, substitutes $LEARNED_HINTS with bulleted top-3
// hints from failure_patterns for the given URL's hostname. When flag is OFF,
// substitutes with empty string so the placeholder disappears cleanly.
export function renderPreambleWithHints(db, url, template) {
  if (process.env.FEATURE_FAILURE_KB !== '1') {
    return template.replace(/\$LEARNED_HINTS/g, '');
  }
  let host = 'unknown';
  try { host = new URL(url).hostname.toLowerCase(); } catch {}
  const hints = topHintsByHost(db, host, 3);
  const bullets = hints.map(h => `- ${h.hint}`).join('\n');
  return template.replace(/\$LEARNED_HINTS/g, bullets);
}

// renderPreamble: reads preamble file, optionally injects hints via db, then
// substitutes all $VAR tokens. When db is null the hint pass is skipped
// (backwards compatible with all existing callers that omit db).
export function renderPreamble({ projectRoot, mode = 'fresh', vars, db = null }) {
  const file = mode === 'resume' ? 'resume-run.md' : 'fresh-run.md';
  const path = join(resolvePreambleDir(projectRoot), file);
  let body = readFileSync(path, 'utf-8');
  // Apply hint injection before variable substitution so $LEARNED_HINTS is
  // resolved before the var loop sees it (avoiding any $-token collisions).
  if (db && vars && vars.URL) {
    body = renderPreambleWithHints(db, vars.URL, body);
  }
  // Sort by key length descending so that $URL_HASH is substituted before $URL,
  // $LAST_PHASE before $LAST, etc. The replacement is a function so $-tokens
  // ($&, $$, …) in the value aren't interpreted as special patterns.
  const entries = Object.entries(vars || {}).sort((a, b) => b[0].length - a[0].length);
  for (const [k, v] of entries) {
    body = body.replaceAll('$' + k, () => String(v));
  }
  return body;
}

export function formatInputsSummary(inputs) {
  if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs) || Object.keys(inputs).length === 0) {
    return '(no prior artifacts recorded)';
  }
  return Object.entries(inputs)
    .map(([k, v]) => `- ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join('\n');
}

export async function tickOnce({ db, projectRoot, capLimits, gitSha, claudeModel, spawn, notify, isShuttingDown = () => false, notifyChatId = 0, logger = defaultLogger }) {
  const cap = checkCap(db, capLimits);
  const next = selectNextQueued(db);
  if (!next && !cap.capped) { logger.debug({ event: 'tick_idle' }, 'no work'); return { action: 'idle' }; }
  if (next && cap.capped) {
    logger.info({ event: 'tick_capped', cap_window: cap.window, cap_count: cap.count }, 'cap reached');
    notify(formatCapReached(cap));
    return { action: 'capped' };
  }

  // Race-safe mark-running (UNIQUE index protects us)
  try { markQueueRunning(db, next.id); }
  catch (e) {
    logger.warn({ event: 'race_lost', queue_id: next.id, err: e }, 'lost race for queue row');
    return { action: 'race_lost', error: e.message };
  }

  const startedAt = new Date().toISOString();
  const runId = insertRun(db, { queueId: next.id, url: next.url, startedAt });
  updateRunStart(db, runId, { gitSha, claudeModel });

  const runLog = logger.child({ queue_id: next.id, run_id: runId, url: next.url });
  runLog.info({ event: 'spawn_start', git_sha: gitSha, claude_model: claudeModel }, 'spawning claude -p');
  notify(formatStart({ runId, hostname: hostnameOf(next.url) }));

  let result;
  try {
    result = await spawn({
      runId, queueId: next.id, url: next.url, urlHash: next.url_hash,
      projectRoot, claudeModel,
    });
  } catch (e) {
    runLog.error({ event: 'spawn_threw', err: e }, 'spawn() threw');
    result = { exitCode: -1, error: `spawn failed: ${e.message}`, failedPhase: 'spawn' };
  }

  const endedAt = new Date().toISOString();

  // If the orchestrator is shutting down AND the spawn was killed (non-zero exit
  // that wasn't a user cancel), leave queue/run/checkpoint state intact so the
  // resume code path engages on next boot. Without this, the existing post-spawn
  // fail bookkeeping would delete the checkpoint and reset the queue to 'queued',
  // forcing a from-scratch redo of every completed phase.
  if (isShuttingDown() && result.exitCode !== 0 && !isCancelRequested(db, next.id)) {
    const cp = selectCheckpoint(db, runId);
    const lastPhase = cp?.last_phase || '(pre-checkpoint)';
    runLog.info({ event: 'shutdown_interrupt', last_phase: lastPhase }, 'paused for shutdown; will resume next boot');
    notify(`⏸️ Run #${runId} paused at \`${lastPhase}\` due to shutdown; will resume on next boot.`);
    return { action: 'shutdown_interrupt', runId, lastPhase };
  }

  if (result.exitCode === 0) {
    updateRunEnd(db, runId, {
      endedAt, status: 'ok', score: result.score, slug: result.slug,
      jdPath: result.jdPath, resumePdf: result.resumePdf, coverLetterPdf: result.coverLetterPdf,
      tokensIn: result.tokensIn, tokensOut: result.tokensOut, costUsd: result.costUsd,
      phaseTimingsJson: result.phaseTimingsJson,
    });
    markQueueDone(db, next.id);
    deleteCheckpoint(db, runId);
    runLog.info({
      event: 'run_completed_ok',
      score: result.score ?? null,
      duration_ms: result.durationMs ?? null,
      company: result.company || null,
      role: result.role || null,
    }, 'run completed ok');
    notify(formatSuccess({
      runId, company: result.company || hostnameOf(next.url), role: result.role || '(role unknown)',
      score: result.score ?? 0, totalMs: result.durationMs,
    }));
    // Lazy-import sendDocument only when we have a PDF to send. If telegram-client
    // doesn't exist or chatId is unset, skip the upload (still mark run done — the
    // PDF is on disk; the Telegram delivery is best-effort).
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

  // failure or cancelled
  const cancelled = isCancelRequested(db, next.id);
  if (cancelled) {
    updateRunEnd(db, runId, { endedAt, status: 'cancelled', error: 'user-cancelled' });
    markQueueCancelled(db, next.id);
    deleteCheckpoint(db, runId);
    runLog.info({ event: 'run_cancelled' }, 'run cancelled by user');
    notify(formatCancelled({ runId }));
    return { action: 'completed_cancelled', runId };
  }

  // Shared 3-strike retry policy (plan §4.8 / Q6 — applies to Yash AND Shivani).
  // After each non-cancelled failure, increment `attempts`; if newAttempts < MAX,
  // re-queue (status='queued', assigned_at cleared) and notify "attempt N/MAX … re-queued".
  // On the final strike, fall through to the existing markQueueFailed + failure_kb path.
  const MAX_ATTEMPTS = 3;
  const newAttempts = (next.attempts ?? 0) + 1;
  const willRetry = newAttempts < MAX_ATTEMPTS;

  updateRunEnd(db, runId, {
    endedAt, status: 'fail',
    error: result.error || `exit ${result.exitCode}`,
    phaseTimingsJson: result.phaseTimingsJson,
  });
  if (willRetry) {
    db.prepare(`UPDATE queue SET status='queued', attempts=?, assigned_at=NULL WHERE id=?`).run(newAttempts, next.id);
  } else {
    db.prepare(`UPDATE queue SET status='failed', attempts=?, completed_at=? WHERE id=?`).run(newAttempts, endedAt, next.id);
  }
  deleteCheckpoint(db, runId);
  runLog.error({
    event: 'run_failed',
    failed_phase: result.failedPhase || 'unknown',
    exit_code: result.exitCode,
    error: result.error || '',
    attempts: newAttempts,
    max_attempts: MAX_ATTEMPTS,
    requeued: willRetry,
  }, willRetry ? 'run failed; re-queuing for retry' : 'run failed (final attempt)');
  if (process.env.FEATURE_FAILURE_KB === '1') {
    try {
      const logPath = join(projectRoot, 'ops/runs', String(runId), 'claude.log');
      let errorText = result.error || '';
      if (existsSync(logPath)) {
        const full = readFileSync(logPath, 'utf8');
        errorText = full.slice(-4096); // last 4 KB of claude.log
      }
      const reviewDir = join(projectRoot, 'ops/kb-review-queue');
      const { learnFromFailure } = await import('./failure-kb.mjs');
      const learnResult = await learnFromFailure(db, runId, errorText, { url: next.url, reviewDir });
      runLog.info({
        event: 'failure_kb_result', kind: learnResult.kind, signature: learnResult.signature
      }, 'learnFromFailure complete');
      if (learnResult.kind === 'review-queued') {
        let host = '(unknown)';
        try { host = new URL(next.url).hostname; } catch {}
        notify(`⚠️ New fault signature observed at ${host}\nSnippet: ${learnResult.snippet}\nReview ops/kb-review-queue/${runId}.json`);
      }
    } catch (e) {
      runLog.warn({ event: 'failure_kb_threw', err: e.message }, 'learnFromFailure threw; continuing');
    }
  }
  if (willRetry) {
    notify(`⚠️ Run #${runId} failed (attempt ${newAttempts}/${MAX_ATTEMPTS}); re-queued`);
    return { action: 'requeued', runId, attempts: newAttempts };
  }
  notify(`${formatFailure({
    runId, hostname: hostnameOf(next.url),
    phase: result.failedPhase || 'unknown', error: result.error || '',
  })}\n(attempt ${newAttempts}/${MAX_ATTEMPTS} — moving to failed)`);
  return { action: 'completed_fail', runId, attempts: newAttempts };
}

// --- real spawn(): one `claude -p` per URL, with checkpoint-polling for phase pings ---
//
// This is the production glue. The signature matches what tickOnce passes in.
// `mode` is 'fresh' (default) or 'resume'; `resumeContext` carries the extra vars
// (LAST_PHASE, NEXT_PHASE, INPUTS_SUMMARY) substituted into the resume preamble.
export async function realSpawn({ runId, queueId, url, urlHash, projectRoot, dbPath, claudeModel, mode = 'fresh', resumeContext = null }, { onPhaseEnd, onSpawn, db }) {
  const preamble = renderPreamble({
    projectRoot, mode,
    vars: {
      URL: url, RUN_ID: runId, URL_HASH: urlHash, PROJECT_ROOT: projectRoot,
      ...(resumeContext || {}),
    },
    db,
  });

  const runDir = join(projectRoot, 'ops/runs', String(runId));
  mkdirSync(runDir, { recursive: true });
  const claudeLogPath = join(runDir, 'claude.log');
  const eventsPath = join(runDir, 'events.jsonl');
  const logStream = createWriteStream(claudeLogPath);

  const child = nodeSpawn('claude', [
    '-p', preamble,
    '--print',
    '--dangerously-skip-permissions',
    '--add-dir', projectRoot,
    '--model', claudeModel,
  ], {
    cwd: projectRoot,
    env: {
      ...process.env,
      RUN_ID: String(runId),
      URL: url,
      URL_HASH: urlHash,
      PROJECT_ROOT: projectRoot,
      WORK_QUEUE_DB: dbPath,
      CHECKPOINT_DIR: join(projectRoot, 'ops/checkpoints'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.pipe(logStream);
  child.stderr.pipe(logStream);

  // Surface the child to the orchestrator so the main loop's SIGTERM handler can
  // signal it directly during shutdown (faster than the 2s cancel poll).
  if (typeof onSpawn === 'function') {
    try { onSpawn(child); }
    catch (e) { defaultLogger.error({ event: 'on_spawn_hook_failed', run_id: runId, err: e }, 'onSpawn hook threw'); }
  }

  // checkpoint poll: every 2s, read checkpoints.last_phase; if changed, fire onPhaseEnd
  let lastSeenPhase = null;
  const phaseStarts = new Map();
  const phasePoll = setInterval(() => {
    const cp = selectCheckpoint(db, runId);
    if (cp && cp.last_phase !== lastSeenPhase) {
      const now = Date.now();
      const startedAt = phaseStarts.get(cp.last_phase) || now;
      onPhaseEnd({ phase: cp.last_phase, elapsedMs: now - startedAt });
      phaseStarts.set(cp.last_phase, now);
      lastSeenPhase = cp.last_phase;
    }
  }, CHECKPOINT_POLL_MS);

  // cancel poll: every 2s, check cancel_requested → SIGTERM → 10s grace → SIGKILL
  const cancelPoll = setInterval(() => {
    if (isCancelRequested(db, queueId)) {
      try { child.kill('SIGTERM'); } catch {}
      setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, SIGKILL_GRACE_MS);
    }
  }, CHECKPOINT_POLL_MS);

  // wall-clock timeout: 20 min
  const timeout = setTimeout(() => {
    try { child.kill('SIGTERM'); } catch {}
    setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, SIGKILL_GRACE_MS);
  }, PER_URL_TIMEOUT_MS);

  const exit = await new Promise((res) => {
    child.on('exit', (code, signal) => res({ code, signal }));
  });

  clearInterval(phasePoll);
  clearInterval(cancelPoll);
  clearTimeout(timeout);
  logStream.end();

  // grep audit log for the per-URL JSONL line
  const auditPath = resolveAuditLogPath(projectRoot);
  let parsed = null;
  if (existsSync(auditPath)) {
    const lines = readFileSync(auditPath, 'utf-8').trim().split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const obj = JSON.parse(lines[i]);
        if (obj.url === url) { parsed = obj; break; }
      } catch {}
    }
  }

  return {
    exitCode: exit.code === null ? 124 : exit.code,
    durationMs: parsed?.total_ms ?? null,
    slug: parsed?.slug ?? null,
    score: parsed?.score ?? null,
    jdPath: parsed?.jd ?? null,
    resumePdf: parsed?.pdf ?? null,
    coverLetterPdf: parsed?.cover_letter_pdf ?? null,
    failedPhase: lastSeenPhase ? computeNextPhase(lastSeenPhase) : 'jd_fetch_end',
    error: exit.code === 0 ? null : `claude -p exit ${exit.code} signal ${exit.signal || 'none'}`,
    phaseTimingsJson: parsed ? JSON.stringify(parsed) : null,
  };
}

// --- resume an in-flight run after a reboot ---
//
// Called once at orchestrator startup when analyzeRebootState() returns state='resume'.
// The queue row is already 'running' and the runs row is already 'running' — we
// spawn `claude -p` with the resume preamble (carrying LAST_PHASE/NEXT_PHASE/
// INPUTS_SUMMARY) and then handle the result exactly like a normal tick would:
// success → markQueueDone+updateRunEnd(ok)+sendDocuments; failure → markQueueFailed;
// cancelled → markQueueCancelled. Checkpoint is deleted in all terminal cases.
//
// `spawn` is injected (defaults to realSpawn) so tests can substitute a fake.
export async function resumeInFlightRun({ db, projectRoot, dbPath, claudeModel, notify, recovery, spawn = realSpawn, onSpawn = () => {}, notifyChatId = 0, logger = defaultLogger }) {
  const resumeLog = logger.child({
    run_id: recovery.runId, queue_id: recovery.queueId, url: recovery.url,
    last_phase: recovery.lastPhase, next_phase: recovery.nextPhase,
  });
  let inputs = {};
  if (recovery.inputsPath && existsSync(recovery.inputsPath)) {
    try {
      inputs = JSON.parse(readFileSync(recovery.inputsPath, 'utf-8'));
    } catch (e) {
      resumeLog.error({ event: 'resume_inputs_parse_failed', inputs_path: recovery.inputsPath, err: e }, 'inputs JSON unparseable');
    }
  }
  const inputsSummary = formatInputsSummary(inputs);

  resumeLog.info({ event: 'resume_start' }, 'resuming from checkpoint');
  notify(formatStart({ runId: recovery.runId, hostname: hostnameOf(recovery.url) }));
  notify(`♻️ Resuming run #${recovery.runId} from \`${recovery.lastPhase}\` → \`${recovery.nextPhase}\``);

  let result;
  try {
    result = await spawn(
      {
        runId: recovery.runId, queueId: recovery.queueId, url: recovery.url, urlHash: recovery.urlHash,
        projectRoot, dbPath, claudeModel,
        mode: 'resume',
        resumeContext: {
          LAST_PHASE: recovery.lastPhase,
          NEXT_PHASE: recovery.nextPhase,
          INPUTS_SUMMARY: inputsSummary,
        },
      },
      {
        db, onSpawn,
        onPhaseEnd: ({ phase, elapsedMs }) => notify(formatPhaseEnd({ runId: recovery.runId, phase, elapsedMs })),
      }
    );
  } catch (e) {
    result = { exitCode: -1, error: `resume spawn failed: ${e.message}`, failedPhase: 'spawn' };
  }

  const endedAt = new Date().toISOString();

  if (result.exitCode === 0) {
    updateRunEnd(db, recovery.runId, {
      endedAt, status: 'ok', score: result.score, slug: result.slug,
      jdPath: result.jdPath, resumePdf: result.resumePdf, coverLetterPdf: result.coverLetterPdf,
      tokensIn: result.tokensIn, tokensOut: result.tokensOut, costUsd: result.costUsd,
      phaseTimingsJson: result.phaseTimingsJson,
    });
    markQueueDone(db, recovery.queueId);
    deleteCheckpoint(db, recovery.runId);
    resumeLog.info({
      event: 'resume_completed_ok',
      score: result.score ?? null,
      duration_ms: result.durationMs ?? null,
    }, 'resumed run completed ok');
    notify(formatSuccess({
      runId: recovery.runId, company: result.company || hostnameOf(recovery.url), role: result.role || '(role unknown)',
      score: result.score ?? 0, totalMs: result.durationMs,
    }));
    if (result.resumePdf && existsSync(result.resumePdf) && notifyChatId) {
      try {
        const { sendDocument } = await import('./telegram-client.mjs');
        await sendDocument(result.resumePdf, { chatId: notifyChatId, caption: `Resume #${recovery.runId} (resumed)` });
      } catch (e) {
        resumeLog.warn({ event: 'pdf_upload_failed', kind: 'resume', err: e }, 'resume PDF upload failed');
        notify(`⚠️ resume upload failed: ${e.message}`);
      }
    }
    if (result.coverLetterPdf && existsSync(result.coverLetterPdf) && notifyChatId) {
      try {
        const { sendDocument } = await import('./telegram-client.mjs');
        await sendDocument(result.coverLetterPdf, { chatId: notifyChatId, caption: `Cover Letter #${recovery.runId} (resumed)` });
      } catch (e) {
        resumeLog.warn({ event: 'pdf_upload_failed', kind: 'cover_letter', err: e }, 'cover-letter PDF upload failed');
        notify(`⚠️ cover-letter upload failed: ${e.message}`);
      }
    }
    return { action: 'completed_ok', runId: recovery.runId };
  }

  if (isCancelRequested(db, recovery.queueId)) {
    updateRunEnd(db, recovery.runId, { endedAt, status: 'cancelled', error: 'user-cancelled' });
    markQueueCancelled(db, recovery.queueId);
    deleteCheckpoint(db, recovery.runId);
    resumeLog.info({ event: 'resume_cancelled' }, 'resumed run cancelled by user');
    notify(formatCancelled({ runId: recovery.runId }));
    return { action: 'completed_cancelled', runId: recovery.runId };
  }

  updateRunEnd(db, recovery.runId, {
    endedAt, status: 'fail',
    error: result.error || `exit ${result.exitCode}`,
    phaseTimingsJson: result.phaseTimingsJson,
  });
  markQueueFailed(db, recovery.queueId);
  deleteCheckpoint(db, recovery.runId);
  resumeLog.error({
    event: 'resume_failed',
    failed_phase: result.failedPhase || recovery.nextPhase || 'unknown',
    exit_code: result.exitCode,
    error: result.error || '',
  }, 'resumed run failed');
  notify(formatFailure({
    runId: recovery.runId, hostname: hostnameOf(recovery.url),
    phase: result.failedPhase || recovery.nextPhase || 'unknown', error: result.error || '',
  }));
  return { action: 'completed_fail', runId: recovery.runId };
}

// --- main entry ---
async function main() {
  const projectRoot = process.env.PROJECT_ROOT || process.cwd();
  const dbPath = process.env.WORK_QUEUE_DB || join(projectRoot, 'ops/work-queue.db');
  // Defense in depth: same guard the listener applies. Catches a misconfigured
  // systemd EnvironmentFile (e.g. Shivani unit pointing WORK_QUEUE_DB at the
  // Yash DB) at process boot, so no Shivani-intended row can ever be picked up
  // by the Yash orchestrator.
  const tenant = (process.env.TENANT || '').trim().toLowerCase() || undefined;
  assertTenantDbConsistency({ tenant, dbPath });
  mkdirSync(join(projectRoot, 'ops/checkpoints'), { recursive: true });
  mkdirSync(join(projectRoot, 'ops/runs'), { recursive: true });

  const db = initDb(dbPath);

  const integrity = integrityCheck(db);
  if (integrity !== 'ok') {
    defaultLogger.fatal({ event: 'integrity_check_failed', integrity }, 'PRAGMA integrity_check failed; bailing');
    process.exit(2);
  }

  // Startup recovery (resume is handled AFTER notify/state setup is wired below)
  const recovery = analyzeRebootState(db);
  if (recovery.state === 'repair') {
    repairOrphanedRunning(db, recovery.queueId);
  } else if (recovery.state === 'restart_from_scratch') {
    markQueueFailed(db, recovery.queueId);
    updateRunEnd(db, recovery.runId, { status: 'cancelled', error: 'reboot-no-checkpoint' });
  } else if (recovery.state === 'corrupt') {
    defaultLogger.fatal({ event: 'reboot_corrupt' }, 'reboot: > 1 running rows; bailing');
    process.exit(3);
  }

  const claudeModel = process.env.CLAUDE_MODEL || 'claude-opus-4-7';
  const gitSha = execSync('git rev-parse HEAD', { cwd: projectRoot }).toString().trim();
  const notifyChatId = parseInt(process.env.TELEGRAM_NOTIFY_CHAT_ID || '0', 10);

  // Lazy-import sendMessage so that this module loads cleanly before telegram-client exists.
  const notify = async (msg) => {
    if (!notifyChatId) { defaultLogger.debug({ event: 'notify_noop', msg }, 'no chat id; notify skipped'); return; }
    try {
      const { sendMessage } = await import('./telegram-client.mjs');
      await sendMessage(msg, { chatId: notifyChatId });
    } catch (e) {
      defaultLogger.warn({ event: 'notify_failed', err: e }, 'telegram sendMessage failed');
    }
  };

  // ── systemd Type=notify lifecycle ────────────────────────────────────────
  // READY=1 lets systemd consider the service "started"; WATCHDOG=1 pings keep
  // it alive under WatchdogSec=300 (ping cadence = 120s ≈ 1/2.5 of the limit).
  await notifyReady('orchestrator');
  const stopWatchdog = startWatchdogPinger(120_000);

  // ── boot notification (one-shot) ────────────────────────────────────────
  const queuedAtBoot = selectQueueLen(db, 'queued');
  const shortSha = gitSha.slice(0, 7);
  defaultLogger.info({ event: 'bot_online', queued: queuedAtBoot, claude_model: claudeModel }, 'orchestrator online');
  await notify(`✅ Bot online · queue: ${queuedAtBoot} waiting · git ${shortSha}`);

  // ── Healthchecks.io heartbeat (opt-in) ───────────────────────────────────
  let stopHeartbeat = () => {};
  if (process.env.FEATURE_WATCHDOG === '1') {
    stopHeartbeat = startHeartbeat();
    defaultLogger.info({ event: 'heartbeat_started' }, 'Healthchecks heartbeat ping started');
  }

  // ── graceful-shutdown state ──────────────────────────────────────────────
  // liveRun tracks the in-flight URL so the signal handler can SIGTERM the
  // child + so the post-tick re-queue logic knows which row to reset.
  const state = { shuttingDown: false, exitCode: 0 };
  const liveRun = { queueId: null, runId: null, child: null };

  const requestShutdown = (sig) => {
    if (state.shuttingDown) return;
    state.shuttingDown = true;
    defaultLogger.info({ event: 'shutdown_requested', signal: sig, live_run_id: liveRun.runId }, 'shutdown requested');
    // Fire-and-forget the user-facing notification — don't block the handler.
    if (liveRun.runId) {
      notify(`🔄 Bot restarting; run #${liveRun.runId} will be re-queued and retried on next boot.`).catch(() => {});
    } else {
      notify(`🔄 Bot restarting; queue preserved on disk.`).catch(() => {});
    }
    // Fast-kill any in-flight child so systemd's TimeoutStopSec budget is generous.
    if (liveRun.child) {
      try { liveRun.child.kill('SIGTERM'); } catch {}
      setTimeout(() => { try { liveRun.child && liveRun.child.kill('SIGKILL'); } catch {} }, SIGKILL_GRACE_MS);
    }
  };
  process.on('SIGTERM', () => requestShutdown('SIGTERM'));
  process.on('SIGINT', () => requestShutdown('SIGINT'));

  // ── reboot-resume: finish the in-flight run from its last checkpoint ─────
  // Happens after SIGTERM handler is wired so that a SIGTERM-during-resume
  // re-queues cleanly (same as a SIGTERM during any normal tick).
  if (recovery.state === 'resume' && !state.shuttingDown) {
    liveRun.queueId = recovery.queueId;
    liveRun.runId = recovery.runId;
    await notify(`♻️ Reboot detected. Resuming run #${recovery.runId} from \`${recovery.lastPhase}\` → \`${recovery.nextPhase}\`.`);
    let resumeResult = null;
    try {
      resumeResult = await resumeInFlightRun({
        db, projectRoot, dbPath, claudeModel, notify, recovery,
        spawn: (ctx, hooks) => realSpawn(ctx, hooks),
        onSpawn: (child) => { liveRun.child = child; },
        notifyChatId,
      });
    } catch (e) {
      defaultLogger.error({ event: 'resume_orchestration_error', run_id: recovery.runId, err: e }, 'resume orchestration threw');
      // Fallback so the next boot doesn't loop on the same row.
      try {
        markQueueFailed(db, recovery.queueId);
        updateRunEnd(db, recovery.runId, { status: 'fail', error: `resume-orchestrator-error: ${e.message}` });
        deleteCheckpoint(db, recovery.runId);
        await notify(`❌ Resume of run #${recovery.runId} failed in orchestrator: ${e.message}`);
      } catch (e2) {
        defaultLogger.error({ event: 'resume_fallback_bookkeeping_failed', run_id: recovery.runId, err: e2 }, 'fallback bookkeeping failed');
      }
    }
    // If shutdown landed during resume and the run wasn't a clean success,
    // undo the bookkeeping and re-queue for the next boot.
    if (state.shuttingDown
        && resumeResult
        && resumeResult.action !== 'completed_ok'
        && resumeResult.action !== 'completed_cancelled') {
      try {
        repairOrphanedRunning(db, recovery.queueId);
        await notify(`↩️ Run #${recovery.runId} re-queued; will retry on next boot.`);
      } catch (e) {
        defaultLogger.error({ event: 'resume_requeue_failed', run_id: recovery.runId, err: e }, 're-queue on shutdown failed');
      }
    }
    liveRun.queueId = null; liveRun.runId = null; liveRun.child = null;
  }

  // ── poll loop ────────────────────────────────────────────────────────────
  while (!state.shuttingDown) {
    let tickResult = null;
    try {
      tickResult = await tickOnce({
        db, projectRoot,
        capLimits: { dailyMax: 20, weeklyMax: 100 },
        gitSha, claudeModel,
        // dbPath is in closure scope; pass it explicitly so realSpawn gets it without
        // mutating the db object (node:sqlite DatabaseSync has no .location property).
        spawn: (ctx) => realSpawn({ ...ctx, dbPath }, {
          db,
          onSpawn: (child) => { liveRun.queueId = ctx.queueId; liveRun.runId = ctx.runId; liveRun.child = child; },
          onPhaseEnd: ({ phase, elapsedMs }) => notify(formatPhaseEnd({ runId: ctx.runId, phase, elapsedMs })),
        }),
        notify,
        // Lets tickOnce detect "spawn killed because we're shutting down" and
        // preserve queue+run+checkpoint state for the next boot's resume path.
        isShuttingDown: () => state.shuttingDown,
        notifyChatId,
      });
    } catch (e) {
      defaultLogger.error({ event: 'tick_error', err: e }, 'tickOnce threw');
    }

    // Shutdown-during-tick handling:
    // - shutdown_interrupt → tickOnce already preserved state; resume engages next boot.
    // - any other non-success action with a live run → re-queue (URL preserved, work redone).
    if (state.shuttingDown && tickResult && tickResult.action === 'shutdown_interrupt') {
      // tickOnce already notified the user; nothing to do here.
    } else if (state.shuttingDown
        && liveRun.queueId
        && tickResult
        && tickResult.action !== 'completed_ok'
        && tickResult.action !== 'idle'
        && tickResult.action !== 'capped') {
      try {
        repairOrphanedRunning(db, liveRun.queueId);
        await notify(`↩️ Run #${liveRun.runId} requeued; will retry from the start on next boot.`);
      } catch (e) {
        defaultLogger.error({ event: 'requeue_failed', queue_id: liveRun.queueId, run_id: liveRun.runId, err: e }, 're-queue on shutdown failed');
      }
    }

    liveRun.queueId = null; liveRun.runId = null; liveRun.child = null;
    if (state.shuttingDown) break;
    await new Promise(r => setTimeout(r, POLL_MS));
  }

  // ── drain + exit ─────────────────────────────────────────────────────────
  await notifyStopping('orchestrator shutdown');
  stopWatchdog();
  stopHeartbeat();
  try { closeDb(db); } catch (e) { defaultLogger.warn({ event: 'closedb_failed', err: e }, 'closeDb threw'); }
  defaultLogger.info({ event: 'daemon_exit', exit_code: state.exitCode }, 'orchestrator exited cleanly');
  process.exit(state.exitCode);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { defaultLogger.fatal({ event: 'daemon_fatal', err: e }, 'orchestrator fatal'); process.exit(4); });
}
