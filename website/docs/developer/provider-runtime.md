---
title: Provider Runtime
description: Provider execution, finalization, native tool history, and fallback boundaries.
sidebar_position: 3
---

# Provider Runtime

The provider runtime turns a selected model route into a finalized provider response. It owns streaming collection, final-state classification, fallback routing, continuation, native tool-call history, and the safety boundary between provider output and executable tools.

This page is for maintainers and operators debugging provider behavior. User-facing setup details live in [Providers](../user-guide/providers.md).

---

## Execution Contract

Provider output is not canonical until finalization completes. Streamed visible text may be displayed while a request is in flight, but session writes, tool planning, tool execution, retries, and continuation use the finalized `ProviderResponse` and `ProviderExecutionResult`.

Finalization normalizes provider finish reasons into the runtime set:

| Finish reason | Runtime behavior |
|---|---|
| `stop` | Normal completion. |
| `tool_calls` | Tool calls may be planned after finalization. |
| `length` | Visible text may continue; tool calls are unsafe until retried. |
| `content_filter` | Filtered output is not text-continued. |
| `incomplete` | The response is not treated as complete unless a later fallback succeeds. |
| `unknown` | Transport ended without a provider-specific final reason. |

Length-truncated tool calls are never executed from the first attempt. The runtime retries once on the successful route chain. If the retry is still length-truncated with tool calls, the turn returns deterministic visible refusal text and executes no tools.

Malformed finalized tool JSON is a tool-planning error, not a provider failure. That distinction keeps fallback behavior honest: the provider produced a final answer, but the runtime rejected unusable tool arguments.

---

## Native Tool-Call Replay

EstaCoda can preserve finalized provider tool-call turns and replay them as provider-native assistant/tool history for supported OpenAI-compatible Chat Completions routes. This is useful for models that reason better, or validate more strictly, when prior `tool_calls` and `tool` replies are sent back in their native protocol shape.

Native replay is gated at prompt assembly:

| Gate | Required value |
|---|---|
| Provider metadata | `supportsNativeToolHistory === true` |
| Model profile | `supportsTools === true` |
| Route API mode | `openai_chat_completions` |

If any gate fails, the route uses flat text history. Responses routes remain fallback/deferred for native replay. Anthropic native replay remains deferred. There is no broad "OpenAI-compatible means native replay" shortcut.

The lifecycle is:

1. The provider response finalizes.
2. Missing tool-call IDs are normalized once with the same stable helper used by planning.
3. The provider tool-call turn is persisted as an `agent` session message before tool execution.
4. Tool planning and execution use the same normalized IDs.
5. Prompt assembly selects a budgeted chronological suffix of prior history.
6. The native builder converts safe provider tool groups into structured provider messages.
7. The Chat Completions serializer emits the complete assistant/tool group atomically.

The current user or continuation instruction is appended by the normal prompt path and remains the final provider message. It is excluded from native history selection.

---

## Replay Safety

`nativeReplaySafe` is turn-level. Native replay is all-or-nothing for a provider tool-call turn.

Unsafe turns emit no native assistant `tool_calls` and no matching native `tool` messages. They may still be represented through sanitized flat history or summaries.

A turn becomes unsafe when, for example:

- any call contains obvious credential material
- faithful `argumentsText` is missing or redacted
- required provider echo is missing
- required provider echo exceeds the configured cap
- the native group is malformed or incomplete

Secret-bearing arguments are not faithfully stored. Affected calls store `argumentsRedacted: true`, and the whole turn is marked unsafe. The runtime does not replay only the safe-looking half of a multi-call assistant turn; providers expect the assistant tool-call message and all matching tool replies as one protocol group.

No synthetic tool results are created by provider persistence or serialization. Known missing-result repair, where supported, is explicit and never pretends a tool actually ran.

---

## Budget and Compression

Native history uses a budget-selected chronological suffix, not a fixed last-N message slice. The selector operates on raw prior session messages before irreversible flat summarization.

Atomic units are:

- ordinary session messages
- provider tool groups: the `agent(provider-tool-call-turn)` message plus following matching tool result messages

