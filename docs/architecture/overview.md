---
title: "Architecture Overview"
description: "High-level system map, entrypoints, runtime composition, and data flow."
---

# Architecture Overview

EstaCoda is a TypeScript-first agent runtime built for Node.js >= 22.18.0, pnpm/Corepack source workflows, and compiled `dist/` production execution. It executes provider-backed agent sessions through the CLI and configured channels, with skills, tools, memory, workflow state, session persistence, and security policy as first-class surfaces. Bun is optional for explicitly named dev-speed lanes only.

## Entrypoints

| File | Role | Evidence |
|------|------|----------|
| `src/index.ts` | Boot flow. Dispatches CLI commands, uses setup-route launch gating for incomplete setup, then starts interactive session or one-shot prompt. Also restores the active CLI workspace session from persisted store before interactive launch. | `smoke-tested` |
| `src/cli/cli.ts` | CLI command surface. Parses arguments and dispatches to subcommands. | `smoke-tested` |
| `src/cli/session-loop.ts` | Interactive terminal loop. Handles in-session admin commands: `/sessions`, `/search`, `/switch`, `/new` (`/reset` alias). | `smoke-tested` |
| `src/cli/cli-session-store.ts` | Persisted active CLI session pointer keyed by workspace root. | `smoke-tested` |
| `src/channels/gateway-runner.ts` | Gateway diagnostics helpers for Telegram plus WhatsApp diagnostics export. Gateway orchestration lives in `ChannelGateway` and CLI gateway commands. | `smoke-tested` |
| `src/channels/discord-adapter.ts` | Discord adapter. Receives messages, sends replies, handles attachments, and supports text delivery paths. | `implemented; operator validation required` |
| `src/channels/email-adapter.ts` | Email adapter. IMAP receive, SMTP send, reply-in-thread, attachment ingestion, and sender filtering via Python worker. | `implemented; operator validation required` |
| `src/channels/whatsapp-adapter.ts` | WhatsApp adapter through an isolated Baileys linked-device bridge. Gated behind `experimental: true`; account standing and upstream protocol stability are external risks. | `operational with external API risk` |

## Runtime Composition

`createRuntime()` in `src/runtime/create-runtime.ts` is the composition root. It manually wires providers, tools, memory, skills, workflow integration, browser/web capability, MCP, security policy, session stores, and the `AgentLoop`.

Construction order:

1. State stores (memory store, session DB, artifact store, cron store)
2. Provider registry and auxiliary routes
3. Tool registry
4. Skill registries (official → personal → project → external)
5. Prompt dependencies (prompt cache, context expander)
6. Runtime components (`RunRecorder`, `ToolPlanRunner`, `ProviderTurnLoop`, `SkillPlaybookRunner`, `NativeToolExecutor`, `RuntimeRouter`)
7. `AgentLoop`

Key composition rules:

- Official skills load first. Profile-installed and configured external skills load next.
- Visible skill catalog is filtered per session using runtime conditions.
- `vision.analyze` is registered as a real tool and uses auxiliary `vision` provider route preferences.
- Channel media directory is treated as an additional allowed root for relevant tools.
- Configured MCP servers are loaded during runtime creation and stopped during runtime disposal.

## Core Orchestration

| File | Role | Evidence |
|------|------|----------|
| `src/runtime/create-runtime.ts` | Composition root | `smoke-tested` |
| `src/runtime/agent-loop.ts` | Core turn orchestration lifecycle | `live-proven` |
| `src/runtime/agent-loop-builder.ts` / `agent-loop-factory.ts` | Shared parent/child loop construction for delegation | `test-backed` |
| `src/runtime/runtime-router.ts` | Runtime routing for native intents and skills | `smoke-tested` |
| `src/runtime/provider-turn-loop.ts` | Provider turn loop, finalization, continuation, and tool-call extraction | `live-proven` |
| `src/runtime/tool-plan-runner.ts` | Tool plan execution and bounded concurrency/failure handling | `live-proven` |
| `src/runtime/run-recorder.ts` | Run recording and trajectory/event linkage | `smoke-tested` |
| `src/runtime/skill-playbook-runner.ts` | Skill playbook execution | `live-proven` |
| `src/runtime/native-tool-executor.ts` | Deterministic native intent execution | `smoke-tested` |
| `src/runtime/intent-router.ts` | Native intent classification | `smoke-tested` |

