---
title: Benchmarking
description: Reproducible Terminal-Bench and SWE-bench run guidance for EstaCoda.
sidebar_position: 2
---

# Benchmarking

Benchmarking is an operator workflow. It uses `estacoda bench run`, Harbor adapters, and artifact files; it does not change the normal EstaCoda CLI experience.

## Priority

Use this order:

1. Terminal-Bench local smoke
2. Terminal-Bench Harbor smoke
3. Terminal-Bench full baseline
4. Terminal-Bench same-model comparison against another agent
5. SWE-bench Lite smoke
6. SWE-bench Verified baseline
7. GAIA later

Terminal-Bench comes first because it tests the whole terminal-native agent loop: shell use, setup, debugging, iteration, recovery, and workspace changes.

`estacoda bench run` wraps task instructions with a benchmark execution contract before entering the runtime. The contract tells the agent that benchmark success is judged by workspace, process, or verifier state rather than prose alone, and that it should use available file and terminal tools when the task requires workspace changes. This wrapper is limited to the benchmark CLI path and does not affect ordinary EstaCoda sessions.

## Local Checks

Run the CI-safe local smoke:

```bash
pnpm run benchmark:smoke
```

Run the Harbor adapter tests:

```bash
pnpm run benchmark:terminal-bench:adapter-test
```

These checks do not call live models and do not produce public scores.

For artifact-only validation without provider credentials, run:

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

With an unconfigured isolated home, `config_error` is valid. This smoke validates artifact writing, schema shape, redaction, `benchmark: null`, and the always-present `estimatedCostUsd` field. A final answer is only expected in a live smoke with an explicit provider/model configuration.

If Harbor is unavailable locally, the adapter remains unit-tested and compile-checked. Run Harbor one-task and five-task validation in a Harbor-installed environment before publishing benchmark results.

## Terminal-Bench Smoke

Before a full run, use a tiny Harbor smoke: five tasks, one model, one temperature, one attempt per task.

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

The goal is harness proof, not a score.

### Harbor Sharp Edges

- Harbor needs Docker or an equivalent container runtime. On macOS/Colima, keep Harbor's host-side job and result directory on a Docker-shared workspace path, such as a checkout-local `.harbor-jobs/` directory. Avoid host `/tmp` for verifier-bearing runs if Harbor reports `RewardFileNotFoundError`.
- `ESTACODA_BENCH_COMMAND` runs inside the Terminal-Bench task container. Do not point it at macOS `node_modules`, host-native binaries, or a host-only checkout path. Use a Linux-built runtime or build/install EstaCoda inside the container.
- Live model runs need explicit provider configuration: model id, credentials, temperature, and any max-token setting. Do not rely on a real user `~/.estacoda` home.
- Some providers constrain temperature. Record the actual value and set `ESTACODA_BENCH_TEMPERATURE` to the provider-supported value.
- Long tasks may need explicit provider-loop budgets. Use `ESTACODA_BENCH_MAX_PROVIDER_ITERATIONS`, `ESTACODA_BENCH_MAX_PROVIDER_TOOL_CALLS`, and `ESTACODA_BENCH_MAX_PROVIDER_WALL_CLOCK_MS` when those limits are part of the run configuration.
- For one-task probes, prefer passing `ESTACODA_BENCH_TASK_ID` if Harbor does not supply task identity to the installed-agent context.

## Full Baseline

After the smoke passes, run the full Terminal-Bench 2.0 baseline with the same model settings:

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

Report:

- EstaCoda version and git commit
- model provider and model id
- benchmark name and version
- task count and attempt count
- temperature and max token setting
- pass rate
- median wall-clock time
- median estimated cost per task
- median provider calls and tool calls per task
- exact command and environment variables

Use conservative wording: early baseline, not a leaderboard claim.

When running the adapter from a local checkout, set `PYTHONPATH` to the checkout root. Use `--artifact /tmp/estacoda-terminal-bench` so Harbor collects EstaCoda's benchmark artifacts.

## Comparison Rule

Compare:

```text
same model in EstaCoda
vs
same model in another baseline agent
```

Do not frame the result as EstaCoda versus a model. The point is to isolate runtime value.

## No Benchmark Tuning

After the five-task smoke, only fix harness or runtime bugs. Do not add task-specific prompts, task-name branches, benchmark-only tools, or Terminal-Bench special cases.

## Artifacts

Use `--out <dir>` as the canonical compact artifact mode. Harnesses that need exact paths can pass `--json-output <path>` and `--event-log <path>` instead; stdout and stderr still use `--out` or the derived default artifact directory.

Each `estacoda bench run` writes:

| Artifact | Meaning |
|---|---|
| `summary.json` | Run manifest with benchmark identity, EstaCoda identity, execution status, model settings, metrics, artifact paths, final answer, and failure details |
| `events.ndjson` or explicit `--event-log` path | Redacted runtime event stream |
| `stdout.txt` | Redacted run summary and final answer |
| `stderr.txt` | Redacted failure message when present |

`estimatedCostUsd` is always present and may be `null`.

## Isolation

Benchmark mode uses the `container-benchmark` policy:

- explicit workspace
- run-local workspace trust only
- no interactive approval prompts
- hard-deny command floor remains active
- no real user home unless explicitly passed
- no memory or session carryover by default
- redacted artifacts by default

Use `/tmp/estacoda-home` or the adapter's isolated-home default for public runs. Do not use a real `~/.estacoda` home for reproducible benchmarks.

## SWE-bench Later

Run SWE-bench after Terminal-Bench. Start with SWE-bench Lite, then SWE-bench Verified once EstaCoda reliably inspects issues and repos, edits files, runs tests, produces final diffs, and avoids unrelated changes.
