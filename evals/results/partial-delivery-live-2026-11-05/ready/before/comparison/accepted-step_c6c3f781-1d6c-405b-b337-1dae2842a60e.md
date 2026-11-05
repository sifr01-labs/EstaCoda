Superagent plus Harness shows substantial repository automation and recovery. Coding superiority over EstaCoda is unproven; EstaCoda evidence is incomplete.

# Superagent + DeepSeek Harness versus EstaCoda

## 1. Verdict and practical implications

**The inspected Superagent + Harness stack is a substantive implementation, not merely an agent prompt.** Superagent supplies a repository-team workflow: event intake, admission policy, assessment, durable tickets, worker assignments, background-aware scheduling, follow-up handling, and outbound delivery. Harness supplies the underlying agent loop, tool execution, plugin services, session recovery, and sandbox implementations. These layers must be evaluated together, without crediting the bundle for implementing its host runtime.[S1–S7][H1–H5]

**There is no defensible comparative winner against EstaCoda from this investigation.** The EstaCoda research dependency failed and produced no accepted evidence. Its implementation, fixture revision, tests, and deployment behavior therefore remain unverified in this report. That is a coverage failure—not evidence that EstaCoda lacks the capabilities documented on the other side.

Two deterministic validations succeeded:

- Superagent’s native suite: **59 files, 1,197 tests passed; exit 0**.
- A focused Harness selection: **4 files, 112 tests passed; exit 0**.[S8][H6]

These are different regression suites with different scopes. **Neither test counts nor execution times establish coding superiority, model intelligence, or relative product reliability.** No matched live-model benchmark was performed.

### Practical decision

- **For repository automation:** the inspected stack merits a controlled pilot, particularly where durable event-to-ticket processing, human follow-up priority, and restart recovery matter.
- **For replacing EstaCoda:** the evidence is insufficient. First complete EstaCoda inspection, then run matched behavioral and live-model evaluations.
- **For improving EstaCoda:** Superagent offers worthwhile design patterns to audit for or adopt—not proven missing features—including observation-before-automation, background-aware capacity accounting, explicit completion ownership, durable effects, and purpose-specific human notifications.
- **For production authorization and isolation:** require deployment-specific verification. Admission policy, worker tool restrictions, per-ticket directories, and host sandbox backends are distinct mechanisms. Their presence does not establish an end-to-end security guarantee.

## 2. Evidence coverage and limitations

### 2.1 Research coverage

| Assigned scope | Dependency outcome | Accepted evidence available | Consequence |
|---|---|---|---|
| `superagent-bundle` | Completed | Source inspection and native test receipt | Supports claims about the inspected bundle |
| `deepseek-harness-runtime` | Completed | Focused source inspection and selected test receipt | Supports claims about inspected host mechanisms |
| `estacoda-runtime` | **Failed** | **None** | No verified EstaCoda implementation comparison, revision, or test results |

The two successful scopes are complementary layers, **not independent corroboration of a deployed end-to-end system**. The bundle worker inspected host dependency boundaries; the Harness worker did not verify that every inspected host mechanism was activated correctly by the bundle.

An unaccepted EstaCoda diagnostic draft is not used as evidence. This report does not fill that gap with product descriptions, session identity instructions, training knowledge, or assumptions about unavailable source.

### 2.2 Evidence classes

This report distinguishes:

1. **Source inspection:** implementation and repository contracts observed in local fixtures.
2. **Executed deterministic tests:** actual worker-reported commands and outcomes, often using mocks or temporary local state.
3. **Live-model performance:** **not measured**.
4. **Inference and recommendations:** interpretations explicitly presented as such.

**Live web was unavailable during this research.** No current public upstream state, launch announcement, release chronology, or canonical remote URL was independently verified. The material supports a local-fixture analysis, not a current-market availability report.

No live GitHub/Feishu deployment, real model API task, or OS-level sandbox escape test was executed. No dependency installation or network retrieval was performed by the accepted workers.[S8][H6]

## 3. Identity, DeepSeek relationship, URLs, dates, and revisions

### 3.1 What is `dsh-superagent`?

The inspected package identifies itself as:

- **Name:** `dsh-superagent`
- **Version:** `0.1.0`
- **Author:** DeepSeek Harness Team
- **Package status:** private
- **License:** MIT, copyright 2026 DeepSeek Harness Team.[S1]

Its README explicitly states:

> “Research prototype for reference only, not an official DeepSeek product.”

It also warns that the publication differs from the internal implementation/article and that some article designs are future directions rather than implemented functionality.[S1]

