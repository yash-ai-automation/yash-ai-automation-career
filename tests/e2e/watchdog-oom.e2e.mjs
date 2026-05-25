import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDb } from '../../services/db.mjs';
import { runWatchdog } from '../../services/watchdog.mjs';

test('e2e: OOM journald line triggers remediation + KB row', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wd-oom-'));
  const db = initDb(join(root, 'work.db'));
  const execCalls = [];
  const tgMsgs = [];
  const stream = (async function* () {
    yield JSON.stringify({
      __REALTIME_TIMESTAMP: String(Date.now() * 1000),
      _SYSTEMD_USER_UNIT: 'pipeline-orchestrator.service',
      MESSAGE: 'Out of memory: Killed process 1234 (node)',
    });
  })();
  try {
    await runWatchdog({
      lineSource: stream,
      db,
      notifier: { tg: async (m) => tgMsgs.push(m) },
      exec: (c) => execCalls.push(c),
      diskCheckIntervalMs: 999999,
      heartbeatCheckIntervalMs: 999999,
      maxEvents: 1,
    });
    assert.ok(execCalls.some((c) => /rm.*yash-pipeline/.test(c)));
    const row = db.prepare("SELECT * FROM failure_patterns WHERE signature='watchdog:oom-cleared'").get();
    assert.ok(row);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
