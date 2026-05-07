---
description: Hand off the current Claude Code session to the next one. Delegates to the session-handoff skill, which writes docs/session-resume/YYYY-MM-DD-<topic>.md (8 sections + pickup prompt) so the next session can resume in seconds without re-reading the transcript.
argument-hint: (no arguments — distills the current conversation)
---

# Session Handoff

This is the slash-command entry point for `/session-handoff`. All logic — section template, execution steps, quality checks, output format — lives in the `session-handoff` skill (single source of truth).

## What to do

Invoke the `session-handoff` skill via the Skill tool and follow its instructions exactly. Do not duplicate the skill's template, quality checks, or summary format here — read them from the skill at execution time so the two never drift.

```
Skill(skill="session-handoff")
```

The skill is at `.claude/skills/session-handoff/SKILL.md`. It will:

- Collect git + date facts.
- Scan the conversation for the 8 required sections.
- Write `docs/session-resume/YYYY-MM-DD-<topic>.md`.
- Run pre-write quality checks.
- Print a ≤6-line chat summary.
- Offer (not auto-execute) a `chore(docs): session handoff YYYY-MM-DD` commit.

## Why this file exists alongside the skill

Claude Code discovers slash commands from `.claude/commands/<name>.md` and skills from `.claude/skills/<name>/SKILL.md` separately. Skills auto-trigger on description match but are not exposed as typable `/name` shortcuts. This file gives `/session-handoff` a typable entry point that delegates to the skill — keeping the user-facing command thin and the implementation in one place.