## Agent Loop Shape

`AgentLoop.handle()` follows this approximate flow:

1. Receive text + attachments + channel
2. Expand `@file:` / `@folder:` references
3. Record input to session DB + trajectory
4. Normalize attachment statuses
5. Short-circuit on attachment preflight failures
6. Route native intent and skill (delegated to `RuntimeRouter`)
7. Make security decision
8. Prepare per-turn memory context through `MemoryRecallOrchestrator`
9. Check provider-turn semantic compression at the `AgentLoop` boundary when enabled
10. Rotate to the compacted child session before provider prompt assembly when auto-compression preserves the transcript
11. **Delegate provider prompt assembly and turn loop to `ProviderTurnLoop`**
12. **Delegate tool execution to `ToolPlanRunner`**
13. **Delegate skill playbook execution to `SkillPlaybookRunner`**
14. **Delegate deterministic native execution to `NativeToolExecutor`**
15. Persist results, outcomes, artifacts
16. Return text/progress/artifacts

Guardrails inside the loop:

- Attachment preflight can stop the turn before provider execution.
- Provider iterations are budgeted (enforced by `ProviderTurnLoop`).
- Repeated tool failures are capped (enforced by `ToolPlanRunner`).
- Safe tool concurrency is bounded (enforced by `ToolPlanRunner`).
- Security decisions are attached to tool executions, not just final replies.

**Remaining coupling:** `AgentLoop` still coordinates prompt preparation, memory context injection, native routing, provider turns, tool plans, result persistence, artifacts, and response shaping. Provider iteration and tool execution are delegated, but the turn boundary remains a large integration point.

Native intent routing handles product-owned paths before normal provider planning:

- Explicit text-to-image prompts → `image-generation` → deterministic `image.generate`
- Ready image attachments with edit/modify prompts → `attachment-analysis`
- Audio/voice transcription wording → `voice-transcription`

## Provider Architecture

Two layers:

**1. Registry / routing**
- Offline-first model catalog (`src/model-catalog/models-dev-registry.ts`)
- Provider registry with route selection by capability and preference
- Runtime credential resolution from provider route metadata, selected-profile `.env`, OAuth/auth state, and process environment where supported

**2. Execution**
- `ProviderExecutor` — streaming token collection, tool-call fragment assembly, fallback handling
- `OpenAICompatibleProvider` — primary inference adapter

Auxiliary routes exist for: `main`, `vision`, `compression`, `assessor`, `profile_context`, `web_extract`, `session_search`, `skills_hub`, `mcp`, `memory_flush`, `delegation`.

These are preferences/routing constructs, not separate runtimes.

Important distinction:
- The model catalog is enriched from the models.dev metadata registry when cached/bundled data is available, with local fallback profiles retained as a safety net.
- Catalog-only providers are discovery adapters, not true inference adapters.
- Runtime config loads catalog metadata with network refresh disabled by default.

## Prompt Architecture

Prompt assembly is layered and partly cacheable. Key context groups:

1. Canonical memory prompt context from `MemoryPromptContextBuilder`
2. Project context, including `AGENTS.md`
3. Optional compaction notice for semantic session compression
4. Session history
5. Optional session recall and external recall from `MemoryRecallOrchestrator`
6. Live user message
7. Channel attachments
8. Intent
9. Skill instructions
10. Skill setup
11. Skill resources
12. Workflow plan
13. Tool menu
14. Explicit reference context
15. Tool results / continuation feedback

The implemented non-cacheable sequence renders compaction notice, session history, session recall, external recall, then the live user message. This render order is separate from trust and authority: recall, external recall, and compression summaries remain reference-only/untrusted context.

Recall policy is not decided by `ProviderTurnLoop`, which consumes the prepared session history and memory context for provider calls. `IntentRouter` currently classifies native intents and does not emit recall-specific labels; recall/continuity detection lives in `MemoryRecallOrchestrator`, which calls `SessionRecallService` when eligible.

Provider-turn semantic compression is also not owned by `ProviderTurnLoop`. When enabled and over threshold, `AgentLoop` can preserve the parent transcript by compacting into a child session and rotating the runtime session context before provider prompt assembly. Post-rotation writes use the active child session; the parent remains queryable as historical/audit context.

