import type {
  TaskCompletionTraceCategory,
  TaskCompletionTraceOutcome,
  TaskCompletionTraceSnapshot,
  TaskCompletionTraceSpan,
} from "../contracts/task-completion-trace.js";
import type { TaskStatusProjection } from "./task-operator-service.js";

const MAX_PERSISTED_TRACE_SPANS = 96;
const MAX_TRACE_LABEL_CHARS = 160;

const TRACE_CATEGORIES: readonly TaskCompletionTraceCategory[] = [
  "plan",
  "search",
  "read",
  "execute",
  "write",
  "validate",
  "wait",
  "retry",
  "failure",
  "deliver",
];

/** Freeze the safe logical projection used by the terminal delivery renderer. */
export function createTaskCompletionTraceSnapshot(
  projection: TaskStatusProjection,
  answerAvailable: boolean
): TaskCompletionTraceSnapshot {
  const allSpans = projection.trace.spans;
  const spans = allSpans.slice(-MAX_PERSISTED_TRACE_SPANS).map((span): TaskCompletionTraceSpan => ({
    category: span.category,
    scope: { kind: span.scope.kind, label: span.scope.label },
    status: span.status === "failed" ? "failed" : "completed",
    durationMs: boundedCount(span.durationMs),
    label: span.label,
  }));
  const workerProgress = projection.phase.workerProgress;
  return {
    version: 1,
    taskId: projection.taskId,
    stage: projection.steps.some((step) => step.executorRole === "synthesis")
      ? "synthesis"
      : spans.length > 0 ? "delivery" : "task",
    outcome: completionOutcome(projection),
    answerAvailable,
    activityCount: allSpans.length,
    activityCountComplete: !projection.trace.hasEarlierEvents,
    totalDurationMs: boundedCount(projection.elapsedMs),
    hasEarlierActivities: projection.trace.hasEarlierEvents || allSpans.length > spans.length,
    spans,
    ...(workerProgress === undefined ? {} : {
      workerOutcomes: {
        usable: boundedCount(workerProgress.usable),
        failed: boundedCount(workerProgress.failed),
        cancelled: boundedCount(workerProgress.cancelled),
      },
    }),
  };
}

/** Parse persisted metadata defensively; malformed snapshots never block answer delivery. */
export function parseTaskCompletionTraceSnapshot(
  value: unknown,
  expectedTaskId?: string
): TaskCompletionTraceSnapshot | undefined {
  if (!isRecord(value) || value.version !== 1 || !isToken(value.taskId) ||
      (expectedTaskId !== undefined && value.taskId !== expectedTaskId) ||
      !isStage(value.stage) || !isOutcome(value.outcome) || typeof value.answerAvailable !== "boolean" ||
      !isCount(value.activityCount) || typeof value.activityCountComplete !== "boolean" ||
      !isCount(value.totalDurationMs) || typeof value.hasEarlierActivities !== "boolean" ||
      !Array.isArray(value.spans) || value.spans.length > MAX_PERSISTED_TRACE_SPANS) {
    return undefined;
  }
  const spans = value.spans.map(parseSpan);
  if (spans.some((span) => span === undefined) || value.activityCount < spans.length) return undefined;
  const workerOutcomes = value.workerOutcomes === undefined
    ? undefined
    : parseWorkerOutcomes(value.workerOutcomes);
  if (value.workerOutcomes !== undefined && workerOutcomes === undefined) return undefined;
  return {
    version: 1,
    taskId: value.taskId,
    stage: value.stage,
    outcome: value.outcome,
    answerAvailable: value.answerAvailable,
    activityCount: value.activityCount,
    activityCountComplete: value.activityCountComplete,
    totalDurationMs: value.totalDurationMs,
    hasEarlierActivities: value.hasEarlierActivities,
    spans: spans as TaskCompletionTraceSpan[],
    ...(workerOutcomes === undefined ? {} : { workerOutcomes }),
  };
}

function completionOutcome(projection: TaskStatusProjection): TaskCompletionTraceOutcome {
  if (projection.status === "cancelled") return "cancelled";
  if (projection.status === "failed") return "failed";
  const workers = projection.phase.workerProgress;
  return projection.status === "partial" || (workers !== undefined && (workers.failed > 0 || workers.cancelled > 0))
    ? "complete_with_warnings"
    : "complete";
}

function parseSpan(value: unknown): TaskCompletionTraceSpan | undefined {
  if (!isRecord(value) || !isCategory(value.category) || !isRecord(value.scope) ||
      !isScopeKind(value.scope.kind) || !isSafeLabel(value.scope.label) ||
      (value.status !== "completed" && value.status !== "failed") ||
      !isCount(value.durationMs) || !isSafeLabel(value.label)) {
    return undefined;
  }
  return {
    category: value.category,
    scope: { kind: value.scope.kind, label: value.scope.label },
    status: value.status,
    durationMs: value.durationMs,
    label: value.label,
  };
}

function parseWorkerOutcomes(value: unknown): NonNullable<TaskCompletionTraceSnapshot["workerOutcomes"]> | undefined {
  if (!isRecord(value) || !isCount(value.usable) || !isCount(value.failed) || !isCount(value.cancelled)) {
    return undefined;
  }
  return { usable: value.usable, failed: value.failed, cancelled: value.cancelled };
}

function boundedCount(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value))) : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isToken(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 256 &&
    !/[\u0000-\u001F\u007F]/u.test(value);
}

function isSafeLabel(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_TRACE_LABEL_CHARS &&
    !/[\u0000-\u001F\u007F]/u.test(value);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isCategory(value: unknown): value is TaskCompletionTraceCategory {
  return typeof value === "string" && TRACE_CATEGORIES.includes(value as TaskCompletionTraceCategory);
}

function isStage(value: unknown): value is TaskCompletionTraceSnapshot["stage"] {
  return value === "task" || value === "synthesis" || value === "delivery";
}

function isOutcome(value: unknown): value is TaskCompletionTraceOutcome {
  return value === "complete" || value === "complete_with_warnings" || value === "failed" || value === "cancelled";
}

function isScopeKind(value: unknown): value is TaskCompletionTraceSpan["scope"]["kind"] {
  return value === "task" || value === "subagent" || value === "synthesis" || value === "delivery";
}
