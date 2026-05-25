# 2026-05-25 — Yash Pipeline Self-Improvement Layer: Architecture Spec

**Status:** Architecture spec, brainstorming-locked. Implementation plan follows in a companion file.
**Scope:** `yash-pipeline-autonomous-agent` ONLY — the 24/7 Telegram-triggered wrapper around `/yash-resume-pipeline` on the Hostinger VPS.
**Input audit:** `docs/superpowers/audits/2026-05-24-yash-pipeline-self-improvement-audit.md`
**Locked baseline architecture:** `docs/superpowers/specs/2026-05-24-yash-pipeline-autonomous-agent-architecture.md`
**Companion (next):** `docs/superpowers/specs/2026-05-25-yash-pipeline-self-improvement-implementation.md`

---

## Brief

The autonomous agent today executes the locked `yash-resume-pipeline` playbook 24/7 but has no memory of past runs, no learning loop, no observability beyond journald, and no automated remediation. This spec adds all four — as a strictly non-invasive overlay — by adopting the audit's three-phase plan (A, B, C) and adding a fourth phase (D) for prompt-version regression eval.

**Headline:** every change here lives in `services/`, `tests/`, `systemd/`, `ops/`, or `.github/`. Zero edits to locked prompts, zero new `claude -p` calls, zero new inbound ports, zero RAM on the hot path. All four phases ship behind feature flags that default OFF; merging the code never changes runtime behavior.

---

## 0. Brainstorming-locked decisions

These are the design questions resolved during brainstorming. Each is closed — do NOT re-litigate in implementation. Any change to any of these requires a spec amendment, not a code-level decision.

| # | Decision | Choice |
|---|---|---|
| 1 | Baseline | Adopt audit's Phase A + B + C as the foundation; extend with Phase D |
| 2 | Scope | `yash-pipeline-autonomous-agent` only (no Shivani pipeline, no future autonomous-Shivani) |
| 3 | Audit extension | Strict — no additions beyond audit's six capabilities (no cache-hit telemetry, no success-pattern learning, no V2.0 A/B test infra, no extra Telegram self-improvement digests) |
| 4 | Unknown faults | Telegram review queue for manual taxonomy growth — active curator model |
| 5 | Hint cap per spawn | 3 (sorted by `hits DESC, last_seen DESC`) |
| 6 | Watchdog remediations | 5 total: 3 audit baseline (clear /tmp on OOM, recompile-keep-logs on tectonic-missing-file, host-cooldown on scrapling repeat-403) + 2 added (auto-restart on 10-min heartbeat miss, auto-pause on disk free < 1 GB) |
| 7 | Phase D (Promptfoo) | Included as deferred-trigger CI workflow; activates on PRs touching V2.0 prompt or `cv.md` |
| 8 | Hint rollback | Manual `/suppress <signature>` Telegram command sets `suppressed=1` |
| 9 | Skill packaging | Extend existing `yash-pipeline-autonomous-agent` SKILL.md + OPERATIONS.md (no new top-level skill) |
| 10 | Test environment | Mock externals in CI; separate `npm run smoke:cloud` for live verification per phase |

---

## 1. Architecture overview

```
                  Existing hot path (unchanged)
   ┌─────────────────────────────────────────────────────────┐
   │  telegram-listener ──► work-queue.db ──► orchestrator   │
   │                              │              │           │
   │                              │              ▼           │
   │                              │       spawn claude -p    │
   │                              │              │           │
   │                              ▼              ▼           │
   │                          runs table   ops/runs/<id>/    │
   └─────────────────────────────────────────────────────────┘
                                   │
                                   │  (read-only access to artefacts)
                                   ▼
   ┌─────────────────────────────────────────────────────────┐
   │                Self-improvement overlay                  │
   │                                                          │
   │  Phase A: exporter.mjs ─► Langfuse Cloud Hobby (cloud)  │
   │      timer-driven, post-hoc, batched                    │
   │                                                          │
   │  Phase B: db.mjs + orchestrator extension               │
   │      pre-spawn:  injectHints() → $LEARNED_HINTS         │
   │      post-fail:  learnFromFailure() → failure_patterns  │
   │                                                          │
   │  Phase C: watchdog.mjs (3rd user daemon)                │
   │      tails journald, runs 5 remediations                │
   │      orchestrator also pings Healthchecks.io / 60s      │
   │                                                          │
   │  Phase D: .github/workflows/prompt-eval.yml             │
   │      runs Promptfoo on PRs touching V2.0/cv.md          │
   └─────────────────────────────────────────────────────────┘
```

