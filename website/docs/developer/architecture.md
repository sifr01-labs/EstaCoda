---
title: Architecture
description: System structure, runtime boundaries, profile ownership, and subsystem maturity for v0.1.0.
sidebar_position: 1
---

# Architecture

EstaCoda is a TypeScript agent runtime for Node.js. It executes provider-backed sessions through a CLI and multiple remote channels. This page explains how the system is structured, where state lives, and which surfaces are stable, experimental, or unsupported in v0.1.0.

The goal of this page is practical orientation: what owns what, where to inspect it, and which runtime paths are part of the current baseline.

---

## What EstaCoda is

At its core, EstaCoda is a turn-based agent loop that:

1. Receives input from a surface such as CLI, Telegram, Discord, Email, or WhatsApp
2. Assembles a layered prompt from session history, memory, skills, project context, and live input
3. Sends the prompt to a configured provider route
4. Executes tool calls under the active security policy
5. Returns output to the active surface
6. Persists session state, memory, approvals, artifacts, and trajectory data where applicable

The loop is explicit construction, explicit delegation, and explicit persistence. Runtime behavior should be inspectable from code and local state.

---

## Entrypoints and surfaces

| Entrypoint | Role | Maturity |
|---|---|---|
| `src/index.ts` | Boot flow, command dispatch, session restoration | `live-proven` |
| `src/cli/cli.ts` | CLI command parsing and dispatch | `live-proven` |
| `src/cli/session-loop.ts` | Interactive terminal session | `live-proven` |
| `src/channels/gateway-runner.ts` | Gateway diagnostics helpers | `smoke-tested` |
| `src/channels/telegram-adapter.ts` | Telegram adapter | `live-proven` |
| `src/channels/discord-adapter.ts` | Discord adapter | `present-not-live-proven` |
| `src/channels/email-adapter.ts` | Email adapter | `present-not-live-proven` |
| `src/channels/whatsapp-adapter.ts` | WhatsApp adapter | `operational-with-external-risk` |

CLI and Telegram are the strongest live-proven surfaces for v0.1.0. Discord and Email adapter code exists and is test-backed, but live production validation is deployment-specific. WhatsApp is setup-backed and operational through an isolated bridge, but it remains gated because Baileys is an unofficial API.

---

## Profile and state boundaries

EstaCoda organizes operator-owned configuration around **profiles**. A profile is the active bundle of provider routes, credentials, memory files, installed skills, channel state, logs, and runtime caches for one operator context.

### What lives under a profile

A typical profile directory contains:

`~/.estacoda/profiles/<id>/`

| Path | Use |
|---|---|
| `config.json` | Provider routes, channel config, security mode, and feature settings |
| `.env` | Profile-local secret values such as API keys and bot tokens. Not shown in setup review output. |
| `auth.json` | OAuth token records, such as Codex OAuth |
| `USER.md` | User preferences and stable user guidance |
| `SOUL.md` | Protected identity and safety guidance |
| `MEMORY.md` | Durable working memory and promoted facts |
| `promotions.json` | Memory promotion metadata |
| `memory-curation.json` | Memory curation checkpoint history |
| `skills/` | Profile-installed skills |
| `cron/` | Profile-local scheduled jobs |
| `gateway/` | Channel session state, gateway handoff state, and adapter state |
| `logs/` | Runtime logs |
| `channel-media/` | Downloaded channel media |
| `audio-cache/` | Audio artifacts and voice cache |
| `image-cache/` | Image generation and image input cache |
| `temp/` | Profile-local temporary files |

Not every file or directory exists before the related capability runs.

### What is global

| Path | Use |
|---|---|
| `~/.estacoda/active-profile.json` | Currently selected profile |
| `~/.estacoda/sessions.sqlite` | Session database, with rows scoped by `profile_id` |
| `~/.estacoda/memory/shared/` | Shared memory across profiles |
| `~/.estacoda/trust.json` | Workspace trust grants keyed by directory |
| `~/.estacoda/workspace-approvals.json` | Persistent workspace approval grants keyed by directory and action |
| `~/.estacoda/packs/` | Installed pack state |
| `~/.estacoda/bin/` | Managed helper binaries |

