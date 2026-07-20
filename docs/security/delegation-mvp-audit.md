# Durable Delegation Security Audit

Status: test-backed checklist for the durable `delegate_task` cutover.

`delegate_task` no longer starts synchronous child sessions. It creates a fixed durable Task graph and returns the Task handle immediately. The Task scheduler and fenced Attempts own execution, cancellation, retry, recovery, usage, results, approvals, and settlement. `SubagentRegistry` is only ephemeral visibility for an Attempt that is currently running.

## Checklist

| Item | Required behavior | Coverage |
|------|-------------------|----------|
| Durable-only availability | `delegate_task` is omitted when profile-bound SQLite Task persistence is unavailable; there is no in-memory execution fallback. | `src/tools/delegation-tools.test.ts`, `src/runtime/create-runtime.test.ts` |
| Provider-call idempotency | A stable provider tool-call ID derives the Task creation key. Exact replay returns the existing handle; conflicting replay fails closed. | `src/delegation/durable-delegation-service.test.ts`, `src/tools/delegation-tools.test.ts` |
| Immediate return | The tool persists a queued Task and returns its handle without waiting for a worker or result. | `src/delegation/durable-delegation-service.test.ts`, `src/tools/delegation-tools.test.ts`, `src/smoke/cases/delegation-mvp.ts` |
| Batch bounds | A batch becomes one Task with one independent Step per item; persisted Task concurrency is capped by `maxConcurrentChildren` and graph limits. | `src/delegation/durable-delegation-service.test.ts`, `src/smoke/cases/delegation-mvp.ts` |
| Root/child ownership | Root Tasks retain creator-session ownership. Nested calls persist `parentTaskId`, `parentAttemptId`, and an agent actor bound to the active Attempt. | `src/delegation/durable-delegation-service.test.ts`, `src/workflow/sqlite-task-store.test.ts` |
| Child authority monotonicity | A child Task is permitted only from an orchestrator Step with remaining child depth; toolsets, exact tools, blocked tools, risk dispositions, and depth can only narrow. | `src/delegation/durable-delegation-service.test.ts`, `src/delegation/toolset-security.test.ts`, `src/contracts/task.test.ts` |
| Child budget monotonicity | A linked child Task budget cannot exceed the active parent Step budget; batch Step budgets divide the parent ceiling. | `src/delegation/durable-delegation-service.test.ts` |
| Workspace boundary | Root delegation requires live trust. Child Tasks retain the exact parent workspace binding, and execution rechecks trust. | `src/delegation/durable-delegation-service.test.ts`, `src/workflow/agent-step-executor.test.ts` |
| Tool/schema bounds | Parent visibility, default risk classes, exact/prefix blocks, excluded toolsets, and explicit tool/toolset requests narrow the persisted Step authority before provider schemas are built. | `src/delegation/toolset-security.test.ts`, `src/delegation/delegation-mvp-security-audit.test.ts`, `src/smoke/cases/delegation-mvp.ts` |
| Hardline and approvals | Normal runtime security and hardline checks remain non-overridable. Task approval waits are durable and scoped to Task/Step/Attempt ownership. | `src/workflow/task-approval-service.test.ts`, `src/workflow/agent-step-executor.test.ts` |
| Durable cancellation/recovery | Cancellation signals, leases, fencing tokens, restart reconciliation, retry eligibility, and settlement are owned by the Task scheduler. | `src/workflow/task-scheduler.test.ts`, `src/workflow/task-vertical-slice.test.ts` |
| Durable result/usage storage | Full result bodies and structured provider usage are persisted against the Task Attempt, with profile and size boundaries. | `src/workflow/task-result-service.test.ts`, `src/workflow/agent-step-executor.test.ts` |
| Worker ownership | Worker sessions carry Task/Step/Attempt metadata and durable session links. In-memory subagent state is not an authorization or ownership boundary. | `src/runtime/agent-loop-factory.test.ts`, `src/workflow/agent-step-executor.test.ts` |
| Model overrides | Same-provider and reviewed cross-provider overrides preserve route configuration, resolve profile credentials, reject disabled routes, and disable child fallback routes. | `src/runtime/agent-loop-factory.test.ts`, `src/tools/delegation-tools.test.ts` |

## Removal assertion

The synchronous `DelegationManager`, `BatchRunner`, and parent-result `file-state-guard` execution architecture has been deleted. The remaining `ChildRunner` is an Attempt execution helper used only after the durable scheduler leases an agent Step; it does not create, schedule, own, or settle Tasks.

This cutover intentionally does not preserve compatibility with the old synchronous result shape. Callers receive a durable Task handle and observe status, results, approvals, cancellation, and completion through Task surfaces.
