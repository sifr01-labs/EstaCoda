import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveProfileStateHome } from "../config/profile-home.js";
import { ChangeManifestStore } from "../skills/change-manifest-store.js";
import { SkillEvolutionStore, type SkillPatchProposal } from "../skills/skill-evolution.js";
import { runCliCommand } from "./cli.js";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("proposal CLI review surface", () => {
  it("lists pending governed proposals with linked review metadata without mutating evolution state", async () => {
    const harness = await createHarness();
    const observation = await harness.skillEvolutionStore.appendObservation({
      id: "obs_review",
      skillName: "release-skill",
      type: "failure",
      outcome: "failed",
      lesson: "Release workflow picked the wrong validation path.",
      candidateImprovement: "Patch release routing metadata.",
      sourceTrust: "runtime_internal"
    });
    const candidate = await harness.skillEvolutionStore.appendLearningCandidate({
      id: "learn_review",
      kind: "selected_skill_refinement",
      selectedSkill: "release-skill",
      evidenceIds: [observation.id],
      suggestedTarget: "routing_metadata_update",
      reason: "Route release prompts to release-skill with higher precision.",
      confidence: 0.81,
      createdAt: "2026-01-01T00:00:00.000Z"
    });
    const experiment = await harness.skillEvolutionStore.appendExperiment({
      id: "exp_review",
      hypothesis: "Routing metadata should reduce false positives.",
      targetSurface: "routing_metadata",
      evidenceIds: [observation.id],
      proposedChangeIds: [],
      evalPlan: "pnpm run eval:fixtures",
      resultMetrics: { primarySkillPrecision: 0.9 },
      outcome: "passed",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    });
    const proposal = await harness.skillEvolutionStore.appendGovernedProposal({
      skillName: "release-skill",
      reason: "Route release prompts to release-skill with higher precision.",
      confidence: 0.81,
      evidenceIds: [observation.id],
      changeKind: "routing_metadata_update",
      targetSurface: "routing_metadata",
      affectedSurface: "release-skill:routing",
      affectedFiles: [join(harness.profilePaths.skillsPath, "release-skill", "SKILL.md")],
      experimentId: experiment.id,
      hypothesis: "Routing metadata should reduce false positives.",
      riskClass: "medium",
      authorityExpansion: false,
      sourceKind: "local",
      evalPlan: {
        command: "pnpm run eval:fixtures",
        constraintGates: ["pnpm run typecheck", "pnpm run smoke"],
        expectedMetrics: ["primary_skill_precision", "false_positive_rate"]
      },
      rollbackExpectation: "Revert routing metadata through the governed proposal path.",
      policyDecision: {
        mode: "proactive",
        createProposals: true,
        shadowOnly: false,
        allowed: true,
        requiresApproval: true
      },
      approvalState: "required"
    });
    await harness.skillEvolutionStore.recordEvalRun({
      skillName: "release-skill",
      evalId: "routing-evolution-baseline",
      score: 0.9,
      passed: true,
      details: { primary_skill_precision: true },
      threshold: 0.85
    });

    const result = await runCliCommand({
      argv: ["proposal", "list", "--status", "proposed"],
      workspaceRoot: harness.homeDir,
      homeDir: harness.homeDir
    });

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("Proposal review queue");
    expect(result.output).toContain(proposal.id);
    expect(result.output).toContain("changeKind: routing_metadata_update");
    expect(result.output).toContain("targetSurface: routing_metadata");
    expect(result.output).toContain("affectedSurface: release-skill:routing");
    expect(result.output).toContain("affectedFiles:");
    expect(result.output).toContain("riskClass: medium");
    expect(result.output).toContain("authorityExpansion: false");
    expect(result.output).toContain("sourceKind: local");
    expect(result.output).toContain(`evidenceIds: ${observation.id}`);
    expect(result.output).toContain(`learningCandidateIds: ${candidate.id}`);
    expect(result.output).toContain(`experimentId: ${experiment.id}`);
    expect(result.output).toContain(`experimentSummary: ${experiment.id}; target=routing_metadata; outcome=passed`);
    expect(result.output).toContain("hypothesis: Routing metadata should reduce false positives.");
    expect(result.output).toContain("evalPlan: command=pnpm run eval:fixtures");
    expect(result.output).toContain("evalResult: passed");
    expect(result.output).toContain("rollbackExpectation: Revert routing metadata");
    expect(result.output).toContain("policyDecision: mode=proactive; allowed=true");
    expect(result.output).toContain("recommendation: review");
    expect(result.output).toContain("approvalState: required");
    await expect(harness.skillEvolutionStore.listPromotions()).resolves.toEqual([]);
    await expect(harness.changeManifestStore.list()).resolves.toEqual([]);
  });

  it("shows proposal detail with linked evidence, learning candidate, experiment, and eval summaries", async () => {
    const harness = await createHarness();
    const observation = await harness.skillEvolutionStore.appendObservation({
      id: "obs_detail",
      skillName: "release-skill",
      type: "note",
      lesson: "Release review needs a skill patch.",
      sourceTrust: "developer"
    });
    await harness.skillEvolutionStore.appendLearningCandidate({
      id: "learn_detail",
      kind: "selected_skill_refinement",
      selectedSkill: "release-skill",
      evidenceIds: [observation.id],
      suggestedTarget: "skill_patch",
      reason: "Patch release-skill playbook.",
      confidence: 0.74,
      createdAt: "2026-01-01T00:00:00.000Z"
    });
    const experiment = await harness.skillEvolutionStore.appendExperiment({
      id: "exp_detail",
      hypothesis: "Skill patch should improve release review.",
      targetSurface: "skill",
      evidenceIds: [observation.id],
      proposedChangeIds: [],
      evalPlan: "pnpm run eval:fixtures",
      baselineMetrics: { falsePositiveRate: 0.2 },
      costRuntime: { wallClockMs: 20, evalRuns: 1 },
      outcome: "proposed",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    });
    const proposal = await harness.skillEvolutionStore.appendGovernedProposal({
      skillName: "release-skill",
      reason: "Patch release-skill playbook.",
      evidenceIds: [observation.id],
      changeKind: "skill_patch",
      affectedFiles: [join(harness.profilePaths.skillsPath, "release-skill", "SKILL.md")],
      experimentId: experiment.id,
      riskClass: "low",
      sourceKind: "local",
      evalPlan: { command: "pnpm run eval:fixtures" },
      rollbackExpectation: "Restore the previous skill snapshot.",
      policyDecision: {
        mode: "suggest",
        createProposals: true,
        shadowOnly: false,
        allowed: true,
        requiresApproval: true
      },
      approvalState: "required"
    });
    await harness.skillEvolutionStore.recordEvalRun({
      skillName: "release-skill",
      evalId: "release-eval",
      score: 1,
      passed: true,
      details: { release: true },
      threshold: 0.8
    });

    const result = await runCliCommand({
      argv: ["proposal", "inspect", proposal.id],
      workspaceRoot: harness.homeDir,
      homeDir: harness.homeDir
    });

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.output) as {
      proposal: SkillPatchProposal;
      linkedEvidence: Array<{ id: string; lesson: string }>;
      linkedLearningCandidates: Array<{ id: string }>;
      linkedExperiment?: { id: string; hypothesis: string; outcome: string };
      evalRuns: Array<{ evalId: string; passed: boolean }>;
    };
    expect(parsed.proposal.id).toBe(proposal.id);
    expect(parsed.linkedEvidence).toEqual([expect.objectContaining({
      id: observation.id,
      lesson: "Release review needs a skill patch."
    })]);
    expect(parsed.linkedLearningCandidates).toEqual([expect.objectContaining({ id: "learn_detail" })]);
    expect(parsed.linkedExperiment).toEqual(expect.objectContaining({
      id: experiment.id,
      hypothesis: "Skill patch should improve release review.",
      outcome: "proposed"
    }));
    expect(parsed.evalRuns).toEqual([expect.objectContaining({
      evalId: "release-eval",
      passed: true
    })]);
    await expect(harness.skillEvolutionStore.listPromotions()).resolves.toEqual([]);
    await expect(harness.changeManifestStore.list()).resolves.toEqual([]);
  });

  it("lists legacy proposal records without new review metadata cleanly", async () => {
    const harness = await createHarness();
    await mkdir(join(harness.profilePaths.skillsPath, ".evolution"), { recursive: true });
    await writeFile(
      join(harness.profilePaths.skillsPath, ".evolution", "proposed-patches.jsonl"),
      `${JSON.stringify(legacyProposal())}\n`,
      "utf8"
    );

    const result = await runCliCommand({
      argv: ["proposal", "list"],
      workspaceRoot: harness.homeDir,
      homeDir: harness.homeDir
    });

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("legacy_patch");
    expect(result.output).toContain("changeKind: skill_patch");
    expect(result.output).toContain("affectedSurface: legacy-skill");
    expect(result.output).toContain("experimentId: none");
    expect(result.output).toContain("experimentSummary: not linked");
    expect(result.output).toContain("evalPlan: not recorded");
    expect(result.output).toContain("policyDecision: not recorded");
    await expect(harness.skillEvolutionStore.listPromotions()).resolves.toEqual([]);
    await expect(harness.changeManifestStore.list()).resolves.toEqual([]);
  });
});

