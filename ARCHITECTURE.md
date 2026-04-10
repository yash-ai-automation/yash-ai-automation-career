# Career-Ops: AI Job Search Pipeline — Architecture Design

> **Excalidraw Diagram**: [Open Interactive Diagram](https://excalidraw.com/#json=WgWqfz0Wf1Kv4JgzA8j9Q,QOrW7FK_gka5cIPJqMGZKQ)

---

## System Overview

Career-Ops is an AI-powered job search automation pipeline built on Claude Code. It evaluates job offers, generates tailored CVs, scans portals, tracks applications, and prepares for interviews — all with a human-in-the-loop design that never auto-submits applications.

---

## Architecture Layers

The system is organized into **7 horizontal layers**, flowing top-to-bottom:

```
+------------------------------------------------------------------+
|                        INPUT LAYER                                |
|  User Input (JD/URL/Text)  -->  /career-ops <cmd>  -->  Router   |
+------------------------------------------------------------------+
                                  |
                    Skill Router (SKILL.md)
                     |        |        |        |
              +------+--------+--------+--------+------+
              v        v          v          v
+------------------------------------------------------------------+
|                       MODE ENGINE                                 |
| [Discovery] [Evaluation] [Generation] [Management]               |
+------------------------------------------------------------------+
                          |
                     JD Text Flow
                          v
+------------------------------------------------------------------+
|                  CORE PROCESSING ENGINE                           |
| JD Extract -> Archetype -> A-F Eval -> Score -> CV -> PDF Gen    |
+------------------------------------------------------------------+
                          |
                    Report + PDF
                          v
+------------------------------------------------------------------+
|                       DATA LAYER                                  |
| [User Layer]  [Pipeline Tracker]  [Output]  [System Layer]       |
+------------------------------------------------------------------+
                          |
+------------------------------------------------------------------+
|               EXTERNAL SERVICES & SCRIPTS                        |
| Playwright | WebSearch | WebFetch | GitHub | MCP Tools | *.mjs   |
+------------------------------------------------------------------+
                          |
+------------------------------------------------------------------+
|                APPLICATION STATE MACHINE                          |
| Evaluated -> Applied -> Responded -> Interview -> Offer          |
|                   \-> Rejected / Discarded / SKIP                |
+------------------------------------------------------------------+
```

---

## Layer 1: Input Layer

| Component | Description | Files |
|-----------|-------------|-------|
| **User Input** | User pastes a JD URL, raw JD text, or describes what they want | N/A (conversation) |
| **CLI Command** | `/career-ops <subcommand>` routes to specific modes | `.claude/skills/career-ops/SKILL.md` |
| **Skill Router** | Dispatches to the correct mode based on input type and command | `SKILL.md` → `modes/*.md` |
| **Context Loader** | Loads shared context files before any mode executes | `modes/_shared.md`, `modes/_profile.md`, `cv.md`, `config/profile.yml` |

### Routing Logic

```
Input                          --> Mode Triggered
─────────────────────────────────────────────────
Paste JD URL (no command)      --> auto-pipeline
/career-ops oferta             --> oferta (evaluate)
/career-ops ofertas            --> ofertas (compare)
/career-ops scan               --> scan (discover)
/career-ops pipeline           --> pipeline (process inbox)
/career-ops batch              --> batch (parallel)
/career-ops pdf                --> pdf (generate CV)
/career-ops apply              --> apply (form assist)
/career-ops contacto           --> contacto (outreach)
/career-ops deep               --> deep (research)
/career-ops training           --> training (course eval)
/career-ops project            --> project (portfolio eval)
/career-ops tracker            --> tracker (status view)
/career-ops patterns           --> patterns (rejection analysis)
```

---

## Layer 2: Mode Engine

The Mode Engine contains **15 operational modes** organized into 4 categories:

### Discovery Modes (Blue)

| Mode | File | Purpose | Output |
|------|------|---------|--------|
| **scan** | `modes/scan.md` | 3-level portal scanning: Playwright direct, Greenhouse API, WebSearch | New URLs added to `data/pipeline.md` |
| **pipeline** | `modes/pipeline.md` | Process pending URLs from inbox | Auto-evaluates all pending URLs |
| **batch** | `modes/batch.md` | Parallel evaluation via `claude -p` workers | Reports + PDFs + tracker TSVs |

**Scan 3-Level Strategy:**
```
Level 1 (Primary):     Playwright → careers_url of 45+ tracked companies
Level 2 (Complementary): Greenhouse JSON API → structured job data
Level 3 (Discovery):   WebSearch → site: filters across Ashby, Lever, Wellfound
```

### Evaluation Modes (Purple)

| Mode | File | Purpose | Output |
|------|------|---------|--------|
| **oferta** | `modes/oferta.md` | Full A-F evaluation (6 blocks) | Evaluation report `.md` |
| **ofertas** | `modes/ofertas.md` | Compare and rank 2+ offers | Comparison table + recommendation |
| **auto-pipeline** | `modes/auto-pipeline.md` | Complete flow: evaluate + report + PDF + tracker | Report + PDF + tracker entry |
| **patterns** | `modes/patterns.md` | Analyze rejection patterns, improve targeting | Pattern report + recommendations |

### Generation Modes (Green)

| Mode | File | Purpose | Output |
|------|------|---------|--------|
| **pdf** | `modes/pdf.md` | ATS-optimized CV generation | `output/cv-{company}-{date}.pdf` |
| **apply** | `modes/apply.md` | Live form filling + answer generation | Draft answers (HUMAN REVIEWS) |
| **contacto** | `modes/contacto.md` | LinkedIn outreach: find contacts + draft message | Contact info + personalized message |
| **deep** | `modes/deep.md` | Deep company research (culture, growth, stability) | Research report |

### Management Modes (Orange)

| Mode | File | Purpose | Output |
|------|------|---------|--------|
| **tracker** | `modes/tracker.md` | Application status overview | Funnel stats + next actions |
| **training** | `modes/training.md` | Evaluate course/cert against career goals | Assessment report |
| **project** | `modes/project.md` | Evaluate portfolio project idea | Project evaluation |
| **interview-prep** | `modes/interview-prep.md` | STAR+R story prep + red-flag responses | Story bank entries + company intel |

### Human-in-the-Loop Guardrail

The `apply` mode has a **mandatory STOP barrier**:
- Reads application forms and generates personalized answers
- Presents answers in copy-paste format for user review
- **NEVER clicks Submit/Send/Apply** — the user makes the final call
- Only updates tracker AFTER user confirms submission

---

## Layer 3: Core Processing Engine

When a job is evaluated, the processing pipeline executes left-to-right:

```
JD Extract ──> Archetype Detect ──> A-F Evaluation ──> Score Decision
    |                |                    |                    |
Playwright       6 Role Types        6 Blocks            >= 4.5?
or WebFetch      matching            10 Dimensions           |
                                                      ┌─────┴─────┐
                                                      YES         NO
                                                      |           |
                                                CV Personalize  Report
                                                      |         Only
                                                  PDF Gen
                                                      |
                                                 output/*.pdf
```

### 3.1 JD Extraction
- **Primary**: Playwright `browser_navigate` + `browser_snapshot`
- **Fallback**: WebFetch for static pages
- **Manual**: User pastes JD text directly

### 3.2 Archetype Detection (6 Types)

| Archetype | Key Signals in JD |
|-----------|-------------------|
| **AI Platform / LLMOps** | observability, evals, pipelines, reliability, monitoring |
| **Agentic / Automation** | agent, HITL, orchestration, workflow, multi-agent |
| **Technical AI PM** | PRD, roadmap, discovery, stakeholder, product manager |
| **AI Solutions Architect** | architecture, enterprise, integration, systems design |
| **AI Forward Deployed** | client-facing, deploy, prototype, fast delivery, field |
| **AI Transformation** | change management, adoption, enablement, transformation |

### 3.3 A-F Evaluation Blocks

| Block | Content | Key Output |
|-------|---------|------------|
| **A** | Role summary table | Archetype, domain, function, seniority, remote, team |
| **B** | CV match analysis | Requirements vs CV lines, gaps, mitigation strategies |
| **C** | Level & positioning strategy | Seniority assessment, negotiation plan |
| **D** | Compensation research | WebSearch for market data, quartile positioning |
| **E** | CV personalization plan | Top 5 changes to maximize match score |
| **F** | Interview prep | 6-10 STAR+R stories mapped to JD requirements |

### 3.4 Scoring Engine (10 Weighted Dimensions)

| Dimension | Weight | Scale | Measures |
|-----------|--------|-------|----------|
| CV Match | 25% | 1-5 | Skills + experience alignment |
| North Star Alignment | 20% | 1-5 | Fit to target archetypes |
| Compensation | 20% | 1-5 | Salary vs market quartiles |
| Cultural Signals | 15% | 1-5 | Culture, growth, remote policy |
| Red Flags | 20% | -2 to +1 | Blocker gaps, visa, on-site |
| **Global Score** | **100%** | **1-5** | **Weighted average** |

**Score Interpretation:**
- **4.5+**: Strong match — recommend applying immediately, generate PDF
- **4.0-4.4**: Good match — worth applying
- **3.5-3.9**: Decent — apply only with specific reason
- **Below 3.5**: Recommend against applying

### 3.5 CV Personalization Pipeline

```
cv.md (source) + JD keywords (15-20 extracted)
    |
    v
Rewrite Professional Summary (keyword injection)
    |
    v
Reorder experience bullets by JD relevance
    |
    v
Build competency grid (6-8 JD keywords)
    |
    v
Generate HTML from templates/cv-template.html
    |
    v
node generate-pdf.mjs → output/cv-{company}-{date}.pdf
```

**ATS Normalization** (automatic in `generate-pdf.mjs`):
- Em-dashes (--) to hyphens (-)
- Smart quotes to straight quotes
- Zero-width characters removed
- Non-breaking spaces to regular spaces

**Design**: Space Grotesk (headings) + DM Sans (body), single-column ATS layout, letter/A4 auto-detect.

---

## Layer 4: Data Layer

The data layer enforces a strict **User/System separation** to enable safe updates:

### User Layer (NEVER auto-updated)

| File | Purpose | Format |
|------|---------|--------|
| `cv.md` | Canonical CV (source of truth) | Markdown |
| `config/profile.yml` | Identity, targets, comp, visa, timezone | YAML |
| `modes/_profile.md` | Custom archetypes, narrative, proof points | Markdown |
| `portals.yml` | Company list + scanning config (45+ companies) | YAML |
| `article-digest.md` | Detailed proof points from portfolio | Markdown |
| `interview-prep/story-bank.md` | Accumulated STAR+R stories | Markdown |
| `interview-prep/{company}-{role}.md` | Company-specific interview intel | Markdown |

### Pipeline Tracker

| File | Purpose | Format |
|------|---------|--------|
| `data/applications.md` | Master application tracker | Markdown table |
| `data/pipeline.md` | URL inbox (pending evaluations) | Markdown |
| `data/scan-history.tsv` | Dedup history for portal scans | TSV |
| `templates/states.yml` | Canonical application states | YAML |
| `batch/tracker-additions/*.tsv` | Batch evaluation results | TSV (9 columns) |

**Tracker Column Format:**
```
# | Date | Company | Role | Score | Status | PDF | Report | Notes
```

### Output

| File | Purpose |
|------|---------|
| `reports/{###}-{company-slug}-{YYYY-MM-DD}.md` | Evaluation reports |
| `output/cv-{company}-{date}.pdf` | Generated CVs |
| `jds/*` | Saved job descriptions |
| `batch/merged/` | Processed tracker additions |

### System Layer (auto-updatable)

| File | Purpose |
|------|---------|
| `modes/_shared.md` | Scoring system, global rules, archetype detection |
| `modes/*.md` | Mode instructions (oferta, pdf, scan, etc.) |
| `modes/de/`, `modes/fr/`, `modes/pt/` | Language-specific modes |
| `templates/cv-template.html` | CV HTML template |
| `*.mjs` | Utility scripts |
| `CLAUDE.md` | Agent instructions |
| `.claude/skills/career-ops/SKILL.md` | Skill router definition |

**THE RULE**: User customizations go to `_profile.md` or `profile.yml`, NEVER to `_shared.md`.

---

## Layer 5: External Services

| Service | Used By | Purpose | Fallback |
|---------|---------|---------|----------|
| **Playwright** | scan, pdf, verify, apply | Browser automation: navigate pages, render PDFs, read forms | WebFetch |
| **WebSearch** | oferta (Block D), deep, contacto | Compensation data, company research, LinkedIn contacts | Manual |
| **WebFetch** | JD extraction, batch mode | Static page content extraction | User pastes JD |
| **GitHub** | update-system | Fetch system updates from remote repo | Manual download |
| **MCP Tools** | Optional enrichment | Data enrichment, visual CV via Canva MCP | Not required |

---

## Layer 6: Utility Scripts (.mjs)

| Script | Purpose | When Used |
|--------|---------|-----------|
| `generate-pdf.mjs` | HTML to PDF via Playwright headless Chromium | After CV personalization |
| `merge-tracker.mjs` | Merge batch TSV additions into applications.md | After every batch of evaluations |
| `verify-pipeline.mjs` | Health check: 7 validation rules on tracker | After merges, on demand |
| `update-system.mjs` | Safe versioned updates (system layer only) | Session start, on demand |
| `dedup-tracker.mjs` | Remove duplicate tracker entries | On demand |
| `doctor.mjs` | Setup validation: 10 checks (Node, deps, Playwright, files) | First run, troubleshooting |
| `analyze-patterns.mjs` | Rejection pattern detection (JSON output) | patterns mode |
| `normalize-statuses.mjs` | Enforce canonical statuses in tracker | After manual edits |

---

## Layer 7: Application State Machine

```
                                    ┌──> SKIP
                                    |
Evaluated ──> Applied ──> Responded ──> Interview ──> Offer ──> (Negotiate)
                |              |
                v              v
            Rejected       Discarded
```

| State | When Used |
|-------|-----------|
| `Evaluated` | Report completed, pending decision |
| `Applied` | Application submitted by user |
| `Responded` | Company responded |
| `Interview` | In interview process |
| `Offer` | Offer received |
| `Rejected` | Rejected by company |
| `Discarded` | Discarded by candidate or offer closed |
| `SKIP` | Doesn't fit, don't apply |

---

## Key Workflow: Full Auto-Pipeline

This is the end-to-end flow when a user pastes a job URL:

```
1. User pastes JD URL
        |
2. Playwright navigates to URL, extracts JD text
        |
3. Verify offer is still active (title + description + Apply button)
        |
4. Load context: _shared.md + _profile.md + cv.md + profile.yml
        |
5. Detect archetype from JD signals
        |
6. Execute A-F Evaluation Blocks
   A) Role summary table
   B) CV match with gaps + mitigation
   C) Level & seniority strategy
   D) Comp research (WebSearch)
   E) CV personalization (top 5 changes)
   F) Interview STAR+R stories (update story-bank)
        |
7. Calculate global score (weighted average of 10 dimensions)
        |
8. Save report → reports/{###}-{company-slug}-{YYYY-MM-DD}.md
        |
9. IF score >= 4.5:
   - Extract 15-20 keywords from JD
   - Personalize CV (summary, bullets, competency grid)
   - Generate HTML from template
   - Render PDF via generate-pdf.mjs
   - Save → output/cv-{company}-{YYYY-MM-DD}.pdf
        |
10. Create TSV → batch/tracker-additions/{###}-{company-slug}.tsv
        |
11. Run merge-tracker.mjs → update applications.md
        |
12. Run verify-pipeline.mjs → health check
        |
13. Return to user:
    - Report link + PDF link (if generated)
    - Score + recommendation
    - Next action suggestion
```

---

## Batch Processing Architecture

```
Conductor (main agent)
    |
    ├──> Read batch-input.tsv (URLs)
    |
    ├──> For each URL:
    |       |
    |       ├──> Playwright: extract JD text
    |       |
    |       └──> Launch worker: claude -p
    |               |
    |               ├──> Reads batch-prompt.md (self-contained)
    |               ├──> Evaluates JD (A-F blocks)
    |               ├──> Writes: report .md
    |               ├──> Writes: PDF (if score >= 4.5)
    |               └──> Writes: tracker-additions/{num}.tsv
    |
    ├──> Update batch-state.tsv (track progress)
    |
    └──> After all workers complete:
            ├──> merge-tracker.mjs
            ├──> verify-pipeline.mjs
            └──> Report summary
```

---

## Language Support

| Language | Directory | Market | Key Terms |
|----------|-----------|--------|-----------|
| **English** (default) | `modes/` | Global | Standard terms |
| **German** | `modes/de/` | DACH | 13. Monatsgehalt, Probezeit, AGG, Tarifvertrag |
| **French** | `modes/fr/` | France/BE/CH/LU | CDI/CDD, SYNTEC, RTT, mutuelle, 13e mois |
| **Portuguese** | `modes/pt/` | Brazil | Brazilian Portuguese terms |

Switch via: `language.modes_dir: modes/de` in `config/profile.yml`

---

## Update System

```
node update-system.mjs check    → JSON: {"status": "update-available", ...}
node update-system.mjs apply    → Backup branch → fetch system files → validate → commit
node update-system.mjs rollback → Restore from backup branch
node update-system.mjs dismiss  → Create .update-dismissed file
```

**Safety guarantee**: Only system layer files are updated. User layer (cv.md, profile.yml, _profile.md, portals.yml, data/*, reports/*, output/*) is NEVER touched.

---

## Onboarding Flow

```
Session Start
    |
    ├──> Check: cv.md exists?              → No: Step 1 (create CV)
    ├──> Check: config/profile.yml exists?  → No: Step 2 (configure profile)
    ├──> Check: modes/_profile.md exists?   → No: Copy from template
    ├──> Check: portals.yml exists?         → No: Step 3 (setup portals)
    ├──> Check: data/applications.md?       → No: Step 4 (create tracker)
    |
    └──> Step 5: Get to know user (superpowers, deal-breakers, achievements)
         → Step 6: Ready + suggest automation (recurring scans)
```

---

## Ethical Design Principles

1. **Human-in-the-loop**: NEVER submit applications without user review
2. **Quality over quantity**: Discourage applications below 4.0/5 score
3. **Respect recruiter time**: Only send what's worth reading
4. **Continuous learning**: System improves from user feedback after each evaluation
5. **Safe updates**: User data is never overwritten by system updates

---

## File Tree Summary

```
career-ops/
├── CLAUDE.md                    # Agent instructions
├── ARCHITECTURE.md              # This file
├── DATA_CONTRACT.md             # User vs system layer rules
├── cv.md                        # User's canonical CV
├── article-digest.md            # Portfolio proof points
├── portals.yml                  # Company scanning config
├── config/
│   ├── profile.yml              # User identity + targets
│   └── profile.example.yml      # Template
├── modes/
│   ├── _shared.md               # Global scoring + rules
│   ├── _profile.md              # User's custom archetypes
│   ├── _profile.template.md     # Template for _profile
│   ├── auto-pipeline.md         # Full evaluation flow
│   ├── oferta.md                # A-F evaluation
│   ├── ofertas.md               # Compare offers
│   ├── scan.md                  # Portal scanning
│   ├── pipeline.md              # Process inbox
│   ├── batch.md                 # Parallel processing
│   ├── pdf.md                   # CV generation
│   ├── apply.md                 # Application assist
│   ├── contacto.md              # LinkedIn outreach
│   ├── deep.md                  # Company research
│   ├── tracker.md               # Status overview
│   ├── training.md              # Course evaluation
│   ├── project.md               # Portfolio project eval
│   ├── interview-prep.md        # Interview preparation
│   ├── patterns.md              # Rejection analysis
│   ├── de/                      # German modes
│   ├── fr/                      # French modes
│   └── pt/                      # Portuguese modes
├── data/
│   ├── applications.md          # Master tracker
│   ├── pipeline.md              # URL inbox
│   └── scan-history.tsv         # Dedup history
├── reports/                     # Evaluation reports
├── output/                      # Generated PDFs
├── jds/                         # Saved job descriptions
├── interview-prep/
│   ├── story-bank.md            # STAR+R story library
│   └── {company}-{role}.md      # Company-specific prep
├── templates/
│   ├── cv-template.html         # CV HTML template
│   ├── portals.example.yml      # Portal config template
│   └── states.yml               # Canonical statuses
├── batch/
│   ├── batch-prompt.md          # Worker prompt
│   ├── tracker-additions/       # Pending TSVs
│   └── merged/                  # Processed TSVs
├── fonts/                       # Space Grotesk + DM Sans
├── dashboard/                   # Dashboard files
├── .claude/skills/career-ops/
│   └── SKILL.md                 # Skill router
├── generate-pdf.mjs             # HTML → PDF
├── merge-tracker.mjs            # TSV → applications.md
├── verify-pipeline.mjs          # Health checks
├── update-system.mjs            # Safe updater
├── dedup-tracker.mjs            # Remove duplicates
├── doctor.mjs                   # Setup validation
├── analyze-patterns.mjs         # Rejection patterns
├── normalize-statuses.mjs       # Status enforcement
└── package.json                 # Dependencies
```
