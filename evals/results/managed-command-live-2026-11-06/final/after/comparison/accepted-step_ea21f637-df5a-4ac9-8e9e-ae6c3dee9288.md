dsh-superagent is a research prototype, not an official DeepSeek product. Its repo-team workflow and EstaCoda’s broader orchestration show distinct strengths; coding quality remains unmeasured.

# Source benchmark: dsh-superagent + DeepSeek Harness versus EstaCoda

## Executive assessment

**Project identification matters:** the inspected dsh-superagent README explicitly describes it as a **research prototype, not an official DeepSeek product**, warns against production-readiness assumptions, and distinguishes implemented behavior from future directions discussed in an article. This comparison therefore evaluates the pinned prototype and its Harness host—not an independently verified official product launch. [`upstream/superagent/README.md:3–5`]

The strongest supported distinction is architectural:

- **dsh-superagent** supplies a focused application model for proactive work around **one GitHub repository**, optionally incorporating Feishu: source admission, model assessment, mandates, tickets, worker assignments, attention questions, and outbound delivery.
- **DeepSeek Harness** supplies host-level execution infrastructure: scoped plugins, native tool dispatch, policy hooks, session persistence and repair, sandbox policy/backends, provider adapters, and subagent providers. These capabilities must not automatically be attributed to the Superagent application without verifying its mounted configuration.
- **EstaCoda** has a broader general-agent foundation in the inspected source: durable delegation graphs, fenced scheduling, constrained descendant authority and budgets, exact-action approval reassessment, provider fallback, and inspectable skill-learning and memory-curation machinery.

The focused verification runs reported **443 passing Superagent tests, 56 passing Harness tests, and 172 passing EstaCoda tests**. Those are different selections testing different contracts. They do **not** establish relative coding quality, agent speed, cost, security, or production readiness.

**No same-model, matched-workload coding comparison was run.** There is no defensible overall performance winner from this evidence.

## 1. Scope, revisions, and research limitations

### 1.1 Pinned subjects and fixture provenance

| Subject | Revision represented in the research fixture | Provenance and qualification |
|---|---|---|
| dsh-superagent application | `8c32a9dc5d72c033816c6a8110b37f40cf94fba4` | Recorded in `UPSTREAM.json:2`; application worker inspected `upstream/superagent`. |
| DeepSeek Harness runtime | `fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159` | Recorded in `UPSTREAM.json:1–4`; runtime worker inspected `upstream/harness`. |
| EstaCoda source subject | `62246ec5afb60cde7d1a9cb4d57b0bcfb421f1b2` | Recorded as the subject revision in `MANIFEST.json:2`; EstaCoda worker inspected root `src`. |
| Research workspace fixture HEAD | `78541dcbb8ea725e4664aa3a45d0ebc3cda21fc7` | Supplied by the assignment; **not independently verified with Git by the worker**. This is not EstaCoda’s `subjectRevision`. |

These are manifest-pinned source identities, not a fresh remote checkout verification. In particular, **EstaCoda’s subject revision and the fixture’s HEAD must remain distinct**.

The workers performed no network requests, installations, deployments, or intentional source edits. EstaCoda’s tests created temporary isolated state; the worker did not perform a post-test Git-status or source-integrity check. The source identity claims should therefore not be expanded into a claim that the fixture was independently proven pristine.

### 1.2 Freshness and availability

Live discovery was blocked in this research workflow. The accepted worker evidence is local, pinned-source inspection and focused local testing.

Consequently:

- No current launch, latest release, or present upstream state was verified.
- No current deployment was inspected.
- No provider credential, exact live model version, region, managed-service availability, self-deployment setup, or retirement status was verified.
- A provider adapter or model catalog entry is evidence of an integration surface, not proof of current service availability.
- No claim about official status beyond the inspected Superagent README is inferred from names or branding.

There was no explicit freshness bound in the request; the limitation is lack of live discovery, not satisfaction of a recency threshold.

### 1.3 Evidence labels

This report distinguishes:

- **Implementation:** behavior visible in inspected source.
- **Executed test:** behavior exercised by selected deterministic tests.
- **Inference/recommendation:** an interpretation or proposed improvement, not demonstrated runtime behavior.
- **Unverified:** outside the successful inspection or execution scope.

