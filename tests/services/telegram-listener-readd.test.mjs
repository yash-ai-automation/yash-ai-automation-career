// tests/services/telegram-listener-readd.test.mjs
//
// Listener-layer tests for the `/readd <queue_id>` command. The dedup-check
// path in `case 'add'` has long advertised `Send /readd <queue_id> to force.`
// but the dispatcher had no `case 'readd'` — operator messages fell through to
// the "Unknown command" default. This file pins the now-implemented contract:
//
//   /readd 11             → 🔁 Re-queued #11 as #<new>: <hostname>
//   /readd 99 (missing)   → ❌ No queue row #99
//   /readd <running id>   → ❌ Queue #<id> is still running — use /cancel <id> first
//   /readd <queued id>    → ℹ️ Queue #<id> is already queued (position N) — nothing to re-add
//   /readd (no arg)       → ❌ Usage: /readd <queue_id>
//   /readd 0 / -3 / abc   → ❌ Usage: /readd <queue_id>
//   tenantLabel passed    → reply prefixed `[<label>] `
//
// Fictional chat IDs only — never the real production ID.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDb, closeDb } from '../../services/db.mjs';
import {
  insertQueueRow,
  markQueueDone,
  markQueueRunning,
} from '../../services/queue.mjs';
import { handleUpdate } from '../../services/telegram-listener.mjs';

const CHAT_ID = 9_000_000_001;
const ALLOW = new Set([CHAT_ID]);

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), 'tl-readd-'));
  const db = initDb(join(dir, 'q.db'));
  return { db, dir, cleanup: () => { closeDb(db); rmSync(dir, { recursive: true, force: true }); } };
}

