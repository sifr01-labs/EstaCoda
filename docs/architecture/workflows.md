---
title: "Task persistence and results"
description: "Profile-owned durable Task metadata, result content, and the Workflow persistence cutover."
---

# Task persistence and durable results

EstaCoda's durable execution records use the Task domain model:

```text
Task
└── PlanRevision
    └── Step
        └── Attempt
            ├── Lease
            └── Result
```

This document describes the persistence and result foundation currently present in the codebase. The Task scheduler, executor integration, and Task operator commands are not wired in this build. The retired Workflow commands fail explicitly instead of falling back to an in-memory or partially initialized implementation.

## Source of truth

- `src/contracts/task.ts` defines the durable records, legal state transitions, authority and budget policies, and deterministic graph validation.
- `src/workflow/task-schema.ts` owns SQLite schema version 10.
- `src/workflow/task-store.ts` defines the profile-bound storage contract.
- `src/workflow/sqlite-task-store.ts` implements transactional SQLite persistence.
- `src/workflow/task-result-service.ts` stores bounded result bodies under the selected profile and verifies them before reads.
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
- Event metadata and Result sizes are bounded before persistence.
- A Step's available Results cannot exceed its declared aggregate result budget.
- SQLite check constraints reject unknown states, invalid JSON, negative sizes, invalid attempt numbers, and self-dependencies.

## Durable result plane

SQLite stores Result identity, ownership, opaque handle, byte length, MIME type, and SHA-256 digest. Raw result bodies are never stored in SQLite events or ordinary diagnostics. Content is written under `~/.estacoda/profiles/<id>/tasks/results/` with private directory and file permissions; filenames are hashes of opaque handles and never appear in tool output.

Result creation writes the content first, then records metadata and the bounded `result-recorded` event in one SQLite transaction. A failed metadata transaction removes the newly written body. Reads verify the stored byte length and digest, reject symlinks and non-regular files, and fail closed when content is missing or modified.

`task.result.read` requires both the Task and Result IDs. The active session must have a profile-owned `TaskSessionLink` to that Task. Access survives transcript-preserving compaction only when every lineage hop has the same profile, a matching `parentSessionId` and `compactedFromSessionId`, and a parent ended for compression; ordinary parent/child session relationships grant nothing. Missing, cross-profile, and unauthorized records share the same error. Text and JSON are returned in bounded Unicode-character pages; binary artifacts remain durable but are not transported through a text tool. Pruned and expired Results are unavailable.

## Migration behavior

Opening a writable `SQLiteSessionDB` migrates it to schema version 10 under the existing migration lock and transaction. The migration preserves unrelated session, message, trajectory, approval, cron, finalization, and memory-curation data. A best-effort pre-migration backup is created by the session database migration runner.

The migration is intentionally destructive only for the retired Workflow tables. There is no dual-read, dual-write, compatibility alias, or hidden legacy store.

## Current boundary

The persistence and result layers do not execute Tasks and do not grant authority. Future execution code must still recheck workspace trust, hardline command policy, approvals, profile ownership, budget, and lease fencing at the point of action. Persisted authority can only narrow runtime policy; it cannot approve an operation by itself.
