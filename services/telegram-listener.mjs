// services/telegram-listener.mjs
// Telegram long-poll listener daemon.
//
// Exports:
//   ALLOWLIST_REJECT — Symbol returned when update.message.from.id is not in the allowlist.
//   parseCommand(text) — { cmd, args } parser.
//   handleUpdate({ update, db, allowlist, notifyChatId, send, tenantLabel? }) — async dispatcher.
//   resolveQueueDbPath(env, projectRoot) — env-aware DB-path resolver (mirrors orchestrator).
//   assertTenantDbConsistency({ tenant, dbPath }) — fail-fast guard against cross-tenant DB writes.
//   main() — daemon entry point; long-poll loop.
//
// Env (used by main() only):
//   TELEGRAM_BOT_TOKEN         — required
//   TELEGRAM_ALLOWLIST         — CSV of integer user IDs (required, or exit 5)
//   TELEGRAM_NOTIFY_CHAT_ID    — numeric chat ID for outbound notifications (required, or exit 5)
//   WORK_QUEUE_DB              — optional, absolute or relative-to-PROJECT_ROOT path to the queue DB
//                                (must match orchestrator's value within the same tenant).
//   TENANT                     — optional tenant tag ('shivani' for the Shivani twin; unset = Yash).
//   TENANT_LABEL               — optional user-facing tenant label used as a /add reply prefix.

import crypto from 'node:crypto';
import { join, isAbsolute, resolve } from 'node:path';
import { validateUrl } from './url-validate.mjs';
import { checkDuplicate } from './dedup.mjs';
import { insertQueueRow, requestCancel, selectQueueLen, upsertTelegramOffset, selectTelegramOffset, readdQueueRow, ReaddError } from './queue.mjs';
import { notifyReady, notifyStopping, startWatchdogPinger } from './sd-notify.mjs';
import { createLogger } from './logger.mjs';

// Tenants whose data must NEVER land in the default (Yash) queue. Extend this
// list when adding a new tenant — the consistency guard uses it symmetrically.
const KNOWN_SIBLING_TENANTS = ['shivani'];

const defaultLogger = createLogger({ service: 'telegram-listener' });

// ── resolveQueueDbPath ──────────────────────────────────────────────────────

/**
 * Resolve the SQLite queue DB path the listener should open.
 *
 * Mirrors services/pipeline-orchestrator.mjs main()'s logic so the two daemons
 * always agree on which file is the queue DB. The previous hardcoded
 * `${projectRoot}/ops/work-queue.db` caused the Shivani listener to write into
 * the Yash DB even though Shivani's systemd unit set WORK_QUEUE_DB correctly.
 *
 * @param {Record<string, string|undefined>} env  — typically process.env
 * @param {string} projectRoot                    — used when env value is relative/missing
 * @returns {string} absolute path
 */
export function resolveQueueDbPath(env, projectRoot) {
  const raw = env && env.WORK_QUEUE_DB;
  if (!raw) return resolve(projectRoot, 'ops/work-queue.db');
  return isAbsolute(raw) ? raw : resolve(projectRoot, raw);
}

// ── assertTenantDbConsistency ───────────────────────────────────────────────

/**
 * Refuse to start when TENANT and the resolved DB path disagree. This makes
 * the cross-tenant DB-routing bug structurally impossible: even a typo in a
 * systemd EnvironmentFile (e.g. WORK_QUEUE_DB pointing at the Yash DB from a
 * Shivani unit) is caught at process boot instead of silently corrupting
 * queue ownership.
 *
 * Rules:
 *   - tenant unset OR 'yash': dbPath must NOT contain any known sibling-tenant
 *     segment (e.g. `/shivani/`).
 *   - tenant === '<sibling>' (e.g. 'shivani'): dbPath MUST contain
 *     `/<sibling>/` as a path segment.
 *
 * @param {{ tenant: string|undefined, dbPath: string }} opts
 * @throws {Error} if the tenant and DB path are inconsistent.
 */
