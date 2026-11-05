import type { RegisteredTool } from "../contracts/tool.js";
import { createHash, randomUUID } from "node:crypto";
import { isTerminalTaskStatus } from "../contracts/task.js";
import type { TaskStore } from "../tasks/task-store.js";
import { withProfileWriteLock } from "../config/profile-write-lock.js";
import { constants } from "node:fs";
import { learningDraftEvidence, learningFindings, learningLesson, type LearningTurnDiagnostics } from "./learning-diagnostics.js";
import * as fs from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { AgentEvolutionPolicy } from "../contracts/agent-evolution.js";
import type { ProviderUsageLineage } from "../contracts/provider-usage.js";
import { SkillDraftError, buildSkillReviewContext, clipSkillReviewText, type SkillDrafter } from "./skill-draft.js";
import { redactSensitiveText } from "../utils/redaction.js";
import { SkillProposalService, readBoundedSkillFile } from "./skill-proposal-service.js";
import { parseSkillFile } from "./skill-loader.js";
import { skillContentHash } from "./skill-task-evaluation.js";
import type { SessionDB } from "../contracts/session.js";
import type {
  LoadedSkill,
  SkillDefinition,
  SkillRouteCorrectionSignal,
  SkillRouteFinalOutcomeStatus,
  SkillRouteNoSkillResult,
  SkillRouteRejectedCandidate
} from "../contracts/skill.js";
import type { ToolRiskClass, ToolsetName } from "../contracts/tool.js";
import type { ToolExecutionRecord } from "../tools/tool-executor.js";
import { stripInlineReasoning } from "../providers/provider-reasoning.js";
import type { SkillRegistry } from "./skill-registry.js";
import type { SkillEvolutionStore, SkillLearningCandidate, SkillObservationRecord } from "./skill-evolution.js";

export type SkillAutonomy = "none" | "suggest" | "proactive" | "autonomous";

export type SkillLearningRecord = {
  key: string;
  name: string;
  content: string;
  occurrences: number;
  sourceSessionIds: string[];
  tools: string[];
  requiredToolsets: ToolsetName[];
  bounded: boolean;
  boundedReason?: string;
  status: "observed" | "candidate" | "created" | "stale";
  staleReason?: "created-path-missing" | "created-path-outside-profile";
  staleDetectedAt?: string;
  evidenceIds?: string[];
  candidateId?: string;
  candidateKind?: SkillLearningCandidate["kind"];
  promptHash?: string;
  selectedSkillName?: string;
  createdSkillName?: string;
  createdSkillPath?: string;
  updatedAt: string;
  draftAttemptedAt?: string;
  draftProposalId?: string;
  draftStatus?: "pending" | "attempted" | "proposed" | "abstained" | "promoted" | "failed";
  draftFailure?: string;
  draftAttempts?: number;
  draftCandidateId?: string;
  draftClaim?: { id: string; expiresAt: number };
};

type DeferredSkillTurn = {
  id: string; profileId: string; sessionId: string; taskIds: string[];
  skillName?: string; skillRevision?: string; promptSummary: string; promptHash?: string;
};

type PendingSkillReview = { id: string; profileId: string; sessionId: string; workspaceIdentityHash?: string };
const REVIEW_TIMEOUT_MS = 120_000;
const REVIEW_LEASE_MS = 600_000;

type SkillReviewRequest = {
  workspaceIdentityHash?: string;
  profileId: string;
  sessionId: string;
  agentEvolutionPolicy: AgentEvolutionPolicy;
  validateAuthority: () => Promise<void>;
  onSkillUpdated?: (skillName: string, proposalId: string) => Promise<void>;
};

type SkillLearningFile = {
  version: 1;
  records: SkillLearningRecord[];
  draftBudget?: { day: string; attempts: number };
  deferredTurns?: DeferredSkillTurn[];
  pendingReviews?: PendingSkillReview[];
};

export type SkillLearningObservation =
  | {
      action: "observed" | "candidate";
      record: SkillLearningRecord;
      evidence?: SkillObservationRecord;
      candidate?: SkillLearningCandidate;
    };

type SelectedSkillSuggestedTarget = Extract<
  SkillLearningCandidate,
  { kind: "selected_skill_refinement" }
>["suggestedTarget"];
type MissingPlaybookSuggestedTarget = Extract<
  SkillLearningCandidate,
  { kind: "new_or_missing_playbook" }
>["suggestedTarget"];
type LearningSuggestedTarget = SelectedSkillSuggestedTarget | MissingPlaybookSuggestedTarget;

export class SkillLearningManager {
  readonly #autonomy: SkillAutonomy;
  readonly #store: SkillLearningStore;
  readonly #sessionDb: SessionDB;
  readonly #skillEvolutionStore: SkillEvolutionStore | undefined;
  readonly #registry: SkillRegistry;
  readonly #draft: SkillDrafter | undefined;
  readonly #reviewTools: ((input: { sessionId: string; skillName: string; taskIds: string[] }) => readonly RegisteredTool[]) | undefined;
  readonly #proposals: SkillProposalService | undefined;
  #review: Promise<void> | undefined;
  #reviewController: AbortController | undefined;
  readonly #reviewQueue = new Map<string, SkillReviewRequest & { job: PendingSkillReview }>();
  #reviewWrites: Promise<void> = Promise.resolve();
  readonly #reviewUsage = new Map<string, ProviderUsageLineage>();

