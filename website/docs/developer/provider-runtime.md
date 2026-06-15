---
title: Provider runtime
description: Provider execution, fallback routing, finalization, continuation, and native tool-history boundaries.
sidebar_position: 3
---

# Provider runtime

The provider runtime turns a selected provider route into a finalized model response. It owns provider execution, fallback routing, stream collection, finish-reason handling, continuation, native tool-call history, and the boundary between provider output and executable tools.

This page is for maintainers and operators debugging provider behavior. User-facing setup details live in [Providers](../user-guide/providers.md).

---

## What this page covers

Use this page when you need to inspect:

- why a provider route was selected
- whether fallback routing ran
- why a response continued, stopped, or failed closed
- whether finalized tool calls were safe to execute
- whether prior tool calls were replayed as provider-native history
- whether provider replay echo was retained or stripped
- which diagnostics should exist for a provider turn

Provider setup, credentials, and model selection are documented elsewhere. This page is about runtime execution after a route has already been resolved.

---

## Execution path

Provider execution is split across two main runtime surfaces:

| Surface | Role |
|---|---|
| `ProviderExecutor` | Executes the primary route and fallback chain through registered provider adapters. |
| `ProviderTurnLoop` | Runs the turn loop around provider execution, tools, continuation, budgets, and final response handling. |

`ProviderExecutor` is the adapter boundary. It resolves the requested route, calls the matching provider adapter, collects streaming output where supported, records attempt metadata, handles fallback attempts, and returns a finalized provider execution result.

`ProviderTurnLoop` consumes that result. It decides whether the turn is complete, whether finalized tool calls should be planned, whether text continuation is allowed, whether repeated failures or wall-clock budgets have been exceeded, and what visible response should be returned.

The runtime does not execute streamed tool fragments. Tool planning starts only after provider finalization.

---

## Adapter support

EstaCoda routes provider calls through configured provider adapters.

OpenAI-compatible Chat Completions routes are the main path for provider-native tool-call replay. Native replay is enabled only when route metadata, model capability, and API mode all allow it.

EstaCoda also includes an OpenAI Responses adapter for configured `openai_responses` routes. Responses request preparation and non-streaming execution are implemented when network inference is enabled for the runtime. Responses streaming is not part of the current baseline, and Responses routes are not currently the native tool-history replay path.

There is no broad rule that every OpenAI-compatible provider supports every runtime feature. Tool support, native history, reasoning echo, and API mode are checked through metadata and model profile capability.

---

## Finalization contract

Provider output is not canonical until finalization completes. Streamed visible text may be displayed while a request is in flight, but session writes, tool planning, tool execution, retries, and continuation use the finalized `ProviderResponse` and `ProviderExecutionResult`.

Finalization normalizes provider finish reasons into the runtime set:

| Finish reason | Runtime behavior |
|---|---|
| `stop` | Normal completion. |
| `tool_calls` | Finalized tool calls may be planned after finalization. |
| `length` | Visible text may continue; tool calls are unsafe until retried. |
| `content_filter` | Filtered output is not text-continued. |
| `incomplete` | The response is not treated as complete unless a later fallback succeeds. |
| `unknown` | Transport ended without a provider-specific final reason. |

Length-truncated tool calls are never executed from the first attempt. The runtime retries once on the successful route chain. If the retry is still length-truncated with tool calls, the turn returns deterministic visible refusal text and executes no tools.

Malformed finalized tool JSON is a tool-planning error, not a provider failure. The provider produced a final answer, but the runtime rejected unusable tool arguments.

---

## Budgets and continuation

Provider turns run inside explicit budgets. The current loop tracks:

| Budget | Purpose |
|---|---|
| Provider iterations | Prevents unbounded provider/tool continuation loops. |
| Provider tool calls | Caps tool-call volume for a turn. |
| Repeated tool failures | Stops repeated failures with the same tool and outcome. |
| Provider wall-clock time | Prevents a turn from running indefinitely. |

Text continuation is separate from tool-call retry. If a response ends with `length` and contains visible text, the runtime may ask the same route chain to continue the answer. Continuation is bounded by the same provider iteration and wall-clock controls.

Tool calls inside length-truncated output are treated more strictly. They are retried for a clean finalized tool-call response before any execution path can proceed.

---

## Reasoning-only responses

Some providers can return reasoning or provider metadata without usable visible text. The runtime handles these as a provider-turn concern, not as normal user-facing content.

Reasoning-only handling can retry with a prefill message where appropriate. If the response remains unusable, the runtime returns safe visible guidance instead of exposing raw reasoning fields or pretending the provider answered normally.