export function assertTenantDbConsistency({ tenant, dbPath }) {
  const t = (tenant || '').trim().toLowerCase();
  if (!t || t === 'yash') {
    for (const sibling of KNOWN_SIBLING_TENANTS) {
      if (dbPath.includes(`/${sibling}/`)) {
        throw new Error(
          `Tenant/DB mismatch: TENANT=${tenant ?? '(unset, treated as yash)'} ` +
          `but WORK_QUEUE_DB resolved to a path containing '/${sibling}/' (${dbPath}). ` +
          `Refusing to start to prevent cross-tenant queue writes.`,
        );
      }
    }
    return;
  }
  // Non-Yash tenant: dbPath must contain its own segment.
  const expected = `/${t}/`;
  if (!dbPath.includes(expected)) {
    throw new Error(
      `Tenant/DB mismatch: TENANT=${t} expects WORK_QUEUE_DB to contain '${expected}', ` +
      `but it resolved to '${dbPath}'. ` +
      `Refusing to start to prevent cross-tenant queue writes.`,
    );
  }
}

// ── Public sentinel ─────────────────────────────────────────────────────────

export const ALLOWLIST_REJECT = Symbol('ALLOWLIST_REJECT');

// ── parseCommand ────────────────────────────────────────────────────────────

/**
 * Parse a Telegram message text into { cmd, args }.
 * If the text starts with '/', cmd is the command word (without '/'); otherwise cmd is ''.
 * args is the remainder (trimmed).
 *
 * @param {string} text
 * @returns {{ cmd: string, args: string }}
 */
export function parseCommand(text) {
  if (!text || !text.startsWith('/')) return { cmd: '', args: (text || '').trim() };
  const [head, ...rest] = text.trim().split(/\s+/);
  const cmd = head.slice(1).toLowerCase();   // strip leading '/'
  const args = rest.join(' ').trim();
  return { cmd, args };
}

// ── handlePatterns ──────────────────────────────────────────────────────────

/**
 * Pure helper: query top-10 failure_patterns rows and format as markdown table.
 * @param {import('better-sqlite3').Database} db
 * @returns {string} markdown reply
 */
export function handlePatterns(db) {
  const rows = db.prepare(`
    SELECT signature, hits, last_seen, suppressed
    FROM failure_patterns
    ORDER BY hits DESC LIMIT 10
  `).all();
  if (rows.length === 0) return '*No patterns learned yet.*';
  const header = '| signature | hits | last_seen | suppressed |\n|---|---|---|---|';
  const body = rows.map(r =>
    `| \`${r.signature}\` | ${r.hits} | ${r.last_seen.slice(0, 10)} | ${r.suppressed ? '✓' : ''} |`
  ).join('\n');
  return `*Top 10 failure patterns:*\n\n${header}\n${body}`;
}

// ── handleUpdate ────────────────────────────────────────────────────────────

/**
 * Dispatch a single Telegram update.
 *
 * @param {{ update: object, db: object, allowlist: Set<number>, notifyChatId: number, send: function }} opts
 * @returns {Promise<symbol|null|object>} ALLOWLIST_REJECT | null (no-message update) | dispatch result
 */
// ── handleSuppress ───────────────────────────────────────────────────────────

/**
 * Pure helper: set suppressed=1 on a failure_pattern row by signature.
 * Returns a user-facing reply string (never throws).
 * @param {import('better-sqlite3').Database} db
 * @param {string} signature
 * @returns {string}
 */
export function handleSuppress(db, signature) {
  const r = db.prepare('UPDATE failure_patterns SET suppressed=1 WHERE signature=?').run(signature);
  if (r.changes === 0) return `❌ Signature \`${signature}\` not found.`;
  return `✅ Suppressed \`${signature}\`. Future runs won't inject its hint.`;
}

// ── handleUnpause ─────────────────────────────────────────────────────────────

/**
 * Pure helper: clear paused=1 on all queue rows, resuming processing.
 * Returns a user-facing reply string (never throws).
 * @param {import('better-sqlite3').Database} db
 * @returns {string}
 */
export function handleUnpause(db) {
  const r = db.prepare('UPDATE queue SET paused=0 WHERE paused=1').run();
  return `✅ Queue resumed; ${r.changes} row(s) unpaused.`;
}