  constructor(options: {
    autonomy: SkillAutonomy;
    registry: SkillRegistry;
    localSkillsRoot: string;
    storePath: string;
    sessionDb: SessionDB;
    skillEvolutionStore?: SkillEvolutionStore;
    drafter?: SkillDrafter;
    reviewTools?: (input: { sessionId: string; skillName: string; taskIds: string[] }) => readonly RegisteredTool[];
    proposalService?: SkillProposalService;
  }) {
    this.#autonomy = options.autonomy;
    this.#store = new SkillLearningStore({
      path: options.storePath,
      localSkillsRoot: options.localSkillsRoot
    });
    this.#sessionDb = options.sessionDb;
    this.#skillEvolutionStore = options.skillEvolutionStore;
    this.#registry = options.registry;
    this.#draft = options.drafter;
    this.#reviewTools = options.reviewTools;
    this.#proposals = options.proposalService;
  }

  async observeTurn(input: {
    delegatedTaskIds?: string[];
    settledTaskEvidence?: { id: string; taskIds: string[]; failures: string[]; acceptedResults: number; diagnosticResults: number; results: Array<{taskId: string; resultId: string; disposition: string}> };
    signal?: AbortSignal;
    usage?: ProviderUsageLineage;
    profileId: string;
    sessionId: string;
    userText: string;
    selectedSkill: LoadedSkill | SkillDefinition | undefined;
    finalSkillUsed?: string;
    noSkillResult?: SkillRouteNoSkillResult;
    routeConfidence?: number;
    promptHash?: string;
    outcomeStatus?: SkillRouteFinalOutcomeStatus;
    turnDiagnostics?: LearningTurnDiagnostics;
    correctionSignals?: SkillRouteCorrectionSignal[];
    modelSelfCorrectionSignal?: string;
    candidatesShown?: string[];
    candidatesRejected?: SkillRouteRejectedCandidate[];
    searchedReplacementSkill?: string;
    agentEvolutionPolicy: AgentEvolutionPolicy;
    toolExecutions: ToolExecutionRecord[];
  }): Promise<SkillLearningObservation | undefined> {
    if (input.usage) {
      this.#reviewUsage.delete(input.sessionId);
      this.#reviewUsage.set(input.sessionId, input.usage);
      if (this.#reviewUsage.size > 100) this.#reviewUsage.delete(this.#reviewUsage.keys().next().value!);
    }
    if (
      this.#autonomy === "none" ||
      !input.agentEvolutionPolicy.observeTurns ||
      !input.agentEvolutionPolicy.createEvidence ||
      this.#skillEvolutionStore === undefined
    ) {
      return undefined;
    }

    if (input.delegatedTaskIds?.length) {
      const taskIds = [...new Set(input.delegatedTaskIds)].sort();
      const id = createHash("sha256").update(JSON.stringify([input.profileId, input.sessionId, taskIds])).digest("hex");
      await this.#store.defer({ id, profileId: input.profileId, sessionId: input.sessionId, taskIds,
        skillName: input.selectedSkill?.name,
        skillRevision: input.selectedSkill ? skillDefinitionRevision(input.selectedSkill) : undefined,
        promptSummary: promptSummaryForLearning(input.userText).slice(0, 2000), promptHash: input.promptHash });
      return undefined;
    }

    const selectedSkill = input.selectedSkill;
    if (selectedSkill !== undefined) {
      if (!input.agentEvolutionPolicy.observeSelectedSkillTurns) {
        return undefined;
      }
      return await this.#observeSelectedSkillTurn({
        ...input,
        selectedSkill
      });
    }

    const workflow = detectWorkflow({
      userText: input.userText,
      toolExecutions: input.toolExecutions
    });
    if (workflow === undefined) {
      return undefined;
    }
    const existing = await this.#store.get(workflow.key);
    if (existing?.status === "stale") {
      return undefined;
    }
    const suggestedTarget = noSkillSuggestedTarget(input, workflow, existing);

    const evidence = await this.#skillEvolutionStore.appendObservation({
      skillName: workflow.name,
      sessionId: input.sessionId,
      type: observationTypeFromOutcome(input.outcomeStatus),
      promptSummary: workflow.content,
      toolsAttempted: workflow.tools,
      outcome: observationOutcomeFromFinalStatus(input.outcomeStatus),
      lesson: learningLesson(learningFindings(input.toolExecutions, input.turnDiagnostics), `No skill was selected for a local workflow using ${workflow.tools.join(", ")}.`),
      candidateImprovement: candidateImprovementForSuggestedTarget(suggestedTarget),
      sourceTrust: "runtime_internal",
      mayPromoteAutomatically: false,
      requiresHumanApproval: true,
      evidence: buildLearningEvidence(input, {
        workflowKey: workflow.key,
        bounded: workflow.bounded,
        boundedReason: workflow.boundedReason,
        requiredToolsets: workflow.requiredToolsets
      })
    });
    const candidate = await this.#skillEvolutionStore.appendLearningCandidate({
      kind: "new_or_missing_playbook",
      evidenceIds: [evidence.id],
      suggestedTarget,
      reason: reasonForSuggestedTarget(suggestedTarget),
      confidence: confidenceFromObservation(input.routeConfidence, confidenceFallbackForSuggestedTarget(suggestedTarget)),
      sessionId: input.sessionId,
      promptHash: input.promptHash
    });
    const record = await this.#store.observe({
      key: workflow.key,
      name: workflow.name,
      content: workflow.content,
      sessionId: input.sessionId,
      tools: workflow.tools,
      requiredToolsets: workflow.requiredToolsets,
      bounded: workflow.bounded,
      boundedReason: workflow.boundedReason,
      evidenceId: evidence.id,
      candidateId: candidate.id,
      candidateKind: candidate.kind,
      promptHash: input.promptHash
    });

    if (record.status === "created") {
      return undefined;
    }

    if (record.occurrences >= 2 && record.status !== "candidate") {
      const candidateRecord = await this.#store.markCandidate(record.key);
      await this.#sessionDb.appendEvent(input.sessionId, {
        kind: "skill-learned",
        action: "candidate",
        record: candidateRecord
      });
      return {
        action: "candidate",
        record: candidateRecord,
        evidence,
        candidate
      };
    }

    await this.#sessionDb.appendEvent(input.sessionId, {
      kind: "skill-learned",
      action: "observed",
      record
    });
    return {
      action: "observed",
      record,
      evidence,
      candidate
    };
  }

  /** Reconciles persisted handoffs from authoritative Task receipts, also on restart. */
  async reconcileSettledTasks(input: { store: TaskStore; profileId: string; workspaceIdentityHash?: string; agentEvolutionPolicy: AgentEvolutionPolicy;
    validateAuthority: () => Promise<void> }): Promise<string[]> {
    if (input.store.profileId !== input.profileId || !input.agentEvolutionPolicy.observeTurns ||
        !input.agentEvolutionPolicy.createEvidence || !this.#skillEvolutionStore) return [];
    const sessions = new Set<string>();
    for (const pending of await this.#store.deferred()) {
      if (pending.profileId !== input.profileId || !await this.#sessionDb.getSessionForProfile(pending.sessionId, input.profileId)) continue;
      const tasks = pending.taskIds.map(id => input.store.getTask(id));
      if (tasks.some(task => !task || task.originSessionId !== pending.sessionId || !isTerminalTaskStatus(task.status) ||
          (input.workspaceIdentityHash !== undefined && task.workspace.identityHash !== input.workspaceIdentityHash))) continue;
      await input.validateAuthority();
      const attempts = tasks.flatMap(task => input.store.listAttempts(task!.id));
      const failures = [...new Set(attempts.flatMap(attempt => attempt.failure ? [attempt.failure.class] : []))];
      const results = tasks.flatMap(task => input.store.listResults(task!.id));
      const outcomeStatus = tasks.every(task => task!.status === "completed") ? "succeeded" as const
        : tasks.some(task => task!.status === "partial" || task!.status === "completed") ? "partial" as const
        : tasks.every(task => task!.status === "cancelled") ? "cancelled" as const : "failed" as const;
      const receipts = { id: pending.id, taskIds: pending.taskIds, failures,
        acceptedResults: results.filter(result => result.disposition === "accepted").length,
        diagnosticResults: results.filter(result => result.disposition === "diagnostic").length,
        results: results.slice(0, 64).map(result => ({ taskId: result.taskId, resultId: result.id, disposition: result.disposition })) };
      const skill = pending.skillName ? this.#registry.get(pending.skillName) : undefined;
      if (skill && skillDefinitionRevision(skill) === pending.skillRevision) {
        await this.observeTurn({ profileId: input.profileId, sessionId: pending.sessionId, userText: pending.promptSummary,
          selectedSkill: skill, outcomeStatus, promptHash: pending.promptHash,
          settledTaskEvidence: receipts, agentEvolutionPolicy: input.agentEvolutionPolicy, toolExecutions: [],
          turnDiagnostics: { delegatedTaskSettled: true, limitReached: failures.includes("execution-limit-exceeded"),
            completionRejected: failures.some(failure => ["completion-validation-failed"].includes(failure)) } });
      } else {
        // A changed/removed skill must not receive a patch based on an old definition.
        await this.#skillEvolutionStore.appendObservation({ id: `obs_task_${pending.id}`,
          skillName: pending.skillName ?? "Delegated workflow", sessionId: pending.sessionId,
          type: observationTypeFromOutcome(outcomeStatus), outcome: observationOutcomeFromFinalStatus(outcomeStatus),
          sourceTrust: "runtime_internal", requiresHumanApproval: true, mayPromoteAutomatically: false,
          lesson: "Delegated work settled. No current matching skill definition is available for a refinement.",
          evidence: { profileId: input.profileId, settledTasks: receipts, outcomeStatus } });
      }
      await this.#store.finishDeferred(pending.id, { id: randomUUID(), profileId: input.profileId, sessionId: pending.sessionId,
        workspaceIdentityHash: tasks[0]!.workspace.identityHash });
      sessions.add(pending.sessionId);
    }
    return [...sessions];
  }

  /** Rehydrate only jobs bound to this profile/workspace using current authority. */
  async resumeBackgroundReviews(input: Omit<SkillReviewRequest, "sessionId">): Promise<void> {
    if (!input.agentEvolutionPolicy.preparePatches || !input.agentEvolutionPolicy.createProposals) return;
    for (const job of await this.#store.pendingReviews()) {
      if (job.profileId !== input.profileId || job.workspaceIdentityHash !== input.workspaceIdentityHash ||
          !await this.#sessionDb.getSessionForProfile(job.sessionId, input.profileId)) continue;
      this.#scheduleReview({ ...input, sessionId: job.sessionId }, job);
    }
  }

  /** Persist the obligation before starting work; delivery does not wait for inference. */
  startBackgroundReview(input: SkillReviewRequest): void {
    if (!input.agentEvolutionPolicy.preparePatches || !input.agentEvolutionPolicy.createProposals) return;
    const job = { id: randomUUID(), profileId: input.profileId, sessionId: input.sessionId,
      workspaceIdentityHash: input.workspaceIdentityHash };
    this.#reviewWrites = this.#reviewWrites.catch(() => undefined).then(() => this.#store.queueReview(job));
    this.#scheduleReview(input, job);
  }

  #scheduleReview(input: SkillReviewRequest, job: PendingSkillReview): void {
    this.#reviewQueue.set(input.sessionId, { ...input, job });
    if (this.#review) return;
    const controller = new AbortController();
    this.#reviewController = controller;
    const deadline = setTimeout(() => controller.abort(), REVIEW_TIMEOUT_MS);
    deadline.unref();
    this.#review = (async () => {
      await this.#reviewWrites;
      await new Promise<void>(resolve => setImmediate(resolve));
      while (this.#reviewQueue.size && !controller.signal.aborted) {
        await this.#reviewWrites;
        const next = this.#reviewQueue.values().next().value!;
        this.#reviewQueue.delete(next.sessionId);
        if (!await this.#sessionDb.getSessionForProfile(next.sessionId, next.profileId)) continue;
        for (const record of (await this.#store.list()).slice(0, 100)) {
          if (controller.signal.aborted) break;
          if (record.status !== "candidate" || !record.candidateId || !record.sourceSessionIds.includes(next.sessionId)) continue;
          await next.validateAuthority();
          const candidate = (await this.#skillEvolutionStore?.listLearningCandidates([record.candidateId]))?.find(item => item.id === record.candidateId);
          if (!candidate || candidate.sessionId !== next.sessionId) continue;
          await this.#prepareDraft(record, candidate, { ...next, usage: this.#reviewUsage.get(next.sessionId), signal: controller.signal });
        }
        if (!controller.signal.aborted) await this.#store.finishReview(next.job);
      }
    })().catch(() => {
      // Pending jobs survive authority, storage, provider and process failures.
    }).finally(() => { clearTimeout(deadline); this.#review = undefined; this.#reviewController = undefined; });
  }

  hasActiveReview(): boolean { return this.#review !== undefined; }
  async waitForBackgroundReview(): Promise<void> { await this.#review; }

  async cancelBackgroundReview(): Promise<void> {
    this.#reviewQueue.clear();
    this.#reviewController?.abort();
    await this.#review;
    await this.#reviewWrites;
  }

  async inspect(): Promise<SkillLearningRecord[]> {
    return this.#store.list();
  }

  async reconcileCreatedPaths(): Promise<{ checked: number; stale: number }> {
    return this.#store.reconcileCreatedPaths();
  }

  async #observeSelectedSkillTurn(input: {
    settledTaskEvidence?: { id: string; taskIds: string[]; failures: string[]; acceptedResults: number; diagnosticResults: number; results: Array<{taskId: string; resultId: string; disposition: string}> };
    signal?: AbortSignal;
    usage?: ProviderUsageLineage;
    profileId: string;
    sessionId: string;
    userText: string;
    selectedSkill: LoadedSkill | SkillDefinition;
    finalSkillUsed?: string;
    noSkillResult?: SkillRouteNoSkillResult;
    routeConfidence?: number;
    promptHash?: string;
    outcomeStatus?: SkillRouteFinalOutcomeStatus;
    turnDiagnostics?: LearningTurnDiagnostics;
    correctionSignals?: SkillRouteCorrectionSignal[];
    modelSelfCorrectionSignal?: string;
    candidatesShown?: string[];
    candidatesRejected?: SkillRouteRejectedCandidate[];
    searchedReplacementSkill?: string;
    agentEvolutionPolicy: AgentEvolutionPolicy;
    toolExecutions: ToolExecutionRecord[];
  }): Promise<SkillLearningObservation | undefined> {
    const tools = successfulToolNames(input.toolExecutions);
    const selectedSkillName = input.selectedSkill.name;
    const finalSkillUsed = input.finalSkillUsed ?? selectedSkillName;
    const suggestedTarget = selectedSkillSuggestedTarget(input, selectedSkillName, finalSkillUsed);
    const evidence = await this.#skillEvolutionStore!.appendObservation({
      id: input.settledTaskEvidence ? `obs_task_${input.settledTaskEvidence.id}` : undefined,
      skillName: selectedSkillName,
      source: "sourceKind" in input.selectedSkill ? input.selectedSkill.sourceKind : undefined,
      sessionId: input.sessionId,
      type: observationTypeFromOutcome(input.outcomeStatus),
      promptSummary: promptSummaryForLearning(input.userText),
      toolsAttempted: tools,
      outcome: observationOutcomeFromFinalStatus(input.outcomeStatus),
      lesson: learningLesson(learningFindings(input.toolExecutions, input.turnDiagnostics), finalSkillUsed === selectedSkillName
        ? `Selected skill ${selectedSkillName} completed with outcome ${input.outcomeStatus ?? "unknown"}.`
        : `Selected skill ${selectedSkillName} was corrected to final skill ${finalSkillUsed}.`),
      candidateImprovement: candidateImprovementForSuggestedTarget(suggestedTarget),
      sourceTrust: "runtime_internal",
      mayPromoteAutomatically: false,
      requiresHumanApproval: true,
      evidence: buildLearningEvidence(input, {
        selectedSkill: selectedSkillName,
        settledTasks: input.settledTaskEvidence,
        finalSkillUsed
      })
    });
    const candidate = await this.#skillEvolutionStore!.appendLearningCandidate({
      id: input.settledTaskEvidence ? `learn_task_${input.settledTaskEvidence.id}` : undefined,
      kind: "selected_skill_refinement",
      selectedSkill: selectedSkillName,
      evidenceIds: [evidence.id],
      suggestedTarget,
      reason: reasonForSuggestedTarget(suggestedTarget),
      confidence: confidenceFromObservation(input.routeConfidence, confidenceFallbackForSuggestedTarget(suggestedTarget)),
      sessionId: input.sessionId,
      promptHash: input.promptHash
    });
    const record = await this.#store.observe({
      key: `selected:${selectedSkillName}:${skillDefinitionRevision(input.selectedSkill)}`,
      name: `${selectedSkillName} refinement`,
      content: `Selected skill refinement evidence: ${selectedSkillName}`,
      sessionId: input.sessionId,
      tools,
      requiredToolsets: input.selectedSkill.requiredToolsets,
      bounded: true,
      boundedReason: "selected-skill-turn",
      evidenceId: evidence.id,
      candidateId: candidate.id,
      candidateKind: candidate.kind,
      promptHash: input.promptHash,
      selectedSkillName
    });
    if (record.status === "stale") {
      return undefined;
    }
    let candidateRecord = record.status === "candidate"
      ? record
      : await this.#store.markCandidate(record.key);
    if (candidateRecord.status === "stale") {
      return undefined;
    }
    // Review is scheduled after delivery; observation never waits for a provider call.

    await this.#sessionDb.appendEvent(input.sessionId, {
      kind: "skill-learned",
      action: "candidate",
      record: candidateRecord
    });

    return {
      action: "candidate",
      record: candidateRecord,
      evidence,
      candidate
    };
  }

  async #prepareDraft(record: SkillLearningRecord, candidate: SkillLearningCandidate, input: {
    profileId: string; sessionId: string; agentEvolutionPolicy: AgentEvolutionPolicy; signal?: AbortSignal; usage?: ProviderUsageLineage; validateAuthority: () => Promise<void>; onSkillUpdated?: (skillName: string, proposalId: string) => Promise<void>;
  }): Promise<SkillLearningRecord> {
    const policy = input.agentEvolutionPolicy;
    if (!this.#proposals || !this.#skillEvolutionStore || !policy.preparePatches || !policy.createProposals ||
        input.signal?.aborted) return record;
    const today = new Date().toISOString().slice(0, 10);
    const proposals = await this.#proposals.listProposals();
    const limit = Math.min(3, policy.budgets.maxProposalsPerDay ?? 3);
    const existingProposal = proposals.find(item => item.evidenceIds?.some(id => record.evidenceIds?.includes(id)));
    if (existingProposal) return this.#store.reconcileProposal(record.key, existingProposal.id, existingProposal.status);
    if (!Number.isFinite(limit) || proposals.filter(item => item.createdAt.startsWith(today)).length >= limit ||
        proposals.some(item => item.status === "proposed" && candidate.kind === "selected_skill_refinement" && item.skillName === candidate.selectedSkill)) return record;
    const skill = candidate.kind === "selected_skill_refinement" ? this.#registry.get(candidate.selectedSkill) : undefined;
    // Changed definitions must collect fresh evidence instead of applying an older lesson.
    if (skill && record.key !== `selected:${skill.name}:${skillDefinitionRevision(skill)}`) return record;
    const evidence = (await this.#skillEvolutionStore.listObservations({ ids: record.evidenceIds }))
      .filter(item => item.sourceTrust === "runtime_internal");
    // Replay only the active profile/session for the skill actually observed there, not other chats.
    const selectedHere = candidate.kind === "selected_skill_refinement" && evidence.some(item => item.sessionId === input.sessionId);
    if (candidate.kind === "selected_skill_refinement" && !selectedHere) return record;
    const context = selectedHere ? buildSkillReviewContext(await this.#sessionDb.listMessages(input.sessionId)) : undefined;
    if (!context?.messages.length && new Set(evidence.map(item => item.sessionId).filter(Boolean)).size < 2) return record;
    if (!context?.messages.length && evidence.every(item => learningDraftEvidence(item.evidence).runtimeOnly)) return record;
    const claim = await this.#store.claimDraft(record.key, limit, candidate.id);
    if (!claim) return record;
    const recordDraft = (key: string, status: NonNullable<SkillLearningRecord["draftStatus"]>, proposalId?: string, failure?: string) =>
      this.#store.recordDraft(key, status, proposalId, failure, claim);
    const validateClaim = async () => {
      await input.validateAuthority();
      if (!await this.#store.ownsClaim(record.key, claim)) throw new SkillDraftError("policy-blocked");
    };
    record = (await this.#store.get(record.key))!;
    // Missing coverage and route corrections become review proposals, never invented executable skills.
    if (!skill || !("sourcePath" in skill) || !("sourceRoot" in skill) || typeof skill.sourcePath !== "string" || typeof skill.sourceRoot !== "string" || candidate.suggestedTarget !== "skill_patch") {
      try {
        await validateClaim();
        if (input.signal?.aborted) return await recordDraft(record.key, "pending");
        const result = await this.#proposals.createProposalFromLearningCandidate({
          candidate: { ...candidate, evidenceIds: evidence.map(item => item.id) }, agentEvolutionPolicy: policy
        });
        if (result.ok) return await recordDraft(record.key, "proposed", result.proposal.id);
      } catch {
        return recordDraft(record.key, "failed", undefined, "evidence-unavailable");
      }
      return recordDraft(record.key, "failed", undefined, "proposal-rejected");
    }
    if (!this.#draft) return recordDraft(record.key, "failed", undefined, "review-unavailable");
    try {
      const content = await readBoundedSkillFile(skill.sourceRoot, skill.sourcePath);
      const diskSkill = parseSkillFile(skill.sourcePath, content, { sourceRoot: skill.sourceRoot, sourceKind: (skill as LoadedSkill).sourceKind });
      if (skillDefinitionRevision(diskSkill) !== skillDefinitionRevision(skill)) return await recordDraft(record.key, "failed", undefined, "stale-evidence");
      if (content.length > 20_000) return await recordDraft(record.key, "failed", undefined, "evidence-unavailable");
      const references = [];
      const skillRoot = dirname(skill.sourcePath);
      for (const resource of ((skill as LoadedSkill).resources ?? []).filter(item => item.kind === "reference").slice(0, 2)) {
        try {
          const text = await readBoundedSkillFile(skillRoot, resolve(skillRoot, resource.path));
          references.push({ path: resource.path, content: clipSkillReviewText(redactSensitiveText(text), 4_000) });
        } catch { references.push({ path: resource.path, content: "Reference unavailable for review." }); }
      }
      const patch = await this.#draft({
        content, reviewAttempt: record.draftAttempts, candidateId: candidate.id, sessionId: input.sessionId, policy, signal: input.signal, usage: input.usage,
        // Bounded, redacted replay stays ephemeral; only the proposal/evidence IDs are persisted here.
        context, references,
        receipts: evidence.filter(item => item.sessionId === input.sessionId).map(item => item.evidence?.settledTasks).filter(Boolean),
        readTools: this.#reviewTools?.({ sessionId: input.sessionId, skillName: skill.name,
          taskIds: evidence.filter(item => item.sessionId === input.sessionId).flatMap(item => {
            const tasks = item.evidence?.settledTasks;
            return tasks && typeof tasks === "object" && "taskIds" in tasks && Array.isArray(tasks.taskIds)
              ? tasks.taskIds.filter((id): id is string => typeof id === "string") : [];
          }) }),
        evidence: evidence.slice(-6).map((item) => ({ outcome: item.outcome, tools: item.toolsAttempted.slice(0, 20),
          lesson: item.outcome === "succeeded" ? "The task succeeded; preserve effective instructions. Success alone does not establish an improvement." : learningDraftEvidence(item.evidence).lesson }))
      });
      await validateClaim();
      if (patch && !input.signal?.aborted) {
        const result = await this.#proposals.createProposalFromLearningCandidate({
          candidate: { ...candidate, evidenceIds: evidence.map((item) => item.id) },
          agentEvolutionPolicy: policy, patch, baseContentHash: skillContentHash(content)
        });
        if (result.ok) {
          await recordDraft(record.key, "proposed", result.proposal.id);
          if (result.proposal.mayPromoteAutomatically && policy.autoPromoteEligibleLocalChanges && !input.signal?.aborted) {
            const promoted = await this.#proposals.promoteProposal(result.proposal.id, { policy, validateAuthority: validateClaim, signal: input.signal });
            if (promoted.ok) {
              const updated = await recordDraft(record.key, "promoted", result.proposal.id);
              // A failed notification must not undo or conceal a successful, recorded update.
              try { await input.onSkillUpdated?.(skill.name, result.proposal.id); } catch { /* Persisted promotion remains inspectable. */ }
              return updated;
            }
          }
          return (await this.#store.get(record.key))!;
        }
        return recordDraft(record.key, "failed", undefined, "proposal-rejected");
      }
    } catch (error) {
      return recordDraft(record.key, "failed", undefined, input.signal?.aborted ? "interrupted" : error instanceof SkillDraftError ? error.reason : "evidence-unavailable");
    }
    return recordDraft(record.key, input.signal?.aborted ? "pending" : "abstained");
  }
}

