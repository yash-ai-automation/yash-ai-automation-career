# OPERATIONS — shivani-pipeline-autonomous-agent

Operational runbook for the 24/7 Telegram-triggered wrapper around `/shivani-resume-pipeline`. Living document; update on every production incident.

**Owner:** yash@srv944193 (Hostinger VPS) — same operator as the Yash agent, single point of contact for both tenants.
**Plan:** `docs/superpowers/plans/2026-05-25-shivani-autonomous-agent-impl-plan.md`.
**Skill:** `.claude/skills/shivani-pipeline-autonomous-agent/SKILL.md`.
**Sibling runbook (Yash):** `OPERATIONS.md` (repo root).

## 1. Bootstrap (first time on VPS)
**Hard prerequisites — DO BOTH BEFORE running step 3:**

1. **Rotate the Shivani bot token via @BotFather.** In Telegram → `@BotFather` → `/revoke` → select the Shivani bot → confirm. Then `/newtoken` → copy the fresh token. Any token previously transmitted in plaintext (chat, prompt, planning doc) is treated as compromised and MUST be replaced before deployment.
2. **Verify swap headroom (plan Q9).**
   ```bash
   swapon --show
   ```
   If less than 1 GB, grow to ≥ 2 GB before bootstrapping:
   ```bash
   sudo fallocate -l 2G /swapfile
   sudo chmod 600 /swapfile
   sudo mkswap /swapfile
   sudo swapon /swapfile
   # Persist across reboots:
   echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
   ```

3. **Bootstrap the env file and tree:**
   ```bash
   sudo mkdir -p /etc/shivani-pipeline
   sudo touch /etc/shivani-pipeline/agent.env
   sudo chown yash:yash /etc/shivani-pipeline/agent.env
   sudo chmod 600 /etc/shivani-pipeline/agent.env

   # Populate from the template:
   cat ops/shivani/telegram.env.example | sudo tee /etc/shivani-pipeline/agent.env > /dev/null
   sudo $EDITOR /etc/shivani-pipeline/agent.env
   #   - Replace <SHIVANI_BOT_TOKEN> with the FRESH BotFather-issued token.
   #   - Replace <SHIVANI_CHAT_ID> on TWO lines: TELEGRAM_ALLOWLIST + TELEGRAM_NOTIFY_CHAT_ID.

   # Create the tenant tree + DB:
   cd /yash-superClaudeHuman/projects/yash-ai-automation-career
   mkdir -p ops/shivani/{checkpoints,runs,preambles}
   node -e "import('./services/db.mjs').then(m => m.initDb('ops/shivani/work-queue.db'))"

   # Install the user-mode systemd units:
   cp systemd/shivani-telegram-listener.service systemd/shivani-pipeline-orchestrator.service ~/.config/systemd/user/
   systemctl --user daemon-reload
   systemctl --user enable --now shivani-pipeline-orchestrator shivani-telegram-listener
   ```
   `loginctl enable-linger yash` is already set for the Yash agent — idempotent.

4. **Measure RSS baseline (plan Q8) during the first overlap:**
   ```bash
   # Run while a Yash job is processing AND a Shivani job is queued behind it,
   # so a real overlap occurs. Capture the peak claude -p RSS in MB.
   ps -eo rss,comm,pid --sort=-rss | head -20
   # Then set cap = floor((free_ram_mb - 500) / measured_peak_mb)
   # Pin the result in /etc/shivani-pipeline/agent.env as a comment (no code change needed —
   # the SQLite queue_one_running UNIQUE index already enforces serial-per-tenant).
   ```
   If `measured_peak_mb * 2 + 500 > available_ram_mb`, DO NOT enable both stacks simultaneously — resize the VPS first.

5. **Smoke test (after `enable --now`):**
   ```bash
   # /help to the Shivani bot should reply within 2s
   # /add <known-good-shivani-jd-url> should reply "Queued #1 …" within 2s
   # Resume + cover-letter PDFs should arrive within ~10 min
   ```