### What is workspace-local

| Path | Use |
|---|---|
| `AGENTS.md` | Project context and coding instructions |

Trust is global state with directory-scoped entries. It is not stored inside the workspace. A profile selects configuration, credentials, memory, and channel identity. Workspace trust gates local tool behavior for a directory. They do not override each other.

---

## Runtime composition root

`createRuntime()` in `src/runtime/create-runtime.ts` is the composition root. It explicitly creates stores, providers, tools, skills, prompt dependencies, runtime components, and the agent loop. There is no dependency injection container. Construction is visible in code and happens in a fixed order.

Construction order:

1. Global and profile state paths
2. State stores: memory, sessions, artifacts, cron, workflow, and gateway state
3. Provider registry, provider executor, and auxiliary route resolver
4. Tool registry and built-in tool providers
5. Skill registries for official, profile, and external skills
6. Prompt dependencies: prompt cache, project context, context expansion, and memory context
7. Runtime execution components such as `ProviderTurnLoop`, `ToolPlanRunner`, `SkillPlaybookRunner`, and native tool execution
8. `AgentLoopBuilder`, which assembles session-scoped loop dependencies
9. `DefaultChildAgentLoopFactory`, which builds isolated worker loops after the scheduler leases agent Steps
10. `AgentLoop`, which coordinates turn boundaries, runtime events, continuation, cancellation, and persistence

Key composition rules:

- Official skills load first. Profile-installed and configured external skills are layered after them.
- Visible skill catalog is filtered per session using runtime conditions.
- Tools are registered in phases so session-bound tools receive the correct runtime context.
- Auxiliary model routes use the same provider registry and executor path as primary model routes.
- Configured MCP servers are loaded during runtime creation and stopped during runtime disposal.
- Child agent loops are built through the child loop factory, not by bypassing the runtime composition path.

---

## Core subsystems

### Provider layer

The provider layer has three parts: model catalog, provider registry, and execution.

| Part | Role |
|---|---|
| Model catalog | Resolves known model profiles, capabilities, and fallback metadata |
| `ProviderRegistry` | Registers provider adapters and exposes route lookup |
| `ProviderExecutor` | Executes provider requests, collects streaming tokens, assembles tool calls, and handles fallback routes |

EstaCoda routes provider calls through configured provider adapters, including OpenAI-compatible chat completions and OpenAI Responses where configured. Provider selection depends on configured provider IDs, route preferences, model capability, and credential readiness.

Auxiliary routes resolve through the same infrastructure as primary model routes. Supported route names include `vision`, `compression`, `assessor`, `profile_context`, `web_extract`, `session_search`, `skills_library`, `mcp`, `memory_flush`, and `delegation`. These are preference routes, not separate runtimes.

See [Provider Reference](../reference/provider-reference.md) for provider maturity labels.

### Tool layer

`ToolRegistry` registers built-in tools at load time and MCP-discovered tools during runtime creation. `ToolExecutor` runs concrete tool actions under the active security policy. `ToolPlanRunner` converts provider tool calls into executable plans, manages safe-tool concurrency, and enforces failure caps.

Tool risk classes drive gating:

| Risk class | Meaning |
|---|---|
| `safe` | Low-risk read or local computation |
| `caution` | Needs care or may expose local state |
| `external-side-effect` | Can affect external systems |
| `irreversible` | Can make hard-to-reverse changes |

### Skill layer

Skills load from three sources:

| Source | Location | Mutability |
|---|---|---|
| `official` | Bundled in repo | Read-only |
| `profile` | `~/.estacoda/profiles/<id>/skills/` | Mutable |
| `external` | Configured external roots | Read-only |

Visibility is session-stable and refreshed on `/reset` or a new session. Skill execution is provider-backed by default, with deterministic fallback behavior for no-provider sessions.

### Memory layer

`MemoryStore` manages bounded memory files. `LocalMemoryProvider` reads and writes profile-local memory files. `MemoryRecallOrchestrator` prepares per-turn memory context for prompt assembly.

