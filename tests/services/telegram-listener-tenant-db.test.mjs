// tests/services/telegram-listener-tenant-db.test.mjs
//
// Regression suite for the cross-tenant DB-routing bug discovered 2026-05-25:
//   services/telegram-listener.mjs main() previously hardcoded the DB path to
//   `${PROJECT_ROOT}/ops/work-queue.db`, ignoring the WORK_QUEUE_DB env var that
//   the orchestrator (and the Shivani systemd unit) does honor. Every /add sent
//   to @rani_job_hunter_bot landed in the Yash queue DB, where the Yash
//   orchestrator dutifully picked it up and ran a Yash-tailored pipeline against
//   a Shivani-intended URL.
//
// This file exercises three structural defenses, all pure functions exported
// from services/telegram-listener.mjs:
//   1. resolveQueueDbPath(env, projectRoot)  — same WORK_QUEUE_DB-aware logic
//      the orchestrator uses (pipeline-orchestrator.mjs:528). Eliminates the
//      hardcoded-path mistake at the source.
//   2. assertTenantDbConsistency({ tenant, dbPath }) — fail-fast guard that
//      throws if TENANT and the resolved DB path disagree. A misconfigured env
//      file can no longer silently route writes to the wrong tenant.
//   3. handleUpdate /add reply prefix — when tenantLabel is passed, the reply
//      to the user is prefixed `[<tenant>] ...` so a misrouted /add becomes
//      immediately visible to the operator instead of vanishing into the wrong
//      queue.
//
// Fictional chat IDs only — never the real production ID.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { initDb, closeDb } from '../../services/db.mjs';
import {
  ALLOWLIST_REJECT,
  handleUpdate,
  resolveQueueDbPath,
  assertTenantDbConsistency,
} from '../../services/telegram-listener.mjs';

const SHIVANI_CHAT_ID = 9_000_000_002;
const SHIVANI_ALLOW = new Set([SHIVANI_CHAT_ID]);
const YASH_CHAT_ID = 9_000_000_001;
const YASH_ALLOW = new Set([YASH_CHAT_ID]);

