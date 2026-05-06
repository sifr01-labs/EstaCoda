import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { SkillOutcome } from "../contracts/memory.js";
import type {
  LoadedSkill,
  SkillDefinition,
  SkillLifecycleState,
  SkillProvenanceKind,
  SkillRouteTelemetry,
  SkillSourceKind
} from "../contracts/skill.js";
import type { ToolExecutionRecord } from "../tools/tool-executor.js";

export type SkillUsageRecord = {
  skillName: string;
  source?: SkillSourceKind;
  provenanceKind?: SkillProvenanceKind;
  useCount: number;
  viewCount: number;
  successCount: number;
  failureCount: number;
  routeMatchCount: number;
  routeSelectedCount: number;
  routeRejectedCount: number;
  lastUsedAt?: string;
  lastViewedAt?: string;
  lastMatchedAt?: string;
  lastSelectedAt?: string;
  lastSucceededAt?: string;
  lastFailedAt?: string;
  lastPatchedAt?: string;
  archivedAt?: string;
  patchCount: number;
  rollbackCount: number;
  pinned: boolean;
  state: SkillLifecycleState;
};

export type SkillObservationType = "success" | "failure" | "blocked" | "partial" | "note";
export type SkillSourceTrust =
  | "untrusted_web"
  | "untrusted_document"
  | "user_direct"
  | "tool_error"
  | "runtime_internal"
  | "developer";

export type SkillObservationRecord = {
  id: string;
  skillName: string;
  source?: SkillSourceKind;
  sessionId?: string;
  timestamp: string;
  type: SkillObservationType;
  promptSummary?: string;
  selectedWorkflowStep?: string;
  toolsAttempted: string[];
  outcome: "succeeded" | "failed" | "blocked" | "partial";
  lesson: string;
  candidateImprovement?: string;
  sourceTrust: SkillSourceTrust;
  mayPromoteAutomatically: boolean;
  requiresHumanApproval: boolean;
  evidence?: Record<string, unknown>;
};

export type SkillPatchOperation =
  | {
      type: "json_frontmatter_patch";
      operation?: "add" | "replace";
      path: string;
      value: unknown;
    }
  | {
      type: "text_patch";
      oldString: string;
      newString: string;
      replaceAll?: boolean;
    };

export type SkillPatchRiskLevel = "low" | "medium" | "high";

export type SkillPatchProposal = {
  id: string;
  skillName: string;
  source?: SkillSourceKind;
  createdAt: string;
  reason: string;
  confidence: number;
  evidence: {
    observations: string[];
    successes: number;
    failures: number;
  };
  sourceTrust: SkillSourceTrust;
  mayPromoteAutomatically: boolean;
  requiresHumanApproval: boolean;
  patch: SkillPatchOperation;
  status: "proposed" | "promoted" | "rejected";
  promotedAt?: string;
  rejectedAt?: string;
  approvedAt?: string;
  approvedBy?: string;
  promotionId?: string;
  changeManifestId?: string;
};

export type SkillEvalRunRecord = {
  id: string;
  skillName: string;
  evalId: string;
  ranAt: string;
  score: number;
  passed: boolean;
  details: Record<string, boolean>;
  threshold: number;
};

export type SkillPromotionEvalDelta = {
  beforeScore?: number;
  afterScore: number;
  delta?: number;
  failedCases: string[];
  newlyPassingCases: string[];
  newlyFailingCases: string[];
};

export type SkillPromotionRecord = {
  id: string;
  proposalId: string;
  skillName: string;
  appliedAt: string;
  snapshotPath?: string;
  fromSnapshot?: string;
  fromVersion?: string;
  toVersion?: string;
  reason: string;
  evidence: SkillPatchProposal["evidence"];
  sourceTrust: SkillSourceTrust;
  requiresHumanApproval: boolean;
  diffSummary?: string;
  riskLevel?: SkillPatchRiskLevel;
  evalDelta?: SkillPromotionEvalDelta;
  checks: {
    schema: "passed" | "failed";
    frontmatter: "passed" | "failed";
    smoke: "not-run" | "passed" | "failed";
    evals: "not-run" | "passed" | "failed";
  };
};

type UsageFile = {
  version: 1;
  skills: SkillUsageRecord[];
};

export class SkillEvolutionStore {
  readonly #usagePath: string;
  readonly #evolutionRoot: string;
  readonly #now: () => Date;
  #usage = new Map<string, SkillUsageRecord>();
  #loaded = false;

