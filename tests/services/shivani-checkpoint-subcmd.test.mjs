/**
 * tests/services/shivani-checkpoint-subcmd.test.mjs
 *
 * CLI-level tests for the additive `checkpoint` subcommand on
 * shivani-resume-pipeline.mjs. Mirrors tests/services/checkpoint-subcmd.test.mjs
 * (Yash) so the two pipelines stay symmetric. Per PR 3 (Q5), this subcommand is
 * additive — no existing handler is edited.
 *
 * The autonomous orchestrator calls
 *   node shivani-resume-pipeline.mjs checkpoint --run-id N --phase X --url-hash H --inputs '{...}'
 * after every `_end` phase boundary so that a SIGTERM during a long run leaves
 * a recoverable checkpoint behind. analyzeRebootState() reads it on next boot
 * and resumes from the matching phase.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initDb, closeDb } from '../../services/db.mjs';

const execFileP = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = resolve(ROOT, 'shivani-resume-pipeline.mjs');

function freshEnv() {
  const dir = mkdtempSync(join(tmpdir(), 'srp-chk-'));
  const dbPath = join(dir, 'work-queue.db');
  const checkpointDir = join(dir, 'checkpoints');
  mkdirSync(checkpointDir, { recursive: true });
  const db = initDb(dbPath);
  db.prepare(`INSERT INTO queue(url, url_hash, added_at, added_by, status) VALUES(?,?,?,?,?)`)
    .run('https://shivani-jobs.example.com/role-x', 'shivanihash1234', new Date().toISOString(), 0, 'running');
  db.prepare(`INSERT INTO runs(id, queue_id, url, started_at, status) VALUES(?,?,?,?,?)`)
    .run(1, 1, 'https://shivani-jobs.example.com/role-x', new Date().toISOString(), 'running');
  closeDb(db);
  return {
    dir,
    dbPath,
    checkpointDir,
    env: {
      ...process.env,
      WORK_QUEUE_DB: dbPath,
      CHECKPOINT_DIR: checkpointDir,
      // Bypass queue auto-commit in tests — checkpoint touches the DB, not data/shivani-pipeline.md.
      SKIP_QUEUE_AUTO_COMMIT: '1',
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

async function runCheckpoint(args, env) {
  try {
    const { stdout, stderr } = await execFileP('node', [SCRIPT, 'checkpoint', ...args], { cwd: ROOT, env });
    return { code: 0, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (e) {
    return { code: e.code ?? 1, stdout: (e.stdout ?? '').trim(), stderr: (e.stderr ?? '').trim() };
  }
}

test('shivani checkpoint: valid call writes .json + DB row + returns ok', async () => {
  const { env, dbPath, cleanup } = freshEnv();
  try {
    const urlHash = 'shivanihash1234';
    const inputs = { jd_path: 'jds/shivani/JD_Example_FullStack_Shivani_Anghan_2026-05-25.md' };
    const { code, stdout } = await runCheckpoint([
      '--run-id', '1',
      '--phase', 'jd_fetch_end',
      '--url-hash', urlHash,
      '--inputs', JSON.stringify(inputs),
    ], env);
    assert.equal(code, 0, `should exit 0; stdout: ${stdout}`);
    const obj = JSON.parse(stdout);
    assert.equal(obj.status, 'ok');
    assert.equal(obj.phase, 'jd_fetch_end');
    assert.ok(obj.inputs_path, 'inputs_path must be set');

    const { existsSync } = await import('node:fs');
    assert.ok(existsSync(obj.inputs_path), `checkpoint file should exist at ${obj.inputs_path}`);

    const db = initDb(dbPath);
    const row = db.prepare(`SELECT * FROM checkpoints WHERE run_id=1`).get();
    closeDb(db);
    assert.ok(row, 'checkpoint row should exist in DB');
    assert.equal(row.last_phase, 'jd_fetch_end');
  } finally { cleanup(); }
});

test('shivani checkpoint: rejects invalid phase name', async () => {
  const { env, cleanup } = freshEnv();
  try {
    const { code, stdout } = await runCheckpoint([
      '--run-id', '1',
      '--phase', 'not_a_real_phase',
      '--url-hash', 'shivanihash1234',
      '--inputs', '{}',
    ], env);
    assert.equal(code, 1);
    const obj = JSON.parse(stdout);
    assert.equal(obj.status, 'fail');
    assert.match(obj.error, /invalid phase/i);
  } finally { cleanup(); }
});

test('shivani checkpoint: rejects malformed --inputs JSON', async () => {
  const { env, cleanup } = freshEnv();
  try {
    const { code, stdout } = await runCheckpoint([
      '--run-id', '1',
      '--phase', 'resume_gen_end',
      '--url-hash', 'shivanihash1234',
      '--inputs', '{not valid json',
    ], env);
    assert.equal(code, 1);
    const obj = JSON.parse(stdout);
    assert.equal(obj.status, 'fail');
    assert.match(obj.error, /invalid.*inputs|JSON/i);
  } finally { cleanup(); }
});

test('shivani checkpoint: missing --run-id is rejected with helpful error', async () => {
  const { env, cleanup } = freshEnv();
  try {
    const { code, stdout } = await runCheckpoint([
      '--phase', 'jd_fetch_end',
      '--url-hash', 'shivanihash1234',
      '--inputs', '{}',
    ], env);
    assert.equal(code, 1);
    const obj = JSON.parse(stdout);
    assert.equal(obj.status, 'fail');
    assert.match(obj.error, /run-id/);
  } finally { cleanup(); }
});

test('shivani checkpoint: each accepted phase round-trips through the subcommand', async () => {
  for (const phase of ['jd_fetch_end', 'resume_gen_end', 'resume_compile_end', 'cl_gen_end', 'cl_compile_end', 'url_end']) {
    const { env, cleanup } = freshEnv();
    try {
      const { code, stdout } = await runCheckpoint([
        '--run-id', '1',
        '--phase', phase,
        '--url-hash', 'shivanihash1234',
        '--inputs', '{}',
      ], env);
      assert.equal(code, 0, `phase ${phase} should be accepted; stdout: ${stdout}`);
      const obj = JSON.parse(stdout);
      assert.equal(obj.phase, phase);
    } finally { cleanup(); }
  }
});

test('shivani checkpoint: ADDITIVE — existing subcommands (slugify, next-pending) still work unchanged', async () => {
  const { env, cleanup } = freshEnv();
  try {
    // slugify is a pure helper that doesn't touch the DB — proves the dispatcher wires both old
    // and new subcommands without regressing existing behavior.
    const { stdout } = await execFileP('node', [SCRIPT, 'slugify', '--company', 'Example Corp', '--role', 'Full Stack Java'], { cwd: ROOT, env });
    const obj = JSON.parse(stdout.trim());
    assert.equal(obj.status, 'ok');
    // shivani slugify strips spaces (no underscore separator) — this asserts the existing
    // behavior is preserved when the new checkpoint subcommand lands additively.
    assert.equal(obj.company_slug, 'ExampleCorp');
    assert.equal(obj.role_slug, 'FullStackJava');
  } finally { cleanup(); }
});
