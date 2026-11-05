Harness supplies the agent loop, tool execution, sandbox backends and durable recovery. A focused keyless run passed 112 tests; several runtime areas remain unverified.

## Scope and evidence status

- Investigated **only `upstream/harness`**; did not inspect EstaCoda implementation or the Superagent bundle.
- Revision **`fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159` is the assigned pin**, not independently confirmed with Git in this worker.
- Read workspace `AGENTS.md`, Harness `AGENTS.md`, and `upstream/harness/packages/AGENTS.md` before execution.
- No source edits, installation, native builds, live-model calls, network requests, or credential-file reads were performed.
- No freshness or current public availability claims are established. This is local pinned-source evidence.
- **Do not treat this worker result as the accepted synthesis or saved report.** Writing and reading back `reports/superagent-vs-estacoda.md` remains the parent’s obligation.

## Implementation findings

### 1. Actual agent loop: implemented in Harness, not merely documented

`ReactLoopAgent` is a concrete driver over queued turns and step-boundary input. It owns agent scope, model selection, inbox, runtime-context projection, assistant-stream state and system-prompt projection.

Evidence:

- `upstream/harness/packages/core/agent-loop/src/agent.ts:113–158` — `ReactLoopAgent`, its state, constructor and scope creation.
- `upstream/harness/packages/core/agent-loop/src/agent.ts:283–317` — `preStep()`:
  1. claims inbox messages;
  2. requires a provider/model selection;
  3. resolves the admitted tool set;
  4. assembles the system prompt;
  5. invokes the `agent/pre-step` waterfall;
  6. disposes tool admission on rejection or failure.
- `upstream/harness/packages/core/agent-loop/src/agent.ts:328–390` — `turn()` appends `turn/start` and `step/start`, repeatedly advances steps, handles blocked/empty steps and installs tool-call recovery.
- Observed symbol locations in the same file:
  - `:479` — builds the request;
  - `:490` — streams via prepared provider call or `llm.stream`;
  - `:590` — dispatches tool execution;
  - `:613` — `prepareRequest()`;
  - `:644` — prepares a provider call.

**Attribution:** these are host-runtime mechanics. A Superagent configuration or plugin bundle using Harness should not receive independent credit for implementing the underlying loop.

### 2. Tool execution and concurrency: concrete host executor

`NativeToolExecutor` projects tool schemas, builds a `ToolExecutionPipeline`, and passes batches to `executeToolBatch`. Its constructor’s default parallelism callback returns **10**.

Evidence:

- `upstream/harness/packages/core/tool-executor-native/src/index.ts:8–23` — `NativeToolExecutor`, schema projection and batch execution.
- `upstream/harness/packages/core/tool-executor-native/src/index.ts:25–36` — Cordis plugin registration and scoped executor selection.

**Qualification:** this proves the native executor’s default batch limit, **not** a universal subagent-concurrency limit or every deployment’s effective concurrency. The batch scheduler’s implementation was not independently traced.

Executed scheduler tests cover deterministic gated tools and cancellation; see test receipts below.

### 3. Plugin architecture: implementation plus repository contracts

The native executor is a working example of plugin composition: declared `inject = ['tools']`, `apply(ctx)`, and scope-local executor selection. The loop uses service calls and an `agent/pre-step` waterfall rather than embedding every behavior directly.

Evidence:

- `upstream/harness/packages/core/tool-executor-native/src/index.ts:25–36`.
- `upstream/harness/packages/core/agent-loop/src/agent.ts:293–309`.

Repository instructions describe the larger architecture as **all-plugin Cordis** and require contributions to use disposable registrations and extension points:

- `upstream/harness/AGENTS.md:4` — architectural description.
- `upstream/harness/AGENTS.md:134–146` — effect-owned registration, waterfall delegation, model-visible/logged relationship and “plugins, not loop changes.”
- `upstream/harness/packages/AGENTS.md` — service-definition/provider/consumer and enforcement-at-operation rules.

