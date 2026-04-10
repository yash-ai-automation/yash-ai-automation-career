---
title: "Microservices Billing Platform"
type: career
created: 2026-04-09
updated: 2026-04-09
sources: [linkedin-profile.md]
tags: [project, microservices, java, spring-boot, billing, bell, telecom]
---

# Microservices Billing Platform

**Company:** [[bell-full-stack-developer]]
**Period:** 2022
**Stack:** Java, Spring Boot, API Gateway, PostgreSQL

## Overview

High-throughput microservices billing platform for Bell's subscriber base. Handled transaction processing, subscription management, and billing cycle operations for one of Canada's largest telecom providers.

## Technical Details

- Microservices architecture with Spring Boot for service isolation and scalability
- REST APIs exposed via API Gateway serving **850,000 subscribers**
- Event-driven order management for subscriber provisioning
- [[databases]]: PostgreSQL with optimized queries for **60% faster** report generation

## Architecture

1. API Gateway layer routing to domain-specific microservices
2. Billing service processing **45,000 daily transactions**
3. Order management service with event-driven provisioning (**55% faster**)
4. Reporting service with optimized PostgreSQL queries
5. Monitoring dashboards (Angular + Java)

## Impact

| Metric | Value |
|--------|-------|
| Daily transactions | 45,000 |
| Subscribers served | 850,000 |
| System uptime | 99.9% |
| API response time | <100ms |
| Provisioning improvement | 55% faster |
| Report speed improvement | 60% faster |

## See Also
- [[bell-full-stack-developer]] -- parent role
- [[network-provisioning]] -- related Bell project
- [[frameworks-and-web]] -- Spring Boot, Angular
- [[measurable-impacts]] -- consolidated metrics
