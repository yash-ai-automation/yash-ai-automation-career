// tests/services/orchestrator-env.test.mjs
// Env-driven configuration: AUDIT_LOG_PATH + PREAMBLE_DIR resolvers.
// PR 1 §1-2 of the Shivani autonomous-agent plan.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { resolveAuditLogPath, resolvePreambleDir } from '../../services/pipeline-orchestrator.mjs';

function withEnv(key, value, fn) {
  const orig = process.env[key];
  if (value === undefined) delete process.env[key]; else process.env[key] = value;
  try { return fn(); }
  finally {
    if (orig === undefined) delete process.env[key];
    else process.env[key] = orig;
  }
}

// ── AUDIT_LOG_PATH ──────────────────────────────────────────────────────────

test('resolveAuditLogPath: defaults to data/yash-resume-runs.log (Yash backward-compat)', () => {
  withEnv('AUDIT_LOG_PATH', undefined, () => {
    assert.equal(
      resolveAuditLogPath('/proj'),
      resolve('/proj', 'data/yash-resume-runs.log'),
    );
  });
});

test('resolveAuditLogPath: relative env value is resolved against projectRoot', () => {
  withEnv('AUDIT_LOG_PATH', 'data/shivani-resume-runs.log', () => {
    assert.equal(
      resolveAuditLogPath('/proj'),
      resolve('/proj', 'data/shivani-resume-runs.log'),
    );
  });
});

test('resolveAuditLogPath: absolute env value is taken as-is', () => {
  withEnv('AUDIT_LOG_PATH', '/var/log/career-ops/shivani.jsonl', () => {
    assert.equal(
      resolveAuditLogPath('/proj'),
      '/var/log/career-ops/shivani.jsonl',
    );
  });
});

test('resolveAuditLogPath: empty env value falls back to default', () => {
  withEnv('AUDIT_LOG_PATH', '', () => {
    assert.equal(
      resolveAuditLogPath('/proj'),
      resolve('/proj', 'data/yash-resume-runs.log'),
    );
  });
});

// ── PREAMBLE_DIR ────────────────────────────────────────────────────────────

test('resolvePreambleDir: defaults to ops/preambles (Yash backward-compat)', () => {
  withEnv('PREAMBLE_DIR', undefined, () => {
    assert.equal(
      resolvePreambleDir('/proj'),
      resolve('/proj', 'ops/preambles'),
    );
  });
});

test('resolvePreambleDir: relative env value is resolved against projectRoot', () => {
  withEnv('PREAMBLE_DIR', 'ops/shivani/preambles', () => {
    assert.equal(
      resolvePreambleDir('/proj'),
      resolve('/proj', 'ops/shivani/preambles'),
    );
  });
});

test('resolvePreambleDir: absolute env value is taken as-is', () => {
  withEnv('PREAMBLE_DIR', '/etc/shivani-pipeline/preambles', () => {
    assert.equal(
      resolvePreambleDir('/proj'),
      '/etc/shivani-pipeline/preambles',
    );
  });
});

test('resolvePreambleDir: empty env value falls back to default', () => {
  withEnv('PREAMBLE_DIR', '', () => {
    assert.equal(
      resolvePreambleDir('/proj'),
      resolve('/proj', 'ops/preambles'),
    );
  });
});

// ── renderPreamble integration: PREAMBLE_DIR override ───────────────────────

test('renderPreamble reads from PREAMBLE_DIR when set', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { renderPreamble } = await import('../../services/pipeline-orchestrator.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'orch-env-'));
  try {
    // Write the Yash default file with content X, and a Shivani file with content Y.
    mkdirSync(join(dir, 'ops/preambles'), { recursive: true });
    mkdirSync(join(dir, 'ops/shivani/preambles'), { recursive: true });
    writeFileSync(join(dir, 'ops/preambles/fresh-run.md'), 'YASH $URL');
    writeFileSync(join(dir, 'ops/shivani/preambles/fresh-run.md'), 'SHIVANI $URL');

    withEnv('PREAMBLE_DIR', undefined, () => {
      const body = renderPreamble({ projectRoot: dir, mode: 'fresh', vars: { URL: 'http://x' } });
      assert.match(body, /^YASH http:\/\/x$/);
    });
    withEnv('PREAMBLE_DIR', 'ops/shivani/preambles', () => {
      const body = renderPreamble({ projectRoot: dir, mode: 'fresh', vars: { URL: 'http://x' } });
      assert.match(body, /^SHIVANI http:\/\/x$/);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
