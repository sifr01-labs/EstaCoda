Harness has substantial runtime features, but incomplete application and EstaCoda evidence prevents a fair winner. Mock recovery checks passed; native-backed resume checks remain blocked.

# Superagent vs EstaCoda: Partial-Evidence Benchmark Report

## Executive summary

1. **No overall winner is established.** Only the Harness host-runtime investigation produced an accepted result. The Superagent application and EstaCoda runtime investigations failed and supplied no usable evidence. This report therefore provides a source-grounded Harness assessment and targeted test receipts—not a completed three-way product comparison.

2. **Harness deserves credit for substantial runtime functionality.** The inspected source implements an agent loop, cancellation/error handling, child-agent creation/resume paths, permission controls, sandbox integration, deterministic tool-result pruning, MCP integration, filesystem skills, API infrastructure, and usage accounting. These are host capabilities, not necessarily application-specific innovations or verified enabled features in Superagent.

3. **The deterministic tests have mixed, narrowly interpretable results.** A combined run returned **exit 1: 21 passed, 34 failed out of 55 tests**. The missing native flock addon prevented meaningful validation of many persisted-resume paths. A separate mock-provider request-recovery run returned **exit 0: 4 passed**. That rerun neither resolves the persistence failures nor adds four independent tests to the combined total.

4. **“DeepSeek launched an official product” is NOT established.** Pinned README metadata names a repository under `deepseek-ai`; that is not verification of a launch, official-product status, present availability, or current upstream contents.

5. **No controlled live-model speed, cost, or task-success trial was run.** Unit-test counts and runner durations cannot establish agent performance, model quality, comparative reliability, or cost efficiency.

## 1. Project identity, provenance, and research coverage

### Distinct comparison subjects

| Subject | Meaning in this report | Evidence available |
|---|---|---|
| **Superagent application** | Application-level composition, workflows, prompts, UX, and configuration | Investigation failed; no accepted application evidence |
| **Harness host runtime** | Underlying runtime services examined independently | Accepted source investigation and two targeted test receipts |
| **Superagent+Harness full stack** | Application plus the host capabilities it actually enables | Host evidence only; application wiring and end-to-end behavior unverified |
| **EstaCoda** | Comparator agent and its runtime/application paths | Investigation failed; no accepted implementation or test evidence |

A fair end-to-end comparison is **Superagent+Harness versus EstaCoda**, with application and host contributions attributed separately. An application-level comparison must not penalize Superagent for delegating functionality to Harness. Conversely, an available Harness plugin is not proof that Superagent enables or exposes it.

### Observed pins and metadata

The accepted Harness investigation reports these pins from `UPSTREAM.json:2–3`:

| Component | Recorded revision |
|---|---|
| Superagent | `8c32a9dc5d72c033816c6a8110b37f40cf94fba4` |
| Harness | `fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159` |
| EstaCoda | Not established by accepted evidence |

The Superagent pin is provenance metadata, **not evidence that the application was successfully investigated**.

Harness’s README identifies `https://github.com/deepseek-ai/deepseek-harness` at `upstream/harness/README.md:34,69`. Package metadata identifies `@deepseek-ai/dsh-root`, version `0.2.2-rc.1`, MIT licensing, Node `>=24.9.0`, and pnpm `11.28.5` at `upstream/harness/package.json:2–9`.

**Comparison date:** not recorded in the accepted evidence; none is inferred.
**Freshness:** live web access was blocked in the research context; the accepted investigation performed no live web requests. Current upstream revisions, availability, and launch status remain unknown.

All repository citations below refer to the inspected pinned snapshot, as reported by the accepted Harness worker. They are not fresh inspections of current upstream.

### Coverage limitations

| Assigned scope | Outcome | Consequence |
|---|---|---|
| `harness-host-runtime` | Completed, accepted result available | Supports the bounded findings below |
| `superagent-application` | Failed, no result available | No supported application capability inventory or composition verification |
| `estacoda-runtime` | Failed, no result available | No supported EstaCoda implementation comparison or test receipts |

This is one accepted evidence stream, not three independent investigations corroborating one another. Failed or unavailable outputs contribute no factual findings.

## 2. Capability matrix

**Evidence labels**

- **Source-only:** inspected implementation supports the statement; runtime behavior was not validated for that capability.
- **Execution-tested, bounded:** specified deterministic paths ran; scope and failures remain material.
- **Unknown:** not established, rather than absent.

For **every row below**, Superagent application enablement and the corresponding EstaCoda implementation are **unknown** because those investigations failed. The Harness column identifies potential host contributions to a Superagent+Harness stack, not verified full-stack behavior.

