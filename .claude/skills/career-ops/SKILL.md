---
name: career-ops
description: AI-powered job search pipeline — evaluate offers, generate tailored CVs, scan portals, manage applications. Use when the user pastes a job URL or JD, asks to evaluate / compare offers, generate a CV, scan portals, or manage their application tracker.
---

# career-ops

Full skill specification lives in [`AGENTS.md`](../../../AGENTS.md) at the project root.

## Quick reference

- Paste a JD or URL → auto-pipeline (evaluate + report + PDF + tracker)
- `/career-ops oferta` — evaluate a single offer
- `/career-ops scan` — scan portals for new offers
- `/career-ops pipeline` — process pending URLs from `data/pipeline.md`
- `/career-ops batch` — batch-process multiple offers
- `/yash-resume-pipeline` — strict V2.0 resume PDF pipeline (Yash-specific fork)

See `modes/` for the full list and `AGENTS.md` for skill modes table, data contract, and ethical-use rules.
