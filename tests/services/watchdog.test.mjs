import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('parseJournaldLine returns null on garbage', async () => {
  const { parseJournaldLine } = await import('../../services/watchdog.mjs');
  assert.equal(parseJournaldLine('not json'), null);
  assert.equal(parseJournaldLine(''), null);
});

test('parseJournaldLine extracts MESSAGE + unit + timestamp', async () => {
  const { parseJournaldLine } = await import('../../services/watchdog.mjs');
  const raw = readFileSync('tests/fixtures/journald/oom-killed.jsonl', 'utf8').trim();
  const evt = parseJournaldLine(raw);
  assert.equal(evt.unit, 'pipeline-orchestrator.service');
  assert.match(evt.message, /Out of memory/);
  assert.ok(evt.timestampMs > 0);
});

test('OOM rule matches "Out of memory: Killed"', async () => {
  const { matchOom } = await import('../../services/watchdog.mjs');
  assert.ok(matchOom('Out of memory: Killed process 1234'));
  assert.equal(matchOom('regular log line'), false);
});

test('remediateOom clears /tmp/yash-pipeline-* (or no-op if empty)', async () => {
  const { remediateOom } = await import('../../services/watchdog.mjs');
  const calls = [];
  await remediateOom({ exec: (cmd) => calls.push(cmd) });
  assert.equal(calls.length, 1);
  assert.match(calls[0], /rm.*yash-pipeline/);
});

test('remediateOom defaults to /tmp/yash-pipeline-* glob when TMP_CLEANUP_GLOB unset', async () => {
  const { remediateOom } = await import('../../services/watchdog.mjs');
  const orig = process.env.TMP_CLEANUP_GLOB;
  delete process.env.TMP_CLEANUP_GLOB;
  const calls = [];
  try {
    await remediateOom({ exec: (cmd) => calls.push(cmd) });
  } finally {
    if (orig !== undefined) process.env.TMP_CLEANUP_GLOB = orig;
  }
  assert.equal(calls.length, 1);
  assert.match(calls[0], /\/tmp\/yash-pipeline-\*/);
});

test('remediateOom honors TMP_CLEANUP_GLOB env (single glob)', async () => {
  const { remediateOom } = await import('../../services/watchdog.mjs');
  const orig = process.env.TMP_CLEANUP_GLOB;
  process.env.TMP_CLEANUP_GLOB = '/tmp/shivani-pipeline-*';
  const calls = [];
  try {
    await remediateOom({ exec: (cmd) => calls.push(cmd) });
  } finally {
    if (orig === undefined) delete process.env.TMP_CLEANUP_GLOB;
    else process.env.TMP_CLEANUP_GLOB = orig;
  }
  assert.equal(calls.length, 1);
  assert.match(calls[0], /\/tmp\/shivani-pipeline-\*/);
  assert.doesNotMatch(calls[0], /yash-pipeline/);
});

test('remediateOom honors TMP_CLEANUP_GLOB env (comma-separated multi-glob)', async () => {
  const { remediateOom } = await import('../../services/watchdog.mjs');
  const orig = process.env.TMP_CLEANUP_GLOB;
  process.env.TMP_CLEANUP_GLOB = '/tmp/yash-pipeline-*,/tmp/shivani-pipeline-*';
  const calls = [];
  try {
    await remediateOom({ exec: (cmd) => calls.push(cmd) });
  } finally {
    if (orig === undefined) delete process.env.TMP_CLEANUP_GLOB;
    else process.env.TMP_CLEANUP_GLOB = orig;
  }
  // Single exec call covering both globs (so the watchdog stays a one-shot remediation).
  assert.equal(calls.length, 1);
  assert.match(calls[0], /\/tmp\/yash-pipeline-\*/);
  assert.match(calls[0], /\/tmp\/shivani-pipeline-\*/);
});

test('OOM remediation is idempotent', async () => {
  const { remediateOom } = await import('../../services/watchdog.mjs');
  const calls = [];
  await remediateOom({ exec: (c) => calls.push(c) });
  await remediateOom({ exec: (c) => calls.push(c) });
  assert.equal(calls.length, 2);
});

test('tectonic rule matches "tectonic exit" + "File ... not found" within 30s', async () => {
  const { matchTectonic } = await import('../../services/watchdog.mjs');
  assert.ok(matchTectonic(
    [{ message: 'tectonic: exit 1', timestampMs: 1748169600000 },
     { message: "LaTeX Error: File `foo.sty' not found", timestampMs: 1748169605000 }]
  ));
});

test('tectonic rule does NOT match when entries are >30s apart', async () => {
  const { matchTectonic } = await import('../../services/watchdog.mjs');
  assert.equal(matchTectonic(
    [{ message: 'tectonic: exit 1', timestampMs: 1748169600000 },
     { message: "LaTeX Error: File `foo.sty' not found", timestampMs: 1748169700000 }]
  ), false);
});

