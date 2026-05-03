---
title: "Architecture"
description: "Holistic system architecture: composition, runtime, boundaries, risks, and decomposition targets."
---

# Architecture

This document is a single-file synthesis of EstaCoda's architecture. For granular subsystem detail, see `docs/architecture/` and `docs/subsystems/`.

All statements are grounded in the current codebase. Unimplemented features are labeled.

---

## 1. System Overview

EstaCoda is a TypeScript agent runtime built on Bun. It executes provider-backed agent sessions through CLI and Telegram, with skills, tools, memory, and security policy as first-class surfaces.

The runtime is organized into layers:

```text
┌─────────────────────────────────────────────────────────────┐
│  User Surfaces          CLI │ Telegram │ Cron │ Editor (ACP)  │
├─────────────────────────────────────────────────────────────┤
│  Runtime                AgentLoop │ IntentRouter │ createRuntime │
├─────────────────────────────────────────────────────────────┤
│  Subsystems    Skills │ Tools │ Providers │ Memory │ Security   │
├─────────────────────────────────────────────────────────────┤
│  Infrastructure  Session DB │ Prompt │ Trajectory │ Artifacts    │
├─────────────────────────────────────────────────────────────┤
│  Contracts              Pure types imported by all layers      │
└─────────────────────────────────────────────────────────────┘
```

### Entrypoints

| File | Role | Evidence |
|------|------|----------|
| `src/index.ts` | Boot flow. Loads config, runs onboarding, dispatches to CLI or one-shot prompt. | `implemented but not live-proven` |
| `src/cli/cli.ts` | CLI command surface. | `smoke-tested` |
| `src/cli/session-loop.ts` | Interactive terminal loop with `/sessions`, `/search`, `/switch`, `/reset`. | `smoke-tested` |
| `src/cli/cli-session-store.ts` | Persisted active CLI session pointer per workspace. | `smoke-tested` |
| `src/channels/gateway-runner.ts` | Telegram gateway runtime wrapper. | `live-proven` |

### Runtime Composition

`createRuntime()` in `src/runtime/create-runtime.ts` is the composition root. It is an 830-line function with 63 imports that manually constructs 30+ subsystem objects in this order:

1. State stores (memory, session, artifact, cron)
2. Provider registry and auxiliary routes
3. Tool registry
4. Skill registries (official → personal → project → external)
5. Prompt dependencies (cache, context expander)
6. `AgentLoop`

**Key rule:** Official skills load first. Personal/project/external skills load next. Visible skill catalog is filtered per session using runtime conditions.

---

## 2. Core Orchestration

### AgentLoop

**File:** `src/runtime/agent-loop.ts`  
**Size:** 809 lines  
**Evidence:** `live-proven`

`AgentLoop.handle()` processes one user turn end to end through approximately these phases:

1. Receive text + attachments + channel
2. Expand `@file:` / `@folder:` references
3. Record input to session DB + trajectory
4. Normalize attachment statuses
5. Short-circuit on attachment preflight failures
6. Route native intent and skill (delegated to `RuntimeRouter`)
7. Make security decision
8. Assemble prompt
9. **Delegate provider turn loop to `ProviderTurnLoop`**
10. **Delegate tool execution to `ToolPlanRunner`**
11. **Delegate skill workflow execution to `SkillWorkflowExecutor`**
12. **Delegate deterministic native execution to `NativeToolExecutor`**
13. Persist results, outcomes, artifacts
14. Return text/progress/artifacts

**Guardrails inside the loop:**

- Attachment preflight can stop the turn before provider execution.
- Provider iterations are budgeted (enforced by `ProviderTurnLoop`).
- Repeated tool failures are capped (enforced by `ToolPlanRunner`).
- Safe tool concurrency is bounded (enforced by `ToolPlanRunner`).
- Security decisions are attached to tool executions, not just final replies.

**Status:** Provider loop, tool execution, skill workflows, and native intents extracted in v0.4. `AgentLoop` retains orchestration, prompt assembly, security gating, memory promotion, and response formatting.

### Native Intent Routing

