---
title: Runtime
description: Runtime creation, provider resolution, tool execution boundaries, and startup failure modes.
sidebar_position: 2
---

# Runtime

The EstaCoda runtime is the execution environment for a single session turn. It is created fresh for each turn in gateway mode and persisted across turns in CLI interactive mode. Everything the runtime needs — config, credentials, skills, memory, tools — is loaded at construction time from a single selected profile.

This page explains how the runtime is created, what it resolves, and where it can fail.

---

## What the Runtime Is

A runtime is a collection of initialized subsystems that cooperate to process one user turn:

- One selected profile config
- One provider registry with resolved primary and auxiliary routes
- One tool registry with built-in and MCP-discovered tools
- One skill registry with visible skills for this session
- One security policy and approval controller
- One session database connection
- One memory store and provider
- One agent loop that coordinates them all

The runtime is not shared across profiles. Switching profiles means creating a new runtime with different config, credentials, and memory.

---

## Profile Selection

Runtime config loads from exactly one selected profile:

- Explicit `profileId` passed to the command
- The active profile if no explicit ID is given
- `default` if no active profile is set

There is no user/project config merge. Workspace trust is a behavioral gating input for local actions and MCP startup; it does not change which config file is loaded.

Profile state lives under `~/.estacoda/profiles/<id>/`. See [Architecture](./architecture.md) for the full state boundary map.

---

## Runtime Construction

`createRuntime()` constructs subsystems in a fixed order:

1. **Trust and approval stores** — `WorkspaceTrustStore`, `WorkspaceApprovalController`
2. **Provider infrastructure** — `ProviderRegistry`, auxiliary model route resolver
3. **Browser backend** — mock or real CDP
4. **Context expander and project loader** — `ContextReferenceExpander`, `ProjectContextLoader`
5. **Memory** — `MemoryStore`, `LocalMemoryProvider`
6. **Persistence** — `CronStore`, `SessionDB`, `ArtifactStore`
7. **Process manager**
8. **Tool infrastructure** — `ToolRegistry`, `ToolExecutor`, `ToolCallPlanner`
9. **Skill infrastructure** — `SkillRegistry`, `SkillLearningManager`, `SkillEvolutionStore`
10. **Delegation manager**
11. **Provider executor**
12. **Extracted runtime components** — `RunRecorder`, `ToolPlanRunner`, `ProviderTurnLoop`, `SkillWorkflowExecutor`, `NativeToolExecutor`, `RuntimeRouter`
13. **AgentLoop** — the orchestration lifecycle

Any constructor signature change cascades through this file. There is no DI container or plugin boundary.

---

## Provider Route Resolution

The runtime resolves three kinds of provider routes:

### Primary Route

Defined under `model` in profile config. Used for normal inference. If the primary route is non-runnable — missing credentials, stale model name, or provider failure — EstaCoda reports the failure. It does not silently fall back unless explicit fallback routes are configured.

### Fallback Routes

Ordered list under `model.fallbacks`. Tried only when the primary route fails at execution time. Fallbacks preserve `apiKeyEnv`, `baseUrl`, `apiMode`, and `authMethod` when available. If all fallbacks fail, the turn reports the error and stops.

### Auxiliary Routes

Specialized routes for tasks like vision, compression, security assessment, web extraction, and session search. Configured under `auxiliaryModels`. They resolve through the same provider infrastructure as the primary route.

| Slot | Purpose | Maturity |
|---|---|---|
| `vision` | Image analysis | `implemented` |
| `compression` | Semantic session compression | `experimental` |
| `assessor` | Smart approval classification | `implemented` |
| `web_extract` | Web extraction | `implemented` |
| `session_search` | Semantic session search | `implemented` |
| `mcp` | MCP tool delegation | `implemented` |
| `memory_flush` | Memory operations | `implemented` |
| `delegation` | Subagent delegation | `implemented` |
| `skills_library` | Skills distribution | `implemented` |
| `title_generation` | Session title generation | `implemented` |
| `curator` | Memory curation | `implemented` |
| `memory_compaction` | Memory file compaction | `implemented` |
| `profile_context` | Profile context generation | `implemented` |