Selected native units bypass semantic compression. Older unselected units remain available for summary/compression. Complete tool groups are kept whole or compressed whole. Multi-call turns are not split. Active or incomplete groups stay protected.

Before semantic compressor input is built, provider replay echo, raw reasoning fields, provider payload fragments, and runtime/session metadata that is not needed for sanitized compression are removed. The compressor model should never see raw provider reasoning echo.

---

## Provider Replay Echo

Some thinking-mode providers require previous assistant tool-call turns to include `reasoning_content` when replayed. EstaCoda supports this through `providerReplayEcho`.

`providerReplayEcho` is raw provider reasoning retained as sensitive persisted provider protocol state. It exists only for same-provider, same-API-mode native replay. It is not UI text, normal prompt text, memory, summary input, export material, diagnostics content, or logs.

Rules:

- Store echo only for routes already eligible for native replay and requiring echo.
- Store echo only when the whole turn remains `nativeReplaySafe`.
- Bound echo by the configured cap.
- Strip echo for cross-provider or cross-API-mode replay.
- Remove echo before compression input.
- Missing or oversized required echo disables native replay for that turn unless a tested placeholder path is explicitly enabled.

DeepSeek and Kimi thinking-mode Chat Completions routes may require `reasoning_content` echo and are handled through same-provider/API-mode checks. MiMo is represented in the echo contract, but it is not native-replay-enabled unless provider metadata and tests explicitly enable it.

Storage tradeoff: if session metadata is not encrypted/private, `providerReplayEcho` is still sensitive persisted state. If a private encrypted metadata layer is added later, this field should move there.

---

## Serialization

OpenAI-compatible Chat Completions serialization converts structured provider messages into native request messages:

- assistant `toolCalls` become `tool_calls`
- tool `toolCallId` becomes `tool_call_id`
- empty assistant content with tools serializes as `content: null`
- non-empty assistant content with tools serializes with both `content` and `tool_calls`

Serialization validates a whole native group before emitting it. If a multi-call assistant message is missing any matching tool reply before the next non-tool message, the whole group fails closed. The serializer does not emit partial assistant `tool_calls`, partial tool replies, invented IDs, invented arguments, invented results, or synthetic stubs.

For echo-required providers, valid matching `providerReplayEcho.value` is serialized only into the configured echo field, currently `reasoning_content`. Raw reasoning fields outside `providerReplayEcho` are not serialized.

---

## Diagnostics

Native replay diagnostics are persistent `SessionEvent` records:

| Event | Purpose |
|---|---|
| `structured-tool-history-selected` | Native history selection succeeded. |
| `structured-tool-history-repaired` | Builder repair counts were recorded. |
| `structured-tool-history-skipped` | Native replay was skipped for a coarse reason. |
| `structured-tool-history-serialized` | Structured native history reached provider-bound Chat Completions context. |

Payloads are counts and coarse reasons only. They may include fields such as provider, model, route role, native pair counts, skipped counts, repair counts, echo counts, and reason enums.

Diagnostics must not include raw arguments, tool results, raw reasoning, echo values, provider payloads, message content, paths, hashes, content fingerprints, serialized request bodies, or stack traces containing prompt content.

---

## Inspection and Tests

Useful files:

- `src/runtime/provider-turn-loop.ts`
- `src/prompt/prompt-assembly.ts`
- `src/prompt/native-history-builder.ts`
- `src/prompt/native-history-selector.ts`
- `src/providers/openai-compatible-provider.ts`
- `src/providers/provider-metadata.ts`

Focused checks:

```bash
pnpm exec vitest run src/runtime/provider-turn-loop.test.ts
pnpm exec vitest run src/prompt/prompt-assembly.test.ts
pnpm exec vitest run src/providers/openai-compatible-provider.test.ts
pnpm exec vitest run src/providers/provider-metadata.test.ts
pnpm exec vitest run src/prompt/native-history-builder.test.ts
pnpm exec vitest run src/prompt/native-history-selector.test.ts
```

If native replay does not activate, inspect the route metadata, model tool support, API mode, `structured-tool-history-skipped` reason, and whether the selected history contains a safe complete provider tool group.
