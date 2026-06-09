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
| `src/skills/skill-evolution.ts` | ~1,100 | Store observations, candidates, proposals, experiments, evals, promotions, snapshots, and rollback metadata |
| `src/skills/skill-learning.ts` | ~240 | Observe completed turns and emit evidence/candidates; not mutation authority |
| `src/skills/skill-playbook-planner.ts` | ~140 | Compile skill playbook plans |
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

Skill evolution is **governed, not autonomous mutation**. In Phase 1A, Agent Evolution is the user-facing control plane for reviewable self-improvement: policy, route/outcome telemetry, evidence, learning candidates, governed proposals, experiment records, and review listings.

**Governed loop:**

```
observe → evidence/candidate → proposal → eval/review → manual promotion → rollback if needed
```

**Current capabilities:**

| Capability | Status |
|------------|--------|
| Usage telemetry (`skill-usage-telemetry.ts`) | `smoke-tested` |
| Agent Evolution policy derived from persisted `skills.autonomy` | `tested` |
| Route/outcome telemetry fields for routing evidence and future advisory signals | `tested` |
| SkillLearningManager observes completed turns and emits evidence/candidates | `tested` |
| Governed proposal kinds: `skill_patch`, `skill_create`, `routing_metadata_update` | `tested` |
| EvolutionExperiment records for evidence/proposal/metric grouping | `tested` |
| `estacoda proposal list` review queue and `inspect` detail view | `tested` |
| Observe with `candidateImprovement` → create ChangeManifest | `smoke-tested` |
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

- `SkillLearningManager` is an evidence source. It does not directly create, patch, promote, or mutate skills as final authority.
- `SkillEvolutionStore` owns observations, learning candidates, proposals, eval/promotion/snapshot/rollback metadata, experiment records, and experiment links.
- `ChangeManifestStore` owns change manifests. Evolution records may link to manifests, but manifests are not stored in `SkillEvolutionStore`.
- Proposed manifest-backed changes carry a `ChangeManifest` with hypothesis, predicted impact, risk level, eval plan, constraint gates, and rollback plan.
- High-risk or untrusted proposals require explicit approval before promotion.
- Promotion runs eval gates; failing gates block the promotion.
- No silent mutation — every change is logged, reviewable, and reversible.
- Bundled and external skill assets are not mutated. Bundled skills can be shadowed only by local/profile-owned working copies.
- Autonomous mode in Phase 1A is shadow-only: it records policy decisions and proposal metadata, but it does not auto-promote, auto-rollback, or bypass gates.
- Routing remains deterministic in Phase 1A. Routing quality telemetry is evidence for Agent Evolution, not a new routing system.

**Limitations:**

- Skill evals are metadata/workflow-scoring only. No real task fixture execution yet.
- Tool-description and routing-metadata proposals are representable as manifest targets but not auto-applied.
- No autonomous promotion or rollback automation.
- No semantic retrieval, provider embeddings, compact skill index fallback, or LLM reranking.
- No taskClass routing, supporting candidates, or advisory route tools such as `skill.reject_route` and `skill.search_routes`.
- No skill fork/merge/archive governed proposal operations in Phase 1A.
- No hygiene scanning loop for automatic proposal creation.
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

Agent Evolution is the user-facing control plane for EstaCoda's reviewable self-improvement behavior. The persisted compatibility key remains `skills.autonomy`; setup and settings present it as Agent Evolution.

| Mode | Behavior |
|------|----------|
| `none` | No Agent Evolution evidence or proposals |
| `suggest` | Records evidence/candidates and creates reviewable proposal records; no promotion |
| `proactive` | Prepares stronger review proposals and eval metadata; asks before promotion |
| `autonomous` | Records shadow-only autonomous decisions and proposal metadata; no real auto-promotion or auto-rollback in Phase 1A |

Roadmap behavior must remain labeled as planned until implemented: semantic/local retrieval, embeddings, reranking, compact skill index fallback, taskClass routing, supporting candidates, advisory route tools, real autonomous promotion, auto-rollback, skill fork/merge/archive, and hygiene scanning.

## Contracts

Key types in `src/contracts/skill.ts`:

- `SkillDefinition`
- `LoadedSkill`
- `SkillCatalogEntry`
- `CompiledSkillPlaybook`
- `CompiledSkillPlaybookStep`
- `SkillOutcome`
