# OPERATIONS — yash-pipeline-autonomous-agent

Operational runbook for the 24/7 Telegram-triggered wrapper around `/yash-resume-pipeline`. Living document; update on every production incident.

**Owner:** yash@srv944193 (Hostinger VPS).
**Spec:** `docs/superpowers/specs/2026-05-24-yash-pipeline-autonomous-agent-architecture.md`.
**Skill:** `.claude/skills/yash-pipeline-autonomous-agent/SKILL.md`.

## 1. Deploy (first time)
```bash
cd /yash-superClaudeHuman/projects/yash-ai-automation-career
bash tools/bootstrap-vps.sh
# On first run, the script provisions /etc/yash-pipeline/agent.env with the
# template and EXITS so you can edit it. Fill in the three secrets, then re-run:
bash tools/bootstrap-vps.sh
```

## 2. Daily checks (1 min)
```bash
systemctl --user status telegram-listener pipeline-orchestrator --no-pager | head -20
sqlite3 ops/work-queue.db "SELECT status, COUNT(*) FROM runs WHERE date(started_at)=date('now') GROUP BY status;"
```
Expected: both units `active (running)`; today's run counts < 20.

## 3. Rotating the Telegram bot token
1. In Telegram, message `@BotFather` → `/revoke` → select your bot → confirm.
2. `/newtoken` → select your bot → copy the new token.
3. On the VPS:
   ```bash
   sudo $EDITOR /etc/yash-pipeline/agent.env  # paste the new TELEGRAM_BOT_TOKEN
   systemctl --user restart telegram-listener
   journalctl --user -u telegram-listener -n 10 --no-pager
   ```
   Expected: `long-poll error` lines disappear within 30s; `/help` from Telegram responds.

## 4. Changing the cap
Defaults are **50 daily / 250 weekly** (raised from 20/100 on 2026-05-28). Override via env vars in `/etc/yash-pipeline/agent.env` (or the Shivani equivalent at `/etc/shivani-pipeline/agent.env`):
```
CAP_DAILY_MAX=50
CAP_WEEKLY_MAX=250
```
Leave the key out (or set empty) to use the default. Restart:
```bash
systemctl --user restart pipeline-orchestrator
# or for Shivani:
systemctl --user restart shivani-pipeline-orchestrator
```

## 4.1 Rate-limit auto-recovery

The orchestrator detects Claude Max 5-hour usage-limit events from the `claude -p` output (regexes in `services/rate-limit.mjs`) and **pauses BOTH tenants** until the window resets. State lives in a single JSON file at `/var/lib/claude-pipeline/rate-limit.json` (configurable via `RATE_LIMIT_STATE_PATH`).

**Per-deploy setup (one-time on the VPS):**
```bash
sudo mkdir -p /var/lib/claude-pipeline
sudo chown yash:yash /var/lib/claude-pipeline
sudo chmod 755 /var/lib/claude-pipeline
```

**How it behaves when triggered:**
1. `tickOnce` reads the last 8 KiB of `ops/runs/<id>/claude.log` after a non-zero exit; if `detectRateLimit()` matches, the row is re-queued with `attempts` unchanged and `runs.status='rate_limited'` (which the cap counter ignores — see `services/cap.mjs` `CAPPED_STATUSES`).
2. Both daemons read `/var/lib/claude-pipeline/rate-limit.json` on every 2-second tick; while `Date.now() < resetAt` they return `action='rate_limit_paused'` and emit one Telegram pause message per daemon process.
3. When the window elapses, the next tick deletes the state file, runs `UPDATE queue SET paused=0`, emits one `▶️ resumed` message, and resumes normal cap-checked processing.

**Manual override (force-resume now):**
```bash
sudo rm -f /var/lib/claude-pipeline/rate-limit.json
systemctl --user restart pipeline-orchestrator shivani-pipeline-orchestrator
```

