---
title: "Trajectory & Observability"
description: "Trajectory recording, persistence, trace inspection, failure classification, and event schema."
---

# Trajectory & Observability

## Current State

Trajectory recording is **persisted to SQLite**, inspectable from the CLI, and paired with a failure classifier.

## Files

| File | Lines | Role |
|------|-------|------|
| `src/contracts/trajectory.ts` | 60 | Event kinds and type definitions |
| `src/contracts/trajectory-store.ts` | ~20 | `TrajectoryStore` contract |
| `src/contracts/failure.ts` | ~40 | `FailureClass` (13 types) and `FailureRecord` |
| `src/contracts/evolution.ts` | ~37 | `EvolutionChangeManifest` type |
| `src/trajectory/trajectory-recorder.ts` | ~120 | In-memory event recorder (session scope) |
| `src/trajectory/failure-classifier.ts` | 325 | Heuristic failure classification |
| `src/session/sqlite-session-db.ts` | ~700 | SQLite persistence for trajectories + failures |
| `src/cli/trace-commands.ts` | ~275 | `estacoda trace` CLI surface |
| `src/utils/redaction.ts` | 96 | Safe redaction engine for trace export |

## Event Kinds

The contract defines 32 event kinds:

| Category | Events |
|----------|--------|
| Session | `session-start`, `session-end` |
| Input | `user-input`, `context-expanded` |
| Skills | `skill-selected`, `skill-workflow-planned`, `skill-workflow-step`, `skill-route-usage`, `skill-route-telemetry`, `skill-lifecycle-changed` |
| Tools | `tool-plan`, `tool-call`, `tool-gated`, `tool-result` |
| Provider | `provider-completion`, `provider-continuation`, `provider-iteration`, `provider-budget-exhausted` |
| Memory | `memory-write`, `memory-conclusion` |
| Security | `security-risk-escalated` |
| Artifacts | `artifact-created` |
| Delegation | `delegation-started`, `delegation-finished` |
| Prompt | `prompt-assembled`, `session-history-packed` |
| Progress | `progress`, `fallback`, `assistant-output`, `user-correction` |
| Cancel | `agent-cancelled` |

### User Corrections

`user-correction` is a structured trajectory event kind introduced in v0.7. When the user provides corrective feedback (e.g., "no, do it this way"), the runtime records:

- `correctionText`: what the user said
- `skillName`: the skill that produced the incorrect behavior (if identified)
- `reason`: why the correction was triggered
- `sourceTrajectoryId` / `sourceEventId`: provenance linking back to the original event

User corrections flow into the evidence corpus and can be referenced in `ChangeManifest` proposals.

## TrajectoryRecorder

```typescript
class TrajectoryRecorder {
  record(kind: TrajectoryEventKind, data: Record<string, unknown>): TrajectoryEvent;
  complete(outcome: Trajectory["outcome"]): Trajectory;
  snapshot(): Trajectory;
  compress(): CompressedTrajectory;
}
```

**Features:**
- Records events with timestamp and ID
- Completes with success/failure outcome
- Compresses to summary + preserved event IDs
- Snapshot includes failure tracking (post-v0.5)

## Persistence

Trajectories are saved to `~/.estacoda/sessions.sqlite` via `SQLiteSessionDB`:

- Table: `trajectories` — id, session_id, profile_id, model_id, created_at, events_json, outcome_json
- Table: `trajectory_failures` — id, trajectory_id, session_id, class, message, recoverable, context_json
- WAL mode, indexed on session_id and profile_id

## Trace CLI

```bash
estacoda trace list [--session <id>] [--limit <n>]
estacoda trace dump <trajectory-id> [--raw]
estacoda trace timeline <trajectory-id> [--raw]
estacoda trace failures <trajectory-id>
```

- `list` shows recent trajectories with session IDs and outcomes
- `dump` outputs full JSON (redacted by default; `--raw` for unredacted)
- `timeline` outputs a chronological human-readable event list
- `failures` lists classified failures for a trajectory

## Redaction

Default policy (applied unless `--raw`):
- Scrubs 25+ sensitive key patterns (`apiKey`, `password`, `token`, etc.)
- `strict` mode redacts high-entropy strings (>32 chars, high entropy)
- Never mutates input; returns a cloned/redacted copy

## Failure Classification

`FailureClassifier` maps runtime events to 13 coarse classes:

| Class | Source |
|-------|--------|
| `provider-error` | HTTP status mapping, network/auth |
| `provider-refusal` | Provider rejected request |
| `tool-execution-error` | Tool threw exception |
| `tool-not-found` | Tool unavailable |
| `tool-blocked` | Security policy blocked |
| `tool-invalid-args` | Schema validation failed |
| `tool-timeout` | Execution exceeded limit |
| `plan-dependency-error` | Dependency resolution failed |
| `workflow-step-error` | Skill workflow step failed |
| `budget-exhausted` | Token/wall-clock/tool-call budget |
| `security-escalation` | Risk escalation aborted run |
| `user-cancelled` | Agent cancelled by user |
| `loop-exhausted` | Max iterations reached |

Classified failures are stored in `trajectory_failures` and surfaced via `estacoda trace failures`.

## ArtifactStore

**File:** `src/artifacts/artifact-store.ts`
**Size:** 56 lines

Stores artifact records in memory with `artifact://<id>` prompt-safe references.

**Gaps:**
- No persistence
- No linkage to trajectory events
- No artifact lineage

## v0.5 Completion Status

| Target | Status |
|--------|--------|
| Structured trajectory recorder | ✅ Persistent SQLite store |
| Trace schema | ✅ Typed contracts + SQLite schema |
| Tool-call timeline | ✅ `estacoda trace timeline` |
| Decision/event log | ✅ Events captured per trajectory |
| Run metadata | ✅ Trajectory record with model/session IDs |
| Failure classification | ✅ 13 classes + SQLite storage |
| Basic eval runner | ✅ `src/eval/eval-runner.ts` + 3 fixtures |
| Regression fixtures | ✅ `src/eval/fixtures/` (3 deterministic) |
| Run replay | ⚠️ Skeleton only (load trajectory, no re-execution) |
| Evidence corpus | ✅ Trajectories + failures + eval results |
| Change-manifest skeleton | ✅ `EvolutionChangeManifest` + `ChangeManifestStore` |
| Golden flows | ✅ Schema + 2 examples + comparison logic |
