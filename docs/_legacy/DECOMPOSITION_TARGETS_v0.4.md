---
title: "Decomposition Targets"
description: "v0.4 agent-loop decomposition plan and acceptance criteria."
---

# Decomposition Targets (v0.4)

## Goal

Turn the 2,714-line `AgentLoop` monolith into inspectable, testable, independently replaceable components.

## Why This Comes First

Everything else depends on it. Without decomposition:

- v0.5 cannot build a clean trajectory recorder — recording logic is embedded in the loop
- v0.7 cannot add skill evolution hooks cleanly — hooks would be ad-hoc
- v0.8 cannot add TaskFlow — no state machine boundary exists

## Target Architecture

```text
┌──────────────────────────────────────────────────────────────────────┐
│                  AgentLoop (orchestrator)                           │
├──────────────────────────────────────────────────────────────────────┤
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  │
│  │   Router    │  │   Planner   │  │  Executor  │  │  Recorder │  │  Native   │  │  Skill    │  │
│  │  (Router)   │  │  (Runner)   │  │  (Runner)   │  │  (Rec)    │  │  (Exec)   │  │  (Exec)   │  │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘  └──────────┘  └──────────┘  │
│                                                                    │
└──────────────────────────────────────────────────────────────────────┘
```

### Router

**Status:** ✅ Extracted as `RuntimeRouter` (`src/runtime/runtime-router.ts`)

Combines `IntentRouter` output with skill configuration to produce a unified routing decision.

### Planner

**Status:** ✅ Extracted as `ToolPlanRunner` (`src/runtime/tool-plan-runner.ts`)

Converts provider tool calls into `ToolCallPlan` objects, manages safe-tool concurrency, handles failure caps.

### Executor

**Status:** ✅ Partially extracted. `ToolPlanRunner` handles tool execution orchestration. `NativeToolExecutor` handles deterministic native intents. `SkillWorkflowExecutor` handles skill workflow execution.

The full "RuntimeExecutor" concept (provider → plan → execute → continue cycle with iteration budget and cancellation) is split between `ProviderTurnLoop` and `ToolPlanRunner`. A unified executor may emerge in v0.8 (TaskFlow).

### Recorder

**Status:** ✅ Extracted as `RunRecorder` (`src/runtime/run-recorder.ts`)

Has explicit phase hooks and writes to session DB. Persistent store (SQLite) deferred to v0.5.

## Acceptance Criteria

- [x] Agent loop components can be tested independently.
- [x] Tool planning has an explicit representation that can be inspected.
- [x] Tool dependencies can be represented even if not fully optimized.
- [x] Native intent handling is no longer buried in the provider turn loop.
- [x] Cancellation and resume have a substrate, even if limited.
- [x] Artifact recording is cleaner and less coupled to the main loop.
- [ ] `createRuntime` uses a builder pattern or DI container instead of manual construction. **Deferred. See `docs/planning/v0.4-builder-assessment.md`.**

## Non-Goals

- Do not build full TaskFlow yet.
- Do not overbuild enforced skill workflows.
- Do not redesign memory yet.
