Scheduler tests passed: 55/55. Source fences cancellation before result publication, but the named late-success cancellation test does not actually return late success.

## Scope and execution evidence

Assigned scope: `estacoda-task-scheduler-cancellation`. I inspected scheduler source, its cancellation helper, store interfaces, and relevant existing scheduler tests. I did not modify source or tests, install dependencies, browse external sources, or save a report.

### Commands and observed receipts

| Command | Observed result |
|---|---|
| `git status --short` — before inspection/tests | Output: `?? node_modules` |
| `node node_modules/vitest/vitest.mjs run --config vitest.node.config.ts src/tasks/task-scheduler.test.ts` | **Exit code 0**; **1 test file passed; 55 tests passed (55)**; Vitest **4.1.6**; duration **31.13s**, tests **30.02s** |
| `git status --short` — after inspection/tests | Output: `?? node_modules` |

The test process was initially returned as running (`proc_2bnqucwe`, PID 92697); the subsequent process receipt explicitly reported `exited, exit code 0` and `closed with code 0 signal null`.

The status-tool receipts showed stdout but did **not** expose numeric exit statuses; I cannot supply those numerically. Before/after short status was identical. This establishes no newly visible tracked changes or additional untracked paths, **not** byte-for-byte immutability inside the pre-existing untracked `node_modules`.

No command was denied and no prerequisite was reported missing. No tests failed in the executed suite.

## Cancellation state transitions

### 1. Durable cancellation precedes local abort

`TaskScheduler.cancelTask()` calls `cancelTaskInStore()` first, then aborts matching locally running executions, then returns the cancelled task.

References: `src/tasks/task-scheduler.ts:424–437`.

The helper performs these changes inside `store.atomicWrite()`:

- Already-terminal tasks return unchanged.
- In the active plan, steps in `pending`, `ready`, `waiting_for_input`, or `waiting_for_approval` become `cancelled`, with state-change events.
- Queued attempts and **unleased** input/approval-waiting attempts become `cancelled` immediately, with completion timestamps and cancellation events.
- Other active attempts receive `requestAttemptCancellation()`.
- The task becomes `cancelled`, with `cancelledAt` and a task-state event.

References: `src/tasks/task-operator-service.ts:791–806`, `:816–849`.

**Implication inferred from source:** task cancellation can be durable while a leased/running attempt and its running step are still awaiting settlement. The helper deliberately does not immediately terminalize every running step.

### 2. Cancellation is checked at execution and settlement boundaries

Before calling the executor, `#execute()` checks the abort signal. An already-aborted launch becomes `{ outcome: "cancelled" }` without invoking the executor. Executor exceptions caused by cancellation or an aborted signal are likewise translated into a cancelled settlement.

Reference: `src/tasks/task-scheduler.ts:1139–1172`.

`#settle()` checks current durable state before the success-result path. Any terminal task, lease cancellation marker, or explicit cancelled outcome routes to `#settleCancelled()`.

Reference: `src/tasks/task-scheduler.ts:1349–1354`.

`#settleCancelled()` atomically:

1. Validates the current lease, allowing the cancellation marker.
2. Marks the attempt cancelled and completed.
3. Cancels a nonterminal step.
4. Releases the exact fenced lease.
5. Appends cancellation/state events.

Reference: `src/tasks/task-scheduler.ts:1687–1714`.

It does not publish results in this path.

### 3. Cancellation settlement does not override lease ownership or expiry

`#assertCurrentLease()` rejects:

- Missing task, attempt, or lease.
- Different lease owner.
- Different fencing token.
- Lease expiration at or before scheduler time.
- A cancellation marker when cancellation is not allowed.

For ordinary settlement, a terminal task also raises a cancellation error.

Reference: `src/tasks/task-scheduler.ts:1956–1978`.

Thus `allowCancellation: true` does **not** waive owner, token, or expiry validation. If cancellation is detected after a lease-loss error, execution attempts fenced cancellation settlement; if that also loses the lease, the run records `leaseLost` and a warning rather than treating the attempt as successfully settled.

Reference: `src/tasks/task-scheduler.ts:1190–1202`.

**Boundary nuance:** a late return after cancellation and lease expiry is not necessarily counted as `cancelled` in that run; it can be counted as `leaseLost`. Durable task cancellation and attempt-settlement accounting are separate observations.

