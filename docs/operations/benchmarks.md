---
title: "Benchmark Operations"
description: "Reproducible Terminal-Bench and SWE-bench run guidance for EstaCoda."
---

# Benchmark Operations

This runbook covers public benchmark execution for EstaCoda. It is an operator surface, not normal product UX. The benchmark path uses the existing CLI and writes artifacts; it does not add interactive screens or change ordinary EstaCoda sessions.

## Current Priority

Use this order:

1. Terminal-Bench local smoke
2. Terminal-Bench Harbor smoke
3. Terminal-Bench full baseline
4. Terminal-Bench same-model comparison against another agent
5. SWE-bench Lite smoke
6. SWE-bench Verified baseline
7. GAIA later, after browser/search/document tooling is mature

Start with Terminal-Bench because EstaCoda is a terminal-native operator runtime. Terminal-Bench exercises the whole agent loop in real terminal environments: setup, shell use, file edits, debugging, iteration, recovery, and final submission.

## Surfaces

Reusable benchmark machinery lives under `src/benchmark/` and the `estacoda bench run` CLI. External benchmark programs live under `benchmarks/`.

Current benchmark surfaces:

| Surface | Purpose | CI status |
|---|---|---|
| `estacoda bench run` | Headless benchmark execution with isolated home, fixed model settings, artifacts, and status taxonomy | Covered by unit tests |
| `estacoda bench compare` | Warning-only comparison of benchmark history or summary artifacts with markdown regression reports | Covered by unit tests |
| `pnpm run benchmark:operator-smoke` | Deterministic EstaCoda Operator Suite scenarios with no live provider or network requirement | CI-safe |
| `pnpm run benchmark:smoke` | Local fake benchmark task plus deterministic native runtime, trajectory-backed, and cross-session memory scenario evals, with no live provider or external harness | CI-safe |
| `benchmarks/terminal_bench/estacoda_harbor_agent.py` | Compatibility Harbor installed-agent adapter path for Terminal-Bench | Manual Harbor use |
| `pnpm run benchmark:terminal-bench:adapter-test` | Local adapter tests with no Harbor install required | CI-safe |

Full Terminal-Bench runs are manual. Do not run Harbor, Docker-backed benchmark jobs, or live provider baselines in ordinary CI.

`estacoda bench run` wraps task instructions with a benchmark execution contract before entering the runtime. The contract tells the agent that benchmark success is judged by workspace, process, or verifier state rather than prose alone, and that it should use available file and terminal tools when the task requires workspace changes. This wrapper is limited to the benchmark CLI path and does not affect ordinary EstaCoda sessions.

Requirement analysis uses the original task instruction, separately from this generic guidance. A read-only task does not acquire a file-mutation requirement from the wrapper.

Absolute output targets inside the execution workspace, such as `/app/summary.csv` when the workspace is `/app`, resolve to the same completion requirement as `summary.csv`. A successful write and matching read-back are still required; outside-workspace paths and symlink escapes cannot qualify as completed outputs.

## Reliability and interpretation

`bench run` pins the primary model and disables configured model fallbacks by default. Use `--allow-model-fallback` only for an explicitly mixed-model experiment. The summary records `model.fallbackPolicy` and the ordered provider/model fallback routes without copying credentials or changing the selected profile. Foreground requests may retry one eligible network/server failure on the same route before fallback; retry dispatch still requires remaining time and a fresh spending reservation. Partial streamed text or tool arguments are not eligible for this transient retry.

`terminal.run` exposes its configured duration ceiling (normally 30 seconds). An excessive requested timeout is rejected before starting the command, rather than silently shortened. Timed-out, cancelled, and nonzero-exit commands have distinct feedback. For longer compilation or service jobs, discover/request the existing managed process tools, use `process.start`, inspect `process.list` and `process.logs`, and stop unfinished work with `process.stop`. These tools retain normal authorization; benchmark disposal releases owned processes at the run deadline.

Explicit document-root/output-directory declarations can bind bare output filenames within the actual workspace. Conflicting directories remain unresolved. After an unrelated command denial, completion repair may only read back receipt-backed successful output writes: exposure and dispatch are restricted to complete `file.read` calls on those exact paths. Denied file operations, missing writes, unresolved paths, and copy mismatches do not qualify. This does not grant workspace access or bypass approval, containment, or symlink checks.

Provider iteration and exhaustion events are exported even without a trajectory. Metrics reconcile event and trajectory counts without double counting. Terminal events include only typed exit, signal, timeout, and cancellation fields; they do not export raw command environments or private error objects. Harness completion and official verifier scores remain separate: these reliability checks do not guarantee that a model solves every task.

## Local Smoke

Run the local fake benchmark first:

```bash
pnpm run benchmark:smoke
```

