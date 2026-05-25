// tests/e2e/shivani-delivery.e2e.mjs
// Plan §8.5 — happy-path resume + cover-letter PDF delivery for a Shivani run.
// Drives tickOnce() with a stub spawn that writes:
//   - a Shivani audit-log JSONL line at data/shivani-resume-runs.log
//   - resumes/shivani/<slug>.pdf
//   - cover-letters/shivani/<slug>.pdf
// then verifies the orchestrator uploads BOTH PDFs to the configured Shivani
// chat with the expected captions ("Resume #<id>", "Cover Letter #<id>") and
// no "undefined" chat_id slipped through (regression guard for 2026-05-24
// production bug).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDb, closeDb } from '../../services/db.mjs';
import { insertQueueRow } from '../../services/queue.mjs';
import { tickOnce } from '../../services/pipeline-orchestrator.mjs';

// Fictional Shivani-side chat id — NOT the real production id (which is blocked
// from the repo by tools/check-secrets.sh).
const SHIVANI_CHAT_ID = 9_000_000_002;

const SHIVANI_ENV = {
  AUDIT_LOG_PATH: 'data/shivani-resume-runs.log',
  PREAMBLE_DIR: 'ops/shivani/preambles',
  TENANT: 'shivani',
  TENANT_LABEL: 'shivani-pipeline',
  TENANT_TRACE_NAME: 'shivani-resume-pipeline',
  TMP_CLEANUP_GLOB: '/tmp/shivani-pipeline-*',
};

async function withEnvBlock(block, fn) {
  const restore = {};
  for (const k of Object.keys(block)) {
    restore[k] = process.env[k];
    if (block[k] === undefined) delete process.env[k];
    else process.env[k] = block[k];
  }
  try { return await fn(); }
  finally {
    for (const k of Object.keys(restore)) {
      if (restore[k] === undefined) delete process.env[k];
      else process.env[k] = restore[k];
    }
  }
}

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), 'shivani-deliver-'));
  mkdirSync(join(dir, 'ops/shivani/checkpoints'), { recursive: true });
  mkdirSync(join(dir, 'ops/shivani/runs'), { recursive: true });
  mkdirSync(join(dir, 'resumes/shivani'), { recursive: true });
  mkdirSync(join(dir, 'cover-letters/shivani'), { recursive: true });
  mkdirSync(join(dir, 'jds/shivani'), { recursive: true });
  const db = initDb(join(dir, 'ops/shivani/work-queue.db'));
  return { db, dir, cleanup: () => { closeDb(db); rmSync(dir, { recursive: true, force: true }); } };
}

test('e2e: happy-path Shivani run uploads resume + cover-letter PDFs to the Shivani chat with correct captions', async () => {
  const { db, dir, cleanup } = fresh();

  // Stand up a fake Telegram API. Captures every POST so we can inspect /sendDocument.
  const http = await import('node:http');
  const captured = [];
  const server = await new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        captured.push({ url: req.url, body });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, result: { message_id: captured.length } }));
      });
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = server.address().port;

  try {
    await withEnvBlock(
      { ...SHIVANI_ENV, TELEGRAM_BOT_TOKEN: 'test-shivani-tok', TELEGRAM_API_BASE: `http://127.0.0.1:${port}/bot` },
      async () => {
        // Stage the artifacts on disk so existsSync() returns true and sendDocument is reached.
        const slug = 'Example_Software_Engineer_Shivani_Anghan_2026-05-25';
        const resumePdf = join(dir, 'resumes/shivani', `${slug}.pdf`);
        const coverPdf = join(dir, 'cover-letters/shivani', `${slug}.pdf`);
        writeFileSync(resumePdf, '%PDF-1.4 fake resume');
        writeFileSync(coverPdf, '%PDF-1.4 fake cover letter');

        insertQueueRow(db, {
          url: 'https://shivani-jobs.example.com/fullstack-java',
          urlHash: 'sh-deliver',
          addedBy: SHIVANI_CHAT_ID,
        });

        const r = await tickOnce({
          db, projectRoot: dir,
          capLimits: { dailyMax: 20, weeklyMax: 100 },
          gitSha: 'cafebabe',
          claudeModel: 'claude-opus-4-7',
          spawn: async ({ runId }) => ({
            exitCode: 0,
            durationMs: 480_000,
            slug,
            score: 88,
            jdPath: `jds/shivani/JD_${slug}.md`,
            resumePdf,
            coverLetterPdf: coverPdf,
            company: 'Example',
            role: 'Software Engineer',
          }),
          notify: () => {},
          notifyChatId: SHIVANI_CHAT_ID,
        });

        assert.equal(r.action, 'completed_ok');
        const queueRow = db.prepare('SELECT status FROM queue ORDER BY id DESC LIMIT 1').get();
        assert.equal(queueRow.status, 'done');

        // Exactly two /sendDocument calls — resume + cover letter.
        const docReqs = captured.filter((c) => c.url.endsWith('/sendDocument'));
        assert.equal(docReqs.length, 2, `expected 2 sendDocument calls, got ${docReqs.length}`);
        for (const docReq of docReqs) {
          assert.ok(
            docReq.body.includes('name="chat_id"') && docReq.body.includes(String(SHIVANI_CHAT_ID)),
            `multipart body must carry chat_id=${SHIVANI_CHAT_ID}; got ${docReq.body.slice(0, 400)}`,
          );
          assert.ok(!docReq.body.includes('undefined'),
            'multipart body must not contain the literal string "undefined" (2026-05-24 regression guard)');
        }
        // Captions: one is "Resume #N", the other is "Cover Letter #N" (same N).
        const captionsRaw = docReqs.map((d) => {
          // crude multipart caption extractor — works because pino-style boundaries put the value alone on a line.
          const m = d.body.match(/name="caption"\r?\n\r?\n([^\r\n]+)/);
          return m ? m[1] : null;
        });
        assert.ok(captionsRaw.some((c) => c && /^Resume #\d+$/.test(c)),
          `expected a "Resume #N" caption, got ${JSON.stringify(captionsRaw)}`);
        assert.ok(captionsRaw.some((c) => c && /^Cover Letter #\d+$/.test(c)),
          `expected a "Cover Letter #N" caption, got ${JSON.stringify(captionsRaw)}`);
      },
    );
  } finally {
    server.close();
    cleanup();
  }
});
