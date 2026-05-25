// tests/services/logger.test.mjs
// Tests for services/logger.mjs — structured pino logger with base fields,
// PII redaction, and env-driven level.

import test from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';

import { createLogger } from '../../services/logger.mjs';

function makeSink() {
  const chunks = [];
  const stream = new Writable({
    write(chunk, _enc, cb) { chunks.push(chunk.toString()); cb(); }
  });
  return {
    stream,
    lines: () => chunks
      .join('')
      .split('\n')
      .filter(Boolean)
      .map((s) => JSON.parse(s)),
  };
}

test('emits structured JSON with service, pid, time', () => {
  const sink = makeSink();
  const log = createLogger({ service: 'test-svc' }, sink.stream);
  log.info('hello');
  const [line] = sink.lines();
  assert.equal(line.service, 'test-svc');
  assert.equal(line.msg, 'hello');
  assert.equal(typeof line.pid, 'number');
  assert.equal(typeof line.time, 'number');
  assert.equal(line.level, 'info');
});

test('includes git_sha from process.env.GIT_SHA', () => {
  process.env.GIT_SHA = 'abc123def';
  const sink = makeSink();
  const log = createLogger({ service: 'svc' }, sink.stream);
  log.info('msg');
  delete process.env.GIT_SHA;
  assert.equal(sink.lines()[0].git_sha, 'abc123def');
});

test('git_sha falls back to detected SHA or "unknown" when GIT_SHA unset', () => {
  // Auto-detection runs `git rev-parse HEAD` inside the worktree, so we get a
  // 40-char hex sha; outside any git repo it returns "unknown". Accept either.
  delete process.env.GIT_SHA;
  const sink = makeSink();
  const log = createLogger({ service: 'svc' }, sink.stream);
  log.info('msg');
  const { git_sha } = sink.lines()[0];
  assert.ok(
    /^[0-9a-f]{40}$/.test(git_sha) || git_sha === 'unknown',
    `expected 40-hex sha or "unknown", got ${git_sha}`
  );
});

test('child() binds additional context to every log line', () => {
  const sink = makeSink();
  const log = createLogger({ service: 'svc' }, sink.stream);
  const child = log.child({ queue_id: 12, url: 'https://example.com/jobs/1' });
  child.info('processing');
  child.warn('slow');
  const lines = sink.lines();
  assert.equal(lines.length, 2);
  for (const line of lines) {
    assert.equal(line.queue_id, 12);
    assert.equal(line.url, 'https://example.com/jobs/1');
    assert.equal(line.service, 'svc');
  }
});

test('chatId at top level is redacted', () => {
  const sink = makeSink();
  const log = createLogger({ service: 'svc' }, sink.stream);
  log.info({ chatId: 999000111 }, 'msg');
  assert.equal(sink.lines()[0].chatId, '[REDACTED]');
});

test('chat_id snake_case is also redacted', () => {
  const sink = makeSink();
  const log = createLogger({ service: 'svc' }, sink.stream);
  log.info({ chat_id: 999000111 }, 'msg');
  assert.equal(sink.lines()[0].chat_id, '[REDACTED]');
});

test('TELEGRAM_BOT_TOKEN-shaped field is redacted', () => {
  const sink = makeSink();
  const log = createLogger({ service: 'svc' }, sink.stream);
  log.info({ token: 'abc:def', bot_token: 'xyz:123', LOGTAIL_TOKEN: 'tok' }, 'msg');
  const line = sink.lines()[0];
  assert.equal(line.token, '[REDACTED]');
  assert.equal(line.bot_token, '[REDACTED]');
  assert.equal(line.LOGTAIL_TOKEN, '[REDACTED]');
});

test('respects LOG_LEVEL env var', () => {
  process.env.LOG_LEVEL = 'warn';
  const sink = makeSink();
  const log = createLogger({ service: 'svc' }, sink.stream);
  log.info('skipped');
  log.warn('kept');
  delete process.env.LOG_LEVEL;
  const lines = sink.lines();
  assert.equal(lines.length, 1);
  assert.equal(lines[0].msg, 'kept');
});

test('defaults to level=info', () => {
  delete process.env.LOG_LEVEL;
  const sink = makeSink();
  const log = createLogger({ service: 'svc' }, sink.stream);
  log.debug('skipped');
  log.info('kept');
  const lines = sink.lines();
  assert.equal(lines.length, 1);
  assert.equal(lines[0].msg, 'kept');
});

test('serializes Error via err field', () => {
  const sink = makeSink();
  const log = createLogger({ service: 'svc' }, sink.stream);
  const e = new Error('boom');
  log.error({ err: e }, 'caught');
  const line = sink.lines()[0];
  assert.equal(line.err.message, 'boom');
  assert.equal(line.err.type, 'Error');
  assert.ok(line.err.stack);
});

test('throws if service is missing', () => {
  assert.throws(() => createLogger({}, makeSink().stream), /service/i);
});

test('omits tenant field when {tenant} not provided (Yash backward-compat)', () => {
  const sink = makeSink();
  const log = createLogger({ service: 'svc' }, sink.stream);
  log.info('msg');
  const line = sink.lines()[0];
  assert.ok(!('tenant' in line), `tenant should be absent when unset, got: ${JSON.stringify(line)}`);
});

test('includes tenant field when passed to createLogger', () => {
  const sink = makeSink();
  const log = createLogger({ service: 'pipeline-orchestrator', tenant: 'shivani' }, sink.stream);
  log.info('msg');
  assert.equal(sink.lines()[0].tenant, 'shivani');
});

test('tenant survives child() binding', () => {
  const sink = makeSink();
  const log = createLogger({ service: 'svc', tenant: 'shivani' }, sink.stream);
  const child = log.child({ queue_id: 7 });
  child.info('msg');
  const line = sink.lines()[0];
  assert.equal(line.tenant, 'shivani');
  assert.equal(line.queue_id, 7);
});
