# ADR-0003: Advisory Skills vs Durable TaskFlow Boundary

**Status:** Accepted  
**Date:** 2026-05-03  
**Scope:** Skills, workflows, runtime

## Context

Skills teach workflows through Markdown instructions. Some workflows need guarantees (shipping, deployment, payments). Others need flexibility (research, architecture, debugging). A single model cannot serve both needs well.

## Decision

Skills remain **Markdown-first and advisory** by default:

```yaml
workflowMode: advisory
```

The skill teaches the agent a good workflow. The agent decides how to apply it.

**Enforced workflows** exist for high-value operational flows:

```yaml
workflowMode: enforced
```

Enforced workflows need:
- Step state
- Dependency resolution
- Failure handling
- Resume behavior
- Cancellation
- Approval gates
- Artifact recording
- Validation hooks

The split:
- Skill template = authoring surface
- Workflow schema = runtime interpretation layer
- Tool planner = dependency-aware execution
- TaskFlow = durable enforced orchestration

## Rejected Alternatives

1. **All skills as rigid mini-programs** — Rejected: kills flexibility for judgment-heavy tasks.
2. **No enforcement at all** — Rejected: unsafe for operational workflows.
3. **Skill-level enforcement only** — Rejected: enforcement belongs in runtime, not authoring.

## Consequences

- v0.7 supports advisory skill workflows.
- v0.8 introduces TaskFlow for durable enforced orchestration.
- Skills do not become a programming language.
