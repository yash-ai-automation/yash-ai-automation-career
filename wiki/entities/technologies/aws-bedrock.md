---
title: AWS Bedrock
type: entity
created: 2026-04-09
updated: 2026-04-09
sources: [linkedin-profile.md, resume-optimization.md]
tags: [technology, ai, aws, cloud, llm, inference]
---

# AWS Bedrock

Amazon Bedrock is a fully managed service from AWS that provides access to foundation models (FMs) from leading AI companies through a single API. It supports model customization, fine-tuning, RAG integration, and serverless inference at scale.

## Yash's Experience

Yash used AWS Bedrock extensively at [[morningstar]] as the backbone for production AI systems.

### Usage at Morningstar
- Engineered Amazon Bedrock-powered document processing pipelines using Python
- Automated extraction from investment research reports, reducing manual review time by 65%
- Deployed scalable inference infrastructure with serverless architecture
- Supported 25K+ daily prediction requests with sub-200ms latency
- Served as the LLM provider for [[rag-pipelines]] processing 15K+ documents

### Key Capabilities Leveraged
- **Serverless inference:** No infrastructure management, auto-scaling for 25K+ daily requests
- **Model access:** Foundation models for document classification, summarization, and extraction
- **RAG integration:** Combined with [[vector-databases]] for retrieval-augmented generation
- **Low latency:** Sub-200ms response times for production AI features
- **Enterprise compliance:** AWS security and compliance features suitable for financial services

### Architecture Context
AWS Bedrock was the central AI infrastructure piece at Morningstar, connecting to:
- [[rag-pipelines]] for document retrieval and generation
- [[vector-databases]] for semantic search
- [[deepeval]] for monitoring model quality
- [[langchain]] for orchestration

## Relevance to Job Search

AWS Bedrock experience is highly relevant for roles requiring production AI deployment on AWS. Signals: enterprise-grade AI infrastructure, not just prototyping. Relevant to roles mentioning: AWS AI/ML, Bedrock, SageMaker, cloud AI infrastructure, MLOps, GenAI platform engineering.

## See Also
- [[rag-pipelines]]
- [[vector-databases]]
- [[langchain]]
- [[deepeval]]
- [[morningstar]]
