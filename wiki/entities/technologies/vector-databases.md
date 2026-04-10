---
title: Vector Databases
type: entity
created: 2026-04-09
updated: 2026-04-09
sources: [linkedin-profile.md, personal-background.md]
tags: [technology, ai, databases, embeddings, semantic-search]
---

# Vector Databases

Vector databases are purpose-built storage systems for high-dimensional embedding vectors. They enable semantic similarity search -- finding documents, images, or data points by meaning rather than exact keyword matching. Core to modern [[rag-pipelines]] and AI applications.

## Yash's Experience

Yash used vector databases at [[morningstar]] as a foundational component of production AI systems.

### Usage at Morningstar
- Processed and indexed 15K+ financial documents for semantic retrieval
- Served as the retrieval layer in [[rag-pipelines]], enabling analysts to search investment research by meaning
- Combined with [[aws-bedrock]] LLMs for retrieval-augmented generation
- Used embeddings and vector similarity for GenAI classification, achieving 94% accuracy across 12K monthly fund documents

### Key Capabilities Leveraged
- **Embedding storage:** High-dimensional vectors from document embeddings
- **Semantic search:** Finding relevant documents by meaning, not just keywords
- **Similarity scoring:** Ranking retrieved documents by relevance for RAG context windows
- **Scale:** Supporting 15K+ document corpus with production-grade performance

### Architecture Role
Vector databases sat between document ingestion and LLM generation in the Morningstar AI stack:
1. Documents processed and embedded
2. Embeddings stored in vector database
3. User queries converted to embeddings
4. Semantic search retrieves relevant documents
5. Retrieved context fed to [[aws-bedrock]] LLMs via [[langchain]]
6. Quality monitored by [[deepeval]]

## Relevance to Job Search

Vector database experience is essential for AI engineering roles in 2025-2026. Nearly every production RAG system depends on vector search. Relevant to roles mentioning: vector databases, Pinecone, Weaviate, Qdrant, Milvus, ChromaDB, pgvector, semantic search, embedding systems, RAG infrastructure.

## See Also
- [[rag-pipelines]]
- [[aws-bedrock]]
- [[langchain]]
- [[deepeval]]
- [[morningstar]]
