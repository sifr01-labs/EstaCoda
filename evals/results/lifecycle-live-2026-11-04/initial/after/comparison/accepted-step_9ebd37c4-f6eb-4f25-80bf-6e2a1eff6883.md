dsh-superagent is a research prototype, not an official DeepSeek product. Its workflow and EstaCoda’s controls show strengths; coding superiority remains untested.

# Superagent + Harness vs. EstaCoda

**Benchmark date:** 2026-11-04 UTC
**Assessment type:** pinned-source comparison and selected deterministic regression tests; **not a live-model coding benchmark**.

## Executive summary

**What dsh-superagent actually is:** a proactive, single-repository application packaged as a DeepSeek Harness bundle—not a standalone replacement for an agent runtime. Its README explicitly calls it a **“Research prototype for reference only, not an official DeepSeek product,”** warns that it is not production-ready, and says the published code differs from the internal implementation and accompanying article. Some article designs remain future directions. [S1]

The appropriate comparison is therefore **Superagent + Harness versus EstaCoda**, including the runtime services each application needs. This report uses that comparison boundary, but the delegated **Harness-runtime investigation failed and supplied no accepted evidence**. Consequently, the Superagent side has verified application-level evidence but incomplete underlying-runtime coverage. An unverified Harness capability must not be treated as absent.

Within that limitation:

- **Superagent’s clearest demonstrated strength is a focused team/repository workflow:** source-native intake, explicit and inferred mandates, durable tickets, persistent workers, human-priority concurrency, interruption recovery, and deduplicated delivery. Its versioned prompts and team skills are concrete implementation features. [S2–S6]
- **EstaCoda’s clearest demonstrated strengths are general durable orchestration and inspectable controls:** Task graphs, leases and fencing, approval lifecycle, scoped child tools, provider-spend reservations, optional Docker policy, and governed skill/memory records. [E1–E7]
- **Neither side has demonstrated superior coding intelligence, production reliability, or cost efficiency in this assessment.** Selected tests passed, but the suites exercise different behavior, use different fixtures, and were not matched coding tasks.
- **Neither should be described as sandboxed by default on this evidence.** Superagent’s inspected session path selects `danger-full-access`; EstaCoda’s execution policy defaults to host execution. EstaCoda has optional Docker containment machinery, but no container launch was exercised here. [S4; E4]

**Practical conclusion:** Superagent is a credible prototype for a focused repository-team workflow; EstaCoda has substantial source-level machinery for broader orchestration, governance, and reusable workflows. Choosing a coding winner requires a controlled live trial—not a test-count comparison.

## 1. Provenance, freshness, and coverage

### 1.1 Revision pins

| Subject | Revision or version | Provenance and qualification |
|---|---|---|
| dsh-superagent application | `8c32a9dc5d72c033816c6a8110b37f40cf94fba4` | Recorded in inspected `UPSTREAM.json`, as reported by the accepted application investigation. |
| Harness runtime | **Not established by accepted evidence** | Its delegated investigation failed. No runtime revision, implementation findings, or tests from that scope are credited here. |
| EstaCoda | `9a8d571ef7455b612c7d37607eaa8570af3dfd31` | Coordinator-supplied subject revision; the EstaCoda investigator did not independently rerun Git verification. |
| EstaCoda package metadata | `0.1.0`; Node `>=22.18.0`; pnpm `10.33.0` | Observed root `package.json`; not a latest-release claim. |

The pins describe the research subjects, not currently deployed services. The research-workspace `AGENTS.md` identifies these as **source research fixtures**, not deployments.

### 1.2 Project identity and public URLs

The inspected Superagent README provides this Harness landing-page link:

**https://www.deepseek.com/en/harness/** — `upstream/superagent/README.md:7`. [S1]

This is a source-observed link, **not a live-verified canonical Superagent repository URL**. Local inspection did not establish a canonical Superagent repository URL or article URL. The README names *Exploring Super-agent Design: Towards a More Autonomous Agent System*, but no article HTTP(S) URL was established. No repository URL is inferred from naming conventions.

