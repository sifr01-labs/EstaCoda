import type { TaskStatus } from "../contracts/task.js";
import type { ToolExecutionRecord } from "../tools/tool-executor.js";

const PENDING_TASK_STATUSES = new Set<TaskStatus>([
  "planning",
  "queued",
  "running",
  "waiting_for_host",
  "waiting_for_input",
  "waiting_for_approval",
  "paused"
]);

export type PendingDelegatedAnswerTask = {
  readonly taskId: string;
  readonly status: TaskStatus;
  readonly execution: "foreground" | "background" | "waiting";
};

export type PendingDelegatedAnswerOwnership = {
  readonly tasks: readonly PendingDelegatedAnswerTask[];
};

/** Detects successful durable delegations that own the requested answer. */
export function pendingDelegatedAnswerOwnership(
  executions: readonly ToolExecutionRecord[]
): PendingDelegatedAnswerOwnership | undefined {
  const tasks = new Map<string, PendingDelegatedAnswerTask>();
  for (const execution of executions) {
    if (execution.tool.name !== "delegate_task" || execution.decision !== "allow" || execution.result?.ok !== true) {
      continue;
    }
    const metadata = execution.result.metadata;
    if (
      !isRecord(metadata) ||
      metadata.childTask !== false ||
      safeToken(metadata.primaryResultStepId) === undefined
    ) continue;
    const taskId = safeToken(metadata.taskId);
    const status = taskStatus(metadata.status);
    const executionState = executionStateValue(metadata.execution);
    if (taskId === undefined || status === undefined || executionState === undefined) {
      continue;
    }
    tasks.set(taskId, { taskId, status, execution: executionState });
  }
  return tasks.size === 0 ? undefined : { tasks: [...tasks.values()] };
}

export function renderDelegatedAnswerAcknowledgement(
  ownership: PendingDelegatedAnswerOwnership,
  locale: "en" | "ar" = "en"
): string {
  const messages: Record<string, [string, string]> = {
    planning: ["Your request is being prepared. The result will appear here.", "أُجهّز العمل وسأنشر النتيجة هنا."],
    queued: ["Your request is queued. The result will appear here when it’s ready.", "طلبك في قائمة الانتظار. سأنشر النتيجة هنا عندما تكون جاهزة."],
    running: ["Work is underway. The result will appear here.", "أعمل على طلبك وسأنشر النتيجة هنا."],
    waiting_for_host: ["The work is waiting for an available execution host.", "العمل بانتظار جهاز متاح للتنفيذ."],
    waiting_for_input: ["The work needs your input before it can continue.", "يحتاج العمل إلى معلومات منك قبل المتابعة."],
    waiting_for_approval: ["The work is waiting for your approval before it can continue.", "العمل بانتظار موافقتك قبل المتابعة."],
    paused: ["The work is paused. You can ask me to resume it.", "العمل متوقف مؤقتًا. يمكنك أن تطلب مني استئنافه."]
  };
  return ownership.tasks.map((task, index) => {
    const message = messages[task.status] ?? messages.queued!;
    const text = message[locale === "ar" ? 1 : 0];
    return ownership.tasks.length === 1 ? text : `${index + 1}. ${text}`;
  }).join("\n\n");
}

function taskStatus(value: unknown): TaskStatus | undefined {
  return typeof value === "string" && PENDING_TASK_STATUSES.has(value as TaskStatus)
    ? value as TaskStatus
    : undefined;
}

function executionStateValue(value: unknown): PendingDelegatedAnswerTask["execution"] | undefined {
  return value === "foreground" || value === "background" || value === "waiting" ? value : undefined;
}

function safeToken(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return /^[A-Za-z0-9_.:-]{1,256}$/u.test(normalized)
    ? normalized
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
