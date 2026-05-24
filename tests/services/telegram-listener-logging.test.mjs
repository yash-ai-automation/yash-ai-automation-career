// tests/services/telegram-listener-logging.test.mjs
// Verifies telegram-listener handleUpdate emits structured log lines via an
// injected logger.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';

import { initDb, closeDb } from '../../services/db.mjs';
import { handleUpdate, ALLOWLIST_REJECT } from '../../services/telegram-listener.mjs';
import { createLogger } from '../../services/logger.mjs';

const FAKE_CHAT = 9_000_000_001;
const ALLOW = new Set([FAKE_CHAT]);

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), 'yash-tl-log-'));
  const db = initDb(join(dir, 'tl.db'));
  return { db, dir, cleanup: () => { closeDb(db); rmSync(dir, { recursive: true, force: true }); } };
}

function makeSinkLogger() {
  const chunks = [];
  const stream = new Writable({ write(c, _e, cb) { chunks.push(c.toString()); cb(); } });
  return {
    logger: createLogger({ service: 'test-listener' }, stream),
    lines: () => chunks.join('').split('\n').filter(Boolean).map(JSON.parse),
  };
}

test('handleUpdate: logs structured allowlist_reject when sender not allowed', async () => {
  const { db, cleanup } = fresh();
  try {
    const sink = makeSinkLogger();
    const result = await handleUpdate({
      update: { update_id: 1, message: { from: { id: 999999 }, chat: { id: 999999 }, text: '/help' } },
      db, allowlist: ALLOW, notifyChatId: FAKE_CHAT,
      send: async () => {},
      logger: sink.logger,
    });
    assert.equal(result, ALLOWLIST_REJECT);
    const line = sink.lines().find((l) => l.event === 'allowlist_reject');
    assert.ok(line, 'expected allowlist_reject log line');
    assert.equal(line.level, 'warn');
    // chatId/chat_id should NOT appear raw — but it's fine to log from_user_id (not PII per our redact policy)
    assert.equal(line.from_user_id, 999999);
  } finally { cleanup(); }
});

test('handleUpdate: redacts chatId field when logger child binds it', async () => {
  const { db, cleanup } = fresh();
  try {
    const sink = makeSinkLogger();
    // Simulate a child logger bound with chatId — that field should be redacted in output
    const childLogger = sink.logger.child({ chatId: FAKE_CHAT });
    childLogger.info({ event: 'manual' }, 'test');
    const line = sink.lines().find((l) => l.event === 'manual');
    assert.equal(line.chatId, '[REDACTED]');
  } finally { cleanup(); }
});
