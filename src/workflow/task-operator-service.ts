import { randomUUID } from "node:crypto";
import type {
  Task,
  TaskAuthorityDisposition,
  TaskAuthorityPolicy,
  TaskAttempt,
  TaskAttemptStatus,
  TaskDeliveryDestination,
  TaskEvent,
  TaskExecutionPreference,
  TaskHostLease,
  TaskResult,
  TaskStatus,
  TaskStep,
  TaskUsageTotals,
  TaskWorkspaceBinding
} from "../contracts/task.js";
import type { ProviderSpendScopeKind, ProviderSpendingScope } from "../contracts/provider-spend.js";
import type { ProviderUsageEntry } from "../contracts/provider-usage.js";
import type { SpendingBudgetSummary } from "../contracts/usage-cost.js";
import {
  TASK_GRAPH_LIMITS,
  TASK_ORIGIN_COMPLETION_DELIVERY_KEY,
  TASK_TOOL_RISK_CLASSES,
  isTerminalTaskStatus
} from "../contracts/task.js";
import { redactSensitiveText } from "../utils/redaction.js";
import { taskUsageFromEntries } from "./task-agent-usage.js";
import {
  listStepTreeAttempts,
  listTaskTreeUsageEntries
} from "./task-tree-accounting.js";
import { spendingBudgetSummary } from "../providers/provider-spend-projection.js";
import { FixedTaskService } from "./fixed-task-service.js";
import type { InitialTaskHostLeaseInput, TaskEventTraceSummary, TaskStore } from "./task-store.js";
import { taskToolCategory } from "./task-safe-activity.js";
import type { TaskTraceCategory } from "./task-step-executor.js";
import { orderTaskResults, taskPrimaryResult } from "./task-primary-result.js";
import { cloneSpendingLimit, type SpendingLimit } from "../contracts/budget.js";

const ACTIVE_ATTEMPT_STATUSES: readonly TaskAttemptStatus[] = [
  "leased",
  "running",
  "waiting_for_input",
  "waiting_for_approval"
];
const MAX_LISTED_TASKS = 100;
const MAX_PROJECTED_RESULTS = 20;
const MAX_PROJECTED_STEPS = 100;
const MAX_PROJECTED_TRACE_EVENTS = 512;
const MAX_RECENT_ACTIVITY = 12;
const MAX_PROJECTED_CHILD_TASKS = 32;

export type TaskProgress = Record<TaskStep["status"], number> & { total: number };

export type TaskPhaseName = TaskStatus | "delegating" | "synthesizing";

export type TaskPhaseProjection = {
  name: TaskPhaseName;
  workerProgress?: {
    completed: number;
    settled: number;
    total: number;
  };
};

export type TaskStatusProjection = {
  taskId: string;
  objective: string;
  status: TaskStatus;
  source: Task["source"];
  executionPreference: TaskExecutionPreference;
  execution: "foreground" | "background" | "waiting";
  foregroundOwnerActive: boolean;
  backgroundContinuation: "available" | "unavailable" | "unknown";
  executionWaitingReason?: string;
  parentTaskId?: string;
  childTasks: readonly {
    taskId: string;
    status: TaskStatus;
    parentAttemptId?: string;
  }[];
  phase: TaskPhaseProjection;
  progress: TaskProgress;
  activeAttempts: number;
  planRevision?: {
    revision: number;
    status: "draft" | "validated" | "active" | "superseded" | "rejected";
  };
  steps: readonly TaskStepProjection[];
  subagents: readonly TaskSubagentProjection[];
  trace: TaskTraceProjection;
  recentActivity: readonly TaskActivityProjection[];
  currentToolCategory?: string;
  elapsedMs: number;
  usage: TaskUsageTotals;
  spending?: SpendingBudgetSummary;
  results: readonly TaskResultProjection[];
  waitReason?: string;
  failure?: Pick<NonNullable<Task["failure"]>, "class" | "retryable" | "uncertainSideEffects">;
  createdAt: string;
  updatedAt: string;
};

export type TaskAttemptProjection = {
  attemptId: string;
  taskId: string;
  stepId: string;
  attemptNumber: number;
  status: TaskAttemptStatus;
  workerSessionId?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  elapsedMs: number;
  currentActivity?: string;
  currentToolCategory?: string;
  assistantPreview?: string;
  usage: TaskUsageTotals;
};