## Concurrency, race, and fence evidence

### Dispatch admission

`#leaseAndStart()` revalidates durable state inside `atomicWrite()`:

- Task must be `running`.
- Step must be `ready`.
- Attempt must be `queued`.
- Host dispatch grant must still be current for the scheduler owner.
- Durable capacity and execution limits must permit admission.
- Attempt lease acquisition must succeed.

It then moves the leased attempt to `running`, the step to `running`, and records events.

Reference: `src/tasks/task-scheduler.ts:1055–1110`.

Relevant executed existing tests include:

- Host ownership race revalidation: `src/tasks/task-scheduler.test.ts:249`.
- Competing schedulers using the same grant: `:288`.
- Durable concurrency across scheduler owners: `:504`.
- Profile/task concurrency: `:485`.
- Executor/provider concurrency: `:531`.

These passed in the 55-test receipt. Their test declarations were inspected; this worker did not inspect every assertion in those concurrency tests.

### Cancellation versus launch microtask

The inspected test schedules cancellation using `queueMicrotask()` after detecting a queued attempt, then asserts:

- `dispatched: 1`, `completed: 0`, `cancelled: 1`.
- Executor invocation count is zero.
- Task, step, and attempt are cancelled.
- Attempt lease is absent.
- No results exist.

Reference: `src/tasks/task-scheduler.test.ts:862–893`.

**Measured:** this specific admitted-but-not-invoked interleaving passed.

### Heartbeat and abort

`heartbeat()` renews using scheduler owner and fencing token. Rejected renewal raises lease loss; a returned cancellation marker aborts the local controller and raises cancellation.

Reference: `src/tasks/task-scheduler.ts:440–454`.

The bounded-abort-grace test uses fake timers and an executor that waits on a gate before returning success. It verifies heartbeat movement within grace, no further movement after the grace window, and eventual failed settlement without lease loss.

Reference: `src/tasks/task-scheduler.test.ts:942–974`.

**Measured:** the bounded renewal test passed. Its abort is a wall-clock deadline abort, not operator cancellation.

Other executed lease-related tests are declared at:

- Initial bounded idle renewal: `src/tasks/task-scheduler.test.ts:909`.
- Heartbeat rejection before reconciliation: `:1012`.
- Renewal stopping at last successful expiry after stale writes: `:1047`.
- Restart recovery of expired retry-safe attempt: `:1201`.
- Result settlement refused after expiry: `:1381`.

### Generation terminology limitation

The inspected scheduler explicitly uses **owner ID plus fencing token** and expiration. I did not establish a separate scheduler “generation” counter, inspect the concrete store’s token-allocation implementation, or verify token monotonicity. Those should not be presented as measured guarantees from this worker’s evidence.

## How completion and results cross into the result service

### Success publication protocol

The scheduler:

1. Copies settlement results and validates required result acceptance.
2. Checks settlement execution limits.
3. Calls `resultService.prepare()` with each result’s task, step, and attempt IDs; content and metadata; and an `expectedLease` containing owner ID and fencing token.
4. Opens `store.atomicWrite()`.
5. Revalidates the current lease and requires the step still be running.
6. Calls `resultService.publishPrepared(preparedResults, store)` using that transactional store.
7. Records usage and marks attempt/step completed.
8. Computes overall task completion.
9. Releases the fenced lease and records completion events.
10. Calls `finalizePrepared()` after the atomic write; on error, calls `discardPrepared()`.

References:

- Acceptance and limits: `src/tasks/task-scheduler.ts:1405–1414`.
- Preparation and expected lease: `:1421–1438`.
- Transaction revalidation: `:1462–1474`.
- Publication and error translation: `:1476–1484`.
- Completion, lease release, events: `:1485–1530`.
- Finalization/discard and persistence failure handling: `:1532–1546`.

`result-fence-lost` from preparation/publication is translated into `TaskSchedulerLeaseLostError`, rather than accepted as normal completion.

References: `src/tasks/task-scheduler.ts:1436–1438`, `:1479–1483`.

**Important distinction:** the scheduler does not hand an unfenced “task complete” result to the service and then independently accept the attempt. Publication is invoked before attempt/step completion within the scheduler’s atomic write. Overall task status is calculated afterward using `taskRequestCompletion()`: all steps completed is insufficient if research completion is false or requested file output remains pending; status becomes `partial` in those cases.

