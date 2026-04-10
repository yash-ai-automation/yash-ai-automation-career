---
title: MLOps / LLMOps
type: concept
created: 2026-04-09
updated: 2026-04-09
sources: [linkedin-profile.md, resume-optimization.md]
tags: [mlops, llmops, monitoring, deepeval, inference, drift-detection, aws]
---

# MLOps / LLMOps

Operationalizing machine learning and large language model systems: monitoring model performance, running evaluations, detecting drift, managing inference infrastructure, and ensuring production-grade AI reliability. Yash has hands-on experience from his [[morningstar]] work.

## MLOps vs LLMOps

**MLOps** covers the lifecycle of traditional ML models -- training, deployment, monitoring, retraining. **LLMOps** extends this to LLM-specific concerns: prompt versioning, hallucination detection, evaluation frameworks, token cost management, and RAG pipeline quality.

Yash's work at Morningstar spans both:
- ML models for financial data classification (MLOps)
- LLM-based summarization and RAG systems (LLMOps)

## Yash's MLOps/LLMOps Work

### Evaluation and Monitoring
- Implemented [[deepeval]] and PyTest frameworks to monitor model performance and drift
- Improved prediction reliability by 25%
- Established best practices for hallucination detection in production AI solutions
- Automated API testing suites using [[playwright]] and GitHub Actions to validate GenAI outputs
- Reduced regression cycles by 60%

### Inference Infrastructure
- Deployed scalable inference on AWS ([[aws-bedrock]], serverless architecture)
- Supporting 25K+ daily prediction requests
- Sub-200ms latency for AI-powered features
- Production-grade reliability for financial services workloads

### RAG Pipeline Quality
- Built [[rag-pipelines]] processing 15K+ documents
- Semantic accuracy ensured through advanced RAG benchmarking protocols
- Reduced data extraction time by 75%

## Key Technologies

| Technology | Use Case |
|------------|----------|
| [[deepeval]] | LLM evaluation, hallucination detection, drift monitoring |
| PyTest | Test framework for ML model validation |
| [[playwright]] | API testing for GenAI output validation |
| GitHub Actions | CI/CD for model deployment and testing |
| [[aws-bedrock]] | Managed LLM inference infrastructure |
| AWS Lambda/Serverless | Scalable inference hosting |
| [[vector-databases]] | Embedding storage and retrieval for RAG |

## The MLOps Lifecycle (as Practiced)

```
Train/Fine-tune --> Deploy (AWS) --> Monitor (DeepEval) --> Evaluate --> Retrain/Update
                                         |
                                    Drift detected?
                                    Hallucination rate?
                                    Latency within SLA?
```

## Relationship to Other Concepts

MLOps/LLMOps is the operational layer that ensures [[generative-ai]] systems remain reliable in production. It connects to [[enterprise-engineering]] (infrastructure discipline) and [[ai-automation]] (the workflows these models power).

## Relevance to [[target-roles]]

ML Engineer and AI Engineer roles increasingly require MLOps skills. The combination of DeepEval experience, production inference at scale, and drift detection is a differentiator for Yash's applications.

## See Also

- [[generative-ai]]
- [[enterprise-engineering]]
- [[deepeval]]
- [[aws-bedrock]]
- [[rag-pipelines]]
- [[morningstar-software-engineer]]
- [[target-roles]]
