// services/pipeline-orchestrator.mjs
// State machine + main daemon entry. Pure orchestration logic is exported as
// tickOnce({db, projectRoot, capLimits, gitSha, claudeModel, spawn, notify})
// so it can be unit-tested without spawning real `claude -p`.
//
// The real daemon is in main() at the bottom; it wires real spawn() + notify()
// into tickOnce() and runs the poll loop with a 2-second cadence.

import { spawn as nodeSpawn } from 'node:child_process';
import { resolve, join, isAbsolute } from 'node:path';
import { mkdirSync, createWriteStream, readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
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
import {
  formatStart, formatSuccess, formatFailure, formatCapReached, formatPhaseEnd,
  formatCancelled, formatSkipped, formatRateLimitPaused, formatRateLimitResumed,
} from './notifier.mjs';
import {
  detectRateLimit, readState, writeState, clearState, defaultResetAt,
  RATE_LIMIT_STATE_PATH,
} from './rate-limit.mjs';
import {
  createNotifyDedup, msUntilEndOfUtcDay, msUntilEndOfUtcWeek,
} from './notify-dedup.mjs';
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

// ── Notification de-duplication ─────────────────────────────────────────────
// Module-level singleton so the cap-reached + rate-limit-paused messages
// emit at most once per window per daemon process. Tests inject their own
// instance via `tickOnce({ notifyDedup })`.
const defaultNotifyDedup = createNotifyDedup();

// ── Per-daemon tick state ────────────────────────────────────────────────────
// `wasPausedLastTick` lets each daemon emit its OWN resume notification when
// the rate-limit window elapses. Without this, only the daemon that won the
// race to delete the shared state file would notify — the other tenant's
// Telegram chat would stay silent even though processing resumed.
// Tests inject a fresh `{wasPausedLastTick: false}` via tickOnce({tickState}).
const defaultTickState = { wasPausedLastTick: false };

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
const SIGKILL_GRACE_MS = 10_000;
// Tolerance between tickOnce's startedAt stamp and the pipeline's audit-line
// timestamp (same host; effectively 0, but be generous).
const AUDIT_WINDOW_SKEW_MS = 5_000;

// Per-URL wall-clock timeout. Raised 20→35 min (2026-05-29): a full run legitimately
// takes ~16–25 min under Sonnet 4.6 / xhigh, so a hard 20 min guillotined runs that
// had already finished, which the orchestrator then re-queued and surfaced as a false
// "duplicate (all artifacts already exist)" skip. Configurable via PER_URL_TIMEOUT_MS
// so the operator can tune without a redeploy.
// See docs/superpowers/plans/2026-05-29-yash-pipeline-timeout-requeue-fix.md.
export function resolveRunTimeoutMs(env = process.env) {
  const raw = parseInt(env.PER_URL_TIMEOUT_MS ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 35 * 60 * 1000;
}

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

// ── verifyRunArtifacts ──────────────────────────────────────────────────────

/**
 * Gate the orchestrator's "this run completed successfully" decision on the
 * actual existence of the declared artifacts on disk. Before this guard, exit
 * code 0 alone was enough to mark a queue row `done` and emit `formatSuccess`,
 * which let the 2026-05-25 dedup-on-retry sequence (run #12 dies before cover
 * letter; run #13 mark-skipped via partial duplicate) silently report
 * "✅ Score 0/100 · role unknown" with no cover letter on disk.
 *
 * Two outcomes are considered "ok":
 *   - `kind: 'skip'`  — the runner explicitly called mark-skipped (no new
 *      artifacts expected). The caller MUST use formatSkipped (not
 *      formatSuccess) so the Telegram surface reflects what actually happened.
 *   - `kind: 'complete'` — all three declared artifacts (jdPath, resumePdf,
 *      coverLetterPdf) exist on disk. The caller can use formatSuccess.
 *
 * Anything else → `ok: false`, with `missing` enumerating the specific
 * artifact(s) that are absent. The caller MUST treat this as a failure and
 * re-queue via the 3-strike retry policy.
 *
 * @param {{ result: object, projectRoot: string }} opts
 * @returns {{ ok: boolean, kind: 'skip'|'complete', missing: string[] }}
 */
export function verifyRunArtifacts({ result, projectRoot }) {
  if (result && result.isSkip) {
    return { ok: true, kind: 'skip', missing: [] };
  }
  const expected = {
    jd: result?.jdPath ?? null,
    pdf: result?.resumePdf ?? null,
    cover_letter_pdf: result?.coverLetterPdf ?? null,
  };
  const missing = [];
  for (const [key, relPath] of Object.entries(expected)) {
    if (!relPath) {
      missing.push(`${key} (not declared)`);
      continue;
    }
    const absPath = isAbsolute(relPath) ? relPath : join(projectRoot, relPath);
    if (!existsSync(absPath)) {
      missing.push(`${key} (${relPath} missing on disk)`);
    }
  }
  return { ok: missing.length === 0, kind: 'complete', missing };
}

// ── scanRunArtifacts ────────────────────────────────────────────────────────

/**
 * Filesystem ground truth for "what did this run produce". The orchestrator runs
 * exactly one `claude -p` per tenant at a time, so any file in the tenant's output
 * dirs whose mtime falls within the run window (>= startedAt) belongs to THIS run.
 * Returns the newest in-window file in jds/<tenant>, resumes/<tenant>, and
 * cover-letters/<tenant> (absolute paths, or null). Used as a fallback when the
 * agent's audit line omits the artifact paths — which it sometimes does (it logged
 * status:ok + timings but not --jd/--pdf/--cover-letter on 2026-05-29 run #93),
 * leaving the orchestrator unable to confirm a genuinely-complete run.
 */
export function scanRunArtifacts({ projectRoot, tenant = 'yash', startedAt = null }) {
  const startMs = startedAt ? Date.parse(startedAt) : 0;
  const minMs = Number.isNaN(startMs) ? 0 : startMs - AUDIT_WINDOW_SKEW_MS;
  const dirs = {
    jd: join(projectRoot, 'jds', tenant),
    pdf: join(projectRoot, 'resumes', tenant),
    cover_letter_pdf: join(projectRoot, 'cover-letters', tenant),
  };
  const out = { jd: null, pdf: null, cover_letter_pdf: null };
  for (const [key, dir] of Object.entries(dirs)) {
    if (!existsSync(dir)) continue;
    let entries;
    try { entries = readdirSync(dir); } catch { continue; }
    let best = null, bestMtime = -1;
    for (const name of entries) {
      const p = join(dir, name);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (!st.isFile() || st.size === 0) continue;
      if (st.mtimeMs >= minMs && st.mtimeMs > bestMtime) { best = p; bestMtime = st.mtimeMs; }
    }
    out[key] = best;
  }
  return out;
}

// ── createPhaseTracker ──────────────────────────────────────────────────────

/**
 * Stateful tracker for the orchestrator's checkpoint poll: every CHECKPOINT_POLL_MS
 * the orchestrator reads `checkpoints.last_phase` and, if it changed, emits a
 * phase_end event with the duration.
 *
 * The pre-fix code computed elapsedMs as `now - (phaseStarts.get(phase) || now)`,
 * which always evaluated to 0 on first observation because each phase name was
 * seen exactly once (lastSeenPhase guard) and phaseStarts was empty. Every phase
 * therefore reported "0 ms" in Telegram (cosmetic bug, real noise).
 *
 * This tracker carries the previous phase's end time across observations so the
 * duration is the actual gap between phase boundaries.
 *
 * @param {number} initialNow  — typically Date.now() at spawn start
 */
export function createPhaseTracker(initialNow = Date.now()) {
  let lastSeenPhase = null;
  let lastPhaseEndTime = initialNow;
  return {
    /**
     * Observe the current checkpointed phase name. Returns
     * `{ newPhase: true, phase, elapsedMs }` exactly once per distinct phase
     * name; returns `{ newPhase: false }` for unchanged or empty observations.
     */
    observe(currentPhase, nowFn = Date.now) {
      if (!currentPhase || currentPhase === lastSeenPhase) return { newPhase: false };
      const now = nowFn();
      const elapsedMs = now - lastPhaseEndTime;
      lastSeenPhase = currentPhase;
      lastPhaseEndTime = now;
      return { newPhase: true, phase: currentPhase, elapsedMs };
    },
  };
}

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

export async function tickOnce({
  db, projectRoot, capLimits, gitSha, claudeModel, spawn, notify,
  isShuttingDown = () => false, notifyChatId = 0, logger = defaultLogger,
  notifyDedup = defaultNotifyDedup, rateLimitStatePath = RATE_LIMIT_STATE_PATH,
  tickState = defaultTickState,
}) {
  // ── Global rate-limit guard ───────────────────────────────────────────────
  // Runs BEFORE checkCap so a 5-hour Max window pause supersedes the daily/
  // weekly cap accounting. Both tenants share the same JSON state file under
  // /var/lib/claude-pipeline/, so one tenant hitting the limit pauses both.
  const rl = readState(rateLimitStatePath);
  if (rl && Date.now() < rl.resetAt.getTime()) {
    // ── Pause path ─────────────────────────────────────────────────────────
    const windowMs = Math.max(rl.resetAt.getTime() - Date.now(), 60_000); // floor 60s
    if (notifyDedup.shouldEmit('rate_limit:paused', windowMs)) {
      notify(formatRateLimitPaused({ resetAt: rl.resetAt }));
    }
    tickState.wasPausedLastTick = true;
    logger.info({
      event: 'tick_rate_limit_paused',
      reset_at: rl.resetAt.toISOString(),
      reason: rl.reason,
      set_by: rl.setBy,
    }, 'rate-limit window active; queue paused');
    return { action: 'rate_limit_paused' };
  }

  // ── Resume path (run on EVERY non-paused tick — race-tolerant across daemons)
  // If the file still exists (we won the race), delete it. Either way, if THIS
  // daemon's prior tick was in the pause branch, emit a resume notification so
  // the user-facing Telegram chat reflects the unpause. Without this guard,
  // the second tenant's daemon — which finds rl=null because the first tenant
  // already deleted the file — would silently resume without notifying its
  // chat (race observed live on 2026-05-28; see deploy-result note in plan).
  let observedReset = false;
  if (rl) {
    clearState(rateLimitStatePath);
    db.prepare(`UPDATE queue SET paused=0 WHERE paused=1`).run();
    observedReset = true;
    logger.info({ event: 'rate_limit_window_reset' }, 'rate-limit window elapsed; queue resumed');
  }
  if (tickState.wasPausedLastTick) {
    tickState.wasPausedLastTick = false;
    notifyDedup.reset('rate_limit:paused');
    notify(formatRateLimitResumed());
    if (!observedReset) {
      logger.info({ event: 'rate_limit_resume_observed' }, 'rate-limit pause cleared by another tenant; queue resumed');
    }
  }

  const cap = checkCap(db, capLimits);
  const next = selectNextQueued(db);
  if (!next && !cap.capped) { logger.debug({ event: 'tick_idle' }, 'no work'); return { action: 'idle' }; }
  if (next && cap.capped) {
    logger.info({ event: 'tick_capped', cap_window: cap.window, cap_count: cap.count }, 'cap reached');
    const windowMs = cap.reason === 'weekly' ? msUntilEndOfUtcWeek() : msUntilEndOfUtcDay();
    if (notifyDedup.shouldEmit(`cap:${cap.reason}`, windowMs)) {
      notify(formatCapReached(cap));
    }
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
      projectRoot, claudeModel, startedAt,
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

  // ── Rate-limit detection ──────────────────────────────────────────────────
  // If realSpawn detected a usage-limit signature in claude.log, treat it as a
  // quota event (NOT a 3-strike failure): write the shared state file so both
  // tenants pause, re-queue the URL WITHOUT consuming an attempt, write
  // runs.status='rate_limited' (excluded from cap.mjs's CAPPED_STATUSES),
  // notify once with dedup, and bail. The next tick reads the state file and
  // returns action='rate_limit_paused' until the window elapses.
  if (result.rateLimitHit) {
    const detected = result.rateLimitResetAt;
    const resetAt = (detected instanceof Date && !Number.isNaN(detected.getTime()))
      ? detected
      : defaultResetAt();
    try {
      writeState(rateLimitStatePath, {
        resetAt,
        reason: 'claude-cli usage limit',
        setBy: (process.env.TENANT || 'yash').toLowerCase(),
      });
    } catch (e) {
      runLog.error({ event: 'rate_limit_state_write_failed', err: e.message, path: rateLimitStatePath }, 'failed to write rate-limit state file — pause will not propagate across daemons');
      // Continue anyway — the in-memory dedup + audit row still prevent same-daemon spam.
    }
    // Re-queue the row without consuming an attempt (the URL itself is healthy).
    db.prepare(`UPDATE queue SET status='queued', assigned_at=NULL WHERE id=?`).run(next.id);
    updateRunEnd(db, runId, {
      endedAt, status: 'rate_limited',
      error: 'claude-cli usage limit detected',
      phaseTimingsJson: result.phaseTimingsJson,
    });
    deleteCheckpoint(db, runId);
    runLog.warn({
      event: 'rate_limit_hit',
      reset_at: resetAt.toISOString(),
      queue_id: next.id,
      run_id: runId,
    }, 'rate limit detected; re-queued without consuming an attempt');
    const windowMs = Math.max(resetAt.getTime() - Date.now(), 60_000);
    if (notifyDedup.shouldEmit('rate_limit:paused', windowMs)) {
      notify(formatRateLimitPaused({ resetAt }));
    }
    return { action: 'rate_limited', runId };
  }

  // ── Ground-truth success determination (2026-05-29 fix) ─────────────────────
  // A run is successful when it legitimately skipped OR produced all three declared
  // artifacts on disk — REGARDLESS of the claude -p exit code. Before this, success
  // was gated on exitCode===0, so a run that finished the pipeline but was SIGTERM'd
  // at the wall-clock timeout (exit 143) just before the process exited was
  // misclassified as a failure and re-queued — which then surfaced as a false
  // "duplicate (all artifacts already exist)" skip (OpenLoop) or an
  // incomplete_artifacts failure (StackAdapt) on the retry. realSpawn scopes
  // result.* to THIS run's audit window, so stale prior-attempt lines can't leak in.
  // See docs/superpowers/plans/2026-05-29-yash-pipeline-timeout-requeue-fix.md.
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
      event: 'run_completed_skip', exit_code: result.exitCode,
      skip_reason: result.skipReason || null,
    }, 'run completed via mark-skipped (no new artifacts)');
    notify(formatSkipped({
      runId, hostname: hostnameOf(next.url), reason: result.skipReason,
    }));
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
      event: 'incomplete_artifacts',
      missing: verify.missing,
      declared_jd: result.jdPath,
      declared_pdf: result.resumePdf,
      declared_cl: result.coverLetterPdf,
    }, 'runner reported exit 0 but expected artifacts are missing');
    result = {
      ...result,
      exitCode: 1,
      error: `incomplete_artifacts: ${verify.missing.join(', ')}`,
      failedPhase: 'verify_artifacts',
    };
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
export async function realSpawn({ runId, queueId, url, urlHash, projectRoot, dbPath, claudeModel, startedAt = null, mode = 'fresh', resumeContext = null }, { onPhaseEnd, onSpawn, db }) {
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

  // Build claude-cli argv. --effort defaults to 'xhigh' (Sonnet 4.6 adaptive
  // thinking budget); operator can disable by setting CLAUDE_EFFORT="" in the
  // env file. --fallback-model is opt-in only via CLAUDE_FALLBACK_MODEL —
  // it covers 529 overloads, NOT 5-hour usage-limit events (those go through
  // the rate-limit branch in tickOnce).
  const claudeArgs = [
    '-p', preamble,
    '--print',
    '--dangerously-skip-permissions',
    '--add-dir', projectRoot,
    '--model', claudeModel,
  ];
  const effortRaw = process.env.CLAUDE_EFFORT;
  const effort = effortRaw === undefined ? 'xhigh' : effortRaw.trim();
  if (effort) {
    claudeArgs.push('--effort', effort);
  }
  const fallback = (process.env.CLAUDE_FALLBACK_MODEL || '').trim();
  if (fallback) {
    claudeArgs.push('--fallback-model', fallback);
  }
  const child = nodeSpawn('claude', claudeArgs, {
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

  // checkpoint poll: every 2s, read checkpoints.last_phase; if changed, fire onPhaseEnd.
  // The tracker carries the prior phase's end time so elapsedMs is the gap from
  // the previous phase boundary — not 0 (the pre-fix behavior).
  const tracker = createPhaseTracker(Date.now());
  let lastSeenPhase = null;          // still needed for the resume/failedPhase fallback below
  const phasePoll = setInterval(() => {
    const cp = selectCheckpoint(db, runId);
    if (!cp) return;
    const ev = tracker.observe(cp.last_phase);
    if (ev.newPhase) {
      lastSeenPhase = ev.phase;
      onPhaseEnd({ phase: ev.phase, elapsedMs: ev.elapsedMs });
    }
  }, CHECKPOINT_POLL_MS);

  // cancel poll: every 2s, check cancel_requested → SIGTERM → 10s grace → SIGKILL
  const cancelPoll = setInterval(() => {
    if (isCancelRequested(db, queueId)) {
      try { child.kill('SIGTERM'); } catch {}
      setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, SIGKILL_GRACE_MS);
    }
  }, CHECKPOINT_POLL_MS);

  // wall-clock timeout (configurable; default 35 min)
  const runTimeoutMs = resolveRunTimeoutMs();
  const timeout = setTimeout(() => {
    try { child.kill('SIGTERM'); } catch {}
    setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, SIGKILL_GRACE_MS);
  }, runTimeoutMs);

  const exit = await new Promise((res) => {
    child.on('exit', (code, signal) => res({ code, signal }));
  });

  clearInterval(phasePoll);
  clearInterval(cancelPoll);
  clearTimeout(timeout);
  logStream.end();

  // Find the per-URL audit line for THIS run, scoped to the run window by startedAt
  // so a stale prior-attempt line can't be credited to this attempt.
  const auditPath = resolveAuditLogPath(projectRoot);
  let parsed = null;
  if (existsSync(auditPath)) {
    parsed = findAuditResult({ auditText: readFileSync(auditPath, 'utf-8'), url, startedAt });
  }

  // Scan the tail of claude.log for usage-limit signatures. Only run when
  // exitCode != 0 (a successful run has no quota signal). 8 KiB tail covers
  // the last ~50 lines, more than enough for any sensible error banner.
  let rateLimitHit = false;
  let rateLimitResetAt = null;
  if (exit.code !== 0 && existsSync(claudeLogPath)) {
    try {
      const tail = readFileSync(claudeLogPath, 'utf8').slice(-8192);
      const rl = detectRateLimit(tail);
      rateLimitHit = rl.hit;
      rateLimitResetAt = rl.resetAt;
    } catch {
      // Best-effort — a missing/unreadable log just leaves rateLimitHit=false
      // and the failure flows through the normal 3-strike retry.
    }
  }

  // Ground-truth fallback: if the agent's audit line omitted artifact paths (it
  // logs status:ok + timings via --from-timer but sometimes not --jd/--pdf/--cover-letter),
  // recover them by scanning the tenant's output dirs for files written during this
  // run's window. Makes success determination independent of agent logging fidelity.
  const tenant = (process.env.TENANT || 'yash').trim().toLowerCase() || 'yash';
  const scanned = scanRunArtifacts({ projectRoot, tenant, startedAt });

  return {
    exitCode: exit.code === null ? 124 : exit.code,
    durationMs: parsed?.total_ms ?? null,
    slug: parsed?.slug ?? null,
    score: parsed?.score ?? null,
    jdPath: parsed?.jd ?? scanned.jd,
    resumePdf: parsed?.pdf ?? scanned.pdf,
    coverLetterPdf: parsed?.cover_letter_pdf ?? scanned.cover_letter_pdf,
    failedPhase: lastSeenPhase ? computeNextPhase(lastSeenPhase) : 'jd_fetch_end',
    error: exit.code === 0 ? null : `claude -p exit ${exit.code} signal ${exit.signal || 'none'}`,
    phaseTimingsJson: parsed ? JSON.stringify(parsed) : null,
    // verifyRunArtifacts + skip-vs-success branching in tickOnce keys on these.
    isSkip: parsed?.status === 'skip',
    skipReason: parsed?.reason ?? null,
    // Rate-limit signal — tickOnce reads these to branch into the quota-pause path.
    rateLimitHit,
    rateLimitResetAt,
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

  const startedAt = new Date().toISOString();
  let result;
  try {
    result = await spawn(
      {
        runId: recovery.runId, queueId: recovery.queueId, url: recovery.url, urlHash: recovery.urlHash,
        projectRoot, dbPath, claudeModel, startedAt,
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

  // Ground-truth success (2026-05-29): credit a clean exit OR a run that produced
  // all artifacts / legitimately skipped even if SIGTERM'd at the timeout (exit 143)
  // before exiting. Same bug class as the tickOnce fix; additive so a clean exit
  // still counts as success (preserves the no-artifact resume test).
  const verify = verifyRunArtifacts({ result, projectRoot });
  if (result.exitCode === 0 || verify.kind === 'skip' || verify.ok) {
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

  const claudeModel = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';
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
        // capLimits intentionally omitted — checkCap reads CAP_DAILY_MAX /
        // CAP_WEEKLY_MAX env vars (default 50/250) so the operator can
        // change the budget without a redeploy.
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
