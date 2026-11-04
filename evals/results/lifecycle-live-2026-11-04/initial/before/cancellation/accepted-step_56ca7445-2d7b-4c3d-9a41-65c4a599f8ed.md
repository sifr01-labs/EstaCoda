All 81 selected tests passed. Cancellation defenses compose on inspected scheduler paths, but noncooperative late success remains untested and result-service fencing is optional.

# Release audit: cancellation and late-result rejection

## 1. Verdict

**Qualified pass for the inspected scheduler-to-result-service paths; insufficient evidence for an unconditional cancellation guarantee across all result-service callers.**

The evidence supports these conclusions:

- Scheduler cancellation persists before local abort, and settlement checks durable cancellation and lease state before accepting success.
- The scheduler supplies lease expectations when preparing results and publishes them within the transaction that settles execution.
- The result service revalidates supplied lease expectations at publication. An existing test demonstrates rejection when cancellation occurs after preparation but before publication.
- Existing tests demonstrate rollback of result metadata and events when publication or subsequent settlement work fails.

Two material qualifications prevent a stronger verdict:

1. **Noncooperative late success after operator cancellation was not directly demonstrated.** The scheduler test named “persists cancellation, aborts local execution, and rejects late success” actually returns a cancelled outcome from its abort listener.
2. **The result service is not an unconditional lifecycle gate.** `expectedLease` is optional; without it, the service does not independently reject cancelled or terminal Task/Step/Attempt states. An omitted fence can therefore bypass its cancellation check, although the inspected scheduler paths supply fences.

No acceptance bypass was demonstrated on the inspected scheduler paths. The release claim supported by this audit is narrower than “cancellation always prevents every later result from being accepted, read, or delivered.”

## 2. Evidence basis and scope

Two delegated investigators supplied accepted reports:

| Scope | Durable result reference | Primary evidence |
|---|---|---|
| `task-scheduler-cancellation` | Task `task_54307d68-346c-446e-8355-f3496f1b1fab`, result `97b12c16-5fa7-4286-9980-344ac2257044` | Scheduler/operator source inspection and the scheduler test suite |
| `result-service-cancellation` | Same Task, result `8a1387c4-1e9a-4a0b-a490-e07ded8a80f1` | Result-service source, tests, result tools, and selection/delivery helpers |

This synthesis uses those investigators’ source references and execution receipts. It does not represent an additional source inspection or test run. The result-service investigator’s limited scheduler observations overlap the scheduler investigation; they are **not counted as independent corroboration**.

Evidence labels used below:

- **Measured:** Assertions exercised by existing tests reported as passing.
- **Source-derived:** Behavior inferred from inspected implementation, not an exhaustive runtime guarantee.
- **Unverified:** A relevant scenario not demonstrated by the supplied receipts.

Repository paths and line numbers identify the inspected source. Neither report supplies a commit hash, so the citations are not pinned to an immutable revision.

## 3. Exact executed commands and outcomes

### 3.1 Scheduler investigation

```sh
node --version; pnpm --version; pnpm exec vitest run --config vitest.node.config.ts src/tasks/task-scheduler.test.ts --no-cache
```

Reported outcomes:

| Item | Outcome |
|---|---|
| Node | `v24.14.1` |
| pnpm | `10.33.0` |
| Vitest | `4.1.6` |
| Exit status | `0`, signal `null` |
| Test files | 1 passed |
| Tests | **55 passed** |
| Duration | 32.22 seconds; 30.47 seconds in tests |

Corepack announced a pnpm download before successful execution. A final command:

```sh
git status --short
```

reported only `?? node_modules`. This investigator did not have a pre-run baseline and could not attribute that entry to its work.

### 3.2 Result-service investigation

```sh
node --version; pnpm --version; git status --short
```

Observed Node `v24.14.1`, pnpm `10.33.0`, and pre-existing untracked `node_modules`.

```sh
pnpm exec vitest run --config vitest.node.config.ts --cache=false src/tasks/task-result-service.test.ts src/tools/task-result-tools.test.ts
```

Reported outcomes:

| Item | Outcome |
|---|---|
| Vitest | `4.1.6` |
| Exit status | `0`, signal `null` |
| Test files | 2 passed / 2 |
| Tests | **26 passed / 26** |
| Duration | 11.64 seconds |

A subsequent:

```sh
git status --short
```

returned the same output as this investigator’s initial status check.

**Combined measured total: 81 passing tests across three selected test files, in two separate invocations.** This was not a full-repository test run. The durations are runner timings, not model or production-performance measurements.

The inspected package declares Node `>=22.18.0` and pnpm `10.33.0`; the selected Vitest configuration uses Node and loads `src/test/vitest-setup.ts` (`package.json:6,15-18`; `vitest.node.config.ts:3-10`).

Both investigators reported no source or test edits. Tests do create temporary fixtures; result-service fixture creation and teardown are at `src/tasks/task-result-service.test.ts:33-59`. These receipts do not constitute a byte-for-byte repository integrity audit.

## 4. Scheduler findings

### 4.1 Measured behavior

| Check | What the inspected assertions demonstrate | Citation |
|---|---|---|
| Cancellation during execution | A cooperative executor returns `outcome: "cancelled"` after abort; Task, Step, and Attempt become cancelled; the lease is removed; results remain empty; cancellation is journaled. | `src/tasks/task-scheduler.test.ts:841-860` |
| Cancellation before launch | A microtask cancels an admitted attempt before executor invocation; execution count stays zero; cancellation settles without results. | `src/tasks/task-scheduler.test.ts:862-894` |
| Successful response after lease expiry | The executor advances an injected clock by 31 seconds under a 30-second lease and returns success; the run reports `leaseLost: 1`, `completed: 0`. | `src/tasks/task-scheduler.test.ts:1381-1388` |
| Publication failure | Duplicate result-event IDs cause failure; result records/events do not survive; retry publishes the new attempt’s result, which downstream execution receives. | `src/tasks/task-scheduler.test.ts:717-777` |
| Failure after publication within settlement | Invalid usage ownership causes rollback; result records, usage rows, result-recorded events, and attempt-completed events remain absent. | `src/tasks/task-scheduler.test.ts:780-797` |

**Coverage caveat:** The named late-success cancellation test resolves a cancelled outcome in its abort listener (`src/tasks/task-scheduler.test.ts:841-846`). It does not demonstrate a successful response from an executor that ignores abort. Lease-expiry late success and operator-cancellation late success are distinct scenarios.

### 4.2 Source-derived guarantees

**Durable cancellation precedes local abort.** `TaskScheduler.cancelTask()` calls `cancelTaskInStore()` before aborting matching local executions (`src/tasks/task-scheduler.ts:424-437`). The helper uses `atomicWrite`, cancels eligible queued/waiting work, requests cancellation for active attempts, updates the Task, and appends its state event. Already-terminal Tasks return unchanged (`src/tasks/task-operator-service.ts:781-850`).

Thus, local signal cooperation is not the only rejection barrier. This does not imply immediate termination of external work or reversal of executor side effects.

**Launch and settlement check cancellation.** An already-aborted execution is suppressed before invoking the executor (`src/tasks/task-scheduler.ts:1144-1155`). Settlement considers terminal Task state, the lease cancellation marker, and an explicitly cancelled outcome before accepting success (`src/tasks/task-scheduler.ts:1330-1363`). Cancellation settlement rechecks the fence and expiry while allowing the cancellation marker, cancels the Attempt and nonterminal Step, releases the fenced lease, and appends its event (`src/tasks/task-scheduler.ts:1687-1714`).

A noncooperative successful response after durable cancellation should therefore be rejected or converted to cancellation. **That conclusion is source-derived, not directly measured by the inspected cancellation test.**

**Lease checks have defined limits.** `#assertCurrentLease()` rejects missing Task/Attempt/lease, owner or token mismatch, expiry including equality, and disallowed cancellation markers; ordinary settlement also rejects terminal Tasks (`src/tasks/task-scheduler.ts:1956-1978`). Successful settlement additionally requires a running Step (`src/tasks/task-scheduler.ts:1465-1467`).

