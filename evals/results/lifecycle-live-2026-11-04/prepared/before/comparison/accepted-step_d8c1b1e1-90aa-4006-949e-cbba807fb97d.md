The likely match is a research prototype, not an official DeepSeek product. Its workflow tests passed, but no fair live-model coding comparison with EstaCoda has yet been run.

# Super-agent versus EstaCoda: source and deterministic-test benchmark

**Comparison date:** 2026-11-04 UTC
**Assessment type:** pinned-source review plus targeted native tests—not a controlled comparative coding benchmark.

## Executive findings

1. **The likely match is `dsh-superagent`, but the reported launch is not independently verified.** Its README explicitly states: **“Research prototype for reference only, not an official DeepSeek product.”** It also warns that the published implementation differs from the internal system and the accompanying article; some described designs remain future work. This report evaluates the inspected prototype, not an official production offering or every claim in the article. [S1]

2. **Superagent is a workflow bundle; EstaCoda is being assessed as a broader agent runtime.** Superagent supplies repository/chat intake, admission policy, tickets, assignment coordination and persistent effects. Its sessions, tools and other execution facilities rely on the Harness host. Treating the bundle alone as a complete runtime would misattribute capabilities and omissions. [S2–S4]

3. **Both inspected snapshots have substantive deterministic recovery evidence.** Superagent passed **510 selected tests** covering admission, core workflow, effects and concurrency. EstaCoda passed **288 selected tests** covering durable scheduling, constrained delegation, spend enforcement, learning, memory, routing and channel state. **These counts are not comparable capability scores.** [R-S, R-E]

4. **The useful distinction is workload fit, not an overall winner.** Superagent is a credible prototype to investigate for persistent, team-facing, single-repository GitHub/Feishu work. EstaCoda has tested mechanisms relevant to general durable orchestration, inherited authority and budget limits, and evidence-linked learning. Neither result establishes better coding quality, lower cost or higher production reliability.

5. **Security requires a separate deployment decision.** Superagent’s documented sessions use `danger-full-access` under the operator’s OS identity; its admission controls are not an OS sandbox. EstaCoda’s tested policy and accounting boundaries likewise do not establish resistance to sandbox escapes or arbitrary prompt-injection attacks. [S5; E2–E3]

**Practical recommendation:** Do not replace EstaCoda on the strength of a “new DeepSeek super-agent” headline. First verify the upstream identity, complete the missing Harness assessment, and run matched end-to-end tasks. Meanwhile, Superagent’s ticket/mandate/effect design is worth studying as a repository-automation workflow—not treating as evidence of superior intelligence.

## 1. What was found—and what remains unverified

### Likely identity

The inspected package identifies itself as:

| Field | Observed value |
|---|---|
| Package | `dsh-superagent` |
| Package version | `0.1.0` |
| License field | MIT |
| Author field | `DeepSeek Harness Team <team@dsh.dev>` |
| Node requirement | `^22.19.0 || >=24.0.0` |
| DSH requirement | `^0.2.1-alpha.2` |

These are **local package metadata**, not independent verification of authorship, launch timing or current availability. [S2]

