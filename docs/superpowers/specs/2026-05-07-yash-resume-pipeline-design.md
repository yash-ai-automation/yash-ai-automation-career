# Spec — Yash Resume Pipeline (JD Extract → V2.0 Resume)

**Date:** 2026-05-07
**Status:** Approved (brainstorming complete, awaiting plan)
**Owner:** Yash Anghan (developer@acodesoft.com)
**Branch target:** `main`

---

## 1. Context and motivation

The user wants a daily two-phase pipeline that turns a list of job-listing URLs into per-job tailored resume PDFs:

1. **Phase 1 — JD extraction**: navigate each URL with browser automation, extract the full job description, save as a structured Markdown file under `jds/`.
2. **Phase 2 — Resume generation**: feed each saved JD into the existing strict resume optimization prompt (`resume-optimization-system-based-on-job-description.md`), capture the LaTeX output, compile to PDF via Tectonic, save under `resumes/`.

The repo already contains a related but heavier pipeline (`modes/auto-pipeline.md` → evaluation A–G + report + score gate + tracker entry). The new flow is intentionally a stripped-down sibling of that pipeline: no evaluation report, no score gate, no tracker mutation. It produces only the JD `.md` and the resume PDF (plus a sidecar `.log`).

Both flows coexist on the same input file (`data/pipeline.md`); the user explicitly chooses which one to run via a slash command.

## 2. Decisions locked in (during brainstorming)

| Concern | Choice |
|---|---|
| Link inbox | `data/pipeline.md` (existing format with `## Pendientes` / `## Procesadas`) |
| Coexistence | New command `/yash-resume-pipeline`. Existing `/career-ops pipeline` untouched. |
| Browser tool | Playwright CLI (`@playwright/cli`, bundled Chromium, headless) |
| Slug format | PascalCase, alnum-only, e.g. `AnthropicPbc_SeniorAiMlEngineer` |
| Date format | ISO `YYYY-MM-DD` |
| Duplicates | Skip + warn (idempotent) |
| Trigger | Manual slash command, sequential, asks before each URL |
| JD schema | YAML frontmatter + cleaned full body |
| Score < 90 | Compile to PDF anyway; sidecar `.log` records score and deficiencies |
| Extract failure | Mark `- [!]` with reason, skip, continue |
| Logging | Single rolling `data/yash-resume-runs.log` (append-only) |
| Stop conditions | User quits, queue empty, or 3 consecutive failures |

## 3. Architecture

```
yash-ai-automation-career/
├── data/
│   ├── pipeline.md                     ← existing inbox (URLs go here)
│   └── yash-resume-runs.log            ← NEW append-only run log
├── jds/
│   └── JD_<CompanySlug>_<RoleSlug>_Yash_Anghan_<YYYY-MM-DD>.md   ← NEW per-JD
├── resumes/
│   ├── <CompanySlug>_<RoleSlug>_Yash_Anghan_Resume_<YYYY-MM-DD>.pdf  ← NEW
│   ├── <CompanySlug>_<RoleSlug>_Yash_Anghan_Resume_<YYYY-MM-DD>.tex  ← NEW
│   └── <CompanySlug>_<RoleSlug>_Yash_Anghan_Resume_<YYYY-MM-DD>.log  ← NEW sidecar
├── modes/
│   └── yash-resume-pipeline.md         ← NEW orchestration prompt
├── .claude/commands/
│   └── yash-resume-pipeline.md         ← NEW slash-command shim
├── tests/
│   ├── fixtures/jds/                   ← NEW saved HTML JD pages for smoke tests
│   ├── yash-resume-pipeline.test.mjs   ← NEW unit tests
│   └── test-yash-pipeline-smoke.mjs    ← NEW end-to-end smoke test
├── yash-resume-pipeline.mjs            ← NEW deterministic orchestrator
├── generate-pdf-latex.mjs              ← existing (used as-is)
└── resume-optimization-system-based-on-job-description.md  ← existing (applied verbatim)
```

