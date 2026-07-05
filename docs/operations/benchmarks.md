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
| `pnpm run benchmark:smoke` | Local fake benchmark task with no live provider or external harness | CI-safe |
| `benchmarks/terminal_bench/estacoda_harbor_agent.py` | Compatibility Harbor installed-agent adapter path for Terminal-Bench | Manual Harbor use |
| `pnpm run benchmark:terminal-bench:adapter-test` | Local adapter tests with no Harbor install required | CI-safe |

Full Terminal-Bench runs are manual. Do not run Harbor, Docker-backed benchmark jobs, or live provider baselines in ordinary CI.

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

The local smoke does not call a live model and does not prove Terminal-Bench scoring.

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
| `stdout.txt` | Redacted benchmark stdout summary plus final answer |
| `stderr.txt` | Redacted failure message when the run fails |

The summary status is one of:

- `success`
- `task_failed`
- `timeout`
- `model_error`
- `provider_error`
- `tool_error`
- `runtime_error`
- `adapter_error`
- `config_error`

`estimatedCostUsd` is always present and may be `null` when pricing data is unavailable.

## Isolation Rules

Benchmark mode uses the `container-benchmark` policy:

- workspace must be explicit
- workspace is trusted for this run only
- no interactive approval prompts
- hard-deny command floor remains active
- no access to the real user home unless explicitly passed
- no memory or session carryover by default
- artifacts are redacted by default

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
