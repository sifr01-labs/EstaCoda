---
title: "Durable Task foundation"
description: "Profile-owned Task persistence, results, scheduling, and isolated agent execution."
---

# Durable Task foundation

EstaCoda's durable execution records use the Task domain model:

```text
Task
└── PlanRevision
    └── Step
        └── Attempt
            ├── Lease
            └── Result
```

This document describes the persistence, result, scheduler, and agent-execution foundation currently present in the codebase. `WorkflowScheduler` and `AgentStepExecutor` are production implementations exercised together in integration tests, but they are not constructed by `createRuntime`, and no ordinary user path can start them. Task operator commands, delivery, and supervisor wiring remain outside this build. The retired Workflow commands fail explicitly instead of falling back to an in-memory or partially initialized implementation.

## Source of truth

- `src/contracts/task.ts` defines the durable records, legal state transitions, authority and budget policies, and deterministic graph validation.
- `src/workflow/task-schema.ts` owns SQLite schema version 12.
- `src/workflow/task-store.ts` defines the profile-bound storage contract.
- `src/workflow/sqlite-task-store.ts` implements transactional SQLite persistence.
- `src/workflow/task-result-service.ts` stores bounded result bodies under the selected profile and verifies them before reads.
- `src/workflow/task-step-executor.ts` defines the narrow Attempt execution and settlement contract.
- `src/workflow/agent-step-executor.ts` runs one agent Attempt in an isolated child session under narrowed authority.
- `src/workflow/task-agent-usage.ts` accounts for every provider attempt, fallback, retry, token total, and known route price.
- `src/workflow/task-scheduler.ts` owns deterministic readiness, dispatch, fencing, retry, cancellation, acceptance, and restart reconciliation.
- `src/tools/task-result-tools.ts` exposes authorized, paged `task.result.read` access.
- `src/session/sqlite-session-db.ts` runs the migration and enables SQLite foreign-key enforcement.

There is one durable persistence model. Schema version 10 removes the former `workflow_*` tables; it does not translate those records because the required Task authority, immutable plan revision, Attempt, workspace binding, and profile ownership cannot be derived safely.

## Profile isolation

Every durable record carries `profile_id`. A `SQLiteTaskStore` cannot be constructed without a profile, every query includes that profile, and composite foreign keys repeat the ownership boundary in SQLite. Sessions, trajectories, parent Tasks, parent Attempts, Steps, Results, Events, and links cannot be attached across profiles.

Opaque Task and session identifiers are routing keys, not authorization boundaries.

## Transaction and graph invariants

- A Task, its first PlanRevision, Steps, dependencies, and creator-session link can be inserted in one `begin immediate` transaction.
- Failed graph writes roll back completely.
- Plan definitions are immutable after insertion. Replanning creates a new PlanRevision.
- Task creation keys and Attempt dispatch keys have separate profile-scoped uniqueness constraints.
- Only one PlanRevision can be active for a Task.
- Attempt leases are stored separately and require a positive, monotonically managed fencing token.
- Scheduler graph mutations are serialized by short `begin immediate` transactions; there is no second legacy run-lock subsystem to reconcile.
- Event metadata and Result sizes are bounded before persistence.
- A Step's available Results cannot exceed its declared aggregate result budget.
- SQLite check constraints reject unknown states, invalid JSON, negative sizes, invalid attempt numbers, and self-dependencies.

## Durable result plane

SQLite stores Result identity, ownership, opaque handle, byte length, MIME type, and SHA-256 digest. Raw result bodies are never stored in SQLite events or ordinary diagnostics. Content is written under `~/.estacoda/profiles/<id>/tasks/results/` with private directory and file permissions; filenames are hashes of opaque handles and never appear in tool output.

Result creation writes the content first, then records metadata and the bounded `result-recorded` event in one SQLite transaction. A failed metadata transaction removes the newly written body. Reads verify the stored byte length and digest, reject symlinks and non-regular files, and fail closed when content is missing or modified.

`task.result.read` requires both the Task and Result IDs. The active session must have a profile-owned `TaskSessionLink` to that Task. Access survives transcript-preserving compaction only when every lineage hop has the same profile, a matching `parentSessionId` and `compactedFromSessionId`, and a parent ended for compression; ordinary parent/child session relationships grant nothing. Missing, cross-profile, and unauthorized records share the same error. Text and JSON are returned in bounded Unicode-character pages; binary artifacts remain durable but are not transported through a text tool. Pruned and expired Results are unavailable.

