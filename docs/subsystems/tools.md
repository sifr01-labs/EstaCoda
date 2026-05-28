---
title: "Tools"
description: "Tool system: registry, schemas, execution, and builtin tools."
---

# Tools

Tools are functions that extend the agent's capabilities. They are organized into a registry with risk-based gating.

## Files

| File | Lines | Role |
|------|-------|------|
| `src/tools/tool-registry.ts` | ~220 | Register and resolve tools |
| `src/tools/tool-executor.ts` | ~340 | Execute tool calls |
| `src/tools/tool-call-planner.ts` | 132 | Convert provider calls to plans |
| `src/tools/tool-schema.ts` | ~180 | Build OpenAI-compatible schemas |
| `src/tools/tool-result-packet.ts` | ~120 | Packetize tool results |
| `src/tools/builtin-tools.ts` | ~400 | Built-in tool definitions |
| `src/tools/workspace-tools.ts` | ~580 | File read/write/edit/search |
| `src/tools/web-tools.ts` | 731 | Web search and extraction |
| `src/tools/execute-code-tool.ts` | ~240 | Code execution |
| `src/tools/vision-tools.ts` | ~200 | Image analysis |
| `src/tools/media-tools.ts` | ~280 | Media handling |

## Builtin Tools

| Tool | Risk | Evidence |
|------|------|----------|
| `file.read` | `safe` | `live-proven` |
| `file.write` | `caution` | `live-proven` |
| `file.replace` | `caution` | `live-proven` |
| `file.search` | `safe` | `smoke-tested` |
| `web.search` | `read-only-network` | `smoke-tested` |
| `web.extract` | `read-only-network` | `smoke-tested` |
| `web.crawl` | `read-only-network` | `smoke-tested` |
| `browser.*` | `external-side-effect` | `smoke-tested` |
| `image.generate` | `external-side-effect` | `live-proven` |
| `voice.speak` | `external-side-effect` | `smoke-tested` |
| `voice.transcribe` | `safe` | `smoke-tested` |
| `execute_code` | `caution` | `smoke-tested` |
| `memory` | `safe` | `smoke-tested` |
| `skill.*` | `safe` | `smoke-tested` |
| `cronjob` | `caution` | `smoke-tested` |

## Voice Tools

`voice.speak` and `voice.transcribe` use boolean-only tool availability. Human-readable readiness reasons are exposed through exported helpers and CLI/status surfaces, not through `RegisteredTool.isAvailable()`.

Implemented voice providers and security boundaries are documented in [Voice](./voice.md). In short:

- Hosted TTS: OpenAI, ElevenLabs, MiniMax, Gemini, and xAI.
- Hosted STT: OpenAI, Groq, and xAI.
- Local STT: managed faster-whisper by default for `stt.provider: "local"`; command mode only with explicit `stt.local.engine: "command"`.
- Deferred: local TTS providers and Mistral TTS/STT.

Voice credentials are direct environment-variable lookups only. Tool errors use stable provider/reason metadata and bounded sanitized snippets.

## Tool Execution

1. Provider requests tool call
2. `ToolCallPlanner` converts to `ToolCallPlan`
3. `ToolExecutor` runs the tool under `SecurityPolicy`
4. Result is packetized and returned to the provider

## Hardening

- Invalid `file.search` regexes are caught before execution.
- Symlink-cycle-safe recursive search.
- Portable shell fallback.
- SIGTERM then SIGKILL timeout escalation.
- Stable provider tool-call IDs.
- Basic schema validation before execution.
- Stored-result truncation.

## Tool Plan Dependency Model

`tool-call-planner.ts` exists but has no DAG. Dependencies are linear. v0.4 target: explicit dependency representation.
