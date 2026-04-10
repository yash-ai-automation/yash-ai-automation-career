---
title: "GenAI Classification with Embeddings"
type: career
created: 2026-04-09
updated: 2026-04-09
sources: [linkedin-profile.md]
tags: [project, genai, embeddings, classification, morningstar, ai]
---

# GenAI Classification with Embeddings

**Company:** [[morningstar-software-engineer]]
**Period:** 2024--2025
**Stack:** Python, LLMs, Vector DBs, embeddings

## Overview

A GenAI-powered document classification system using embedding models to categorize financial documents with high accuracy. Replaced rule-based and traditional ML classifiers with semantic understanding via embeddings.

## Technical Details

- Generated document embeddings using LLM-based embedding models
- Stored and indexed vectors in a vector database for similarity-based classification
- Achieved **94% accuracy** on financial document categorization
- Handled edge cases where traditional keyword-based classifiers failed

## Architecture

1. Document ingestion from [[ai-document-processing]] pipeline
2. Embedding generation via LLM API
3. Vector similarity search against labeled reference set
4. Classification with confidence scoring
5. Low-confidence items routed for human review

## Relationship to Other Systems

- Complemented the ML models in [[ai-document-processing]] with semantic classification
- Shared vector infrastructure with [[rag-pipeline-15k-docs]]
- Monitored via [[testing-and-qa]] frameworks (DeepEval)

## Impact

| Metric | Value |
|--------|-------|
| Classification accuracy | 94% |

## See Also
- [[morningstar-software-engineer]] -- parent role
- [[ai-document-processing]] -- upstream pipeline
- [[rag-pipeline-15k-docs]] -- shared vector infrastructure
- [[ai-and-ml]] -- skills used
