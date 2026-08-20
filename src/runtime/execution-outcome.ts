import type {
  ConfirmedActionReceipt,
  ExecutionCompletionFloor,
  ExecutionEvidenceRecord,
  ExecutionFinalOutcome,
  ExecutionFinalOutcomeStatus,
  ExecutionTerminationCause,
  UncertainActionReceipt
} from "../contracts/execution-plan.js";
import type { SkillRouteFinalOutcomeStatus } from "../contracts/skill.js";
import type { ToolRiskClass } from "../contracts/tool.js";
import type { ToolCallPlan } from "../contracts/tool-plan.js";
import type { ProviderExecutionResult } from "../providers/provider-executor.js";
import type { ToolExecutionRecord } from "../tools/tool-executor.js";
import { isolateLtr } from "../ui/bidi.js";

const RECEIPT_RISK_CLASSES = new Set<ToolRiskClass>([
  "workspace-write",
  "external-side-effect",
  "destructive-local",
  "shared-state-mutation",
  "spend-money",
  "sandbox-escape"
]);
const RECEIPT_INELIGIBLE_TOOLS = new Set(["plan", "delegate_task"]);

export type ExecutionCompletionCapability = {
  tool: string;
  kind: "read" | "mutation" | "verification";
  verifies?: readonly string[];
  connector?: { kind: "mcp"; id: string };
};

export function deriveExecutionCompletionFloor(input: {
  userText: string;
  capabilities?: readonly ExecutionCompletionCapability[];
}): ExecutionCompletionFloor {
  const text = normalizeExpectationText(input.userText);
  if (text.length === 0 || requestsInformationOnly(text)) return "none";

  const capabilities = input.capabilities ?? [];
  const namesExecutionSurface = requestNamesExecutionSurface(text, capabilities);
  const requestsRead = /\b(?:inspect|review|check|find|list|show|get|read|analy[sz]e|look\s+at|search|open)\b/iu.test(text) ||
    /(?:افحص|راجع|تحقق|ابحث|اعرض|اقرأ|حلل|انظر|افتح)/u.test(text);
  const mutationAction = /\b(?:update|set\s*up|configure|create|add|change|edit|modify|write|save|upload|send|post|delete|remove|install|connect|fill|enter|submit|provision|fix|implement|build|complete|finish|apply|deploy|publish)\b/iu;
  const arabicMutationAction = /(?:حد[ّ]?ث|حدّث|أعد|اضبط|هيئ|أنشئ|أضف|غيّر|عدّل|اكتب|احفظ|ارفع|أرسل|احذف|أزل|ثبّت|اربط|املأ|أدخل|نفّذ|ابن|أكمل|أنه|طبّق|انشر)/u;
  const readLedRequest = /^(?:(?:can|could|would)\s+you\s+|please\s+)?(?:inspect|review|check|find|list|show|get|read|analy[sz]e|look\s+at|search|open)\b/iu.test(text) ||
    /^(?:من فضلك\s+)?(?:افحص|راجع|تحقق|ابحث|اعرض|اقرأ|حلل|انظر|افتح)/u.test(text);
  const explicitMutationSequence = /\b(?:and|then)\s+(?:please\s+)?(?:update|set\s*up|configure|create|add|change|edit|modify|write|save|delete|remove|fix|complete|finish|apply|deploy|publish)\b/iu.test(text) ||
    /(?:ثم|و)\s*(?:حد[ّ]?ث|اضبط|هيئ|أنشئ|أضف|غيّر|عدّل|اكتب|احذف|أكمل|طبّق|انشر)/u.test(text);
  const requestsMutation = (mutationAction.test(text) || arabicMutationAction.test(text)) &&
    (!readLedRequest || explicitMutationSequence) &&
    namesExecutionSurface;
  if (requestsMutation) {
    const requiresExplicitVerification = /\b(?:verify|verification|confirm|read\s*back|double[- ]check|validate|ensure)\b/iu.test(text) ||
      /(?:تحقق|تأكّد|أكد|راجع بعد)/u.test(text);
    return requiresExplicitVerification || hasConfiguredVerificationRelationship(text, capabilities)
      ? "mutation_with_verification"
      : "mutation";
  }

  return requestsRead && namesExecutionSurface ? "read" : "none";
}