Recall, external recall, and compression summaries are reference-only context. They are not trusted as authoritative instructions.

### Channel layer

`ChannelGateway` is the generic adapter bridge. It handles auth, allowlists, session mapping, progress delivery, approval prompts, and command routing. Adapters do not mutate approval state or runtime cache directly.

`DeliveryRouter` is the normalized delivery path for channels. It handles multi-target delivery, text truncation, error persistence, and artifact routing.

### Security layer

EstaCoda uses a capability-first security boundary. Approval modes include `strict`, `adaptive`, and `open`. `adaptive` is the default. `/yolo` toggles `open` mode for the session, but it cannot bypass the hardline floor.

Persistent approvals match on normalized `targetKey`. Display summaries are not the approval boundary.

The hardline floor covers high-risk actions such as broad recursive deletes, destructive disk operations, shutdown or reboot commands, fork-bomb or kill-all patterns, secret reads, pipe-to-interpreter installs, and git force-pushes.

### Setup and onboarding

The setup subsystem owns reviewed first-run setup, repair flows, optional capability setup, config editing, and verification.

| Area | Code |
|---|---|
| Onboarding Wizard | `src/setup/onboarding-wizard/` |
| Setup Editor | `src/setup/config-editor/` |
| Review and apply | `src/setup/review/` |
| Verification | `src/setup/verification.ts` |
| Optional capabilities | `src/setup/optional-capability-flow.ts` |
| WhatsApp setup | `src/setup/whatsapp-setup-flow.ts` |

Setup writes profile-local configuration and secrets. It shows a review before applying changes, and raw secrets are not displayed in review output.

### Delegation and subagents

Delegation creates durable Tasks and returns their handles immediately. A single request becomes one Step; a batch becomes independent Steps governed by the durable scheduler. Tool authority, model routes, budgets, workspace trust, cancellation, results, and restart recovery are persisted Task behavior rather than provider-turn state.

| Component | Role |
|---|---|
| `DurableDelegationService` | Validates delegation and atomically creates root or linked child Tasks |
| `TaskScheduler` | Owns dependency order, bounded concurrency, retries, cancellation, and settlement |
| `AgentStepExecutor` | Runs a leased Step in an isolated worker session |
| `SubagentRegistry` | Provides ephemeral visibility for currently running Attempts |
| `toolset-security` | Narrows persisted Task and Step tool authority |

Provider tool-call IDs are idempotency keys: replay returns the existing Task, while a different definition under the same key fails closed. Orchestrator Steps may create linked child Tasks only when their persisted authority retains child depth, and the child authority and budget must be narrower than the active parent Step.

### Durable Task foundation

The Task foundation stores profile-owned multi-step execution graphs and durable result bodies independently of a provider turn. The profile gateway supervisor hosts deterministic dependency resolution, fenced Attempts, concurrency, retry, cancellation, acceptance, restart reconciliation, and authorized completion delivery. `delegate_task` is the first model-visible creation path and uses the same governed substrate.

| Component | Role |
|---|---|
| `task-schema.ts` | Defines the SQLite Task schema migration |
| `task-store.ts` | Defines the profile-bound persistence contract |
| `sqlite-task-store.ts` | Persists Tasks, plan revisions, Steps, Attempts, Results, Events, and session links |
| `task-result-service.ts` | Stores profile-local result bodies and verifies size and content hashes |
| `task-result-tools.ts` | Provides linked sessions with bounded `task.result.read` pages |
| `task-step-executor.ts` | Defines the Attempt execution and settlement boundary |
| `task-scheduler.ts` | Owns deterministic orchestration and fenced settlement |
| `agent-step-executor.ts` | Runs an isolated read-only child agent and captures complete results and usage |
| `task-background-host.ts` | Runs non-overlapping scheduler and completion-delivery ticks with startup recovery |
| `supervisor-task-background-host.ts` | Lazily creates the workspace-eligible agent runtime when work exists |
| `task-completion-delivery.ts` | Delivers terminal Results through a session-authorized, profile-owned outbox |
| `contracts/task.ts` | Defines Task records, transitions, authority, budgets, and graph validation |

