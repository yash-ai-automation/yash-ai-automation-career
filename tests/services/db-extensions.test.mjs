import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initDb } from '../../services/db.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function tmpDb() {
  const dir = mkdtempSync(join(tmpdir(), 'db-ext-test-'));
  return { path: join(dir, 'work.db'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('exporter_state migration is idempotent', () => {
  const { path, cleanup } = tmpDb();
  try {
    const db1 = initDb(path); db1.close();
    const db2 = initDb(path); db2.close();
    const db3 = initDb(path);
    const cols = db3.prepare("PRAGMA table_info(exporter_state)").all();
    assert.equal(cols.length, 2);
    assert.ok(cols.find(c => c.name === 'key' && c.pk === 1));
    assert.ok(cols.find(c => c.name === 'value'));
    db3.close();
  } finally { cleanup(); }
});

test('getCursor returns 0 when missing', async () => {
  const { path, cleanup } = tmpDb();
  try {
    const { getCursor } = await import('../../services/db.mjs');
    const db = initDb(path);
    assert.equal(getCursor(db, 'exporter.last_run_id'), 0);
    db.close();
  } finally { cleanup(); }
});

test('setCursor + getCursor round-trip', async () => {
  const { path, cleanup } = tmpDb();
  try {
    const { getCursor, setCursor } = await import('../../services/db.mjs');
    const db = initDb(path);
    setCursor(db, 'exporter.last_run_id', 1247);
    assert.equal(getCursor(db, 'exporter.last_run_id'), 1247);
    setCursor(db, 'exporter.last_run_id', 1297);
    assert.equal(getCursor(db, 'exporter.last_run_id'), 1297);
    db.close();
  } finally { cleanup(); }
});

test('failure_patterns migration is idempotent', () => {
  const { path, cleanup } = tmpDb();
  try {
    const db1 = initDb(path); db1.close();
    const db2 = initDb(path);
    const cols = db2.prepare("PRAGMA table_info(failure_patterns)").all();
    assert.equal(cols.length, 7);
    db2.close();
  } finally { cleanup(); }
});

test('upsertPattern inserts on first call, increments on second', async () => {
  const { path, cleanup } = tmpDb();
  try {
    const { upsertPattern } = await import('../../services/db.mjs');
    const db = initDb(path);
    upsertPattern(db, { signature: 'sig-1', hint: 'h', runId: 42 });
    let r = db.prepare('SELECT * FROM failure_patterns WHERE signature=?').get('sig-1');
    assert.equal(r.hits, 1);
    assert.equal(r.last_run_id, 42);
    upsertPattern(db, { signature: 'sig-1', hint: 'h', runId: 43 });
    r = db.prepare('SELECT * FROM failure_patterns WHERE signature=?').get('sig-1');
    assert.equal(r.hits, 2);
    assert.equal(r.last_run_id, 43);
    db.close();
  } finally { cleanup(); }
});

test('topHintsByHost returns top 3 by hits DESC, excludes suppressed', async () => {
  const { path, cleanup } = tmpDb();
  try {
    const { upsertPattern, topHintsByHost } = await import('../../services/db.mjs');
    const db = initDb(path);
    upsertPattern(db, { signature: 'lever:a', hint: 'A', runId: 1 });
    upsertPattern(db, { signature: 'lever:a', hint: 'A', runId: 2 });
    upsertPattern(db, { signature: 'lever:b', hint: 'B', runId: 3 });
    upsertPattern(db, { signature: 'lever:c', hint: 'C', runId: 4 });
    upsertPattern(db, { signature: 'lever:d', hint: 'D', runId: 5 });
    db.prepare("UPDATE failure_patterns SET suppressed=1 WHERE signature='lever:d'").run();
    const hints = topHintsByHost(db, 'lever.co', 3);
    assert.equal(hints.length, 3);
    assert.equal(hints[0].hint, 'A');           // hits=2, first
    assert.ok(!hints.find(h => h.hint === 'D')); // suppressed
    db.close();
  } finally { cleanup(); }
});

test('topHintsByHost excludes patterns older than 90 days', async () => {
  const { path, cleanup } = tmpDb();
  try {
    const { upsertPattern, topHintsByHost } = await import('../../services/db.mjs');
    const db = initDb(path);
    upsertPattern(db, { signature: 'lever:old', hint: 'old', runId: 1 });
    db.prepare("UPDATE failure_patterns SET last_seen = date('now','-91 days') WHERE signature='lever:old'").run();
    upsertPattern(db, { signature: 'lever:fresh', hint: 'fresh', runId: 2 });
    const hints = topHintsByHost(db, 'lever.co', 3);
    assert.equal(hints.length, 1);
    assert.equal(hints[0].hint, 'fresh');
    db.close();
  } finally { cleanup(); }
});

test('topHintsByHost cap LIMIT 3 default, configurable', async () => {
  const { path, cleanup } = tmpDb();
  try {
    const { upsertPattern, topHintsByHost } = await import('../../services/db.mjs');
    const db = initDb(path);
    for (let i = 0; i < 5; i++) upsertPattern(db, { signature: `lever:${i}`, hint: `H${i}`, runId: i });
    assert.equal(topHintsByHost(db, 'lever.co').length, 3);
    assert.equal(topHintsByHost(db, 'lever.co', 5).length, 5);
    db.close();
  } finally { cleanup(); }
});
