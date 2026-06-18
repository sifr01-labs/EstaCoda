---
title: "Skills"
description: "Skill system: loading, registry, execution, evolution, and learning."
---

# Skills

The skill system is the most mature subsystem in EstaCoda. It provides procedural knowledge to the agent through Markdown-first documents that are progressively disclosed.

## Files

| File | Role |
|------|------|
| `src/skills/skill-loader.ts` | Load and validate skill directories |
| `src/skills/skill-registry.ts` | Hold loaded skills, resolve source conflicts, and expose catalogs |
| `src/tools/skill-tools.ts` | Agent-facing `skill.*` tools for inspection, mutation, proposals, eval gates, rollback, import, and export |
| `src/skills/skill-evolution.ts` | Store observations, candidates, proposals, experiments, evals, promotions, snapshots, and rollback metadata |
| `src/skills/skill-learning.ts` | Observe completed turns and emit evidence/candidates; not mutation authority |
| `src/skills/skill-proposal-service.ts` | Convert candidates into governed proposals and run promotion gates |
| `src/skills/change-manifest-store.ts` | Persist JSONL change manifests linked from proposals |
| `src/skills/skill-playbook-planner.ts` | Compile skill playbook plans |
| `src/skills/skill-usage-telemetry.ts` | Usage tracking and route telemetry |
| `src/skills/skill-bundled-sync.ts` | Bundled-skill sync helper |
| `src/skills/skill-visibility.ts` | Runtime visibility filtering |
| `src/skills/skill-mutation-policy.ts` | Trust and mutation checks |
| `src/skills/skill-curator-status.ts` | Curator status and proposal listing |

## Skill Sources

| Source | Directory | Mutability | Load order |
|--------|-----------|------------|------------|
| `external` packs | `~/.estacoda/profiles/<profile-id>/skills/packs/` | Managed/materialized by pack flows | Loaded first, lowest priority |
| `bundled` | `skills/official/` in the package/repo | Read-only package content | Loaded after packs |
| `local` | `~/.estacoda/profiles/<profile-id>/skills/` | Profile-local mutable skills | Loaded after bundled skills and can shadow lower-priority sources |
| `external` configured roots | `skills.externalDirs` / runtime `externalSkillRoots` | Operator-controlled external roots | Loaded from configured directories |

The runtime does not currently load `<workspace>/.estacoda/skills/` as a project-skill root. Workspace context is loaded separately from project context files.

## Execution Model

**Provider-backed:** In normal provider-backed turns, selected skill instructions and resources are exposed through prompt/context assembly. The provider still chooses output and tool calls; deterministic safety gates remain outside the skill text.

**Playbook planning:** `src/skills/skill-playbook-planner.ts` compiles declared playbook steps for deterministic planning and inspection surfaces.

**Resources:** `references/`, `templates/`, `scripts/`, and compatible `assets/` are indexed and loaded on demand by the skill loader.

## Python Capabilities

A skill can declare that it needs a runtime-registered Python capability:

```yaml
pythonCapabilities:
  - id: example-capability
    required: true
    groups: []
```

For example, a future registered capability could expose an optional group:

```yaml
pythonCapabilities:
  - id: ocr-and-documents
    required: true
    groups: []
  - id: ocr-and-documents
    required: false
    groups: ["advancedOcr"]
```

The skill declaration is not a package manifest. Each entry may contain only `id`, `required`, and `groups`.

The runtime registry owns package names, package versions, import checks, install paths, and optional group definitions. Unknown capability IDs, unknown groups, and unknown metadata keys fail validation according to the skill loader rules.

Normal skill execution resolves only already-installed and verified environments. It does not run `pip`, create virtualenvs, or repair missing dependencies.

## Visibility

- Visibility is **session-stable**. Once a session starts, the visible skill catalog does not change.
- Filtered by runtime conditions (provider capability, trust level, etc.).
- Refreshed on `/reset` or new session.

## Operations

The agent-facing surface is the `skill` toolset implemented in `src/tools/skill-tools.ts`. Current tool names include:

| Area | Tools |
|------|-------|
| Read/inspect | `skill.list`, `skill.view`, `skill.inspect`, `skill.eval`, `skill.usage` |
| Learning and proposals | `skill.observe`, `skill.propose_patch`, `skill.list_proposals`, `skill.review_proposals`, `skill.review_proposal`, `skill.approve_patch`, `skill.reject_patch`, `skill.promote_patch` |
| Mutation | `skill.create`, `skill.patch`, `skill.edit`, `skill.delete`, `skill.rollback`, `skill.reset`, `skill.write_file`, `skill.remove_file` |
| Portability | `skill.import`, `skill.export` |

## Evolution

Skill evolution is **governed, not autonomous mutation**. Agent Evolution is the user-facing control plane for reviewable self-improvement: policy, route/outcome telemetry, evidence, learning candidates, governed proposals, experiment records, and review listings.

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
- Autonomous mode is shadow-only: it records policy decisions and proposal metadata, but it does not auto-promote, auto-rollback, or bypass gates.
- Routing remains deterministic. Routing quality telemetry is evidence for Agent Evolution, not a new routing system.

**Limitations:**

- Skill promotion eval gates are metadata/playbook assertions. The default deterministic eval fixtures test surrounding skill/evolution behavior, but proposal promotion does not execute open-ended task fixtures.
- Tool-description and routing-metadata proposals are representable as manifest targets but not auto-applied.
- No autonomous promotion or rollback automation.
- No semantic retrieval, provider embeddings, compact skill index fallback, or LLM reranking.
- No taskClass routing, supporting candidates, or advisory route tools such as `skill.reject_route` and `skill.search_routes`.
- No skill fork/merge/archive governed proposal operations.
- No hygiene scanning loop for automatic proposal creation.
- The primary shipped CLI surfaces are `estacoda skills`, `estacoda proposal`, `estacoda manifest`, `estacoda curator`, and `estacoda evolution`. Do not document a separate `estacoda skill` namespace unless the command registry exposes it.

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
| `autonomous` | Records shadow-only autonomous decisions and proposal metadata; no real auto-promotion or auto-rollback |

Roadmap behavior must remain labeled as planned until implemented: semantic/local retrieval, embeddings, reranking, compact skill index fallback, taskClass routing, supporting candidates, advisory route tools, real autonomous promotion, auto-rollback, skill fork/merge/archive, and hygiene scanning.

## Contracts

Key types in `src/contracts/skill.ts`:

- `SkillDefinition`
- `LoadedSkill`
- `SkillCatalogEntry`
- `CompiledSkillPlaybook`
- `CompiledSkillPlaybookStep`
- `SkillOutcome`
