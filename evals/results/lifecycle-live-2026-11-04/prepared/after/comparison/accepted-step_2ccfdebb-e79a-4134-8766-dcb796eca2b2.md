dsh-superagent is a research prototype, not an official DeepSeek product. Its team workflows stand out; EstaCoda offers broader governance. Coding superiority remains unproven.

# Superagent + DeepSeek Harness vs. EstaCoda

## Practical verdict

**The inspected `dsh-superagent` is a specialized repository/team-workflow application built on DeepSeek Harness—not an official DeepSeek product or a standalone implementation of the entire agent runtime.** Its README explicitly calls it a research prototype and cautions that its published implementation differs from internal versions and article designs. [S1]

For a team seeking GitHub- and Feishu-driven work on one repository, Superagent presents a coherent design: source-aware admission, persistent tickets, assignment recovery, background-work accounting, and carefully gated human communication. EstaCoda’s inspected implementation emphasizes a broader agent platform: durable dependency-aware Tasks, delegated execution, dispatch authorization, change verification, estimated spending controls, persistent memory, and governed skill evolution.

**There is no defensible coding-quality winner from this investigation.** Superagent passed 718 selected deterministic tests; EstaCoda passed 270. Those suites test different components with different fixtures. Neither their counts nor their durations establish comparative coding ability, cost, latency, or production reliability.

The intended comparison is the **full Superagent + Harness stack against EstaCoda**, rather than the Superagent application alone against EstaCoda’s runtime. However, the independent Harness investigation failed and supplied no accepted result. Consequently, this report credits Harness where its role is supported by the accepted application investigation, but leaves Harness internals, revision, and independent runtime checks unverified. This materially limits any full-stack ranking.

## 1. Evidence, provenance, and missing coverage

### Inspected revisions

| Component | Revision/version established by accepted evidence | Provenance and limits |
|---|---|---|
| Superagent application | `8c32a9dc5d72c033816c6a8110b37f40cf94fba4`; package `dsh-superagent` version `0.1.0` | Revision recorded in root `UPSTREAM.json`; identity and package metadata inspected. It is MIT licensed. [S1] |
| DeepSeek Harness runtime | **Not established by accepted evidence** | Independent Harness scope failed. No accepted runtime revision, package version, or native-test receipt is available. Application integration evidence establishes dependency roles, not an independent Harness audit. [S6] |
| EstaCoda | `5a9f397a8063d6235157282c4bda77e20c93c71c` | Investigation ran `git rev-parse HEAD`, exit `0`. Root `AGENTS.md` describes source research fixtures, not deployed services. |

The exact public repository URL for `dsh-superagent` was **not established**. Its README links to the Harness product page; the inspected deployment example interpolates the operator’s target repository rather than identifying this application’s upstream URL. A bounded search did not resolve that provenance gap. [S1]

### Investigation coverage

| Assigned scope | Outcome | Treatment in this report |
|---|---|---|
| `superagent-application` | Completed; accepted result | Supports application findings and its executed test receipts. |
| `estacoda-runtime` | Completed; accepted result | Supports EstaCoda runtime findings and its executed test receipts. |
| `harness-runtime` | **Failed; no accepted result** | Missing coverage. An unaccepted diagnostic draft is not used as evidence. |

Only **two of three investigations** supplied accepted evidence. Application references to Harness are not counted as independent corroboration of Harness’s implementation.

### Freshness and research method

- Network retrieval was disabled; no network/latest-release verification was performed.
- There was no explicit freshness cutoff, but the evidence supports only the inspected snapshots—not a claim about either project’s latest release.
- Publication dates, current public availability, and present deployment readiness remain unverified.
- Prepared local dependencies were used. Neither accepted investigation installed packages or ran setup, build, or lifecycle scripts.
- No live model endpoints, authenticated remote-service integrations, or equal-model coding trials were exercised.
- Source citations below refer to local inspected paths and line ranges, not verified public permalinks.

## 2. Attribute the application and runtime correctly

A fair comparison must not make the Superagent application appear to lack capabilities delegated to its host, or credit that application with independently implementing the host runtime.

