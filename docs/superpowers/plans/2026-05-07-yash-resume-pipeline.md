# Yash Resume Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a slash-command pipeline (`/yash-resume-pipeline`) that drains URLs from `data/pipeline.md` one at a time, extracts each JD via Playwright into `jds/JD_<slug>_<date>.md`, applies the existing V2.0 resume-optimization prompt, and compiles a tailored LaTeX resume to `resumes/<slug>_<date>.pdf` via Tectonic.

**Architecture:** Hybrid — `modes/yash-resume-pipeline.md` drives the interactive loop (LLM-shaped work), `yash-resume-pipeline.mjs` owns deterministic operations (slugify, dedup, atomic mutations of `data/pipeline.md`, log appends, Tectonic invocation). The existing `generate-pdf-latex.mjs` and `resume-optimization-system-based-on-job-description.md` are used unchanged.

**Tech Stack:** Node.js v22 (ESM, `node:test`, `node:assert/strict`), Playwright CLI v0.1.7, Tectonic, Markdown.

**Spec:** `docs/superpowers/specs/2026-05-07-yash-resume-pipeline-design.md` (locked in during brainstorming).

**Note on commits:** This plan ends each task with a commit step. If user preference is to defer commits, batch them at logical milestones (after Tasks 5, 9, 12, 15). Always ask the user before pushing.

---

## File structure

**New files:**

| Path | Responsibility |
|---|---|
| `yash-resume-pipeline.mjs` | Deterministic orchestrator. Subcommands: `next-pending`, `slugify`, `check-duplicate`, `mark-processed`, `mark-failed`, `mark-skipped`, `log`, `compile-resume`. Importable for unit tests. |
| `tests/yash-resume-pipeline.test.mjs` | Unit tests using `node:test`. Imports pure functions (slugify, parsers) directly; spawns the script for CLI behavior tests. |
| `tests/test-yash-pipeline-smoke.mjs` | End-to-end smoke test. Drives the orchestrator against fixture HTML JD pages and a fixture LaTeX file. |
| `tests/fixtures/jds/lever-sample.html` | Saved Lever JD page (sanitized). |
| `tests/fixtures/jds/ashby-sample.html` | Saved Ashby JD page (sanitized). |
| `tests/fixtures/jds/greenhouse-sample.html` | Saved Greenhouse JD page (sanitized). |
| `tests/fixtures/sample-good.tex` | Minimal valid LaTeX for `compile-resume` happy path. |
| `tests/fixtures/sample-bad.tex` | Deliberately broken LaTeX for `compile-resume` failure path. |
| `modes/yash-resume-pipeline.md` | Mode prompt — interactive loop, hard rules, V2.0 output parsing. |
| `.claude/commands/yash-resume-pipeline.md` | Two-line slash-command shim. |

**Modified files:**

| Path | Change |
|---|---|
| `test-all.mjs` | Add a single `run('node', ['--test', 'tests/'])` call in the syntax/test section so existing PR gate covers the new tests. |
| `AGENTS.md` | Add one paragraph in the "Skill Modes" table describing `yash-resume-pipeline`. |
| `data/pipeline.md` | Will be mutated by orchestrator at runtime (no static change). |

**Auto-created at runtime:**

| Path | When |
|---|---|
| `data/yash-resume-runs.log` | First `log` subcommand call. Created with `mkdir -p` parent + append. |
| `jds/JD_*.md` | Per successful URL. |
| `resumes/<slug>_*.{tex,pdf,log}` | Per successful URL. |

---

## Task 1: Scaffold orchestrator with dispatcher and helpers

**Files:**
- Create: `yash-resume-pipeline.mjs`
- Create: `tests/yash-resume-pipeline.test.mjs`

- [ ] **Step 1: Create `tests/` directory**

```bash
mkdir -p /yash-superClaudeHuman/projects/yash-ai-automation-career/tests/fixtures/jds
```

- [ ] **Step 2: Write the failing test for the dispatcher**

Create `tests/yash-resume-pipeline.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

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
```

- [ ] **Step 3: Run test to confirm failure**

```bash
cd /yash-superClaudeHuman/projects/yash-ai-automation-career
node --test tests/yash-resume-pipeline.test.mjs
```

Expected: both tests fail with `Error: ENOENT: no such file or directory, open '.../yash-resume-pipeline.mjs'`.

- [ ] **Step 4: Implement the scaffold**

Create `yash-resume-pipeline.mjs`:

```js
#!/usr/bin/env node
/**
 * yash-resume-pipeline.mjs — deterministic orchestrator for /yash-resume-pipeline mode.
 *
 * Subcommands print one JSON object to stdout, exit 0 on ok, non-zero on fail.
 * Importable: pure functions (slugify, parsers) are exported for unit tests.
 */

import { readFile, writeFile, rename, stat, appendFile, mkdir } from 'node:fs/promises';
import { dirname, resolve, basename } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileP = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)));
const PIPELINE_PATH = resolve(ROOT, 'data/pipeline.md');
const RUNS_LOG_PATH = resolve(ROOT, 'data/yash-resume-runs.log');
const JDS_DIR = resolve(ROOT, 'jds');
const RESUMES_DIR = resolve(ROOT, 'resumes');
const PDF_GENERATOR = resolve(ROOT, 'generate-pdf-latex.mjs');

// === Output helpers ===
export function ok(payload = {}) {
  process.stdout.write(JSON.stringify({ status: 'ok', ...payload }) + '\n');
  process.exit(0);
}
export function fail(error, extra = {}) {
  process.stdout.write(JSON.stringify({ status: 'fail', error, ...extra }) + '\n');
  process.exit(1);
}
export function emptyOk() {
  process.stdout.write(JSON.stringify({ status: 'empty' }) + '\n');
  process.exit(0);
}

// === Arg parsing: --flag value pairs ===
export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

// === Subcommand stubs (filled in subsequent tasks) ===
const SUBCOMMANDS = {
  // populated as we go
};

// === Dispatcher (CLI mode only) ===
async function main() {
  const subcommand = process.argv[2];
  if (!subcommand) {
    fail('unknown subcommand: <none>. usage: node yash-resume-pipeline.mjs <subcommand> [--flags]');
  }
  const handler = SUBCOMMANDS[subcommand];
  if (!handler) {
    fail(`unknown subcommand: ${subcommand}`);
  }
  const args = parseArgs(process.argv.slice(3));
  await handler(args);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => fail(`unexpected: ${e.message}`));
}
```

- [ ] **Step 5: Run test to confirm pass**

```bash
cd /yash-superClaudeHuman/projects/yash-ai-automation-career
node --test tests/yash-resume-pipeline.test.mjs
```

Expected: both tests pass. `# tests 2`, `# pass 2`, `# fail 0`.

- [ ] **Step 6: Commit**

```bash
git add yash-resume-pipeline.mjs tests/yash-resume-pipeline.test.mjs
git commit -m "feat(yash-resume): scaffold orchestrator script with dispatcher"
```

---

## Task 2: Implement `slugify` subcommand

**Files:**
- Modify: `yash-resume-pipeline.mjs` (add `slugify` function and subcommand handler)
- Modify: `tests/yash-resume-pipeline.test.mjs` (add slugify tests)

- [ ] **Step 1: Write the failing tests**

Append to `tests/yash-resume-pipeline.test.mjs`:

```js
import { slugify } from '../yash-resume-pipeline.mjs';

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
```

- [ ] **Step 2: Run tests to confirm failure**

```bash
node --test tests/yash-resume-pipeline.test.mjs
```

Expected: 10 new tests fail with `slugify is not a function` or similar.

- [ ] **Step 3: Implement `slugify` and the subcommand**

In `yash-resume-pipeline.mjs`, add after `parseArgs`:

```js
// === Slugify ===
export function slugify(input) {
  if (typeof input !== 'string') return '';
  // Step 1: replace runs of non-alnum with single space
  const cleaned = input.replace(/[^a-zA-Z0-9]+/g, ' ').trim();
  if (!cleaned) return '';
  // Step 2-5: tokenize, capitalize, concat
  return cleaned.split(/\s+/).map((token) => {
    if (token.length === 0) return '';
    if (token.length >= 2 && token === token.toUpperCase() && /[A-Z]/.test(token)) {
      // all-caps token of length >= 2: title-case it (AI -> Ai, ML -> Ml)
      return token[0] + token.slice(1).toLowerCase();
    }
    // single-letter or mixed-case: capitalize first, lowercase rest only if not already mixed
    if (token.length === 1) return token.toUpperCase();
    return token[0].toUpperCase() + token.slice(1).toLowerCase();
  }).join('');
}

export function dateToday() {
  return new Date().toISOString().slice(0, 10);
}
```

Then add the subcommand to `SUBCOMMANDS`:

```js
SUBCOMMANDS['slugify'] = async (args) => {
  const company = args.company ?? '';
  const role = args.role ?? '';
  const company_slug = slugify(company);
  const role_slug = slugify(role);
  if (!company_slug) fail('empty company slug after normalization');
  if (!role_slug) fail('empty role slug after normalization');
  ok({ company_slug, role_slug, date: dateToday() });
};
```

- [ ] **Step 4: Run tests to confirm pass**

```bash
node --test tests/yash-resume-pipeline.test.mjs
```

Expected: all 12 tests pass.

- [ ] **Step 5: Commit**

```bash
git add yash-resume-pipeline.mjs tests/yash-resume-pipeline.test.mjs
git commit -m "feat(yash-resume): slugify subcommand with full edge-case tests"
```

---

## Task 3: Implement `next-pending` subcommand

**Files:**
- Modify: `yash-resume-pipeline.mjs`
- Modify: `tests/yash-resume-pipeline.test.mjs`

- [ ] **Step 1: Write the failing tests**

Append to `tests/yash-resume-pipeline.test.mjs`:

```js
import { mkdtemp, rm, writeFile as writeFileTest, mkdir as mkdirTest } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function makeTempPipelineFile(content) {
  const dir = await mkdtemp(join(tmpdir(), 'yrp-test-'));
  await mkdirTest(join(dir, 'data'), { recursive: true });
  await writeFileTest(join(dir, 'data/pipeline.md'), content);
  return dir;
}

async function runScriptInDir(dir, args) {
  try {
    const { stdout, stderr } = await execFileP('node', [SCRIPT, ...args], { cwd: dir });
    return { code: 0, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (e) {
    return { code: e.code ?? 1, stdout: (e.stdout ?? '').trim(), stderr: (e.stderr ?? '').trim() };
  }
}
```

Then the actual tests (still in the same file):

```js
test('next-pending: returns first `- [ ] <url>` line', async () => {
  const dir = await makeTempPipelineFile(`# Job Pipeline

## Pendientes

- [ ] https://jobs.lever.co/openai/abc-123
- [ ] https://boards.greenhouse.io/anthropic/jobs/4567

## Procesadas

- [x] https://done.example.com | Acme | PM | JD ✅ | Resume ✅ | Score 91/100
`);
  // copy script into temp dir
  const { code, stdout } = await execFileP('node', [SCRIPT, 'next-pending'], { cwd: dir })
    .then((r) => ({ code: 0, stdout: r.stdout.trim() }))
    .catch((e) => ({ code: e.code ?? 1, stdout: (e.stdout ?? '').trim() }));
  assert.equal(code, 0);
  const obj = JSON.parse(stdout);
  assert.equal(obj.status, 'ok');
  assert.equal(obj.url, 'https://jobs.lever.co/openai/abc-123');
  await rm(dir, { recursive: true, force: true });
});

test('next-pending: skips `- [!]` and `- [x]` lines', async () => {
  const dir = await makeTempPipelineFile(`## Pendientes

- [!] https://failed.example.com — reason: 404
- [x] https://done.example.com
- [ ] https://still-pending.example.com
`);
  const { stdout } = await execFileP('node', [SCRIPT, 'next-pending'], { cwd: dir });
  const obj = JSON.parse(stdout.trim());
  assert.equal(obj.url, 'https://still-pending.example.com');
  await rm(dir, { recursive: true, force: true });
});

test('next-pending: empty queue returns status=empty', async () => {
  const dir = await makeTempPipelineFile(`## Pendientes

- [!] https://stuck.example.com — reason: auth required

## Procesadas

- [x] https://done.example.com
`);
  const { stdout } = await execFileP('node', [SCRIPT, 'next-pending'], { cwd: dir });
  const obj = JSON.parse(stdout.trim());
  assert.equal(obj.status, 'empty');
  await rm(dir, { recursive: true, force: true });
});

test('next-pending: missing pipeline.md returns fail', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'yrp-test-'));
  const { code, stdout } = await execFileP('node', [SCRIPT, 'next-pending'], { cwd: dir })
    .then((r) => ({ code: 0, stdout: r.stdout.trim() }))
    .catch((e) => ({ code: e.code ?? 1, stdout: (e.stdout ?? '').trim() }));
  assert.equal(code, 1);
  const obj = JSON.parse(stdout);
  assert.equal(obj.status, 'fail');
  assert.match(obj.error, /pipeline\.md/);
  await rm(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run tests to confirm failure**

```bash
node --test tests/yash-resume-pipeline.test.mjs
```

Expected: 4 new `next-pending` tests fail.

- [ ] **Step 3: Implement the subcommand**

In `yash-resume-pipeline.mjs`, add helper near top:

```js
// === Pipeline.md helpers ===
async function readPipeline() {
  try {
    return await readFile(PIPELINE_PATH, 'utf-8');
  } catch (e) {
    if (e.code === 'ENOENT') fail(`pipeline.md not found at ${PIPELINE_PATH}`);
    fail(`failed to read pipeline.md: ${e.message}`);
  }
}

export function findFirstPending(content) {
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^- \[ \] (\S+)/);
    if (m) return { url: m[1], line_number: i + 1 };
  }
  return null;
}
```

Then add subcommand:

```js
SUBCOMMANDS['next-pending'] = async () => {
  const content = await readPipeline();
  const next = findFirstPending(content);
  if (!next) emptyOk();
  ok(next);
};
```

- [ ] **Step 4: Run tests to confirm pass**

```bash
node --test tests/yash-resume-pipeline.test.mjs
```

Expected: all tests pass (16 total now).

- [ ] **Step 5: Commit**

```bash
git add yash-resume-pipeline.mjs tests/yash-resume-pipeline.test.mjs
git commit -m "feat(yash-resume): next-pending subcommand reads pipeline.md inbox"
```

---

## Task 4: Implement `check-duplicate` subcommand

**Files:**
- Modify: `yash-resume-pipeline.mjs`
- Modify: `tests/yash-resume-pipeline.test.mjs`

- [ ] **Step 1: Write the failing tests**

Append to `tests/yash-resume-pipeline.test.mjs`:

```js
test('check-duplicate: neither file exists → exists=false', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'yrp-test-'));
  await mkdirTest(join(dir, 'jds'), { recursive: true });
  await mkdirTest(join(dir, 'resumes'), { recursive: true });
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
  await rm(dir, { recursive: true, force: true });
});

test('check-duplicate: only JD exists → exists=true, which=[jd]', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'yrp-test-'));
  await mkdirTest(join(dir, 'jds'), { recursive: true });
  await mkdirTest(join(dir, 'resumes'), { recursive: true });
  await writeFileTest(join(dir, 'jds/JD_AcmeInc_Engineer_Yash_Anghan_2026-05-07.md'), 'x');
  const { stdout } = await execFileP('node', [SCRIPT,
    'check-duplicate',
    '--company-slug', 'AcmeInc',
    '--role-slug', 'Engineer',
    '--date', '2026-05-07',
  ], { cwd: dir });
  const obj = JSON.parse(stdout.trim());
  assert.equal(obj.exists, true);
  assert.deepEqual(obj.which, ['jd']);
  await rm(dir, { recursive: true, force: true });
});