`IntentRouter` (`src/runtime/intent-router.ts`, 175 lines, `smoke-tested`) handles product-owned paths before normal provider planning:

- Explicit text-to-image prompts → `image-generation` → deterministic `image.generate`
- Ready image attachments with edit/modify prompts → `attachment-analysis`
- Audio/voice transcription wording → `voice-transcription`

### Supporting Runtime Files

| File | Role | Lines | Evidence |
|------|------|-------|----------|
| `src/runtime/create-runtime.ts` | Composition root | 901 | `smoke-tested` |
| `src/runtime/runtime-router.ts` | Runtime routing (intent + skill) | ~120 | `smoke-tested` |
| `src/runtime/provider-turn-loop.ts` | Provider streaming loop | ~585 | `live-proven` |
| `src/runtime/tool-plan-runner.ts` | Tool plan execution | ~420 | `live-proven` |
| `src/runtime/run-recorder.ts` | Run recording and trajectory | ~200 | `smoke-tested` |
| `src/runtime/skill-workflow-executor.ts` | Skill workflow execution | ~267 | `live-proven` |
| `src/runtime/native-tool-executor.ts` | Deterministic native intent execution | ~150 | `smoke-tested` |
| `src/runtime/intent-router.ts` | Native intent classification | 175 | `smoke-tested` |

---

## 3. Provider Architecture

Two layers:

**1. Registry / routing**
- Offline-first model catalog (`src/model-catalog/models-dev-registry.ts`)
- Provider registry with route selection by capability and preference
- Credential pool for key rotation

**2. Execution**
- `ProviderExecutor` — streaming token collection, tool-call fragment assembly, fallback handling
- `OpenAICompatibleProvider` — primary inference adapter

Auxiliary routes exist for: `main`, `vision`, `compression`, `approval`, `web_extract`, `session_search`, `skills_hub`, `mcp`, `memory_flush`, `delegation`. These are preferences/routing constructs, not separate runtimes.

**Important distinction:** The model catalog is enriched from the models.dev metadata registry when cached/bundled data is available, with local fallback profiles retained as a safety net. Catalog-only providers are discovery adapters, not true inference adapters.

---

## 4. Prompt Architecture

Prompt assembly is layered and partly cacheable. Key layers:

1. Identity / SOUL
2. Frozen memory snapshot
3. Compact skills index
4. Session history
5. User message
6. Channel attachments
7. Intent
8. Skill instructions
9. Skill setup
10. Skill resources
11. Workflow plan
12. Tool menu
13. Project context
14. Explicit reference context
15. Tool results / continuation feedback

**Semantic rules:**

- Session-stable system context is preferred over mid-session mutation.
- Skills are progressively disclosed.
- Attachments are structured context, not fake user text.
- Channel-facing formatting is handled after model generation, not by mutating the core runtime.

---

## 5. Subsystems

### Skills

**Location:** `src/skills/` (5,606 lines)

Skill sources:

| Source | Location | Mutability |
|--------|----------|------------|
| `official` | Bundled in repo | Read-only (local working copies for evolution) |
| `personal` | `~/.estacoda/skills/` | Mutable |
| `project` | `<workspace>/.estacoda/skills/` | Mutable |
| `external` | Configured external roots | Read-only |

Visibility is session-stable, filtered by runtime conditions, and refreshed on `/reset` or new session.

Skill operations: list, view, inspect, create, patch, edit, delete, write_file, remove_file, import, export.

Execution: provider-backed by default; deterministic fallback path exists for no-provider sessions. Resources (`references/`, `templates/`, `scripts/`, compatible `assets/`) are indexed and loaded on demand.

### Tools

**Location:** `src/tools/` (4,510 lines)

`ToolRegistry` registers built-in tools at load time and MCP-discovered tools at runtime creation. `ToolExecutor` runs concrete actions under security policy. `ToolCallPlanner` converts provider tool calls into execution plans.

Tool risk classes drive gating: `safe`, `caution`, `external-side-effect`, `irreversible`.

### Memory

**Location:** `src/memory/` (1,074 lines)

