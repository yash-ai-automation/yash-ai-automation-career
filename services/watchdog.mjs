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
