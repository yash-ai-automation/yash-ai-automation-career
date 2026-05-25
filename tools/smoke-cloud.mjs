#!/usr/bin/env node
import { execSync } from 'node:child_process';
import { initDb, topHintsByHost } from '../services/db.mjs';
import { runExporter } from '../services/exporter.mjs';

const args = process.argv.slice(2);
// Support both --phase=A and --phase A
const phaseEq = args.find(a => a.startsWith('--phase='));
const phaseIdx = args.indexOf('--phase');
const phase = phaseEq
  ? phaseEq.split('=')[1]
  : phaseIdx >= 0 ? args[phaseIdx + 1] : 'all';

async function smokePhaseA() {
  console.log('[smoke A] Hitting Langfuse Cloud Hobby with one synthetic trace...');
  const required = ['LANGFUSE_PUBLIC_KEY', 'LANGFUSE_SECRET_KEY', 'LANGFUSE_HOST'];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length) { console.error('Missing env:', missing); process.exit(1); }

  const db = initDb('/tmp/smoke-cloud.db');
  const q = db.prepare(`
    INSERT INTO queue (url, url_hash, added_at, added_by, status)
    VALUES ('https://smoke.test', 'smoke', ?, 1, 'done')
  `).run(new Date().toISOString());
  db.prepare(`
    INSERT OR IGNORE INTO runs (id, queue_id, url, status, resume_pdf, git_sha, tokens_in, tokens_out, started_at)
    VALUES (999999, ?, 'https://smoke.test', 'done', '/p.pdf', 'smoke', 1, 1, ?)
  `).run(q.lastInsertRowid, new Date().toISOString());

  const result = await runExporter({
    db, httpClient: fetch,
    host: process.env.LANGFUSE_HOST,
    publicKey: process.env.LANGFUSE_PUBLIC_KEY,
    secretKey: process.env.LANGFUSE_SECRET_KEY,
    runsDir: '/tmp'
  });

  if (result.advanced > 0) { console.log('[smoke A] OK — exported', result.advanced, 'trace(s)'); }
  else { console.error('[smoke A] FAIL — no rows advanced'); process.exit(2); }
  db.close();
}

async function smokePhaseB() {
  console.log('[smoke B] Verifying failure_patterns table is queryable...');
  const dbPath = process.env.DB_PATH || 'ops/work-queue.db';
  const db = initDb(dbPath);
  try {
    const cols = db.prepare("PRAGMA table_info(failure_patterns)").all();
    if (cols.length === 0) { console.error('[smoke B] FAIL — failure_patterns table missing'); process.exit(2); }
    const hints = topHintsByHost(db, 'lever.co', 3);
    console.log(`[smoke B] OK — table present (${cols.length} cols), returned ${hints.length} hint(s) for lever.co`);
  } finally { db.close(); }
}

async function smokePhaseC() {
  console.log('[smoke C] Sending one Healthchecks.io ping + verifying response...');
  if (!process.env.HEALTHCHECK_PING_URL) {
    console.error('[smoke C] FAIL — HEALTHCHECK_PING_URL not set');
    process.exit(1);
  }
  try {
    const res = await fetch(process.env.HEALTHCHECK_PING_URL);
    if (res.ok) {
      console.log('[smoke C] OK — Healthchecks responded', res.status);
    } else {
      console.error('[smoke C] FAIL — status', res.status);
      process.exit(2);
    }
  } catch (e) {
    console.error('[smoke C] FAIL —', e.message);
    process.exit(3);
  }
}

async function smokePhaseD() {
  console.log('[smoke D] Running promptfoo eval on one fixture...');
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('[smoke D] FAIL — ANTHROPIC_API_KEY not set');
    process.exit(1);
  }
  try {
    execSync('npx promptfoo eval -c tests/promptfoo.yaml --filter-pattern=lever-ml-engineer', { stdio: 'inherit' });
    console.log('[smoke D] OK');
  } catch (e) {
    console.error('[smoke D] FAIL —', e.message);
    process.exit(2);
  }
}

async function main() {
  if (phase === 'A' || phase === 'all') {
    await smokePhaseA();
  }
  if (phase === 'B' || phase === 'all') {
    await smokePhaseB();
  }
  if (phase === 'C' || phase === 'all') {
    await smokePhaseC();
  }
  if (phase === 'D' || phase === 'all') {
    await smokePhaseD();
  }
}

main().catch(e => { console.error(e); process.exit(99); });
