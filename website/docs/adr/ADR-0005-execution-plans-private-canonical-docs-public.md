---
title: ADR-0005 Execution Plans Private Canonical Docs Public
description: Execution plans live in the private workspace; canonical docs are public-ready.
sidebar_position: 5
---

# ADR-0005: Execution Plans Private, Canonical Docs Public

**Status:** Accepted
**Date:** 2026-05-03
**Scope:** Documentation governance, repo hygiene

---

## Context

Execution plans are detailed, iterative, and contain internal decisions, trade-offs, and speculation. They are valuable for the team but confusing and misleading for external contributors. Committing them to the public repo creates documentation sprawl.

## Decision

1. **Execution plans live in the private workspace**, not the public repo.
2. **Canonical docs in the repo are public-ready** unless explicitly marked internal.
3. **Durable decisions from execution plans are promoted** into architecture docs, ADRs, release notes, or public operations docs.
4. **Internal alpha runbooks, assessments, and call graphs** are private workspace artifacts.

## Rejected alternatives

1. **Keep everything in the repo** — Rejected. Sprawl, stale docs, internal detail leakage.
2. **Separate private repo for docs** — Rejected. Overhead for a pre-MVP project.
3. **Mark internal docs with disclaimers** — Rejected. Still clutters the public tree.

## Consequences

- Planning and release-control artifacts stay outside the public repo.
- Public history is promoted into release notes or Docusaurus operations docs when it matters to users.
- Private workspace material holds detailed plans.

## Operational impact

**What boundary it creates:**
- The public repo contains durable decisions, not iterative drafts. If a doc is in the repo, it should be accurate and readable by external contributors.
- The private workspace contains working memory: plans, assessments, grep maps, and operational runbooks.

**What files, commands, and subsystems it affects:**
- Docusaurus operations docs — public maintenance and release process guidance
- ADRs — durable architecture and governance decisions
- Private workspace material — detailed execution plans and internal assessments

**What maintainers must preserve:**
- Durable decisions must be promoted, not left in private plans. A decision that stays private is invisible to future maintainers.
- Canonical docs must be kept accurate. Public docs that drift from the code are worse than no docs.
- Internal artifacts must not leak into the public repo. Review `git status` before committing.

**What failure or drift it prevents:**
- Documentation sprawl where 80% of the docs tree is stale planning material.
- External contributors reading internal trade-offs as public commitments.
- Durable decisions being lost because they were never promoted out of a private plan.

**What is intentionally outside the decision:**
- A formal document lifecycle tool. The boundary is enforced by convention and review.
- Automatic promotion of decisions from private plans. Promotion is manual and intentional.
- Public access to the private workspace. Private means private.

## Related docs

- [Operations: Maintenance](../operations/maintenance.md)
- [Developer: Architecture](../developer/architecture.md)
