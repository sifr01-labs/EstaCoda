import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
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
  status: "observed" | "candidate" | "created";
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
      path: options.storePath
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

    const evidence = await this.#skillEvolutionStore.appendObservation({
      skillName: workflow.name,
      sessionId: input.sessionId,
      type: observationTypeFromOutcome(input.outcomeStatus),
      promptSummary: workflow.content,
      toolsAttempted: workflow.tools,
      outcome: observationOutcomeFromFinalStatus(input.outcomeStatus),
      lesson: `No skill was selected for a repeated local workflow using ${workflow.tools.join(", ")}.`,
      candidateImprovement: "Create a governed skill or update routing metadata for this missing workflow.",
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
      suggestedTarget: workflow.bounded ? "skill_create" : "routing_metadata_update",
      reason: workflow.bounded
        ? "Repeated no-skill workflow may need a governed skill."
        : "No-skill workflow is not bounded enough for skill creation; consider routing metadata instead.",
      confidence: confidenceFromObservation(input.routeConfidence, workflow.bounded ? 0.65 : 0.45),
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
      candidateImprovement: "Refine the selected skill or its routing metadata through the governed evolution path.",
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
      suggestedTarget: finalSkillUsed === selectedSkillName ? "skill_patch" : "routing_metadata_update",
      reason: finalSkillUsed === selectedSkillName
        ? "Selected skill turn produced evidence for future governed refinement."
        : "Route or model correction suggests routing metadata should be reviewed.",
      confidence: confidenceFromObservation(input.routeConfidence, 0.6),
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
    const candidateRecord = record.status === "candidate"
      ? record
      : await this.#store.markCandidate(record.key);

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
  readonly #now: () => Date;
  readonly #records = new Map<string, SkillLearningRecord>();
  #loaded = false;

  constructor(options: { path: string; now?: () => Date }) {
    this.#path = options.path;
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
      updatedAt: now
    };
    this.#records.set(input.key, record);
    await this.#flush();
    return record;
  }

  async markCandidate(key: string): Promise<SkillLearningRecord> {
    await this.#ensureLoaded();
    const existing = this.#records.get(key);
    if (existing === undefined) {
      throw new Error(`Workflow candidate not found: ${key}`);
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

  async list(): Promise<SkillLearningRecord[]> {
    await this.#ensureLoaded();
    return [...this.#records.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async #ensureLoaded(): Promise<void> {
    if (this.#loaded) {
      return;
    }
    this.#loaded = true;
    try {
      const parsed = JSON.parse(await readFile(this.#path, "utf8")) as Partial<SkillLearningFile>;
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

  async #flush(): Promise<void> {
    const file: SkillLearningFile = {
      version: 1,
      records: [...this.#records.values()].sort((left, right) => left.key.localeCompare(right.key))
    };
    await mkdir(dirname(this.#path), { recursive: true });
    await writeFile(this.#path, `${JSON.stringify(file, null, 2)}\n`, "utf8");
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
