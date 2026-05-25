// tests/services/queue-readd.test.mjs
//
// Unit tests for the `readdQueueRow(db, sourceQueueId)` helper in
// services/queue.mjs — the storage primitive behind the listener's new
// `/readd <queue_id>` command. Implements the contract the dedup-check path
// already advertises but had no code behind it:
//   "Already done in last 24h (run #N). Send /readd <queue_id> to force."
//
// Behavior:
//   - For a terminal source row (done/failed/cancelled/dedup_skipped) → insert
//     a new row inheriting url + url_hash + added_by, with status='queued',
//     attempts=0, no assigned_at / cancel_requested. Returns { newQueueId,
//     url, hostname }.
//   - For a missing source id → throw a typed `ReaddError` with code
//     'not_found'.
//   - For a running source row → throw `ReaddError` code='still_running'.
//   - For a queued source row → throw `ReaddError` code='already_queued' with
//     `existingPosition` so the listener can surface "already queued (position
//     N)".
//   - Source row is NEVER mutated or deleted (audit preserved).
//
// Fictional chat ID for added_by — never a real production user ID.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDb, closeDb } from '../../services/db.mjs';
import {
  insertQueueRow,
  markQueueDone,
  markQueueFailed,
  markQueueCancelled,
  markQueueDedupSkipped,
  markQueueRunning,
  readdQueueRow,
  ReaddError,
} from '../../services/queue.mjs';

const FAKE_USER = 9_000_000_001;

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), 'queue-readd-'));
  const db  = initDb(join(dir, 'q.db'));
  return { db, dir, cleanup: () => { closeDb(db); rmSync(dir, { recursive: true, force: true }); } };
}

// ── happy path: terminal source → new queued row ────────────────────────────

test('readdQueueRow: done source → inserts new queued row inheriting url+url_hash+added_by', () => {
  const { db, cleanup } = fresh();
  try {
    const sourceId = insertQueueRow(db, {
      url: 'https://job-boards.greenhouse.io/pcm/jobs/4257446009',
      urlHash: 'c829c43d2ad7b14e',
      addedBy: FAKE_USER,
    });
    markQueueDone(db, sourceId);

    const r = readdQueueRow(db, sourceId);
    assert.ok(r.newQueueId > sourceId, 'must allocate a new id');
    assert.equal(r.url, 'https://job-boards.greenhouse.io/pcm/jobs/4257446009');
    assert.equal(r.hostname, 'job-boards.greenhouse.io');

    const newRow = db.prepare('SELECT * FROM queue WHERE id=?').get(r.newQueueId);
    assert.equal(newRow.url, 'https://job-boards.greenhouse.io/pcm/jobs/4257446009');
    assert.equal(newRow.url_hash, 'c829c43d2ad7b14e');
    assert.equal(newRow.added_by, FAKE_USER, 'added_by inherited from source row');
    assert.equal(newRow.status, 'queued');
    assert.equal(newRow.attempts, 0,            'attempts MUST reset to 0');
    assert.equal(newRow.cancel_requested, 0,    'cancel_requested MUST not be inherited');
    assert.equal(newRow.assigned_at, null,      'assigned_at MUST not be inherited');
    assert.equal(newRow.completed_at, null,     'completed_at MUST not be inherited');

    // Audit invariant: source row left intact.
    const src = db.prepare('SELECT status FROM queue WHERE id=?').get(sourceId);
    assert.equal(src.status, 'done', 'source row must remain in done state — audit preserved');
  } finally { cleanup(); }
});

test('readdQueueRow: failed source row is also re-queueable', () => {
  const { db, cleanup } = fresh();
  try {
    const sourceId = insertQueueRow(db, { url: 'https://x.com/job', urlHash: 'h-fail', addedBy: FAKE_USER });
    markQueueFailed(db, sourceId);
    const r = readdQueueRow(db, sourceId);
    assert.ok(r.newQueueId > sourceId);
    assert.equal(db.prepare('SELECT status FROM queue WHERE id=?').get(r.newQueueId).status, 'queued');
  } finally { cleanup(); }
});

