---
title: "Testing"
description: "Testing strategy, smoke tests, and validation commands."
---

# Testing

## Philosophy

EstaCoda currently has **broad smoke coverage and no unit tests**. The smoke test file is the primary safety net.

## Fast Regression Checks

Run these before and after most changes:

```bash
bun run typecheck
bun run smoke
bun run scripts/run-eval.ts
```

**Check** | **Evidence Level**
`typecheck` | Compile guard only
`smoke` | `smoke-tested`
`eval fixtures` | Deterministic regression detection (27 cases)

## Smoke Tests

**Entrypoint:** `src/smoke.ts` (thin wrapper)
**Runner:** `src/smoke/smoke-runner.ts`
**Legacy baseline:** `src/smoke/_legacy.ts` (~14,000 lines, all assertions preserved)
**Legacy wrapper case:** `src/smoke/cases/legacy-monolith.ts` (thin 9-line wrapper)
**Extracted cases:** `src/smoke/cases/*.ts`
**Eval fixtures:** 27 deterministic evals (see below)

### Running Smoke Cases

```bash
# All cases
bun run smoke

# By tag
bun run smoke --tag skills
bun run smoke --tag memory

# By case ID
bun run smoke --id corrupt-skill-usage

# List cases
bun run smoke --list

# Fail fast + JSON
bun run smoke --fail-fast --json
```

### What Smoke Covers

- Provider normalization and routing
- Tool-call recovery and continuation
- Browser backend basics
- Image generation (FAL, BytePlus/Seedream)
- Voice (TTS, STT)
- Telegram progress, approvals, attachments, session lifecycle
- Skill execution, mutation, evolution
- Memory promotion, provenance, selective rendering, deactivation, safety-file protection
- Security policy and hard floor
- Cron create/list/edit/tick
- MCP discovery and reload
- ACP basic flow
- Context expansion and prompt packing
- Artifact handling
- Onboarding copy and settings
- Trajectory persistence and failure classification
- Trace CLI commands
- Eval runner and fixtures (27 deterministic evals)
- Golden flow comparison
- Change manifest state transitions
- Code dependency graph: forward/reverse/affected lookup, summary, cache invalidation
- **Evolution:** manifest creation, proposal bridge, user-correction capture, tool-description/routing-metadata skeletons, export shape
- **TaskFlow:** state transitions, locking, migration, atomicity, engine lifecycle, restart recovery, operator control plane, compaction, runtime integration

### Eval Fixtures

Run with `bun run scripts/run-eval.ts` or `bun run scripts/run-eval.ts --id <fixture-id>`.

**Base runtime (3):**
- `provider-text-response` — Provider returns text without tool calls
- `tool-security-block` — Dangerous command is blocked by security policy
- `missing-tool-failure` — Unregistered tool returns undefined and classifies as not-found

**Memory (4):**
- `memory-promotion-provenance` — Memory promotion carries provenance metadata
- `memory-deactivate-suppresses` — Deactivated memory is suppressed from rendered context
- `memory-selective-renders` — Selective renderer returns relevant entries and respects fallback rules
- `memory-safety-files-protected` — Safety file entries cannot be deactivated

**Code dependency graph (5):**
- `knowledge-forward-deps` — Forward dependency lookup returns correct direct imports
- `knowledge-reverse-deps` — Reverse dependency lookup returns correct direct importers
- `knowledge-affected-files` — Affected-file lookup returns correct transitive dependents
- `knowledge-graph-summary` — Graph summary reports correct node and edge counts
- `knowledge-cache-invalidates` — Cache invalidates when source files change

**Evolution (6):**
- `manifest-creation-from-observation` — Observation with candidateImprovement creates a ChangeManifest
- `skill-proposal-manifest-bridge` — skill.propose_patch creates a ChangeManifest and links it
- `user-correction-recording` — recordUserCorrection writes user-correction event
- `tool-description-proposal` — Tool description proposal manifest can be created and inspected
- `routing-metadata-proposal` — Routing metadata proposal manifest can be created and inspected
- `evolution-export-shape` — Evolution export dataset matches OptimizationDataset schema

**TaskFlow foundation (5):**
- `taskflow-state-transitions` — Flow and step state transitions are validated correctly
- `taskflow-locking` — Flow lock acquire, release, heartbeat, and stale recovery
- `taskflow-migration` — v0.8 schema migration creates tables and sets version
- `taskflow-atomicity` — SQLiteTaskFlowStore atomic transitions and round-trip integrity
- `taskflow-engine-lifecycle` — TaskFlowEngine flow and step lifecycle methods

**TaskFlow engine (1):**
- `taskflow-restart-recovery` — FlowRestartRecovery marks running flows/steps interrupted and releases stale locks

**Operator control plane (1):**
- `operator-control-plane` — OperatorCommandDispatcher routes and validates all slash commands

**Compaction (1):**
- `flow-compaction` — Flow-Safe Compaction: manual, automatic, boundary safety, preservation

**Track 5 integration (1):**
- `track5-integration` — Track 5 System Integration: adapter, CLI bridge, runtime wiring, compaction, linkage

### What Smoke Does Not Cover

- Real provider execution (mocked)
- Real Telegram gateway (mocked adapter)
- Real browser automation (mock backend)
- Real MCP server execution (mocked)
- Real voice/image generation (mocked responses)

### Smoke Limitations

- Legacy monolith still contains most assertions in one file
- No formal test framework (assertions are manual `throw`/`assert`)
- `// @ts-nocheck` on legacy monolith due to TypeScript control-flow analysis limits
- New extracted cases use full type-checking

## Diagnostic CLI Tools

```bash
# Inspect execution history
estacoda trace list [--session <id>] [--limit <n>]
estacoda trace dump <trajectory-id> [--raw]
estacoda trace timeline <trajectory-id> [--raw]
estacoda trace failures <trajectory-id>

# Run eval fixtures
estacoda eval [fixture-id]
```

These are runtime inspection and validation tools, not a replacement for unit tests.

## Recommended Test Practices

1. Run `bun run typecheck` first.
2. Run `bun run smoke` before declaring success.
3. For live behavior, run the internal alpha harness.
4. Capture failures with screenshots, logs, and reproduction steps.

## Future Testing

**Target:** Post-v0.7

- Introduce Vitest (Bun-compatible) — deferred from v0.4–v0.6 to avoid blocking feature delivery
- Extract unit tests for Router, Planner, Executor, Recorder
- Keep smoke.ts as integration layer only
- Add per-subsystem test suites
- Expand eval fixture corpus for regression detection