### 3.1 Component responsibilities

| Component | Owns |
|---|---|
| `modes/yash-resume-pipeline.md` | The interactive loop, user prompts, JD field extraction (LLM judgment), V2.0 prompt application, content-shaped file writes (JD `.md`, `.tex`, sidecar `.log`). |
| `yash-resume-pipeline.mjs` | All deterministic operations: slugify, duplicate detection, atomic mutations of `data/pipeline.md`, append to `data/yash-resume-runs.log`, invocation of `generate-pdf-latex.mjs`. Pure file/string operations; no network. |
| `.claude/commands/yash-resume-pipeline.md` | Two-line shim that registers `/yash-resume-pipeline` as a top-level slash command pointing at the mode file. |
| `generate-pdf-latex.mjs` | Existing Tectonic wrapper. Used unchanged. |
| `resume-optimization-system-based-on-job-description.md` | Existing V2.0 prompt. Read by Claude in-context and applied to the JD body. Its output rules govern what comes back (LaTeX block, optionally preceded by deficiency lines). |

### 3.2 External dependencies (verified present)

- `playwright-cli` v0.1.7 (`~/.npm-global/bin/playwright-cli`)
- Chromium for Testing 147.0.7727.49 (cached at `~/.cache/ms-playwright/`)
- `tectonic` at `/usr/local/bin/tectonic`
- Node.js v22.22.2

No new packages need to be installed.

## 4. Per-URL data flow

```
[Claude]   reads modes/yash-resume-pipeline.md when /yash-resume-pipeline runs
[Script]   yash-resume-pipeline.mjs next-pending
              → returns first `- [ ] <url>` from data/pipeline.md, or {"status":"empty"}
[Claude]   asks user: "Process <url>? (yes / skip / quit)"

  if quit                → stop the loop
  if skip                → mark-skipped --reason "user skipped"; continue
  if yes                 ↓

[Tool]     playwright-cli open <url> --browser=chromium
[Tool]     playwright-cli eval "() => document.title"
[Tool]     playwright-cli eval "() => document.body.innerText"
[Tool]     playwright-cli close

  on any tool error      → mark-failed --reason "playwright: <e>"; log; ask continue

[Claude]   parses raw text → company, role, location, posted_date
              (LLM judgment; URL host gives a portal hint: lever, ashby, greenhouse, workday)
              if company/role confidence is low → ask user once to confirm
              if user can't say   → mark-failed --reason "could not determine company/role"
[Script]   slugify --company "<c>" --role "<r>"
              → { company_slug, role_slug, date }
[Script]   check-duplicate --company-slug … --role-slug … --date …
              if exists           → mark-skipped --reason "duplicate"; log; continue

[Claude]   writes jds/JD_<c>_<r>_Yash_Anghan_<date>.md
              ┌─ YAML frontmatter
              │   company:        "Anthropic, PBC"
              │   company_slug:   AnthropicPbc
              │   role:           "Senior AI/ML Engineer"
              │   role_slug:      SeniorAiMlEngineer
              │   url:            https://...
              │   source:         lever | ashby | greenhouse | workday | other
              │   location:       "Remote (US/Canada)"
              │   posted_date:    2026-05-01     # if visible on page; else null
              │   captured_date:  2026-05-07
              └─ body: cleaned full JD as markdown
[Claude]   applies resume-optimization-system-based-on-job-description.md
              to the JD body in-context (one-shot LLM application; no API call).
              The V2.0 prompt's output rules produce one of:
                a) just LaTeX (score ≥ 90)
                b) "OPTIMIZATION INCOMPLETE — Score: X/100\nDeficiencies:\n…\n\n<LaTeX>"
                c) "CONTEXTUALIZATION DEFICIENCY DETECTED\n…\n\n<LaTeX>"
                d) "SENTENCE COUNT ERROR — CANNOT PROCEED\n…"  (no LaTeX, hard fail)
                e) "SKILLS OVERFLOW ERROR — CANNOT PROCEED\n…"  (no LaTeX, hard fail)
[Claude]   parses prompt output:
              - find first `\documentclass`
              - if present: everything before = deficiency log; from \documentclass = LaTeX block
              - if absent: hard-fail. mark-failed --reason "V2.0 hard-fail: <category>";
                save full prompt output as the .log; do NOT write .tex
[Claude]   writes resumes/<c>_<r>_Yash_Anghan_Resume_<date>.tex
[Script]   compile-resume --tex … --pdf …
              wraps `node generate-pdf-latex.mjs <tex> <pdf>`
              if compile fails → mark-failed --reason "tectonic: <tail>"; log; keep .tex; ask continue

[Claude]   writes resumes/<c>_<r>_Yash_Anghan_Resume_<date>.log
              ┌─ score:        92/100
              ├─ deficiencies: (any captured before \documentclass; else "none")
              └─ status:       compiled | compiled-review-recommended (score < 90)
[Script]   mark-processed --url <url> --jd … --pdf … --score … \
                          --company "<c>" --role "<r>"
[Script]   log --status ok --url … --slug … --score … --jd … --pdf …

[Claude]   reports paths + score + review flag to user
[Claude]   asks: "continue with next URL? (yes / quit)"
```

