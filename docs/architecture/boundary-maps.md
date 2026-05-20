---
title: "Boundary Maps"
description: "Cross-subsystem boundary analysis for memory, skills, provider loop, and observability."
---

# Boundary Maps

## Memory Boundary

```
┌───────────────────────────────────────────────────────┐
│  MemoryStore (bounded files)                          │
│  ───────────────────────────────────────────────────────  │
│  USER.md  ←──── LocalMemoryProvider ────→  AgentLoop  │
│  MEMORY.md ←─── (read/write/promote)   (per-turn context)  │
│  SOUL.md   ←─────────────────────────────────────────  │
└───────────────────────────────────────────────────────┘
```

**Inbound boundaries:**
- Startup loads profile memory into the runtime `MemoryStore`.
- `MemoryRecallOrchestrator` prepares prompt memory context per turn.
- `LocalMemoryProvider` reads `USER.md`, `MEMORY.md`, `SOUL.md` from disk.
- `memory-promotion.ts` promotes repeated preferences and facts after the response path.

**Outbound boundaries:**
- `memory-tool.ts` exposes `memory.curate` with `kind: append | replace | remove`.
- `memory-promotion.ts` writes promoted content back to disk.
- Changes during a session are persisted immediately and can affect later turns in the same runtime because prompt memory context is rebuilt per turn.

**Crosses:**
- AgentLoop → MemoryRecallOrchestrator → MemoryPromptContextBuilder
- AgentLoop → MemoryRecallOrchestrator → SessionRecallService for eligible recall turns
- ProviderTurnLoop consumes prepared memory context; it does not decide recall policy
- AgentLoop → memory-promotion (triggers post-run promotion)
- SkillLearningManager → MemoryStore (workflow learning state)

## Skill Runtime Boundary

```
┌───────────────────────────────────────────────────────┐
│  SkillRegistry                                          │
│  ───────────────────────────────────────────────────────  │
│  SkillLoader → skill-loader.ts                          │
│  SkillEvolutionStore → skill-evolution.ts                │
│  SkillLearningManager → skill-learning.ts               │
│  SkillTools → skill-tools.ts                            │
├───────────────────────────────────────────────────────┤
│  Consumers: AgentLoop, CLI slash commands, skill-tools    │
└───────────────────────────────────────────────────────┘
```

**Inbound boundaries:**
- `SkillLoader` loads from official, personal, project, and external roots.
- `SkillEvolutionStore` receives proposed patches from usage telemetry.
- `SkillLearningManager` observes workflow execution and creates project skills.

**Outbound boundaries:**
- `AgentLoop` reads selected skill instructions and resources.
- `SkillTools` exposes CRUD operations to the agent.
- `skill-mutation-policy.ts` enforces promotion gates.

**Crosses:**
- AgentLoop → SkillRegistry (read skill instructions)
- AgentLoop → SkillLearningManager (observe outcomes)
- SkillTools → SkillEvolutionStore (propose/approve/reject)
- SkillLearningManager → MemoryStore (workflow learning state)

## Provider–Tool Loop Boundary

```
┌───────────────────────────────────────────────────────┐
│  ProviderExecutor ←→ AgentLoop ←→ ToolExecutor           │
│  ───────────────────────────────────────────────────────  │
│  1. AgentLoop assembles prompt                              │
│  2. ProviderExecutor streams response                       │
│  3. AgentLoop extracts tool calls                           │
│  4. ToolCallPlanner converts to plans                       │
│  5. ToolExecutor runs tools under SecurityPolicy            │
│  6. AgentLoop builds continuation prompt                    │
│  7. Repeat until no tool calls or budget exhausted          │
└───────────────────────────────────────────────────────┘
```

**Key boundary:** The loop currently owns the iteration cycle. The provider does not know about tools; the tool executor does not know about providers. Only the loop bridges them.

**Risk:** The loop is the only place where provider responses, tool plans, security decisions, and memory promotion meet. This makes the loop irreplaceable without rewriting the entire system.

## Observability & Eval Boundary

```
┌───────────────────────────────────────────────────────┐
│  TrajectoryRecorder (101 lines, in-memory per session)     │
│  SQLiteSessionDB (persistent trajectories + failures)      │
│  FailureClassifier (325 lines, 13 classes)                 │
│  RedactionEngine (130 lines, safe-by-default)              │
│  EvalRunner (118 lines, 3 deterministic fixtures)          │
│  GoldenFlowCompare (65 lines, baseline assertion)          │
│  ChangeManifestStore (137 lines, JSONL proposals)          │
│  ───────────────────────────────────────────────────────  │
│  Events captured:                                          │
│    - session-start, user-input, context-expanded           │
│    - skill-selected, skill-workflow-planned                │
│    - tool-plan, tool-call, tool-gated, tool-result         │
│    - artifact-created, memory-write                        │
│    - provider-completion, provider-continuation            │
│    - security-risk-escalated, agent-cancelled              │
│    - assistant-output, session-end                         │
│  CLI inspection:                                           │
│    - estacoda trace list|dump|timeline|failures            │
│    - estacoda eval [fixture-id]                            │
└───────────────────────────────────────────────────────┘
```

**Current state:** Contracts define 32 event kinds. Trajectories persist to SQLite. Failures are classified. Traces are inspectable via CLI. Eval fixtures run automatically. Golden flows provide baselines. Change manifests prepare for v0.7 evolution.

**Remaining gap:** No visual dashboard. No real-time streaming. No automated regression detection across runs. No self-evolution pipeline (candidate generation, evaluation, promotion).
