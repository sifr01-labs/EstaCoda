---
title: Tool Runtime
description: Tool planning, execution, result persistence, and native replay boundaries.
sidebar_position: 4
---

# Tool Runtime

The tool runtime is the boundary between provider output and local action. It converts finalized provider tool calls into plans, applies security policy, executes approved tools, packetizes results, and records enough structure for safe continuation.

This page focuses on runtime behavior. The user-facing tool list lives in [Tools](../user-guide/tools.md).

---

## Execution Flow

Tool execution starts only after provider finalization:

1. The provider returns finalized tool calls.
2. Missing tool-call IDs are normalized once.
3. `ToolCallPlanner` converts each call into a tool plan.
4. Security and approval policy decide whether execution may proceed.
5. `ToolExecutor` runs the tool.
6. The result packet is persisted and sent back through continuation.

Streaming fragments, incomplete streams, malformed JSON, and length-truncated tool calls do not bypass this path. If a tool call is not finalized, it is not executable.

---

## Stable IDs

Provider-native replay depends on ID consistency. When a provider omits a tool-call ID, EstaCoda derives one with `stableToolCallId()`.

The same normalized IDs are used for:

- the persisted provider tool-call turn
- `ToolCallPlanner`
- tool result `metadata.tool_call_id`
- native history builder matching
- OpenAI-compatible Chat Completions serialization

There is no separate planner-only ID path. If IDs diverge, native replay should fail closed instead of inventing a link.

---

## Provider Tool-Call Persistence

When finalized tool calls exist, the runtime persists one provider tool-call turn before tool execution. The session message has:

- `role: "agent"`
- `metadata.kind: "provider-tool-call-turn"`
- `metadata.providerToolCalls`
- `metadata.nativeReplaySafe`

Non-empty assistant content is preserved on that message. The replay layer does not create synthetic tool results. Tool execution still records the actual outcome through the existing result path.

This ordering matters: native replay needs the exact assistant tool-call turn the provider produced, while tool execution still needs normal security gates and approval behavior.

---

## Replay Safety

Native replay safety is turn-level. A provider tool-call turn is either replayable as a complete native group or not replayed natively at all.

If any call contains obvious credential material, affected calls omit faithful `argumentsText` and store `argumentsRedacted: true`. The whole turn becomes `nativeReplaySafe: false`. Unsafe turns do not emit native assistant/tool protocol messages.

This avoids distorted native transcripts. A provider assistant turn with two calls is one protocol event; replaying only one call because the other was unsafe would ask the next model to reason from a conversation that never happened.

---

## Native History and Compression

Prompt assembly can select a budgeted chronological suffix of atomic native-history units. Tool groups are atomic units:

```text
agent(provider-tool-call-turn)
tool(result for call A)
tool(result for call B)
```

Selected units bypass semantic compression and can become structured provider messages. Older unselected units feed sanitized summary/compression. Complete groups are kept whole or compressed whole. Multi-call groups are never split. Active or incomplete groups are protected.

`providerReplayEcho`, raw reasoning, raw provider payloads, and runtime/session metadata are stripped before compressor input is built. The compressor should not see echo values or faithful secret-bearing arguments.

---

## Continuation

After tools run, provider continuation sends tool results back to the model.

For unsupported routes, continuation uses the existing flat `Executed tool results` text path. For supported native routes, selected tool groups are inserted as structured assistant/tool history. The final continuation instruction remains the last user message.

If a selected native `tool` message already carries a tool result, that same result is not repeated in the flat continuation block. Non-selected tool results remain in flat text so the model still receives them.

---

## Diagnostics

Native tool history diagnostics are persistent session events with names beginning `structured-tool-history-`.

They are count/reason only. A safe diagnostic may record that two native pairs were selected, one orphan was dropped, or required echo was missing. It must not record arguments, tool results, raw reasoning, echo values, provider payloads, message content, paths, hashes, request bodies, or content-derived fingerprints.

---

## Inspection and Tests

Useful files:

- `src/tools/tool-call-planner.ts`
- `src/runtime/provider-turn-loop.ts`
- `src/runtime/agent-loop.ts`
- `src/prompt/native-history-builder.ts`
- `src/prompt/semantic-compressor.ts`

Focused checks:

```bash
pnpm exec vitest run src/tools/tool-call-planner.test.ts
pnpm exec vitest run src/runtime/provider-turn-loop.test.ts
pnpm exec vitest run src/runtime/agent-loop.test.ts
pnpm exec vitest run src/prompt/native-history-builder.test.ts
pnpm exec vitest run src/prompt/semantic-compressor.test.ts
```

When debugging replay, inspect `metadata.kind`, `metadata.nativeReplaySafe`, `metadata.providerToolCalls[].id`, and tool result `metadata.tool_call_id`. If those do not line up, native replay should degrade rather than patching the transcript with guesses.
