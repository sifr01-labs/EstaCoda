import type {
  ExecutionEvidenceRecord,
  ExecutionPlan,
  ExecutionPlanEvidence,
  ExecutionPlanItem,
} from "../contracts/execution-plan.js";

const MAX_ITEM_EVIDENCE = 4;
const MAX_STALE_EVIDENCE_CALL_IDS = 4;

type EvidenceRole = "artifact-import" | "credential-configuration" | "browser-navigation";

export type ExecutionPlanEvidenceSynchronization = {
  plan: ExecutionPlan;
  changed: boolean;
  reconciliationRequired: boolean;
};

/**
 * Projects trusted execution receipts into optional Plan coordination state.
 * The matcher is intentionally narrow: unknown tools and browser clicks cannot
 * complete a semantic step, and mutations require an independent verifier.
 */
export function synchronizeExecutionPlanEvidence(input: {
  plan: ExecutionPlan;
  records: readonly ExecutionEvidenceRecord[];
  resolveEvidence: (toolCallIds: readonly string[]) => ExecutionPlanEvidence[];
}): ExecutionPlanEvidenceSynchronization {
  if (input.plan.status !== "active" || input.records.length === 0) {
    return { plan: input.plan, changed: false, reconciliationRequired: false };
  }

  let items = input.plan.items.map(cloneItem);
  let changed = false;
  let reconciliationRequired = input.plan.runtimeSynchronization?.status === "stale";
  const ambiguousCallIds = new Set(input.plan.runtimeSynchronization?.evidenceCallIds ?? []);

  for (const record of input.records) {
    if (record.status !== "success") continue;
    const mutationTool = record.verifiedMutation?.tool ?? record.tool;
    const role = evidenceRoleForTool(mutationTool);
    if (role === undefined) continue;

    const unfinishedMatches = items.filter((item) =>
      item.status !== "completed" && item.status !== "cancelled" && evidenceRoleForItem(item) === role
    );
    if (unfinishedMatches.length === 0) {
      if (items.some((item) =>
        item.runtimeProgress?.status === "verified" && evidenceRoleForItem(item) === role
      )) continue;
      if (record.verifiedMutation !== undefined) {
        ambiguousCallIds.add(record.toolCallId);
        reconciliationRequired = true;
      }
      continue;
    }
    if (unfinishedMatches.length !== 1) {
      ambiguousCallIds.add(record.toolCallId);
      reconciliationRequired = true;
      continue;
    }

    const item = unfinishedMatches[0]!;
    const evidenceCallIds = record.verifiedMutation === undefined
      ? [record.toolCallId]
      : [record.verifiedMutation.toolCallId, record.toolCallId];
    let evidence: ExecutionPlanEvidence[];
    try {
      evidence = input.resolveEvidence(evidenceCallIds);
    } catch {
      continue;
    }
    const verified = record.verifiedMutation !== undefined;
    const semanticCompletionIsBounded = !(role === "artifact-import" && describesAggregateArtifactWork(item.content));
    const updated = applyRuntimeProgress(item, evidence, verified);
    const boundedUpdate = verified && !semanticCompletionIsBounded
      ? applyRuntimeProgress(item, evidence, false)
      : updated;
    if (verified && !semanticCompletionIsBounded) {
      ambiguousCallIds.add(record.toolCallId);
      reconciliationRequired = true;
    }
    if (!sameRuntimeProgress(item, boundedUpdate) || item.status !== boundedUpdate.status) {
      items = items.map((candidate) => candidate.id === item.id ? boundedUpdate : candidate);
      changed = true;
    }
  }

  if (!changed && !reconciliationRequired && input.plan.runtimeSynchronization === undefined) {
    return { plan: input.plan, changed: false, reconciliationRequired: false };
  }
  if (changed) items = promoteNextPendingItem(items);
  const runtimeSynchronization = reconciliationRequired
    ? {
        status: "stale" as const,
        reason: "ambiguous_execution_evidence" as const,
        evidenceCallIds: [...ambiguousCallIds].slice(-MAX_STALE_EVIDENCE_CALL_IDS),
      }
    : { status: "current" as const };
  if (!sameSynchronization(input.plan.runtimeSynchronization, runtimeSynchronization)) changed = true;
  if (!changed) return { plan: input.plan, changed: false, reconciliationRequired };

  return {
    plan: {
      ...input.plan,
      revision: input.plan.revision + 1,
      status: derivePlanStatus(items),
      items,
      runtimeSynchronization,
    },
    changed: true,
    reconciliationRequired,
  };
}

function applyRuntimeProgress(
  item: ExecutionPlanItem,
  evidence: readonly ExecutionPlanEvidence[],
  verified: boolean,
): ExecutionPlanItem {
  const merged = new Map<string, ExecutionPlanEvidence>();
  for (const entry of [...(item.runtimeProgress?.evidence ?? []), ...evidence]) {
    merged.set(entry.toolCallId, { ...entry });
  }
  const runtimeProgress = {
    status: verified || item.runtimeProgress?.status === "verified" ? "verified" as const : "observed" as const,
    evidence: [...merged.values()].slice(-MAX_ITEM_EVIDENCE),
  };
  return {
    ...item,
    status: runtimeProgress.status === "verified" ? "completed" : item.status,
    runtimeProgress,
  };
}

