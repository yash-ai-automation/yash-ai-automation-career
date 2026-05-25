import { test } from 'node:test';
import assert from 'node:assert/strict';

test('extractSignature: Cloudflare 403 on lever.co', async () => {
  const { extractSignature } = await import('../../services/failure-kb.mjs');
  const err = 'Error: scrapling fetch failed: HTTP 403 Forbidden\nCloudflare challenge detected at https://lever.co/jobs/abc';
  const result = extractSignature(err, { url: 'https://lever.co/jobs/abc', exitCode: 1 });
  assert.equal(result.signature, 'scrapling:cloudflare:lever.co');
  assert.match(result.hint, /cloudflare|browser fallback/i);
});

test('extractSignature: tectonic exit', async () => {
  const { extractSignature } = await import('../../services/failure-kb.mjs');
  const err = 'tectonic: latex error: tectonic exited with code 1\nLaTeX Error: File `foo.sty\' not found';
  const result = extractSignature(err, { url: 'https://x.test', exitCode: 1 });
  assert.equal(result.signature, 'tectonic:missing-file');
  assert.match(result.hint, /tectonic|missing/i);
});

test('extractSignature: validator bullet-count fail', async () => {
  const { extractSignature } = await import('../../services/failure-kb.mjs');
  const err = 'validate_bullets: expected 15 bullets, got 14';
  const result = extractSignature(err, { url: 'https://x.test', exitCode: 1 });
  assert.equal(result.signature, 'validator:bullet-count');
  assert.match(result.hint, /bullet|15/i);
});

test('extractSignature: OOM', async () => {
  const { extractSignature } = await import('../../services/failure-kb.mjs');
  const err = 'Out of memory: Killed process 1234 (node)';
  const result = extractSignature(err, { url: 'https://x.test', exitCode: 137 });
  assert.equal(result.signature, 'system:oom');
});

test('extractSignature: rate limit', async () => {
  const { extractSignature } = await import('../../services/failure-kb.mjs');
  const err = 'API error: 429 Too Many Requests\nrate_limit_exceeded';
  const result = extractSignature(err, { url: 'https://api.anthropic.com', exitCode: 1 });
  assert.equal(result.signature, 'anthropic:rate-limit');
});

test('extractSignature: Telegram outage', async () => {
  const { extractSignature } = await import('../../services/failure-kb.mjs');
  const err = 'Telegram Bot API: 502 Bad Gateway';
  const result = extractSignature(err, { url: 'https://x.test', exitCode: 1 });
  assert.equal(result.signature, 'telegram:outage');
});

test('extractSignature: unknown returns {unknown: true, snippet}', async () => {
  const { extractSignature } = await import('../../services/failure-kb.mjs');
  const err = 'Some never-before-seen weird failure mode XYZ';
  const result = extractSignature(err, { url: 'https://x.test', exitCode: 1 });
  assert.equal(result.unknown, true);
  assert.ok(result.snippet.includes('XYZ'));
  assert.ok(result.snippet.length <= 200);
});

test('extractSignature: signature is deterministic', async () => {
  const { extractSignature } = await import('../../services/failure-kb.mjs');
  const err = 'Error: scrapling fetch failed: HTTP 403 Forbidden\nCloudflare';
  const a = extractSignature(err, { url: 'https://lever.co/x', exitCode: 1 });
  const b = extractSignature(err, { url: 'https://lever.co/x', exitCode: 1 });
  assert.equal(a.signature, b.signature);
});

test('extractSignature: hint is capped at 100 chars', async () => {
  const { extractSignature } = await import('../../services/failure-kb.mjs');
  const err = 'Out of memory: Killed process';
  const r = extractSignature(err, { url: 'https://x.test', exitCode: 137 });
  assert.ok(r.hint.length <= 100);
});

test('regex catalogue is exported for inspection', async () => {
  const mod = await import('../../services/failure-kb.mjs');
  assert.ok(Array.isArray(mod.SIGNATURE_PATTERNS));
  assert.equal(mod.SIGNATURE_PATTERNS.length, 6);
});
