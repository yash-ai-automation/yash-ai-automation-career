---
name: shivani-pipeline-autonomous-agent
description: 24/7 unattended wrapper around /shivani-resume-pipeline. Telegram bot enqueues URLs, systemd orchestrator runs one claude -p per URL, delivers resume + cover letter PDFs back to Telegram. Use when the user mentions "autonomous-shivani", "shivani-24-7", "shivani-bot", asks to /add a URL via Telegram for Shivani, checks /status for the Shivani agent, debugs why her bot isn't responding, rotates the Shivani bot token, or needs to deploy / rollback the Shivani autonomous pipeline on the Hostinger VPS.
---

# shivani-pipeline-autonomous-agent — runbook

This skill is operational, not generative. It does NOT modify resumes, JDs, or prompts — it spins up / inspects / rolls back the Telegram-triggered wrapper that drives the existing `/shivani-resume-pipeline` skill on the VPS. It is the **standalone twin** of `yash-pipeline-autonomous-agent`: separate bot token, separate systemd units, separate SQLite queue, separate audit log, separate output directories — sharing only the parameterized `services/*.mjs` code.

## When to use
- User asks why the Shivani bot isn't responding to /add or /status.
- User asks to deploy / re-deploy / roll back the Shivani autonomous agent.
- User asks to rotate the Shivani Telegram bot token, change the allowlist, or change the cap.
- User pastes a journalctl error from `shivani-telegram-listener` or `shivani-pipeline-orchestrator`.
- User asks for the Shivani runbook (see also `OPERATIONS.md` in this skill folder for the long form).

## Architecture (one-paragraph reminder)
Two systemd `--user` daemons (`shivani-telegram-listener`, `shivani-pipeline-orchestrator`) read from `/etc/shivani-pipeline/agent.env`, share state through `ops/shivani/work-queue.db` (SQLite WAL), and spawn one `claude -p` per URL using model `${CLAUDE_MODEL:-claude-sonnet-4-6}` with adaptive thinking (`--effort ${CLAUDE_EFFORT:-xhigh}`). Allowlist is single-user; URLs from any other Telegram user are silently ignored. Daily cap defaults to **50** (`CAP_DAILY_MAX`), weekly to **250** (`CAP_WEEKLY_MAX`). **The rate-limit state file at `${RATE_LIMIT_STATE_PATH:-/var/lib/claude-pipeline/rate-limit.json}` is SHARED with the Yash daemon** — both bots share the same Claude Max login on this VPS, so a usage-limit hit by either tenant pauses both queues until the 5-hour window resets; the URL is re-queued without consuming a retry attempt. Per-URL latency tracks the existing `/shivani-resume-pipeline` budget (V3.1 prompt + cover-letter generation + tectonic compile). Plan: `docs/superpowers/plans/2026-05-25-shivani-autonomous-agent-impl-plan.md`.

## Quick diagnostic commands
```bash
# Are both daemons alive?
systemctl --user status shivani-telegram-listener shivani-pipeline-orchestrator --no-pager

# What's the bot been doing?
journalctl --user -u shivani-telegram-listener -n 50 --no-pager
journalctl --user -u shivani-pipeline-orchestrator -n 50 --no-pager

# What's in the Shivani queue right now?
sqlite3 ops/shivani/work-queue.db 'SELECT id, url, status, attempts FROM queue ORDER BY id DESC LIMIT 10;'

# How many Shivani runs today / this week?
sqlite3 ops/shivani/work-queue.db "SELECT status, COUNT(*) FROM runs WHERE date(started_at)=date('now') GROUP BY status;"

# Cross-tenant sanity: is the Yash agent still happy?
systemctl --user status telegram-listener pipeline-orchestrator --no-pager | head -6
```

