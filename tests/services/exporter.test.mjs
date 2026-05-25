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

test('postBatch returns true on 200', async () => {
  const { postBatch } = await import('../../services/exporter.mjs');
  const stub = async (url, opts) => ({ ok: true, status: 200 });
  const result = await postBatch({ httpClient: stub, host: 'https://x.test', publicKey: 'pk', secretKey: 'sk' }, [{}]);
  assert.equal(result, true);
});

test('postBatch returns false on 5xx', async () => {
  const { postBatch } = await import('../../services/exporter.mjs');
  const stub = async () => ({ ok: false, status: 503 });
  assert.equal(await postBatch({ httpClient: stub, host: 'https://x.test', publicKey: 'p', secretKey: 's' }, [{}]), false);
});

test('postBatch returns false on 429 (quota)', async () => {
  const { postBatch } = await import('../../services/exporter.mjs');
  const stub = async () => ({ ok: false, status: 429 });
  assert.equal(await postBatch({ httpClient: stub, host: 'https://x.test', publicKey: 'p', secretKey: 's' }, [{}]), false);
});

test('postBatch throws on 401 (auth)', async () => {
  const { postBatch } = await import('../../services/exporter.mjs');
  const stub = async () => ({ ok: false, status: 401 });
  await assert.rejects(
    () => postBatch({ httpClient: stub, host: 'https://x.test', publicKey: 'p', secretKey: 's' }, [{}]),
    /auth/
  );
});

test('postBatch returns false on network error', async () => {
  const { postBatch } = await import('../../services/exporter.mjs');
  const stub = async () => { throw new Error('ENETUNREACH'); };
  assert.equal(await postBatch({ httpClient: stub, host: 'https://x.test', publicKey: 'p', secretKey: 's' }, [{}]), false);
});

test('postBatch posts to /api/public/ingestion', async () => {
  const { postBatch } = await import('../../services/exporter.mjs');
  let capturedUrl = null;
  const stub = async (url) => { capturedUrl = url; return { ok: true, status: 200 }; };
  await postBatch({ httpClient: stub, host: 'https://x.test', publicKey: 'p', secretKey: 's' }, [{}]);
  assert.ok(capturedUrl.endsWith('/api/public/ingestion'));
});
