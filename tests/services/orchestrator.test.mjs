// tests/services/orchestrator.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDb, closeDb } from '../../services/db.mjs';
import { insertQueueRow } from '../../services/queue.mjs';
import { tickOnce } from '../../services/pipeline-orchestrator.mjs';

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), 'yash-orch-'));
  mkdirSync(join(dir, 'ops/checkpoints'), { recursive: true });
  mkdirSync(join(dir, 'ops/runs'), { recursive: true });
  const db = initDb(join(dir, 'ops/work-queue.db'));
  return { db, dir, cleanup: () => { closeDb(db); rmSync(dir, { recursive: true, force: true }); } };
}

test('tickOnce: idle when queue empty', async () => {
  const { db, dir, cleanup } = fresh();
  try {
    const notifications = [];
    const r = await tickOnce({
      db, projectRoot: dir,
      capLimits: { dailyMax: 20, weeklyMax: 100 },
      gitSha: 'deadbee',
      claudeModel: 'claude-opus-4-7',
      spawn: async () => { throw new Error('should not spawn'); },
      notify: (msg) => notifications.push(msg),
    });
    assert.equal(r.action, 'idle');
    assert.equal(notifications.length, 0);
  } finally { cleanup(); }
});

test('tickOnce: spawns when queued, returns ok on clean exit', async () => {
  const { db, dir, cleanup } = fresh();
  try {
    insertQueueRow(db, { url: 'http://acme.com/job', urlHash: 'h1', addedBy: 1 });
    const notifications = [];
    const r = await tickOnce({
      db, projectRoot: dir,
      capLimits: { dailyMax: 20, weeklyMax: 100 },
      gitSha: 'cafebabe',
      claudeModel: 'claude-opus-4-7',
      spawn: async ({ url, runId }) => ({ exitCode: 0, durationMs: 1000, slug: 'Acme_Job', score: 91, jdPath: 'jds/yash/x.md', resumePdf: 'resumes/yash/x.pdf', coverLetterPdf: 'cover-letters/yash/x.pdf' }),
      notify: (msg) => notifications.push(msg),
    });
    assert.equal(r.action, 'completed_ok');
    assert.ok(notifications.some(n => /🚀/.test(n)), 'expected a start notification');
    assert.ok(notifications.some(n => /✅/.test(n)), 'expected a success notification');
    const queueRow = db.prepare('SELECT status FROM queue ORDER BY id DESC LIMIT 1').get();
    assert.equal(queueRow.status, 'done');
  } finally { cleanup(); }
});

test('tickOnce: marks failed and notifies on non-zero exit', async () => {
  const { db, dir, cleanup } = fresh();
  try {
    insertQueueRow(db, { url: 'http://acme.com/job', urlHash: 'h1', addedBy: 1 });
    const notifications = [];
    const r = await tickOnce({
      db, projectRoot: dir,
      capLimits: { dailyMax: 20, weeklyMax: 100 },
      gitSha: 'cafebabe',
      claudeModel: 'claude-opus-4-7',
      spawn: async () => ({ exitCode: 1, durationMs: 2000, error: 'tectonic exit 11', failedPhase: 'resume_compile_end' }),
      notify: (msg) => notifications.push(msg),
    });
    assert.equal(r.action, 'completed_fail');
    const queueRow = db.prepare('SELECT status FROM queue ORDER BY id DESC LIMIT 1').get();
    assert.equal(queueRow.status, 'failed');
    assert.ok(notifications.some(n => /❌/.test(n)));
  } finally { cleanup(); }
});

test('tickOnce: when cap reached, leaves queue alone and notifies once', async () => {
  const { db, dir, cleanup } = fresh();
  try {
    // seed 20 ok runs to trigger daily cap
    for (let i = 0; i < 20; i++) {
      const qid = insertQueueRow(db, { url: `http://x${i}`, urlHash: `h${i}`, addedBy: 1 });
      db.prepare(`UPDATE queue SET status='running', assigned_at=datetime('now') WHERE id=?`).run(qid);
      const r = db.prepare(`INSERT INTO runs(queue_id, url, started_at, status) VALUES(?,?,?,?)`).run(qid, `http://x${i}`, new Date().toISOString(), 'ok');
      db.prepare(`UPDATE runs SET ended_at=datetime('now') WHERE id=?`).run(Number(r.lastInsertRowid));
      db.prepare(`UPDATE queue SET status='done', completed_at=datetime('now') WHERE id=?`).run(qid);
    }
    insertQueueRow(db, { url: 'http://newcomer', urlHash: 'hn', addedBy: 1 });
    const notifications = [];
    const r = await tickOnce({
      db, projectRoot: dir,
      capLimits: { dailyMax: 20, weeklyMax: 100 },
      gitSha: 'cafebabe',
      claudeModel: 'claude-opus-4-7',
      spawn: async () => { throw new Error('should not spawn when capped'); },
      notify: (msg) => notifications.push(msg),
    });
    assert.equal(r.action, 'capped');
    assert.ok(notifications.some(n => /⏸️/.test(n)));
    const newcomer = db.prepare(`SELECT status FROM queue WHERE url='http://newcomer'`).get();
    assert.equal(newcomer.status, 'queued', 'capped URL stays queued for retry');
  } finally { cleanup(); }
});

