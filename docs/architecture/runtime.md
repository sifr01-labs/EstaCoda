---
title: "Runtime Components"
description: "Breakdown of EstaCoda's runtime: AgentLoop, createRuntime, registries, and executors."
---

# Runtime Components

## AgentLoop

**File:** `src/runtime/agent-loop.ts`
**Exports:** `AgentLoop`, `AgentLoopInput`, `AgentLoopResponse`, `AgentLoopOptions`

`AgentLoop` is the orchestration lifecycle. A single `handle()` call processes one user turn end to end, but delegates execution to specialized components.

### Constructor dependencies

| Dependency | Type | Purpose |
|------------|------|---------|
| `runRecorder` | `RunRecorder` | Record run events and outcomes |
| `runtimeRouter` | `RuntimeRouter` | Route intent + skill selection |
| `toolPlanRunner` | `ToolPlanRunner` | Execute tool plans under policy |
| `providerTurnLoop` | `ProviderTurnLoop` | Stream provider responses and extract tool calls |
| `skillPlaybookRunner` | `SkillPlaybookRunner` | Execute skill playbook plans |
| `nativeToolExecutor` | `NativeToolExecutor` | Execute deterministic native intents |
| `intentRouter` | `IntentRouter` | Classify native intents |
| `securityPolicy` | `SecurityPolicy` | Policy for this session |
| `trajectoryRecorder` | `TrajectoryRecorder` | Record execution events |
| `sessionDb` | `SessionDB` | Persist session messages |
| `toolExecutor` | `ToolExecutor` | Run concrete tool actions |
| `toolCallPlanner` | `ToolCallPlanner` | Convert provider tool calls into plans |
| `providerExecutor` | `ProviderExecutor` | Execute provider requests |
| `memoryProvider` | `MemoryProvider` | Read/write memory |
| `contextReferenceExpander` | `ContextReferenceExpander` | Expand `@file:` / `@folder:` |
| `skillLearningManager` | `SkillLearningManager` | Observe and learn from workflows |
| `skillEvolutionStore` | `SkillEvolutionStore` | Store proposed skill patches |

### Internal Phases

| Phase | Delegated to | Description |
|-------|-------------|-------------|
| Input normalization | `AgentLoop` | Attachments, references, preflight |
| Intent routing | `RuntimeRouter` | Native intent + skill selection |
| Security assessment | `AgentLoop` | Policy decision, risk escalation |
| Skill playbook setup | `SkillPlaybookRunner` | Compile workflow plan, load resources |
| Prompt assembly | `AgentLoop` | Layered prompt construction |
| Provider loop | `ProviderTurnLoop` | Streaming, tool-call extraction, iteration |
| Tool execution | `ToolPlanRunner` | Plan conversion, execution, result packets |
| Native intent execution | `NativeToolExecutor` | Deterministic paths (image-gen, voice, attachments) |
| Memory curation/promotion | `AgentLoop` | Checkpoint curation and post-run preference/fact promotion |
| Artifact collection | `AgentLoop` | Gather artifacts from tool results |
| Response formatting | `AgentLoop` | Final text + progress + artifacts |

> **Status:** Provider iteration, tool execution, skill playbooks, and native intents have separate runtime components. `AgentLoop` still owns the turn boundary, prompt preparation, security gating, memory curation/promotion, artifact collection, and response shaping.

### CLI Active-Turn Control Boundary

`AgentLoop.handle()` still processes one submitted turn at a time. There is no runtime-level steering hook and no provider in-flight steering primitive in the current implementation.

CLI `/interrupt` and `/steer` are wrappers around the active `AbortSignal` supplied to `runtime.handle()` by the interactive session loop. `/interrupt` aborts the active turn and stops there. `/steer <note>` aborts the active turn, then the CLI loop schedules one retry whose input is the original submitted text plus an explicit steering note block:

```text
<original user text>

[Steering note while previous turn was interrupted]
<note>
```

`<note>` is documentation notation only. Users type free-form text after the command, for example `/steer try the safer approach instead`. Normal text typed and submitted during an active turn does not interrupt the turn; the CLI queues it as the next user turn and sends it after the current response completes.

This boundary matters for inspection and failure handling. The provider sees the retried request as a normal new turn. If the retry fails, is cancelled, or is interrupted, the CLI does not reapply the same steering note indefinitely.

---

## createRuntime

**File:** `src/runtime/create-runtime.ts`
**Exports:** `createRuntime`, `RuntimeOptions`

