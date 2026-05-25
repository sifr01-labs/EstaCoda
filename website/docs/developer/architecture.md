---
title: Architecture
description: System structure, runtime boundaries, profile ownership, and subsystem maturity for v0.1.0.
sidebar_position: 1
---

# Architecture

EstaCoda is a TypeScript agent runtime for Node.js. It executes provider-backed sessions through a CLI and multiple remote channels. Every subsystem is inspectable, every state boundary is explicit, and every maturity label tells you what you can rely on.

This page explains how the system is structured, where state lives, and which surfaces are stable, experimental, or unsupported in v0.1.0.

---

## What EstaCoda Is

At its core, EstaCoda is a turn-based agent loop that:

1. Receives input from a surface (CLI, Telegram, Discord, Email, WhatsApp)
2. Assembles a layered prompt from session history, memory, skills, and context
3. Sends the prompt to a configured LLM provider
4. Executes any tool calls the provider requests
5. Returns the result to the surface
6. Persists session state, memory, and trajectory

The loop is not magic. It is explicit construction, explicit delegation, and explicit persistence. Every boundary is visible.

---

## Entrypoints and Surfaces

| Entrypoint | Role | Maturity |
|---|---|---|
| `src/index.ts` | Boot flow, command dispatch, session restoration | `live-proven` |
| `src/cli/cli.ts` | CLI command parsing and dispatch | `live-proven` |
| `src/cli/session-loop.ts` | Interactive terminal session | `live-proven` |
| `src/channels/gateway-runner.ts` | Telegram gateway runtime | `live-proven` |
| `src/channels/discord-adapter.ts` | Discord adapter | `present-not-live-proven` |
| `src/channels/email-adapter.ts` | Email adapter | `present-not-live-proven` |
| `src/channels/whatsapp-adapter.ts` | WhatsApp adapter | `experimental` |

CLI and Telegram are the live-proven surfaces for v0.1.0. Discord and Email are present in code but not validated end-to-end. WhatsApp is gated behind `experimental: true`.

---

## Runtime Composition Root

`createRuntime()` in `src/runtime/create-runtime.ts` is the composition root. It is a long function with many imports that manually constructs 30+ subsystem objects. There is no dependency injection container. Every subsystem is created with explicit constructor arguments in a fixed order.

Construction order:

1. State stores (memory store, session DB, artifact store, cron store)
2. Provider registry and auxiliary route resolver
3. Tool registry
4. Skill registries (official, profile, external)
5. Prompt dependencies (prompt cache, context expander)
6. Extracted runtime components (`RunRecorder`, `ToolPlanRunner`, `ProviderTurnLoop`, `SkillWorkflowExecutor`, `NativeToolExecutor`)
7. `AgentLoop`

Key composition rules:

- Official skills load first. Profile-installed and configured external skills load next.
- Visible skill catalog is filtered per session using runtime conditions.
- `vision.analyze` is registered as a real tool and uses the auxiliary `vision` provider route.
- Configured MCP servers are loaded during runtime creation and stopped during runtime disposal.

---

## Profile and State Boundaries

EstaCoda organizes all operator state around **profiles**. A profile is a complete configuration, credential, memory, skill, and gateway identity bundle.

### What Lives Under a Profile

`~/.estacoda/profiles/<id>/` contains:

- `config.json` — provider routes, channel config, security policy
- `.env` — API keys, bot tokens, secrets
- `auth.json` — OAuth tokens (e.g., Codex)
- `skills/` — profile-installed skills
- `memory/` — profile-local memory files
- `cron/` — job definitions and execution state
- `gateway/` — channel session pointers, handoff codes, approval state
- `logs/` — runtime logs
- `cache/` — prompt cache and runtime caches
- `media/` — channel-downloaded media

### What Is Global

- `~/.estacoda/sessions.sqlite` — session database, rows scoped by `profile_id`
- `~/.estacoda/memory/shared/` — shared memory across profiles
- `~/.estacoda/trust.json` — workspace trust per directory
- `~/.estacoda/workspace-approvals.json` — workspace approval grants

### What Is Workspace-Local

- `AGENTS.md` — project context and conventions (not memory)
- `trust.json` and `workspace-approvals.json` are directory-scoped

Trust is orthogonal to profiles. A profile selects configuration and credentials. Workspace trust gates local tool behavior for a directory. They do not override each other.

---

## Core Subsystems

### Provider Layer

Two layers: registry/routing and execution.

**Registry:** Offline-first model catalog, provider registry with route selection by capability, direct credential lookup from `apiKeyEnv` to `process.env`.

**Execution:** `ProviderExecutor` handles streaming token collection, tool-call fragment assembly, and fallback handling. `OpenAICompatibleProvider` is the primary inference adapter.

Auxiliary routes resolve through the same infrastructure: `vision`, `compression`, `assessor`, `profile_context`, `web_extract`, `session_search`, `skills_library`, `mcp`, `memory_flush`, `delegation`. These are preference constructs, not separate runtimes.

See [Provider Reference](../reference/provider-reference.md) for the exact maturity label of every provider.

### Tool Layer

`ToolRegistry` registers built-in tools at load time and MCP-discovered tools at runtime creation. `ToolExecutor` runs concrete tool actions under the active security policy. `ToolPlanRunner` converts provider tool calls into executable plans, manages safe-tool concurrency, and enforces failure caps.

Tool risk classes drive gating: `safe`, `caution`, `external-side-effect`, `irreversible`.

### Skill Layer

Skills load from three sources:

| Source | Location | Mutability |
|---|---|---|
| `official` | Bundled in repo | Read-only |
| `profile` | `~/.estacoda/profiles/<id>/skills/` | Mutable |
| `external` | Configured external roots | Read-only |

