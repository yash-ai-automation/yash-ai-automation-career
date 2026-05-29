---
name: yash-pipeline-autonomous-agent
description: 24/7 unattended wrapper around /yash-resume-pipeline. Telegram bot enqueues URLs, systemd orchestrator runs one claude -p per URL, delivers resume + cover letter PDFs back to Telegram. Use when the user mentions "autonomous-yash", "yash-24-7", "yash-bot", asks to /add a URL via Telegram, checks /status, debugs why the bot isn't responding, rotates the bot token, or needs to deploy / rollback the autonomous pipeline on the Hostinger VPS.
---

# yash-pipeline-autonomous-agent — runbook

This skill is operational, not generative. It does NOT modify resumes, JDs, or prompts — it spins up / inspects / rolls back the Telegram-triggered wrapper that drives the existing `/yash-resume-pipeline` skill on the VPS.

## When to use
- User asks why the bot isn't responding to /add or /status.
- User asks to deploy / re-deploy / roll back the autonomous agent.
- User asks to rotate the Telegram bot token, change the allowlist, or change the cap.
- User pastes a journalctl error from `telegram-listener` or `pipeline-orchestrator`.
- User asks for the runbook (see also `OPERATIONS.md` at repo root for the long form).

## Architecture (one-paragraph reminder)
Two systemd `--user` daemons (`telegram-listener`, `pipeline-orchestrator`) read from `/etc/yash-pipeline/agent.env`, share state through `ops/work-queue.db` (SQLite WAL), and spawn one `claude -p` per URL using model `${CLAUDE_MODEL:-claude-sonnet-4-6}` with adaptive thinking (`--effort ${CLAUDE_EFFORT:-xhigh}`). Daily cap defaults to **50** (`CAP_DAILY_MAX`), weekly to **250** (`CAP_WEEKLY_MAX`). On a `claude -p` usage-limit response, the orchestrator writes a cross-tenant pause file at `${RATE_LIMIT_STATE_PATH:-/var/lib/claude-pipeline/rate-limit.json}` and re-queues the URL **without consuming a retry attempt**; the Shivani daemon reads the same file and pauses too. Per-URL latency ~13–25 min (Sonnet 4.6 / xhigh, full JD→resume→cover-letter). The per-URL wall-clock timeout is **35 min** (configurable via `PER_URL_TIMEOUT_MS`); a run that finishes is credited even if SIGTERM'd at the timeout — success is gated on artifacts-on-disk, not the `claude -p` exit code (fixed 2026-05-29). Spec: `docs/superpowers/specs/2026-05-24-yash-pipeline-autonomous-agent-architecture.md`.

## Quick diagnostic commands
```bash
# Are both daemons alive?
systemctl --user status telegram-listener pipeline-orchestrator --no-pager

# What's the bot been doing?
journalctl --user -u telegram-listener -n 50 --no-pager
journalctl --user -u pipeline-orchestrator -n 50 --no-pager

# What's in the queue right now?
sqlite3 ops/work-queue.db 'SELECT id, url, status FROM queue ORDER BY id DESC LIMIT 10;'

# How many runs today / this week?
sqlite3 ops/work-queue.db "SELECT status, COUNT(*) FROM runs WHERE date(started_at)=date('now') GROUP BY status;"
```

## Failure playbook
| Symptom | First check | If that's fine, then |
|---|---|---|
| Bot doesn't reply to /help | `systemctl --user status telegram-listener` | `journalctl --user -u telegram-listener -n 100` — look for `long-poll error` |
| /add accepted but nothing happens | `systemctl --user status pipeline-orchestrator` | Check `sqlite3 ops/work-queue.db 'SELECT * FROM queue WHERE status="queued"'`; check cap |
| Run failed with `tectonic exit` | Read `resume-logs/yash/<slug>.log` last 30 lines | Re-add via `/add <same-url>` after 24h, or `/readd` (Phase 3) |
| "OOM" notification | `dmesg \| tail -100` for the killed process | Reduce concurrency (already 1); inspect tectonic memory profile |
| Secret leak alert from pre-commit | `tools/check-secrets.sh` output | Move offending lines to `/etc/yash-pipeline/agent.env`, recommit |
| `⏸️ Claude usage-limit window active until …` (one msg only, then silence) | This is correct behavior — Claude Max 5-hour window hit by either tenant. Both bots pause until reset. | Audit: `journalctl --user -u pipeline-orchestrator --since today \| grep rate_limit`. Force-resume: `sudo rm /var/lib/claude-pipeline/rate-limit.json && systemctl --user restart pipeline-orchestrator shivani-pipeline-orchestrator` (then expect a fresh quota window) |

## Rollback
```bash
systemctl --user disable --now telegram-listener pipeline-orchestrator
git revert <merge-commit-sha>
git push origin main
# DB and ops/ tree stay on disk (gitignored) — preserve for forensics
```

## Full reference
- Long-form ops doc: `OPERATIONS.md` (repo root)
- Spec: `docs/superpowers/specs/2026-05-24-yash-pipeline-autonomous-agent-architecture.md`
- Drift audit: `docs/superpowers/audits/2026-05-24-spec-vs-code-drift.md`

## Self-Improvement Layer

Four phases, each flag-gated (default OFF). See `OPERATIONS.md § Operating the Self-Improvement Layer` for full runbook.

| Flag | Phase | What it enables |
|---|---|---|
| `FEATURE_EXPORTER=1` | A | Langfuse Cloud Hobby observability via `services/exporter.mjs` + 5-min systemd timer |
| `FEATURE_FAILURE_KB=1` | B | Pre-spawn `$LEARNED_HINTS` injection + post-fail `learnFromFailure` regex catalogue |
| `FEATURE_WATCHDOG=1` | C | `services/watchdog.mjs` daemon + 60s Healthchecks.io heartbeat |
| Repo var `FEATURE_PROMPT_EVAL=1` | D | GitHub Actions runs Promptfoo on V2.0/cv.md edits |

Telegram operator commands (Phase B/C):
- `/patterns` — list top 10 failure patterns
- `/suppress <signature>` — stop injecting a hint
- `/unpause` — clear `paused=1` on `queue` after a disk-watch event

Watchdog rules (Phase C):
1. OOM → `rm -rf /tmp/yash-pipeline-*`
2. tectonic missing-file → re-run with `--keep-logs`
3. Two 403s on same host within 30 min → host-cooldown UPSERT
4. No orchestrator log for >10 min → `systemctl --user restart pipeline-orchestrator`
5. Disk free <1 GB → `UPDATE queue SET paused=1` + Telegram alert