The supported relationship is therefore **a locally attributed DeepSeek Harness Team research prototype built for DeepSeek Harness**, not proof of an official DeepSeek commercial product, hosted service, or the internal system described elsewhere.

“Private” is a package metadata field; it should not be interpreted as proof that the source is inaccessible or that a private hosted service exists.

Architecturally, Superagent is an **application/plugin bundle for Harness**, oriented toward one GitHub repository with optional Feishu integration. Package declarations and executor/session code show that it consumes Harness services rather than replacing the inference and tool-execution runtime.[S1][S4]

### 3.2 Canonical URL status

| Component | Exact verified canonical project URL | Qualification |
|---|---|---|
| `dsh-superagent` | **Unresolved** | None established from inspected package metadata, README, targeted Markdown search, or observed remote metadata |
| DeepSeek Harness | **Unresolved in accepted evidence** | The host investigation established implementation details, not an authenticated canonical remote |
| EstaCoda | **Unresolved in accepted evidence** | Its research scope failed |
| Related launch/article URL | **Unresolved** | README references an article/internal implementation, but no verified canonical article URL was established |

No guessed GitHub URL is supplied. In particular, the GitHub URL examples in Superagent’s deployment documentation refer to the **operator’s target repository**, not necessarily Superagent’s source origin.[S1]

### 3.3 Revision and date ledger

| Component or date | Evidence | What it establishes—and does not |
|---|---|---|
| Superagent fixture revision | `8c32a9dc5d72c033816c6a8110b37f40cf94fba4`, attributed by `UPSTREAM.json:3` | Declared fixture provenance; not independently verified checkout HEAD |
| Harness assigned revision | `fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159` | Assigned research pin; not independently confirmed with Git by the worker |
| EstaCoda fixture revision | **Not established** | Failed scope supplies no accepted revision or fixture-state evidence |
| Superagent package version | `0.1.0` | Inspected metadata, not current published version |
| Superagent copyright | **2026** | License year, not launch date |
| Launch/publication date | **Not verified** | No live-web confirmation |
| Current upstream HEAD/release date | **Not verified** | No current remote inspection |
| Test execution calendar date | Not supplied in accepted receipts | Durations and runtime versions are known, but no date is invented |

The Superagent fixture had no nested `.git` entry in the observed listing. Consequently, the declared hash does not independently establish clean-tree status, byte-for-byte upstream identity, dependency provenance, or compatibility with a particular Harness checkout.[S1]

**The two revision labels are not proof of deployment parity or full reproducibility.** Reproduction would additionally require fixture hashes or Git verification, lockfiles and dependency resolution, build prerequisites, platform details, effective configuration, and exact integration activation. Equivalent verification is still needed for EstaCoda.

## 4. Capability matrix: the complete stack, with ownership preserved

**“Unverified” means insufficient accepted evidence, not absent.**

| Capability | Superagent bundle | Harness host | EstaCoda | Evidence and boundary |
|---|---|---|---|---|
| Agent inference/tool loop | Consumes host agent/session services | Concrete `ReactLoopAgent`, queued input, step preparation, provider streaming, tool dispatch | Unverified | [S4][H1]; host-owned mechanism |
| Repository event intake | GitHub polling, issue/PR/comment/CI observation; optional Feishu wiring | Supporting runtime services | Unverified | [S2]; no live integration test |
| Proactive work admission | Off/observe/auto behavior, source identities, rules, explicit versus inferred intent | Tool authorization needs separate verification | Unverified | [S3]; semantic intent remains model judgment |
| Durable orchestration | Transactional engine, tickets, decisions, assignment and follow-up ownership | Session execution and persistence infrastructure | Unverified | [S3–S6][H4] |
| Worker workspaces | Ticket-specific directories and configurable prepare command | OS sandbox backends exist | Unverified | [S4][H3]; directories are not a security sandbox |
| Concurrency | Startup reservations; counts surviving jobs/subagents; one extra human-follow-up slot | Native tool executor default batch parallelism is 10 | Unverified | [S4][H2]; these are different capacity controls |
| Subagent orchestration | Worker tool inventory includes subagents; background accounting includes them | Several adapter/package families observed, but dispatch and authority inheritance not traced | Unverified | [S4][H7]; no broad subagent parity claim |
| Restart and recovery | Durable effects/outbox, restart reconciliation, evaluation requeue, classified retries | JSONL session resume and interrupted-tool repair tested | Unverified | [S5–S6][H4][H6] |
| External delivery | Durable receipts, atomic queueing, pause/source gates, ordering | Transport services consumed by bundle | Unverified | [S5]; exactly-once remote posting not established |
| Skills | Skills tools are included in worker tool inventory | Loading/learning implementation not inspected | Unverified | [S4][H7]; exposure is not evidence of learning |
| Durable memory | Domain/session state persists | Session persistence verified in selected composition | Unverified | [S6][H4]; persistence is not preference memory or skill learning |
| Authorization | Deterministic admission and revalidation paths; restricted worker tool inventory | Approval presets and operation-level enforcement not traced | Unverified | [S3–S4][H7] |
| OS confinement | Activation not established | Linux, macOS, Windows implementations inspected partially | Unverified | [H3]; no actual confinement test |
| Human control | Status, stop, retry, attention/result routing | Supporting agent/runtime facilities | Unverified | [S5–S6] |
| Plugin extensibility | Application composition via Harness services | Concrete scoped plugin example and extension hooks | Unverified | [H1–H2]; hot reload not verified |
| Provider breadth | Uses host services | Provider/model selection and transport recovery inspected | Unverified | [H1][H5]; exact live model/provider matrix not verified |
| UI, MCP, browser/computer use | No deployed behavior established | Package/script inventory alone is insufficient | Unverified | [H7] |