The helper does not itself establish Attempt status, latest-attempt identity, active plan revision, or all ownership relationships. Normal lease release and fencing mitigate stale execution, but the helper alone is not a complete provenance/state predicate.

**Cancellation cleanup can lag Task cancellation.** Cancellation settlement still requires an unexpired lease. Lease-loss handling and abandoned-attempt recovery provide reconciliation paths rather than allowing stale publication (`src/tasks/task-scheduler.ts:1190-1202,836-864`). Immediate terminalization of every running Step/Attempt is therefore not implied.

## 5. Result-service findings

### 5.1 Measured behavior

| Check | What the inspected assertions demonstrate | Citation |
|---|---|---|
| Cancellation between preparation and publication | With `expectedLease` supplied, cancellation produces `result-fence-lost`; no result metadata remains; the prepared body is absent after discard. | `src/tasks/task-result-service.test.ts:318-371` |
| Event persistence failure | Result metadata rolls back and its body is removed. | `src/tasks/task-result-service.test.ts:278-291` |
| Later failure in a two-result batch | No result metadata or result-recorded events survive; neither body remains after discard. | `src/tasks/task-result-service.test.ts:293-316` |
| Prepared-body recovery | Abandoned prepared bodies are removed; bodies with committed metadata are preserved. | `src/tasks/task-result-service.test.ts:373-402` |

The cancellation case is a deterministic prepare–cancel–publish ordering test, not a simultaneous multi-process race. It does not explicitly assert absence of a result-recorded event in that particular case.

### 5.2 Source-derived acceptance boundary

Preparation validates content constraints and Task/Step/Attempt relationships. Lease validation occurs **only when `expectedLease` is present**, and disposition defaults to `accepted` (`src/tasks/task-result-service.ts:304-361`).

Publication revalidates the batch before inserting metadata, including relationships and any supplied fence, then applies policy and aggregate budgets (`src/tasks/task-result-service.ts:218-245,393-437`).

The fence predicate rejects absent leases, owner/token mismatch, expiry at or before the current time, and a defined cancellation marker (`src/tasks/task-result-service.ts:684-698`). The cancellation test measures the marker case; it does not independently demonstrate every predicate variant.

**Critical boundary:** Neither preparation nor publication independently requires nonterminal Task/Step/Attempt status (`src/tasks/task-result-service.ts:338-361,393-418`). The service’s cancellation rejection is conditional on fencing, not an unconditional lifecycle rule.

Preparation writes bodies without publishing metadata. Finalization removes markers; discard preserves content whose matching metadata committed, and recovery reconciles markers against stored metadata (`src/tasks/task-result-service.ts:181-209,250-302,470-482`). This is transactional metadata publication plus compensating filesystem cleanup—not one atomic transaction spanning SQLite and the filesystem.

## 6. How the boundaries compose

### 6.1 Inspected integration

The scheduler’s successful-result path:

1. Prepares results with expected lease owner and fencing token.
2. Enters `store.atomicWrite`.
3. Rechecks lease/Task state and requires a running Step.
4. Calls `publishPrepared(preparedResults, store)`.
5. Writes usage and lifecycle settlement, releases the lease, and appends completion events.
6. Finalizes after commit or discards on failure.

References: `src/tasks/task-scheduler.ts:1421-1441,1463-1535`.

A result-service `result-fence-lost` becomes scheduler lease loss, not successful acceptance (`src/tasks/task-scheduler.ts:1477-1484`). Failure diagnostics also prepare with a fence and publish after lease validation inside an atomic write (`src/tasks/task-scheduler.ts:1729-1760`).

### 6.2 Testable composition argument

| Ordering | Expected outcome | Evidence strength |
|---|---|---|
| Cancellation commits before settlement | Durable Task/lease state prevents successful settlement. | Source-derived; cooperative cancellation measured |
| Cancellation occurs after preparation but before publication | Publication revalidation rejects the cancelled fence. | Directly measured at the service boundary |
| Successful settlement commits before cancellation | Later cancellation returns the already-terminal Task unchanged; committed results are not retroactively revoked. | Source-derived |
| Publication or later settlement work fails | Result metadata/events roll back with settlement. | Measured in specific scheduler and service failure cases |