This verifies that `estacoda bench run` can:

- receive a task instruction
- materialize a benchmark workspace
- run through the benchmark harness path
- capture runtime events
- write the expected workspace result
- produce benchmark artifacts
- report native runtime eval metrics for deterministic scenario evidence
- write trajectory artifacts when a scenario run uses a persistent trajectory store
- exercise cross-session memory recall with isolated home, workspace, and SQLite state

The progress guard credits distinct successful terminal commands with new results even while a completion checkpoint is active. Failed, denied, cancelled, timed-out, reused, and repeated commands do not reset that checkpoint guard. Changing only deadlines or receipt identifiers is not progress. This accounting does not satisfy file delivery or other completion requirements; the agent must still produce and verify the requested result.

The local smoke includes a real-runtime integration test with an offline provider. It checks tool dispatch, workspace trust isolation and cleanup, the hard-deny floor, and failure reporting when a tool loop exhausts its budget. The other deterministic scenarios also use mocked runtime components. The smoke does not call a live model and does not prove Terminal-Bench scoring.

## Operator Suite Smoke

Run deterministic operator-runtime scenarios with:

```bash
pnpm run benchmark:operator-smoke
```

This suite covers the first bug-fix, config-repair, failure-recovery, workspace-isolation, and repo-discovery scenarios. It uses the normal benchmark runner, trajectory artifacts, evidence assertions, and history artifacts while avoiding live provider or network requirements. See [Operator Suite](./operator-suite.md) for scenario authoring guidance.

## Local Artifact Control Smoke

Use this when validating the public artifact contract without provider credentials:

```bash
rm -rf /tmp/estacoda-bench-app /tmp/estacoda-summary.json /tmp/estacoda-events.jsonl
mkdir -p /tmp/estacoda-bench-app

estacoda bench run \
  --instruction-file benchmarks/local-smoke/simple-file-task/instruction.txt \
  --workspace /tmp/estacoda-bench-app \
  --isolated-home \
  --json-output /tmp/estacoda-summary.json \
  --event-log /tmp/estacoda-events.jsonl
```

With an unconfigured isolated home, this may exit with `config_error`. That is valid for the artifact/control smoke. It should still produce valid JSON artifacts, keep `benchmark` as `null`, include `estimatedCostUsd`, apply default redaction, and avoid touching normal user config or session state. A final answer is not expected in this mode.

For a live local smoke, pass provider/model credentials through an explicit benchmark home or environment and expect the run to reach model execution and capture a final answer. The fixture verifier is:

```bash
benchmarks/local-smoke/simple-file-task/verify.sh /tmp/estacoda-bench-app
```

## Harbor Adapter Tests

Run the adapter tests before trying Harbor:

```bash
pnpm run benchmark:terminal-bench:adapter-test
```

These tests validate command construction, benchmark identity mapping, isolated-home behavior, provider budget flags, and instruction-file handling without requiring Harbor.

If Harbor is unavailable in the validation environment, stop after the local smoke and adapter tests. The Terminal-Bench adapter is unit-tested and compile-checked locally. End-to-end Harbor validation must be run in an environment with Harbor installed before publishing benchmark results.

## Terminal-Bench Harbor Smoke

Run a tiny Harbor smoke before a full baseline. Use five tasks, one model, one temperature, and one attempt per task.

Example:

```bash
export ESTACODA_BENCH_MODEL="anthropic/claude-sonnet"
export ESTACODA_BENCH_HOME="/tmp/estacoda-home"
export PYTHONPATH="/path/to/estacoda:${PYTHONPATH:-}"

harbor run \
  -d terminal-bench/terminal-bench-2 \
  -a benchmarks.terminal_bench.estacoda_harbor_agent:EstaCodaAgent \
  --artifact /tmp/estacoda-terminal-bench \
  -n 5
```

If `estacoda` is not installed in the task container, set:

```bash
export ESTACODA_HARBOR_INSTALL_COMMAND="corepack enable && pnpm install --frozen-lockfile && pnpm run build"
export ESTACODA_BENCH_COMMAND="node /path/to/estacoda/dist/index.js"
```

The smoke goal is not a public score. The goal is to prove that EstaCoda can run under Harbor without harness failures and produce reproducible artifacts.

### Harbor Sharp Edges

Document these details in every reproducible run note:

- Harbor needs a working Docker-capable runtime. On macOS/Colima, keep Harbor's host-side job and result directory on a Docker-shared workspace path, such as a checkout-local `.harbor-jobs/` directory. Avoid host `/tmp` for verifier-bearing runs if the verifier reports `RewardFileNotFoundError`; that failure can mean the task container wrote the reward file but the host-side verifier cannot see the mounted result.
- The EstaCoda process runs inside the Terminal-Bench task container. Do not point `ESTACODA_BENCH_COMMAND` at macOS `node_modules`, host-native binaries, or a host-only checkout path. Use a Linux-built runtime available in the task container, or build/install EstaCoda inside the container with `ESTACODA_HARBOR_INSTALL_COMMAND`.
- Live runs need explicit provider configuration. Pass `ESTACODA_BENCH_MODEL`, provider credentials, `ESTACODA_BENCH_TEMPERATURE`, and any max-token setting through the Harbor agent environment or an explicit benchmark home. Do not rely on a real user `~/.estacoda` home.
- Some providers constrain temperature. Record the actual value and set `ESTACODA_BENCH_TEMPERATURE` accordingly.
- Select the workspace explicitly with `ESTACODA_BENCH_WORKSPACE` (Harbor `--ae ESTACODA_BENCH_WORKSPACE=<path>`). The adapter defaults to `/app`; file tools cannot write `/etc` or `/var` under that scope. For an operator-authorized disposable container requiring system-wide configuration, choose `/` inside that container, without host filesystem mounts. Keep project-only runs scoped to their project directory. This is an explicit operator choice, never inferred from task prose or container-detection heuristics, and does not disable hardline command checks.
- Completion tracks up to eight explicitly named text outputs, including conjunctive lists and separate save/create instructions. Each destination requires its own successful write and matching full read-back. Alternatives, ambiguous source/destination wording, unsafe paths, and requests exceeding the bound remain unresolved. Filesystem access remains scoped to the execution workspace; implicit directory references are not resolved by this parser.
- Long tasks may exhaust default provider-loop budgets before Harbor verification. Use `ESTACODA_BENCH_MAX_PROVIDER_ITERATIONS`, `ESTACODA_BENCH_MAX_PROVIDER_TOOL_CALLS`, and `ESTACODA_BENCH_MAX_PROVIDER_WALL_CLOCK_MS` when a run intentionally needs larger limits.
- Prefer explicit task identity for one-task probes. If Harbor does not expose the task id to the installed-agent context, pass `ESTACODA_BENCH_TASK_ID` so artifacts and summaries do not fall back to `unknown-task`.

## Full Baseline

After the smoke passes, run all Terminal-Bench 2.0 tasks with the same settings:

```bash
export ESTACODA_BENCH_MODEL="anthropic/claude-sonnet"
export ESTACODA_BENCH_HOME="/tmp/estacoda-home"
export ESTACODA_BENCH_TEMPERATURE="0"
export PYTHONPATH="/path/to/estacoda:${PYTHONPATH:-}"

harbor run \
  -d terminal-bench/terminal-bench-2 \
  -a benchmarks.terminal_bench.estacoda_harbor_agent:EstaCodaAgent \
  --artifact /tmp/estacoda-terminal-bench
```

Record:

- EstaCoda version and git commit
- model provider and model id
- temperature and max token setting
- benchmark name and version
- task count
- attempt count
- pass rate
- median wall-clock time
- median estimated cost per task
- median provider calls, provider tool calls, and tool calls per task
- exact command and environment variables

Do not claim leaderboard parity unless the run follows the benchmark publisher's submission requirements.

## Comparison Rule

The useful comparison is:

```text
same model in EstaCoda
vs
same model in another baseline agent
```

Do not frame the comparison as EstaCoda versus a model. Keep model, temperature, task set, attempt count, and environment as close as possible so the comparison isolates the runtime.

## No Benchmark Tuning

After the five-task smoke, only fix harness or runtime bugs. Do not add task-specific prompts, task-name branches, benchmark-only tool behavior, or special cases for Terminal-Bench tasks.

If a fix changes normal runtime behavior, it needs the same review, tests, and security scrutiny as any other runtime change.

## Artifact Contract

The canonical compact form is:

```bash
estacoda bench run \
  --workspace /tmp/estacoda-bench-app \
  --instruction-file benchmarks/local-smoke/simple-file-task/instruction.txt \
  --out /tmp/estacoda-artifacts
```

This writes all artifacts under `--out`. For harnesses that need exact paths, use:

```bash
estacoda bench run \
  --workspace /tmp/estacoda-bench-app \
  --instruction-file benchmarks/local-smoke/simple-file-task/instruction.txt \
  --json-output /tmp/summary.json \
  --event-log /tmp/events.jsonl
```

`--out` remains the compact canonical mode. `--json-output` and `--event-log` are explicit-path aliases for the summary and event log; stdout and stderr still use `--out` or the derived default artifact directory.

Each `estacoda bench run` writes:

| Artifact | Meaning |
|---|---|
| `summary.json` | Structured run manifest with benchmark identity, EstaCoda identity, execution status, model settings, metrics, artifact paths, final answer, and failure details |
| `events.ndjson` or explicit `--event-log` path | Redacted runtime event stream, one event per line |
| `trajectory.jsonl` | Redacted persisted trajectory event stream, one event per line, when a trajectory store is available |
| `trajectory-summary.json` | Redacted compact trajectory summary and trajectory-backed metrics, when a trajectory store is available |
| `history.jsonl` | Redacted stable run-history record for regression tracking and cross-commit comparison |
| `stdout.txt` | Redacted benchmark stdout summary plus final answer |
| `stderr.txt` | Redacted failure message when the run fails |

The summary status is one of:

- `success`
- `task_failed`
- `timeout`
- `model_error`
- `provider_error`
- `provider_rejected`
- `tool_error`
- `runtime_error`
- `adapter_error`
- `config_error`

Returned runtime outcomes affect the exit code and all summary/history artifacts: completed and recovered completions are `success`; blocked, partial, failed, cancelled, or budget-exhausted runs are `task_failed`; runtime deadlines are `timeout`; provider failures are `provider_error`. Completion-validation failures also prevent success. Recovered tool errors alone do not fail a completed run. Runtime success is not an external verifier score; Harbor still evaluates the task independently.

An explicit Responses API `cyber_policy` error is classified as a provider safety-policy rejection. It is not retried or sent to a fallback route. A terminal rejection is reported as `provider_rejected` with failure code `provider_policy` and a nonzero exit code, unless the runtime deadline took precedence. Provider diagnostics remain visible even when requested files or research are incomplete; diagnostics use controlled descriptions rather than raw provider error bodies. Batch owners can record the rejection as a task failure and continue with the next task, while pausing on `provider_error` or missing verifier results to investigate provider, authentication, network, or infrastructure failures. Do not rewrite a rejected task's prompt or change routes to bypass the rejection.

`estimatedCostUsd` is always present and may be `null` when pricing data is unavailable.

Compare two run-history or summary artifacts with:

```bash
estacoda bench compare baseline-history.jsonl current-history.jsonl

estacoda bench compare \
  --baseline baseline-summary.json \
  --current current-summary.json
```

Comparison reports are markdown and warning-only. They show aggregate and per-scenario deltas for success status, duration, token counts, estimated cost when available, tool/runtime failure metrics, memory activity, session recall, external memory recall, and security escalations. Token counts remain the primary measurement; cost is a nullable derived estimate.

## Isolation Rules

Benchmark mode uses the `container-benchmark` policy:

- workspace must be explicit
- workspace is trusted for this run only
- no interactive approval prompts
- hard-deny command floor remains active
- no access to the real user home unless explicitly passed
- no memory or session carryover by default
- artifacts are redacted by default

The runner grants the explicit workspace through the normal trust-store API before runtime creation, using a fresh store under the benchmark home. That store is passed to the runtime and removed during cleanup, including startup errors and timeouts. Existing home trust grants are neither inherited nor modified. This does not disable dispatch authorization checks or the hard-deny floor. As with other temporary state, abrupt process termination can leave a directory behind; later runs create fresh stores and do not reuse it.

For public benchmark runs, pass `--home /tmp/estacoda-home` or use the adapter default that maps to `--isolated-home`. Do not default to a real `~/.estacoda` home.

## Reporting Language

Use conservative wording:

```text
We ran EstaCoda v0.1.x on Terminal-Bench 2.0 using [model].
This is an early baseline, not a leaderboard claim.
We report pass rate, cost, time, and the full run configuration.
```

Include links or attachments for run artifacts and the exact configuration used.

When running the adapter from a local checkout, set `PYTHONPATH` to the checkout root so Harbor can import `benchmarks.terminal_bench.estacoda_harbor_agent`. Add `--artifact /tmp/estacoda-terminal-bench` so Harbor collects EstaCoda's `summary.json`, `events.ndjson`, `stdout.txt`, and `stderr.txt` from the task container.

## SWE-bench Later

Run SWE-bench after Terminal-Bench because it requires a tighter patch-generation flow. Start with SWE-bench Lite, then SWE-bench Verified.

Before SWE-bench, EstaCoda must reliably:

- inspect the issue
- inspect the repository
- edit files
- run tests
- produce a final patch or diff
- avoid unrelated changes

Do not begin public SWE-bench Verified claims until the Terminal-Bench baseline is reproducible.

## Related Files

- `src/benchmark/` - reusable benchmark schema, metrics, redaction, and artifact writers
- `src/cli/bench-command.ts` - `estacoda bench run`
- `benchmarks/local-smoke/` - CI-safe local benchmark fixture
- `benchmarks/terminal_bench/` - Terminal-Bench Harbor adapter
- `docs/operations/testing.md` - general validation lanes
