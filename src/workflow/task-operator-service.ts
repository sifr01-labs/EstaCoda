import { randomUUID } from "node:crypto";
import type {
  Task,
  TaskAuthorityDisposition,
  TaskAuthorityPolicy,
  TaskAttempt,
  TaskAttemptStatus,
  TaskDeliveryDestination,
  TaskEvent,
  TaskResult,
  TaskStatus,
  TaskStep,
  TaskUsageTotals,
  TaskWorkspaceBinding
} from "../contracts/task.js";
import {
  TASK_GRAPH_LIMITS,
  TASK_ORIGIN_COMPLETION_DELIVERY_KEY,
  TASK_TOOL_RISK_CLASSES,
  isTerminalTaskStatus
} from "../contracts/task.js";
import { redactSensitiveText } from "../utils/redaction.js";
import { taskUsageFromEntries } from "./task-agent-usage.js";
import { FixedTaskService } from "./fixed-task-service.js";
import type { TaskStore } from "./task-store.js";
import { taskToolCategory } from "./task-safe-activity.js";

const ACTIVE_ATTEMPT_STATUSES: readonly TaskAttemptStatus[] = [
  "leased",
  "running",
  "waiting_for_input",
  "waiting_for_approval"
];
const MAX_LISTED_TASKS = 100;
const MAX_PROJECTED_RESULTS = 20;
const MAX_PROJECTED_STEPS = 100;
const MAX_RECENT_ACTIVITY = 12;

export type TaskProgress = Record<TaskStep["status"], number> & { total: number };

export type TaskStatusProjection = {
  taskId: string;
  objective: string;
  status: TaskStatus;
  source: Task["source"];
  parentTaskId?: string;
  progress: TaskProgress;
  activeAttempts: number;
  planRevision?: {
    revision: number;
    status: "draft" | "validated" | "active" | "superseded" | "rejected";
  };
  steps: readonly TaskStepProjection[];
  recentActivity: readonly TaskActivityProjection[];
  currentToolCategory?: string;
  elapsedMs: number;
  usage: TaskUsageTotals;
  results: readonly Pick<TaskResult, "id" | "handle" | "kind" | "status" | "byteLength" | "mimeType" | "summary">[];
  waitReason?: string;
  failure?: Pick<NonNullable<Task["failure"]>, "class" | "retryable" | "uncertainSideEffects">;
  createdAt: string;
  updatedAt: string;
};

export type TaskAttemptProjection = {
  attemptNumber: number;
  status: TaskAttemptStatus;
  startedAt?: string;
  completedAt?: string;
  elapsedMs: number;
  currentActivity?: string;
  currentToolCategory?: string;
};

export type TaskStepProjection = {
  stepId: string;
  title: string;
  status: TaskStep["status"];
  dependsOn: readonly string[];
  activeAttempt?: TaskAttemptProjection;
};

export type TaskActivityProjection = {
  kind: TaskEvent["kind"];
  label: string;
  timestamp: string;
  stepId?: string;
};

/** Profile-bound operator controls. Session authorization is explicit for in-session callers. */
export class TaskOperatorService {
  readonly #store: TaskStore;
  readonly #now: () => Date;
  readonly #eventId: () => string;

  constructor(options: { store: TaskStore; now?: () => Date; eventId?: () => string }) {
    this.#store = options.store;
    this.#now = options.now ?? (() => new Date());
    this.#eventId = options.eventId ?? randomUUID;
  }