function fresh(prefix) {
  const dir = mkdtempSync(join(tmpdir(), `${prefix}-`));
  const db = initDb(join(dir, 'q.db'));
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

// ─────────────────────────────────────────────────────────────────────────────
// resolveQueueDbPath — honors WORK_QUEUE_DB, mirrors orchestrator
// ─────────────────────────────────────────────────────────────────────────────

test('resolveQueueDbPath: defaults to <projectRoot>/ops/work-queue.db when WORK_QUEUE_DB unset', () => {
  const dbPath = resolveQueueDbPath({}, '/proj');
  assert.equal(dbPath, resolve('/proj', 'ops/work-queue.db'));
});

test('resolveQueueDbPath: honors WORK_QUEUE_DB env (absolute path taken as-is)', () => {
  const dbPath = resolveQueueDbPath(
    { WORK_QUEUE_DB: '/yash-superClaudeHuman/projects/yash-ai-automation-career/ops/shivani/work-queue.db' },
    '/proj',
  );
  assert.equal(dbPath, '/yash-superClaudeHuman/projects/yash-ai-automation-career/ops/shivani/work-queue.db');
});

test('resolveQueueDbPath: honors WORK_QUEUE_DB env (relative path resolved against projectRoot)', () => {
  const dbPath = resolveQueueDbPath({ WORK_QUEUE_DB: 'ops/shivani/work-queue.db' }, '/proj');
  assert.equal(dbPath, resolve('/proj', 'ops/shivani/work-queue.db'));
});

test('resolveQueueDbPath: empty WORK_QUEUE_DB falls back to default', () => {
  const dbPath = resolveQueueDbPath({ WORK_QUEUE_DB: '' }, '/proj');
  assert.equal(dbPath, resolve('/proj', 'ops/work-queue.db'));
});

// ─────────────────────────────────────────────────────────────────────────────
// assertTenantDbConsistency — structural guard against misconfigured units
// ─────────────────────────────────────────────────────────────────────────────

test('assertTenantDbConsistency: tenant=shivani + shivani-segment path is OK', () => {
  assert.doesNotThrow(() =>
    assertTenantDbConsistency({
      tenant: 'shivani',
      dbPath: '/proj/ops/shivani/work-queue.db',
    }),
  );
});

test('assertTenantDbConsistency: tenant=shivani + Yash-path THROWS (the bug we are fixing)', () => {
  assert.throws(
    () => assertTenantDbConsistency({
      tenant: 'shivani',
      dbPath: '/yash-superClaudeHuman/projects/yash-ai-automation-career/ops/work-queue.db',
    }),
    /TENANT=shivani.*shivani/,
    'must throw a tenant/DB mismatch error mentioning both TENANT and the missing segment',
  );
});

test('assertTenantDbConsistency: tenant=yash + Yash-path is OK', () => {
  assert.doesNotThrow(() =>
    assertTenantDbConsistency({
      tenant: 'yash',
      dbPath: '/proj/ops/work-queue.db',
    }),
  );
});

test('assertTenantDbConsistency: tenant=yash + Shivani path THROWS (defensive symmetric guard)', () => {
  assert.throws(
    () => assertTenantDbConsistency({
      tenant: 'yash',
      dbPath: '/proj/ops/shivani/work-queue.db',
    }),
    /shivani/,
    'must refuse a yash listener pointing at /shivani/ path',
  );
});

test('assertTenantDbConsistency: tenant undefined behaves like tenant=yash (backward compat)', () => {
  assert.doesNotThrow(() =>
    assertTenantDbConsistency({ tenant: undefined, dbPath: '/proj/ops/work-queue.db' }),
  );
  assert.throws(
    () => assertTenantDbConsistency({ tenant: undefined, dbPath: '/proj/ops/shivani/work-queue.db' }),
    /shivani/,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// /add reply tenant-tagged prefix — makes misrouted /add visible to operator
// ─────────────────────────────────────────────────────────────────────────────

test('handleUpdate /add: when tenantLabel passed, queued reply is prefixed [<label>]', async () => {
  const { db, cleanup } = fresh('tl-tenant-reply');
  try {
    const replies = [];
    await handleUpdate({
      update: makeUpdate({
        text: '/add https://jobs.example.com/shivani-java-dev',
        from_id: SHIVANI_CHAT_ID,
        chat_id: SHIVANI_CHAT_ID,
        update_id: 100,
      }),
      db,
      allowlist: SHIVANI_ALLOW,
      notifyChatId: SHIVANI_CHAT_ID,
      send: (msg) => replies.push(msg),
      tenantLabel: 'shivani-pipeline',
    });
    assert.equal(replies.length, 1);
    assert.match(
      replies[0],
      /\[shivani-pipeline\]/,
      'queued reply must include [shivani-pipeline] prefix when tenantLabel is set',
    );
    assert.match(replies[0], /Queued/, 'reply must still confirm queuing');
  } finally { cleanup(); }
});

test('handleUpdate /add: no tenantLabel passed → reply has no prefix (Yash backward compat)', async () => {
  const { db, cleanup } = fresh('tl-no-prefix');
  try {
    const replies = [];
    await handleUpdate({
      update: makeUpdate({
        text: '/add https://jobs.example.com/yash-ai-eng',
        from_id: YASH_CHAT_ID,
        chat_id: YASH_CHAT_ID,
        update_id: 200,
      }),
      db,
      allowlist: YASH_ALLOW,
      notifyChatId: YASH_CHAT_ID,
      send: (msg) => replies.push(msg),
      // tenantLabel intentionally omitted
    });
    assert.equal(replies.length, 1);
    assert.doesNotMatch(replies[0], /\[/, 'Yash backward-compat reply must NOT contain bracketed tenant tag');
    assert.match(replies[0], /Queued/);
  } finally { cleanup(); }
});

test('handleUpdate /add (duplicate): tenantLabel also prefixes the "already queued" notice', async () => {
  const { db, cleanup } = fresh('tl-tenant-dup');
  try {
    const replies = [];
    const url = 'https://jobs.example.com/shivani-backend';
    await handleUpdate({
      update: makeUpdate({ text: `/add ${url}`, from_id: SHIVANI_CHAT_ID, chat_id: SHIVANI_CHAT_ID, update_id: 300 }),
      db, allowlist: SHIVANI_ALLOW, notifyChatId: SHIVANI_CHAT_ID,
      send: (msg) => replies.push(msg),
      tenantLabel: 'shivani-pipeline',
    });
    await handleUpdate({
      update: makeUpdate({ text: `/add ${url}`, from_id: SHIVANI_CHAT_ID, chat_id: SHIVANI_CHAT_ID, update_id: 301 }),
      db, allowlist: SHIVANI_ALLOW, notifyChatId: SHIVANI_CHAT_ID,
      send: (msg) => replies.push(msg),
      tenantLabel: 'shivani-pipeline',
    });
    assert.equal(replies.length, 2);
    assert.match(replies[1], /\[shivani-pipeline\]/, 'duplicate notice must also carry tenant prefix');
    assert.match(replies[1], /already/i);
  } finally { cleanup(); }
});
