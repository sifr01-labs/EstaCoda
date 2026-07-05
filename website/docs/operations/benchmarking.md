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

## Terminal-Bench Smoke

Before a full run, use a tiny Harbor smoke: five tasks, one model, one temperature, one attempt per task.

```bash
export ESTACODA_BENCH_MODEL="anthropic/claude-sonnet"
export ESTACODA_BENCH_HOME="/tmp/estacoda-home"

harbor run \
  -d terminal-bench/terminal-bench-2 \
  -a benchmarks.terminal_bench.harbor_agent:EstaCodaHarborAgent \
  -n 5
```

The goal is harness proof, not a score.

## Full Baseline

After the smoke passes, run the full Terminal-Bench 2.0 baseline with the same model settings:

```bash
export ESTACODA_BENCH_MODEL="anthropic/claude-sonnet"
export ESTACODA_BENCH_HOME="/tmp/estacoda-home"
export ESTACODA_BENCH_TEMPERATURE="0"

harbor run \
  -d terminal-bench/terminal-bench-2 \
  -a benchmarks.terminal_bench.harbor_agent:EstaCodaHarborAgent
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

Each `estacoda bench run` writes:

| Artifact | Meaning |
|---|---|
| `summary.json` | Run manifest with benchmark identity, EstaCoda identity, execution status, model settings, metrics, artifact paths, final answer, and failure details |
| `events.ndjson` | Redacted runtime event stream |
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
