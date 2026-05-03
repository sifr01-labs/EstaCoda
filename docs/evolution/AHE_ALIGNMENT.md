# AHE Alignment: EstaCoda v0.7

**Document Type:** Architecture alignment brief
**Date:** 2026-05-03
**Source:** Agentic Harness Engineering (AHE) by Lin et al. (arXiv:2604.25850)
**Hermes reference:** NousResearch/hermes-agent-self-evolution

---

## Core Principle

> Self-improvement is not silent mutation. It is evidence-backed, eval-tested, reviewable, reversible harness improvement.

---

## AHE Pillars Mapped to EstaCoda

### 1. Component Observability

Every harness component that can be improved has a file-level or manifest-level representation:

| Component | Representation | Inspectable | Diffable | Revertible |
|-----------|---------------|-------------|----------|------------|
| Skills | `SKILL.md` + directory | ✅ Yes | ✅ Yes (git) | ✅ Yes (rollback tool) |
| Tool descriptions | `ToolDefinition` in code | ✅ Yes | ✅ Yes | ✅ Yes |
| Routing metadata | Skill `routing` frontmatter | ✅ Yes | ✅ Yes | ✅ Yes |
| Memory policy | Code (not yet extractable) | ⚠ Partial | ❌ No | ❌ No |
| Prompt sections | Code (not yet extractable) | ⚠ Partial | ❌ No | ❌ No |
| Middleware | Implicit in runtime | ❌ No | ❌ No | ❌ No |
| Workflows | Skill frontmatter | ✅ Yes | ✅ Yes | ✅ Yes |
| Eval fixtures | Code | ✅ Yes | ✅ Yes | ✅ Yes |

**v0.7 scope:** Skills, tool descriptions, and routing metadata are observable and mutable. Memory policy, prompt sections, and middleware remain implicit and are excluded from self-evolution in v0.7.

### 2. Experience Observability

Every run produces structured evidence:

| Data Type | Captured | Structured | Linked to Skills |
|-----------|----------|------------|------------------|
| Runs | ✅ Yes | ✅ Trajectory | ✅ Yes |
| Traces | ✅ Yes | ✅ 32 event kinds | ✅ Yes |
| Tool calls | ✅ Yes | ✅ Yes | ✅ Yes |
| Failures | ✅ Yes | ✅ 13 classes | ⚠ Partial |
| User corrections | ✅ Yes | ✅ v0.7 | ⚠ Partial |
| Eval results | ✅ Yes | ✅ Yes | ✅ Yes |
| Artifacts | ✅ Yes | ✅ Yes | ⚠ Partial |
| Memory promotions | ✅ Yes | ✅ Yes | ✅ Yes |

### 3. Decision Observability

Every proposed change carries a `ChangeManifest`:

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

Every manifest declares its hypothesis, predicted impact, eval plan, risk level, and rollback plan before promotion.

---

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

---

## Self-Evolution Target Set (Staged)

| Stage | Target | Timing |
|-------|--------|--------|
| 1 | Skill instructions and metadata | v0.7 ✅ |
| 2 | Tool descriptions and routing hints | v0.7 ✅ (skeleton) |
| 3 | Memory promotion/rendering policy | v0.6–v0.10 |
| 4 | Eval fixtures and golden flows | v0.5–v0.10 |
| 5 | Middleware/runtime strategy | post-v0.10 |
| 6 | Runtime code evolution | post-MVP, PR-only |

---

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

---

## Export Format

The `OptimizationDataset` type in `src/evolution/export-format.ts` provides a clean JSON schema for external optimization pipelines:

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

No Python dependency. Produced by `estacoda evolution export --dataset <path>`.