| Capability | Harness evidence and precise citation | Validation and limits |
|---|---|---|
| Agent/model/tool loop | Turn admission, lifecycle events, cancellation, tool disposal, structured failures, and pending-tool recovery: `upstream/harness/packages/core/agent-loop/src/agent.ts:327–434`. Request preparation and session projection: `:436–470`. | Source-only for the full loop; selected request-recovery behavior execution-tested with a mock adapter. |
| Approval versus sandbox policy | Separate durable controls for sandbox presets and approval modes: `upstream/harness/packages/interaction/permission-presets/src/index.ts:46–120`. | Source-only. Approval is not equivalent to OS confinement. |
| Local sandbox integration | Runner selection and bounded probes for bwrap, Landlock, Seatbelt, and Windows restricted-token/ACL execution: `upstream/harness/packages/sandbox/sandbox-local/src/index.ts:25–145`. Windows limitations include hard-link aliasing and unconfined reads: `:1–20`. | Source-only. No OS confinement trial. |
| Delegation and cold-resume paths | Forks use the last balanced completed-turn prefix; seed capture, depth limits, route overrides, and structured output: `upstream/harness/packages/subagent/subagent-fork-in-process/src/index.ts:38–84`. Child resume/create and persisted policy: `upstream/harness/packages/subagent/subagent/src/manager.ts:830–857`. | Source-only. Does not establish distributed scheduling or exactly-once external effects. |
| Session persistence and recovery | Real JSONL persistence composition and teardown ordering: `upstream/harness/packages/core/agent-loop/tests/resume.spec.ts:32–53`; session/event-log helpers: `:65–81`. | Execution attempted; resume suite had 17 passes and 34 failures, with a missing native prerequisite obstructing validation. |
| Context compression | Unicode-code-point tool-result pruning, rich-content ordering, and surrogate-pair handling: `upstream/harness/packages/compaction/compaction-tool-result-pruner/src/index.ts:43–127`. Replay-linked replacements and partial-commit durability: `:130–155`. | Source-only. Grapheme clusters may split; full summarizing-compaction pipeline not traced. |
| MCP integration | Server-qualified tools, namespace reservation, lifecycle cleanup, reconnect policy, and timeout defaults: `upstream/harness/packages/mcp/mcp-client/src/index.ts:1–60`. | Source-only; no external-server trial. Defaults include 60-second tool-call and 5-second cleanup bounds. |
| Filesystem skills | Discovery, frontmatter parsing, root precedence, watches, and symlink policy: `upstream/harness/packages/skill/skill-filesystem/src/index.ts:1–85`. | Source-only. Skill loading does not establish automatic learning or promotion. |
| API infrastructure | Typed remote dispatch, unary transport, and WebSocket stream multiplexing: `upstream/harness/packages/api/gateway/src/index.ts:1–65`. | Source-only; no end-to-end frontend validation. |
| Usage accounting | Disjoint usage buckets, including cache usage without double-counting reasoning output: `upstream/harness/packages/llm/token-meter/src/index.ts:56–61,87`. | Source-only. Accounting does not establish hard monetary-budget enforcement. |
| Telemetry controls | Sharing modes, explicit exporter configuration without ambient credential inheritance, bounded queues/request sizes, and shutdown bounds: `upstream/harness/packages/session/session-telemetry-otel/src/index.ts:65–125`. | Source-only; no exporter deployment test. |

Workspace isolation, GUI implementation, provider-adapter compatibility, global spending limits, background-job durability, and the complete summarizing-compaction pipeline were **not fully traced**. Their absence is not established.

## 3. Deterministic benchmark receipts

These are targeted runtime checks, not an end-to-end agent benchmark.

### Execution method and environment

The worker reviewed the normal test entry point and deliberately bypassed its native build, invoking the existing Vitest runner directly. Relevant configuration: `upstream/harness/package.json:61–66` and `upstream/harness/vitest.config.ts:1–10,130–180`.

Observed or reported execution conditions:

| Parameter | Evidence |
|---|---|
| Node | `v24.14.1` |
| Vitest | `4.1.11` |
| Test concurrency | `--maxWorkers=1` |
| Live model/provider | None; isolated recovery suite used a registered mock adapter |
| Token/dollar budget | No live-model budget exercised or measured |
| Agent concurrency | Not benchmarked; test-worker concurrency is not agent concurrency |
| Native prerequisite | Expected `darwin-arm64` system addon missing |
| Host specification | Full OS version, CPU, RAM, and load not recorded |
| Setup changes | No installs, builds, deployments, or source edits performed |