## 5. End-to-end behavior and important failure boundaries

### 5.1 Event to authorized ticket

GitHub intake defaults to a 60-second polling interval and can observe issues, PRs, comments, and default-branch CI. `Engine.receive` stores a trigger once, distributes it to subscribing tickets, and queues evaluation.[S2–S3]

Admission is more than a prompt instruction:

- identities remain source-specific;
- allowed humans explicitly addressing the agent receive explicit-intent treatment;
- other messages pass source scope and follow-up checks;
- unlisted identified bots are rejected;
- listed bots can only become inferred candidates;
- senderless system/CI events require the relevant inferred admission path;
- inferred acceptance requires auto mode and enabled rules.[S3]

Assessment validation requires structured rule coverage and evidence. Outside auto mode, inferred acceptance becomes an audited `would_accept` observation rather than execution.[S3]

**Boundary:** these checks validate structure and configured authorization. They do not prove the model correctly interpreted intent. A nonempty evidence string is not semantic proof of permission.

`Evals.decide` rejects unknown or finished evaluations, returns a previous acceptance instead of creating another ticket, and restricts main-session decisions on worker-owned follow-ups.[S3] This is concrete workflow coordination, but it does not establish exactly-once behavior for every downstream external action.

### 5.2 Ticket to worker and background work

A worker has a persistent `worker-<ticketId>` session and ticket-specific directory. Its tool inventory includes file/search, shell/jobs, web, skills, todos, and subagents, while excluding unrelated session/profile/scheduling capabilities.[S4]

The prepare command has a ten-minute timeout. Existing directories count as prepared; failed preparation is not automatically retried. Empty failed directories are removed, while nonempty ones can remain.[S4]

**Operational shortcoming:** a partially prepared workspace needs clear operator handling. Do not assume that directory existence means successful setup, a clean Git worktree, or security isolation.

Worker capacity is reserved synchronously before asynchronous startup. Running turns and surviving shell jobs/subagents retain capacity, with one additional slot available for human follow-ups. Outbound delivery has a separate limit of four.[S4]

This is a useful distinction from merely counting active model calls. Harness’s native executor’s default parallelism of ten is a **tool-batch limit**, not an alternative statement of worker or subagent capacity.[H2]

### 5.3 Completion and external delivery

Completion is not simply “the model stopped.” Tickets can retain ownership of followed PRs/threads, with merge/close events contributing to completion. Human-facing replies distinguish answers/acknowledgements, attention, and results, with state requirements for result delivery.[S5]

Outbox queueing records receipts and durable reply effects atomically. Delivery can be held by pause or disabled sources, preserves ordering subject to repeated failure handling, and can settle gone conversations as dropped.[S5]

**Recovery boundary:** the inspected path sends remotely before marking the local receipt sent. A crash between those operations can create ambiguity. The evidence does not establish exactly-once external posting or remote reconciliation.

### 5.4 Recovery across application and host layers

Superagent uses SQLite with WAL and `synchronous=FULL`, transactional migrations, nested savepoints, rollback-aware after-commit callbacks, and durable effects. Runtime state locking and executor restart reconciliation are implemented.[S6]