function buildLearningEvidence(
  input: {
    profileId: string;
    promptHash?: string;
    finalSkillUsed?: string;
    noSkillResult?: SkillRouteNoSkillResult;
    routeConfidence?: number;
    outcomeStatus?: SkillRouteFinalOutcomeStatus;
    turnDiagnostics?: LearningTurnDiagnostics;
    correctionSignals?: SkillRouteCorrectionSignal[];
    modelSelfCorrectionSignal?: string;
    candidatesShown?: string[];
    candidatesRejected?: SkillRouteRejectedCandidate[];
    searchedReplacementSkill?: string;
    toolExecutions: ToolExecutionRecord[];
  },
  extra: Record<string, unknown>
): Record<string, unknown> {
  return {
    profileId: input.profileId,
    promptHash: input.promptHash,
    routeConfidence: input.routeConfidence,
    finalSkillUsed: input.finalSkillUsed,
    noSkillResult: input.noSkillResult,
    outcomeStatus: input.outcomeStatus,
    findings: learningFindings(input.toolExecutions, input.turnDiagnostics),
    turnDiagnostics: input.turnDiagnostics,
    correctionSignals: input.correctionSignals,
    modelSelfCorrectionSignal: input.modelSelfCorrectionSignal,
    candidatesShown: input.candidatesShown,
    candidatesRejected: input.candidatesRejected,
    searchedReplacementSkill: input.searchedReplacementSkill,
    tools: input.toolExecutions.map((execution) => ({
      name: execution.tool.name,
      ok: execution.result?.ok,
      riskClass: execution.riskClass
    })),
    ...extra
  };
}

