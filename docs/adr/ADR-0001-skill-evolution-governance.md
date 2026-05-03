# ADR-0001: Governed Skill Evolution and Review-Gated Promotion

**Status:** Accepted  
**Date:** 2026-05-03  
**Scope:** Skills, evolution, security

## Context

EstaCoda needs to improve skills from usage and failure evidence. Hermes and OpenClaw demonstrate that agents can learn, but silent self-mutation is dangerous. AHE (Agentic Harness Engineering) shows that observability and evidence make controlled improvement possible.

## Decision

Skill evolution follows a governed loop with explicit review gates:

```
observe → propose → review → approve/reject → promote → rollback
```

Every proposal carries a `ChangeManifest` with:
- Hypothesis
- Predicted impact
- Risk level
- Eval plan
- Constraint gates
- Rollback plan

Promotion requires explicit approval or configured policy. Failing eval gates block promotion. The runtime never silently rewrites itself.

## Rejected Alternatives

1. **Auto-promotion after eval pass** — Rejected: removes human review for high-risk changes.
2. **Direct skill mutation without manifest** — Rejected: no evidence trail, no rollback.
3. **External-only evolution pipeline** — Rejected: runtime must capture evidence locally.

## Consequences

- Proposal and manifest CLI namespaces are top-level (`estacoda proposal`, `estacoda manifest`).
- `SkillProposalService` is the shared implementation layer.
- Tool-description and routing-metadata proposals are supported as manifest targets.
- Auto-proposal generation is deferred to post-v0.7.