The composition root. Every subsystem is instantiated here with explicit constructor arguments. It constructs runtime components before passing them to `AgentLoop`.

Runtime config is loaded from exactly one selected profile: an explicit `profileId`, the active profile, or `default`. There is no user/project config merge. Workspace trust is only a behavioral gating input for local actions and MCP startup; it does not change which config file is loaded.

State ownership after the C2 profile overhaul:

- Profile config, secrets, OAuth auth, identity memory, skills, cron state, gateway state, logs, caches, and channel media live under `~/.estacoda/profiles/<id>/`.
- The session database is global at `~/.estacoda/sessions.sqlite`, with rows scoped by `profile_id`.
- Workspace trust and workspace approvals are global directory-owned state in `trust.json` and `workspace-approvals.json`.
- Global shared memory lives only under `~/.estacoda/memory/shared/`.

Trust is orthogonal to profiles: a profile selects configuration, credentials, memory, skills, cron state, and gateway state, while workspace trust gates local behavior for a directory.

Session model overrides are runtime inputs layered over the selected profile config. CLI and gateway `/model <provider>/<model>` commands are scoped to the active session/conversation by default, persist with that session, and are revalidated during runtime construction. Invalid or stale overrides are ignored non-fatally and the configured profile primary route is used. The explicit `/model --global <provider>/<model>` form mutates only the selected profile's primary route after the relevant trust and authorization checks pass. It preserves fallback routes and auxiliary routes.

### Security And Approval Wiring

`createRuntime` composes the active `SecurityPolicy` and optional `WorkspaceApprovalController`. The security policy produces deterministic `allow` / `ask` / `deny` assessments; the controller layers one-time, session, and persistent approval grants around that policy without overriding the hardline command floor.

CLI runtime and gateway runtime use the same smart approval configuration shape:

- resolved Providers Pass D assessor auxiliary route
- main route
- provider executor
- fallback metadata carried on the resolved auxiliary route
- timeout metadata carried on the resolved auxiliary route
- profile/scope key where needed

The route key is `assessor`. Runtime route construction uses `resolveAuxiliaryModelRoute("assessor", ...)`; there is no `approval` auxiliary route and no legacy provider/model smart-assessor fallback. The smart assessor uses `executeAuxiliaryTask(...)` with `tools: []` and fails safe to manual approval on missing route, timeout, provider failure, malformed output, or ambiguous output.

Gateway runtime construction receives the gateway-owned security policy and approval controller context. `ChannelGateway` remains the orchestrator for remote approval resolution and runtime-cache invalidation; adapters do not mutate approval state. Gateway global model switching writes profile config only when channel authorization, runtime workspace/profile trust, and profile config path proof are available; otherwise it returns terminal guidance and does not write.

### Delegation Runtime

`createRuntime` owns a runtime-scoped `SubagentRegistry`, `DelegationManager`, and `DefaultChildAgentLoopFactory`. Child loops are built through `AgentLoopBuilder` so the parent and child construction paths share provider registry/executor, MCP registrations, skill metadata, memory stores, process manager, browser backend, artifact store, trust store, and loaded config without restarting parent-owned MCP servers.

Child construction is still session-bound. Each child gets a fresh `SessionRuntimeContext`, `ToolRegistry`, `ToolExecutor`, `ToolCallPlanner`, `RunRecorder`, `ToolPlanRunner`, `ProviderTurnLoop`, `SkillPlaybookRunner`, `NativeToolExecutor`, `RuntimeRouter`, and `AgentLoop`. Parent session-bound services that capture session ID, such as recall and memory-file compaction, are created per built session rather than shared from the parent.

The factory creates a child session with `parentSessionId`, role/depth metadata, effective tool metadata, stripped/blocked diagnostics, suppressed runtime features, and `approvalMode: "non-interactive-fail-closed"`. Child runtime suppression defaults disable memory recall, skill learning, and session compression, with bounded project context. Child transcripts are excluded from parent recall/search and prompt packing by default.

Tool authority is resolved before provider schemas are built:

1. Start with tools visible to the parent.
2. Intersect with child candidate tools.
3. Keep only default read-only local/network risk classes unless a delegation-depth exception allows `delegate_task` for an orchestrator below `maxSpawnDepth`.
4. Strip default blocked exact names and prefixes.
5. Strip excluded toolsets: browser, media, and MCP by default.
6. Apply explicit `allowedTools` / `allowedToolsets` as further narrowing, not expansion.

