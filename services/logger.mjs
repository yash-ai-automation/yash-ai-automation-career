// services/logger.mjs
// Structured pino logger factory. Used by both daemons (telegram-listener,
// pipeline-orchestrator) so every log line has the same shape and PII never
// leaks into logs.
//
// Base fields on every line: { service, pid, git_sha, hostname, level, time, msg }
// PII redaction: chatId/chat_id and bot tokens become "[REDACTED]" automatically.
// Env: LOG_LEVEL (default "info"). GIT_SHA preferred; falls back to `git rev-parse HEAD`
// (one-shot at import), then "unknown" if not in a git repo.

import { pino } from 'pino';
import { execSync } from 'node:child_process';

const REDACT_PATHS = [
  'chatId', 'chat_id',
  'token', 'bot_token', 'TELEGRAM_BOT_TOKEN', 'LOGTAIL_TOKEN',
  '*.chatId', '*.chat_id',
  '*.token', '*.bot_token',
];

const SUPPORTED_TRANSPORTS = ['none', 'betterstack'];

function defaultRunGitSha() {
  return execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
}

export function detectGitSha(env = process.env, runCmd = defaultRunGitSha) {
  if (env.GIT_SHA) return env.GIT_SHA;
  try {
    const out = runCmd();
    return out && out.length > 0 ? out : 'unknown';
  } catch {
    return 'unknown';
  }
}

export function buildTransportOpts(env = process.env) {
  const t = (env.LOG_TRANSPORT || '').toLowerCase();
  if (!t || t === 'none') return null;
  if (t === 'betterstack') {
    const token = env.LOGTAIL_TOKEN;
    if (!token) {
      throw new Error('LOG_TRANSPORT=betterstack requires LOGTAIL_TOKEN');
    }
    return { target: '@logtail/pino', options: { sourceToken: token } };
  }
  throw new Error(
    `Unknown LOG_TRANSPORT=${env.LOG_TRANSPORT} (supported: ${SUPPORTED_TRANSPORTS.join(', ')})`
  );
}

export function createLogger({ service, tenant } = {}, destination) {
  if (!service) {
    throw new Error('createLogger: `service` is required');
  }
  const base = { pid: process.pid, service, git_sha: detectGitSha() };
  // Only attach `tenant` when explicitly provided so existing Yash log lines stay
  // byte-identical (no `tenant: undefined` noise in journald / BetterStack).
  if (tenant) base.tenant = tenant;
  const opts = {
    level: process.env.LOG_LEVEL || 'info',
    base,
    timestamp: pino.stdTimeFunctions.epochTime,
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    formatters: { level(label) { return { level: label }; } },
    serializers: { err: pino.stdSerializers.err },
  };
  if (destination) return pino(opts, destination);
  const transport = buildTransportOpts();
  if (transport) return pino({ ...opts, transport });
  return pino(opts);
}
