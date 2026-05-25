import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('parseJournaldLine returns null on garbage', async () => {
  const { parseJournaldLine } = await import('../../services/watchdog.mjs');
  assert.equal(parseJournaldLine('not json'), null);
  assert.equal(parseJournaldLine(''), null);
});

test('parseJournaldLine extracts MESSAGE + unit + timestamp', async () => {
  const { parseJournaldLine } = await import('../../services/watchdog.mjs');
  const raw = readFileSync('tests/fixtures/journald/oom-killed.jsonl', 'utf8').trim();
  const evt = parseJournaldLine(raw);
  assert.equal(evt.unit, 'pipeline-orchestrator.service');
  assert.match(evt.message, /Out of memory/);
  assert.ok(evt.timestampMs > 0);
});