  begin(input: {
    objective: string;
    workspace: TaskWorkspaceBinding;
    creatorSessionId: string;
    source?: "cli" | "gateway" | "runtime";
    completionDestination?: TaskDeliveryDestination;
  }): TaskStatusProjection {
    const objective = normalizeTaskOperatorObjective(input.objective);
    const authority = operatorTaskAuthority();
    const graph = new FixedTaskService({ store: this.#store, now: this.#now }).create({
      creatorSessionId: input.creatorSessionId,
      source: input.source ?? "cli",
      objective,
      workspace: input.workspace,
      authorityPolicy: authority,
      budgetPolicy: {
        maxConcurrentAttempts: 1,
        maxProviderCalls: 45,
        maxTotalTokens: 1_000_000,
        maxEstimatedCostUsd: 100,
        maxWallClockMs: 30 * 60 * 1_000
      },
      steps: [{
        key: "task",
        title: "Complete Task",
        objective,
        dependsOn: [],
        executor: { kind: "agent", role: "worker" },
        authorityPolicy: authority,
        budget: {
          maxProviderCalls: 45,
          maxTotalTokens: 1_000_000,
          maxEstimatedCostUsd: 100,
          maxWallClockMs: 30 * 60 * 1_000
        },
        retryPolicy: {
          maxAttempts: TASK_GRAPH_LIMITS.maxAttemptsPerStep,
          initialBackoffMs: 0,
          backoffMultiplier: 1,
          maxBackoffMs: 0,
          // Unknown-idempotency agent work never auto-retries. Explicit operator retry requeues the Step.
          retryableFailureClasses: ["operator-retry-only"],
          nonRetryableFailureClasses: [],
          requireIdempotent: false
        },
        failurePolicy: { onAttemptsExhausted: "wait_for_operator", optional: false },
        idempotency: "unknown",
        resultPolicy: { kind: "text", required: true, maxBytes: 1_048_576 }
      }],
      planReason: "Created by an explicit Task operator command.",
      ...(input.completionDestination === undefined ? {} : {
        completionDelivery: {
          deliveryKey: TASK_ORIGIN_COMPLETION_DELIVERY_KEY,
          destination: input.completionDestination
        }
      })
    });
    return this.#project(graph.task);
  }

