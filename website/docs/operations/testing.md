---
title: Testing
description: Validation layers, smoke tests, eval fixtures, and operator checks.
sidebar_position: 1
---

# Testing

EstaCoda ships with a layered validation stack. The authoritative gate is the Vitest unit-test suite. Smoke tests serve as the integration safety net. Eval fixtures detect deterministic regressions. Runtime import and ESM audits catch packaging mistakes before they reach users.

Run validation in this order:

```bash
pnpm run typecheck
pnpm run test
pnpm run smoke
pnpm run build
pnpm run audit:runtime-imports
pnpm run audit:esm
pnpm run smoke:dist
```

Do not skip `typecheck`. Type errors can pass tests while breaking builds.

## Validation layers

| Command | What it checks | When to run |
|---------|---------------|-------------|
| `pnpm run typecheck` | TypeScript compilation with zero errors | Before every commit |
| `pnpm run test` | Vitest unit-test suite | Before every PR |
| `pnpm run smoke` | Source-mode integration smoke | Before every PR |
| `pnpm run build` | Production `dist/` compilation | Before release candidate |
| `pnpm run audit:runtime-imports` | Runtime import graph sanity | After structural moves |
| `pnpm run audit:esm` | ESM packaging correctness | After build changes |
| `pnpm run smoke:dist` | Built-output smoke | Before release candidate |
| `pnpm run eval:fixtures` | 27 deterministic eval fixtures | After logic changes |

`pnpm run smoke:dist` is the final gate. If it fails, the built artifact is broken.

## Smoke tests

**Entrypoint:** `src/smoke.ts`
**Runner:** `src/smoke/smoke-runner.ts`
**Cases:** `src/smoke/cases/*.ts`
**Legacy baseline:** `src/smoke/_legacy.ts` (assertions preserved)

Smoke covers cross-subsystem behavior with mocked providers and adapters. It does not call live APIs.

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

### What smoke covers

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
- Trajectory persistence and failure classification
- Trace CLI commands
- Eval runner and fixtures
- Golden flow comparison
- Change manifest state transitions
- Code dependency graph: forward/reverse/affected lookup, summary, cache invalidation
- TaskFlow: state transitions, locking, migration, atomicity, engine lifecycle, restart recovery, operator control plane, compaction

### What smoke does not cover

- Real provider execution (mocked)
- Real Telegram gateway (mocked adapter)
- Real browser automation (mock backend)
- Real MCP server execution (mocked)
- Real voice/image generation (mocked responses)
- Real Discord voice-channel sessions, microphone input, live voice providers, live faster-whisper model downloads

Smoke limitations are not product limitations. They are testing boundaries.

## Eval fixtures

27 deterministic fixtures run with `pnpm run eval:fixtures`.

**Base runtime (3):**
- `provider-text-response` — Provider returns text without tool calls
- `tool-security-block` — Dangerous command blocked by security policy
- `missing-tool-failure` — Unregistered tool returns undefined

**Memory (4):**
- `memory-promotion-provenance` — Promotion carries provenance metadata
- `memory-deactivate-suppresses` — Deactivated memory suppressed from context
- `memory-selective-renders` — Selective renderer respects fallback rules
- `memory-safety-files-protected` — Safety files cannot be deactivated

**Code dependency graph (5):**
- `knowledge-forward-deps` — Forward dependency lookup
- `knowledge-reverse-deps` — Reverse dependency lookup
- `knowledge-affected-files` — Transitive affected-file lookup
- `knowledge-graph-summary` — Graph summary counts
- `knowledge-cache-invalidates` — Cache invalidates on source change

**Evolution (6):**
- `manifest-creation-from-observation` — Observation creates ChangeManifest
- `skill-proposal-manifest-bridge` — `skill.propose_patch` creates manifest
- `user-correction-recording` — User correction recorded as event
- `tool-description-proposal` — Tool description manifest skeleton
- `routing-metadata-proposal` — Routing metadata manifest skeleton
- `evolution-export-shape` — Export dataset matches schema

**TaskFlow foundation (5):**
- `taskflow-state-transitions` — Flow and step state transitions
- `taskflow-locking` — Lock acquire, release, heartbeat, stale recovery
- `taskflow-migration` — Schema migration
- `taskflow-atomicity` — Atomic transitions and round-trip integrity
- `taskflow-engine-lifecycle` — Engine flow and step lifecycle

**TaskFlow engine (1):**
- `taskflow-restart-recovery` — Restart recovery marks stale flows interrupted

**Operator control plane (1):**
- `operator-control-plane` — Dispatcher routes and validates slash commands

**Compaction (1):**
- `flow-compaction` — Manual, automatic, boundary safety, preservation

**Track 5 integration (1):**
- `track5-integration` — System integration: adapter, CLI bridge, runtime wiring

## Diagnostic CLI tools

```bash
# Inspect execution history
estacoda trace list [--session <id>] [--limit <n>]
estacoda trace dump <trajectory-id> [--raw]
estacoda trace timeline <trajectory-id> [--raw]
estacoda trace failures <trajectory-id>

# Run eval fixtures
estacoda eval [fixture-id]
```

These are runtime inspection tools, not replacements for unit tests.

## Targeted test practices

Run the full stack before structural changes. Run targeted suites for subsystem work.

```bash
# Voice subsystem only
pnpm exec vitest run src/tools/voice-tools.test.ts src/tools/tts-providers.test.ts src/tools/stt-providers.test.ts
pnpm exec vitest run src/channels/voice-transcription.test.ts src/gateway/voice-state.test.ts
```

Provider finalization and reasoning hygiene checks:

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

Inspect these failure modes before changing provider runtime behavior:

- `incomplete-stream` stays a failure or uses fallback; it must not become a final assistant answer
- length-truncated tool calls retry once or refuse; the first truncated attempt must not reach planning or execution
- malformed finalized tool JSON stays a tool-planning error
- reasoning-only responses use the visible-answer retry path without displaying raw reasoning
- length-truncated visible text continuation persists one final assistant message and no synthetic continuation messages
- summary, memory, skill, and export tests strip reasoning while preserving ordinary visible prose

Manual inspection path:

```bash
pnpm run dev
estacoda trace list --limit 5
estacoda trace dump <trajectory-id> --raw
```

Raw reasoning, `reasoning_content`, `reasoning_details`, discarded truncated tool arguments, and synthetic continuation/prefill messages should not appear in persisted session-visible messages, runtime/session events, summaries, memory files, skill records, or export traces. Safe finish reason, usage, `reasoningMetadata`, truncation status, and continuation status may appear.

Provider, Discord voice, and faster-whisper tests use mocks where optional packages or live services are absent. Live provider calls, real Discord voice, microphone capture, and first-run model downloads are operator integration tests, not base CI requirements.

## Recommended practice

1. Run `pnpm run typecheck` first.
2. Run `pnpm run test`, `pnpm run smoke`, and `pnpm run smoke:dist` before declaring success.
3. For live behavior, run manual operator validation.
4. Capture failures with screenshots, logs, and reproduction steps.

## Related docs

- [Known Issues](./known-issues.md) — limitations that affect testing scope
- [Gateway Operations](./gateway-operations.md) — operator commands for diagnostics