test('check-duplicate: both exist → exists=true, which=[jd,pdf]', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'yrp-test-'));
  await mkdirTest(join(dir, 'jds'), { recursive: true });
  await mkdirTest(join(dir, 'resumes'), { recursive: true });
  await writeFileTest(join(dir, 'jds/JD_AcmeInc_Engineer_Yash_Anghan_2026-05-07.md'), 'x');
  await writeFileTest(join(dir, 'resumes/AcmeInc_Engineer_Yash_Anghan_Resume_2026-05-07.pdf'), 'x');
  const { stdout } = await execFileP('node', [SCRIPT,
    'check-duplicate',
    '--company-slug', 'AcmeInc',
    '--role-slug', 'Engineer',
    '--date', '2026-05-07',
  ], { cwd: dir });
  const obj = JSON.parse(stdout.trim());
  assert.equal(obj.exists, true);
  assert.deepEqual(obj.which.sort(), ['jd', 'pdf']);
  await rm(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run tests to confirm failure**

```bash
node --test tests/yash-resume-pipeline.test.mjs
```

Expected: 3 new tests fail.

- [ ] **Step 3: Implement the subcommand**

In `yash-resume-pipeline.mjs`, add:

```js
async function fileExists(p) {
  try { await stat(p); return true; } catch { return false; }
}

export function buildJdPath(company_slug, role_slug, date) {
  return `jds/JD_${company_slug}_${role_slug}_Yash_Anghan_${date}.md`;
}
export function buildPdfPath(company_slug, role_slug, date) {
  return `resumes/${company_slug}_${role_slug}_Yash_Anghan_Resume_${date}.pdf`;
}
export function buildTexPath(company_slug, role_slug, date) {
  return `resumes/${company_slug}_${role_slug}_Yash_Anghan_Resume_${date}.tex`;
}
export function buildSidecarLogPath(company_slug, role_slug, date) {
  return `resumes/${company_slug}_${role_slug}_Yash_Anghan_Resume_${date}.log`;
}

SUBCOMMANDS['check-duplicate'] = async (args) => {
  const cs = args['company-slug'];
  const rs = args['role-slug'];
  const date = args.date;
  if (!cs || !rs || !date) fail('check-duplicate requires --company-slug, --role-slug, --date');
  const jd_rel = buildJdPath(cs, rs, date);
  const pdf_rel = buildPdfPath(cs, rs, date);
  const jd_abs = resolve(ROOT, jd_rel);
  const pdf_abs = resolve(ROOT, pdf_rel);
  const which = [];
  if (await fileExists(jd_abs)) which.push('jd');
  if (await fileExists(pdf_abs)) which.push('pdf');
  ok({ exists: which.length > 0, which, jd_path: jd_rel, pdf_path: pdf_rel });
};
```

Note: `ROOT` is `dirname(import.meta.url)` so when tests run with a different `cwd`, `ROOT` still points at the project root. That makes `check-duplicate` always check the *project's* `jds/` and `resumes/`. For the test to work, we need to make path resolution relative to `cwd` instead. Replace the `ROOT`-anchored constants with `cwd`-anchored ones for the directory subcommands:

Actually the simpler fix: use `process.cwd()` for runtime path resolution, since the user always invokes from the project root. Update the file constants:

```js
function projectRoot() { return process.cwd(); }
function pipelinePath() { return resolve(projectRoot(), 'data/pipeline.md'); }
function runsLogPath() { return resolve(projectRoot(), 'data/yash-resume-runs.log'); }
function jdsDir() { return resolve(projectRoot(), 'jds'); }
function resumesDir() { return resolve(projectRoot(), 'resumes'); }
function pdfGeneratorPath() { return resolve(projectRoot(), 'generate-pdf-latex.mjs'); }
```

Then replace earlier uses:
- `PIPELINE_PATH` → `pipelinePath()`
- `RUNS_LOG_PATH` → `runsLogPath()`
- etc.

Update `readPipeline` and `cmdNextPending`'s error messages accordingly.

- [ ] **Step 4: Run tests to confirm pass**

```bash
node --test tests/yash-resume-pipeline.test.mjs
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add yash-resume-pipeline.mjs tests/yash-resume-pipeline.test.mjs
git commit -m "feat(yash-resume): check-duplicate + path-builder helpers"
```

---

## Task 5: Implement `mark-processed` (with shared atomic-write helper)

**Files:**
- Modify: `yash-resume-pipeline.mjs`
- Modify: `tests/yash-resume-pipeline.test.mjs`

- [ ] **Step 1: Write the failing tests**

Append to `tests/yash-resume-pipeline.test.mjs`:

```js
import { readFile as readFileTest } from 'node:fs/promises';

test('mark-processed: moves URL from Pendientes to Procesadas with metadata', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'yrp-test-'));
  await mkdirTest(join(dir, 'data'), { recursive: true });
  await writeFileTest(join(dir, 'data/pipeline.md'), `# Job Pipeline

## Pendientes

- [ ] https://jobs.lever.co/openai/abc-123

## Procesadas

`);
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
  await rm(dir, { recursive: true, force: true });
});

test('mark-processed: idempotent — running twice does not duplicate', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'yrp-test-'));
  await mkdirTest(join(dir, 'data'), { recursive: true });
  await writeFileTest(join(dir, 'data/pipeline.md'), `## Pendientes

- [ ] https://x.com/job

## Procesadas

`);
  const args = ['mark-processed', '--url', 'https://x.com/job', '--company', 'X', '--role', 'Eng', '--jd', 'a', '--pdf', 'b', '--score', '90'];
  await execFileP('node', [SCRIPT, ...args], { cwd: dir });
  await execFileP('node', [SCRIPT, ...args], { cwd: dir });
  const result = await readFileTest(join(dir, 'data/pipeline.md'), 'utf-8');
  const occurrences = (result.match(/https:\/\/x\.com\/job/g) || []).length;
  assert.equal(occurrences, 1, 'URL should appear exactly once after two mark-processed calls');
  await rm(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run tests to confirm failure**

```bash
node --test tests/yash-resume-pipeline.test.mjs
```

Expected: 2 new tests fail.

- [ ] **Step 3: Implement the subcommand and shared helpers**

In `yash-resume-pipeline.mjs`, add:

```js
async function writePipelineAtomic(content) {
  const path = pipelinePath();
  const tmp = `${path}.tmp`;
  await writeFile(tmp, content);
  await rename(tmp, path);
}

// Find the section header line index; -1 if not found.
function findSectionStart(lines, sectionName) {
  return lines.findIndex((l) => l.trim() === `## ${sectionName}`);
}

// Returns { lines, pendientesIdx, procesadasIdx } or fails if structure invalid.
function parsePipelineSections(content) {
  const lines = content.split('\n');
  const pendientesIdx = findSectionStart(lines, 'Pendientes');
  const procesadasIdx = findSectionStart(lines, 'Procesadas');
  if (pendientesIdx === -1) fail('pipeline.md missing `## Pendientes` section');
  if (procesadasIdx === -1) fail('pipeline.md missing `## Procesadas` section');
  return { lines, pendientesIdx, procesadasIdx };
}

// Remove the line(s) matching `- [<state>] <url>` (any state) from the file.
function removeUrlLines(lines, url) {
  const escaped = url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^- \\[.\\] ${escaped}( |$)`);
  return lines.filter((l) => !re.test(l));
}

// Insert a line at the bottom of a given section.
function insertAtSectionEnd(lines, sectionIdx, newLine) {
  // find next section header or EOF
  let insertIdx = lines.length;
  for (let i = sectionIdx + 1; i < lines.length; i++) {
    if (lines[i].startsWith('## ')) { insertIdx = i; break; }
  }
  // walk back to skip trailing blank lines
  while (insertIdx > sectionIdx + 1 && lines[insertIdx - 1].trim() === '') insertIdx--;
  return [...lines.slice(0, insertIdx), newLine, ...lines.slice(insertIdx)];
}

SUBCOMMANDS['mark-processed'] = async (args) => {
  const { url, company, role, jd, pdf, score } = args;
  if (!url || !company || !role || !jd || !pdf || score === undefined) {
    fail('mark-processed requires --url, --company, --role, --jd, --pdf, --score');
  }
  const content = await readPipeline();
  const { lines } = parsePipelineSections(content);
  // Remove any existing line for this URL (idempotency)
  const cleaned = removeUrlLines(lines, url);
  // Re-parse section indices after removal
  const procesadasIdx = findSectionStart(cleaned, 'Procesadas');
  const newLine = `- [x] ${url} | ${company} | ${role} | JD ✅ | Resume ✅ | Score ${score}/100`;
  const updated = insertAtSectionEnd(cleaned, procesadasIdx, newLine);
  await writePipelineAtomic(updated.join('\n'));
  ok({});
};
```

- [ ] **Step 4: Run tests to confirm pass**

```bash
node --test tests/yash-resume-pipeline.test.mjs
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add yash-resume-pipeline.mjs tests/yash-resume-pipeline.test.mjs
git commit -m "feat(yash-resume): mark-processed with atomic pipeline.md mutation"
```

---

## Task 6: Implement `mark-failed` subcommand

**Files:**
- Modify: `yash-resume-pipeline.mjs`
- Modify: `tests/yash-resume-pipeline.test.mjs`

- [ ] **Step 1: Write the failing tests**

Append:

```js
test('mark-failed: changes [ ] to [!] with reason in Pendientes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'yrp-test-'));
  await mkdirTest(join(dir, 'data'), { recursive: true });
  await writeFileTest(join(dir, 'data/pipeline.md'), `## Pendientes

- [ ] https://dead.example.com

## Procesadas

`);
  await execFileP('node', [SCRIPT,
    'mark-failed',
    '--url', 'https://dead.example.com',
    '--reason', '404 Not Found',
  ], { cwd: dir });
  const result = await readFileTest(join(dir, 'data/pipeline.md'), 'utf-8');
  assert.match(result, /- \[!\] https:\/\/dead\.example\.com — reason: 404 Not Found/);
  assert.doesNotMatch(result, /- \[ \] https:\/\/dead\.example\.com/);
  await rm(dir, { recursive: true, force: true });
});

test('mark-failed: replaces existing [!] reason in place (idempotent on URL)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'yrp-test-'));
  await mkdirTest(join(dir, 'data'), { recursive: true });
  await writeFileTest(join(dir, 'data/pipeline.md'), `## Pendientes

- [!] https://x.com/job — reason: old reason

## Procesadas

`);
  await execFileP('node', [SCRIPT,
    'mark-failed', '--url', 'https://x.com/job', '--reason', 'new reason',
  ], { cwd: dir });
  const result = await readFileTest(join(dir, 'data/pipeline.md'), 'utf-8');
  const occurrences = (result.match(/https:\/\/x\.com\/job/g) || []).length;
  assert.equal(occurrences, 1);
  assert.match(result, /reason: new reason/);
  assert.doesNotMatch(result, /old reason/);
  await rm(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run tests to confirm failure**

```bash
node --test tests/yash-resume-pipeline.test.mjs
```

Expected: 2 new tests fail.

- [ ] **Step 3: Implement the subcommand**

In `yash-resume-pipeline.mjs`, add:

```js
SUBCOMMANDS['mark-failed'] = async (args) => {
  const { url, reason } = args;
  if (!url || !reason) fail('mark-failed requires --url and --reason');
  const content = await readPipeline();
  const { lines } = parsePipelineSections(content);
  const cleaned = removeUrlLines(lines, url);
  const pendientesIdx = findSectionStart(cleaned, 'Pendientes');
  const newLine = `- [!] ${url} — reason: ${reason}`;
  const updated = insertAtSectionEnd(cleaned, pendientesIdx, newLine);
  await writePipelineAtomic(updated.join('\n'));
  ok({});
};
```

- [ ] **Step 4: Run tests to confirm pass**

```bash
node --test tests/yash-resume-pipeline.test.mjs
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add yash-resume-pipeline.mjs tests/yash-resume-pipeline.test.mjs
git commit -m "feat(yash-resume): mark-failed leaves [!] in Pendientes with reason"
```

---

## Task 7: Implement `mark-skipped` subcommand

**Files:**
- Modify: `yash-resume-pipeline.mjs`
- Modify: `tests/yash-resume-pipeline.test.mjs`

- [ ] **Step 1: Write the failing test**

Append:

```js
test('mark-skipped: moves URL to Procesadas with [~] and skipped reason', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'yrp-test-'));
  await mkdirTest(join(dir, 'data'), { recursive: true });
  await writeFileTest(join(dir, 'data/pipeline.md'), `## Pendientes

- [ ] https://dup.example.com

## Procesadas

`);
  await execFileP('node', [SCRIPT,
    'mark-skipped',
    '--url', 'https://dup.example.com',
    '--reason', 'duplicate (jd+pdf already exist)',
  ], { cwd: dir });
  const result = await readFileTest(join(dir, 'data/pipeline.md'), 'utf-8');
  assert.match(result, /- \[~\] https:\/\/dup\.example\.com — skipped: duplicate \(jd\+pdf already exist\)/);
  assert.doesNotMatch(result, /- \[ \] https:\/\/dup\.example\.com/);
  await rm(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run test to confirm failure**

```bash
node --test tests/yash-resume-pipeline.test.mjs
```

- [ ] **Step 3: Implement the subcommand**

In `yash-resume-pipeline.mjs`:

```js
SUBCOMMANDS['mark-skipped'] = async (args) => {
  const { url, reason } = args;
  if (!url || !reason) fail('mark-skipped requires --url and --reason');
  const content = await readPipeline();
  const { lines } = parsePipelineSections(content);
  const cleaned = removeUrlLines(lines, url);
  const procesadasIdx = findSectionStart(cleaned, 'Procesadas');
  const newLine = `- [~] ${url} — skipped: ${reason}`;
  const updated = insertAtSectionEnd(cleaned, procesadasIdx, newLine);
  await writePipelineAtomic(updated.join('\n'));
  ok({});
};
```

- [ ] **Step 4: Run test to confirm pass**

```bash
node --test tests/yash-resume-pipeline.test.mjs
```

- [ ] **Step 5: Commit**

```bash
git add yash-resume-pipeline.mjs tests/yash-resume-pipeline.test.mjs
git commit -m "feat(yash-resume): mark-skipped moves URL to Procesadas with [~]"
```

---

## Task 8: Implement `log` subcommand

**Files:**
- Modify: `yash-resume-pipeline.mjs`
- Modify: `tests/yash-resume-pipeline.test.mjs`

- [ ] **Step 1: Write the failing tests**

Append:

```js
test('log: appends one JSON line per call, creates file if missing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'yrp-test-'));
  await mkdirTest(join(dir, 'data'), { recursive: true });
  // file does not exist yet
  await execFileP('node', [SCRIPT,
    'log', '--status', 'ok', '--url', 'https://x.com/1',
    '--slug', 'X_E', '--score', '92', '--jd', 'a', '--pdf', 'b',
  ], { cwd: dir });
  await execFileP('node', [SCRIPT,
    'log', '--status', 'fail', '--url', 'https://x.com/2', '--reason', 'oops',
  ], { cwd: dir });
  const result = await readFileTest(join(dir, 'data/yash-resume-runs.log'), 'utf-8');
  const lines = result.trim().split('\n');
  assert.equal(lines.length, 2);
  const e1 = JSON.parse(lines[0]);
  const e2 = JSON.parse(lines[1]);
  assert.equal(e1.status, 'ok');
  assert.equal(e1.url, 'https://x.com/1');
  assert.equal(e1.score, '92');
  assert.match(e1.timestamp, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(e2.status, 'fail');
  assert.equal(e2.reason, 'oops');
  await rm(dir, { recursive: true, force: true });
});

test('log: rejects unknown status', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'yrp-test-'));
  await mkdirTest(join(dir, 'data'), { recursive: true });
  const { code, stdout } = await execFileP('node', [SCRIPT,
    'log', '--status', 'wat', '--url', 'https://x.com',
  ], { cwd: dir })
    .then((r) => ({ code: 0, stdout: r.stdout.trim() }))
    .catch((e) => ({ code: e.code ?? 1, stdout: (e.stdout ?? '').trim() }));
  assert.equal(code, 1);
  const obj = JSON.parse(stdout);
  assert.equal(obj.status, 'fail');
  assert.match(obj.error, /status must be ok\|fail\|skip/);
  await rm(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run tests to confirm failure**

```bash
node --test tests/yash-resume-pipeline.test.mjs
```

- [ ] **Step 3: Implement the subcommand**

In `yash-resume-pipeline.mjs`:

```js
const ALLOWED_LOG_STATUSES = new Set(['ok', 'fail', 'skip']);

SUBCOMMANDS['log'] = async (args) => {
  const { status, url } = args;
  if (!status) fail('log requires --status');
  if (!ALLOWED_LOG_STATUSES.has(status)) fail('status must be ok|fail|skip');
  if (!url) fail('log requires --url');

  const entry = { timestamp: new Date().toISOString(), status, url, ...args };
  delete entry.timestamp_args; // keep payload clean; status, url already captured separately is fine — JSON.stringify handles dup keys by taking last

  // Build cleanly without the status/url duplication that ...args would produce
  const payload = { timestamp: new Date().toISOString(), status, url };
  const optionalKeys = ['slug', 'score', 'jd', 'pdf', 'reason'];
  for (const k of optionalKeys) {
    if (args[k] !== undefined) payload[k] = args[k];
  }

  const logPath = runsLogPath();
  await mkdir(dirname(logPath), { recursive: true });
  await appendFile(logPath, JSON.stringify(payload) + '\n');
  ok({});
};
```

- [ ] **Step 4: Run tests to confirm pass**

```bash
node --test tests/yash-resume-pipeline.test.mjs
```

- [ ] **Step 5: Commit**

```bash
git add yash-resume-pipeline.mjs tests/yash-resume-pipeline.test.mjs
git commit -m "feat(yash-resume): log subcommand appends JSONL run history"
```

---

## Task 9: Implement `compile-resume` subcommand

**Files:**
- Modify: `yash-resume-pipeline.mjs`
- Modify: `tests/yash-resume-pipeline.test.mjs`
- Create: `tests/fixtures/sample-good.tex`
- Create: `tests/fixtures/sample-bad.tex`

- [ ] **Step 1: Create LaTeX fixtures**

Create `tests/fixtures/sample-good.tex`:

```tex
\documentclass{article}
\begin{document}
Hello, world.
\end{document}
```

Create `tests/fixtures/sample-bad.tex`:

```tex
\documentclass{article}
\begin{document}
\unknowncommand{this is not real}
\end{document}
```

- [ ] **Step 2: Write the failing tests**

Append to `tests/yash-resume-pipeline.test.mjs`:

```js
import { copyFile, stat as statTest } from 'node:fs/promises';

test('compile-resume: good .tex produces a real PDF', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'yrp-test-'));
  await mkdirTest(join(dir, 'resumes'), { recursive: true });
  await copyFile(resolve(ROOT, 'tests/fixtures/sample-good.tex'), join(dir, 'resumes/test.tex'));
  // copy generate-pdf-latex.mjs into temp dir so cwd-anchored lookup finds it
  await copyFile(resolve(ROOT, 'generate-pdf-latex.mjs'), join(dir, 'generate-pdf-latex.mjs'));
  const { stdout } = await execFileP('node', [SCRIPT,
    'compile-resume', '--tex', 'resumes/test.tex', '--pdf', 'resumes/test.pdf',
  ], { cwd: dir });
  const obj = JSON.parse(stdout.trim());
  assert.equal(obj.status, 'ok');
  assert.equal(obj.pdf_path, 'resumes/test.pdf');
  const st = await statTest(join(dir, 'resumes/test.pdf'));
  assert.ok(st.size > 100, 'PDF should be non-trivial size');
  await rm(dir, { recursive: true, force: true });
});

