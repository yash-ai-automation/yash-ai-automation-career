import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDb } from '../../services/db.mjs';
import { renderPreambleWithHints } from '../../services/pipeline-orchestrator.mjs';

test('e2e: with all FEATURE_* flags OFF, no overlay activity happens', () => {
  const root = mkdtempSync(join(tmpdir(), 'e2e-flags-off-'));
  const db = initDb(join(root, 'work.db'));
  const before = {
    FEATURE_EXPORTER: process.env.FEATURE_EXPORTER,
    FEATURE_FAILURE_KB: process.env.FEATURE_FAILURE_KB,
    FEATURE_WATCHDOG: process.env.FEATURE_WATCHDOG,
  };
  process.env.FEATURE_EXPORTER = '0';
  process.env.FEATURE_FAILURE_KB = '0';
  process.env.FEATURE_WATCHDOG = '0';
  try {
    const template = '## Recent\n\n$LEARNED_HINTS';
    const rendered = renderPreambleWithHints(db, 'https://x.test', template);
    assert.equal(rendered.includes('$LEARNED_HINTS'), false);
    assert.equal(rendered.includes('- '), false); // no bullets injected
  } finally {
    for (const k of Object.keys(before)) {
      if (before[k] === undefined) delete process.env[k];
      else process.env[k] = before[k];
    }
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
