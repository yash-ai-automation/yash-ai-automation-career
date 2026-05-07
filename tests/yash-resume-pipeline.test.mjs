import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { parseArgs, slugify } from '../yash-resume-pipeline.mjs';

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

test('slugify: simple two-word company', () => {
  assert.equal(slugify('Anthropic, PBC'), 'AnthropicPbc');
});

test('slugify: complex role with slashes and parens', () => {
  assert.equal(slugify('Senior AI/ML Engineer (Remote)'), 'SeniorAiMlEngineer');
});

test('slugify: hyphenated lowercase', () => {
  assert.equal(slugify('Open-AI'), 'OpenAi');
});

test('slugify: single-letter all-caps tokens stay capitalized', () => {
  assert.equal(slugify('M&A Research Lead'), 'MAResearchLead');
});

test('slugify: collapses runs of whitespace', () => {
  assert.equal(slugify('   spaces   here   '), 'SpacesHere');
});

test('slugify: leading number preserved', () => {
  assert.equal(slugify('42 Watt Studios'), '42WattStudios');
});

test('slugify: emoji and unicode stripped as non-alnum', () => {
  assert.equal(slugify('🦾 Robotics Inc'), 'RoboticsInc');
});

test('slugify: empty string returns empty', () => {
  assert.equal(slugify(''), '');
});

test('slugify CLI: returns ok JSON with company_slug, role_slug, date', async () => {
  const { code, stdout } = await runScript([
    'slugify',
    '--company', 'Anthropic, PBC',
    '--role', 'Senior AI/ML Engineer (Remote)',
  ]);
  assert.equal(code, 0);
  const obj = JSON.parse(stdout);
  assert.equal(obj.status, 'ok');
  assert.equal(obj.company_slug, 'AnthropicPbc');
  assert.equal(obj.role_slug, 'SeniorAiMlEngineer');
  assert.match(obj.date, /^\d{4}-\d{2}-\d{2}$/);
});

test('slugify CLI: empty company returns fail', async () => {
  const { code, stdout } = await runScript([
    'slugify', '--company', '   ', '--role', 'Engineer',
  ]);
  assert.equal(code, 1);
  const obj = JSON.parse(stdout);
  assert.equal(obj.status, 'fail');
  assert.match(obj.error, /empty.*company.*slug/i);
});
