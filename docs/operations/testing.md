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
bun run scripts/run-eval-fixtures.ts
```

**Check** | **Evidence Level**
`typecheck` | Compile guard only
`smoke` | `smoke-tested`
`eval fixtures` | Deterministic regression detection (18 cases)

## Smoke Tests

**Entrypoint:** `src/smoke.ts` (thin wrapper)
**Runner:** `src/smoke/smoke-runner.ts`
**Legacy baseline:** `src/smoke/_legacy.ts` (~14,000 lines, all assertions preserved)
**Legacy wrapper case:** `src/smoke/cases/legacy-monolith.ts` (thin 9-line wrapper)
**Extracted cases:** `src/smoke/cases/*.ts`
**Eval fixtures:** 18 (3 base + 4 memory + 5 code-graph + 6 evolution)

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
- Eval runner and fixtures (18 deterministic evals)
- Golden flow comparison
- Change manifest state transitions
- Code dependency graph: forward/reverse/affected lookup, summary, cache invalidation
- **Evolution:** manifest creation, proposal bridge, user-correction capture, tool-description/routing-metadata skeletons, export shape

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