test('tickOnce: shutdown_interrupt — preserves queue/run/checkpoint when spawn killed during shutdown', async () => {
  const { db, dir, cleanup } = fresh();
  try {
    const qid = insertQueueRow(db, { url: 'http://acme.com/job', urlHash: 'h1', addedBy: 1 });
    const notifications = [];
    const r = await tickOnce({
      db, projectRoot: dir,
      capLimits: { dailyMax: 20, weeklyMax: 100 },
      gitSha: 'cafebabe',
      claudeModel: 'claude-opus-4-7',
      // Simulate: orchestrator received SIGTERM while claude was running.
      // spawn returns non-zero exit AND isShuttingDown returns true.
      spawn: async ({ runId }) => {
        // Pretend the in-flight run reached resume_gen_end before being SIGTERMed.
        const { upsertCheckpoint } = await import('../../services/queue.mjs');
        upsertCheckpoint(db, { runId, lastPhase: 'resume_gen_end', inputsPath: '/tmp/h1.json' });
        return { exitCode: 143, error: 'claude -p exit 143' };
      },
      notify: (msg) => notifications.push(msg),
      isShuttingDown: () => true,
    });
    assert.equal(r.action, 'shutdown_interrupt');
    assert.equal(r.lastPhase, 'resume_gen_end');
    // Queue must stay 'running' (NOT 'failed' and NOT 'queued') so next-boot analyzeRebootState sees state='resume'.
    const queueRow = db.prepare('SELECT status FROM queue WHERE id=?').get(qid);
    assert.equal(queueRow.status, 'running', 'queue must stay running so resume engages on next boot');
    // Run must stay 'running' (NOT 'fail') so it can be resumed.
    const runRow = db.prepare('SELECT status, ended_at FROM runs WHERE queue_id=?').get(qid);
    assert.equal(runRow.status, 'running');
    assert.equal(runRow.ended_at, null);
    // Checkpoint must NOT be deleted.
    const cp = db.prepare('SELECT last_phase FROM checkpoints WHERE run_id=?').get(r.runId);
    assert.equal(cp.last_phase, 'resume_gen_end');
    // User notified about the pause.
    assert.ok(notifications.some(n => /⏸️.*paused.*resume_gen_end/.test(n)));
  } finally { cleanup(); }
});

test('tickOnce: shutdown_interrupt does NOT fire when user cancelled the run (cancel path still works)', async () => {
  const { db, dir, cleanup } = fresh();
  try {
    const qid = insertQueueRow(db, { url: 'http://acme.com/job', urlHash: 'h1', addedBy: 1 });
    // User requested cancel before the SIGTERM hit.
    db.prepare('UPDATE queue SET cancel_requested=1 WHERE id=?').run(qid);
    const notifications = [];
    const r = await tickOnce({
      db, projectRoot: dir,
      capLimits: { dailyMax: 20, weeklyMax: 100 },
      gitSha: 'cafebabe',
      claudeModel: 'claude-opus-4-7',
      spawn: async () => ({ exitCode: 143, error: 'sigterm via cancel' }),
      notify: (msg) => notifications.push(msg),
      isShuttingDown: () => true,
    });
    // Cancel takes precedence over shutdown_interrupt because the user's intent wins.
    assert.equal(r.action, 'completed_cancelled');
    const queueRow = db.prepare('SELECT status FROM queue WHERE id=?').get(qid);
    assert.equal(queueRow.status, 'cancelled');
  } finally { cleanup(); }
});

