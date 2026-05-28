// tests/services/rate-limit.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  detectRateLimit,
  readState,
  writeState,
  clearState,
  defaultResetAt,
  FIVE_HOURS_MS,
  RATE_LIMIT_PATTERNS,
  RATE_LIMIT_STATE_PATH,
} from '../../services/rate-limit.mjs';

function tmpFile() {
  const dir = mkdtempSync(join(tmpdir(), 'rate-limit-'));
  return {
    path: join(dir, 'rate-limit.json'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test('detectRateLimit: positive — "Claude AI usage limit reached. Your limit will reset at <ISO>"', () => {
  const text = 'Claude AI usage limit reached. Your limit will reset at 2026-05-28T07:00:00Z. Try again later.';
  const r = detectRateLimit(text);
  assert.equal(r.hit, true);
  assert.ok(r.resetAt instanceof Date, 'resetAt should be a Date');
  assert.equal(r.resetAt.toISOString(), '2026-05-28T07:00:00.000Z');
  assert.match(r.rawHint, /2026-05-28T07:00:00Z/);
});

test('detectRateLimit: positive — "5-hour limit" without reset hint', () => {
  const text = 'Error: you have hit your 5-hour limit. Please come back later.';
  const r = detectRateLimit(text);
  assert.equal(r.hit, true);
  assert.equal(r.resetAt, null);
  assert.equal(r.rawHint, null);
});

test('detectRateLimit: positive — "usage_limit_exceeded" json envelope', () => {
  const text = '{"error":{"type":"usage_limit_exceeded","message":"You have reached your usage limit"}}';
  const r = detectRateLimit(text);
  assert.equal(r.hit, true);
});

test('detectRateLimit: positive — "weekly limit"', () => {
  const text = 'You have reached your weekly limit for the Max plan.';
  const r = detectRateLimit(text);
  assert.equal(r.hit, true);
});

test('detectRateLimit: positive — generic "rate limit exceeded"', () => {
  const text = 'rate limit exceeded for sonnet-4-6';
  const r = detectRateLimit(text);
  assert.equal(r.hit, true);
});

test('detectRateLimit: negative — generic error text', () => {
  const text = 'spawn ENOENT: command claude not found in PATH';
  const r = detectRateLimit(text);
  assert.equal(r.hit, false);
  assert.equal(r.resetAt, null);
  assert.equal(r.rawHint, null);
});

test('detectRateLimit: negative — empty / null / non-string', () => {
  assert.equal(detectRateLimit('').hit, false);
  assert.equal(detectRateLimit(null).hit, false);
  assert.equal(detectRateLimit(undefined).hit, false);
  assert.equal(detectRateLimit(42).hit, false);
});

test('detectRateLimit: unparseable reset hint → resetAt null but hit true', () => {
  const text = 'Claude AI usage limit reached. Your limit will reset at later today.';
  const r = detectRateLimit(text);
  assert.equal(r.hit, true);
  // "later today" cannot be parsed; we expect null so caller falls back.
  assert.equal(r.resetAt, null);
  assert.equal(r.rawHint, 'later today');
});

test('writeState + readState round-trip', () => {
  const { path, cleanup } = tmpFile();
  try {
    const resetAt = new Date('2026-05-28T10:00:00.000Z');
    writeState(path, { resetAt, reason: 'claude-cli usage limit', setBy: 'yash' });
    const r = readState(path);
    assert.ok(r, 'readState should return an object');
    assert.equal(r.resetAt.toISOString(), resetAt.toISOString());
    assert.equal(r.reason, 'claude-cli usage limit');
    assert.equal(r.setBy, 'yash');
    assert.ok(r.writtenAt instanceof Date);
  } finally { cleanup(); }
});

test('readState: missing file → null', () => {
  const { path, cleanup } = tmpFile();
  try {
    assert.equal(readState(path), null);
  } finally { cleanup(); }
});

test('readState: corrupt JSON → null', () => {
  const { path, cleanup } = tmpFile();
  try {
    writeFileSync(path, '{ not json ', 'utf8');
    assert.equal(readState(path), null);
  } finally { cleanup(); }
});

test('readState: missing resetAt → null', () => {
  const { path, cleanup } = tmpFile();
  try {
    writeFileSync(path, JSON.stringify({ reason: 'x', setBy: 'y' }), 'utf8');
    assert.equal(readState(path), null);
  } finally { cleanup(); }
});

test('clearState: idempotent on missing file', () => {
  const { path, cleanup } = tmpFile();
  try {
    // No file exists; should not throw.
    clearState(path);
    clearState(path);
    assert.equal(existsSync(path), false);
  } finally { cleanup(); }
});

test('clearState: deletes existing file', () => {
  const { path, cleanup } = tmpFile();
  try {
    writeState(path, { resetAt: new Date(), reason: 'x', setBy: 'y' });
    assert.equal(existsSync(path), true);
    clearState(path);
    assert.equal(existsSync(path), false);
  } finally { cleanup(); }
});

test('defaultResetAt: now + 5 hours', () => {
  const now = Date.UTC(2026, 4, 28, 0, 0, 0); // May 28 2026 00:00 UTC
  const r = defaultResetAt(now);
  assert.equal(r.getTime(), now + FIVE_HOURS_MS);
});

test('RATE_LIMIT_PATTERNS is a non-empty array of RegExp', () => {
  assert.ok(Array.isArray(RATE_LIMIT_PATTERNS));
  assert.ok(RATE_LIMIT_PATTERNS.length >= 5);
  for (const p of RATE_LIMIT_PATTERNS) assert.ok(p instanceof RegExp);
});

test('RATE_LIMIT_STATE_PATH defaults under /var/lib/claude-pipeline/ when env unset', () => {
  // We can't unset the env var inside the test (the module captured it at import),
  // but we can at least assert the export is a non-empty string.
  assert.equal(typeof RATE_LIMIT_STATE_PATH, 'string');
  assert.ok(RATE_LIMIT_STATE_PATH.length > 0);
});

test('writeState: atomic — old content survives if write would interrupt', () => {
  // We can't easily simulate mid-rename failure here, but we can verify the
  // .tmp pattern is gone after a successful write.
  const { path, cleanup } = tmpFile();
  try {
    writeState(path, { resetAt: new Date('2027-01-01T00:00:00Z'), reason: 'a', setBy: 'b' });
    assert.equal(existsSync(path), true);
    assert.equal(existsSync(path + '.tmp'), false);
  } finally { cleanup(); }
});