The native path identifies the expected artifact, not a complete machine specification.

### Receipt A: combined request-recovery and persisted-resume checks

```sh
cd upstream/harness && node --version && node node_modules/vitest/vitest.mjs run packages/core/agent-loop/tests/request-error.spec.ts packages/core/agent-loop/tests/resume.spec.ts --maxWorkers=1
```

| Item | Result |
|---|---|
| Exit | **1** |
| Files | 2 |
| Tests | **55: 21 passed, 34 failed** |
| Request-error suite | 4 passed |
| Resume suite | 17 passed, 34 failed |
| Reported duration | 1.19 seconds |

Reported prerequisite failure:

```text
Cannot find module
'/private/tmp/lifecycle-deepseek-harness/native/system/packages/darwin-arm64/bin/system.node'
```

The loader stack points to `native/system/packages/entry/src/flock.ts:30`. Some expectation mismatches were secondary to this error occurring before the intended injected failure.

**Interpretation:** the fixture was not ready to validate many native-backed persistence/resume paths. The 34 failures remain part of the result, but are not evidence of 34 distinct recovery defects. Successful validation of those paths requires repairing the prerequisite and rerunning; that was not done.

### Receipt B: isolated request-recovery checks

```sh
cd upstream/harness && node node_modules/vitest/vitest.mjs run packages/core/agent-loop/tests/request-error.spec.ts --maxWorkers=1
```

| Item | Result |
|---|---|
| Exit | **0** |
| Files | 1 |
| Tests | **4 passed** |
| Reported duration | 408 ms |
| Reported test execution | 18 ms |

The suite uses a mock adapter and covers middleware-failure exclusion from provider recovery, repeated retry within one turn, and cancellation winning over retry: `upstream/harness/packages/core/agent-loop/tests/request-error.spec.ts:14–125`.

A redundant `vite-tsconfig-paths` warning was nonfatal.

**Do not combine these receipts into 25 independent passing tests.** The isolated run repeats four tests already present in the combined run and does not clear the persisted-resume failures.

### What these receipts do not measure

The durations are test-runner timings—not model response time, task completion latency, or user productivity. They provide no comparative speed, cost, success-rate, or reliability ranking against EstaCoda.

There are no accepted Superagent application or EstaCoda test receipts. That is missing research coverage, not proof that either project cannot run tests.

## 4. Architecture and tradeoffs

### Substantial host runtime, not merely a prompt wrapper

The inspected Harness loop owns lifecycle events, cancellation/error handling, context projection, and recovery integration. Delegation, permissions, skills, MCP, API, and accounting are implemented as additional host services.

**Benefit:** applications can reuse substantial runtime infrastructure.

**Tradeoff:** plugin availability does not establish application activation. Composition, ordering, and lifecycle management create integration obligations; the application investigation needed to verify those obligations is unavailable.

### Persistence and child-agent continuity

Completed-turn fork seeds and explicit child create/resume paths support a design for continuable delegated work. Persistence tests also address interrupted tools, torn tails, rollback, write ownership, and scheduler failures.

**Benefit:** explicit recovery surfaces and replay-oriented state.

**Tradeoff:** native dependencies affect reproducibility. The missing flock addon blocked important checks here. Durable child state also does not guarantee exactly-once effects in external systems.

### Permission controls and confinement are separate

Independent approval and sandbox settings avoid treating a user confirmation prompt as a security boundary.

**Benefit:** clearer policy semantics.

**Tradeoff:** actual protection depends on platform enforcement and runner availability. Documented Windows limitations and the lack of executed confinement tests prohibit a blanket safety claim.

### Context preservation versus cost and information loss

Forking completed history can preserve continuity, while deterministic pruning can bound tool-result volume without a model call.

**Tradeoff:** inherited context can increase child token cost, and pruning may discard useful information. Neither task-quality preservation nor net cost savings was measured.

## 5. Supported conclusions and claim boundaries

### Supported

- Harness contains substantial implemented runtime capabilities at the inspected pin.
- Four mock-provider request-recovery tests passed in isolation.
- The combined run failed, with native-addon absence obstructing many persistence checks.
- A full-stack comparison should credit Harness contributions while verifying application enablement.

### Not established

- An official DeepSeek product launch.
- Current upstream contents, availability, or release status.
- Superagent’s actual enabled plugin set or end-to-end workflows.
- EstaCoda’s corresponding capabilities or deficiencies.
- A performance, quality, reliability, cost, or safety winner.
- Hard global monetary-budget enforcement.
- Exactly-once external effects or distributed-job guarantees.
- Live-model recovery, task success, sandbox confinement, or MCP interoperability.