export function deriveExecutionFinalOutcome(input: {
  providerExecution?: ProviderExecutionResult;
  toolExecutions: readonly ToolExecutionRecord[];
  executionReceipts: readonly ExecutionEvidenceRecord[];
  toolPlans?: readonly ToolCallPlan[];
  emergencyDeadlineReached?: boolean;
  delegatedAnswerOwned?: boolean;
  cancelled?: boolean;
  terminationCause?: ExecutionTerminationCause;
  completionFloor?: ExecutionCompletionFloor;
  openContinuation?: boolean;
}): ExecutionFinalOutcome {
  const confirmedActions = confirmedActionReceipts(input.executionReceipts);
  const uncertainActions = uncertainActionReceipts(input.toolExecutions, input.toolPlans ?? []);
  const terminationCause = input.cancelled === true
    ? "cancelled"
    : input.terminationCause ?? (input.emergencyDeadlineReached === true
      ? "deadline_reached"
      : input.providerExecution?.ok === false ? "provider_failed" : "normal");
  const completionFloor = input.completionFloor ?? "none";
  const status = classifyFinalStatus({
    ...input,
    terminationCause,
    completionFloor,
    confirmedActions,
    uncertainActions
  });
  return { status, terminationCause, completionFloor, confirmedActions, uncertainActions };
}

export function learningOutcomeStatus(
  status: ExecutionFinalOutcomeStatus
): SkillRouteFinalOutcomeStatus {
  switch (status) {
    case "completed":
      return "succeeded";
    case "completed_with_recovered_errors":
    case "partially_completed":
      return "partial";
    case "blocked":
      return "blocked";
    case "cancelled":
      return "cancelled";
    case "failed":
      return "failed";
  }
}

export function appendExecutionReceipt(
  text: string,
  outcome: ExecutionFinalOutcome,
  locale: "en" | "ar"
): string {
  if (outcome.confirmedActions.length === 0 && outcome.uncertainActions.length === 0) {
    return text;
  }
  const lines = locale === "ar"
    ? renderArabicReceipt(outcome)
    : renderEnglishReceipt(outcome);
  return [text.trim(), "", ...lines].join("\n");
}

function confirmedActionReceipts(
  executionReceipts: readonly ExecutionEvidenceRecord[]
): ConfirmedActionReceipt[] {
  const verifiedCallIds = verifiedMutationCallIds(executionReceipts);
  const receipts = new Map<string, ConfirmedActionReceipt>();
  for (const execution of executionReceipts) {
    if (
      execution.status !== "success" ||
      execution.executionEffect?.kind !== "mutation" ||
      !RECEIPT_RISK_CLASSES.has(execution.riskClass) ||
      RECEIPT_INELIGIBLE_TOOLS.has(execution.tool)
    ) continue;
    const receipt = confirmedReceipt({
      toolCallId: execution.toolCallId,
      tool: execution.tool,
      riskClass: execution.riskClass,
      targetSummary: execution.targetSummary,
      verification: verifiedCallIds.has(execution.toolCallId) ? "verified" : "not_verified"
    });
    receipts.set(receiptKey(receipt, receipts.size), receipt);
  }
  return [...receipts.values()];
}

function uncertainActionReceipts(
  executions: readonly ToolExecutionRecord[],
  plans: readonly ToolCallPlan[]
): UncertainActionReceipt[] {
  const receipts = new Map<string, UncertainActionReceipt>();
  for (const execution of executions) {
    if (!isReceiptEligible(execution) || !hasNoAuthoritativeResult(execution)) continue;
    const receipt: UncertainActionReceipt = {
      ...(execution.toolCallId === undefined ? {} : { toolCallId: execution.toolCallId }),
      tool: execution.tool.name,
      riskClass: execution.riskClass,
      status: "uncertain"
    };
    receipts.set(receiptKey(receipt, receipts.size), receipt);
  }
  for (const plan of plans) {
    if (!isUnresolvedPlan(plan) || !isReceiptEligiblePlan(plan)) continue;
    const riskClass = plan.riskClass;
    if (riskClass === undefined) continue;
    const receipt: UncertainActionReceipt = {
      toolCallId: plan.id,
      tool: plan.tool,
      riskClass,
      status: "uncertain"
    };
    receipts.set(receiptKey(receipt, receipts.size), receipt);
  }
  return [...receipts.values()];
}

function isUnresolvedPlan(plan: ToolCallPlan): boolean {
  return (plan.status === "planned" || plan.status === "cancelled" || plan.status === "executed") &&
    plan.result === undefined;
}

