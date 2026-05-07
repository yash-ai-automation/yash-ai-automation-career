---
name: session-handoff
description: Use when the user wraps up a Claude Code CLI session and needs to hand state off to the next session. Triggers on "/session-handoff", "/handoff", "wrap up session", "save session", "hand this off", "context getting full", "compact and handoff", "document what we did", "resume later", "I'm running out of time", or any phrasing where the user wants a durable record of this session's state. Produces one markdown file at docs/session-resume/YYYY-MM-DD-<topic>.md that covers: where it started, decisions locked, what shipped (with commit SHAs), running state (services/URLs/ports), key files for next session, verification commands, deferred + open questions, and a concrete pickup prompt. Distills the entire conversation into a page the next session can consume in 30 seconds instead of re-reading the transcript. Use even if the user just says "handoff" or "save this" — those are the main triggers.
---

# Session Handoff

Turn the current Claude Code session into a durable handoff doc so the next session (or a teammate, or future-you) can pick up without re-reading the transcript.

## Why this exists

Long sessions accumulate context that lives nowhere except in Claude's in-memory conversation. When the session ends (compact, clear, crash, day end), that context vanishes. The next session restarts from the repo state alone and has to reverse-engineer:

- What the user was trying to do
- What decisions were made and why
- What got shipped vs. what's still open
- How to verify nothing broke

A well-structured handoff doc preserves all of that in a ~100-line markdown file the next session can load in seconds.

## When to trigger

Always trigger when the user says any of:

- `/session-handoff`, `/handoff`, `/save-session`
- "hand this off", "wrap up", "save this session", "compact and handoff"
- "context getting full", "I'm out of time", "let's stop for today"
- "document what we did", "resume later", "pick this up next time"

Also trigger proactively when:

- The user signals they're done (not explicitly asking for handoff but clearly wrapping up)
- Context is >70% full and the user has unsaved state

## Output location

Write to `docs/session-resume/YYYY-MM-DD-<topic>.md` in the current project repo.

- **Date**: `date +%Y-%m-%d` — local time of the machine the session runs on
- **Topic**: 3-5 kebab-case words summarizing the session's focus. Examples: `phase1-deploy-live`, `supabase-migration-rename`, `caddy-cert-fix`, `skill-creation`
- **Multiple handoffs on the same day**: add a disambiguator: `2026-04-22-deploy.md` vs `2026-04-22-skill-creation.md`

If `docs/session-resume/` doesn't exist, create it.

## The 8 required sections

Use EXACTLY these H2 headers, in this order. The next session is trained to scan them — consistency matters more than cleverness. Skip no sections; if a section has no content for this session, write "_None this session._" instead of omitting it.

### 1. Where it started

One paragraph (2-4 sentences). What was the user's goal when the session opened? Include the triggering user prompt verbatim if concise enough. Pull from the first 1-2 user messages.

### 2. Decisions locked

Bulleted list of decisions the user explicitly made or confirmed during the session, plus the reason. Include decisions about tools, paths, versions, design tradeoffs, deferrals, go/no-go calls. Format: **<decision>**: <why>.

### 3. Shipped

Table of commits created this session. Columns: SHA (7 chars), title. Get from `git log --oneline <start-sha>..HEAD` if a start SHA is known; otherwise get the commits that show the assistant as co-author, or look at file mtimes newer than session start.

If no commits yet: list files modified/created that weren't committed, so the next session knows what's pending.

### 4. Running state

Table of live services, endpoints, external resources, or scheduled jobs this session put in motion. Columns: Component | Status | URL / command | Notes.

Include: deployed Docker services, TLS certs, DNS records, live API endpoints, scheduled cron jobs, external accounts created, webhooks registered, etc. Put down actual HTTP status codes and command outputs you verified.

If nothing is live yet (planning-only session): "_No live state yet._"

### 5. Key files for next session

Bulleted list of 3-10 files the next session should open first. Format: `<path>` — <1-line reason it matters>. Pick files the next session will actually need — configs, entry points, recently-edited modules, fresh handoff docs. Skip tangential files.

### 6. Verification — how to confirm things still work

Shell commands the next session should run FIRST to confirm the handed-off state is still healthy. Each command with a comment showing the expected output. Favor commands that are cheap, idempotent, and informative.

Examples worth including when relevant:

- `git log --oneline -5` — recent commits
- `docker compose ps` — services up?
- `curl -sI https://<live-endpoint>/` — endpoint responding?
- `dig +short <subdomain>` — DNS still resolves?
- `<tool> --version` — CLI still installed?

### 7. Deferred + open questions

Two-part list:

**Deferred (decided NOT to do now):**

- [ ] **<item>** — <why deferred, what unblocks it>

**Open (unanswered questions, untested paths, operator actions pending):**

- [ ] **<question>** — <context, who can answer>

If either sublist is empty, say so: "_None._"

### 8. Pick up from here

Provide the EXACT prompt the next session should see first. Something they can paste verbatim into `claude` to resume. Usually a one-liner + a resumé of locked-in context the new session won't have.

