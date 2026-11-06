Harness supplies real tool execution, policy gates and conservative crash recovery. Two focused suites passed 56 tests; live models and OS confinement were not exercised.

## Scope and revision

Inspected **`upstream/harness` only**, as the potential host of Superagent. This establishes host implementation capabilities, **not that Superagent enables every capability**.

`UPSTREAM.json:1–4` pins:

- Harness: `fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159`
- Superagent: `8c32a9dc5d72c033816c6a8110b37f40cf94fba4`

No network, installation, deployment, or source edits were performed. Launch recency and latest upstream state remain unverified.

## Implementation findings

### 1. Actual native tool execution and approval gates

**Observed implementation**

- `upstream/harness/packages/core/tool-executor-native/src/index.ts`, `NativeToolExecutor`:
  - Projects tool definitions into model-facing schemas.
  - Constructs a `ToolExecutionPipeline`.
  - Executes batches through `executeToolBatch`, with default maximum parallelism of **10**.
  - Installs the executor into the mounting Cordis scope via `ctx.tools.setExecutor(...)`.
- `upstream/harness/packages/core/tools/src/pipeline.ts:100–180`, execution classification and preparation:
  - Only an explicit concurrency-safe declaration permits parallel classification; unknown, hidden or otherwise unsuitable calls are exclusive.
  - Execution arguments are detached through JSON snapshotting and frozen.
  - Executor-owned refusals precede extensible policy.
- `upstream/harness/packages/core/tools/src/pipeline.ts:190–233`, `prepare`:
  - Runs the scoped `tools/pre-execute` waterfall.
  - Services an `ask` decision through `serviceAsk`.
  - Handles cancellation and denial before dispatch.
  - Checks tool guards after an allow decision.
- `upstream/harness/packages/core/tools/src/pipeline.ts:258–280`, `dispatchToolBody`:
  - Resolves the registered tool.
  - Actually invokes `await tool.execute(exec.arguments, exec)`.
  - Fuses the caller cancellation signal with a wrapper signal.
  - Waits for an already-started body to settle rather than abandoning it when cancelled.
- `upstream/harness/packages/core/tools/src/pipeline.ts`, `complete`, `postExecute`, `createSuccessResult`:
  - Source inspection located post-execution policy and output-schema validation, plus canonical result materialization.

**Implication**

This is a runtime execution path, not merely a prompt/tool catalog. Approval is an extensible gate before invocation. The inspected default policy-waterfall continuation is **allow**, so the existence of approval plumbing must not be presented as “every tool always requires approval.” Which policy plugins Superagent actually mounts was outside this worker’s scope.

**Unverified:** end-to-end agent-loop-to-model-to-tool execution; actual approval UI/transport, default Superagent policy composition, and native-tool execution tests.

### 2. Sandbox policy versus actual confinement

**Policy layer**

`upstream/harness/packages/sandbox/sandbox-policy/src/index.ts`, policy resolution and configuration:

- Separates deployment fallback policy from per-session policy.
- Validates absolute workspace/additional writable paths without host-normalizing remote execution-world paths.
- Contributes resolved policy to the runtime-context snapshot.
- Enforcement remains the responsibility of filesystem, shell and terminal backends—not the prompt text.

Focused tests inspected in
`upstream/harness/packages/sandbox/sandbox-policy/tests/policy.spec.ts` include:

- Default read-only policy: line 46.
- Rejecting relative additional writable roots: line 88.
- Approved mode outranking session mode: line 147.
- Rejecting unknown mode vocabulary: line 163.
- Reconstructing resumed policy from the session log: line 263.

**Local confinement backend**

`upstream/harness/packages/sandbox/sandbox-local/src/index.ts:24–190`, imports, probes and platform chain definitions:

- Linux chain: **bubblewrap, then Landlock**.
- macOS: **Seatbelt**.
- Windows: **ACL/restricted-token runner**.
- Linux’s competing candidates use functional probing; singleton platform chains are selected without a probe, with execution-time refusal handling.
- Probe calls have bounded timeouts.
- Windows enforcement is explicitly classified **partial**, including unconfined reads and hard-link-related limitations.
- A custom runner override skips built-in selection/probing and asserts full enforcement; its configured failure signatures are therefore an important trust/configuration boundary.

The backend documents fail-closed behavior rather than returning unconstrained argv when confinement is unavailable. The bounded inspection did **not** trace every error branch to verify that property independently.

**Implication**

There is substantive platform-specific confinement code, but it should not be flattened into “universal sandbox security.” Policy unit tests do not demonstrate kernel-level confinement, and Windows intentionally has weaker stated guarantees.

**Unverified:** actual confinement on this host, escape resistance, network isolation, OS runner availability, and native addon readiness. No native build was attempted.

### 3. Sessions and subagents

`upstream/harness/packages/subagent/subagent-spawn-in-process/src/index.ts:33–65`, `SpawnInProcessProvider`:

- Registers a subagent provider through `ctx.subagents.registerProvider(...)`.
- Declares support for agent options, agent presets, structured output schema and depth limits.
- Explicitly sets `inheritsParentContext = false`.
- `prepareContinuable()` supplies an empty seed: a spawned child starts fresh, while a separate continuation manager owns subsequent operations.

This proves a provider-level distinction between fresh child context and continuation ownership. It does **not**, by itself, prove actual depth-limit enforcement or complete continuation recovery.

Additional implementation search located separate external-process integrations:

- `upstream/harness/packages/subagent/subagent-dsh-sdk/src/run.ts`
- `upstream/harness/packages/subagent/subagent-acp/src/run.ts`
- `upstream/harness/packages/subagent/subagent-codex/src/run.ts`
- `upstream/harness/packages/subagent/subagent-claude-code/src/run.ts`

These were **located, not fully audited or run**. Do not count their presence as demonstrated interoperability or inherit the host sandbox guarantees across those boundaries.

### 4. Provider/model support

`upstream/harness/packages/llm/llm-pi-ai/src/index.ts:1–100`:

- Imports the real `PiAiAdapter`, provider profile resolution, model discovery, authentication helpers and provider defaults.
- Exposes a generic pi-ai-backed LLM plugin with provider-route configuration.
- Its declared design supports inherited catalog defaults and explicitly declared compatible endpoints, plus per-request settings/credential resolution.
- Source examples include OpenAI, Anthropic and a custom OpenAI-compatible endpoint. **Examples are not evidence those services were called successfully.**

Implementation files for a dedicated DeepSeek adapter were also observed under
`upstream/harness/packages/llm/llm-deepseek/`.

**Safe comparison statement:** Harness has adapter/plugin infrastructure for multiple provider routes; it is not structurally limited to one DeepSeek model.

**Unverified:** exact currently usable model IDs, regions, managed-service availability, credentials, protocol fidelity against live APIs, and whether Superagent exposes these routes. No live-model coding benchmark was run.

### 5. Persistence and conservative recovery

**Persistence implementation**

`upstream/harness/packages/session/session-persistence-jsonl/src/index.ts:1–180`:

- Defines a filesystem JSONL persistence backend.
- Requires an explicit root.
- Defaults to **checksummed Zstandard frames**, with an uncompressed option.
- Contains stored-log state for torn-tail truncation and complete events recovered from a torn final frame.
- Separates already-current durable generations from prepared historical migrations pending publication.
- Imports lease, generation/migration and durable publication machinery.

This was a bounded read of a large implementation, **not a completed durability audit or persistence integration test**.

**Recovery implementation**

`upstream/harness/packages/core/session/src/repair.ts:1–160`, `openTurnClosers` and `ToolCallRecovery`:

- Repairs pending tool results for failed live steps, interrupted logs and fork seeds.
- Distinguishes:
  - `TOOL_NOT_STARTED`
  - `TOOL_OUTCOME_UNKNOWN`