**Launch date, latest release, current public availability, and retirement status are unverified because network access was disabled.** No freshness guarantee beyond the inspected snapshots is implied. In particular, this report establishes neither managed-service availability nor a currently supported self-deployment offering.

### 1.3 Accepted research coverage

| Scope | Outcome | Evidence admitted |
|---|---|---|
| `superagent-application` | Completed | Application source inspection and two selected test runs |
| `estacoda-runtime` | Completed | EstaCoda source inspection and three selected test runs |
| `harness-runtime` | **Failed** | **None**; diagnostic/unaccepted material excluded |

These scopes are not independent corroboration of one another. Superagent application calls into Harness establish dependencies and application intent; they do not independently prove Harness internals.

### 1.4 Evidence categories

- **Source inspection:** implementation exists in the pinned snapshot; it may still require configuration, integration, or external services.
- **Deterministic tests:** selected code paths passed with the fixtures and substitutions described below.
- **Runtime observations:** local test processes ran successfully. No deployed product or live inference was established.
- **Inference:** architectural or operational implications, explicitly qualified.
- **Unperformed benchmarks:** no live-model coding contest, real model-generated PR trial, provider-billing comparison, deployed-channel exercise, or production-load test was performed.

A supplied historical configuration observation named Codex / `gpt-6.1-sol` for EstaCoda. It was not independently inspected by the accepted investigator and does **not** establish current routing, readiness, or successful inference.

## 2. Implementation comparison

Paths beginning `upstream/superagent/` refer to Superagent; EstaCoda paths are relative to its root. Citations use inspected line ranges where supplied and named symbols where exact line ranges were not reported.

### 2.1 Autonomy and work intake

**Superagent + Harness**

`Intake.receive` normalizes trigger timestamps, rejects threadless inputs, deduplicates stored trigger IDs, records filtered events, and correlates incoming messages with tickets. Human follow-ups on non-context threads can resume ended tickets; bots/CI cannot do so through that path. Human-stopped tickets receive no further inputs. [S2]

Its autonomy is policy-bound rather than unconstrained:

- `settingsPolicy().gate` considers source-native identity, sender lists, addressing, observation scope, admission cells, and ticket participation.
- Inferred work requires automatic mode, at least one matched rule, and every matched rule still enabled.
- `directionAllowed` checks implementation intent, an established target, and no open design decisions.
- `revalidate` reevaluates authorization conditions, but its explicit-follow-up branch preserves those mandates; it is not universal sender-list revocation. [S3]

**Strength:** an unusually concrete implementation of “proactive”—including negative cases and human-stop semantics.

**EstaCoda**

`DurableDelegationService.create` requires a trusted workspace, bounds delegation batches, records allowed toolsets, and constructs durable Task graphs. It prevents required research synthesis from being disabled and constrains synthesis output paths. `runDelegatedChild` actually invokes the child runtime, renews heartbeats, relays progress, and handles timeouts. [E1]

Cron source integrates execution authority, workspace trust, locking, and durable execution records. `tickCron` advances the schedule under lock before execution, helping avoid duplicate dispatch; that is not proof of exactly-once execution or guaranteed missed-run recovery. [E6]

**Strength:** broader orchestration primitives for research, execution, and scheduled work.

**Comparison:** Superagent has stronger accepted evidence for a focused event-to-repository workflow; EstaCoda has broader accepted evidence for durable general-purpose orchestration. This is an architectural distinction, not a coding-performance result.

### 2.2 Durability, recovery, and cancellation

**Superagent + Harness**

Application storage uses SQLite `DatabaseSync`; the engine wraps state transitions in `repo.atomic`, and `DshExecutor` queues launches and deliveries through durable `Effects`. [S4]

`assignmentInterrupted` distinguishes work requiring restart from qualifying waiting/ready/blocked/failed states whose session/state can be retained. Execution code provides:

- three attempts for transient network/provider failures, with a 15-second initial backoff;
- immediate failure on workspace preparation errors, avoiding reuse of a dirty partial directory;
- a 30-minute background-continuation bound;
- a 10-second shutdown-wait bound. [S4]

The outbox records pending/sent/dropped delivery state. `AgentDelivery` uses request-ID deduplication. [S5]

**EstaCoda**

The scheduler and SQLite store represent ownership, leases, dispatch grants, concurrency, atomic graph creation, and accepted durable results. Passing scheduler tests cover stale grants, competing dispatch, cancellation races, publication rollback, progress fencing, retry-safe crash recovery, and approval pause/resume. [E1–E2]

A particularly important safety behavior is **pausing uncertain non-idempotent work for operator review**, rather than automatically replaying it. [E2, `task-scheduler.test.ts:582`]

**Tradeoffs:** Superagent’s recovery is specialized around ticket/session continuity. EstaCoda exposes broader durable execution semantics, but cooperative abort does not prove hard termination of every process descendant. Neither implementation establishes universal exactly-once external effects or automatic rollback of already-issued actions.

### 2.3 Security, approvals, and workspace isolation

**Superagent + Harness**

The application separates admission, human attention/hold, and tool execution. These must not be conflated.

`Sessions.ensure` selects **`danger-full-access`**. Worker tool lists omit some application APIs, but include shell/files and related capabilities. An omitted API does not prove equivalent actions cannot be achieved through shell access. Persistent worker sessions and per-ticket worktree directories are useful organization—not demonstrated security containment. [S4]

**Implication:** the inspected path assumes substantial trust after admission. Human attention and stop/resume workflows are not universal approval gates around side effects. Harness-level enforcement remains an evidence gap.

**EstaCoda**

Accepted source evidence includes:

- effective child-tool allowlists and role/depth restrictions; [E3]
- tested durable approval pause/resume and sibling cleanup on denial; [E2]
- a dedicated credential pipe with bounded frames, exact parameter validation, and disposal behavior; [E3]
- execution-policy parsing that defaults to **host**, rejects unsupported backends without authorized host fallback, and requires immutable `sha256` image IDs for Docker; [E4]
- Docker configuration for a read-only root filesystem, dropped capabilities, no-new-privileges, default-disabled network, explicit user, and inspection verification. [E4]

**Important limits:** Docker policy tests passed, but no Docker daemon/container launch was performed. Child-tool security tests themselves were not among the executed suites. No exhaustive audit of credential sinks, host subprocesses, desktop routes, or channel adapters occurred.

**Comparison:** EstaCoda has more accepted evidence of explicit containment and credential-control machinery. That does not establish that every deployment enables it or that Harness lacks comparable controls.

### 2.4 Skills, memory, and “learning”

**Superagent + Harness**

`bundledSkills` supplies GitHub and Feishu skills. `Prompts.skills` / `composeSkill` combine built-in and custom team skills. Prompt configurations are versioned through `Versions`, support preview/validation, and detect stale revisions through `PromptConflict`. Session prompt revisions and permitted revision reads are tracked. [S6]

**Strength:** inspectable, versioned operational customization.

**Not established:** automatic workflow-learning promotion, semantic cross-task memory curation, or evaluated autonomous skill improvement. `MemoryRepositories` is not evidence of lifelong semantic memory merely because of its name.

**EstaCoda**

Skill source defines lifecycle decisions, governed proposals, evaluation records, promotion states, rollback expectations, and telemetry. Memory curation represents explicit `USER.md` / `MEMORY.md` operations, scanning/redaction, checkpointing, and auto-applied versus pending-review outcomes. Selected lifecycle, evolution, learning, and memory tests passed. [E7]

**Strength:** richer inspectable governance around changes to reusable behavior.

**Limits:** some configured memory modes can auto-apply changes; not every change necessarily receives human approval. No held-out study established beneficial learning, poisoning resistance, or improved future coding success. This is application-level learning machinery, not model-weight training.

### 2.5 Providers, budgets, and costs