## 2. Daily checks (1 min)
```bash
systemctl --user status shivani-telegram-listener shivani-pipeline-orchestrator --no-pager | head -20
sqlite3 ops/shivani/work-queue.db "SELECT status, COUNT(*) FROM runs WHERE date(started_at)=date('now') GROUP BY status;"
# Cross-tenant: Yash sanity
systemctl --user status telegram-listener pipeline-orchestrator --no-pager | head -10
```
Expected: all four units `active (running)`; today's Shivani runs < 20.

## 3. Rotating the Telegram bot token
1. In Telegram → `@BotFather` → `/revoke` → select the Shivani bot → confirm. **Old token is dead instantly.**
2. `/newtoken` → select the Shivani bot → copy the new token.
3. On the VPS:
   ```bash
   sudo $EDITOR /etc/shivani-pipeline/agent.env   # replace the TELEGRAM_BOT_TOKEN line
   sudo chmod 600 /etc/shivani-pipeline/agent.env # idempotent
   systemctl --user restart shivani-telegram-listener shivani-pipeline-orchestrator
   journalctl --user -u shivani-telegram-listener -n 10 --no-pager
   ```
   Expected: `long-poll error` lines disappear within 30s; `/help` from Telegram responds within 2s.

## 4. Changing the cap
Cap lives in the daily/weekly limits inside `services/pipeline-orchestrator.mjs` (`capLimits: { dailyMax: 20, weeklyMax: 100 }`) — shared with Yash. Commit and:
```bash
systemctl --user restart shivani-pipeline-orchestrator
```
Concurrency cap (workers across both tenants) is enforced at the operator level via the measured Q8 calculation in §1.4. Until the VPS is resized, keep the rule "no more than one Shivani worker AND one Yash worker simultaneously".

## 5. Manual cancellation
```bash
# From Telegram (preferred):
/cancel <queue_id>

# From the VPS shell (emergency):
sqlite3 ops/shivani/work-queue.db "UPDATE queue SET cancel_requested=1 WHERE id=<queue_id> AND status IN ('queued','running');"
# Orchestrator polls cancel_requested every 2s.
```

## 6. Inspecting a single run's claude transcript
```bash
ls ops/shivani/runs/<run_id>/
less ops/shivani/runs/<run_id>/claude.log
cat ops/shivani/runs/<run_id>/events.jsonl | jq .
```

## 7. Reading the canonical audit log
```bash
tail -50 data/shivani-resume-runs.log | jq .
```
One JSONL line per URL. Fields: url, status, slug, score, jd, pdf, cover_letter_pdf, phase timings (ms). Same schema as the Yash audit log.

## 8. Reboot procedure
```bash
sudo reboot
# Wait ~60s; all four units auto-start because:
#  - `loginctl enable-linger yash` is set (one-shot, idempotent)
#  - all .service files have `WantedBy=default.target`
# Verify:
ssh yash@srv944193 'systemctl --user status shivani-telegram-listener shivani-pipeline-orchestrator telegram-listener pipeline-orchestrator --no-pager | head -16'
```

## 9. Rollback (Shivani-only)
```bash
systemctl --user disable --now shivani-telegram-listener shivani-pipeline-orchestrator
# DB and ops/shivani/ tree stay on disk (gitignored) — preserve for forensics.
# Yash agent is untouched; verify:
systemctl --user status telegram-listener pipeline-orchestrator --no-pager | head -6
```

For a full-stack rollback (e.g., a bad `services/*.mjs` change broke both tenants):
```bash
systemctl --user disable --now shivani-* telegram-listener pipeline-orchestrator
git checkout main
git revert <bad-merge-sha>
git push origin main
systemctl --user enable --now telegram-listener pipeline-orchestrator
# Then re-evaluate whether to bring Shivani back up.
```

