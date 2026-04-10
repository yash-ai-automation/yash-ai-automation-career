---
title: RAG Pipelines
type: entity
created: 2026-04-09
updated: 2026-04-09
sources: [linkedin-profile.md, resume-optimization.md]
tags: [technology, ai, rag, retrieval-augmented-generation, llm]
---

# RAG Pipelines

Retrieval-Augmented Generation (RAG) combines large language models with external knowledge retrieval to produce grounded, accurate responses. Rather than relying solely on the LLM's training data, RAG systems retrieve relevant documents from a knowledge base and feed them as context to the model.

## Yash's Experience

RAG pipelines are one of Yash's core technical competencies, developed primarily during his time at [[morningstar]].

### Production RAG at Morningstar
- Engineered generative AI systems using LLMs and [[vector-databases]] to process 15K+ documents
- Reduced data extraction time by 75% while ensuring semantic accuracy
- Implemented advanced RAG pipeline benchmarking protocols to maintain quality
- Used [[aws-bedrock]] as the LLM backbone for document processing pipelines
- Applied [[deepeval]] for monitoring hallucination and retrieval quality in production

### Key Architecture Components
- **Retrieval layer:** [[vector-databases]] for semantic search over financial documents
- **Generation layer:** LLMs via [[aws-bedrock]] for summarization and extraction
- **Evaluation layer:** [[deepeval]] for monitoring drift, hallucination, and retrieval relevance
- **Orchestration:** [[langchain]] for chaining retrieval and generation steps

### Scale
- 15K+ documents indexed and searchable
- Used by analyst teams for investment research report processing
- Production-grade with monitoring and benchmarking

## Relevance to Job Search

RAG is a high-demand skill in 2025-2026 AI engineering roles. Yash's experience building production RAG systems at enterprise scale (not just prototypes) is a strong differentiator. Relevant to roles mentioning: RAG, retrieval-augmented generation, semantic search, knowledge bases, document AI, GenAI infrastructure.

## See Also
- [[vector-databases]]
- [[aws-bedrock]]
- [[langchain]]
- [[deepeval]]
- [[morningstar]]