**Superagent + Harness**

`initializeRoleModel` separates orchestrator and worker model selection. `RetryHealth` / `budgetFailure` project provider-budget exhaustion into retry/session health. [S7]

That establishes **application-level budget observability**, not independent cost enforcement. Harness-level enforcement is unknown because its scope failed.

**EstaCoda**

`prepareProviderSpend` prepares spending authority before provider execution. Passing tests cover:

- durable reservation before adapter entry and settlement using actual usage;
- zero-spend denial before adapter invocation;
- unknown pricing failing closed when an applicable limit exists;
- parallel reservation protection;
- retained uncertain reservations after post-dispatch exceptions;
- failure when attributed execution lacks a spend controller. [E5]

**Tradeoff:** conservative uncertain reservations protect budgets but can temporarily reduce usable capacity. Protection depends on configured limits and pricing/bounds. No invoice accuracy, dollar cost per completed task, or comparative token efficiency was measured.

### 2.6 Ergonomics and operational fit

**Superagent’s supported advantages**

- Coherent ticket-centered workflow rather than a collection of unrelated tools.
- Per-item routing refusals: one batch failure need not discard other items.
- Persistent sessions and ticket/worktree naming.
- Human-follow-up capacity: `WorkerSlots` permits one extra slot for human follow-up.
- Versioned team prompts and skills. [S2, S4, S6]

**EstaCoda’s supported advantages**

- Explicit Task graphs, scoped delegation, durable result acceptance, and progress.
- Inspectable approval, spending, recovery, and skill-change records.
- Execution-policy options and broader scheduled-work machinery. [E1–E7]

**Inference:** Superagent’s narrower workflow may be easier to reason about for a repository team, while EstaCoda’s broader configuration surface may suit varied workflows at the cost of more operational choices. Neither ease of use nor operator time was measured. Channel adapter inventories are not proof of configured integrations.

## 3. Executed test receipts

Investigators inspected test configuration before execution and invoked Vitest directly. No installs, package lifecycle scripts, external service calls, credential inspection, or source modifications were reported.

### 3.1 Superagent application

**S-A — `superagent-core-policy-store`**

```sh
cd upstream/superagent && node node_modules/vitest/vitest.mjs run tests/core-engine.spec.ts tests/policy.spec.ts tests/store.spec.ts
```

Receipt: successful tool response (`ok=true`); **3 files, 458 tests passed**, no reported failures/skips; **373 ms**.

**S-B — `superagent-runtime-recovery`**

```sh
cd upstream/superagent && node node_modules/vitest/vitest.mjs run tests/runtime.spec.ts tests/runtime-concurrency.spec.ts tests/effects.spec.ts tests/outbox.spec.ts tests/delivery.spec.ts
```

Receipt: successful tool response; **5 files, 177 tests passed**, no reported failures/skips; **7.53 s**.

**Selected total: 8 files, 635 passed tests.**

The core tests use `MemoryRepositories`, mocked assessors/executors, and deterministic clocks. Runtime tests use real application/SQLite state but stub host services, GitHub/Feishu commands, sessions, agents, and delivery. They are not real Harness/model sessions or model-coded PRs. [S8]

### 3.2 EstaCoda

**E-A — `estacoda-durable-task-security-recovery`**

```sh
node node_modules/vitest/vitest.mjs run --config vitest.node.config.ts src/tasks/task-scheduler.test.ts src/tasks/sqlite-task-store.test.ts src/tasks/task-approval-service.test.ts src/delegation/delegate-call-budget.test.ts --reporter=dot
```

Receipt: successful tool response; **4 files, 95 tests passed**, no reported failures/skips; **6.24 s**.

**E-B — `estacoda-cost-execution-credential-boundaries`**

```sh
node node_modules/vitest/vitest.mjs run --config vitest.node.config.ts src/providers/provider-spend-enforcement.test.ts src/tasks/provider-spend-cross-process.test.ts src/execution/docker-policy.test.ts src/execution/host-execution-bounds.test.ts src/security/plaintext-credential-guard.test.ts src/control-service/credential-pipe.test.ts --reporter=dot
```

