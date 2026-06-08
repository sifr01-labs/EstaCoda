# ADR-0003: Skill Playbooks vs Durable Workflows Boundary

**Status:** Accepted  
**Date:** 2026-05-03  
**Scope:** Skills, workflows, runtime

## Context

Skills teach workflows through Markdown instructions. Some workflows need guarantees (shipping, deployment, payments). Others need flexibility (research, architecture, debugging). A single model cannot serve both needs well.

## Decision

Skills remain **Markdown-first and advisory**. A skill playbook teaches the agent a good sequence; normal AgentLoop skill selection does not create a durable Workflow run.

Workflow is the durable runtime system. Operators enter it explicitly:

```bash
/workflow begin <objective>
/workflow begin --skill <skillName> <objective>
estacoda workflow begin --session <sessionId> <objective>
estacoda workflow begin --skill <skillName> --session <sessionId> <objective>
```

Durable Workflow runs need:
- Step state
- Dependency resolution
- Failure handling
- Resume behavior
- Cancellation
- Approval gates
- Artifact recording
- Validation hooks

The split:
- Skill playbook = advisory authoring surface
- `convertSkillPlaybookToWorkflowPlan()` = explicit bridge from a named skill playbook to a `WorkflowPlan`
- Tool planner = dependency-aware execution
- Workflow = durable orchestration with persisted state and operator controls

## Rejected Alternatives

1. **All skills as rigid mini-programs** — Rejected: kills flexibility for judgment-heavy tasks.
2. **No enforcement at all** — Rejected: unsafe for operational workflows.
3. **Skill-level enforcement only** — Rejected: enforcement belongs in runtime, not authoring.

## Consequences

- v0.7 supports advisory skill playbooks.
- v0.8 introduces explicit Workflow begin for durable orchestration.
- Skills do not become a programming language.
- There is no automatic workflow promotion, no complex-request auto-detection, and no `--use-selected-playbook` shortcut.