test('compile-resume: bad .tex returns fail with tectonic_log_tail', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'yrp-test-'));
  await mkdirTest(join(dir, 'resumes'), { recursive: true });
  await copyFile(resolve(ROOT, 'tests/fixtures/sample-bad.tex'), join(dir, 'resumes/bad.tex'));
  await copyFile(resolve(ROOT, 'generate-pdf-latex.mjs'), join(dir, 'generate-pdf-latex.mjs'));
  const { code, stdout } = await execFileP('node', [SCRIPT,
    'compile-resume', '--tex', 'resumes/bad.tex', '--pdf', 'resumes/bad.pdf',
  ], { cwd: dir })
    .then((r) => ({ code: 0, stdout: r.stdout.trim() }))
    .catch((e) => ({ code: e.code ?? 1, stdout: (e.stdout ?? '').trim() }));
  assert.equal(code, 1);
  const obj = JSON.parse(stdout);
  assert.equal(obj.status, 'fail');
  assert.match(obj.error, /tectonic|exit/i);
  await rm(dir, { recursive: true, force: true });
});
```

- [ ] **Step 3: Run tests to confirm failure**

```bash
node --test tests/yash-resume-pipeline.test.mjs
```

Expected: both compile-resume tests fail.

- [ ] **Step 4: Implement the subcommand**

In `yash-resume-pipeline.mjs`:

```js
SUBCOMMANDS['compile-resume'] = async (args) => {
  const tex = args.tex;
  const pdf = args.pdf;
  if (!tex || !pdf) fail('compile-resume requires --tex and --pdf');
  const texAbs = resolve(projectRoot(), tex);
  const pdfAbs = resolve(projectRoot(), pdf);
  if (!(await fileExists(texAbs))) fail(`tex file not found: ${tex}`);
  await mkdir(dirname(pdfAbs), { recursive: true });
  try {
    const { stdout } = await execFileP('node', [pdfGeneratorPath(), texAbs, pdfAbs], { timeout: 120000 });
    // tectonic logs go to stdout via generate-pdf-latex.mjs
    const tail = stdout.split('\n').slice(-10).join('\n');
    if (!(await fileExists(pdfAbs))) {
      fail('compile produced no PDF', { tectonic_log_tail: tail });
    }
    ok({ pdf_path: pdf, tectonic_log_tail: tail });
  } catch (e) {
    const tail = (e.stdout || e.stderr || '').split('\n').slice(-15).join('\n');
    fail(`tectonic exit ${e.code ?? '?'}: ${e.message}`, { tectonic_log_tail: tail });
  }
};
```

- [ ] **Step 5: Run tests to confirm pass**

```bash
node --test tests/yash-resume-pipeline.test.mjs
```

Expected: all tests pass. (May take 10–20 seconds for Tectonic to compile the good .tex on first run.)

- [ ] **Step 6: Commit**

```bash
git add yash-resume-pipeline.mjs tests/yash-resume-pipeline.test.mjs tests/fixtures/sample-good.tex tests/fixtures/sample-bad.tex
git commit -m "feat(yash-resume): compile-resume subcommand wraps generate-pdf-latex"
```

---

## Task 10: Wire unit tests into `test-all.mjs`

**Files:**
- Modify: `test-all.mjs`

- [ ] **Step 1: Locate the syntax/scripts test section**

```bash
grep -n "syntax\|node --test\|tests/" /yash-superClaudeHuman/projects/yash-ai-automation-career/test-all.mjs | head -10
```

- [ ] **Step 2: Add a hook for the new test file**

Open `test-all.mjs` and locate the section that runs script-level tests. Add after the existing script tests (the exact insertion point depends on the file; aim for the section that already runs `node --check` on .mjs files). Add:

```js
// === yash-resume-pipeline unit tests ===
console.log('\n📋 yash-resume-pipeline tests');
const ypResult = run('node', ['--test', 'tests/yash-resume-pipeline.test.mjs']);
if (ypResult === null) {
  fail('yash-resume-pipeline.test.mjs failed');
} else {
  pass(`yash-resume-pipeline tests passed`);
}
```

- [ ] **Step 3: Run `test-all.mjs`**

```bash
node test-all.mjs --quick
```

Expected: existing tests still pass; new yash-resume-pipeline test row passes.

- [ ] **Step 4: Commit**

```bash
git add test-all.mjs
git commit -m "test(yash-resume): wire unit tests into test-all.mjs gate"
```

---

## Task 11: Create the mode file

**Files:**
- Create: `modes/yash-resume-pipeline.md`

- [ ] **Step 1: Write the mode file**

Create `modes/yash-resume-pipeline.md`:

````markdown
# Mode: yash-resume-pipeline — JD-extract → V2.0-resume two-phase pipeline

Single-URL-at-a-time pipeline. Reads pending URLs from `data/pipeline.md`,
extracts each JD via Playwright into `jds/`, applies
`resume-optimization-system-based-on-job-description.md` to produce LaTeX,
compiles a tailored PDF resume into `resumes/`. Asks for user confirmation
before each URL. No evaluation, no scoring gate, no tracker writes.

## Per-run loop

Repeat until queue empty, user quits, or 3 consecutive failures:

1. **Get next URL**

   ```bash
   node yash-resume-pipeline.mjs next-pending
   ```

   - If `status: empty` → report "queue drained" and stop.
   - If `status: ok` → continue with the returned `url`.

2. **Confirm with user**

   Show the URL. Ask: "Process `<url>`? (yes / skip / quit)"

   - `quit` → stop the loop.
   - `skip` → run `mark-skipped --url <url> --reason "user skipped"`, continue to next URL.
   - `yes` → continue.

3. **Extract JD via Playwright** (in `/tmp` to avoid `.playwright-cli/` polluting the repo):

   ```bash
   cd /tmp
   playwright-cli open <url> --browser=chromium
   playwright-cli eval "() => document.title"
   playwright-cli eval "() => document.body.innerText"
   playwright-cli close
   ```

   On any tool error (timeout, 404, login wall, expired posting):
   - run `mark-failed --url <url> --reason "playwright: <short-error>"`
   - run `log --status fail --url <url> --reason "..."`
   - ask user: continue with next URL? (yes / quit)

4. **Parse JD fields** from raw text (LLM judgment):
   - Extract `company`, `role`, `location`, `posted_date`.
   - Use the URL host as a portal hint: `lever`, `ashby`, `greenhouse`, `workday`, or `other`.
   - If `company` or `role` confidence is low, ask user once to confirm/correct.
   - If user can't say, run `mark-failed --reason "could not determine company/role"` and continue.

5. **Slugify and dedup check:**

   ```bash
   node yash-resume-pipeline.mjs slugify --company "<c>" --role "<r>"
   ```

   Capture `company_slug`, `role_slug`, `date` from the returned JSON.

   ```bash
   node yash-resume-pipeline.mjs check-duplicate \
       --company-slug <c> --role-slug <r> --date <d>
   ```

   If `exists: true` → run `mark-skipped --reason "duplicate (..."` and continue.

6. **Write JD .md** to `jds/JD_<c>_<r>_Yash_Anghan_<d>.md`:

   ```markdown
   ---
   company: "<original company>"
   company_slug: <c>
   role: "<original role>"
   role_slug: <r>
   url: <url>
   source: lever | ashby | greenhouse | workday | other
   location: "<location>"
   posted_date: <YYYY-MM-DD or null>
   captured_date: <d>
   ---

   # <role> at <company>

   <cleaned full JD body as markdown>
   ```

7. **Apply the V2.0 prompt:**

   Read `resume-optimization-system-based-on-job-description.md` and apply it
   in-context to the JD body from the file written in step 6. The prompt's
   output rules govern the response. Possible outputs:

   a) Just LaTeX (score ≥ 90)
   b) `OPTIMIZATION INCOMPLETE — Score: X/100` + deficiencies + LaTeX
   c) `CONTEXTUALIZATION DEFICIENCY DETECTED` + reason + LaTeX
   d) `SENTENCE COUNT ERROR — CANNOT PROCEED` (no LaTeX, hard fail)
   e) `SKILLS OVERFLOW ERROR — CANNOT PROCEED` (no LaTeX, hard fail)

   **Parse the output:**

   - Find the first occurrence of `\documentclass`.
   - If present: everything before that line = deficiency log; everything from
     `\documentclass` to end of output = LaTeX block.
   - If absent: hard-fail. Run
     `mark-failed --reason "V2.0 hard-fail: <SENTENCE_COUNT|SKILLS_OVERFLOW>"`
     and `log --status fail`. Save the full output to the sidecar `.log`. Continue.

8. **Write `.tex`:** save the LaTeX block (from `\documentclass` onward) to
   `resumes/<c>_<r>_Yash_Anghan_Resume_<d>.tex`.

9. **Compile to PDF:**

   ```bash
   node yash-resume-pipeline.mjs compile-resume \
       --tex resumes/<c>_<r>_Yash_Anghan_Resume_<d>.tex \
       --pdf resumes/<c>_<r>_Yash_Anghan_Resume_<d>.pdf
   ```

   If `status: fail`:
   - run `mark-failed --reason "tectonic: <tectonic_log_tail>"`
   - run `log --status fail --reason "tectonic: ..."`
   - keep the .tex on disk for inspection
   - ask user: continue?

10. **Write sidecar `.log`** to `resumes/<c>_<r>_Yash_Anghan_Resume_<d>.log`:

    ```
    score: <X>/100
    deficiencies: <text captured before \documentclass; or "none">
    status: compiled | compiled-review-recommended  (review-recommended if score < 90)
    ```

11. **Mark processed and log:**

    ```bash
    node yash-resume-pipeline.mjs mark-processed \
        --url <url> --company "<c>" --role "<r>" \
        --jd <jd-path> --pdf <pdf-path> --score <X>

    node yash-resume-pipeline.mjs log \
        --status ok --url <url> \
        --slug <c>_<r> --score <X> \
        --jd <jd-path> --pdf <pdf-path>
    ```

12. **Report to user:** print the JD path, PDF path, score, and any review flag.

13. **Ask user:** "continue with next URL? (yes / quit)"

## Stop conditions

- User says quit at any prompt.
- `next-pending` returns `status: empty`.
- 3 consecutive failures (extract or compile). Report summary and ask user
  to investigate before continuing.

## Hard rules

- **One URL at a time.** Never process in parallel. Never run multiple URLs
  through the V2.0 prompt simultaneously.
- **Files only.** This pipeline never auto-submits applications. It only
  produces JD `.md`, `.tex`, `.pdf`, and `.log` files.
- **Never edit `data/pipeline.md` directly.** Always go through the orchestrator
  subcommands so the format stays consistent with the existing `pipeline` mode.
- **Never fabricate company or role.** If the JD page is ambiguous, ask the
  user once. If they can't say, mark failed.
- **Never modify** `resume-optimization-system-based-on-job-description.md`,
  `generate-pdf-latex.mjs`, or the existing `pipeline`/`auto-pipeline` modes.
````

- [ ] **Step 2: Verify markdown is valid**

```bash
head -30 /yash-superClaudeHuman/projects/yash-ai-automation-career/modes/yash-resume-pipeline.md
```

- [ ] **Step 3: Commit**

```bash
git add modes/yash-resume-pipeline.md
git commit -m "feat(yash-resume): mode file describing the per-URL loop"
```

---

## Task 12: Create the slash-command shim

**Files:**
- Create: `.claude/commands/yash-resume-pipeline.md`

- [ ] **Step 1: Ensure `.claude/commands/` exists**

```bash
mkdir -p /yash-superClaudeHuman/projects/yash-ai-automation-career/.claude/commands
```

- [ ] **Step 2: Write the shim**

Create `.claude/commands/yash-resume-pipeline.md`:

```markdown
---
description: Run the JD-extract → V2.0-resume pipeline (one URL at a time).
argument-hint: ""
---

