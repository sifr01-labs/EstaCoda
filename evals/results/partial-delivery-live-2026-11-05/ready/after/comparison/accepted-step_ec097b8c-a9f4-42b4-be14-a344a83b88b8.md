Harness supplies substantial runtime capabilities beyond the superagent bundle. Two focused suites passed 56 tests, including policy rejection and interrupted-tool recovery.

## Scope and provenance

- Investigated **`upstream/harness` only**, with root fixture instructions and revision metadata as supporting context.
- Canonical repository URL recorded by local upstream documentation: **https://github.com/deepseek-ai/deepseek-harness**.
  - `upstream/harness/README.md:31–41` gives the clone URL.
  - `README.md:61–70` records the repository in its citation.
  - Documentation URL: https://deepseek-harness.github.io/deepseek-harness/ (`README.md:9`).
- Requested Harness revision: **`fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159`**, recorded in root **`UPSTREAM.json:3`**.
- **Revision qualification:** this is a fixture manifest pin, not independently authenticated local Git ancestry. The inspection found no separate `upstream/harness/.git`; root `git status --short -- upstream/harness` showed `?? upstream/harness/`. Do not describe this as a verified upstream checkout at that commit.
- No network requests, installs, lifecycle/build scripts, live providers, credential files, or external actions were executed. No source edits were made.
- Current upstream release, launch date, and latest revision remain **unverified**. README statements below are local source evidence, not independently verified public announcements.

The Harness README describes an open-source, plugin-based agent harness and explicitly labels it **developer preview with compatibility-breaking changes** (`README.md:5–15`). Its safety notice states it is unaudited and not secure or production-ready (`SAFETY.md`, “Experimental status”).

## Principal finding: compare the complete stack

Harness is not merely a model client underlying a clever prompt bundle. It contains implemented tool execution, sandbox-policy plumbing, approvals, durable session storage, recovery, delegation, concurrency admission, provider adapters, and deterministic performance infrastructure.

These are **host capabilities**. Their existence must not be credited as original superagent application code. Conversely, comparing EstaCoda only against the superagent bundle would omit substantial capabilities of the system required to run it.

This investigation does **not** prove that the superagent bundle mounts every available Harness plugin or exposes every tool. The application worker must establish that wiring. Presence in the runtime and implementation behind a seam are distinct from actual application enablement.

## Implementation findings

All paths below are relative to `upstream/harness/`.

### 1. Tools and execution pipeline

**Implemented, inspected:**

- `packages/core/tool-executor-native/src/index.ts:8–20`, **`NativeToolExecutor`**, projects tool schemas and invokes the shared `executeToolBatch` pipeline. Its constructor supplies a default `maxParallel` of **10**, which is an executor default, not proof of total deployed agent concurrency.
- `packages/core/tools/src/pipeline.ts:190–224`, **`ToolExecutionPipeline.prepare`**:
  1. Creates the execution context.
  2. Stops pre-dispatch cancellation.
  3. Runs `tools/pre-execute`.
  4. Resolves an `ask` through approval handling.
  5. Applies registered guards after an allow decision.
  6. Returns a model-facing error rather than invoking denied tool bodies.
- Actual tool packages include:
  - Filesystem tools: `packages/fs/tool-fs/src/index.ts:21–24,71`, **`apply`**, injecting `tools`, `fs`, `systemPrompt`, and `workingDirectory`.
  - Bash: `packages/shell/tool-bash/src/index.ts:369,543–553`, tool name `bash` and registration that adapts to whether the jobs service is present.
  - Web tools: `packages/web/tool-web/src/index.ts:2–6,14–19,23–26`, **`applyWebSearchTool` / `applyWebFetchTool`**. Availability is conditional on backend readiness; this is not proof of a configured search service.

**Documentation, corroborating but broader than the reviewed implementation slice:**

`docs/tool-execution-pipeline.md:6–27,64` describes logging, pre/around/post waterfalls, monotonic guards, approval, filesystem intents, normalization, finalization, and authoritative result observation. The inspected `prepare` method directly corroborates the pre-dispatch policy/approval/guard portion; not every documented stage received equivalent code review.

### 2. Execution isolation and security

**Implemented, inspected:**

- `packages/sandbox/sandbox-policy/src/index.ts:134–159,197–200`, **`SandboxPolicyService`**:
  - Closed policy vocabulary: `read-only`, `workspace-write`, `danger-full-access`.
  - Service default: **`read-only`**.
  - Resolves deployment defaults with session-specific mode and workspace.
  - This is a service default, **not a claim about the superagent application’s configured default**.
- `packages/sandbox/sandbox-local/src/index.ts:161–162` lists Linux candidates `bwrap`/Landlock and macOS Seatbelt.
- `packages/sandbox/sandbox-local/src/index.ts:508` throws `SandboxUnavailableError` when no runner is available.
- `packages/sandbox/sandbox-local/src/profiles.ts:16–35,53–59` implements filesystem-effect profiles:
  - Bubblewrap: root read-only binding, PID namespace, `/proc`, death with parent, and workspace writable bindings when permitted.
  - Landlock: read access to `/`, selected write grants.
  - Seatbelt: allow-default profile with denied filesystem writes except explicitly writable locations.
