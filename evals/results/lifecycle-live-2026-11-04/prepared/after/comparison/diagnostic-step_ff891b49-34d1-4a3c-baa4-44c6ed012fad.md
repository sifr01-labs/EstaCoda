Harness supplied substantial runtime infrastructure in the inspected fixture, and 99 selected tests passed. Repository-evidence validation remains incomplete under the required file-tool contract.

## Status and evidence qualification

This is the **Harness-runtime worker result**, not the complete EstaCoda comparison or saved synthesis.

**Outstanding evidence gap:** most implementation excerpts were obtained using `execute_code` and `terminal.inspect`, rather than the specifically required **file tools**. Only `upstream/harness/vitest.config.ts` was directly observed through `file.read`. Therefore, the implementation findings below retain useful, precise source locations but **remain provisional under the repository-evidence contract**. No further tool work is available to close that gap. The earlier draft should not be treated as fully evidence-accepted.

The completed test executions are separately supported by their actual `terminal.run` results. They are not inferred from fixture manifests.

### Provenance

- `UPSTREAM.json` was inspected and declared Harness pin **`fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159`**. Its original contents were observed through `terminal.inspect`; neither Git identity nor source cleanliness was independently verified.
- The inspected Harness package declared version **`0.2.2-rc.1`**, package name `@deepseek-ai/dsh-root`, and Node requirement **`>=24.9.0`** (`upstream/harness/package.json`, `name`, `version`, `engines`).
- No latest-release date, current upstream availability, or live-provider performance was verified.
- No installation, build/lifecycle/setup-script execution, network/service testing, secret inspection, or intentional source edits were performed. Configured **Vitest setup files did execute as part of the tests**, after their contents were inspected.

## Provisional implementation findings

The following locations were observed through local code-reading commands, but require file-tool confirmation before acceptance under the stated evidence contract.

| Area | Observed implementation and precise references | Qualification |
|---|---|---|
| **Agent loop** | Failed steps attempt missing-tool-result recovery and append `step/end`: `upstream/harness/packages/core/agent-loop/src/agent.ts:374–389`. Turn stopping checks pending next-step input: `:394–400`. Request errors support a retry action: `:541–563`. Assistant messages record provider/model, usage when supplied, and stream information: `:566–583`. Tool execution receives `maxParallelToolCalls`: `:584–593`. | Establishes runtime mechanisms, not coding competence or guaranteed termination. |
| **Tool concurrency** | `upstream/harness/packages/core/tools/src/batch.ts:1–5` describes a bounded rolling pool with exclusive-call barriers and model-ordered results. `executeToolBatch` begins at `:50`; pool filling and execution-mode reclassification appear at `:186–193`. | This is concurrency within a tool batch, not proof of distributed scheduling or process isolation. |
| **Subagents** | Delegation-depth metadata is defined in `upstream/harness/packages/subagent/subagent/src/depth.ts:1–15`, `AgentOptions.subagentDepth`. Structured-child tests cover steer/queue input (`upstream/harness/packages/subagent/subagent/tests/structured.spec.ts:114`), terminal capture (`:219`, `:231`), cold continuation (`:453`), and concurrent per-child schemas (`:720`). | The executed suite uses mocked/in-process facilities; it does not validate external-agent integrations or crash-safe child execution. |
| **Durable sessions** | JSONL persistence exposes read and single-writer write access; write opening claims ownership and acquires a lease: `upstream/harness/packages/session/session-persistence-jsonl/src/index.ts:381–428`, `open`. Initial materialization is deferred: `:373–378`. Torn-tail handling appears in `upstream/harness/packages/session/session-persistence-jsonl/src/storage.ts:39–50`, `:68–72`. | Physical publication, actual lock contention, migrations, corruption recovery, and process-kill/restart behavior were not tested. |
| **Recovery semantics** | `upstream/harness/packages/core/session/src/repair.ts:1–18` defines pending-tool recovery and distinguishes `TOOL_NOT_STARTED` from `TOOL_OUTCOME_UNKNOWN`. | Recovery is not exactly-once side-effect execution. An unknown recorded outcome must not be reported as a successful or safely repeatable operation. |
| **Permissions and sandbox** | Central policy and backend enforcement are separated: `upstream/harness/packages/sandbox/sandbox-policy/src/index.ts:1–19`. Modes include `read-only`, `workspace-write`, and `danger-full-access`: `:59–76`; the documented default is read-only: `:87–96`. Permission presets bundle sandbox and approval settings: `upstream/harness/packages/interaction/permission-presets/src/index.ts:24–31`, `:57–61`. | The selected sandbox tests validate error vocabulary—not actual OS confinement. Effective protection depends on backend, host, policy, and mounted tools. |
| **Skills** | The registry merges provider catalogs: `upstream/harness/packages/skill/skill/src/index.ts:1–8`. Model/user invocation eligibility appears at `:49–53`; registration at `:439–440`; listing and catalog snapshots at `:470–483`. | A skill registry does not establish automatic skill learning or durable preference curation. No skill tests were run. |
| **Context management** | Routed-model compaction defaults include threshold ratio **0.8** and retained-tail ratio **0.16**: `upstream/harness/packages/compaction/compaction-basic/src/config.ts:19–23`. Policy fields include headroom, retention, summarization route, token limits, and retries: `:25–36`. | These are context-pressure controls, not lossless memory guarantees. No compaction tests were run. |
| **Providers and budgets** | `LlmAdapter` and `LlmRuntime` are defined in `upstream/harness/packages/llm/llm/src/index.ts:208`, `:354–356`; listing and prepared-call interfaces appear at `:718–720`, `:960–962`. Optional context/output limits appear in `upstream/harness/packages/llm/llm/src/types.ts:346–349`. | No endpoint, model availability, latency, throughput, billing accuracy, or hard cross-agent spend ceiling was verified. Context/token limits are not equivalent to monetary-budget enforcement. |

