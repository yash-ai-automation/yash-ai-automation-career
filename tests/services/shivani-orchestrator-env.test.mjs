// tests/services/shivani-orchestrator-env.test.mjs
// Plan §8.1 — explicit Shivani-tenant coverage for the env-driven resolvers
// added in PR 1. Demonstrates that with the Shivani env block applied, the
// orchestrator selects the Shivani audit log + Shivani preamble dir while
// Yash defaults remain reachable when env is cleared.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveAuditLogPath, resolvePreambleDir, renderPreamble } from '../../services/pipeline-orchestrator.mjs';

function withEnvBlock(block, fn) {
  const restore = {};
  for (const k of Object.keys(block)) {
    restore[k] = process.env[k];
    if (block[k] === undefined) delete process.env[k];
    else process.env[k] = block[k];
  }
  try { return fn(); }
  finally {
    for (const k of Object.keys(restore)) {
      if (restore[k] === undefined) delete process.env[k];
      else process.env[k] = restore[k];
    }
  }
}

const SHIVANI_ENV = {
  AUDIT_LOG_PATH: 'data/shivani-resume-runs.log',
  PREAMBLE_DIR: 'ops/shivani/preambles',
  TENANT: 'shivani',
  TENANT_LABEL: 'shivani-pipeline',
  TENANT_TRACE_NAME: 'shivani-resume-pipeline',
  TMP_CLEANUP_GLOB: '/tmp/shivani-pipeline-*',
};

test('Shivani env block: AUDIT_LOG_PATH points at the Shivani audit log under the project root', () => {
  withEnvBlock(SHIVANI_ENV, () => {
    assert.equal(
      resolveAuditLogPath('/yash-superClaudeHuman/projects/yash-ai-automation-career'),
      resolve('/yash-superClaudeHuman/projects/yash-ai-automation-career', 'data/shivani-resume-runs.log'),
    );
  });
});

test('Shivani env block: PREAMBLE_DIR points at ops/shivani/preambles under the project root', () => {
  withEnvBlock(SHIVANI_ENV, () => {
    assert.equal(
      resolvePreambleDir('/yash-superClaudeHuman/projects/yash-ai-automation-career'),
      resolve('/yash-superClaudeHuman/projects/yash-ai-automation-career', 'ops/shivani/preambles'),
    );
  });
});

test('renderPreamble: with PREAMBLE_DIR=ops/shivani/preambles, picks the Shivani fresh-run template', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shivani-env-'));
  try {
    mkdirSync(join(dir, 'ops/preambles'), { recursive: true });
    mkdirSync(join(dir, 'ops/shivani/preambles'), { recursive: true });
    writeFileSync(join(dir, 'ops/preambles/fresh-run.md'), 'YASH preamble for $URL');
    writeFileSync(join(dir, 'ops/shivani/preambles/fresh-run.md'), 'SHIVANI preamble for $URL');

    withEnvBlock(SHIVANI_ENV, () => {
      const body = renderPreamble({ projectRoot: dir, mode: 'fresh', vars: { URL: 'http://x' } });
      assert.equal(body, 'SHIVANI preamble for http://x');
    });
    // Cleared env restores Yash default.
    withEnvBlock({ AUDIT_LOG_PATH: undefined, PREAMBLE_DIR: undefined }, () => {
      const body = renderPreamble({ projectRoot: dir, mode: 'fresh', vars: { URL: 'http://x' } });
      assert.equal(body, 'YASH preamble for http://x');
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Yash defaults still reachable when Shivani env is cleared (cross-tenant guard)', () => {
  withEnvBlock({ AUDIT_LOG_PATH: undefined, PREAMBLE_DIR: undefined }, () => {
    assert.equal(
      resolveAuditLogPath('/p'),
      resolve('/p', 'data/yash-resume-runs.log'),
    );
    assert.equal(
      resolvePreambleDir('/p'),
      resolve('/p', 'ops/preambles'),
    );
  });
});