- `packages/ptc-runtime/ptc-runtime-node/src/index.ts:18–24,40–56`, **`NodePtcRuntime`**, declares TypeScript and **process isolation**, injects sandbox/policy services, supports configurable retained state through its execution layer, applies deadlines, and aborts/disposes live runs during teardown.

**Important limitation:** the examined profiles are primarily **file-write confinement**, not evidence of a comprehensive network/secret isolation boundary. In particular, the displayed bubblewrap arguments do not establish network isolation, and the Seatbelt profile starts with `(allow default)`. Do not equate “sandbox supported” with “all host reads, credentials, and network access isolated.”

**Project’s own warning:** `SAFETY.md`, “Experimental status” and “Sandbox limitations,” says the system may access available files, processes, network, and credentials; controls do not guarantee isolation. It recommends disposable VMs/containers and least privilege. Native isolation was **not exercised** by our checks.

### 3. Approval controls

**Implemented, inspected:**

`packages/interaction/user-approval/src/index.ts`:

- `:31–45`: session events persist approval-policy changes, including delegated child overrides.
- `:56`: closed outcomes are `allowed-once`, `rejected`, `cancelled`, and `unavailable`.
- `:151–159`: default `ask` versus unattended `never` policy.
- `:167`, **`ApprovalService`**; `:242`, **`request`**.
- `:295,301`: aborted requests cancel; `never` rejects.
- `:225–238`: the request contract explicitly makes `allowed-once` the only grant and describes missing/throwing answerers as fail-closed.

The shared tool pipeline calls approval before proceeding to guards (`pipeline.ts:203–215`). This is materially stronger evidence than an approval UI alone. However, this worker did **not** execute the approval-service test suite, and did not prove that every external backend applies identical enforcement.

### 4. Persistence and recovery

**Implemented, inspected:**

- `packages/session/session-persistence-jsonl/src/index.ts`, **`JsonlSessionPersistence`** (`:291`):
  - Validated durable append: `:905–920`.
  - Torn-tail repair before further append: `:940–946`.
  - Initial materialization uses temporary write, synchronization, and publication: `:1264–1318`.
  - Uses `link()+unlink()` rather than overwriting `rename()` publication to avoid clobbering a concurrent creator (`:1299–1301`).
  - **`appendLines`** (`:1409–1434`) appends/synchronizes and attempts rollback on partial-write or synchronization failure.
  - **`repair`** (`:1453–1454`) truncates/synchronizes the torn tail.
- `packages/core/session/src/repair.ts`, **`openTurnClosers`**, and public **`interruptedTurnClosers`**:
  - Repair dangling model tool requests.
  - Distinguish **not recorded as started** from **recorded but outcome unknown**.
  - Do not silently reinterpret an unknown side-effecting operation as safely retryable.

**Executed recovery evidence:**

`packages/core/session/tests/repair.spec.ts:320–351,370–449` checks unknown outcomes, result correlation, and exact model-visible advice: retry only read-only/idempotent actions; otherwise verify external state or ask the user.

This proves deterministic event-log repair behavior, **not end-to-end disk crash durability**. JSONL filesystem fault-injection tests were not run.

### 5. Delegation and concurrency

**Implemented, inspected:**

- `packages/subagent/subagent-spawn-in-process/src/index.ts:33–51`, **`SpawnInProcessProvider`**: fresh child conversation; shared continuation machinery.
- `packages/subagent/subagent-fork-in-process/src/index.ts:56–75`, **`ForkInProcessProvider`**: child seeded with the parent’s completed-turn prefix, captured once rather than refreshed on later resumes.
- `packages/subagent/subagent/src/activation.ts:14–34`, **`ActivationPool.reserve`**:
  - Shared process-local capacity across a subagent tree.
  - Reserves a slot before reconstruction.
  - Rejects over-capacity admission with **`ACTIVATION_LIMIT_REACHED`**.
  - Returns an idempotent release function.
- Activation records track durable child identity, run identity, provider, ancestry, local/external resources, result promises, and cleanup state (`activation.ts:37–93`).

This is real lifecycle/admission machinery, not merely an LLM emitting multiple role prompts. **In-process spawn/fork is not process security isolation.** Delegation suites were inspected only in limited source slices and were not executed.

Other adapter directories exist—ACP, Claude Code, Codex, and dsh SDK—but directory presence alone does not establish operational readiness or parity. No external backend was invoked.

### 6. Model/provider support

**Implemented, inspected:**

- `packages/llm/llm-pi-ai/src/index.ts:2–9,139–174` implements configurable provider routes, inheriting installed catalog defaults where applicable, with adapter registration and credential/configuration seams.
- `packages/llm/llm-pi-ai/src/provider.ts`, **`PROTOCOLS` / `supportedProtocols`**, implements explicit overrides for:
  - `openai-completions`
  - `openai-responses`
  - `anthropic-messages`