| Layer | Responsibilities supported by the accepted investigation |
|---|---|
| **Superagent application** | GitHub/Feishu intake; admission and proactive rules; tickets and assignments; workspace preparation; account-oriented CLI guardrails; launch coordination; worker-slot accounting; recovery coordination; durable effects; outbox and human-attention policy. [S2–S8] |
| **DeepSeek Harness host** | Agent execution, sessions, persistence, subprocesses, and tool/permission infrastructure consumed by the application. Credential-shaped environment stripping is specifically identified as host subprocess behavior. These attributions come from application-side evidence; the independent runtime investigation is unavailable. [S6] |
| **EstaCoda runtime and services** | Dependency-aware durable Tasks, delegation, execution authorization, verification freshness, worktree/change controls, estimated provider-spending reservations, memory curation, channel plumbing, and governed skill learning/evolution. [E1–E9] |

Superagent’s policy gates and EstaCoda’s dispatch controls also operate at different layers. The former decides whether observed team activity should become work; the latter includes checks on whether a particular operation remains authorized at execution time. These are complementary concerns, not interchangeable implementations of one feature.

## 3. Capability comparison

“Not established” means the accepted investigation did not demonstrate the capability. It does **not** mean the other stack lacks it.

| Capability | Superagent + Harness: supported evidence | EstaCoda: supported evidence | Comparative interpretation |
|---|---|---|---|
| Repository/team intake | Normalizes GitHub issues, PRs, comments, inline reviews, and CI transitions; optional Feishu live/history intake. [S2] | Channel gateway, state stores, approval queues, and trust-checked continuation. [E8] | Superagent has stronger demonstrated specialization for the inspected GitHub/Feishu workflow. Equivalent EstaCoda intake behavior was not benchmarked. |
| Proactive admission | Source-specific identities, configurable explicit/inferred admission, enabled-rule requirements, mandate revalidation. [S3] | Runtime trust and authorization controls are demonstrated; an equivalent source-admission matrix was not established. [E2] | Superagent’s admission model is a useful application-level design, not proof of generally safer autonomy. |
| Durable work | Tickets separate work identity from assignments; recovery distinguishes inbox delivery from worker consumption. [S4] | Dependency-aware Tasks, leases, fencing, concurrency limits, bounded retry, and durable result acceptance. [E1] | Both demonstrate meaningful durability. EstaCoda explicitly exposes a general dependency-aware orchestration layer; the full Harness equivalent is unknown. |
| Delegation/background activity | Application recovery accounts for running workers, subagents, and background work. [S4, S7] | Delegation requires persistent Task service/workspace binding and stable provider tool-call identity, carrying trust and restrictions. [E1] | Both go beyond simple parallel prompting, but no matched live delegation trial was run. |
| Execution authorization | Admission and mandate revalidation, including a check before worker delivery. [S3–S4] | Process-local dispatch authorization and execution-time validation; change application rechecks trust and authority. [E2, E9] | EstaCoda’s inspected controls are more explicit at the runtime dispatch/change boundary. Harness’s corresponding internals remain unassessed. |
| Isolation | Per-ticket workspaces, sessions, environment overrides, and command guardrails; explicitly not an OS security boundary. [S5] | Host execution by default; configured Docker policy support; worktrees are not sandboxes. [E4, E9] | Neither default should be described as hostile-code isolation. Docker operation was not live-tested. |
| Failure recovery | Cursor preservation, bounded effect retries, preparation-failure handling, inbox recovery, outbox deferral. [S2, S4, S7–S8] | Lease/fencing checks, uncertain-operation handling, mutation recovery, channel-state recovery, and spend-reservation recovery. [E1–E2, E5, E8] | Both have substantial deterministic regression coverage, but different failure surfaces. |
| Delivery and attention | Purpose-specific reply gates, deterministic IDs, atomic local outbox/effect creation, stale-question withdrawal. [S8] | Channel state recovery and trust-aware approval continuation. [E8] | Superagent demonstrates particularly detailed team-attention semantics. Matched remote-delivery behavior remains untested. |
| Verification freshness | Full-stack equivalent not established. | Declared workspace-relative verification inputs; overlapping or unknown changes affect freshness; later edits cannot reuse old success receipts in selected tests. [E3, E9] | Useful EstaCoda control, but declared inputs are not automatic dependency analysis. |
| Provider spending | Not established for the full stack. | Estimated-cost bounds, scoped reservations, pricing/bounds denials, and retention of uncertain dispatched capacity. [E5] | A demonstrated EstaCoda runtime feature—not a guaranteed invoice ceiling or evidence that Harness lacks budgeting. |
| Persistent learning/memory | Full-stack equivalent not established. | Persistent memory, policy-qualified curation, repeated-observation skill candidates, and governed evolution proposals. [E6–E7] | EstaCoda offers demonstrated inspectable workflow learning, not model-weight training. |
| Live coding quality | Not measured. | Not measured. | **No ranking supported.** |