An unverified feature is **not necessarily absent**.

Three workers covered separate scopes. Superagent’s dependency on Harness is a composition relationship, not independent corroboration of Harness behavior.

## 2. Architecture and capabilities matrix

| Dimension | dsh-superagent application | DeepSeek Harness host | EstaCoda |
|---|---|---|---|
| Primary role | Proactive application for one repository, optionally listening to Feishu. | Composable runtime and execution services. | General-agent orchestration, execution policy, learning, memory, and integration infrastructure. |
| Composition | `Runtime` joins store, engine, settings, sources, assessor, executor, effects, outbox, passes, sessions, and prompts. | Cordis-scoped service/plugin registration and execution-policy seams. | Durable delegation admission plus scheduler, security, provider, skill, and memory services. |
| Unit of work | Trigger → assessment → decision → mandated ticket → assignment. | Sessions, turns, tool calls, and subagent continuations. | Durable task graph, worker steps, accepted results, and synthesis. |
| Admission | Deterministic source/sender gates plus model rule assessment; inferred acceptance depends on mode. | Pre-execution policy hooks; inspected waterfall continuation defaults to allow. | Trusted-workspace, worker-contract, authority, budget, freshness-capability, and synthesis checks. |
| Tool execution | Uses Harness facilities; application executor manages worker launch and delivery. | Real native dispatch, immutable argument snapshots, conservative concurrency classification, approval hooks, output validation. | Tool policy assessment incorporates action context and optional egress; approval leads to exact-call reassessment. |
| Concurrency | Configured worker slots; pause disables launch/delivery concurrency. | Native executor default batch maximum of 10; only explicitly concurrency-safe calls qualify for parallel execution. | Tested descendant concurrency limits, reservations, ownership fencing, and dependency ordering. |
| Recovery | Stale-assessment/report rejection, mandate revalidation, explicit retry, outbox pause/resume. | Session repair distinguishes not-started work from unknown outcomes; persistence contains torn-tail handling. | Tested leases, fencing, retry policies, durable publication, approval pauses, cancellation, and uncertain-effect intervention. |
| Isolation | Prepares workspaces, but this inspection does not establish an application-wide OS boundary. | Platform-specific sandbox backend code; actual confinement not exercised. | Exact-action authorization inspected; worktree/OS-isolation implementation not audited here. |
| Human interaction | First-class attention questions; automated input held while waiting for a person. | Approval plumbing exists; actual UI/transport not exercised. | Durable approval pauses and revocation handling tested; no equivalent repo-team attention lifecycle traced here. |
| Learning and memory | No comparable learning pipeline established in the application scope. | No comparable learning pipeline established in the runtime scope. | Inspectable skill evidence/candidates and incremental memory curation; outcome improvements unmeasured. |
| Integrations | GitHub-oriented application and Feishu recovery loops. | Multiple provider and subagent integration surfaces. | Provider registry/fallback and Telegram, Discord, email, WhatsApp capability registry. |
| Proven live coding outcome | Not measured. | Not measured. | Not measured. |

### Architecture references

**Superagent:** `upstream/superagent/package.json` (`description`, `dsh.bundle`, `peerDependencies`); `upstream/superagent/src/app/runtime.ts:1–57` (`Runtime`); `upstream/superagent/src/executor/dsh.ts:207–280` (`DshExecutor`).

**Harness:** `upstream/harness/packages/core/tool-executor-native/src/index.ts` (`NativeToolExecutor`, `apply`); `upstream/harness/packages/core/tools/src/pipeline.ts:100–280`; `upstream/harness/packages/subagent/subagent-spawn-in-process/src/index.ts:33–65`.

**EstaCoda:** `src/delegation/durable-delegation-service.ts:155–260`; `src/tools/tool-executor.ts:390–455`; `src/tasks/task-scheduler.test.ts`; `src/skills/skill-learning.ts:32–109`; `src/memory/memory-curation-service.ts:80–205`.

## 3. End-to-end flow differences

### 3.1 Superagent: turn team signals into authorized repository work

