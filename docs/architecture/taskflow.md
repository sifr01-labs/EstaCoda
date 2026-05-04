---
title: "TaskFlow"
description: "Durable multi-step execution, state machine, and runtime integration."
---

# TaskFlow Architecture

## Purpose

TaskFlow provides durable, observable, operator-controllable multi-step execution for agent sessions. A flow represents a high-level objective (e.g., "refactor the auth module"). Steps represent discrete actions within that flow. State is persisted to SQLite so work survives process restarts.

## When TaskFlow is active

TaskFlow is wired into `createRuntime` **only** when `sessionDb` is an `SQLiteSessionDB`. In-memory sessions do not support TaskFlow.

## Components

### TaskFlowEngine

The state machine. Enforces legal transitions, manages flow/step lifecycles, and emits events.

Key methods:
- `createFlow(sessionId, intent)` — creates a flow in `pending` state.
- `startFlow(flowId)` — transitions to `running`.
- `requestPause(flowId, reason)` — requests pause at next safe boundary.
- `resumeFlow(flowId)` — transitions `paused`/`interrupted`/`waiting` → `running`.
- `interruptFlow(flowId, reason)` — immediate interrupt with process cleanup.
- `cancelFlow(flowId, reason)` — terminal cancel with process cleanup.
- `skipStep(stepId, reason)` — skip a pending step (only if not started and skippable).
- `retryStep(stepId)` — create a retry step (only if idempotent/safeToRetry and under maxRetries).
- `createCheckpoint(flowId, name)` — record a named checkpoint.

### TaskFlowStore (SQLiteTaskFlowStore)

Persistence layer. All tables use `create table if not exists` and are created via schema migration in `SQLiteSessionDB`.

### FlowLockService

Prevents concurrent flow mutation. Locks have lease expiry; stale locks are recovered on startup.

### FlowProcessRegistry

Tracks external processes (shell commands, browser sessions) linked to steps. On interrupt/cancel, running processes are terminated and results are recorded.

### OperatorCommandDispatcher

Routes slash commands to engine methods. Every dispatch validates preconditions and returns structured `CommandResult`. All operator actions append `OperatorEvent` records.

### FlowCompactionService

Summarizes completed flow events into `CompactSummary` records. Never deletes original events. Only runs when:
- no active processes,
- no active steps,
- no pending approvals.

Default config: `enabled: false`. Must be explicitly enabled.

### TaskFlowAgentLoopAdapter

Bridges TaskFlow and AgentLoop. Responsibilities:
- Load unconsumed steer events before each turn.
- Prefix steer guidance explicitly (auditable, not hidden).
- Execute turn through AgentLoop.handle().
- Mark steer events consumed with real `trajectoryId` linkage.
- Record artifact and run links.
- Check auto-compaction at safe boundary.

## Data Model

### Flow

- `id`, `sessionId`, `status`
- `intent`: the original objective (JSON)
- `currentStepId`: active step
- `createdAt`, `updatedAt`, `completedAt`, `cancelledAt`, `failedAt`
- `pauseRequestedAt`, `pauseReason`
- `checkpointCount`, `stepCount`, `retryCount`
- `compactedAt`

### FlowStep

- `id`, `flowId`, `index`, `status`, `name`, `description`
- `toolPlans`, `executions`
- `retryPolicy`, `retryCount`, `maxRetries`
- `idempotent`, `safeToRetry`
- `failurePolicy` (includes `allowSkipIfSkippable`)
- `retryOfStepId`, `attemptNumber`
- Timestamps: `startedAt`, `completedAt`, `failedAt`, `cancelledAt`, `pausedAt`, `resumedAt`

### FlowEvent

- `id`, `flowId`, `stepId`, `kind`, `data`, `timestamp`

Kinds include: `step-started`, `step-completed`, `step-failed`, `step-skipped`, `step-retried`, `pause-requested`, `process-registered`, `process-exited`, `process-orphaned`, `compacted`.

### OperatorEvent

- `id`, `flowId`, `stepId`, `kind`, `operator`, `command`, `effect`
- `previousState`, `newState`
- `metadata`, `timestamp`
- `consumedAt`, `consumedByStepId`, `consumedByRunId` — set when steer is consumed by adapter

### Checkpoint

- `id`, `flowId`, `stepId`, `name`, `description`, `snapshot` (JSON), `createdAt`, `createdBy`

### ApprovalGate

- `id`, `stepId`, `flowId`, `status`
- `requestedAt`, `resolvedAt`, `resolvedBy`
- `reason`, `riskClass`
- `toolName`, `targetKey`, `targetSummary`, `scope`
- `controllerGrantId`, `toolExecutorDecision`, `deterministicRule`

## Runtime Integration

```
Session Loop
    |
    v
Runtime.handle()  <-- /flow commands set activeFlowId
    |
    v
AgentLoop.handle()
    ^
    |
TaskFlowAgentLoopAdapter.runTurn()  <-- only when activeFlowId is set
    |
    v
TaskFlowEngine + Store
```

When `rt.taskflow.activeFlowId` is set and the flow is running, the adapter wraps turns. When no active flow is set, AgentLoop runs normally.

## Restart Recovery

On `createRuntime` with SQLite:
1. `FlowRestartRecovery.recover()` marks `running` flows as `interrupted`.
2. Marks `running` steps as `interrupted`.
3. Releases stale locks (expired lease).
4. Results are visible via `rt.taskflow.recoverFromRestart()`.

## Known Limitations

- Checkpoints are recorded but not restorable in v0.8.
- Flows are scoped to a single session; no cross-session resumption.
- Lock service is single-process SQLite only.
- Auto-compaction is disabled by default.
- No automatic retry without operator `/retry`.
