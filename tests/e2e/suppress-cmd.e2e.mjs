import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDb, upsertPattern, topHintsByHost } from '../../services/db.mjs';
import { handleSuppress } from '../../services/telegram-listener.mjs';

test('e2e: /suppress removes hint from topHintsByHost', () => {
  const root = mkdtempSync(join(tmpdir(), 'e2e-supp-'));
  const db = initDb(join(root, 'work.db'));
  try {
    upsertPattern(db, { signature: 'lever:bad-hint', hint: 'BAD', runId: 1 });
    let hints = topHintsByHost(db, 'lever.co');
    assert.equal(hints.length, 1);
    handleSuppress(db, 'lever:bad-hint');
    hints = topHintsByHost(db, 'lever.co');
    assert.equal(hints.length, 0);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
