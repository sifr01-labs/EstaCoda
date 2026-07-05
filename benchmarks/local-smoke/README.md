# Local Benchmark Smoke

This fixture is the CI-safe benchmark smoke lane for EstaCoda's headless benchmark runner.

It intentionally does not call a live model or an external benchmark harness. The smoke test injects a fake runtime into `estacoda bench run`, materializes the task workspace, emits runtime events, writes the expected workspace output, and verifies the generated benchmark artifacts.

Run it with:

```bash
pnpm run benchmark:smoke
```

This catches harness regressions before running Terminal-Bench or Harbor-backed adapters.

The operator-facing simple file task lives at:

```text
benchmarks/local-smoke/simple-file-task/instruction.txt
benchmarks/local-smoke/simple-file-task/verify.sh
```

Use it for artifact/control smoke runs that validate CLI artifact writing without provider credentials. An unconfigured isolated home may return `config_error`; that is expected for control smoke. Live local smoke runs should pass provider/model configuration and then verify the workspace with `verify.sh`.
