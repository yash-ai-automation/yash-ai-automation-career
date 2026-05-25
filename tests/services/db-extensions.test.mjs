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