test('tickOnce: skips PDF upload when notifyChatId is 0 (test default), still marks done', async () => {
  const { db, dir, cleanup } = fresh();
  try {
    // Write a fake PDF on disk so existsSync() returns true.
    const { writeFileSync, mkdirSync } = await import('node:fs');
    mkdirSync(`${dir}/resumes/yash`, { recursive: true });
    const pdfPath = `${dir}/resumes/yash/test.pdf`;
    writeFileSync(pdfPath, '%PDF-1.4 fake');
    insertQueueRow(db, { url: 'http://acme.com/job', urlHash: 'h1', addedBy: 1 });
    const r = await tickOnce({
      db, projectRoot: dir,
      capLimits: { dailyMax: 20, weeklyMax: 100 },
      gitSha: 'cafebabe',
      claudeModel: 'claude-opus-4-7',
      spawn: async () => ({ exitCode: 0, slug: 'Acme', score: 90, resumePdf: pdfPath }),
      notify: () => {},
      // Default notifyChatId=0 → upload should be skipped, no telegram-client import attempted.
    });
    assert.equal(r.action, 'completed_ok');
    const queueRow = db.prepare('SELECT status FROM queue ORDER BY id DESC LIMIT 1').get();
    assert.equal(queueRow.status, 'done', 'success path still marks queue done even with no Telegram chat');
  } finally { cleanup(); }
});

test('tickOnce: when notifyChatId is set, sendDocument receives it (regression for 2026-05-24 prod bug)', async () => {
  const { db, dir, cleanup } = fresh();
  try {
    const { writeFileSync, mkdirSync } = await import('node:fs');
    mkdirSync(`${dir}/resumes/yash`, { recursive: true });
    const pdfPath = `${dir}/resumes/yash/test.pdf`;
    writeFileSync(pdfPath, '%PDF-1.4 fake');

    // Stand up a mock Telegram server so we can observe the request body.
    const http = await import('node:http');
    const captured = [];
    const server = await new Promise((resolve) => {
      const s = http.createServer((req, res) => {
        let body = '';
        req.on('data', c => { body += c; });
        req.on('end', () => {
          captured.push({ url: req.url, body });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, result: { message_id: 1 } }));
        });
      });
      s.listen(0, '127.0.0.1', () => resolve(s));
    });
    const port = server.address().port;
    process.env.TELEGRAM_BOT_TOKEN = 'test-tok';
    process.env.TELEGRAM_API_BASE = `http://127.0.0.1:${port}/bot`;

    insertQueueRow(db, { url: 'http://acme.com/job', urlHash: 'h1', addedBy: 1 });
    const r = await tickOnce({
      db, projectRoot: dir,
      capLimits: { dailyMax: 20, weeklyMax: 100 },
      gitSha: 'cafebabe',
      claudeModel: 'claude-opus-4-7',
      spawn: async () => ({ exitCode: 0, slug: 'Acme', score: 90, resumePdf: pdfPath }),
      notify: () => {},
      notifyChatId: 999000111,  // fake numeric chatId for test (never use a real one — secret scanner flags it as PII).
    });
    server.close();

    assert.equal(r.action, 'completed_ok');
    // At least one request to /sendDocument with the correct chat_id in the multipart body.
    const docReq = captured.find(c => c.url.endsWith('/sendDocument'));
    assert.ok(docReq, 'expected at least one POST to /sendDocument');
    assert.ok(
      docReq.body.includes('name="chat_id"') && docReq.body.includes('999000111'),
      'multipart body must include chat_id form-field with the real numeric chatId, not "undefined"',
    );
    assert.ok(!docReq.body.includes('undefined'), 'multipart body must not contain the string "undefined"');
  } finally { cleanup(); }
});

test('tickOnce: shutdown_interrupt does NOT fire when spawn exits cleanly (success path still works)', async () => {
  const { db, dir, cleanup } = fresh();
  try {
    insertQueueRow(db, { url: 'http://acme.com/job', urlHash: 'h1', addedBy: 1 });
    const notifications = [];
    const r = await tickOnce({
      db, projectRoot: dir,
      capLimits: { dailyMax: 20, weeklyMax: 100 },
      gitSha: 'cafebabe',
      claudeModel: 'claude-opus-4-7',
      spawn: async () => ({ exitCode: 0, slug: 'Acme', score: 90 }),
      notify: (msg) => notifications.push(msg),
      // Even though shutdown is in progress, success completes normally.
      isShuttingDown: () => true,
    });
    assert.equal(r.action, 'completed_ok');
    const queueRow = db.prepare('SELECT status FROM queue ORDER BY id DESC LIMIT 1').get();
    assert.equal(queueRow.status, 'done');
  } finally { cleanup(); }
});