## Failure playbook
| Symptom | First check | If that's fine, then |
|---|---|---|
| Bot doesn't reply to /help | `systemctl --user status shivani-telegram-listener` | `journalctl --user -u shivani-telegram-listener -n 100` — look for `long-poll error` or `allowlist_reject` |
| /add accepted but nothing happens | `systemctl --user status shivani-pipeline-orchestrator` | Check `sqlite3 ops/shivani/work-queue.db 'SELECT * FROM queue WHERE status="queued"'`; check cap |
| Run failed with `tectonic exit` | Read `resume-logs/shivani/<slug>.log` last 30 lines | Re-add via `/add <same-url>` after 24h, or rely on the 3-strike auto-retry |
| "OOM" notification | `dmesg \| tail -100` for the killed process; check `MemoryMax=1G` on the unit | If two tenants overlapped → lower concurrency cap or resize VPS (plan §5.4) |
| Secret leak alert from `tools/check-secrets.sh` | Output identifies the offending file | Move the secret to `/etc/shivani-pipeline/agent.env` (mode 0600), recommit; never paste tokens into a Claude session |
| Yash agent regression after Shivani deploy | Tail Yash journalctl + run `npm run test:services` | Roll back ONLY Shivani: `systemctl --user disable --now shivani-*`. Yash defaults preserved in PR 1 — Yash should not regress from Shivani changes |
| `⏸️ Claude usage-limit window active until …` (one msg only, then silence — same message in Yash bot too) | Correct behavior — Claude Max 5-hour window hit. The shared state file at `/var/lib/claude-pipeline/rate-limit.json` paused both bots. | Audit: `cat /var/lib/claude-pipeline/rate-limit.json` + `journalctl --user -u shivani-pipeline-orchestrator --since today \| grep rate_limit`. Force-resume: `sudo rm /var/lib/claude-pipeline/rate-limit.json && systemctl --user restart pipeline-orchestrator shivani-pipeline-orchestrator` (only do this if you have fresh quota — otherwise the daemons will immediately re-pause on the next URL) |

## Rollback (Shivani-only — Yash untouched)
```bash
systemctl --user disable --now shivani-telegram-listener shivani-pipeline-orchestrator
# Optional: archive the Shivani DB for forensics
mv ops/shivani/work-queue.db ops/shivani/work-queue.db.bak.$(date +%s)
# Token rotation is NOT reverted; the agent can re-deploy without re-bootstrapping.
```

For a code-level rollback (e.g., a bad `services/*.mjs` change broke both tenants), revert the merge commit and redeploy both stacks. The PR 1 env-parameterization keeps every Yash default byte-identical when Shivani env vars are unset.

## Full reference
- Long-form ops doc: `OPERATIONS.md` (this skill folder)
- Plan: `docs/superpowers/plans/2026-05-25-shivani-autonomous-agent-impl-plan.md`
- Clarifications: `docs/superpowers/plans/2026-05-25-shivani-autonomous-agent-clarifications.md`
- Sibling skill (Yash): `.claude/skills/yash-pipeline-autonomous-agent/SKILL.md`
- Shared services parameterization PR: env hooks `AUDIT_LOG_PATH`, `PREAMBLE_DIR`, `TENANT_LABEL`, `TENANT_TRACE_NAME`, `TMP_CLEANUP_GLOB`, optional `tenant` field on `createLogger`

## Self-Improvement Layer (Phases A–D)
Identical opt-in mechanism to Yash. Set the corresponding flag in `/etc/shivani-pipeline/agent.env` and restart the orchestrator. See `OPERATIONS.md § Operating the Self-Improvement Layer` (this folder) for the full per-phase runbook. The flags are tenant-local — enabling them for Shivani does NOT enable them for Yash and vice versa.

| Flag | Phase | What it enables |
|---|---|---|
| `FEATURE_EXPORTER=1` | A | Langfuse Cloud Hobby observability via `services/exporter.mjs` (trace name comes from `TENANT_TRACE_NAME` env, so Shivani traces are tagged `shivani-resume-pipeline`) |
| `FEATURE_FAILURE_KB=1` | B | Pre-spawn `$LEARNED_HINTS` injection + post-fail `learnFromFailure` regex catalogue, scoped to the Shivani DB |
| `FEATURE_WATCHDOG=1` | C | `services/watchdog.mjs` daemon + 60s Healthchecks.io heartbeat; `TMP_CLEANUP_GLOB=/tmp/shivani-pipeline-*` ensures the right artifacts are cleaned |
| Repo var `FEATURE_PROMPT_EVAL=1` | D | GitHub Actions runs Promptfoo on V3.1 / cv-shivani.md edits |

Telegram operator commands (same set as Yash; scoped to the Shivani DB):
- `/add <url>`, `/queue`, `/status`, `/cancel <id>`, `/help`
- `/patterns`, `/suppress <signature>`, `/unpause` (Phase B/C)
