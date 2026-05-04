# EstaCoda v0.8 Release Notes

## Summary

v0.8 introduces durable, operator-controllable multi-step execution through TaskFlow. Agent work can now span multiple steps, survive process restarts, and be observed and steered by the operator at any point.

## What's New

### Durable TaskFlow

- **Flows and steps:** A flow represents a high-level objective. Steps are discrete actions with explicit lifecycle states.
- **SQLite persistence:** All flow, step, event, and checkpoint state lives in the same SQLite database as sessions.
- **Strict state machine:** Illegal transitions throw `IllegalTransitionError`. Flow states: `pending`, `running`, `paused`, `waiting`, `interrupted`, `completed`, `failed`, `cancelled`. Step states: `pending`, `running`, `completed`, `waiting_for_approval`, `paused`, `failed`, `skipped`, `cancelled`.
- **Restart recovery:** On runtime startup, running flows and steps are marked `interrupted`, and stale locks are released. Results are visible in status and trace.

### Operator Control Plane

- **In-session slash commands:** `/flow status`, `/flow pause`, `/flow resume`, `/flow interrupt`, `/flow cancel`, `/flow steer`, `/flow approve`, `/flow reject`, `/flow retry`, `/flow skip`, `/flow checkpoint`, `/flow trace`, `/flow compact`, `/flow set`, `/flow unset`.
- **Top-level CLI commands:** `estacoda flow list|show|status|trace|pause|resume|interrupt|cancel|steer|approve|reject|retry|skip|checkpoint|compact`.
- **Process ownership:** On interrupt/cancel, active processes are terminated and results recorded.
- **Approval gates:** Integrated with the security layer; gates are created, resolved, and auditable.

### /steer Semantics

- Operator guidance is recorded as an `OperatorEvent`.
- On the next adapter turn, guidance is explicitly prefixed to the user text in a structured `OPERATOR GUIDANCE` block.
- Events are marked `consumedAt` with real `trajectoryId` and `stepId` linkage.
- Consumption is visible in `/flow trace`.

### Flow-Safe Compaction

- Manual compaction via `/flow compact` or `estacoda flow compact`.
- Automatic compaction is available but **disabled by default**.
- Only runs at safe boundaries: no active processes, no active steps, no pending approvals.
- Original events are preserved; compaction creates additive `CompactSummary` records.

### Runtime/Session Integration

- `createRuntime` wires TaskFlow subsystems automatically when `sessionDb` is `SQLiteSessionDB`.
- `TaskFlowAgentLoopAdapter` bridges TaskFlow and AgentLoop without making AgentLoop TaskFlow-aware.
- Run and artifact linkage uses real `trajectoryId` from AgentLoop.
- `activeFlowId` set/unset controls whether the adapter wraps turns.

### Schema Migrations

- `SQLiteSessionDB` now tracks schema versions.
- v0.8 introduces migrations v1–v3 for TaskFlow tables and operator event consumption columns.
- Migrations are idempotent and include pre-migration backups.

## Validation

- **Type check:** `bun run typecheck` — clean
- **Smoke tests:** `bun run smoke` — 3/3 passed
- **Eval fixtures:** `bun run scripts/run-eval.ts` — 27/27 passed

## Known Limitations

- TaskFlow requires SQLite session persistence; in-memory sessions do not support flows.
- Checkpoints are recorded but not restorable in v0.8.
- Flows are scoped to a single session; no cross-session resumption.
- Lock service is single-process SQLite only.
- Auto-compaction is disabled by default.
- No automatic retry without operator `/retry`.
- No visual workflow builder or marketplace.
- No channels beyond Telegram.
- No background automation without explicit cron scheduling.

## Files Changed in v0.8

TaskFlow implementation spans 15+ files:

- `src/taskflow/*` — engine, store, locking, process registry, compaction, adapter, dispatcher, restart recovery, types
- `src/runtime/create-runtime.ts` — TaskFlow wiring
- `src/runtime/agent-loop.ts` — trajectoryId exposure
- `src/session/sqlite-session-db.ts` — schema migrations v1–v3
- `src/cli/session-loop.ts` — `/flow` slash commands
- `src/cli/flow-commands.ts` — `estacoda flow` CLI
- `src/cli/cli.ts` — CLI integration
- `src/cli/slash-menu.ts` — menu registration
- `src/eval/fixtures/*` — 9 new TaskFlow eval fixtures
- `docs/adr/ADR-0006-taskflow-state-machine.md`
- `docs/architecture/taskflow.md`
- `docs/operations/operator-controls.md`
- `docs/operations/taskflow-cli.md`
- `README.md` and `ROADMAP.md` updates
