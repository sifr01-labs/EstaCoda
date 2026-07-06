---
title: "Operator Suite"
description: "Deterministic operator-runtime scenarios for EstaCoda benchmark development."
---

# Operator Suite

The EstaCoda Operator Suite is a deterministic benchmark lane for runtime behavior. It complements public benchmarks by measuring operator capabilities that EstaCoda owns: workspace isolation, evidence gathering, trajectory artifacts, tool orchestration, recovery, memory/session behavior, and regression tracking.

The first smoke lane is:

```bash
pnpm run benchmark:operator-smoke
```

This lane uses deterministic fake runtimes. It requires no live provider, browser, network, or real user home.

## Scenario Contract

Every operator scenario must define:

| Field | Purpose |
|---|---|
| `objective` | The operator task being measured |
| `fixtureShape` | Files, directories, config, scripts, and state the scenario provides |
| `expectedOutcome` | Concrete end state or answer requirement |
| `verifierCommand` | Deterministic local command that validates final state |
| `evidenceAssertions` | Runtime evidence required in events, trajectory, final answer, or metrics |
| `metricsWatched` | Metrics worth tracking across commits |
| `knownNonGoals` | Explicitly out-of-scope behavior to prevent suite drift |

The registry lives in `src/benchmark/operator-suite.ts`. Fixtures live under `benchmarks/operator-suite/<scenario-id>/`.

## Registry Shape

Scenarios are grouped by category:

- `bug-fix`
- `config-repair`
- `failure-recovery`
- `workspace-isolation`
- `repo-discovery`
- `memory-continuity`
- `docs-generation`

The first deterministic smoke suite covers:

| Scenario | Category | Capability |
|---|---|---|
| `one-file-bug-diagnosis` | `bug-fix` | Diagnose, patch, verify |
| `local-provider-base-url-repair` | `config-repair` | Inspect config, apply minimal repair |
| `tool-failure-retry-recovery` | `failure-recovery` | Recover after injected tool failure |
| `two-workspace-scope-isolation` | `workspace-isolation` | Avoid unrelated workspace context |
| `architecture-entrypoint-discovery` | `repo-discovery` | Evidence-grounded architecture discovery |

`memory-continuity` and `docs-generation` are reserved registry categories for later deterministic scenarios.

## Good Verifiers

A good verifier is deterministic, local, and checks final state rather than model prose.

Prefer verifiers that:

- run without network
- use temporary scenario workspaces only
- check specific files or config values
- fail before the intended fix and pass after it
- avoid snapshots of incidental wording
- avoid depending on wall-clock timing

Avoid verifiers that:

- require live providers
- require browser or external service access
- grade broad writing style
- inspect real user home, memory, config, sessions, or credentials
- require a specific tool route when multiple routes are valid

## Evidence Assertions

Assertions should validate outcomes and evidence, not brittle routes. Prefer:

- file inspected
- command attempted
- patch touches expected path
- forbidden path untouched
- final answer contains expected root cause
- no unrelated memory or context injected
- event kind present or absent
- metric under threshold
- workspace path scoped correctly

Avoid assertions like "browser navigation must happen" unless the route itself is the behavior under test.

## Metrics

Operator scenarios produce the normal benchmark artifacts:

- `summary.json`
- `events.ndjson`
- `trajectory.jsonl`
- `trajectory-summary.json`
- `history.jsonl`
- `stdout.txt`
- `stderr.txt` on failure

Track these over time:

- success/failure
- duration
- input, output, and total tokens
- estimated cost when available
- tool calls
- tool failures
- provider iterations
- provider budget exhaustions
- memory writes and promotions
- session recall and external memory recall
- security escalations

Warnings should remain warning-only until a scenario has proven stable across many runs.

## Adding a Scenario

1. Add a fixture under `benchmarks/operator-suite/<scenario-id>/`.
2. Include `instruction.txt`, `verifier.sh`, and `workspace/`.
3. Add a contract entry to `OPERATOR_SCENARIO_REGISTRY`.
4. Add deterministic runtime behavior in `src/benchmark/operator-suite.test.ts`.
5. Assert final state with the verifier.
6. Assert evidence using shared helpers from `src/benchmark/evidence-assertions.ts`.
7. Run:

```bash
pnpm run benchmark:operator-smoke
```

Then run the broader benchmark validation before publishing.