## 4. Differentiation, weaknesses, and tradeoffs

### Superagent: a coherent repository-team application

Its strongest differentiation is not simply “multiple agents.” It is the way team events become durable, authorized work and then appropriately timed communication.

Examples include:

- Failed source streams retain their cursors while unrelated streams continue.
- GitHub `404` is not simplistically treated as deletion because it can represent lost private-repository access.
- Source-specific identities prevent an identical Feishu ID and GitHub login from automatically sharing authorization.
- Inferred proactive work requires automatic mode, enabled matched rules, settled direction, and intent evidence.
- Person-stopped work cannot be casually revived through retry handling.
- Assignment recovery preserves messages that no worker step consumed.
- Replaced questions withdraw pending unsent attention messages. [S2–S4, S8]

These are practical safeguards against duplicate work, lost requests, noisy communication, and incorrectly resumed activity.

**Important weaknesses and qualifications:**

1. **Identity classification is not authentication.** Automation using an ordinary GitHub user account may count as human. [S2]
2. **Allowlisting is configurable, not absolute.** Configuration can admit unlisted addressed senders, with additional participating-thread semantics. “Only allowlisted people can ever create work” would be inaccurate. [S3]
3. **Bounded proactive scope remains partly model-dependent.** Instructions require independent judgment that work is small and bounded; deterministic gates do not remove that semantic dependency. [S3]
4. **Workspace separation is not sandboxing.** Workers execute under the operator’s OS user. The source expressly calls the protections default-path guardrails. [S5]
5. **Local deduplication is not unconditional exactly-once remote delivery.** The inspected outbox sends externally before settling the local receipt, leaving a possible crash window. This is a source-observed risk, not an observed duplicate-delivery incident. [S8]
6. **The research-prototype designation matters.** Passing fixtures do not override the README’s warning or prove production readiness. [S1]

### EstaCoda: general orchestration and governed reuse

EstaCoda’s strongest inspected differentiation is its explicit treatment of authority, ownership, uncertainty, and reusable workflow knowledge:

- Durable Task progression accounts for dependencies and accepted results.
- Lease identity, expiry, fencing, cancellation, and concurrency are runtime concerns.
- Delegation requires persistent service/workspace binding.
- Dispatch authority is process-local rather than based solely on serialized, model-visible receipts.
- Estimated spending reservations distinguish abandoned work from uncertain dispatched usage.
- Repeated observations become inspectable skill candidates rather than silently rewriting skills.
- Repository changes recheck trust, identity, frozen HEAD, and application authority. [E1–E6, E9]

**Important weaknesses and qualifications:**

1. **Deployment complexity is real.** Persistent services, workspace binding, trust, approval, provider configuration, and review introduce operational friction.
2. **Safety can reduce availability.** Uncertain non-idempotent operations may require review; uncertain dispatched spending can retain capacity instead of refunding immediately. [E1, E5]
3. **Verification scope is declared.** Incomplete declarations or unobserved external changes can weaken freshness guarantees. [E3]
4. **Memory persistence deserves further audit.** Low-level `hydrate` bypasses write-time budget checks, and the inspected save layer uses plain `writeFile`. This does not prove higher-level failure, but that layer alone does not establish crash-atomic persistence or universal budget enforcement. [E7]
5. **Memory is not universally approval-only.** Policy-qualified automatic application exists. Skill evolution’s approval controls should not be generalized to every memory mutation. [E6–E7]
6. **Host execution is the default.** Docker policy support is not evidence that Docker, a suitable image, or required security capabilities were provisioned. [E4]
7. **Local checks are not deployment validation.** Authenticated channels, actual billing reconciliation, live containers, and production restart/load behavior were not exercised.

