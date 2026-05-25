import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDb } from '../../services/db.mjs';
import { remediateDiskPause } from '../../services/watchdog.mjs';

test('e2e: disk-pause remediation sets paused=1 + sends Telegram', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wd-disk-'));
  const db = initDb(join(root, 'work.db'));
  const tgMsgs = [];
  try {
    db.prepare(
      `INSERT INTO queue (url, url_hash, added_at, added_by, status) VALUES ('https://x.test', 'h1', ?, 1, 'queued')`,
    ).run('2026-05-25T10:00:00.000Z');
    db.prepare(
      `INSERT INTO queue (url, url_hash, added_at, added_by, status) VALUES ('https://y.test', 'h2', ?, 1, 'queued')`,
    ).run('2026-05-25T10:00:00.000Z');
    await remediateDiskPause({ db, notifier: { tg: async (m) => tgMsgs.push(m) } });
    const paused = db.prepare("SELECT count(*) c FROM queue WHERE paused=1").get().c;
    assert.equal(paused, 2);
    assert.equal(tgMsgs.length, 1);
    assert.match(tgMsgs[0], /disk/i);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
