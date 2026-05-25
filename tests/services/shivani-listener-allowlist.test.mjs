// tests/services/shivani-listener-allowlist.test.mjs
// Plan §8.1 — proves the listener's single-user allowlist behavior with a
// Shivani-flavored binding. Uses a fictional chat id (NOT the real production
// id, which is blocked from the repo by tools/check-secrets.sh).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDb, closeDb } from '../../services/db.mjs';
import { ALLOWLIST_REJECT, handleUpdate } from '../../services/telegram-listener.mjs';

// Fictional Shivani-side chat id — chosen to differ from the Yash test fixture
// (9_000_000_001) so cross-tenant collisions surface as test failures.
// The REAL Shivani chat id lives only in /etc/shivani-pipeline/agent.env
// (mode 0600, outside the repo) and never appears in code.
const SHIVANI_CHAT_ID = 9_000_000_002;
const SHIVANI_ALLOW = new Set([SHIVANI_CHAT_ID]);
const NON_ALLOWED_USER = 7_000_000_007;
const YASH_CHAT_ID = 9_000_000_001;  // sibling tenant — must also be rejected by a Shivani allowlist

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), 'shivani-tl-'));
  const db = initDb(join(dir, 'shivani-tl.db'));
  return { db, dir, cleanup: () => { closeDb(db); rmSync(dir, { recursive: true, force: true }); } };
}

function makeUpdate({ text = '', from_id, chat_id, update_id = 1 }) {
  return {
    update_id,
    message: {
      message_id: update_id,
      from: { id: from_id, is_bot: false, first_name: 'Test' },
      chat: { id: chat_id, type: 'private' },
      text,
    },
  };
}

test('Shivani allowlist: message from the allowlisted Shivani user is processed', async () => {
  const { db, cleanup } = fresh();
  try {
    const replies = [];
    const update = makeUpdate({
      text: '/help',
      from_id: SHIVANI_CHAT_ID,
      chat_id: SHIVANI_CHAT_ID,
      update_id: 1,
    });
    const result = await handleUpdate({
      update,
      db,
      allowlist: SHIVANI_ALLOW,
      notifyChatId: SHIVANI_CHAT_ID,
      send: (msg) => replies.push(msg),
    });
    assert.equal(result.cmd, 'help', 'allowed sender must dispatch the command');
    assert.equal(replies.length, 1);
    assert.match(replies[0], /Commands:/);
  } finally { cleanup(); }
});

test('Shivani allowlist: non-allowlisted sender returns ALLOWLIST_REJECT and never replies', async () => {
  const { db, cleanup } = fresh();
  try {
    const replies = [];
    const update = makeUpdate({
      text: '/help',
      from_id: NON_ALLOWED_USER,
      chat_id: SHIVANI_CHAT_ID,
      update_id: 2,
    });
    const result = await handleUpdate({
      update,
      db,
      allowlist: SHIVANI_ALLOW,
      notifyChatId: SHIVANI_CHAT_ID,
      send: (msg) => replies.push(msg),
    });
    assert.equal(result, ALLOWLIST_REJECT);
    assert.equal(replies.length, 0, 'must not confirm the bot exists to non-allowlisted senders');
  } finally { cleanup(); }
});

test('Shivani allowlist: Yash chat id is rejected by a Shivani allowlist (cross-tenant isolation)', async () => {
  const { db, cleanup } = fresh();
  try {
    const replies = [];
    const update = makeUpdate({
      text: '/help',
      from_id: YASH_CHAT_ID,
      chat_id: SHIVANI_CHAT_ID,
      update_id: 3,
    });
    const result = await handleUpdate({
      update,
      db,
      allowlist: SHIVANI_ALLOW,
      notifyChatId: SHIVANI_CHAT_ID,
      send: (msg) => replies.push(msg),
    });
    assert.equal(result, ALLOWLIST_REJECT);
    assert.equal(replies.length, 0);
  } finally { cleanup(); }
});

test('Shivani allowlist: /add from allowlisted user enqueues into the (Shivani) DB', async () => {
  const { db, cleanup } = fresh();
  try {
    const replies = [];
    const update = makeUpdate({
      text: '/add https://jobs.example.com/shivani-fullstack-java',
      from_id: SHIVANI_CHAT_ID,
      chat_id: SHIVANI_CHAT_ID,
      update_id: 4,
    });
    const result = await handleUpdate({
      update,
      db,
      allowlist: SHIVANI_ALLOW,
      notifyChatId: SHIVANI_CHAT_ID,
      send: (msg) => replies.push(msg),
    });
    assert.equal(result.cmd, 'add');
    const queueRow = db.prepare('SELECT id, url, status, added_by FROM queue ORDER BY id DESC LIMIT 1').get();
    assert.ok(queueRow, 'expected an enqueued row');
    assert.equal(queueRow.url, 'https://jobs.example.com/shivani-fullstack-java');
    assert.equal(queueRow.status, 'queued');
    assert.equal(queueRow.added_by, SHIVANI_CHAT_ID);
    assert.ok(replies.some(r => /queued/i.test(r)), 'expected a "queued" confirmation reply');
  } finally { cleanup(); }
});