async function createHarness(): Promise<{
  homeDir: string;
  profilePaths: ReturnType<typeof resolveProfileStateHome>;
  skillEvolutionStore: SkillEvolutionStore;
  changeManifestStore: ChangeManifestStore;
}> {
  const homeDir = await mkdtemp(join(tmpdir(), "estacoda-proposal-cli-"));
  tempDirs.push(homeDir);
  const profilePaths = resolveProfileStateHome({ homeDir, profileId: "default" });
  await mkdir(profilePaths.skillsPath, { recursive: true });
  const skillEvolutionStore = new SkillEvolutionStore({
    usagePath: join(profilePaths.skillsPath, ".usage.json"),
    evolutionRoot: join(profilePaths.skillsPath, ".evolution")
  });
  const changeManifestStore = new ChangeManifestStore({
    root: join(profilePaths.skillsPath, ".evolution", "manifests")
  });
  return { homeDir, profilePaths, skillEvolutionStore, changeManifestStore };
}

function legacyProposal(): SkillPatchProposal {
  return {
    id: "legacy_patch",
    skillName: "legacy-skill",
    createdAt: "2026-01-01T00:00:00.000Z",
    reason: "Legacy proposal should still list.",
    confidence: 0.5,
    evidence: {
      observations: ["obs_legacy"],
      successes: 0,
      failures: 1
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
  };
}
