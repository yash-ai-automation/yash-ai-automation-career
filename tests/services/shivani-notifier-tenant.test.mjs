// tests/services/shivani-notifier-tenant.test.mjs
// Plan §8.1 — explicit Shivani-tenant test for TENANT_LABEL=shivani-pipeline
// producing the right /help header. Complements the parameterized tests added
// in PR 1's notifier.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatHelp } from '../../services/notifier.mjs';

function withEnv(key, value, fn) {
  const orig = process.env[key];
  if (value === undefined) delete process.env[key]; else process.env[key] = value;
  try { return fn(); }
  finally {
    if (orig === undefined) delete process.env[key];
    else process.env[key] = orig;
  }
}

test('TENANT_LABEL=shivani-pipeline → formatHelp header reads "shivani-pipeline bot — commands"', () => {
  withEnv('TENANT_LABEL', 'shivani-pipeline', () => {
    const body = formatHelp();
    const firstLine = body.split('\n', 1)[0];
    assert.equal(firstLine, '*shivani-pipeline bot — commands*');
    // The remainder of the help block (command list) is tenant-agnostic and stays identical.
    assert.match(body, /`\/add <url>` — queue a job URL/);
    assert.match(body, /`\/status`/);
    assert.match(body, /`\/cancel <queue_id>`/);
  });
});

test('TENANT_LABEL=yash-pipeline → Yash header (defensive regression)', () => {
  withEnv('TENANT_LABEL', 'yash-pipeline', () => {
    assert.match(formatHelp().split('\n', 1)[0], /^\*yash-pipeline bot — commands\*$/);
  });
});

test('TENANT_LABEL unset → default Yash header (back-compat)', () => {
  withEnv('TENANT_LABEL', undefined, () => {
    assert.match(formatHelp().split('\n', 1)[0], /^\*yash-pipeline bot — commands\*$/);
  });
});