Reference: `src/tasks/task-scheduler.ts:1497–1508`.

### Measured transaction rollback checks

The inspected publication-failure test injects duplicate result event IDs. It verifies that the failed first publication exposes neither results nor result-recorded events, leaves the producer ready for retry, and that later downstream execution sees only the successful retry’s published result.

Reference: `src/tasks/task-scheduler.test.ts:717–777`.

The inspected later-write-invalid test returns a successful result with a usage entry belonging to another attempt. It verifies no results, no usage entries, and no result-recorded or attempt-completed events remain; the attempt fails with `invalid-settlement`.

Reference: `src/tasks/task-scheduler.test.ts:780–797`.

**Measured:** both passed. These tests support atomic result/completion rollback under their injected failures; they are not crash-injection or arbitrary concurrent cancellation tests.

## Critical test-coverage distinction

The test named **“persists cancellation, aborts local execution, and rejects late success”** does **not** actually return a successful settlement after cancellation.

Its executor resolves `{ outcome: "cancelled" }` on abort. Assertions establish durable cancellation, removed lease, cancelled attempt/step, no results, and a cancellation state event.

Reference: `src/tasks/task-scheduler.test.ts:841–859`.

Therefore:

- **Measured:** cooperative cancellation persists and leaves no results.
- **Not directly measured by this test:** an executor ignoring operator cancellation and later returning `{ outcome: "succeeded", results: [...] }`.
- **Source-inferred protection:** the durable terminal-task/cancellation-marker check routes such a settlement into cancellation before success publication, with an additional transactional lease check before publication. References: `src/tasks/task-scheduler.ts:1349–1354`, `:1464–1467`, `:1956–1978`.

A separate deadline test **does** return success after the abort signal. It verifies failure rather than completion and retention of late output only as `diagnostic`.

Reference: `src/tasks/task-scheduler.test.ts:977–1005`.

**Measured:** deadline-late success is intentionally treated differently from operator cancellation: diagnostic retention is allowed in that tested deadline path. It would be inaccurate to summarize the scheduler as universally deleting or rejecting every kind of late output.

## Boundary invariant and synthesis risk

### Specific compositional invariant

For accepted success, **result publication and attempt completion must share the same transactional store, and both must remain conditioned on the same current attempt lease**.

Scheduler-side support:

- Sends `expectedLease` to preparation: `src/tasks/task-scheduler.ts:1424–1435`.
- Revalidates immediately inside settlement transaction: `:1464–1467`.
- Passes that transaction’s `store` to `publishPrepared`: `:1476–1478`.
- Marks completion and releases the lease within that transaction: `:1485–1513`.

The result-service investigator should verify that publication actually honors that supplied store and rechecks applicable fences, including cancellation, plan/attempt identity, and any service-specific generation rules. This worker did not independently establish those service internals.

### Concrete coverage risk for synthesis

There is a **test-name-versus-behavior gap** at the operator-cancellation boundary. The existing named cancellation/late-success test is cooperative and never exercises a late successful result payload.

A targeted future regression test should:

1. Dispatch an executor that ignores abort and waits on a gate.
2. Cancel the task durably.
3. Release the gate with a successful result payload.
4. Assert no accepted or diagnostic result, no result-recorded/attempt-completed event, no task resurrection, and appropriate cancelled-versus-lease-lost accounting.
5. Repeat after expiry/reacquisition to exercise stale-owner/token rejection.

This is a proposed check, **not** a test added or executed during this audit.

## Outstanding limitations and obligations

- Executed only `src/tasks/task-scheduler.test.ts`: **55 passed, 0 failed**. No independent result-service, operator-service, concrete-store, or full-project suite was run by this worker.
- No dedicated new race, process-crash, or multi-process cancellation experiment was performed.
- Concrete lease-token generation, store isolation mechanics, result-service generation fences, and staged-content cleanup internals remain unverified here.
- Repository evidence only; no live-source claims or web citations were needed.
- No source/test changes or dependency installation were performed. Before/after short git status was unchanged.
- No report file was saved, consistent with this delegated worker’s instructions. The parent still owns cross-subsystem synthesis and the requested verified write/readback of `reports/release-audit.md`.
