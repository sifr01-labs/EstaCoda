# Terminal-Bench Harbor Adapter

This directory contains the Harbor custom-agent adapter for running EstaCoda on Terminal-Bench through the existing headless benchmark CLI.

New runs target **Terminal-Bench 4.0**, pinned to Harbor dataset
`terminal-bench/terminal-bench@4.0.0`. The adapter records `4.0.0` in its artifacts.
The dataset selection and artifact label are separate settings: changing the label
does not select or download a dataset. Historical reports retain their original versions.

The adapter is intentionally thin. Harbor supplies the task instruction and terminal environment; the adapter invokes:

```bash
estacoda bench run \
  --workspace /app \
  --instruction-file /tmp/estacoda-terminal-bench/<task>/attempt-1/instruction.txt \
  --out /tmp/estacoda-terminal-bench/<task>/attempt-1 \
  --benchmark-name terminal-bench \
  --benchmark-version 4.0.0 \
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
export PYTHONPATH="/path/to/estacoda:${PYTHONPATH:-}"

harbor run \
  -d terminal-bench/terminal-bench@4.0.0 \
  -a benchmarks.terminal_bench.estacoda_harbor_agent:EstaCodaAgent \
  --artifact /tmp/estacoda-terminal-bench \
  -l 5 -n 1 -k 1 -r 0
```

The importable compatibility path is `benchmarks.terminal_bench.estacoda_harbor_agent:EstaCodaAgent`. The internal implementation remains in `benchmarks.terminal_bench.harbor_agent`.
When running from a source checkout, `PYTHONPATH` must include the checkout root. The explicit `--artifact /tmp/estacoda-terminal-bench` flag lets Harbor collect EstaCoda's benchmark artifacts from the task container.

This smoke selects at most five tasks (`-l 5`), runs one at a time (`-n 1`),
and makes one attempt per task (`-k 1`) with no automatic retries (`-r 0`).
Record the resolved task identities; the subset is not a public benchmark score.
Remove `-l 5` for a full baseline after the smoke passes. Use a Harbor release
supporting the pinned Hub dataset and separate verifier environments, and record
`harbor --version` with each run.

If `estacoda` is not already available in the task container, provide an install command controlled by the benchmark operator:

```bash
export ESTACODA_HARBOR_INSTALL_COMMAND="corepack enable && pnpm install --frozen-lockfile && pnpm run build"
export ESTACODA_BENCH_COMMAND="node /path/to/estacoda/dist/index.js"
```

## Harbor Sharp Edges

- Harbor requires a working Docker-capable environment. On macOS/Colima, keep Harbor's host-side job and result directory on a Docker-shared workspace path, such as a checkout-local `.harbor-jobs/` directory. Avoid host `/tmp` for verifier-bearing runs if the verifier reports `RewardFileNotFoundError`; the task container may write the reward file while the host-side verifier cannot see it.
- The EstaCoda command runs inside the Terminal-Bench task container. Do not point `ESTACODA_BENCH_COMMAND` at macOS `node_modules` or host-native binaries. Use a Linux-built runtime available in the task container, or install/build EstaCoda inside the container through `ESTACODA_HARBOR_INSTALL_COMMAND`.
- Live model runs need explicit provider configuration. Set `ESTACODA_BENCH_MODEL`, provider credentials, temperature, and any required max-token setting through the Harbor agent environment instead of relying on a real user home.
- Some providers constrain temperature. Keep the temperature in the recorded run configuration and override `ESTACODA_BENCH_TEMPERATURE` when the provider requires a specific value.
- Long Terminal-Bench tasks may need explicit provider budgets. Use `ESTACODA_BENCH_MAX_PROVIDER_ITERATIONS`, `ESTACODA_BENCH_MAX_PROVIDER_TOOL_CALLS`, and `ESTACODA_BENCH_MAX_PROVIDER_WALL_CLOCK_MS` to make those limits intentional and reproducible.
- Prefer explicit task identity when probing a single task. If Harbor does not supply a task id to the installed-agent context, pass `ESTACODA_BENCH_TASK_ID` so EstaCoda artifacts do not fall back to `unknown-task`.

## Deadlines, cleanup, and comparison quality

