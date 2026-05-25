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

test('buildTrace defaults trace name to yash-resume-pipeline when TENANT_TRACE_NAME unset', () => {
  const orig = process.env.TENANT_TRACE_NAME;
  delete process.env.TENANT_TRACE_NAME;
  try {
    const trace = buildTrace({ id: 1, url: 'http://x', git_sha: 'abc', created_at: '2026-05-25T00:00:00Z' }, []);
    assert.equal(trace.body.name, 'yash-resume-pipeline');
  } finally {
    if (orig !== undefined) process.env.TENANT_TRACE_NAME = orig;
  }
});

test('buildTrace uses TENANT_TRACE_NAME env when set (shivani-resume-pipeline)', () => {
  const orig = process.env.TENANT_TRACE_NAME;
  process.env.TENANT_TRACE_NAME = 'shivani-resume-pipeline';
  try {
    const trace = buildTrace({ id: 2, url: 'http://x', git_sha: 'abc', created_at: '2026-05-25T00:00:00Z' }, []);
    assert.equal(trace.body.name, 'shivani-resume-pipeline');
  } finally {
    if (orig === undefined) delete process.env.TENANT_TRACE_NAME;
    else process.env.TENANT_TRACE_NAME = orig;
  }
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

import { initDb } from '../../services/db.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function seedDb(n) {
  const dir = mkdtempSync(join(tmpdir(), 'exporter-test-'));
  const dbPath = join(dir, 'work.db');
  const db = initDb(dbPath);
  const insertQ = db.prepare(`
    INSERT INTO queue (url, url_hash, added_at, added_by, status)
    VALUES ('https://x.test/foo', 'h', ?, 1, 'done')
  `);
  const insertR = db.prepare(`
    INSERT INTO runs (id, queue_id, url, status, resume_pdf, git_sha, tokens_in, tokens_out, started_at)
    VALUES (?, ?, 'https://x.test/foo', 'done', '/p.pdf', 'abc', 100, 50, ?)
  `);
  for (let i = 1; i <= n; i++) {
    const q = insertQ.run('2026-05-25T10:00:00.000Z');
    insertR.run(i, q.lastInsertRowid, '2026-05-25T10:00:00.000Z');
  }
  return { db, dir, cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('runExporter advances cursor on 200', async () => {
  const { runExporter } = await import('../../services/exporter.mjs');
  const { db, cleanup } = seedDb(10);
  try {
    const result = await runExporter({
      db,
      httpClient: async () => ({ ok: true, status: 200 }),
      host: 'https://x.test',
      publicKey: 'p', secretKey: 's',
      batchSize: 50,
      runsDir: '/nonexistent'
    });
    assert.equal(result.advanced, 10);
    const { getCursor } = await import('../../services/db.mjs');
    assert.equal(getCursor(db, 'exporter.last_run_id'), 10);
  } finally { cleanup(); }
});

test('runExporter does NOT advance cursor on 5xx', async () => {
  const { runExporter } = await import('../../services/exporter.mjs');
  const { db, cleanup } = seedDb(10);
  try {
    const result = await runExporter({
      db,
      httpClient: async () => ({ ok: false, status: 503 }),
      host: 'https://x.test',
      publicKey: 'p', secretKey: 's',
      batchSize: 50,
      runsDir: '/nonexistent'
    });
    assert.equal(result.advanced, 0);
    const { getCursor } = await import('../../services/db.mjs');
    assert.equal(getCursor(db, 'exporter.last_run_id'), 0);
  } finally { cleanup(); }
});

test('runExporter respects batchSize and advances in batches', async () => {
  const { runExporter } = await import('../../services/exporter.mjs');
  const { db, cleanup } = seedDb(75);
  let batchCount = 0;
  try {
    await runExporter({
      db,
      httpClient: async (_, opts) => {
        batchCount++;
        const body = JSON.parse(opts.body);
        assert.ok(body.batch.length <= 50);
        return { ok: true, status: 200 };
      },
      host: 'https://x.test',
      publicKey: 'p', secretKey: 's',
      batchSize: 50,
      runsDir: '/nonexistent'
    });
    assert.equal(batchCount, 2); // 50 + 25
    const { getCursor } = await import('../../services/db.mjs');
    assert.equal(getCursor(db, 'exporter.last_run_id'), 75);
  } finally { cleanup(); }
});

test('runExporter no-op on empty result set', async () => {
  const { runExporter } = await import('../../services/exporter.mjs');
  const { db, cleanup } = seedDb(0);
  let called = false;
  try {
    await runExporter({
      db,
      httpClient: async () => { called = true; return { ok: true, status: 200 }; },
      host: 'https://x.test',
      publicKey: 'p', secretKey: 's',
      batchSize: 50,
      runsDir: '/nonexistent'
    });
    assert.equal(called, false);
  } finally { cleanup(); }
});

test('main() exits cleanly when FEATURE_EXPORTER=0', async () => {
  const { main } = await import('../../services/exporter.mjs');
  const orig = process.env.FEATURE_EXPORTER;
  process.env.FEATURE_EXPORTER = '0';
  try {
    const result = await main({ exitOnDisabled: false });
    assert.equal(result.disabled, true);
  } finally {
    process.env.FEATURE_EXPORTER = orig;
  }
});
