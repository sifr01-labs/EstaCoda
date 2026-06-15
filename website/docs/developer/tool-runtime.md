---
title: Tool runtime
description: Tool registration, planning, execution, result persistence, and replay-safe history boundaries.
sidebar_position: 4
---

# Tool runtime

The tool runtime is the boundary between provider output and local action. It registers available tools, converts finalized provider tool calls into plans, applies security policy, executes approved tools, packetizes results, and records enough structure for safe continuation and replay-safe history.

This page focuses on runtime behavior. The user-facing tool list lives in [Tools](../user-guide/tools.md).

---

## What this page covers

Use this page when you need to inspect:

- which tools were registered for a runtime
- how provider tool calls become executable plans
- why a tool was allowed, denied, blocked, or deferred
- how malformed or unknown tool calls fail
- how tool-call IDs are normalized
- how safe tools can run concurrently
- how tool results are packetized and persisted
- how tool results line up with provider-native history

This page is not a catalog of every available tool. It explains the execution path that provider-requested tools pass through.

---

## Runtime composition

Tools are assembled during runtime construction. `AgentLoopBuilder` creates the tool registry and layers registration phases around runtime setup.

The important composition pieces are:

| Surface | Role |
|---|---|
| `ToolRegistry` | Holds registered tool definitions. |
| `ToolExecutor` | Applies policy and executes an approved registered tool. |
| `ToolCallPlanner` | Converts finalized provider tool calls into executable plans. |
| `ToolPlanRunner` | Runs planned provider tool calls, emits activity events, handles safe concurrency, and returns execution state. |
| `NativeToolExecutor` | Executes deterministic native-intent tools selected by the runtime router. |

Registration is phased so the runtime can register base tools, apply skill visibility, attach memory/provider-dependent tools, and finish executor wiring without every subsystem owning the whole registry.

---

## Registration phases

Tool providers are registered in named phases:

| Phase | Purpose |
|---|---|
| `pre-skill-visibility` | Registers base tools before skill visibility is calculated. |
| `post-skill-visibility` | Registers tools that depend on the visible session skill set. |
| `post-memory-provider` | Registers tools that depend on memory provider wiring. |
| `post-tool-executor` | Registers tools that need the executor or delegation manager. |

MCP tools are registered before the planned tool-registration phases. After registration, the runtime snapshots available tools and builds the provider tool schemas that can be exposed to the model.

---

## Execution flow

Provider-requested tool execution starts only after provider finalization:

1. The provider returns finalized tool calls.
2. Missing tool-call IDs are normalized once.
3. `ToolCallPlanner` converts each call into a tool plan.
4. `ToolPlanRunner` groups planned provider tool calls.
5. `ToolExecutor` applies security policy, approval state, workspace trust, and command safety.
6. Allowed tools invoke the registered tool handler.
7. The result packet is persisted and sent back through continuation.

Streaming fragments, incomplete streams, malformed JSON, and length-truncated tool calls do not bypass this path. If a tool call is not finalized, it is not executable.

---

## Planning and policy

`ToolCallPlanner` is the first structured boundary after provider finalization. It validates the provider call, resolves the registered tool, parses arguments, and produces a plan the runtime can execute or reject.

Tool plans carry the tool name, parsed arguments, source, status, and later result or error state. Risk class, toolsets, and the security decision come from the registered tool definition and execution record.

Risk classes are explicit runtime values, including:

- `read-only-local`
- `read-only-network`
- `workspace-write`
- `external-side-effect`
- `credential-access`
- `destructive-local`
- `shared-state-mutation`
- `spend-money`
- `sandbox-escape`

These are the runtime policy classes used by tool execution. Higher-level docs may group them into broader user-facing labels.

Security policy, approval state, workspace trust, command safety, and runtime approval mode decide whether execution may proceed. High-risk or blocked tools must fail closed rather than quietly downgrade into execution.

---

## Planning failures

A provider tool call can fail before execution if the tool name is unknown, arguments are malformed, required arguments are missing, schema validation fails, or policy blocks the resolved tool.

Planning failures are reported back through the provider turn loop as tool-result state where appropriate. They are not executed, and they do not bypass policy by falling back to shell, native intent execution, or another tool path.

---

## Tool plan runner

`ToolPlanRunner` owns execution of provider-requested tool plans for a provider turn.

It is responsible for:

- planning provider tool calls through `ToolCallPlanner`
- emitting tool activity events
- grouping safe provider tools for bounded concurrent execution
- calling `ToolExecutor` for approved tools
- packetizing tool execution output
- tracking observed risk
- returning tool results and failure state to the provider turn loop

Repeated tool-failure budgets are enforced by `ProviderTurnLoop`, using the outcomes returned from tool execution. The runner reports what happened; the provider loop decides whether repeated failures have exceeded the turn budget.

---

## Safe-tool concurrency

