---
title: "Trajectory & Observability"
description: "Trajectory recording, persistence, trace inspection, failure classification, and event schema."
---

# Trajectory & Observability

## Current State

Trajectory recording is **persisted to SQLite**, inspectable from the CLI, and paired with a failure classifier.

## Files

| File | Role |
|------|------|
| `src/contracts/trajectory.ts` | Event kinds and trajectory type definitions |
| `src/contracts/trajectory-store.ts` | `TrajectoryStore` contract |
| `src/contracts/failure.ts` | `FailureClass` and `FailureRecord` contract |
| `src/contracts/evolution.ts` | `EvolutionChangeManifest` type |
| `src/trajectory/trajectory-recorder.ts` | In-memory event recorder for one runtime trajectory |
| `src/trajectory/failure-classifier.ts` | Heuristic failure classification |
| `src/session/sqlite-session-db.ts` | SQLite persistence for trajectories and failures |
| `src/cli/trace-commands.ts` | `estacoda trace` CLI surface |
| `src/utils/redaction.ts` | Function-based redaction helpers for trace export |

## Event Kinds

The event-kind source of truth is the `TrajectoryEventKind` union in `src/contracts/trajectory.ts`. Keep this table aligned with that union when new event families are added.

| Category | Events |
|----------|--------|
| Session | `session-start`, `session-end` |
| Input | `user-input`, `context-expanded` |
| Skills | `skill-selected`, `skill-playbook-planned`, `skill-playbook-step`, `skill-route-usage`, `skill-route-telemetry`, `skill-lifecycle-changed` |
| Tools | `tool-plan`, `tool-call`, `tool-gated`, `tool-result` |
| Provider | `provider-completion`, `provider-continuation`, `provider-iteration`, `provider-budget-exhausted` |
| Memory | `memory-write`, `memory-conclusion`, `memory-promotion`, `memory-promotion-failed`, `memory-file-compaction`, `session-recall-decision`, `external-memory-recall`, `external-memory-mirror-write` |
| Security | `security-risk-escalated` |
| Artifacts | `artifact-created` |
| Delegation | `delegation-started`, `delegation-finished` |
| Prompt and history | `prompt-assembled`, `session-history-packed`, `session-history-compressed`, `session-compression-state` |
| Progress | `progress`, `fallback`, `assistant-output`, `user-correction` |
| Cancel | `agent-cancelled` |

### User Corrections

Delegation events are additive and bounded. `delegation-started` / `delegation-finished` are persisted session events for child lifecycle summaries. `delegation-heartbeat` keeps long-running child work visible to the parent without raw token streams. `delegation-diagnostic` points at bounded timeout/stale-heartbeat diagnostics. Runtime `delegation-progress` relays selected child activity such as tool start/result and provider attempt/result summaries with child metadata.

`user-correction` is a structured trajectory event kind. When the user provides corrective feedback (e.g., "no, do it this way"), the runtime records:

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
- Snapshot includes failure tracking

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

`skill-route-telemetry` records the governed route shape: task class, selected primary skill, supporting candidates, lower-confidence candidates, rejected/deferred candidates, and final route outcome fields. When available, it also includes local semantic shadow telemetry and bounded LLM reranker shadow telemetry. Human-readable trace summaries render these shadow signals as `shadow=...` and `llm-shadow=...`; both are advisory diagnostics, not proof that either route signal controlled the turn.

## Redaction

`estacoda trace dump <id>` redacts by default. `--raw` returns the stored JSON without redaction.

Redaction is implemented by functions in `src/utils/redaction.ts`, not by a stateful redaction engine. The default object path redacts sensitive key names such as API keys, tokens, passwords, credentials, OAuth tokens, cookies, and related variants. String values are also scanned for common secret shapes such as bearer/basic auth headers, JWTs, URL credentials, environment-style secret assignments, password assignments, and common API-key patterns.

`strict` mode exists in the helper API for unknown high-entropy strings, but the trace CLI currently calls `redactObject(trajectory)` with default options.

## Failure Classification

The failure-class source of truth is the `FailureClass` union in `src/contracts/failure.ts`. `FailureClassifier` maps runtime events and errors to these coarse classes:

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
| `skill-playbook-step-error` | Skill playbook step failed |
| `budget-exhausted` | Token/wall-clock/tool-call budget |
| `security-escalation` | Risk escalation aborted run |
| `user-cancelled` | Agent cancelled by user |
| `agent-loop-exhausted` | Max iterations reached |
| `unknown` | Unclassified failure |

Classified failures are stored in `trajectory_failures` and surfaced via `estacoda trace failures`.

## ArtifactStore

**File:** `src/artifacts/artifact-store.ts`

Stores artifact records in memory with `artifact://<id>` prompt-safe references.

**Gaps:**
- No persistence
- No linkage to trajectory events
- No artifact lineage

## Current Completion Status

| Target | Status |
|--------|--------|
| Structured trajectory recorder | ✅ Persistent SQLite store |
| Trace schema | ✅ Typed contracts + SQLite schema |
| Tool-call timeline | ✅ `estacoda trace timeline` |
| Decision/event log | ✅ Events captured per trajectory |
| Run metadata | ✅ Trajectory record with model/session IDs |
| Failure classification | ✅ `FailureClass` contract + SQLite storage |
| Basic eval runner | ✅ `src/eval/eval-runner.ts` |
| Regression fixtures | ✅ `src/eval/fixtures/` deterministic fixtures |
| Run replay | ⚠️ Skeleton only (load trajectory, no re-execution) |
| Evidence corpus | ✅ Trajectories + failures + eval results |
| Change-manifest skeleton | ✅ `EvolutionChangeManifest` + `ChangeManifestStore` |
| Golden flows | ✅ Schema + 2 examples + comparison logic |