## 5. Executed checks and retained receipts

These are the accepted investigators’ actual execution receipts, not new executions during synthesis. Negative-path tests that passed are successful checks of failure handling—not failed test runs.

### 5.1 Superagent application

Executed command:

```sh
cd upstream/superagent &&
node --version &&
node node_modules/vitest/vitest.mjs run \
  tests/policy.spec.ts \
  tests/sources.spec.ts \
  tests/core-engine.spec.ts \
  tests/effects.spec.ts \
  tests/outbox.spec.ts \
  tests/delivery.spec.ts \
  tests/retry-health.spec.ts \
  tests/runtime-concurrency.spec.ts \
  tests/runtime.spec.ts \
  --reporter=default
```

**Exit: `0`. Result: 9 files passed; 718 tests passed; no failures reported.**

| Suite | Passed |
|---|---:|
| `policy.spec.ts` | 328 |
| `sources.spec.ts` | 71 |
| `core-engine.spec.ts` | 113 |
| `effects.spec.ts` | 13 |
| `outbox.spec.ts` | 2 |
| `delivery.spec.ts` | 15 |
| `retry-health.spec.ts` | 29 |
| `runtime-concurrency.spec.ts` | 56 |
| `runtime.spec.ts` | 91 |
| **Total** | **718** |

Environment: Node `v24.14.1`, Vitest `4.1.8`; reported duration `8.07 seconds`. SQLite emitted an experimental-feature warning, not a failure.

Discriminating passing cases included:

- Cursor preservation after failed source/history reads: `tests/sources.spec.ts:1112,1269`.
- Consumer restart and CI-transition identities: `tests/sources.spec.ts:1176,1357`.
- Person-stopped work cannot retry: `tests/core-engine.spec.ts:1271`.
- Preservation of unconsumed messages: `tests/core-engine.spec.ts:1540–1585`.
- Recovery of running work, subagents, and interrupted inbox delivery: `tests/runtime-concurrency.spec.ts:529,597,670–710`.
- Transient launches retry three times, whereas failed preparation fails immediately: `tests/runtime.spec.ts:1575`.
- Interrupted queued effects survive shutdown: `tests/effects.spec.ts:105`.
- Failed durability barrier retries without another delivery: `tests/delivery.spec.ts:89`.
- Out-of-order retry events cannot overwrite active retry state: `tests/retry-health.spec.ts:73`.
- Paused or unregistered-source delivery defers appropriately: `tests/outbox.spec.ts:17,30`.

All test paths in this subsection are relative to `upstream/superagent/`.

**Fixture limitation:** GitHub, Feishu, Git, general commands, subprocess outputs, and worker/model behavior are mocked or simulated. These checks establish controlled application behavior, not authenticated integrations or live coding performance. [S9]

### 5.2 EstaCoda runtime

Command A:

```sh
node node_modules/vitest/vitest.mjs run \
  --config vitest.node.config.ts --reporter=dot \
  src/tasks/task-scheduler.test.ts \
  src/tasks/sqlite-provider-spend.test.ts \
  src/security/dispatch-authorization.test.ts \
  src/skills/skill-learning.test.ts \
  src/skills/skill-evolution.test.ts \
  src/execution/docker-policy.test.ts \
  src/tools/tool-executor.test.ts \
  src/tools/delegation-tools.test.ts \
  src/memory/memory-hardening-evals.test.ts \
  src/channels/channel-state-recovery.test.ts
```

**Exit: `0`. Result: 10 files passed; 256 tests passed; duration `7.27 seconds`.**

Command B:

```sh
node node_modules/vitest/vitest.mjs run \
  --config vitest.node.config.ts --reporter=dot \
  src/workspaces/change-application.test.ts \
  src/workspaces/managed-worktrees.test.ts \
  src/providers/provider-spend-policy.test.ts
```