Read modes/yash-resume-pipeline.md and follow it.
```

- [ ] **Step 3: Commit**

```bash
git add .claude/commands/yash-resume-pipeline.md
git commit -m "feat(yash-resume): /yash-resume-pipeline slash command shim"
```

---

## Task 13: Create HTML JD fixtures

**Files:**
- Create: `tests/fixtures/jds/lever-sample.html`
- Create: `tests/fixtures/jds/ashby-sample.html`
- Create: `tests/fixtures/jds/greenhouse-sample.html`

- [ ] **Step 1: Create Lever fixture**

Create `tests/fixtures/jds/lever-sample.html`:

```html
<!doctype html>
<html lang="en">
<head><title>Senior AI Engineer at Lever Demo Corp</title></head>
<body>
<div class="content">
  <h2>Senior AI Engineer</h2>
  <div class="location">Toronto, ON / Remote (Canada)</div>
  <div class="department">AI Engineering</div>
  <div class="posting-content">
    <h3>About Lever Demo Corp</h3>
    <p>Lever Demo Corp builds applied-AI products for the financial services sector.</p>
    <h3>What you'll do</h3>
    <ul>
      <li>Design and ship LLM-powered features for our research platform.</li>
      <li>Own the AI-automation pipeline from prompt design through production deployment.</li>
      <li>Collaborate with analyst teams to ground model outputs in proprietary financial data.</li>
    </ul>
    <h3>Requirements</h3>
    <ul>
      <li>5+ years of software engineering, including 2+ years on ML/AI systems.</li>
      <li>Strong Python; experience with retrieval-augmented generation (RAG).</li>
      <li>Familiarity with cloud platforms (AWS preferred).</li>
    </ul>
    <h3>Apply</h3>
    <a href="#">Apply Now</a>
  </div>
