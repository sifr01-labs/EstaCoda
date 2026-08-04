import type { TaskAttemptStatus, TaskEventKind } from "../contracts/task.js";
import { redactSensitiveText } from "../utils/redaction.js";
import {
  taskActivityCategoryFromTrace,
  type TaskActivityCategory,
} from "./task-safe-activity.js";
import type { TaskTraceCategory } from "./task-step-executor.js";

const ACTIVE_ATTEMPT_STATUSES: readonly TaskAttemptStatus[] = [
  "leased",
  "running",
  "waiting_for_input",
  "waiting_for_approval",
];
const SPAN_LABEL_MAX_CHARS = 160;

export type TaskActivityScope = {
  readonly kind: "task" | "subagent" | "synthesis" | "delivery";
  readonly stepId?: string;
  readonly label: string;
};

export type TaskActivitySpan = {
  readonly id: string;
  readonly category: TaskActivityCategory;
  readonly scope: TaskActivityScope;
  readonly status: "completed" | "running" | "failed";
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly durationMs: number;
  readonly eventCount: number;
  readonly label: string;
  readonly attemptId?: string;
};

export type TaskActivitySpanEvent = {
  readonly eventId: string;
  readonly kind: TaskEventKind;
  readonly label: string;
  readonly category: TaskTraceCategory;
  readonly timestamp: string;
  readonly stepId?: string;
  readonly attemptId?: string;
};

export type TaskActivitySpanStep = {
  readonly stepId: string;
  readonly kind: "subagent" | "synthesis";
  readonly label: string;
};

export type TaskActivitySpanAttempt = {
  readonly attemptId: string;
  readonly attemptNumber: number;
  readonly status: TaskAttemptStatus;
  readonly completedAt?: string;
};

type MutableSpan = Omit<TaskActivitySpan, "status" | "endedAt" | "durationMs"> & {
  eventCount: number;
  label: string;
  lastEventAt: string;
};

/**
 * Derives bounded logical activities from already-safe durable event projections.
 * Raw events remain the source of truth for detailed inspection.
 */
export function deriveTaskActivitySpans(
  events: readonly TaskActivitySpanEvent[],
  options: {
    readonly steps: readonly TaskActivitySpanStep[];
    readonly attempts: readonly TaskActivitySpanAttempt[];
    readonly projectionTimestamp: string;
    readonly taskCompletedAt?: string;
  }
): readonly TaskActivitySpan[] {
  const steps = new Map(options.steps.map((step) => [step.stepId, step] as const));
  const attempts = new Map(options.attempts.map((attempt) => [attempt.attemptId, attempt] as const));
  const mutable: MutableSpan[] = [];

  for (const event of events) {
    const attempt = event.attemptId === undefined ? undefined : attempts.get(event.attemptId);
    const category = activityCategory(event, attempt?.attemptNumber);
    const scope = activityScope(event.stepId, category, steps);
    const label = activityLabel(event, category);
    const previous = mutable.at(-1);
    if (previous !== undefined &&
        previous.category === category &&
        sameScope(previous.scope, scope) &&
        previous.attemptId === event.attemptId) {
      mutable[mutable.length - 1] = {
        ...previous,
        eventCount: previous.eventCount + 1,
        label,
        lastEventAt: event.timestamp,
      };
      continue;
    }
    mutable.push({
      id: event.eventId,
      category,
      scope,
      startedAt: event.timestamp,
      eventCount: 1,
      label,
      ...(event.attemptId === undefined ? {} : { attemptId: event.attemptId }),
      lastEventAt: event.timestamp,
    });
  }

  const lastSpanByActiveAttempt = new Map<string, number>();
  for (let index = mutable.length - 1; index >= 0; index -= 1) {
    const attemptId = mutable[index]?.attemptId;
    if (attemptId === undefined || lastSpanByActiveAttempt.has(attemptId)) continue;
    const attempt = attempts.get(attemptId);
    if (attempt !== undefined && ACTIVE_ATTEMPT_STATUSES.includes(attempt.status)) {
      lastSpanByActiveAttempt.set(attemptId, index);
    }
  }

  return mutable.map((span, index) => {
    const failed = span.category === "failure";
    const running = !failed && span.attemptId !== undefined && lastSpanByActiveAttempt.get(span.attemptId) === index;
    const status = failed ? "failed" as const : running ? "running" as const : "completed" as const;
    const endedAt = running
      ? undefined
      : completedSpanEnd(span, index, mutable, attempts, options.taskCompletedAt);
    const durationEnd = running ? options.projectionTimestamp : endedAt ?? span.lastEventAt;
    return {
      id: span.id,
      category: span.category,
      scope: span.scope,
      status,
      startedAt: span.startedAt,
      ...(endedAt === undefined ? {} : { endedAt }),
      durationMs: durationMs(span.startedAt, durationEnd),
      eventCount: span.eventCount,
      label: span.label,
      ...(span.attemptId === undefined ? {} : { attemptId: span.attemptId }),
    };
  });
}