### 1.1 Invariants preserved

Restated from the audit and the locked architecture spec. Any PR violating any of these is a merge blocker.

- `modes/yash-resume-pipeline.md` — not modified.
- `resume-optimization-system-based-on-job-description.md` (V2.0 resume prompt) — not modified.
- `cover-letter-system-based-on-jd-and-resume.md` — not modified.
- `cv.md` — not modified.
- "claude-runner is the only LLM agent" (architecture spec § 2) — no new `claude -p` calls anywhere; Phase B uses pure regex; Phase C uses pattern matching on journald JSON; Phase D is CI-only.
- Zero inbound ports (architecture spec § 8.2) — exporter and orchestrator both call OUT to Langfuse / Healthchecks.io; watchdog only reads local journald via subprocess.
- Career-ops tracker isolation (architecture spec § 0) — overlay never touches `data/applications.md` or `batch/tracker-additions/`.

### 1.2 Feature flags

All flags in `/etc/yash-pipeline/agent.env`. Default OFF. Code merges do not change behavior.

| Flag | Purpose | Default |
|---|---|---|
| `FEATURE_EXPORTER` | Enable `services/exporter.mjs` + its systemd timer | `0` |
| `FEATURE_FAILURE_KB` | Enable `learnFromFailure()` + `injectHints()` in orchestrator (table migration runs regardless) | `0` |
| `FEATURE_WATCHDOG` | Enable `services/watchdog.mjs` + heartbeat ping in orchestrator | `0` |
| `FEATURE_PROMPT_EVAL` | GitHub Actions variable (repo settings) gating the workflow | `0` |

### 1.3 Resource budget

| Resource | Cost | Note |
|---|---|---|
| RAM | ~30 MB total (exporter ~10 MB during 5-min timer ticks, watchdog ~30 MB steady-state) | Inside spec § 11.4's ~2 GB headroom |
| Disk | `failure_patterns` capped at ~100 rows; `ops/kb-review-queue/` grows by ~1 file per unknown fault | Phase C disk-pause catches runaway growth |
| Money | $0 (Langfuse Cloud Hobby 50k obs/mo, Healthchecks.io 50 monitors free, Promptfoo MIT) | Audit § 6 cost ledger |
| New env vars | 4 (`LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_HOST`, `HEALTHCHECK_PING_URL`) + 4 feature flags | Documented in `agent.env.example` |

---

## 2. Components

### 2.1 Phase A — Observability exporter

| File | Status | Target LOC | Responsibility |
|---|---|---|---|
| `services/exporter.mjs` | NEW | ~150 | Read recent `runs` rows + matching `ops/runs/<id>/events.jsonl`, batch-POST to Langfuse `/api/public/ingestion`, persist cursor in new `exporter_state(key, value)` table. Idempotent: re-running with same cursor is a no-op. |
| `services/db.mjs` | EXTEND | +25 | Add `exporter_state` migration + helpers `getCursor()` and `setCursor()`. |
| `systemd/exporter.service` | NEW | ~20 | `--user` oneshot. Runs `node services/exporter.mjs`, exits cleanly. |
| `systemd/exporter.timer` | NEW | ~15 | `OnUnitInactiveSec=5min`. Guarded by `FEATURE_EXPORTER=1` in `ExecCondition=`. |

### 2.2 Phase B — Failure-pattern KB + preamble injection

| File | Status | Target LOC | Responsibility |
|---|---|---|---|
| `services/db.mjs` | EXTEND | +35 | `failure_patterns` table migration (schema in § 2.5) + helpers `upsertPattern()` and `topHintsByHost()`. |
| `services/failure-kb.mjs` | NEW | ~120 | Pure functions: `extractSignature(errorText, runMeta)` runs the 6-regex catalogue and returns `{signature, hint}` or `{unknown: true, snippet}`; `learnFromFailure(db, runId, errorText)` upserts. |
| `services/pipeline-orchestrator.mjs` | EXTEND | +40 | Wire-up only: call `topHintsByHost()` before `renderPreamble()`, pass result as `$LEARNED_HINTS`; call `learnFromFailure()` in the post-fail branch; route `{unknown: true}` results to `ops/kb-review-queue/<run_id>.json`. |
| `ops/preambles/fresh-run.md` | EXTEND | +5 lines | Add `## Recent patterns for this host\n$LEARNED_HINTS` block; `renderPreamble()` omits the block when substitution is empty. |
| `services/telegram-listener.mjs` | EXTEND | +60 | New commands: `/patterns` (top 10 by hits), `/suppress <signature>` (set `suppressed=1`), `/unpause` (clear `paused=1` on `work_queue`). All gated by the existing 1-user allowlist. |