`MemoryStore` manages bounded files (`SOUL.md`, `USER.md`, `MEMORY.md`, `AGENTS.md`) under `~/.estacoda/`. `LocalMemoryProvider` reads and writes these files. `MemoryRenderer` packs memory into prompts. `MemoryPromotion` promotes repeated preferences and facts after the response path.

**Frozen snapshot pattern:** The agent loop injects a memory snapshot at session start. Changes during a session are persisted immediately but do not appear in the system prompt until the next session.

### Security

**Location:** `src/security/` (1,185 lines)

Capability-first security boundary.

- Approval modes: `strict`, `adaptive`, `open`
- `adaptive` is default; uses deterministic triage first, then optional auxiliary security assessor
- `open` preserves a hard dangerous-command floor
- `/yolo` is a session-scoped CLI/gateway toggle for `open` mode; cannot bypass the hard floor
- Structured `targetKey` values are the approval boundary; display summaries are not
- Workspace trust allows normal local work to proceed proactively
- Persistent approvals match on normalized `targetKey`
- Channel approvals: `once`, `session`, `always`
- CLI approvals: same scope model through runtime-backed grants
- Hard floor covers: broad recursive deletes, destructive disk operations, shutdown/reboot, fork-bomb/kill-all, secret reads, pipe-to-interpreter installs, git force-pushes

### Channels

**Location:** `src/channels/` (3,607 lines)

`ChannelGateway` is the generic adapter bridge. Responsibilities: auth / allowlist / pairing, session mapping, session auto-reset, progress delivery, approval prompt delivery, command handling.

Telegram-specific behavior lives in `TelegramAdapter`: polling, attachment download, callback query handling, progress message editing, final reply formatting.

Telegram UX choices:

- One evolving progress message per active turn
- Inline approval buttons map back to `/approve` and `/deny`
- Final replies formatted in Telegram-safe HTML layer
- Activity labels localized through shared label map (`en`, `ar`)
- Group sessions per-user by default; thread sessions shared by default
- Active chat → session mapping persists across gateway restarts

### Session

**Location:** `src/session/` (502 lines)

SQLite for gateway path; in-memory for smoke/scaffolding. CLI session context persisted in `.estacoda/cli-sessions.json`. Channel session context persisted in `.estacoda/channel-sessions.json`. Channel session identity includes explicit chat/thread policy.

### Trajectory and Artifacts

**Location:** `src/trajectory/` (97 lines), `src/artifacts/` (56 lines)

`TrajectoryRecorder` records 32 event kinds in memory only. `ArtifactStore` is 56 lines and in-memory only.

**Evidence labels:** `implemented but not live-proven` for both.

---

## 6. Boundary Analysis

### Memory Boundary

```
┌───────────────────────────────────────────────────────┐
│  MemoryStore (bounded files)                          │
│  ───────────────────────────────────────────────────  │
│  USER.md  ←──── LocalMemoryProvider ────→  AgentLoop  │
│  MEMORY.md ←─── (read/write/promote)   (frozen snap)  │
│  SOUL.md   ←────────────────────────────────────────  │
└───────────────────────────────────────────────────────┘
```

- **Inbound:** AgentLoop injects frozen snapshot; LocalMemoryProvider reads from disk.
- **Outbound:** `memory-tool.ts` lets the agent mutate entries; `memory-promotion.ts` writes promoted content back.
- **Crosses:** AgentLoop → LocalMemoryProvider; SkillLearningManager → MemoryStore.

### Skill Runtime Boundary

- **Inbound:** SkillLoader loads from four sources; SkillEvolutionStore receives proposed patches; SkillLearningManager observes workflows.
- **Outbound:** AgentLoop reads instructions; SkillTools exposes CRUD to the agent; skill-mutation-policy enforces promotion gates.
- **Crosses:** AgentLoop → SkillRegistry; SkillTools → SkillEvolutionStore; SkillLearningManager → MemoryStore.

### Provider–Tool Loop Boundary

The loop currently owns the iteration cycle. The provider does not know about tools; the tool executor does not know about providers. Only the loop bridges them.

