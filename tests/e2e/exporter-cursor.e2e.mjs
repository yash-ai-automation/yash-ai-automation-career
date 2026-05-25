import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDb, getCursor } from '../../services/db.mjs';
import { runExporter } from '../../services/exporter.mjs';

test('e2e: 75 rows export in 2 batches of (50, 25) with cursor advance', async () => {
  const root = mkdtempSync(join(tmpdir(), 'exporter-e2e-'));
  const dbPath = join(root, 'work.db');
  const runsDir = join(root, 'runs');
  mkdirSync(runsDir);
  const db = initDb(dbPath);
  try {
    const insertQ = db.prepare(`
      INSERT INTO queue (url, url_hash, added_at, added_by, status)
      VALUES ('https://x.test/f', 'h', ?, 1, 'done')
    `);
    const insertR = db.prepare(`
      INSERT INTO runs (id, queue_id, url, status, resume_pdf, git_sha, tokens_in, tokens_out, started_at)
      VALUES (?, ?, 'https://x.test/f', 'done', '/p.pdf', 'abc', 100, 50, ?)
    `);
    for (let i = 1; i <= 75; i++) {
      const q = insertQ.run('2026-05-25T10:00:00.000Z');
      insertR.run(i, q.lastInsertRowid, '2026-05-25T10:00:00.000Z');
      const dir = join(runsDir, String(i));
      mkdirSync(dir);
      writeFileSync(join(dir, 'events.jsonl'), JSON.stringify({ phase: 'p1', start: '...', end: '...' }) + '\n');
    }

    const batches = [];
    const result = await runExporter({
      db,
      httpClient: async (_, opts) => { batches.push(JSON.parse(opts.body).batch.length); return { ok: true, status: 200 }; },
      host: 'https://x.test', publicKey: 'p', secretKey: 's',
      runsDir
    });

    assert.deepEqual(batches, [50, 25]);
    assert.equal(result.advanced, 75);
    assert.equal(getCursor(db, 'exporter.last_run_id'), 75);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
