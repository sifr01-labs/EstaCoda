EstaCoda’s source has substantial durable-task, security, spend-control and learning machinery. Three bounded test runs passed; deployment and coding quality remain unverified.

## Scope and evidence limits

- Assigned scope: **EstaCoda source/runtime implementation**, not upstream Superagent or Harness.
- Benchmark date supplied by coordinator: **2026-11-04 UTC**.
- Subject revision supplied by coordinator: `9a8d571ef7455b612c7d37607eaa8570af3dfd31`. I did **not independently rerun git verification**.
- Observed root `package.json`: version `0.1.0`, Node requirement `>=22.18.0`, pnpm `10.33.0`.
- `AGENTS.md` explicitly identifies this as a source-research fixture, not a deployed service, and warns against comparing coding quality using test counts.
- No `.env` or credential contents were inspected; no installs, lifecycle scripts, source edits, external services, or live-model calls were performed.
- Supplied runtime observation: configured Codex / `gpt-6.1-sol`; readiness was a configuration observation, **not successful live inference**; current routing unknown. This worker did not independently inspect deployed runtime status.
- Network discovery/latest-release claims and upstream implementation comparison belong to other scopes and are not established here.

## Actual deterministic verification

Before execution, inspected `package.json`, `vitest.node.config.ts`, `src/test/vitest-setup.ts`, and `src/test/state-home.ts`. Vitest uses the Node environment; setup redirects `HOME` to a newly created temporary directory. Invoked Vitest directly, avoiding package lifecycle scripts.

All three terminal calls used `verificationInputs: ["."]`, explicit verification labels, and `timeoutMs: 30000`.

| Label | Exact command | Outcome | Test files / tests | Reported duration |
|---|---|---|---|---|
| `estacoda-durable-task-security-recovery` | `node node_modules/vitest/vitest.mjs run --config vitest.node.config.ts src/tasks/task-scheduler.test.ts src/tasks/sqlite-task-store.test.ts src/tasks/task-approval-service.test.ts src/delegation/delegate-call-budget.test.ts --reporter=dot` | Successful; exit 0 indicated by successful terminal receipt and completed Vitest summary | 4 passed / **95 passed** | 6.24 s |
| `estacoda-cost-execution-credential-boundaries` | `node node_modules/vitest/vitest.mjs run --config vitest.node.config.ts src/providers/provider-spend-enforcement.test.ts src/tasks/provider-spend-cross-process.test.ts src/execution/docker-policy.test.ts src/execution/host-execution-bounds.test.ts src/security/plaintext-credential-guard.test.ts src/control-service/credential-pipe.test.ts --reporter=dot` | Successful; exit 0 indicated by successful terminal receipt and completed Vitest summary | 6 passed / **55 passed** | 2.82 s |
| `estacoda-skill-memory-channel-lifecycle` | `node node_modules/vitest/vitest.mjs run --config vitest.node.config.ts src/skills/skill-lifecycle.test.ts src/skills/skill-evolution.test.ts src/skills/skill-learning.test.ts src/memory/memory-curation-service.test.ts src/channels/channel-state-recovery.test.ts --reporter=dot` | Successful; exit 0 indicated by successful terminal receipt and completed Vitest summary | 5 passed / **68 passed** | 579 ms |

**Total: 15 selected files, 218 tests passed; no reported failed or skipped tests in these runs.** The visible tool output did not print a separate numeric exit-code field; do not portray it as a raw numeric receipt independent of the successful tool result.

No missing prerequisites were encountered for these selected tests. That does **not** establish prerequisites for the entire suite, Docker daemon execution, packaged desktop operation, browsers, channels, or real providers.

An inspection helper failed: `execute_code` attempted `file.grep`, which is unavailable inside that helper. It returned `ok:false`; these were **not test failures**. Relevant inspections continued using the exposed `functions.file_grep` and file reads. No terminal failure-follow-up was needed.

## Findings by implementation area

### 1. Durable delegation, plans, workers and recovery

**Source evidence**

