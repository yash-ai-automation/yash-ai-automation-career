// services/cap.mjs
// Cap enforcement. Only status ∈ {ok, fail} consume cap. cancelled, dedup_skipped,
// and rate_limited are excluded:
//   - cancelled       — user-initiated, not a budget event
//   - dedup_skipped   — no claude -p spawn happened
//   - rate_limited    — quota-window event; consuming cap on a rate-limit hit
//     would compound the outage with a self-DDoS (3 retries × 1 cap each).
//
// Limits are env-driven so the operator can lower the cap without a redeploy:
//   CAP_DAILY_MAX  (default 50)
//   CAP_WEEKLY_MAX (default 250)
// A caller-provided `limits` object only takes effect when the env var is
// unset/empty — env wins so an incident response (`export CAP_DAILY_MAX=10`)
// is one restart away.
import { countByStatus } from './queue.mjs';

const CAPPED_STATUSES = ['ok', 'fail'];

function parseEnvCap(envVal, fallback) {
  if (envVal === undefined || envVal === null || envVal === '') return fallback;
  const n = Number(envVal);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

export function checkCap(db, limits) {
  const dailyMax = parseEnvCap(process.env.CAP_DAILY_MAX, limits?.dailyMax ?? 50);
  const weeklyMax = parseEnvCap(process.env.CAP_WEEKLY_MAX, limits?.weeklyMax ?? 250);
  const today = countByStatus(db, CAPPED_STATUSES, 'day');
  if (today >= dailyMax) return { capped: true, reason: 'daily', count: today, limit: dailyMax };
  const week = countByStatus(db, CAPPED_STATUSES, 'week');
  if (week >= weeklyMax) return { capped: true, reason: 'weekly', count: week, limit: weeklyMax };
  return { capped: false };
}