Receipt: successful tool response; **6 files, 55 tests passed**, no reported failures/skips; **2.82 s**.

**E-C — `estacoda-skill-memory-channel-lifecycle`**

```sh
node node_modules/vitest/vitest.mjs run --config vitest.node.config.ts src/skills/skill-lifecycle.test.ts src/skills/skill-evolution.test.ts src/skills/skill-learning.test.ts src/memory/memory-curation-service.test.ts src/channels/channel-state-recovery.test.ts --reporter=dot
```

Receipt: successful tool response; **5 files, 68 tests passed**, no reported failures/skips; **579 ms**.

**Selected total: 15 files, 218 passed tests.** Test setup redirects `HOME` to a temporary directory.

### 3.3 Exit-status precision and failures

For **all five commands**, the accepted reports describe successful terminal receipts and completed passing Vitest summaries. **A separate numeric process-exit field was not exposed.** Success is consistent with normal exit 0, but this report does not claim an independently captured literal `exit_code=0` receipt.

Other outcomes:

- Superagent emitted Node’s SQLite experimental-feature warning.
- A Superagent directory-inspection attempt was denied as outside the trusted workspace. This was an inspection failure, not a failed test or proof of absent dependencies.
- An EstaCoda inspection helper failed when it attempted an unavailable `file.grep`; subsequent inspection used exposed read/grep tools. This was not a test failure.
- No selected test was reported failed or skipped; no missing prerequisite blocked the selected runs.
- Full suites, builds, and typechecks were not performed.
- **Harness-runtime coverage failed at the research-scope level**, not as a reported failed Harness test.

**The totals and durations are not comparable performance scores.** Different suites test different behaviors; their speed says nothing about live coding latency or intelligence.

## 4. Actionable recommendations

### For a team evaluating Superagent + Harness

1. **Treat it as a prototype.** Preserve the README disclaimer in adoption materials and distinguish article aspirations from implemented behavior.
2. **Complete the Harness audit before deployment decisions.** Pin its runtime revision and verify permission enforcement, containment, credential handling, provider budgets, process termination, and recovery with accepted evidence.
3. **Make high-trust execution visible.** Surface `danger-full-access`, active mandate, workspace, and effective authority to operators. Evaluate narrower execution profiles rather than assuming admission alone is sufficient.
4. **Exercise external side effects end to end.** Verify PR creation, branch authorization, duplicate webhooks, provider failures, process restart, and notification retries in disposable repositories.
5. **Keep its workflow strengths.** Human-stop semantics, auditable filtered events, per-item refusals, and human-priority concurrency are valuable design patterns.

### For EstaCoda

1. **Expose the active execution boundary prominently.** Report host versus Docker and distinguish requested policy from verified containment.
2. **Document uncertain-effect recovery.** Show why a Task paused, what may already have happened, and what an operator must reconcile.
3. **Make spending uncertainty actionable.** Display limits, pricing assumptions, reservations, retained uncertain usage, and safe reconciliation procedures.
4. **Evaluate learning quality separately from lifecycle correctness.** Use held-out tasks, regression checks, poisoning cases, and rollback criteria before promoting learned skills.
5. **Close integration gaps.** Exercise Docker launches, deployed providers/channels, packaging, and the complete file-edit → test → artifact-validation path. Source inventories and selected tests do not substitute for those checks.

### For selection

Prefer a **Superagent + Harness pilot** when the dominant requirement is a focused, high-trust repository-team workflow. Prefer an **EstaCoda pilot** when durable multi-step delegation, explicit governance, optional containment policy, and reusable workflow records are central.

These are fit hypotheses based on inspected architecture—not procurement-grade reliability findings or a declaration that one codes better.

## 5. Proposed controlled head-to-head coding benchmark

**This protocol is a future experiment. It was not run.**

### A. Freeze and disclose the systems