- `src/delegation/durable-delegation-service.ts:153`, `DurableDelegationService`: explicitly converts requests into durable Task graphs rather than itself executing or waiting for workers.
- `src/delegation/durable-delegation-service.ts:227–239`, `create`: requires a trusted workspace, bounds batch length, and prevents a research request’s required synthesis step from being disabled by `synthesis:false`.
- `src/delegation/durable-delegation-service.ts:275`: synthesis output must be root-task-relative `.md`/`.txt`, without traversal.
- `src/delegation/durable-delegation-service.ts:427`: graph binds the Task workspace.
- `src/delegation/durable-delegation-service.ts:569`: records allowed toolsets and named tools.
- `src/delegation/durable-delegation-service.ts:654–673`: distinguishes unavailable requested toolsets and a required but unavailable `web.search`.
- `src/tasks/task-scheduler.ts:1–160`, `TaskSchedulerOptions`, `TaskSchedulerDispatchResult`: durable store, executor resolution, approval service, owner ID, leases, concurrency limits, dispatch grants and independently settling completion are explicit.
- `src/tasks/sqlite-task-store.ts:100–160`, `SQLiteTaskStore.createTaskGraph`: profile-scoped integrity checks, plan validation, revision-state agreement, event ownership checks, foreground-host/workspace matching and atomic graph creation.
- `src/delegation/child-runner.ts:70–210`, `runDelegatedChild`: actual child runtime call via `input.child.handle(...)`, heartbeat renewal, progress/preview relays, configured timeout, abort signaling and timeout diagnostics.

**Behavior actually covered by the passing scheduler tests**

Precise test evidence in `src/tasks/task-scheduler.test.ts`:

- `:100`: dependency ordering and completion only after durable result acceptance.
- `:226`, `:249`, `:288`: expired/superseded grants, ownership races, competing scheduler dispatch.
- `:357`: unfinished-attempt fencing and requeue for handoff.
- `:504`, `:531`: durable cross-owner concurrency; executor/provider concurrency.
- `:582`: uncertain non-idempotent work pauses for operator review.
- `:717`, `:780`: failed atomic publication and rollback of invalid settlement.
- `:841`, `:862`: cancellation rejects late success and handles launch races.
- `:942`, `:977`: bounded post-abort lease renewal and active wall-clock deadline abort.
- `:1095`: worker progress checkpoints under the attempt fence.
- `:1201`, `:1363`, `:1381`: expired retry-safe attempt recovery, queued crash-boundary reuse, stale settlement rejection.
- `:1467`, `:1547`, `:1622`: durable approval pause/resume, all parallel approvals required, denial cleans up sibling live state.
- `:1678`: exact spend denial preserves completed results.

**Strength:** this is more than an in-memory agent loop: ownership fencing, durable results, cancellation races, retry policy and operator review are represented and tested.

**Qualification/weakness:** the inspected worker path uses cooperative runtime abort and heartbeats; the source/test evidence is not proof of hard OS-level termination of every descendant or exactly-once external side effects. Deliberately pausing uncertain non-idempotent work is safer but limits unattended recovery.

### 2. Approval and credential boundaries

**Source evidence**

- `src/delegation/toolset-security.ts:1–190`, `resolveChildToolAccess` / `applyChildToolAccessResult`: effective child-tool allowlist, stripping/blocking reasons, removal from registry, parent-visibility restrictions, role/depth gating of delegation.
- `src/control-service/credential-pipe.ts:1–57`, `attachCredentialPipe`: dedicated inherited descriptor, explicitly not stdout or ordinary preload/RPC; bounded frames/backpressure; exact parameter validation; staging returns candidate IDs; discard/window-close operations; abort/dispose on close; bounded concurrent work-input requests.
- `src/tasks/task-scheduler.test.ts:1467–1622`: approval lifecycle and parallel-denial behavior, actually tested.

**Tested:** selected task-approval, plaintext-credential-guard and credential-pipe suites passed.

**Strength:** scoped child access and a separate credential transport provide concrete boundaries beyond “tell the model not to disclose secrets.”

**Qualification:** do not infer that every credential sink, channel adapter, arbitrary host subprocess or desktop route has been audited. The security suite selected here is bounded; child-tool security tests themselves were not run.

### 3. Workspace identity, containment and execution

**Source evidence**