  list(input: { authorizedSessionId?: string; limit?: number } = {}): TaskStatusProjection[] {
    const limit = Math.min(MAX_LISTED_TASKS, Math.max(1, Math.floor(input.limit ?? 20)));
    return this.#store.listTasks({ limit: MAX_LISTED_TASKS })
      .filter((task) => input.authorizedSessionId === undefined || this.#isLinked(task.id, input.authorizedSessionId))
      .slice(0, limit)
      .map((task) => this.#project(task));
  }

  status(taskId: string, authorizedSessionId?: string): TaskStatusProjection {
    return this.#project(this.#authorizedTask(taskId, authorizedSessionId, false));
  }

  results(taskId: string, authorizedSessionId?: string): TaskStatusProjection["results"] {
    const task = this.#authorizedTask(taskId, authorizedSessionId, false);
    return this.#project(task).results;
  }

  pause(taskId: string, authorizedSessionId?: string): TaskStatusProjection {
    const now = this.#now().toISOString();
    const task = this.#store.atomicWrite((store) => {
      const current = this.#authorizedTask(taskId, authorizedSessionId, true, store);
      if (isTerminalTaskStatus(current.status)) throw new Error(`Task ${current.id} is already settled.`);
      if (current.status === "paused") return current;
      const next = { ...current, status: "paused" as const, updatedAt: now };
      store.updateTask(next);
      store.appendEvent(this.#event(current, "task-state-changed", now, {
        from: current.status,
        to: "paused",
        reasonCode: "operator-pause"
      }));
      return next;
    });
    return this.#project(task);
  }

  resume(taskId: string, authorizedSessionId?: string): TaskStatusProjection {
    const now = this.#now().toISOString();
    const task = this.#store.atomicWrite((store) => {
      const current = this.#authorizedTask(taskId, authorizedSessionId, true, store);
      if (current.status !== "paused") throw new Error(`Task ${current.id} is not paused.`);
      const next = { ...current, status: "queued" as const, waitReason: undefined, updatedAt: now };
      store.updateTask(next);
      store.appendEvent(this.#event(current, "task-state-changed", now, {
        from: "paused",
        to: "queued",
        reasonCode: "operator-resume"
      }));
      return next;
    });
    return this.#project(task);
  }

  cancel(taskId: string, authorizedSessionId?: string): TaskStatusProjection {
    return this.#project(cancelTaskInStore({
      store: this.#store,
      taskId,
      authorizedSessionId,
      reasonCode: "operator-request",
      timestamp: this.#now().toISOString(),
      eventId: this.#eventId
    }));
  }

  retry(taskId: string, stepId?: string, authorizedSessionId?: string): TaskStatusProjection {
    const now = this.#now().toISOString();
    const task = this.#store.atomicWrite((store) => {
      const current = this.#authorizedTask(taskId, authorizedSessionId, true, store);
      if (current.status !== "waiting_for_input" && current.status !== "paused") {
        throw new Error(`Task ${current.id} is not waiting for an operator retry.`);
      }
      const revisionId = current.activePlanRevisionId;
      if (revisionId === undefined) throw new Error(`Task ${current.id} has no active plan.`);
      const candidates = store.listSteps(current.id, revisionId)
        .filter((step) => step.status === "waiting_for_input" && (stepId === undefined || step.id === stepId));
      if (candidates.length === 0) throw new Error(stepId === undefined
        ? `Task ${current.id} has no Step waiting for retry.`
        : `Step ${stepId} is not waiting for retry in Task ${current.id}.`);
      if (stepId === undefined && candidates.length > 1) {
        throw new Error(`Task ${current.id} has multiple retryable Steps; pass a Step ID.`);
      }
      const step = candidates[0]!;
      const attempts = store.listAttempts(current.id, step.id);
      if (attempts.length >= step.retryPolicy.maxAttempts) {
        throw new Error(`Step ${step.id} has exhausted its ${step.retryPolicy.maxAttempts} Attempt limit.`);
      }
      store.updateStep({ ...step, status: "ready", updatedAt: now });
      store.appendEvent(this.#event(current, "step-state-changed", now, {
        from: "waiting_for_input",
        to: "ready",
        reasonCode: "operator-retry",
        stepId: step.id
      }, step));
      const next = { ...current, status: "queued" as const, waitReason: undefined, updatedAt: now };
      store.updateTask(next);
      store.appendEvent(this.#event(current, "task-state-changed", now, {
        from: current.status,
        to: "queued",
        reasonCode: "operator-retry",
        stepId: step.id
      }));
      return next;
    });
    return this.#project(task);
  }

  #project(task: Task): TaskStatusProjection {
    const steps = task.activePlanRevisionId === undefined
      ? []
      : this.#store.listSteps(task.id, task.activePlanRevisionId);
    const progress = emptyProgress();
    for (const step of steps) progress[step.status] += 1;
    progress.total = steps.length;
    const attempts = this.#store.listAttempts(task.id);
    const projectionNow = this.#now();
    const attemptsByStep = groupAttemptsByStep(attempts);
    const activityByAttempt = this.#latestActivityByAttempt(task.id);
    const planRevision = task.activePlanRevisionId === undefined
      ? undefined
      : this.#store.getPlanRevision(task.activePlanRevisionId);
    const recentActivity = this.#recentActivity(task, steps);
    const currentToolCategory = this.#currentToolCategory(task, attempts, activityByAttempt);
    return {
      taskId: task.id,
      objective: safeText(task.objective, 240),
      status: task.status,
      source: task.source,
      ...(task.parentTaskId === undefined ? {} : { parentTaskId: task.parentTaskId }),
      progress,
      activeAttempts: attempts.filter((attempt) => ACTIVE_ATTEMPT_STATUSES.includes(attempt.status)).length,
      ...(planRevision === null || planRevision === undefined ? {} : {
        planRevision: {
          revision: planRevision.revision,
          status: planRevision.status
        }
      }),
      steps: steps.slice(0, MAX_PROJECTED_STEPS).map((step) => ({
        stepId: step.id,
        title: safeText(step.title, 160),
        status: step.status,
        dependsOn: step.dependsOn.slice(0, TASK_GRAPH_LIMITS.maxDependenciesPerStep),
        ...projectActiveAttempt(attemptsByStep.get(step.id), activityByAttempt, projectionNow)
      })),
      recentActivity,
      ...(currentToolCategory === undefined ? {} : { currentToolCategory }),
      elapsedMs: elapsedMs(task.startedAt ?? task.createdAt, task.completedAt ?? task.cancelledAt, projectionNow),
      usage: taskUsageFromEntries(this.#store.listUsageEntries(task.id)),
      results: this.#store.listResults(task.id).slice(0, MAX_PROJECTED_RESULTS).map((result) => ({
        id: result.id,
        handle: result.handle,
        kind: result.kind,
        status: result.status,
        byteLength: result.byteLength,
        ...(result.mimeType === undefined ? {} : { mimeType: result.mimeType }),
        ...(result.summary === undefined ? {} : { summary: safeText(result.summary, 240) })
      })),
      ...(task.waitReason === undefined ? {} : { waitReason: safeText(task.waitReason.summary, 240) }),
      ...(task.failure === undefined ? {} : {
        failure: {
          class: task.failure.class,
          retryable: task.failure.retryable,
          uncertainSideEffects: task.failure.uncertainSideEffects
        }
      }),
      createdAt: task.createdAt,
      updatedAt: task.updatedAt
    };
  }

  #recentActivity(task: Task, steps: readonly TaskStep[]): readonly TaskActivityProjection[] {
    const titles = new Map(steps.map((step) => [step.id, safeText(step.title, 80)]));
    return this.#store.listEvents(task.id, { limit: MAX_RECENT_ACTIVITY, order: "desc" })
      .map((event) => ({
        kind: event.kind,
        label: taskActivityLabel(event, titles),
        timestamp: event.timestamp,
        ...(event.stepId === undefined ? {} : { stepId: event.stepId })
      }));
  }

  #latestActivityByAttempt(taskId: string): ReadonlyMap<string, ReturnType<typeof eventActivity>> {
    const result = new Map<string, NonNullable<ReturnType<typeof eventActivity>>>();
    for (const event of this.#store.listEvents(taskId, { kinds: ["attempt-progressed"], limit: 1_000, order: "desc" })) {
      if (event.attemptId === undefined || result.has(event.attemptId)) continue;
      const activity = eventActivity(event);
      if (activity !== undefined) result.set(event.attemptId, activity);
    }
    return result;
  }

  #currentToolCategory(
    task: Task,
    attempts: readonly TaskAttempt[],
    activityByAttempt: ReadonlyMap<string, ReturnType<typeof eventActivity>>
  ): string | undefined {
    const activeAttemptIds = new Set(attempts
      .filter((attempt) => ACTIVE_ATTEMPT_STATUSES.includes(attempt.status))
      .map((attempt) => attempt.id));
    const category = attempts
      .filter((attempt) => activeAttemptIds.has(attempt.id))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map((attempt) => activityByAttempt.get(attempt.id)?.toolCategory)
      .find((candidate) => candidate !== undefined);
    if (category !== undefined) return category;
    const approval = this.#store.listApprovalLinks({ taskId: task.id, statuses: ["requesting", "pending"], limit: 100 })
      .find((link) => activeAttemptIds.has(link.attemptId));
    if (approval !== undefined) return taskToolCategory(approval.toolName);
    return activeAttemptIds.size > 0 ? "agent" : undefined;
  }

  #authorizedTask(taskId: string, sessionId: string | undefined, mutate: boolean, store = this.#store): Task {
    const id = token(taskId, "Task ID");
    const task = store.getTask(id);
    if (task === null) throw new Error(`Task ${id} was not found in this profile.`);
    if (sessionId !== undefined) {
      const relationship = store.listSessionLinks(id).find((link) => link.sessionId === sessionId)?.relationship;
      const allowed = mutate ? relationship === "creator" : relationship !== undefined;
      if (!allowed) throw new Error(`Task ${id} was not found for this session.`);
    }
    return task;
  }

  #isLinked(taskId: string, sessionId: string): boolean {
    return this.#store.listSessionLinks(taskId).some((link) => link.sessionId === sessionId);
  }

  #event(
    task: Task,
    kind: TaskEvent["kind"],
    timestamp: string,
    data: Readonly<Record<string, unknown>>,
    step?: TaskStep
  ): TaskEvent {
    return {
      id: token(this.#eventId(), "Task Event ID"),
      profileId: task.profileId,
      taskId: task.id,
      ...(step === undefined ? {} : { planRevisionId: step.planRevisionId, stepId: step.id }),
      kind,
      timestamp,
      data
    };
  }
}