function isReceiptEligiblePlan(plan: ToolCallPlan): boolean {
  return plan.riskClass !== undefined &&
    RECEIPT_RISK_CLASSES.has(plan.riskClass) &&
    !RECEIPT_INELIGIBLE_TOOLS.has(plan.tool);
}

function hasNoAuthoritativeResult(execution: ToolExecutionRecord): boolean {
  return execution.result === undefined || (
    execution.result.ok === false && execution.result.metadata?.reason === "cancelled"
  );
}

function confirmedReceipt(input: {
  toolCallId?: string;
  tool: string;
  riskClass: ToolRiskClass;
  targetSummary?: string;
  verification: ConfirmedActionReceipt["verification"];
}): ConfirmedActionReceipt {
  return {
    ...(input.toolCallId === undefined ? {} : { toolCallId: input.toolCallId }),
    tool: input.tool,
    riskClass: input.riskClass,
    ...(input.targetSummary === undefined ? {} : { targetSummary: input.targetSummary }),
    status: "confirmed",
    verification: input.verification
  };
}

function isReceiptEligible(execution: ToolExecutionRecord): boolean {
  return execution.decision === "allow" &&
    RECEIPT_RISK_CLASSES.has(execution.riskClass) &&
    !RECEIPT_INELIGIBLE_TOOLS.has(execution.tool.name);
}

function receiptKey(
  receipt: Pick<ConfirmedActionReceipt | UncertainActionReceipt, "toolCallId" | "tool" | "targetSummary">,
  fallbackIndex: number
): string {
  return receipt.toolCallId ?? `${receipt.tool}:${receipt.targetSummary ?? ""}:${fallbackIndex}`;
}

function verifiedMutationCallIds(receipts: readonly ExecutionEvidenceRecord[]): ReadonlySet<string> {
  const mutations = new Map<string, Extract<ExecutionEvidenceRecord, { status: "success" }>>();
  const verified = new Set<string>();
  for (const receipt of receipts) {
    if (
      receipt.status === "success" &&
      receipt.executionEffect?.kind === "mutation" &&
      RECEIPT_RISK_CLASSES.has(receipt.riskClass) &&
      !RECEIPT_INELIGIBLE_TOOLS.has(receipt.tool)
    ) {
      mutations.set(receipt.toolCallId, receipt);
      continue;
    }
    if (
      receipt.status !== "success" ||
      receipt.executionEffect?.kind !== "verification" ||
      receipt.verifiedMutation === undefined
    ) continue;
    const mutation = mutations.get(receipt.verifiedMutation.toolCallId);
    if (
      mutation === undefined ||
      mutation.tool !== receipt.verifiedMutation.tool ||
      !receipt.executionEffect.verifies.includes(mutation.tool) ||
      !sameVisibleTurn(receipt.visibleTurnId, mutation.visibleTurnId)
    ) continue;
    verified.add(mutation.toolCallId);
  }
  return verified;
}

function sameVisibleTurn(left: string | undefined, right: string | undefined): boolean {
  return left === undefined || right === undefined || left === right;
}