The inspected application lifecycle is:

```text
Source event or follow-up
  → source/sender/admission gate
  → assessment against enabled rules
  → audited acceptance, rejection, or would_accept decision
  → ticket carrying a mandate
  → assignment and prepared workspace
  → Harness-backed worker launch
  → assignment-aware inputs and reports
  → attention question, answer, or result
  → source-specific outbox delivery
  → pause, retry, resume, or completion under current authority
```

Several details distinguish this from merely forwarding messages to a coding model:

1. `assessmentOutcome` requires exactly one assessment for each enabled rule, a settled direction, at least one matched rule for acceptance, and `intent_evidence`.
2. Inferred acceptance outside `auto` mode becomes an audited `would_accept`, rather than silently starting work.
3. Mandates are revalidated against changed source scope, identities, mode, and rules.
4. Accepted work is assignment-aware: replaced assignments cannot submit valid late reports.
5. Waiting for a human suppresses automatic input, preventing background activity from overrunning an unresolved question.

References: `upstream/superagent/src/policy.ts:26–61,167–245`; `src/core/tickets.ts:104–113,238–269`; `src/core/assignments.ts:94–121`; `src/core/replies.ts:46–47,75–86`, all latter paths under `upstream/superagent/`.

**Executed support:** atomic acceptance rollback, stale assessment rejection, timeout exhaustion, mandate revocation, late-assignment rejection, and human-stop behavior were exercised in `upstream/superagent/tests/core-engine.spec.ts:136,146,161,228,331,339,1241,1271`.

**Boundary:** the core tests use `MemoryRepositories`, mock assessor/executor ports, and a simulated clock. This is application-state correctness evidence, not a demonstrated live GitHub issue-to-merged-PR run. [`upstream/superagent/tests/core-engine.spec.ts:1–71`]

### 3.2 Harness: execute and preserve session activity

The inspected native execution path is:

```text
Registered tool schema
  → native executor batch
  → execution classification and frozen argument snapshot
  → executor-owned refusals
  → scoped pre-execute policy and optional approval
  → tool guards
  → registered tool body
  → post-execution policy and output validation
  → canonical result
```

This path actually invokes `tool.execute(exec.arguments, exec)`. It is not just a declarative tool catalog. Cancellation signals are fused, and an already-started tool body is awaited rather than simply abandoned. [`upstream/harness/packages/core/tools/src/pipeline.ts:100–280`, symbols `prepare`, `dispatchToolBody`, `postExecute`, `createSuccessResult`]

Session repair separately handles incomplete histories. It distinguishes `TOOL_NOT_STARTED` from `TOOL_OUTCOME_UNKNOWN` and warns against blindly retrying potentially side-effecting work whose result was not durably recorded. [`upstream/harness/packages/core/session/src/repair.ts:1–160`, `openTurnClosers`, `ToolCallRecovery`]

**Boundary:** the worker did not run the complete model-loop-to-tool path, approval UI, native execution suite, or persistence crash integration.

### 3.3 EstaCoda: admit durable work, constrain execution, accept evidence, synthesize

The inspected delegation/scheduling flow is:

```text
Delegation request
  → authority preview and admission checks
  → immutable durable graph creation
  → activation
  → fenced scheduling under leases and grants
  → workers with constrained authority/budgets
  → tool policy and approval handling
  → durable result publication and acceptance
  → dependent work / synthesis
  → settlement-aware learning observation
```

`DurableDelegationService` creates durable graphs; it does not itself run or wait for workers. Persisting the graph precedes activation, so a post-commit activation failure still returns a recoverable durable handle. Required research/report synthesis cannot be disabled by a model flag. [`src/delegation/durable-delegation-service.ts:155–156,220–260`]

Executed tests covered immutable graph replay, worker-before-synthesis ordering, accepted-evidence requirements, restart preservation, partial synthesis, constrained descendants, cancellation, reservations, and admission failure when child tool access is unavailable. [`src/delegation/durable-delegation-service.test.ts`]

**Boundary:** this foundation was not traced through webhook intake → issue selection → isolated coding workspace → tests → branch/commit → PR → review response. The evidence neither proves that full workflow nor proves its absence.

