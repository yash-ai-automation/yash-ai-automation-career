// services/queue.mjs
// Thin DB ops for queue + runs + checkpoints + telegram_state.
// All inputs are validated by callers; this file does no business logic.

const ISO = () => new Date().toISOString();

// --- queue ---

export function insertQueueRow(db, { url, urlHash, addedBy, telegramMsgId = null }) {
  const r = db.prepare(`
    INSERT INTO queue(url, url_hash, added_at, added_by, telegram_msg_id, status)
    VALUES(?, ?, ?, ?, ?, 'queued')
  `).run(url, urlHash, ISO(), addedBy, telegramMsgId);
  return Number(r.lastInsertRowid);
}

// ── /readd <queue_id> support ───────────────────────────────────────────────

/**
 * Typed error from `readdQueueRow`. `code` is one of:
 *   - 'not_found'      — no row with this id
 *   - 'still_running'  — source is running; caller should /cancel first
 *   - 'already_queued' — source is already queued; `existingPosition` is set
 *
 * The listener inspects `code` to pick the right user-facing reply.
 */
export class ReaddError extends Error {
  constructor(code, queueId, extra = {}) {
    super(`readd ${code} for queue_id=${queueId}`);
    this.name = 'ReaddError';
    this.code = code;
    this.queueId = queueId;
    Object.assign(this, extra);
  }
}

/**
 * Re-queue a previously-terminal URL (the contract advertised by /add's
 * dedup-check reply: "Send /readd <queue_id> to force"). Inserts a NEW row
 * inheriting url + url_hash + added_by from the source; resets attempts,
 * cancel_requested, assigned_at. NEVER mutates or deletes the source row
 * (audit history preserved).
 *
 * @returns {{ newQueueId: number, url: string, hostname: string }}
 * @throws  {ReaddError}
 */
export function readdQueueRow(db, sourceQueueId) {
  const src = db.prepare(`SELECT url, url_hash, added_by, status FROM queue WHERE id=?`).get(sourceQueueId);
  if (!src) throw new ReaddError('not_found', sourceQueueId);
  if (src.status === 'running') throw new ReaddError('still_running', sourceQueueId);
  if (src.status === 'queued') {
    // Position is the count of queued rows with id <= this id (1-based).
    const row = db.prepare(`SELECT COUNT(*) AS n FROM queue WHERE status='queued' AND id <= ?`).get(sourceQueueId);
    throw new ReaddError('already_queued', sourceQueueId, { existingPosition: row.n });
  }
  // Terminal source (done / failed / cancelled / dedup_skipped) → insert fresh row.
  const r = db.prepare(`
    INSERT INTO queue(url, url_hash, added_at, added_by, telegram_msg_id, status)
    VALUES(?, ?, ?, ?, NULL, 'queued')
  `).run(src.url, src.url_hash, ISO(), src.added_by);
  const newQueueId = Number(r.lastInsertRowid);
  let hostname = src.url;
  try { hostname = new URL(src.url).hostname || src.url; } catch { /* keep raw */ }
  return { newQueueId, url: src.url, hostname };
}

export function selectNextQueued(db) {
  return db.prepare(`SELECT * FROM queue WHERE status='queued' AND paused=0 ORDER BY id LIMIT 1`).get();
}

export function markQueueRunning(db, id) {
  db.prepare(`UPDATE queue SET status='running', assigned_at=? WHERE id=?`).run(ISO(), id);
}

export function markQueueDone(db, id) {
  db.prepare(`UPDATE queue SET status='done', completed_at=? WHERE id=?`).run(ISO(), id);
}

export function markQueueFailed(db, id) {
  db.prepare(`UPDATE queue SET status='failed', completed_at=? WHERE id=?`).run(ISO(), id);
}

export function markQueueCancelled(db, id) {
  db.prepare(`UPDATE queue SET status='cancelled', completed_at=? WHERE id=?`).run(ISO(), id);
}

export function markQueueDedupSkipped(db, id) {
  db.prepare(`UPDATE queue SET status='dedup_skipped', completed_at=? WHERE id=?`).run(ISO(), id);
}

export function requestCancel(db, id) {
  db.prepare(`UPDATE queue SET cancel_requested=1 WHERE id=? AND status IN ('queued','running')`).run(id);
}

export function isCancelRequested(db, id) {
  const r = db.prepare(`SELECT cancel_requested FROM queue WHERE id=?`).get(id);
  return !!(r && r.cancel_requested);
}

export function selectQueueByUrlActive(db, url) {
  return db.prepare(`SELECT * FROM queue WHERE url=? AND status IN ('queued','running') ORDER BY id LIMIT 1`).get(url);
}

