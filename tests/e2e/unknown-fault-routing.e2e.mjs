import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDb } from '../../services/db.mjs';
import { learnFromFailure } from '../../services/failure-kb.mjs';

test('e2e: unknown fault writes review-queue JSON + signals review-queued', async () => {
  const root = mkdtempSync(join(tmpdir(), 'e2e-unk-'));
  const dbPath = join(root, 'work.db');
  const reviewDir = join(root, 'kb-review-queue');
  const db = initDb(dbPath);
  try {
    const r = await learnFromFailure(
      db, 555,
      'A completely unknown failure mode XYZ-987 nothing matches',
      { url: 'https://novel-host.test', reviewDir }
    );
    assert.equal(r.kind, 'review-queued');
    const files = readdirSync(reviewDir);
    assert.equal(files.length, 1);
    const body = JSON.parse(readFileSync(join(reviewDir, files[0]), 'utf8'));
    assert.equal(body.run_id, 555);
    assert.ok(body.snippet.includes('XYZ-987'));
    assert.ok(body.full_error.includes('XYZ-987'));
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