The child approval policy evaluates hardline command denies first, then denies anything that would ask, consume parent approval grants, inherit pending approval queues, or depend on persisted/session approval behavior. Parent-mediated child approvals are not shipped.

`DelegationManager` records `delegation-started` / `delegation-finished` events additively, registers active children while they run, relays bounded progress events, and cleans registry state on success, cancellation, timeout, or parent abort. Batch delegation runs children through a bounded concurrency runner and preserves input order. Aggregate batch status may be `failed`, while per-child metadata preserves `timeout` and `cancelled`. Parent-visible result metadata includes structured status/reason fields, child session ids, effective child tools/toolsets, stripped/blocked diagnostics, role/depth, task index/batch id, token usage where the provider reports it, and usage-unavailable flags where it does not.

Gateway interrupt protection is runtime/session scoped. `ChannelGateway` checks the active runtime's `hasActiveSubagents(parentSessionId)` for the active turn; under interrupt busy policy, ordinary messages queue while subagents are active. `/stop`, `/approve`, `/deny`, `/status`, and existing control flows continue to bypass normal blocked-message queues.

Diagnostics for child timeout/stale heartbeat are written only under the configured profile-local diagnostics root. They store bounded task previews, hashes, effective tool names, provider/model labels, last safe event summaries, and timing metadata. Full prompt previews are disabled by default.

Delegation outcome memory is optional and disabled by default. When enabled, it records bounded delegated-task previews and deterministic status/reason summaries such as `completed`, `timeout`, or `failed: provider-error`. It does not store raw child output, prompts, transcripts, tool arguments, file contents, or diagnostic payloads.

File-state tracking records structured reads and writes performed through tracked file tools. Before delegation, the parent read set is snapshotted with a monotonic tracker cursor. If a child later writes, replaces, or deletes a file the parent had already read, the parent result receives an advisory stale-file warning. The warning is metadata only and does not change delegation status. Shell/process writes are not claimed as tracked unless they flow through the file-state tracker.

Child model overrides are supported for same-provider routes and reviewed cross-provider routes. Cross-provider child routes are derived from normalized target provider config, preserve route fields such as `baseUrl`, `apiKeyEnv`, `apiMode`, `authMethod`, `enableNetwork`, `timeoutMs`, and `staleTimeoutMs`, and disable fallback routes for the overridden child. Credentials resolve through the existing provider config and `apiKeyEnv` path; credential pools are not introduced. `authMethod: "none"` does not require credentials, and `enableNetwork: false` rejects before child execution.

`terminal.inspect` is shipped as a read-only-local inspection tool and may be visible to children only through the normal parent-visible, read-only child policy. It executes a narrow argv-only command set without a shell and keeps `terminal.run` excluded from default child schemas.

This shipped delegation path completes MVP functional parity and the full delegation capability set described for this branch, with two explicit non-shipped boundaries: parent-mediated child approvals and durable or estimated USD cost accounting. Structured token usage rollup is shipped; session-level spend accounting is deferred until there is a stable cost-accounting contract.

### Created subsystems

1. `WorkspaceTrustStore`
2. `WorkspaceApprovalController`
3. `ProviderRegistry`
4. Auxiliary model route resolver
5. `BrowserBackend` (mock or real CDP)
6. `ContextReferenceExpander`
7. `ProjectContextLoader`
8. `MemoryStore`
9. `LocalMemoryProvider`
10. `CronStore`
11. `SessionDB`
12. `ArtifactStore`
14. `ProcessManager`
15. `ToolRegistry`
16. `ToolExecutor`
17. `ToolCallPlanner`
18. `SkillRegistry`
19. `SkillLearningManager`
20. `SkillEvolutionStore`
21. `DelegationManager`
22. `ProviderExecutor`
23. `RunRecorder`
24. `ToolPlanRunner`
25. `ProviderTurnLoop`
26. `SkillPlaybookRunner`
27. `NativeToolExecutor`
28. `RuntimeRouter`
29. `AgentLoop`

> **Risk:** Any constructor signature change can cascade through this file. There is no DI container or plugin boundary.

---

## Runtime Components

### RuntimeRouter

**File:** `src/runtime/runtime-router.ts`
**Role:** Combines `IntentRouter` output with skill configuration to produce a unified routing decision. Separates routing policy from loop execution.

### ProviderTurnLoop

**File:** `src/runtime/provider-turn-loop.ts`
**Role:** Owns the provider streaming loop: send prompt, collect tokens, assemble tool-call fragments, build continuation packets, enforce iteration budgets. Previously embedded in `AgentLoop`.

