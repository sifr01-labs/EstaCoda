Harness provides a substantial runtime beneath Superagent. Tool and sandbox-policy checks passed; persistence and subagent tests hit a missing native addon. Live coding performance remains untested.

## Scope and provenance

- **Assigned scope:** `harness-runtime`; source inspection and bounded deterministic tests only.
- **Benchmark date supplied:** 2026-11-04 UTC.
- **Pinned revisions:** `UPSTREAM.json:3–4` records Superagent `8c32a9dc5d72c033816c6a8110b37f40cf94fba4` and Harness `fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159`.
- **Important identity correction:** `upstream/superagent/README.md:3` explicitly calls this a research prototype, **not an official DeepSeek product**. Line 5 says the public adaptation is not identical to the internal/article implementation and some article designs remain future directions. Line 7 identifies it as a proactive, single-GitHub-repository coding-agent bundle for Harness.
- **Locally documented Harness canonical repository:** `https://github.com/deepseek-ai/deepseek-harness`, found in `upstream/harness/README.md:34` and `:69`. This is a locally documented URL, **not a web-verified current source**.
- The inspected Superagent README links to `https://www.deepseek.com/en/harness/` at line 7. I did **not** establish Superagent’s canonical GitHub URL within this worker’s inspected evidence.
- Network discovery was unavailable. Launch timing, latest revisions, current release status and public-service availability are **unverified**.
- Root `AGENTS.md:2` explicitly characterizes these as source fixtures, not deployed services, and warns against interpreting native test counts as comparative model coding performance.

No installs, build/lifecycle scripts, source edits, external services or live model calls were performed.

## Implementation findings

### 1. Harness supplies the actual model/tool loop

**Evidence:** `upstream/harness/packages/core/agent-loop/src/agent.ts:435–610`, symbol `step`.

The implementation:

1. Prepares a provider/model request and refreshes runtime context.
2. Appends admitted system/user context into session history.
3. Streams via a prepared adapter call or `this.loopCtx.llm.stream(request)` at approximately lines 486–494.
4. Records interrupted/failed assistant attempts and successful assistant messages.
5. Routes error finishes through `agent/request-error`, permitting an explicit retry decision.
6. Extracts model tool calls; no calls ends the step as completed.
7. Invokes `this.loopCtx.tools.execute(...)` at lines 590–594, carrying cancellation, agent identity, turn/step log coordinates, parallel-call limit and the admitted tool set.
8. Admits tool-provided additional contexts into the next-step inbox and handles partial batch failures.

**Interpretation:** Superagent is not merely a prompt wrapper expected to implement its own foundational loop. Harness supplies real streaming, session-event settlement, tool dispatch and retry-extension machinery. Conversely, source existence does not establish any particular deployed provider configuration or successful live-model run.

### 2. Shared tool pipeline implements policy, cancellation and scheduling

**Evidence:**

- `upstream/harness/packages/core/tool-executor-native/src/index.ts:8–20`, `NativeToolExecutor.execute`: delegates to `executeToolBatch`.
- `upstream/harness/packages/core/tools/src/pipeline.ts:61–115`, `ToolExecutionPipeline`, `executionMode`.
- Same file `:117–181`, `createExecution`.
- Same file `:190–239`, `prepare`.
- Same file `:253–260`, dispatch cancellation contract.

Concrete behavior:

- Tool lookup is scoped to executable/admitted definitions, not arbitrary names.
- Input arguments are snapshotted as JSON and deep-frozen before execution policy.
- Parallel eligibility is **fail-closed for scheduling**: only an exact `true` from the tool’s `isConcurrencySafe` classifier permits parallel execution; missing, invalid or throwing classifiers are exclusive.
- `prepare` calls the `tools/pre-execute` waterfall, resolves `ask`, handles denial/cancellation and checks tool guards before dispatch.
- The waterfall’s terminal default is **allow**. Therefore the core pipeline is a policy extension point, **not independently a deny-by-default universal permission regime**. Effective security depends on mounted policy plugins and concrete tool implementations.
- Cancellation is checked before dispatch. The documented dispatch contract waits for an already-started body to settle rather than treating an abandoned promise as stopped execution.

**Strength:** shared enforcement machinery across executors, conservative concurrency admission, frozen arguments and explicit settlement.

**Gap/caveat:** neither pre-execute hooks nor tool guards alone prove operating-system isolation, safe MCP servers, or confinement of every plugin.

### 3. OS sandboxing exists, but platform and composition qualifications matter

**Evidence:** `upstream/harness/packages/sandbox/sandbox-local/src/index.ts`.

- `:1–21`: backend contract and explicit Windows limitations.
- `:45–65`: custom `runnerCommand` semantics.
- `:70–108`: bounded functional probe implementations.
- `:151–174`: `PLATFORM_CHAINS`.
- `:176–199`: `STATIC_ENFORCEMENT`.
- `:229–242`: runner failure classification.