export function cancelTaskInStore(input: {
  store: TaskStore;
  taskId: string;
  reasonCode: string;
  timestamp: string;
  eventId?: () => string;
  authorizedSessionId?: string;
}): Task {
  const eventId = input.eventId ?? randomUUID;
  const reason = token(input.reasonCode, "cancellation reason code");
  return input.store.atomicWrite((store) => {
    const task = store.getTask(token(input.taskId, "Task ID"));
    if (task === null) throw new Error(`Task ${input.taskId} was not found.`);
    if (input.authorizedSessionId !== undefined) {
      const relationship = store.listSessionLinks(task.id)
        .find((link) => link.sessionId === input.authorizedSessionId)?.relationship;
      if (relationship !== "creator") throw new Error(`Task ${task.id} was not found for this session.`);
    }
    if (isTerminalTaskStatus(task.status)) return task;
    const event = (kind: TaskEvent["kind"], data: Record<string, unknown>, step?: TaskStep): TaskEvent => ({
      id: token(eventId(), "Task Event ID"),
      profileId: task.profileId,
      taskId: task.id,
      ...(step === undefined ? {} : { planRevisionId: step.planRevisionId, stepId: step.id }),
      kind,
      timestamp: input.timestamp,
      data
    });
    if (task.activePlanRevisionId !== undefined) {
      for (const step of store.listSteps(task.id, task.activePlanRevisionId)) {
        if (["pending", "ready", "waiting_for_input", "waiting_for_approval"].includes(step.status)) {
          store.updateStep({ ...step, status: "cancelled", updatedAt: input.timestamp });
          store.appendEvent(event("step-state-changed", {
            from: step.status,
            to: "cancelled",
            reasonCode: reason
          }, step));
        }
      }
    }
    for (const attempt of store.listAttempts(task.id)) {
      if (attempt.status === "queued" ||
          ((attempt.status === "waiting_for_input" || attempt.status === "waiting_for_approval") && attempt.lease === undefined)) {
        store.updateAttempt({ ...attempt, status: "cancelled", updatedAt: input.timestamp, completedAt: input.timestamp });
        store.appendEvent({
          ...event("attempt-cancelled", { reasonCode: reason }),
          planRevisionId: attempt.planRevisionId,
          stepId: attempt.stepId,
          attemptId: attempt.id
        });
      } else if (ACTIVE_ATTEMPT_STATUSES.includes(attempt.status)) {
        store.requestAttemptCancellation(attempt.id, input.timestamp);
      }
    }
    const next = { ...task, status: "cancelled" as const, updatedAt: input.timestamp, cancelledAt: input.timestamp };
    store.updateTask(next);
    store.appendEvent(event("task-state-changed", {
      from: task.status,
      to: "cancelled",
      reasonCode: reason
    }));
    return next;
  });
}