### 4.1 Hard rules

- One URL at a time. **No** parallel processing.
- The pipeline produces files only. It **never** auto-submits applications.
- All mutations of `data/pipeline.md` and `data/yash-resume-runs.log` go through orchestrator subcommands. Claude does **not** edit those files directly.
- Company and role names are **never** fabricated. If extraction is ambiguous, ask the user; if the user can't say, mark failed.

## 5. Orchestrator script API (`yash-resume-pipeline.mjs`)

All subcommands print one JSON object to stdout, exit 0 on success, non-zero on fail.

### 5.1 Subcommands

```
node yash-resume-pipeline.mjs next-pending
  → {"status":"ok","url":"https://…","line_number":42}
  → {"status":"empty"}

node yash-resume-pipeline.mjs slugify \
    --company "Anthropic, PBC" \
    --role    "Senior AI/ML Engineer (Remote)"
  → {"status":"ok",
     "company_slug":"AnthropicPbc",
     "role_slug":"SeniorAiMlEngineer",
     "date":"2026-05-07"}
  → {"status":"fail","error":"empty company slug"}    ← validation hits

node yash-resume-pipeline.mjs check-duplicate \
    --company-slug AnthropicPbc \
    --role-slug    SeniorAiMlEngineer \
    --date         2026-05-07
  → {"status":"ok","exists":false,
     "jd_path":"jds/JD_AnthropicPbc_SeniorAiMlEngineer_Yash_Anghan_2026-05-07.md",
     "pdf_path":"resumes/AnthropicPbc_SeniorAiMlEngineer_Yash_Anghan_Resume_2026-05-07.pdf"}
  → {"status":"ok","exists":true,"which":["jd","pdf"], "jd_path":"…","pdf_path":"…"}

node yash-resume-pipeline.mjs compile-resume \
    --tex resumes/<slug>.tex \
    --pdf resumes/<slug>.pdf
  → {"status":"ok","pdf_path":"…","tectonic_log_tail":"…last 10 lines…"}
  → {"status":"fail","error":"tectonic exit 1: …","tectonic_log_tail":"…"}

node yash-resume-pipeline.mjs mark-processed \
    --url     <url> \
    --company "Anthropic, PBC" \
    --role    "Senior AI/ML Engineer" \
    --jd      <path> \
    --pdf     <path> \
    --score   92
  → {"status":"ok"}

node yash-resume-pipeline.mjs mark-failed \
    --url     <url> \
    --reason  "404 Not Found"
  → {"status":"ok"}

node yash-resume-pipeline.mjs mark-skipped \
    --url     <url> \
    --reason  "duplicate (jd+pdf already exist)"
  → {"status":"ok"}

node yash-resume-pipeline.mjs log \
    --status  ok \
    --url     <url> \
    --slug    AnthropicPbc_SeniorAiMlEngineer \
    --score   92 \
    --jd      <path> \
    --pdf     <path>
  → {"status":"ok"}

node yash-resume-pipeline.mjs log \
    --status  fail \
    --url     <url> \
    --reason  "tectonic compile error"
  → {"status":"ok"}

node yash-resume-pipeline.mjs log \
    --status  skip \
    --url     <url> \
    --reason  "duplicate"
  → {"status":"ok"}
```