Normal chat turns remain independent of durable Task scheduling. Result IDs and session links are checked before reads; raw bodies and filesystem paths do not enter Task events or completion bindings. The scheduler cannot grant tool authority. `createRuntime()` exposes the production read-only executor only for profile-backed SQLite runtimes, and the supervisor creates it lazily for runnable work in the exact trusted workspace. Gateway and session status expose bounded host/Task counts. Task creation and operator controls remain intentionally absent.

### Packs and distribution

Packs are installable bundles. The pack subsystem validates pack metadata, permissions, risk, and installation behavior before a pack is accepted.

| Component | Role |
|---|---|
| `pack-installer.ts` | Installs packs |
| `pack-registry.ts` | Tracks installed packs |
| `pack-validator.ts` | Validates pack shape |
| `pack-permission-validator.ts` | Checks declared permissions |
| `pack-risk-classifier.ts` | Classifies pack risk |
| `pack-force-audit-log.ts` | Records forced installs |

Packs are reviewable runtime extensions. They do not bypass normal permission and trust boundaries.

### Lifecycle management

Lifecycle code handles installation state, updates, uninstall, version resolution, and state preservation.

| Component | Role |
|---|---|
| `install-method.ts` | Detects how EstaCoda was installed |
| `update-engine.ts` | Coordinates update checks and update actions |
| `startup-update.ts` | Handles startup update behavior |
| `uninstall.ts` | Removes managed install state |
| `state-preservation.ts` | Preserves user-owned state during lifecycle operations |
| `version-resolver.ts` | Resolves available and current versions |

Lifecycle code is security-sensitive because it can mutate install files and preserve or remove local state.

### Agent evolution

The evolution subsystem supports reviewed improvement workflows. It handles candidate lifecycle, constraint gates, and export formats for evaluation or optimization data.

| Component | Role |
|---|---|
| `candidate-lifecycle.ts` | Tracks candidate change lifecycle |
| `constraint-gate-runner.ts` | Runs gate checks before promotion |
| `export-format.ts` | Exports structured data for review or evaluation |

Evolution is designed to remain reviewable. Learned or generated behavior must not silently mutate live policy.

### ACP server

`src/acp/` contains the ACP server integration. It exposes editor and protocol integration separately from the normal CLI and channel surfaces.

### Supporting infrastructure

These subsystems are smaller than the main runtime surfaces but still part of the architecture.

| Subsystem | Role |
|---|---|
| `src/theme/` | Terminal token resolution, skins, and plain-mode overlays |
| `src/knowledge/` | Code dependency graph and knowledge cache |
| `src/python-env/` | Managed Python capability environments |
| `src/capabilities/` | Optional capability setup and secret storage helpers |
| `src/workers/` | Python worker process |
| `src/search/` | Full-text query helpers |
| `src/reports/` | Model report rendering |
| `src/diagnostics/` | Provider and model diagnostic helpers |

---

## Prompt architecture

Prompt assembly is layered. Key context groups include:

1. Identity and profile guidance
2. Safety and learned memory
3. Project context, including `AGENTS.md`
4. Session history
5. Session recall and external recall
6. Live user message and attachments
7. Intent and skill instructions
8. Skill setup and resources
9. Workflow plan
10. Tool menu
11. Explicit reference context
12. Tool results or continuation feedback

Cacheable layers, such as identity, safety, project context, skill resources, and compact skills index, are rebuilt only when underlying data changes. Non-cacheable layers, such as session history, recall, and live messages, are rebuilt every turn.

Semantic rules:

- Session-stable system context is preferred over mid-session mutation.
- Skills are progressively disclosed.
- Attachments are structured context, not fake user text.
- Channel-facing formatting happens after model generation.
- `AGENTS.md` is project context, not memory.
- Recall and compression summaries are untrusted historical context.

---

## Data flow

The primary direct-turn path:

1. Input arrives from CLI or a channel
2. Runtime normalizes message and attachments
3. Prompt assembly builds a layered provider request
4. Provider responds with text and/or tool calls
5. Tool planner and executor run concrete actions under policy
6. Continuation prompt feeds tool results back if needed
7. Final output is formatted for the active surface
8. Session, memory, approvals, trajectory, and related state are persisted

