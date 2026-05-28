// services/rate-limit.mjs
// Cross-tenant rate-limit detection + state file. Both orchestrators (Yash +
// Shivani) share a single JSON state file under /var/lib/claude-pipeline/
// (configurable via RATE_LIMIT_STATE_PATH) so a 5-hour Claude Max window hit
// by one tenant pauses BOTH queues. The file is the source of truth — the
// orchestrator polls it on every 2s tick and never holds the state in memory
// across ticks.

import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';

// Detected patterns from real claude-cli usage-limit responses. Order doesn't
// matter — `hit` is true if ANY matches. The "reset at" capture is only used
// when present; absent → caller falls back to defaultResetAt() (now + 5h).
export const RATE_LIMIT_PATTERNS = [
  /Claude\s+(?:AI\s+)?usage limit reached/i,
  /your\s+(?:usage|limit)\s+will reset at\s+([^\n.]+)/i,
  /5[- ]hour limit/i,
  /weekly\s+(?:usage\s+)?limit/i,
  /usage_limit_exceeded/i,
  // Sonnet/Opus sometimes phrase it differently in non-interactive mode:
  /rate[- ]?limit(?:ed)?\s+(?:exceeded|hit|reached)/i,
  /quota\s+exceeded/i,
];

// The second pattern captures the reset hint; we keep a direct reference so
// detectRateLimit can re-run it for the capture group.
const RESET_HINT_PATTERN = /your\s+(?:usage|limit)\s+will reset at\s+([^\n.]+)/i;

export const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;

export const RATE_LIMIT_STATE_PATH =
  process.env.RATE_LIMIT_STATE_PATH || '/var/lib/claude-pipeline/rate-limit.json';

export function defaultResetAt(now = Date.now()) {
  return new Date(now + FIVE_HOURS_MS);
}

/**
 * Scan `output` (typically the tail of ops/runs/<id>/claude.log) for any
 * known rate-limit signature. If one matches, attempt to parse a reset time
 * from the "reset at <X>" capture group; on parse failure, return null and
 * let the caller fall back to defaultResetAt().
 *
 * @param {string} output
 * @returns {{ hit: boolean, resetAt: Date | null, rawHint: string | null }}
 */
export function detectRateLimit(output) {
  if (typeof output !== 'string' || output.length === 0) {
    return { hit: false, resetAt: null, rawHint: null };
  }
  const hit = RATE_LIMIT_PATTERNS.some((re) => re.test(output));
  if (!hit) return { hit: false, resetAt: null, rawHint: null };

  const m = output.match(RESET_HINT_PATTERN);
  const rawHint = m ? m[1].trim() : null;
  let resetAt = null;
  if (rawHint) {
    const parsed = new Date(rawHint);
    if (!Number.isNaN(parsed.getTime())) {
      resetAt = parsed;
    }
  }
  return { hit: true, resetAt, rawHint };
}

/**
 * Read the shared state file. Returns null if missing or unparseable —
 * tickOnce treats null as "no pause active".
 *
 * @param {string} path
 * @returns {{ resetAt: Date, reason: string, setBy: string, writtenAt: Date|null } | null}
 */
export function readState(path = RATE_LIMIT_STATE_PATH) {
  if (!existsSync(path)) return null;
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  const resetAt = obj.resetAt ? new Date(obj.resetAt) : null;
  if (!resetAt || Number.isNaN(resetAt.getTime())) return null;
  const writtenAt = obj.writtenAt ? new Date(obj.writtenAt) : null;
  return {
    resetAt,
    reason: typeof obj.reason === 'string' ? obj.reason : 'unknown',
    setBy: typeof obj.setBy === 'string' ? obj.setBy : 'unknown',
    writtenAt: writtenAt && !Number.isNaN(writtenAt.getTime()) ? writtenAt : null,
  };
}

/**
 * Atomic write: writes to `<path>.tmp` then renames. Ensures readers never
 * see a half-written JSON document. Caller is responsible for the parent
 * directory existing (deploy creates /var/lib/claude-pipeline upfront).
 *
 * @param {string} path
 * @param {{ resetAt: Date, reason: string, setBy: string }} payload
 */
export function writeState(path, { resetAt, reason, setBy }) {
  const out = {
    resetAt: resetAt instanceof Date ? resetAt.toISOString() : new Date(resetAt).toISOString(),
    reason: String(reason || 'unknown'),
    setBy: String(setBy || 'unknown'),
    writtenAt: new Date().toISOString(),
  };
  const tmp = path + '.tmp';
  writeFileSync(tmp, JSON.stringify(out, null, 2) + '\n', 'utf8');
  renameSync(tmp, path);
}

/**
 * Idempotent delete. Used when the pause window has elapsed AND on rollback.
 *
 * @param {string} path
 */
export function clearState(path = RATE_LIMIT_STATE_PATH) {
  try {
    unlinkSync(path);
  } catch (e) {
    if (e && e.code !== 'ENOENT') throw e;
  }
}
