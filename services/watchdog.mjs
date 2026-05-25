import { execSync as defaultExec, spawn } from 'node:child_process';
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

// ── Rule 5/5: disk-free pause ─────────────────────────────────────────────────

export function readDiskFreeGb({ dfOutput, exec = defaultExec } = {}) {
  const out = dfOutput ?? exec('df -BG / 2>/dev/null', { encoding: 'utf8' });
  const lines = out.trim().split('\n');
  if (lines.length < 2) return Infinity;
  const cols = lines[1].split(/\s+/);
  const avail = cols[3] || '';
  return Number(avail.replace('G', '')) || Infinity;
}

export function matchDiskPause({ freeGb }) {
  return freeGb < 1.0;
}

export async function remediateDiskPause({ db, notifier } = {}) {
  if (db) {
    db.prepare("UPDATE queue SET paused=1 WHERE status='queued'").run();
    const { upsertPattern } = await import('./db.mjs');
    upsertPattern(db, {
      signature: 'watchdog:disk-pause',
      hint: 'disk <1G free; queue paused. Use /unpause after cleanup.',
      runId: 0
    });
  }
  if (notifier) await notifier.tg('🚨 Disk free <1 GB. Queue paused. Run /unpause after clean-up.');
}

// ── journalctl subprocess stream ───────────────────────────────────────────────

async function* journaldStream() {
  const proc = spawn('journalctl', ['--user', '-f', '-u', 'pipeline-orchestrator', '-u', 'telegram-listener', '-o', 'json'], { stdio: ['ignore', 'pipe', 'inherit'] });
  let buf = '';
  for await (const chunk of proc.stdout) {
    buf += chunk.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line) yield line;
    }
  }
}

// ── Main orchestration loop ────────────────────────────────────────────────────

export async function runWatchdog(opts = {}) {
  const {
    lineSource = journaldStream(),
    db,
    notifier,
    exec = defaultExec,
    diskCheckIntervalMs = 5 * 60 * 1000,
    heartbeatCheckIntervalMs = 60 * 1000,
    maxEvents = Infinity
  } = opts;

  const recent = []; // ring buffer of recent {message, timestampMs, unit}
  const KEEP_MS = 60 * 60 * 1000;
  let lastOrchTs = Date.now();
  let processed = 0;

  const diskTimer = setInterval(async () => {
    try {
      const free = readDiskFreeGb({ exec });
      if (matchDiskPause({ freeGb: free })) await remediateDiskPause({ db, notifier });
    } catch {}
  }, diskCheckIntervalMs);
  if (diskTimer.unref) diskTimer.unref();

  const hbTimer = setInterval(async () => {
    if (matchHeartbeatMiss({ lastLogTs: lastOrchTs })) await remediateHeartbeatMiss({ exec, db });
  }, heartbeatCheckIntervalMs);
  if (hbTimer.unref) hbTimer.unref();

  try {
    for await (const line of lineSource) {
      const evt = parseJournaldLine(line);
      if (!evt) continue;
      recent.push(evt);
      while (recent.length && recent[0].timestampMs < Date.now() - KEEP_MS) recent.shift();
      if (evt.unit && evt.unit.startsWith('pipeline-orchestrator')) lastOrchTs = evt.timestampMs;

      if (matchOom(evt.message)) await remediateOom({ exec, db });
      if (matchTectonic(recent)) await remediateTectonic({ db });
      const hc = matchHostCooldown(recent);
      if (hc) await remediateHostCooldown({ host: hc.host, db });

      processed++;
      if (processed >= maxEvents) break;
    }
  } finally {
    clearInterval(diskTimer);
    clearInterval(hbTimer);
  }
}

// ── CLI entry point ────────────────────────────────────────────────────────────

export async function main() {
  if (process.env.FEATURE_WATCHDOG !== '1') {
    log.info({ event: 'watchdog_disabled' }, 'FEATURE_WATCHDOG not set; exiting');
    process.exit(0);
  }
  const { initDb } = await import('./db.mjs');
  const notifier = await import('./notifier.mjs');
  const db = initDb(process.env.DB_PATH || 'ops/work-queue.db');
  try {
    await runWatchdog({ db, notifier });
  } finally {
    db.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => { console.error(e); process.exit(1); });
}