function selectedSkillSuggestedTarget(
  input: {
    outcomeStatus?: SkillRouteFinalOutcomeStatus;
    turnDiagnostics?: LearningTurnDiagnostics;
    correctionSignals?: SkillRouteCorrectionSignal[];
    candidatesRejected?: SkillRouteRejectedCandidate[];
    searchedReplacementSkill?: string;
  },
  selectedSkillName: string,
  finalSkillUsed: string
): SelectedSkillSuggestedTarget {
  if (hasRejectedRouteSignal(input, selectedSkillName)) {
    return "negative_example_addition";
  }
  if (
    finalSkillUsed !== selectedSkillName ||
    input.searchedReplacementSkill !== undefined ||
    (input.correctionSignals?.length ?? 0) > 0
  ) {
    return "routing_metadata_update";
  }

  return "skill_patch";
}

function noSkillSuggestedTarget(
  input: {
    noSkillResult?: SkillRouteNoSkillResult;
    candidatesShown?: string[];
    candidatesRejected?: SkillRouteRejectedCandidate[];
    searchedReplacementSkill?: string;
  },
  workflow: { bounded: boolean },
  existing: SkillLearningRecord | undefined
): MissingPlaybookSuggestedTarget {
  if ((input.candidatesRejected?.length ?? 0) > 0) {
    return "routing_metadata_update";
  }
  if (!workflow.bounded) {
    return "routing_metadata_update";
  }
  if (input.noSkillResult === "correct" || input.noSkillResult === "not-applicable") {
    return "routing_eval_addition";
  }
  const repeated = (existing?.occurrences ?? 0) > 0;
  if (!repeated) {
    return "routing_eval_addition";
  }
  if ((input.candidatesShown?.length ?? 0) > 0 || input.searchedReplacementSkill !== undefined) {
    return "skill_consolidation";
  }
  return "skill_create";
}

