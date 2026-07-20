---
title: Runtime
description: Runtime creation, provider resolution, execution boundaries, gateway caching, disposal, and startup failure modes.
sidebar_position: 2
---

# Runtime

The EstaCoda runtime is the execution environment that owns session execution. It loads one selected profile, builds shared runtime substrate, assembles session-bound components, executes provider and tool work under policy, and persists the resulting state.

This page explains how runtime creation works, what is reused, what is rebuilt per session, and where failures usually happen.

---

## What the runtime is

A runtime combines shared substrate with session-bound execution components.

| Area | Examples |
|---|---|
| Profile state | Config, credentials, memory files, skills, gateway state |
| Provider substrate | Provider registry, provider executor, primary route, fallback routes, auxiliary routes |
| Tool substrate | Built-in tool providers, MCP-discovered tools, process manager, browser backend |
| Memory substrate | Memory store, memory provider, memory index, retrieval service, prompt context builder |
| Session-bound components | Tool registry, tool executor, tool planner, provider turn loop, runtime router, agent loop |
| Persistence | Session DB, artifacts, trajectory, cron, workflow state where available |
| Policy | Security mode, trust store, approval control, child fail-closed policy |

Runtime config loads from exactly one selected profile. Workspace trust gates local action behavior and may affect trusted runtime capabilities such as MCP startup, but it does not change which profile config is loaded.

---

## Profile selection

Runtime config loads from one profile, in this order:

1. Explicit `profileId` passed to the command
2. Active profile if no explicit profile ID is given
3. `default` if no active profile is set

There is no user/project config merge. Profile state lives under:

```text
~/.estacoda/profiles/<id>/
```

Sessions are scoped by `profile_id` in the session database. `createRuntime()` rejects an existing session if that session belongs to a different profile than the runtime being created.

See [Architecture](./architecture.md) for the full state boundary map.

---

## Runtime construction

Runtime construction has three practical phases.

### Phase A: shared substrate

`createRuntime()` builds the shared substrate for the selected profile and session.

It creates or resolves:

| Substrate | Examples |
|---|---|
| State paths | Global state home, profile state home, workspace root |
| Stores | Memory store, artifact store, cron store, session DB |
| Memory infrastructure | Memory index store, memory index sync, local memory retrieval, memory prompt context |
| Provider infrastructure | Provider registry, provider executor, primary route, fallback routes, auxiliary routes |
| Skill infrastructure | Official skills, profile skills, pack-materialized skills, skill evolution stores |
| MCP infrastructure | Configured MCP servers and discovered MCP tools, gated by trusted runtime capability state |
| Process and media state | Process manager, channel media root, audio cache, image cache |
| Browser infrastructure | Browser backend, supervised local CDP lifecycle, emergency cleanup |
| Voice infrastructure | Local Whisper worker when configured |
| Prompt infrastructure | Project context loader, context reference expander, session compression service |
| Delegation substrate | Durable Task store/service, parent routes, shared provider/tool substrate |
| Trajectory | `TrajectoryRecorder` for the active session |

Approval control is injected into runtime creation and used by runtime methods that grant, inspect, or revoke approvals.

### Phase B: session-bound components

`AgentLoopBuilder.buildSession()` assembles the session-bound execution components.

It creates:

| Component | Role |
|---|---|
| `ToolRegistry` | Session-visible tool registry |
| `ToolExecutor` | Executes tool actions under security policy |
| `ToolCallPlanner` | Maps provider tool calls to executable tool plans |
| `RunRecorder` | Records turn/tool/session events and trajectory data |
| `MemoryRecallOrchestrator` | Prepares per-turn recall context |
| `ToolPlanRunner` | Runs planned tools, handles concurrency, failure caps, and continuation packets |
| `ProviderTurnLoop` | Runs provider iterations and finalizes provider output |
| `SkillPlaybookRunner` | Executes skill playbook tool steps |
| `NativeToolExecutor` | Executes native runtime intents |
| `IntentRouter` | Routes user intent to runtime paths and skills |
| `RuntimeRouter` | Selects native, skill, or provider-backed execution |
| `AgentLoop` | Coordinates the turn boundary and persistence |