## 10. Secrets hygiene — DO NOT DO
- Do NOT `cat /etc/shivani-pipeline/agent.env` into a Claude session (the token will end up in transcripts).
- Do NOT add the literal token or chat ID to any code, config, commit message, or planning document. Use the placeholders `<SHIVANI_BOT_TOKEN>` and `<SHIVANI_CHAT_ID>` in any artifact that lives inside the repo.
- Do NOT remove `ECC_DISABLED_HOOKS` from `~/.claude/settings.json` without verifying the gateguard hook isn't deadlocking the orchestrator-spawned Bash calls (same lesson as Yash). If a fresh install resets settings.json, restore:
  ```json
  "env": {
    "ECC_DISABLED_HOOKS": "pre:bash:gateguard-fact-force,pre:edit-write:gateguard-fact-force",
    "CLAUDE_SESSION_ID": "yash-primary"
  }
  ```
- `tools/check-secrets.sh` enforces the no-leak rule on every commit. The Shivani env file at `/etc/shivani-pipeline/agent.env` is outside the repo so the scanner can't see it; the in-repo template is `ops/shivani/telegram.env.example` and contains only placeholders.

## 11. Logs
- Daemon stdout/stderr → journald (`journalctl --user -u <unit>`). Lines are **structured pino JSON** with the `tenant=shivani` field stamped in by the logger when `TENANT` env var is set.
- Per-URL Claude transcript → `ops/shivani/runs/<run_id>/claude.log` (keep forever).
- Per-URL phase timings JSONL → `data/shivani-resume-runs.log` (existing, append-only, keep forever).
- Per-run state events → `ops/shivani/runs/<run_id>/events.jsonl` (keep forever).
- Tectonic stderr (resume) → `resume-logs/shivani/<slug>...log` (existing, keep forever).
- Tectonic stderr (cover letter) → `cover-letter-logs/shivani/<slug>...log` (existing, keep forever).

### 11.1. Querying structured logs

```bash
# All Shivani errors in the last hour
journalctl --user -u shivani-pipeline-orchestrator --since "1 hour ago" -o cat | jq -c 'select(.level=="error")'

# Every failed run, with phase + error
journalctl --user -u shivani-pipeline-orchestrator -o cat | jq -c 'select(.event=="run_failed") | {run_id,failed_phase,error,attempts,max_attempts,requeued,time}'

# Retries vs final failures (3-strike telemetry)
journalctl --user -u shivani-pipeline-orchestrator -o cat | jq -c 'select(.event=="run_failed" and .requeued==true) | {run_id, attempts}'
journalctl --user -u shivani-pipeline-orchestrator -o cat | jq -c 'select(.event=="run_failed" and .requeued==false) | {run_id, attempts}'

# Both tenants in one pane
journalctl --user -u shivani-pipeline-orchestrator -u pipeline-orchestrator -o cat | jq -c 'select(.event=="run_completed_ok")'
```

**PII redaction (built-in):** `chatId`, `chat_id`, `token`, `bot_token`, `TELEGRAM_BOT_TOKEN`, `LOGTAIL_TOKEN` are auto-replaced with `[REDACTED]` (top-level and one-level-nested). Allowlist user IDs and chat IDs are never written raw.

### 11.2. Env knobs (`/etc/shivani-pipeline/agent.env`)

Documented in `ops/shivani/telegram.env.example`. Hot-only fields (no code change):

| Env | Default in template | Effect |
|---|---|---|
| `LOG_LEVEL` | `info` | Standard pino levels. Set to `debug` to see `tick_idle` + `notify_noop`. |
| `LOG_TRANSPORT` | `none` | `none` = stdout only (journald captures). `betterstack` = also ship to BetterStack/Logtail. |
| `LOGTAIL_TOKEN` | (unset) | Required iff `LOG_TRANSPORT=betterstack`. Daemon refuses to start without it. |
| `FEATURE_EXPORTER` | `0` | Phase A — Langfuse traces tagged `shivani-resume-pipeline` (via `TENANT_TRACE_NAME`). |
| `FEATURE_FAILURE_KB` | `0` | Phase B — failure-pattern KB + `$LEARNED_HINTS` injection, scoped to Shivani DB. |
| `FEATURE_WATCHDOG` | `0` | Phase C — watchdog daemon + Healthchecks.io heartbeat. `TMP_CLEANUP_GLOB=/tmp/shivani-pipeline-*` keeps cleanup scoped. |