### 2.3 Phase C — Watchdog + heartbeat

| File | Status | Target LOC | Responsibility |
|---|---|---|---|
| `services/watchdog.mjs` | NEW | ~250 | Spawns `journalctl --user -f -u pipeline-orchestrator -u telegram-listener -o json`; runs the 5-rule ruleset (§ 2.6); writes outcome to `failure_patterns` (closes Phase B loop). |
| `systemd/watchdog.service` | NEW | ~20 | Third `--user` daemon. `Restart=always`. Guarded by `FEATURE_WATCHDOG=1`. |
| `services/pipeline-orchestrator.mjs` | EXTEND | +15 | `setInterval(() => fetch(process.env.HEALTHCHECK_PING_URL).catch(()=>{}), 60_000)` at boot. Never throws on heartbeat fail. |
| `services/db.mjs` | EXTEND | +10 | Add `paused INTEGER NOT NULL DEFAULT 0` column to `work_queue`. Orchestrator spawn-tick honors it. |

### 2.4 Phase D — Promptfoo regression eval

| File | Status | Target LOC | Responsibility |
|---|---|---|---|
| `.github/workflows/prompt-eval.yml` | NEW | ~60 | Triggers on PRs touching `resume-optimization-system-based-on-job-description.md`, `cv.md`, or `tests/fixtures/jds/**`. Gated by repo variable `FEATURE_PROMPT_EVAL == '1'`. Runs `npx promptfoo eval -c tests/promptfoo.yaml`. |
| `tests/promptfoo.yaml` | NEW | ~80 | 5 synthetic JD fixtures × deterministic asserts (bullet count = 15, skill categories = 6, no metric outside `cv.md`). Anthropic provider, `ANTHROPIC_API_KEY` from GH secrets. |
| `tests/fixtures/jds/*.md` | NEW | 5 files | Synthetic JDs covering lever, ashby, greenhouse, workday, direct-portal shapes. No real company text. |

### 2.5 Schema additions to `ops/work-queue.db`

```sql
-- Phase A
CREATE TABLE IF NOT EXISTS exporter_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Phase B
CREATE TABLE IF NOT EXISTS failure_patterns (
  signature   TEXT PRIMARY KEY,        -- e.g. "scrapling:cloudflare:greenhouse.io"
  hint        TEXT NOT NULL,           -- single sentence injected into preamble
  hits        INTEGER NOT NULL DEFAULT 1,
  first_seen  TEXT NOT NULL,           -- ISO-8601
  last_seen   TEXT NOT NULL,
  last_run_id INTEGER REFERENCES runs(id),
  suppressed  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS failure_patterns_recent ON failure_patterns(last_seen);

-- Phase C
ALTER TABLE work_queue ADD COLUMN paused INTEGER NOT NULL DEFAULT 0;
```

All migrations are idempotent. The Phase C `ALTER TABLE` runs once on boot; subsequent boots no-op via `PRAGMA table_info` check in `db.mjs`.

### 2.6 Watchdog rule set

Each rule is independent, idempotent, and writes its outcome to `failure_patterns` so Phase B's `injectHints` can fold it into future preambles.