export async function handleUpdate({ update, db, allowlist, notifyChatId, send, logger = defaultLogger, tenantLabel }) {
  // When tenantLabel is set, all /add replies are prefixed `[<label>] ...` so a
  // misrouted /add (user picks the wrong bot from a look-alike username) is
  // immediately visible in Telegram rather than silently being processed by the
  // wrong tenant. Yash backward compatibility: omit tenantLabel → no prefix.
  const tag = tenantLabel ? `[${tenantLabel}] ` : '';
  const message = update.message;

  // Updates with no message object at all → ignore silently.
  if (!message) return null;

  // §8.3 check 1: per-message user allowlist check fires BEFORE text guard.
  // Not replying to non-allowlisted senders — replying would confirm the bot to scanners.
  const fromId = message.from && message.from.id;
  if (!allowlist.has(fromId)) {
    logger.warn({ event: 'allowlist_reject', from_user_id: fromId, update_id: update.update_id }, 'rejected non-allowlisted sender');
    return ALLOWLIST_REJECT;
  }

  // Updates with no text body (e.g. photos, stickers, edited_message) → ignore.
  if (!message.text) return null;

  const chatId = message.chat && message.chat.id;
  const { cmd, args } = parseCommand(message.text);

  switch (cmd) {
    case 'start':
      await send('👋 Hi! Send /help for a list of commands.');
      return { cmd };

    case 'help':
      await send(
        '📋 Commands:\n' +
        '/add <url>        — Queue a job URL for processing\n' +
        '/status           — Show current pipeline status\n' +
        '/queue            — List up to 10 queued URLs\n' +
        '/cancel <id>      — Cancel a queued or running job\n' +
        '/readd <queue_id> — Re-queue a previously-done URL (bypasses dedup)\n' +
        '/patterns         — List top 10 learned failure patterns\n' +
        '/suppress <sig>   — Suppress a failure pattern by signature\n' +
        '/unpause          — Resume processing (clears all paused rows)\n' +
        '/help             — Show this message'
      );
      return { cmd };

    case 'status': {
      const waiting = selectQueueLen(db, 'queued');
      const running = selectQueueLen(db, 'running');
      await send(`📊 Status\nQueue: ${waiting} waiting · ${running} running`);
      return { cmd };
    }

    case 'queue': {
      const rows = db.prepare(
        `SELECT id, url, added_at FROM queue WHERE status='queued' ORDER BY id LIMIT 10`
      ).all();
      if (rows.length === 0) {
        await send('📭 Queue is empty.');
      } else {
        const lines = rows.map(r => {
          let host = r.url;
          try { host = new URL(r.url).hostname; } catch { /* keep raw */ }
          return `#${r.id}  ${host}`;
        });
        await send('📋 Next in queue:\n' + lines.join('\n'));
      }
      return { cmd };
    }

    case 'add': {
      const url = args.trim();
      if (!url) {
        await send('❌ Usage: /add <url>');
        return { cmd, error: 'missing_url' };
      }

      // Validate URL (SSRF-safe).
      const validation = validateUrl(url);
      if (!validation.ok) {
        await send(`❌ Invalid URL: ${validation.error}`);
        return { cmd, error: validation.error };
      }

      // Dedup check (single logical txn via dedup.mjs).
      const urlHash = crypto.createHash('sha256').update(url).digest('hex').slice(0, 16);
      const dup = checkDuplicate(db, url);
      if (dup.type === 'in_queue') {
        await send(`${tag}ℹ️ Already in queue as #${dup.existingId}`);
        return { cmd, dedup: dup.type };
      }
      if (dup.type === 'recent_success') {
        await send(`${tag}ℹ️ Already done in last 24h (run #${dup.runId}). Send /readd <queue_id> to force.`);
        return { cmd, dedup: dup.type };
      }

      // Insert.
      const queueId = insertQueueRow(db, {
        url,
        urlHash,
        addedBy:      fromId,
        telegramMsgId: message.message_id,
      });

      // Update Telegram offset state in the same logical operation.
      // (The real long-poll loop does this in a single txn; here we do it post-insert.)
      if (chatId && update.update_id) {
        upsertTelegramOffset(db, chatId, update.update_id);
      }

      let host = url;
      try { host = new URL(url).hostname; } catch { /* keep raw */ }
      const waiting = selectQueueLen(db, 'queued');
      await send(`${tag}✅ Queued #${queueId}: ${host} (position ${waiting})`);
      return { cmd, queueId };
    }

    case 'patterns': {
      await send(handlePatterns(db));
      return { cmd };
    }

    case 'suppress': {
      if (!args) { await send('Usage: /suppress <signature>'); return { cmd }; }
      await send(handleSuppress(db, args));
      return { cmd };
    }

    case 'unpause': {
      await send(handleUnpause(db));
      return { cmd };
    }

    case 'cancel': {
      const id = parseInt(args.trim(), 10);
      if (!Number.isFinite(id) || id <= 0) {
        await send('❌ Usage: /cancel <queue_id>');
        return { cmd, error: 'invalid_id' };
      }
      requestCancel(db, id);
      await send(`🛑 Cancel requested for #${id}; takes effect at next phase boundary.`);
      return { cmd, queueId: id };
    }

    case 'readd': {
      // Re-queue a previously-terminal URL. Bypasses the listener-level dedup
      // (`checkDuplicate`) by inserting a fresh queue row that carries the
      // source row's url/url_hash/added_by but starts at status=queued with
      // attempts=0. Source row is never mutated — audit history preserved.
      // Validation mirrors /cancel: parseInt strict-positive; reject 0 / -3
      // / 'abc' / '1.5' with a usage error. parseInt('1.5') returns 1, so we
      // additionally reject any arg containing a non-digit/sign character.
      const raw = args.trim();
      const idMatch = /^[1-9][0-9]*$/.test(raw);
      const id = parseInt(raw, 10);
      if (!raw || !idMatch || !Number.isFinite(id) || id <= 0) {
        await send(`${tag}❌ Usage: /readd <queue_id>`);
        return { cmd, error: 'invalid_id' };
      }
      try {
        const { newQueueId, hostname } = readdQueueRow(db, id);
        logger.info({
          event: 'readd', source_queue_id: id, new_queue_id: newQueueId, url_hostname: hostname,
        }, 'readd: re-queued terminal row');
        await send(`${tag}🔁 Re-queued #${id} as #${newQueueId}: ${hostname}`);
        return { cmd, queueId: id, newQueueId };
      } catch (e) {
        if (!(e instanceof ReaddError)) throw e;
        if (e.code === 'not_found') {
          await send(`${tag}❌ No queue row #${id}`);
          return { cmd, error: 'not_found', queueId: id };
        }
        if (e.code === 'still_running') {
          await send(`${tag}❌ Queue #${id} is still running — use /cancel ${id} first`);
          return { cmd, error: 'still_running', queueId: id };
        }
        if (e.code === 'already_queued') {
          await send(`${tag}ℹ️ Queue #${id} is already queued (position ${e.existingPosition}) — nothing to re-add`);
          return { cmd, error: 'already_queued', queueId: id };
        }
        throw e;
      }
    }

    default: {
      // Unknown command — give a hint.
      if (cmd) {
        await send(`❓ Unknown command /${cmd}. Send /help for a list of commands.`);
      }
      return { cmd: cmd || null };
    }
  }
}