The executor classifies transient provider/network failures, allows up to three transient attempts, and uses an initial 15-second backoff. However, observed retry counters are in-memory maps; a restart-persistent lifetime retry ceiling was not established.[S6]

Separately, Harness resume tests compose a real JSONL persistence plugin with a mock LLM adapter and temporary filesystem state. Passing cases include torn-tail recovery, durable interrupted-turn closers, missing tool-result repair, identity release after setup failure, and continuity of sequence numbering.[H4][H6]

These establish useful local recovery behavior in the selected compositions—not universal crash tolerance, distributed-storage guarantees, or validated production operation.

### 5.5 Authorization and confinement are not interchangeable

Three layers must remain separate:

1. **Event admission:** who or what may create work.
2. **Worker/tool authority:** what an admitted worker may invoke.
3. **OS confinement:** what executed operations can access.

Harness contains Linux Bubblewrap/Landlock, macOS Seatbelt, and Windows restricted-token/ACL backends. The Windows classification is explicitly **partial**. Custom runner overrides can bypass built-in selection/probing and assert enforcement through configuration.[H3]

The full confinement path was not traced, and no OS escape tests were run. Approval flows, filesystem-tool enforcement, shell escalation, and effective Superagent sandbox activation remain unverified. Passing sandbox-policy tests is not a substitute for those checks.

## 6. Executed deterministic benchmark and command receipts

These results are **native regression validations**, not a shared benchmark or a model-quality leaderboard. No cross-suite score is calculated.

### 6.1 Exact commands

**Superagent — receipt label `superagent-tests`; input scope `.`**

```sh
cd upstream/superagent && ./node_modules/.bin/vitest run
```

**Harness — receipt label `harness-tests`; input scope `.`**

```sh
cd upstream/harness &&
node --version &&
./node_modules/.bin/vitest run \
  packages/core/agent-loop/tests/tool-calls.spec.ts \
  packages/core/agent-loop/tests/resume.spec.ts \
  packages/sandbox/sandbox-policy/tests/policy.spec.ts \
  packages/llm/llm-retry/tests/transport-recovery.spec.ts \
  --maxWorkers 2
```

### 6.2 Outcomes

| Execution | Command exit receipt | Passed | Failed | Skipped | Duration | Prerequisites and limitations |
|---|---|---:|---:|---|---:|---|
| Superagent native suite | **Exit 0; successful tool execution** | 1,197 tests / 59 files | 0 reported | None reported | 11.77 s | Prepared dependencies; no typecheck/build/live integrations |
| Harness focused selection | **Exit 0; terminal receipt `ok=true`** | 112 tests / 4 files | 0 reported | None in printed summary | 3.23 s | Node v24.14.1, Vitest v4.1.11; no native build |
| EstaCoda | No accepted test command or exit receipt | Not established | Not established | Not established | — | Research dependency failed; no comparative result |
| Matched live-model evaluation | Not run | — | — | Not run | — | No paired tasks, model calls, or quality/cost measurements |
| Real OS confinement tests | Not run | — | — | Not run | — | Sandbox-policy validation only |

Zero reported failures in the successful runs must not be misread as “all requested work passed.” EstaCoda coverage failed, and important integration/build/security checks were not run.

### 6.3 Tested scope

Harness breakdown:

| Selected suite | Tests passed |
|---|---:|
| `agent-loop/tests/resume.spec.ts` | 51 |
| `agent-loop/tests/tool-calls.spec.ts` | 29 |
| `sandbox-policy/tests/policy.spec.ts` | 24 |
| `llm-retry/tests/transport-recovery.spec.ts` | 8 |

Selected Superagent coverage included engine, policy, runtime concurrency, store/migration, sources, delivery/effects, retry health, environment, and service lifecycle tests. Printed negative cases included refusing credential fallback through operator askpass, retaining outbound messages while a source is off, running effects only after commit, refusing multiple service instances, refusing a reused recorded PID, and failing startup on readiness timeout.[S8]

A test that **successfully verifies rejection or timeout behavior is a passing negative test**, not an observed suite failure.

### 6.4 Failures and exclusions

- **Actual test failures:** none reported by the two accepted test receipts.
- **Research failure:** EstaCoda dependency failed; no accepted evidence resulted.
- **Inspection failure:** a Harness read-only inventory script raised `FileNotFoundError` because `tool-executor-native/tests` did not exist. This was not a test failure. No numeric exit receipt was supplied for that exploratory command.
- **Not run:** Superagent typecheck/build, full Harness suite, native addon build, live deployment, real integrations, live-model tasks, and matched comparison.
- **Warnings:** Superagent emitted SQLite experimental warnings; Harness emitted Vite/`vite-tsconfig-paths` advisory or deprecation warnings.[S8][H6]