**Exit: `0`. Result: 3 files passed; 14 tests passed; duration `922 milliseconds`.**

**Combined: 13 files passed; 270 tests passed; no reported failures or skips.**

Environment: Node `v24.14.1`, Vitest `4.1.6`, darwin-arm64. Test setup uses an isolated state home. [E10]

Discriminating passing cases included:

- Dependency order and durable result acceptance: `src/tasks/task-scheduler.test.ts:100`.
- Expired/superseded grants and competing schedulers: `src/tasks/task-scheduler.test.ts:226,249,288,504`.
- Uncertain non-idempotent work and required missing/empty result rejection: `src/tasks/task-scheduler.test.ts:582,630,643`.
- Uncertain dispatched spending retained and expired settlement rejected: `src/tasks/sqlite-provider-spend.test.ts:212,244,314`.
- Mutation recovery and missing-verifier blocking: `src/tools/tool-executor.test.ts:1397,1568`.
- Authorization revoked during assessment logging: `src/tools/tool-executor.test.ts:2995`.
- Observation does not directly write skills: `src/skills/skill-learning.test.ts:185`.
- Unsafe paths, repeated-observation thresholds, and governed proposal rejection: `src/skills/skill-learning.test.ts:327,415`; `src/skills/skill-evolution.test.ts:171`.
- Untrusted recalled content, secret rejection, and rejection of child-only corroboration: `src/memory/memory-hardening-evals.test.ts:131,212,263`.
- Corrupt/cross-profile channel-state rejection: `src/channels/channel-state-recovery.test.ts:34`.
- Later edits cannot reuse an earlier successful verification receipt: `src/workspaces/change-application.test.ts:55`.
- Frozen HEAD, explicit trust, disabled hooks/filters, and dirty-worktree preservation: `src/workspaces/managed-worktrees.test.ts:13,27,36`.

Docker negative cases used mocks/policy checks; **no live container was tested**.

Additional provenance receipts:

- `git rev-parse HEAD`: exit `0`, returning the EstaCoda revision above.
- Initial and final `git status --short`: both exit `0`, reporting:

```text
?? UPSTREAM.json
?? node_modules
?? upstream/
```

No tracked source changes appeared in those receipts.

### 5.3 Failed and missing coverage

| Item | Receipt or evidence state |
|---|---|
| Independent Harness investigation | **Failed delegated scope; no accepted result.** No supported Harness test command, exit code, count, or exact revision can be reported. |
| Failed native tests in accepted investigations | None reported. Source-observed risks must not be presented as demonstrated test failures. |
| Missing prerequisites for selected accepted tests | None blocked those selected tests. This does not validate deployment prerequisites. |
| Full clean install, build/typecheck, packaging | Not established by the accepted checks; no pass claim. |
| Equal-model live coding comparison | Not run. |
| Live GitHub/Feishu or EstaCoda channel delivery | Not run. |
| Live Docker/security-boundary testing | Not run. |
| Provider billing reconciliation | Not run. |
| Production process-kill, storage-corruption, restart/load validation | Not established by simulated local recovery tests. |
| Network provenance/latest-release verification | Not performed. |

Missing Harness receipts are **unknown**, not passing, zero failures, or proof of absent capability.

## 6. Actionable features worth borrowing

These are implementation priorities to evaluate, not assertions that the receiving stack necessarily lacks every related mechanism.

### For EstaCoda

1. **Package repository-team intake as an explicit workflow.** Separate source event, admission decision, work item, assignment, and reply purpose. Test each transition independently.
2. **Adopt purpose-specific attention contracts.** Require current-question identity for attention, ready/finished state for results, and eligible human context for answers; withdraw stale unsent questions.
3. **Expose admission as an inspectable matrix.** Make source identity, addressed/unaddressed activity, explicit/inferred admission, and matched rules visible to operators.
4. **Preserve consumption-aware recovery.** Track not only inbox delivery but whether a worker step consumed an input, then test replacement assignments and restart.
5. **Expand adapter failure injection.** Exercise revoked repository access, partial polling failure, consumer exits, repeated CI transitions, and temporary source unregistration. [S2–S4, S8]

