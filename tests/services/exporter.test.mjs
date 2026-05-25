import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildTrace } from '../../services/exporter.mjs';

test('buildTrace produces canonical Langfuse trace shape', () => {
  const runRow = {
    id: 1247,
    url: 'https://lever.co/example',
    status: 'ok',
    pdf_path: 'resumes/yash/Example_AI_Engineer_2026-05-25.pdf',
    git_sha: 'abc1234',
    exit_code: 0,
    tokens_in: 12000,
    tokens_out: 4500,
    created_at: '2026-05-25T10:00:00.000Z'
  };
  const events = []; // empty observations for this base test
  const trace = buildTrace(runRow, events);
  const expected = JSON.parse(readFileSync('tests/fixtures/langfuse/trace-expected.json', 'utf8')).batch[0];
  assert.equal(trace.id, expected.id);
  assert.equal(trace.body.input, expected.body.input);
  assert.equal(trace.body.metadata.git_sha, 'abc1234');
});