Raw provider reasoning is not normal assistant text. It must not become memory, summary input, UI text, or diagnostics content unless a specific sanitized path exists.

---

## Native tool-call replay

EstaCoda can preserve finalized provider tool-call turns and replay them as provider-native assistant/tool history for supported OpenAI-compatible Chat Completions routes. This helps models that reason better, or validate more strictly, when prior `tool_calls` and `tool` replies are sent back in their native protocol shape.

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

## Replay safety

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

## Budget and compression

Native history uses a budget-selected chronological suffix, not a fixed last-N message slice. The selector operates on raw prior session messages before irreversible flat summarization.

Atomic units are:

- ordinary session messages
- provider tool groups: the `agent(provider-tool-call-turn)` message plus following matching tool result messages

Selected native units bypass semantic compression. Older unselected units remain available for summary/compression. Complete tool groups are kept whole or compressed whole. Multi-call turns are not split. Active or incomplete groups stay protected.

Before semantic compressor input is built, provider replay echo, raw reasoning fields, provider payload fragments, and runtime/session metadata that is not needed for sanitized compression are removed. The compressor model should never see raw provider reasoning echo.

---

## Provider replay echo

Some thinking-mode providers require previous assistant tool-call turns to include provider reasoning echo when replayed. EstaCoda supports this through `providerReplayEcho`.

`providerReplayEcho` is raw provider reasoning retained as sensitive persisted provider protocol state. It exists only for same-provider, same-API-mode native replay. It is not UI text, normal prompt text, memory, summary input, export material, diagnostics content, or logs.

Rules:

- Store echo only for routes already eligible for native replay and requiring echo.
- Store echo only when the whole turn remains `nativeReplaySafe`.
- Bound echo by the configured cap.
- Strip echo for cross-provider or cross-API-mode replay.
- Remove echo before compression input.
- Missing or oversized required echo disables native replay for that turn unless a tested placeholder path is explicitly enabled.

Provider metadata may mark some thinking-mode Chat Completions routes as requiring `reasoning_content` echo. Those routes are handled through same-provider and same-API-mode checks.

Storage tradeoff: if session metadata is not encrypted/private, `providerReplayEcho` is still sensitive persisted state. If a private encrypted metadata layer is added later, this field should move there.

---

## Serialization and normalization

OpenAI-compatible Chat Completions serialization converts structured provider messages into native request messages:

- assistant `toolCalls` become `tool_calls`
- tool `toolCallId` becomes `tool_call_id`
- empty assistant content with tools serializes as `content: null`
- non-empty assistant content with tools serializes with both `content` and `tool_calls`

Serialization validates a whole native group before emitting it. If a multi-call assistant message is missing any matching tool reply before the next non-tool message, the whole group fails closed. The serializer does not emit partial assistant `tool_calls`, partial tool replies, invented IDs, invented arguments, invented results, or synthetic stubs.

Provider-bound messages are normalized before they leave the runtime. The normalizer strips runtime-only fields, removes unsafe replay echo, and keeps provider request shape separate from session metadata.

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

## Inspection and tests

Useful files:

- `src/providers/provider-executor.ts`
- `src/runtime/provider-turn-loop.ts`
- `src/providers/openai-compatible-provider.ts`
- `src/providers/openai-responses-provider.ts`
- `src/providers/provider-reasoning.ts`
- `src/providers/provider-message-normalizer.ts`
- `src/providers/provider-metadata.ts`
- `src/prompt/prompt-assembly.ts`
- `src/prompt/native-history-builder.ts`
- `src/prompt/native-history-selector.ts`
- `src/prompt/semantic-compressor.ts`

Focused checks include provider executor, provider turn loop, OpenAI-compatible provider, OpenAI Responses provider, provider metadata, prompt assembly, native history builder/selector, and semantic compressor tests.

```bash
pnpm exec vitest run src/providers/provider-executor-route.test.ts
pnpm exec vitest run src/providers/provider-executor-fallback.test.ts
pnpm exec vitest run src/runtime/provider-turn-loop.test.ts
pnpm exec vitest run src/providers/openai-compatible-provider.test.ts
pnpm exec vitest run src/providers/openai-responses-provider.test.ts
pnpm exec vitest run src/providers/provider-metadata.test.ts
pnpm exec vitest run src/prompt/prompt-assembly.test.ts
pnpm exec vitest run src/prompt/native-history-builder.test.ts
pnpm exec vitest run src/prompt/native-history-selector.test.ts
pnpm exec vitest run src/prompt/semantic-compressor.test.ts
```

If native replay does not activate, inspect the route metadata, model tool support, API mode, `structured-tool-history-skipped` reason, and whether the selected history contains a safe complete provider tool group.
