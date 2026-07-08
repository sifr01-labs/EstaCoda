import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { deriveAgentEvolutionPolicy } from "../contracts/agent-evolution.js";
import type { LoadedSkill } from "../contracts/skill.js";
import { ChangeManifestStore } from "./change-manifest-store.js";
import type { SkillLearningCandidate } from "./skill-evolution.js";
import { SkillEvolutionStore } from "./skill-evolution.js";
import { SkillProposalService } from "./skill-proposal-service.js";
import { SkillRegistry } from "./skill-registry.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "estacoda-skill-proposal-service-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("SkillProposalService governed learning proposals", () => {
  it("converts selected-skill refinement candidates into governed skill_patch proposals", async () => {
    const harness = await createHarness();
    harness.registry.register(loadedSkill("release-skill", join(harness.localSkillsRoot, "release-skill", "SKILL.md")));
    const candidate = selectedSkillCandidate({
      suggestedTarget: "skill_patch",
      selectedSkill: "release-skill"
    });

    const result = await harness.service.createProposalFromLearningCandidate({
      candidate,
      agentEvolutionPolicy: deriveAgentEvolutionPolicy("suggest")
    });

    expect(result).toEqual(expect.objectContaining({ ok: true }));
    if (!result.ok) throw new Error(result.reason);
    expect(result.proposal).toEqual(expect.objectContaining({
      skillName: "release-skill",
      changeKind: "skill_patch",
      targetSurface: "skill",
      affectedSurface: "release-skill",
      affectedFiles: [join(harness.localSkillsRoot, "release-skill", "SKILL.md")],
      evidenceIds: ["obs_selected"],
      hypothesis: candidate.reason,
      riskClass: "low",
      authorityExpansion: false,
      sourceKind: "local",
      evalPlan: expect.objectContaining({ command: "pnpm run eval:fixtures" }),
      rollbackExpectation: expect.stringContaining("skill patch"),
      policyDecision: expect.objectContaining({
        mode: "suggest",
        createProposals: true,
        shadowOnly: false,
        allowed: true
      }),
      approvalState: "required"
    }));
    await expect(harness.skillEvolutionStore.listProposals()).resolves.toContainEqual(expect.objectContaining({
      id: result.proposal.id,
      changeKind: "skill_patch"
    }));
  });

  it("converts selected-skill correction candidates into routing_metadata_update proposals", async () => {
    const harness = await createHarness();
    const candidate = selectedSkillCandidate({
      suggestedTarget: "routing_metadata_update",
      selectedSkill: "wrong-skill"
    });

    const result = await harness.service.createProposalFromLearningCandidate({
      candidate,
      agentEvolutionPolicy: deriveAgentEvolutionPolicy("proactive")
    });

    expect(result).toEqual(expect.objectContaining({ ok: true }));
    if (!result.ok) throw new Error(result.reason);
    expect(result.proposal).toEqual(expect.objectContaining({
      skillName: "wrong-skill",
      changeKind: "routing_metadata_update",
      targetSurface: "routing_metadata",
      affectedSurface: "wrong-skill:routing",
      evidenceIds: ["obs_selected"],
      riskClass: "medium",
      authorityExpansion: false,
      approvalState: "required"
    }));
  });

  it("converts routing eval and negative example candidates into routing metadata proposals", async () => {
    const harness = await createHarness();

    const evalResult = await harness.service.createProposalFromLearningCandidate({
      candidate: selectedSkillCandidate({
        suggestedTarget: "routing_eval_addition",
        selectedSkill: "release-skill"
      }),
      agentEvolutionPolicy: deriveAgentEvolutionPolicy("suggest")
    });
    const negativeResult = await harness.service.createProposalFromLearningCandidate({
      candidate: selectedSkillCandidate({
        suggestedTarget: "negative_example_addition",
        selectedSkill: "wrong-skill"
      }),
      agentEvolutionPolicy: deriveAgentEvolutionPolicy("suggest")
    });

    expect(evalResult).toEqual(expect.objectContaining({ ok: true }));
    expect(negativeResult).toEqual(expect.objectContaining({ ok: true }));
    if (!evalResult.ok || !negativeResult.ok) throw new Error("expected proposal creation");
    expect(evalResult.proposal).toEqual(expect.objectContaining({
      changeKind: "routing_eval_addition",
      targetSurface: "routing_metadata",
      affectedSurface: "release-skill:routing.evaluations",
      rollbackExpectation: expect.stringContaining("routing eval")
    }));
    expect(negativeResult.proposal).toEqual(expect.objectContaining({
      changeKind: "negative_example_addition",
      targetSurface: "routing_metadata",
      affectedSurface: "wrong-skill:routing.negativePatterns",
      rollbackExpectation: expect.stringContaining("negative routing example")
    }));
  });

  it("converts missing-playbook candidates into governed skill_create proposals without creating skills", async () => {
    const harness = await createHarness();
    const candidate = missingPlaybookCandidate({
      suggestedTarget: "skill_create"
    });

    const result = await harness.service.createProposalFromLearningCandidate({
      candidate,
      skillName: "release-checks-workflow",
      agentEvolutionPolicy: deriveAgentEvolutionPolicy("suggest")
    });

    expect(result).toEqual(expect.objectContaining({ ok: true }));
    if (!result.ok) throw new Error(result.reason);
    expect(result.proposal).toEqual(expect.objectContaining({
      skillName: "release-checks-workflow",
      changeKind: "skill_create",
      targetSurface: "skill",
      affectedFiles: [],
      evidenceIds: ["obs_missing"],
      riskClass: "medium",
      authorityExpansion: true,
      approvalState: "required"
    }));
    await expect(harness.changeManifestStore.list()).resolves.toEqual([]);
    await expect(harness.skillEvolutionStore.listPromotions()).resolves.toEqual([]);
  });

  it("converts missing-playbook consolidation candidates into review-only skill proposals", async () => {
    const harness = await createHarness();
    const candidate = missingPlaybookCandidate({
      suggestedTarget: "skill_consolidation"
    });

    const result = await harness.service.createProposalFromLearningCandidate({
      candidate,
      skillName: "release-checks-workflow",
      agentEvolutionPolicy: deriveAgentEvolutionPolicy("suggest")
    });

    expect(result).toEqual(expect.objectContaining({ ok: true }));
    if (!result.ok) throw new Error(result.reason);
    expect(result.proposal).toEqual(expect.objectContaining({
      skillName: "release-checks-workflow",
      changeKind: "skill_consolidation",
      targetSurface: "skill",
      affectedSurface: "release-checks-workflow:consolidation",
      authorityExpansion: false,
      riskClass: "medium",
      approvalState: "required"
    }));
  });

  it("does not create proposals when policy disables proposal creation", async () => {
    const harness = await createHarness();

    const result = await harness.service.createProposalFromLearningCandidate({
      candidate: selectedSkillCandidate({ suggestedTarget: "skill_patch", selectedSkill: "release-skill" }),
      agentEvolutionPolicy: deriveAgentEvolutionPolicy("suggest", { createProposals: false })
    });

    expect(result).toEqual({
      ok: false,
      reason: "Agent Evolution policy does not allow proposal creation."
    });
    await expect(harness.skillEvolutionStore.listProposals()).resolves.toEqual([]);
  });

  it("does not create proposals for skills.autonomy none", async () => {
    const harness = await createHarness();

    const result = await harness.service.createProposalFromLearningCandidate({
      candidate: missingPlaybookCandidate({ suggestedTarget: "routing_metadata_update" }),
      agentEvolutionPolicy: deriveAgentEvolutionPolicy("none")
    });

    expect(result).toEqual({
      ok: false,
      reason: "Agent Evolution policy does not allow learning evidence."
    });
    await expect(harness.skillEvolutionStore.listProposals()).resolves.toEqual([]);
  });

  it("records autonomous proposal policy metadata as shadow-only without promoting", async () => {
    const harness = await createHarness();

    const result = await harness.service.createProposalFromLearningCandidate({
      candidate: selectedSkillCandidate({ suggestedTarget: "skill_patch", selectedSkill: "release-skill" }),
      agentEvolutionPolicy: deriveAgentEvolutionPolicy("autonomous")
    });

    expect(result).toEqual(expect.objectContaining({ ok: true }));
    if (!result.ok) throw new Error(result.reason);
    expect(result.proposal).toEqual(expect.objectContaining({
      status: "proposed",
      mayPromoteAutomatically: false,
      policyDecision: expect.objectContaining({
        mode: "autonomous",
        shadowOnly: true,
        reason: "Autonomous proposal is recorded as shadow-only in Phase 1A."
      })
    }));
    await expect(harness.skillEvolutionStore.listPromotions()).resolves.toEqual([]);
  });
});