### For Superagent + Harness operators or maintainers

1. **Verify full-stack authority before adding new mechanisms.** Audit Harness’s actual runtime controls first; the missing investigation prevents a reliable gap inventory.
2. **Evaluate durable result acceptance and dependency-aware orchestration.** General multi-stage work benefits from explicit dependency results, lease ownership, cancellation fencing, and bounded partial synthesis. [E1]
3. **Evaluate dispatch-time and mutation-time reauthorization.** Admission should not be the final authority check for consequential operations. [E2, E9]
4. **Add or verify spending reservations with uncertainty semantics.** Distinguish unused reservations from potentially billed dispatches; label estimates honestly. [E5]
5. **Make verification freshness explicit.** Bind check receipts to declared inputs and invalidate them after relevant changes, while disclosing incomplete dependency coverage. [E3, E9]
6. **Prefer governed workflow reuse over silent self-modification.** Repeated observations can become reviewed skill proposals, with clear evidence and approval policy. [E6]
7. **Treat sandboxing as a separate deployment decision.** Account shims and working directories should never be marketed as hostile-code isolation. [S5, E4]

## 7. Fair next live-benchmark protocol

### A. Close provenance and setup gaps

- Complete the independent Harness review and record its exact revision and dependency versions.
- Record both full stacks’ source revisions, prompts, tool schemas, plugins, permissions, and configuration.
- If network access is authorized, verify upstream identity and release status.
- Test clean installation, build/typecheck, packaging, and documented startup.
- Keep setup failures and missing prerequisites in the published results.

### B. Run two distinct benchmark tracks

**Controlled coding track**

Use the same model/version, provider endpoint, sampling settings where supported, context budget, output/reasoning bounds, tool budget, wall-clock deadline, network policy, and CPU/memory limits.

Use a common task runner where needed. If this bypasses Superagent’s normal GitHub/Feishu intake, disclose that it measures the coding execution path rather than the complete product workflow.

**End-to-end product track**

Use each stack’s documented workflow and recommended configuration. Include intake, authorization, delegation, implementation, validation, and delivery. Report model/configuration differences; do not attribute an unequal-model result solely to application or runtime design.

If equivalent model access is unsupported by one stack, report that limitation instead of calling the comparison equal-model.

### C. Use representative tasks and repeated trials

Include:

- Bug fixes requiring repository investigation.
- Small bounded features.
- Multi-file refactors.
- CI-failure repair.
- Inline-review follow-ups.
- Ambiguous or unauthorized requests that should pause or be refused.
- Dependency-aware delegated work.
- Restart, cancellation, changed trust, and delivery-retry scenarios.

Use fresh identical repository snapshots, reset persistent memory for the baseline, randomize order, and run repeated trials. Evaluate any memory/learning benefit separately under an explicit exposure protocol.

### D. Measure outcomes, not test counts

Primary measures:

- Hidden functional acceptance.
- Regression/security failures.
- Blinded patch-quality review.
- Human interventions and unauthorized actions.
- Duplicate or missing work and delivery.
- Wall-clock completion time.
- Tokens, observed provider charges, and estimated spend separately.
- Restart success without repeated non-idempotent effects.

Publish attempted, completed, failed, cancelled, timed-out, and setup-blocked denominators. Retain commands, exit statuses, logs, diffs, check receipts, model responses, and redacted configuration. Do not discard inconvenient trials or silently repair one stack’s output.

### E. Inject realistic faults

Test crashes around dispatch, inbox consumption, durable writes, remote send, and local receipt settlement. Include revocation after admission, stale worktree state, changed verification inputs, unavailable pricing, uncertain provider responses, and source access loss.

Use safe, authorized sandboxes. Report policy-model tests separately from actual OS/container enforcement.

## 8. Bottom line

Superagent is a substantial, deliberately specialized research prototype with strong demonstrated GitHub/Feishu workflow and recovery semantics. EstaCoda’s inspected implementation demonstrates broader durable orchestration and governance, including estimated spending controls and inspectable workflow learning.