function hasRejectedRouteSignal(
  input: {
    correctionSignals?: SkillRouteCorrectionSignal[];
    candidatesRejected?: SkillRouteRejectedCandidate[];
  },
  selectedSkillName: string
): boolean {
  return (input.correctionSignals ?? []).some((signal) =>
    signal.kind === "rejected" && (signal.skillName === undefined || signal.skillName === selectedSkillName)
  ) ||
    (input.candidatesRejected ?? []).some((candidate) => candidate.skillName === selectedSkillName);
}

function candidateImprovementForSuggestedTarget(target: LearningSuggestedTarget): string {
  switch (target) {
    case "routing_metadata_update":
      return "Review routing metadata through the governed evolution path.";
    case "routing_eval_addition":
      return "Add or update a routing eval case through the governed evolution path.";
    case "negative_example_addition":
      return "Add a negative routing example through the governed evolution path.";
    case "skill_consolidation":
      return "Review whether existing skill coverage should be consolidated before creating a new skill.";
    case "skill_create":
      return "Create a governed skill only after repeated bounded evidence is reviewed.";
    case "skill_patch":
      return "Refine the selected skill through the governed evolution path.";
  }
}

function reasonForSuggestedTarget(target: LearningSuggestedTarget): string {
  switch (target) {
    case "routing_metadata_update":
      return "Route evidence suggests routing metadata should be reviewed before changing skill behavior.";
    case "routing_eval_addition":
      return "Route evidence should first become a routing eval before metadata or skill changes.";
    case "negative_example_addition":
      return "Rejected route evidence should first become a negative routing example.";
    case "skill_consolidation":
      return "Repeated bounded workflow overlapped existing route candidates; review consolidation before creating a new skill.";
    case "skill_create":
      return "Repeated bounded no-skill workflow may need a governed skill.";
    case "skill_patch":
      return "Selected skill turn produced evidence for future governed refinement.";
  }
}