Other cacheable context includes:

1. Identity / profile guidance
2. Safety and learned memory
3. Project context
4. Skill resources
5. Compact skills index

Semantic rules:

- Session-stable system context is preferred over mid-session mutation.
- Skills are progressively disclosed.
- Attachments are structured context, not fake user text.
- Channel-facing formatting is handled after model generation, not by mutating the core runtime.
- `AGENTS.md` is project context, not memory.
- Session recall, external recall, and compression summaries are untrusted historical context.

## Skill Model

Skill sources:

| Source | Location | Mutability |
|--------|----------|------------|
| `official` | Bundled in repo | Read-only (local working copies for evolution) |
| `profile` | `~/.estacoda/profiles/<id>/skills/` | Mutable |
| `external` | Configured external roots | Read-only |

Visibility is session-stable, filtered by runtime conditions, and refreshed on `/new` or new session. `/reset` remains a deprecated alias.

Skill operations: list, view, inspect, create, patch, edit, delete, write_file, remove_file, import, export.

Execution: provider-backed by default; deterministic fallback path exists for no-provider sessions. Resources (`references/`, `templates/`, `scripts/`, compatible `assets/`) are indexed and loaded on demand.

## Channel Architecture

`ChannelGateway` is the generic adapter bridge. Responsibilities:

- Auth / allowlist / pairing
- Session mapping with normalized session-key policy
- Session auto-reset policy
- Session-admin commands (`/sessions`, `/search`, `/switch`, `/attach`, `/detach`)
- Runtime construction from fresh config snapshot per turn
- Progress delivery
- Approval prompt delivery
- Command handling

### Adapters

| Adapter | Status | Key File |
|---------|--------|----------|
| Telegram | `live-proven` | `src/channels/telegram-adapter.ts` |
| Discord | `implemented but not live-proven` | `src/channels/discord-adapter.ts` |
| Email | `implemented but not live-proven` | `src/channels/email-adapter.ts` |
| WhatsApp | `operational with external API risk` | `src/channels/whatsapp-adapter.ts` |

Telegram-specific behavior:
- Polling
- Attachment download
- Callback query handling
- Progress message editing
- Final reply formatting (Telegram-safe HTML)

Discord-specific behavior:
- Gateway client via `discord.js`
- DM, guild channel, and thread support
- Attachment download
- Text delivery with chunking
- Slash-command registration is not part of the current first-party setup flow

Email-specific behavior:
- IMAP poll for incoming mail
- SMTP send for replies
- Reply-in-thread via `In-Reply-To` / `References` headers
- Attachment ingestion
- Allowed sender filtering
- Home address configuration

WhatsApp-specific behavior:
- Baileys linked-device model through the isolated `scripts/whatsapp-bridge/` helper
- QR-only device login through the shared WhatsApp setup flow (`estacoda whatsapp`, Setup Editor, or first-run onboarding)
- DM-first (no group support)
- Media download/upload
- Message chunking
- Gated behind `channels.whatsapp.experimental: true`

### DeliveryRouter

`DeliveryRouter` is the normalized delivery path for all channels. It replaces hardcoded per-channel delivery in cron and gateway.

Supported targets:
- `local` — write to local file
- `origin` — deliver to the channel that triggered the action
- `silent` — no delivery
- `telegram:<chatId>` — Telegram DM or channel
- `discord:<channelId>` — Discord channel
- `whatsapp:<number>` — WhatsApp DM
- `email:<address>` — Email address

Behavior:
- Multi-target delivery: one message can be delivered to multiple targets.
- Truncation: long text is truncated with ellipsis when channel limits apply.
- Error persistence: delivery failures are recorded and visible via `estacoda gateway status`.
- Progress/artifact routing: `deliverProgress` and `deliverArtifact` variants exist.

### Session Identity Policy

Channel session identity includes explicit chat/thread policy:

| Context | Default |
|---------|---------|
| DM | Per-user |
| Group | Per-user |
| Thread | Shared |

Configurable via runtime config.

### Cross-Surface Sessions

Sessions are **separate by default**. A CLI session and a Telegram session for the same user do not share context automatically.

Explicit attach/detach is required:
- `estacoda sessions attach <surface> <surface-id> <session-id>`
- `estacoda sessions detach <surface> <surface-id>`
- `/attach <code>` in Telegram (redeems a handoff code)
- `/detach` in Telegram (creates a new independent session)