Visibility is session-stable and refreshed on `/reset` or new session. Skill execution is provider-backed by default; a deterministic fallback exists for no-provider sessions.

### Memory Layer

`MemoryStore` manages bounded memory files. `LocalMemoryProvider` reads and writes `USER.md`, `MEMORY.md`, and `SOUL.md` from the active profile. `MemoryRecallOrchestrator` prepares per-turn memory context for prompt assembly.

Recall, external recall, and compression summaries are reference-only context. They are not trusted as authoritative instructions.

### Channel Layer

`ChannelGateway` is the generic adapter bridge. It handles auth, allowlists, session mapping, progress delivery, approval prompts, and command routing. Adapters do not mutate approval state or runtime cache directly.

`DeliveryRouter` is the normalized delivery path for all channels. It handles multi-target delivery, text truncation, error persistence, and artifact routing.

### Security Layer

Capability-first security boundary. Approval modes: `strict`, `adaptive`, `open`. `adaptive` is default. `/yolo` toggles `open` mode session-scoped but cannot bypass the hardline floor.

Persistent approvals match on normalized `targetKey`. Display summaries are not the approval boundary.

Hardline floor covers: broad recursive deletes, destructive disk operations, shutdown/reboot, fork-bomb/kill-all, secret reads, pipe-to-interpreter installs, git force-pushes.

---

## Prompt Architecture

Prompt assembly is layered. Key context groups:

1. Identity and profile guidance
2. Safety and learned memory
3. Project context (including `AGENTS.md`)
4. Session history
5. Session recall and external recall
6. Live user message and attachments
7. Intent and skill instructions
8. Skill setup and resources
9. Workflow plan
10. Tool menu
11. Explicit reference context
12. Tool results / continuation feedback

Cacheable layers (identity, safety, project context, skill resources, compact skills index) are rebuilt only when underlying data changes. Non-cacheable layers (session history, recall, live message) are rebuilt every turn.

Semantic rules:

- Session-stable system context is preferred over mid-session mutation.
- Skills are progressively disclosed.
- Attachments are structured context, not fake user text.
- Channel-facing formatting happens after model generation.
- `AGENTS.md` is project context, not memory.
- Recall and compression summaries are untrusted historical context.

---

## Data Flow

The primary end-to-end path:

1. Input arrives from CLI or a channel
2. Runtime normalizes message + attachments
3. Prompt assembly builds a layered provider request
4. Provider responds with text and/or tool calls
5. Tool planner + executor run concrete actions under policy
6. Continuation prompt feeds tool results back if needed
7. Final output is formatted per surface
8. Session, memory, approvals, and trajectory state are persisted

`AgentLoop.handle()` coordinates this flow but delegates execution to specialized components. It does not execute provider iterations, tool plans, or skill workflows directly.

---

## v0.1.0 Maturity Matrix

| Area | Status | Notes |
|---|---|---|
| CLI | `live-proven` | Direct interaction surface. |
| Telegram | `live-proven` | First-party remote channel. |
| Discord | `present-not-live-proven` | Code exists, adapters initialize, not live-validated. |
| Email | `present-not-live-proven` | Code exists, adapters initialize, not live-validated. |
| WhatsApp | `experimental` | Gated behind `experimental: true`. |
| AgentLoop | `live-proven` | Core orchestration decomposed from monolith. |
| Provider execution | `live-proven` | OpenAI-compatible primary adapter. |
| Tool execution | `live-proven` | Built-in tools and MCP tools. |
| Skill system | `live-proven` | Official, profile, and external skills. |
| Memory system | `live-proven` | Local memory provider with promotion. |
| Security policy | `live-proven` | Adaptive mode with smart assessor fallback. |
| Gateway | `live-proven` | Telegram gateway. |
| Cron | `implemented` | Job scheduling and execution. |
| TaskFlow | `implemented` | Durable multi-step execution. Wired only with SQLite. |
| Browser (local CDP) | `live-proven` | Local Chrome DevTools Protocol. |
| Browser (cloud) | `unsupported` | Registered stubs only. |
| Web search | `unsupported` | Registered stubs only. Guarded fetch fallback only. |
| Eval runner | `implemented` | Deterministic fixtures exist. |

---

## Architectural Weak Spots

1. **`create-runtime.ts` god factory** — 900+ lines, 69 imports, no DI boundary. Accepted risk. Builder pattern deferred.
2. **AgentLoop remaining coupling** — Prompt assembly, memory context injection, and cross-component coordination still live in `AgentLoop`. Provider loop, tool execution, skill workflows, and native intents are already extracted.
3. **Gateway readiness vs. liveness** — `estacoda gateway diagnose` reports readiness per adapter, not background-process liveness.
4. **Trajectory/Artifact skeletons** — Trajectory persists to SQLite. `ArtifactStore` is thin (in-memory with limited persistence).
5. **Native SQLite bindings** — `better-sqlite3` requires install-time compilation on some platforms.

---

## How to Inspect

```bash
# Runtime readiness and config issues
estacoda model diagnose

# Gateway readiness per adapter
estacoda gateway diagnose

# Gateway full status
estacoda gateway status

# Provider state
estacoda model show

# Session list with surface attachments
estacoda sessions list

# Channel status
estacoda channels status
```

---

## Related

- [Runtime](./runtime.md) — runtime creation, provider resolution, and tool boundaries
- [Provider Reference](../reference/provider-reference.md) — provider maturity matrix
- [Channels](../user-guide/channels.md) — channel configuration and maturity
- [Security and Approvals](../user-guide/security-and-approvals.md) — approval behavior and security modes
