import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDb } from '../../services/db.mjs';
import { learnFromFailure } from '../../services/failure-kb.mjs';

test('e2e: post-fail branch calls learnFromFailure and upserts pattern', async () => {
  const root = mkdtempSync(join(tmpdir(), 'e2e-lof-'));
  const dbPath = join(root, 'work.db');
  const reviewDir = join(root, 'kb-review-queue');
  const db = initDb(dbPath);
  try {
    // Seed a parent queue row + a runs row (real schema: queue_id FK, started_at)
    const q = db.prepare(`
      INSERT INTO queue (url, url_hash, added_at, added_by, status)
      VALUES ('https://lever.co/abc', 'h', ?, 1, 'failed')
    `).run('2026-05-25T10:00:00.000Z');
    db.prepare(`
      INSERT INTO runs (id, queue_id, url, status, started_at)
      VALUES (?, ?, 'https://lever.co/abc', 'failed', ?)
    `).run(101, q.lastInsertRowid, '2026-05-25T10:00:00.000Z');

    const claudeLog = 'Error: scrapling fetch failed: HTTP 403 Forbidden\nCloudflare challenge detected';
    const r = await learnFromFailure(db, 101, claudeLog, { url: 'https://lever.co/abc', reviewDir });
    assert.equal(r.kind, 'learned');
    const row = db.prepare('SELECT * FROM failure_patterns WHERE signature=?').get(r.signature);
    assert.equal(row.hits, 1);
    assert.equal(row.last_run_id, 101);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