## Harness versus Superagent attribution

The inspected application entry explicitly injects Harness services for agents, session control/persistence, workspaces, permissions, tools, prompts, skills, LLMs, and subprocesses:

- `upstream/superagent/src/index.ts:7–10`.

Superagent then constructs its **own application `Runtime`**, wires restart handling, and awaits readiness:

- `upstream/superagent/src/index.ts:14–24`.

Its composition selects and constrains Harness facilities:

- Subagent model-selection options and parallel TODO configuration: `upstream/superagent/cordis.patch.yml:108–115`.
- Restricted router preset: `:121–132`.
- Five-second shell limits: `:145–156`.
- Router file writes/edits disabled: `:163–167`.
- Skills and compaction plugins: `:173–193`.

**Provisional attribution conclusion:** Harness furnishes the generic execution, delegation, persistence, tools, provider, skill, and context-management machinery. Superagent implements its application `Runtime` and chooses its composition/presets. Do not credit Superagent with independently implementing the entire Harness, or assume every Harness package is enabled in its deployment.

This worker did **not** establish Superagent’s complete application-level scheduling or restart-recovery design.

## Actual deterministic test results

Package scripts and test configuration were inspected before execution. The direct Vitest invocation avoided the native-system build invoked by the package’s normal test script.

The directly file-read configuration establishes source-path/decorator plugins and test configuration:

- `upstream/harness/vitest.config.ts:19–22`, path-resolution plugin.
- `upstream/harness/vitest.config.ts:139–144`, included test patterns.
- Further configuration inspection through code-reading commands showed the configured test setup files and forked test projects.

### Run 1 — successful, exit status 0

```sh
cd upstream/harness && node node_modules/vitest/vitest.mjs run packages/core/agent-loop/tests/model.spec.ts packages/sandbox/sandbox/tests/vocabulary.spec.ts packages/llm/llm/tests/retry-policy.spec.ts --maxWorkers=1 --no-file-parallelism
```

| Suite | Passed |
|---|---:|
| Agent model ownership | 4 |
| Sandbox vocabulary | 4 |
| Provider retry policy | 20 |
| **Total** | **28** |

**3 files passed; 0 failed.** Vitest-reported duration: **745 ms**.

### Run 2 — successful, exit status 0

```sh
cd upstream/harness && node node_modules/vitest/vitest.mjs run packages/core/session/tests/repair.spec.ts packages/subagent/subagent/tests/structured.spec.ts --maxWorkers=1 --no-file-parallelism
```

| Suite | Passed |
|---|---:|
| Structured subagents | 39 |
| Session repair | 32 |
| **Total** | **71** |

**2 files passed; 0 failed.** Vitest-reported duration: **2.54 s**.

Both executions reported Vitest **4.1.11** and a nonfatal `vite-tsconfig-paths` deprecation/migration warning.

### Interpretation

- **Observed aggregate:** **99 passed, 0 failed across five selected test files**.
- **Failed tests:** none in these executions.
- **Missing prerequisites:** none blocked these selected runs.
- **Not executed:** the full Harness suite, physical persistence/restart tests, OS sandbox enforcement, external subagent integrations, skills/compaction tests, live providers, or model-driven coding benchmarks.
- Test counts and durations are regression evidence only. They do not establish comparative intelligence, coding success, production reliability, security, or model performance.

## Outstanding obligations

1. **Repository-evidence acceptance remains unresolved:** confirm the cited implementation excerpts and provenance with the required file tools.
2. **Git/source identity remains unverified:** the manifest pin was read, not independently reconciled with checkout identity and modifications.
3. **The complete EstaCoda comparison remains outside this worker’s scope.**
4. **`reports/superagent-vs-estacoda.md` was not written by this worker.** Saving and verifying the complete accepted synthesis remains the parent’s obligation.