## 6. Prioritized recommendations for EstaCoda

These are **audit and engineering priorities**, not findings that EstaCoda lacks the named capabilities.

| Priority | Concrete action | Acceptance evidence |
|---|---|---|
| **P0: restore comparison coverage** | Complete the EstaCoda runtime and Superagent application investigations. Trace each capability from user entry point through configuration, implementation, and tests. | Exact revisions, file/line citations, enabled-path mapping, and runnable receipts. |
| **P0: reproducible recovery validation** | Provide a documented prerequisite/preflight path for native dependencies and a deterministic recovery suite covering both systems. | Clean-fixture receipts that distinguish setup failures from behavioral failures; no silently excluded tests. |
| **P1: end-to-end cost accounting** | Verify accounting across roots, retries, children, inherited context, cache usage, and tool charges. Distinguish measured usage from enforced ceilings. | Reconciled ledger plus deterministic budget-exhaustion tests. |
| **P1: delegation and side-effect recovery** | Exercise cancellation, child cold resume, interrupted writes, and tool effects that occur before result persistence. | Recovery traces recording lost work, repeated effects, and human intervention. |
| **P1: explicit security semantics** | Audit approval separately from OS confinement; test supported platforms and unavailable-runner behavior. | Policy matrix, negative tests, and documented fail-open/fail-closed behavior. |
| **P2: evaluate context strategies** | Measure pruning and fork-seed alternatives on long-context tasks. | Quality, cost, and latency results—not token reduction alone. |
| **P2: benchmark-visible diagnostics** | Export application configuration, runtime versions, routes, costs, and intervention events with sensitive data redacted. | Reproducible manifests and independently scored results. |

## 7. Proposed fair benchmark—not executed

### Freeze comparable configurations

Record exact revisions for Superagent, Harness, and EstaCoda; an observed comparison date; dependency locks; native artifacts; hardware/OS; and sandbox settings.

Use the same exact model/provider version, region, context window, generation settings, reasoning budget where exposed, and cache policy. Match available tools, network access, task inputs, credentials, and external-service fixtures.

Predeclare equal root-plus-child token/dollar ceilings, wall-clock limits, retry limits, maximum concurrent model calls, and child-agent limits. Equal agent counts alone do not ensure equal concurrency or spending.

Run two clearly separated tracks:

1. **Matched-configuration track:** equivalent model, tools, permissions, and resource limits.
2. **Product-default track:** each product’s documented defaults, with all differences disclosed.

### Use paired, independently scored tasks

Include:

- A small bug fix with hidden regression checks.
- A multi-file change with acceptance tests.
- Delegated research with citation and completeness scoring.
- A long-context task requiring retention of critical evidence.
- An interrupted task requiring root and child recovery.

Start each pair from identical clean snapshots. Use a preregistered repetition count, randomized execution order, and blinded output scoring where practical. Report uncertainty and exclusions rather than only averages.

### Separate deterministic faults from live-model outcomes

Inject rate limits, retry cancellation, tool failure after dispatch, process death during append, torn log tails, child cold resume, and unavailable sandbox runners.

Score these independently from live-model task quality. A mock fault test and a live task answer different questions.

### Measure outcomes that matter

| Dimension | Measurement |
|---|---|
| Success | Independently verified completion, including partial success and invalid outputs |
| Time | End-to-end wall time, model/tool wait, recovery time, and human time |
| Cost | Root-plus-child usage, retries, cache effects, inherited context, and external tool costs |
| Intervention | Approvals, clarifications, corrective prompts, manual recovery, and operator minutes |
| Recovery | Lost work, duplicate effects, resumed-state fidelity, and unresolved failures |
| Safety | Unauthorized actions, confinement violations, and policy bypasses |
| Reproducibility | Exact manifests, commands, failures, exclusions, and variability |

Report cost per successful task alongside total spend and completion rate; do not hide failed-run costs. Keep prerequisite failures visible and document any corrected reruns.

## Bottom line

The available evidence supports a substantial Harness runtime and a narrowly successful mock request-recovery check. Native-backed resume validation remains obstructed, and the missing Superagent application and EstaCoda investigations prevent a defensible product ranking.

A fair verdict requires equivalent full-stack paths, complete prerequisite handling, and a controlled same-model trial measuring success, total cost, elapsed time, and human intervention. None of those live-model comparative outcomes has yet been established.
