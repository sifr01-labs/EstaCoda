import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { LoadedSkill, SkillDefinition, SkillEvaluation } from "../contracts/skill.js";
import type { EvolutionChangeManifest, EvolutionExperiment } from "../contracts/evolution.js";
import type { AgentEvolutionPolicy } from "../contracts/agent-evolution.js";
import {
  SkillEvolutionStore,
  type GovernedProposalChangeKind,
  type GovernedProposalEvalPlan,
  type GovernedProposalPolicyDecision,
  type SkillLearningCandidate,
  type SkillEvalRunRecord,
  type SkillObservationRecord,
  type SkillPatchOperation,
  type SkillPatchProposal,
  type SkillPatchRiskLevel,
  type SkillSourceTrust
} from "./skill-evolution.js";
import { ChangeManifestStore } from "./change-manifest-store.js";
import type { SkillRegistry } from "./skill-registry.js";
import { hydrateSkillResources, parseSkillFile } from "./skill-loader.js";
import { assertSkillContentMutationAllowed, assertSkillMutable } from "./skill-mutation-policy.js";
import { ensureContainedDirectory, isSafeRelativeSkillPath } from "./skill-path-safety.js";
import { MAX_SKILL_RESOURCE_BYTES, MAX_SKILL_RESOURCE_CHARS } from "./skill-limits.js";
import { truncateContextDocument } from "./skill-loader.js";

export type SkillProposalServiceOptions = {
  registry: SkillRegistry;
  localSkillsRoot: string;
  skillEvolutionStore: SkillEvolutionStore;
  changeManifestStore?: ChangeManifestStore;
};

export type ProposalListFilter = {
  skillName?: string;
  status?: "proposed" | "promoted" | "rejected";
};

export type ProposalReview = {
  proposalId: string;
  skillName: string;
  status: string;
  sourceTrust: SkillSourceTrust;
  reason: string;
  evidenceCount: number;
  riskLevel: SkillPatchRiskLevel;
  affectedFields: string[];
  diffSummary: string;
  evalResult?: {
    status: string;
    score: number;
    threshold: number;
    failures: string[];
  };
  recommendedAction: "none" | "review" | "reject" | "promote" | "approve";
  blockedReason?: string;
};

export type ProposalEvidenceSummary = Pick<
  SkillObservationRecord,
  | "id"
  | "skillName"
  | "sessionId"
  | "timestamp"
  | "type"
  | "outcome"
  | "lesson"
  | "candidateImprovement"
  | "sourceTrust"
>;

export type ProposalLearningCandidateSummary = SkillLearningCandidate;

export type ProposalEvalRunSummary = Pick<
  SkillEvalRunRecord,
  "id" | "skillName" | "evalId" | "ranAt" | "score" | "passed" | "threshold"
>;

export type ProposalReviewDetails = {
  proposal: SkillPatchProposal;
  review: ProposalReview;
  linkedEvidence: ProposalEvidenceSummary[];
  linkedLearningCandidates: ProposalLearningCandidateSummary[];
  linkedExperiment?: EvolutionExperiment;
  evalRuns: ProposalEvalRunSummary[];
};

export type LearningCandidateProposalResult =
  | { ok: true; proposal: SkillPatchProposal }
  | { ok: false; reason: string };

export type PromoteResult =
  | { ok: true; promotion: Record<string, unknown>; evalGate: SkillEvalGateResult; snapshotPath: string; skill: LoadedSkill }
  | { ok: false; reason: string };

export class SkillProposalService {
  readonly #options: SkillProposalServiceOptions;

  constructor(options: SkillProposalServiceOptions) {
    this.#options = options;
  }

  async listProposals(filter?: ProposalListFilter): Promise<SkillPatchProposal[]> {
    return this.#options.skillEvolutionStore.listProposals(filter ?? {});
  }

  async findProposal(proposalId: string): Promise<SkillPatchProposal | undefined> {
    return this.#options.skillEvolutionStore.findProposal(proposalId);
  }