Implemented platform selection:

| Platform | Source-defined runner chain |
|---|---|
| Linux | Bubblewrap, then Landlock |
| macOS | Seatbelt |
| Windows | ACL restricted-token runner |

Important qualifications:

- Linux alternatives are selected using functional probes.
- Contrary to a blanket “all backends are probed” claim, the implementation explicitly selects a single-candidate platform chain without probing; execution-time refusal must fail closed through runner failure detection.
- Windows is explicitly marked **partial**: unconfined reads and NTFS hard-link aliasing are documented limitations.
- A configured runner override skips built-in selection/probing and asserts full enforcement; operator configuration therefore matters.
- The source defines confinement failure handling, but **no real OS sandbox test was run by this worker**.
- `sandbox-policy/tests/policy.spec.ts` verifies policy semantics, **not kernel escape resistance**.

Do not equate “has sandbox packages” with “this fixture is currently sandboxed,” or “full” in the backend’s declared file-effect vocabulary with universal host/network isolation.

### 4. Persistence and recovery are substantive, but validation was prerequisite-blocked

**Evidence:** `upstream/harness/packages/core/agent-loop/src/index.ts`:

- `:679–690`: acquiring a fresh session’s persistence handle when a backend is mounted.
- `:747–757`, `resume`: requires configured session persistence and otherwise throws.
- `:761–808`, `resumeWith`: takes write ownership before loading/recovering, reads persisted events and derives `interruptedTurnClosers(persisted)` before constructing restored history.

The inspected control flow distinguishes physical persistence from agent-layer semantic repair: interrupted turns receive repair suffixes rather than silently pretending they completed normally. Persistence is optional composition, not unconditional durable storage.

**Deterministic evidence:** resume tests executed, but 34 of 51 failed with a missing native locking addon. This blocks a favorable runtime conclusion about recovery in this fixture; it does **not** demonstrate that the recovery design is absent or generally broken.

### 5. Provider extensibility is real

**Evidence:** `upstream/harness/packages/llm/llm/src/index.ts`:

- `:204–208`, `LlmAdapter`: adapter extension contract.
- `:290–302`: default prepared-call/stream interface.
- `:354–355`, `LlmRuntime`: adapter registration map.
- `:401–417`, `registerAdapter`: provider registration with disposal.
- `:442–472`: conflict handling and registration replacement.
- `:960–1014`, `prepareCall`: binds a selected adapter call and dispatch.

This supports a provider/model-plugin comparison rather than “DeepSeek-only” shorthand. It does **not** establish that every catalog model is currently available, configured or reachable.

The provider test selected by this worker uses scripted adapters: `upstream/harness/packages/llm/llm/tests/service.spec.ts`, symbols `ScriptedAdapter`, `RecordingAdapter`, `ThrowingAdapter`, `CatalogAdapter`. It does not call a live model.

**Unverified here:** actual provider coverage, transport-level compatibility, budget enforcement, fallback policy and current routing. Do not infer budget controls merely from token-meter filenames.

### 6. Subagents: implementation integration is evident, successful conformance is blocked

The inspected `upstream/harness/packages/subagent/subagent/tests/structured.spec.ts:1–100` exercises the real Harness agent loop with a mock adapter, a mounted subagent runtime, provider registration and activation-scoped structured output. It is stronger evidence than a directory listing, but remains test setup rather than a complete implementation audit.

Runtime failure traces reached:

- `upstream/harness/packages/subagent/subagent/src/manager.ts:1006`
- `:1074`, `finishDisposal`

These surfaced `ACTIVATION_TEARDOWN_FAILED` when teardown encountered the missing native locking addon.

**Limit:** this worker did not finish tracing subagent scheduling limits, nesting restrictions, persistence guarantees, external-provider lifecycle, or production isolation. Do not report that the structured-output suite passed.

### 7. Skills, memory, MCP and browser: avoid overclaiming

- A skills test was executed: `upstream/harness/packages/skill/skill/tests/skill.spec.ts`. Its inspected setup registers `SkillProvider` implementations and exercises duplicate/rank/provider resolution.
- The test’s `MemoryProvider` is an **in-memory test fixture**, not evidence of durable learned user memory.
- I did not complete a production skill-loader or automatic skill-learning audit.
- MCP/browser implementation files were located but **not inspected sufficiently to support capability/security claims**. Their directory presence should not be promoted into verified working browser automation or MCP interoperability.
- No MCP server, browser session or external service was launched.

## Harness versus Superagent integration

Observed source configuration in `upstream/superagent/cordis.patch.yml` explicitly references Harness plugins for shell sandboxing (`:45–52`), filesystem skill loading and skill invocation (`:75–78`), and subagent tools (`:102–108`). These configuration observations support **bundle integration**, not successful deployed activation.

