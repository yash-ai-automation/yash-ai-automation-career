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
    const flagBody = a.slice(2);
    if (flagBody.includes('=')) {
      const eq = flagBody.indexOf('=');
      const key = flagBody.slice(0, eq);
      const value = flagBody.slice(eq + 1);
      out[key] = value;
      continue;
    }
    const key = flagBody;
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

// === Slugify ===
export function slugify(input) {
  if (typeof input !== 'string') return '';
  // Step 0: remove parenthesized groups (e.g. "(Remote)", "(US)")
  const noParen = input.replace(/\([^)]*\)/g, '');
  // Step 1: replace runs of non-alnum with single space
  const cleaned = noParen.replace(/[^a-zA-Z0-9]+/g, ' ').trim();
  if (!cleaned) return '';
  // Step 2-5: tokenize, capitalize, concat
  return cleaned.split(/\s+/).map((token) => {
    if (token.length >= 2 && token === token.toUpperCase() && /[A-Z]/.test(token)) {
      // all-caps token of length >= 2: title-case it (AI -> Ai, ML -> Ml)
      return token[0] + token.slice(1).toLowerCase();
    }
    // single-letter or mixed-case: first char upper, rest forced lower (spec §5.3 step 4)
    if (token.length === 1) return token.toUpperCase();
    return token[0].toUpperCase() + token.slice(1).toLowerCase();
  }).join('');
}

export function dateToday() {
  return new Date().toISOString().slice(0, 10);
}

// === Subcommand stubs (filled in subsequent tasks) ===
const SUBCOMMANDS = {
  // populated as we go
};

SUBCOMMANDS['slugify'] = async (args) => {
  const company = args.company ?? '';
  const role = args.role ?? '';
  const company_slug = slugify(company);
  const role_slug = slugify(role);
  if (!company_slug) fail('empty company slug after normalization');
  if (!role_slug) fail('empty role slug after normalization');
  ok({ company_slug, role_slug, date: dateToday() });
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
