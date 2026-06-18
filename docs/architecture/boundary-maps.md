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
- SkillLearningManager → MemoryStore (Agent Evolution state)

## Skill Runtime Boundary

```
┌───────────────────────────────────────────────────────┐
│  SkillRegistry                                          │
│  ───────────────────────────────────────────────────────  │
│  SkillLoader → skill-loader.ts                          │
│  SkillEvolutionStore → skill-evolution.ts                │
│  SkillLearningManager → skill-learning.ts               │
│  SkillTools → src/tools/skill-tools.ts                  │
├───────────────────────────────────────────────────────┤
│  Consumers: AgentLoop, CLI slash commands, skill-tools    │
└───────────────────────────────────────────────────────┘
```

**Inbound boundaries:**
- `SkillLoader` loads from official, personal, project, and external roots.
- `SkillEvolutionStore` receives observations, candidates, proposals, promotion records, snapshots, and rollback metadata.
- `SkillLearningManager` observes completed turns and emits evidence/candidates; it does not create or promote live skills directly.

**Outbound boundaries:**
- `AgentLoop` reads selected skill instructions and resources.
- `SkillTools` exposes CRUD operations to the agent.
- `skill-mutation-policy.ts` enforces promotion gates.

**Crosses:**
- AgentLoop → SkillRegistry (read skill instructions)
- AgentLoop → SkillLearningManager (observe outcomes)
- SkillTools → SkillEvolutionStore (propose/approve/reject)
- SkillLearningManager → MemoryStore (Agent Evolution state)

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
│  TrajectoryRecorder (in-memory recorder per trajectory)     │
│  SQLiteSessionDB (persistent trajectories + failures)      │
│  FailureClassifier (maps events/errors to FailureClass)    │
│  redaction helpers (function-based trace export redaction) │
│  EvalRunner (runs the default deterministic fixture set)   │
│  GoldenFlowCompare (baseline comparison helper)            │
│  ChangeManifestStore (JSONL change manifests)              │
│  ───────────────────────────────────────────────────────  │
│  Events captured:                                          │
│    - session-start, user-input, context-expanded           │
│    - skill-selected, skill-playbook-planned                │
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

**Current state:** Contracts define trajectory event kinds and failure classes. Trajectories and classified failures persist to SQLite. Trace data is inspectable from the CLI with redacted output by default. The eval runner executes the fixture set exported by `src/eval/fixtures/index.ts`; golden-flow comparison and change manifests provide supporting evidence for governed evolution work.

**Remaining gap:** No visual dashboard. No real-time trace streaming. No scored benchmark or automated regression gate across historical runs. Agent Evolution remains governed: evidence and proposals are recorded, but live promotion remains review-gated.
