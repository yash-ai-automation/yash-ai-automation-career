---
title: "RAG Pipeline -- 15K+ Documents"
type: career
created: 2026-04-09
updated: 2026-04-09
sources: [linkedin-profile.md]
tags: [project, rag, genai, vector-db, llm, morningstar]
---

# RAG Pipeline -- 15K+ Documents

**Company:** [[morningstar-software-engineer]]
**Period:** 2024--2025
**Stack:** Python, LLMs, Vector DBs, LangChain, AWS

## Overview

Production Retrieval-Augmented Generation system spanning 15,000+ financial documents. Enabled analysts to query large document corpora using natural language and receive grounded, cited answers with sub-30-second response times.

## Technical Details

- Indexed **15,000+ documents** in vector database with chunking and metadata preservation
- LLM-based query understanding and answer synthesis with source citations
- Achieved **75% faster extraction** compared to manual document search
- Generated analyst briefs in **under 30 seconds**

## Architecture

1. Documents preprocessed by [[ai-document-processing]] pipeline
2. Chunking strategy preserving section boundaries and metadata
3. Embedding generation and vector storage
4. Query processing: embedding + similarity search + reranking
5. LLM synthesis with retrieved context and citation tracking

## Infrastructure

- AWS serverless deployment handling **25,000+ daily requests**
- **Sub-200ms latency** for inference via AWS Lambda + SageMaker
- Scalable vector database for growing document corpus

## Impact

| Metric | Value |
|--------|-------|
| Documents indexed | 15,000+ |
| Extraction speed improvement | 75% |
| Brief generation time | <30 seconds |
| Daily requests served | 25,000+ |
| Inference latency | <200ms |

## See Also
- [[morningstar-software-engineer]] -- parent role
- [[ai-document-processing]] -- upstream pipeline
- [[genai-classification]] -- shared vector infrastructure
- [[cloud-and-devops]] -- AWS deployment
- [[measurable-impacts]] -- all metrics
