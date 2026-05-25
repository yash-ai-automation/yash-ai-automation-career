#!/usr/bin/env node
import { initDb } from '../services/db.mjs';
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

async function main() {
  if (phase === 'A' || phase === 'all') {
    await smokePhaseA();
  } else if (phase === 'B' || phase === 'C' || phase === 'D') {
    console.error(`[smoke ${phase}] Not yet implemented (added in later phase tasks).`);
    process.exit(3);
  }
}

main().catch(e => { console.error(e); process.exit(99); });