The README links to [DeepSeek Harness](https://www.deepseek.com/en/harness/). That URL was observed in source; its live contents were not fetched or independently verified. [S1]

An earlier extraction attempt against a **guessed GitHub repository address** failed because networking was disabled. The accepted research results did not establish an authoritative repository URL. Consequently:

- The inspected package is a **likely match** to the user’s description.
- The reported launch, official association, current release and latest revision remain **unverified**.
- The failed request proves neither that the guessed repository exists nor that it does not.
- No guessed repository address is presented here as an authoritative project link.

### Research coverage

| Assigned scope | Outcome | Evidence used |
|---|---|---|
| `superagent-bundle` | Completed | Accepted source inspection and executed test receipts |
| `estacoda-runtime` | Completed | Accepted source inspection and executed test receipts |
| `harness-runtime` | **Failed; no accepted result** | None |

This is therefore a **partial synthesis of three assigned scopes, using two accepted results**. Harness-related observations below come only from the bundle’s dependency declarations, integration code and documentation. They are not an independent assessment of Harness internals. An unaccepted diagnostic draft was not used as evidence.

## 2. Snapshot provenance and reproducibility

| Subject | Pin or observation | Qualification |
|---|---|---|
| Superagent | `UPSTREAM.json:2` records `8c32a9dc5d72c033816c6a8110b37f40cf94fba4` | Snapshot provenance; the worker did not verify a Git checkout at this revision |
| Root/EstaCoda fixture | Executed `git rev-parse HEAD` returned `5a9f397a8063d6235157282c4bda77e20c93c71c` | Observed fixture HEAD, not a claim about a current public release |
| EstaCoda subject baseline | `MANIFEST.json` declares `bed689970f442caa9cf44432eeeec30bed9f05de` | **Not an unmodified checkout:** the manifest lists updated hashes for 21 files |
| Comparison date | Executed `date -u +%Y-%m-%d` returned `2026-11-04` | Date of this assessment, not a release date |

The EstaCoda manifest describes a prepared experimental fixture with upstream/dependency preparation, token-ceiling stress, an isolated learning skill and deliberate setup/policy fault injection, without web or Telegram transport. Its reference to real Codex execution describes fixture provenance; it does **not** mean the checks in this report executed live-model tasks. Manifest hashes were observed, not independently recomputed. [E1]

Neither accepted worker reported source/configuration edits, dependency installation or credential reads. Tests used existing dependencies. The inspected fixture is not evidence of production deployment, current provider health or operational history.

## 3. Concise feature matrix

**Evidence labels:** **Implemented** means inspected source or documentation; **Tested** means included in the executed native suites; **Inference** means a workload judgment. “Not established” is not a finding of absence.

| Dimension | Superagent bundle | EstaCoda fixture |
|---|---|---|
| Main workflow | **Implemented:** one GitHub repository, optional Feishu intake, tickets and assignments [S1, S3] | **Implemented/tested:** durable task/delegation runtime with provider and channel machinery [E2, E6] |
| Admission and authority | **Tested:** source-specific identity policy, mandate revalidation, policy-change races [S3] | **Tested:** inherited tool ceilings, blocked tools, parent leases, spawn/deadline/concurrency constraints [E2] |
| Durable execution | **Tested:** SQLite effects, ordering, coalescing, retries, drain/restart and assignment recovery [S4] | **Tested:** leases/fencing, accepted results, publication atomicity, retry-safe recovery and cancellation [E2] |
| Provider spend limits | Comparable host-wide enforcement **not established** by accepted bundle evidence | **Tested:** atomic reservations, cross-process limits, pre-adapter denial and conservative uncertain-spend handling [E3] |
| Worker tools | **Implemented:** bundle selects/restricts Harness session tools; host executes them [S2, S5] | **Tested:** child access intersects parent authority and requested toolsets [E2] |
| Learning | Host/bundle counterpart **not established** | **Tested:** evidence-linked drafts, policy-gated promotion, narrow automatic correction with snapshot/undo [E4] |
| Memory curation | Comparable general curation **not established** | **Tested:** audited low-risk apply, review queues, failure-safe cursors and cutoff validation [E5] |
| Integrations and UI | **Implemented:** GitHub/Feishu workflow and web panel; no live integration/UI exercise [S1, S3] | **Implemented/tested locally:** provider routing and channel state/adapter traits; no live transport exercise [E6] |
| OS containment | **Documented:** `danger-full-access`; operator-user execution [S5] | OS sandbox containment **not assessed** |
| Coding success, cost and latency | **Not measured comparatively** | **Not measured comparatively** |

## 4. End-to-end execution, security and recovery

### Superagent: intake → policy → ticket → worker → persistent effects

The inspected workflow accepts repository/chat activity, evaluates admission policy, creates or updates ticket work, and coordinates worker sessions through Harness. Core tests cover mandate, subscription, acknowledgment, assignment and transactional acceptance. [S3]

Its authorization is more nuanced than “ignore every nonmember.” Tests distinguish explicit authority, configurable inferred admission, and follow-up/context paths. They also cover source-specific identities and revalidation when policy changes during assessment. A Feishu identity does not automatically grant GitHub authority. [S3]

Persistent effects use SQLite-backed rows, transaction-aware dispatch, per-kind concurrency and optional strict ordering. The implementation includes coalescing, exponential retry, deferral without incrementing failure count, and generation checks preventing stale completion from deleting newer work. Tests cover transaction rollback, restart persistence, cancellation/requeue, interrupted assignments and launch/delivery races. [S4]

**Important limit:** recovery notes instruct workers to inspect Git/GitHub before repeating outside actions. That is useful recovery design, not proof of exactly-once external effects.

### EstaCoda: durable task → authority/budget admission → execution → accepted result

The executed scheduler tests cover dependency ordering, durable result acceptance, ownership fencing, competing schedulers, deterministic backoff, publication retry and rejection of late success after cancellation or lease expiry. **Uncertain non-idempotent work pauses for operator review rather than blindly retrying.** [E2]

Delegation tests establish that children cannot simply widen the parent’s authority or resource envelope. They cover non-parent-visible tools, blocked names/prefixes, spawn depth, expired parent leases, ancestor deadlines, root monetary scope and concurrent budget reservations. [E2]

Provider-spend tests exercise denial before adapter entry, unknown-price fail-closed behavior under limits, atomic reservations across scopes/processes, protection of synthesis capacity, and conservative retention of capacity after uncertain dispatch. These are local accounting/admission guarantees—not provider invoice reconciliation. [E3]

### Security conclusion

Superagent has tested **who may authorize work**, but its documented execution mode gives workers substantial host-user access. Deployment documentation says workers can execute programs by path and read the operator’s home directory; account wrappers are not process isolation. A dedicated OS account is recommended. [S5]

EstaCoda has tested **runtime authority, delegation and spending constraints**, but this study did not establish an OS containment boundary for it.

For either system, production evaluation must separately test hostile repository content, malicious tool output, secret exposure, destructive commands and external side effects. Passing application-policy tests is not security certification.

## 5. Executed deterministic checks

The following are **actual worker-reported executed commands**, not proposed checks. They were not rerun during synthesis. Package scripts were inspected before testing.

### Commands

**S — Superagent policy, workflow, effects and concurrency**

```sh
cd upstream/superagent && ./node_modules/.bin/vitest run tests/policy.spec.ts tests/core-engine.spec.ts tests/effects.spec.ts tests/runtime-concurrency.spec.ts
```

**E-A — EstaCoda scheduling, budgets, delegation, learning and memory**

```sh
node node_modules/vitest/vitest.mjs run --config vitest.node.config.ts src/tasks/task-scheduler.test.ts src/tasks/sqlite-provider-spend.test.ts src/tasks/provider-spend-cross-process.test.ts src/delegation/durable-delegation-service.test.ts src/delegation/toolset-security.test.ts src/providers/provider-spend-enforcement.test.ts src/skills/skill-lifecycle.test.ts src/memory/memory-curation-service.test.ts --reporter=dot
```

**E-B — EstaCoda provider routing/fallback and channel state**

```sh
node node_modules/vitest/vitest.mjs run --config vitest.node.config.ts src/providers/provider-executor-route.test.ts src/providers/provider-executor-fallback.test.ts src/channels/channel-state-recovery.test.ts src/channels/adapter-capability.test.ts --reporter=dot
```

### Results

| Command/suite | Status | Passing tests | Reported duration |
|---|---|---:|---:|
| S: `policy.spec.ts` | Passed | 328 | 32 ms |
| S: `core-engine.spec.ts` | Passed | 113 | 106 ms |
| S: `effects.spec.ts` | Passed | 13 | 335 ms |
| S: `runtime-concurrency.spec.ts` | Passed | 56 | 7,679 ms |
| **S total: 4 files; Vitest 4.1.8** | **Exit 0** | **510** | **8.28 s overall** |
| **E-A: 8 files; Vitest 4.1.6** | **Exit 0** | **178** | **7.89 s overall** |
| **E-B: 4 files** | **Exit 0** | **110** | **462 ms overall** |
| **EstaCoda total: 12 distinct files** | **All selected files passed** | **288** | Separate runs; not a throughput benchmark |

No selected test failed. Superagent emitted an experimental SQLite warning. Both EstaCoda commands were bounded to 30 seconds. [R-S, R-E]

**Do not compare 510 with 288, or compare these durations as agent performance.** Suite breadth, test construction, mocks, runner versions and workloads differ.

### Failed attempts and omitted checks

- **Live discovery:** the earlier web extraction failed with networking disabled; authoritative repository identity and launch freshness remain unresolved.
- **Superagent exploration:** a compound discovery command exited 1 because its final `command -v vitest` found no global executable. The local binary subsequently ran successfully:

  ```sh
  pwd; date -u +%Y-%m-%d; ls -d node_modules upstream/superagent/node_modules 2>/dev/null; find . -name UPSTREAM.json -not -path '*/node_modules/*' -maxdepth 4; cat upstream/superagent/vitest.config.ts; command -v node; command -v pnpm; command -v vitest
  ```

- **Incorrect inspection path:** reading `upstream/superagent/tests/fixtures/runtime.ts` returned `ENOENT`. This was not a failing test prerequisite.
- **Unproductive search:** a broad globbed search returned no matches; it supports no capability conclusion.
- **EstaCoda inspection limit:** runtime adapter wiring was observed by grep; a subsequent bounded read did not return the relevant body.
- **Missing scope:** the independent Harness worker failed. No host-runtime test counts or diagnostic claims are included.
- **Not run:** full suites, typechecks, builds, production setup, live providers, live GitHub/Feishu/channel operations, UI/browser validation, Docker/deployment validation, adversarial containment tests, or a controlled live-model comparative coding benchmark.

## 6. Verdict by workload

| Workload | Candid verdict |
|---|---|
| Persistent single-repository GitHub/Feishu work | **Superagent is a directly relevant prototype to trial.** Its ticket, mandate and recovery workflow has source and targeted-test support. Live task completion and deployment safety remain unmeasured. |
| General durable orchestration with nested workers and bounded spend | **EstaCoda has directly tested mechanisms relevant to this workload.** Superagent/Harness equivalence or inferiority cannot be determined with the host scope missing. |
| Repeat workflows that become skills or curated memory | **EstaCoda has evidenced lifecycle machinery.** Actual learning benefit and long-horizon recall were not measured; counterpart evidence is incomplete. |
| Autonomous coding quality, speed or cost | **No winner established.** Neither native test run measures model-driven coding performance. |
| Untrusted repository execution or sensitive host access | **No production-safety endorsement for either system.** Superagent has an explicit broad-access warning; EstaCoda containment was not evaluated. |
| Production integrations and service reliability | **Undetermined.** Local source/test evidence is not live transport health or operational history. |

## 7. Fair future evaluation protocol

A useful next experiment should measure matched workloads rather than convert native suite counts into scores.

### Freeze the comparison

1. Verify the authoritative Superagent repository and launch source; record immutable commits, package versions and dependency locks.
2. Complete the Harness source/runtime assessment and record the exact bundle-plus-host combination.
3. Record EstaCoda’s fixture HEAD, baseline, modifications and independently recomputed hashes.
4. Use clean, equivalent disposable environments with the same OS, CPU/RAM, network rules, tool versions and repository starting state. Keep host secrets absent.
5. Make permissions and integration privileges equivalent. If capabilities cannot be matched, report that explicitly.

### Match model and resource conditions

Use the same exact model/version, provider endpoint, sampling settings and context limits where both systems support them. Match:

- Total token and monetary ceiling, including workers, retries, review and synthesis.
- Wall-clock limit and concurrent-worker ceiling.
- Task instructions, visible tests, credentials/scopes and human-intervention policy.

If the systems cannot use the same model, label the experiment a **system-plus-model comparison**, not a runtime-only result.

### Run representative tasks

Use a predeclared corpus—for example, 24 tasks split across bug fixes, features, refactors and repository/issue workflows—with three independent trials per task/system. Include multi-file work, ambiguous intake, test repair and long-running work interrupted mid-execution. Use held-out acceptance tests and blind review of patches.

Measure:

- Accepted task completion and hidden-test pass rate.
- Regressions, patch validity and unnecessary changes.
- Human interventions and review effort.
- End-to-end latency, tokens, billed cost and budget overruns.
- Unauthorized actions and denied-action handling.
- Duplicate/lost effects, stale result acceptance, recovery latency and operator escalations.

### Include negative and recovery cases

Inject, in disposable environments:

- Unauthorized senders and source-identity mismatches.
- Policy revocation during assessment.
- Child requests for forbidden tools, extra budget or greater concurrency.
- Zero budget, unknown pricing and simultaneous final-capacity reservations.
- Provider failures, uncertain usage and empty-content/tool-call edge cases.
- Worker-slot saturation and competing schedulers.
- Cancellation during launch/delivery and late success after cancellation.
- Crashes before dispatch, after dispatch and before acknowledgment.
- Corrupt persisted state and stale leases.
- Prompt injection in issues/files, attempted secret access and duplicate external actions.

Record intervention traces, denied actions and all failures—not just successful patches. Report per-workload results with uncertainty, and separate **application correctness**, **runtime recovery**, **security containment** and **model task quality**.

## 8. Source and receipt references

Paths below are snapshot-local citations, not claims about current public repository contents.

### Superagent scope

- **[S1]** `upstream/superagent/README.md:3–7` — prototype disclaimer, published/internal/article differences, workflow description and source-observed Harness link.
- **[S2]** `upstream/superagent/package.json` — identity, version, license, author, engines, scripts, DSH metadata and Harness peer dependencies; `UPSTREAM.json:2` — recorded revision.
- **[S3]** `src/policy.ts` (`settingsPolicy`, `gate`, `revalidate`); `tests/policy.spec.ts:61,82–86,104–105,205–222`; `tests/core-engine.spec.ts:115–146`; `src/core/tickets.ts:113,257`. Paths relative to `upstream/superagent/`.
- **[S4]** `src/app/effects.ts` (`Effects.enqueue`, `dispatch`, `attempt`, `drain`); `tests/effects.spec.ts:29,51,85,105,160,174`; `tests/core-engine.spec.ts:701–723`; `tests/runtime-concurrency.spec.ts`; `docs/003-execution.md`, “Restart” and “Stored work.”
- **[S5]** `src/app/sessions.ts:61,137–152,292`; `docs/006-deployment.md:13–19`; `docs/007-architecture.md:532`.

### EstaCoda scope

- **[E1]** Executed `git rev-parse HEAD`; `MANIFEST.json` baseline, `updatedSourceHashes` and `scope`; `src/test/vitest-setup.ts:1–4`.
- **[E2]** `src/tasks/task-scheduler.test.ts:100,226,249,288,504,552,582,717,780,841,1201,1363,1381`; `src/delegation/durable-delegation-service.ts:202–203`; `src/delegation/toolset-security.ts:52,96`; corresponding executed tests, including delegation cases at `:912,967,1000,1048,1167,1200,1325,1350`.
- **[E3]** `src/tasks/sqlite-provider-spend.ts:66,105,1062`; `src/providers/provider-spend-policy.ts:24`; executed provider-spend enforcement, SQLite accounting and cross-process suites.
- **[E4]** `src/skills/skill-lifecycle.test.ts:77–358`; `src/skills/skill-learning.ts:245–268,409,439–448`.
- **[E5]** `src/memory/memory-curation-service.test.ts:34,120,171,296,330,410,441`.
- **[E6]** `src/runtime/create-runtime.ts:1854–1904` via grep; executed provider routing/fallback, channel-state recovery and adapter-capability suites. Adapter labels are static metadata, not live checks.

### Accepted delegated receipts

- **[R-S]** `superagent-bundle`, accepted durable result `e8a139aa-2a22-48d9-9199-7139d7241ecd`.
- **[R-E]** `estacoda-runtime`, accepted durable result `68ce7df8-edc6-4b1a-be32-67b03b7b963d`.

**Bottom line:** the inspected Superagent is a meaningful repository-automation research prototype, not verified evidence of an officially launched DeepSeek production agent or a superior coding system. EstaCoda’s fixture shows substantial tested runtime controls. A matched live-model evaluation—and the missing Harness assessment—are necessary before claiming a performance winner.