</div>
</body>
</html>
```

- [ ] **Step 2: Create Ashby fixture**

Create `tests/fixtures/jds/ashby-sample.html`:

```html
<!doctype html>
<html lang="en">
<head><title>Machine Learning Engineer (Toronto) | Ashby Demo Inc</title></head>
<body>
<main>
  <h1>Machine Learning Engineer (Toronto)</h1>
  <section>
    <p><strong>Ashby Demo Inc</strong> is hiring a Machine Learning Engineer to join our applied AI team in Toronto.</p>
    <h3>Responsibilities</h3>
    <ul>
      <li>Build and ship ML pipelines for production scoring.</li>
      <li>Optimize inference latency and cost across cloud (AWS/GCP).</li>
      <li>Partner with platform engineers on automation tooling.</li>
    </ul>
    <h3>Required</h3>
    <ul>
      <li>3+ years building production ML systems.</li>
      <li>Python, PyTorch or TensorFlow.</li>
      <li>Experience with microservices and Docker.</li>
    </ul>
  </section>
</main>
</body>
</html>
```

- [ ] **Step 3: Create Greenhouse fixture**

Create `tests/fixtures/jds/greenhouse-sample.html`:

```html
<!doctype html>
<html lang="en">
<head><title>AI Automation Engineer - Greenhouse Demo LLC</title></head>
<body>
<div id="content">
  <h1 class="app-title">AI Automation Engineer</h1>
  <div class="location">Remote – Canada</div>
  <div id="content">
    <p>Greenhouse Demo LLC is a fast-moving startup automating telecom operations with AI.</p>
    <h3>What you'll do</h3>
    <ul>
      <li>Build agentic workflows that automate billing reconciliation.</li>
      <li>Integrate LLM-based decision systems with our microservices stack.</li>
      <li>Own end-to-end automation from data ingestion to action.</li>
    </ul>
    <h3>You bring</h3>
    <ul>
      <li>Production experience with LLMs, RAG, or agent frameworks.</li>
      <li>Strong Python, REST API design, and microservices.</li>
      <li>Bonus: Java/Spring background, AWS, CI/CD.</li>
    </ul>
  </div>
