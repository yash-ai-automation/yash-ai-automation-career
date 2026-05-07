import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { mkdtemp, rm, writeFile as writeFileTest, mkdir as mkdirTest } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs, slugify } from '../yash-resume-pipeline.mjs';

async function makeTempPipelineFile(content) {
  const dir = await mkdtemp(join(tmpdir(), 'yrp-test-'));
  await mkdirTest(join(dir, 'data'), { recursive: true });
  await writeFileTest(join(dir, 'data/pipeline.md'), content);
  return dir;
}

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

test('slugify CLI: missing --company flag returns fail', async () => {
  const { code, stdout } = await runScript(['slugify', '--role', 'Engineer']);
  assert.equal(code, 1);
  const obj = JSON.parse(stdout);
  assert.equal(obj.status, 'fail');
  assert.match(obj.error, /empty.*company.*slug/i);
});

test('next-pending: returns first `- [ ] <url>` line', async () => {
  const dir = await makeTempPipelineFile(`# Job Pipeline

## Pendientes

- [ ] https://jobs.lever.co/openai/abc-123
- [ ] https://boards.greenhouse.io/anthropic/jobs/4567

## Procesadas

- [x] https://done.example.com | Acme | PM | JD ✅ | Resume ✅ | Score 91/100
`);
  try {
    const { stdout } = await execFileP('node', [SCRIPT, 'next-pending'], { cwd: dir });
    const obj = JSON.parse(stdout.trim());
    assert.equal(obj.status, 'ok');
    assert.equal(obj.url, 'https://jobs.lever.co/openai/abc-123');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('next-pending: skips `- [!]` and `- [x]` lines', async () => {
  const dir = await makeTempPipelineFile(`## Pendientes

- [!] https://failed.example.com — reason: 404
- [x] https://done.example.com
- [ ] https://still-pending.example.com
`);
  try {
    const { stdout } = await execFileP('node', [SCRIPT, 'next-pending'], { cwd: dir });
    const obj = JSON.parse(stdout.trim());
    assert.equal(obj.url, 'https://still-pending.example.com');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('next-pending: empty queue returns status=empty', async () => {
  const dir = await makeTempPipelineFile(`## Pendientes

- [!] https://stuck.example.com — reason: auth required

## Procesadas

- [x] https://done.example.com
`);
  try {
    const { stdout } = await execFileP('node', [SCRIPT, 'next-pending'], { cwd: dir });
    const obj = JSON.parse(stdout.trim());
    assert.equal(obj.status, 'empty');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('next-pending: missing pipeline.md returns fail', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'yrp-test-'));
  try {
    let code = 0, stdout = '';
    try {
      const r = await execFileP('node', [SCRIPT, 'next-pending'], { cwd: dir });
      stdout = r.stdout.trim();
    } catch (e) {
      code = e.code ?? 1;
      stdout = (e.stdout ?? '').trim();
    }
    assert.equal(code, 1);
    const obj = JSON.parse(stdout);
    assert.equal(obj.status, 'fail');
    assert.match(obj.error, /pipeline\.md/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