function activityCategory(event: TaskActivitySpanEvent, attemptNumber: number | undefined): TaskActivityCategory {
  if (event.kind === "attempt-created" && attemptNumber !== undefined && attemptNumber > 1) return "retry";
  if (event.label.startsWith("Provider route failed; switching fallback")) return "retry";
  if (event.kind === "task-state-changed" && event.category === "finish") return "deliver";
  return taskActivityCategoryFromTrace(event.category);
}

function activityScope(
  stepId: string | undefined,
  category: TaskActivityCategory,
  steps: ReadonlyMap<string, TaskActivitySpanStep>
): TaskActivityScope {
  const step = stepId === undefined ? undefined : steps.get(stepId);
  if (step !== undefined) {
    return {
      kind: step.kind,
      stepId: step.stepId,
      label: safeLabel(step.label),
    };
  }
  if (category === "deliver") return { kind: "delivery", label: "Delivery" };
  return { kind: "task", label: "Task" };
}

function activityLabel(event: TaskActivitySpanEvent, category: TaskActivityCategory): string {
  if (category === "retry") return "Retrying attempt";
  if (category === "deliver") return "Finalizing task delivery";
  if (event.category === "answer") return "Writing response";
  return safeLabel(event.label);
}

function completedSpanEnd(
  span: MutableSpan,
  index: number,
  spans: readonly MutableSpan[],
  attempts: ReadonlyMap<string, TaskActivitySpanAttempt>,
  taskCompletedAt: string | undefined
): string {
  const candidates: string[] = [];
  const nextInScope = spans.slice(index + 1).find((candidate) => sameScope(candidate.scope, span.scope));
  if (nextInScope !== undefined) candidates.push(nextInScope.startedAt);
  const attemptCompletedAt = span.attemptId === undefined ? undefined : attempts.get(span.attemptId)?.completedAt;
  if (attemptCompletedAt !== undefined) candidates.push(attemptCompletedAt);
  if ((span.scope.kind === "task" || span.scope.kind === "delivery") && taskCompletedAt !== undefined) {
    candidates.push(taskCompletedAt);
  }
  return earliestAtOrAfter(candidates, span.startedAt) ?? span.lastEventAt;
}

function sameScope(left: TaskActivityScope, right: TaskActivityScope): boolean {
  return left.kind === right.kind && left.stepId === right.stepId;
}

function earliestAtOrAfter(values: readonly string[], lowerBound: string): string | undefined {
  const lower = Date.parse(lowerBound);
  return values
    .map((value) => ({ value, time: Date.parse(value) }))
    .filter((candidate) => Number.isFinite(candidate.time) && (!Number.isFinite(lower) || candidate.time >= lower))
    .sort((left, right) => left.time - right.time)[0]?.value;
}

function durationMs(startedAt: string, endedAt: string): number {
  const start = Date.parse(startedAt);
  const end = Date.parse(endedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return Math.max(0, end - start);
}

function safeLabel(value: string): string {
  const normalized = redactSensitiveText(value).replace(/\s+/gu, " ").trim();
  const bounded = normalized.length <= SPAN_LABEL_MAX_CHARS
    ? normalized
    : `${normalized.slice(0, SPAN_LABEL_MAX_CHARS - 1)}…`;
  return bounded.length === 0 || /[\u0000-\u001F\u007F]/u.test(bounded) ? "Activity" : bounded;
}
