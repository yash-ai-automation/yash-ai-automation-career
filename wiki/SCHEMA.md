# Wiki Schema -- Career Knowledge Base

This wiki is a persistent, compounding knowledge base maintained by the LLM.
It sits between the raw source documents and the career-ops system, providing
structured, interlinked context that improves evaluations, PDFs, and form answers.

Based on the [LLM Wiki pattern](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) by Andrej Karpathy.

## Three Layers

1. **Raw sources** (`wiki/raw/`) -- immutable source documents. The LLM reads but NEVER modifies these.
2. **The wiki** (`wiki/`) -- LLM-generated markdown pages. Small, focused, interlinked. The LLM owns this layer entirely.
3. **This schema** (`wiki/SCHEMA.md`) -- conventions, workflows, page formats. Co-evolved by user and LLM.

## Directory Structure

```
wiki/
  SCHEMA.md                     # This file (conventions, workflows)
  index.md                      # Master catalog -- LLM reads this first
  log.md                        # Chronological append-only log
  overview.md                   # High-level synthesis (the "front page")

  raw/                          # Immutable source documents
    linkedin-profile.md
    personal-background.md
    pipeline-spec.md
    resume-optimization.md

  sources/                      # One summary per raw source
    linkedin-profile.md
    personal-background.md
    pipeline-spec.md
    resume-optimization.md

  entities/
    companies/                  # One page per company worked at
      morningstar.md
      bell-canada.md
      virtusa.md
    technologies/               # One page per key technology
      rag-pipelines.md
      n8n.md
      make-com.md
      langchain.md
      aws-bedrock.md
      vector-databases.md
      playwright.md
      spring-boot.md
      deepeval.md
    certifications/             # One page per certification
      azure-ai-engineer.md
      azure-ai-fundamentals.md
      n8n-certification.md
      make-com-level5.md

  concepts/                     # Domain concepts and methodologies
    ai-automation.md
    generative-ai.md
    enterprise-engineering.md
    mlops-llmops.md
    workflow-orchestration.md
    ats-optimization.md

  career/
    work-experience/            # One page per role (detailed)
      morningstar-software-engineer.md
      bell-full-stack-developer.md
      virtusa-full-stack-developer.md
    projects/                   # One page per project/achievement
      ai-document-processing.md
      genai-classification.md
      rag-pipeline-15k-docs.md
      client-onboarding-automation.md
      ecommerce-automation.md
      ai-lead-qualification.md
      microservices-billing.md
      network-provisioning.md
      banking-transaction-platform.md
    achievements/
      measurable-impacts.md     # Consolidated metrics page
    education/
      masters-windsor.md
      btech-ddu.md
    skills/
      programming-languages.md
      frameworks-and-web.md
      cloud-and-devops.md
      ai-and-ml.md
      databases.md
      testing-and-qa.md

  job-search/                   # Job search strategy and preferences
    target-roles.md
    compensation.md
    location-preferences.md
    deal-breakers.md
    negotiation-scripts.md
    form-fill-data.md
```

## Page Format

Every wiki page uses this format:

```markdown
---
title: Page Title
type: entity|concept|career|source|job-search
created: YYYY-MM-DD
updated: YYYY-MM-DD
sources: [list of raw source files this was derived from]
tags: [relevant tags]
---

# Page Title

Content here. Keep it focused -- one concept, one entity, one project per page.

## See Also

- [[related-page-1]]
- [[related-page-2]]
```

### Conventions

- **Wikilinks**: Use `[[filename]]` syntax (without directory path) for cross-references. Example: `[[morningstar]]`, `[[rag-pipelines]]`
- **One topic per page**: Each page covers exactly one entity, concept, project, or role
- **Small pages**: Target 50-150 lines per page. If a page grows beyond 200 lines, split it
- **Frontmatter required**: Every page has YAML frontmatter with at least `title`, `type`, `created`, `updated`
- **See Also section**: Every page ends with links to related pages
- **Metrics are sacred**: Never invent metrics. Every number must trace to a raw source
- **Timestamps**: Use ISO 8601 (YYYY-MM-DD) everywhere

## Workflows

### Ingest (adding a new source)

1. Place the raw document in `wiki/raw/` (immutable)
2. Create a summary page in `wiki/sources/` with key takeaways
3. For each entity mentioned: create or update its page in `wiki/entities/`
4. For each concept discussed: create or update its page in `wiki/concepts/`
5. For career-related content: create or update pages in `wiki/career/`
6. Update cross-references (`[[wikilinks]]`) across all touched pages
7. Update `wiki/index.md` with new/modified pages
8. Append entry to `wiki/log.md`

### Query (answering a question)

1. Read `wiki/index.md` to find relevant pages
2. Read those pages for structured context
3. If needed, drill into `wiki/raw/` for verbatim source data
4. Synthesize answer with citations to wiki pages
5. If the answer is reusable, file it as a new wiki page

### Lint (health check)

Run periodically to keep the wiki healthy:
- Orphan pages with no inbound links
- Stale pages not updated after new source ingestion
- Missing cross-references between related pages
- Contradictions between pages
- Pages exceeding 200 lines (split candidates)
- Concepts mentioned but lacking their own page

## Integration with career-ops

The wiki enhances career-ops modes:

| Mode | How wiki helps |
|------|----------------|
| `oferta` (evaluate) | Read `wiki/career/projects/` for proof points, `wiki/entities/technologies/` for skill matching |
| `pdf` (generate CV) | Read `wiki/career/achievements/measurable-impacts.md` for metrics, project pages for bullets |
| `apply` (form fill) | Read `wiki/job-search/form-fill-data.md` for pre-filled answers |
| `interview-prep` | Read `wiki/career/projects/` for STAR story material |
| `scan` (portal scan) | Read `wiki/job-search/target-roles.md` for filtering context |

**Rule**: When career-ops modes need candidate context, check the wiki FIRST (structured, interlinked) before falling back to raw files (cv.md, article-digest.md).
