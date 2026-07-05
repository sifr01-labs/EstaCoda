# Terminal-Bench Harbor Adapter

This directory contains the Harbor custom-agent adapter for running EstaCoda on Terminal-Bench through the existing headless benchmark CLI.

The adapter is intentionally thin. Harbor supplies the task instruction and terminal environment; the adapter invokes:

```bash
estacoda bench run \
  --workspace /app \
  --instruction-file /tmp/estacoda-terminal-bench/<task>/attempt-1/instruction.txt \
  --out /tmp/estacoda-terminal-bench/<task>/attempt-1 \
  --benchmark-name terminal-bench \
  --benchmark-version 2.0 \
  --task-id <task> \
  --attempt 1 \
  --isolated-home
```

It does not add task-specific prompts, special cases, or benchmark-tuned behavior.

## Harbor Usage

Use the Python module path when running Harbor:

```bash
export ESTACODA_BENCH_MODEL="anthropic/claude-sonnet"
export ESTACODA_BENCH_HOME="/tmp/estacoda-home"

harbor run \
  -d terminal-bench/terminal-bench-2 \
  -a benchmarks.terminal_bench.harbor_agent:EstaCodaHarborAgent
```

If `estacoda` is not already available in the task container, provide an install command controlled by the benchmark operator:

```bash
export ESTACODA_HARBOR_INSTALL_COMMAND="corepack enable && pnpm install --frozen-lockfile && pnpm run build"
export ESTACODA_BENCH_COMMAND="node /path/to/estacoda/dist/index.js"
```

## Configuration

Supported environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `ESTACODA_BENCH_COMMAND` | `estacoda` | Command used to launch EstaCoda. May include fixed arguments. |
| `ESTACODA_BENCH_MODEL` | unset | Optional model passed to `estacoda bench run --model`. |
| `ESTACODA_BENCH_WORKSPACE` | `/app` | Workspace directory inside the Terminal-Bench task container. |
| `ESTACODA_BENCH_OUT` | `/tmp/estacoda-terminal-bench/<task>/attempt-<n>` | Artifact directory for summary, events, stdout, stderr, and instruction file. |
| `ESTACODA_BENCH_HOME` | unset | Explicit EstaCoda home. If unset, the adapter passes `--isolated-home`. |
| `ESTACODA_BENCH_TASK_ID` | Harbor context or `unknown-task` | Task id for benchmark identity. |
| `ESTACODA_BENCH_ATTEMPT` | Harbor context or `1` | Attempt number for benchmark identity. |
| `ESTACODA_BENCH_TEMPERATURE` | `0` | Provider request temperature. |
| `ESTACODA_BENCH_MAX_TOKENS` | unset | Optional max output tokens. |
| `ESTACODA_BENCH_TIMEOUT_MS` | `1800000` | Headless run timeout in milliseconds. |
| `ESTACODA_BENCH_REDACT` | `true` | Keep benchmark artifacts redacted by default. |
| `ESTACODA_BENCHMARK_VERSION` | `2.0` | Terminal-Bench version label recorded in artifacts. |

Provider budget variables map directly to the matching `estacoda bench run` flags:

- `ESTACODA_BENCH_MAX_PROVIDER_ITERATIONS`
- `ESTACODA_BENCH_MAX_PROVIDER_TOOL_CALLS`
- `ESTACODA_BENCH_MAX_REPEATED_TOOL_FAILURES`
- `ESTACODA_BENCH_MAX_PROVIDER_WALL_CLOCK_MS`

## Testing

The local adapter tests do not require Harbor:

```bash
python3 -m unittest benchmarks.terminal_bench.harbor_agent_test
```
