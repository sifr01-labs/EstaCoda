---
title: "Evolution & Self-Improvement"
description: "Governed skill evolution, evidence-backed proposals, and AHE-aligned harness improvement."
---

# Evolution & Self-Improvement

EstaCoda improves its harness through **governed, reviewable, reversible** proposals — not silent runtime mutation.

## Core Principle

> Self-improvement is not silent mutation. It is evidence-backed, eval-tested, reviewable, reversible harness improvement.

## Governed Loop

```
Runtime produces traces
  ↓
Curator distills evidence (SkillProposalService)
  ↓
Evolution pipeline proposes candidates (ChangeManifest)
  ↓
Evals and constraint gates select survivors
  ↓
Change manifests explain hypotheses and risks
  ↓
Human/operator review promotes accepted changes
  ↓
Rollback remains available
```

**Critical rule:** The runtime does not silently rewrite itself during normal user work.

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

## Self-Evolution Target Set (Staged)

| Stage | Target | Timing |
|-------|--------|--------|
| 1 | Skill instructions and metadata | v0.7 ✅ |
| 2 | Tool descriptions and routing hints | v0.7 ✅ (skeleton) |
| 3 | Memory promotion/rendering policy | v0.6–v0.10 |
| 4 | Eval fixtures and golden flows | v0.5–v0.10 |
| 5 | Middleware/runtime strategy | post-v0.10 |
| 6 | Runtime code evolution | post-MVP, PR-only |

## AHE Alignment

EstaCoda aligns with **Agentic Harness Engineering (AHE)** by Lin et al. (arXiv:2604.25850) and **Hermes Agent Self-Evolution** by Nous Research.

| AHE Pillar | EstaCoda Interpretation |
|-----------|------------------------|
| Component observability | Skills, tools, prompts, memory policy, middleware, workflows have file-level representations |
| Experience observability | Runs, traces, tool calls, failures, decisions, artifacts captured in structured evidence corpus |
| Decision observability | Every change declares hypothesis, predicted impact, eval plan, risk level, rollback plan |

## Export Format

The `OptimizationDataset` type provides clean JSON for external optimization pipelines:

```typescript
{
  version: "v0.7";
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
10. No automatic memory policy evolution in v0.7.
11. No embedding/vector search.

## CLI Commands

| Command | Purpose |
|---------|---------|
| `estacoda proposal list` | List skill patch proposals |
| `estacoda proposal inspect <id>` | Inspect a proposal |
| `estacoda proposal approve <id>` | Approve a proposal |
| `estacoda proposal reject <id>` | Reject a proposal |
| `estacoda proposal promote <id>` | Promote an approved proposal |
| `estacoda manifest list` | List all evolution manifests |
| `estacoda manifest inspect <id>` | Inspect a manifest |
| `estacoda curator status` | Show curator recommendations |
| `estacoda evolution export --dataset <path>` | Export optimization dataset |

## Sources

- Agentic Harness Engineering (AHE): https://arxiv.org/abs/2604.25850
- Hermes Agent Self-Evolution: https://github.com/NousResearch/hermes-agent-self-evolution
