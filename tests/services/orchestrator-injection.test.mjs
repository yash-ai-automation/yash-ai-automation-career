import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initDb, upsertPattern } from '../../services/db.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderPreambleWithHints } from '../../services/pipeline-orchestrator.mjs';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'orch-inj-'));
  const db = initDb(join(dir, 'work.db'));
  return { db, cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('renderPreambleWithHints substitutes top-3 hints when FEATURE_FAILURE_KB=1', () => {
  const { db, cleanup } = setup();
  const orig = process.env.FEATURE_FAILURE_KB;
  process.env.FEATURE_FAILURE_KB = '1';
  try {
    upsertPattern(db, { signature: 'lever:a', hint: 'A', runId: 1 });
    upsertPattern(db, { signature: 'lever:a', hint: 'A', runId: 2 }); // hits=2
    upsertPattern(db, { signature: 'lever:b', hint: 'B', runId: 3 });
    const template = '## Recent patterns for this host\n\n$LEARNED_HINTS';
    const rendered = renderPreambleWithHints(db, 'https://lever.co/x', template);
    assert.ok(rendered.includes('A'));
    assert.ok(rendered.includes('B'));
    assert.equal(rendered.includes('$LEARNED_HINTS'), false);
  } finally {
    process.env.FEATURE_FAILURE_KB = orig;
    cleanup();
  }
});

test('renderPreambleWithHints leaves $LEARNED_HINTS empty when FEATURE_FAILURE_KB=0', () => {
  const { db, cleanup } = setup();
  const orig = process.env.FEATURE_FAILURE_KB;
  process.env.FEATURE_FAILURE_KB = '0';
  try {
    upsertPattern(db, { signature: 'lever:a', hint: 'A', runId: 1 });
    const template = '## Recent patterns for this host\n\n$LEARNED_HINTS';
    const rendered = renderPreambleWithHints(db, 'https://lever.co/x', template);
    assert.equal(rendered.includes('A'), false);
  } finally {
    process.env.FEATURE_FAILURE_KB = orig;
    cleanup();
  }
});
