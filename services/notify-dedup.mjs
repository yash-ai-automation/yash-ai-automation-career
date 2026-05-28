// services/notify-dedup.mjs
// Suppresses repeat Telegram notifications within a configurable window.
//
// Two call-sites use this:
//   1. tickOnce cap-reached branch  — key `cap:<reason>`, window = "until end of
//      current day/week (UTC)" so the reminder re-fires once per fresh window
//      instead of every 2s tick.
//   2. tickOnce rate-limit-paused   — key `rate_limit:paused`, window = "until
//      resetAt" so the user gets exactly one "queue paused" message per
//      5-hour Max window, not one per tick.
//
// Backed by a process-local Map<key, lastEmittedAt>. State is intentionally
// in-memory: the orchestrator daemon's lifetime IS the suppression window for
// these notification classes (a daemon restart clears the map, which is fine
// because the user-facing event "boot up" already produces a `bot_online`
// message that supersedes the prior pause/cap reminder).

/**
 * Create an isolated dedup tracker. Each orchestrator daemon constructs one
 * instance at boot; tests create a fresh one per test to avoid cross-test
 * pollution.
 *
 * @param {{ defaultWindowMs?: number, now?: () => number }} [opts]
 * @returns {{ shouldEmit: (key: string, windowMs?: number) => boolean, reset: (key?: string) => void }}
 */
export function createNotifyDedup({ defaultWindowMs = 60_000, now = Date.now } = {}) {
  const lastEmit = new Map();

  function shouldEmit(key, windowMs) {
    if (typeof key !== 'string' || key.length === 0) return true;
    const win = Number.isFinite(windowMs) && windowMs > 0 ? windowMs : defaultWindowMs;
    const t = now();
    const prev = lastEmit.get(key);
    if (prev != null && t - prev < win) return false;
    lastEmit.set(key, t);
    return true;
  }

  function reset(key) {
    if (key === undefined) {
      lastEmit.clear();
      return;
    }
    lastEmit.delete(key);
  }

  return { shouldEmit, reset };
}

/**
 * Compute the millis until the end of the current UTC day. Used by the
 * cap-reached call-site so the dedup window expires exactly when a fresh
 * daily-cap window opens.
 *
 * @param {number} [now]
 * @returns {number}
 */
export function msUntilEndOfUtcDay(now = Date.now()) {
  const d = new Date(now);
  const tomorrow = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0, 0);
  return tomorrow - now;
}

/**
 * Compute millis until the end of the current ISO week (Sunday → Monday 00:00
 * UTC). Used by the weekly-cap dedup call-site.
 *
 * @param {number} [now]
 * @returns {number}
 */
export function msUntilEndOfUtcWeek(now = Date.now()) {
  const d = new Date(now);
  const day = d.getUTCDay(); // 0 = Sunday
  const daysToMonday = (8 - day) % 7 || 7; // 1..7
  const nextMonday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + daysToMonday, 0, 0, 0, 0);
  return nextMonday - now;
}