  constructor(options: {
    usagePath: string;
    evolutionRoot: string;
    now?: () => Date;
  }) {
    this.#usagePath = options.usagePath;
    this.#evolutionRoot = options.evolutionRoot;
    this.#now = options.now ?? (() => new Date());
  }

  get usagePath(): string {
    return this.#usagePath;
  }

  get evolutionRoot(): string {
    return this.#evolutionRoot;
  }

  async recordSkillOutcome(input: {
    skill: LoadedSkill | SkillDefinition;
    outcome: SkillOutcome;
    sessionId?: string;
    promptSummary?: string;
    selectedWorkflowStep?: string;
    toolExecutions: ToolExecutionRecord[];
  }): Promise<SkillObservationRecord> {
    const now = this.#nowIso();
    const source = skillSource(input.skill);
    const usage = await this.#updateUsage(input.skill.name, source, (record) => {
      record.state = "active";
      if (input.outcome.status === "succeeded") {
        record.successCount += 1;
        record.lastSucceededAt = now;
      } else {
        record.failureCount += 1;
        record.lastFailedAt = now;
      }
    });
    const observation: SkillObservationRecord = {
      id: `obs_${randomUUID()}`,
      skillName: input.skill.name,
      source,
      sessionId: input.sessionId,
      timestamp: now,
      type: observationTypeForOutcome(input.outcome.status),
      promptSummary: input.promptSummary,
      selectedWorkflowStep: input.selectedWorkflowStep,
      toolsAttempted: input.toolExecutions.map((execution) => execution.tool.name),
      outcome: input.outcome.status,
      lesson: defaultLesson(input.outcome),
      sourceTrust: "runtime_internal",
      mayPromoteAutomatically: input.outcome.status === "succeeded",
      requiresHumanApproval: input.outcome.status !== "succeeded",
      evidence: {
        useCount: usage.useCount,
        successCount: usage.successCount,
        failureCount: usage.failureCount,
        summary: input.outcome.summary
      }
    };
    await this.appendObservation(observation);
    return observation;
  }

  async recordSkillUsed(input: {
    skill: LoadedSkill | SkillDefinition;
    selectedAt?: string;
  }): Promise<SkillUsageRecord> {
    const now = input.selectedAt ?? this.#nowIso();
    return await this.#updateUsage(input.skill.name, skillSource(input.skill), (record) => {
      record.useCount += 1;
      record.lastUsedAt = now;
      record.state = "active";
    });
  }

  async recordSkillViewed(input: {
    skillName: string;
    source?: SkillSourceKind;
    provenanceKind?: SkillProvenanceKind;
  }): Promise<SkillUsageRecord> {
    const now = this.#nowIso();
    return await this.#updateUsage(input.skillName, input.source, (record) => {
      record.provenanceKind = input.provenanceKind ?? record.provenanceKind;
      record.viewCount += 1;
      record.lastViewedAt = now;
    });
  }

  async recordSkillRouteTelemetry(input: SkillRouteTelemetry): Promise<SkillUsageRecord> {
    return await this.#updateUsage(input.skillName, input.sourceKind, (record) => {
      record.routeMatchCount += 1;
      record.lastMatchedAt = input.matchedAt;
      if (input.selected) {
        record.routeSelectedCount += 1;
        record.lastSelectedAt = input.matchedAt;
      } else {
        record.routeRejectedCount += 1;
      }
    });
  }

  async recordMutation(input: {
    skillName: string;
    source?: SkillSourceKind;
    provenanceKind?: SkillProvenanceKind;
    kind: "created" | "patched" | "edited" | "deleted" | "rolled-back" | "promoted";
  }): Promise<SkillUsageRecord> {
    const now = this.#nowIso();
    return await this.#updateUsage(input.skillName, input.source, (record) => {
      record.provenanceKind = input.provenanceKind ?? record.provenanceKind;
      record.lastUsedAt = now;
      if (input.kind === "patched" || input.kind === "edited" || input.kind === "promoted") {
        record.patchCount += 1;
        record.lastPatchedAt = now;
      }
      if (input.kind === "rolled-back") {
        record.rollbackCount += 1;
      }
      if (record.pinned) {
        return;
      }
      if (input.kind === "deleted") {
        record.state = "archived";
        record.archivedAt = now;
      } else {
        record.state = "active";
        record.archivedAt = undefined;
      }
    });
  }

  async pinSkill(skillName: string, source?: SkillSourceKind): Promise<SkillUsageRecord> {
    return await this.#updateUsage(skillName, source, (record) => {
      record.pinned = true;
    });
  }

  async unpinSkill(skillName: string, source?: SkillSourceKind): Promise<SkillUsageRecord> {
    return await this.#updateUsage(skillName, source, (record) => {
      record.pinned = false;
    });
  }

  async archiveSkill(skillName: string, source?: SkillSourceKind): Promise<SkillUsageRecord> {
    const now = this.#nowIso();
    return await this.#updateUsage(skillName, source, (record) => {
      if (record.pinned) {
        return;
      }
      record.state = "archived";
      record.archivedAt = now;
    });
  }

  async restoreSkill(skillName: string, source?: SkillSourceKind): Promise<SkillUsageRecord> {
    return await this.#updateUsage(skillName, source, (record) => {
      if (record.pinned) {
        return;
      }
      record.state = "active";
      record.archivedAt = undefined;
    });
  }

  async usage(): Promise<SkillUsageRecord[]> {
    await this.#ensureLoaded();
    return [...this.#usage.values()]
      .map((record) => ({ ...record }))
      .sort((left, right) => left.skillName.localeCompare(right.skillName));
  }

  async getUsage(skillName: string): Promise<SkillUsageRecord | undefined> {
    await this.#ensureLoaded();
    const record = this.#usage.get(skillName);
    return record === undefined ? undefined : { ...record };
  }

  async appendObservation(input: Omit<SkillObservationRecord, "id" | "timestamp" | "toolsAttempted" | "outcome" | "sourceTrust" | "mayPromoteAutomatically" | "requiresHumanApproval"> & Partial<Pick<SkillObservationRecord, "id" | "timestamp" | "toolsAttempted" | "outcome" | "sourceTrust" | "mayPromoteAutomatically" | "requiresHumanApproval">>): Promise<SkillObservationRecord> {
    const sourceTrust = input.sourceTrust ?? "user_direct";
    const observation: SkillObservationRecord = {
      id: input.id ?? `obs_${randomUUID()}`,
      skillName: input.skillName,
      source: input.source,
      sessionId: input.sessionId,
      timestamp: input.timestamp ?? this.#nowIso(),
      type: input.type,
      promptSummary: input.promptSummary,
      selectedWorkflowStep: input.selectedWorkflowStep,
      toolsAttempted: input.toolsAttempted ?? [],
      outcome: input.outcome ?? outcomeForObservationType(input.type),
      lesson: input.lesson,
      candidateImprovement: input.candidateImprovement,
      sourceTrust,
      mayPromoteAutomatically: input.mayPromoteAutomatically ?? sourceTrustAllowsAutomaticPromotion(sourceTrust),
      requiresHumanApproval: input.requiresHumanApproval ?? !sourceTrustAllowsAutomaticPromotion(sourceTrust),
      evidence: input.evidence
    };
    await this.#appendJsonl("observations.jsonl", observation);
    return observation;
  }

  async proposePatch(input: {
    skillName: string;
    source?: SkillSourceKind;
    reason: string;
    confidence?: number;
    observationIds?: string[];
    successes?: number;
    failures?: number;
    sourceTrust?: SkillSourceTrust;
    mayPromoteAutomatically?: boolean;
    requiresHumanApproval?: boolean;
    patch: SkillPatchOperation;
    changeManifestId?: string;
  }): Promise<SkillPatchProposal> {
    const sourceTrust = input.sourceTrust ?? "user_direct";
    const proposal: SkillPatchProposal = {
      id: `patch_${randomUUID()}`,
      skillName: input.skillName,
      source: input.source,
      createdAt: this.#nowIso(),
      reason: input.reason,
      confidence: clampConfidence(input.confidence ?? 0.5),
      evidence: {
        observations: input.observationIds ?? [],
        successes: input.successes ?? 0,
        failures: input.failures ?? 0
      },
      sourceTrust,
      mayPromoteAutomatically: input.mayPromoteAutomatically ?? sourceTrustAllowsAutomaticPromotion(sourceTrust),
      requiresHumanApproval: input.requiresHumanApproval ?? !sourceTrustAllowsAutomaticPromotion(sourceTrust),
      patch: input.patch,
      status: "proposed",
      changeManifestId: input.changeManifestId
    };
    await this.#appendJsonl("proposed-patches.jsonl", proposal);
    return proposal;
  }

  async listProposals(filter: { skillName?: string; status?: SkillPatchProposal["status"] } = {}): Promise<SkillPatchProposal[]> {
    const proposals = await this.#readJsonl<SkillPatchProposal>("proposed-patches.jsonl");
    return proposals.filter((proposal) =>
      (filter.skillName === undefined || proposal.skillName === filter.skillName) &&
      (filter.status === undefined || proposal.status === filter.status)
    );
  }

  async findProposal(id: string): Promise<SkillPatchProposal | undefined> {
    return (await this.listProposals()).find((proposal) => proposal.id === id);
  }

  async approveProposal(id: string, approvedBy = "user"): Promise<SkillPatchProposal | undefined> {
    return await this.#rewriteProposal(id, (proposal) => ({
      ...proposal,
      approvedAt: this.#nowIso(),
      approvedBy,
      requiresHumanApproval: false
    }));
  }

  async listObservations(filter: { skillName?: string; ids?: string[] } = {}): Promise<SkillObservationRecord[]> {
    const observations = await this.#readJsonl<SkillObservationRecord>("observations.jsonl");
    const idFilter = filter.ids === undefined ? undefined : new Set(filter.ids);
    return observations.filter((observation) =>
      (filter.skillName === undefined || observation.skillName === filter.skillName) &&
      (idFilter === undefined || idFilter.has(observation.id))
    );
  }

  async recordPromotion(input: {
    proposal: SkillPatchProposal;
    skillName: string;
    snapshotPath?: string;
    fromVersion?: string;
    toVersion?: string;
    diffSummary?: string;
    riskLevel?: SkillPatchRiskLevel;
    evalDelta?: SkillPromotionEvalDelta;
    checks?: Partial<SkillPromotionRecord["checks"]>;
  }): Promise<SkillPromotionRecord> {
    const appliedAt = this.#nowIso();
    const promotion: SkillPromotionRecord = {
      id: `promo_${randomUUID()}`,
      proposalId: input.proposal.id,
      skillName: input.skillName,
      appliedAt,
      snapshotPath: input.snapshotPath,
      fromSnapshot: input.snapshotPath,
      fromVersion: input.fromVersion,
      toVersion: input.toVersion,
      reason: input.proposal.reason,
      evidence: input.proposal.evidence,
      sourceTrust: input.proposal.sourceTrust,
      requiresHumanApproval: input.proposal.requiresHumanApproval,
      diffSummary: input.diffSummary,
      riskLevel: input.riskLevel,
      evalDelta: input.evalDelta,
      checks: {
        schema: "passed",
        frontmatter: "passed",
        smoke: "not-run",
        evals: "not-run",
        ...input.checks
      }
    };
    await this.#appendJsonl("promotions.jsonl", promotion);
    await this.#rewriteProposal(input.proposal.id, (proposal) => ({
      ...proposal,
      status: "promoted",
      promotedAt: promotion.appliedAt,
      promotionId: promotion.id
    }));
    await this.recordMutation({
      skillName: input.skillName,
      kind: "promoted"
    });
    return promotion;
  }

  async recordEvalRun(input: {
    skillName: string;
    evalId: string;
    score: number;
    passed: boolean;
    details: Record<string, boolean>;
    threshold: number;
  }): Promise<SkillEvalRunRecord> {
    const record: SkillEvalRunRecord = {
      id: `eval_${randomUUID()}`,
      skillName: input.skillName,
      evalId: input.evalId,
      ranAt: this.#nowIso(),
      score: clampConfidence(input.score),
      passed: input.passed,
      details: input.details,
      threshold: clampConfidence(input.threshold)
    };
    await this.#appendJsonl("eval-runs.jsonl", record);
    return record;
  }

  async listEvalRuns(filter?: { skillName?: string }): Promise<SkillEvalRunRecord[]> {
    const runs = await this.#readJsonl<SkillEvalRunRecord>("eval-runs.jsonl");
    if (filter?.skillName === undefined) {
      return runs;
    }
    return runs.filter((r) => r.skillName === filter.skillName);
  }

  async listPromotions(filter?: { skillName?: string; proposalId?: string }): Promise<SkillPromotionRecord[]> {
    const promotions = await this.#readJsonl<SkillPromotionRecord>("promotions.jsonl");
    return promotions.filter((p) =>
      (filter?.skillName === undefined || p.skillName === filter.skillName) &&
      (filter?.proposalId === undefined || p.proposalId === filter.proposalId)
    );
  }

  async findPromotion(id: string): Promise<SkillPromotionRecord | undefined> {
    return (await this.listPromotions()).find((p) => p.id === id);
  }

  async rejectProposal(id: string): Promise<SkillPatchProposal | undefined> {
    return await this.#rewriteProposal(id, (proposal) => ({
      ...proposal,
      status: "rejected",
      rejectedAt: this.#nowIso()
    }));
  }

  async #rewriteProposal(id: string, update: (proposal: SkillPatchProposal) => SkillPatchProposal): Promise<SkillPatchProposal | undefined> {
    const proposals = await this.#readJsonl<SkillPatchProposal>("proposed-patches.jsonl");
    let updated: SkillPatchProposal | undefined;
    const next = proposals.map((proposal) => {
      if (proposal.id !== id) {
        return proposal;
      }
      updated = update(proposal);
      return updated;
    });
    if (updated === undefined) {
      return undefined;
    }
    await this.#writeJsonl("proposed-patches.jsonl", next);
    return updated;
  }

  async #updateUsage(
    skillName: string,
    source: SkillSourceKind | undefined,
    update: (record: SkillUsageRecord) => void
  ): Promise<SkillUsageRecord> {
    await this.#ensureLoaded();
    const record = this.#usage.get(skillName) ?? defaultUsageRecord(skillName, source);
    if (source !== undefined) {
      record.source = source;
    }
    update(record);
    this.#usage.set(skillName, record);
    await this.#flushUsage();
    return { ...record };
  }

  async #ensureLoaded(): Promise<void> {
    if (this.#loaded) {
      return;
    }
    const raw = await readFile(this.#usagePath, "utf8").catch(() => undefined);
    if (raw !== undefined) {
      try {
        const parsed = JSON.parse(raw) as UsageFile;
        for (const record of parsed.skills ?? []) {
          this.#usage.set(record.skillName, {
            ...defaultUsageRecord(record.skillName, record.source),
            ...record
          });
        }
      } catch {
        const corruptPath = `${this.#usagePath}.corrupt-${this.#nowIso().replace(/[:.]/gu, "-")}`;
        await rename(this.#usagePath, corruptPath).catch(() => undefined);
        this.#usage.clear();
      }
    }
    this.#loaded = true;
  }

  async #flushUsage(): Promise<void> {
    const payload: UsageFile = {
      version: 1,
      skills: [...this.#usage.values()].sort((left, right) => left.skillName.localeCompare(right.skillName))
    };
    await atomicWriteJson(this.#usagePath, payload);
  }

  async #appendJsonl(file: string, value: unknown): Promise<void> {
    await mkdir(this.#evolutionRoot, { recursive: true });
    await appendFile(join(this.#evolutionRoot, file), `${JSON.stringify(value)}\n`, "utf8");
  }

  async #readJsonl<T>(file: string): Promise<T[]> {
    const raw = await readFile(join(this.#evolutionRoot, file), "utf8").catch(() => "");
    return raw
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as T];
        } catch {
          return [];
        }
      });
  }

  async #writeJsonl(file: string, values: unknown[]): Promise<void> {
    await mkdir(this.#evolutionRoot, { recursive: true });
    await writeFile(join(this.#evolutionRoot, file), values.map((value) => JSON.stringify(value)).join("\n") + "\n", "utf8");
  }

  #nowIso(): string {
    return this.#now().toISOString();
  }
}

