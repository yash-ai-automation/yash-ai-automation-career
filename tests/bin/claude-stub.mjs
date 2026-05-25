#!/usr/bin/env node
// Stub `claude` binary used only by e2e tests. Writes its received preamble
// (the first prompt arg) to STUB_CAPTURE_PATH, then exits cleanly.
import { writeFileSync, appendFileSync } from 'node:fs';

const capture = process.env.STUB_CAPTURE_PATH || '/tmp/claude-stub-capture.txt';
const idx = process.argv.indexOf('-p');
const prompt = idx >= 0 ? process.argv[idx + 1] : '';
writeFileSync(capture, prompt);
appendFileSync(capture + '.argv', JSON.stringify(process.argv) + '\n');
process.exit(process.env.STUB_EXIT_CODE ? Number(process.env.STUB_EXIT_CODE) : 0);
