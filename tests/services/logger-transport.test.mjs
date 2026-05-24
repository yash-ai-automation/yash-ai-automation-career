// tests/services/logger-transport.test.mjs
// Tests for the LOG_TRANSPORT env wiring — buildTransportOpts() decides how
// log lines leave the process. Default is none (stdout only); 'betterstack'
// adds an HTTP transport that requires LOGTAIL_TOKEN.

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildTransportOpts } from '../../services/logger.mjs';

test('buildTransportOpts: returns null when LOG_TRANSPORT unset', () => {
  assert.equal(buildTransportOpts({}), null);
});

test('buildTransportOpts: returns null when LOG_TRANSPORT=none', () => {
  assert.equal(buildTransportOpts({ LOG_TRANSPORT: 'none' }), null);
});

test('buildTransportOpts: returns null when LOG_TRANSPORT is empty string', () => {
  assert.equal(buildTransportOpts({ LOG_TRANSPORT: '' }), null);
});

test('buildTransportOpts: case-insensitive (BETTERSTACK works)', () => {
  const opts = buildTransportOpts({ LOG_TRANSPORT: 'BETTERSTACK', LOGTAIL_TOKEN: 'tok' });
  assert.equal(opts.target, '@logtail/pino');
});

test('buildTransportOpts: betterstack requires LOGTAIL_TOKEN', () => {
  assert.throws(
    () => buildTransportOpts({ LOG_TRANSPORT: 'betterstack' }),
    /LOGTAIL_TOKEN/
  );
});

test('buildTransportOpts: betterstack returns @logtail/pino target with sourceToken', () => {
  const opts = buildTransportOpts({ LOG_TRANSPORT: 'betterstack', LOGTAIL_TOKEN: 'tok-abc' });
  assert.equal(opts.target, '@logtail/pino');
  assert.equal(opts.options.sourceToken, 'tok-abc');
});

test('buildTransportOpts: unknown LOG_TRANSPORT throws with supported list', () => {
  assert.throws(
    () => buildTransportOpts({ LOG_TRANSPORT: 'splunk' }),
    /Unknown LOG_TRANSPORT.*splunk.*supported/
  );
});

test('buildTransportOpts: defaults to process.env when no arg passed', () => {
  // Just verify it doesn't throw and reads process.env (which has no LOG_TRANSPORT set in test)
  delete process.env.LOG_TRANSPORT;
  delete process.env.LOGTAIL_TOKEN;
  assert.equal(buildTransportOpts(), null);
});