### 5.2 Contract rules

- **Idempotent.** `mark-processed` on a URL already in `Procesadas` returns `{"status":"ok"}` without double-writing. `mark-failed` on a `- [!]` line replaces the reason.
- **Atomic writes.** All mutations of `data/pipeline.md` use the read → mutate-in-memory → write `pipeline.md.tmp` → `rename` pattern. Kill mid-run leaves the file consistent.
- **No network.** Script never calls Playwright, Tectonic-the-binary, or the LLM. It only edits files and shells out to `node generate-pdf-latex.mjs` for PDF compilation. Browser/LLM are Claude's responsibility.
- **Deterministic.** Given the same inputs and the same on-disk state, every subcommand produces the same output.
- **No silent overwrites.** `compile-resume` overwrites the `.pdf` for the same `<slug>_<date>` combo (intentional re-runs after fixing a `.tex`). Duplicate detection happens before that, so it only fires when the user really wants to retry.

### 5.3 Slugify rule (precise)

Input: arbitrary string (company name or role title, often with punctuation/casing variants).
Output: PascalCase, alnum-only.

Algorithm:
1. Replace runs of any non-`[a-zA-Z0-9]` character with a single space.
2. Trim and collapse whitespace.
3. Split on whitespace into tokens.
4. For each token: if entire token is uppercase and length ≥ 2, lowercase it then capitalize first letter (so `AI/ML` → tokens `AI`, `ML` → `Ai`, `Ml`); else lowercase the whole token then capitalize first letter (so `senior` → `Senior`, `Engineer` → `Engineer`).
5. Concatenate tokens with no separator.

Examples (these become tests):
| Input | Output |
|---|---|
| `Anthropic, PBC` | `AnthropicPbc` |
| `Senior AI/ML Engineer (Remote)` | `SeniorAiMlEngineer` |
| `Open-AI` | `OpenAi` |
| `M&A Research Lead` | `MAResearchLead` |
| `   spaces   here   ` | `SpacesHere` |
| `42 Watt Studios` | `42WattStudios` |
| `🦾 Robotics Inc` | `RoboticsInc` |
| `` (empty) | empty → script returns `{"status":"fail","error":"empty slug"}` |

**Edge case — `M&A`**: after step 1, `M` and `A` are separate single-character tokens. Step 4 leaves single uppercase letters as-is (the all-caps lowering rule applies only when length ≥ 2). So input `M&A Research Lead` → tokens `M A Research Lead` → output `MAResearchLead`. Tests will pin this exact behavior.

**Locked behavior:** Slugify never ASCII-folds accents. `Société Générale` → `Société` is not a valid slug under the alnum-only rule, so accents get stripped at step 1 (treated as non-alnum). Result: `SociTGNRale` — ugly but deterministic. If the user dislikes this for a specific company, they override by passing `--company "Societe Generale"` (manual ASCII-fold) before slugify.

## 6. Mode file structure (`modes/yash-resume-pipeline.md`)

The mode file is the prompt Claude reads when `/yash-resume-pipeline` runs. Structural outline (full content written during implementation):

