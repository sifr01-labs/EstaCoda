import type { TaskStatus } from "../contracts/task.js";
import type { ToolExecutionRecord } from "../tools/tool-executor.js";
import { isolateLtr } from "../ui/bidi.js";

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
  return ownership.tasks.map((task) => locale === "ar"
    ? [
        `تم إنشاء ${isolateLtr("Task")}: ${isolateLtr(task.taskId)}.`,
        `الحالة الحالية: ${isolateLtr(task.status)} (${isolateLtr(task.execution)}).`,
        `تملك هذه ${isolateLtr("Task")} الإجابة المطلوبة. ستُسلَّم النتيجة عند اكتمال ${isolateLtr("Task")}.`
      ].join("\n")
    : [
        `Task created: ${task.taskId}.`,
        `Current state: ${task.status} (${task.execution}).`,
        "This Task owns the requested answer. The result will be delivered when the Task settles."
      ].join("\n")
  ).join("\n\n");
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