- Dedicated DeepSeek packages also exist, but this worker did not validate a live account/key route.

Therefore, the host is **not source-limited to a single DeepSeek model**. This does not prove that an arbitrary model/version is currently sold, configured, compatible with superagent’s instructions, or available in any region or managed service. No provider calls were made.

## Deterministic check receipt

Before execution, reviewed:

- `package.json` scripts: normal `test` runs `build:native-system` first; benchmark commands build libraries/web artifacts.
- `vitest.config.ts`, `vitest.shared.ts`, selected configuration imports and worker-budget code.
- Setup files:
  - `scripts/test-proxy-environment.ts`
  - `scripts/test-dom-environment.ts`
  - `scripts/test-official-listing-guard.ts`
- Selected policy and repair tests, including imports, setup/cleanup, negative cases, and model-visible recovery wording.

Bypassed the package lifecycle/build command and invoked the prepared Vitest binary directly:

```sh
cd upstream/harness &&
./node_modules/.bin/vitest run \
  packages/sandbox/sandbox-policy/tests/policy.spec.ts \
  packages/core/session/tests/repair.spec.ts \
  --maxWorkers=1 --reporter=verbose
```

**Verification:** `harness-checks`, `verificationInputs: ["."]`.

**Actual result:** exit **0**; **2 files passed, 56 tests passed**, no reported failed or skipped tests; reported duration **1.10 s**. Node inspection returned **v24.14.1**; runner reported **Vitest 4.1.11**.

Breakdown:

- Policy: **24 passing cases**, including invalid absolute-root rejection, invalid additional writable root rejection, invalid mode rejection, session override reconstruction, and child-fiber disposal.
- Recovery: **32 passing cases**, including interrupted/forked histories, unmatched tool outcomes, correlation mismatches, already-completed call preservation, and guarded retry wording.

Warnings: Vite reported that native tsconfig-path support can replace `vite-tsconfig-paths`; this did not fail the check.

These totals validate those local invariants only. **They are not a coding benchmark, agent success rate, or comparative performance result.**

### Inspection diagnostics and unmet prerequisites

- Initial inspection tried `vitest.node.config.ts` inside Harness: absent. The relevant Harness file is `vitest.config.ts`; this was corrected before execution.
- Initial `ls src` failed because Harness is a packages monorepo.
- A final benchmark-artifact inspection used a shell glob with no matches and printed `zsh: no matches found: benchmarks/agent-continuation/*.worker.js`; the surrounding inspection command ended **0**. This does **not** establish that every possible build artifact is missing.
- No selected-test prerequisite was missing.
- Full native/sandbox tests, application integration, approval-service tests, disk-fault recovery tests, external delegates, and live-provider checks remain **not executed**, not passing by inference.
- Broad inspection batches generally ended 0; individual unsuccessful probes above were not test failures. Some long inspection output was bounded, so claims here use observed excerpts and named symbols rather than unseen output.

## Benchmark support: what it measures

`benchmarks/agent-continuation/README.md:7,19–27` documents synthetic, network-free backend continuation workloads, including an SDK case with real file reads. It explicitly says model adapters avoid provider serialization/network calls.

Implementation exists in:

- `benchmarks/agent-continuation/agent-continuation.bench.ts`
  - Imports `runBuiltBenchmarkWorker` at `:7`.
  - Selects worker entrypoints at `:64–71`.
  - Reports worker failures at `:75`.
  - Implements median calculation at `:80`.
  - Includes calibration acceptance/rejection tests beginning at `:88–99`.
- Other benchmark areas include session corpus/opening, conversation folding, reconnects, terminal I/O, and browser/long-session behavior.

These are **runtime engineering benchmarks**, not evidence that superagent solves coding tasks better. They require a reviewed build path and built workers; neither those builds nor timing workloads were executed here.

## Implications for the parent synthesis

1. Credit Harness—not superagent application code—for generic provider routing, tool-policy plumbing, sandbox implementation, session durability/recovery, and subagent admission.
2. Check superagent’s actual plugin composition before marking any host capability “enabled.”
3. Treat its isolation as qualified, unaudited file-policy enforcement, not a comprehensive secure workload boundary.
4. A useful design opportunity for any comparator is the explicit **not-started versus unknown-outcome** recovery contract, with model-visible instructions against blind retries.
5. Compare source and deterministic invariants separately from deployed readiness and live-model effectiveness. This worker establishes no EstaCoda deployment parity, no provider availability, and no coding-performance winner.
6. For a later live evaluation, hold model/version, task corpus, clean repository state, tool/network permissions, token/time budgets, and concurrency constant; separately score correctness, cost, elapsed time, approval behavior, and recovery after interruption. That experiment was **not executed**.

No report file was saved by this worker; the requested accepted-synthesis write/readback remains the parent synthesis step’s responsibility.