</div>
</body>
</html>
```

- [ ] **Step 4: Commit**

```bash
git add tests/fixtures/jds/
git commit -m "test(yash-resume): HTML JD fixtures for three portals"
```

---

## Task 14: Write smoke test

**Files:**
- Create: `tests/test-yash-pipeline-smoke.mjs`

- [ ] **Step 1: Write the smoke test**

Create `tests/test-yash-pipeline-smoke.mjs`:

```js
#!/usr/bin/env node
/**
 * test-yash-pipeline-smoke.mjs — end-to-end smoke test for the deterministic
 * portion of the yash-resume-pipeline.
 *
 * Validates: Playwright can extract title+text from local fixture HTML, slugify
 * round-trip, JD .md write, .tex compile via tectonic produces a real PDF.
 *
 * Does NOT cover: the V2.0 prompt application (LLM-bound, exercised manually).
 *
 * Usage: node tests/test-yash-pipeline-smoke.mjs
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir, rm, stat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';

const execFileP = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = resolve(ROOT, 'tests/fixtures/jds');
const SCRIPT = resolve(ROOT, 'yash-resume-pipeline.mjs');

let pass = 0, fail = 0;
function ok(msg) { console.log('  ✅', msg); pass++; }
function ng(msg) { console.log('  ❌', msg); fail++; }

// Tiny HTTP server to serve the fixtures for Playwright.
function serveFixtures(port) {
  return new Promise((resolveSrv) => {
    const server = createServer((req, res) => {
      const file = req.url.replace(/^\//, '') || 'lever-sample.html';
      try {
        const content = readFileSync(resolve(FIXTURES, file));
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(content);
      } catch (e) {
        res.writeHead(404); res.end('not found');
      }
    });
    server.listen(port, () => resolveSrv(server));
  });
}

async function runFixture(server, port, fixtureName, expectedCompany, expectedRole) {
  const url = `http://localhost:${port}/${fixtureName}`;
  console.log(`\n→ Fixture: ${fixtureName}`);

  // Use playwright-cli to fetch title + body text
  await execFileP('playwright-cli', ['open', url, '--browser=chromium'], { cwd: '/tmp' });
  let title;
  let body;
  try {
    const t = await execFileP('playwright-cli', ['eval', '() => document.title'], { cwd: '/tmp' });
    title = t.stdout.trim();
    const b = await execFileP('playwright-cli', ['eval', '() => document.body.innerText'], { cwd: '/tmp' });
    body = b.stdout.trim();
  } finally {
    await execFileP('playwright-cli', ['close'], { cwd: '/tmp' }).catch(() => {});
  }

  if (title.includes(expectedCompany) || body.includes(expectedCompany)) ok('extracts company');
  else ng(`expected company "${expectedCompany}" in title or body`);

  if (body.includes(expectedRole)) ok('extracts role');
  else ng(`expected role "${expectedRole}" in body`);

  // Slugify
  const slug = await execFileP('node', [SCRIPT, 'slugify',
    '--company', expectedCompany,
    '--role', expectedRole,
  ], { cwd: ROOT });
  const slugObj = JSON.parse(slug.stdout.trim());
  if (slugObj.status === 'ok' && slugObj.company_slug && slugObj.role_slug) ok('slugify ok');
  else ng('slugify failed');
}

async function main() {
  const server = await serveFixtures(8765);
  try {
    await runFixture(server, 8765, 'lever-sample.html',
      'Lever Demo Corp', 'Senior AI Engineer');
    await runFixture(server, 8765, 'ashby-sample.html',
      'Ashby Demo Inc', 'Machine Learning Engineer');
    await runFixture(server, 8765, 'greenhouse-sample.html',
      'Greenhouse Demo LLC', 'AI Automation Engineer');

    // Tectonic round-trip on a known-good .tex
    const tmpDir = resolve(ROOT, '.tmp-smoke');
    await mkdir(resolve(tmpDir, 'resumes'), { recursive: true });
    await writeFile(resolve(tmpDir, 'resumes/sm.tex'),
      `\\documentclass{article}\\begin{document}smoke\\end{document}`);
    // copy generate-pdf-latex.mjs into tmpDir
    const gen = await readFile(resolve(ROOT, 'generate-pdf-latex.mjs'), 'utf-8');
    await writeFile(resolve(tmpDir, 'generate-pdf-latex.mjs'), gen);

    const out = await execFileP('node', [SCRIPT, 'compile-resume',
      '--tex', 'resumes/sm.tex', '--pdf', 'resumes/sm.pdf',
    ], { cwd: tmpDir });
    const obj = JSON.parse(out.stdout.trim());
    if (obj.status === 'ok') ok('tectonic compile happy path');
    else ng(`tectonic compile failed: ${obj.error}`);

    const st = await stat(resolve(tmpDir, 'resumes/sm.pdf'));
    if (st.size > 100) ok('pdf is non-trivial size');
    else ng(`pdf too small: ${st.size} bytes`);

    await rm(tmpDir, { recursive: true, force: true });
  } finally {
    server.close();
  }

  console.log(`\nSmoke test: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Run the smoke test**

```bash
cd /yash-superClaudeHuman/projects/yash-ai-automation-career
node tests/test-yash-pipeline-smoke.mjs
```

Expected output (approximately):

```
→ Fixture: lever-sample.html
  ✅ extracts company
  ✅ extracts role
  ✅ slugify ok
→ Fixture: ashby-sample.html
  ✅ extracts company
  ✅ extracts role
  ✅ slugify ok
→ Fixture: greenhouse-sample.html
  ✅ extracts company
  ✅ extracts role
  ✅ slugify ok
  ✅ tectonic compile happy path
  ✅ pdf is non-trivial size

Smoke test: 11 passed, 0 failed
```

If a fixture fails, inspect the HTML and adjust either the fixture or the expected company/role string. The smoke test is permissive (substring match) for resilience.

- [ ] **Step 3: Commit**

```bash
git add tests/test-yash-pipeline-smoke.mjs
git commit -m "test(yash-resume): smoke test covering Playwright + Tectonic"
```

---

## Task 15: Update AGENTS.md and final verification

**Files:**
- Modify: `AGENTS.md`

- [ ] **Step 1: Add a row to the Skill Modes table**

Open `AGENTS.md` and locate the "Skill Modes" table (search for `| If the user...`). Add a row:

```markdown
| Wants the strict V2.0 resume pipeline (JD extract + tailored PDF only) | `yash-resume-pipeline` |
```

- [ ] **Step 2: Add a paragraph above the table** describing the new mode:

Locate the section where the existing modes (`pipeline`, `auto-pipeline`) are introduced. Add:

```markdown
### Yash Resume Pipeline (yash-resume-pipeline)

A streamlined sibling of `auto-pipeline`. Instead of running the full evaluation
(A–G blocks + scoring + tracker), it produces only two artifacts per URL: a
structured JD `.md` in `jds/` and a tailored LaTeX-compiled PDF resume in
`resumes/`. Drop URLs into `data/pipeline.md` (same inbox as `pipeline`),
then run `/yash-resume-pipeline` — it processes one URL at a time, asks
before each, and stops on `quit`, empty queue, or 3 consecutive failures.

Inputs:
- URLs in `data/pipeline.md` `## Pendientes` section as `- [ ] <url>`.
- The locked V2.0 prompt at `resume-optimization-system-based-on-job-description.md`.

Outputs:
- `jds/JD_<CompanySlug>_<RoleSlug>_Yash_Anghan_<YYYY-MM-DD>.md`
- `resumes/<CompanySlug>_<RoleSlug>_Yash_Anghan_Resume_<YYYY-MM-DD>.{tex,pdf,log}`
- One JSONL line per run in `data/yash-resume-runs.log`.

See `modes/yash-resume-pipeline.md` for the full per-URL loop and
`docs/superpowers/specs/2026-05-07-yash-resume-pipeline-design.md` for the
locked design.
```

- [ ] **Step 3: Run the full test gate**

```bash
cd /yash-superClaudeHuman/projects/yash-ai-automation-career
node test-all.mjs --quick
node tests/test-yash-pipeline-smoke.mjs
```

Both must pass.

- [ ] **Step 4: Commit**

```bash
git add AGENTS.md
git commit -m "docs(yash-resume): document /yash-resume-pipeline mode in AGENTS.md"
```

- [ ] **Step 5: Manual verification (one-time, not committed)**

Per spec §8.3, run the live flow against 5 real URLs:

1. Pick one Lever URL, one Ashby URL, one Greenhouse URL, one Workday URL, one LinkedIn URL.
2. Add them to `data/pipeline.md` under `## Pendientes`.
3. Run `/yash-resume-pipeline` interactively. Process each URL.
4. Verify each output file exists with the correct format.
5. Diff one of the produced LaTeX files against the V2.0 prompt's expectations:
   - 6 sentences in Morningstar block, 5 in Bell, 4 in Virtusa
   - All metrics from allowed_metrics ranges
   - All Technical Skills categories within character limits
6. Force-test failure paths:
   - Add a known 404 URL → should produce `[!]` line with "page not found".
   - Add a known login-walled URL (e.g., LinkedIn-internal) → should produce `[!]` with "auth required".

Document any issues found in `docs/superpowers/notes/2026-05-07-yash-resume-manual-verification.md` (optional).

---

## Self-Review

### Spec coverage check

| Spec section | Implementing task |
|---|---|
| §3 Architecture | Tasks 1, 11 (file/dir layout) |
| §4 Per-URL data flow | Task 11 (mode file) |
| §5.1 Subcommand contracts | Tasks 1–9 |
| §5.2 Idempotency, atomic writes | Tasks 5–7 |
| §5.3 Slugify rule | Task 2 |
| §6 Mode file structure | Task 11 |
| §6.1 Slash shim | Task 12 |
| §7 Error matrix | Task 11 (mode file) + Tasks 5–9 (mark-* / log) |
| §8.1 Unit tests | Tasks 1–9 |
| §8.2 Smoke test | Tasks 13, 14 |
| §8.3 Manual verification | Task 15 step 5 |
| §9 Acceptance criteria | All 15 tasks together |
| §10 Out of scope | Not implemented (correctly) |

All spec requirements are covered.

### Placeholder scan

No `TBD`, `TODO`, `implement later`, or "similar to Task N". Every task contains the actual code or text the engineer needs.

### Type / signature consistency

- Slugify: same signature `slugify(input: string): string` everywhere.
- Path builders: `buildJdPath`, `buildPdfPath`, `buildTexPath`, `buildSidecarLogPath` defined in Task 4, used consistently in Tasks 5–9 (when path strings appear in tests).
- Subcommand argument names match across tests, mode file, and implementation: `--company-slug`, `--role-slug`, `--date`, `--url`, `--reason`, `--score`, `--jd`, `--pdf`, `--status`, `--slug`, `--tex`.
- Status values from log subcommand: `ok | fail | skip` (defined in Task 8, referenced in mode file Task 11).

No inconsistencies found.
