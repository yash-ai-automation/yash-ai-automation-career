// tests/services/orchestrator-pdf-delivery.test.mjs
// Regression for the 2026-05-29 delivery bug exposed by the timeout fix: the
// orchestrator imported/called `sendDocument`, but telegram-client.mjs only
// exports `sendTelegramDocument` — so every PDF delivery threw
// "sendDocument is not a function" and resume/cover-letter PDFs never reached
// Telegram (silent best-effort warning). This guards the export/caller contract
// with a static check (no network, no token needed).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const tgSrc = readFileSync(resolve(ROOT, 'services/telegram-client.mjs'), 'utf8');
const orchSrc = readFileSync(resolve(ROOT, 'services/pipeline-orchestrator.mjs'), 'utf8');

test('telegram-client exports sendTelegramDocument', () => {
  assert.ok(
    /export\s+async\s+function\s+sendTelegramDocument\b/.test(tgSrc),
    'telegram-client.mjs must export sendTelegramDocument',
  );
});

test('orchestrator delivers via sendTelegramDocument, never the nonexistent sendDocument', () => {
  assert.ok(
    !/\bsendDocument\b/.test(orchSrc),
    'orchestrator must NOT reference sendDocument — it is not exported (export is sendTelegramDocument)',
  );
  assert.ok(
    /await sendTelegramDocument\(/.test(orchSrc),
    'orchestrator must call sendTelegramDocument to deliver PDFs',
  );
});