function confidenceFallbackForSuggestedTarget(target: LearningSuggestedTarget): number {
  switch (target) {
    case "skill_create":
      return 0.65;
    case "skill_consolidation":
      return 0.6;
    case "skill_patch":
    case "routing_eval_addition":
      return 0.55;
    case "routing_metadata_update":
    case "negative_example_addition":
      return 0.45;
  }
}

function promptSummaryForLearning(userText: string): string {
  return humanizePrompt(redactLearningText(stripInlineReasoning(userText)));
}

function successfulToolNames(toolExecutions: ToolExecutionRecord[]): string[] {
  return mergeOrdered([], toolExecutions
    .filter((execution) => execution.result?.ok === true)
    .map((execution) => execution.tool.name));
}

function observationTypeFromOutcome(status: SkillRouteFinalOutcomeStatus | undefined): SkillObservationRecord["type"] {
  if (status === "succeeded") return "success";
  if (status === "blocked") return "blocked";
  if (status === "partial") return "partial";
  if (status === "failed" || status === "cancelled") return "failure";
  return "note";
}

function observationOutcomeFromFinalStatus(status: SkillRouteFinalOutcomeStatus | undefined): SkillObservationRecord["outcome"] {
  if (status === "succeeded") return "succeeded";
  if (status === "blocked") return "blocked";
  if (status === "partial") return "partial";
  return "failed";
}

function confidenceFromObservation(routeConfidence: number | undefined, fallback: number): number {
  if (!Number.isFinite(routeConfidence)) {
    return fallback;
  }
  return Math.max(0, Math.min(1, routeConfidence ?? fallback));
}

class SkillLearningStore {
  readonly #path: string;
  readonly #localSkillsRoot: string;
  readonly #now: () => Date;
  readonly #records = new Map<string, SkillLearningRecord>();
  #loaded = false;
  #draftBudget: SkillLearningFile["draftBudget"];
  #deferred = new Map<string, DeferredSkillTurn>();
  #pendingReviews = new Map<string, PendingSkillReview>();

  constructor(options: { path: string; localSkillsRoot: string; now?: () => Date }) {
    this.#path = options.path;
    this.#localSkillsRoot = resolve(options.localSkillsRoot);
    this.#now = options.now ?? (() => new Date());
  }