## 4. Security boundaries and autonomy

### 4.1 Admission authority is not execution containment

Superagent’s policy decides **whether team input may create or continue work**. It accounts for source-local identities, addressed messages, bot admission, follow-ups, explicit versus inferred authority, and changed policy. These are meaningful deterministic gates around model assessment, not merely prompt instructions. [`upstream/superagent/src/policy.ts:26–61,167–245`]

They do not establish immunity to prompt injection, credential theft, or sandbox escape. A legitimate sender can still supply unsafe content; an authorized ticket still needs constrained execution.

Harness’s tool pipeline decides **whether a concrete invocation proceeds** through policy and guards. Its inspected default continuation is **allow**. Therefore “approval hooks exist” must not become “every tool always requires approval.” Superagent’s exact mounted policy composition remains unverified. [`upstream/harness/packages/core/tools/src/pipeline.ts:190–233`]

EstaCoda’s tool executor constructs a security request including tool name, risk class, target summary, environment, trusted-workspace context, and optional data-egress information. On an approval callback, it reassesses policy; if policy still asks, the call is denied because the approval did not authorize that exact action. Callback exceptions default to denial. [`src/tools/tool-executor.ts:390–455`]

Executed dispatch-authorization tests additionally exercised revoke-and-identical-regrant fencing and preservation of grants across unrelated changes. [`src/security/dispatch-authorization.test.ts`]

**Comparative conclusion:** Superagent has particularly explicit application-level social admission; EstaCoda has particularly explicit inspected exact-call reassessment and grant-race tests. These are different layers, not interchangeable measures of overall security.

### 4.2 OS sandboxing: substantive Harness code, untested enforcement

Harness separates deployment fallback policy from per-session policy, validates writable-root configuration, and publishes resolved policy into runtime context. Enforcement belongs to filesystem/shell/terminal backends, not prompt text. [`upstream/harness/packages/sandbox/sandbox-policy/src/index.ts`]

The local backend contains platform-specific chains:

- Linux: bubblewrap, then Landlock.
- macOS: Seatbelt.
- Windows: ACL/restricted-token runner, explicitly classified as **partial**, including unconfined reads and hard-link limitations.

Linux alternatives use functional probing. Singleton platform chains rely on execution-time refusal handling. A custom runner override bypasses built-in selection/probing and asserts full enforcement, creating a configuration trust boundary. [`upstream/harness/packages/sandbox/sandbox-local/src/index.ts:24–190`]

The backend documents fail-closed behavior, but the worker did not trace every failure branch or exercise actual confinement. No claim of network isolation, escape resistance, native-addon readiness, or universal cross-platform sandbox equivalence is warranted.

EstaCoda’s worktree-related paths were located but not inspected. Its authorization tests must not be represented as OS-isolation proof.

### 4.3 Recovery favors safety over unconditional completion

All three scopes contain useful recovery behavior, at different layers:

| Scope | Supported behavior | Important limit |
|---|---|---|
| Superagent | Revalidate mandates; reject stale reports; hold/resume outbox delivery; preserve human stop; avoid automatic retry of failed workspace preparation. | Core tests are simulated; no real process-kill or live external mutation experiment. |
| Harness | Repair incomplete turns and distinguish not-started from unknown-outcome tool calls. | Session repair is not proof of exactly-once external effects; persistence crash integration was not run. |
| EstaCoda | Fence ownership, reject expired settlement, preserve durable results, pause uncertain non-idempotent work, resume approval pauses with preserved usage. | Deterministic scheduler tests do not establish deployed GitHub-service behavior. |

Superagent deliberately avoids automatic retry after failed workspace preparation because a partly populated directory must not count as a successful prepare. [`upstream/superagent/src/executor/dsh.ts:238–280`]

Harness’s JSONL backend has explicit-root configuration, default checksummed Zstandard frames, torn-tail state, and generation/migration machinery. This is implementation evidence from a bounded read, not a completed durability audit. [`upstream/harness/packages/session/session-persistence-jsonl/src/index.ts:1–180`]