- `src/tasks/task-workspace.ts:1–2` reexports `resolveWorkspaceIdentity` as `resolveTaskWorkspaceBinding`: Task workspace identity is explicit, but identity alone is not containment.
- `src/execution/docker-policy.ts:7–43`, `parseExecutionPolicy` / `selectedExecutionPolicy`:
  - Missing policy defaults to **host** execution.
  - Unsupported backends fail with “no host fallback is authorized.”
  - Docker requires prepared immutable `sha256` image ID.
  - Workspace access, command network, credential capabilities, lifetime and resource controls are validated.
  - Controls distinguish mandatory from advisory requirements.
- `src/execution/docker-container.ts:70–120`, `DockerContainer` acquisition/container configuration:
  - Requires selected Docker policy and profile.
  - Source configures explicit user, read-only root filesystem, dropped capabilities, no-new-privileges, network disabled by default, private IPC/cgroup namespace, and workspace bind mount.
- `src/execution/docker-container.ts:141–153`, `verifyDockerInspection`: verifies actual inspection facts against expected container configuration.
- `src/execution/docker-container.ts:158–183`, `assertSafeDockerWorkspace`: protected roots and socket/device/FIFO rejection.
- `src/delegation/child-runner.ts:148–159`: actual runtime execution occurs through the child’s `handle`, rather than graph creation merely pretending execution occurred.

**Tested:** Docker **policy** and host execution-bounds tests passed.

**Strength:** optional Docker backend has explicit fail-closed selection and verification machinery, not just a `docker run` claim.

**Concrete weakness:** host is the default. A trusted workspace or child tool allowlist must not be advertised as a sandbox. No Docker daemon/container launch was performed in this worker; container configuration and inspection are **source-only** evidence.

### 4. Provider and spending budgets

**Source evidence**

- `src/providers/provider-spend-policy.ts:24`, `prepareProviderSpend`: spend preparation exists before provider execution.
- `src/providers/provider-spend-policy.ts:106–115`, `providerSpendDenialMessage`: distinguishes logical-session and Task-tree capacity already reserved by in-progress work, explicitly stating no provider request was sent.
- `src/tasks/task-scheduler.ts:75–80`, `TaskSchedulerLimits`: profile, executor and provider concurrency limits.
- `src/tasks/task-scheduler.test.ts:1394`, `:1449`, `:1678`: zero-call execution limit, reservation settlement and spending-denial handling.

**Passing tests with inspected descriptions**

`src/providers/provider-spend-enforcement.test.ts`:

- `:62`: durable reservation marked dispatching before adapter entry and settled using actual usage.
- `:113`: threshold warning once, before dispatch.
- `:163`: zero-spend Session blocked before adapter.
- `:179`: unknown pricing fails closed **when an applicable limit exists**.
- `:205`: unbounded request denied under a limit.
- `:227`: parallel capacity cannot oversubscribe Session.
- `:253`: post-dispatch adapter exception retains full uncertain reservation.
- `:315`: graceful disposal fences an in-flight call.
- `:346`: attributed execution without a spend controller fails closed.

The cross-process spend test file also passed, but its individual assertions were not inspected here.

**Strength:** durable reservation accounting addresses parallel overspend and ambiguous post-dispatch failures.

**Tradeoff/weakness:** cost protection is conditional on applicable configured limits and known/bounded pricing assumptions. Retaining uncertain reservations is conservative but can reduce available capacity after ambiguous failures. These tests do not verify provider invoices or live billing accuracy.

### 5. Proactive execution, channels and delivery

**Source evidence**

- `src/cron/cron-runner.ts:1–31`: integrates cron authority validation, runtime acquisition, workspace trust, live execution authority, safety checks, execution store, locks and hooks.
- `src/cron/cron-runner.ts:116–160`, `tickCron`: selects due jobs under tick lock; per-job lock prevents simultaneous execution; creates execution record; advances next run **under lock before execution**; runs job and completes durable record.
- `src/cron/cron-runner.ts:47–64`: per-target delivery outcomes and execution/session/trajectory linkage are represented.
- Inspected file inventory contains channel adapters for Telegram, Discord, WhatsApp and email and channel recovery/delivery stores. **Inventory is not proof of configured, working integrations.**

**Tested:** `src/channels/channel-state-recovery.test.ts` passed.

**Strength:** proactive execution has explicit locking, authority and durable delivery/execution bookkeeping.

**Qualification/weakness:** advancing schedule before execution helps avoid duplicates but is not proof of exactly-once or guaranteed missed-run recovery. Cron execution and real channel delivery were not exercised. Do not imply channels are deployed or credentials configured.