Surface pointers are stored in `FileSurfacePointerStore` under the bound profile gateway state. Each pointer records:
- `sessionId`: the SQLite session
- `attachedAt`: ISO timestamp
- `homeDelivery`: optional delivery target (e.g., `local`, `telegram:<chatId>`)

### CLI ↔ Telegram Handoff

Handoff uses short-lived, single-use codes:
1. Operator runs `estacoda handoff telegram` → generates a 6-character code (Crockford base-32, `crypto.randomInt`).
2. Code is written under the bound profile gateway state with TTL (default 10 minutes).
3. User sends `/attach <code>` in Telegram.
4. `HandoffStore.redeem()` validates: code exists, not used, not expired, surface type matches.
5. On success, the Telegram surface pointer is updated to point to the CLI session.
6. On failure, generic safe messages are returned (no session ID leakage).

Security properties:
- Cryptographically secure randomness.
- 32^6 keyspace (~1.07 billion combinations).
- Atomic file writes with `0o600` permissions.
- No built-in handoff rate limiter; mitigation relies on short TTL, single-use codes, large keyspace, and gateway allowlist.

## Cron Architecture

### Stores

| Store | Persistence | Role |
|-------|-------------|------|
| `CronStore` | `~/.estacoda/profiles/<id>/cron/jobs.json` | Job definitions, schedule, status, next run |
| `CronExecutionStore` | SQLite (`sessions.sqlite`) | Execution records: start, end, status, output summary, failure class/message |

### Runner

`tickCron` in `src/cron/cron-runner.ts`:
- Acquires `.tick.lock` to prevent concurrent ticks.
- Computes due jobs.
- Per-job execution: acquires job-level lock, advances `nextRunAt` before execution, creates fresh session, runs script or prompt.
- PID/stale-lock recovery: on startup, checks for stale locks from crashed processes.
- Recursion guard: `disableCronTools: true` in cron runtime prevents cron jobs from scheduling more cron jobs.
- Delivery: uses `DeliveryRouter` for all channel delivery.

### Failure Handling

- Failure class: `timeout`, `script-failed`, `delivery-failed`, `unknown`.
- Failure message: captured from script stderr or exception.
- Execution status: `success`, `failed`, `cancelled`.
- Recent failures visible via `estacoda gateway status` and `estacoda cron history`.

## Security Model

Capability-first security boundary.

- Approval modes: `strict`, `adaptive`, `open`
- `adaptive` is default; uses deterministic triage first, then optional auxiliary assessor
- `open` preserves a hard dangerous-command floor
- `/yolo` is a session-scoped CLI/gateway toggle for `open` mode; cannot bypass the hard floor
- Tool risk classes drive gating: `safe`, `caution`, `external-side-effect`, `irreversible`
- Structured `targetKey` values are the approval boundary; display summaries are not
- Workspace trust allows normal local work in that directory to proceed proactively; it does not control config loading
- Persistent approvals match on normalized `targetKey`
- Channel approvals: `once`, `session`, `always`
- CLI approvals: same scope model through runtime-backed grants
- Hard floor covers: broad recursive deletes, destructive disk operations, shutdown/reboot, fork-bomb/kill-all, secret reads, pipe-to-interpreter installs, git force-pushes

### Channel Security

- **Telegram:** allowlist by `userId` and `chatId`; optional pairing codes for unlisted users.
- **Discord:** allowlist by `userId`, `guildId`, and `channelId`.
- **Email:** allowlist by sender address (`allowedSenders`); `allowAllUsers` bypasses sender filtering. Uses global security policy — no email-specific approval friction.
- **WhatsApp:** allowlist by `userId` (phone number/JID). The unofficial-API gate (`experimental: true`) must be open for the adapter to initialize.
- **Global policy:** all channels share the same runtime security policy. There is no channel-specific approval escalation.

## Operator Surface

### Gateway

- `estacoda gateway status` — process, channels, DeliveryRouter platforms, surface pointers, pending approvals, cron summary, recent failures, delivery errors, missing config.
- `estacoda gateway diagnose` — per-channel readiness checks, cron directory permissions, missing credentials. Returns exit 1 if warnings exist.

### Channels