| Rule | Trigger pattern (journald JSON) | Remediation | Idempotent? |
|---|---|---|---|
| OOM | `MESSAGE` contains `Out of memory: Killed process` AND unit matches `pipeline-orchestrator` or `telegram-listener` | `rm -rf /tmp/yash-pipeline-*`; UPSERT `watchdog:oom-cleared` | Yes (rm on empty dir is no-op) |
| Tectonic missing file | `MESSAGE` contains `LaTeX Error: File ... not found` AND prior log has tectonic exit-1 within 30 s | `queue.requeue(runId, {keepLogs:true})`; UPSERT `watchdog:tectonic-missing-file` | Yes (requeue check guards re-entry) |
| Host repeat-403 | Two `scrapling 403` errors on same host within 30 min | UPSERT `watchdog:host-cooldown:<host>` with hint suggesting 30-min wait | Yes (UPSERT) |
| Heartbeat miss | No journald entries from `pipeline-orchestrator` for > 10 min | `systemctl --user restart pipeline-orchestrator`; UPSERT `watchdog:orchestrator-restart` | Yes (restart on healthy daemon is one bounce) |
| Disk free | `df -BG /` reports `<1G` | `db.exec("UPDATE work_queue SET paused=1 WHERE status='queued'")`; UPSERT `watchdog:disk-pause`; Telegram alert | Yes (re-run sets paused=1 again, no harm) |

### 2.7 Cross-cutting

| File | Status | Target LOC | Responsibility |
|---|---|---|---|
| `/etc/yash-pipeline/agent.env.example` | EXTEND | +7 vars | Document all new env vars + feature flags |
| `.claude/skills/yash-pipeline-autonomous-agent/SKILL.md` | EXTEND | +30 lines | "Self-Improvement Layer" section: feature-flag table, `/patterns`+`/suppress`+`/unpause` cmds, watchdog rule summary |
| `OPERATIONS.md` (repo root) | EXTEND | +80 lines | New section: enable/disable each phase, KB curation workflow, watchdog log reading, Langfuse dashboard URLs, smoke-test recipes |

**Total new code budget:** ~880 LOC across 7 new files + 5 fixture files; ~190 LOC of extensions across 5 existing files. No deletes; no refactors of existing services.

---

## 3. Data flow

### 3.1 Pre-spawn hint injection (Phase B, hot path)

```
orchestrator.tick()
  └─► dequeue URL
        └─► extractHost(url) → "lever.co"
              └─► db.topHintsByHost(host, cap=3, days=90)
                    └─► SELECT signature, hint
                        FROM failure_patterns
                        WHERE (signature LIKE 'lever:%' OR hint LIKE '%lever%')
                          AND suppressed = 0
                          AND last_seen > date('now','-90 days')
                        ORDER BY hits DESC, last_seen DESC LIMIT 3
                          ↓
                        ["scrapling-403 → use browser fallback",
                         "lever portal → JD lives in iframe at #app"]
                          ↓
              renderPreamble({URL, RUN_ID, ..., LEARNED_HINTS: bullets.join('\n')})
                    ↓
              spawn claude -p --model claude-opus-4-7
```

Latency budget: 1–3 ms (SQLite WAL query). Invisible against multi-minute Claude run.

Empty-result handling: `topHintsByHost` returns `[]` → `$LEARNED_HINTS` substitutes to empty string → `renderPreamble` omits the entire "Recent patterns for this host" block. No false hints on cold KB.

### 3.2 Post-fail learning (Phase B, slow path)

```
claude -p exits non-zero
  └─► orchestrator reads ops/runs/<id>/claude.log tail (last 4 KB)
        └─► failureKb.extractSignature(errorText, {url, exitCode})
              ├─► regex match? → {signature, hint}
              │     └─► db.upsertPattern(signature, hint, runId)
              │
              └─► no match? → {unknown: true, snippet}
                    └─► write ops/kb-review-queue/<run_id>.json
                    └─► notifier.tg("new fault signature at <host>: <snippet>")
```

Write volume estimate: at 20 runs/day cap × ~5% failure rate → ~1 new row/day. After 90 days, ~30 unique signatures.

### 3.3 Periodic trace export (Phase A)

```
systemd timer fires every 5 min
  └─► exporter.mjs starts
        └─► db.getCursor("exporter.last_run_id") → 1247
              └─► SELECT * FROM runs WHERE id > 1247 ORDER BY id LIMIT 50
                    ├─► build Langfuse trace per row (+ events.jsonl observations)
                    └─► POST /api/public/ingestion (gzipped batch)
                          ↓
                          200 → db.setCursor("exporter.last_run_id", 1297)
                          5xx/429/network → exit 0, retry next tick
```

Backpressure: 7-day Langfuse outage backlogs ~140 rows — well under 50-batch limit. Cursor never advances past unsent rows.

Quota math: 20 runs/day × ~30 observations/run × 30 days = 18k observations/month vs 50k/month cap → 64% headroom.

