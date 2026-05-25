import { test } from 'node:test';
import assert from 'node:assert/strict';

test('startHeartbeat returns a function that does nothing when HEALTHCHECK_PING_URL is missing', async () => {
  const { startHeartbeat } = await import('../../services/pipeline-orchestrator.mjs');
  const orig = process.env.HEALTHCHECK_PING_URL;
  delete process.env.HEALTHCHECK_PING_URL;
  try {
    let called = false;
    const fn = startHeartbeat({ httpClient: async () => { called = true; return { ok: true }; }, intervalMs: 10 });
    await new Promise(r => setTimeout(r, 50));
    assert.equal(called, false);
    if (typeof fn === 'function') fn();
  } finally { if (orig) process.env.HEALTHCHECK_PING_URL = orig; }
});

test('startHeartbeat pings HEALTHCHECK_PING_URL on interval', async () => {
  const { startHeartbeat } = await import('../../services/pipeline-orchestrator.mjs');
  process.env.HEALTHCHECK_PING_URL = 'https://hc.test/ping';
  try {
    let calls = 0;
    const stop = startHeartbeat({ httpClient: async (url) => { if (url === 'https://hc.test/ping') calls++; return { ok: true }; }, intervalMs: 20 });
    await new Promise(r => setTimeout(r, 70));
    stop();
    assert.ok(calls >= 2);
  } finally { delete process.env.HEALTHCHECK_PING_URL; }
});

test('startHeartbeat never throws on fetch failure', async () => {
  const { startHeartbeat } = await import('../../services/pipeline-orchestrator.mjs');
  process.env.HEALTHCHECK_PING_URL = 'https://hc.test/ping';
  try {
    const stop = startHeartbeat({ httpClient: async () => { throw new Error('network unreachable'); }, intervalMs: 10 });
    await new Promise(r => setTimeout(r, 40));
    stop(); // should not have crashed
    assert.ok(true);
  } finally { delete process.env.HEALTHCHECK_PING_URL; }
});