**Qualification:** those instructions establish intended design and maintenance policy, not proof that every package obeys them. Loader internals and hot reload were not traced.

### 4. Sandbox: real platform backends, with explicit qualifications

Harness contains a concrete local sandbox provider with platform runner chains:

- Linux: `bwrap`, then Landlock;
- macOS: Seatbelt;
- Windows: restricted-token/ACL runner.

Evidence:

- `upstream/harness/packages/sandbox/sandbox-local/src/index.ts:24–42` — concrete runner imports and profile construction.
- `upstream/harness/packages/sandbox/sandbox-local/src/index.ts:68–93` — actual `spawnSync` functional probes for Bubblewrap and Seatbelt.
- `upstream/harness/packages/sandbox/sandbox-local/src/index.ts:156–190` — `PLATFORM_CHAINS` and static enforcement classifications.
- `upstream/harness/packages/sandbox/sandbox-local/src/index.ts:218–240` — runner-failure classification rules, including status-gated Landlock diagnostics.

Important limits are explicit in the source:

- The Windows backend classifies enforcement as **partial**, citing hard-link aliases and unconfined reads; do not describe all platforms as equally isolated.
- A configured custom runner is a deployment assertion: its non-empty override claims full enforcement and skips built-in selection/probing (`:44–65`).
- Single-candidate chains are selected without probing; source commentary says runtime runner refusal must fail closed (`:156–174`).
- The file’s introductory contract states missing/unusable confinement fails closed rather than returning the original argv (`:1–21`). The full `confine()` path was **not** read, so this remains a source contract supported by partially inspected implementation, not an executed OS-level result.

**Critical separation:** sandbox-policy tests passed, but **no actual OS confinement or escape tests were run**. Approval prompts, permission presets, filesystem-tool enforcement and shell escalation were not traced. A sandbox package’s presence does not prove the Superagent bundle enables it correctly.

### 5. Persistence and recovery: substantial executed evidence

The selected resume tests compose a real JSONL persistence plugin with the loop and a mock LLM adapter, using temporary filesystem directories.

Evidence:

- `upstream/harness/packages/core/agent-loop/tests/resume.spec.ts:29–52` — temporary storage, actual plugin composition, JSONL backend mounted before the loop and mock adapter registration.
- `upstream/harness/packages/core/agent-loop/src/agent.ts:362–390` — live-step tool-call recovery observes session events and appends missing `tool/result` events on failure; step closure is appended in `finally`.

Passed negative/recovery cases include:

| Case | Repository citation |
|---|---|
| Cannot crash-repair a turn owned by a live agent | `upstream/harness/packages/core/agent-loop/tests/resume.spec.ts:493` |
| Interrupted-turn closers are appended durably | same file `:514` |
| Interrupted tool call closed with result, step end and turn end | same file `:539` |
| Torn physical tail resumes from committed prefix | same file `:578` |
| Repair suffix persisted before publication | same file `:716` |
| Resume setup failure releases identity | same file `:784` |
| Resume/fork continues after live scheduler failure | same file `:1046` |
| History and numbering continue without duplicate sequence IDs | same file `:1119` |
| Resume without configured persistence rejects | same file `:1156` |

**Qualification:** these tests establish deterministic local behavior for the selected composition. They do not establish resistance to every crash/storage failure, distributed persistence, or production operation.

### 6. Providers and transport recovery: narrow verified result

The loop explicitly requires selected provider/model identity before entering a step, and calls the LLM service’s prepared-call/stream interfaces.

- `upstream/harness/packages/core/agent-loop/src/agent.ts:288–294`.
- Same file `:490`, `:644`.

The focused provider-transport recovery suite passed **8 tests**, including conversion of a stalled body into `TIMEOUT` followed by a successful request, both when the body observes abort and when it does not.

**Not verified:** exact supported provider/model matrix, authentication routes, regional availability, Pi adapter behavior, live DeepSeek compatibility, model catalog freshness or real API response quality. Package directories named `llm-deepseek`, `llm-pi-ai`, API-key/account routes and retry exist in the inspected tree, but directory names alone are not implementation verification.

