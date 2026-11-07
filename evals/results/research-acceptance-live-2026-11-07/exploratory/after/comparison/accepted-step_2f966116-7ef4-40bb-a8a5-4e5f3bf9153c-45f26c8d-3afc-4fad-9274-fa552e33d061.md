Superagent is a research app on DeepSeek Harness, not a new model. Its ticket workflow is well tested; EstaCoda has tested durable delegation. Neither has a measured coding or cost win.

# Benchmark: dsh-superagent-prototype + DeepSeek Harness versus EstaCoda

## Executive assessment

**The critical distinction is application versus runtime.** `dsh-superagent-prototype` is a research application bundle for repository-oriented work. **DeepSeek Harness supplies its underlying agent runtime.** Neither should be described as a new model, and the prototype should not be represented as an official production product.

The inspected manifests and executor interfaces substantiate the application/runtime distinction. The research-prototype and not-official-product positioning was supplied in the research brief; the workers did not independently revalidate that public disclaimer against a live upstream README. This report therefore distinguishes verified local source identity from supplied public positioning.

Two comparisons are useful:

1. **Superagent application alone versus EstaCoda:** the application is narrower. Its evidenced contribution is source admission, trigger/thread/ticket orchestration, per-ticket worker management, and delivery coordination. It delegates model execution and host services to Harness.
2. **Superagent + Harness versus EstaCoda:** this is the fairer full-stack comparison. Both have substantive agent-runtime machinery. The strongest evidence collected differs: superagent has tested repository-workflow policy and lifecycle coordination; EstaCoda has tested authority-bounded durable delegation, recovery, approvals, and Result integrity.

### Bottom line

- **For studying a focused repository-agent workflow:** superagent is the more directly relevant reference implementation in the inspected evidence.
- **For durable, governed multi-worker research and execution:** EstaCoda has stronger *verified evidence in this investigation* for Task graphs, authority fencing, partial synthesis, and accepted Result handling.
- **For a reusable plugin runtime:** Harness contains a concrete model/tool loop and scoped tool registry, but its behavioral test investigation remained incomplete.
- **For production security or readiness:** neither stack earned an unqualified endorsement.
- **For coding quality, latency, reliability, or cost:** **there is no measured winner.** That requires a controlled same-model, same-budget, same-task benchmark.

Passing native tests supports specific software invariants. It does not establish model intelligence, comparative coding ability, or production reliability.

---

## 1. Scope, revisions, date, and evidence rules

### Inspected snapshots

| Scope | Verified Git revision | Manifest identity | Evidence boundary |
|---|---|---|---|
| Superagent application | `8c32a9dc5d72c033816c6a8110b37f40cf94fba4` | Private MIT-licensed DSH bundle, version `0.1.0` | Application policy, orchestration, executor coordination, selected tests |
| DeepSeek Harness | `fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159` | `@deepseek-ai/dsh-root`, version `0.2.2-rc.1`, private MIT workspace root | Model/tool driver and scoped tools; broader subsystems incompletely inspected |
| EstaCoda | `fa61f5cf7a1846c7eaf19538c3b8a33a26447eff` | `estacoda`, version `0.1.0` | Durable delegation, scheduler, Results, authority, provider loop, selected learning/memory/isolation source |

**Date anchor:** the Harness worker recorded `2026-11-07T00:06:20Z`. The other workers did not independently collect timestamps. Treat this as a pinned-snapshot investigation associated with that observation, **not a verification of current upstream HEAD or present deployment state**. No freshness bound was imposed.