Harness dependencies had been prepared without lifecycle scripts. Its normal test script first builds native system code; the focused direct Vitest command intentionally avoided that build. The passing selection therefore does not establish readiness of native-dependent sandbox, computer-use, or storage suites.[H6]

## 7. Shortcomings and worthwhile ideas for EstaCoda

### 7.1 Observed limitations of the inspected stack

1. **Prototype status:** the README disclaims official-product status and warns against equating article designs with shipped code.
2. **Application scope:** the bundle targets one repository; general multi-project deployment parity is not established.
3. **Semantic authorization remains model-dependent:** deterministic admission scaffolding cannot guarantee correct interpretation.
4. **Partial setup ambiguity:** failed nonempty preparation directories can remain.
5. **External exactly-once delivery is unproven:** durable local receipts do not close every remote crash window.
6. **Retry ceilings may reset across restarts:** observed counters are in memory.
7. **Security activation remains incomplete evidence:** host sandbox implementation is not proof of effective confinement in this bundle.
8. **Skills and learning are unanswered:** tool availability and session persistence do not establish skill acquisition, preference curation, or safe learning.
9. **Freshness/provenance remains unresolved:** canonical URLs, launch date, current upstream, and independently verified Git state are missing.

### 7.2 Improvement candidates for EstaCoda

These are **audit and design proposals**, not claims that EstaCoda lacks them.

| Candidate | Why it is worthwhile | Acceptance condition |
|---|---|---|
| Observe-before-auto admission | Lets operators inspect proposed proactive work without granting execution | Observe mode launches no workers and records actionable reasons |
| Background-aware capacity accounting | Prevents hidden shell jobs/subagents from escaping concurrency budgets | Capacity remains occupied until descendants settle |
| Human follow-up reservation | Reduces starvation behind autonomous work | Bounded follow-up latency without orphaned background work |
| Durable effects and outbox | Separates committed intent from transient execution | Fault injection shows recoverable work without silent loss |
| Explicit completion ownership | Avoids treating end-of-turn as end-of-task | PR/thread and delivery state determine completion |
| Purpose-specific notifications | Can reduce interruption noise | Measure useful attention requests, not message volume |
| Durable setup-state markers | Addresses partial-directory ambiguity | Failed setup cannot be silently mistaken for prepared state |
| Restart-persistent retry budgets | Prevents restart loops from renewing exhausted retries | Attempts remain bounded across repeated process restarts |
| Authority-aware skills | Makes reuse inspectable without silently expanding permission | Loaded skills remain subordinate to current task authority |

The most concrete EstaCoda shortcoming established **by this investigation** is the missing accepted runtime evidence. Product deficiencies cannot honestly be inferred from that absence.

## 8. Controlled benchmark plan for unanswered performance

### 8.1 Establish comparable systems first

Before scoring:

- independently verify revisions, fixture changes, dependency lockfiles, and builds;
- complete EstaCoda source and runtime inspection;
- record exact model identifier/snapshot, endpoint, routing, sampling settings, context and output limits;
- verify actual provider/model execution rather than relying on configuration labels;
- equalize repository snapshots, permissions, sandbox policy, network access, tool affordances, and concurrency/resource budgets.

Run two separate tracks:

1. **Capability-normalized track:** matched tools and policies to isolate orchestration/model effects.
2. **Native-product track:** each full stack’s documented configuration to measure practical utility and setup burden.

Do not combine their scores.

### 8.2 Deterministic behavioral track

Use fake providers and integration endpoints to test:

| Scenario | Required observations |
|---|---|
| Admission matrix | Zero unauthorized launches across humans, bots, addressed/unaddressed events, and operating modes |
| Revocation during execution | Cancellation, subsequent tool use, and external side effects respect changed authority |
| Duplicate/reordered events | No duplicate tickets; stale assessments cannot regain authority |
| Background saturation | Slot accounting, human priority, and descendant cleanup remain correct |
| Crash after remote acceptance | Duplicate risk is prevented, reconciled, or explicitly surfaced |
| Partial workspace setup | Failure is distinguishable from successful preparation |
| Restart at transaction boundaries | No silent lost inputs, unexplained duplicate work, or infinite retry renewal |
| Skill loading | No authority expansion; expected discovery and reuse are observable |
| Session recovery | Repair preserves event order and avoids inconsistent tool histories |