  async reviewProposal(proposal: SkillPatchProposal): Promise<ProposalReview> {
    const observations = await this.#options.skillEvolutionStore.listObservations({
      skillName: proposal.skillName,
      ids: proposal.evidence.observations
    });
    const riskLevel = riskLevelForProposal(proposal);
    const skill = this.#options.registry.get(proposal.skillName);
    const evalGate = skill === undefined ? undefined : await runSkillEvalGate(skill);
    const trustGate = evaluateProposalTrust(proposal, observations, riskLevel);
    const recommendedAction = proposal.status !== "proposed"
      ? "none"
      : !trustGate.ok
        ? "review"
        : evalGate?.status === "failed"
          ? "reject"
          : proposal.patch !== undefined && proposal.changeKind === "skill_patch" && riskLevel === "low"
            ? "promote"
            : "approve";
    return {
      proposalId: proposal.id,
      skillName: proposal.skillName,
      status: proposal.status,
      sourceTrust: proposal.sourceTrust,
      reason: proposal.reason,
      evidenceCount: proposal.evidence.observations.length,
      riskLevel,
      affectedFields: proposal.patch === undefined ? [] : affectedFieldsForPatch(proposal.patch),
      diffSummary: proposal.patch === undefined
        ? summarizeGovernedProposal(proposal)
        : summarizePatchOperation(proposal.patch),
      evalResult: evalGate === undefined
        ? undefined
        : {
            status: evalGate.status,
            score: evalGate.score,
            threshold: evalGate.threshold,
            failures: evalGate.failures
          },
      recommendedAction,
      blockedReason: trustGate.ok ? undefined : trustGate.reason
    };
  }

  async reviewProposalDetails(proposal: SkillPatchProposal): Promise<ProposalReviewDetails> {
    const review = await this.reviewProposal(proposal);
    const evidenceIds = evidenceIdsForProposal(proposal);
    const evidenceIdSet = new Set(evidenceIds);
    const [observations, learningCandidates, linkedExperiment, evalRuns] = await Promise.all([
      this.#options.skillEvolutionStore.listObservations({ ids: evidenceIds }),
      this.#options.skillEvolutionStore.listLearningCandidates(),
      proposal.experimentId === undefined
        ? Promise.resolve(undefined)
        : this.#options.skillEvolutionStore.findExperiment(proposal.experimentId),
      this.#options.skillEvolutionStore.listEvalRuns({ skillName: proposal.skillName })
    ]);
    const linkedLearningCandidates = learningCandidates.filter((candidate) =>
      evidenceIdSet.has(candidate.id) || candidate.evidenceIds.some((id) => evidenceIdSet.has(id))
    );
    return {
      proposal,
      review,
      linkedEvidence: observations.map(summarizeObservationForReview),
      linkedLearningCandidates,
      linkedExperiment,
      evalRuns: evalRuns.map(summarizeEvalRunForReview)
    };
  }

  async approveProposal(proposalId: string, approvedBy?: string): Promise<SkillPatchProposal | undefined> {
    return this.#options.skillEvolutionStore.approveProposal(proposalId, approvedBy ?? "user");
  }

  async rejectProposal(proposalId: string): Promise<SkillPatchProposal | undefined> {
    const proposal = await this.#options.skillEvolutionStore.rejectProposal(proposalId);
    if (proposal?.changeManifestId !== undefined && this.#options.changeManifestStore !== undefined) {
      await this.#options.changeManifestStore.updateStatus(proposal.changeManifestId, "rejected");
    }
    return proposal;
  }

  async promoteProposal(proposalId: string): Promise<PromoteResult> {
    const proposal = await this.#options.skillEvolutionStore.findProposal(proposalId);
    if (proposal === undefined) {
      return { ok: false, reason: `Skill patch proposal not found: ${proposalId}` };
    }
    if (proposal.status !== "proposed") {
      return { ok: false, reason: `Skill patch proposal ${proposalId} is ${proposal.status}, not proposed.` };
    }
    if (proposal.changeKind !== undefined && proposal.changeKind !== "skill_patch") {
      return { ok: false, reason: `Governed proposal ${proposalId} is ${proposal.changeKind} and is not promotable by skill patch promotion.` };
    }
    if (proposal.patch === undefined) {
      return { ok: false, reason: `Skill patch proposal ${proposalId} has no executable patch.` };
    }

    const proposalObservations = await this.#options.skillEvolutionStore.listObservations({
      skillName: proposal.skillName,
      ids: proposal.evidence.observations
    });
    const riskLevel = classifyPatchRisk(proposal.patch);
    const trustGate = evaluateProposalTrust(proposal, proposalObservations, riskLevel);
    if (!trustGate.ok) {
      return { ok: false, reason: trustGate.reason };
    }

    const target = await this.#requireMutableLocalSkill(proposal.skillName, "promote");
    if (typeof target === "string") {
      return { ok: false, reason: target };
    }

    const current = await readFile(target.skillPath, "utf8");
    const currentSkill = this.#options.registry.get(proposal.skillName);
    const beforeEvalGate = currentSkill === undefined ? undefined : await runSkillEvalGate(currentSkill);
    const next = applySkillPatch(current, proposal.patch);

    let loaded: LoadedSkill;
    try {
      loaded = await hydrateSkillResources(parseSkillFile(target.skillPath, next, {
        sourceKind: "local",
        sourceRoot: this.#options.localSkillsRoot
      }));
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }

    if (loaded.name !== proposal.skillName) {
      return { ok: false, reason: `Promoted patch changed skill name from ${proposal.skillName} to ${loaded.name}` };
    }

    const evalGate = await runSkillEvalGate(loaded);
    await recordSkillEvalRuns(this.#options.skillEvolutionStore, loaded.name, evalGate);

    if (proposal.changeManifestId !== undefined && this.#options.changeManifestStore !== undefined) {
      if (evalGate.status === "failed") {
        await this.#options.changeManifestStore.updateStatus(proposal.changeManifestId, "rejected");
      } else {
        await this.#options.changeManifestStore.updateStatus(proposal.changeManifestId, "testing");
      }
    }

    if (evalGate.status === "failed") {
      return { ok: false, reason: `Skill patch proposal ${proposal.id} failed eval gate: ${evalGate.failures.join("; ")}` };
    }

    const snapshotPath = await this.#snapshotLocalSkill(target, proposal.skillName);
    await writeFile(target.skillPath, next, "utf8");
    this.#options.registry.register(loaded);

    const promotion = await this.#options.skillEvolutionStore.recordPromotion({
      proposal,
      skillName: proposal.skillName,
      snapshotPath,
      fromVersion: currentSkill?.version,
      toVersion: loaded.version,
      diffSummary: summarizePatchOperation(proposal.patch),
      riskLevel,
      evalDelta: compareEvalGates(beforeEvalGate, evalGate),
      checks: {
        evals: evalGate.status
      }
    });

    if (proposal.changeManifestId !== undefined && this.#options.changeManifestStore !== undefined) {
      await this.#options.changeManifestStore.updateStatus(proposal.changeManifestId, "promoted", { promotedBy: "skill.promote_patch" });
    }

    return {
      ok: true,
      promotion,
      evalGate,
      snapshotPath,
      skill: loaded
    };
  }

  async createManifestFromObservation(options: {
    skillName: string;
    lesson: string;
    candidateImprovement: string;
    observationId: string;
    sourceTrust?: SkillSourceTrust;
  }): Promise<{ manifestId: string } | undefined> {
    if (this.#options.changeManifestStore === undefined) {
      return undefined;
    }
    const skill = this.#options.registry.get(options.skillName);
    const manifest = await this.#options.changeManifestStore.propose({
      target: "skill",
      filesChanged: skill !== undefined && isLoadedSkill(skill) ? [skill.sourcePath] : [],
      evidence: {
        traces: [],
        failures: [],
        evalCases: [],
        userCorrections: []
      },
      hypothesis: options.lesson,
      predictedImpact: options.candidateImprovement,
      riskLevel: options.sourceTrust === "developer" || options.sourceTrust === "runtime_internal" ? "low" : "medium",
      evalCommand: "pnpm run eval:fixtures",
      constraintGates: ["pnpm run typecheck", "pnpm run smoke"],
      rollbackPlan: `Revert skill file using skill.rollback or restore from snapshot.`
    });
    await this.#options.changeManifestStore.linkEvidence(manifest.id, {
      traces: [options.observationId]
    });
    return { manifestId: manifest.id };
  }

  async createManifestFromProposal(options: {
    skillName: string;
    reason: string;
    patch: SkillPatchOperation;
  }): Promise<{ manifestId: string } | undefined> {
    if (this.#options.changeManifestStore === undefined) {
      return undefined;
    }
    const skill = this.#options.registry.get(options.skillName);
    const riskLevel = classifyPatchRisk(options.patch);
    const manifest = await this.#options.changeManifestStore.propose({
      target: "skill",
      filesChanged: skill !== undefined && isLoadedSkill(skill) ? [skill.sourcePath] : [],
      evidence: {
        traces: [],
        failures: [],
        evalCases: [],
        userCorrections: []
      },
      hypothesis: options.reason,
      predictedImpact: `Apply ${options.patch.type} to skill ${options.skillName}`,
      riskLevel,
      evalCommand: "pnpm run eval:fixtures",
      constraintGates: ["pnpm run typecheck", "pnpm run smoke"],
      rollbackPlan: `Revert skill file using skill.rollback or restore from snapshot.`
    });
    return { manifestId: manifest.id };
  }

  async createProposalFromLearningCandidate(options: {
    candidate: SkillLearningCandidate;
    agentEvolutionPolicy: AgentEvolutionPolicy;
    skillName?: string;
    affectedFiles?: string[];
    evalPlan?: GovernedProposalEvalPlan;
    rollbackExpectation?: string;
  }): Promise<LearningCandidateProposalResult> {
    const policyDecision = policyDecisionForLearningCandidateProposal(options.agentEvolutionPolicy);
    if (!policyDecision.allowed) {
      return { ok: false, reason: policyDecision.reason ?? "Agent Evolution policy does not allow proposal creation." };
    }

    const changeKind = governedChangeKindForLearningCandidate(options.candidate);
    const skillName = skillNameForLearningCandidate(options.candidate, options.skillName);
    const skill = this.#options.registry.get(skillName);
    const source = skill !== undefined && isLoadedSkill(skill) ? skill.sourceKind : undefined;
    const affectedFiles = options.affectedFiles ?? (skill !== undefined && isLoadedSkill(skill) ? [skill.sourcePath] : []);
    const riskClass = riskClassForGovernedChangeKind(changeKind);
    const requiresHumanApproval = requiresApprovalForRisk(options.agentEvolutionPolicy, riskClass);
    const proposal = await this.#options.skillEvolutionStore.appendGovernedProposal({
      skillName,
      source,
      reason: options.candidate.reason,
      confidence: options.candidate.confidence,
      evidenceIds: options.candidate.evidenceIds,
      sourceTrust: "runtime_internal",
      mayPromoteAutomatically: false,
      requiresHumanApproval,
      changeKind,
      targetSurface: changeKind === "routing_metadata_update" ? "routing_metadata" : "skill",
      affectedSurface: changeKind === "routing_metadata_update" ? `${skillName}:routing` : skillName,
      affectedFiles,
      hypothesis: options.candidate.reason,
      riskClass,
      authorityExpansion: changeKind === "skill_create",
      sourceKind: source,
      evalPlan: options.evalPlan ?? defaultEvalPlan(),
      rollbackExpectation: options.rollbackExpectation ?? defaultRollbackExpectation(changeKind),
      policyDecision: {
        ...policyDecision,
        requiresApproval: requiresHumanApproval
      },
      approvalState: requiresHumanApproval ? "required" : "not_required"
    });
    return { ok: true, proposal };
  }

  async createManifestForToolDescription(options: {
    toolName: string;
    proposedDescription: string;
    hypothesis: string;
    predictedImpact: string;
    evidenceTraceIds?: string[];
  }): Promise<{ manifestId: string } | undefined> {
    if (this.#options.changeManifestStore === undefined) {
      return undefined;
    }
    const manifest = await this.#options.changeManifestStore.propose({
      target: "tool_description",
      filesChanged: [],
      evidence: {
        traces: options.evidenceTraceIds ?? [],
        failures: [],
        evalCases: [],
        userCorrections: []
      },
      hypothesis: options.hypothesis,
      predictedImpact: options.predictedImpact,
      riskLevel: "low",
      evalCommand: "pnpm run eval:fixtures",
      constraintGates: ["pnpm run typecheck", "pnpm run smoke"],
      rollbackPlan: `Revert tool description to previous version via manifest store.`
    });
    return { manifestId: manifest.id };
  }

  async createManifestForRoutingMetadata(options: {
    skillName: string;
    proposedRoutingChange: string;
    hypothesis: string;
    predictedImpact: string;
    evidenceTraceIds?: string[];
  }): Promise<{ manifestId: string } | undefined> {
    if (this.#options.changeManifestStore === undefined) {
      return undefined;
    }
    const skill = this.#options.registry.get(options.skillName);
    const manifest = await this.#options.changeManifestStore.propose({
      target: "routing_metadata",
      filesChanged: skill !== undefined && isLoadedSkill(skill) ? [skill.sourcePath] : [],
      evidence: {
        traces: options.evidenceTraceIds ?? [],
        failures: [],
        evalCases: [],
        userCorrections: []
      },
      hypothesis: options.hypothesis,
      predictedImpact: options.predictedImpact,
      riskLevel: "medium",
      evalCommand: "pnpm run eval:fixtures",
      constraintGates: ["pnpm run typecheck", "pnpm run smoke"],
      rollbackPlan: `Revert routing metadata to previous version via manifest store.`
    });
    return { manifestId: manifest.id };
  }

  async listManifests(filter?: { status?: import("../contracts/evolution.js").EvolutionChangeManifest["status"] }): Promise<EvolutionChangeManifest[]> {
    if (this.#options.changeManifestStore === undefined) {
      return [];
    }
    return this.#options.changeManifestStore.list(filter ?? {});
  }

  async findManifest(manifestId: string): Promise<EvolutionChangeManifest | undefined> {
    if (this.#options.changeManifestStore === undefined) {
      return undefined;
    }
    return this.#options.changeManifestStore.find(manifestId);
  }

  async #requireMutableLocalSkill(
    name: string,
    action: "patch" | "edit" | "delete" | "write-file" | "remove-file" | "promote"
  ): Promise<{ skillDir: string; skillPath: string; skill: LoadedSkill } | string> {
    const existing = this.#options.registry.get(name);
    if (existing !== undefined) {
      if (!isLoadedSkill(existing)) {
        return `Skill ${name} is not a file-backed skill and cannot be modified here.`;
      }
      const mutable = await assertSkillMutable({
        skill: existing,
        action,
        store: this.#options.skillEvolutionStore
      });
      if (!mutable.ok) {
        return mutable.reason;
      }
      if (existing.sourceKind !== "local") {
        const workingCopy = await this.#createLocalWorkingCopy(existing);
        if (typeof workingCopy === "string") {
          return workingCopy;
        }
        return workingCopy;
      }
      return {
        skillDir: dirname(existing.sourcePath),
        skillPath: existing.sourcePath,
        skill: existing
      };
    }
    return `Local skill not found: ${name}`;
  }

  async #createLocalWorkingCopy(skill: LoadedSkill): Promise<{ skillDir: string; skillPath: string; skill: LoadedSkill } | string> {
    await mkdir(this.#options.localSkillsRoot, { recursive: true });
    const contained = await ensureContainedDirectory(this.#options.localSkillsRoot, slugifySkillName(skill.name));
    if (!contained.ok) {
      return contained.reason;
    }
    const skillDir = contained.path;
    await rm(skillDir, { recursive: true, force: true });
    await mkdir(dirname(skillDir), { recursive: true });
    await cp(dirname(skill.sourcePath), skillDir, { recursive: true });
    const localSkillPath = join(skillDir, "SKILL.md");
    const loaded = await this.#reloadLocalSkill(localSkillPath);

    await this.#options.skillEvolutionStore.recordMutation({
      skillName: loaded.name,
      source: loaded.sourceKind,
      kind: "created"
    });

    return {
      skillDir,
      skillPath: localSkillPath,
      skill: loaded
    };
  }

  async #reloadLocalSkill(skillPath: string): Promise<LoadedSkill> {
    const loaded = await hydrateSkillResources(parseSkillFile(skillPath, await readFile(skillPath, "utf8"), {
      sourceKind: "local",
      sourceRoot: this.#options.localSkillsRoot
    }));
    this.#options.registry.register(loaded);
    return loaded;
  }

  async #snapshotLocalSkill(
    target: { skillDir: string; skillPath: string; skill: LoadedSkill },
    name: string
  ): Promise<string> {
    const slug = slugifySkillName(name);
    const snapshotRoot = join(this.#options.localSkillsRoot, ".snapshots", slug);
    const snapshotPath = join(snapshotRoot, new Date().toISOString().replace(/[:.]/gu, "-"));
    await mkdir(snapshotRoot, { recursive: true });
    await cp(target.skillDir, snapshotPath, { recursive: true });
    return snapshotPath;
  }
}

