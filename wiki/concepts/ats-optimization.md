---
title: ATS Optimization
type: concept
created: 2026-04-09
updated: 2026-04-09
sources: [resume-optimization.md, pipeline-spec.md]
tags: [ats, resume, cv, pdf, keyword-injection, applicant-tracking]
---

# ATS Optimization

Making resumes parseable and highly ranked by Applicant Tracking Systems (Workday, Greenhouse, Lever, iCIMS). This includes keyword injection, format rules, scoring rubrics, and the career-ops PDF generation approach.

## Why ATS Optimization Matters

Most companies use ATS software to screen resumes before a human sees them. A strong resume that fails ATS parsing gets rejected automatically. Key factors:

- **Keyword matching**: ATS scans for specific terms from the job description
- **Format compliance**: Single-column layouts, standard section headers, no tables/graphics
- **Parseable structure**: Clean text extraction, no embedded images or complex formatting
- **Relevance scoring**: Systems rank candidates by keyword density and match quality

## The Resume Optimization System V2.0

Yash's pipeline uses a structured 6-phase system (detailed in [[resume-optimization]]):

### Phase 1: JD Analysis
Extract required/preferred skills, identify high-priority keywords (appearing 2+ times or in "required" section), and secondary keywords.

### Phase 2: Technical Skills Mapping
Populate 6 locked skill categories with JD-relevant terms. Character limits enforced per category. High-priority JD keywords placed first.

### Phase 3: Work Experience Enhancement
Enhance baseline sentences by injecting JD keywords -- never fabricate new accomplishments. Each sentence follows the STAR framework: Action Verb + Technical Skill (bolded) + Context + Quantified Outcome.

### Phase 4: ATS Formatting
- 1-3 high-priority JD keywords per sentence wrapped in `\textbf{}`
- Single-page LaTeX output
- Standard section headers (Experience, Skills, Education, Certifications)
- Clean, parseable structure

### Phase 5: Constraint Verification
- Exactly 15 experience sentences (Morningstar: 6, Bell: 5, Virtusa: 4)
- No verb repetition within the same company
- Metrics only from pre-approved allowed values
- Domain lock respected (AI/Finance at Morningstar, Java/Telecom at Bell, Java/Banking at Virtusa)

### Phase 6: Quality Scoring
Score must reach 90/100 before output. Below 90 triggers self-correction.

## Keyword Allocation Strategy

Critical rule -- keywords are domain-locked to specific companies:

| Keyword Type | Allocation |
|-------------|------------|
| AI/ML/LLM/GenAI | Morningstar ONLY |
| Python/Data Science | Morningstar ONLY |
| Java/Spring/Hibernate | Bell + Virtusa |
| CI/CD/DevOps/Docker | Bell ONLY |
| Microservices/APIs | Bell (primary) + Virtusa (secondary) |
| Cloud (AWS/Azure) | Morningstar (primary), Bell (if heavily emphasized) |
| SQL/Databases | Distributed across all three |

## Integration with Career-Ops

The career-ops `pdf` mode generates ATS-optimized CVs using this system. The pipeline:
1. Reads JD
2. Runs all 6 phases internally
3. Outputs compilable LaTeX
4. Generates PDF via Playwright or pdflatex
5. Stores in `output/`

For [[form-fill-data]], the ATS optimization extends to form field answers -- mirroring JD terminology in free-text responses.

## See Also

- [[resume-optimization]] (source summary)
- [[target-roles]]
- [[form-fill-data]]
- [[morningstar-software-engineer]]
- [[bell-full-stack-developer]]
- [[virtusa-full-stack-developer]]