function classifyFinalStatus(input: {
  providerExecution?: ProviderExecutionResult;
  executionReceipts: readonly ExecutionEvidenceRecord[];
  toolPlans?: readonly ToolCallPlan[];
  emergencyDeadlineReached?: boolean;
  delegatedAnswerOwned?: boolean;
  cancelled?: boolean;
  terminationCause: ExecutionTerminationCause;
  completionFloor: ExecutionCompletionFloor;
  openContinuation?: boolean;
  confirmedActions: readonly ConfirmedActionReceipt[];
  uncertainActions: readonly UncertainActionReceipt[];
}): ExecutionFinalOutcomeStatus {
  if (input.cancelled === true || input.terminationCause === "cancelled") return "cancelled";

  const successfulIndexes: number[] = [];
  const failedIndexes: number[] = [];
  const authoritativeReceipts = input.executionReceipts.filter((receipt) => receipt.status !== "ineligible");
  for (const [index, receipt] of authoritativeReceipts.entries()) {
    if (receipt.status === "success") successfulIndexes.push(index);
    if (receipt.status === "failed") failedIndexes.push(index);
  }
  const succeeded = successfulIndexes.length;
  const failed = failedIndexes.length;
  const blocked = authoritativeReceipts.some((receipt) =>
    receipt.status === "blocked" || receipt.status === "unavailable"
  );
  const hasConfirmedWork = input.confirmedActions.length > 0 || succeeded > 0;
  const hasUsefulEvidence = hasConfirmedWork || input.uncertainActions.length > 0;
  const unresolvedToolPlans = (input.toolPlans ?? []).some(isUnresolvedPlan);
  const completionFloorSatisfied = settlesCompletionFloor(
    input.completionFloor,
    authoritativeReceipts,
    input.confirmedActions
  );

  if (
    input.delegatedAnswerOwned === true &&
    input.terminationCause === "normal" &&
    input.openContinuation !== true &&
    completionFloorSatisfied &&
    input.uncertainActions.length === 0 &&
    !unresolvedToolPlans &&
    !blocked &&
    failed === 0
  ) {
    return "completed";
  }

  if (
    input.terminationCause === "browser_no_progress" ||
    input.terminationCause === "tool_loop_no_progress" ||
    input.terminationCause === "user_input_required"
  ) {
    return hasUsefulEvidence ? "partially_completed" : "blocked";
  }
  if (
    input.terminationCause === "budget_exhausted" ||
    input.terminationCause === "deadline_reached"
  ) return "partially_completed";
  if (
    input.uncertainActions.length > 0 ||
    unresolvedToolPlans
  ) {
    return "partially_completed";
  }
  if (blocked) {
    return hasConfirmedWork ? "partially_completed" : "blocked";
  }
  if (input.terminationCause === "provider_failed" || input.providerExecution?.ok === false) {
    return hasConfirmedWork ? "partially_completed" : "failed";
  }
  if (failed > 0) {
    if (succeeded === 0) return "failed";
    const lastSuccessIndex = successfulIndexes.at(-1) ?? -1;
    const lastFailureIndex = failedIndexes.at(-1) ?? -1;
    return lastSuccessIndex > lastFailureIndex
      ? "completed_with_recovered_errors"
      : "partially_completed";
  }
  if (input.openContinuation === true || !completionFloorSatisfied) {
    return hasUsefulEvidence ? "partially_completed" : "blocked";
  }
  if (
    input.providerExecution?.ok === true &&
    (input.providerExecution.response?.content ?? "").trim().length === 0
  ) {
    return hasConfirmedWork ? "partially_completed" : "failed";
  }
  return "completed";
}

function settlesCompletionFloor(
  floor: ExecutionCompletionFloor,
  receipts: readonly ExecutionEvidenceRecord[],
  confirmedActions: readonly ConfirmedActionReceipt[]
): boolean {
  if (floor === "none") return true;
  if (floor === "read") {
    return receipts.some((receipt) => receipt.status === "success" && (
      receipt.executionEffect?.kind === "read" || receipt.executionEffect?.kind === "verification"
    ));
  }
  if (floor === "mutation") return confirmedActions.length > 0;
  return confirmedActions.some((receipt) => receipt.verification === "verified");
}

function hasConfiguredVerificationRelationship(
  normalizedUserText: string,
  capabilities: readonly ExecutionCompletionCapability[]
): boolean {
  const matchingMutations = capabilities.filter((capability) =>
    capability.kind === "mutation" && capabilityMatchesRequest(capability, normalizedUserText)
  );
  if (matchingMutations.length === 0) return false;
  return matchingMutations.some((mutation) => capabilities.some((candidate) =>
    candidate.kind === "verification" &&
    candidate.verifies?.includes(mutation.tool) === true &&
    connectorsCompatible(candidate.connector, mutation.connector)
  ));
}

function capabilityMatchesRequest(
  capability: ExecutionCompletionCapability,
  normalizedUserText: string
): boolean {
  const connectorId = normalizeExpectationText(capability.connector?.id ?? "");
  if (connectorId.length > 0 && containsExpectationPhrase(normalizedUserText, connectorId)) return true;
  return capability.tool
    .replace(/([\p{Ll}\d])([\p{Lu}])/gu, "$1 $2")
    .split(/[^\p{L}\p{N}]+/u)
    .map(normalizeExpectationText)
    .flatMap((token) => token.endsWith("s") ? [token, token.slice(0, -1)] : [token])
    .some((token) =>
      token.length >= 3 &&
      !CAPABILITY_MATCH_STOP_WORDS.has(token) &&
      containsExpectationPhrase(normalizedUserText, token)
    );
}

function connectorsCompatible(
  left: ExecutionCompletionCapability["connector"],
  right: ExecutionCompletionCapability["connector"]
): boolean {
  return left === undefined || right === undefined || (
    left.kind === right.kind && normalizeExpectationText(left.id) === normalizeExpectationText(right.id)
  );
}