Unsupported auxiliary task names throw during config normalization.

---

## Tool Registry and Execution Boundary

`ToolRegistry` registers built-in tools at module load time and MCP-discovered tools at runtime creation. `ToolExecutor` runs concrete tool actions under the active security policy.

**Boundary rule:** The provider does not know about tools. The tool executor does not know about providers. Only the agent loop bridges them.

`ToolPlanRunner` converts provider tool calls into executable plans, manages safe-tool concurrency, handles failure caps, and builds result packets for continuation. Previously embedded in `AgentLoop`; now an extracted component.

Tool risk classes: `safe`, `caution`, `external-side-effect`, `irreversible`. The security policy gates on `targetKey`, not display summary.

---

## Gateway, Session, and Runtime Cache Boundaries

### Gateway Mode

In gateway mode, a fresh runtime is constructed for each incoming turn. This ensures:

- Config changes take effect immediately
- Session-scoped model overrides are revalidated
- Runtime caches do not leak between users

The tradeoff is construction overhead. Gateway runtime creation is optimized but not free.

### CLI Mode

In CLI interactive mode, the runtime persists across turns within a session. This reduces construction overhead and maintains session state in memory.

### Session Database

Sessions are stored in `~/.estacoda/sessions.sqlite`, scoped by `profile_id`. The session DB outlives any single runtime instance. Channel session context is persisted under the bound profile gateway state.

### Runtime Cache

Prompt cache layers (identity, safety, project context, skill resources) are rebuilt only when underlying data changes. Session history and live user context are rebuilt every turn.

---

## Memory Prompt Assembly

Per-turn memory context is prepared by `MemoryRecallOrchestrator` and rendered by `MemoryPromptContextBuilder`. The prompt assembly pipeline includes:

1. Canonical memory prompt context
2. Project context (including `AGENTS.md`)
3. Optional compaction notice
4. Session history
5. Optional session recall and external recall
6. Live user message
7. Channel attachments
8. Intent, skill instructions, skill setup, skill resources
9. Workflow plan
10. Tool menu
11. Explicit reference context
12. Tool results / continuation feedback

Recall, external recall, and compression summaries are reference-only context. They are included for continuity but are not treated as authoritative instructions.

Provider-turn semantic compression is owned by `AgentLoop`, not `ProviderTurnLoop`. When enabled and over threshold, `AgentLoop` preserves the parent transcript by compacting into a child session before provider prompt assembly.

---

## Runtime Startup Failures

**Missing profile config:** `createRuntime` fails early if the selected profile directory or `config.json` does not exist. The CLI reports the missing profile and suggests `estacoda profile switch` or setup.

**Non-runnable primary route:** Missing API key, invalid model name, or provider failure. `estacoda model diagnose` reports the exact failure. `estacoda model setup` repairs the route.

**Missing auxiliary route:** Missing or malformed auxiliary route config. The calling subsystem falls back as documented (e.g., manual approval if `assessor` fails).

**MCP server unreachable:** MCP tools are not registered. The runtime continues without MCP tools. Check `estacoda gateway diagnose` for MCP readiness.

**Browser backend unavailable:** If `browser.backend` is `local-cdp` and Chrome is not running on the configured `cdpUrl`, browser operations report connection errors. Enable `autoLaunch` or start Chrome manually.

**SQLite lock or corruption:** Session operations fail. `better-sqlite3` uses synchronous SQLite semantics. Check file permissions on `~/.estacoda/sessions.sqlite`.

---

## How to Inspect Runtime State

```bash
# Current primary route and readiness
estacoda model show

# Live diagnostic against configured provider
estacoda model diagnose

# List catalog-known providers
estacoda model list

# Gateway readiness (includes MCP, channels, cron)
estacoda gateway diagnose

# Full gateway status
estacoda gateway status

# Recent sessions
estacoda sessions list

# Current session
estacoda sessions current
```

---

## Related

- [Architecture](./architecture.md) — system structure and state boundaries
- [Provider Reference](../reference/provider-reference.md) — provider maturity matrix
- [Providers](../user-guide/providers.md) — user-facing provider setup
- [Tools](../user-guide/tools.md) — tool overview