**The supported choice is about workflow fit, not proven coding superiority.** Superagent merits evaluation for a focused repository-team automation role. EstaCoda merits evaluation where general orchestration, authorization, verification, and governed reuse are central. Neither has demonstrated superior live coding outcomes here, and the missing independent Harness evidence prevents an exhaustive full-stack judgment.

## Source index

All paths refer to the inspected local snapshots.

### Superagent application evidence

- **[S1] Identity, positioning, packaging:** `upstream/superagent/README.md:3–9,37–39`; `upstream/superagent/package.json` (`version`, `description`, `engines`, `license`, `peerDependencies`); root `UPSTREAM.json`; `upstream/superagent/docs/006-deployment.md:152`.
- **[S2] Intake and identity:** `upstream/superagent/src/sources/github-trigger.ts:1–17,23–61`; `src/sources/github.ts:157,297–344`; `src/sources/feishu-trigger.ts:17–43`; `src/sources/feishu-loops.ts:1–19`, with the latter paths relative to `upstream/superagent/`.
- **[S3] Admission and proactive scope:** `upstream/superagent/src/policy.ts:25–57,167–239`; `tests/policy.spec.ts:54–84,109–162,205–224`; `src/executor/dsh.ts:88–94`, relative application paths.
- **[S4] Assignments and launch revalidation:** `upstream/superagent/src/core/assignments.ts:90–99`; `upstream/superagent/src/executor/dsh.ts:440–468`.
- **[S5] Workspace/account guardrails:** `upstream/superagent/src/infra/environment.ts:1–5,17–18,38–57,86–115`; `upstream/superagent/src/executor/dsh.ts:96–110,171–207,237–268`.
- **[S6] Harness integration attribution:** `upstream/superagent/package.json` (`peerDependencies`); `upstream/superagent/src/infra/environment.ts:127–129`; `upstream/superagent/src/executor/dsh.ts:440–441`.
- **[S7] Effects and launch recovery:** `upstream/superagent/src/executor/dsh.ts:270–284`; `upstream/superagent/src/app/effects.ts` (`Effects`); `upstream/superagent/tests/effects.spec.ts:29–35,85–105,137–150`.
- **[S8] Reply/outbox policy:** `upstream/superagent/src/core/replies.ts:20–24,64–91`; `upstream/superagent/src/app/outbox.ts:27–50`; `upstream/superagent/src/core/assignments.ts:99–132`.
- **[S9] Test fixture boundary:** `upstream/superagent/vitest.config.ts:1–3`; `upstream/superagent/tests/fixtures/host.ts:135–178`.

### EstaCoda runtime evidence

- **[E1] Tasks and delegation:** `src/tasks/task-scheduler.ts:930–963,1958–1979,2122–2125,2256–2281`; `src/tools/delegation-tools.ts:152–199`.
- **[E2] Dispatch authorization:** `src/security/dispatch-authorization.ts:4–18`; `src/tools/tool-executor.ts:643`.
- **[E3] Verification inputs:** `src/tools/verification-inputs.ts:3–17`.
- **[E4] Execution policy:** `src/execution/docker-policy.ts:7–29`.
- **[E5] Estimated spending:** `src/providers/provider-spend-policy.ts:24–58,106–121`; `src/tasks/sqlite-provider-spend.ts:216,331,1016–1040`.
- **[E6] Skill learning/evolution:** `src/skills/skill-learning.ts:178–181,217–228,260–267`; `src/skills/skill-evolution.ts:138–153`.
- **[E7] Memory:** `src/memory/memory-store.ts:28–72`; `src/memory/memory-curation-service.ts:200–237,294–334`.
- **[E8] Channels:** `src/channels/channel-gateway.ts:469,568–583,1061–1076`.
- **[E9] Repository worktrees/change authority:** `src/workspaces/managed-worktrees.ts:36–76`; `src/workspaces/change-authorization.ts:85–99`.
- **[E10] Test environment:** `src/test/vitest-setup.ts:1–4`; root `package.json`, `vitest.node.config.ts`, and `tsconfig.json`; individual executed test cases cited in Section 5.
