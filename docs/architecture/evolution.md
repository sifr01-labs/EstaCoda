---
title: "Evolution & Self-Improvement"
description: "Agent Evolution as a governed, reviewable self-improvement control plane."
---

# Evolution & Self-Improvement

EstaCoda improves its harness through **governed, reviewable, reversible** proposals — not silent runtime mutation. Agent Evolution is the user-facing control plane for that behavior. Routing quality is one evidence input, not the product identity.

## Core Principle

> Self-improvement is not silent mutation. It is evidence-backed, eval-tested, reviewable, reversible harness improvement.

The persisted compatibility key remains `skills.autonomy`. Setup and settings present the same value as Agent Evolution.

## Governed Loop

```
Runtime produces traces and route/outcome telemetry
  ↓
SkillLearningManager emits evidence and learning candidates
  ↓
SkillEvolutionStore records observations, candidates, proposals, evals, experiments, promotions, snapshots, rollback metadata, and experiment links
  ↓
SkillProposalService creates governed proposals and review metadata
  ↓
ChangeManifestStore owns change manifests with hypotheses, risks, gates, and rollback plans
  ↓
Human/operator review decides promotion
  ↓
Rollback remains manual/snapshot-backed where implemented
```

**Critical rule:** The runtime does not silently rewrite itself during normal user work.

## Current State

Implemented now:

- Agent Evolution policy derivation from `skills.autonomy`.
- Additive route/outcome telemetry fields for routing evidence, future correction signals, and final outcomes.
- Offline deterministic routing/evolution baseline fixture metrics.
- `SkillLearningManager` as an evidence source, not mutation authority.
- Reduced governed evolution change kinds: `skill_patch`, `skill_create`, `routing_metadata_update`.
- Durable `EvolutionExperiment` records.
- `estacoda proposal list` and `estacoda proposal inspect <id>` review surfaces for pending proposals and linked evidence/candidates/experiments/evals.

Autonomous behavior is shadow-only. It may record policy decisions and proposal metadata, but it does not auto-promote, auto-rollback, bypass approval gates, or mutate bundled/external skills.

## Change Manifest

Every proposed change carries an `EvolutionChangeManifest`:

```typescript
{
  id: string;
  target: "skill" | "tool_description" | "routing_metadata" | ...;
  filesChanged: string[];
  evidence: { traces, failures, evalCases, userCorrections };
  hypothesis: string;
  predictedImpact: string;
  riskLevel: "low" | "medium" | "high";
  evalCommand: string;
  constraintGates: string[];
  rollbackPlan: string;
  status: "proposed" | "testing" | "approved" | "rejected" | "promoted" | "reverted";
}
```

Manifest ownership is explicit:

- `SkillEvolutionStore` owns observations, learning candidates, proposals, eval/promotion/snapshot/rollback metadata, experiment records, and experiment links.
- `ChangeManifestStore` owns change manifests.
- `EvolutionExperiment` records may link to both evolution records and change manifests by ID.

## Self-Evolution Target Set (Staged)

| Stage | Target | Timing |
|-------|--------|--------|
| 1 | Skill instructions and metadata | implemented for governed patch proposals |
| 2 | Tool descriptions and routing hints | manifest/proposal skeletons implemented; application is future work |
| 3 | Memory promotion/rendering policy | planned |
| 4 | Eval fixtures and golden flows | partially implemented; richer eval execution is planned |
| 5 | Middleware/runtime strategy | future work |
| 6 | Runtime code evolution | future PR-only work |

## AHE Alignment

EstaCoda aligns with **Agentic Harness Engineering (AHE)** by Lin et al. (arXiv:2604.25850).

| AHE Pillar | EstaCoda Interpretation |
|-----------|------------------------|
| Component observability | Skills, tools, prompts, memory policy, middleware, workflows have file-level representations |
| Experience observability | Runs, traces, tool calls, failures, decisions, artifacts captured in structured evidence corpus |
| Decision observability | Every change declares hypothesis, predicted impact, eval plan, risk level, rollback plan |

## Export Format

The `OptimizationDataset` type provides clean JSON for external optimization pipelines:

```typescript
{
  version: "v0.1.0";
  generatedAt: string;
  meta: { skillCount, proposalCount, manifestCount, observationCount, evalRunCount };
  traces: [...];
  skillEvalRuns: [...];
  observations: [...];
  proposals: [...];
  manifests: [...];
}
```

Produced by `estacoda evolution export --dataset <path>`. No Python dependency.

## Non-Goals (Strict Exclusions)

1. No full autonomous runtime self-modification.
2. No direct code evolution.
3. No silent skill rewriting.
4. No full DSPy/GEPA integration — only clean JSON export.
5. No Python optimization pipeline.
6. No marketplace.
7. No enforced workflow for every skill.
8. No bypassing security/approval layers.
9. No broad semantic architecture inference.
10. No automatic memory policy evolution in the current release.
11. No embedding/vector search.
12. No semantic retrieval, compact skill index fallback, LLM reranking, taskClass routing, or supporting-candidate routing in the current implementation.
13. No advisory route tools such as `skill.reject_route` or `skill.search_routes` in the current implementation.
14. No real autonomous promotion, auto-rollback, skill fork/merge/archive, or hygiene scanning loop in the current implementation.

## Routing Boundary

Routing remains deterministic. Route telemetry, rejection/search-compatible contracts, and routing baseline metrics exist so Agent Evolution can evaluate routing quality, but they do not enable semantic retrieval, provider embeddings, reranking, compact skill indexes, supporting candidates, or advisory route tools.

## CLI Commands

| Command | Purpose |
|---------|---------|
| `estacoda proposal list` | List proposals with review metadata |
| `estacoda proposal inspect <id>` | Inspect a proposal with linked evidence/candidates/experiment/eval summaries |
| `estacoda proposal approve <id>` | Approve a proposal |
| `estacoda proposal reject <id>` | Reject a proposal |
| `estacoda proposal promote <id>` | Promote an approved proposal |
| `estacoda manifest list` | List all evolution manifests |
| `estacoda manifest inspect <id>` | Inspect a manifest |
| `estacoda curator status` | Show curator recommendations |
| `estacoda evolution export --dataset <path>` | Export optimization dataset |

## Sources

- Agentic Harness Engineering (AHE): https://arxiv.org/abs/2604.25850
