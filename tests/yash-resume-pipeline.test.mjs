import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { mkdtemp, rm, writeFile as writeFileTest, mkdir as mkdirTest, readFile as readFileTest } from 'node:fs/promises';
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

test('next-pending: handles Windows \\r\\n line endings', async () => {
  const content = `## Pendientes\r\n\r\n- [ ] https://crlf.example.com\r\n`;
  const dir = await makeTempPipelineFile(content);
  try {
    const { stdout } = await execFileP('node', [SCRIPT, 'next-pending'], { cwd: dir });
    const obj = JSON.parse(stdout.trim());
    assert.equal(obj.status, 'ok');
    assert.equal(obj.url, 'https://crlf.example.com');  // no trailing \r
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('check-duplicate: neither file exists → exists=false', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'yrp-test-'));
  await mkdirTest(join(dir, 'jds'), { recursive: true });
  await mkdirTest(join(dir, 'resumes'), { recursive: true });
  try {
    const { stdout } = await execFileP('node', [SCRIPT,
      'check-duplicate',
      '--company-slug', 'AcmeInc',
      '--role-slug', 'Engineer',
      '--date', '2026-05-07',
    ], { cwd: dir });
    const obj = JSON.parse(stdout.trim());
    assert.equal(obj.status, 'ok');
    assert.equal(obj.exists, false);
    assert.equal(obj.jd_path, 'jds/JD_AcmeInc_Engineer_Yash_Anghan_2026-05-07.md');
    assert.equal(obj.pdf_path, 'resumes/AcmeInc_Engineer_Yash_Anghan_Resume_2026-05-07.pdf');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('check-duplicate: only JD exists → exists=true, which=[jd]', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'yrp-test-'));
  await mkdirTest(join(dir, 'jds'), { recursive: true });
  await mkdirTest(join(dir, 'resumes'), { recursive: true });
  await writeFileTest(join(dir, 'jds/JD_AcmeInc_Engineer_Yash_Anghan_2026-05-07.md'), 'x');
  try {
    const { stdout } = await execFileP('node', [SCRIPT,
      'check-duplicate',
      '--company-slug', 'AcmeInc',
      '--role-slug', 'Engineer',
      '--date', '2026-05-07',
    ], { cwd: dir });
    const obj = JSON.parse(stdout.trim());
    assert.equal(obj.exists, true);
    assert.deepEqual(obj.which, ['jd']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('check-duplicate: both exist → exists=true, which=[jd,pdf]', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'yrp-test-'));
  await mkdirTest(join(dir, 'jds'), { recursive: true });
  await mkdirTest(join(dir, 'resumes'), { recursive: true });
  await writeFileTest(join(dir, 'jds/JD_AcmeInc_Engineer_Yash_Anghan_2026-05-07.md'), 'x');
  await writeFileTest(join(dir, 'resumes/AcmeInc_Engineer_Yash_Anghan_Resume_2026-05-07.pdf'), 'x');
  try {
    const { stdout } = await execFileP('node', [SCRIPT,
      'check-duplicate',
      '--company-slug', 'AcmeInc',
      '--role-slug', 'Engineer',
      '--date', '2026-05-07',
    ], { cwd: dir });
    const obj = JSON.parse(stdout.trim());
    assert.equal(obj.exists, true);
    assert.deepEqual(obj.which.sort(), ['jd', 'pdf']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('check-duplicate: PDF-only exists → exists=true, which=[pdf]', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'yrp-test-'));
  await mkdirTest(join(dir, 'jds'), { recursive: true });
  await mkdirTest(join(dir, 'resumes'), { recursive: true });
  await writeFileTest(join(dir, 'resumes/AcmeInc_Engineer_Yash_Anghan_Resume_2026-05-07.pdf'), 'x');
  try {
    const { stdout } = await execFileP('node', [SCRIPT,
      'check-duplicate',
      '--company-slug', 'AcmeInc',
      '--role-slug', 'Engineer',
      '--date', '2026-05-07',
    ], { cwd: dir });
    const obj = JSON.parse(stdout.trim());
    assert.equal(obj.exists, true);
    assert.deepEqual(obj.which, ['pdf']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('check-duplicate: directory at JD path is NOT treated as JD existing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'yrp-test-'));
  await mkdirTest(join(dir, 'jds'), { recursive: true });
  await mkdirTest(join(dir, 'resumes'), { recursive: true });
  // Create a directory (not a file) at the expected JD path
  await mkdirTest(join(dir, 'jds/JD_AcmeInc_Engineer_Yash_Anghan_2026-05-07.md'), { recursive: true });
  try {
    const { stdout } = await execFileP('node', [SCRIPT,
      'check-duplicate',
      '--company-slug', 'AcmeInc',
      '--role-slug', 'Engineer',
      '--date', '2026-05-07',
    ], { cwd: dir });
    const obj = JSON.parse(stdout.trim());
    assert.equal(obj.exists, false);
    assert.deepEqual(obj.which, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('mark-processed: moves URL from Pendientes to Procesadas with metadata', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'yrp-test-'));
  await mkdirTest(join(dir, 'data'), { recursive: true });
  await writeFileTest(join(dir, 'data/pipeline.md'), `# Job Pipeline

## Pendientes

- [ ] https://jobs.lever.co/openai/abc-123

## Procesadas

`);
  try {
    await execFileP('node', [SCRIPT,
      'mark-processed',
      '--url', 'https://jobs.lever.co/openai/abc-123',
      '--company', 'OpenAI',
      '--role', 'AI Engineer',
      '--jd', 'jds/JD_Openai_AiEngineer_Yash_Anghan_2026-05-07.md',
      '--pdf', 'resumes/Openai_AiEngineer_Yash_Anghan_Resume_2026-05-07.pdf',
      '--score', '92',
    ], { cwd: dir });
    const result = await readFileTest(join(dir, 'data/pipeline.md'), 'utf-8');
    assert.doesNotMatch(result, /- \[ \] https:\/\/jobs\.lever\.co\/openai\/abc-123/);
    assert.match(result, /- \[x\] https:\/\/jobs\.lever\.co\/openai\/abc-123 \| OpenAI \| AI Engineer \| JD ✅ \| Resume ✅ \| Score 92\/100/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('mark-processed: idempotent — running twice does not duplicate', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'yrp-test-'));
  await mkdirTest(join(dir, 'data'), { recursive: true });
  await writeFileTest(join(dir, 'data/pipeline.md'), `## Pendientes

- [ ] https://x.com/job

## Procesadas

`);
  const args = ['mark-processed', '--url', 'https://x.com/job', '--company', 'X', '--role', 'Eng', '--jd', 'a', '--pdf', 'b', '--score', '90'];
  try {
    await execFileP('node', [SCRIPT, ...args], { cwd: dir });
    await execFileP('node', [SCRIPT, ...args], { cwd: dir });
    const result = await readFileTest(join(dir, 'data/pipeline.md'), 'utf-8');
    const occurrences = (result.match(/https:\/\/x\.com\/job/g) || []).length;
    assert.equal(occurrences, 1, 'URL should appear exactly once after two mark-processed calls');
    const sections = result.split(/^## /m);
    const procesadas = sections.find((s) => s.startsWith('Procesadas')) ?? '';
    const pendientes = sections.find((s) => s.startsWith('Pendientes')) ?? '';
    assert.match(procesadas, /https:\/\/x\.com\/job/, 'URL must be in Procesadas');
    assert.doesNotMatch(pendientes, /https:\/\/x\.com\/job/, 'URL must not still be in Pendientes');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('mark-processed: rejects non-integer score', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'yrp-test-'));
  await mkdirTest(join(dir, 'data'), { recursive: true });
  await writeFileTest(join(dir, 'data/pipeline.md'), `## Pendientes\n\n- [ ] https://x.com/job\n\n## Procesadas\n\n`);
  try {
    let code = 0, stdout = '';
    try {
      const r = await execFileP('node', [SCRIPT, 'mark-processed',
        '--url', 'https://x.com/job', '--company', 'X', '--role', 'Eng',
        '--jd', 'a', '--pdf', 'b', '--score', 'abc'], { cwd: dir });
      stdout = r.stdout.trim();
    } catch (e) {
      code = e.code ?? 1;
      stdout = (e.stdout ?? '').trim();
    }
    assert.equal(code, 1);
    const obj = JSON.parse(stdout);
    assert.equal(obj.status, 'fail');
    assert.match(obj.error, /score must be a non-negative integer/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('mark-failed: changes [ ] to [!] with reason in Pendientes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'yrp-test-'));
  await mkdirTest(join(dir, 'data'), { recursive: true });
  await writeFileTest(join(dir, 'data/pipeline.md'), `## Pendientes\n\n- [ ] https://dead.example.com\n\n## Procesadas\n\n`);
  try {
    await execFileP('node', [SCRIPT,
      'mark-failed',
      '--url', 'https://dead.example.com',
      '--reason', '404 Not Found',
    ], { cwd: dir });
    const result = await readFileTest(join(dir, 'data/pipeline.md'), 'utf-8');
    assert.match(result, /- \[!\] https:\/\/dead\.example\.com — reason: 404 Not Found/);
    assert.doesNotMatch(result, /- \[ \] https:\/\/dead\.example\.com/);
    // verify it's in Pendientes, not Procesadas
    const sections = result.split(/^## /m);
    const pendientes = sections.find((s) => s.startsWith('Pendientes')) ?? '';
    const procesadas = sections.find((s) => s.startsWith('Procesadas')) ?? '';
    assert.match(pendientes, /dead\.example\.com/);
    assert.doesNotMatch(procesadas, /dead\.example\.com/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('mark-skipped: moves URL to Procesadas with [~] and skipped reason', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'yrp-test-'));
  await mkdirTest(join(dir, 'data'), { recursive: true });
  await writeFileTest(join(dir, 'data/pipeline.md'), `## Pendientes\n\n- [ ] https://dup.example.com\n\n## Procesadas\n\n`);
  try {
    await execFileP('node', [SCRIPT,
      'mark-skipped',
      '--url', 'https://dup.example.com',
      '--reason', 'duplicate (jd+pdf already exist)',
    ], { cwd: dir });
    const result = await readFileTest(join(dir, 'data/pipeline.md'), 'utf-8');
    assert.match(result, /- \[~\] https:\/\/dup\.example\.com — skipped: duplicate \(jd\+pdf already exist\)/);
    assert.doesNotMatch(result, /- \[ \] https:\/\/dup\.example\.com/);
    // verify it's in Procesadas, not Pendientes
    const sections = result.split(/^## /m);
    const pendientes = sections.find((s) => s.startsWith('Pendientes')) ?? '';
    const procesadas = sections.find((s) => s.startsWith('Procesadas')) ?? '';
    assert.match(procesadas, /dup\.example\.com/);
    assert.doesNotMatch(pendientes, /dup\.example\.com/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('mark-failed: replaces existing [!] reason in place (idempotent on URL)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'yrp-test-'));
  await mkdirTest(join(dir, 'data'), { recursive: true });
  await writeFileTest(join(dir, 'data/pipeline.md'), `## Pendientes\n\n- [!] https://x.com/job — reason: old reason\n\n## Procesadas\n\n`);
  try {
    await execFileP('node', [SCRIPT,
      'mark-failed', '--url', 'https://x.com/job', '--reason', 'new reason',
    ], { cwd: dir });
    const result = await readFileTest(join(dir, 'data/pipeline.md'), 'utf-8');
    const occurrences = (result.match(/https:\/\/x\.com\/job/g) || []).length;
    assert.equal(occurrences, 1);
    assert.match(result, /reason: new reason/);
    assert.doesNotMatch(result, /old reason/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