### 3.4 Heartbeat + watchdog (Phase C)

```
orchestrator boot
  └─► setInterval(60_000)
        └─► fetch(HEALTHCHECK_PING_URL).catch(()=>{})

watchdog.mjs (independent daemon)
  └─► spawn journalctl --user -f -u pipeline-orchestrator -u telegram-listener -o json
        └─► match against 5-rule set (§ 2.6)
        └─► remediate + UPSERT pattern + (sometimes) Telegram alert

Healthchecks.io (cloud, outer net)
  └─► no ping for 2 windows → Telegram via HC integration
```

Watchdog is the inner self-healing loop; Healthchecks.io is the outer dead-man's-switch.

### 3.5 Operator commands (Phase B surface, in telegram-listener)

```
/patterns
  └─► SELECT signature, hits, last_seen, suppressed
       FROM failure_patterns ORDER BY hits DESC LIMIT 10
  └─► reply as markdown table

/suppress <signature>
  └─► UPDATE failure_patterns SET suppressed=1 WHERE signature = ?
  └─► reply "✅ suppressed"

/unpause
  └─► UPDATE work_queue SET paused=0
  └─► reply "✅ queue resumed; <n> rows unpaused"
```

All three gated by existing 1-user allowlist in `services/telegram-listener.mjs`.

---

## 4. Error handling

### 4.1 Phase A — exporter

| Failure | Behavior | Surface |
|---|---|---|
| Langfuse 5xx / timeout | exit 0, cursor unchanged, retry next tick | none (observability outage ≠ pipeline outage) |
| Langfuse 401/403 | exit 1, systemd records failure | journald: `exporter auth failed` |
| Corrupt `events.jsonl` | skip file, advance cursor past it | journald warn |
| Cursor row missing | auto-init to `0` | first run backfills everything |
| Quota exceeded (429) | exit 0, cursor unchanged | dashboard shows trend 5+ days early |

Hot-path impact: **zero**.

### 4.2 Phase B — failure-kb + orchestrator

| Failure | Behavior | Surface |
|---|---|---|
| `topHintsByHost()` throws | catch, treat as `[]`, spawn proceeds without hint | journald warn |
| `learnFromFailure()` throws | catch, run's fail-bookkeeping proceeds | journald warn |
| Malformed hint string | `renderPreamble` escapes / strips | none |
| Hint produces worse run | `/suppress` via Telegram | user-driven |
| Telegram unknown-fault notify fails | review-queue JSON still on disk | `ls ops/kb-review-queue/` |
| `ops/kb-review-queue/` write fails | warn + skip; Phase C disk-watch fires | journald error |

Hot-path impact: degrades to **"no hints injected"** in worst case — equivalent to today's posture.

### 4.3 Phase C — watchdog + heartbeat

| Failure | Behavior | Surface |
|---|---|---|
| `journalctl -f` dies | watchdog respawns via `Restart=always` | none |
| False-positive remediation | each remediation is idempotent; user can `/unpause` | one bounce + journald entry |
| Remediation during running spawn | OOM cleanup waits; host-cooldown doesn't interrupt | none for in-flight |
| Heartbeat fetch fails | wrapped in `.catch(()=>{})` | Healthchecks.io fires Telegram after 2 misses |
| Healthchecks.io down | fetch resolves on DNS, no orchestrator impact | extended HC down-window |
| Watchdog itself dies | systemd restart + Healthchecks.io as outer net | covered |
| Heartbeat env var missing | orchestrator logs warn at boot, skips heartbeat | journald warn |
| Disk-pause false trigger | user runs `/unpause` | Telegram alert |

Hot-path impact: degrades to **"no automated remediation"** — equivalent to today's posture.

### 4.4 Phase D — Promptfoo CI

| Failure | Behavior | Surface |
|---|---|---|
| `ANTHROPIC_API_KEY` missing | workflow fails fast | PR check red |
| Asserts fail on V2.0 edit | PR blocked from merge | reviewer reads diff |
| Buggy fixture | one-time false positive | fix on same branch |
| Anthropic quota hit | workflow times out | re-run after wait |
| `FEATURE_PROMPT_EVAL` not set | workflow gate exits 0 | check green, no-op |

Hot-path impact: **zero** — VPS never sees Phase D.

### 4.5 Cross-cutting safety properties

