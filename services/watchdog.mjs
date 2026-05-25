import { execSync as defaultExec } from 'node:child_process';
import { createLogger } from './logger.mjs';

const log = createLogger({ service: 'watchdog' });

export function parseJournaldLine(line) {
  try {
    const j = JSON.parse(line);
    return {
      timestampMs: Math.floor(Number(j.__REALTIME_TIMESTAMP) / 1000),
      unit: j._SYSTEMD_USER_UNIT || '',
      message: j.MESSAGE || ''
    };
  } catch {
    return null;
  }
}

// ── Rule 1/5: OOM ──────────────────────────────────────────────────────────────

export function matchOom(message) {
  return /out of memory.*killed/i.test(message);
}

export async function remediateOom({ exec = defaultExec, db, runId = null } = {}) {
  try { exec('rm -rf /tmp/yash-pipeline-* 2>/dev/null || true'); } catch {}
  if (db) {
    const { upsertPattern } = await import('./db.mjs');
    upsertPattern(db, {
      signature: 'watchdog:oom-cleared',
      hint: 'OOM observed; /tmp cleared by watchdog. Next spawn fresh.',
      runId: runId ?? 0
    });
  }
  log.info({ event: 'watchdog_oom_remediated' }, 'OOM remediated');
}

// ── Rule 2/5: tectonic missing-file ───────────────────────────────────────────

export function matchTectonic(events) {
  const exits = events.filter(e => /tectonic.*exit/i.test(e.message));
  const missing = events.filter(e => /latex error.*file .* not found/i.test(e.message));
  for (const a of exits) for (const b of missing) {
    if (Math.abs(a.timestampMs - b.timestampMs) <= 30_000) return true;
  }
  return false;
}

export async function remediateTectonic({ db, runId } = {}) {
  if (db) {
    const { upsertPattern } = await import('./db.mjs');
    upsertPattern(db, {
      signature: 'watchdog:tectonic-missing-file',
      hint: 'tectonic missing-file detected; re-run with --keep-logs to capture cache state.',
      runId: runId ?? 0
    });
  }
  log.info({ event: 'watchdog_tectonic_remediated' }, 'tectonic missing-file remediated');
}

// ── Rule 3/5: host repeat-403 cooldown ────────────────────────────────────────

export function matchHostCooldown(events) {
  const re = /scrapling.*403 for (https?:\/\/[^\s]+)/i;
  const hits = events.map(e => {
    const m = e.message.match(re);
    if (!m) return null;
    try { return { host: new URL(m[1]).hostname.toLowerCase(), ts: e.timestampMs }; } catch { return null; }
  }).filter(Boolean);
  for (let i = 0; i < hits.length; i++) for (let j = i + 1; j < hits.length; j++) {
    if (hits[i].host === hits[j].host && Math.abs(hits[i].ts - hits[j].ts) <= 30 * 60 * 1000) {
      return { host: hits[i].host };
    }
  }
  return null;
}

export async function remediateHostCooldown({ host, db, runId } = {}) {
  if (db) {
    const { upsertPattern } = await import('./db.mjs');
    upsertPattern(db, {
      signature: `watchdog:host-cooldown:${host}`,
      hint: `Two 403s on ${host} within 30 min; wait 30 min before retry.`,
      runId: runId ?? 0
    });
  }
}

// ── Rule 4/5: heartbeat-miss ───────────────────────────────────────────────────

export function matchHeartbeatMiss({ lastLogTs, now = Date.now() }) {
  if (!lastLogTs) return false;
  return (now - lastLogTs) > 10 * 60 * 1000;
}

export async function remediateHeartbeatMiss({ exec = defaultExec, db } = {}) {
  try { exec('systemctl --user restart pipeline-orchestrator'); } catch {}
  if (db) {
    const { upsertPattern } = await import('./db.mjs');
    upsertPattern(db, {
      signature: 'watchdog:orchestrator-restart',
      hint: 'orchestrator silent >10min; restarted by watchdog.',
      runId: 0
    });
  }
}