## Scheduler core

`WorkflowScheduler.runOnce()` performs one bounded reconciliation and dispatch pass. It derives ready Steps from completed dependencies, creates deterministic dispatch keys, acquires fenced Attempt leases, starts available executors within profile, Task, executor, and provider concurrency limits, and accepts settlement only while the same unexpired lease is current. Every agent Attempt reserves at least one provider call for budget enforcement even if an executor reports incomplete usage.

Executors return settlements; they cannot declare a Step or Task complete. The scheduler validates required result kind and presence, writes result bodies through the fenced durable result plane, validates aggregate Task and Step usage and wall-clock budgets, and then settles the Attempt and logical Step. Retry classification is deterministic: failure-class policy, attempt limits, backoff, idempotency, and uncertain side effects are evaluated before a Step can return to `ready`.

Cancellation is durable on the Attempt lease and visible to its owner on heartbeat. Local work also receives an `AbortSignal`. A stale owner cannot write results or settle after expiry, cancellation, or fencing loss. Restart reconciliation preserves unexpired foreign leases, expires or interrupts abandoned Attempts, and retries only when policy permits. Terminal Task state is reconstructed from durable Step state; the scheduler can produce `completed`, `partial`, `failed`, and `cancelled` outcomes without provider inference.

## Agent Step executor

`AgentStepExecutor` adapts the existing child-agent factory and runner to the durable Attempt contract; it does not create a parallel delegation lifecycle. Before constructing a child, it verifies the Task, Step, Attempt, profile, exact workspace binding, creator session, and current workspace trust. The scheduler resolver receives both Task and Step so a future host can expose the executor only for workspace-eligible work without embedding delegation or runtime policy in the scheduler.

Task and Step authority are intersected with the parent session's visible tools. This phase admits only `read-only-local` and `read-only-network` tools whose risk disposition remains `runtime_policy`; blocked tools, non-shared toolsets, write/side-effect risk classes, and `delegate_task` are removed. The child factory's existing non-interactive fail-closed security policy still performs the live decision. Persisted Task authority never becomes an approval.

The child session is marked `task-step-worker` and carries Task, PlanRevision, Step, and Attempt ownership metadata. Its session is checkpointed under the current fencing token before provider work begins. Once the child trajectory is durably present, that trajectory is checkpointed under the same fence. These checkpoints renew the lease, create the worker `TaskSessionLink`, append a bounded `attempt-progressed` event, and cannot be replaced by a later checkpoint or settlement.

The child runner sends progress through the normal runtime event sink while its heartbeat renews the Attempt lease. It suppresses legacy `delegation-heartbeat` persistence for Task execution because the Task journal is the sole lifecycle authority. Durable cancellation aborts the child; timeouts and provider, approval, security, tool, JSON, and artifact-capture failures return bounded classifications to the scheduler.

Successful text and JSON results are captured in full. Artifact bodies are accepted only through an injected, bounded resolver and must match the artifact's declared byte count before the scheduler writes them to the result plane. Dependency context contains bounded result metadata and opaque handles, never raw bodies or filesystem paths; the child reads authorized content through `task.result.read`. Usage includes every provider attempt across retries and fallbacks. Missing token or price data is preserved as explicit incompleteness rather than silently reported as zero-cost complete usage.

## Migration behavior

Opening a writable `SQLiteSessionDB` migrates it to schema version 12 under the existing migration lock and transaction. Version 10 performs the Task persistence cutover; version 11 adds the durable Attempt cancellation marker without replacing existing leases; version 12 extends the Task event journal with fenced Attempt progress checkpoints while preserving existing Task events. The migrations preserve unrelated session, message, trajectory, approval, cron, finalization, and memory-curation data. A best-effort pre-migration backup is created by the session database migration runner.

The migration is intentionally destructive only for the retired Workflow tables. There is no dual-read, dual-write, compatibility alias, or hidden legacy store.

## Current boundary

The scheduler and production agent executor are deliberately dormant at the application boundary. `createRuntime()` does not construct a scheduler host, so no CLI, gateway, cron, or background path dispatches durable Tasks yet. Commit-level integration tests prove the execution boundary without creating a partially live product surface. Supervisor ownership, restart activation, operator commands, delivery, and user-facing status remain required before Task execution is enabled for ordinary users.
