import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDb, upsertPattern } from '../../services/db.mjs';
import { renderPreambleWithHints } from '../../services/pipeline-orchestrator.mjs';

test('e2e: pre-spawn hint injection — top 3 hints visible in preamble', () => {
  const root = mkdtempSync(join(tmpdir(), 'e2e-hi-'));
  const dbPath = join(root, 'work.db');
  const db = initDb(dbPath);
  const orig = process.env.FEATURE_FAILURE_KB;
  process.env.FEATURE_FAILURE_KB = '1';
  try {
    for (const sig of ['lever:a', 'lever:a', 'lever:a', 'lever:b', 'lever:b', 'lever:c', 'lever:d', 'lever:e']) {
      upsertPattern(db, { signature: sig, hint: `H-${sig.split(':')[1]}`, runId: 1 });
    }
    const template = '## Recent patterns for this host\n\n$LEARNED_HINTS\n';
    const rendered = renderPreambleWithHints(db, 'https://lever.co/jobs/123', template);
    const lines = rendered.split('\n').filter(l => l.startsWith('- '));
    assert.equal(lines.length, 3);  // cap honored
    assert.ok(lines.some(l => l.includes('H-a')));  // top by hits
  } finally {
    process.env.FEATURE_FAILURE_KB = orig;
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