### 6. Skills evolution and memory

**Source evidence**

- `src/skills/skill-lifecycle.ts:3–29`: lifecycle decisions, active-state checks and transition policy.
- `src/skills/skill-evolution.ts:138–207`: governed proposal change kinds, approval states, evaluation plans, policy decisions, rollback expectations and proposed/promoted/rejected states.
- `src/skills/skill-evolution.ts:266–315`: evaluation records, promotion deltas and `SkillEvolutionStore`.
- `src/skills/skill-evolution.ts:439–450`: mutation/rollback telemetry.
- `src/skills/skill-evolution.ts:628–665`: proposal records and append to `proposed-patches.jsonl`.
- `src/memory/memory-curation-service.ts:1–24`: transient-state checks, content scanner, fact extractor/reviewer, redaction and mutation/persistence integration.
- `src/memory/memory-curation-service.ts:26–44`: explicit `USER.md`/`MEMORY.md` operations and auto-applied/pending-review/ignored/failed results.
- `src/memory/memory-curation-service.ts:114–158`, `observeCompletedTurn` / `checkpoint`: configurable turn threshold, enabled triggers, manual-mode gating and optional exclusive coordination.
- `src/memory/memory-curation-service.ts:161–190`: cutoff-based message selection, prior-audit checkpoint, runtime-dispose throttling and minimum-new-message checks.

**Tested:** skill lifecycle, evolution, learning and memory-curation-service suites all passed.

**Strength:** source implements inspectable records, lifecycle transitions and review/evaluation concepts rather than presenting “learning” only as opaque prompt changes.

**Qualification/weakness:** passing lifecycle tests does **not** demonstrate beneficial skill learning, resistance to every poisoning attack, model-weight learning, or better future task success. Memory can be auto-applied in configured modes; do not claim all durable memory changes require human approval. Full promotion/toolchain end-to-end integration and long-horizon quality were not verified.

### 7. Coding-tool capabilities — evidence gap

Source inventories observed execution/file services for host and Docker, and runtime child execution. The selected tests establish pieces of execution bounds and recovery, **not coding performance**.

A complete coding-tool walkthrough—file patch/write semantics, shell command authorization-to-execution, code navigation, test receipts, workspace mutation recovery and end-to-end artifact validation—was **not completed within this worker’s inspection budget**. Avoid upgrading file names into verified implementation claims.

## Balanced synthesis suitable for the parent report

Defensible EstaCoda strengths at this revision:

1. Durable task and result lifecycle with explicit leases/fencing and adversarial recovery tests.
2. Provider spend reservations designed for parallel execution and uncertain provider failures.
3. Separate credential transport and scoped delegated tool access.
4. Explicit optional Docker execution policy with immutable image and containment checks.
5. Governed skill/memory records and proactive execution bookkeeping.

Important caveats and likely engineering priorities:

1. **Host default means no default sandbox guarantee.** State backend and verified authority clearly in user-visible receipts.
2. **Cooperative cancellation is not universal side-effect rollback.** Document idempotency and operator intervention for uncertain effects.
3. **Budget enforcement depends on configured limits/pricing.** Surface reservation uncertainty and safe reconciliation.
4. **Learning machinery is not evidence of learning efficacy.** Measure held-out outcomes and regressions after promotion.
5. **Large integration surface needs deployed conformance evidence.** Channel availability, Docker execution, packaging and providers must be tested independently.
6. **No demonstrated coding advantage.** A matched task/model/budget trial remains necessary; test count measures selected implementation coverage, not intelligence.

## Outstanding obligations for synthesis

- Integrate this evidence with the independently inspected **Superagent + Harness** scopes; this worker makes no unsupported superiority claim.
- Preserve supplied upstream research-prototype/not-official-DeepSeek-product disclaimer and disabled-network/latest-discovery limitation.
- Include all three actual test commands and successful counts, while explicitly separating deterministic tests from source-only features.
- Report that no selected test failed and no selected-test prerequisite was missing; do not generalize that to unrun suites.
- Verify the incomplete coding-tool end-to-end scope separately if needed, rather than implying it was covered.
- The requested final report file was **not written by this worker**. Parent synthesis must perform its governed write and readback before claiming `reports/superagent-vs-estacoda.md` is saved.