- `estacoda channels list` — compact table of all configured channels.
- `estacoda channels status [channel]` — detailed per-channel status with surface pointers.

### Cron

- `estacoda cron list` — all jobs with schedule, status, next run.
- `estacoda cron show <job-id>` — job detail with recent executions.
- `estacoda cron history [job-id]` — execution history.
- `estacoda cron run <job-id>` — request a run (sets `runRequested`).
- `estacoda cron pause <job-id>` — pause job.
- `estacoda cron resume <job-id>` — resume job.
- `estacoda cron remove <job-id>` — delete job.

### Sessions

- `estacoda sessions list` — recent sessions with attached surfaces.
- `estacoda sessions show <session-id>` — session detail with surface pointers.
- `estacoda sessions current` — current runtime session (when present).
- `estacoda sessions attach <surface> <surface-id> <session-id>` — explicit attach.
- `estacoda sessions detach <surface> <surface-id>` — explicit detach.

## Persistence Model

### Session persistence

- Interactive/session state written to session DB
- Global SQLite session DB at `~/.estacoda/sessions.sqlite`, with rows scoped by `profile_id`
- CLI session context persisted in `.estacoda/cli-sessions.json`
- Channel session context persisted under the bound profile gateway state via `ChannelSessionStore`
- Cross-surface pointers under the bound profile gateway state
- Channel session identity includes explicit chat/thread policy

### Memory persistence

- Global shared memory in `~/.estacoda/memory/shared/`
- Profile-local `USER.md`, `SOUL.md`, `MEMORY.md`, `promotions.json`, and `memory-curation.json` under `~/.estacoda/profiles/<id>/`
- Workspace `AGENTS.md` is context/instruction input, not profile memory
- Bounded budgets enforced by `MemoryStore`
- `LocalMemoryProvider` persists: manual conclusions, promoted user preferences, promoted project facts/conventions, skill outcomes
- Contradiction/forget/inspection for promoted user preferences
- Agent Evolution separated from memory files:
  - Facts/conventions → profile-local `MEMORY.md`
  - User preferences → profile-local `USER.md`
  - Persona/identity → profile-local `SOUL.md`
  - Reusable procedures → profile skills
  - Promotion metadata → profile-local `promotions.json`
  - Curation history → profile-local `memory-curation.json`
- `skills.autonomy`: `none` | `suggest` | `proactive` | `autonomous`

### Trajectory persistence

- Trajectories are persisted to global `~/.estacoda/sessions.sqlite` via `SQLiteSessionDB` and scoped by profile
- Table `trajectories` stores event arrays, outcomes, and metadata
- Table `trajectory_failures` stores classified failure records
- `TrajectoryRecorder` remains in-memory for the active session; persistence happens at completion
- `smoke-tested`

## Data Flow Summary

The primary end-to-end path:

1. Input arrives from CLI or a channel (Telegram, Discord, Email, WhatsApp)
2. Runtime normalizes message + attachments
3. Prompt assembly builds a layered provider request
4. Provider responds with text and/or tool calls
5. Tool planner + executor run concrete actions under policy
6. Continuation prompt feeds tool results back if needed
7. Final output is formatted per surface
8. Session, memory, approvals, and trajectory state are persisted

## Current Architectural Weak Spots

1. **AgentLoop integration size** — Provider turns, tool execution, skill playbooks, and native intents are separated, but `AgentLoop` remains a large turn-level coordinator.
2. **create-runtime.ts god factory** — Runtime construction still centralizes many subsystem objects and has no DI/plugin boundary.
3. **Artifact store is still thin** — Trajectories persist through SQLite, but `ArtifactStore` remains an in-memory prompt-reference store.
4. **Native SQLite distribution** — `better-sqlite3` provides stable synchronous SQLite semantics behind the internal adapter, but native bindings require install and packaging validation on supported platforms.
5. **Gateway liveness** — readiness-focused, not daemon-tracking.
6. **Remaining cross-component state** — `AgentLoop` constructor still receives 20+ dependencies. Some (e.g., `memoryContext`, `projectContext`) are only used for prompt assembly and could move to a dedicated `PromptAssembler`.
7. **Discord slash commands** — slash-command registration is not part of current first-party setup.
8. **WhatsApp external API risk** — Baileys is an unofficial API; Meta may suspend accounts using it.
