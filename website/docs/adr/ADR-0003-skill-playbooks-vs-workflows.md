---
title: ADR-0003 Skill Playbooks vs Workflows
description: Markdown-first skill playbooks and durable enforced orchestration via Workflow.
sidebar_position: 3
---

# ADR-0003: Skill Playbooks vs Durable Workflows Boundary

**Status:** Accepted
**Date:** 2026-05-03
**Scope:** Skills, workflows, runtime

---

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

## Rejected alternatives

1. **All skills as rigid mini-programs** — Rejected. Kills flexibility for judgment-heavy tasks.
2. **No enforcement at all** — Rejected. Unsafe for operational workflows.
3. **Skill-level enforcement only** — Rejected. Enforcement belongs in runtime, not authoring.

## Consequences

- v0.7 supports advisory skill playbooks.
- v0.8 introduces explicit Workflow begin for durable orchestration.
- Skills do not become a programming language.
- There is no automatic workflow promotion, no complex-request auto-detection, and no `--use-selected-playbook` shortcut.

## Operational impact

**What boundary it creates:**
- Skill playbooks provide guidance without guaranteeing execution order. The agent may skip, reorder, or reinterpret steps.
- Explicit workflow runs execute through Workflow, which records every step, enforces transitions, and blocks illegal state changes.

**What files, commands, and subsystems it affects:**
- `estacoda skills list` — browse available skills
- `estacoda skills view <name>` — read full SKILL.md content
- `estacoda workflow` — Workflow operator commands
- `src/skills/skill-loader.ts` — skill parsing and validation
- `src/workflow/` — durable orchestration engine
- `src/tools/tool-call-planner.ts` — dependency-aware execution planning

**What maintainers must preserve:**
- The playbook/Workflow boundary must remain explicit. A skill playbook must never be silently upgraded to durable Workflow behavior.
- Workflow state transitions must remain strict. Illegal transitions throw `IllegalTransitionError`; relaxing this corrupts execution guarantees.
- Skill templates must stay Markdown-first. Turning skills into a DSL would violate the decision.

**What failure or drift it prevents:**
- Over-constraining judgment-heavy tasks by forcing rigid step order.
- Under-constraining operational workflows by allowing the agent to skip safety steps.
- Skill bloat where every workflow tries to be both advisory and enforced simultaneously.

**What is intentionally outside the decision:**
- Automatic workflow mode selection or automatic workflow promotion.
- Visual workflow builder. Authoring remains text-based.
- Cross-skill playbook composition. A workflow belongs to a single skill or explicit composition layer.

## Related docs

- [Skills](../user-guide/skills.md)
- [Workflow CLI](../reference/cli-commands.md)
- [ADR-0006: Workflow State Machine](./ADR-0006-workflow-state-machine.md)