  async #transaction<T>(work: () => Promise<T>): Promise<T> {
    return withProfileWriteLock(dirname(this.#path), async () => {
      this.#loaded = false;
      this.#records.clear();
      this.#draftBudget = undefined;
      this.#deferred.clear();
      this.#pendingReviews.clear();
      await this.#ensureLoaded();
      return work();
    });
  }

  defer(turn: DeferredSkillTurn) { return this.#transaction(async () => {
    this.#deferred.set(turn.id, turn); await this.#flush();
  }); }
  deferred() { return this.#transaction(async () => [...this.#deferred.values()]); }
  finishDeferred(id: string, job: PendingSkillReview) { return this.#transaction(async () => {
    this.#deferred.delete(id); this.#pendingReviews.set(job.sessionId, job); await this.#flush();
  }); }
  pendingReviews() { return this.#transaction(async () => [...this.#pendingReviews.values()]); }
  queueReview(job: PendingSkillReview) { return this.#transaction(async () => {
    this.#pendingReviews.set(job.sessionId, job); await this.#flush();
  }); }
  finishReview(job: PendingSkillReview) { return this.#transaction(async () => {
    if (this.#pendingReviews.get(job.sessionId)?.id !== job.id) return;
    const pending = [...this.#records.values()].some(record => record.status === "candidate" && record.sourceSessionIds.includes(job.sessionId) &&
      (!record.draftStatus || record.draftStatus === "pending" || record.draftStatus === "attempted" ||
       record.draftStatus === "failed" && ["provider-failure", "interrupted"].includes(record.draftFailure ?? "") && (record.draftAttempts ?? 0) < 2));
    if (!pending) { this.#pendingReviews.delete(job.sessionId); await this.#flush(); }
  }); }
  ownsClaim(key: string, claim: string) { return this.#transaction(async () => {
    const record = this.#records.get(key);
    return record?.draftClaim?.id === claim && record.draftClaim.expiresAt > Date.now();
  }); }
  reconcileProposal(key: string, proposalId: string, status: "proposed" | "promoted" | "rejected") { return this.#transaction(() =>
    this.#recordDraft(key, status === "rejected" ? "failed" : status, proposalId, status === "rejected" ? "proposal-rejected" : undefined)); }


  observe(input: {
    key: string;
    name: string;
    content: string;
    sessionId: string;
    tools: string[];
    requiredToolsets: ToolsetName[];
    bounded: boolean;
    boundedReason?: string;
    evidenceId?: string;
    candidateId?: string;
    candidateKind?: SkillLearningCandidate["kind"];
    promptHash?: string;
    selectedSkillName?: string;
  }) { return this.#transaction(() => this.#observe(input)); }
  markCandidate(key: string) { return this.#transaction(() => this.#markCandidate(key)); }
  recordDraft(key: string, status: NonNullable<SkillLearningRecord["draftStatus"]>, proposalId?: string, failure?: string, claim?: string) {
    return this.#transaction(async () => {
      const record = this.#records.get(key);
      if (claim && record?.draftClaim?.id !== claim) return record!;
      return this.#recordDraft(key, status, proposalId, failure);
    });
  }
  get(key: string) { return this.#transaction(() => this.#get(key)); }
  list() { return this.#transaction(() => this.#list()); }
  reconcileCreatedPaths() { return this.#transaction(() => this.#reconcileCreatedPaths()); }
  claimDraft(key: string, limit: number, candidateId: string): Promise<string | undefined> {
    return this.#transaction(async () => {
      const today = this.#now().toISOString().slice(0, 10);
      const record = this.#records.get(key);
      const attempts = this.#draftBudget?.day === today ? this.#draftBudget.attempts
        : [...this.#records.values()].filter(item => item.draftAttemptedAt?.startsWith(today)).length;
      const interrupted = record?.draftStatus === "pending" || record?.draftStatus === "failed" && record.draftFailure === "interrupted" ||
        record?.draftStatus === "attempted" && (record.draftClaim?.expiresAt ?? Date.parse(record.draftAttemptedAt ?? "") + REVIEW_LEASE_MS) <= Date.now();
      const retryable = interrupted || record?.draftStatus === "failed" && record.draftFailure === "provider-failure" &&
        Date.now() - Date.parse(record.draftAttemptedAt ?? "") >= 60_000;
      if (!record || record.candidateId !== candidateId || record.draftClaim && record.draftClaim.expiresAt > Date.now() && record.draftStatus === "attempted" ||
          record.draftCandidateId === candidateId && (!retryable || (record.draftAttempts ?? 1) >= 2) || attempts >= limit) return undefined;
      const id = randomUUID();
      this.#draftBudget = { day: today, attempts: attempts + 1 };
      this.#records.set(key, { ...record, draftCandidateId: candidateId, draftClaim: { id, expiresAt: Date.now() + REVIEW_LEASE_MS },
        draftAttempts: record.draftCandidateId === candidateId ? (record.draftAttempts ?? 1) + 1 : 1 });
      await this.#recordDraft(key, "attempted");
      return id;
    });
  }

  async #observe(input: {
    key: string;
    name: string;
    content: string;
    sessionId: string;
    tools: string[];
    requiredToolsets: ToolsetName[];
    bounded: boolean;
    boundedReason?: string;
    evidenceId?: string;
    candidateId?: string;
    candidateKind?: SkillLearningCandidate["kind"];
    promptHash?: string;
    selectedSkillName?: string;
  }): Promise<SkillLearningRecord> {
    await this.#ensureLoaded();
    await this.#reconcileCreatedPathsLoaded();
    const now = this.#now().toISOString();
    const existing = this.#records.get(input.key);
    const sourceSessionIds = existing === undefined
      ? [input.sessionId]
      : unique([...existing.sourceSessionIds, input.sessionId]);
    const record: SkillLearningRecord = {
      key: input.key,
      name: existing?.name ?? input.name,
      content: existing?.content ?? input.content,
      occurrences: sourceSessionIds.length,
      sourceSessionIds,
      tools: existing === undefined ? input.tools : mergeOrdered(existing.tools, input.tools),
      requiredToolsets: existing === undefined ? input.requiredToolsets : mergeOrdered(existing.requiredToolsets, input.requiredToolsets),
      bounded: existing?.bounded === false ? false : input.bounded,
      boundedReason: existing?.boundedReason ?? input.boundedReason,
      status: existing?.status ?? "observed",
      evidenceIds: mergeOrdered(existing?.evidenceIds ?? [], input.evidenceId === undefined ? [] : [input.evidenceId]),
      candidateId: input.candidateId ?? existing?.candidateId,
      candidateKind: input.candidateKind ?? existing?.candidateKind,
      promptHash: input.promptHash ?? existing?.promptHash,
      selectedSkillName: input.selectedSkillName ?? existing?.selectedSkillName,
      createdSkillName: existing?.createdSkillName,
      createdSkillPath: existing?.createdSkillPath,
      staleReason: existing?.staleReason,
      staleDetectedAt: existing?.staleDetectedAt,
      updatedAt: now,
      draftAttemptedAt: existing?.draftAttemptedAt,
      draftProposalId: existing?.draftProposalId,
      draftStatus: existing?.draftStatus,
      draftFailure: existing?.draftFailure,
      draftAttempts: existing?.draftAttempts,
      draftCandidateId: existing?.draftCandidateId,
      draftClaim: existing?.draftClaim
    };
    this.#records.set(input.key, record);
    await this.#flush();
    return record;
  }

  async #markCandidate(key: string): Promise<SkillLearningRecord> {
    await this.#ensureLoaded();
    await this.#reconcileCreatedPathsLoaded();
    const existing = this.#records.get(key);
    if (existing === undefined) {
      throw new Error(`Skill learning candidate not found: ${key}`);
    }
    if (existing.status === "stale") {
      return existing;
    }
    const updated: SkillLearningRecord = {
      ...existing,
      status: "candidate",
      updatedAt: this.#now().toISOString()
    };
    this.#records.set(key, updated);
    await this.#flush();
    return updated;
  }

  async #recordDraft(key: string, status: NonNullable<SkillLearningRecord["draftStatus"]>, proposalId?: string, failure?: string): Promise<SkillLearningRecord> {
    const record = this.#records.get(key);
    if (!record) throw new Error("Learning record missing.");
    const updated = { ...record, draftAttemptedAt: this.#now().toISOString(), draftStatus: status, draftProposalId: proposalId, draftFailure: failure };
    this.#records.set(key, updated);
    await this.#flush();
    return updated;
  }

  async #get(key: string): Promise<SkillLearningRecord | undefined> {
    await this.#ensureLoaded();
    await this.#reconcileCreatedPathsLoaded();
    return this.#records.get(key);
  }

  async #reconcileCreatedPaths(): Promise<{ checked: number; stale: number }> {
    await this.#ensureLoaded();
    return this.#reconcileCreatedPathsLoaded();
  }

  async #reconcileCreatedPathsLoaded(): Promise<{ checked: number; stale: number }> {
    let checked = 0;
    let stale = 0;
    for (const record of [...this.#records.values()]) {
      if (record.status !== "created") {
        continue;
      }
      checked += 1;
      const reason = await this.#staleReasonForCreatedRecord(record);
      if (reason !== undefined) {
        await this.#markStale(record.key, reason);
        stale += 1;
      }
    }
    return { checked, stale };
  }

  async #markStale(key: string, reason: NonNullable<SkillLearningRecord["staleReason"]>): Promise<SkillLearningRecord> {
    await this.#ensureLoaded();
    const existing = this.#records.get(key);
    if (existing === undefined) {
      throw new Error(`Skill learning record not found: ${key}`);
    }
    const updated: SkillLearningRecord = {
      ...existing,
      status: "stale",
      staleReason: reason,
      staleDetectedAt: this.#now().toISOString(),
      updatedAt: this.#now().toISOString()
    };
    this.#records.set(key, updated);
    await this.#flush();
    return updated;
  }

  async #list(): Promise<SkillLearningRecord[]> {
    await this.#ensureLoaded();
    await this.#reconcileCreatedPathsLoaded();
    return [...this.#records.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async #ensureLoaded(): Promise<void> {
    if (this.#loaded) {
      return;
    }
    this.#loaded = true;
    try {
      const file = await fs.open(this.#path, constants.O_RDONLY | constants.O_NOFOLLOW);
      let parsed: Partial<SkillLearningFile>;
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > 8_000_000) throw new Error("Invalid learning store.");
        parsed = JSON.parse(await file.readFile("utf8"));
      } finally { await file.close(); }
      for (const record of Array.isArray(parsed.records) ? parsed.records : []) {
        if (typeof record?.key !== "string") {
          continue;
        }
        this.#records.set(record.key, record);
      }
      for (const turn of parsed.deferredTurns ?? []) {
        if (typeof turn.id !== "string" || typeof turn.profileId !== "string" || typeof turn.sessionId !== "string" ||
            !Array.isArray(turn.taskIds) || !turn.taskIds.every(id => typeof id === "string")) throw new Error("Invalid deferred learning turn.");
        this.#deferred.set(turn.id, turn);
      }
      for (const job of parsed.pendingReviews ?? []) {
        if (typeof job.id !== "string" || typeof job.sessionId !== "string" || typeof job.profileId !== "string" ||
            job.workspaceIdentityHash !== undefined && typeof job.workspaceIdentityHash !== "string") throw new Error("Invalid pending skill review.");
        this.#pendingReviews.set(job.sessionId, job);
      }
      if (parsed.draftBudget !== undefined) {
        if (!/^\d{4}-\d{2}-\d{2}$/u.test(parsed.draftBudget.day) || !Number.isSafeInteger(parsed.draftBudget.attempts) || parsed.draftBudget.attempts < 0) throw new Error("Invalid draft budget.");
        this.#draftBudget = parsed.draftBudget;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  async #staleReasonForCreatedRecord(record: SkillLearningRecord): Promise<SkillLearningRecord["staleReason"] | undefined> {
    if (record.createdSkillPath === undefined || record.createdSkillPath.trim().length === 0) {
      return "created-path-missing";
    }
    const resolvedPath = resolve(record.createdSkillPath);
    if (!isPathInside(this.#localSkillsRoot, resolvedPath)) {
      return "created-path-outside-profile";
    }
    const skillPath = resolvedPath.endsWith(`${sep}SKILL.md`) || resolvedPath === resolve(this.#localSkillsRoot, "SKILL.md")
      ? resolvedPath
      : resolve(resolvedPath, "SKILL.md");
    try {
      const skillStat = await fs.stat(skillPath);
      return skillStat.isFile() ? undefined : "created-path-missing";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return "created-path-missing";
      }
      throw error;
    }
  }

  async #flush(): Promise<void> {
    const file: SkillLearningFile = {
      version: 1,
      draftBudget: this.#draftBudget,
      deferredTurns: [...this.#deferred.values()],
      pendingReviews: [...this.#pendingReviews.values()],
      records: [...this.#records.values()].sort((left, right) => left.key.localeCompare(right.key))
    };
    await fs.mkdir(dirname(this.#path), { recursive: true });
    const temporary = `${this.#path}.${process.pid}.tmp`;
    try {
      await fs.writeFile(temporary, `${JSON.stringify(file, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      await fs.rename(temporary, this.#path);
    } finally { await fs.rm(temporary, { force: true }); }
  }
}

function detectWorkflow(input: {
  userText: string;
  toolExecutions: ToolExecutionRecord[];
}): {
  key: string;
  name: string;
  content: string;
  tools: string[];
  requiredToolsets: ToolsetName[];
  bounded: boolean;
  boundedReason?: string;
} | undefined {
  const successful = input.toolExecutions.filter((execution) => execution.result?.ok === true);
  if (successful.length < 2) {
    return undefined;
  }

  const tools = mergeOrdered([], successful.map((execution) => execution.tool.name));
  if (tools.length < 2) {
    return undefined;
  }

  const visibleUserText = stripInlineReasoning(input.userText);
  const redactedPrompt = redactLearningText(visibleUserText);
  const normalizedPrompt = normalizePrompt(redactedPrompt);
  if (normalizedPrompt.length === 0) {
    return undefined;
  }
  if (!hasMeaningfulWorkflowIntent(visibleUserText)) {
    return undefined;
  }

  const secretReason = sensitiveWorkflowReason(visibleUserText);
  const boundedByRisk = successful.every((execution) => isBoundedRisk(execution.riskClass));
  const bounded = boundedByRisk && secretReason === undefined;
  const boundedReason = secretReason ?? (boundedByRisk ? "bounded-local-workflow" : "unbounded-tool-risk");
  const requiredToolsets = mergeOrdered(
    [],
    successful.flatMap((execution) => execution.tool.toolsets)
  );
  const label = humanizePrompt(redactedPrompt);

  return {
    key: `${normalizedPrompt}::${tools.join(">")}`,
    name: `${summarizePrompt(redactedPrompt)} workflow`,
    content: `Reusable workflow: ${label}`,
    tools,
    requiredToolsets,
    bounded,
    boundedReason
  };
}

function hasMeaningfulWorkflowIntent(prompt: string): boolean {
  const normalized = normalizePrompt(redactLearningText(prompt));
  if (normalized.length === 0) {
    return false;
  }
  if (GENERIC_WORKFLOW_PROMPTS.has(normalized)) {
    return false;
  }
  if (hasConcreteWorkflowReference(prompt)) {
    return true;
  }
  const wordCount = normalized.split(/\s+/u).filter(Boolean).length;
  return wordCount >= MIN_WORKFLOW_WORDS && normalized.length >= MIN_WORKFLOW_CHARS;
}

function hasConcreteWorkflowReference(prompt: string): boolean {
  return (
    /(?:^|[\s"'`])(?:\.{0,2}\/|~\/|\/|[A-Za-z]:[\\/])\S+/u.test(prompt) ||
    /\b[\w.-]+\.(?:ts|tsx|js|jsx|json|md|yml|yaml|toml|lock|txt|sh|sql|py|go|rs|java|css|html)\b/iu.test(prompt) ||
    /\b(?:file|directory|folder|branch|commit|test|typecheck|build|package|service|server|config|skill|tool|workflow|release|deploy|migration|script|database)\b/iu.test(prompt)
  );
}

function isPathInside(root: string, child: string): boolean {
  const rel = relative(root, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

const MIN_WORKFLOW_WORDS = 4;
const MIN_WORKFLOW_CHARS = 24;
const GENERIC_WORKFLOW_PROMPTS = new Set([
  "can you try",
  "okay",
  "ok",
  "try again",
  "yes",
  "no",
  "continue",
  "go on"
]);

function mergeOrdered<T extends string>(left: T[], right: T[]): T[] {
  return [...new Set([...left, ...right])];
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function normalizePrompt(value: string): string {
  return value
    .toLowerCase()
    .replace(/[`"'“”‘’]/gu, "")
    .replace(/[^a-z0-9\u0600-\u06ff]+/gu, " ")
    .trim();
}

function summarizePrompt(value: string): string {
  const normalized = normalizePrompt(value)
    .split(/\s+/u)
    .filter((word) => word.length > 2 && !STOP_WORDS.has(word))
    .slice(0, 5)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1));

  if (normalized.length === 0) {
    return "Generated";
  }

  return normalized.join(" ");
}

function humanizePrompt(value: string): string {
  const trimmed = value.trim().replace(/\s+/gu, " ");
  if (trimmed.length === 0) {
    return "repeated local task";
  }
  return trimmed.replace(/[.?!]+$/u, "");
}

function sensitiveWorkflowReason(value: string): string | undefined {
  if (/\b(api[_-]?key|token|secret|password|credential|bearer)\b/iu.test(value)) {
    return "prompt references secrets or credentials";
  }
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/u.test(value)) {
    return "prompt references a private key";
  }
  if (/(^|[\\/\s])\.env(?:$|[\\/\s])/u.test(value)) {
    return "prompt references an environment file";
  }
  if (/(^|\/)\.ssh\/(?:id_[a-z0-9_]+|config|known_hosts)\b/iu.test(value)) {
    return "prompt references SSH credential material";
  }
  if (/\b(cookies?|sessionid|auth[_-]?token)\b/iu.test(value)) {
    return "prompt references browser or session credentials";
  }
  return undefined;
}

function redactLearningText(value: string): string {
  return value
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu, "[redacted private key]")
    .replace(/\b(?:sk|rk|pk|xox[baprs]|gh[pousr])-[A-Za-z0-9_-]{12,}\b/gu, "[redacted secret]")
    .replace(/\b[A-Za-z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD)[A-Za-z0-9_]*\b/gu, "[redacted secret name]")
    .replace(/(?:^|\s)(?:\/Users\/[^\s]+|\/home\/[^\s]+|\/private\/[^\s]+)/gu, " [local path]");
}

function isBoundedRisk(riskClass: ToolRiskClass): boolean {
  return (
    riskClass === "read-only-local" ||
    riskClass === "workspace-write" ||
    riskClass === "read-only-network"
  );
}

const STOP_WORDS = new Set([
  "the",
  "and",
  "that",
  "this",
  "with",
  "from",
  "into",
  "please",
  "tell",
  "what",
  "about",
  "exactly",
  "there",
  "give",
  "make"
]);

/** Exclude derived session readiness fields; bind learning to the actual definition and instructions. */
function skillDefinitionRevision(skill: SkillDefinition | LoadedSkill): string {
  return skillContentHash(JSON.stringify({ ...skill, resources: undefined, contract: undefined,
    providerInstructions: undefined, pythonCapabilitySetup: undefined, loadWarnings: undefined,
    provenance: undefined, lifecycleState: undefined }));
}