The default outer agent deadline is **28,800,000 ms (eight hours)**, matching the
[Terminal-Bench 4.0 release](https://www.tbench.ai/news/terminal-bench-4-0).
The adapter also sets the provider wall-clock budget to the remaining execution
time unless the operator supplies a smaller value. Iteration, tool-call, and
repeated-failure limits remain the runtime defaults unless explicitly configured;
record them when comparing agents. The longer time allowance can increase run cost.
No live provider campaign is part of the local adapter test.

The adapter reserves the smaller of 30 seconds or 10% of the supplied task timeout
for startup, runtime disposal, and artifact collection. It caps the inner provider
wall-clock budget at the remaining execution time. The outer published Harbor
limit is unchanged; resolved CLI arguments record the effective inner limit.
Unexpected host cancellation tears down the disposable environment before an
operator subclass can clean credentials. Such an attempt needs infrastructure
review, rather than grading while the agent might still be mutating files.
Credential-installing subclasses must await the base `run` before removing secrets;
never delete credentials from a live, unsettled agent.

`summary.json` includes `providerUsage.session` and `providerUsage.routing`, aggregated
from the conversation's actual ledger and verified compression ancestors, including
the default in-memory database. Separate delegated-task ledgers are not included. Inspect
`usageComplete` and `pricingComplete` before comparing costs; missing usage is not
zero cost. A separate SQLite exporter is neither necessary nor authoritative.

For fair build-heavy comparisons, use native Linux amd64 execution when possible.
Record emulation and CPU/memory limits, and investigate compiler crashes separately
from solution correctness. Keep task images, instructions, deadlines, and attempts
unchanged. A correct source patch does not establish a passing build/test result.

## Configuration

### Separate verification in Terminal-Bench 4.0

Use the dataset's published agent/verifier environments and artifact declarations.
Harbor transfers the declared task outputs into the separate verifier; EstaCoda's
diagnostic logs are additional artifacts, not substitutes for those outputs.
Leave `ESTACODA_BENCH_SERVICE_GRACE_MS` unset for separate verification: keeping a
service alive in the agent container does not transfer it into the verifier.
Do not change task images, resource limits, artifact paths, or verifier mode to
make a run pass. See Harbor's [separate verifier documentation](https://docs.harborframework.com/tasks/separate-verifier).

### Reproducing older runs

Select the historical dataset explicitly in Harbor and set
`ESTACODA_BENCHMARK_VERSION` to its exact recorded version. Also set
`ESTACODA_BENCH_TIMEOUT_MS` and provider budgets to the original run's values;
the version label does not restore older budget defaults. Never relabel existing
2.x reports as 4.0 or compare their aggregate pass rates as a regression delta.

### Services needed by the verifier

For a disposable **shared-environment** trial whose task requires a live service,
set `ESTACODA_BENCH_SERVICE_GRACE_MS` to the published verifier timeout plus a
bounded allowance for artifact collection (for example, `960000` for a 900-second
verifier). The maximum is one hour; the default is off. This is an operator setting,
not a model-controlled persistence capability. Do not use it with separate agent
and verifier environments or as a persistent host-service launcher.

The adapter launches the benchmark session with redirected standard streams and
returns when the CLI atomically publishes `agent-finished`, after writing its
summary and artifacts. The same runtime continues owning its managed processes
through the grading window; it makes no further provider calls. A normal answer
can carry a failing task status without destroying the service before independent
grading. Agent timeout, provider/runtime failure, or cancellation does not receive
this extension. SIGINT/SIGTERM during the window releases the runtime normally;
grace expiry also disposes it. Final Harbor container teardown ends every process,
including on verifier failure. Retained debug environments still have the bounded
grace deadline. Ordinary CLI/session disposal is unchanged.

The adapter reserves the smaller of 30 seconds or 10% of the agent timeout for
startup and artifact handoff, capping the provider wall-clock budget accordingly.
Cancellation tears down the disposable environment before returning; subclasses
must await the base `run` before removing credentials. The published outer agent
and verifier limits are unchanged. Grading grace is never additional agent time.

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
| `ESTACODA_BENCH_TIMEOUT_MS` | `28800000` | Outer agent timeout in milliseconds (eight hours); the adapter deducts its startup/cleanup reserve for the headless run. Keep aligned with the published Harbor task limit. |
| `ESTACODA_BENCH_SERVICE_GRACE_MS` | unset | Session lifetime after agent completion for shared-environment service grading; maximum 3600000. |
| `ESTACODA_BENCH_REDACT` | `true` | Keep benchmark artifacts redacted by default. |
| `ESTACODA_BENCHMARK_VERSION` | `4.0.0` | Terminal-Bench version label recorded in artifacts; does not select the Harbor dataset. |

Provider budget variables map directly to the matching `estacoda bench run` flags:

- `ESTACODA_BENCH_MAX_PROVIDER_ITERATIONS`
- `ESTACODA_BENCH_MAX_PROVIDER_TOOL_CALLS`
- `ESTACODA_BENCH_MAX_REPEATED_TOOL_FAILURES`
- `ESTACODA_BENCH_MAX_PROVIDER_WALL_CLOCK_MS`

When omitted, the provider wall-clock budget follows the effective CLI deadline
(28,770,000 ms at the default eight-hour limit). An explicit value is capped at
that deadline. Other provider budget flags are only forwarded when supplied.

## Testing

The local adapter tests do not require Harbor:

```bash
python3 -m unittest benchmarks.terminal_bench.harbor_agent_test
python3 -m py_compile benchmarks/terminal_bench/estacoda_harbor_agent.py
```