**Force-trigger for smoke test:**
```bash
# Pause both bots for 5 minutes
echo '{"resetAt":"'"$(date -u -d '+5 min' +%Y-%m-%dT%H:%M:%SZ)"'","reason":"smoke","setBy":"manual","writtenAt":"'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'"}' | sudo tee /var/lib/claude-pipeline/rate-limit.json
sudo chown yash:yash /var/lib/claude-pipeline/rate-limit.json
# Within 2 s: both Telegram chats receive ⏸️ pause message exactly once.
# After 5 min: both receive ▶️ resume message and daemons resume.
```

**Audit:**
```bash
# Was the rate-limit branch triggered today?
journalctl --user -u pipeline-orchestrator --since today --no-pager | grep -E 'rate_limit_hit|rate_limit_paused|rate_limit_window_reset'
# How many rate_limited runs in the audit table?
sqlite3 /yash-superClaudeHuman/projects/yash-ai-automation-career/ops/work-queue.db "SELECT count(*), max(started_at) FROM runs WHERE status='rate_limited'"
```

## 5. Manual cancellation
```bash
# From Telegram (preferred):
/cancel <queue_id>

# From the VPS shell (emergency):
sqlite3 ops/work-queue.db "UPDATE queue SET cancel_requested=1 WHERE id=<queue_id> AND status IN ('queued','running');"
# Orchestrator polls cancel_requested every 2s.
```

## 6. Inspecting a single run's claude transcript
```bash
ls ops/runs/<run_id>/
less ops/runs/<run_id>/claude.log
cat ops/runs/<run_id>/events.jsonl | jq .
```

## 7. Reading the canonical audit log
```bash
tail -50 data/yash-resume-runs.log | jq .
```
One JSONL line per URL. Fields: url, status, slug, score, jd, pdf, cover_letter_pdf, phase timings (ms).

## 8. Reboot procedure
```bash
sudo reboot
# Wait ~60s; both units auto-start because:
#  - `loginctl enable-linger yash` is set
#  - both .service files have `WantedBy=default.target`
# Verify:
ssh yash@srv944193 'systemctl --user status telegram-listener pipeline-orchestrator --no-pager | head -10'
```

## 9. Rollback (full, nuclear)
```bash
systemctl --user disable --now telegram-listener pipeline-orchestrator
git checkout main
git revert <bad-merge-sha>
git push origin main
# Optional: archive the DB before reinstalling
mv ops/work-queue.db ops/work-queue.db.bak.$(date +%s)
```

## 10. Secrets hygiene — DO NOT DO
- Do NOT `cat /etc/yash-pipeline/agent.env` into a Claude session (the token will end up in transcripts).
- Do NOT add the literal token or chat ID to any code, config, or commit message.
- Do NOT remove `ECC_DISABLED_HOOKS` from `~/.claude/settings.json` without verifying the gateguard hook isn't deadlocking the orchestrator-spawned Bash calls. If a fresh install resets settings.json, restore:
  ```json
  "env": {
    "ECC_DISABLED_HOOKS": "pre:bash:gateguard-fact-force,pre:edit-write:gateguard-fact-force",
    "CLAUDE_SESSION_ID": "yash-primary"
  }
  ```

## 11. Logs
- Daemon stdout/stderr → journald (`journalctl --user -u <unit>`). Lines are **structured pino JSON**: `{level, time, pid, service, git_sha, event, ...fields, msg}`.
- Per-URL Claude transcript → `ops/runs/<run_id>/claude.log` (keep forever).
- Per-URL phase timings JSONL → `data/yash-resume-runs.log` (existing, append-only, keep forever).
- Per-run state events → `ops/runs/<run_id>/events.jsonl` (keep forever).
- Tectonic stderr (resume) → `resume-logs/yash/<slug>...log` (existing, keep forever).
- Tectonic stderr (cover letter) → `cover-letter-logs/yash/<slug>...log` (existing, keep forever).
- (Future) `/var/log/yash-pipeline/*.log` mirror via `systemd-cat` or tee — wired by `tools/bootstrap-vps.sh` + `/etc/logrotate.d/yash-pipeline`.

