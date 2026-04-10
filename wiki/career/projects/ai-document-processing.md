---
title: "AI Document Processing Pipelines"
type: career
created: 2026-04-09
updated: 2026-04-09
sources: [linkedin-profile.md]
tags: [project, ai, python, ml, document-processing, morningstar]
---

# AI Document Processing Pipelines

**Company:** [[morningstar-software-engineer]]
**Period:** 2023--2025
**Stack:** Python, ML models, AWS

## Overview

End-to-end AI pipelines for automated processing and classification of financial documents at scale. The system ingested raw financial documents, applied ML classification, extracted structured data, and routed results for analyst review.

## Technical Details

- Built in Python with modular pipeline stages (ingestion, classification, extraction, validation)
- ML models trained for financial document classification achieving **94% accuracy**
- Processed **12,000+ documents monthly** across multiple document types
- Reduced manual review effort by **65%** compared to previous human-only workflow

## Integration Points

- Fed into [[rag-pipeline-15k-docs]] for downstream search and retrieval
- Classification layer shared with [[genai-classification]] embeddings approach
- Deployed on [[cloud-and-devops]] infrastructure (AWS Lambda, SageMaker)

## Impact

| Metric | Value |
|--------|-------|
| Documents processed monthly | 12,000+ |
| Classification accuracy | 94% |
| Manual review reduction | 65% |

## See Also
- [[morningstar-software-engineer]] -- parent role
- [[genai-classification]] -- embeddings-based classification
- [[rag-pipeline-15k-docs]] -- RAG system built on processed docs
- [[measurable-impacts]] -- all metrics