```
# Mode: yash-resume-pipeline — JD-extract → V2.0-resume two-phase pipeline

[1-paragraph identity statement]

## Per-run loop
[Step-by-step interactive loop, exactly as Section 4 above]

## Stop conditions
- User says quit
- next-pending returns status=empty
- 3 consecutive failures (safety brake)

## Hard rules
[Bullet list, exactly as Section 4.1 above]

## Parsing the V2.0 prompt's output
[Rules for extracting LaTeX block + score + deficiencies, as Section 4 detailed]
```

### 6.1 Slash command shim

`.claude/commands/yash-resume-pipeline.md`:

```
---
description: Run the JD-extract → V2.0-resume pipeline (one URL at a time).
argument-hint: ""
---

Read modes/yash-resume-pipeline.md and follow it.
```

This makes `/yash-resume-pipeline` a top-level command. Mode content stays in `modes/` next to existing modes for consistency.

## 7. Error handling matrix

| Failure | Detected at | Action | User recovery |
|---|---|---|---|
| Playwright unreachable URL (timeout/DNS/refused) | step 3 | `mark-failed --reason "playwright: <e>"` + log + ask continue | Re-add URL when network restored |
| HTTP 404 / page gone | step 3 | `mark-failed --reason "page not found"` | Leave `[!]` as audit trail |
| Login wall | step 3 (text contains common sign-in patterns) | `mark-failed --reason "auth required — paste JD manually"` | User pastes JD on retry |
| Empty/expired posting | step 4 (body < 500 chars or "no longer available" pattern) | `mark-failed --reason "posting expired/closed"` | Move on |
| Ambiguous company/role | step 4 | Ask user once; if user can't say, `mark-failed --reason "could not determine company/role"` | User clarifies on next run |
| Empty slug | step 5 (`slugify` exits non-zero) | Surface `{"status":"fail","error":"empty slug"}` to Claude; ask user for an override slug | User provides slug manually |
| Duplicate detected | step 5 | `mark-skipped --reason "duplicate (jd+pdf already exist)"` + log + continue | Intentional → no action; accidental → delete old files, retry |
| V2.0 hard-fail (no LaTeX block) | step 7 (no `\documentclass` in prompt output) | `mark-failed --reason "V2.0 hard-fail: <SENTENCE_COUNT|SKILLS_OVERFLOW>"` + log + save full output as `.log` | Investigate JD vs baseline mismatch |
| Tectonic compile fails | step 9 | `compile-resume` returns fail; `mark-failed --reason "tectonic: <tail>"`; keep `.tex` for inspection | Read tectonic log tail, fix `.tex` by hand or fix V2.0 prompt's escaping |
| `data/pipeline.md` rename collision | any `mark-*` | atomic rename fails; subcommand returns `status=fail` | Won't happen with sequential runs; defensive only |
| 3 consecutive failures | mode loop | Stop, print summary, ask user to investigate | User decides whether to resume |

## 8. Testing strategy

### 8.1 Unit tests (`tests/yash-resume-pipeline.test.mjs`)

Run with `node --test tests/yash-resume-pipeline.test.mjs`. Goal: green on every commit.

- **`slugify`**: every example in §5.3 plus: spaces, slashes, parens, commas, ampersands, all-caps tokens, single-letter tokens, accents, unicode, leading numbers, empty string.
- **`check-duplicate`**: matrix of {jd exists, pdf exists} × four states.
- **`mark-processed` / `mark-failed` / `mark-skipped`**: idempotency (running twice → same final file content); atomic-rename safety (kill mid-run → valid file).
- **`next-pending`**: empty queue, single pending, mixed pending+processed+failed; preserves line ordering.
- **`compile-resume`**: passes a known-good fixture `.tex` through; asserts `.pdf` is produced, `tectonic_log_tail` is non-empty, and exit-code-0 path returns `status=ok`. Also a deliberately broken `.tex` to verify failure path returns `status=fail` with a useful tail.
- **`log`**: appends one valid JSON line per call; creates file if missing; correct ISO timestamp.