## 12. On-call playbook
| Page | Action |
|---|---|
| `🚨 work-queue.db corrupt, archived` (Shivani) | `sqlite3 ops/shivani/work-queue.db.corrupt-* '.dump'` for forensics; bring up a fresh DB; re-add lost URLs from Telegram history |
| `❌ #N <hostname> failed at jd_fetch` (Shivani) | Open `resume-logs/shivani/<slug>.log` and `data/shivani-resume-runs.log`; if Scrapling 403 → retryable (3-strike auto-retry will try again); if mass failures → check `scrapling_fetch.py` and `.venv/bin/python3` |
| `⚠️ Run #N failed (attempt N/3); re-queued` | Working as designed — 3-strike retry. After 3 strikes, the message ends with `attempt 3/3 — moving to failed`. |
| `⏸️ Cap reached` | Working as designed; will resume tomorrow / next ISO week. Caps are shared with Yash since `capLimits` is hardcoded in `services/pipeline-orchestrator.mjs`. |
| `OOM detected` | `dmesg \| tail -100`; if two `claude -p` workers overlapped, lower the Q8 cap. The `OOMScoreAdjust=-500` setting on `shivani-pipeline-orchestrator.service` biases the kernel to kill the child first. |
| Shivani Telegram doesn't respond at all | `systemctl --user status shivani-telegram-listener`; if active, `journalctl --user -u shivani-telegram-listener` for `long-poll error`; if backoff still climbing, restart |
| Yash agent regression after Shivani PR | Roll back ONLY Shivani: `systemctl --user disable --now shivani-*`. If Yash still broken, full-stack rollback per §9. |

## Operating the Self-Improvement Layer

Identical mechanism to the Yash agent — see the sibling `OPERATIONS.md` (repo root) `§ Operating the Self-Improvement Layer` for the per-phase enable/verify/rollback commands. To apply to Shivani, replace `/etc/yash-pipeline/agent.env` with `/etc/shivani-pipeline/agent.env` and the unit name `pipeline-orchestrator` with `shivani-pipeline-orchestrator`.

**Phase B suppress (Shivani-scoped):** `/suppress <signature>` over Telegram targets the Shivani DB only (separate table).

**Phase C watchdog:** the watchdog daemon's `journaldStream()` was extended in this PR to follow BOTH tenants' units, so a single watchdog instance covers both. The `TMP_CLEANUP_GLOB` env var (set in `/etc/shivani-pipeline/agent.env`) ensures `remediateOom` cleans `/tmp/shivani-pipeline-*` instead of (only) the Yash glob.

## Coexistence rules with the Yash agent

1. **Disjoint state.** Each tenant owns its own systemd units, env file, SQLite DB, audit log, preamble dir, queue MD, and output directory tree. A bug in one tenant cannot corrupt the other's state.
2. **Shared code.** All `services/*.mjs` files are shared; tenant-specific behavior comes from env vars. If you need to change shared code, run BOTH tenants' tests (`npm run test:services && npm run test:e2e`) before deploying.
3. **Concurrency.** Each tenant's `queue_one_running` UNIQUE index enforces single worker per DB. Across tenants, observe the Q8 cap of `floor((free_ram - 500MB) / measured_peak)` total `claude -p` Opus 4.7 workers.
4. **Token isolation.** Shivani's bot token is separate from Yash's. Rotating one does not affect the other.
5. **No cross-DB FK.** Neither orchestrator reads from the other's SQLite file. Cross-tenant observability is via journald + BetterStack tags only.
