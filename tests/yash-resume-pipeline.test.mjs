import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { parseArgs } from '../yash-resume-pipeline.mjs';

const execFileP = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = resolve(ROOT, 'yash-resume-pipeline.mjs');

async function runScript(args) {
  try {
    const { stdout, stderr } = await execFileP('node', [SCRIPT, ...args], { cwd: ROOT });
    return { code: 0, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (e) {
    return { code: e.code ?? 1, stdout: (e.stdout ?? '').trim(), stderr: (e.stderr ?? '').trim() };
  }
}

test('dispatcher: no subcommand returns fail JSON with usage', async () => {
  const { code, stdout } = await runScript([]);
  assert.equal(code, 1);
  const obj = JSON.parse(stdout);
  assert.equal(obj.status, 'fail');
  assert.match(obj.error, /unknown subcommand|usage/i);
});

test('dispatcher: unknown subcommand returns fail JSON', async () => {
  const { code, stdout } = await runScript(['bogus-command']);
  assert.equal(code, 1);
  const obj = JSON.parse(stdout);
  assert.equal(obj.status, 'fail');
  assert.match(obj.error, /unknown subcommand: bogus-command/);
});

test('parseArgs: --key=value style returns { key: "value" }', () => {
  const result = parseArgs(['--key=value']);
  assert.deepEqual(result, { key: 'value' });
});

test('parseArgs: mixed = and space styles', () => {
  const result = parseArgs(['--name=John Doe', '--count', '5']);
  assert.deepEqual(result, { name: 'John Doe', count: '5' });
});

test('parseArgs: bare flag preceding = flag', () => {
  const result = parseArgs(['--flag', '--key=value']);
  assert.deepEqual(result, { flag: true, key: 'value' });
});