test('host-cooldown rule matches two 403s on same host within 30 min', async () => {
  const { matchHostCooldown } = await import('../../services/watchdog.mjs');
  const result = matchHostCooldown([
    { message: 'scrapling fetch failed 403 for https://lever.co/abc', timestampMs: 1748169600000 },
    { message: 'scrapling fetch failed 403 for https://lever.co/def', timestampMs: 1748170200000 }
  ]);
  assert.equal(result.host, 'lever.co');
});

test('host-cooldown rule ignores >30min gap', async () => {
  const { matchHostCooldown } = await import('../../services/watchdog.mjs');
  const result = matchHostCooldown([
    { message: 'scrapling fetch failed 403 for https://lever.co/abc', timestampMs: 1748169600000 },
    { message: 'scrapling fetch failed 403 for https://lever.co/def', timestampMs: 1748169600000 + 31 * 60 * 1000 }
  ]);
  assert.equal(result, null);
});

test('heartbeat-miss rule fires when last orchestrator log >10min ago', async () => {
  const { matchHeartbeatMiss } = await import('../../services/watchdog.mjs');
  const now = 1748170400000;
  const lastLogTs = now - 11 * 60 * 1000;
  assert.equal(matchHeartbeatMiss({ lastLogTs, now }), true);
});

test('heartbeat-miss rule does not fire at exactly 10min', async () => {
  const { matchHeartbeatMiss } = await import('../../services/watchdog.mjs');
  const now = 1748170400000;
  const lastLogTs = now - 9 * 60 * 1000;
  assert.equal(matchHeartbeatMiss({ lastLogTs, now }), false);
});

test('disk-pause rule fires at <1G free', async () => {
  const { matchDiskPause } = await import('../../services/watchdog.mjs');
  assert.equal(matchDiskPause({ freeGb: 0.5 }), true);
  assert.equal(matchDiskPause({ freeGb: 0.99 }), true);
  assert.equal(matchDiskPause({ freeGb: 1.0 }), false);
  assert.equal(matchDiskPause({ freeGb: 4.0 }), false);
});

test('readDiskFreeGb parses df output', async () => {
  const { readDiskFreeGb } = await import('../../services/watchdog.mjs');
  const fakeDf = "Filesystem      1G-blocks  Used Available Use% Mounted on\n/dev/vda1            40G   38G        2G  95% /\n";
  assert.equal(readDiskFreeGb({ dfOutput: fakeDf }), 2);
});

test('buildJournalctlArgs follows both Yash and Shivani units (plan §9.5)', async () => {
  const { buildJournalctlArgs, WATCHDOG_UNITS } = await import('../../services/watchdog.mjs');
  const args = buildJournalctlArgs();
  // Args shape: ['--user', '-f', '-u', <u1>, '-u', <u2>, ..., '-o', 'json']
  assert.equal(args[0], '--user');
  assert.equal(args[1], '-f');
  assert.equal(args[args.length - 2], '-o');
  assert.equal(args[args.length - 1], 'json');
  // Every WATCHDOG_UNITS member appears prefixed by '-u'.
  for (const unit of WATCHDOG_UNITS) {
    const idx = args.indexOf(unit);
    assert.ok(idx > 0, `expected ${unit} in args, got ${JSON.stringify(args)}`);
    assert.equal(args[idx - 1], '-u', `each unit must be preceded by -u`);
  }
  // Specifically guards the Shivani extension.
  assert.ok(args.includes('shivani-pipeline-orchestrator'));
  assert.ok(args.includes('shivani-telegram-listener'));
  // Yash units must still be present (no regression).
  assert.ok(args.includes('pipeline-orchestrator'));
  assert.ok(args.includes('telegram-listener'));
});

test('buildJournalctlArgs accepts a custom unit list', async () => {
  const { buildJournalctlArgs } = await import('../../services/watchdog.mjs');
  const args = buildJournalctlArgs(['only-this']);
  assert.deepEqual(args, ['--user', '-f', '-u', 'only-this', '-o', 'json']);
});

test('runWatchdog dispatches matched rules in correct order', async () => {
  const { runWatchdog } = await import('../../services/watchdog.mjs');
  const fakeStream = (async function* () {
    yield JSON.stringify({ __REALTIME_TIMESTAMP: '1748169600000000', _SYSTEMD_USER_UNIT: 'pipeline-orchestrator.service', MESSAGE: 'Out of memory: Killed process' });
  })();
  const execCalls = [];
  await runWatchdog({
    lineSource: fakeStream,
    db: null,
    notifier: { tg: async () => {} },
    exec: (c) => execCalls.push(c),
    diskCheckIntervalMs: 999999,
    heartbeatCheckIntervalMs: 999999,
    maxEvents: 1
  });
  assert.ok(execCalls.some(c => /rm.*yash-pipeline/.test(c)));
});