### 8.2 Smoke test (`tests/test-yash-pipeline-smoke.mjs`)

Saved HTML JD fixtures (one per portal style) in `tests/fixtures/jds/`. Served via `python3 -m http.server` on a temp port (or loaded via `file://`). Run the full mode end-to-end against each, verify:

- JD `.md` exists with correct frontmatter (parseable YAML, expected fields).
- `.tex` exists and parses as valid LaTeX (run `tectonic --print` dry-run; it should compile).
- `.pdf` exists; `file resumes/*.pdf` returns "PDF document".
- `.log` sidecar contains a numeric score 0–100.
- `data/pipeline.md` shows the entry under `Procesadas` in the locked format.

### 8.3 Manual verification (one-time, before declaring done)

- 5 live URLs (one per portal: Lever, Ashby, Greenhouse, Workday, LinkedIn).
- Run interactively. Verify all output files. Diff one resume PDF against the V2.0 prompt's success criteria (15 sentences, locked sections, no fabricated metrics).
- Force-test failure paths: feed a known 404 URL and a known login-walled URL; verify both produce `[!]` lines with reasons.

### 8.4 Out of scope for testing

- The V2.0 prompt itself (already a stable artifact).
- `tectonic` itself (verified installed and working).
- The existing `generate-pdf-latex.mjs` (used unchanged).

## 9. Acceptance criteria

The implementation is done when:

1. `/yash-resume-pipeline` is a working slash command (top-level, no `/career-ops` prefix).
2. The full mode file at `modes/yash-resume-pipeline.md` matches the structure in §6.
3. `yash-resume-pipeline.mjs` implements every subcommand in §5.1 with the contracts in §5.2 and the slugify rule in §5.3.
4. `tests/yash-resume-pipeline.test.mjs` passes with `node --test`.
5. `tests/test-yash-pipeline-smoke.mjs` passes against the 3 fixture portals.
6. Manual verification (§8.3) succeeds on 5 live URLs covering all five expected outcomes (success ≥ 90, success < 90, expired posting, login wall, V2.0 hard-fail).
7. `data/pipeline.md` always ends in a consistent state after each URL: `[x]` (success), `[~]` (skipped), or `[!]` (failed). No `[ ]` left in `Pendientes` for an attempted URL.
8. `data/yash-resume-runs.log` contains one JSON line per run (success, fail, or skip).
9. CLAUDE.md / AGENTS.md updated with a one-paragraph entry describing the new mode and command (where to put URLs, how to invoke, what files come out).

## 10. Out of scope (explicitly NOT in this spec)

- Cover letter generation
- Form-fill / auto-submit (the existing pipeline never auto-submits; this one doesn't either)
- Supabase logging or any external service
- Scheduled/cron execution (deferred until manual flow is stable; the spec leaves room for it later)
- Multi-candidate support (the V2.0 prompt is hardcoded for Yash)
- Modification of the V2.0 prompt itself
- Modification of the existing `auto-pipeline` / `pipeline` modes
- A new MCP server wrapping browser-use or auto-browser (deferred unless Playwright proves insufficient)

## 11. Open questions / future work

- **Cover letter sibling pipeline.** Could mirror this design with a `modes/yash-cover-letter-pipeline.md` once resume flow is stable.
- **Cron via `/schedule create yash-resume daily`.** Possible once the manual flow has stabilized (4-week observation period suggested before automating).
- **JD freshness re-checks.** Today the pipeline only fires when the user adds a URL. A future enhancement could re-verify expiry of previously-processed JDs (similar to existing `check-liveness.mjs` for evaluations).
- **Per-portal extractors.** If LLM-based field parsing turns out to be unreliable for a specific portal, drop in a deterministic extractor (e.g., `parse-greenhouse.mjs`). The architecture supports adding these without changing the mode file.

---