### 11.1. Querying structured logs
Each line is one JSON object. `event` is the stable machine-readable key; `msg` is the human description. Useful one-liners:

```bash
# All errors in the last hour
journalctl --user -u pipeline-orchestrator --since "1 hour ago" -o cat | jq -c 'select(.level=="error")'

# Every failed run, with phase + error
journalctl --user -u pipeline-orchestrator -o cat | jq -c 'select(.event=="run_failed") | {run_id,failed_phase,error,time}'

# PDF upload failures (telegram side)
journalctl --user -u pipeline-orchestrator -o cat | jq -c 'select(.event=="pdf_upload_failed") | {run_id,kind,err}'

# All bot_online events (boot history)
journalctl --user -u pipeline-orchestrator -o cat | jq -c 'select(.event=="bot_online")'
```

**PII redaction (built-in):** `chatId`, `chat_id`, `token`, `bot_token`, `TELEGRAM_BOT_TOKEN`, `LOGTAIL_TOKEN` are auto-replaced with `[REDACTED]` (top-level and one-level-nested). Allowlist user IDs and chat IDs are never written raw.

### 11.2. Env knobs (`/etc/yash-pipeline/agent.env`)

| Env | Default | Effect |
|---|---|---|
| `LOG_LEVEL` | `info` | Standard pino levels: `trace`, `debug`, `info`, `warn`, `error`, `fatal`. Set to `debug` to see `tick_idle` + `notify_noop`. |
| `GIT_SHA` | (set by systemd ExecStartPre) | Stamped on every log line for fast version triage. |
| `LOG_TRANSPORT` | `none` | `none` = stdout only (journald captures). `betterstack` = also ship to BetterStack/Logtail. |
| `LOGTAIL_TOKEN` | — | Required iff `LOG_TRANSPORT=betterstack`. Daemon refuses to start without it. |
| `CLAUDE_MODEL` | `claude-sonnet-4-6` | Active model for `claude -p`. Override to any valid alias without a code change. |
| `CLAUDE_EFFORT` | `xhigh` | Maps to `--effort` flag (adaptive thinking budget). Set to `""` to drop the flag entirely if the installed CLI rejects it. |
| `CLAUDE_FALLBACK_MODEL` | (unset) | Opt-in `--fallback-model`; covers HTTP 529 overloads only, NOT 5-hour usage-limit events. |
| `CAP_DAILY_MAX` | `50` | Daily cap override (since 2026-05-28; previously hardcoded at 20). |
| `CAP_WEEKLY_MAX` | `250` | Weekly cap override (since 2026-05-28; previously hardcoded at 100). |
| `RATE_LIMIT_STATE_PATH` | `/var/lib/claude-pipeline/rate-limit.json` | Shared with Shivani — both daemons read+write the same file so a usage-limit hit by either tenant pauses both. |

### 11.3. Wiring BetterStack (optional, opt-in)
1. Create a BetterStack source → copy the source token.
2. Add to `/etc/yash-pipeline/agent.env`:
   ```
   LOG_TRANSPORT=betterstack
   LOGTAIL_TOKEN=<source-token>
   ```
3. Verify the transport package is installed locally: `npm ls @logtail/pino` (it ships as an `optionalDependency`; reinstall with `npm install` if pruned).
4. `systemctl --user restart pipeline-orchestrator telegram-listener` — log shipping starts on next process boot. Journald continues to receive everything regardless.

## 12. On-call playbook
| Page | Action |
|---|---|
| `🚨 work-queue.db corrupt, archived` | `sqlite3 ops/work-queue.db.corrupt-* '.dump'` for forensics; bring up a fresh DB; re-add lost URLs from Telegram history |
| `❌ #N <hostname> failed at jd_fetch` | Open the Scrapling stderr; if Cloudflare blocked, ignore (retryable). Mass failures → check `scrapling_fetch.py` and `.venv/bin/python3` |
| `⏸️ Cap reached` | Working as designed; will resume tomorrow / next ISO week |
| `OOM detected` | `dmesg \| tail -100`; if tectonic killed, recompile smaller; if claude killed, restart and add memory caps |
| Telegram doesn't respond at all | `systemctl --user status telegram-listener`; if active, `journalctl --user -u telegram-listener` for `long-poll error`; if backoff still climbing, restart |