export function isLoadedSkill(skill: LoadedSkill | SkillDefinition): skill is LoadedSkill {
  return "sourcePath" in skill && "instructions" in skill;
}

export function slugifySkillName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9\u0600-\u06ff]+/g, "-").replace(/^-|-$/g, "") || value;
}

export function classifyPatchRisk(patch: SkillPatchOperation): SkillPatchRiskLevel {
  const serialized = JSON.stringify(patch).toLowerCase();
  if (/\b(required_credential_files|requiredcredentialfiles|required_environment_variables|requiredenvironmentvariables|permission_expectations|permissionexpectations|terminal\.run|execute_code|browser\.|web\.|external|credential|secret|token|api[_-]?key)\b/u.test(serialized)) {
    return "high";
  }
  if (patch.type === "json_frontmatter_patch" && /\/(playbook|workflow|triggerpatterns|trigger_patterns|intentlabels|intent_labels|negativepatterns|negative_patterns|requiredtoolsets|required_toolsets|optionaltoolsets|optional_toolsets)\b/u.test(patch.path.toLowerCase())) {
    return "medium";
  }
  return "low";
}

function riskLevelForProposal(proposal: SkillPatchProposal): SkillPatchRiskLevel {
  if (proposal.riskClass !== undefined) {
    return proposal.riskClass;
  }
  if (proposal.patch !== undefined) {
    return classifyPatchRisk(proposal.patch);
  }
  return riskClassForGovernedChangeKind(proposal.changeKind ?? "skill_patch");
}