1. Every overlay **write** is to non-critical state (`failure_patterns`, `exporter_state`, `ops/kb-review-queue/`, `paused` column). Never blocks the existing `runs`, `work_queue` (rows), or `ops/runs/<id>/` artefacts.
2. Every overlay **read** of locked data is read-only (`runs` table, `events.jsonl`, `claude.log` tail). Never writes them.
3. **No new dependency on cloud services for the inner loop.** Even with Langfuse, Healthchecks.io, and GitHub Actions all simultaneously down, the orchestrator + listener + claude-runner still serve URLs.

---

## 5. Testing strategy

### 5.1 Layer 1 — Unit tests (hermetic, mocked externals)

Run with existing `node --test` harness.

| New file | Test file | Cases |
|---|---|---|
| `services/exporter.mjs` | `tests/services/exporter.test.mjs` | 12 — cursor idempotence, batched POST, advance only on 200, no-advance on 5xx/429/network err, malformed events.jsonl skipping, empty result no-op, auth-error logs+exit-1, trace shape, gzip body, cursor auto-init |
| `services/failure-kb.mjs` | `tests/services/failure-kb.test.mjs` | 15 — each of 6 regexes against canonical samples, unknown returns `{unknown,snippet}`, hint cap 100 chars, signature determinism, upsert increments hits, first_seen on insert, suppressed=1 ignored by lookup, >90d-old excluded, LIMIT 3, host extraction edge cases, regex catalogue exported |
| `services/watchdog.mjs` | `tests/services/watchdog.test.mjs` | 18 — 5 rules happy-path + idempotency, OOM skip on empty /tmp, tectonic only on exit-1+missing-file, heartbeat threshold = exactly 10 min, disk threshold = exactly 1 GB, host match across query strings, journalctl respawn, rule writes to `failure_patterns`, Telegram mocked, fake-clock fixture |
| `services/db.mjs` ext | `tests/services/db-extensions.test.mjs` | 8 — both migrations idempotent, `paused` default = 0, `topHintsByHost` index usage, UPSERT semantics, `setCursor` overwrites, FK on `last_run_id` |

**Total new unit tests:** ~53. Existing 108 must remain green → final baseline ≥ 161 tests.

**Mocking discipline:**
- HTTP → `fetch` injected via factory (`createExporter({httpClient})`).
- `journalctl` → spawn stubbed with JSON-line fixtures under `tests/fixtures/journald/`.
- Telegram → existing `notifier.mjs` mock pattern.
- Filesystem → real temp dirs under `tests/tmp/`, cleaned in `afterEach`.

### 5.2 Layer 2 — E2E tests (whole-loop, deterministic, no network)

| Scenario | File | Proves |
|---|---|---|
| Pre-spawn hint injection | `tests/e2e/hint-injection.e2e.mjs` | Seed 5 patterns for `lever.co`; enqueue URL; assert preamble (captured via stub `claude` binary in `tests/bin/`) contains top-3 hints |
| Post-fail KB write | `tests/e2e/learn-on-fail.e2e.mjs` | Stub `claude` exits 1 with Cloudflare-403; assert pattern row inserted with `hits=1` |
| Unknown fault routing | `tests/e2e/unknown-fault-routing.e2e.mjs` | Stub `claude` exits with novel error; assert `ops/kb-review-queue/<run_id>.json` exists + mocked Telegram message sent |
| Exporter cursor advance | `tests/e2e/exporter-cursor.e2e.mjs` | Insert 75 fake runs; run exporter twice with stub Langfuse 200; assert two batches + cursor |
| Watchdog OOM remediation | `tests/e2e/watchdog-oom.e2e.mjs` | Canned journald stream; assert `/tmp` clean, pattern row, mocked Telegram |
| Watchdog disk-pause | `tests/e2e/watchdog-disk-pause.e2e.mjs` | Mock `df` <1GB; assert `paused=1` rows, no new spawn next tick |
| Telegram `/suppress` | `tests/e2e/suppress-cmd.e2e.mjs` | Seed pattern; send mocked `/suppress`; assert `suppressed=1` + omitted from `topHintsByHost` |
| Feature flag OFF = silence | `tests/e2e/feature-flag-off.e2e.mjs` | All 4 flags = 0; full URL cycle; assert no overlay writes, no behavior change |
| Regression: existing 108 tests | (existing) | `npm test` all green |

