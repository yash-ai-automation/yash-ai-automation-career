---
title: "Source: Pipeline Specification"
type: source
created: 2026-04-09
updated: 2026-04-09
sources: [pipeline-spec.md]
tags: [source, pipeline, automation, ats, supabase, latex, form-fill]
---

# Source: Pipeline Specification

Summary of `wiki/raw/pipeline-spec.md` -- The automated job application pipeline design for Yash Anghan, including LaTeX resume system, Supabase logging, ATS form auto-fill, and end-to-end execution flow.

## Pipeline Overview

A fully autonomous, end-to-end job application pipeline running on a Hostinger VPS (Ubuntu 24.0). Ten-step flow:

1. **Discover** -- Scrape target platforms for matching jobs
2. **Filter** -- Deduplicate against Supabase application log
3. **Extract** -- Pull full JD text per job
4. **Tailor** -- Generate .tex via Resume Optimization V2.0 (see [[resume-optimization]])
5. **Compile** -- pdflatex to PDF
6. **Cover** -- Generate tailored cover letter PDF
7. **Fill** -- Auto-complete ATS form fields using [[form-fill-data]]
8. **Submit** -- Submit application
9. **Log** -- Write result to Supabase
10. **Next** -- Loop to next job

## Target Platforms (Priority Order)
1. Greenhouse (primary ATS)
2. LinkedIn (sourcing + Easy Apply)
3. Indeed (secondary)
4. Workday, Lever, iCIMS (supported)

## Sourcing Filters
- **Location**: Toronto, ON + Remote-Canada + Hybrid-Toronto
- **Level**: Mid-level to Senior (3-8 years)
- **Recency**: Last 7 days (prefer 24-48 hours)
- **Exclusions**: Internships, Director+, Principal-level, US-only authorization
- **Target titles**: See [[target-roles]]

## Resume Tailoring Engine
Uses the V2.0 Resume Optimization System with 6 phases:
- JD analysis and keyword extraction
- Skills mapping to locked categories
- Baseline sentence enhancement (never fabrication)
- ATS formatting with `\textbf{}` keyword wrapping
- Constraint verification (15 sentences, domain lock, metric validation)
- Quality scoring (minimum 90/100)

See [[ats-optimization]] for the full system description.

## Cover Letter Specs
- 250-350 words, 3-4 paragraphs
- Structure: Hook, experience mapping, value proposition, close
- Metrics from allowed values only; never fabricate

## ATS Form Auto-Fill
Uses pre-defined personal data (see [[form-fill-data]]) mapped to form fields by label matching. Dynamic experience descriptions reference baseline accomplishments. For unknown technologies: "Limited direct experience; actively developing proficiency."

## Supabase Logging
Every application attempt logged with: job_id, platform, company, title, resume_version, resume_score, status (submitted/failed/duplicate/skipped), and notes. Deduplication query runs before each application.

## Behavioral Guardrails
- Never fabricate experience, projects, or metrics
- Never apply to US-only auth, security clearance, or out-of-scope roles
- Never submit resume scoring below 90/100
- Never reapply to same company+role combination
- Maximum 30 applications per day
- Respect platform ToS and rate limits

## File Organization
```
output/resumes/    -- Tailored .tex and .pdf per application
output/cover-letters/ -- Cover letter PDFs
config/            -- Resume system, form data, .env
logs/              -- Pipeline execution logs
```

## See Also

- [[ats-optimization]]
- [[resume-optimization]]
- [[form-fill-data]]
- [[target-roles]]
- [[deal-breakers]]