## Operating the Self-Improvement Layer

### Phase A — Observability exporter

**Enable:**
```bash
# On VPS, edit /etc/yash-pipeline/agent.env:
FEATURE_EXPORTER=1
LANGFUSE_PUBLIC_KEY=pk-lf-...
LANGFUSE_SECRET_KEY=sk-lf-...
LANGFUSE_HOST=https://cloud.langfuse.com

# Install + enable systemd timer:
cp systemd/exporter.{service,timer} ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now exporter.timer
```

**Verify:** `journalctl --user -u exporter -n 50 | grep exporter_done`. Then visit Langfuse dashboard → traces should appear within 5 min.

**Rollback:** `systemctl --user disable --now exporter.timer && sed -i 's/^FEATURE_EXPORTER=1/FEATURE_EXPORTER=0/' /etc/yash-pipeline/agent.env`

### Phase B — Failure-pattern KB

**Enable:**
```bash
sed -i 's/^FEATURE_FAILURE_KB=0/FEATURE_FAILURE_KB=1/' /etc/yash-pipeline/agent.env
systemctl --user restart pipeline-orchestrator
```

**Curate weekly (15 min):**
```bash
sqlite3 ops/work-queue.db "SELECT signature, hits, last_seen FROM failure_patterns ORDER BY hits DESC LIMIT 20;"
```
Or via Telegram: `/patterns`

**Suppress a bad hint:** Telegram `/suppress <signature>`

**Review unknown faults:** `ls ops/kb-review-queue/` then add a regex to `services/failure-kb.mjs:SIGNATURE_PATTERNS` and re-deploy.

**Rollback:** `sed -i 's/^FEATURE_FAILURE_KB=1/FEATURE_FAILURE_KB=0/' /etc/yash-pipeline/agent.env && systemctl --user restart pipeline-orchestrator`

### Phase C — Watchdog + heartbeat

**Enable:**
```bash
# Get your ping URL from Healthchecks.io → create check named "yash-orchestrator"
echo "HEALTHCHECK_PING_URL=https://hc-ping.com/<uuid>" >> /etc/yash-pipeline/agent.env
sed -i 's/^FEATURE_WATCHDOG=0/FEATURE_WATCHDOG=1/' /etc/yash-pipeline/agent.env

cp systemd/watchdog.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now watchdog.service
systemctl --user restart pipeline-orchestrator
```

**Verify heartbeat:** check Healthchecks dashboard → should be "up" within 2 min.

**Verify remediations:** induce an OOM (`stress-ng --vm 1 --vm-bytes 3G --timeout 30`); watch journald: `journalctl --user -u watchdog -f`.

**Rollback:** `systemctl --user disable --now watchdog.service && sed -i 's/^FEATURE_WATCHDOG=1/FEATURE_WATCHDOG=0/' /etc/yash-pipeline/agent.env && systemctl --user restart pipeline-orchestrator`

### Phase D — Promptfoo CI

**Enable:** In GitHub repo settings:
- Settings → Variables → Actions → add `FEATURE_PROMPT_EVAL=1`
- Settings → Secrets → Actions → ensure `ANTHROPIC_API_KEY` is set

**Test:** push a one-character edit to `resume-optimization-system-based-on-job-description.md`; CI should run prompt-eval workflow.

**Rollback:** Remove the `FEATURE_PROMPT_EVAL` repo variable.

### Smoke tests (manual, pre-rollout)

```bash
npm run smoke:cloud -- --phase=A
npm run smoke:cloud -- --phase=B
npm run smoke:cloud -- --phase=C
npm run smoke:cloud -- --phase=D
```