EstaCoda’s executed scheduler cases cover uncertain non-idempotent work requiring operator review, publication rollback, cancellation rejecting late success, lease expiry, crash-boundary attempt reuse, and durable approval continuation. [`src/tasks/task-scheduler.test.ts:599,734,797,858,1243,1405,1423,1509`]

**Inference:** “autonomous” should mean bounded, policy-governed continuation—not an obligation to retry until success. Stopping when external effects are unknown is a desirable safety property, even when it reduces unattended completion.

## 5. Learning, memory, and integrations

### 5.1 EstaCoda’s learning advantage is an inspected mechanism, not measured improvement

`SkillLearningManager` records workflow observations, candidates, provenance, drafts, and review jobs. Its modes include `none`, `suggest`, `proactive`, and `autonomous`, but observation still depends on policy and evidence-store prerequisites. Delegated observations wait for task-settlement evidence. The inspected new-workflow path marks evidence as runtime-internal while setting `mayPromoteAutomatically: false` and `requiresHumanApproval: true`. [`src/skills/skill-learning.ts:32–109,180–230`]

A scheduler test verifies that learning notification follows settlement/result publication and that observer failure cannot reject delivery. The skill-learning suite also passed, although individual case counts were not retained in the worker’s final excerpt. [`src/tasks/task-scheduler.test.ts:100`; `src/skills/skill-learning.test.ts`]

Memory curation has incremental thresholds, manual-mode handling, checkpoint coordination, bounded extraction, and review through `reviewMemoryFacts`; curatable operations target `USER.md` and `MEMORY.md`. [`src/memory/memory-curation-service.ts:26,80–205`]

**Limits:** no memory suite was run, the full mutation/promotion path was not inspected, and no experiment measured whether learned skills improve coding outcomes. “Inspectable, gated learning machinery” is supported; “proven autonomous self-improvement” is not.

No equivalent pipeline was established in the Superagent or Harness scopes. That is a coverage finding, not proof that no such functionality exists elsewhere.

### 5.2 Focused integration depth versus general integration breadth

**Superagent’s focused strengths**

`SourceRegistry` normalizes scope, context reading, and delivery outcomes (`sent`, `gone`, `waiting`). Feishu loops combine event consumption, backfill before cursor advancement, and subscribed-thread polling to recover missed replies. Runtime wiring routes GitHub pull-end notices through the outbox. [`upstream/superagent/src/sources/registry.ts:95–98,116`; `src/sources/kind.ts:53,68–78`; `src/sources/feishu-loops.ts:146–164,217–219`; `src/app/runtime.ts`, `pullEndNotices`, all under `upstream/superagent/`]

**Harness’s extensibility**

The pi-ai plugin has provider-profile, discovery, authentication, and compatible-endpoint infrastructure; a dedicated DeepSeek adapter is also present. This is not a runtime structurally limited to one DeepSeek model. [`upstream/harness/packages/llm/llm-pi-ai/src/index.ts:1–100`; `upstream/harness/packages/llm/llm-deepseek/`]

The in-process subagent provider starts fresh rather than inheriting parent context. External integration files for DSH SDK, ACP, Codex, and Claude Code were located but not fully audited or run. [`upstream/harness/packages/subagent/subagent-spawn-in-process/src/index.ts:33–65`; `packages/subagent/subagent-{dsh-sdk,acp,codex,claude-code}/src/run.ts` under `upstream/harness/`]

**EstaCoda’s broader surfaces**

The provider contract includes multiple named vendors and extensible IDs. `ProviderRegistry` computes availability by adapter `health()`, rather than treating registration as successful connectivity. Mocked fallback tests cover bounded retries, deadlines, cancellation, partial-output handling, configured-only fallback, and credential boundaries. [`src/contracts/provider.ts:1–14`; `src/providers/provider-registry.ts:3–40`; `src/providers/provider-executor-fallback.test.ts`]

The channel registry represents Telegram, Discord, email, and WhatsApp capabilities but explicitly does not instantiate adapters or track runtime state. [`src/channels/adapter-registry.ts:5–46`]

None of these integration findings demonstrates authenticated live interoperability or current service readiness.

## 6. Actual executed checks and verification receipts

### 6.1 Exact commands