export type TaskStepProjection = {
  stepId: string;
  position: number;
  title: string;
  objective: string;
  executorRole: TaskStep["executor"]["role"];
  status: TaskStep["status"];
  dependsOn: readonly string[];
  childTaskPolicy: TaskStep["childTaskPolicy"];
  usage: TaskUsageTotals;
  attempts: readonly TaskAttemptProjection[];
  latestAttempt?: TaskAttemptProjection;
  activeAttempt?: TaskAttemptProjection;
};

export type TaskActivityProjection = {
  eventId: string;
  kind: TaskEvent["kind"];
  label: string;
  category: TaskTraceCategory;
  timestamp: string;
  stepId?: string;
  attemptId?: string;
  subagentIndex?: number;
};

export type TaskTraceEventProjection = TaskActivityProjection;

export type TaskTraceCategoryCounts = Readonly<Record<TaskTraceCategory, number>>;

export type TaskTraceProjection = {
  events: readonly TaskTraceEventProjection[];
  totalEvents: number;
  categoryCounts: TaskTraceCategoryCounts;
  hasEarlierEvents: boolean;
};

export type SubagentUsageProjection = {
  total: TaskUsageTotals;
  currentAttempt?: TaskUsageTotals;
};

export type TaskResultProjection = Pick<
  TaskResult,
  "id" | "handle" | "kind" | "disposition" | "status" | "byteLength" | "mimeType" | "summary" | "stepId" | "attemptId"
> & {
  primary: boolean;
};

export type TaskSubagentProjection = {
  stepId: string;
  position: number;
  displayIndex: number;
  displayLabel: string;
  title: string;
  objective: string;
  role: "worker" | "orchestrator";
  status: TaskStep["status"];
  dependsOn: readonly string[];
  elapsedMs: number;
  currentActivity?: string;
  currentToolCategory?: string;
  assistantPreview?: string;
  usage: SubagentUsageProjection;
  attempts: readonly TaskAttemptProjection[];
  latestAttempt?: TaskAttemptProjection;
  activeAttempt?: TaskAttemptProjection;
  trace: readonly TaskTraceEventProjection[];
  traceSummary: Omit<TaskTraceProjection, "events">;
  results: readonly TaskResultProjection[];
};

/** Profile-bound operator controls. Session authorization is explicit for in-session callers. */
export class TaskOperatorService {
  readonly #store: TaskStore;
  readonly #now: () => Date;
  readonly #eventId: () => string;
  readonly #backgroundContinuation: () => TaskStatusProjection["backgroundContinuation"];
  readonly #defaultTaskSpendingLimit: SpendingLimit | undefined;
  readonly #spendingScope: ((kind: ProviderSpendScopeKind, ownerId: string) => ProviderSpendingScope | null) | undefined;

  constructor(options: {
    store: TaskStore;
    now?: () => Date;
    eventId?: () => string;
    backgroundContinuation?: () => TaskStatusProjection["backgroundContinuation"];
    defaultTaskSpendingLimit?: SpendingLimit;
    spendingScope?: (kind: ProviderSpendScopeKind, ownerId: string) => ProviderSpendingScope | null;
  }) {
    this.#store = options.store;
    this.#now = options.now ?? (() => new Date());
    this.#eventId = options.eventId ?? randomUUID;
    this.#backgroundContinuation = options.backgroundContinuation ?? (() => "unknown");
    this.#defaultTaskSpendingLimit = cloneSpendingLimit(options.defaultTaskSpendingLimit);
    this.#spendingScope = options.spendingScope;
  }