function defaultUsageRecord(skillName: string, source: SkillSourceKind | undefined): SkillUsageRecord {
  return {
    skillName,
    source,
    useCount: 0,
    viewCount: 0,
    successCount: 0,
    failureCount: 0,
    routeMatchCount: 0,
    routeSelectedCount: 0,
    routeRejectedCount: 0,
    patchCount: 0,
    rollbackCount: 0,
    pinned: false,
    state: "active"
  };
}

function skillSource(skill: LoadedSkill | SkillDefinition): SkillSourceKind | undefined {
  return "sourceKind" in skill ? skill.sourceKind : undefined;
}

function observationTypeForOutcome(status: SkillOutcome["status"]): SkillObservationType {
  if (status === "succeeded") return "success";
  if (status === "blocked") return "blocked";
  if (status === "partial") return "partial";
  return "failure";
}

function outcomeForObservationType(type: SkillObservationType): SkillObservationRecord["outcome"] {
  if (type === "success") return "succeeded";
  if (type === "blocked") return "blocked";
  if (type === "partial") return "partial";
  return "failed";
}

function defaultLesson(outcome: SkillOutcome): string {
  if (outcome.status === "succeeded") {
    return `Skill completed successfully using ${outcome.tools.join(", ") || "no tools"}.`;
  }
  return `Skill ended with status ${outcome.status}: ${outcome.summary}`;
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) {
    return 0.5;
  }
  return Math.max(0, Math.min(1, value));
}

function sourceTrustAllowsAutomaticPromotion(sourceTrust: SkillSourceTrust): boolean {
  return sourceTrust === "runtime_internal" || sourceTrust === "developer";
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${randomUUID()}`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temp, path);
}