**Risk:** The loop is the only place where provider responses, tool plans, security decisions, and memory promotion meet. This makes the loop irreplaceable without rewriting the entire system.

### Observability Boundary

Contracts define 32 event kinds. Implementation is a 97-line in-memory recorder with no persistence.

**Gap:** No run replay, no structured trace export, no eval dataset generation, no evidence corpus.

---
## 7. Decomposition Targets (v0.4)

**Goal:** Turn the 2,714-line `AgentLoop` monolith into inspectable, testable, independently replaceable components.

**Status:** ✅ Completed. `AgentLoop` reduced from 2,714 to 809 lines. Six components extracted:

| Component | File | Lines | Formerly |
|-----------|------|-------|----------|
| `RuntimeRouter` | `src/runtime/runtime-router.ts` | ~120 | Intent routing logic inside `AgentLoop` |
| `ProviderTurnLoop` | `src/runtime/provider-turn-loop.ts` | ~585 | Provider streaming loop inside `AgentLoop` |
| `ToolPlanRunner` | `src/runtime/tool-plan-runner.ts` | ~420 | Tool execution orchestration inside `AgentLoop` |
| `SkillWorkflowExecutor` | `src/runtime/skill-workflow-executor.ts` | ~267 | Skill workflow execution inside `AgentLoop` |
| `NativeToolExecutor` | `src/runtime/native-tool-executor.ts` | ~150 | Native intent execution inside `AgentLoop` |
| `RunRecorder` | `src/runtime/run-recorder.ts` | ~200 | Scattered recording calls inside `AgentLoop` |

**Remaining coupling:** `AgentLoop` still assembles the full prompt, manages memory context injection, and coordinates between components. A dedicated `PromptAssembler` could further reduce coupling in v0.5+.

**Acceptance criteria:**

- [x] Agent loop components can be tested independently.
- [x] Tool planning has an explicit, inspectable representation.
- [x] Tool dependencies can be represented even if not fully optimized.
- [x] Native intent handling is no longer buried in the provider turn loop.
- [x] Cancellation and resume have a substrate, even if limited.
- [x] Artifact recording is cleaner and less coupled to the main loop.
- [ ] `createRuntime` uses a builder pattern or DI container. **Deferred. See `docs/planning/v0.4-builder-assessment.md`.**

**Non-goals:** Do not build full TaskFlow yet. Do not overbuild enforced skill workflows. Do not redesign memory yet.

---

## 8. Dependency Observations

The module-level dependency graph has these properties:

- **Contract layer is the foundation.** `src/contracts/` is imported by almost every other module. It contains pure types with no runtime logic.
- **Skill system is the largest leaf.** `src/skills/` has many internal dependencies but few external consumers outside the runtime.
- **Runtime is the integration hub.** `src/runtime/` imports from skills, tools, providers, memory, channels, and security.
- **CLI and channels are sibling consumers.** Both depend on the runtime but not on each other.
- **Circular dependencies are minimal.** Only 3 bidirectional pairs detected:
  - `config/runtime-config.ts` ↔ `contracts/image-generation.ts`
  - `contracts/intent.ts` ↔ `contracts/skill.ts`
  - `channels/channel-gateway.ts` ↔ `channels/channel-session-store.ts`

### Hotspots (Most-Imported Files)

| File | Import Count | Role |
|------|-------------|------|
| `contracts/tool.ts` | 44 | Tool definitions and risk classes |
| `contracts/skill.ts` | 38 | Skill definitions and workflow types |
| `contracts/provider.ts` | 30 | Provider request/response types |
| `contracts/security.ts` | 26 | Security policy and decision types |
| `config/runtime-config.ts` | 24 | Runtime configuration types |

---

## 9. Risk Register

