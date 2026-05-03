# ADR-0002: Trace and Eval Substrate as Evidence Infrastructure

**Status:** Accepted  
**Date:** 2026-05-03  
**Scope:** Runtime, observability, testing

## Context

Before v0.5, execution was opaque. There was no structured record of what the agent planned, what tools it called, what failed, or why. This blocked debugging, regression detection, and future self-evolution.

## Decision

Every run produces a structured trajectory with:
- 32 event kinds
- Timestamped tool calls tied to context
- Failure classification (13 classes)
- Decision/event log
- Safe redaction of secrets

Eval fixtures run deterministically against known scenarios. The eval runner is the regression gate for skill evolution proposals.

## Rejected Alternatives

1. **Log-only tracing** — Rejected: unstructured logs are not queryable or linkable.
2. **External observability platform** — Rejected: local-first requirement.
3. **Unit tests as primary safety net** — Rejected: too much code churn pre-MVP; eval fixtures are cheaper.

## Consequences

- `TrajectoryRecorder` and `SQLiteSessionDB` are the persistence layer.
- `estacoda trace` CLI provides inspection.
- Eval fixtures grow with each subsystem.
- Smoke tests remain broad; evals become focused.