- Pin Superagent, Harness, EstaCoda, dependencies, OS/container images, and repository commits.
- Record exact model versions, provider endpoints, region, generation settings, context limits, and availability.
- Publish effective tools, permissions, network access, skill versions, memory state, and concurrency.
- Complete the missing Harness-runtime verification before interpreting security or budget comparisons.

### B. Separate two experimental tracks

1. **Matched-model track:** use the same model/provider and comparable tools where supported, to isolate orchestration effects as far as practical.
2. **Native-system track:** use each system’s documented configuration, fully disclosing differences. Interpret results as whole-system performance, not model intelligence.

If a matched model is unavailable, report that limitation rather than silently substituting.

### C. Use a preregistered task set

Choose unseen, independently reviewable repository tasks across bug fixes, features, refactors, dependency/API migrations, and test repair. Freeze requirements and hidden tests before runs. Include tasks with ambiguity that should trigger clarification.

Use multiple repositories/languages, several runs per task, randomized execution order, fresh workspaces, and a declared contamination policy. Disable cross-trial memory in the main comparison. Study learning separately with identical prior exposure and held-out evaluation.

### D. Match resource and authority budgets

Set equal wall-clock, token, dollar, tool-call, retry, and concurrency ceilings. Count orchestration, workers, retries, and synthesis—not only the final coding call.

Use the same authorization envelope: sandbox, network allowlist, secret access, branch permissions, and approval rules. If equivalent containment is impossible, report that as a separate track difference.

### E. Measure outcomes, not activity

Primary measures:

- hidden functional-test success;
- blinded maintainer review of correctness, maintainability, and regressions;
- successful artifact delivery from the intended workspace;
- policy violations and unintended side effects.

Secondary measures:

- end-to-end time and actual provider usage/cost;
- human interventions and clarification quality;
- recovery after controlled failures;
- duplicate effects, incomplete work, and budget compliance.

Record numeric process exits explicitly in the benchmark harness.

### F. Exercise recovery and security independently

On disposable infrastructure, inject crashes before/after dispatch, duplicate events, lease expiry, provider timeouts, quota exhaustion, cancellation during writes, and uncertain publication.

Add controlled prompt-injection and permission tests involving repository text, untrusted messages, synthetic secrets, path traversal, approval revocation, and child-tool escalation. Use no real production secrets.

### G. Publish complete denominators

Report every attempt, timeout, refusal, approval wait, infrastructure failure, retry, and excluded run. Use paired comparisons and uncertainty intervals. Distinguish safe refusal from incorrect completion. Publish redacted traces, patches, hidden-test outcomes, and configuration manifests where permissible.

Do not collapse functional quality, security, cost, recovery, and usability into an unexplained “intelligence score.”

## 6. Material limitations and bottom line

This assessment establishes real implementation strengths and successful selected regressions. It does **not** establish a full-system winner.

The largest gaps are:

1. **Failed Harness-runtime coverage**, leaving its revision and internals unverified.
2. Disabled network access: canonical Superagent repository/article URLs, launch, latest release, and current availability remain unresolved.
3. Source-research fixtures rather than deployed services.
4. No live-model coding, real PR, provider-billing, Docker-launch, or deployed-channel benchmark.
5. Incomplete Superagent PR/branch authorization inspection and incomplete EstaCoda coding-tool end-to-end inspection.
6. Successful selected test receipts without separately exposed numeric exit codes.
7. No empirical user-experience or long-horizon learning-quality study.

**Bottom line:** Superagent’s accepted evidence is strongest around proactive repository teamwork; EstaCoda’s is strongest around durable orchestration and explicit governance machinery. Both deserve concrete evaluation. Neither has earned a coding-intelligence advantage from this report.

## Evidence references

References identify local source at the revisions above, not live web verification.

### Superagent application