This argument depends on the supplied store transaction providing the intended serialization and rollback semantics. The inspected tests support concrete transaction paths, not all multi-process schedules or crash points.

**Reconciliation of the investigators’ findings:** The scheduler report’s provisional composition argument included rejection of terminal-attempt provenance by the result service. The result-service inspection does **not** establish that condition. The supported argument instead relies on scheduler lifecycle checks, service relationship checks, supplied fences, and normal lease lifecycle invariants. Neither subsystem should be described as independently enforcing every terminal-Attempt/latest-attempt/plan-revision rule.

### 6.3 Concrete cross-subsystem risk

**Optional fencing creates a caller-contract hazard.**

A caller can associate a result with an Attempt while omitting `expectedLease`. Because the service defaults disposition to accepted and does not independently reject terminal lifecycle states, that caller can bypass the service’s cancellation gate.

This is a source-supported API risk, **not a demonstrated scheduler exploit**. The inspected scheduler publication paths supply fences. It matters for future or alternate callers that may incorrectly assume the service itself guarantees cancellation rejection.

## 7. Acceptance, readability, and delivery are different properties

Cancellation rejection is not result revocation:

- `preview` and `readText` enforce association, authorization, availability/retention, and integrity, but do not require accepted disposition or an uncancelled Task (`src/tasks/task-result-service.ts:488-496,525-560`).
- Primary synthesis selection requires an available, accepted result for the synthesis Step (`src/tasks/task-primary-result.ts:27-33`).
- Research completion requires completed workers with accepted, available results (`src/tasks/task-primary-result.ts:5-20`).
- Delivered-path accounting requires a completed report-delivery Step with an accepted, available result (`src/tasks/task-primary-result.ts:51-57`).

These helpers do not independently revoke results on Task cancellation. Authorized diagnostic inspection may remain possible, and cancellation after successful settlement need not invalidate previously committed results. The receipts do not demonstrate an end-to-end cancellation-versus-delivery race.

## 8. Recommended release follow-up

No proposed test or implementation change below was performed.

1. **Directly test noncooperative late success.** Start an executor controlled independently of abort, commit cancellation, then resolve success with content. Assert cancelled lifecycle state, no lease, no accepted result, no result-recorded/completion events, no readable result handle, and no delivery receipt.
2. **Document or enforce the fence contract.** Test publication on a cancelled Attempt without `expectedLease`. Decide explicitly whether this is a permitted trusted-caller capability or must be rejected.
3. **Exercise preparation/publication races.** Replace owner/token, expire the lease, and request cancellation between preparation and publication. Assert rejection, metadata/event absence, and body cleanup.
4. **Test lifecycle invariants.** Cover Task/Step cancellation without a lease marker and terminal/stale Attempt scenarios, including latest-attempt and plan-revision expectations.
5. **Specify post-commit semantics.** Test cancellation after successful settlement and document which accepted or diagnostic results remain inspectable and eligible for selection/delivery.

## 9. Material limitations and final assessment

- Only the three selected test files ran; no full-suite, production, live-model, distributed stress, or exhaustive fault-injection result is claimed.
- Passing test counts do not prove all assertions relevant to cancellation. The investigators inspected specific cases; other passing test names are not promoted into stronger guarantees.
- The central noncooperative cancellation-versus-success scenario remains source-derived.
- The result-service investigator’s surrounding scheduler reads were truncated; the scheduler investigator supplies the transaction/control-flow evidence.
- No immutable source revision, complete caller inventory, independent database-serialization analysis, or exhaustive filesystem crash-consistency evidence was supplied.
- No source or test changes were reported.

**Final assessment:** The measured checks and inspected code support coherent cancellation and late-result rejection on the fenced scheduler publication paths. They do not justify a blanket result-service guarantee or a claim that noncooperative late success after operator cancellation has been directly tested. Release acceptance should preserve those qualifications, especially the optional-fence caller contract and the missing end-to-end late-success test.