export function selectQueueLen(db, status = 'queued') {
  return db.prepare(`SELECT COUNT(*) AS n FROM queue WHERE status=?`).get(status).n;
}

export function findOrphanedRunning(db) {
  return db.prepare(`
    SELECT q.* FROM queue q
    WHERE q.status='running'
      AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.queue_id=q.id AND r.ended_at IS NULL)
      AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.queue_id=q.id AND r.status IN ('ok','done'))
  `).all();
}

export function repairOrphanedRunning(db, id) {
  db.prepare(`UPDATE queue SET status='queued', assigned_at=NULL WHERE id=?`).run(id);
}

// --- runs ---

export function insertRun(db, { queueId, url, startedAt }) {
  const r = db.prepare(`INSERT INTO runs(queue_id, url, started_at, status) VALUES(?, ?, ?, 'running')`).run(queueId, url, startedAt);
  return Number(r.lastInsertRowid);
}

export function updateRunStart(db, id, { gitSha, claudeModel }) {
  db.prepare(`UPDATE runs SET git_sha=?, claude_model=? WHERE id=?`).run(gitSha || null, claudeModel || null, id);
}

export function updateRunEnd(db, id, {
  endedAt = ISO(), status, score = null, slug = null, jdPath = null,
  resumePdf = null, coverLetterPdf = null, tokensIn = null, tokensOut = null,
  costUsd = null, phaseTimingsJson = null, error = null
}) {
  db.prepare(`
    UPDATE runs SET
      ended_at=?, status=?, score=?, slug=?, jd_path=?, resume_pdf=?, cover_letter_pdf=?,
      tokens_in=?, tokens_out=?, cost_usd=?, phase_timings_json=?, error=?
    WHERE id=?
  `).run(endedAt, status, score, slug, jdPath, resumePdf, coverLetterPdf,
         tokensIn, tokensOut, costUsd, phaseTimingsJson, error, id);
}

export function selectRunByQueueId(db, queueId) {
  return db.prepare(`SELECT * FROM runs WHERE queue_id=? ORDER BY id DESC LIMIT 1`).get(queueId);
}

export function selectRunInFlight(db, queueId) {
  return db.prepare(`SELECT * FROM runs WHERE queue_id=? AND status='running' AND ended_at IS NULL`).get(queueId);
}

export function selectRecentSuccess(db, url, hours = 24) {
  // hours is an integer modifier used inside the SQLite datetime() string.
  // Never pass user-supplied data here — always a hardcoded constant from dedup.mjs.
  return db.prepare(`
    SELECT * FROM runs
    WHERE url=? AND status='ok'
      AND started_at > datetime('now', ?)
    ORDER BY id DESC LIMIT 1
  `).get(url, `-${hours} hours`);
}

// status counts for cap enforcement
export function countByStatus(db, statuses, window) {
  const placeholders = statuses.map(() => '?').join(',');
  const dateClause = window === 'day'
    ? `date(started_at)=date('now')`
    : `strftime('%Y%V', started_at)=strftime('%Y%V','now')`;
  const r = db.prepare(`SELECT COUNT(*) AS n FROM runs WHERE status IN (${placeholders}) AND ${dateClause}`).get(...statuses);
  return r.n;
}

// --- checkpoints ---

export function upsertCheckpoint(db, { runId, lastPhase, inputsPath }) {
  db.prepare(`
    INSERT INTO checkpoints(run_id, last_phase, inputs_path, updated_at)
    VALUES(?, ?, ?, ?)
    ON CONFLICT(run_id) DO UPDATE SET last_phase=excluded.last_phase, inputs_path=excluded.inputs_path, updated_at=excluded.updated_at
  `).run(runId, lastPhase, inputsPath, ISO());
}

export function selectCheckpoint(db, runId) {
  return db.prepare(`SELECT * FROM checkpoints WHERE run_id=?`).get(runId);
}

export function deleteCheckpoint(db, runId) {
  db.prepare(`DELETE FROM checkpoints WHERE run_id=?`).run(runId);
}

// --- telegram_state ---

export function selectTelegramOffset(db, chatId) {
  const r = db.prepare(`SELECT last_update_id FROM telegram_state WHERE chat_id=?`).get(chatId);
  return r ? r.last_update_id : 0;
}

export function upsertTelegramOffset(db, chatId, lastUpdateId) {
  db.prepare(`
    INSERT INTO telegram_state(chat_id, last_update_id) VALUES(?, ?)
    ON CONFLICT(chat_id) DO UPDATE SET last_update_id=excluded.last_update_id
  `).run(chatId, lastUpdateId);
}