Sources: [superagent manifest, lines 1–25](../upstream/superagent/package.json#L1-L25), [Harness manifest, lines 1–17](../upstream/harness/package.json#L1-L17), [EstaCoda manifest](../package.json).

### Important version mismatch

The superagent manifest pins DSH development packages at **`0.2.1-alpha.2`**, whereas the separately inspected Harness checkout identifies as **`0.2.2-rc.1`**.

Consequently:

- The application tests are evidence for the application under its own locked dependency environment.
- The separate Harness inspection is evidence for the stated Harness revision.
- These do **not** constitute a tested, jointly deployed application/runtime pair.
- Compatibility between the prototype and the separately inspected Harness revision remains unverified.

See [superagent dependencies, lines 66–145](../upstream/superagent/package.json#L66-L145).

### Evidence labels

- **T — Tested:** relevant deterministic checks executed successfully. Strong evidence for the tested invariant under those fixtures—not for untested production behavior.
- **S — Source:** implementation inspected; behavior not independently exercised.
- **D — Documented/inventory:** documentation or package/test inventory only.
- **U — Unresolved:** insufficient investigation or execution.

“Unresolved” does not mean absent or broken. The three workers investigated separate scopes; application tests involving mocked Harness services are not independent corroboration of Harness implementation behavior.

**Citation convention:** links below are workspace-relative source references, intended to be read at the revisions above. They are not claims that live upstream files are unchanged. Workers did not supply verified public repository URLs, so none are invented here.

---

## 2. What each layer actually contributes

### Superagent: the workflow application

The inspected application is organized around work for one GitHub repository, optionally accepting Feishu requests and mapping tickets to separate DSH sessions.

Its evidenced responsibilities include:

- Source-specific admission and sender policy.
- Explicit versus inferred request strength.
- Mandate revalidation.
- Durable intake and trigger deduplication at the engine boundary.
- Thread/ticket coordination.
- Per-ticket worker-session mapping.
- Capacity reservations and background-work accounting.
- Delivery retry, acknowledgement, and outbox coordination.

Its executor consumes host-provided sessions, agents, subprocesses, background jobs, and subagents. Those interfaces are not a model runtime implemented independently by the application.

Sources: [manifest, lines 1–25](../upstream/superagent/package.json#L1-L25), [policy, lines 167–236](../upstream/superagent/src/policy.ts#L167-L236), [executor, lines 1–82](../upstream/superagent/src/executor/dsh.ts#L1-L82).

### Harness: the underlying runtime

Harness has a substantive default agent driver. Inspected source includes request preparation, streaming, tool execution, request-error events, and recovery integration points.

Examples in `agent.ts`:

- `turn()` at line 327.
- `ToolCallRecovery` construction at line 363.
- `step()` at line 435.
- Prepared streaming or `llm.stream(request)` at line 490.
- Request-error dispatch at line 549.
- Awaited tool execution at line 590.
- Request preparation at lines 613–644.

The tool service also implements scoped registration and restrictions, including a distinction between visible definitions, registrations, and capability names.

Sources: [agent driver, lines 253–644](../upstream/harness/packages/core/agent-loop/src/agent.ts#L253-L644), [tool service, lines 1–65](../upstream/harness/packages/core/tools/src/index.ts#L1-L65).

**Supported conclusion:** Harness is an implemented runtime, not merely an architectural proposal.

**Unsupported conclusion:** that every recovery, cancellation, sandbox, approval, or provider path works correctly. Those claims require inspection and tests beyond what completed.

### EstaCoda: agent runtime plus governed durable work

EstaCoda has its own provider/tool-turn orchestration and a persisted delegation system.

`DurableDelegationService` converts requests into durable Task graphs; it does not itself execute or wait for workers. Execution, approvals, recovery, and accepted Results are separate responsibilities coordinated through the Task system.

Sources: [delegation service, lines 150–230](../src/delegation/durable-delegation-service.ts#L150-L230), [provider turn loop, lines 206–294](../src/runtime/provider-turn-loop.ts#L206-L294), [provider/tool handling, lines 740–946](../src/runtime/provider-turn-loop.ts#L740-L946).

The strongest executed evidence concerns:

- Child access ceilings and trusted-workspace admission.
- Durable worker/synthesis ordering.
- Cancellation and stale-lease fencing.
- Approval revocation and pause/resume.
- Retry-safe recovery versus operator review for uncertain effects.
- Result authorization, atomic publication, integrity, and recovery.

This is evidence of orchestration and governance—not proof of superior model reasoning.

---

## 3. End-to-end capability matrix

Confidence is specific to the claim in each cell. No row implies an unexecuted end-to-end deployment passed.

| Capability | Superagent application alone | Superagent + Harness stack | EstaCoda |
|---|---|---|---|
| **Model/tool loop** | Delegates to host/runtime interfaces; not an independent loop. **S** | Concrete Harness request/stream/tool driver inspected; no runtime behavior tests completed. **S** | Provider/tool orchestration inspected; selected loop and completion tests passed. **T/S** |
| **External request intake** | Repository/Feishu-oriented application; engine intake deduplication tested. Real transports untested. **T/S** | Application intake plus runtime execution, not jointly deployed. **S/U** | Channel test inventory found; live gateway operation not verified. **D/U** |
| **Admission and request provenance** | Explicit/inferred strength, bots/system paths, source scope, mandate revalidation; policy suite passed. **T/S** | Same application policy; broader runtime permissions not fully inspected. **T/U** | Trusted-workspace and child-access admission tested. External sender policy not established here. **T/U** |
| **Work decomposition** | Trigger/thread/ticket and assessor/executor separation evidenced. **T/S** | Application coordinates runtime workers. Native Harness subagent governance unresolved. **S/U** | Durable worker/synthesis graphs, partial accepted evidence, and fail-closed synthesis tested. **T** |
| **Workspace separation** | Persistent worker session/workspace per ticket. **S** | Runtime containment behind that separation unverified. **U** | Host limitations explicit; substantial Docker verification source inspected, not exercised. **S** |
| **Concurrency** | Startup reservations, running workers, shell jobs and subagents counted; relevant tests passed. **T/S** | App coordination tested with host fixtures, not live Harness. **T/U** | Task/profile/executor/provider boundaries and atomic child reservations tested. **T** |
| **Cancellation and stop** | Selected lifecycle, stop/handoff, and delivery-during-loading cases passed. **T** | Core Harness cancellation behavior not executed. **U** | Cancellation fences, late-success rejection, and child admission under stale parents tested. **T** |
| **Recovery** | Selected restart delivery, retries, and cleanup coordination tested. **T/S** | Harness recovery seams inspected; persistence/recovery correctness unresolved. **S/U** | Task graph/Result restart behavior tested; whole chat-session recovery unresolved. **T/U** |
| **Approval and revocation** | Sender/admission policy evidenced; not equivalent to tool-execution approvals. **T/U** | Harness approval bodies not sufficiently inspected. **U** | Dispatch revocation, durable approval pause/resume, parallel denial tested. **T** |
| **Delivery** | Durability-barrier retry, history retry/pagination, paused outbox, delayed source registration tested. **T** | External send/ack crash windows and exactly-once behavior unverified. **U** | Accepted Result publication and delivery ordering tested; live external channel delivery unverified. **T/U** |
| **Result integrity** | Store/outbox tests passed; no equivalent content-integrity conclusion established. **T/U** | Broader runtime artifact integrity unresolved. **U** | Tampering, symlink substitution, authorization, atomic publication, and recovery tested. **T** |
| **Skills and workflow learning** | No independent learning mechanism established in app scope. **U** | Skills appear in Harness inventory; behavior not audited. **D** | Learning records and policy gates inspected; settlement notification tested, learning quality unmeasured. **S/T narrowly** |
| **Durable memory** | Not established in inspected application scope. **U** | Memory behavior not established. **U** | Configurable transcript-to-memory curation inspected; recall/privacy quality untested. **S** |
| **Credentials and secret confinement** | Operational credential setup not executed or audited end to end. **U** | Runtime credential subsystem not inspected sufficiently. **U** | Secret-broker read unsuccessful; credential confinement unverified. **U** |
| **Live coding, latency, cost** | No controlled live benchmark. **U** | No controlled live benchmark. **U** | No controlled live benchmark. **U** |

Primary references: [application policy](../upstream/superagent/src/policy.ts#L167-L236), [application executor](../upstream/superagent/src/executor/dsh.ts#L1-L200), [application delivery tests](../upstream/superagent/tests/delivery.spec.ts#L89-L137), [Harness driver](../upstream/harness/packages/core/agent-loop/src/agent.ts#L253-L644), [EstaCoda scheduler tests](../src/tasks/task-scheduler.test.ts), [EstaCoda Result tests](../src/tasks/task-result-service.test.ts), [EstaCoda dispatch tests](../src/security/dispatch-authorization.test.ts).

---

## 4. Tests actually executed

These are existing project regression suites selected by the workers, not a common cross-project benchmark.

### 4.1 Superagent application

**Preparation**

- Node: `v24.14.1`.
- pnpm: `11.7.0`, matching the application manifest.
- Own frozen-lockfile installation; no EstaCoda dependency borrowing.
- No root-package installation lifecycle script was present.
- Installation lifecycle execution was suppressed.

```sh
cd upstream/superagent &&
pnpm install --frozen-lockfile --ignore-scripts
```

**Receipt:** exit **0**; **235 packages** installed; reported duration **15.2 seconds**.

**Executed test command**

```sh
cd upstream/superagent &&
pnpm test \
  tests/policy.spec.ts \
  tests/core-engine.spec.ts \
  tests/delivery.spec.ts \
  tests/outbox.spec.ts \
  tests/passes.spec.ts \
  tests/runtime-concurrency.spec.ts \
  tests/store.spec.ts
```

**Receipt:** exit **0**; **7 files passed, 535 tests passed, 0 failed**; reported wall duration **12.43 seconds**.

| Suite | Passed |
|---|---:|
| `policy.spec.ts` | 328 |
| `core-engine.spec.ts` | 113 |
| `delivery.spec.ts` | 15 |
| `outbox.spec.ts` | 2 |
| `passes.spec.ts` | 4 |
| `runtime-concurrency.spec.ts` | 56 |
| `store.spec.ts` | 17 |

Only an experimental SQLite warning was reported. There were no observed loading errors.

**What this supports**

- Application admission rules and negative cases.
- Duplicate intake and source-filter dispositions.
- Worker capacity and background-work lifecycle accounting.
- Selected retry, cancellation, restart-delivery, outbox, and store behavior.

**What it does not support**

The runtime fixture substitutes GitHub, Feishu, git, commands, subprocesses, agents, jobs, and subagents. Therefore these tests do not establish working external accounts, actual repository execution, live Harness integration, or successful model-generated code.

Sources: [engine fixture, lines 1–94](../upstream/superagent/tests/core-engine.spec.ts#L1-L94), [host fixture, lines 1–200](../upstream/superagent/tests/fixtures/host.ts#L1-L200), [concurrency cases](../upstream/superagent/tests/runtime-concurrency.spec.ts#L264-L395).

### 4.2 DeepSeek Harness

**Prerequisites observed**

- Node requirement: `>=24.9.0`; observed Node `v24.14.1`.
- Required package manager: `pnpm@11.28.5`.
- Harness-owned `node_modules` was initially absent.
- Default test command first builds a native system component.
- Real-API end-to-end tests use a separate command.

Sources: [manifest](../upstream/harness/package.json#L7-L10), [test commands, lines 58–73](../upstream/harness/package.json#L58-L73), [development setup, lines 27–39](../upstream/harness/docs/development.md#L27-L39).

**Preparation attempted**

```sh
cd upstream/harness &&
pnpm --version &&
pnpm install --frozen-lockfile --ignore-scripts
```

Corepack began obtaining the correct pinned pnpm version. Installation verified the lockfile and progressed through package materialization:

- **1,755 lockfile entries** checked by the supply-chain policy.
- **1,434 packages** selected.
- Last observed progress: **434 downloaded, 117 reused, 555 added**.

**Receipt:** installation completion and exit status **unknown**. It was still running at the last worker observation. Slow registry warnings were not evidence of failure.

Because scripts were suppressed, required native/lifecycle preparation was not established even if package installation subsequently completed.

**Behavioral tests executed: 0.**

No agent-loop, security, cancellation, persistence, or recovery suite was run. No live-model task was run. Existing candidate test files were located, but their presence is not coverage evidence.

This is an **unresolved prerequisite and incomplete investigation**, not a Harness behavior failure. It is also not a successful operational-readiness result.

### 4.3 EstaCoda

**Preparation**

- Node: `v24.14.1`.
- Runner: Vitest `v4.1.6`.
- Existing root `node_modules` symlink to the developer installation used only for EstaCoda tests.
- No clean dependency installation or independent lockfile verification performed.
- Test setup creates an isolated temporary HOME.

Sources: [Vitest configuration](../vitest.node.config.ts#L3-L17), [test setup](../src/test/vitest-setup.ts#L1-L4), [isolated HOME](../src/test/state-home.ts#L1-L10).

**Executed command**

```sh
node --version && node node_modules/vitest/vitest.mjs run \
  --config vitest.node.config.ts \
  src/delegation/durable-delegation-service.test.ts \
  src/delegation/toolset-security.test.ts \
  src/tasks/task-scheduler.test.ts \
  src/tasks/task-result-service.test.ts \
  src/security/dispatch-authorization.test.ts \
  src/runtime/completion-admission.test.ts \
  src/runtime/provider-turn-loop.test.ts
```

**Receipt:** exit **0**; **7 files passed, 329 tests passed, 0 failed**; reported duration **7.63 seconds**. No skipped tests were reported in the final summary.

**Particularly useful passing cases**

- Child authority does not widen on inheritance or replay.
- Untrusted workspaces and unavailable access fail admission.
- Durable graphs and primary Results survive restart.
- Partial synthesis uses accepted evidence; no accepted evidence fails closed.
- Expired, cancelled, or stale parents cannot create children.
- Approval revocation fences execution even across identical regrant.
- Uncertain/non-idempotent work pauses for operator review.
- Late completion after cancellation is rejected.
- Missing/empty required Results are rejected.
- Result tampering and symlink substitution are rejected.
- Result publication rolls back atomically on persistence failure.
- Provider-loop failure budgets are scoped and completion admission rejects explicit incomplete-work claims.

These tests use local fixtures/fakes; scheduler and delegation tests combine SQLite-backed state with fake execution. They do not verify a real provider, live messaging system, or real Docker environment.

Sources: [delegation tests](../src/delegation/durable-delegation-service.test.ts), [toolset security tests](../src/delegation/toolset-security.test.ts), [scheduler tests](../src/tasks/task-scheduler.test.ts), [Result tests](../src/tasks/task-result-service.test.ts), [provider-loop tests](../src/runtime/provider-turn-loop.test.ts).

### Interpretation of the receipts

**535 versus 329 is not a quality ranking.** Test granularity, parameterization, scope, fixtures, and implementation differ. Likewise, the reported test durations are not agent throughput measurements.

Harness’s zero executed tests indicate an evidence gap, not zero capability. No loading or preparation problem has been counted as a behavioral failure.

---

## 5. Strengths and weaknesses

### 5.1 Superagent application

**Strengths**

1. **Concrete workflow focus.** Trigger, thread, ticket, worker, and delivery responsibilities are explicit.
2. **Admission provenance.** The policy distinguishes sources, sender types, explicit requests, inferred candidates, and recorded mandate bases.
3. **Realistic capacity accounting.** Startup reservations prevent asynchronous oversubscription; shell jobs and subagents continue to consume capacity after a model turn ends.
4. **Practical delivery mechanics.** Durability barriers, history loading, cancellation, paused processing, and delayed source availability receive targeted tests.
5. **Per-ticket continuity.** A stable `worker-<ticketId>` identity supports persistent worker context.

Sources: [policy](../upstream/superagent/src/policy.ts#L167-L236), [worker mapping and lifecycle constants](../upstream/superagent/src/executor/dsh.ts#L1-L56), [worker slots](../upstream/superagent/src/executor/dsh.ts#L160-L200), [outbox tests](../upstream/superagent/tests/outbox.spec.ts#L17-L30).

**Weaknesses and tradeoffs**

- Alpha runtime dependency coupling and the inspected version mismatch create integration risk.
- Policy is more nuanced than “only allowlisted humans can influence work”: followed threads, inferred admissions, configured bots, and system paths matter.
- Human follow-ups may consume **one extra worker slot** beyond the configured limit; operators must understand that exception.
- Transient-error classification partly matches error text.
- Prepare failures intentionally avoid automatic retry because partial directories could be mistaken for completed preparation.
- External exactly-once delivery and hostile-input containment remain unproven.

The executor specifies three transient retry attempts with an initial 15-second backoff, a 10-minute preparation timeout, a 30-minute post-turn background-work limit, and a 10-second shutdown stop allowance. These are implementation choices, not measured optimal settings. See [executor, lines 27–56](../upstream/superagent/src/executor/dsh.ts#L27-L56).

### 5.2 DeepSeek Harness

**Strengths**

- A substantive request/stream/tool driver.
- Plugin-scoped tool registration and restriction structures.
- Documented durable event and extension architecture.

**Limits of this investigation**

Approvals, platform isolation, skills, subagent authority inheritance, persistence edge cases, credentials, channels, and provider compatibility were not sufficiently inspected. Package inventories cannot substitute for those audits.

See [tool service](../upstream/harness/packages/core/tools/src/index.ts#L1-L65), [architecture documentation](../upstream/harness/docs/architecture.md#L1-L110), [package inventory](../upstream/harness/AGENTS.md#L19-L89).

### 5.3 EstaCoda

**Strengths**

1. **Persisted, governed delegation:** work is represented as authority-bounded Task graphs.
2. **Explicit uncertainty handling:** retry-safe work can recover; uncertain side effects require operator review.
3. **Revocation and cancellation fencing:** prior authority does not remain valid merely because execution began.
4. **Result acceptance and integrity:** successful prose is distinct from an accepted, authorized, intact Result.
5. **Inspectable learning and memory mechanisms:** these have identifiable records, policy gates, and checkpoint surfaces.

Sources: [delegation service](../src/delegation/durable-delegation-service.ts#L150-L230), [dispatch tests](../src/security/dispatch-authorization.test.ts), [Result tests](../src/tasks/task-result-service.test.ts), [skill learning](../src/skills/skill-learning.ts#L32-L180), [memory curation](../src/memory/memory-curation-service.ts#L80-L195).

**Weaknesses and tradeoffs**

- Durable state does not guarantee an eligible execution host is running.
- Operator review deliberately interrupts autonomy when side effects are uncertain.
- A comparable GitHub issue-to-worker-to-result path was not established by this investigation.
- Memory retention, recall, privacy filtering, and workflow-learning effectiveness remain unbenchmarked.
- Task recovery does not establish seamless recovery of every chat session or provider history.
- The existing developer dependency environment is weaker reproducibility evidence than a verified clean installation.
- Credential confinement remains unresolved.

Learning infrastructure is not proof of self-improvement. Memory infrastructure is not proof of correct recall.

---

## 6. Security and deployment implications

### Separation is not containment

A separate session, worktree, or workspace helps organize work and reduce accidental context mixing. It does not establish protection from hostile code.

For superagent, per-ticket separation is evidenced; kernel, container, network, and credential boundaries are not.

For EstaCoda, host-mode source explicitly reports:

- `filesystemContainment: false`.
- `networkContainment: false`.
- Unrestricted command networking.
- Unverified limits.

It also rejects unauthorized fallback and unsupported mandatory controls. This is useful security honesty, not host containment. See [host authority, lines 8–38](../src/execution/host-authority.ts#L8-L38).

EstaCoda’s Docker implementation inspects image/user/owner identity, read-only root filesystem, dropped capabilities, no-new-privileges, network/namespace settings, workspace mounts, resource limits, and cleanup receipts. **No real Docker execution or Docker tests were run here.** See [Docker implementation](../src/execution/docker-container.ts).

### Admission is not prompt-injection resistance

Sender authorization answers who or what may enter a workflow. It does not establish that repository content, issue text, tool output, or a permitted user cannot induce unsafe actions.

Neither investigation performed a controlled adversarial prompt-injection or secret-exfiltration exercise. No such protection should be inferred from policy test success.

### Delivery guarantees stop at inspected boundaries

Superagent’s tested retries and deduplication do not prove universal exactly-once external delivery. EstaCoda’s tested atomic Result publication does not prove a remote channel received a message.

Production validation should inject crashes:

1. Before and after durable intake.
2. After external action but before acknowledgement persistence.
3. During worker startup and ownership transfer.
4. During Result publication and final delivery.
5. During cancellation while background jobs remain active.

### Deployment readiness remains unestablished

Superagent documentation requires application build/setup and Harness installation/configuration. Credentials, model-provider setup, profiles, and accounts were not configured during this investigation. See [setup](../upstream/superagent/SETUP.md#L16-L30) and [deployment instructions](../upstream/superagent/docs/006-deployment.md#L76-L85).

Harness also requires its pinned toolchain and native preparation. Installation completion was unresolved.

EstaCoda’s tested local developer environment does not establish a reproducible deployment or working live integrations.

For either stack, a pilot should use a disposable repository/workspace, least-privilege credentials, explicit spend/concurrency limits, verified execution boundaries, and operator-visible recovery states.

---

## 7. Prioritized ideas EstaCoda could adopt

These are design recommendations derived from observed mechanisms, **not claims that EstaCoda lacks every equivalent feature**.

| Priority | Idea | Why it is worth adopting or validating | Acceptance criterion |
|---|---|---|---|
| **P0** | **First-class repository workflow adapter** | Superagent makes the intake → admission → ticket → worker → delivery path explicit. EstaCoda’s comparable path was not established here. | Demonstrate authorized and denied requests, duplicate intake, worker execution, cancellation, restart, and final repository-facing delivery in a disposable repository. |
| **P0** | **Persist admission provenance through revalidation** | Explicit/inferred strength and recorded mandate basis make autonomous admission explainable. | Persist source, sender class, admission basis, policy revision, and later revocation/revalidation decisions; test stale authority. |
| **P0** | **Account for background work in capacity** | A finished model turn does not mean shell jobs or subagents stopped. | No oversubscription under concurrent startup; active jobs/children retain capacity; any follow-up exception is explicit and bounded. |
| **P1** | **Crash-tested ingress/outbox contract** | Pause/resume, history retry, and source availability are practical failure modes. | Fault-injection tests expose duplicate/loss windows and document actual transport guarantees. |
| **P1** | **Stable work-item/session mapping** | Persistent ticket identity can simplify follow-ups and work ownership. | Stable mapping survives restart without cross-ticket context or authority leakage; workspace preparation is idempotent or clearly marked uncertain. |
| **P1** | **Runtime/version compatibility receipts** | The alpha/RC mismatch illustrates why “app tested” and “stack tested” must remain distinct. | Record app revision, runtime revision, provider adapter, lockfile, execution mode, and successful integration checks together. |
| **P1** | **Typed retry and preparation states** | Superagent’s refusal to retry partial preparation identifies a real hazard; text-based retry classification is fragile. | Retry decisions use structured error categories and durable preparation receipts rather than directory existence alone. |
| **P2** | **Lifecycle/operator dashboard** | Capacity, pending delivery, uncertain effects, approvals, and cleanup need a coherent operational view. | Every stalled work item has an inspectable state, owner, reason, next action, and bounded recovery policy. |

Preserve EstaCoda’s tested access ceilings, revocation fences, accepted-Result distinction, and operator review for uncertain side effects while adopting workflow convenience. A shorter “issue to agent” path should not bypass those controls.

---

## 8. What would establish a real comparative winner?

Run two separate evaluations.

### A. Runtime/workflow reliability benchmark

Use deterministic scripted model responses and identical tool outcomes where feasible. Exercise:

- Duplicate and out-of-order requests.
- Authorization revocation during execution.
- Startup races and concurrency saturation.
- Worker crash and host handoff.
- Cancellation with active subprocesses.
- Provider timeout/rate limiting.
- Partial workspace preparation.
- External action followed by lost acknowledgement.
- Partial worker evidence and failed synthesis.
- Corrupted or substituted result artifacts.

Judge predefined invariants and recovery outcomes, not native test counts.

### B. Live coding benchmark

Hold constant:

- Exact model/version and provider endpoint.
- Repository snapshot and tasks.
- Token, spend, wall-clock, retry, and concurrency budgets.
- Available tools and network access.
- Execution isolation and credentials.
- Persistent-memory/learning conditions.
- Success criteria, hidden tests, and human-review rubric.

Measure accepted task completion, correctness, regressions, unsafe actions, intervention rate, latency, tokens, and actual billed cost. Repeat trials and report uncertainty.

Run both clean-state and persistent-state tracks if memory or learning is enabled. Otherwise one system may receive accumulated context unavailable to the other.

**Until then, no live coding-performance or cost winner is justified.**

---

## 9. Material research limitations

1. **Harness behavioral verification did not complete.** Installation had no terminal receipt, native prerequisites were unestablished, and zero behavior tests ran.
2. **No complete stack was deployed.** Application tests used host fixtures; the independently inspected Harness revision differs from the application’s declared development dependencies.
3. **Public positioning was not independently refreshed.** The research-prototype/not-official-product disclaimer came from the supplied brief; local manifests and interfaces verify the software-layer distinction.
4. **No live-model comparison occurred.** No coding-quality, latency, token-use, or cost ranking is supported.
5. **No live external integration was exercised.** GitHub, Feishu, messaging, webhook, and cron operation remain unverified here.
6. **No real containment test occurred.** Neither hostile-code isolation nor Docker enforcement was operationally validated.
7. **Credential assurance is incomplete.** Harness credential behavior was not audited; EstaCoda’s secret-broker read was unsuccessful.
8. **Learning and memory effectiveness are unresolved.** Source mechanisms were inspected, not their end-to-end quality or privacy outcomes.
9. **Recovery findings have narrow scope.** Task/Result restart tests do not establish whole-process, whole-session, or every external-side-effect guarantee.
10. **Only targeted tests ran.** Full suites, builds, typechecks, and reproducible clean deployments were not established across all projects.
11. **Some exploratory tool attempts failed.** Those attempts provide no positive or negative capability evidence.
12. **Evidence confidence is asymmetric.** EstaCoda’s deeper verified governance coverage here is not proof that Harness lacks comparable mechanisms; those runtime paths remain unresolved.

## Final recommendation

Treat **superagent as a focused research application worth studying for repository-workflow design**, and **Harness as its substantive but incompletely verified runtime foundation**.

Treat **EstaCoda as having credible deterministic evidence for durable, authority-bounded delegation and Result handling**, while retaining explicit reservations about integrations, credentials, isolation, memory quality, and deployment readiness.

The practical next investment is to combine workflow clarity with governance: a traceable repository adapter, background-aware capacity, crash-tested delivery, and versioned execution receipts—then evaluate both complete stacks under the same controlled conditions.