function makeUpdate({ text, update_id = 1, from_id = CHAT_ID, chat_id = CHAT_ID }) {
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

// ── happy path ──────────────────────────────────────────────────────────────

test('/readd <done queueId> re-queues and replies with old + new id', async () => {
  const { db, cleanup } = fresh();
  try {
    const sourceId = insertQueueRow(db, {
      url: 'https://job-boards.greenhouse.io/pcm/jobs/4257446009',
      urlHash: 'c829c43d2ad7b14e',
      addedBy: CHAT_ID,
    });
    markQueueDone(db, sourceId);

    const replies = [];
    const r = await handleUpdate({
      update: makeUpdate({ text: `/readd ${sourceId}`, update_id: 100 }),
      db, allowlist: ALLOW, notifyChatId: CHAT_ID,
      send: (m) => replies.push(m),
    });
    assert.equal(r.cmd, 'readd');
    assert.ok(r.newQueueId > sourceId);
    assert.equal(replies.length, 1);
    assert.match(replies[0], /🔁/, 'must use 🔁 (distinct from ✅ success)');
    assert.match(replies[0], new RegExp(`#${sourceId}`));
    assert.match(replies[0], new RegExp(`#${r.newQueueId}`));
    assert.match(replies[0], /job-boards\.greenhouse\.io/);

    // DB invariant
    const newRow = db.prepare('SELECT status, url FROM queue WHERE id=?').get(r.newQueueId);
    assert.equal(newRow.status, 'queued');
    assert.equal(newRow.url, 'https://job-boards.greenhouse.io/pcm/jobs/4257446009');
  } finally { cleanup(); }
});

// ── error paths ─────────────────────────────────────────────────────────────

test('/readd <missing id> replies "❌ No queue row #N" (no rows added)', async () => {
  const { db, cleanup } = fresh();
  try {
    const replies = [];
    const r = await handleUpdate({
      update: makeUpdate({ text: '/readd 99999' }),
      db, allowlist: ALLOW, notifyChatId: CHAT_ID,
      send: (m) => replies.push(m),
    });
    assert.equal(r.cmd, 'readd');
    assert.equal(r.error, 'not_found');
    assert.match(replies[0], /❌/);
    assert.match(replies[0], /#99999/);
    const n = db.prepare('SELECT COUNT(*) AS n FROM queue').get().n;
    assert.equal(n, 0, 'no rows added on error path');
  } finally { cleanup(); }
});

test('/readd <running id> refuses with /cancel instruction', async () => {
  const { db, cleanup } = fresh();
  try {
    const sourceId = insertQueueRow(db, { url: 'https://x.com/r', urlHash: 'h-run', addedBy: CHAT_ID });
    markQueueRunning(db, sourceId);
    const replies = [];
    const r = await handleUpdate({
      update: makeUpdate({ text: `/readd ${sourceId}` }),
      db, allowlist: ALLOW, notifyChatId: CHAT_ID,
      send: (m) => replies.push(m),
    });
    assert.equal(r.error, 'still_running');
    assert.match(replies[0], /still running/i);
    assert.match(replies[0], /\/cancel/);
  } finally { cleanup(); }
});

test('/readd <queued id> replies "already queued (position N)"', async () => {
  const { db, cleanup } = fresh();
  try {
    const sourceId = insertQueueRow(db, { url: 'https://x.com/q', urlHash: 'h-q', addedBy: CHAT_ID });
    const replies = [];
    const r = await handleUpdate({
      update: makeUpdate({ text: `/readd ${sourceId}` }),
      db, allowlist: ALLOW, notifyChatId: CHAT_ID,
      send: (m) => replies.push(m),
    });
    assert.equal(r.error, 'already_queued');
    assert.match(replies[0], /ℹ️/);
    assert.match(replies[0], /already queued/i);
    assert.match(replies[0], /position 1/i);
  } finally { cleanup(); }
});

// ── input validation ────────────────────────────────────────────────────────

test('/readd (no arg) replies usage error', async () => {
  const { db, cleanup } = fresh();
  try {
    const replies = [];
    const r = await handleUpdate({
      update: makeUpdate({ text: '/readd' }),
      db, allowlist: ALLOW, notifyChatId: CHAT_ID,
      send: (m) => replies.push(m),
    });
    assert.equal(r.error, 'invalid_id');
    assert.match(replies[0], /Usage: \/readd/);
  } finally { cleanup(); }
});

test('/readd 0, /readd -3, /readd abc all reply usage error (positive integer required)', async () => {
  for (const bad of ['0', '-3', 'abc', '1.5', 'NaN']) {
    const { db, cleanup } = fresh();
    try {
      const replies = [];
      const r = await handleUpdate({
        update: makeUpdate({ text: `/readd ${bad}` }),
        db, allowlist: ALLOW, notifyChatId: CHAT_ID,
        send: (m) => replies.push(m),
      });
      assert.equal(r.error, 'invalid_id', `bad input '${bad}' must produce invalid_id`);
      assert.match(replies[0], /Usage: \/readd/);
    } finally { cleanup(); }
  }
});

// ── tenant prefix parity with /add (PR #16) ─────────────────────────────────

test('/readd reply is prefixed [<tenantLabel>] when tenantLabel passed (parity with /add)', async () => {
  const { db, cleanup } = fresh();
  try {
    const sourceId = insertQueueRow(db, { url: 'https://x.com/p', urlHash: 'h-p', addedBy: CHAT_ID });
    markQueueDone(db, sourceId);
    const replies = [];
    await handleUpdate({
      update: makeUpdate({ text: `/readd ${sourceId}` }),
      db, allowlist: ALLOW, notifyChatId: CHAT_ID,
      send: (m) => replies.push(m),
      tenantLabel: 'shivani-pipeline',
    });
    assert.match(replies[0], /\[shivani-pipeline\]/);
    assert.match(replies[0], /🔁/);
  } finally { cleanup(); }
});

test('/readd error replies also carry tenantLabel prefix', async () => {
  const { db, cleanup } = fresh();
  try {
    const replies = [];
    await handleUpdate({
      update: makeUpdate({ text: '/readd 99' }),
      db, allowlist: ALLOW, notifyChatId: CHAT_ID,
      send: (m) => replies.push(m),
      tenantLabel: 'shivani-pipeline',
    });
    assert.match(replies[0], /\[shivani-pipeline\]/, 'error path must also carry tenant prefix');
  } finally { cleanup(); }
});

// ── /help advertises /readd ─────────────────────────────────────────────────

test('/help reply lists /readd <queue_id>', async () => {
  const { db, cleanup } = fresh();
  try {
    const replies = [];
    await handleUpdate({
      update: makeUpdate({ text: '/help' }),
      db, allowlist: ALLOW, notifyChatId: CHAT_ID,
      send: (m) => replies.push(m),
    });
    assert.match(replies[0], /\/readd <queue_id>/, '/help must advertise /readd');
  } finally { cleanup(); }
});