// ── main (daemon) ────────────────────────────────────────────────────────────

/**
 * Long-poll daemon.  Reads env, builds allowlist, opens DB, loops.
 * Exits with code 5 if TELEGRAM_ALLOWLIST or TELEGRAM_NOTIFY_CHAT_ID is missing.
 */
export async function main() {
  // Hard-coded allowlist enforcement — defense in depth.
  const allowlistEnv  = process.env.TELEGRAM_ALLOWLIST  || '';
  const notifyChatEnv = process.env.TELEGRAM_NOTIFY_CHAT_ID || '';

  if (!allowlistEnv.trim() || !notifyChatEnv.trim()) {
    defaultLogger.fatal({ event: 'config_missing' }, 'TELEGRAM_ALLOWLIST and TELEGRAM_NOTIFY_CHAT_ID must both be set');
    process.exit(5);
  }

  const allowlist = new Set(
    allowlistEnv.split(',').map(s => parseInt(s.trim(), 10)).filter(n => Number.isFinite(n) && n > 0)
  );
  if (allowlist.size === 0) {
    defaultLogger.fatal({ event: 'config_invalid', reason: 'allowlist_empty' }, 'TELEGRAM_ALLOWLIST parsed to empty set');
    process.exit(5);
  }
  const notifyChatId = parseInt(notifyChatEnv.trim(), 10);

  // Lazy-import DB + telegram-client so unit tests can import this module without them.
  const { initDb } = await import('./db.mjs');
  const { getUpdates, sendMessage } = await import('./telegram-client.mjs');

  const projectRoot = process.env.PROJECT_ROOT || process.cwd();
  const tenant = (process.env.TENANT || '').trim().toLowerCase() || undefined;
  const tenantLabel = (process.env.TENANT_LABEL || '').trim() || undefined;

  // Tenant-aware DB-path resolution. WORK_QUEUE_DB MUST match the value the
  // sibling orchestrator opens — assertTenantDbConsistency below fails-fast on
  // any mismatch so the cross-tenant routing bug is structurally impossible.
  const dbPath = resolveQueueDbPath(process.env, projectRoot);
  assertTenantDbConsistency({ tenant, dbPath });
  const db = initDb(dbPath);

  // Per-process logger: now carries the tenant tag so journald lines from the
  // Yash and Shivani listeners are no longer indistinguishable.
  const logger = createLogger({ service: 'telegram-listener', tenant });

  const send = (text) => sendMessage(text, { chatId: notifyChatId });

  // Note: allowlist user IDs and notifyChatId are PII; log only count + presence flag.
  logger.info({
    event: 'listener_started',
    allowlist_size: allowlist.size,
    notify_chat_configured: notifyChatId > 0,
    db_path: dbPath,
    tenant_label: tenantLabel,
  }, 'telegram-listener started');

  // Mark service READY for systemd Type=notify, then start the WatchdogSec= pinger.
  // Unit file declares WatchdogSec=90 → ping every 30s (≈1/3 of the timeout).
  await notifyReady('listening');
  const stopWatchdog = startWatchdogPinger(30_000);

  let running = true;
  const onSignal = (sig) => {
    if (!running) return;
    running = false;
    logger.info({ event: 'shutdown_requested', signal: sig }, 'draining for clean exit');
  };
  process.on('SIGTERM', () => onSignal('SIGTERM'));
  process.on('SIGINT', () => onSignal('SIGINT'));

  let offset = selectTelegramOffset(db, notifyChatId);
  let backoffMs = 0;

  // Long-poll loop. `running` is flipped to false by SIGTERM/SIGINT; the loop
  // exits at the next iteration boundary (≤ 30s of getUpdates() + post-handling).
  while (running) {
    if (backoffMs > 0) {
      // Sleep is interrupted by signal via the running flag check on each tick.
      const sleptMs = await sleepUntilSignal(backoffMs, () => !running);
      if (!running) break;
      if (sleptMs < backoffMs) backoffMs = 0;
    }

    let updates;
    try {
      updates = await getUpdates({ offset, timeout: 25 });
      backoffMs = 0;   // reset on success
    } catch (err) {
      if (!running) break;
      const nextBackoff = Math.min((backoffMs || 5_000) * 3, 15 * 60_000);
      logger.error({ event: 'long_poll_error', backoff_ms: nextBackoff, err }, 'getUpdates failed');
      backoffMs = nextBackoff;
      continue;
    }

    for (const update of updates) {
      try {
        await handleUpdate({ update, db, allowlist, notifyChatId, send, logger, tenantLabel });
      } catch (err) {
        logger.error({ event: 'handle_update_failed', update_id: update.update_id, err }, 'handleUpdate threw');
      }

      offset = update.update_id + 1;
      upsertTelegramOffset(db, notifyChatId, update.update_id);
    }
  }

  // Drain: tell systemd we're stopping, stop watchdog, close DB.
  await notifyStopping('shutting down');
  stopWatchdog();
  try {
    const { closeDb } = await import('./db.mjs');
    closeDb(db);
  } catch (e) {
    logger.warn({ event: 'closedb_failed', err: e }, 'closeDb threw');
  }
  logger.info({ event: 'daemon_exit' }, 'telegram-listener exited cleanly');
}

// Interruptible sleep: resolves when `ms` elapse or `signal()` returns true.
async function sleepUntilSignal(ms, signal) {
  const start = Date.now();
  const stepMs = 250;
  while (Date.now() - start < ms) {
    if (signal()) return Date.now() - start;
    await new Promise(r => setTimeout(r, Math.min(stepMs, ms - (Date.now() - start))));
  }
  return ms;
}

// ── Entry point ──────────────────────────────────────────────────────────────

// Run main() when executed directly (not when imported by tests).
const isMain = process.argv[1] && process.argv[1].endsWith('telegram-listener.mjs');
if (isMain) {
  main().catch(err => {
    defaultLogger.fatal({ event: 'daemon_fatal', err }, 'unhandled error in main()');
    process.exit(1);
  });
}