Example:

> "Resume the linkedin-yash-ai-automation Phase 1 deploy. Stack is live at 72.60.25.242; credentials rotated; Task 20 (weekly batch dry-run) is next. Skill docs at .claude/skills/claude-code-session-gotchas/ are authoritative for deployment gotchas. Start by running the Verification commands in docs/session-resume/2026-04-22-phase1-deploy.md."

## Execution steps

1. **Collect facts in parallel**:
   - `git log --oneline -20` — recent commits
   - `git status --short` — uncommitted state
   - `git branch --show-current` — current branch
   - `date +%Y-%m-%d` — date for filename
   - `git log --oneline --author="Co-Authored-By: Claude" --since="12 hours ago"` if available, else use the session's earliest commit SHA as a lower bound

2. **Scan the conversation** for:
   - First user message (→ Section 1)
   - Key user decisions like "yes", "use X", "skip this", "do it" (→ Section 2)
   - Commits mentioned, files written via Write/Edit (→ Section 3)
   - URLs verified, services started, curls returning 200/401/etc. (→ Section 4)
   - Files touched that will matter for continuation (→ Section 5)
   - Commands that verified state (→ Section 6)
   - User-flagged deferrals, unanswered questions, "revisit later" items (→ Section 7)

3. **Draft the markdown** using the output template below.

4. **Write the file** with the Write tool (respect any Fact-Forcing Gate).

5. **Print a ≤6-line chat summary** with:
   - 📝 `<path to file written>`
   - 🚀 Shipped: `<N commits>` — `<latest SHA/title>`
   - ⚡ Live: `<N services/endpoints>`
   - ⏭️ Next: `<one-line pickup>`
   - ⚠️ Open: `<N deferred/open items>`

6. **Offer a commit** (don't auto-commit):
   > Want me to commit this? `chore(docs): session handoff YYYY-MM-DD`

## Output template

Use this structure verbatim (fill placeholders; never change section order or headers):

```markdown
# Session Handoff — YYYY-MM-DD — <Topic Title Case>

**Branch:** `<branch>`
**Latest commit:** `<short-sha>` — <commit title>
**Generated:** <ISO 8601 timestamp>
**Session driver:** <user goal one-liner>

## 1. Where it started

<2-4 sentences. Include the triggering user prompt verbatim in a blockquote if concise.>

> <verbatim user prompt or its first line>

## 2. Decisions locked

- **<decision>** — <reason>
- **<decision>** — <reason>

## 3. Shipped

| SHA | Title |
|---|---|
| `<short-sha>` | <commit title> |
| `<short-sha>` | <commit title> |

<If uncommitted work exists, add a "Not yet committed" bullet list below the table.>

## 4. Running state

| Component | Status | URL / command | Notes |
|---|---|---|---|
| <service> | <status> | <url or cmd> | <notes> |

## 5. Key files for next session

- `<path>` — <why it matters>
- `<path>` — <why it matters>

## 6. Verification — how to confirm things still work

Run in order. Each should return a specific signal; if any fails, investigate before continuing.

\`\`\`bash
<cmd>              # expected: <concise expectation>
<cmd>              # expected: <concise expectation>
\`\`\`

## 7. Deferred + open questions

**Deferred:**

- [ ] **<item>** — <why deferred, what unblocks it>

**Open:**

- [ ] **<question>** — <context>

## 8. Pick up from here

Paste this into the next session:

> <exact resume prompt — 2-3 sentences, concrete>

---

_Generated by `/session-handoff` on <ISO timestamp>._
```

## Quality checks before writing the file

Before the file hits disk, self-check:

1. **Every H2 header present** (8 total including "Pick up from here"). If a section has no content, write `_None this session._` — never omit.
2. **No placeholders left** — no `<TODO>`, `<fill in>`, `<>` stubs. If you can't fill a section honestly, explicitly say so.
3. **Commit SHAs are real and short-form (7 chars)** — verified against `git log`.
4. **URLs and commands are copy-paste-executable** — no "https://xxx.supabase.co" placeholders; use the real URL the session verified.
5. **Pickup prompt is self-contained** — a fresh session with zero context can act on it.
6. **No secrets leaked** — scan for bearer tokens, API keys, DB passwords, PATs. Replace with `<name-of-secret from password manager>` if any appear.

## Common mistakes to avoid

- **Dumping the whole transcript**: this is a handoff doc, not a session log. Each section aims for ~5 lines unless the session was unusually complex.
- **Skipping the Running state section because "code-only" sessions have no services**: even then, document the test suite state (`pytest passing 45/45`), linter state, or whatever "running" state exists for the work type. Don't leave blank.
- **Writing "see chat history"**: chat history won't be there next session. Everything that matters must be in the doc.
- **Omitting the pickup prompt**: the whole point of handoff is enabling fast resumption. The pickup prompt is the most valuable line in the document.
- **Picking a generic topic slug** like `session-update.md`: future-you will thank you for a specific slug like `caddy-cert-fix.md`.
