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
            ├── Approval link
            ├── Provider-call usage entries
            └── Result
```

This document describes the persistence, result, scheduler, agent-execution, and background-host foundation currently present in the codebase. The profile gateway supervisor now runs a durable Task tick beside cron and channel work, recovers abandoned Attempts after restart, and delivers terminal results through a fail-closed completion outbox. The internal fixed-graph service can atomically create idempotent Tasks and persist authorized steering, but no ordinary user path invokes it yet: operator commands and user-facing delegation semantics remain outside this build. The retired Workflow commands fail explicitly instead of falling back to an in-memory or partially initialized implementation.

## Source of truth

- `src/contracts/task.ts` defines the durable records, legal state transitions, authority and budget policies, and deterministic graph validation.
- `src/workflow/task-schema.ts` owns SQLite schema version 15.
- `src/workflow/task-store.ts` defines the profile-bound storage contract.
- `src/workflow/sqlite-task-store.ts` implements transactional SQLite persistence.
- `src/workflow/task-result-service.ts` stores bounded result bodies under the selected profile and verifies them before reads.
- `src/workflow/fixed-task-service.ts` creates immutable initial graphs idempotently and records authorized Task steering.
- `src/workflow/task-step-executor.ts` defines the narrow Attempt execution and settlement contract.
- `src/workflow/agent-step-executor.ts` runs one agent Attempt in an isolated child session under narrowed authority.
- `src/workflow/task-agent-usage.ts` accounts for every provider attempt, fallback, retry, token total, and known route price.
- `src/workflow/task-approval-service.ts` narrows runtime policy with Task authority and bridges asks to the durable gateway approval queue.
- `src/workflow/task-scheduler.ts` owns deterministic readiness, dispatch, fencing, retry, cancellation, acceptance, and restart reconciliation.
- `src/workflow/task-background-host.ts` prevents overlapping scheduler/delivery ticks and performs one-time startup recovery.
- `src/workflow/supervisor-task-background-host.ts` lazily creates the workspace-eligible agent runtime when runnable work exists.
- `src/workflow/task-completion-delivery.ts` owns authorized, terminal-only completion delivery.
- `src/workflow/task-workspace.ts` derives the canonical workspace identity shared by Task creation and hosts.
- `src/workflow/task-artifact-content.ts` constrains artifact capture to reviewed workspace/profile roots.
- `src/tools/task-result-tools.ts` exposes authorized, paged `task.result.read` access.
- `src/session/sqlite-session-db.ts` runs the migration and enables SQLite foreign-key enforcement.

There is one durable persistence model. Schema version 10 removes the former `workflow_*` tables; it does not translate those records because the required Task authority, immutable plan revision, Attempt, workspace binding, and profile ownership cannot be derived safely.

## Profile isolation

Every durable record carries `profile_id`. A `SQLiteTaskStore` cannot be constructed without a profile, every query includes that profile, and composite foreign keys repeat the ownership boundary in SQLite. Sessions, trajectories, parent Tasks, parent Attempts, Steps, Results, Events, and links cannot be attached across profiles.

Opaque Task and session identifiers are routing keys, not authorization boundaries.

## Transaction and graph invariants

- A Task, its first PlanRevision, Steps, dependencies, and creator-session link can be inserted in one `begin immediate` transaction.
- Creation events are journaled in that same transaction, with deterministic ordering and no raw objective or result content.
- Failed graph writes roll back completely.
- Plan definitions are immutable after insertion. Replanning creates a new PlanRevision.
- Task creation keys and Attempt dispatch keys have separate profile-scoped uniqueness constraints.
- Only one PlanRevision can be active for a Task.
- Attempt leases are stored separately. Acquisition is one conditional SQLite mutation, and a persisted generation issues a strictly increasing fencing token whenever the same Attempt resumes.
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

An approval ask is a normal non-terminal settlement. The scheduler records a profile- and Attempt-owned approval link, moves the Attempt, Step, and Task to `waiting_for_approval`, and releases the lease. The gateway queue authorizes resolution through the Task creator session. Approval returns the same Attempt to `queued`; the next acquisition receives a higher fencing token. Denial or expiry fails the waiting work without executing the gated tool. Waiting Attempts intentionally hold no lease and consume no concurrency slot.

## Agent Step executor

`AgentStepExecutor` adapts the existing child-agent factory and runner to the durable Attempt contract; it does not create a parallel delegation lifecycle. Before constructing a child, it verifies the Task, Step, Attempt, profile, exact workspace binding, creator session, and current workspace trust. The scheduler resolver receives both Task and Step so a future host can expose the executor only for workspace-eligible work without embedding delegation or runtime policy in the scheduler.

Task and Step authority are intersected with the parent session's visible tools. Blocked tools, forbidden risk classes, non-shared toolsets, and `delegate_task` are removed. Authorized write and side-effect tools remain available, but Task authority can only narrow the active runtime security policy: a runtime denial remains a denial, `forbid` denies, and `require_approval` creates a durable ask. An approval is bound to the creator session, Attempt, tool, risk class, and SHA-256 target fingerprint; it cannot become a general grant or override the hardline floor.

The child session is marked `task-step-worker` and carries Task, PlanRevision, Step, and Attempt ownership metadata. Its session is checkpointed under the current fencing token before provider work begins. Once the child trajectory is durably present, that trajectory is checkpointed under the same fence. These checkpoints renew the lease, create the worker `TaskSessionLink`, append a bounded `attempt-progressed` event, and cannot be replaced by a later checkpoint or settlement.

The child runner sends progress through the normal runtime event sink while its heartbeat renews the Attempt lease. It suppresses legacy `delegation-heartbeat` persistence for Task execution because the Task journal is the sole lifecycle authority. Durable cancellation aborts the child; timeouts and provider, approval, security, tool, JSON, and artifact-capture failures return bounded classifications to the scheduler.

Successful text and JSON results are captured in full. Artifact bodies are accepted only through an injected, bounded resolver and must match the artifact's declared byte count before the scheduler writes them to the result plane. Dependency context contains bounded result metadata and opaque handles, never raw bodies or filesystem paths; the child reads authorized content through `task.result.read`. Authorized steering is stored outside the conversation transcript and injected as bounded context at safe Attempt boundaries, so transcript compaction or terminal closure cannot discard it. Guidance is user context, not policy: it cannot override Task authority, repository instructions, or runtime security.

Usage is a canonical append-only ledger keyed by the worker session, provider turn, and provider-attempt index. It includes initial completions, continuation turns, fallbacks, and provider retries, while distinguishing preflight route failures from calls that actually reached an adapter. Settlement totals are re-derived from persisted entries, so scheduler replay and approval resume cannot overwrite or double-count earlier usage. Full-precision cost stays in storage; missing token or price data remains explicit incompleteness.

## Background host and restart recovery

The selected profile's gateway supervisor owns the Task host. It runs even when no channel adapter is configured, so service mode is now a general background host for Tasks and cron rather than a cron-only process. Each supervisor tick starts at most one Task pass; overlapping ticks are skipped. Shutdown drain waits for active Task work as well as channel turns, and the shared session database remains open until active Task/finalization work settles.

The host is cheap while idle. It constructs the full agent runtime only when a queued, running, or `waiting_for_host` Task exists. `createRuntime()` exposes an `AgentStepExecutor` only when backed by the profile SQLite database. The executor is bound to the host's canonical workspace identity and rechecks workspace trust immediately before each Attempt. A Task for another workspace remains `waiting_for_host`; the host never rewrites its workspace binding or widens its authority.

Startup reconciliation stays scheduler-owned. Expired or abandoned Attempt leases are reconciled from durable state, while current foreign leases are preserved. The scheduler is the only component that may settle an Attempt, Step, or Task, so a process disconnect or restart cannot manufacture success from an incomplete child run.

Gateway state records the Task and cron hosts as `starting` or `running`. `estacoda gateway status` shows those services, and normal runtime `/status` output includes profile-scoped durable Task counts without exposing objectives or result bodies.

## Authorized completion delivery

Completion delivery is a profile-owned SQLite outbox linked to both a Task and a session already authorized through `TaskSessionLink`. A binding records one explicit channel destination and a profile/Task-scoped delivery key. It can be claimed only after the Task reaches `completed`, `partial`, `failed`, or `cancelled`.

Delivery renders bounded Task status and durable Results. Text/JSON bodies are read through `TaskResultService` using the authorized session; artifacts are represented by opaque handles and summaries, never local paths. Transport errors are reduced to bounded static failure metadata so provider, adapter, or user content is not copied into the outbox.

External delivery is deliberately at-most-once after ambiguity. A crash or transport exception may occur after an adapter accepts a message but before the process records success. Those bindings are marked `delivery-outcome-unknown` and cannot be retried through the delivery service. Confirmed transport rejection and pre-send rendering failure remain failed until an explicit retry call resets the binding; nothing retries automatically. This preserves a reviewable retry path without turning uncertain delivery into duplicate external messages.

## Migration behavior

Opening a writable `SQLiteSessionDB` migrates it to schema version 15 under the existing migration lock and transaction. Version 10 performs the Task persistence cutover; version 11 adds the durable Attempt cancellation marker without replacing existing leases; version 12 extends the Task event journal with fenced Attempt progress checkpoints; version 13 adds the profile-owned completion-delivery outbox; version 14 adds monotonic lease generations, durable Task approval links, and canonical provider-call usage entries; version 15 adds profile-owned steering context and its bounded audit event. The migrations preserve unrelated session, message, trajectory, approval, cron, finalization, and memory-curation data. A best-effort pre-migration backup is created by the session database migration runner.

The migration is intentionally destructive only for the retired Workflow tables. There is no dual-read, dual-write, compatibility alias, or hidden legacy store.

## Current boundary

The execution host and internal fixed-graph creation path are live, but the product creation surface is not. Durable Tasks can be created idempotently by trusted runtime code, steered by a linked creator or observer session, recovered, dispatched by an eligible workspace host, and delivered through a creator- or observer-authorized binding. Worker sessions cannot authorize steering or delivery. No CLI command, channel command, or model-visible tool creates a Task or delivery binding in this build. Operator controls and the replacement `delegate_task` experience must land before ordinary users can start durable execution.