function promoteNextPendingItem(items: ExecutionPlanItem[]): ExecutionPlanItem[] {
  if (items.some((item) => item.status === "in_progress")) return items;
  const next = items.find((item) => item.status === "pending");
  return next === undefined
    ? items
    : items.map((item) => item.id === next.id ? { ...item, status: "in_progress" } : item);
}

function evidenceRoleForItem(item: ExecutionPlanItem): EvidenceRole | undefined {
  const text = normalizeSemanticText(`${item.id} ${item.content}`);
  if (isArtifactImport(text)) return "artifact-import";
  if (isCredentialConfiguration(text)) return "credential-configuration";
  if (isBrowserNavigation(text)) return "browser-navigation";
  return undefined;
}

function evidenceRoleForTool(tool: string): EvidenceRole | undefined {
  if (tool === "browser.navigate" || tool === "browser.switch_tab") return "browser-navigation";
  // Low-level gestures never prove the surrounding business operation.
  if (/^browser\.(?:click|type|press|select|scroll|dialog)$/u.test(tool)) return undefined;
  const text = normalizeSemanticText(tool);
  if (isArtifactImport(text)) return "artifact-import";
  if (isCredentialConfiguration(text)) return "credential-configuration";
  return undefined;
}

function isArtifactImport(text: string): boolean {
  const action = /\b(?:import|upload|transfer|add|create|generate|update|put|setup|configure)\b/u.test(text) ||
    /(?:استورد|استيراد|ارفع|رفع|انقل|نقل|أنشئ|انشئ|إنشاء|اضف|أضف|حدّث|حدث|هيئ|تهيئة)/u.test(text);
  const object = /\b(?:api|apis|spec|specification|swagger|openapi|collection|collections)\b/u.test(text) ||
    /(?:واجهة|واجهات|مواصفة|مواصفات|سواجر|مجموعة|مجموعات)/u.test(text);
  return action && object;
}

function isCredentialConfiguration(text: string): boolean {
  const action = /\b(?:configure|set|setup|create|update|put|transfer|add|write)\b/u.test(text) ||
    /(?:هيئ|تهيئة|اضبط|إعداد|انشئ|أنشئ|إنشاء|حدّث|حدث|انقل|نقل|اضف|أضف)/u.test(text);
  const object = /\b(?:credential|credentials|environment|environments|secret|secrets|key|keys|auth|authorization|variable|variables)\b/u.test(text) ||
    /(?:اعتماد|بيانات الاعتماد|بيئة|بيئات|سر|أسرار|مفتاح|مفاتيح|مصادقة|متغير|متغيرات)/u.test(text);
  return action && object;
}

function isBrowserNavigation(text: string): boolean {
  return /\b(?:open|navigate|visit|launch|switch)\b/u.test(text) ||
    /(?:افتح|انتقل|زر|شغّل|شغل)/u.test(text);
}

function describesAggregateArtifactWork(content: string): boolean {
  const text = normalizeSemanticText(content);
  return /\b(?:all|every|each|multiple|several|two|three|four|five|six|seven|eight|nine|ten)\b/u.test(text) ||
    /\b(?:apis|products|specifications|specs|collections)\b/u.test(text) ||
    /(?:كل|جميع|متعدد|عدة|اثنين|ثلاثة|أربعة|اربعة|خمسة|ستة|سبعة|ثمانية|تسعة|عشرة|واجهات|منتجات|مواصفات|مجموعات)/u.test(text) ||
    /\b[2-9]\d*\b/u.test(text);
}

function normalizeSemanticText(value: string): string {
  return value.normalize("NFKC")
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .toLowerCase()
    .trim();
}

function cloneItem(item: ExecutionPlanItem): ExecutionPlanItem {
  return {
    ...item,
    ...(item.runtimeProgress === undefined ? {} : {
      runtimeProgress: {
        status: item.runtimeProgress.status,
        evidence: item.runtimeProgress.evidence.map((entry) => ({ ...entry })),
      },
    }),
  };
}

function derivePlanStatus(items: readonly ExecutionPlanItem[]): ExecutionPlan["status"] {
  if (items.every((item) => item.status === "cancelled")) return "abandoned";
  if (items.every((item) => item.status === "completed" || item.status === "cancelled")) return "completed";
  return "active";
}

function sameRuntimeProgress(left: ExecutionPlanItem, right: ExecutionPlanItem): boolean {
  return left.runtimeProgress?.status === right.runtimeProgress?.status &&
    JSON.stringify(left.runtimeProgress?.evidence ?? []) === JSON.stringify(right.runtimeProgress?.evidence ?? []);
}

function sameSynchronization(
  left: ExecutionPlan["runtimeSynchronization"],
  right: NonNullable<ExecutionPlan["runtimeSynchronization"]>,
): boolean {
  return left?.status === right.status &&
    left.reason === right.reason &&
    JSON.stringify(left.evidenceCallIds ?? []) === JSON.stringify(right.evidenceCallIds ?? []);
}