**A — Superagent application**

```sh
cd upstream/superagent && ./node_modules/.bin/vitest run tests/policy.spec.ts tests/core-engine.spec.ts tests/outbox.spec.ts --maxWorkers=1
```

**B — Harness runtime**

```sh
cd upstream/harness &&
node --version &&
./node_modules/.bin/vitest run \
  packages/sandbox/sandbox-policy/tests/policy.spec.ts \
  packages/core/session/tests/repair.spec.ts \
  --maxWorkers=1
```

**C — EstaCoda**

```sh
node node_modules/vitest/vitest.mjs run --config vitest.node.config.ts src/tasks/task-scheduler.test.ts src/delegation/durable-delegation-service.test.ts src/security/dispatch-authorization.test.ts src/skills/skill-learning.test.ts src/providers/provider-executor-fallback.test.ts --maxWorkers=1
```

### 6.2 Results and prerequisites

| Check | Runner and counts | Collected completion | Failures and prerequisites |
|---|---|---|---|
| A | Vitest **4.1.8**; **3 files, 443 tests passed**: policy 328, core engine 113, outbox 2. | Exit **0**, signal **null**; overall duration **820 ms**. | No failed selected tests or dependency prerequisites. Experimental SQLite warning. Full build/typecheck/native readiness not established. |
| B | Node **v24.14.1**; Vitest **4.1.11**; **2 files, 56 tests passed**: sandbox policy 24, session repair 32. | Exit **0**, signal **null**, independently collected through process logs; overall duration **496 ms**. | No failed selected tests/prerequisites. Native-addon build deliberately not attempted. Nonfatal Vite configuration warning. |
| C | Vitest **4.1.6**; **5 files, 172 tests passed**. Per-file counts were not retained. | Exit **0**; overall duration **11.25 s**. | No failed selected tests, blocked selected suites, or native-dependency errors observed. No full build/typecheck or live integration run. |

The reported durations are **local test-run durations**, not task-completion latency, model inference speed, or coding-performance measurements. The runner versions and test populations differ.

### 6.3 Preflight and execution scope

- **Superagent:** scripts and Vitest configuration were reviewed before execution; no custom setup hook was declared. Verification scope was conservatively `["."]`.
- **Harness:** package requires Node `>=24.9.0`; the observed runtime met that requirement. Its normal test script builds a native system addon, so the worker used the existing Vitest executable directly to avoid installation, lifecycle scripts, and native compilation. Configuration included a local PowerShell availability probe. Verification scope was `["."]`.
- **EstaCoda:** package scripts, `vitest.node.config.ts:1–20`, and test setup were reviewed first. `src/test/vitest-setup.ts:1–4` and `src/test/state-home.ts:1–10` install a temporary isolated HOME. Declared inputs were `src`, `vitest.node.config.ts`, `package.json`, `node_modules`, and `tsconfig.json`.

### 6.4 Inspection failures and coverage gaps

These were research-tool limitations, not failing product tests:

- Superagent’s worker reported two failed exploratory inspection attempts, including a refused read-only inspection involving a dependency executable path. It did not bypass the refusal. The separately authorized test command completed.
- Harness’s worker attempted an unavailable nested `file.grep` call, then used directly exposed file tools.
- Some broad/verbose outputs were truncated. Conclusions here use retained targeted observations and final receipts, not unseen output.

No worker ran a full suite, live-model coding experiment, authenticated GitHub/Feishu/channel integration, or production deployment audit.

### 6.5 Durable evidence references

The accepted results for task `task_38096e8a-a64d-4401-9654-0e7d433f6971` preserve the worker observations and execution receipts:

| Scope | Accepted result ID |
|---|---|
| Superagent application | `26d568ff-0480-4af0-868a-c330831f9488` |
| Harness runtime | `563c758a-2597-42b3-8557-6561a1714d31` |
| EstaCoda runtime | `b53ca735-108d-4461-b2a2-6b27e9cd42a4` |

These are three scoped evidence records, not three independent live validations of the combined stack.

## 7. Strongest supported advantages

### dsh-superagent