Publish command exits, traces, fault locations, and pass/fail criteria per scenario. Keep unsupported scenarios distinct from behavioral failures.

### 8.3 Matched live-model track

Use a preregistered, held-out set of:

- bug fixes with hidden tests;
- bounded features and refactors;
- multi-file repository investigations;
- CI failure triage;
- ambiguous requests requiring clarification;
- repeated workflows that test safe skill reuse;
- noisy event streams that test proactive restraint.

Run both systems from identical clean snapshots, with multiple paired repetitions and randomized execution order. Use the same exact model version and per-task budgets where possible. Otherwise label the comparison unmatched.

Measure separately:

- hidden-test correctness and blinded patch review;
- regressions and unauthorized actions;
- completion and recovery success;
- human interventions and unnecessary notifications;
- wall-clock time, token use, actual API cost, and retries;
- setup/maintenance burden and resource use.

Report paired uncertainty estimates, failures, exclusions, and censored runs. Do not let frequent easy tasks hide authorization or recovery failures.

**Until this evaluation exists, comparative coding quality, speed, cost efficiency, and human-attention savings remain unmeasured.**

## 9. Source and receipt index

All implementation citations refer to the inspected local fixtures. They are not verified current upstream web permalinks.

### Superagent scope

- **[S1] Identity/provenance:** `upstream/superagent/package.json:2–7`, package `dsh`, `engines`, and `peerDependencies`; `README.md:3–9`; `LICENSE:1–21`; `UPSTREAM.json:3`; `docs/006-deployment.md:152`. Accepted bundle result: `8320d75c-c19f-4c26-9e67-f6f2d8b35a2e`.
- **[S2] Intake/integrations:** `upstream/superagent/src/sources/github.ts:25–100`; `src/app/runtime.ts:41,100–106`.
- **[S3] Admission/decisions:** `src/policy.ts:1–4,25–64`, symbols `settingsPolicy`, `machineGate`, `gate`, `admitsInferred`, `revalidate`; `src/core/engine.ts:19–49`; `src/core/evals.ts:105–159`.
- **[S4] Workers/concurrency:** `src/executor/dsh.ts:1–41,165–199,226–258,434–436`; `src/app/sessions.ts:55–64`.
- **[S5] Completion/delivery:** `src/core/engine.ts:50–67,115–207`; `src/app/outbox.ts:18–59`.
- **[S6] State/recovery:** `src/app/store.ts:45–108,141–172`; `src/app/runtime.ts:54–58,90–102`; `src/executor/dsh.ts:29–30,43–54,208–212,520–532`; `src/core/engine.ts:70–89`; `src/app/sessions.ts:89–124`.
- **[S7] Instruction versus enforcement:** `README.md:5,9`; `prompts/team/delivery.md:17`.
- **[S8] Execution receipt:** accepted bundle result above, label `superagent-tests`; `package.json` scripts; `vitest.config.ts:1–3`. Exit 0, 59 files, 1,197 tests.

### Harness scope

- **[H1] Agent loop:** `upstream/harness/packages/core/agent-loop/src/agent.ts:113–158,283–317,328–390,479,490,590,613,644`. Accepted host result: `ec6aa955-75d7-4dac-8de9-3a44789f16ac`.
- **[H2] Tool executor/plugins:** `packages/core/tool-executor-native/src/index.ts:8–36`; `AGENTS.md:4,134–146`; `packages/AGENTS.md`.
- **[H3] Sandbox:** `packages/sandbox/sandbox-local/src/index.ts:1–93,156–190,218–240`.
- **[H4] Session recovery:** `packages/core/agent-loop/tests/resume.spec.ts:29–52,493,514,539,578,716,784,1046,1119,1156`; agent-loop `agent.ts:362–390`.
- **[H5] Provider boundary:** agent-loop `agent.ts:288–294,490,644`; `packages/llm/llm-retry/tests/transport-recovery.spec.ts`.
- **[H6] Execution receipt/prerequisites:** accepted host result above, label `harness-tests`; `package.json:55–60`; `vitest.config.ts:173–187,209–270`; `vitest.shared.ts:1–42`; test environment scripts. Exit 0, 4 files, 112 tests.
- **[H7] Explicit unverified coverage:** accepted host result’s subagent, skills/memory, permissions, UI/integration, and bundle-activation limitations.

### EstaCoda scope

No accepted implementation or test result is available. Its failed dependency is retained as a material coverage limitation throughout this report.
