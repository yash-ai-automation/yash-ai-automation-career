// tests/services/orchestrator-pdf-delivery.test.mjs
// Guard the orchestrator <-> telegram-client delivery contract so a rename on
// either side can't silently break PDF delivery (resume + cover letter). The
// real export is `sendDocument` (verified live on the VPS); this test pins it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const tgSrc = readFileSync(resolve(ROOT, 'services/telegram-client.mjs'), 'utf8');
const orchSrc = readFileSync(resolve(ROOT, 'services/pipeline-orchestrator.mjs'), 'utf8');

test('telegram-client exports sendDocument', () => {
  assert.ok(
    /export\s+async\s+function\s+sendDocument\b/.test(tgSrc),
    'telegram-client.mjs must export sendDocument',
  );
});

test('orchestrator delivers via the real sendDocument export (no phantom symbol)', () => {
  assert.ok(
    /await sendDocument\(/.test(orchSrc),
    'orchestrator must call sendDocument to deliver PDFs',
  );
  assert.ok(
    !/sendTelegramDocument/.test(orchSrc),
    'orchestrator must not reference sendTelegramDocument — that symbol is not exported',
  );
});