function evidenceIdsForProposal(proposal: SkillPatchProposal): string[] {
  return [...new Set([
    ...(proposal.evidenceIds ?? []),
    ...(proposal.evidence?.observations ?? [])
  ])];
}

function summarizeObservationForReview(observation: SkillObservationRecord): ProposalEvidenceSummary {
  return {
    id: observation.id,
    skillName: observation.skillName,
    sessionId: observation.sessionId,
    timestamp: observation.timestamp,
    type: observation.type,
    outcome: observation.outcome,
    lesson: observation.lesson,
    candidateImprovement: observation.candidateImprovement,
    sourceTrust: observation.sourceTrust
  };
}

function summarizeEvalRunForReview(run: SkillEvalRunRecord): ProposalEvalRunSummary {
  return {
    id: run.id,
    skillName: run.skillName,
    evalId: run.evalId,
    ranAt: run.ranAt,
    score: run.score,
    passed: run.passed,
    threshold: run.threshold
  };
}

export function evaluateProposalTrust(
  proposal: SkillPatchProposal,
  observations: SkillObservationRecord[],
  riskLevel: SkillPatchRiskLevel
): { ok: true } | { ok: false; reason: string } {
  if (proposal.requiresHumanApproval && proposal.approvedAt === undefined) {
    return { ok: false, reason: "Skill patch proposal requires explicit approval before promotion." };
  }
  if (riskLevel !== "low" && proposal.approvedAt === undefined) {
    return { ok: false, reason: `Skill patch proposal is ${riskLevel}-risk and requires explicit approval before promotion.` };
  }
  if (isUntrustedSource(proposal.sourceTrust) && proposal.approvedAt === undefined) {
    return { ok: false, reason: "Skill patch proposal is derived from untrusted content and requires review before promotion." };
  }
  if (
    observations.length > 0 &&
    observations.every((observation) => isUntrustedSource(observation.sourceTrust)) &&
    proposal.approvedAt === undefined
  ) {
    return { ok: false, reason: "Skill patch proposal only cites untrusted observations and requires review before promotion." };
  }
  return { ok: true };
}

