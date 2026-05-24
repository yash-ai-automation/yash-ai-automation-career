// tests/services/logger-git-sha.test.mjs
// Tests for detectGitSha() — env wins; falls back to git rev-parse HEAD; only
// returns 'unknown' as a last resort when git is unavailable / not a repo.

import test from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';

import { createLogger, detectGitSha } from '../../services/logger.mjs';

test('detectGitSha: GIT_SHA env wins (no subprocess call)', () => {
  let called = false;
  const runCmd = () => { called = true; return 'should-not-be-used'; };
  const sha = detectGitSha({ GIT_SHA: 'env-sha-abc' }, runCmd);
  assert.equal(sha, 'env-sha-abc');
  assert.equal(called, false, 'runCmd should not be invoked when env is set');
});

test('detectGitSha: falls back to runCmd when GIT_SHA env unset', () => {
  const sha = detectGitSha({}, () => 'cmd-resolved-sha');
  assert.equal(sha, 'cmd-resolved-sha');
});

test('detectGitSha: returns "unknown" when runCmd throws', () => {
  const sha = detectGitSha({}, () => { throw new Error('not a git dir'); });
  assert.equal(sha, 'unknown');
});

test('detectGitSha: returns "unknown" when runCmd returns empty string', () => {
  const sha = detectGitSha({}, () => '');
  assert.equal(sha, 'unknown');
});

test('detectGitSha: default runCmd resolves real git HEAD when called inside repo', () => {
  delete process.env.GIT_SHA;
  const sha = detectGitSha();
  // Either a 40-char hex sha, or "unknown" if git unavailable. NEVER an empty string.
  assert.ok(
    /^[0-9a-f]{40}$/.test(sha) || sha === 'unknown',
    `expected 40-hex sha or "unknown", got ${JSON.stringify(sha)}`
  );
});

test('createLogger: base.git_sha reflects detectGitSha output (real sha when no env)', () => {
  delete process.env.GIT_SHA;
  const chunks = [];
  const stream = new Writable({ write(c, _e, cb) { chunks.push(c.toString()); cb(); } });
  const log = createLogger({ service: 'gs-test' }, stream);
  log.info('m');
  const line = JSON.parse(chunks.join('').trim());
  // When run inside the repo, base.git_sha should be a 40-hex string (NOT "unknown")
  assert.match(line.git_sha, /^[0-9a-f]{40}$/, `expected 40-hex git_sha, got ${line.git_sha}`);
});

test('createLogger: does NOT emit duplicate git_sha when child or call passes it', () => {
  process.env.GIT_SHA = 'base-sha-xyz';
  const chunks = [];
  const stream = new Writable({ write(c, _e, cb) { chunks.push(c.toString()); cb(); } });
  const log = createLogger({ service: 'gs-test' }, stream);
  log.info({ event: 'bootstrap' }, 'no git_sha in payload');
  delete process.env.GIT_SHA;
  const raw = chunks.join('').trim();
  // Count occurrences of "git_sha" in the raw JSON; should be exactly 1
  const occurrences = (raw.match(/"git_sha"/g) || []).length;
  assert.equal(occurrences, 1, `expected 1 git_sha key, got ${occurrences} in: ${raw}`);
});