Tool registration happens in phases so tools receive the right runtime and session context:

1. `pre-skill-visibility`
2. `post-skill-visibility`
3. `post-memory-provider`
4. `post-tool-executor`

MCP-discovered tools are added to the session-visible tool registry during session construction, alongside built-in tool registration phases.

### Phase C: durable Task foundation

`SQLiteSessionDB` installs the profile-owned Task schema and `SQLiteTaskStore` provides transactional graph storage. SQLite runtimes also create a profile-local `TaskResultService`: result bodies remain outside SQLite, carry verified hashes and opaque handles, and are available to linked sessions through bounded `task.result.read` pages. Binary results are never injected through that text tool. `createRuntime()` now exposes a production `AgentStepExecutor` for profile-backed SQLite runtimes. The executor rechecks profile, exact workspace binding and trust, narrows the child to read-only capabilities, checkpoints worker ownership under the Attempt fence, captures complete results, and accounts for every provider attempt.

The profile gateway supervisor runs the deterministic scheduler beside cron, including startup lease reconciliation, disconnect/restart survival, and graceful drain. It creates the full Task executor runtime only when runnable work exists. Terminal completion is sent through a session-linked delivery outbox; ambiguous in-flight external sends are marked failed after restart instead of being retried and duplicated. Status surfaces show bounded Task host/count information. `delegate_task`, `estacoda task`, and `/task` create or control fixed durable Task graphs, while `task.status` and `task.result.read` expose bounded authorized reads. The retired Workflow engine and command surface are removed rather than initialized as a compatibility store.

---

## Provider route resolution

The runtime resolves three kinds of provider routes.

### Primary route

The primary route comes from `model` in profile config. It is used for normal inference.

If the primary route is not runnable because credentials are missing, the model is stale, or the provider fails, EstaCoda reports the failure. It does not silently fall back unless fallback routes are configured.

### Fallback routes

Fallback routes come from `model.fallbacks`. They are tried only when the primary route fails at execution time.

Fallbacks preserve route metadata such as:

| Metadata | Use |
|---|---|
| `apiKeyEnv` | Credential environment variable |
| `baseUrl` | Provider endpoint |
| `apiMode` | Adapter mode, such as OpenAI-compatible or OpenAI Responses |
| `authMethod` | Credential/auth mode |

If all fallback routes fail, the turn reports the error and stops.

### Auxiliary routes

Auxiliary routes are specialized model routes configured under `auxiliaryModels`. They use the same provider registry and executor path as primary routes.

| Slot | Purpose |
|---|---|
| `vision` | Image analysis |
| `compression` | Semantic session compression |
| `assessor` | Smart approval classification |
| `web_extract` | Web extraction |
| `session_search` | Semantic session search |
| `mcp` | MCP tool delegation |
| `memory_flush` | Memory operations |
| `delegation` | Subagent delegation |
| `skills_library` | Skills distribution |
| `title_generation` | Session title generation |
| `curator` | Memory curation |
| `memory_compaction` | Memory file compaction |
| `profile_context` | Profile context generation |

Unsupported auxiliary task names fail during config normalization.

---

## Provider execution boundary

`ProviderTurnLoop` treats provider output as usable only after finalization. Streaming can emit live visible tokens, but these surfaces use finalized visible output only:

| Surface | Uses finalized output |
|---|---|
| Executable tool calls | Yes |
| Persisted assistant content | Yes |
| Provider-bound history | Yes |
| Summaries and compression | Yes |
| Memory inputs | Yes |
| Skill learning | Yes |
| Exports | Yes |

Stream safety rules:

- Streamed tool-call fragments are collected while the stream is open.
- Stream errors discard collected fragments.
- Incomplete streams remain provider failures.
- `[DONE]` is an internal transport marker, not user-visible output.
- Visible-only transport completion may finalize as `finishReason: "unknown"`.
- Transport completion with unfinished tool fragments fails as `incomplete-stream`.
- OpenAI-compatible chat completions support streaming.
- OpenAI Responses execution is implemented. Responses streaming is not part of the current supported runtime baseline.

`ProviderExecutionResult.toolCalls` is canonical. Length-truncated tool calls retry once on the successful route chain. If the retry is still length-truncated, the runtime returns deterministic refusal text and executes no tools.

Reasoning is hidden material. Raw reasoning is turn-local only. Visible output, provider-bound history, semantic compression, summaries, memory, skill learning, and exports strip raw reasoning and inline hidden reasoning blocks.

Visible text with `finishReason: "length"` can continue on the successful route chain. Synthetic continuation messages are local-only. Intermediate partials are not persisted. Final visible text is persisted once. Continuation uses exact overlap trimming.

---

## Tool boundary

The provider does not know how to execute tools. The tool executor does not know how to call providers. The agent loop bridges the two.

| Component | Responsibility |
|---|---|
| Provider | Returns visible text and finalized tool calls |
| `ToolCallPlanner` | Resolves provider tool calls to known tool definitions |
| `ToolExecutor` | Executes concrete tool actions under policy |
| `ToolPlanRunner` | Runs tool plans and builds continuation packets |
| `ProviderTurnLoop` | Feeds tool results back to the provider when needed |
| `AgentLoop` | Coordinates the overall turn boundary |

Tool risk classes drive gating:

| Risk class | Meaning |
|---|---|
| `safe` | Low-risk read or local computation |
| `caution` | Needs care or may expose local state |
| `external-side-effect` | Can affect external systems |
| `irreversible` | Can make hard-to-reverse changes |

The security policy gates on normalized `targetKey`, not display summary.

---

## CLI runtime lifecycle

In CLI interactive mode, the runtime persists across turns in the active session. This avoids rebuilding the full runtime after every message and keeps session-bound state available in memory.

A CLI runtime is disposed when the session exits or the process shuts down. Disposal stops runtime-owned resources such as MCP servers, browser lifecycle resources, local Whisper workers, memory index sync, and session DB connections when the runtime owns them.

---

## Gateway runtime lifecycle

Gateway mode uses `RuntimeCache`.

A gateway runtime is not created fresh for every incoming turn. The gateway asks the cache for a runtime keyed by `sessionId` and the current runtime fingerprint.

| Cache case | Behavior |
|---|---|
| No entry | Create runtime |
| Cache hit | Reuse runtime |
| Fingerprint mismatch | Create replacement runtime and retire the old entry |
| Suspended entry | Create replacement runtime |
| Explicit invalidation | Suspend and replace on next use |
| Idle TTL exceeded | Dispose idle runtime |
| LRU cap exceeded | Dispose least-recent idle runtimes |

Current implementation defaults:

| Setting | Default |
|---|---|
| Max cached runtimes | `50` |
| Idle TTL | `30 minutes` |
| Dispose timeout | `10 seconds` |

These are implementation defaults, not public API guarantees. Inspect `RuntimeCache` for current values.

The gateway invalidates cached runtimes when policy-affecting state changes, such as persistent approval grant/revoke or session model override changes.

Runtime cache entries are keyed by `sessionId`. Session rows are scoped by `profile_id`, and `createRuntime()` rejects profile/session mismatches. Runtime cache documentation should still treat session identity as a sensitive boundary.

---

## Delegation runtime

`AgentLoopBuilder` receives an optional `DurableDelegationService`. The service is installed only for profile-bound SQLite Task runtimes, so `delegate_task` is omitted rather than falling back to an in-memory execution owner.