#### Provider finalization invariant

The provider loop treats a provider response as usable only after finalization. Streaming may emit live visible tokens for the UI, but canonical state uses finalized data:

- executable tool calls come only from finalized `ProviderExecutionResult.toolCalls`
- tool planning and tool execution run after finalization checks
- persisted assistant messages use finalized visible content only
- prompt-bound history, summaries, memory inputs, skill learning/evolution, run-recorder learned artifacts, and exports consume visible output with reasoning stripped

This invariant exists because streamed provider output can be partial, reordered by provider protocol details, or terminated before the provider has supplied a complete finish state. Live tokens are progress. They are not permission to execute tools, write memory, or preserve internal reasoning.

Stream finalization rules are intentionally conservative:

- streamed tool-call fragments are collected locally while the stream is open
- stream errors discard accumulated tool fragments and use the existing provider failure/fallback path
- incomplete streams remain provider failures
- `[DONE]` is represented by an internal transport marker; it is not emitted as user-visible text
- visible-only transport completion can finalize with `finishReason: "unknown"`
- transport completion with unfinished tool fragments and no final finish metadata fails as `incomplete-stream`

`ProviderExecutionResult.toolCalls` is the canonical tool-call list. Length-truncated tool calls are unsafe: the first attempt never reaches tool planning, never executes tools, and must not leak discarded raw arguments into runtime events or execution records. The runtime retries once on the successful route chain. If the retry is still length-truncated with tool calls, it returns deterministic visible refusal text and executes no tools. If finalized tool JSON is malformed, that remains a tool-planning error rather than a provider failure or incomplete-stream classification.

Reasoning is handled as hidden provider-side material. Raw reasoning is turn-local only except for `providerReplayEcho`, a bounded provider-scoped replay field used for same-provider native tool-call history when a tested Chat Completions route requires `reasoning_content` echo. Safe metadata may record `present`, `chars`, and `format`; `reasoningTokens` is usage telemetry only and does not imply raw reasoning was displayed. Inline reasoning blocks and provider reasoning fields are stripped from visible output, flat provider-bound history, semantic compression, summaries, memory, skill learning/evolution, and export traces. Responses summary-shaped reasoning remains metadata-only where implemented. Provider replay echo is sensitive persisted provider protocol state, not product memory or UI text.

Reasoning-only successful provider responses reach the turn loop; they are not treated as provider failures. Non-length reasoning-only responses may retry with a local-only assistant prefill asking for a visible answer. The prefill is not persisted and is not emitted as assistant output. Length-truncated reasoning-only responses do not text-continue or prefill retry; they return deterministic visible guidance. Raw reasoning is never displayed.

Finalized visible text with `finishReason: "length"` can continue on the same successful route chain. If primary failed and a fallback produced the length-truncated text, continuation starts at that fallback and preserves later fallbacks; it does not restart at the original primary. Continuation appends local-only provider messages containing the partial visible text and the continuation instruction. Intermediate partials and synthetic messages are not persisted. The final visible text is persisted once. Concatenation trims exact suffix/prefix overlap over bounded windows; it does not use semantic or fuzzy matching. If continuation exhausts all attempts, Wave 1 returns the best visible partial without appending a runtime note.

#### Native tool-call replay

Provider-native replay sits between prompt packing and provider request serialization. It preserves finalized provider tool-call turns as native assistant/tool history for supported OpenAI-compatible Chat Completions routes, while unsupported routes keep flat text history.

The pipeline is:

1. Finalized provider tool calls are ID-normalized after Wave 1 finalization.
2. The provider tool-call turn is persisted as an `agent` session message before tool planning/execution.
3. `ToolCallPlanner` receives the exact normalized IDs that were persisted.
4. Prompt assembly selects a budgeted chronological suffix of raw session history before irreversible summarization.
5. The native history builder converts safe provider tool groups into structured provider messages.
6. The OpenAI-compatible Chat Completions serializer emits native `tool_calls` and matching `tool_call_id` replies only for complete valid groups.

Replay is all-or-nothing per provider tool-call turn. If any call is unsafe, malformed, missing faithful arguments, missing required echo, or oversized for required echo, the turn does not emit native assistant/tool messages. Flat fallback and sanitized summaries remain available.

Tool groups are atomic throughout packing and compression. A group is the provider tool-call turn plus immediately following matching tool result messages. Complete groups are kept whole or compressed whole. Multi-call turns are never split. Active or incomplete groups are protected from compression. `providerReplayEcho` is removed before compressor input is constructed.