| ID | Risk | Severity | Likelihood | Impact | Mitigation | Owner |
|----|------|----------|------------|--------|------------|-------|
| R01 | **AgentLoop monolith blocks v0.4+** | Critical | High | High | Decompose into Router/Planner/Executor/Recorder | **v0.4 ✅ Completed** |
| R02 | **create-runtime god factory** | High | High | Medium | Introduce DI container or builder pattern | v0.4 – assessment done; defer to v0.5+ |
| R03 | **No unit tests** | Critical | High | High | Extract unit tests from smoke; introduce Vitest | **v0.5** |
| R04 | **Bun lock-in prevents Node deployment** | High | Medium | Medium | Abstract SQLite behind interface | v0.4 |
| R05 | **Trajectory/Artifact are in-memory only** | Medium | High | Medium | Add SQLite persistence | **v0.5** |
| R06 | **smoke.ts at 14k lines** | Medium | High | Low | Split into per-subsystem test suites | **v0.5** |
| R07 | **Capability trust is a stub** | Medium | Low | High | Design manifest schema before v0.10 | v0.9–v0.10 |
| R08 | **No formal eval runner** | Medium | Medium | Medium | Integrate `scripts/eval-substrate.ts` | **v0.5** |
| R09 | **Memory rendering is dump-based** | Medium | Medium | Medium | Add selectivity/ranking | **v0.6** |
| R10 | **Provider message content assumes strings** | Low | High | Low | Widen content type support | v0.4 |
| R11 | **AGENTS.md drift** | Low | High | Low | Update project structure map | **v0.4 ✅ Completed** |
| R12 | **Telegram-only channels** | Medium | Low | Medium | Add more channel adapters | v0.9 |
| R13 | **Gateway readiness ≠ liveness** | Low | Medium | Low | Add daemon health checks | v0.9 |
| R14 | **Skill evals are metadata-only** | Medium | Medium | Medium | Add real task fixtures | **v0.7** |
| R15 | **OpenRouter exactness issues** | Medium | Medium | Medium | Provider-specific hardening | v0.4 |
| R16 | **MCP HTTP transport unproven** | Low | Low | Low | Operator validation | v0.9 |
| R17 | **Local/Ollama unproven** | Low | Low | Low | Environment-specific testing | v0.9 |
| R18 | **ACP editor polish incomplete** | Low | Medium | Low | Terminal/process rendering | v0.9 |

### Risk Heat Map

| | Low Likelihood | Medium Likelihood | High Likelihood |
|---|----------------|-------------------|-----------------|
| **Critical Severity** | — | — | R01, R03 |
| **High Severity** | R04 | — | R02 |
| **Medium Severity** | R07, R12 | R08, R09, R14, R15 | R05, R06 |
| **Low Severity** | R16, R17 | R13, R18 | R10, R11 |

---

## 10. Data Flow Summary

The primary end-to-end path:

1. Input arrives from CLI or Telegram
2. Runtime normalizes message + attachments
3. Prompt assembly builds a layered provider request
4. Provider responds with text and/or tool calls
5. Tool planner + executor run concrete actions under policy
6. Continuation prompt feeds tool results back if needed
7. Final output is formatted per surface
8. Session, memory, approvals, and trajectory state are persisted

---

## 11. Current Architectural Weak Spots

1. **AgentLoop monolith** — Was 2,714 lines, now 809 lines. Core orchestration remains but provider loop, tool execution, skill workflows, and native intents are extracted. Remaining coupling: prompt assembly, memory context injection, cross-component coordination.
2. **create-runtime.ts god factory** — 901 lines, 69 imports, 36 constructor calls, no DI boundary. Assessment in `docs/planning/v0.4-builder-assessment.md` recommends deferring a builder pattern.
3. **Trajectory/Artifact skeletons** — 97 and 56 lines, in-memory only.
4. **No unit tests** — 13,969-line smoke.ts is the only safety net. Deferred to v0.5.
5. **Bun lock-in** — `bun:sqlite` prevents Node execution.
6. **Telegram-only channels** — no other real launch channel.
7. **Gateway liveness** — readiness-focused, not daemon-tracking.
8. **Remaining cross-component state** — `AgentLoop` constructor still receives 20+ dependencies. Some (e.g., `memoryContext`, `projectContext`) are only used for prompt assembly and could move to a dedicated `PromptAssembler`.
