# ADR-0005: Execution Plans Private, Canonical Docs Public

**Status:** Accepted  
**Date:** 2026-05-03  
**Scope:** Documentation governance, repo hygiene

## Context

Execution plans are detailed, iterative, and contain internal decisions, trade-offs, and speculation. They are valuable for the team but confusing and misleading for external contributors. Committing them to the public repo creates documentation sprawl.

## Decision

1. **Execution plans live in the private workspace**, not the public repo.
2. **Canonical docs in the repo are public-ready** unless explicitly marked internal.
3. **Durable decisions from execution plans are promoted** into architecture docs, ADRs, release notes, or public operations docs.
4. **Internal alpha runbooks, assessments, and call graphs** are private workspace artifacts.

## Rejected Alternatives

1. **Keep everything in the repo** — Rejected: sprawl, stale docs, internal detail leakage.
2. **Separate private repo for docs** — Rejected: overhead for a pre-MVP project.
3. **Mark internal docs with disclaimers** — Rejected: still clutters the public tree.

## Consequences

- Planning and release-control artifacts stay outside the public repo.
- Public history is promoted into release notes or operations docs when it matters to users.
- Private workspace material holds detailed plans.