1. **A coherent repository-team work model.** Tickets, mandates, assignments, source context, and delivery form a concrete application lifecycle.
2. **Attention management as state, not etiquette.** Questions can be replaced or cleared, stale unsent replies withdrawn, and automated input held while waiting for a person.
3. **Explicit proactive admission modes.** Deterministic gates and audited `would_accept` behavior provide a practical way to introduce autonomy gradually.

These strengths are implementation-backed and partially exercised by the selected application tests. Live team usefulness and coding outcomes remain unmeasured.

### DeepSeek Harness

1. **Concrete, extensible execution machinery.** Native tool invocation, conservative concurrency classification, argument snapshotting, and multiple policy seams are real implementation paths.
2. **Conservative unknown-outcome recovery.** Session repair communicates uncertainty rather than encouraging blind replay.
3. **Substantive sandbox and plugin infrastructure.** Platform-specific backend code and scoped services provide useful building blocks, with configuration and platform caveats.

Only policy and session-repair suites were executed; native execution and confinement were not demonstrated.

### EstaCoda

1. **Durable general-purpose delegation and synthesis.** Persisted graphs, immutable replay, evidence acceptance, and failure-aware synthesis are strongly supported by selected tests.
2. **Fine-grained execution authority and recovery.** Fencing, revocation, exact-action reassessment, descendant budgets, approval continuation, and uncertain-effect handling have discriminating test coverage.
3. **Inspectable learning and broader integration architecture.** Skill evidence and memory curation provide a basis for accumulating reusable workflows without treating every output as automatically trustworthy.

These strengths do not establish a complete GitHub-native lifecycle or superior coding quality.

## 8. Ranked practical opportunities for EstaCoda

The following are recommendations inferred from the comparison—not assertions that the features are absent.

| Rank | Opportunity | Source lesson | Suggested implementation and validation |
|---:|---|---|---|
| **1** | Build or expose a cohesive repository-team workflow over existing durable primitives. | Superagent’s trigger → mandate → ticket → assignment model is easier to reason about operationally than disconnected generic capabilities. | Trace the existing GitHub path first. Connect source identity, authorization, workspace, PR, review, and cancellation into one inspectable lifecycle. Validate duplicates, changed policy, stale reports, and revoked authority. |
| **2** | Make attention questions first-class durable objects. | Superagent suppresses automated input while waiting for a human and rejects replies to obsolete questions. | Add stable question identity, supersession, authorized answers, unsent-reply withdrawal, and a waiting state. Test late answers, concurrent updates, and restart while waiting. |
| **3** | Offer a proactive shadow-admission mode with explicit evidence. | Superagent’s `would_accept` separates observing opportunities from acting on them. | Present proposed work with source, rule matches, and intent evidence. Measure false-positive admission and reviewer burden before enabling automatic starts. |
| **4** | Produce end-to-end recovery and isolation evidence. | Harness distinguishes policy from backend confinement; Superagent distinguishes state-machine recovery from live integration behavior. | Exercise actual process kills, workspace failures, tool side effects, OS sandbox refusal, and external-state reconciliation. Publish per-platform guarantees and unsupported boundaries. |
| **5** | Integrate source delivery/backfill with durable task progress. | Superagent treats `sent`, `gone`, and `waiting` as distinct outcomes and repairs missed conversation input. | Separate execution completion from notification completion. Add cursor/backfill contracts and idempotent delivery receipts. Test missing adapters, revoked destinations, and duplicate events. |
| **6** | Surface a unified capability-and-authority receipt. | Harness plugin presence and EstaCoda registry presence are not proof of active readiness. | Show configured versus healthy providers, effective tools, mounted policies, sandbox backend, remaining budget, and background-continuation evidence. Represent unknown explicitly. |
| **7** | Measure skill-learning benefit on held-out work. | EstaCoda already has gated evidence and candidate machinery. | Compare reviewed-skill and no-skill runs under matched conditions. Measure held-out success, regressions, review effort, provenance quality, and promotion errors—not just candidate counts. |

The highest-value lesson is **application coherence**, not replacing EstaCoda’s durable scheduler with a second orchestration system. Existing authority, budgeting, and result-acceptance controls should remain the foundation.

