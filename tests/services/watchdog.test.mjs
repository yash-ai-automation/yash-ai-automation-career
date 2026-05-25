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

test('OOM rule matches "Out of memory: Killed"', async () => {
  const { matchOom } = await import('../../services/watchdog.mjs');
  assert.ok(matchOom('Out of memory: Killed process 1234'));
  assert.equal(matchOom('regular log line'), false);
});

test('remediateOom clears /tmp/yash-pipeline-* (or no-op if empty)', async () => {
  const { remediateOom } = await import('../../services/watchdog.mjs');
  const calls = [];
  await remediateOom({ exec: (cmd) => calls.push(cmd) });
  assert.equal(calls.length, 1);
  assert.match(calls[0], /rm.*yash-pipeline/);
});

test('OOM remediation is idempotent', async () => {
  const { remediateOom } = await import('../../services/watchdog.mjs');
  const calls = [];
  await remediateOom({ exec: (c) => calls.push(c) });
  await remediateOom({ exec: (c) => calls.push(c) });
  assert.equal(calls.length, 2);
});

test('tectonic rule matches "tectonic exit" + "File ... not found" within 30s', async () => {
  const { matchTectonic } = await import('../../services/watchdog.mjs');
  assert.ok(matchTectonic(
    [{ message: 'tectonic: exit 1', timestampMs: 1748169600000 },
     { message: "LaTeX Error: File `foo.sty' not found", timestampMs: 1748169605000 }]
  ));
});

test('tectonic rule does NOT match when entries are >30s apart', async () => {
  const { matchTectonic } = await import('../../services/watchdog.mjs');
  assert.equal(matchTectonic(
    [{ message: 'tectonic: exit 1', timestampMs: 1748169600000 },
     { message: "LaTeX Error: File `foo.sty' not found", timestampMs: 1748169700000 }]
  ), false);
});