### 5.3 Layer 3 — Live smoke (manual, pre-rollout, not in CI)

```bash
npm run smoke:cloud              # all phases
npm run smoke:cloud -- --phase=A # exporter against real Langfuse
npm run smoke:cloud -- --phase=B # KB against snapshot of prod DB
npm run smoke:cloud -- --phase=C # one Healthchecks ping + induced stress-ng
npm run smoke:cloud -- --phase=D # promptfoo against fixtures + real Anthropic
```

### 5.4 Coverage targets

- New files: ≥ 85 % line + branch coverage.
- `services/db.mjs` extensions: keep `db.mjs` ≥ 90 % (current level).
- Existing 108-test suite: 100 % pass rate maintained (regression = PR blocker).

### 5.5 Per-phase gate sequence

```
Phase X unit tests written + failing
   ↓
Phase X implementation
   ↓
Phase X unit tests green
   ↓
Phase X e2e tests green
   ↓
Phase X smoke:cloud green
   ↓
FEATURE_X=1 on prod  ← rollout
```

Phases are independent — Phase B can ship even if Phase A's smoke fails.

---

## 6. Rollout phases & rollback

### 6.1 Rollout order

Cheapest-win-first, lowest-risk-first.

```
Week 1 — Phase A (Observability)
   ↓  green smoke + 48h soak: trace count matches runs row count
Week 2 — Phase B (Failure-pattern KB)
   ↓  green smoke + 48h soak: first real failure produces expected pattern
Week 3 — Phase C (Watchdog + heartbeat)
   ↓  green smoke + induced-OOM test passes
Week 4 — Phase D (Promptfoo CI)
   ↓  one V2.0 edit attempted; PR check fires; merge gated correctly
```

Phase B trails Phase A because Langfuse traces are the measurement instrument for whether Phase B's hints actually help.

### 6.2 Activation gates (operator checklist per phase)

| Gate | Phase A | Phase B | Phase C | Phase D |
|---|---|---|---|---|
| All new unit tests green | ✅ | ✅ | ✅ | ✅ |
| All new e2e tests green | ✅ | ✅ | ✅ | n/a |
| Existing 108 suite green | ✅ | ✅ | ✅ | ✅ |
| `npm run smoke:cloud --phase=X` green | ✅ | ✅ | ✅ | ✅ |
| Env vars present in `agent.env` | `LANGFUSE_*` | (none new) | `HEALTHCHECK_PING_URL` | GH secret + repo var |
| New systemd unit installed + reloaded | `exporter.{service,timer}` | n/a | `watchdog.service` | n/a |
| Documentation updated | OPERATIONS.md § A | OPERATIONS.md § B + SKILL.md | OPERATIONS.md § C + SKILL.md | CONTRIBUTING.md note |

### 6.3 Rollback (one line per phase)

| Phase | Command | Recovery |
|---|---|---|
| A | `systemctl --user disable --now exporter.timer && sed -i 's/^FEATURE_EXPORTER=1/FEATURE_EXPORTER=0/' /etc/yash-pipeline/agent.env` | < 30 s |
| B | `sed -i 's/^FEATURE_FAILURE_KB=1/FEATURE_FAILURE_KB=0/' /etc/yash-pipeline/agent.env && systemctl --user restart pipeline-orchestrator` | < 30 s (table stays) |
| C | `systemctl --user disable --now watchdog.service && sed -i 's/^FEATURE_WATCHDOG=1/FEATURE_WATCHDOG=0/' /etc/yash-pipeline/agent.env && systemctl --user restart pipeline-orchestrator` | < 60 s |
| D | Remove `FEATURE_PROMPT_EVAL` repo variable in GitHub Actions settings | < 30 s |

Total rollback time for all four phases: **under 5 minutes**. No destructive migrations to undo.

### 6.4 Soak observations

| Phase active | Watch | Roll back if |
|---|---|---|
| A | Langfuse trace count vs `SELECT count(*) FROM runs WHERE created_at > <activate>`; should match ±5% over 48 h | <90% match for 24 h |
| A+B | First 10 real failures → sensible row in `failure_patterns`; hint visible in `ops/runs/<id>/claude.log` head; second occurrence of same fault completes faster | 3 suppressions in a week |
| A+B+C | Zero false-positive remediations over 48 h; 100 % HC uptime modulo expected restarts; one controlled bounce recovery | one false-positive disk-pause OR one mistaken orchestrator restart |
| A+B+C+D | First V2.0 edit PR fires the workflow, asserts green, merge proceeds | check wrong on known-good V2.0 |

