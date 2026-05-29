---
title: "Skills"
description: "Skill system: loading, registry, execution, evolution, and learning."
---

# Skills

The skill system is the most mature subsystem in EstaCoda. It provides procedural knowledge to the agent through Markdown-first documents that are progressively disclosed.

## Files

| File | Lines | Role |
|------|-------|------|
| `src/skills/skill-loader.ts` | 916 | Load skills from official, personal, project, and external roots |
| `src/skills/skill-registry.ts` | ~180 | Hold loaded skills, filter visibility |
| `src/skills/skill-tools.ts` | 2,292 | Agent-facing skill CRUD tools |
| `src/skills/skill-evolution.ts` | ~666 | Propose, review, approve, reject, promote patches |
| `src/skills/skill-learning.ts` | ~240 | Observe workflows and create project skills |
| `src/skills/skill-workflow-planner.ts` | ~140 | Compile skill workflow plans |
| `src/skills/skill-usage-telemetry.ts` | ~120 | Usage tracking and route telemetry |
| `src/skills/skill-bundled-sync.ts` | ~100 | Sync bundled official skills |
| `src/skills/skill-visibility.ts` | ~80 | Runtime visibility filtering |
| `src/skills/skill-mutation-policy.ts` | ~160 | Promotion gates and trust checks |
| `src/skills/skill-curator-status.ts` | ~100 | Curator status and proposal listing |

## Skill Sources

| Source | Directory | Mutability | Evidence |
|--------|-----------|------------|----------|
| `official` | Bundled in repo | Read-only (local working copies for evolution) | `smoke-tested` |
| `personal` | `~/.estacoda/skills/` | Mutable | `smoke-tested` |
| `project` | `<workspace>/.estacoda/skills/` | Mutable | `smoke-tested` |
| `external` | Configured `externalSkillRoots` | Read-only | `smoke-tested` |

## Execution Model

**Provider-backed:** By default, skill instructions are injected into the system prompt and the provider executes the workflow. `implemented but not live-proven`

**Deterministic fallback:** If no provider is available, a deterministic path executes the workflow steps directly. `smoke-tested`

**Resources:** `references/`, `templates/`, `scripts/`, and compatible `assets/` are indexed and loaded on demand. `smoke-tested`

## Visibility

- Visibility is **session-stable**. Once a session starts, the visible skill catalog does not change.
- Filtered by runtime conditions (provider capability, trust level, etc.).
- Refreshed on `/reset` or new session.

## Operations

The agent can perform these operations via `skill-tools.ts`:

| Operation | Evidence |
|-----------|----------|
| `list` | `smoke-tested` |
| `view` | `smoke-tested` |
| `inspect` | `smoke-tested` |
| `create` | `smoke-tested` |
| `patch` | `smoke-tested` |
| `edit` | `smoke-tested` |
| `delete` | `smoke-tested` |
| `write_file` | `smoke-tested` |
| `remove_file` | `smoke-tested` |
| `import` | `smoke-tested` |
| `export` | `smoke-tested` |

## Evolution

Skill evolution is **governed, not autonomous**. The system improves skills through an evidence-backed, reviewable, reversible pipeline.

**Governed loop:**

```
observe → propose → review → approve/reject → promote → rollback (if needed)
```

**Current capabilities:**

| Capability | Status |
|------------|--------|
| Usage telemetry (`skill-usage-telemetry.ts`) | `smoke-tested` |
| Observe with `candidateImprovement` → auto-create ChangeManifest | `smoke-tested` |
| Propose patches (`skill-evolution.ts`) | `smoke-tested` |
| Review proposals with trust/risk scoring | `smoke-tested` |
| Approve/reject/promote via agent tools and CLI | `smoke-tested` |
| Eval-gated promotion (failing eval blocks promotion) | `smoke-tested` |
| Promotion gates (untrusted-source blocking) | `smoke-tested` |
| Eval deltas in promotion records | `smoke-tested` |
| Rollback tool (`skill.rollback`) | `smoke-tested` |
| ChangeManifestStore wired into runtime (no longer orphaned) | `smoke-tested` |
| Tool-description proposal skeleton (`target: "tool_description"`) | `smoke-tested` |
| Routing-metadata proposal skeleton (`target: "routing_metadata"`) | `smoke-tested` |
| DSPy/GEPA-compatible export (`estacoda evolution export`) | `smoke-tested` |

**What "governed" means:**

- Proposed changes carry a `ChangeManifest` with hypothesis, predicted impact, risk level, eval plan, constraint gates, and rollback plan.
- High-risk or untrusted proposals require explicit approval before promotion.
- Promotion runs eval gates; failing gates block the promotion.
- No silent mutation — every change is logged, reviewable, and reversible.
- Bundled skills evolve only through local working copies.
- External skills remain read-only.

**Limitations:**

- Skill evals are metadata/workflow-scoring only. No real task fixture execution yet.
- Tool-description and routing-metadata proposals are representable as manifest targets but not auto-applied.
- No autonomous proposal generation from observations (observations create lightweight manifests; full proposals require explicit `skill.propose_patch`).
- `skill` namespace CLI (`estacoda skill list`, `estacoda skill inspect`) is deferred to post-v0.7.

**CLI surface:**

```bash
estacoda proposal list [--skill <name>] [--status <s>]
estacoda proposal inspect <id>
estacoda proposal approve <id>
estacoda proposal reject <id>
estacoda proposal promote <id>
estacoda manifest list [--target <t>] [--status <s>]
estacoda manifest inspect <id>
estacoda curator status
estacoda evolution export --dataset <path> [--since <date>] [--skill <name>]
```

## Agent Evolution

Agent Evolution controls whether EstaCoda may learn reusable Skills from workflow patterns. The persisted config key is `skills.autonomy`; the user-facing setup label is Agent Evolution.

| Mode | Behavior |
|------|----------|
| `none` | Agent Evolution is off |
| `suggest` | Records candidates after repeated success; does not write files |
| `proactive` | Auto-creates project skills after repeated successful bounded local workflows |
| `autonomous` | Auto-creates after first successful bounded local workflow |

## Contracts

Key types in `src/contracts/skill.ts`:

- `SkillDefinition`
- `LoadedSkill`
- `SkillCatalogEntry`
- `SkillWorkflowPlan`
- `SkillWorkflowPlanStep`
- `SkillOutcome`