function governedChangeKindForLearningCandidate(candidate: SkillLearningCandidate): GovernedProposalChangeKind {
  return candidate.suggestedTarget;
}

function skillNameForLearningCandidate(candidate: SkillLearningCandidate, provided: string | undefined): string {
  if (provided !== undefined && provided.trim().length > 0) {
    return provided;
  }
  if (candidate.kind === "selected_skill_refinement") {
    return candidate.selectedSkill;
  }
  return `learning-candidate-${candidate.id}`;
}

function policyDecisionForLearningCandidateProposal(policy: AgentEvolutionPolicy): GovernedProposalPolicyDecision {
  if (!policy.observeTurns || !policy.createEvidence) {
    return {
      mode: policy.mode,
      createProposals: policy.createProposals,
      shadowOnly: policy.shadowAutonomousDecisions,
      allowed: false,
      requiresApproval: true,
      reason: "Agent Evolution policy does not allow learning evidence."
    };
  }
  if (!policy.createProposals) {
    return {
      mode: policy.mode,
      createProposals: policy.createProposals,
      shadowOnly: policy.shadowAutonomousDecisions,
      allowed: false,
      requiresApproval: true,
      reason: "Agent Evolution policy does not allow proposal creation."
    };
  }
  return {
    mode: policy.mode,
    createProposals: policy.createProposals,
    shadowOnly: policy.shadowAutonomousDecisions,
    allowed: true,
    requiresApproval: true,
    reason: policy.shadowAutonomousDecisions ? "Autonomous proposal is recorded as shadow-only in Phase 1A." : undefined
  };
}

function riskClassForGovernedChangeKind(kind: GovernedProposalChangeKind): SkillPatchRiskLevel {
  if (kind === "skill_patch") {
    return "low";
  }
  return "medium";
}

function requiresApprovalForRisk(policy: AgentEvolutionPolicy, riskClass: SkillPatchRiskLevel): boolean {
  if (riskClass === "high") {
    return policy.requireApprovalForHighRisk;
  }
  if (riskClass === "medium") {
    return policy.requireApprovalForMediumRisk;
  }
  return policy.requireApprovalForLowRisk;
}

function defaultEvalPlan(): GovernedProposalEvalPlan {
  return {
    command: "pnpm run eval:fixtures",
    constraintGates: ["pnpm run typecheck", "pnpm run smoke"],
    expectedMetrics: ["primary_skill_precision", "false_positive_rate", "no_skill_correctness"]
  };
}

function defaultRollbackExpectation(kind: GovernedProposalChangeKind): string {
  if (kind === "routing_metadata_update") {
    return "Revert routing metadata through the governed manifest/proposal path before changing live routing behavior.";
  }
  if (kind === "skill_create") {
    return "Remove or archive the governed local skill candidate before promotion is considered.";
  }
  return "Revert the governed skill patch through snapshot-backed promotion rollback if later promoted.";
}

function summarizeGovernedProposal(proposal: SkillPatchProposal): string {
  return `Governed ${proposal.changeKind ?? "skill_patch"} proposal for ${proposal.affectedSurface ?? proposal.skillName}.`;
}

