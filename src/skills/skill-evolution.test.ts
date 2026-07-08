import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ChangeManifestStore } from "./change-manifest-store.js";
import { SkillEvolutionStore } from "./skill-evolution.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "estacoda-skill-evolution-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("SkillEvolutionStore", () => {
  it("strips hidden reasoning from observations and evidence", async () => {
    const root = await makeTempDir();
    const store = new SkillEvolutionStore({
      usagePath: join(root, "usage.json"),
      evolutionRoot: join(root, "evolution")
    });

    await store.appendObservation({
      skillName: "demo",
      type: "note",
      promptSummary: "<think>private prompt</think>Visible prompt",
      lesson: "<reasoning>private lesson</reasoning>Visible lesson",
      candidateImprovement: "<thinking>private improvement</thinking>Visible improvement",
      evidence: {
        reasoning_content: "raw private reasoning",
        summary: "<think>private evidence</think>Visible evidence",
        ordinary: "Use <think> as the example tag.",
        nested: {
          reasoning: "nested private reasoning",
          safe: "Visible nested value",
          values: [
            {
              reasoning_details: {
                hidden: "nested details"
              },
              kept: "<thinking>private nested text</thinking>Visible nested text"
            }
          ]
        }
      }
    });

    const [observation] = await store.listObservations();
    expect(observation?.promptSummary).toBe("Visible prompt");
    expect(observation?.lesson).toBe("Visible lesson");
    expect(observation?.candidateImprovement).toBe("Visible improvement");
    expect(observation?.evidence?.summary).toBe("Visible evidence");
    expect(observation?.evidence?.ordinary).toBe("Use <think> as the example tag.");
    expect(observation?.evidence).not.toHaveProperty("reasoning_content");
    expect(observation?.evidence?.nested).toEqual({
      safe: "Visible nested value",
      values: [
        {
          kept: "Visible nested text"
        }
      ]
    });
    expect(JSON.stringify(observation)).not.toContain("private");
  });

  it("serializes and reloads Phase 1A governed proposal change kinds with review metadata", async () => {
    const root = await makeTempDir();
    const store = new SkillEvolutionStore({
      usagePath: join(root, "usage.json"),
      evolutionRoot: join(root, "evolution")
    });

    for (const changeKind of [
      "skill_patch",
      "skill_create",
      "routing_metadata_update",
      "routing_eval_addition",
      "negative_example_addition",
      "skill_consolidation"
    ] as const) {
      await store.appendGovernedProposal({
        skillName: `${changeKind}-target`,
        reason: `${changeKind} hypothesis`,
        confidence: 0.8,
        evidenceIds: [`obs-${changeKind}`],
        changeKind,
        targetSurface: (
          changeKind === "routing_metadata_update" ||
          changeKind === "routing_eval_addition" ||
          changeKind === "negative_example_addition"
        ) ? "routing_metadata" : "skill",
        affectedSurface: `${changeKind}-surface`,
        affectedFiles: [`skills/${changeKind}/SKILL.md`],
        hypothesis: `${changeKind} hypothesis`,
        riskClass: changeKind === "skill_patch" ? "low" : "medium",
        authorityExpansion: changeKind === "skill_create",
        sourceKind: "local",
        evalPlan: {
          command: "pnpm run eval:fixtures",
          constraintGates: ["pnpm run typecheck", "pnpm run smoke"],
          expectedMetrics: ["primary_skill_precision"]
        },
        rollbackExpectation: `${changeKind} rollback expectation`,
        policyDecision: {
          mode: "suggest",
          createProposals: true,
          shadowOnly: false,
          allowed: true,
          requiresApproval: true
        },
        approvalState: "required"
      });
    }

    const reloaded = new SkillEvolutionStore({
      usagePath: join(root, "usage.json"),
      evolutionRoot: join(root, "evolution")
    });
    const proposals = await reloaded.listProposals();

    expect(proposals.map((proposal) => proposal.changeKind).sort()).toEqual([
      "negative_example_addition",
      "routing_eval_addition",
      "routing_metadata_update",
      "skill_consolidation",
      "skill_create",
      "skill_patch"
    ]);
    expect(proposals).toContainEqual(expect.objectContaining({
      changeKind: "skill_patch",
      evidenceIds: ["obs-skill_patch"],
      hypothesis: "skill_patch hypothesis",
      riskClass: "low",
      authorityExpansion: false,
      sourceKind: "local",
      evalPlan: expect.objectContaining({ command: "pnpm run eval:fixtures" }),
      rollbackExpectation: "skill_patch rollback expectation",
      policyDecision: expect.objectContaining({ mode: "suggest", createProposals: true }),
      approvalState: "required"
    }));
    expect(proposals).toContainEqual(expect.objectContaining({
      changeKind: "skill_create",
      authorityExpansion: true,
      riskClass: "medium"
    }));
    expect(proposals).toContainEqual(expect.objectContaining({
      changeKind: "routing_metadata_update",
      targetSurface: "routing_metadata"
    }));
    expect(proposals).toContainEqual(expect.objectContaining({
      changeKind: "routing_eval_addition",
      targetSurface: "routing_metadata"
    }));
    expect(proposals).toContainEqual(expect.objectContaining({
      changeKind: "negative_example_addition",
      targetSurface: "routing_metadata"
    }));
    expect(proposals).toContainEqual(expect.objectContaining({
      changeKind: "skill_consolidation",
      targetSurface: "skill"
    }));
  });

  it("rejects fork merge and archive as Phase 1A governed proposal change kinds", async () => {
    const root = await makeTempDir();
    const store = new SkillEvolutionStore({
      usagePath: join(root, "usage.json"),
      evolutionRoot: join(root, "evolution")
    });

    for (const changeKind of ["skill_fork", "skill_merge", "skill_archive"]) {
      await expect(store.appendGovernedProposal({
        skillName: "demo",
        reason: "unsupported change kind",
        changeKind: changeKind as never
      })).rejects.toThrow(/Unsupported Phase 1A/u);
    }
  });

  it("keeps legacy proposal records readable with default governed metadata", async () => {
    const root = await makeTempDir();
    const evolutionRoot = join(root, "evolution");
    await mkdir(evolutionRoot, { recursive: true });
    await writeFile(join(evolutionRoot, "proposed-patches.jsonl"), `${JSON.stringify({
      id: "patch_legacy",
      skillName: "legacy-skill",
      createdAt: "2026-01-01T00:00:00.000Z",
      reason: "legacy patch",
      confidence: 0.7,
      evidence: {
        observations: ["obs_legacy"],
        successes: 1,
        failures: 0
      },
      sourceTrust: "user_direct",
      mayPromoteAutomatically: false,
      requiresHumanApproval: true,
      patch: {
        type: "text_patch",
        oldString: "old",
        newString: "new"
      },
      status: "proposed"
    })}\n`, "utf8");

    const store = new SkillEvolutionStore({
      usagePath: join(root, "usage.json"),
      evolutionRoot
    });

    await expect(store.listProposals()).resolves.toEqual([
      expect.objectContaining({
        id: "patch_legacy",
        changeKind: "skill_patch",
        targetSurface: "skill",
        evidenceIds: ["obs_legacy"],
        hypothesis: "legacy patch",
        approvalState: "required"
      })
    ]);
  });

  it("serializes, reloads, lists, reads, and updates EvolutionExperiment records", async () => {
    const root = await makeTempDir();
    const store = new SkillEvolutionStore({
      usagePath: join(root, "usage.json"),
      evolutionRoot: join(root, "evolution"),
      now: () => new Date("2026-01-01T00:00:00.000Z")
    });

    const experiment = await store.appendExperiment({
      hypothesis: "Routing metadata improvement should reduce false positives",
      targetSurface: "routing_metadata",
      evidenceIds: ["obs_1"],
      proposedChangeIds: ["proposal_1"],
      baselineMetrics: {
        primaryPrecision: 0.81,
        ignoredNaN: Number.NaN
      },
      evalPlan: "pnpm run eval:fixtures",
      costRuntime: {
        providerCostUsd: 0.01,
        wallClockMs: 1200,
        evalRuns: 1
      }
    });

    expect(experiment).toEqual(expect.objectContaining({
      id: expect.stringMatching(/^exp_/u),
      outcome: "proposed",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      baselineMetrics: { primaryPrecision: 0.81 },
      evidenceIds: ["obs_1"],
      proposedChangeIds: ["proposal_1"]
    }));

    const reloaded = new SkillEvolutionStore({
      usagePath: join(root, "usage.json"),
      evolutionRoot: join(root, "evolution"),
      now: () => new Date("2026-01-01T00:05:00.000Z")
    });

    await expect(reloaded.listExperiments()).resolves.toEqual([
      expect.objectContaining({
        id: experiment.id,
        targetSurface: "routing_metadata",
        outcome: "proposed"
      })
    ]);
    await expect(reloaded.listExperiments({ targetSurface: "routing_metadata" })).resolves.toHaveLength(1);
    await expect(reloaded.listExperiments({ outcome: "failed" })).resolves.toEqual([]);
    await expect(reloaded.findExperiment(experiment.id)).resolves.toEqual(expect.objectContaining({
      id: experiment.id,
      hypothesis: "Routing metadata improvement should reduce false positives"
    }));

    const updated = await reloaded.updateExperiment(experiment.id, {
      outcome: "passed",
      resultMetrics: {
        primaryPrecision: 0.9,
        falsePositiveRate: 0.02
      },
      costRuntime: {
        providerCostUsd: 0.02,
        wallClockMs: 2200,
        evalRuns: 2
      }
    });

    expect(updated).toEqual(expect.objectContaining({
      id: experiment.id,
      outcome: "passed",
      updatedAt: "2026-01-01T00:05:00.000Z",
      resultMetrics: {
        primaryPrecision: 0.9,
        falsePositiveRate: 0.02
      },
      costRuntime: {
        providerCostUsd: 0.02,
        wallClockMs: 2200,
        evalRuns: 2
      }
    }));
  });

  it("links proposal records to experiments without requiring manifests promotion or rollback", async () => {
    const root = await makeTempDir();
    const evolutionRoot = join(root, "evolution");
    const store = new SkillEvolutionStore({
      usagePath: join(root, "usage.json"),
      evolutionRoot
    });
    const changeManifestStore = new ChangeManifestStore({
      root: join(evolutionRoot, "manifests")
    });
    const experiment = await store.appendExperiment({
      hypothesis: "Skill proposal should be reviewable as one experiment",
      targetSurface: "skill",
      evidenceIds: ["obs_1"],
      proposedChangeIds: ["proposal_pending"]
    });

    const proposal = await store.appendGovernedProposal({
      skillName: "demo",
      reason: "candidate skill patch",
      changeKind: "skill_patch",
      evidenceIds: ["obs_1"],
      experimentId: experiment.id
    });

    const updatedExperiment = await store.updateExperiment(experiment.id, {
      proposedChangeIds: [proposal.id]
    });

    await expect(store.findProposal(proposal.id)).resolves.toEqual(expect.objectContaining({
      id: proposal.id,
      experimentId: experiment.id
    }));
    expect(updatedExperiment).toEqual(expect.objectContaining({
      proposedChangeIds: [proposal.id]
    }));
    await expect(changeManifestStore.list()).resolves.toEqual([]);
    await expect(store.listPromotions()).resolves.toEqual([]);
    await expect(store.getUsage("demo")).resolves.toBeUndefined();
  });
});