The tool adapter validates and normalizes single or batch input, requires the stable provider tool-call ID, and asks the service to create a fixed Task graph. The service derives exact Step tool authority from the current filtered registry, persists the provider-call idempotency key, and returns without constructing a worker session.

When the call originates inside a running orchestrator Attempt, the child Task records `parentTaskId` and `parentAttemptId`. Parent Attempt activity, creator worker identity, workspace equality, authority monotonicity, budget monotonicity, and graph persistence are checked in one SQLite transaction.

`DefaultChildAgentLoopFactory` remains the isolated worker constructor used by `AgentStepExecutor` after the scheduler leases a Step. It no longer creates a delegation manager. `SubagentRegistry` describes currently running Attempts for operator visibility; it is not Task ownership or authorization state.

## Memory prompt assembly

Per-turn memory context is prepared before provider prompt assembly. `MemoryRecallOrchestrator` gathers recall context, and `MemoryPromptContextBuilder` renders the canonical memory prompt context.

The prompt assembly pipeline includes:

1. Canonical memory prompt context
2. Project context, including `AGENTS.md`
3. Optional compaction notice
4. Session history
5. Optional session recall and external recall
6. Live user message
7. Channel attachments
8. Intent, skill instructions, skill setup, and skill resources
9. Workflow plan
10. Tool menu
11. Explicit reference context
12. Tool results or continuation feedback

Recall, external recall, and compression summaries are reference-only context. They are included for continuity but are not treated as authoritative instructions.

Provider-turn semantic compression is owned by `AgentLoop`, not `ProviderTurnLoop`. When enabled and over threshold, `AgentLoop` preserves the parent transcript by compacting into a child session before provider prompt assembly.

---

## Runtime disposal

Runtime disposal is responsible for cleaning up resources owned by the runtime.

Disposal includes:

| Resource | Cleanup |
|---|---|
| Browser lifecycle | Stop lifecycle, cleanup sessions, close owned backend |
| Local Whisper | Dispose worker when present |
| MCP servers | Stop loaded MCP servers |
| Memory index sync | Dispose sync worker |
| Session DB | Close when runtime owns the connection |

Gateway cached runtimes are disposed through `RuntimeCache.safeDispose()`, which applies a timeout so stuck disposal does not block cache cleanup forever.

---

## Runtime startup failures

| Failure | What happens | First inspection command |
|---|---|---|
| Missing profile config | Runtime creation fails early | `estacoda verify` |
| Profile/session mismatch | Runtime creation rejects the session | `estacoda sessions list` |
| Non-runnable primary route | Turn reports provider/model failure | `estacoda model diagnose` |
| Missing auxiliary route | Calling subsystem falls back where supported | `estacoda model show` |
| MCP server unreachable | MCP tools are not registered; runtime continues | `estacoda gateway diagnose` |
| Browser backend unavailable | Browser tools report connection errors | `estacoda doctor` |
| SQLite lock or corruption | Session or Task persistence operations fail | Check `~/.estacoda/sessions.sqlite` permissions |

---

## How to inspect runtime state

```bash
# Current primary route and readiness
estacoda model show

# Live diagnostic against configured provider
estacoda model diagnose

# List catalog-known providers
estacoda model list

# Full setup readiness
estacoda verify

# General diagnosis
estacoda doctor

# Gateway readiness
estacoda gateway diagnose

# Full gateway status, including runtime cache state when available
estacoda gateway status

# Recent sessions
estacoda sessions list

# Current session
estacoda sessions current

# Code dependency graph
estacoda knowledge code summary
estacoda knowledge code refresh
```

---

## Related

- [Architecture](./architecture.md) - system structure and state boundaries
- [Provider Reference](../reference/provider-reference.md) - provider maturity matrix
- [Providers](../user-guide/providers.md) - user-facing provider setup
- [Tools](../user-guide/tools.md) - tool overview
- [Gateway Internals](./gateway-internals.md) - gateway routing, approvals, and channel behavior