Some provider-requested tools can run concurrently. Concurrency is intentionally narrow.

Safe concurrent grouping is limited to read-only risk classes:

- `read-only-local`
- `read-only-network`

The runtime still excludes tools that should remain serialized even if they look read-only by risk class. Command/process-style tools are not batched into the safe concurrent group.

The maximum safe concurrency is configured by the runtime builder. This keeps low-risk inspection work from becoming a serial bottleneck without letting side-effecting tools race each other.

---

## Native tool executor

`NativeToolExecutor` is separate from provider-requested tool calls.

It handles deterministic native-intent execution selected by the runtime router. The current native intent path is not a general replacement for provider tool calls, slash commands, or tool planning. Provider-generated tool calls still go through finalization, planning, policy, execution, and continuation.

Keep this distinction clear:

| Path | Source | Runtime surface |
|---|---|---|
| Provider tool call | Finalized provider response | `ToolCallPlanner` and `ToolPlanRunner` |
| Native intent | Runtime router decision | `NativeToolExecutor` |
| Slash command | CLI/session command handling | Session command surfaces |

These paths may use some of the same registered tools, but they are not the same control flow.

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

## Provider tool-call persistence

When finalized tool calls exist, the runtime persists one provider tool-call turn before tool execution. The session message has:

- `role: "agent"`
- `metadata.kind: "provider-tool-call-turn"`
- `metadata.providerToolCalls`
- `metadata.nativeReplaySafe`

Non-empty assistant content is preserved on that message. The replay layer does not create synthetic tool results. Tool execution still records the actual outcome through the existing result path.

This ordering matters: native replay needs the exact assistant tool-call turn the provider produced, while tool execution still needs normal security gates and approval behavior.

---

## Replay-safe history

Native replay safety is turn-level because tool results must match the assistant tool-call group exactly. If one call in a multi-call provider turn is unsafe, the whole native group is unsafe.

Tool groups are atomic native-history units:

```text
agent(provider-tool-call-turn)
tool(result for call A)
tool(result for call B)
```

Complete groups are kept whole or compressed whole. Multi-call groups are not split. Active, incomplete, or unsafe groups are not serialized as native history.

See [Provider runtime](./provider-runtime.md) for provider echo, serializer rules, compression boundaries, and native replay diagnostics.

---

## Continuation

After tools run, provider continuation sends tool results back to the model.

For unsupported routes, continuation uses the existing flat `Executed tool results` text path. For supported native routes, selected tool groups are inserted as structured assistant/tool history. The final continuation instruction remains the last user message.

If a selected native `tool` message already carries a tool result, that same result is not repeated in the flat continuation block. Non-selected tool results remain in flat text so the model still receives them.

Continuation is still bounded by provider-turn budgets. Repeated tool failures, too many tool calls, too many provider iterations, or wall-clock exhaustion can stop the loop before another provider attempt is made.

---

## Diagnostics

Native tool history diagnostics are persistent session events with names beginning `structured-tool-history-`.

They are count/reason only. A safe diagnostic may record that two native pairs were selected, one orphan was dropped, or required echo was missing. It must not record arguments, tool results, raw reasoning, echo values, provider payloads, message content, paths, hashes, request bodies, or content-derived fingerprints.

Tool activity events are separate from native replay diagnostics. They describe execution lifecycle, not replay eligibility.

---

## Inspection and tests

Useful files:

- `src/runtime/agent-loop-builder.ts`
- `src/runtime/tool-plan-runner.ts`
- `src/runtime/native-tool-executor.ts`
- `src/runtime/provider-turn-loop.ts`
- `src/tools/tool-call-planner.ts`
- `src/tools/tool-executor.ts`
- `src/contracts/tool.ts`
- `src/prompt/native-history-builder.ts`
- `src/prompt/native-history-selector.ts`
- `src/prompt/semantic-compressor.ts`

Focused checks include tool planning, tool schema policy, runtime tool activity events, provider turn-loop behavior, agent loop wiring, native history building/selection, and semantic compression.

```bash
pnpm exec vitest run src/tools/tool-call-planner.test.ts
pnpm exec vitest run src/tools/tool-schema.test.ts
pnpm exec vitest run src/runtime/tool-activity-events.test.ts
pnpm exec vitest run src/runtime/provider-turn-loop.test.ts
pnpm exec vitest run src/runtime/agent-loop.test.ts
pnpm exec vitest run src/runtime/agent-loop-builder.test.ts
pnpm exec vitest run src/prompt/native-history-builder.test.ts
pnpm exec vitest run src/prompt/native-history-selector.test.ts
pnpm exec vitest run src/prompt/semantic-compressor.test.ts
```

When debugging replay, inspect `metadata.kind`, `metadata.nativeReplaySafe`, `metadata.providerToolCalls[].id`, and tool result `metadata.tool_call_id`. If those do not line up, native replay should degrade rather than patching the transcript with guesses.
