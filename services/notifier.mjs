// services/notifier.mjs
// Formats Telegram outbound messages. The HTTP send paths are thin wrappers around
// services/telegram-client.mjs and require live env vars (TELEGRAM_BOT_TOKEN,
// TELEGRAM_NOTIFY_CHAT_ID) — tested separately in Task 3.x.

const MAX_ERROR_CHARS = 200;
const MAX_MSG_CHARS = 480;  // keeps room under Telegram's 4096; leaves headroom for formatting

function fmtDuration(ms) {
  if (!Number.isFinite(ms)) return '?';
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}

function clip(s, max) {
  if (typeof s !== 'string') return '';
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

export function formatStart({ runId, hostname }) {
  return `🚀 Starting run #${runId} for ${hostname}`;
}

export function formatPhaseEnd({ runId, phase, elapsedMs }) {
  return `⏱️ #${runId} ${phase} done · ${fmtDuration(elapsedMs)}`;
}

export function formatSuccess({ runId, company, role, score, totalMs }) {
  return clip(`✅ #${runId} ${company} — ${role}\nScore ${score}/100 · total ${fmtDuration(totalMs)}`, MAX_MSG_CHARS);
}

export function formatFailure({ runId, hostname, phase, error }) {
  return clip(`❌ #${runId} ${hostname} failed at ${phase}:\n${clip(error || '', MAX_ERROR_CHARS)}`, MAX_MSG_CHARS);
}

// Distinct from formatSuccess: a mark-skipped run did NOT produce new artifacts.
// The 🔁 prefix + explicit "skipped" wording prevents the false-success pattern
// where Telegram showed "✅ Score 0/100 · role unknown" for a no-op skip (run #13,
// 2026-05-25 incident).
export function formatSkipped({ runId, hostname, reason }) {
  const r = (reason && String(reason).trim()) || 'duplicate';
  return clip(`🔁 #${runId} ${hostname} skipped\n${r}`, MAX_MSG_CHARS);
}

export function formatCapReached({ reason, count, limit }) {
  return `⏸️ Cap reached (${reason}: ${count}/${limit}). New URLs will wait.`;
}

// Emitted ONCE per 5-hour Claude Max window when the orchestrator detects a
// usage-limit response from `claude -p`. The orchestrator pauses both tenants
// globally; the resetAt timestamp tells the user when work will resume.
export function formatRateLimitPaused({ resetAt }) {
  const when = resetAt instanceof Date ? resetAt : new Date(resetAt);
  // Two formats: ISO for log-friendliness, then HH:MM UTC for at-a-glance read.
  const iso = when.toISOString();
  const hhmm = `${String(when.getUTCHours()).padStart(2, '0')}:${String(when.getUTCMinutes()).padStart(2, '0')}`;
  return `⏸️ Claude usage-limit window active until ${iso} (≈${hhmm} UTC); queue paused for all tenants.`;
}

// Emitted ONCE when the pause window has elapsed and the orchestrator clears
// the shared state file. The next tick resumes normal cap-checked processing.
export function formatRateLimitResumed() {
  return `▶️ Claude usage-limit window has reset; resuming queue.`;
}

export function formatCancelled({ runId, queueId }) {
  return `🛑 Cancelled #${runId ?? queueId}`;
}

export function formatStatus({ idle, runningRunId, runningCompany, runningRole, runningPhase, runningElapsedMs, queueLen, todayCount, todayLimit, weekCount, weekLimit, lastRunSummary, uptimeListenerSec, uptimeOrchSec }) {
  if (idle) {
    return [
      `📭 Idle.`,
      `Queue:  ${queueLen} waiting · 0 running`,
      `Today:  ${todayCount}/${todayLimit} runs · Week: ${weekCount}/${weekLimit}`,
      lastRunSummary ? `Last:   ${lastRunSummary}` : null,
      `Uptime: orchestrator ${fmtDuration(uptimeOrchSec * 1000)} · listener ${fmtDuration(uptimeListenerSec * 1000)}`,
    ].filter(Boolean).join('\n');
  }
  return [
    `🏃 Run #${runningRunId} — ${runningCompany} / ${runningRole}`,
    `Phase:    ${runningPhase}`,
    `Elapsed:  ${fmtDuration(runningElapsedMs)}`,
    `Queue:    ${queueLen} waiting after this`,
    `Today:    ${todayCount}/${todayLimit} · Week: ${weekCount}/${weekLimit}`,
  ].join('\n');
}

export function formatHelp() {
  const tenant = process.env.TENANT_LABEL || 'yash-pipeline';
  return [
    `*${tenant} bot — commands*`,
    '`/add <url>` — queue a job URL',
    '`/queue` — show next up to 10 queued',
    '`/status` — what the orchestrator is doing now',
    '`/cancel <queue_id>` — request cancellation',
    '`/help` — this message',
  ].join('\n');
}