function isUntrustedSource(sourceTrust: SkillSourceTrust): boolean {
  return sourceTrust === "untrusted_web" || sourceTrust === "untrusted_document";
}

export function summarizePatchOperation(patch: SkillPatchOperation): string {
  if (patch.type === "text_patch") {
    return patch.replaceAll === true ? "Applied text replacement to all matching occurrences." : "Applied one exact text replacement.";
  }
  return `${patch.operation ?? "add"} JSON frontmatter path ${patch.path}.`;
}

export function affectedFieldsForPatch(patch: SkillPatchOperation): string[] {
  if (patch.type === "text_patch") {
    return ["body"];
  }
  const field = patch.path.split("/").filter((part) => part.length > 0)[0];
  return field === undefined ? ["frontmatter"] : [field.replace(/~1/gu, "/").replace(/~0/gu, "~")];
}

export function applySkillPatch(current: string, patch: SkillPatchOperation): string {
  if (patch.type === "text_patch") {
    const occurrences = countOccurrences(current, patch.oldString);
    if (occurrences === 0) {
      throw new Error("Proposed text patch target was not found.");
    }
    if (occurrences > 1 && patch.replaceAll !== true) {
      throw new Error("Proposed text patch matched multiple occurrences without replaceAll.");
    }
    return patch.replaceAll === true
      ? current.split(patch.oldString).join(patch.newString)
      : current.replace(patch.oldString, patch.newString);
  }
  if (patch.type === "json_frontmatter_patch") {
    const parsed = splitSkillFile(current);
    const frontmatter = parsed.frontmatter.trim();
    if (!frontmatter.startsWith("{")) {
      throw new Error("json_frontmatter_patch can only promote into skills with JSON frontmatter.");
    }
    const document = JSON.parse(frontmatter) as unknown;
    if (!isRecord(document)) {
      throw new Error("Skill frontmatter must be a JSON object.");
    }
    applyJsonPointerPatch(document, patch.path, patch.value, patch.operation ?? "add");
    return `---\n${JSON.stringify(document, null, 2)}\n---\n${parsed.instructions}`;
  }
  throw new Error(`Unsupported patch type: ${(patch as { type: string }).type}`);
}

function countOccurrences(content: string, needle: string): number {
  if (needle.length === 0) {
    return 0;
  }
  let count = 0;
  let index = 0;
  while (true) {
    const next = content.indexOf(needle, index);
    if (next === -1) {
      return count;
    }
    count++;
    index = next + needle.length;
  }
}

function splitSkillFile(content: string): { frontmatter: string; instructions: string } {
  const match = /^---\n(?<frontmatter>[\s\S]*?)\n---\n?(?<instructions>[\s\S]*)$/u.exec(content);
  if (match?.groups === undefined) {
    throw new Error("Skill file must start with frontmatter wrapped in --- markers");
  }
  return {
    frontmatter: match.groups.frontmatter,
    instructions: match.groups.instructions
  };
}

function applyJsonPointerPatch(
  target: Record<string, unknown>,
  path: string,
  value: unknown,
  operation: "add" | "replace"
): void {
  const parts = parseJsonPointer(path);
  if (parts.length === 0) {
    throw new Error("Patch path cannot target the frontmatter root.");
  }
  let cursor: unknown = target;
  for (const part of parts.slice(0, -1)) {
    if (Array.isArray(cursor)) {
      const index = Number(part);
      cursor = cursor[index];
      continue;
    }
    if (!isRecord(cursor)) {
      throw new Error(`Patch path cannot descend through ${part}.`);
    }
    cursor = cursor[part];
  }
  const key = parts[parts.length - 1]!;
  if (Array.isArray(cursor)) {
    if (key === "-") {
      cursor.push(value);
      return;
    }
    const index = Number(key);
    if (!Number.isInteger(index) || index < 0 || index > cursor.length) {
      throw new Error(`Invalid array patch index: ${key}`);
    }
    if (operation === "replace" && index >= cursor.length) {
      throw new Error(`Cannot replace missing array index: ${key}`);
    }
    cursor[index] = value;
    return;
  }
  if (!isRecord(cursor)) {
    throw new Error("Patch path parent is not an object or array.");
  }
  if (operation === "replace" && !(key in cursor)) {
    throw new Error(`Cannot replace missing object key: ${key}`);
  }
  cursor[key] = value;
}

function parseJsonPointer(path: string): string[] {
  if (!path.startsWith("/")) {
    throw new Error("JSON patch path must start with /.");
  }
  return path
    .slice(1)
    .split("/")
    .map((part) => part.replace(/~1/gu, "/").replace(/~0/gu, "~"));
}

export type SkillEvalGateResult = {
  status: "passed" | "failed" | "not-run";
  caseCount: number;
  score: number;
  threshold: number;
  cases: Array<{
    id: string;
    score: number;
    passed: boolean;
    details: Record<string, boolean>;
    threshold: number;
  }>;
  failures: string[];
  checkedFiles: string[];
};

type SkillEvalCase = SkillEvaluation & {
  id?: string;
  prompt?: string;
  availableToolsets?: string[];
  passThreshold?: number;
  scoring?: Record<string, number>;
  shouldNotUseToolsets?: string[];
  expected?: {
    selectedSkill?: string;
    playbookStep?: string;
    mustAttempt?: string[];
    mustUseOneOf?: string[];
    mustNotUse?: string[];
    mustEndState?: string;
    skillVisible?: boolean;
    degraded?: boolean;
  };
};