A turn can also attach to larger orchestration:

| Path | When it applies |
|---|---|
| Direct provider/tool loop | Normal chat and tool use |
| Delegation | Parent session spawns bounded child agent sessions |
| Workflow | Durable multi-step execution is started or resumed |
| Channel gateway | Remote surfaces route messages, progress, approvals, and final delivery |

`AgentLoop.handle()` coordinates the turn boundary. Provider iteration, tool planning, skill playbooks, child loop construction, and workflow execution live in specialized components.

---

## v0.1.0 maturity matrix

| Area | Status | Notes |
|---|---|---|
| CLI | `live-proven` | Direct interaction surface. |
| Telegram | `live-proven` | First-party remote channel. |
| Discord | `present-not-live-proven` | Adapter code exists; live production use is not part of the v0.1.0 baseline. |
| Email | `present-not-live-proven` | Adapter code exists; live production use is not part of the v0.1.0 baseline. |
| WhatsApp | `operational-with-external-risk` | QR-linked bridge, diagnostics, and setup flow exist; still gated because Baileys is an unofficial API. |
| AgentLoop | `live-proven` | Core turn orchestration. |
| AgentLoopBuilder | `live-proven` | Session-scoped runtime assembly. |
| Provider execution | `live-proven` | Provider registry, executor, fallback, and auxiliary routes. |
| Tool execution | `live-proven` | Built-in tools and MCP tools. |
| Skill system | `live-proven` | Official, profile, and external skills. |
| Memory system | `live-proven` | Profile memory files and shared memory. |
| Security policy | `live-proven` | Adaptive mode with hardline floor. |
| Gateway | `live-proven` | Channel auth, routing, approvals, and delivery. |
| Setup and verification | `live-proven` | Onboarding, setup editor, and readiness checks. |
| Delegation | `implemented` | Durable root/child Tasks with bounded worker execution and Attempt visibility. |
| Workflow | `implemented` | Durable multi-step execution with SQLite-backed state. |
| Packs | `implemented` | Pack validation, install, risk, and permission checks. |
| Lifecycle | `implemented` | Install, update, uninstall support, and state preservation. |
| Agent Evolution | `implemented` | Candidate lifecycle, gates, and export format. |
| Cron | `implemented` | Job scheduling and execution. |
| ACP | `implemented` | ACP server integration exists. |
| Knowledge graph | `implemented` | Code dependency graph and cache. |
| Browser, local CDP | `live-proven` | Local Chrome DevTools Protocol. |
| Browser, cloud | `implemented` | Browserbase is implemented behind explicit cloud-spend approval; other cloud browser providers remain stubs. |
| Web search | `implemented` | Brave Search and DDGS search are implemented. Guarded `fetch` extraction is implemented; crawl and other search providers remain stubs. |
| Eval runner | `implemented` | Deterministic fixtures exist. |

---

## Architectural weak spots

1. **`create-runtime.ts` remains the composition root** - construction is explicit and reviewable, but the file is still large. Changes here should be narrow and heavily tested.
2. **AgentLoop is decomposed but still central** - `AgentLoopBuilder`, `ProviderTurnLoop`, `ToolPlanRunner`, `SkillPlaybookRunner`, and child loop factories handle much of the work. `AgentLoop` still coordinates turn boundaries, runtime events, continuation, cancellation, and persistence.
3. **Gateway readiness vs. liveness** - `estacoda gateway diagnose` reports adapter readiness, not full background-process liveness.
4. **Lifecycle and pack operations are high-impact** - update, uninstall, pack install, and state-preservation paths can mutate local install or runtime state. Treat changes there as security-sensitive.
5. **Native SQLite bindings** - `better-sqlite3` requires install-time compilation on some platforms.

---

## How to inspect

```bash
# Runtime readiness and config issues
estacoda model diagnose

# Full setup readiness
estacoda verify

# General diagnosis
estacoda doctor

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

# Code dependency graph
estacoda knowledge code summary
estacoda knowledge code refresh
```
