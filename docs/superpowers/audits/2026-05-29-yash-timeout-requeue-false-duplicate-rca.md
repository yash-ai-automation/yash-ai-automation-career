# RCA — Yash/Shivani autonomous pipeline: 20-min timeout → re-queue → false "duplicate" / spurious failure

**Date:** 2026-05-29
**Severity:** High (live production; correct work reported as skipped/failed; PDFs not delivered)
**Components:** `services/pipeline-orchestrator.mjs` (shared by both tenants), `yash-resume-pipeline.mjs`, `shivani-resume-pipeline.mjs`
**Fix branch:** `fix/orchestrator-timeout-requeue-false-duplicate`
**Plan:** `docs/superpowers/plans/2026-05-29-yash-pipeline-timeout-requeue-fix.md`

## Symptom

Three URLs added ~12:02 ET. None reported success. The bot re-queued runs that had already completed and ultimately reported **"Skipped: duplicate (all artifacts already exist)"** (OpenLoop) or **failed** (StackAdapt, Cineplex), even though the resume + cover letter were correctly generated and on disk.

## Evidence (SQLite `runs` + `data/yash-resume-runs.log` + on-disk artifacts)

| run | queue/url | status | window | error |
|----|-----------|--------|--------|-------|
| 85–87 | 65 Cineplex | fail | 20m each | `claude -p exit 143 signal none` |
| 88 | 66 OpenLoop | fail | 17:03→17:23 (**20m**) | `claude -p exit 143` — yet the audit log shows `status:ok` (score 100, both PDFs) at **17:22:38**, 25 s before the kill |
| 89 | 66 OpenLoop | ok | 17:23→17:25 | dedup-skip of run 88's artifacts → surfaced as "duplicate" |
| 90 | 67 StackAdapt | fail | 20m | `claude -p exit 143` |
| 91–92 | 67 StackAdapt | fail | 4–5m | `incomplete_artifacts: jd (not declared)` (agent duplicate-skipped but wrote no audit line) |

`exit 143` = 128 + SIGTERM(15). All "20m" runs were force-killed at the wall-clock timeout. **All three URLs' artifacts exist on disk and are correct** (OpenLoop full; StackAdapt full; Cineplex JD+resume, missing only the cover letter).

## Root cause

1. **`PER_URL_TIMEOUT_MS = 20 min`** (hard-coded). A full run legitimately takes ~16–25 min under Sonnet 4.6 / xhigh, so long runs were SIGTERM'd just as/after they finished.
2. **`tickOnce` gated success on `result.exitCode === 0` only.** A run killed at the timeout exits 143 ≠ 0 → treated as failure → 3-strike **re-queue**, discarding the audit-log + on-disk evidence that it had completed.
3. The re-dispatch then hit the pipeline's own duplicate detection → false **"duplicate (all artifacts already exist)"** (OpenLoop), or duplicate-skipped without writing the audit JSONL line → **`incomplete_artifacts`** (StackAdapt), or restarted from scratch and timed out again (Cineplex).
4. `realSpawn` matched the audit line by URL only (last line), a latent staleness risk on retries.
5. `resumeInFlightRun` (reboot-resume path) had the same exit-code-only gate.

## Fix

- **Configurable timeout, default 35 min** (`resolveRunTimeoutMs`, env `PER_URL_TIMEOUT_MS`).
- **Ground-truth success in `tickOnce`:** a run is successful when it legitimately skipped OR all three declared artifacts exist on disk — regardless of exit code. Cancellation still wins; a clean exit (0) with no artifacts is still rerouted to `incomplete_artifacts` + retry.
- **`findAuditResult`** scopes the audit-log match to the run window (`timestamp >= startedAt`), so a stale prior-attempt line can't falsely credit a later attempt.
- **`mark-skipped` now writes a deterministic `status:skip` audit line** (yash + shivani), removing the dependence on the agent remembering a separate `log --status skip`.
- **`resumeInFlightRun`** credited additively by ground truth too (exit 0 OR artifacts/skip).

## Locked operator decisions (2026-05-29)

- Keep `--effort xhigh` (model already `claude-sonnet-4-6`); do NOT set `max` — more effort = longer runs = more timeouts.
- Fix both tenants (shared orchestrator).
- Re-deliver OpenLoop + StackAdapt PDFs and generate Cineplex's missing cover letter.
- Deploy as soon as tests pass.

## Verification

`npm run test:services` (318) + `tests/yash-resume-pipeline.test.mjs` / `tests/shivani-resume-pipeline.test.mjs` (117) green, including new regression suites `tests/services/orchestrator-timeout-success.test.mjs` and the `resume-inflight` SIGTERM-with-artifacts case. Production smoke via a live URL after deploy.

## Out of scope (follow-ups)

- Cosmetic `slug` slash inconsistency (`Company/Role` vs `Company_Role`) in some audit lines.
- A dedicated short JD-fetch sub-timeout for Workday-style hangs (Cineplex).
- Checkpoint-resume across the per-URL timeout (the timeout bump makes single-attempt completion the norm).
