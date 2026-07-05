# Local Benchmark Smoke

This fixture is the CI-safe benchmark smoke lane for EstaCoda's headless benchmark runner.

It intentionally does not call a live model or an external benchmark harness. The smoke test injects a fake runtime into `estacoda bench run`, materializes the task workspace, emits runtime events, writes the expected workspace output, and verifies the generated benchmark artifacts.

Run it with:

```bash
pnpm run benchmark:smoke
```

This catches harness regressions before running Terminal-Bench or Harbor-backed adapters.