function containsExpectationPhrase(text: string, phrase: string): boolean {
  return (` ${text} `).includes(` ${phrase} `);
}

function requestsInformationOnly(text: string): boolean {
  return /\b(?:how\s+(?:do|can|would|should)|explain|describe|what\s+(?:is|are)|tell\s+me\s+how|should\s+i)\b/iu.test(text) &&
    !/\b(?:please|now|go ahead|do it|make the change)\b/iu.test(text);
}

const CAPABILITY_MATCH_STOP_WORDS = new Set([
  "add", "apply", "build", "change", "check", "complete", "configure", "connect", "create",
  "delete", "deploy", "edit", "enter", "fill", "find", "finish", "get", "implement", "install",
  "list", "mcp", "modify", "open", "post", "publish", "read", "remove", "review", "save", "search",
  "send", "set", "setup", "show", "submit", "update", "upload", "verify", "write"
]);

function requestNamesExecutionSurface(
  text: string,
  capabilities: readonly ExecutionCompletionCapability[]
): boolean {
  if (capabilities.some((capability) => capabilityMatchesRequest(capability, text))) return true;
  if (/\b(?:draft|poem|story|summary|explanation|description|copy|prose|outline|response|answer)\b/iu.test(text)) {
    return false;
  }
  return /\b(?:postman|browser|tabs?|pages?|websites?|urls?|collections?|variables?|environments?|settings?|configurations?|accounts?|workspaces?|repositories|repos?|files?|directories|folders?|databases?|records?|apis?|servers?|deployments?|messages?|emails?|forms?|fields?|apps?|applications?|projects?|codebases?)\b/iu.test(text) ||
    /(?:بوستمان|المتصفح|علامة تبويب|صفحة|موقع|رابط|مجموعة|متغير|بيئة|إعداد|حساب|مساحة عمل|مستودع|ملف|مجلد|قاعدة بيانات|سجل|خادم|رسالة|بريد|نموذج|حقل|تطبيق|مشروع|قاعدة الشفرة)/u.test(text);
}

function normalizeExpectationText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function renderEnglishReceipt(outcome: ExecutionFinalOutcome): string[] {
  const lines: string[] = [];
  if (outcome.confirmedActions.length > 0) {
    lines.push("Confirmed actions:");
    lines.push(...outcome.confirmedActions.map((receipt) =>
      `- ${renderAction(receipt.tool, receipt.targetSummary)} (${receipt.verification === "verified" ? "verified" : "not independently verified"})`
    ));
  }
  if (outcome.uncertainActions.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push("Uncertain actions:");
    lines.push(...outcome.uncertainActions.map((receipt) =>
      `- ${renderAction(receipt.tool, receipt.targetSummary)} (execution started, but no authoritative completion result was recorded)`
    ));
  }
  if (outcome.confirmedActions.some((receipt) => receipt.verification === "not_verified")) {
    lines.push("", "The confirmed actions remain confirmed; independent verification was not completed.");
  }
  return lines;
}

function renderArabicReceipt(outcome: ExecutionFinalOutcome): string[] {
  const lines: string[] = [];
  if (outcome.confirmedActions.length > 0) {
    lines.push("الإجراءات المؤكدة:");
    lines.push(...outcome.confirmedActions.map((receipt) =>
      `- ${renderArabicAction(receipt.tool, receipt.targetSummary)} (${receipt.verification === "verified" ? "تم التحقق" : "لم يتم التحقق بشكل مستقل"})`
    ));
  }
  if (outcome.uncertainActions.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push("إجراءات ذات نتيجة غير مؤكدة:");
    lines.push(...outcome.uncertainActions.map((receipt) =>
      `- ${renderArabicAction(receipt.tool, receipt.targetSummary)} (بدأ التنفيذ، لكن لم تُسجل نتيجة إكمال موثوقة)`
    ));
  }
  if (outcome.confirmedActions.some((receipt) => receipt.verification === "not_verified")) {
    lines.push("", "تبقى الإجراءات أعلاه مؤكدة، لكن التحقق المستقل لم يكتمل.");
  }
  return lines;
}

function renderAction(tool: string, targetSummary: string | undefined): string {
  return targetSummary === undefined ? tool : `${tool} — ${targetSummary}`;
}

function renderArabicAction(tool: string, targetSummary: string | undefined): string {
  return targetSummary === undefined
    ? isolateLtr(tool)
    : `${isolateLtr(tool)} — ${isolateLtr(targetSummary)}`;
}