- For a recorded call without a durable result, synthetic model-visible guidance explicitly warns against blind retries: verify external state or ask the user before retrying potentially side-effecting work.
- Closes open step/turn boundaries deterministically.
- Leaves balanced histories unchanged.
- Uses cause-specific wording for interrupted execution versus forked history.

**Implication**

Recovery is deliberately conservative about **unknown side effects**, rather than claiming exactly-once tool execution. That distinction is useful in the comparison.

### 6. Extensibility

The inspected native executor, subagent provider and LLM plugin use Cordis-scoped services and registration. The execution pipeline additionally exposes pre-execute, around-dispatch and post-execute policy seams.

Evidence:

- `upstream/harness/packages/core/tool-executor-native/src/index.ts`, `apply`
- `upstream/harness/packages/core/tools/src/pipeline.ts`, `prepare`, `dispatch`, `postExecute`
- `upstream/harness/packages/subagent/subagent-spawn-in-process/src/index.ts`, `apply`
- `upstream/harness/packages/llm/llm-pi-ai/src/index.ts`

This supports **runtime/plugin extensibility**. Hot reload, arbitrary third-party plugin safety and complete plugin lifecycle behavior were not demonstrated.

## Executed verification

### Preflight review

Reviewed:

- `upstream/harness/package.json`
- `upstream/harness/vitest.config.ts:1–200`
- Policy test declarations before execution.

Important choices:

- Package requires Node `>=24.9.0`; observed runtime was **Node v24.14.1**.
- The package’s ordinary `test` script first builds the native system addon.
- I deliberately invoked the existing local Vitest binary directly for narrowly selected tests, avoiding native builds, lifecycle scripts, installation and network access.
- `verificationInputs` was declared as `["."]`.
- Vitest configuration executes a local PowerShell availability probe; no network action was observed.

### Actual command

```sh
cd upstream/harness &&
node --version &&
./node_modules/.bin/vitest run \
  packages/sandbox/sandbox-policy/tests/policy.spec.ts \
  packages/core/session/tests/repair.spec.ts \
  --maxWorkers=1
```

**Observed result: exit code 0**

```text
Node: v24.14.1
Vitest: v4.1.11

sandbox-policy/tests/policy.spec.ts: 24 passed
core/session/tests/repair.spec.ts: 32 passed

Test Files: 2 passed (2)
Tests:      56 passed (56)
Duration:   496 ms
```

Reported test execution times: policy **24 ms**, repair **6 ms**. These are local unit-suite timings, **not agent coding-performance measurements**.

Nonfatal warning: Vite reported that `vite-tsconfig-paths` could be replaced by native `resolve.tsconfigPaths`.

Process completion was independently collected through `process.logs`: **closed with code 0, signal null**.

### Failure and prerequisite accounting

- **Failed tests:** none in the two executed suites.
- **Failed test prerequisites:** none encountered for these suites.
- **Unattempted prerequisite:** native addon build/availability; dependencies were supplied without lifecycle scripts, and no native-dependent check was attempted.
- An auxiliary attempt to call `file.grep` inside `execute_code` returned “Tool is not available inside execute_code.” Direct exposed file tools were then used; this was an inspection-tool limitation, not a Harness failure.
- Some broad output was truncated; findings above rely on retained targeted reads or explicitly bounded observations, not unseen output.

## Outstanding obligations and limits for synthesis

1. Confirm which Harness plugins, provider routes, policies and subagent providers **Superagent actually loads** before attributing host capabilities to the application.
2. No persistence filesystem/crash integration suite, external subagent integration, actual approval interaction, native execution suite, or OS sandbox suite was run.
3. No security certification, live-provider availability claim or coding-quality ranking follows from 56 passing unit tests.
4. This worker did not compare EstaCoda implementation or repeat other workers’ scopes.
5. The parent-owned report **`reports/superagent-vs-estacoda.md` remains pending**. This worker neither wrote nor verified that artifact, as instructed.