function emptyProgress(): TaskProgress {
  return {
    pending: 0,
    ready: 0,
    running: 0,
    waiting_for_input: 0,
    waiting_for_approval: 0,
    completed: 0,
    failed: 0,
    skipped: 0,
    cancelled: 0,
    total: 0
  };
}

function token(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 256 || /[\u0000-\u001F\u007F]/u.test(normalized)) {
    throw new Error(`${label} is invalid.`);
  }
  return normalized;
}

function bounded(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}

function safeText(value: string, maxChars: number): string {
  return bounded(redactSensitiveText(value).replace(/\s+/gu, " ").trim(), maxChars);
}

function groupAttemptsByStep(attempts: readonly TaskAttempt[]): ReadonlyMap<string, readonly TaskAttempt[]> {
  const grouped = new Map<string, TaskAttempt[]>();
  for (const attempt of attempts) {
    const entries = grouped.get(attempt.stepId) ?? [];
    entries.push(attempt);
    grouped.set(attempt.stepId, entries);
  }
  return grouped;
}

function projectActiveAttempt(
  attempts: readonly TaskAttempt[] | undefined,
  activityByAttempt: ReadonlyMap<string, ReturnType<typeof eventActivity>>,
  now: Date
): { readonly activeAttempt?: TaskAttemptProjection } {
  const attempt = attempts
    ?.filter((candidate) => ACTIVE_ATTEMPT_STATUSES.includes(candidate.status))
    .sort((left, right) => right.attemptNumber - left.attemptNumber)[0];
  if (attempt === undefined) return {};
  const activity = activityByAttempt.get(attempt.id);
  return {
    activeAttempt: {
      attemptNumber: attempt.attemptNumber,
      status: attempt.status,
      ...(attempt.startedAt === undefined ? {} : { startedAt: attempt.startedAt }),
      ...(attempt.completedAt === undefined ? {} : { completedAt: attempt.completedAt }),
      elapsedMs: elapsedMs(attempt.startedAt ?? attempt.createdAt, attempt.completedAt, now),
      ...(activity === undefined ? {} : { currentActivity: activity.label }),
      ...(activity?.toolCategory === undefined ? {} : { currentToolCategory: activity.toolCategory })
    }
  };
}