## Executed deterministic test receipt

**Verification label:** `harness-tests`
**Scope:** `.`
**Working directory:** `upstream/harness`

Exact command:

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

Observed:

- Node **v24.14.1**
- Vitest **v4.1.11**
- **Successful completion / exit 0**; terminal receipt reported `ok=true`.
- **4 files passed; 112 tests passed; none failed or skipped in the printed summary.**
- Duration **3.23 seconds**.

Breakdown:

| Existing suite | Passed |
|---|---:|
| `agent-loop/tests/resume.spec.ts` | 51 |
| `llm-retry/tests/transport-recovery.spec.ts` | 8 |
| `agent-loop/tests/tool-calls.spec.ts` | 29 |
| `sandbox-policy/tests/policy.spec.ts` | 24 |
| **Total** | **112** |

The sandbox-policy suite includes invalid workspace-root rejection as well as default read-only policy behavior: `upstream/harness/packages/sandbox/sandbox-policy/tests/policy.spec.ts:45–64`.

Before execution, inspected:

- `upstream/harness/package.json:55–60` — normal `test` script first builds native system code; direct Vitest selection intentionally avoided invoking that build.
- `upstream/harness/vitest.config.ts:173–187,209–270` — forked projects, process-bound inventory, setup files and source aliases.
- `upstream/harness/vitest.shared.ts:1–42` — decorator transform and worker flags.
- `upstream/harness/scripts/test-proxy-environment.ts:26–63` — clears ambient proxy variables.
- `upstream/harness/scripts/test-dom-environment.ts:1–41` — test-only ResizeObserver setup.
- `upstream/harness/scripts/test-official-listing-guard.ts:12–22` — rejects unstubbed official model-listing requests.

Only Vite’s `vite-tsconfig-paths` deprecation/advisory warnings appeared. No failing test was observed.

**Native-build gap:** dependencies were prepared without lifecycle scripts. No native addon build was attempted; this selection passing does not establish that native sandbox, computer-use, storage or other native-dependent suites are ready.

**Inspection failure:** one read-only Python inventory script stopped with `FileNotFoundError` because `tool-executor-native/tests` does not exist. This was not a test failure. Subsequent focused inspection and the selected test run succeeded.

## Unverified requested areas

The following remain gaps and should not be filled from marketing text or directory names:

- **Subagents:** source tree includes in-process spawn/fork, ACP, Codex, Claude Code and DSH SDK packages; actual dispatch, inheritance, depth limits, external-process authority and concurrency were not traced or tested.
- **Skills/memory:** skill loading implementation, durable preference memory, promotion/curation and automatic learning were not inspected. Session persistence is **not equivalent** to learned memory.
- **UI/integrations:** Web/Desktop/CLI scripts are declared in `upstream/harness/package.json:32–36,72–79`, but GUI, SDK, MCP, browser/computer use, schedules, jobs and external integrations were not executed or traced.
- **Permissions:** approval, permission presets and tool-specific authorization need separate executor-level evidence.
- **Bundle activation:** this worker did not inspect Superagent configuration. It can identify host-owned mechanisms but cannot say which are actually activated by the bundle.

## Comparison guidance for synthesis

A defensible conceptual comparison should place **Harness runtime mechanisms**—loop, scoped plugin services, tool executor, sandbox backend and JSONL recovery—opposite independently verified EstaCoda runtime mechanisms. Then separately compare the **Superagent bundle’s composition, prompts and integrations**.

Do not infer parity in learned skills/memory, subagent orchestration, approvals or UI from Harness’s package inventory. Do not interpret **112 passing tests** as a live-model coding benchmark, comparative quality score or evidence of production maturity.

Exploration limitations: 1 settled exploratory attempt(s) failed (execute_code). These attempts are not evidence and remain recorded in the worker history. Acceptance of this report does not establish that every requested source was inspected. Use only successful observations and preserve any unresolved coverage gaps in synthesis.