### 6.5 Decision points

- **End of week 1:** Langfuse Hobby quota usage <30 % → continue to B. >50 % trending → evaluate Helicone EU or self-host before B.
- **End of week 8:** `failure_patterns` has <30 unique signatures → plain SQLite stays. >100 → revisit FTS5 or Qdrant (audit § 3.2).
- **End of 90 days:** V2.0 edited at least twice → Phase D placement validated. If not edited, Phase D was over-anticipation; leave running.

### 6.6 Locked-spec invariant checklist (per PR)

Reviewer must confirm before merge:

- ☐ No diff under `modes/yash-resume-pipeline.md`
- ☐ No diff to `resume-optimization-system-based-on-job-description.md`, `cover-letter-system-based-on-jd-and-resume.md`, `cv.md`
- ☐ No new `claude -p` invocation anywhere except the existing orchestrator spawn
- ☐ No new inbound port opened on the VPS
- ☐ All new code under `services/`, `tests/`, `.github/workflows/`, `systemd/`, or `ops/`
- ☐ Every new env var documented in `/etc/yash-pipeline/agent.env.example`

Any failed checkbox = merge blocker.

---

## 7. Open questions deferred to implementation plan

These are deliberately left to the writing-plans phase. They are tactical, not architectural.

1. **Phase B regex catalogue — final patterns.** This spec names six signatures (Cloudflare 403, tectonic exit, validator-bullet-count, OOM, rate limit, Telegram outage). The exact regex strings, capture groups, and hint texts are authored in the implementation plan with real error-log samples from `data/yash-resume-runs.log`.
2. **Watchdog rule thresholds — confirmation.** Defaults: heartbeat-miss = 10 min, disk-pause = 1 GB, host-cooldown = 30 min, OOM signature = exact kernel string. Implementation plan validates each threshold against 30 days of journald history before locking.
3. **Promptfoo assert authoring.** This spec names "bullet count = 15, skill categories = 6, no metric outside `cv.md`". Implementation plan writes the exact YAML assertions and validates them against the canonical V2.0 prompt + 5 synthetic fixtures.
4. **Synthetic JD fixture authoring.** 5 files covering lever / ashby / greenhouse / workday / direct-portal shapes. Content is synthetic — no real company text. Authored during Phase D implementation.
5. **`smoke:cloud` script implementation.** This spec specifies behavior; the implementation plan writes the bash + Node entry points.

---

## 8. Files referenced

Input documents read during brainstorming (none modified):

- `docs/superpowers/audits/2026-05-24-yash-pipeline-self-improvement-audit.md`
- `docs/superpowers/specs/2026-05-24-yash-pipeline-autonomous-agent-architecture.md` (referenced indirectly via audit)
- `AGENTS.md`
- `OPERATIONS.md`
- `.claude/skills/yash-pipeline-autonomous-agent/SKILL.md`
- `services/pipeline-orchestrator.mjs` (sizing)
- `services/telegram-listener.mjs` (sizing)
- `services/db.mjs` (current schema)
- `services/logger.mjs` (Pino integration, already merged)
- `tests/services/*` (existing 108 tests)
- `ops/preambles/fresh-run.md` (substitution surface)
- `ops/work-queue.db` (existing schema)

External tools referenced (verified May 2026, see audit § 3 for pricing):

- Langfuse Cloud Hobby: 50k observations/month, free, 30-day retention
- Healthchecks.io: 50 monitors free, 5-min minimum check, native Telegram channel
- Promptfoo: MIT, $0, GitHub Actions integration

---

## 9. Sign-off

- Brainstorming-locked decisions: § 0 — closed
- Architecture: § 1–§ 2 — locked
- Data flow: § 3 — locked
- Error handling: § 4 — locked
- Testing strategy: § 5 — locked
- Rollout & rollback: § 6 — locked
- Open questions (implementation-plan scope): § 7

**Spec status:** drafted, pending user review.
**Next deliverable:** `docs/superpowers/specs/2026-05-25-yash-pipeline-self-improvement-implementation.md` via the `superpowers:writing-plans` skill.
