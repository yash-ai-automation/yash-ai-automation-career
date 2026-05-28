// tests/services/notifier.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatStart, formatPhaseEnd, formatSuccess, formatFailure, formatHelp,
  formatRateLimitPaused, formatRateLimitResumed,
} from '../../services/notifier.mjs';

function withEnv(key, value, fn) {
  const orig = process.env[key];
  if (value === undefined) delete process.env[key]; else process.env[key] = value;
  try { return fn(); }
  finally {
    if (orig === undefined) delete process.env[key];
    else process.env[key] = orig;
  }
}

test('formatStart', () => {
  const s = formatStart({ runId: 42, hostname: 'jobs.acme.com' });
  assert.match(s, /🚀.*#42.*jobs\.acme\.com/);
});

test('formatPhaseEnd shows phase + elapsed', () => {
  const s = formatPhaseEnd({ runId: 42, phase: 'resume_compile_end', elapsedMs: 5_320 });
  assert.match(s, /#42/);
  assert.match(s, /resume_compile_end/);
  assert.match(s, /5\.3\s?s/);
});

test('formatSuccess includes score + total + delivery list', () => {
  const s = formatSuccess({ runId: 42, company: 'Acme', role: 'Backend Engineer', score: 92, totalMs: 412_000 });
  assert.match(s, /✅.*#42.*Acme.*Backend/);
  assert.match(s, /92\/100/);
  assert.match(s, /6m 52s|412/);  // either format acceptable
});

test('formatFailure includes phase + truncated error', () => {
  const longErr = 'x'.repeat(500);
  const s = formatFailure({ runId: 42, hostname: 'jobs.acme.com', phase: 'jd_fetch', error: longErr });
  assert.match(s, /❌.*#42.*jobs\.acme\.com/);
  assert.match(s, /jd_fetch/);
  assert.ok(s.length < 500, 'should truncate error to keep message under 500 chars');
});

test('formatHelp defaults to yash-pipeline when TENANT_LABEL unset', () => {
  withEnv('TENANT_LABEL', undefined, () => {
    assert.match(formatHelp(), /\*yash-pipeline bot — commands\*/);
  });
});

test('formatHelp uses TENANT_LABEL env when set (shivani-pipeline)', () => {
  withEnv('TENANT_LABEL', 'shivani-pipeline', () => {
    assert.match(formatHelp(), /\*shivani-pipeline bot — commands\*/);
  });
});

test('formatHelp ignores empty TENANT_LABEL and falls back to default', () => {
  withEnv('TENANT_LABEL', '', () => {
    assert.match(formatHelp(), /\*yash-pipeline bot — commands\*/);
  });
});

test('formatRateLimitPaused shows ISO + HH:MM UTC and the pause emoji', () => {
  const resetAt = new Date('2026-05-28T09:30:00.000Z');
  const s = formatRateLimitPaused({ resetAt });
  assert.match(s, /⏸️/);
  assert.match(s, /2026-05-28T09:30:00\.000Z/);
  assert.match(s, /≈09:30 UTC/);
  assert.match(s, /paused for all tenants/);
});

test('formatRateLimitPaused accepts ISO string for resetAt', () => {
  const s = formatRateLimitPaused({ resetAt: '2026-05-28T18:05:00Z' });
  assert.match(s, /2026-05-28T18:05:00\.000Z/);
  assert.match(s, /≈18:05 UTC/);
});

test('formatRateLimitResumed contains play emoji and "resuming queue"', () => {
  const s = formatRateLimitResumed();
  assert.match(s, /▶️/);
  assert.match(s, /resuming queue/);
});
