---
title: "Testing"
description: "Testing strategy, smoke tests, and validation commands."
---

# Testing

## Philosophy

EstaCoda uses an authoritative Node/Vitest unit-test lane plus source and built-output smoke checks. Smoke remains the integration safety net for cross-subsystem behavior.

## Fast Regression Checks

Run these before and after most changes:

```bash
pnpm run typecheck
pnpm run test
pnpm run smoke
pnpm run smoke:dist
pnpm run eval:fixtures
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
pnpm run smoke

# By tag
pnpm run smoke --tag skills
pnpm run smoke --tag memory

# By case ID
pnpm run smoke --id corrupt-skill-usage

# List cases
pnpm run smoke --list

# Fail fast + JSON
pnpm run smoke --fail-fast --json
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

Run with `pnpm run eval:fixtures` or `pnpm run dev -- eval <fixture-id>`.

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
- Real Discord voice-channel sessions, optional Discord voice packages, real microphone input, live voice providers, and live faster-whisper model downloads. Voice unit tests mock these surfaces unless explicitly run as operator integration tests.

### Smoke Limitations

- Legacy monolith still contains most assertions in one file
- Smoke assertions are manual `throw`/`assert`; unit tests run through Vitest.
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

## Provider Finalization Checks

When changing provider streaming, tool-call planning, reasoning extraction, continuation, or downstream transcript consumers, run the narrow lane first:

```bash
pnpm exec vitest run src/providers/provider-executor-fallback.test.ts
pnpm exec vitest run src/providers/provider-executor-route.test.ts
pnpm exec vitest run src/providers/openai-compatible-provider.test.ts
pnpm exec vitest run src/providers/openai-responses-provider.test.ts
pnpm exec vitest run src/providers/provider-reasoning.test.ts
pnpm exec vitest run src/providers/provider-message-normalizer.test.ts
pnpm exec vitest run src/runtime/provider-turn-loop.test.ts
pnpm exec vitest run src/runtime/agent-loop.test.ts
pnpm exec vitest run src/prompt/semantic-compressor.test.ts
pnpm exec vitest run src/memory/local-memory-provider.test.ts
pnpm exec vitest run src/skills/skill-learning.test.ts
pnpm exec vitest run src/skills/skill-evolution.test.ts
pnpm exec vitest run src/evolution/export-format.test.ts
```

Expected failure modes to inspect:

- `incomplete-stream` stays a provider failure or uses fallback; it must not become a successful assistant response
- length-truncated tool calls retry once or refuse safely; the first truncated attempt must not reach tool planning or execution
- malformed finalized tool JSON stays a tool-planning error
- reasoning-only non-length responses retry with local-only visible-answer prefill
- reasoning-only length exhaustion returns visible guidance and does not text-continue
- length-truncated visible text continuation persists one final assistant message and no synthetic continuation messages
- summary, memory, skill learning/evolution, and export tests preserve ordinary visible prose while stripping raw reasoning fields and inline hidden blocks

For manual inspection, run a local turn that streams visible text and tools, then inspect session messages and trace output:

```bash
pnpm run dev
estacoda trace list --limit 5
estacoda trace dump <trajectory-id> --raw
```

Raw reasoning, `reasoning_content`, `reasoning_details`, discarded truncated tool arguments, and synthetic continuation/prefill messages should not appear in persisted session-visible messages, runtime/session events, summaries, memory files, skill records, or export traces. Safe metadata such as finish reason, usage, `reasoningMetadata`, truncation status, and continuation status may appear.

## Recommended Test Practices

1. Run `pnpm run typecheck` first.
2. Run `pnpm run test`, `pnpm run smoke`, and `pnpm run smoke:dist` before declaring success.
3. For live behavior, run the internal alpha harness.
4. Capture failures with screenshots, logs, and reproduction steps.

## Voice Validation

Targeted voice checks:

```bash
pnpm exec vitest run src/tools/voice-tools.test.ts src/tools/tts-providers.test.ts src/tools/stt-providers.test.ts
pnpm exec vitest run src/channels/voice-transcription.test.ts src/channels/channel-gateway.test.ts src/gateway/voice-state.test.ts
pnpm exec vitest run src/channels/telegram-adapter.test.ts src/channels/discord-adapter.test.ts src/channels/discord-voice-bridge.test.ts
pnpm exec vitest run src/cli/voice-mode.test.ts src/cli/session-loop.test.ts
```

For full voice-adjacent validation, also run:

```bash
pnpm run typecheck
pnpm run test
pnpm run smoke
pnpm run build
pnpm run audit:runtime-imports
pnpm run audit:esm
pnpm run smoke:dist
git diff --check
```

Provider, Discord voice, and faster-whisper tests use mocks where optional packages or live services are absent. Live Discord voice, real provider calls, microphone capture, and first-run model downloads are operator integration tests, not base CI requirements.

## Future Testing

**Target:** Post-v0.7

- Keep expanding subsystem unit tests for Router, Planner, Executor, Recorder
- Keep smoke.ts as integration layer only
- Add per-subsystem test suites
- Expand eval fixture corpus for regression detection
