import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDb, upsertPattern } from '../../services/db.mjs';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'tg-cmd-'));
  const db = initDb(join(dir, 'work.db'));
  return { db, cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('/patterns returns top 10 by hits DESC as markdown', async () => {
  const { handlePatterns } = await import('../../services/telegram-listener.mjs');
  const { db, cleanup } = setup();
  try {
    for (let i = 0; i < 12; i++) {
      for (let j = 0; j <= i; j++) {
        upsertPattern(db, { signature: `sig-${i}`, hint: `H${i}`, runId: 1 });
      }
    }
    const reply = handlePatterns(db);
    // 12 patterns inserted; expect top-10 to include sig-11 (highest hits)
    assert.ok(reply.includes('sig-11'));
    assert.ok(reply.includes('sig-2'));  // top patterns (higher hits)
    assert.equal(reply.includes('sig-0'), false); // sig-0 has hits=1, falls outside top 10
  } finally { cleanup(); }
});