test('readdQueueRow: cancelled source row is re-queueable', () => {
  const { db, cleanup } = fresh();
  try {
    const sourceId = insertQueueRow(db, { url: 'https://x.com/job', urlHash: 'h-cncl', addedBy: FAKE_USER });
    markQueueCancelled(db, sourceId);
    const r = readdQueueRow(db, sourceId);
    assert.ok(r.newQueueId > sourceId);
  } finally { cleanup(); }
});

test('readdQueueRow: dedup_skipped source row is re-queueable', () => {
  const { db, cleanup } = fresh();
  try {
    const sourceId = insertQueueRow(db, { url: 'https://x.com/job', urlHash: 'h-dedup', addedBy: FAKE_USER });
    markQueueDedupSkipped(db, sourceId);
    const r = readdQueueRow(db, sourceId);
    assert.ok(r.newQueueId > sourceId);
  } finally { cleanup(); }
});

// ── error paths: typed ReaddError with code ──────────────────────────────────

// Helper: invoke fn, capture the thrown error, or fail if it didn't throw.
// (Node's `assert.throws` returns undefined; we need the actual error object.)
function captureThrow(fn) {
  try { fn(); } catch (e) { return e; }
  throw new Error('expected fn to throw, but it returned normally');
}

test('readdQueueRow: missing source id throws ReaddError code=not_found', () => {
  const { db, cleanup } = fresh();
  try {
    const err = captureThrow(() => readdQueueRow(db, 99999));
    assert.equal(err.name, 'ReaddError');
    assert.equal(err.code, 'not_found');
    assert.equal(err.queueId, 99999);
  } finally { cleanup(); }
});

test('readdQueueRow: running source throws ReaddError code=still_running', () => {
  const { db, cleanup } = fresh();
  try {
    const sourceId = insertQueueRow(db, { url: 'https://x.com/job', urlHash: 'h-run', addedBy: FAKE_USER });
    markQueueRunning(db, sourceId);
    const err = captureThrow(() => readdQueueRow(db, sourceId));
    assert.equal(err.name, 'ReaddError');
    assert.equal(err.code, 'still_running');
    assert.equal(err.queueId, sourceId);
  } finally { cleanup(); }
});

test('readdQueueRow: queued source throws ReaddError code=already_queued with existingPosition', () => {
  const { db, cleanup } = fresh();
  try {
    // Seed 2 prior queued rows so this one sits at position 3.
    insertQueueRow(db, { url: 'https://x.com/a', urlHash: 'a', addedBy: FAKE_USER });
    insertQueueRow(db, { url: 'https://x.com/b', urlHash: 'b', addedBy: FAKE_USER });
    const sourceId = insertQueueRow(db, { url: 'https://x.com/job', urlHash: 'h-q', addedBy: FAKE_USER });
    const err = captureThrow(() => readdQueueRow(db, sourceId));
    assert.equal(err.name, 'ReaddError');
    assert.equal(err.code, 'already_queued');
    assert.equal(err.queueId, sourceId);
    assert.equal(err.existingPosition, 3, 'position counts queued rows up to and including this one');
  } finally { cleanup(); }
});

test('readdQueueRow: idempotency — readd, then readd of the new id reports already_queued', () => {
  const { db, cleanup } = fresh();
  try {
    const sourceId = insertQueueRow(db, { url: 'https://x.com/job', urlHash: 'h-idem', addedBy: FAKE_USER });
    markQueueDone(db, sourceId);
    const first = readdQueueRow(db, sourceId);
    const err = captureThrow(() => readdQueueRow(db, first.newQueueId));
    assert.equal(err.code, 'already_queued');
  } finally { cleanup(); }
});

test('readdQueueRow: hostname extraction falls back to raw URL on parse failure', () => {
  const { db, cleanup } = fresh();
  try {
    // URL.parse will accept this as a valid URL with empty hostname? Use a truly invalid one.
    const sourceId = insertQueueRow(db, { url: 'not-a-url', urlHash: 'h-bad', addedBy: FAKE_USER });
    markQueueDone(db, sourceId);
    const r = readdQueueRow(db, sourceId);
    assert.ok(r.hostname, 'hostname must be a non-empty string (falls back to raw url)');
  } finally { cleanup(); }
});
