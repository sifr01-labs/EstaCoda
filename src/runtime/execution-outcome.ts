import type {
  ConfirmedActionReceipt,
  ExecutionFinalOutcome,
  ExecutionFinalOutcomeStatus,
  ExecutionPlan,
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
const VERIFICATION_ITEM_PATTERN = /\b(?:verify|verification|validate|validation|check|read[ -]?back|confirm)\b|(?:تحقق|التحقق|تأكيد|راجع|مراجعة)/iu;

export function deriveExecutionFinalOutcome(input: {
  providerExecution?: ProviderExecutionResult;
  toolExecutions: readonly ToolExecutionRecord[];
  toolPlans?: readonly ToolCallPlan[];
  executionPlan?: ExecutionPlan;
  executionPlanIncomplete?: boolean;
  emergencyDeadlineReached?: boolean;
  delegatedAnswerOwned?: boolean;
  cancelled?: boolean;
}): ExecutionFinalOutcome {
  const verification = planVerificationStatus(input.executionPlan);
  const verifiedCallIds = verifiedActionCallIds(input.executionPlan);
  const confirmedActions = confirmedActionReceipts(input.toolExecutions, verifiedCallIds);
  const uncertainActions = uncertainActionReceipts(input.toolExecutions, input.toolPlans ?? []);
  const status = classifyFinalStatus({
    ...input,
    confirmedActions,
    uncertainActions,
    verificationMissing: verification === "required_but_incomplete"
  });
  return { status, confirmedActions, uncertainActions };
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
  executions: readonly ToolExecutionRecord[],
  verifiedCallIds: ReadonlySet<string>
): ConfirmedActionReceipt[] {
  const receipts = new Map<string, ConfirmedActionReceipt>();
  for (const execution of executions) {
    if (!isReceiptEligible(execution) || execution.result?.ok !== true) continue;
    const receipt = confirmedReceipt({
      toolCallId: execution.toolCallId,
      tool: execution.tool.name,
      riskClass: execution.riskClass,
      verification: execution.toolCallId !== undefined && verifiedCallIds.has(execution.toolCallId)
        ? "verified"
        : "not_verified"
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
  verification: ConfirmedActionReceipt["verification"];
}): ConfirmedActionReceipt {
  return {
    ...(input.toolCallId === undefined ? {} : { toolCallId: input.toolCallId }),
    tool: input.tool,
    riskClass: input.riskClass,
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

type PlanVerificationStatus = "not_requested" | "required_but_incomplete" | "verified";

function planVerificationStatus(plan: ExecutionPlan | undefined): PlanVerificationStatus {
  const verificationItems = plan?.items.filter((item) => VERIFICATION_ITEM_PATTERN.test(item.content)) ?? [];
  if (verificationItems.length === 0) return "not_requested";
  return verificationItems.every((item) =>
    item.status === "completed" &&
    item.completionKind !== "reasoning" &&
    (item.evidence?.length ?? 0) > 0
  ) ? "verified" : "required_but_incomplete";
}

function verifiedActionCallIds(plan: ExecutionPlan | undefined): ReadonlySet<string> {
  const verified = new Set<string>();
  const planItems = plan?.items ?? [];
  for (const [verificationIndex, item] of planItems.entries()) {
    if (!isCompletedVerificationItem(item)) continue;
    for (const prior of planItems.slice(0, verificationIndex)) {
      for (const evidence of prior.evidence ?? []) verified.add(evidence.toolCallId);
    }
  }
  return verified;
}

function isCompletedVerificationItem(item: ExecutionPlan["items"][number]): boolean {
  return VERIFICATION_ITEM_PATTERN.test(item.content) &&
    item.status === "completed" &&
    item.completionKind !== "reasoning" &&
    (item.evidence?.length ?? 0) > 0;
}

function classifyFinalStatus(input: {
  providerExecution?: ProviderExecutionResult;
  toolExecutions: readonly ToolExecutionRecord[];
  toolPlans?: readonly ToolCallPlan[];
  executionPlan?: ExecutionPlan;
  executionPlanIncomplete?: boolean;
  emergencyDeadlineReached?: boolean;
  delegatedAnswerOwned?: boolean;
  cancelled?: boolean;
  confirmedActions: readonly ConfirmedActionReceipt[];
  uncertainActions: readonly UncertainActionReceipt[];
  verificationMissing: boolean;
}): ExecutionFinalOutcomeStatus {
  if (input.cancelled === true) return "cancelled";

  const successfulIndexes: number[] = [];
  const failedIndexes: number[] = [];
  for (const [index, execution] of input.toolExecutions.entries()) {
    if (execution.result?.ok === true) successfulIndexes.push(index);
    if (execution.decision === "allow" && execution.result?.ok === false) failedIndexes.push(index);
  }
  const succeeded = successfulIndexes.length;
  const failed = failedIndexes.length;
  const blocked = input.toolExecutions.some((execution) => execution.decision !== "allow");
  const hasCompletedPlanWork = input.executionPlan?.items.some((item) => item.status === "completed") === true;
  const hasConfirmedWork = input.confirmedActions.length > 0 || hasCompletedPlanWork || (
    input.executionPlan === undefined && succeeded > 0
  );
  const planIncomplete = input.executionPlanIncomplete === true || input.executionPlan?.status === "active";
  const unresolvedToolPlans = (input.toolPlans ?? []).some(isUnresolvedPlan);

  if (
    input.delegatedAnswerOwned === true &&
    input.executionPlanIncomplete !== true &&
    input.emergencyDeadlineReached !== true &&
    input.uncertainActions.length === 0 &&
    !unresolvedToolPlans &&
    (
      input.executionPlan === undefined ||
      input.executionPlan.status === "completed" ||
      input.executionPlan.status === "transferred" ||
      input.executionPlan.status === "abandoned"
    )
  ) {
    return "completed";
  }

  if (input.executionPlan?.status === "blocked") {
    return hasConfirmedWork ? "partially_completed" : "blocked";
  }
  if (
    input.emergencyDeadlineReached === true ||
    input.uncertainActions.length > 0 ||
    unresolvedToolPlans ||
    input.verificationMissing ||
    planIncomplete
  ) {
    return "partially_completed";
  }
  if (blocked) {
    return hasConfirmedWork ? "partially_completed" : "blocked";
  }
  if (input.providerExecution?.ok === false) {
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
  if (
    input.providerExecution?.ok === true &&
    (input.providerExecution.response?.content ?? "").trim().length === 0
  ) {
    return hasConfirmedWork ? "partially_completed" : "failed";
  }
  return "completed";
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
