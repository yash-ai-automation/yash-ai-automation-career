export function buildTrace(runRow, events = []) {
  return {
    id: `trace-${runRow.id}`,
    type: 'trace-create',
    timestamp: runRow.created_at,
    body: {
      id: `run-${runRow.id}`,
      name: 'yash-resume-pipeline',
      input: runRow.url,
      output: runRow.pdf_path,
      metadata: {
        git_sha: runRow.git_sha,
        exit_code: runRow.exit_code,
        tokens_in: runRow.tokens_in,
        tokens_out: runRow.tokens_out
      }
    },
    observations: events.map((e, i) => ({
      id: `obs-${runRow.id}-${i}`,
      traceId: `trace-${runRow.id}`,
      name: e.phase,
      startTime: e.start,
      endTime: e.end
    }))
  };
}

import { getCursor, setCursor } from './db.mjs';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

function readEvents(runsDir, runId) {
  const path = join(runsDir, String(runId), 'events.jsonl');
  if (!existsSync(path)) return [];
  try {
    return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
  } catch {
    return [];  // malformed → skip events but emit trace anyway
  }
}

export async function runExporter({ db, httpClient, host, publicKey, secretKey, batchSize = 50, runsDir }) {
  const cursor = getCursor(db, 'exporter.last_run_id');
  let advanced = 0;
  let lastId = cursor;
  while (true) {
    const rows = db.prepare(`
      SELECT id, url, status,
             resume_pdf AS pdf_path,
             git_sha,
             CASE status WHEN 'done' THEN 0 ELSE 1 END AS exit_code,
             tokens_in, tokens_out,
             started_at AS created_at
      FROM runs
      WHERE id > ? ORDER BY id LIMIT ?
    `).all(lastId, batchSize);
    if (rows.length === 0) break;
    const batch = rows.map(r => buildTrace(r, readEvents(runsDir, r.id)));
    const ok = await postBatch({ httpClient, host, publicKey, secretKey }, batch);
    if (!ok) break;
    lastId = rows[rows.length - 1].id;
    setCursor(db, 'exporter.last_run_id', lastId);
    advanced += rows.length;
    if (rows.length < batchSize) break;
  }
  return { advanced, finalCursor: lastId };
}

export async function postBatch({ httpClient, host, publicKey, secretKey }, batch) {
  const authHeader = 'Basic ' + Buffer.from(`${publicKey}:${secretKey}`).toString('base64');
  try {
    const res = await httpClient(`${host}/api/public/ingestion`, {
      method: 'POST',
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ batch })
    });
    if (res.status === 401 || res.status === 403) {
      throw new Error(`Langfuse auth failed (status ${res.status})`);
    }
    return res.ok;
  } catch (e) {
    if (/auth/i.test(e.message)) throw e;
    return false;
  }
}
