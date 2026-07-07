---
title: "Testing"
description: "Validation commands, smoke coverage, release checks, and operator evidence."
---

# Testing

EstaCoda uses layered validation. Unit tests are the authoritative code gate, smoke tests cover cross-subsystem behavior, eval fixtures catch deterministic agent regressions, and package/install validators check the artifacts users actually run.

The commands below are grounded in `package.json`, `vitest.node.config.ts`, `src/smoke.ts`, `src/smoke/cases/`, `scripts/run-eval-fixtures.ts`, and the validation scripts under `scripts/`.

## Core validation lane

Run this lane before declaring a normal code change ready:

```bash
pnpm run typecheck
pnpm run test
pnpm run smoke
pnpm run build
pnpm run audit:runtime-imports
pnpm run audit:esm
pnpm run smoke:dist
```

What each command proves:

| Command | Source | What it checks |
|---|---|---|
| `pnpm run typecheck` | `tsc --noEmit` | TypeScript compiles without emitting output. |
| `pnpm run test` | `vitest run --config vitest.node.config.ts` | Node/Vitest unit tests under `src/**/*.test.ts`. |
| `pnpm run smoke` | `node --import tsx src/smoke.ts` | Source-mode integration smoke with mocked providers/adapters. |
| `pnpm run build` | `tsc -p tsconfig.build.json` after `clean:dist` | Production `dist/` output builds. |
| `pnpm run audit:runtime-imports` | `scripts/audit-runtime-imports.mjs` | Runtime import graph sanity before shipping. |
| `pnpm run audit:esm` | `scripts/audit-esm.mjs dist` | ESM packaging correctness in built output. |
| `pnpm run smoke:dist` | `node dist/smoke.js` | Built-output smoke. This is the final artifact sanity check. |

Do not skip `typecheck`. Type errors can pass runtime tests and still break the build.

## Validation by change type

Use targeted lanes to reduce feedback time, then run the core validation lane before merge or release.

| Change type | Run |
|---|---|
| Most TypeScript/runtime changes | `pnpm run typecheck`, `pnpm run test` |
| Cross-subsystem runtime behavior | `pnpm run smoke`, then `pnpm run smoke:dist` after build |
| Agent/eval logic | `pnpm run eval:fixtures` |
| Provider routing, reasoning, continuation, or message normalization | `pnpm run provider:hardening` plus targeted Vitest tests for the touched provider/runtime files |
| Benchmark harness or adapter changes | `pnpm run benchmark:smoke`, `pnpm run benchmark:terminal-bench:adapter-test`, targeted tests under `src/benchmark` and `src/cli/bench-command.test.ts` |
| Install/update behavior | `pnpm run validate:install`, `pnpm run validate:source-install` |
| Uninstall behavior | `pnpm run validate:uninstall` |
| npm/package readiness | `pnpm run verify:local-bin`, `pnpm run pack:dry-run`, `pnpm run verify:package-bin` |
| Docker handoff | `pnpm run validate:docker` |
| Homebrew handoff | `pnpm run validate:homebrew` |
| Skills catalog changes | `pnpm run skills:catalog`, then inspect generated website API output |
| Docs-only changes | `git diff --check`; build the Docusaurus site when sidebars, links, frontmatter, or i18n files change |

## Smoke tests

Smoke tests are the integration safety net. They exercise product flows with mocked providers and adapters, so they are fast and deterministic. They do not prove live API behavior.

**Entrypoint:** `src/smoke.ts`

**Runner:** `src/smoke/smoke-runner.ts`

**Cases:** `src/smoke/cases/*.ts`

Current smoke cases include:

- bare launch
- init lifecycle
- update dry run
- pack lifecycle
- bundled skill sync
- corrupt skill usage recovery
- evolution lifecycle and evolution safety
- delegation MVP
- gateway stop behavior
- WhatsApp support

Useful smoke commands:

```bash
# All cases
pnpm run smoke

# List cases
pnpm run smoke --list

# By tag
pnpm run smoke --tag skills
pnpm run smoke --tag memory

# By case ID
pnpm run smoke --id corrupt-skill-usage

# Fail fast + JSON
pnpm run smoke --fail-fast --json
```

### What smoke does not prove

Smoke tests mock or simulate several external surfaces. Treat these as testing boundaries, not product limitations:

- Real provider calls
- Real Telegram or WhatsApp gateway sessions
- Real browser automation against a live browser service
- Real MCP server execution
- Real voice/image provider output
- Real microphone capture, live Discord voice sessions, and first-run faster-whisper downloads

Live behavior still needs operator validation when a change touches a live provider, channel, browser backend, voice path, installer, update path, or package artifact.

## Benchmark checks

Benchmark checks are operator validation lanes, not normal user UX. The CI-safe lanes are:

```bash
pnpm run benchmark:smoke
pnpm run benchmark:terminal-bench:adapter-test
```

