---
title: Generative AI
type: concept
created: 2026-04-09
updated: 2026-04-09
sources: [linkedin-profile.md, resume-optimization.md]
tags: [genai, llm, rag, embeddings, prompt-engineering, morningstar]
---

# Generative AI

Large language models (LLMs), prompt engineering, retrieval-augmented generation (RAG), embeddings, and GenAI-based classification. This is the technical core of Yash's most recent and relevant work at [[morningstar]].

## Key Techniques

### Prompt Engineering
Designing and iterating on prompts to extract reliable, structured outputs from LLMs. Used at Morningstar for:
- Earnings report summarization (analyst-ready briefs in under 30 seconds)
- Document classification across 12K monthly fund documents

### Retrieval-Augmented Generation (RAG)
Combining LLMs with external knowledge retrieval to ground outputs in real data. Yash built [[rag-pipelines]] at Morningstar enabling natural language queries against proprietary financial databases, accelerating research workflows by 50%.

### Embeddings and Vector Similarity
Using [[vector-databases]] and embedding models for semantic search and classification. Achieved 94% accuracy on financial data categorization using embeddings-based approaches.

### LLM-Based Summarization
Built tools using LLMs to summarize earnings reports into concise, analyst-ready briefs. Delivered outputs in under 30 seconds per document.

## Yash's Morningstar GenAI Work

| Project | Technique | Impact |
|---------|-----------|--------|
| [[ai-document-processing]] | LLM extraction pipelines | 65% reduction in manual review |
| [[genai-classification]] | Embeddings + vector similarity | 94% accuracy, 12K docs/month |
| [[rag-pipeline-15k-docs]] | RAG over financial databases | 50% faster research workflows |
| LLM summarization | Prompt engineering | 30-second analyst briefs |
| Inference infrastructure | AWS deployment | 25K+ daily requests, sub-200ms |

## Technology Stack

- **LLM APIs**: GPT-4/5, Claude API, Amazon Bedrock
- **Frameworks**: [[langchain]], [[deepeval]]
- **Infrastructure**: [[aws-bedrock]], vector databases, serverless
- **Validation**: [[deepeval]] for hallucination detection, PyTest for output quality
- **Monitoring**: Model performance tracking, drift detection ([[mlops-llmops]])

## Relationship to Other Concepts

GenAI is the intelligence layer that powers [[ai-automation]] systems. While [[workflow-orchestration]] handles the process flow and [[enterprise-engineering]] ensures reliability, generative AI provides the reasoning, classification, and generation capabilities.

## Relevance to [[target-roles]]

GenAI Engineer and AI Engineer roles focus heavily on this area. The 94% classification accuracy, RAG pipeline work, and production inference at scale (25K+ daily, sub-200ms) are the key proof points.

## See Also

- [[ai-automation]]
- [[mlops-llmops]]
- [[rag-pipelines]]
- [[vector-databases]]
- [[aws-bedrock]]
- [[deepeval]]
- [[morningstar]]
- [[target-roles]]
