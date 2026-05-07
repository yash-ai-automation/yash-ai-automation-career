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