Continuation prompts reuse the same native selector and builder path when route gates pass. The final continuation instruction remains the last user message. Tool results already included as selected native `tool` messages are not duplicated in the flat continuation results block; non-selected tool results still appear there.

Native replay diagnostics are persistent session events, not runtime live events. They use the `structured-tool-history-*` event family and contain only counts and coarse reasons. They are meant to answer "why did native replay happen or not happen?" without copying prompt material into observability.

Inspection surfaces:

- runtime `provider-result` events report provider/model, success, fallback status, finish reason, incomplete reason, usage, and safe reasoning metadata
- session `provider-completion` and `provider-continuation` events record attempts plus safe runtime metadata for reasoning, truncation, and continuation
- session `structured-tool-history-*` events record native replay selection, repair, skip, and serialization counts
- `estacoda trace dump <trajectory-id> --raw` can inspect trajectory-level event flow, but raw provider reasoning and discarded tool arguments should not appear there
- focused tests live in `src/providers/provider-executor-fallback.test.ts`, `src/providers/provider-executor-route.test.ts`, `src/providers/openai-compatible-provider.test.ts`, `src/runtime/provider-turn-loop.test.ts`, and `src/runtime/agent-loop.test.ts`

Operational failure modes to check before changing this area:

- `incomplete-stream` should fail or fall back, not become a successful assistant answer
- partial streamed tool fragments should not appear as finalized tool calls
- discarded truncated tool arguments should not appear in runtime events, session events, session messages, or traces
- synthetic reasoning-prefill and text-continuation messages should not persist as session-visible messages
- summaries, memory files, skill records, and export traces should contain visible content only
- native replay should degrade to flat fallback for unsupported routes, Responses routes, Anthropic routes, unsafe arguments, and missing required echo
- `providerReplayEcho` should appear only in provider-tool-call-turn metadata and matching structured provider messages, never in summaries, diagnostics, memory, logs, or flat prompt text

### ToolPlanRunner

**File:** `src/runtime/tool-plan-runner.ts`
**Role:** Converts provider tool calls into executable plans, manages safe-tool concurrency, handles failure caps, and builds result packets for continuation. Previously embedded in `AgentLoop`.

### SkillPlaybookRunner

**File:** `src/runtime/skill-playbook-runner.ts`
**Role:** Executes skill playbook plans (deterministic and provider-backed), loads skill resources, and manages workflow state transitions. Previously embedded in `AgentLoop`.

### NativeToolExecutor

**File:** `src/runtime/native-tool-executor.ts`
**Role:** Executes deterministic native intents (image generation, voice transcription, attachment analysis) without provider involvement. Keeps product-owned paths separate from general tool execution.

### RunRecorder

**File:** `src/runtime/run-recorder.ts`
**Role:** Records run events, tool calls, outcomes, and artifacts to the session DB. Provides structured run history for trace inspection and Agent Evolution evidence.

---

## Registries

### ToolRegistry

**File:** `src/tools/tool-registry.ts`
**Role:** Register and resolve tool definitions. Built-in tools are registered at load time. MCP-discovered tools are registered at runtime creation.

### SkillRegistry

**File:** `src/skills/skill-registry.ts`
**Role:** Hold loaded skills, filter visibility, and serve skill instructions to the agent loop.

### ProviderRegistry

**File:** `src/providers/provider-registry.ts`
**Role:** Register provider adapters and resolve routes by capability.

---

## Executors

### ProviderExecutor

**File:** `src/providers/provider-executor.ts`
**Role:** Streaming execution, token collection, tool-call fragment assembly, fallback handling, and direct `apiKeyEnv` credential resolution.

### ToolExecutor

**File:** `src/tools/tool-executor.ts`
**Role:** Execute tool calls, manage concurrency, record executions, apply risk gating.

---

## Supporting Components

| Component | File | Role |
|-----------|------|------|
| PromptCache | `src/prompt/prompt-cache.ts` | Cache assembled prompt layers |
| HistoryPacker | `src/prompt/history-packer.ts` | Pack session history within budget |
| ContextReferenceExpander | `src/context/context-reference-expander.ts` | Expand `@file:` / `@folder:` |
| ProjectContextLoader | `src/context/project-context-loader.ts` | Load project context files |
| TrajectoryRecorder | `src/trajectory/trajectory-recorder.ts` | Record active-session trajectory events before persistence through the session DB |
| ArtifactStore | `src/artifacts/artifact-store.ts` | Store prompt-safe artifact references in memory |