- **[S1] Identity and packaging:** `upstream/superagent/README.md:3–7`; `upstream/superagent/package.json`, `description`, `dsh.bundle`, `peerDependencies`; inspected `UPSTREAM.json`.
- **[S2] Intake and routing:** `upstream/superagent/src/core/intake.ts`, `Intake.receive`; `upstream/superagent/src/app/tools/main.ts`, `route`, `routeTool`.
- **[S3] Admission and autonomy:** `upstream/superagent/src/policy.ts:190–242`, `settingsPolicy().gate`, `revalidate`; same file, `directionAllowed`.
- **[S4] Execution and recovery:** `upstream/superagent/src/app/store.ts:2,52,60`; `src/core/engine.ts`, `Engine`, `assignmentInterrupted`, `report`; `src/executor/dsh.ts`, `DshExecutor`, `WorkerSlots`, `workerSessionId`, `ticketWorktreeName`; `src/app/sessions.ts`, `Sessions.ensure`, `WORK_TOOLS`. Paths in this bullet after the first are relative to `upstream/superagent/`.
- **[S5] Delivery:** `upstream/superagent/src/app/store.ts:263–287`; `src/app/sessions.ts`, `relay`, `notify`, `AgentDelivery`; `src/core/engine.ts`, `report`.
- **[S6] Skills/prompts:** `upstream/superagent/src/app/skill-files.ts`, `bundledSkills`; `src/app/prompts.ts`, `Prompts.skills`, `composeSkill`, `Versions`, `PromptConflict`; `src/app/sessions.ts`, `promptVersion`, `mayRead`.
- **[S7] Providers:** `upstream/superagent/src/app/sessions.ts`, `initializeRoleModel`; `src/app/retry-health.ts`, `RetryHealth`, `budgetFailure`.
- **[S8] Test boundaries:** `upstream/superagent/tests/core-engine.spec.ts:1–85`; `upstream/superagent/tests/runtime.spec.ts:90–168`; exact executed suites listed in Section 3.

### EstaCoda

- **[E1] Durable execution:** `src/delegation/durable-delegation-service.ts:153,227–239,275,427,569,654–673`; `src/tasks/task-scheduler.ts:1–160`; `src/tasks/sqlite-task-store.ts:100–160`; `src/delegation/child-runner.ts:70–210`.
- **[E2] Recovery and approval tests:** `src/tasks/task-scheduler.test.ts:100,226,249,288,357,504,531,582,717,780,841,862,942,977,1095,1201,1363,1381,1467,1547,1622,1678`.
- **[E3] Tool and credential boundaries:** `src/delegation/toolset-security.ts:1–190`, `resolveChildToolAccess`, `applyChildToolAccessResult`; `src/control-service/credential-pipe.ts:1–57`, `attachCredentialPipe`.
- **[E4] Execution policy:** `src/tasks/task-workspace.ts:1–2`; `src/execution/docker-policy.ts:7–43`; `src/execution/docker-container.ts:70–120,141–183`; `src/delegation/child-runner.ts:148–159`.
- **[E5] Provider spending:** `src/providers/provider-spend-policy.ts:24,106–115`; `src/tasks/task-scheduler.ts:75–80`; `src/providers/provider-spend-enforcement.test.ts:62,113,163,179,205,227,253,315,346`; `src/tasks/task-scheduler.test.ts:1394,1449,1678`.
- **[E6] Proactive execution:** `src/cron/cron-runner.ts:1–31,47–64,116–160`; selected `src/channels/channel-state-recovery.test.ts`.
- **[E7] Skills and memory:** `src/skills/skill-lifecycle.ts:3–29`; `src/skills/skill-evolution.ts:138–207,266–315,439–450,628–665`; `src/memory/memory-curation-service.ts:1–44,114–190`.

### Accepted research-result provenance

- Superagent application: durable result `e355e737-8161-4314-a875-b4cf44483712`.
- EstaCoda runtime/source: durable result `f4c1d56a-f1fa-4e03-9703-9bcb3fa069a1`.
- Both belong to Task `task_52ab4608-0904-4bb4-ac0a-1d15e1945f8a`.
- Harness-runtime diagnostic material is excluded from the evidentiary basis.
