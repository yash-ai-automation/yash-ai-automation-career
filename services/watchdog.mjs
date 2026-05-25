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