  begin(input: {
    objective: string;
    workspace: TaskWorkspaceBinding;
    creatorSessionId: string;
    source?: "cli" | "gateway" | "runtime";
    executionPreference?: TaskExecutionPreference;
    completionDestination?: TaskDeliveryDestination;
    initialHostLease?: InitialTaskHostLeaseInput;
  }): TaskStatusProjection {
    const objective = normalizeTaskOperatorObjective(input.objective);
    const authority = operatorTaskAuthority();
    const source = input.source ?? "cli";
    const executionPreference = input.executionPreference ?? (source === "gateway" ? "background" : "auto");
    const graph = new FixedTaskService({ store: this.#store, now: this.#now }).create({
      creatorSessionId: input.creatorSessionId,
      source,
      executionPreference,
      objective,
      workspace: input.workspace,
      authorityPolicy: authority,
      ...(this.#defaultTaskSpendingLimit === undefined ? {} : { spendingLimit: this.#defaultTaskSpendingLimit }),
      executionLimits: {
        maxConcurrentAttempts: 1,
        maxProviderCalls: 45,
        maxTotalTokens: 1_000_000,
        maxWallClockMs: 30 * 60 * 1_000
      },
      steps: [{
        key: "task",
        title: "Complete Task",
        objective,
        dependsOn: [],
        executor: { kind: "agent", role: "worker" },
        childTaskPolicy: "forbid",
        authorityPolicy: authority,
        executionLimits: {
          maxProviderCalls: 45,
          maxTotalTokens: 1_000_000,
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
      ...(input.initialHostLease === undefined ? {} : { initialHostLease: input.initialHostLease }),
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
    const treeUsageEntries = listTaskTreeUsageEntries(this.#store, task.id);
    const usageByAttempt = groupUsageByAttempt(treeUsageEntries);
    const projectionNow = this.#now();
    const hostLease = activeHostLease(this.#store.getTaskHostLease(task.id), projectionNow);
    const execution = hostLease?.kind ?? "waiting";
    const backgroundContinuation = this.#backgroundContinuation();
    const attemptsByStep = groupAttemptsByStep(attempts);
    const activityByAttempt = this.#latestActivityByAttempt(task.id);
    const planRevision = task.activePlanRevisionId === undefined
      ? undefined
      : this.#store.getPlanRevision(task.activePlanRevisionId);
    const currentToolCategory = this.#currentToolCategory(task, attempts, activityByAttempt);
    const primaryResult = taskPrimaryResult(this.#store, task);
    const results = orderTaskResults(this.#store.listResults(task.id), primaryResult)
      .slice(0, MAX_PROJECTED_RESULTS)
      .map((result) => projectResult(result, result.id === primaryResult?.id));
    const eventTraceSummary = this.#store.summarizeEventTrace(task.id);
    const trace = this.#trace(task, steps, eventTraceSummary);
    const recentActivity = trace.events.slice(-MAX_RECENT_ACTIVITY).reverse();
    const projectedSteps = steps.slice(0, MAX_PROJECTED_STEPS).map((step) => {
      const stepAttempts = listStepTreeAttempts(this.#store, task.id, step.id);
      const stepAttemptIds = new Set(stepAttempts.map((attempt) => attempt.id));
      return {
        stepId: step.id,
        position: step.position,
        title: safeText(step.title, 160),
        objective: safeText(step.objective, 240),
        executorRole: step.executor.role,
        status: step.status,
        dependsOn: step.dependsOn.slice(0, TASK_GRAPH_LIMITS.maxDependenciesPerStep),
        childTaskPolicy: step.childTaskPolicy,
        usage: taskUsageFromEntries(treeUsageEntries.filter((entry) =>
          entry.attemptId !== undefined && stepAttemptIds.has(entry.attemptId)
        )),
        attempts: stepAttempts.map((attempt) => projectAttempt(
          attempt,
          usageByAttempt.get(attempt.id) ?? [],
          activityByAttempt,
          projectionNow
        )),
        ...projectLatestAttempt(attemptsByStep.get(step.id), usageByAttempt, activityByAttempt, projectionNow),
        ...projectActiveAttempt(attemptsByStep.get(step.id), usageByAttempt, activityByAttempt, projectionNow)
      } satisfies TaskStepProjection;
    });
    const subagents = projectedSteps.flatMap((step) =>
      step.executorRole === "worker" || step.executorRole === "orchestrator"
        ? [projectSubagent(task.id, step, trace.events, eventTraceSummary, results)]
        : []
    );
    return {
      taskId: task.id,
      objective: safeText(task.objective, 240),
      status: task.status,
      source: task.source,
      executionPreference: task.executionPreference,
      execution,
      foregroundOwnerActive: execution === "foreground",
      backgroundContinuation,
      ...executionWaitingReason(task, execution, backgroundContinuation),
      ...(task.parentTaskId === undefined ? {} : { parentTaskId: task.parentTaskId }),
      childTasks: this.#store.listChildTasks(task.id).slice(0, MAX_PROJECTED_CHILD_TASKS).map((child) => ({
        taskId: child.id,
        status: child.status,
        ...(child.parentAttemptId === undefined ? {} : { parentAttemptId: child.parentAttemptId })
      })),
      phase: projectTaskPhase(task, projectedSteps),
      progress,
      activeAttempts: attempts.filter((attempt) => ACTIVE_ATTEMPT_STATUSES.includes(attempt.status)).length,
      ...(planRevision === null || planRevision === undefined ? {} : {
        planRevision: {
          revision: planRevision.revision,
          status: planRevision.status
        }
      }),
      steps: projectedSteps,
      subagents,
      trace,
      recentActivity,
      ...(currentToolCategory === undefined ? {} : { currentToolCategory }),
      elapsedMs: elapsedMs(task.startedAt ?? task.createdAt, task.completedAt ?? task.cancelledAt, projectionNow),
      usage: taskUsageFromEntries(treeUsageEntries),
      ...this.#taskSpending(task, treeUsageEntries),
      results,
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

  #taskSpending(
    task: Task,
    treeUsageEntries: readonly ProviderUsageEntry[]
  ): { readonly spending?: SpendingBudgetSummary } {
    const root = task.id === task.rootTaskId ? task : this.#store.getTask(task.rootTaskId);
    if (root?.spendingLimit === undefined) return {};
    const scope = this.#spendingScope?.("root_task", root.id);
    const fallbackEntries = root.id === task.id
      ? treeUsageEntries
      : listTaskTreeUsageEntries(this.#store, root.id);
    return {
      spending: spendingBudgetSummary(
        root.spendingLimit,
        scope,
        taskUsageFromEntries(fallbackEntries).estimatedCostUsd
      )
    };
  }

  #trace(
    task: Task,
    steps: readonly TaskStep[],
    summary: TaskEventTraceSummary
  ): TaskTraceProjection {
    const titles = new Map(steps.map((step) => [step.id, safeText(step.title, 80)]));
    const subagentIndices = new Map(steps
      .filter((step) => step.executor.role === "worker" || step.executor.role === "orchestrator")
      .map((step) => [step.id, step.position + 1] as const));
    const events = this.#store.listEvents(task.id, {
      limit: MAX_PROJECTED_TRACE_EVENTS + 1,
      order: "desc"
    });
    return {
      events: events.slice(0, MAX_PROJECTED_TRACE_EVENTS).map((event) => ({
        eventId: event.id,
        kind: event.kind,
        label: taskActivityLabel(event, titles),
        category: taskTraceCategoryFromTaskEvent(event),
        timestamp: event.timestamp,
        ...(event.stepId === undefined ? {} : { stepId: event.stepId }),
        ...(event.attemptId === undefined ? {} : { attemptId: event.attemptId }),
        ...(event.stepId === undefined || subagentIndices.get(event.stepId) === undefined
          ? {}
          : { subagentIndex: subagentIndices.get(event.stepId) })
      })).reverse(),
      totalEvents: summary.totalEvents,
      categoryCounts: traceCategoryCounts(summary.counts),
      hasEarlierEvents: summary.totalEvents > MAX_PROJECTED_TRACE_EVENTS
    };
  }

  #latestActivityByAttempt(taskId: string): ReadonlyMap<string, ReturnType<typeof eventActivity>> {
    const result = new Map<string, NonNullable<ReturnType<typeof eventActivity>>>();
    for (const event of this.#store.listEvents(taskId, { kinds: ["attempt-progressed"], limit: 1_000, order: "desc" })) {
      if (event.attemptId === undefined) continue;
      const activity = eventActivity(event);
      if (activity === undefined) continue;
      const current = result.get(event.attemptId);
      if (current === undefined) {
        result.set(event.attemptId, activity);
        continue;
      }
      if ((current.toolCategory === undefined && activity.toolCategory !== undefined) ||
          (current.assistantPreview === undefined && activity.assistantPreview !== undefined)) {
        result.set(event.attemptId, {
          ...current,
          ...(current.toolCategory === undefined && activity.toolCategory !== undefined
            ? { toolCategory: activity.toolCategory }
            : {}),
          ...(current.assistantPreview === undefined && activity.assistantPreview !== undefined
            ? { assistantPreview: activity.assistantPreview }
            : {})
        });
      }
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

function projectTaskPhase(task: Task, steps: readonly TaskStepProjection[]): TaskPhaseProjection {
  const workers = task.source === "delegation"
    ? steps.filter((step) => step.executorRole === "worker" || step.executorRole === "orchestrator")
    : [];
  const completed = workers.filter((step) => step.status === "completed").length;
  const settled = workers.filter((step) =>
    step.status === "completed" ||
    step.status === "failed" ||
    step.status === "skipped" ||
    step.status === "cancelled"
  ).length;
  const workerProgress = workers.length === 0
    ? undefined
    : { completed, settled, total: workers.length };
  const synthesis = steps.find((step) => step.executorRole === "synthesis");
  const synthesisActive = synthesis !== undefined &&
    completed === workers.length &&
    workers.length > 0 &&
    (synthesis.status === "pending" || synthesis.status === "ready" || synthesis.status === "running");
  const name: TaskPhaseName = isTerminalTaskStatus(task.status) ||
    task.status === "planning" ||
    task.status === "waiting_for_host" ||
    task.status === "waiting_for_input" ||
    task.status === "waiting_for_approval" ||
    task.status === "paused"
    ? task.status
    : synthesisActive
      ? "synthesizing"
      : task.source === "delegation" && workers.length > 0
        ? "delegating"
        : task.status;
  return {
    name,
    ...(workerProgress === undefined ? {} : { workerProgress }),
  };
}

function activeHostLease(lease: TaskHostLease | null, now: Date): TaskHostLease | undefined {
  if (lease === null) return undefined;
  const expiresAt = Date.parse(lease.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt > now.getTime() ? lease : undefined;
}

function executionWaitingReason(
  task: Task,
  execution: TaskStatusProjection["execution"],
  backgroundContinuation: TaskStatusProjection["backgroundContinuation"]
): { executionWaitingReason?: string } {
  if (execution !== "waiting" || isTerminalTaskStatus(task.status)) return {};
  if (task.waitReason !== undefined) return { executionWaitingReason: safeText(task.waitReason.summary, 240) };
  if (task.executionPreference === "background") {
    return {
      executionWaitingReason: backgroundContinuation === "available"
        ? "Waiting for the background host to claim this Task."
        : backgroundContinuation === "unavailable"
          ? "Waiting for an active background host."
          : "Waiting for a compatible background host."
    };
  }
  return {
    executionWaitingReason: backgroundContinuation === "unavailable"
      ? "Waiting for an eligible host; no active background continuation is available."
      : "Waiting for an eligible Task host."
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

function groupUsageByAttempt(
  entries: readonly ProviderUsageEntry[]
): ReadonlyMap<string, readonly ProviderUsageEntry[]> {
  const grouped = new Map<string, ProviderUsageEntry[]>();
  for (const entry of entries) {
    if (entry.attemptId === undefined) continue;
    const attemptEntries = grouped.get(entry.attemptId) ?? [];
    attemptEntries.push(entry);
    grouped.set(entry.attemptId, attemptEntries);
  }
  return grouped;
}

function projectActiveAttempt(
  attempts: readonly TaskAttempt[] | undefined,
  usageByAttempt: ReadonlyMap<string, readonly ProviderUsageEntry[]>,
  activityByAttempt: ReadonlyMap<string, ReturnType<typeof eventActivity>>,
  now: Date
): { readonly activeAttempt?: TaskAttemptProjection } {
  const attempt = attempts
    ?.filter((candidate) => ACTIVE_ATTEMPT_STATUSES.includes(candidate.status))
    .sort((left, right) => right.attemptNumber - left.attemptNumber)[0];
  if (attempt === undefined) return {};
  return {
    activeAttempt: projectAttempt(
      attempt,
      usageByAttempt.get(attempt.id) ?? [],
      activityByAttempt,
      now
    )
  };
}

function projectLatestAttempt(
  attempts: readonly TaskAttempt[] | undefined,
  usageByAttempt: ReadonlyMap<string, readonly ProviderUsageEntry[]>,
  activityByAttempt: ReadonlyMap<string, ReturnType<typeof eventActivity>>,
  now: Date
): { readonly latestAttempt?: TaskAttemptProjection } {
  const attempt = attempts
    ?.slice()
    .sort((left, right) =>
      right.attemptNumber - left.attemptNumber || right.updatedAt.localeCompare(left.updatedAt)
    )[0];
  if (attempt === undefined) return {};
  return {
    latestAttempt: projectAttempt(
      attempt,
      usageByAttempt.get(attempt.id) ?? [],
      activityByAttempt,
      now
    )
  };
}

function projectAttempt(
  attempt: TaskAttempt,
  usageEntries: readonly ProviderUsageEntry[],
  activityByAttempt: ReadonlyMap<string, ReturnType<typeof eventActivity>>,
  now: Date
): TaskAttemptProjection {
  const activity = activityByAttempt.get(attempt.id);
  return {
    attemptId: attempt.id,
    taskId: attempt.taskId,
    stepId: attempt.stepId,
    attemptNumber: attempt.attemptNumber,
    status: attempt.status,
    ...(attempt.workerSessionId === undefined ? {} : { workerSessionId: attempt.workerSessionId }),
    createdAt: attempt.createdAt,
    updatedAt: attempt.updatedAt,
    ...(attempt.startedAt === undefined ? {} : { startedAt: attempt.startedAt }),
    ...(attempt.completedAt === undefined ? {} : { completedAt: attempt.completedAt }),
    elapsedMs: elapsedMs(attempt.startedAt ?? attempt.createdAt, attempt.completedAt, now),
    ...(activity === undefined ? {} : { currentActivity: activity.label }),
    ...(activity?.toolCategory === undefined ? {} : { currentToolCategory: activity.toolCategory }),
    ...(activity?.assistantPreview === undefined ? {} : { assistantPreview: activity.assistantPreview }),
    usage: taskUsageFromEntries(usageEntries)
  };
}

function projectResult(result: TaskResult, primary: boolean): TaskResultProjection {
  return {
    id: result.id,
    handle: result.handle,
    kind: result.kind,
    disposition: result.disposition,
    status: result.status,
    byteLength: result.byteLength,
    primary,
    ...(result.stepId === undefined ? {} : { stepId: result.stepId }),
    ...(result.attemptId === undefined ? {} : { attemptId: result.attemptId }),
    ...(result.mimeType === undefined ? {} : { mimeType: result.mimeType }),
    ...(result.summary === undefined ? {} : { summary: safeText(result.summary, 240) })
  };
}

function projectSubagent(
  taskId: string,
  step: TaskStepProjection,
  trace: readonly TaskTraceEventProjection[],
  traceSummary: TaskEventTraceSummary,
  results: readonly TaskResultProjection[]
): TaskSubagentProjection {
  if (step.executorRole === "synthesis") {
    throw new Error("A synthesis Step cannot be projected as a Subagent.");
  }
  const attempts = step.attempts.filter((attempt) =>
    attempt.taskId === taskId && attempt.stepId === step.stepId
  );
  const latestAttempt = step.latestAttempt;
  const currentAttempt = step.activeAttempt ?? latestAttempt;
  const subagentTrace = trace.filter((event) => event.stepId === step.stepId);
  const subagentTraceCounts = traceSummary.counts.filter((count) => count.stepId === step.stepId);
  const subagentTraceTotal = subagentTraceCounts.reduce((total, count) => total + count.count, 0);
  return {
    stepId: step.stepId,
    position: step.position,
    displayIndex: step.position + 1,
    displayLabel: `Subagent ${step.position + 1}`,
    title: step.title,
    objective: step.objective,
    role: step.executorRole,
    status: step.status,
    dependsOn: step.dependsOn,
    elapsedMs: currentAttempt?.elapsedMs ?? 0,
    ...(currentAttempt?.currentActivity === undefined
      ? {}
      : { currentActivity: currentAttempt.currentActivity }),
    ...(currentAttempt?.currentToolCategory === undefined
      ? {}
      : { currentToolCategory: currentAttempt.currentToolCategory }),
    ...(currentAttempt?.assistantPreview === undefined
      ? {}
      : { assistantPreview: currentAttempt.assistantPreview }),
    usage: {
      total: step.usage,
      ...(currentAttempt === undefined ? {} : { currentAttempt: currentAttempt.usage })
    },
    attempts,
    ...(latestAttempt === undefined ? {} : { latestAttempt }),
    ...(step.activeAttempt === undefined ? {} : { activeAttempt: step.activeAttempt }),
    trace: subagentTrace,
    traceSummary: {
      totalEvents: subagentTraceTotal,
      categoryCounts: traceCategoryCounts(subagentTraceCounts),
      hasEarlierEvents: subagentTraceTotal > subagentTrace.length
    },
    results: results.filter((result) => result.stepId === step.stepId)
  };
}

function traceCategoryCounts(
  counts: TaskEventTraceSummary["counts"]
): TaskTraceCategoryCounts {
  const result: Record<TaskTraceCategory, number> = {
    terminal: 0,
    search: 0,
    plan: 0,
    read: 0,
    edit: 0,
    answer: 0,
    wait: 0,
    finish: 0,
    failed: 0
  };
  for (const count of counts) result[count.category] += count.count;
  return result;
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
  if (activity !== undefined) return `${activity.assistantPreview ?? activity.label}${suffix}`;
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

function eventActivity(event: TaskEvent): {
  readonly label: string;
  readonly traceCategory: TaskTraceCategory;
  readonly toolCategory?: string;
  readonly assistantPreview?: string;
} | undefined {
  const activity = event.data.activity;
  if (activity === null || typeof activity !== "object" || Array.isArray(activity)) return undefined;
  const record = activity as Record<string, unknown>;
  if ((record.kind !== "worker" && record.kind !== "provider" && record.kind !== "tool" && record.kind !== "assistant") ||
      typeof record.label !== "string" || record.label.length === 0 || record.label.length > 160 ||
      /[\u0000-\u001F\u007F]/u.test(record.label)) return undefined;
  const traceCategory = taskTraceCategory(record.traceCategory);
  if (traceCategory === undefined) return undefined;
  const toolCategory = typeof record.toolCategory === "string" && /^[A-Za-z0-9._:-]{1,160}$/u.test(record.toolCategory)
    ? record.toolCategory
    : undefined;
  const assistantPreview = typeof record.assistantPreview === "string" && record.assistantPreview.length <= 160
    ? safeText(record.assistantPreview, 160)
    : undefined;
  if (record.kind === "assistant" && assistantPreview === undefined) return undefined;
  return {
    label: safeText(record.label, 160),
    traceCategory,
    ...(toolCategory === undefined ? {} : { toolCategory }),
    ...(assistantPreview === undefined ? {} : { assistantPreview })
  };
}

function taskTraceCategory(value: unknown): TaskTraceCategory | undefined {
  switch (value) {
    case "terminal":
    case "search":
    case "plan":
    case "read":
    case "edit":
    case "answer":
    case "wait":
    case "finish":
    case "failed":
      return value;
    default:
      return undefined;
  }
}

function taskTraceCategoryFromTaskEvent(event: TaskEvent): TaskTraceCategory {
  const activity = eventActivity(event);
  if (activity !== undefined) return activity.traceCategory;
  const status = typeof event.data.to === "string" ? event.data.to : undefined;
  if (status === "completed" || status === "succeeded") return "finish";
  if (status === "waiting_for_input" || status === "waiting_for_approval" || status === "blocked") return "wait";
  if (status === "failed" || status === "cancelled") return "failed";
  switch (event.kind) {
    case "attempt-waiting":
    case "approval-requested":
      return "wait";
    case "attempt-completed":
    case "result-recorded":
      return "finish";
    case "attempt-failed":
    case "attempt-cancelled":
    case "attempt-interrupted":
    case "attempt-expired":
    case "plan-revision-rejected":
      return "failed";
    default:
      return "plan";
  }
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
