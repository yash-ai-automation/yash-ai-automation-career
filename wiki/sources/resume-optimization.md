---
title: "Source: Resume Optimization System"
type: source
created: 2026-04-09
updated: 2026-04-09
sources: [resume-optimization.md]
tags: [source, resume, ats, latex, keyword-injection, scoring, baseline-sentences]
---

# Source: Resume Optimization System

Summary of `wiki/raw/resume-optimization.md` -- The V2.0 Resume Optimization System with baseline sentences, keyword injection rules, scoring rubric, and anti-hallucination safeguards.

## System Purpose

Generate tailored, ATS-optimized LaTeX resumes for every job application. The system ENHANCES existing baseline work experience by injecting JD keywords -- it never invents new accomplishments. See [[ats-optimization]] for the concept overview.

## The 6 Phases

### Phase 1: JD Analysis & Integrity Check
- Extract required and preferred technical skills
- Identify high-priority keywords (2+ occurrences or in "required" section)
- Identify secondary keywords (mentioned once or in "preferred" section)
- Only work experience and technical skills sections are modifiable

### Phase 2: Technical Skills Mapping
Six locked skill categories with character limits:
- AI & Automation (97 chars), Languages (88), Frameworks & Web (88), Data & Databases (91), Cloud & DevOps (87), Tools & Platforms (86, catch-all)
- High-priority JD keywords placed first; overflow goes to Tools & Platforms

### Phase 3: Work Experience Transformation
Enhance baseline sentences with JD keywords. Sentence counts are strict:
- [[morningstar]]: 6 sentences
- [[bell-canada]]: 5 sentences
- [[virtusa]]: 4 sentences
- Total: exactly 15 sentences

### Phase 3A: Baseline Sentences (Anti-Hallucination)
Pre-defined, verified accomplishments with enhancement zones marking which parts can be modified. Each sentence has domain-locked context that must be preserved. Allowed metrics are pre-defined per company -- no invented numbers.

### Phase 3B: Keyword-to-Context Mapping
Strict allocation rules:
- AI/ML/LLM/GenAI and Python: Morningstar ONLY
- Java/Spring: Bell + Virtusa
- CI/CD/DevOps: Bell ONLY
- No keyword in more than 2 companies' sentences

### Phase 3C: Sentence Quality Standards
Each sentence must contain: strong action verb (tracked, no repetition per company), 1-3 bolded JD keywords, domain-appropriate context, and a quantified outcome from allowed metrics.

### Phase 3D: Sentence Enhancement Workflow
Five-step process: keyword extraction/prioritization, keyword-to-baseline mapping, baseline enhancement, metric validation, verb/uniqueness tracking.

### Phase 4: ATS Optimization
Format rules for ATS parseability. Single-page LaTeX output with standard headers.

### Phase 5: Constraint Verification
Final checks on sentence counts, verb uniqueness, metric validity, domain lock compliance, and keyword distribution.

### Phase 6: Quality Scoring
Score must reach 90/100. Components include keyword match rate, sentence quality, formatting compliance, and constraint adherence. Below 90 triggers self-correction loop.

## Allowed Metrics (Key Values)

| Company | Metric Type | Allowed Values |
|---------|-------------|----------------|
| Morningstar | Documents processed | 8K-40K monthly |
| Morningstar | Time reduction | 45%-75% |
| Morningstar | Accuracy | up to 94% |
| Bell | Transactions | 25K-95K daily |
| Bell | Uptime | 99.5%-99.95% |
| Bell | Users | 350K-1.2M |
| Virtusa | Transactions | 65K-180K daily |
| Virtusa | Accuracy | 99.5%-99.8% |

## See Also

- [[ats-optimization]]
- [[pipeline-spec]]
- [[morningstar-software-engineer]]
- [[bell-full-stack-developer]]
- [[virtusa-full-stack-developer]]