export async function runSkillEvalGate(skill: LoadedSkill | SkillDefinition): Promise<SkillEvalGateResult> {
  const loadedCases = await loadSkillEvalCases(skill);
  const cases: SkillEvalCase[] = [
    ...skill.evaluations.map((evaluation, index) => ({
      ...evaluation,
      id: `frontmatter-${index + 1}`
    })),
    ...loadedCases.cases
  ];
  if (cases.length === 0) {
    return {
      status: "not-run",
      caseCount: 0,
      score: 0,
      threshold: 1,
      cases: [],
      failures: [],
      checkedFiles: loadedCases.checkedFiles
    };
  }

  const availableToolsets = new Set([
    ...skill.requiredToolsets,
    ...(skill.optionalToolsets ?? []),
    ...skill.playbook.flatMap((step) => step.toolsets ?? [])
  ]);
  const declaredTools = new Set(skill.playbook.flatMap((step) => [
    step.preferredTool,
    ...(step.toolCandidates ?? [])
  ].filter(isNonEmptyString)));
  const failures: string[] = [];
  const caseResults: SkillEvalGateResult["cases"] = [];

  for (const [index, evaluation] of cases.entries()) {
    const label = evaluation.id ?? (evaluation as { input?: string }).input ?? evaluation.prompt ?? `case-${index + 1}`;
    const details: Record<string, boolean> = {};
    for (const toolset of evaluation.shouldUseToolsets ?? []) {
      details[`uses_toolset:${toolset}`] = availableToolsets.has(toolset);
      if (!details[`uses_toolset:${toolset}`]) {
        failures.push(`${label}: expected toolset ${toolset} is not declared by the skill playbook`);
      }
    }
    for (const toolset of evaluation.shouldNotUseToolsets ?? []) {
      details[`avoids_toolset:${toolset}`] = !availableToolsets.has(toolset);
      if (!details[`avoids_toolset:${toolset}`]) {
        failures.push(`${label}: forbidden toolset ${toolset} is still declared by the skill playbook`);
      }
    }
    if (evaluation.shouldNotAskUserFirst === true) {
      details.shouldNotAskUserFirst = !skill.permissionExpectations.some((expectation) => expectation.startsWith("ask-before"));
    }
    if (details.shouldNotAskUserFirst === false) {
      failures.push(`${label}: shouldNotAskUserFirst conflicts with ask-before permission expectations`);
    }
    if (evaluation.expected?.selectedSkill !== undefined) {
      details.selectedSkill = evaluation.expected.selectedSkill === skill.name;
    }
    if (details.selectedSkill === false) {
      failures.push(`${label}: expected selectedSkill ${evaluation.expected?.selectedSkill}, got ${skill.name}`);
    }
    if (evaluation.expected?.playbookStep !== undefined) {
      details.playbookStep = skill.playbook.some((step) => step.id === evaluation.expected?.playbookStep);
    }
    if (details.playbookStep === false) {
      failures.push(`${label}: expected playbook step ${evaluation.expected?.playbookStep} is not declared`);
    }
    for (const tool of evaluation.expected?.mustAttempt ?? []) {
      details[`must_attempt:${tool}`] = declaredTools.has(tool);
      if (!details[`must_attempt:${tool}`]) {
        failures.push(`${label}: expected tool candidate ${tool} is not declared by the playbook`);
      }
    }
    if ((evaluation.expected?.mustUseOneOf ?? []).length > 0) {
      details.mustUseOneOf = evaluation.expected!.mustUseOneOf!.some((tool) => declaredTools.has(tool));
      if (!details.mustUseOneOf) {
        failures.push(`${label}: none of expected tool candidates are declared: ${evaluation.expected!.mustUseOneOf!.join(", ")}`);
      }
    }
    for (const tool of evaluation.expected?.mustNotUse ?? []) {
      details[`must_not_use:${tool}`] = !declaredTools.has(tool);
      if (!details[`must_not_use:${tool}`]) {
        failures.push(`${label}: forbidden tool candidate ${tool} is declared by the playbook`);
      }
    }
    if (evaluation.expected?.skillVisible === false) {
      failures.push(`${label}: promotion evals cannot currently assert skillVisible=false`);
      details.skillVisible = false;
    } else if (evaluation.expected?.skillVisible === true) {
      details.skillVisible = true;
    }
    if (evaluation.expected?.degraded !== undefined) {
      details.degraded = true;
    }
    if (evaluation.expected?.mustEndState !== undefined) {
      details.finalBehavior = true;
    }
    const threshold = clampEvalScore(evaluation.passThreshold ?? 1);
    const score = scoreEvalDetails(details, evaluation.scoring);
    const passed = score >= threshold;
    if (!passed) {
      failures.push(`${label}: score ${score.toFixed(2)} below threshold ${threshold.toFixed(2)}`);
    }
    caseResults.push({
      id: label,
      score,
      passed,
      details,
      threshold
    });
  }

  const score = caseResults.length === 0
    ? 0
    : caseResults.reduce((sum, result) => sum + result.score, 0) / caseResults.length;
  const threshold = caseResults.length === 0
    ? 1
    : Math.min(...caseResults.map((result) => result.threshold));
  return {
    status: failures.length === 0 ? "passed" : "failed",
    caseCount: cases.length,
    score,
    threshold,
    cases: caseResults,
    failures,
    checkedFiles: loadedCases.checkedFiles
  };
}

