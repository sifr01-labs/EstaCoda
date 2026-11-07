The pinned harness has a concrete plugin-based agent runtime, but dependency setup was still running; no behavioral tests or live-model benchmark completed.

## Scope and provenance

- **Assigned scope:** `upstream/harness` only. No comparative conclusions about EstaCoda or the superagent application are established by this worker.
- **Verified revision:** `fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159`, obtained with:
  ```sh
  git -C upstream/harness rev-parse HEAD
  ```
  Exit status: **0**. This matches the harness pin in `UPSTREAM.json:2–5`.
- **Observation timestamp:** `2026-11-07T00:06:20Z`, from `date -u`.
- **Manifest identity:** package `@deepseek-ai/dsh-root`, version `0.2.2-rc.1`, MIT, private workspace root (`upstream/harness/package.json:1–17`).
- **Public identity limitation:** I did not independently obtain web evidence in this worker. The supplied context’s GitHub identity/product-status statements must remain attributed to the parent’s evidence, not this inspection.

## Findings supported by inspected repository files

### 1. Implemented model/tool-loop machinery—not merely a README promise

`upstream/harness/packages/core/agent-loop/src/agent.ts` is a substantive default driver, importing the agent API, LLM adapter vocabulary, session log/recovery machinery, scoped tools, prompt assembly, inbox, and runtime-context projections (`:1–43`).

Concrete implementation locations observed through file tools:

| Symbol / operation | Source location |
|---|---|
| `whenIdle()` | `upstream/harness/packages/core/agent-loop/src/agent.ts:253` |
| `kick()` | same file, `:268` |
| `preStep()` | same file, `:283` |
| `turn()` | same file, `:327` |
| construction of `ToolCallRecovery` | same file, `:363` |
| `step()` | same file, `:435` |
| prepared-call streaming or `llm.stream(request)` fallback | same file, `:490` |
| `agent/request-error` event dispatch | same file, `:549` |
| awaited `tools.execute(...)` | same file, `:590` |
| `prepareRequest()` | same file, `:613` |
| awaited `llm.prepareCall(...)` | same file, `:644` |

**Interpretation:** the pinned source contains an actual request/stream/tool-execution driver and explicit recovery/error seams. These observations do **not** establish that retry policies, interrupted-tool recovery, or cancellation behave correctly; those branches were not executed, and their complete bodies were not reviewed.

The architecture documentation describes durable turn/step/message/tool events and live waterfall extension points, with requests derived from session history. That is a documented design, not independently executed verification (`upstream/harness/docs/architecture.md:1–110`).

### 2. Scoped, plugin-owned tool registration is implemented

`upstream/harness/packages/core/tools/src/index.ts:1–65` provides implementation evidence beyond repository descriptions:

- Cordis `Context` and `Service` imports.
- `ToolExecutorUnavailableError` and executor/batch types.
- Tool-schema projection and supported-JSON-schema validation imports.
- `ToolsService` registration on the Cordis context.
- Compiled allow/deny restrictions using readonly sets.
- A `ToolView` separating visible definitions, registrations, known capability names, and restrictable names.
- A scope-owned `ToolLayer` using named tool entries and anonymous restrictions.

**Assessment:** tool availability is represented as scoped registry data with executor and restriction seams. This is not proof of an enforced operating-system sandbox, safe plugin installation, or complete authorization coverage.

### 3. Capability inventory exists, but most requested subsystems remain unverified

The inspected repository instructions enumerate packages for sandboxing, skills, subagents, teams, jobs, schedules, durable sessions, credentials, user interaction, MCP, ACP, and host/client applications (`upstream/harness/AGENTS.md:19–89`).

However, inventory is not implementation verification. This worker did **not** finish file-tool inspection of the relevant implementation bodies for:

- User approval and permission presets.
- Local sandbox enforcement and platform-specific isolation.
- Skill discovery/loading, trust boundaries, or durable memory.
- Child-agent spawning, cancellation, nesting, and inheritance of permissions.
- JSONL persistence, leases, migration, torn-write handling, and recovery.
- Superagent-relevant channel transports and channel authentication.
- Provider-specific adapter behavior and operational model compatibility.

A terminal directory listing located likely implementation candidates, but those files were not subsequently read through file tools. Therefore they should be treated as **follow-up leads, not supported capability claims**.

## Environment preparation and executed verification

### Prerequisites inspected before installation

Read:

- Root `AGENTS.md`: requires upstream-owned dependencies; forbids borrowing EstaCoda dependencies and installing missing imports individually.
- `upstream/harness/UPSTREAM` pin via workspace `UPSTREAM.json`.
- `upstream/harness/package.json`.
- `upstream/harness/pnpm-workspace.yaml`.
- Beginning of `upstream/harness/pnpm-lock.yaml`.
- `upstream/harness/docs/development.md:1–65`.
- Beginning of `upstream/harness/docs/testing.md`.
- Beginning of `upstream/harness/vitest.config.ts`.
- `upstream/harness/scripts/install-lefthook.mjs:1–140`.

Observed configuration:

| Requirement | Evidence |
|---|---|
| Node `>=24.9.0` | `upstream/harness/package.json:7–10` |
| Exact package manager `pnpm@11.28.5` | `upstream/harness/package.json:7` |
| Workspace package globs, native packages, benchmarks, website, Python SDK runtime | `upstream/harness/pnpm-workspace.yaml:1–15` |
| Lockfile version `9.0`, workspace links, patched dependencies | `upstream/harness/pnpm-lock.yaml:1–35` |
| Strict symlinked dependency setup and explicit lifecycle allowlisting | `upstream/harness/docs/development.md:27–39` |
| Dependency lifecycle policy | `upstream/harness/pnpm-workspace.yaml:26–55` |
| Root postinstall invokes hook installer | `upstream/harness/package.json`, `scripts.postinstall` |
| Hook installer uses filesystem and child-process operations | `upstream/harness/scripts/install-lefthook.mjs:1–52` |

The upstream default `test` command first builds the native system component, then runs Vitest. Real-API e2e tests are a separate command (`upstream/harness/package.json:58–73`; `upstream/harness/AGENTS.md:94–115`).

### Commands and actual outcomes

**1. Runtime/dependency probe**

```sh
node --version
pnpm --version
corepack --version
test -d upstream/harness/node_modules
printf 'own_node_modules_status=%s\n' "$?"
```

Aggregate exit status: **0**.

Results:

- Node: **v24.14.1**, satisfying the manifest floor.
- Root-context pnpm: **10.33.0**. Corepack downloaded this version during the probe; it was **not** used as a substitute for the harness pin.
- Corepack: **0.34.6**.
- Harness `node_modules` directory check: **1**, meaning absent at that point.

**2. Harness-owned dependency installation**

```sh
cd upstream/harness &&
pnpm --version &&
pnpm install --frozen-lockfile --ignore-scripts
```

- Process handle: `proc_wca9z9by`.
- Corepack began downloading the correct pinned **pnpm 11.28.5**.
- Installation reached lockfile verification and package materialization.
- Observed output:
  - Supply-chain-policy verification: **1,755 lockfile entries**.
  - “Lockfile is up to date, resolution step is skipped.”
  - **1,434 packages** selected.
  - Harness-local virtual store: `upstream/harness/node_modules/.pnpm`.
  - Last observed progress: **434 downloaded, 117 reused, 555 added**.
- **Exit status: unknown.** The process was still running at the last observation; no completion receipt was obtained.
- Several registry requests reported low download speed. These were warnings, **not a demonstrated install failure**.
- `--ignore-scripts` deliberately prevented execution of root and dependency installation scripts. Consequently native/lifecycle-dependent prerequisites were **not established**, even if package materialization later completed.
- No ad hoc missing-import installation and no borrowing of EstaCoda’s runner/dependencies occurred.

### Test accounting

| Check category | Executed tests | Outcome |
|---|---:|---|
| Agent-loop behavior | 0 | Not run |
| Negative/security behavior | 0 | Not run |
| Cancellation/recovery | 0 | Not run |
| Persistence/restart | 0 | Not run |
| Live-model tasks | 0 | Deliberately not run |

**There are no observed test failures, but also no passing behavior tests.** Dependency preparation and the task stop left the requested deterministic benchmark unmet.

Existing candidate suites were verified as files through `file.glob`, including:

- `upstream/harness/packages/core/agent-loop/tests/cancel.spec.ts`
- `upstream/harness/packages/core/agent-loop/tests/request-error.spec.ts`
- `upstream/harness/packages/core/agent-loop/tests/resume.spec.ts`
- `upstream/harness/packages/core/agent-loop/tests/contract-regressions.spec.ts`
- `upstream/harness/packages/core/agent-loop/tests/resource-lifecycle.spec.ts`
- `upstream/harness/packages/core/agent-loop/tests/shutdown-drain.spec.ts`
- `upstream/harness/packages/core/agent-loop/tests/tool-calls.spec.ts`
- `upstream/harness/packages/core/agent-loop/tests/tool-order.spec.ts`

Their contents were not reviewed and they were not executed. Listing them is not coverage evidence.

## Operational and comparison boundaries

1. **Source capability:** substantive model/tool-loop and scoped tool-registry implementations are supported by the inspected code.
2. **Local operational readiness:** not established. Installation completion, necessary approved lifecycle/native preparation, and test execution remain unknown or unmet.
3. **Live service readiness:** not assessed. No service deployed, credentials validated, or channel connected.
4. **Live-model performance:** unknown. No model calls, coding-task benchmark, latency/cost measurement, or quality comparison was performed.
5. **Security:** no security certification or “safe by default” conclusion is justified from the inspected seams.
6. **Source changes:** no source edits were made. Dependency setup may have created ignored installation artifacts; tracked-tree cleanliness was not checked afterward.
7. **Report delivery:** this worker did not write `reports/superagent-vs-estacoda.md`, as instructed. Saving and verifying the accepted synthesis remains the parent’s obligation.

## Outstanding obligations for the synthesis

- Disclose this worker’s **zero executed behavior tests**, rather than presenting installation progress as a benchmark.
- Do not infer unsupported approvals, sandbox strength, memory/learning, child-agent governance, persistence guarantees, or channel coverage from package names.
- Resolve the outstanding installation process and inspect its final result before claiming a prepared harness environment.
- Complete implementation-level inspection and selected deterministic tests if further execution becomes available.
- Use the parent’s independently collected web evidence for public identity/product-status statements.
- Keep source architecture, fixture test results, deployment readiness, and live-model performance as separate comparison dimensions.

Exploration limitations: 1 settled exploratory attempt(s) failed (terminal.inspect). These attempts are not evidence and remain recorded in the worker history. Acceptance of this report does not establish that every requested source was inspected. Use only successful observations and preserve any unresolved coverage gaps in synthesis.