function elapsedMs(startedAt: string, endedAt: string | undefined, now: Date): number {
  const start = Date.parse(startedAt);
  const end = endedAt === undefined ? now.getTime() : Date.parse(endedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return Math.max(0, end - start);
}

function taskActivityLabel(event: TaskEvent, stepTitles: ReadonlyMap<string, string>): string {
  const step = event.stepId === undefined ? undefined : stepTitles.get(event.stepId);
  const suffix = step === undefined ? "" : ` · ${step}`;
  const activity = eventActivity(event);
  if (activity !== undefined) return `${activity.label}${suffix}`;
  switch (event.kind) {
    case "task-created": return "Task created";
    case "task-state-changed": return "Task status changed";
    case "plan-revision-created": return "Plan revision created";
    case "plan-revision-validated": return "Plan revision validated";
    case "plan-revision-activated": return "Plan revision activated";
    case "plan-revision-rejected": return "Plan revision rejected";
    case "plan-revision-superseded": return "Plan revision superseded";
    case "step-state-changed": return `Step status changed${suffix}`;
    case "attempt-created": return `Attempt queued${suffix}`;
    case "attempt-leased": return `Worker assigned${suffix}`;
    case "attempt-started": return `Attempt started${suffix}`;
    case "attempt-progressed": return `Attempt checkpointed${suffix}`;
    case "attempt-waiting": return `Attempt waiting${suffix}`;
    case "attempt-completed": return `Attempt completed${suffix}`;
    case "attempt-failed": return `Attempt failed${suffix}`;
    case "attempt-cancelled": return `Attempt cancelled${suffix}`;
    case "attempt-interrupted": return `Attempt interrupted${suffix}`;
    case "attempt-expired": return `Attempt lease expired${suffix}`;
    case "approval-requested": return `Approval requested${suffix}`;
    case "approval-resolved": return `Approval resolved${suffix}`;
    case "task-steered": return "Operator guidance queued";
    case "usage-recorded": return `Usage recorded${suffix}`;
    case "result-recorded": return `Result recorded${suffix}`;
  }
}

function eventActivity(event: TaskEvent): { readonly label: string; readonly toolCategory?: string } | undefined {
  const activity = event.data.activity;
  if (activity === null || typeof activity !== "object" || Array.isArray(activity)) return undefined;
  const record = activity as Record<string, unknown>;
  if ((record.kind !== "worker" && record.kind !== "provider" && record.kind !== "tool") ||
      typeof record.label !== "string" || record.label.length === 0 || record.label.length > 160 ||
      /[\u0000-\u001F\u007F]/u.test(record.label)) return undefined;
  const toolCategory = typeof record.toolCategory === "string" && /^[A-Za-z0-9._:-]{1,160}$/u.test(record.toolCategory)
    ? record.toolCategory
    : undefined;
  return {
    label: safeText(record.label, 160),
    ...(toolCategory === undefined ? {} : { toolCategory })
  };
}

export function normalizeTaskOperatorObjective(value: string): string {
  const objective = value.trim();
  if (objective.length === 0 || objective.length > TASK_GRAPH_LIMITS.maxStepObjectiveChars || objective.includes("\u0000")) {
    throw new Error(`Task objective must be 1-${TASK_GRAPH_LIMITS.maxStepObjectiveChars} characters.`);
  }
  return objective;
}

function operatorTaskAuthority(): TaskAuthorityPolicy {
  const dispositions: Partial<Record<(typeof TASK_TOOL_RISK_CLASSES)[number], TaskAuthorityDisposition>> = {
    "read-only-local": "runtime_policy",
    "read-only-network": "runtime_policy",
    "workspace-write": "require_approval"
  };
  return {
    allowedToolsets: ["core", "files", "shell-readonly", "web", "coding", "research"],
    blockedTools: ["terminal.run"],
    riskClassPolicy: Object.fromEntries(TASK_TOOL_RISK_CLASSES.map((riskClass) => [
      riskClass,
      dispositions[riskClass] ?? "forbid"
    ])) as TaskAuthorityPolicy["riskClassPolicy"],
    mayCreateChildTasks: false,
    maxChildDepth: 0
  };
}
