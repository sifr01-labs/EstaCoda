---
title: "Runtime Components"
description: "Breakdown of EstaCoda's runtime: AgentLoop, createRuntime, registries, and executors."
---

# Runtime Components

## AgentLoop

**File:** `src/runtime/agent-loop.ts`
**Size:** 809 lines
**Exports:** `AgentLoop`, `AgentLoopInput`, `AgentLoopResponse`, `AgentLoopOptions`

`AgentLoop` is the orchestration lifecycle. A single `handle()` call processes one user turn end to end, but delegates execution to specialized components.

### Constructor dependencies

| Dependency | Type | Purpose |
|------------|------|---------|
| `runRecorder` | `RunRecorder` | Record run events and outcomes |
| `runtimeRouter` | `RuntimeRouter` | Route intent + skill selection |
| `toolPlanRunner` | `ToolPlanRunner` | Execute tool plans under policy |
| `providerTurnLoop` | `ProviderTurnLoop` | Stream provider responses and extract tool calls |
| `skillWorkflowExecutor` | `SkillWorkflowExecutor` | Execute skill workflow plans |
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

### Internal phases (as they exist after v0.4 decomposition)

| Phase | Delegated to | Description |
|-------|-------------|-------------|
| Input normalization | `AgentLoop` | Attachments, references, preflight |
| Intent routing | `RuntimeRouter` | Native intent + skill selection |
| Security assessment | `AgentLoop` | Policy decision, risk escalation |
| Skill workflow setup | `SkillWorkflowExecutor` | Compile workflow plan, load resources |
| Prompt assembly | `AgentLoop` | Layered prompt construction |
| Provider loop | `ProviderTurnLoop` | Streaming, tool-call extraction, iteration |
| Tool execution | `ToolPlanRunner` | Plan conversion, execution, result packets |
| Native intent execution | `NativeToolExecutor` | Deterministic paths (image-gen, voice, attachments) |
| Memory promotion | `AgentLoop` | Post-run preference/fact promotion |
| Artifact collection | `AgentLoop` | Gather artifacts from tool results |
| Response formatting | `AgentLoop` | Final text + progress + artifacts |

> **Status:** v0.4 extracted provider loop, tool execution, skill workflows, and native intents. `AgentLoop` retains orchestration, prompt assembly, security gating, memory promotion, and response formatting.

---

## createRuntime

**File:** `src/runtime/create-runtime.ts`
**Size:** 901 lines
**Exports:** `createRuntime`, `RuntimeOptions`

The composition root. Every subsystem is instantiated here with explicit constructor arguments. After v0.4, it also constructs six extracted runtime components before passing them to `AgentLoop`.

Runtime config is loaded from exactly one selected profile: an explicit `profileId`, the active profile, or `default`. There is no user/project config merge. Workspace trust is only a behavioral gating input for local actions and MCP startup; it does not change which config file is loaded.

State ownership after the C2 profile overhaul:

- Profile config, secrets, OAuth auth, identity memory, skills, cron state, gateway state, logs, caches, and channel media live under `~/.estacoda/profiles/<id>/`.
- The session database is global at `~/.estacoda/sessions.sqlite`, with rows scoped by `profile_id`.
- Workspace trust and workspace approvals are global directory-owned state in `trust.json` and `workspace-approvals.json`.
- Global shared memory lives only under `~/.estacoda/memory/shared/`.

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
23. `RunRecorder` (extracted in v0.4)
24. `ToolPlanRunner` (extracted in v0.4)
25. `ProviderTurnLoop` (extracted in v0.4)
26. `SkillWorkflowExecutor` (extracted in v0.4)
27. `NativeToolExecutor` (extracted in v0.4)
28. `RuntimeRouter` (extracted in v0.4)
29. `AgentLoop`

> **Risk:** Any constructor signature change cascades through this file. There is no DI container or plugin boundary. See `docs/planning/v0.4-builder-assessment.md` for assessment.

---

## Extracted Runtime Components (v0.4)

### RuntimeRouter

**File:** `src/runtime/runtime-router.ts`
**Role:** Combines `IntentRouter` output with skill configuration to produce a unified routing decision. Separates routing policy from loop execution.

### ProviderTurnLoop

**File:** `src/runtime/provider-turn-loop.ts`
**Role:** Owns the provider streaming loop: send prompt, collect tokens, assemble tool-call fragments, build continuation packets, enforce iteration budgets. Previously embedded in `AgentLoop`.

### ToolPlanRunner

**File:** `src/runtime/tool-plan-runner.ts`
**Role:** Converts provider tool calls into executable plans, manages safe-tool concurrency, handles failure caps, and builds result packets for continuation. Previously embedded in `AgentLoop`.

### SkillWorkflowExecutor

**File:** `src/runtime/skill-workflow-executor.ts`
**Role:** Executes skill workflow plans (deterministic and provider-backed), loads skill resources, and manages workflow state transitions. Previously embedded in `AgentLoop`.

### NativeToolExecutor

**File:** `src/runtime/native-tool-executor.ts`
**Role:** Executes deterministic native intents (image generation, voice transcription, attachment analysis) without provider involvement. Keeps product-owned paths separate from general tool execution.

### RunRecorder

**File:** `src/runtime/run-recorder.ts`
**Role:** Records run events, tool calls, outcomes, and artifacts to the session DB. Provides structured run history for v0.5 observability work.

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
| TrajectoryRecorder | `src/trajectory/trajectory-recorder.ts` | Record events (97 lines, in-memory) |
| ArtifactStore | `src/artifacts/artifact-store.ts` | Store artifacts (56 lines, in-memory) |