The fair attribution is:

- **Harness:** foundational agent/model/tool execution and the inspected policy, sandbox-provider and persistence mechanisms.
- **Superagent:** the proactive GitHub/optional Feishu work-item workflow described in `upstream/superagent/README.md:7`, plus its bundle/preset integration.
- **Not established:** that all broader Harness features are exposed in Superagent’s main session or every preset. The bundle comments explicitly describe a reduced session surface, reinforcing the need to inspect exact preset composition.

## Executed deterministic tests and failure receipts

Configuration was inspected before testing:

- `upstream/harness/package.json:7–9`: pnpm and Node requirements; observed Node was **v24.14.1**.
- `package.json:61`: normal `test` script first builds native components. I deliberately bypassed that build/lifecycle step and invoked the existing Vitest executable directly.
- `upstream/harness/vitest.config.ts:199–257`: source-mode plugins, setup files, forked test lanes.
- Test implementations inspected to confirm scripted/mock model usage.

Both verification calls used scope `["upstream/harness"]`.

| Verification label | Exact command | Exit | Observed counts |
|---|---|---:|---|
| `harness-loop-policy-recovery` | `cd upstream/harness && node node_modules/vitest/vitest.mjs run packages/core/agent-loop/tests/tool-calls.spec.ts packages/core/agent-loop/tests/resume.spec.ts packages/sandbox/sandbox-policy/tests/policy.spec.ts --maxWorkers=1 --no-file-parallelism` | 1 | **104 total: 70 passed, 34 failed.** Files: 2 passed, 1 failed. Tool calls: 29/29 passed. Sandbox policy: 24/24 passed. Resume: 17 passed, 34 failed out of 51. |
| `harness-subagent-provider-skills` | `cd upstream/harness && node node_modules/vitest/vitest.mjs run packages/subagent/subagent/tests/structured.spec.ts packages/llm/llm/tests/service.spec.ts packages/skill/skill/tests/skill.spec.ts --maxWorkers=1 --no-file-parallelism` | 1 | Aggregate counts were **not recoverable in the retained bounded output**. Failure output contains structured-subagent failures and missing-addon causes. Do not invent totals or claim the other suites passed. |

### Concrete prerequisite follow-up

A subsequent `test -f upstream/harness/native/system/packages/darwin-arm64/bin/system.node` returned **1**: the fixture addon was absent.

Inspected loader: `upstream/harness/native/system/packages/entry/src/flock.ts:12–31`, `loadBinding`, and `:46–48`, `tryLockExclusive`.

The failure was:

```text
Cannot find module
/private/tmp/lifecycle-deepseek-harness/native/system/packages/darwin-arm64/bin/system.node
```

It originates from the platform addon resolution at `flock.ts:29–30`; the resolved dependency points at a prepared fixture path outside the checkout. No build, installation, environment adjustment or symlink repair was attempted. The missing addon explains the observed locking-dependent failures; a clean rerun with prerequisites prepared remains outstanding.

## Fair comparison axes and ranked takeaways for synthesis

1. **Compare full stacks.** Excluding Harness would materially undercount Superagent’s runtime. Separate implemented Harness mechanisms from bundle-selected tools.
2. **Compare effective security, not permission vocabulary.** Evaluate pipeline admission, mounted policies, actual tool-specific guards, kernel confinement, unsafe modes, runner overrides, external MCP authority and platform limitations.
3. **Make persistence readiness a separate result.** Harness has explicit write ownership and interrupted-turn repair implementation, but this fixture did not validate those paths successfully.
4. **Compare extensibility contracts separately from deployment availability.** Adapter registration is implemented; current provider credentials, model availability and runtime routes are not established.
5. **Do not equate skill loading with learning or durable memory.** This worker found no sufficient evidence for automated durable preference learning in Harness; this is an unverified scope, not proof of absence.
6. **Compare controlled coding outcomes later.** These are native conformance tests, not intelligence, autonomy or coding-productivity scores.

EstaCoda-side implementation and current runtime facts were outside this worker’s inspection. The synthesis must obtain those from its corresponding scope rather than treating these Harness findings as proof that either stack wins.

## Outstanding obligations

- Recover second test command’s complete count receipt if retained execution logs are accessible; otherwise preserve the explicit unknown.
- Complete implementation-level subagent lifecycle/concurrency, skill loading/memory, MCP/browser and budget audits before making detailed claims in those areas.
- Validate actual OS confinement and persistence recovery only in a separately authorized, correctly prepared environment.
- Establish Superagent’s canonical repository URL from local evidence or later web verification.
- No report file was written by this worker, as required by the delegation. Saving and verifying `reports/superagent-vs-estacoda.md` remains the synthesizer’s obligation.