async function createHarness(): Promise<{
  localSkillsRoot: string;
  registry: SkillRegistry;
  skillEvolutionStore: SkillEvolutionStore;
  changeManifestStore: ChangeManifestStore;
  service: SkillProposalService;
}> {
  const root = await makeTempDir();
  const localSkillsRoot = join(root, "skills");
  const registry = new SkillRegistry();
  const skillEvolutionStore = new SkillEvolutionStore({
    usagePath: join(localSkillsRoot, ".usage.json"),
    evolutionRoot: join(localSkillsRoot, ".evolution")
  });
  const changeManifestStore = new ChangeManifestStore({
    root: join(localSkillsRoot, ".evolution", "manifests")
  });
  const service = new SkillProposalService({
    registry,
    localSkillsRoot,
    skillEvolutionStore,
    changeManifestStore
  });
  return {
    localSkillsRoot,
    registry,
    skillEvolutionStore,
    changeManifestStore,
    service
  };
}

function selectedSkillCandidate(input: {
  suggestedTarget: "skill_patch" | "routing_metadata_update" | "routing_eval_addition" | "negative_example_addition";
  selectedSkill: string;
}): SkillLearningCandidate {
  return {
    id: "learn_selected",
    kind: "selected_skill_refinement",
    selectedSkill: input.selectedSkill,
    evidenceIds: ["obs_selected"],
    suggestedTarget: input.suggestedTarget,
    reason: "Selected skill should be reviewed",
    confidence: 0.82,
    sessionId: "session",
    promptHash: "prompt-hash",
    createdAt: "2026-01-01T00:00:00.000Z"
  };
}

function missingPlaybookCandidate(input: {
  suggestedTarget: "skill_create" | "routing_metadata_update" | "routing_eval_addition" | "skill_consolidation";
}): SkillLearningCandidate {
  return {
    id: "learn_missing",
    kind: "new_or_missing_playbook",
    evidenceIds: ["obs_missing"],
    suggestedTarget: input.suggestedTarget,
    reason: "Missing workflow should be reviewed",
    confidence: 0.7,
    sessionId: "session",
    promptHash: "prompt-hash",
    createdAt: "2026-01-01T00:00:00.000Z"
  };
}

function loadedSkill(name: string, sourcePath: string): LoadedSkill {
  return {
    name,
    description: `${name} description`,
    version: "0.1.0",
    whenToUse: ["release checks"],
    requiredToolsets: ["files"],
    playbook: [],
    permissionExpectations: ["auto-read"],
    examples: [],
    evaluations: [],
    sourcePath,
    sourceKind: "local",
    sourceRoot: join(sourcePath, ".."),
    instructions: "Use this skill for release checks."
  };
}
