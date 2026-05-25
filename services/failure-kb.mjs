import { URL } from 'node:url';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { upsertPattern } from './db.mjs';

function safeHost(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return 'unknown'; }
}

export const SIGNATURE_PATTERNS = [
  {
    name: 'scrapling:cloudflare',
    test: (err) => /scrapling fetch failed.*40[03]|cloudflare challenge/i.test(err),
    extract: (err, meta) => {
      const host = safeHost(meta.url);
      return {
        signature: `scrapling:cloudflare:${host}`,
        hint: `Host ${host} returned Cloudflare challenge; prefer browser fallback over scrapling.`.slice(0, 100)
      };
    }
  },
  {
    name: 'tectonic:missing-file',
    test: (err) => /tectonic.*exit/i.test(err) && /file .* not found|missing file/i.test(err),
    extract: () => ({
      signature: 'tectonic:missing-file',
      hint: 'tectonic compile failed on missing file; retry with --keep-logs to capture cache state.'.slice(0, 100)
    })
  },
  {
    name: 'validator:bullet-count',
    test: (err) => /validate_bullets.*expected 15/i.test(err),
    extract: () => ({
      signature: 'validator:bullet-count',
      hint: 'bullet count must equal 15; trim or expand before .tex emit.'.slice(0, 100)
    })
  },
  {
    name: 'system:oom',
    test: (err) => /out of memory.*killed/i.test(err),
    extract: () => ({
      signature: 'system:oom',
      hint: 'OOM kill observed; ensure /tmp is clean before next spawn.'.slice(0, 100)
    })
  },
  {
    name: 'anthropic:rate-limit',
    test: (err) => /429.*too many requests|rate_limit_exceeded/i.test(err),
    extract: () => ({
      signature: 'anthropic:rate-limit',
      hint: 'Anthropic 429 observed; back off 60s before retry.'.slice(0, 100)
    })
  },
  {
    name: 'telegram:outage',
    test: (err) => /telegram bot api.*5\d\d/i.test(err),
    extract: () => ({
      signature: 'telegram:outage',
      hint: 'Telegram Bot API outage; queue notifications until restored.'.slice(0, 100)
    })
  }
];

export function extractSignature(errorText, meta = {}) {
  for (const sig of SIGNATURE_PATTERNS) {
    if (sig.test(errorText)) return sig.extract(errorText, meta);
  }
  return { unknown: true, snippet: errorText.slice(0, 200).replace(/\s+/g, ' ') };
}

export async function learnFromFailure(db, runId, errorText, { url, reviewDir }) {
  const sig = extractSignature(errorText, { url });
  if (sig.unknown) {
    try {
      mkdirSync(reviewDir, { recursive: true });
      writeFileSync(
        join(reviewDir, `${runId}.json`),
        JSON.stringify({ run_id: runId, url, snippet: sig.snippet, full_error: errorText.slice(0, 2000) }, null, 2)
      );
      return { kind: 'review-queued', snippet: sig.snippet };
    } catch (e) {
      return { kind: 'review-queue-failed', error: e.message };
    }
  }
  try {
    upsertPattern(db, { signature: sig.signature, hint: sig.hint, runId });
    return { kind: 'learned', signature: sig.signature };
  } catch (e) {
    return { kind: 'upsert-failed', error: e.message };
  }
}
