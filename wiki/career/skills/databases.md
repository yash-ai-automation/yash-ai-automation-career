---
title: "Databases"
type: career
created: 2026-04-09
updated: 2026-04-09
sources: [linkedin-profile.md]
tags: [skills, databases, postgresql, mongodb, redis, elasticsearch]
---

# Databases

Database technologies used across professional roles, spanning relational, document, cache, and search systems.

## Relational

### PostgreSQL
- **Proficiency:** Expert
- **Used at:** [[bell-full-stack-developer]], [[morningstar-software-engineer]]
- **Highlights:** Query optimization yielding **60% faster** reports at Bell; data layer for [[microservices-billing]] (45K daily transactions, 99.9% uptime)

### SQL (Oracle/Other)
- **Used at:** [[virtusa-full-stack-developer]]
- **Highlights:** Optimization for **52% faster** compliance reports; ETL pipelines reducing **85% manual data entry**; batch processing of **85,000 nightly records**

## Document Store

### MongoDB
- NoSQL document storage for flexible schema requirements
- Used in applications requiring rapid iteration on data models

## Cache

### Redis
- In-memory caching for high-throughput systems
- Session management and rate limiting
- Performance optimization for sub-100ms API responses

## Search

### Elasticsearch
- Full-text search and analytics
- Log aggregation and operational monitoring
- Complements vector databases used in [[rag-pipeline-15k-docs]]

## Database Selection by Use Case

| Use Case | Database | Example |
|----------|----------|---------|
| Transactional billing | PostgreSQL | [[microservices-billing]] |
| Banking transactions | Oracle/SQL | [[banking-transaction-platform]] |
| Vector search | Vector DBs | [[rag-pipeline-15k-docs]] |
| Caching | Redis | API response optimization |
| Full-text search | Elasticsearch | Log analysis, monitoring |

## See Also
- [[programming-languages]] -- SQL proficiency
- [[frameworks-and-web]] -- frameworks that use these databases
- [[cloud-and-devops]] -- managed database services