Use Harbor manually for Terminal-Bench smoke and full baseline runs. Do not run full Terminal-Bench in ordinary CI.

See [Benchmark Operations](./benchmarks.md) for the reproducible runbook, artifact contract, no-tuning rule, and public reporting guidance.

## Eval fixtures

Run the default eval fixture corpus with:

```bash
pnpm run eval:fixtures
```

Run one fixture by ID with:

```bash
pnpm run eval:fixtures -- <fixture-id>
```

The default corpus is defined in `src/eval/fixtures/index.ts` and currently covers:

- Base runtime behavior
- Tool security and missing-tool failure classification
- Memory curation, promotion, deactivation, selective rendering, and safety-file protection
- Code dependency graph lookup and cache invalidation
- Agent Evolution manifests, proposals, user-correction capture, routing metadata, routing baseline, and export shape
- Workflow run state, locking, migration, store atomicity, engine lifecycle, restart recovery, command control, event summaries, and integration

Prefer category descriptions in docs over hard-coding fixture counts. Fixture IDs change as the eval corpus grows.

## Provider and reasoning checks

For provider hardening, start with:

```bash
pnpm run provider:hardening
```

When changing provider streaming, tool-call planning, reasoning extraction, continuation, prompt compression, or transcript consumers, also run the focused tests that match the touched subsystem. Common examples:

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
```

Inspect these failure modes before accepting provider-runtime changes:

- `incomplete-stream` stays a failure or uses fallback; it must not become a final assistant answer.
- Length-truncated tool calls retry once or refuse safely; the first truncated attempt must not reach planning or execution.
- Malformed finalized tool JSON remains a tool-planning error.
- Reasoning-only responses use the visible-answer retry path without exposing raw reasoning.
- Length-truncated visible text continuation persists one final assistant message and no synthetic continuation messages.
- Summaries, memory, skills, and export traces strip raw reasoning while preserving ordinary visible prose.

## Diagnostic CLI tools

These commands inspect runtime evidence. They are not replacements for tests.

```bash
# Inspect execution history
estacoda trace list [--session <id>] [--limit <n>]
estacoda trace dump <trajectory-id> [--raw]
estacoda trace timeline <trajectory-id> [--raw]
estacoda trace failures <trajectory-id>

# Run eval fixtures from the CLI
estacoda eval [fixture-id]
```

For manual inspection after a local turn:

```bash
pnpm run dev
estacoda trace list --limit 5
estacoda trace dump <trajectory-id> --raw
```

Raw reasoning, `reasoning_content`, `reasoning_details`, discarded truncated tool arguments, and synthetic continuation/prefill messages should not appear in persisted session-visible messages, runtime/session events, summaries, memory files, skill records, or export traces. Safe metadata such as finish reason, usage, `reasoningMetadata`, truncation status, and continuation status may appear.

## Install, update, package, and uninstall validation

The release surface is not only TypeScript. Installer, updater, package, and handoff scripts have their own gates:

```bash
pnpm run verify:local-bin
pnpm run pack:dry-run
pnpm run verify:package-bin
pnpm run validate:install
pnpm run validate:source-install
pnpm run validate:uninstall
pnpm run validate:docker
pnpm run validate:homebrew
```

Use these when touching:

- `package.json`, package metadata, `bin`, or `files`
- `scripts/install.sh`, `scripts/setup-estacoda.sh`, `scripts/uninstall.sh`, or `scripts/estacoda-wrapper.sh`
- update routing or managed-source behavior
- Docker, Homebrew, npm, or source-install documentation
- WhatsApp bridge packaging boundaries

`verify-package-bin.sh` also checks that the npm tarball includes required runtime files and excludes source, website, test, node_modules, and secret/state paths.

## Manual operator validation

Mocks keep CI deterministic, but some behaviors must be checked live before calling them live-proven:

- Provider calls against the target model/provider
- Telegram and WhatsApp gateway sessions
- Browserbase or live browser sessions
- Hosted TTS/STT and first-run local STT model download
- Microphone capture and Discord voice paths
- Docker/Homebrew/npm install paths in clean environments
- Arabic terminal rendering in real terminal workflows

Capture evidence with:

- command output
- logs and trace IDs
- screenshots for UI or terminal rendering issues
- exact provider/channel/config used
- reproduction steps for failures

## Recommended practice

1. Run `pnpm run typecheck` first.
2. Run targeted tests for the subsystem you changed.
3. Run the core validation lane before declaring success.
4. Run install/package validators when touching release surfaces.
5. Run live operator validation when changing live providers, channels, browser, voice, installer, or Arabic terminal behavior.
6. Capture failures with logs, traces, screenshots, and reproduction steps.

## Related docs

- [Known Issues](./known-issues.md) — limitations that affect testing scope
- [Environment](./environment.md) — development environment setup
- [Agent Handoff](./agent-handoff.md) — short operational note for incoming coding agents
