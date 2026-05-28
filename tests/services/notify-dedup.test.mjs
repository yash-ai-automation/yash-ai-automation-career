// tests/services/notify-dedup.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createNotifyDedup,
  msUntilEndOfUtcDay,
  msUntilEndOfUtcWeek,
} from '../../services/notify-dedup.mjs';

test('first shouldEmit returns true; immediate second returns false', () => {
  const d = createNotifyDedup({ defaultWindowMs: 60_000 });
  assert.equal(d.shouldEmit('cap:daily'), true);
  assert.equal(d.shouldEmit('cap:daily'), false);
});

test('after the window elapses, shouldEmit returns true again', () => {
  let t = 1_000_000;
  const d = createNotifyDedup({ defaultWindowMs: 60_000, now: () => t });
  assert.equal(d.shouldEmit('cap:daily'), true);
  t += 30_000;
  assert.equal(d.shouldEmit('cap:daily'), false, 'still within window');
  t += 31_000;
  assert.equal(d.shouldEmit('cap:daily'), true, 'window elapsed; re-emit ok');
});

test('per-call windowMs overrides the default', () => {
  let t = 1_000_000;
  const d = createNotifyDedup({ defaultWindowMs: 60_000, now: () => t });
  assert.equal(d.shouldEmit('k', 5_000), true);
  t += 4_999;
  assert.equal(d.shouldEmit('k', 5_000), false);
  t += 2;
  assert.equal(d.shouldEmit('k', 5_000), true);
});

test('distinct keys are independent', () => {
  const d = createNotifyDedup({ defaultWindowMs: 60_000 });
  assert.equal(d.shouldEmit('a'), true);
  assert.equal(d.shouldEmit('b'), true);
  assert.equal(d.shouldEmit('a'), false);
  assert.equal(d.shouldEmit('b'), false);
});

test('reset(key) clears only that key', () => {
  const d = createNotifyDedup({ defaultWindowMs: 60_000 });
  d.shouldEmit('a');
  d.shouldEmit('b');
  d.reset('a');
  assert.equal(d.shouldEmit('a'), true, 'a was reset');
  assert.equal(d.shouldEmit('b'), false, 'b still suppressed');
});

test('reset() with no arg clears the entire map', () => {
  const d = createNotifyDedup({ defaultWindowMs: 60_000 });
  d.shouldEmit('a');
  d.shouldEmit('b');
  d.reset();
  assert.equal(d.shouldEmit('a'), true);
  assert.equal(d.shouldEmit('b'), true);
});

test('shouldEmit returns true for empty/invalid key (failsafe — never suppress garbage)', () => {
  const d = createNotifyDedup({ defaultWindowMs: 60_000 });
  assert.equal(d.shouldEmit(''), true);
  assert.equal(d.shouldEmit(null), true);
  assert.equal(d.shouldEmit(undefined), true);
});

test('msUntilEndOfUtcDay: positive and < 24h', () => {
  const noonUtc = Date.UTC(2026, 4, 28, 12, 0, 0); // May 28 2026 12:00 UTC
  const r = msUntilEndOfUtcDay(noonUtc);
  assert.equal(r, 12 * 60 * 60 * 1000);
});

test('msUntilEndOfUtcDay: just before midnight rolls over correctly', () => {
  const nearMidnight = Date.UTC(2026, 4, 28, 23, 59, 30); // 30s before midnight
  const r = msUntilEndOfUtcDay(nearMidnight);
  assert.equal(r, 30 * 1000);
});

test('msUntilEndOfUtcWeek: midweek returns positive < 7d', () => {
  const wedNoon = Date.UTC(2026, 4, 27, 12, 0, 0); // Wed May 27 2026 12:00 UTC
  const r = msUntilEndOfUtcWeek(wedNoon);
  // Next Monday = Jun 1 2026 00:00 UTC = Wed 12pm + 4d 12h
  assert.equal(r, (4 * 24 + 12) * 60 * 60 * 1000);
});

test('msUntilEndOfUtcWeek: Sunday returns ~24h', () => {
  const sunNoon = Date.UTC(2026, 4, 31, 12, 0, 0); // Sun May 31 2026 12:00 UTC
  const r = msUntilEndOfUtcWeek(sunNoon);
  assert.equal(r, 12 * 60 * 60 * 1000);
});
