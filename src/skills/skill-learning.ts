import * as fs from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { AgentEvolutionPolicy } from "../contracts/agent-evolution.js";
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
};

type SkillLearningFile = {
  version: 1;
  records: SkillLearningRecord[];
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

  constructor(options: {
    autonomy: SkillAutonomy;
    registry: SkillRegistry;
    localSkillsRoot: string;
    storePath: string;
    sessionDb: SessionDB;
    skillEvolutionStore?: SkillEvolutionStore;
  }) {
    this.#autonomy = options.autonomy;
    this.#store = new SkillLearningStore({
      path: options.storePath,
      localSkillsRoot: options.localSkillsRoot
    });
    this.#sessionDb = options.sessionDb;
    this.#skillEvolutionStore = options.skillEvolutionStore;
  }

  async observeTurn(input: {
    profileId: string;
    sessionId: string;
    userText: string;
    selectedSkill: LoadedSkill | SkillDefinition | undefined;
    finalSkillUsed?: string;
    noSkillResult?: SkillRouteNoSkillResult;
    routeConfidence?: number;
    promptHash?: string;
    outcomeStatus?: SkillRouteFinalOutcomeStatus;
    correctionSignals?: SkillRouteCorrectionSignal[];
    modelSelfCorrectionSignal?: string;
    candidatesShown?: string[];
    candidatesRejected?: SkillRouteRejectedCandidate[];
    searchedReplacementSkill?: string;
    agentEvolutionPolicy: AgentEvolutionPolicy;
    toolExecutions: ToolExecutionRecord[];
  }): Promise<SkillLearningObservation | undefined> {
    if (
      this.#autonomy === "none" ||
      !input.agentEvolutionPolicy.observeTurns ||
      !input.agentEvolutionPolicy.createEvidence ||
      this.#skillEvolutionStore === undefined
    ) {
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
      lesson: `No skill was selected for a repeated local workflow using ${workflow.tools.join(", ")}.`,
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

  async inspect(): Promise<SkillLearningRecord[]> {
    return this.#store.list();
  }

  async reconcileCreatedPaths(): Promise<{ checked: number; stale: number }> {
    return this.#store.reconcileCreatedPaths();
  }

  async #observeSelectedSkillTurn(input: {
    profileId: string;
    sessionId: string;
    userText: string;
    selectedSkill: LoadedSkill | SkillDefinition;
    finalSkillUsed?: string;
    noSkillResult?: SkillRouteNoSkillResult;
    routeConfidence?: number;
    promptHash?: string;
    outcomeStatus?: SkillRouteFinalOutcomeStatus;
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
      skillName: selectedSkillName,
      source: "sourceKind" in input.selectedSkill ? input.selectedSkill.sourceKind : undefined,
      sessionId: input.sessionId,
      type: observationTypeFromOutcome(input.outcomeStatus),
      promptSummary: promptSummaryForLearning(input.userText),
      toolsAttempted: tools,
      outcome: observationOutcomeFromFinalStatus(input.outcomeStatus),
      lesson: finalSkillUsed === selectedSkillName
        ? `Selected skill ${selectedSkillName} completed with outcome ${input.outcomeStatus ?? "unknown"}.`
        : `Selected skill ${selectedSkillName} was corrected to final skill ${finalSkillUsed}.`,
      candidateImprovement: candidateImprovementForSuggestedTarget(suggestedTarget),
      sourceTrust: "runtime_internal",
      mayPromoteAutomatically: false,
      requiresHumanApproval: true,
      evidence: buildLearningEvidence(input, {
        selectedSkill: selectedSkillName,
        finalSkillUsed
      })
    });
    const candidate = await this.#skillEvolutionStore!.appendLearningCandidate({
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
      key: `selected:${selectedSkillName}:${input.promptHash ?? normalizePrompt(promptSummaryForLearning(input.userText))}`,
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
    const candidateRecord = record.status === "candidate"
      ? record
      : await this.#store.markCandidate(record.key);
    if (candidateRecord.status === "stale") {
      return undefined;
    }

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
}

function buildLearningEvidence(
  input: {
    profileId: string;
    promptHash?: string;
    finalSkillUsed?: string;
    noSkillResult?: SkillRouteNoSkillResult;
    routeConfidence?: number;
    outcomeStatus?: SkillRouteFinalOutcomeStatus;
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
  if (input.outcomeStatus === "succeeded") {
    return "routing_eval_addition";
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

  constructor(options: { path: string; localSkillsRoot: string; now?: () => Date }) {
    this.#path = options.path;
    this.#localSkillsRoot = resolve(options.localSkillsRoot);
    this.#now = options.now ?? (() => new Date());
  }

  async observe(input: {
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
      updatedAt: now
    };
    this.#records.set(input.key, record);
    await this.#flush();
    return record;
  }

  async markCandidate(key: string): Promise<SkillLearningRecord> {
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

  async get(key: string): Promise<SkillLearningRecord | undefined> {
    await this.#ensureLoaded();
    await this.#reconcileCreatedPathsLoaded();
    return this.#records.get(key);
  }

  async reconcileCreatedPaths(): Promise<{ checked: number; stale: number }> {
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
        await this.markStale(record.key, reason);
        stale += 1;
      }
    }
    return { checked, stale };
  }

  async markStale(key: string, reason: NonNullable<SkillLearningRecord["staleReason"]>): Promise<SkillLearningRecord> {
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

  async list(): Promise<SkillLearningRecord[]> {
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
      const parsed = JSON.parse(await fs.readFile(this.#path, "utf8")) as Partial<SkillLearningFile>;
      for (const record of Array.isArray(parsed.records) ? parsed.records : []) {
        if (typeof record?.key !== "string") {
          continue;
        }
        this.#records.set(record.key, record);
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
      records: [...this.#records.values()].sort((left, right) => left.key.localeCompare(right.key))
    };
    await fs.mkdir(dirname(this.#path), { recursive: true });
    await fs.writeFile(this.#path, `${JSON.stringify(file, null, 2)}\n`, "utf8");
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