## 9. Fair future benchmark protocol

A meaningful next comparison needs two tracks: **matched-capability execution** and **product-native workflow**. The first isolates runtime differences; the second measures the value and burden of each system’s preferred operating model.

### 9.1 Freeze and disclose the experimental configuration

For each system, record:

- Exact source commits and fixture/package lockfiles.
- Installed runtime and dependency versions.
- Mounted Harness plugins and effective Superagent policy.
- Exact model version, endpoint, provider, region, and inference settings.
- Managed-service versus self-deployed inference, where applicable.
- Enabled tools, sandbox backend, filesystem/network permissions, and credentials scope.
- Context limits, concurrency, wall-clock/token/spend budgets, and retry settings.
- Enabled memory, skills, and prior project context.

Verify current model availability before the experiment. If the same exact model cannot be routed through both systems, disclose the confound rather than calling the run model-controlled.

### 9.2 Use matched, independently scored repository tasks

Select multiple repositories and task types:

- A localized bug with hidden regression tests.
- A feature spanning several files.
- A test-repair task.
- A dependency/API migration.
- A task requiring clarification.
- A task that should be refused or paused because authority is insufficient.
- A task interrupted after an externally visible side effect.

Start each trial from an identical clean repository snapshot. Keep task wording, accessible context, tool rights, acceptance tests, and budgets matched. Run repeated trials with randomized order and publish variance and failures, not only best examples.

### 9.3 Separate outcome dimensions

| Dimension | Suggested measure |
|---|---|
| Correctness | Hidden-test pass rate, regressions, independently reviewed functional acceptance. |
| Change quality | Review rubric, unnecessary diff, maintainability, test relevance. |
| Autonomy | Completion without intervention, clarification appropriateness, human actions and time. |
| Recovery | Correct continuation after interruption, duplicate external mutations, safe unknown-outcome handling. |
| Security | Unauthorized action attempts, actual enforcement, revocation races, egress and injection scenarios. |
| Efficiency | Task wall-clock time, retries, tool calls, tokens, and metered cost from receipts. |
| Learning | Held-out improvement after reviewed skill promotion, regression rate, review burden. |
| Operations | Delivery reliability, traceability, orphaned work, deploy/setup burden. |

Do not combine these into an opaque headline score without preregistered weights. A correct safety pause must not be scored as equivalent to an unexplained abandonment.

### 9.4 Include failure and adversarial scenarios

Inject failures at admission, dispatch, result publication, approval, notification, and external mutation boundaries. Exercise:

- Duplicate events and stale assignments.
- Revocation while a worker is queued or running.
- Approval changes during parallel execution.
- A process kill after a mutation but before durable result recording.
- Missing sandbox prerequisites and unsupported platform behavior.
- Partial provider streams, authentication failure, and exhausted fallback.
- Untrusted instructions in repository or conversation content.

Use isolated test accounts and reversible fixtures. Avoid destructive real-world side effects.

### 9.5 Publish reproducible receipts

Retain task prompts, source manifests, clean-start hashes, effective configuration, model identifiers, tool logs, approval decisions, evaluator results, failure classifications, and metered usage.

Report setup and prerequisite failures separately from model/task failures. Include both successful and failed runs. Measure setup effort as an operational outcome rather than silently normalizing it away.

## 10. Bottom line

This source benchmark supports a **complementary-strengths conclusion**, not a coding leaderboard:

- **dsh-superagent** offers the clearest inspected repository-team application lifecycle, especially admission, mandates, attention, and source delivery.
- **DeepSeek Harness** offers substantive execution and session infrastructure, but host capabilities must not be mistaken for verified Superagent configuration or exercised confinement.
- **EstaCoda** offers the strongest inspected general-purpose durable delegation, authority, recovery, and learning foundation, but its complete GitHub workflow and live coding outcomes were not established in this investigation.

The practical opportunity for EstaCoda is to make its existing primitives feel like a coherent, inspectable repository teammate while preserving its execution controls—and then validate that experience with matched live workloads.

There is **no verified current launch claim, no demonstrated current deployment, no same-model matched coding run, and no measured comparative score, latency, or cost** in this report.
