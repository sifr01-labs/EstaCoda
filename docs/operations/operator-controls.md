---
title: "Operator Controls"
description: "Slash commands and CLI commands for controlling TaskFlow execution."
---

# Operator Controls

## In-Session Slash Commands

Available when TaskFlow is wired (requires SQLite session persistence):

- `/flow status [flowId]` — Show flow status, progress, pending approvals, elapsed time, and available actions.
- `/flow pause <flowId> [reason]` — Request pause at next safe boundary.
- `/flow resume <flowId>` — Resume a paused, interrupted, or waiting flow.
- `/flow interrupt <flowId> [reason]` — Interrupt immediately; terminates active processes.
- `/flow cancel <flowId> [reason]` — Cancel flow; terminal state.
- `/flow steer <flowId> <guidance>` — Inject operator guidance for next turn.
- `/flow approve <stepId>` — Approve a pending approval gate.
- `/flow reject <stepId> [reason]` — Reject a pending approval gate.
- `/flow retry <stepId>` — Retry a failed step (if idempotent or safeToRetry).
- `/flow skip <stepId> [reason]` — Skip a pending skippable step.
- `/flow checkpoint <flowId> <name>` — Create a named checkpoint.
- `/flow trace [flowId] [limit]` — Show event timeline.
- `/flow compact <flowId>` — Run manual compaction.
- `/flow set <flowId>` — Set active flow for this session.
- `/flow unset` — Clear active flow.

If `flowId` is omitted for `status` and `trace`, the active flow is used.

## Top-Level CLI Commands

```bash
estacoda flow list                          # List active flows
estacoda flow show <flowId>                 # Show flow details and steps
estacoda flow status <flowId>               # Show formatted status
estacoda flow trace <flowId> [limit]        # Show event trace
estacoda flow pause <flowId> [reason]       # Request pause
estacoda flow resume <flowId>               # Resume flow
estacoda flow interrupt <flowId> [reason]   # Interrupt flow
estacoda flow cancel <flowId> [reason]      # Cancel flow
estacoda flow steer <flowId> <instruction>  # Inject guidance
estacoda flow approve <stepId>              # Approve gate
estacoda flow reject <stepId> [reason]      # Reject gate
estacoda flow retry <stepId>                # Retry step
estacoda flow skip <stepId> [reason]        # Skip step
estacoda flow checkpoint <flowId> <name>    # Create checkpoint
estacoda flow compact <flowId>              # Compact events
```

## /steer Semantics

`/steer` and `/flow steer` record an `OperatorEvent` with `kind: "operator-steered"`. The event is **unconsumed** until the adapter processes the next turn.

On the next adapter turn:
1. All unconsumed steer events are loaded.
2. Guidance is prefixed to the user text in a structured block:
   ```
   --- OPERATOR GUIDANCE (eventIds: <id1>, <id2>) ---
   1. <guidance 1>
   2. <guidance 2>
   --- END OPERATOR GUIDANCE ---
   
   <original user text>
   ```
3. Events are marked `consumedAt`, `consumedByStepId`, `consumedByRunId`.
4. Consumption is visible in `/flow trace`.

Steer is rejected for flows in terminal states.

## /compact and Automatic Compaction

**Manual:** `/flow compact <flowId>` or `estacoda flow compact <flowId>` triggers compaction immediately if at a safe boundary.

**Automatic:** Disabled by default. Enable by passing a custom `CompactionConfig` to `FlowCompactionService`:

```typescript
{
  enabled: true,
  mode: "conservative",
  eventThreshold: 50,
  minTurnsBeforeCompact: 3
}
```

Auto-compaction checks the boundary at the end of each adapter turn. It only runs when:
- no active processes,
- no active steps,
- no pending approvals,
- event count ≥ threshold,
- completed steps ≥ minTurnsBeforeCompact.

Compaction creates a `CompactSummary` and appends `compacted` / `operator-compacted` events. Original events are preserved.

## Process Ownership

On `/interrupt` and `/cancel`, the dispatcher:
1. Lists active processes for the flow.
2. Sends `SIGTERM` with 5s timeout to each.
3. Records `process-exited` or `process-orphaned` events.
4. Then transitions the flow state.

Process cleanup results are visible in `/flow status` and `/flow trace`.

## Approval Gates

Approval gates are created by the security layer when a tool call requires explicit approval. Gates have:
- `status`: `pending` | `approved` | `rejected`
- `riskClass`: `low` | `medium` | `high` | `critical`
- `toolName`, `targetKey`, `targetSummary`
- `controllerGrantId`: links to the runtime approval system
- `toolExecutorDecision`: `approve` | `reject` | `ask`
- `deterministicRule`: which rule triggered the gate

`/flow approve` and `/flow reject` resolve gates and emit `OperatorEvent` records.

## Retry and Skip Safety Rules

**Retry:**
- Only if `idempotent` or `safeToRetry` is true.
- Only if `retryCount < maxRetries`.
- Creates a new step linked via `retryOfStepId`.

**Skip:**
- Only if `failurePolicy.allowSkipIfSkippable` is true.
- Only if the step has not started (`startedAt` is null).
- A step that has started must be interrupted or cancelled.