async function loadSkillEvalCases(skill: LoadedSkill | SkillDefinition): Promise<{ cases: SkillEvalCase[]; checkedFiles: string[] }> {
  if (!isLoadedSkill(skill)) {
    return { cases: [], checkedFiles: [] };
  }
  const evalRoot = join(dirname(skill.sourcePath), "evals");
  const entries = await readdir(evalRoot, { withFileTypes: true }).catch(() => []);
  const cases: SkillEvalCase[] = [];
  const checkedFiles: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || (!entry.name.endsWith(".jsonl") && !entry.name.endsWith(".json"))) {
      continue;
    }
    const path = join(evalRoot, entry.name);
    checkedFiles.push(path);
    const raw = await readFile(path, "utf8");
    if (entry.name.endsWith(".jsonl")) {
      for (const line of raw.split(/\r?\n/u)) {
        const trimmed = line.trim();
        if (trimmed.length > 0) {
          cases.push(normalizeEvalCase(JSON.parse(trimmed)));
        }
      }
      continue;
    }
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      cases.push(...parsed.map(normalizeEvalCase));
    } else {
      cases.push(normalizeEvalCase(parsed));
    }
  }
  return { cases, checkedFiles };
}

function normalizeEvalCase(value: unknown): SkillEvalCase {
  if (!isRecord(value)) {
    throw new Error("Skill eval case must be an object.");
  }
  const input = firstNonEmptyString(value.input, value.prompt) ?? "";
  return {
    id: firstNonEmptyString(value.id),
    input,
    prompt: firstNonEmptyString(value.prompt),
    availableToolsets: stringArrayOrEmpty(value.availableToolsets ?? value.available_toolsets),
    passThreshold: typeof value.passThreshold === "number"
      ? value.passThreshold
      : typeof value.pass_threshold === "number"
        ? value.pass_threshold
        : undefined,
    scoring: isRecord(value.scoring) ? numericRecord(value.scoring) : undefined,
    shouldUseToolsets: stringArrayOrEmpty(value.shouldUseToolsets ?? value.should_use_toolsets),
    shouldNotUseToolsets: stringArrayOrEmpty(value.shouldNotUseToolsets ?? value.should_not_use_toolsets),
    shouldNotAskUserFirst: value.shouldNotAskUserFirst === true || value.should_not_ask_user_first === true,
    expectedOutcome: firstNonEmptyString(value.expectedOutcome, value.expected_outcome),
    expected: isRecord(value.expected)
      ? {
          selectedSkill: firstNonEmptyString(value.expected.selectedSkill ?? value.expected.selected_skill),
          playbookStep: firstNonEmptyString(value.expected.playbookStep ?? value.expected.playbook_step),
          mustAttempt: stringArrayOrEmpty(value.expected.mustAttempt ?? value.expected.must_attempt),
          mustUseOneOf: stringArrayOrEmpty(value.expected.mustUseOneOf ?? value.expected.must_use_one_of),
          mustNotUse: stringArrayOrEmpty(value.expected.mustNotUse ?? value.expected.must_not_use),
          mustEndState: firstNonEmptyString(value.expected.mustEndState ?? value.expected.must_end_state),
          skillVisible: typeof value.expected.skillVisible === "boolean" ? value.expected.skillVisible : undefined,
          degraded: typeof value.expected.degraded === "boolean" ? value.expected.degraded : undefined
        }
      : undefined
  };
}

export async function recordSkillEvalRuns(
  store: SkillEvolutionStore,
  skillName: string,
  result: SkillEvalGateResult
): Promise<SkillEvalRunRecord[]> {
  const records: SkillEvalRunRecord[] = [];
  for (const item of result.cases) {
    records.push(await store.recordEvalRun({
      skillName,
      evalId: item.id,
      score: item.score,
      passed: item.passed,
      details: item.details,
      threshold: item.threshold
    }));
  }
  return records;
}

export function compareEvalGates(
  before: SkillEvalGateResult | undefined,
  after: SkillEvalGateResult
) {
  const beforeScore = before?.status === "not-run" ? undefined : before?.score;
  const afterScore = after.status === "not-run" ? 0 : after.score;
  const beforeCases = new Map((before?.cases ?? []).map((item) => [item.id, item]));
  const newlyPassingCases: string[] = [];
  const newlyFailingCases: string[] = [];
  for (const item of after.cases) {
    const previous = beforeCases.get(item.id);
    if (previous !== undefined && !previous.passed && item.passed) {
      newlyPassingCases.push(item.id);
    }
    if (previous !== undefined && previous.passed && !item.passed) {
      newlyFailingCases.push(item.id);
    }
  }
  return {
    beforeScore,
    afterScore,
    delta: beforeScore === undefined ? undefined : afterScore - beforeScore,
    failedCases: after.cases.filter((item) => !item.passed).map((item) => item.id),
    newlyPassingCases,
    newlyFailingCases
  };
}

function scoreEvalDetails(details: Record<string, boolean>, scoring: Record<string, number> | undefined): number {
  const entries = Object.entries(details);
  if (entries.length === 0) {
    return 1;
  }
  if (scoring === undefined || Object.keys(scoring).length === 0) {
    return entries.filter(([, passed]) => passed).length / entries.length;
  }
  let total = 0;
  let earned = 0;
  for (const [key, passed] of entries) {
    const weight = scoring[key] ?? scoring[key.split(":")[0]!] ?? 0;
    total += weight;
    if (passed) {
      earned += weight;
    }
  }
  if (total <= 0) {
    return entries.filter(([, passed]) => passed).length / entries.length;
  }
  return clampEvalScore(earned / total);
}

function numericRecord(value: Record<string, unknown>): Record<string, number> {
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, number] => typeof entry[1] === "number"));
}

function clampEvalScore(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
  return values.find((value) => isNonEmptyString(value));
}

function stringArrayOrEmpty(value: unknown): string[] {
  return Array.isArray(value) ? value.filter(isNonEmptyString) : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
