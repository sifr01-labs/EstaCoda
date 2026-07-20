import { createHash, randomUUID } from "node:crypto";
import type {
  Task,
  TaskAttempt,
  TaskAttemptLease,
  TaskAttemptStatus,
  TaskEvent,
  TaskEventKind,
  TaskFailure,
  TaskStep,
  TaskUsageEntry,
  TaskUsageTotals
} from "../contracts/task.js";
import {
  TASK_GRAPH_LIMITS,
  isTerminalTaskAttemptStatus,
  isTerminalTaskStatus,
  isTerminalTaskStepStatus
} from "../contracts/task.js";
import {
  TaskResultContentError,
  type PreparedTaskResultBatch,
  type TaskResultService
} from "./task-result-service.js";
import type { TaskStore } from "./task-store.js";
import type { TaskApprovalService } from "./task-approval-service.js";
import { cancelTaskInStore } from "./task-operator-service.js";
import {
  listStepTreeAttempts,
  listTaskBudgetScopes,
  listTaskTreeAttempts
} from "./task-tree-accounting.js";
import type {
  ResolveTaskStepExecutor,
  TaskAttemptActivity,
  TaskAttemptCheckpoint,
  TaskExecutorSettlement,
  TaskStepExecutor
} from "./task-step-executor.js";

const DEFAULT_LEASE_MS = 30_000;
const MAX_RESULT_RECORDS_PER_SETTLEMENT = 64;
const ACTIVE_ATTEMPT_STATUSES: readonly TaskAttemptStatus[] = [
  "leased",
  "running",
  "waiting_for_input",
  "waiting_for_approval"
];
const LEASE_OWNED_ATTEMPT_STATUSES: readonly TaskAttemptStatus[] = ["leased", "running"];
const RECONCILABLE_TASK_STATUSES: readonly Task["status"][] = [
  "queued",
  "running",
  "waiting_for_host",
  "waiting_for_input",
  "waiting_for_approval",
  "paused",
  "completed",
  "partial",
  "failed",
  "cancelled"
];

export type TaskSchedulerLimits = {
  maxProfileConcurrentAttempts?: number;
  maxConcurrentByExecutor?: Readonly<Record<string, number>>;
  maxConcurrentByProvider?: Readonly<Record<string, number>>;
};

export type TaskSchedulerOptions = {
  store: TaskStore;
  resultService: TaskResultService;
  ownerId: string;
  resolveExecutor: ResolveTaskStepExecutor;
  leaseMs?: number;
  limits?: TaskSchedulerLimits;
  now?: () => Date;
  id?: () => string;
  eventId?: () => string;
  approvalService?: TaskApprovalService;
};

export type TaskSchedulerRunResult = {
  reconciled: number;
  dispatched: number;
  completed: number;
  failed: number;
  cancelled: number;
  leaseLost: number;
  warnings: readonly string[];
};

export type TaskRetryDecision = {
  retry: boolean;
  delayMs: number;
  reason: string;
};

export class TaskSchedulerLeaseLostError extends Error {
  constructor() {
    super("Task Attempt lease is no longer current.");
    this.name = "TaskSchedulerLeaseLostError";
  }
}

class TaskSchedulerCancellationError extends Error {
  constructor() {
    super("Task Attempt cancellation was requested.");
    this.name = "TaskSchedulerCancellationError";
  }
}

class TaskSchedulerResultPublicationError extends Error {
  constructor(options?: ErrorOptions) {
    super("Prepared Task results could not be published.", options);
    this.name = "TaskSchedulerResultPublicationError";
  }
}

type MutableRunResult = Omit<TaskSchedulerRunResult, "warnings"> & { warnings: string[] };

type CapacityState = {
  profile: number;
  task: Map<string, number>;
  tree: Map<string, number>;
  executor: Map<string, number>;
  provider: Map<string, number>;
};

type RunningExecution = {
  taskId: string;
  controller: AbortController;
};

export class TaskScheduler {
  readonly #store: TaskStore;
  readonly #resultService: TaskResultService;
  readonly #ownerId: string;
  readonly #resolveExecutor: ResolveTaskStepExecutor;
  readonly #leaseMs: number;
  readonly #limits: Required<Pick<TaskSchedulerLimits, "maxProfileConcurrentAttempts">> & TaskSchedulerLimits;
  readonly #now: () => Date;
  readonly #id: () => string;
  readonly #eventId: () => string;
  readonly #approvalService: TaskApprovalService | undefined;
  readonly #running = new Map<string, RunningExecution>();

  constructor(options: TaskSchedulerOptions) {
    this.#store = options.store;
    this.#resultService = options.resultService;
    this.#ownerId = requireToken(options.ownerId, "scheduler owner ID");
    this.#resolveExecutor = options.resolveExecutor;
    this.#leaseMs = positiveInteger(options.leaseMs ?? DEFAULT_LEASE_MS, "scheduler lease duration");
    this.#limits = {
      maxProfileConcurrentAttempts: positiveInteger(
        options.limits?.maxProfileConcurrentAttempts ?? TASK_GRAPH_LIMITS.maxConcurrentAttempts,
        "profile concurrency limit"
      ),
      maxConcurrentByExecutor: validateLimitMap(options.limits?.maxConcurrentByExecutor),
      maxConcurrentByProvider: validateLimitMap(options.limits?.maxConcurrentByProvider)
    };
    this.#now = options.now ?? (() => new Date());
    this.#id = options.id ?? randomUUID;
    this.#eventId = options.eventId ?? randomUUID;
    this.#approvalService = options.approvalService;
  }

  get ownerId(): string {
    return this.#ownerId;
  }

  async runOnce(): Promise<TaskSchedulerRunResult> {
    const result: MutableRunResult = emptyRunResult();
    await this.#approvalService?.reconcile();
    this.#reconcileApprovals(result);
    this.#reconcile(result);

    const tasks = this.#store.listTasks({
      statuses: ["queued", "running", "waiting_for_host"],
      limit: 1_000
    }).sort(compareTasks);
    const prepared: Task[] = [];
    for (const task of tasks) {
      const resumed = task.status === "waiting_for_host" ? this.#resumeForAvailableHost(task) : task;
      if (resumed.status !== "queued" && resumed.status !== "running") continue;
      const next = this.#prepareTask(resumed.id);
      if (next !== null && (next.status === "queued" || next.status === "running")) prepared.push(next);
    }

    const capacity = this.#capacityState();
    const launches: Promise<void>[] = [];
    const touchedTaskIds = new Set<string>();

    for (const task of prepared) {
      touchedTaskIds.add(task.id);
      const revisionId = task.activePlanRevisionId;
      if (revisionId === undefined) continue;
      const steps = this.#store.listSteps(task.id, revisionId);
      let missingExecutor = false;
      let hasEligibleExecutor = false;
      for (const step of steps) {
        if (step.status !== "ready") continue;
        const executor = this.#resolveExecutor(task, step);
        if (executor === undefined || executor.kind !== step.executor.kind) {
          missingExecutor = true;
          continue;
        }
        hasEligibleExecutor = true;
        if (!this.#retryDelayElapsed(step)) continue;
        if (!this.#hasCapacity(task, step, capacity)) continue;
        const budgetReason = this.#budgetBlockReason(task, step);
        if (budgetReason !== undefined) {
          if ((capacity.task.get(task.id) ?? 0) === 0) {
            this.#pauseForBudget(task.id, budgetReason);
            result.warnings.push(`Task ${task.id} paused because ${budgetReason}.`);
          }
          break;
        }

        const attempt = this.#claimAttempt(task, step);
        if (attempt === null || attempt.status !== "queued") continue;
        const started = this.#leaseAndStart(task.id, step.id, attempt.id);
        if (started === null) continue;

        result.dispatched++;
        touchedTaskIds.add(task.id);
        incrementCapacity(capacity, task, step);
        launches.push(this.#execute(task, step, started, executor, result));
      }
      if (missingExecutor && !hasEligibleExecutor && (capacity.task.get(task.id) ?? 0) === 0) {
        this.#waitForEligibleHost(task.id);
        result.warnings.push(`Task ${task.id} is waiting for an eligible Step executor.`);
      }
    }

    await Promise.all(launches);
    for (const taskId of touchedTaskIds) this.#finalizeTaskIfSettled(taskId);
    return result;
  }

  cancelTask(taskId: string, reasonCode = "operator-request"): Task {
    const now = this.#now().toISOString();
    const cancelled = cancelTaskInStore({
      store: this.#store,
      taskId,
      reasonCode,
      timestamp: now,
      eventId: this.#eventId
    });

    for (const execution of this.#running.values()) {
      if (execution.taskId === taskId) execution.controller.abort();
    }
    return cancelled;
  }

  heartbeat(attemptId: string, fencingToken: number): TaskAttemptLease {
    const now = this.#now();
    const renewed = this.#store.renewAttemptLease({
      attemptId,
      ownerId: this.#ownerId,
      fencingToken,
      heartbeatAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.#leaseMs).toISOString()
    });
    if (renewed === null) throw new TaskSchedulerLeaseLostError();
    if (renewed.cancellationRequestedAt !== undefined) {
      this.#running.get(attemptId)?.controller.abort();
      throw new TaskSchedulerCancellationError();
    }
    return renewed;
  }

  checkpoint(attemptId: string, fencingToken: number, checkpoint: TaskAttemptCheckpoint): TaskAttemptLease {
    const workerSessionId = checkpoint.workerSessionId === undefined
      ? undefined
      : requireToken(checkpoint.workerSessionId, "worker session ID");
    const trajectoryId = checkpoint.trajectoryId === undefined
      ? undefined
      : requireToken(checkpoint.trajectoryId, "trajectory ID");
    const activity = checkpoint.activity === undefined ? undefined : normalizeCheckpointActivity(checkpoint.activity);
    if (workerSessionId === undefined && trajectoryId === undefined && activity === undefined) {
      throw new Error("Task Attempt checkpoint must contain worker progress.");
    }

    const now = this.#now();
    const timestamp = now.toISOString();
    const renewed = this.#store.atomicWrite((store) => {
      const attempt = store.getAttempt(attemptId);
      if (attempt === null || attempt.lease === undefined ||
          attempt.lease.ownerId !== this.#ownerId || attempt.lease.fencingToken !== fencingToken) {
        throw new TaskSchedulerLeaseLostError();
      }
      const context = this.#assertCurrentLease(store, attempt.taskId, attemptId, attempt.lease, false);
      if (workerSessionId !== undefined && context.attempt.workerSessionId !== undefined &&
          context.attempt.workerSessionId !== workerSessionId) {
        throw new Error("Task Attempt worker session cannot be replaced after it is linked.");
      }
      if (trajectoryId !== undefined && context.attempt.trajectoryId !== undefined &&
          context.attempt.trajectoryId !== trajectoryId) {
        throw new Error("Task Attempt trajectory cannot be replaced after it is linked.");
      }

      const next: TaskAttempt = {
        ...context.attempt,
        ...(workerSessionId === undefined ? {} : { workerSessionId }),
        ...(trajectoryId === undefined ? {} : { trajectoryId }),
        updatedAt: timestamp
      };
      store.updateAttempt(next);
      if (workerSessionId !== undefined && !store.listSessionLinks(context.task.id).some((link) =>
        link.relationship === "worker" && link.sessionId === workerSessionId && link.attemptId === attemptId
      )) {
        store.linkSession({
          taskId: context.task.id,
          profileId: this.#store.profileId,
          sessionId: workerSessionId,
          relationship: "worker",
          stepId: context.attempt.stepId,
          attemptId,
          createdAt: timestamp
        });
      }
      const lease = store.renewAttemptLease({
        attemptId,
        ownerId: this.#ownerId,
        fencingToken,
        heartbeatAt: timestamp,
        expiresAt: new Date(now.getTime() + this.#leaseMs).toISOString()
      });
      if (lease === null || lease.cancellationRequestedAt !== undefined) {
        throw new TaskSchedulerLeaseLostError();
      }
      store.appendEvent(this.#event(context.task, "attempt-progressed", timestamp, {
        attemptId,
        stepId: context.attempt.stepId,
        planRevisionId: context.attempt.planRevisionId,
        data: {
          ...(workerSessionId === undefined ? {} : { workerSessionId }),
          ...(trajectoryId === undefined ? {} : { trajectoryId }),
          ...(activity === undefined ? {} : { activity })
        }
      }));
      return lease;
    });
    return renewed;
  }

  #reconcileApprovals(result: MutableRunResult): void {
    const links = this.#store.listApprovalLinks({ statuses: ["approved", "denied", "expired"], limit: 1_000 });
    for (const link of links) {
      const task = this.#store.getTask(link.taskId);
      const step = this.#store.getStep(link.stepId);
      const attempt = this.#store.getAttempt(link.attemptId);
      if (task?.status !== "waiting_for_approval" || step?.status !== "waiting_for_approval" ||
          attempt?.status !== "waiting_for_approval") continue;
      const now = this.#now().toISOString();
      this.#store.atomicWrite((store) => {
        const currentTask = store.getTask(link.taskId);
        const currentStep = store.getStep(link.stepId);
        const currentAttempt = store.getAttempt(link.attemptId);
        if (currentTask?.status !== "waiting_for_approval" || currentStep?.status !== "waiting_for_approval" ||
            currentAttempt?.status !== "waiting_for_approval") return;
        if (link.status === "approved") {
          store.updateAttempt({
            ...currentAttempt,
            status: "queued",
            workerSessionId: undefined,
            trajectoryId: undefined,
            updatedAt: now
          });
          store.updateStep({ ...currentStep, status: "ready", updatedAt: now });
          store.updateTask({ ...currentTask, status: "queued", waitReason: undefined, updatedAt: now });
          store.appendEvent(this.#event(currentTask, "approval-resolved", now, {
            attemptId: currentAttempt.id,
            stepId: currentStep.id,
            planRevisionId: currentStep.planRevisionId,
            data: { approvalId: link.id, resolution: "approved" }
          }));
          store.appendEvent(this.#event(currentTask, "task-state-changed", now, {
            data: { from: "waiting_for_approval", to: "queued", reasonCode: "approval-granted" }
          }));
          return;
        }
        const failureRecord = failure(
          link.status === "denied" ? "approval-denied" : "approval-expired",
          link.status === "denied" ? "The requested Task operation was denied." : "The requested Task approval expired.",
          false,
          false
        );
        store.updateAttempt({ ...currentAttempt, status: "failed", failure: failureRecord, updatedAt: now, completedAt: now });
        store.updateStep({ ...currentStep, status: "failed", updatedAt: now });
        store.updateTask({
          ...currentTask,
          status: "failed",
          waitReason: undefined,
          failure: failureRecord,
          updatedAt: now,
          completedAt: now
        });
        store.appendEvent(this.#event(currentTask, "approval-resolved", now, {
          attemptId: currentAttempt.id,
          stepId: currentStep.id,
          planRevisionId: currentStep.planRevisionId,
          data: { approvalId: link.id, resolution: link.status }
        }));
        store.appendEvent(this.#event(currentTask, "attempt-failed", now, {
          attemptId: currentAttempt.id,
          stepId: currentStep.id,
          planRevisionId: currentStep.planRevisionId,
          data: { failureClass: failureRecord.class, retryable: false, uncertainSideEffects: false }
        }));
        store.appendEvent(this.#event(currentTask, "step-state-changed", now, {
          stepId: currentStep.id,
          planRevisionId: currentStep.planRevisionId,
          data: { from: "waiting_for_approval", to: "failed", reasonCode: failureRecord.class }
        }));
        store.appendEvent(this.#event(currentTask, "task-state-changed", now, {
          data: { from: "waiting_for_approval", to: "failed", reasonCode: failureRecord.class }
        }));
      });
      result.reconciled++;
      if (link.status !== "approved") result.failed++;
    }
  }

  #reconcile(result: MutableRunResult): void {
    const now = this.#now();
    const tasks = this.#store.listTasks({ statuses: RECONCILABLE_TASK_STATUSES, limit: 1_000 });
    for (const task of tasks) {
      for (const attempt of this.#store.listAttempts(task.id)) {
        if (!ACTIVE_ATTEMPT_STATUSES.includes(attempt.status)) continue;
        const lease = attempt.lease;
        if (!LEASE_OWNED_ATTEMPT_STATUSES.includes(attempt.status) && lease === undefined && !isTerminalTaskStatus(task.status)) {
          continue;
        }
        const leaseExpired = lease !== undefined && Date.parse(lease.expiresAt) <= now.getTime();
        if (lease !== undefined && !leaseExpired) continue;

        const recovered = this.#recoverAbandonedAttempt(task.id, attempt.id, now);
        if (!recovered) continue;
        result.reconciled++;
        if (isTerminalTaskStatus(task.status)) result.cancelled++;
        else result.failed++;
        result.warnings.push(
          `Attempt ${attempt.id} was reconciled after ${lease === undefined ? "a missing lease" : "lease expiry"}.`
        );
      }
      this.#finalizeTaskIfSettled(task.id);
    }
  }

  #recoverAbandonedAttempt(taskId: string, attemptId: string, now: Date): boolean {
    let abortTask = false;
    const recovered = this.#store.atomicWrite((store) => {
      const task = store.getTask(taskId);
      const attempt = store.getAttempt(attemptId);
      if (task === null || attempt === null || !ACTIVE_ATTEMPT_STATUSES.includes(attempt.status)) return false;
      const lease = attempt.lease;
      if (lease !== undefined && Date.parse(lease.expiresAt) > now.getTime()) return false;

      const timestamp = now.toISOString();
      if (isTerminalTaskStatus(task.status)) {
        store.updateAttempt({ ...attempt, status: "cancelled", updatedAt: timestamp, completedAt: timestamp });
        if (lease !== undefined) store.releaseAttemptLease(fenceInput(lease));
        const step = store.getStep(attempt.stepId);
        if (step !== null && !isTerminalTaskStepStatus(step.status)) {
          store.updateStep({ ...step, status: "cancelled", updatedAt: timestamp });
          store.appendEvent(this.#event(task, "step-state-changed", timestamp, {
            stepId: step.id,
            planRevisionId: step.planRevisionId,
            data: { from: step.status, to: "cancelled", reasonCode: "terminal-task-reconciliation" }
          }));
        }
        store.appendEvent(this.#event(task, "attempt-cancelled", timestamp, {
          attemptId: attempt.id,
          stepId: attempt.stepId,
          planRevisionId: attempt.planRevisionId,
          data: { reasonCode: "terminal-task-reconciliation" }
        }));
        return true;
      }

      if (!LEASE_OWNED_ATTEMPT_STATUSES.includes(attempt.status) && lease === undefined) return false;
      const status: TaskAttemptStatus = lease === undefined ? "interrupted" : "expired";
      const failure: TaskFailure = {
        class: lease === undefined ? "lease-missing" : "lease-expired",
        message: lease === undefined
          ? "Attempt lost its durable scheduler lease."
          : "Attempt scheduler lease expired before settlement.",
        retryable: true,
        uncertainSideEffects: attempt.status !== "leased"
      };
      const terminal: TaskAttempt = {
        ...attempt,
        status,
        failure,
        updatedAt: timestamp,
        completedAt: timestamp
      };
      store.updateAttempt(terminal);
      if (lease !== undefined) store.releaseAttemptLease(fenceInput(lease));
      store.appendEvent(this.#event(task, status === "expired" ? "attempt-expired" : "attempt-interrupted", timestamp, {
        attemptId: attempt.id,
        stepId: attempt.stepId,
        planRevisionId: attempt.planRevisionId,
        data: { failureClass: failure.class, uncertainSideEffects: failure.uncertainSideEffects }
      }));
      abortTask = this.#applyFailurePolicy(store, task, terminal, timestamp);
      return true;
    });
    if (abortTask) this.#abortTaskExecutions(taskId, attemptId);
    return recovered;
  }

  #resumeForAvailableHost(task: Task): Task {
    const revisionId = task.activePlanRevisionId;
    if (revisionId === undefined) return task;
    const hasAvailable = this.#store.listSteps(task.id, revisionId)
      .some((step) => step.status === "ready" && this.#resolveExecutor(task, step)?.kind === step.executor.kind);
    if (!hasAvailable) return task;
    const now = this.#now().toISOString();
    return this.#store.atomicWrite((store) => {
      const current = store.getTask(task.id);
      if (current === null || current.status !== "waiting_for_host") return current ?? task;
      const next: Task = { ...current, status: "queued", updatedAt: now, waitReason: undefined };
      store.updateTask(next);
      store.appendEvent(this.#event(current, "task-state-changed", now, {
        data: { from: "waiting_for_host", to: "queued", reasonCode: "executor-available" }
      }));
      return next;
    });
  }

  #prepareTask(taskId: string): Task | null {
    const now = this.#now().toISOString();
    return this.#store.atomicWrite((store) => {
      let task = store.getTask(taskId);
      if (task === null || (task.status !== "queued" && task.status !== "running")) return task;
      if (task.status === "queued") {
        const next: Task = { ...task, status: "running", updatedAt: now, startedAt: task.startedAt ?? now };
        store.updateTask(next);
        store.appendEvent(this.#event(task, "task-state-changed", now, {
          data: { from: "queued", to: "running", reasonCode: "scheduler-start" }
        }));
        task = next;
      }
      const revisionId = task.activePlanRevisionId;
      if (revisionId === undefined) return task;

      let changed = true;
      while (changed) {
        changed = false;
        const steps = store.listSteps(task.id, revisionId);
        const byId = new Map(steps.map((step) => [step.id, step]));
        for (const step of steps) {
          if (step.status !== "pending") continue;
          const dependencies = step.dependsOn.map((id) => byId.get(id)).filter((value): value is TaskStep => value !== undefined);
          const allCompleted = dependencies.every((dependency) => dependency.status === "completed");
          const blocked = dependencies.some((dependency) => isTerminalTaskStepStatus(dependency.status) && dependency.status !== "completed");
          const status = allCompleted ? "ready" : blocked ? "skipped" : undefined;
          if (status === undefined) continue;
          store.updateStep({ ...step, status, updatedAt: now });
          store.appendEvent(this.#event(task, "step-state-changed", now, {
            stepId: step.id,
            planRevisionId: step.planRevisionId,
            data: { from: "pending", to: status, reasonCode: blocked ? "dependency-not-completed" : "dependencies-completed" }
          }));
          changed = true;
        }
      }
      return store.getTask(task.id);
    });
  }

  #waitForEligibleHost(taskId: string): void {
    const now = this.#now().toISOString();
    this.#store.atomicWrite((store) => {
      const task = store.getTask(taskId);
      if (task === null || task.status !== "running") return;
      const next: Task = {
        ...task,
        status: "waiting_for_host",
        updatedAt: now,
        waitReason: { kind: "eligible_host", summary: "No eligible Step executor is available.", requestedAt: now }
      };
      store.updateTask(next);
      store.appendEvent(this.#event(task, "task-state-changed", now, {
        data: { from: "running", to: "waiting_for_host", reasonCode: "executor-unavailable" }
      }));
    });
  }

  #pauseForBudget(taskId: string, reasonCode: string): void {
    const now = this.#now().toISOString();
    this.#store.atomicWrite((store) => {
      const task = store.getTask(taskId);
      if (task === null || task.status !== "running") return;
      const next: Task = {
        ...task,
        status: "paused",
        updatedAt: now,
        waitReason: { kind: "budget", summary: `Scheduler budget boundary: ${reasonCode}.`, requestedAt: now }
      };
      store.updateTask(next);
      store.appendEvent(this.#event(task, "task-state-changed", now, {
        data: { from: "running", to: "paused", reasonCode }
      }));
    });
  }

  #claimAttempt(task: Task, step: TaskStep): TaskAttempt | null {
    const now = this.#now().toISOString();
    return this.#store.atomicWrite((store) => {
      const currentTask = store.getTask(task.id);
      const currentStep = store.getStep(step.id);
      if (currentTask?.status !== "running" || currentStep?.status !== "ready") return null;
      const attempts = store.listAttempts(task.id, step.id);
      const active = attempts.find((attempt) => !isTerminalTaskAttemptStatus(attempt.status));
      if (active !== undefined) return active;
      const attemptNumber = attempts.reduce((maximum, attempt) => Math.max(maximum, attempt.attemptNumber), 0) + 1;
      if (attemptNumber > step.retryPolicy.maxAttempts) return null;
      const attempt: TaskAttempt = {
        id: this.#id(),
        profileId: this.#store.profileId,
        taskId: task.id,
        planRevisionId: step.planRevisionId,
        stepId: step.id,
        attemptNumber,
        status: "queued",
        dispatchKey: taskDispatchKey(task.id, step.planRevisionId, step.id, attemptNumber),
        usage: emptyUsage(),
        resultIds: [],
        createdAt: now,
        updatedAt: now
      };
      store.createAttempt(attempt);
      store.appendEvent(this.#event(task, "attempt-created", now, {
        attemptId: attempt.id,
        stepId: step.id,
        planRevisionId: step.planRevisionId,
        data: { attemptNumber, dispatchKey: attempt.dispatchKey }
      }));
      return attempt;
    });
  }

  #leaseAndStart(taskId: string, stepId: string, attemptId: string): TaskAttempt | null {
    const now = this.#now();
    const timestamp = now.toISOString();
    return this.#store.atomicWrite((store) => {
      const task = store.getTask(taskId);
      const step = store.getStep(stepId);
      const attempt = store.getAttempt(attemptId);
      if (task?.status !== "running" || step?.status !== "ready" || attempt?.status !== "queued") return null;
      if (!this.#hasDurableCapacity(store, task, step) ||
          this.#budgetBlockReason(task, step, store, attempt.id) !== undefined) {
        return null;
      }
      const lease = store.acquireAttemptLease({
        attemptId,
        ownerId: this.#ownerId,
        acquiredAt: timestamp,
        expiresAt: new Date(now.getTime() + this.#leaseMs).toISOString()
      });
      if (lease === null) return null;
      store.appendEvent(this.#event(task, "attempt-leased", timestamp, {
        attemptId,
        stepId,
        planRevisionId: step.planRevisionId,
        data: { ownerId: this.#ownerId, fencingToken: lease.fencingToken, expiresAt: lease.expiresAt }
      }));

      const leased = store.getAttempt(attemptId);
      if (leased === null || leased.status !== "leased") return null;
      const runningAttempt: TaskAttempt = { ...leased, status: "running", updatedAt: timestamp, startedAt: timestamp };
      store.updateAttempt(runningAttempt);
      store.updateStep({ ...step, status: "running", updatedAt: timestamp });
      store.appendEvent(this.#event(task, "attempt-started", timestamp, {
        attemptId,
        stepId,
        planRevisionId: step.planRevisionId,
        data: { fencingToken: lease.fencingToken }
      }));
      store.appendEvent(this.#event(task, "step-state-changed", timestamp, {
        stepId,
        planRevisionId: step.planRevisionId,
        data: { from: "ready", to: "running", reasonCode: "attempt-started" }
      }));
      return runningAttempt;
    });
  }

  async #execute(
    task: Task,
    step: TaskStep,
    attempt: TaskAttempt,
    executor: TaskStepExecutor,
    result: MutableRunResult
  ): Promise<void> {
    const lease = attempt.lease;
    if (lease === undefined) {
      result.leaseLost++;
      return;
    }
    const controller = new AbortController();
    this.#running.set(attempt.id, { taskId: task.id, controller });
    try {
      let settlement: TaskExecutorSettlement;
      try {
        settlement = await executor.execute({
          task,
          step,
          attempt,
          signal: controller.signal,
          heartbeat: () => this.heartbeat(attempt.id, lease.fencingToken),
          checkpoint: (checkpoint) => this.checkpoint(attempt.id, lease.fencingToken, checkpoint)
        });
      } catch (error) {
        if (error instanceof TaskSchedulerLeaseLostError) throw error;
        if (error instanceof TaskSchedulerCancellationError || controller.signal.aborted) {
          settlement = { outcome: "cancelled" };
        } else {
          settlement = {
            outcome: "failed",
            failure: {
              class: "executor-error",
              message: "Executor failed before returning a settlement.",
              retryable: true,
              uncertainSideEffects: true
            }
          };
        }
      }

      const outcome = await this.#settle(task.id, step.id, attempt.id, lease, settlement);
      if (outcome === "completed") result.completed++;
      else if (outcome === "cancelled") result.cancelled++;
      else if (outcome === "failed") result.failed++;
    } catch (error) {
      if (error instanceof TaskSchedulerCancellationError) {
        this.#settleCancelled(task.id, step.id, attempt.id, lease);
        result.cancelled++;
      } else if (error instanceof TaskSchedulerLeaseLostError) {
        const current = this.#store.getAttempt(attempt.id)?.lease;
        if (current?.cancellationRequestedAt !== undefined) {
          try {
            this.#settleCancelled(task.id, step.id, attempt.id, lease);
            result.cancelled++;
            return;
          } catch (settlementError) {
            if (!(settlementError instanceof TaskSchedulerLeaseLostError)) throw settlementError;
          }
        }
        result.leaseLost++;
        result.warnings.push(`Attempt ${attempt.id} lost its settlement lease.`);
      } else {
        try {
          this.#settleFailure(
            task.id,
            attempt.id,
            lease,
            failure("invalid-settlement", "Executor settlement could not be accepted.", false, false),
            emptyUsage()
          );
          result.failed++;
          result.warnings.push(`Attempt ${attempt.id} returned an invalid settlement.`);
        } catch (settlementError) {
          if (settlementError instanceof TaskSchedulerLeaseLostError) {
            result.leaseLost++;
            result.warnings.push(`Attempt ${attempt.id} lost its settlement lease.`);
          } else {
            throw settlementError;
          }
        }
      }
    } finally {
      this.#running.delete(attempt.id);
    }
  }

  async #settle(
    taskId: string,
    stepId: string,
    attemptId: string,
    lease: TaskAttemptLease,
    settlement: TaskExecutorSettlement
  ): Promise<"completed" | "failed" | "cancelled" | "waiting"> {
    if (settlement.outcome !== "succeeded" && settlement.outcome !== "failed" &&
        settlement.outcome !== "cancelled" && settlement.outcome !== "waiting_for_approval") {
      this.#settleFailure(
        taskId,
        attemptId,
        lease,
        failure("invalid-settlement", "Executor returned an unknown settlement outcome.", false, false),
        emptyUsage()
      );
      return "failed";
    }
    const task = this.#store.getTask(taskId);
    const currentLease = this.#store.getAttempt(attemptId)?.lease;
    if ((task !== null && task !== undefined && isTerminalTaskStatus(task.status)) ||
        currentLease?.cancellationRequestedAt !== undefined || settlement.outcome === "cancelled") {
      this.#settleCancelled(taskId, stepId, attemptId, lease);
      return "cancelled";
    }
    if (settlement.outcome === "waiting_for_approval") {
      if (this.#approvalService === undefined) {
        this.#settleFailure(
          taskId,
          attemptId,
          lease,
          failure("approval-service-unavailable", "Durable approval service is unavailable.", false, false),
          normalizeUsage(settlement.usage)
        );
        return "failed";
      }
      this.#settleWaitingForApproval(taskId, stepId, attemptId, lease, settlement);
      return "waiting";
    }
    let usage: TaskUsageTotals;
    try {
      usage = normalizeUsage(settlement.usage);
    } catch {
      this.#settleFailure(
        taskId,
        attemptId,
        lease,
        failure("invalid-usage", "Executor returned invalid usage totals.", false, false),
        emptyUsage()
      );
      return "failed";
    }
    if (settlement.outcome === "failed") {
      let normalizedFailure: TaskFailure;
      try {
        normalizedFailure = normalizeFailure(settlement.failure);
      } catch {
        normalizedFailure = failure("invalid-failure", "Executor returned an invalid failure record.", false, false);
      }
      this.#settleFailure(taskId, attemptId, lease, normalizedFailure, usage, settlement.usageEntries);
      return "failed";
    }
    const step = this.#store.getStep(stepId);
    if (step === null) throw new TaskSchedulerLeaseLostError();
    const results = [...(settlement.results ?? [])];
    let acceptanceFailure = validateResultAcceptance(step, results);
    if (acceptanceFailure === undefined && !this.#usageWithinBudget(taskId, step, usage)) {
      acceptanceFailure = failure("budget-exceeded", "Attempt usage exceeded its Task or Step budget.", false, false);
    }

    let preparedResults: PreparedTaskResultBatch | undefined;
    if (acceptanceFailure === undefined) {
      try {
        preparedResults = this.#resultService.prepare(results.map((result) => ({
            taskId,
            stepId,
            attemptId,
            kind: result.kind,
            content: result.content,
            mimeType: result.mimeType,
            summary: result.summary,
            expiresAt: result.expiresAt,
            expectedLease: { ownerId: lease.ownerId, fencingToken: lease.fencingToken }
          })));
      } catch (error) {
        if (error instanceof TaskResultContentError && error.code === "result-fence-lost") {
          throw new TaskSchedulerLeaseLostError();
        }
        acceptanceFailure = failure(
          "result-persistence-failed",
          "Attempt results could not be durably persisted.",
          true,
          false
        );
      }
    }
    if (acceptanceFailure !== undefined) {
      this.#settleFailure(taskId, attemptId, lease, acceptanceFailure, usage, settlement.usageEntries);
      return "failed";
    }
    if (preparedResults === undefined) throw new Error("Task result preparation did not complete.");

    const now = this.#now().toISOString();
    try {
      this.#store.atomicWrite((store) => {
        const context = this.#assertCurrentLease(store, taskId, attemptId, lease, false);
        const currentStep = store.getStep(stepId);
        if (currentStep === null || currentStep.status !== "running") throw new TaskSchedulerLeaseLostError();
        if (settlement.workerSessionId !== undefined && context.attempt.workerSessionId !== undefined &&
            settlement.workerSessionId !== context.attempt.workerSessionId) {
          throw new Error("Task Attempt settlement cannot replace its checkpointed worker session.");
        }
        if (settlement.trajectoryId !== undefined && context.attempt.trajectoryId !== undefined &&
            settlement.trajectoryId !== context.attempt.trajectoryId) {
          throw new Error("Task Attempt settlement cannot replace its checkpointed trajectory.");
        }
        let publishedResultCount = 0;
        try {
          publishedResultCount = this.#resultService.publishPrepared(preparedResults, store).length;
        } catch (error) {
          if (error instanceof TaskResultContentError && error.code === "result-fence-lost") {
            throw new TaskSchedulerLeaseLostError();
          }
          throw new TaskSchedulerResultPublicationError({ cause: error });
        }
        const finalUsage = this.#recordUsageEntries(store, context.attempt, settlement.usageEntries, usage);
        const completed: TaskAttempt = {
          ...context.attempt,
          status: "completed",
          usage: finalUsage,
          workerSessionId: settlement.workerSessionId ?? context.attempt.workerSessionId,
          trajectoryId: settlement.trajectoryId ?? context.attempt.trajectoryId,
          updatedAt: now,
          completedAt: now
        };
        store.updateAttempt(completed);
        store.updateStep({ ...currentStep, status: "completed", updatedAt: now });
        const steps = store.listSteps(context.task.id, currentStep.planRevisionId);
        const allSettled = steps.length > 0 && steps.every((candidate) => isTerminalTaskStepStatus(candidate.status));
        if (allSettled) {
          const status: Task["status"] = steps.every((candidate) => candidate.status === "completed")
            ? "completed"
            : "partial";
          store.updateTask({ ...context.task, status, updatedAt: now, completedAt: now });
          store.appendEvent(this.#event(context.task, "task-state-changed", now, {
            data: { from: context.task.status, to: status, reasonCode: "all-steps-settled" }
          }));
        } else {
          store.updateTask({ ...context.task, updatedAt: now });
        }
        if (!store.releaseAttemptLease(fenceInput(lease))) throw new TaskSchedulerLeaseLostError();
        store.appendEvent(this.#event(context.task, "usage-recorded", now, {
          attemptId,
          stepId,
          planRevisionId: completed.planRevisionId,
          data: usageEventData(finalUsage)
        }));
        store.appendEvent(this.#event(context.task, "attempt-completed", now, {
          attemptId,
          stepId,
          planRevisionId: completed.planRevisionId,
          data: { resultCount: publishedResultCount }
        }));
        store.appendEvent(this.#event(context.task, "step-state-changed", now, {
          stepId,
          planRevisionId: completed.planRevisionId,
          data: { from: "running", to: "completed", reasonCode: "acceptance-passed" }
        }));
      });
      this.#resultService.finalizePrepared(preparedResults);
    } catch (error) {
      this.#resultService.discardPrepared(preparedResults);
      if (error instanceof TaskSchedulerResultPublicationError) {
        this.#settleFailure(
          taskId,
          attemptId,
          lease,
          failure("result-persistence-failed", "Attempt results could not be durably persisted.", true, false),
          usage,
          settlement.usageEntries
        );
        return "failed";
      }
      throw error;
    }
    return "completed";
  }

  #settleWaitingForApproval(
    taskId: string,
    stepId: string,
    attemptId: string,
    lease: TaskAttemptLease,
    settlement: Extract<TaskExecutorSettlement, { outcome: "waiting_for_approval" }>
  ): void {
    const service = this.#approvalService;
    if (service === undefined) throw new Error("Durable approval service is unavailable.");
    const usage = normalizeUsage(settlement.usage);
    const now = this.#now().toISOString();
    this.#store.atomicWrite((store) => {
      const context = this.#assertCurrentLease(store, taskId, attemptId, lease, false);
      const step = store.getStep(stepId);
      if (step === null || step.status !== "running") throw new TaskSchedulerLeaseLostError();
      const finalUsage = this.#recordUsageEntries(store, context.attempt, settlement.usageEntries, usage);
      const link = service.createLink({ task: context.task, step, attempt: context.attempt, request: settlement.approval });
      store.createApprovalLink(link);
      store.updateAttempt({
        ...context.attempt,
        status: "waiting_for_approval",
        usage: finalUsage,
        workerSessionId: settlement.workerSessionId ?? context.attempt.workerSessionId,
        trajectoryId: settlement.trajectoryId ?? context.attempt.trajectoryId,
        updatedAt: now
      });
      store.updateStep({ ...step, status: "waiting_for_approval", updatedAt: now });
      store.updateTask({
        ...context.task,
        status: "waiting_for_approval",
        updatedAt: now,
        waitReason: {
          kind: "approval",
          summary: `Approval required for ${link.toolName}.`,
          requestedAt: now,
          approvalId: link.id
        }
      });
      if (!store.releaseAttemptLease(fenceInput(lease))) throw new TaskSchedulerLeaseLostError();
      store.appendEvent(this.#event(context.task, "usage-recorded", now, {
        attemptId,
        stepId,
        planRevisionId: step.planRevisionId,
        data: usageEventData(finalUsage)
      }));
      store.appendEvent(this.#event(context.task, "approval-requested", now, {
        attemptId,
        stepId,
        planRevisionId: step.planRevisionId,
        data: { approvalId: link.id, toolName: link.toolName, riskClass: link.riskClass }
      }));
      store.appendEvent(this.#event(context.task, "attempt-waiting", now, {
        attemptId,
        stepId,
        planRevisionId: step.planRevisionId,
        data: { reasonCode: "approval-required", approvalId: link.id }
      }));
      store.appendEvent(this.#event(context.task, "step-state-changed", now, {
        stepId,
        planRevisionId: step.planRevisionId,
        data: { from: "running", to: "waiting_for_approval", reasonCode: "approval-required" }
      }));
      store.appendEvent(this.#event(context.task, "task-state-changed", now, {
        data: { from: "running", to: "waiting_for_approval", reasonCode: "approval-required" }
      }));
    });
  }

  #settleCancelled(taskId: string, stepId: string, attemptId: string, lease: TaskAttemptLease): void {
    const now = this.#now().toISOString();
    this.#store.atomicWrite((store) => {
      const context = this.#assertCurrentLease(store, taskId, attemptId, lease, true);
      const cancelled: TaskAttempt = {
        ...context.attempt,
        status: "cancelled",
        updatedAt: now,
        completedAt: now
      };
      store.updateAttempt(cancelled);
      const step = store.getStep(stepId);
      if (step !== null && !isTerminalTaskStepStatus(step.status)) {
        store.updateStep({ ...step, status: "cancelled", updatedAt: now });
        store.appendEvent(this.#event(context.task, "step-state-changed", now, {
          stepId: step.id,
          planRevisionId: step.planRevisionId,
          data: { from: step.status, to: "cancelled", reasonCode: "cancellation-requested" }
        }));
      }
      if (!store.releaseAttemptLease(fenceInput(lease))) throw new TaskSchedulerLeaseLostError();
      store.appendEvent(this.#event(context.task, "attempt-cancelled", now, {
        attemptId,
        stepId,
        planRevisionId: cancelled.planRevisionId,
        data: { reasonCode: "cancellation-requested" }
      }));
    });
  }

  #settleFailure(
    taskId: string,
    attemptId: string,
    lease: TaskAttemptLease,
    failureRecord: TaskFailure,
    usage: TaskUsageTotals,
    usageEntries?: readonly TaskUsageEntry[]
  ): void {
    const now = this.#now().toISOString();
    let abortTask = false;
    this.#store.atomicWrite((store) => {
      const context = this.#assertCurrentLease(store, taskId, attemptId, lease, false);
      const finalUsage = this.#recordUsageEntries(store, context.attempt, usageEntries, usage);
      const failedAttempt: TaskAttempt = {
        ...context.attempt,
        status: "failed",
        failure: failureRecord,
        usage: finalUsage,
        updatedAt: now,
        completedAt: now
      };
      store.updateAttempt(failedAttempt);
      if (!store.releaseAttemptLease(fenceInput(lease))) throw new TaskSchedulerLeaseLostError();
      store.appendEvent(this.#event(context.task, "usage-recorded", now, {
        attemptId,
        stepId: failedAttempt.stepId,
        planRevisionId: failedAttempt.planRevisionId,
        data: usageEventData(finalUsage)
      }));
      store.appendEvent(this.#event(context.task, "attempt-failed", now, {
        attemptId,
        stepId: failedAttempt.stepId,
        planRevisionId: failedAttempt.planRevisionId,
        data: {
          failureClass: failureRecord.class,
          retryable: failureRecord.retryable,
          uncertainSideEffects: failureRecord.uncertainSideEffects
        }
      }));
      abortTask = this.#applyFailurePolicy(store, context.task, failedAttempt, now);
    });
    if (abortTask) this.#abortTaskExecutions(taskId, attemptId);
  }

  #recordUsageEntries(
    store: TaskStore,
    attempt: TaskAttempt,
    entries: readonly TaskUsageEntry[] | undefined,
    fallback: TaskUsageTotals
  ): TaskUsageTotals {
    for (const entry of entries ?? []) {
      if (entry.attemptId !== attempt.id || entry.taskId !== attempt.taskId ||
          entry.stepId !== attempt.stepId || entry.planRevisionId !== attempt.planRevisionId) {
        throw new Error("Task usage entry does not belong to the settling Attempt.");
      }
      store.recordUsageEntry(entry);
    }
    const persisted = store.listUsageEntries(attempt.taskId, attempt.id);
    return persisted.length === 0 ? fallback : usageTotalsFromEntries(persisted);
  }

  #applyFailurePolicy(store: TaskStore, task: Task, attempt: TaskAttempt, now: string): boolean {
    const step = store.getStep(attempt.stepId);
    if (step === null || step.status !== "running") return false;
    const decision = classifyTaskRetry(step, attempt);
    if (decision.retry) {
      store.updateStep({ ...step, status: "ready", updatedAt: now });
      store.appendEvent(this.#event(task, "step-state-changed", now, {
        stepId: step.id,
        planRevisionId: step.planRevisionId,
        data: { from: "running", to: "ready", reasonCode: decision.reason, retryAfterMs: decision.delayMs }
      }));
      return false;
    }

    const policy = step.failurePolicy.onAttemptsExhausted;
    if (policy === "skip_if_optional" && step.failurePolicy.optional) {
      store.updateStep({ ...step, status: "skipped", updatedAt: now });
      store.appendEvent(this.#event(task, "step-state-changed", now, {
        stepId: step.id,
        planRevisionId: step.planRevisionId,
        data: { from: "running", to: "skipped", reasonCode: "optional-attempts-exhausted" }
      }));
      return false;
    }
    if (policy === "wait_for_operator") {
      store.updateStep({ ...step, status: "waiting_for_input", updatedAt: now });
      store.appendEvent(this.#event(task, "step-state-changed", now, {
        stepId: step.id,
        planRevisionId: step.planRevisionId,
        data: { from: "running", to: "waiting_for_input", reasonCode: "operator-review-required" }
      }));
      if (task.status === "running") {
        store.updateTask({
          ...task,
          status: "waiting_for_input",
          updatedAt: now,
          waitReason: { kind: "operator", summary: "A Task Step requires operator review.", requestedAt: now }
        });
        store.appendEvent(this.#event(task, "task-state-changed", now, {
          data: { from: "running", to: "waiting_for_input", reasonCode: "operator-review-required" }
        }));
      }
      return false;
    }

    store.updateStep({ ...step, status: "failed", updatedAt: now });
    store.appendEvent(this.#event(task, "step-state-changed", now, {
      stepId: step.id,
      planRevisionId: step.planRevisionId,
      data: { from: "running", to: "failed", reasonCode: "attempts-exhausted" }
    }));
    if (policy === "mark_partial") return false;

    const currentTask = store.getTask(task.id);
    if (currentTask !== null && !isTerminalTaskStatus(currentTask.status)) {
      const failedTask: Task = {
        ...currentTask,
        status: "failed",
        failure: attempt.failure,
        updatedAt: now,
        completedAt: now
      };
      store.updateTask(failedTask);
      store.appendEvent(this.#event(task, "task-state-changed", now, {
        data: { from: currentTask.status, to: "failed", reasonCode: "step-attempts-exhausted" }
      }));
      const revisionId = currentTask.activePlanRevisionId;
      if (revisionId !== undefined) {
        for (const other of store.listSteps(task.id, revisionId)) {
          if (other.id !== step.id && (other.status === "pending" || other.status === "ready" ||
              other.status === "waiting_for_input" || other.status === "waiting_for_approval")) {
            store.updateStep({ ...other, status: "cancelled", updatedAt: now });
            store.appendEvent(this.#event(task, "step-state-changed", now, {
              stepId: other.id,
              planRevisionId: other.planRevisionId,
              data: { from: other.status, to: "cancelled", reasonCode: "task-failed" }
            }));
          }
        }
      }
      for (const otherAttempt of store.listAttempts(task.id)) {
        if (otherAttempt.id !== attempt.id && ACTIVE_ATTEMPT_STATUSES.includes(otherAttempt.status)) {
          store.requestAttemptCancellation(otherAttempt.id, now);
        }
      }
    }
    return true;
  }

  #assertCurrentLease(
    store: TaskStore,
    taskId: string,
    attemptId: string,
    expected: TaskAttemptLease,
    allowCancellation: boolean
  ): { task: Task; attempt: TaskAttempt } {
    const task = store.getTask(taskId);
    const attempt = store.getAttempt(attemptId);
    const lease = attempt?.lease;
    if (
      task === null ||
      attempt === null ||
      lease === undefined ||
      lease.ownerId !== expected.ownerId ||
      lease.fencingToken !== expected.fencingToken ||
      Date.parse(lease.expiresAt) <= this.#now().getTime() ||
      (!allowCancellation && lease.cancellationRequestedAt !== undefined)
    ) {
      throw new TaskSchedulerLeaseLostError();
    }
    if (!allowCancellation && isTerminalTaskStatus(task.status)) throw new TaskSchedulerCancellationError();
    return { task, attempt };
  }

  #retryDelayElapsed(step: TaskStep): boolean {
    const attempts = this.#store.listAttempts(step.taskId, step.id);
    const latest = attempts.reduce<TaskAttempt | undefined>((current, attempt) =>
      current === undefined || attempt.attemptNumber > current.attemptNumber ? attempt : current, undefined);
    if (latest === undefined || latest.completedAt === undefined || latest.failure === undefined) return true;
    const decision = classifyTaskRetry(step, latest);
    return !decision.retry || Date.parse(latest.completedAt) + decision.delayMs <= this.#now().getTime();
  }

  #budgetBlockReason(
    task: Task,
    step: TaskStep,
    store: TaskStore = this.#store,
    ignoredAttemptId?: string
  ): string | undefined {
    const scopes = listTaskBudgetScopes(store, task, step);
    for (let index = 0; index < scopes.length; index++) {
      const scope = scopes[index]!;
      const taskAttempts = listTaskTreeAttempts(store, scope.task.id)
        .filter((attempt) => attempt.id !== ignoredAttemptId);
      const stepAttempts = listStepTreeAttempts(store, scope.task.id, scope.step.id)
        .filter((attempt) => attempt.id !== ignoredAttemptId);
      const taskUsage = sumUsage(taskAttempts.map(attemptBudgetUsage));
      const stepUsage = sumUsage(stepAttempts.map(attemptBudgetUsage));
      const prefix = index === 0 ? "" : "ancestor-";
      if (taskUsage.providerCalls >= scope.task.budgetPolicy.maxProviderCalls) {
        return `${prefix}task-provider-call-budget-exhausted`;
      }
      if (taskUsage.totalTokens >= scope.task.budgetPolicy.maxTotalTokens) {
        return `${prefix}task-token-budget-exhausted`;
      }
      if (taskUsage.estimatedCostUsd >= scope.task.budgetPolicy.maxEstimatedCostUsd) {
        return `${prefix}task-cost-budget-exhausted`;
      }
      if (stepUsage.providerCalls >= scope.step.budget.maxProviderCalls) {
        return `${prefix}step-provider-call-budget-exhausted`;
      }
      if (stepUsage.totalTokens >= scope.step.budget.maxTotalTokens) {
        return `${prefix}step-token-budget-exhausted`;
      }
      if (stepUsage.estimatedCostUsd >= scope.step.budget.maxEstimatedCostUsd) {
        return `${prefix}step-cost-budget-exhausted`;
      }
      const startedAt = scope.task.startedAt === undefined ? undefined : Date.parse(scope.task.startedAt);
      if (startedAt !== undefined && this.#now().getTime() - startedAt >= scope.task.budgetPolicy.maxWallClockMs) {
        return `${prefix}task-wall-clock-budget-exhausted`;
      }
      const stepStartedAt = stepAttempts
        .filter((attempt) => attempt.startedAt !== undefined)
        .reduce<number | undefined>((earliest, attempt) => {
          const started = Date.parse(attempt.startedAt!);
          return earliest === undefined || started < earliest ? started : earliest;
        }, undefined);
      if (stepStartedAt !== undefined && this.#now().getTime() - stepStartedAt >= scope.step.budget.maxWallClockMs) {
        return `${prefix}step-wall-clock-budget-exhausted`;
      }
    }
    return undefined;
  }

  #usageWithinBudget(taskId: string, step: TaskStep, newUsage: TaskUsageTotals): boolean {
    const task = this.#store.getTask(taskId);
    if (task === null) return false;
    const attempts = this.#store.listAttempts(taskId);
    const currentAttemptId = this.#currentAttemptId(attempts, step.id);
    const effectiveNewUsage = { ...newUsage, providerCalls: Math.max(1, newUsage.providerCalls) };
    const nowMs = this.#now().getTime();
    for (const scope of listTaskBudgetScopes(this.#store, task, step)) {
      const priorTask = sumUsage(listTaskTreeAttempts(this.#store, scope.task.id)
        .filter((attempt) => attempt.id !== currentAttemptId)
        .map(attemptBudgetUsage));
      const scopeStepAttempts = listStepTreeAttempts(this.#store, scope.task.id, scope.step.id);
      const priorStepAttempts = scopeStepAttempts
        .filter((attempt) => attempt.id !== currentAttemptId);
      const priorStep = sumUsage(priorStepAttempts.map(attemptBudgetUsage));
      const taskWallClockOk = scope.task.startedAt === undefined ||
        nowMs - Date.parse(scope.task.startedAt) <= scope.task.budgetPolicy.maxWallClockMs;
      const firstStepStart = scopeStepAttempts
        .filter((attempt) => attempt.startedAt !== undefined)
        .reduce<number | undefined>((earliest, attempt) => {
          const started = Date.parse(attempt.startedAt!);
          return earliest === undefined || started < earliest ? started : earliest;
        }, undefined);
      const stepWallClockOk = firstStepStart === undefined ||
        nowMs - firstStepStart <= scope.step.budget.maxWallClockMs;
      if (!taskWallClockOk || !stepWallClockOk ||
          !usageFits(addUsage(priorTask, effectiveNewUsage), scope.task.budgetPolicy) ||
          !usageFits(addUsage(priorStep, effectiveNewUsage), scope.step.budget)) return false;
    }
    return true;
  }

  #currentAttemptId(attempts: readonly TaskAttempt[], stepId: string): string | undefined {
    return attempts.filter((attempt) => attempt.stepId === stepId && !isTerminalTaskAttemptStatus(attempt.status))[0]?.id;
  }

  #capacityState(): CapacityState {
    const state: CapacityState = {
      profile: 0,
      task: new Map(),
      tree: new Map(),
      executor: new Map(),
      provider: new Map()
    };
    const tasks = this.#store.listTasks({ statuses: RECONCILABLE_TASK_STATUSES, limit: 1_000 });
    for (const task of tasks) {
      for (const attempt of this.#store.listAttempts(task.id)) {
        if (!LEASE_OWNED_ATTEMPT_STATUSES.includes(attempt.status)) continue;
        const step = this.#store.getStep(attempt.stepId);
        if (step === null) continue;
        incrementCapacity(state, task, step);
      }
    }
    return state;
  }

  #hasCapacity(task: Task, step: TaskStep, state: CapacityState, store: TaskStore = this.#store): boolean {
    const executorKey = step.executor.kind;
    const providerKey = step.executor.model?.provider ?? "default";
    const root = store.getTask(task.rootTaskId);
    if (root === null) return false;
    return state.profile < this.#limits.maxProfileConcurrentAttempts &&
      (state.task.get(task.id) ?? 0) < task.budgetPolicy.maxConcurrentAttempts &&
      (state.tree.get(task.rootTaskId) ?? 0) < root.budgetPolicy.maxConcurrentAttempts &&
      (state.executor.get(executorKey) ?? 0) < (this.#limits.maxConcurrentByExecutor?.[executorKey] ?? Number.MAX_SAFE_INTEGER) &&
      (state.provider.get(providerKey) ?? 0) < (this.#limits.maxConcurrentByProvider?.[providerKey] ?? Number.MAX_SAFE_INTEGER);
  }

  #hasDurableCapacity(store: TaskStore, task: Task, step: TaskStep): boolean {
    const state: CapacityState = {
      profile: 0,
      task: new Map(),
      tree: new Map(),
      executor: new Map(),
      provider: new Map()
    };
    const tasks = store.listTasks({ statuses: RECONCILABLE_TASK_STATUSES, limit: 1_000 });
    for (const candidateTask of tasks) {
      for (const attempt of store.listAttempts(candidateTask.id)) {
        if (!LEASE_OWNED_ATTEMPT_STATUSES.includes(attempt.status)) continue;
        const candidateStep = store.getStep(attempt.stepId);
        if (candidateStep !== null) incrementCapacity(state, candidateTask, candidateStep);
      }
    }
    return this.#hasCapacity(task, step, state, store);
  }

  #finalizeTaskIfSettled(taskId: string): void {
    const now = this.#now().toISOString();
    this.#store.atomicWrite((store) => {
      const task = store.getTask(taskId);
      if (task === null || task.status !== "running" || task.activePlanRevisionId === undefined) return;
      const steps = store.listSteps(task.id, task.activePlanRevisionId);
      if (steps.length === 0 || steps.some((step) => !isTerminalTaskStepStatus(step.status))) return;
      const status: Task["status"] = steps.every((step) => step.status === "completed") ? "completed" : "partial";
      const completed: Task = { ...task, status, updatedAt: now, completedAt: now };
      store.updateTask(completed);
      store.appendEvent(this.#event(task, "task-state-changed", now, {
        data: { from: "running", to: status, reasonCode: "all-steps-settled" }
      }));
    });
  }

  #abortTaskExecutions(taskId: string, exceptAttemptId?: string): void {
    for (const [attemptId, execution] of this.#running) {
      if (execution.taskId === taskId && attemptId !== exceptAttemptId) execution.controller.abort();
    }
  }

  #event(
    task: Task,
    kind: TaskEventKind,
    timestamp: string,
    options: {
      planRevisionId?: string;
      stepId?: string;
      attemptId?: string;
      data: Readonly<Record<string, unknown>>;
    }
  ): TaskEvent {
    return {
      id: this.#eventId(),
      profileId: this.#store.profileId,
      taskId: task.id,
      ...(options.planRevisionId === undefined ? {} : { planRevisionId: options.planRevisionId }),
      ...(options.stepId === undefined ? {} : { stepId: options.stepId }),
      ...(options.attemptId === undefined ? {} : { attemptId: options.attemptId }),
      kind,
      timestamp,
      data: options.data
    };
  }
}

export function taskDispatchKey(
  taskId: string,
  planRevisionId: string,
  stepId: string,
  attemptNumber: number
): string {
  if (!Number.isSafeInteger(attemptNumber) || attemptNumber < 1) {
    throw new Error("Task dispatch attempt number must be a positive integer.");
  }
  const digest = createHash("sha256")
    .update(JSON.stringify([taskId, planRevisionId, stepId, attemptNumber]), "utf8")
    .digest("hex");
  return `task-dispatch:${digest}`;
}

export function classifyTaskRetry(step: TaskStep, attempt: TaskAttempt): TaskRetryDecision {
  const failureRecord = attempt.failure;
  if (failureRecord === undefined) return { retry: false, delayMs: 0, reason: "attempt-has-no-failure" };
  if (attempt.attemptNumber >= step.retryPolicy.maxAttempts) {
    return { retry: false, delayMs: 0, reason: "attempt-limit-exhausted" };
  }
  if (step.retryPolicy.nonRetryableFailureClasses.includes(failureRecord.class)) {
    return { retry: false, delayMs: 0, reason: "failure-class-non-retryable" };
  }
  const explicitlyRetryable = step.retryPolicy.retryableFailureClasses.length === 0 ||
    step.retryPolicy.retryableFailureClasses.includes(failureRecord.class);
  if (!failureRecord.retryable || !explicitlyRetryable) {
    return { retry: false, delayMs: 0, reason: "failure-not-retryable" };
  }
  if (step.retryPolicy.requireIdempotent && step.idempotency !== "idempotent" && step.idempotency !== "retry_safe") {
    return { retry: false, delayMs: 0, reason: "idempotency-required" };
  }
  if (failureRecord.uncertainSideEffects && step.idempotency !== "idempotent") {
    return { retry: false, delayMs: 0, reason: "uncertain-side-effects" };
  }
  return { retry: true, delayMs: retryDelayMs(step, attempt.attemptNumber), reason: "retry-policy-allowed" };
}

export function retryDelayMs(step: TaskStep, completedAttemptNumber: number): number {
  const raw = step.retryPolicy.initialBackoffMs *
    Math.pow(step.retryPolicy.backoffMultiplier, Math.max(0, completedAttemptNumber - 1));
  return Math.min(step.retryPolicy.maxBackoffMs, Math.max(0, Math.round(raw)));
}

function validateResultAcceptance(
  step: TaskStep,
  results: readonly { kind: string; content: string | Uint8Array }[]
): TaskFailure | undefined {
  if (results.length > MAX_RESULT_RECORDS_PER_SETTLEMENT) {
    return failure("too-many-results", "Attempt returned too many result records.", false, false);
  }
  if (step.resultPolicy.kind === "none") {
    return results.length === 0
      ? undefined
      : failure("unexpected-result", "Step does not accept result content.", false, false);
  }
  if (results.some((result) => result.kind !== step.resultPolicy.kind)) {
    return failure("result-kind-mismatch", "Attempt result kind does not match Step acceptance policy.", false, false);
  }
  if (step.resultPolicy.required && results.length === 0) {
    return failure("required-result-missing", "Attempt did not provide its required result.", false, false);
  }
  if (results.some((result) => !hasAcceptedContent(step, result.content))) {
    return failure("empty-result", "Attempt returned an empty durable result.", false, false);
  }
  return undefined;
}

function hasAcceptedContent(step: TaskStep, content: string | Uint8Array): boolean {
  if (content instanceof Uint8Array) return content.byteLength > 0;
  if (step.resultPolicy.kind === "text") return content.trim().length > 0;
  return Buffer.byteLength(content, "utf8") > 0;
}

function normalizeFailure(value: TaskFailure): TaskFailure {
  const failureClass = requireToken(value.class, "failure class");
  const message = value.message.trim().slice(0, 500) || "Task Attempt failed.";
  return {
    class: failureClass,
    message,
    retryable: value.retryable === true,
    uncertainSideEffects: value.uncertainSideEffects === true
  };
}

function failure(
  failureClass: string,
  message: string,
  retryable: boolean,
  uncertainSideEffects: boolean
): TaskFailure {
  return { class: failureClass, message, retryable, uncertainSideEffects };
}

function emptyUsage(): TaskUsageTotals {
  return {
    providerCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    estimatedCostUsd: 0,
    usageComplete: true,
    pricingComplete: true,
    incompleteReasons: []
  };
}

function normalizeUsage(value: TaskUsageTotals | undefined): TaskUsageTotals {
  if (value === undefined) return emptyUsage();
  const integerFields = [
    value.providerCalls,
    value.inputTokens,
    value.outputTokens,
    value.reasoningTokens,
    value.totalTokens
  ];
  if (integerFields.some((entry) => !Number.isSafeInteger(entry) || entry < 0) ||
      !Number.isFinite(value.estimatedCostUsd) || value.estimatedCostUsd < 0 ||
      !Array.isArray(value.incompleteReasons) || value.incompleteReasons.length > 32 ||
      value.incompleteReasons.some((reason) => typeof reason !== "string" || reason.length > 160)) {
    throw new Error("Executor returned invalid Task usage totals.");
  }
  return { ...value, incompleteReasons: [...value.incompleteReasons] };
}

function sumUsage(values: readonly TaskUsageTotals[]): TaskUsageTotals {
  return values.reduce(addUsage, emptyUsage());
}

function usageTotalsFromEntries(entries: readonly TaskUsageEntry[]): TaskUsageTotals {
  const dispatched = entries.filter((entry) => entry.dispatched);
  const reasons = [...new Set(dispatched.flatMap((entry) => entry.incompleteReasons))].slice(0, 32);
  if (dispatched.length === 0) reasons.push("provider-usage-unavailable");
  return {
    providerCalls: dispatched.length,
    inputTokens: dispatched.reduce((sum, entry) => sum + entry.inputTokens, 0),
    outputTokens: dispatched.reduce((sum, entry) => sum + entry.outputTokens, 0),
    reasoningTokens: dispatched.reduce((sum, entry) => sum + entry.reasoningTokens, 0),
    totalTokens: dispatched.reduce((sum, entry) => sum + entry.totalTokens, 0),
    estimatedCostUsd: dispatched.reduce((sum, entry) => sum + entry.estimatedCostUsd, 0),
    usageComplete: dispatched.length > 0 && dispatched.every((entry) => entry.usageComplete),
    pricingComplete: dispatched.length > 0 && dispatched.every((entry) => entry.pricingComplete),
    incompleteReasons: reasons
  };
}

function attemptBudgetUsage(attempt: TaskAttempt): TaskUsageTotals {
  return { ...attempt.usage, providerCalls: Math.max(1, attempt.usage.providerCalls) };
}

function addUsage(left: TaskUsageTotals, right: TaskUsageTotals): TaskUsageTotals {
  return {
    providerCalls: left.providerCalls + right.providerCalls,
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    reasoningTokens: left.reasoningTokens + right.reasoningTokens,
    totalTokens: left.totalTokens + right.totalTokens,
    estimatedCostUsd: left.estimatedCostUsd + right.estimatedCostUsd,
    usageComplete: left.usageComplete && right.usageComplete,
    pricingComplete: left.pricingComplete && right.pricingComplete,
    incompleteReasons: [...left.incompleteReasons, ...right.incompleteReasons].slice(0, 32)
  };
}

function usageFits(
  usage: TaskUsageTotals,
  budget: Pick<Task["budgetPolicy"], "maxProviderCalls" | "maxTotalTokens" | "maxEstimatedCostUsd">
): boolean {
  return usage.providerCalls <= budget.maxProviderCalls &&
    usage.totalTokens <= budget.maxTotalTokens &&
    usage.estimatedCostUsd <= budget.maxEstimatedCostUsd;
}

function usageEventData(usage: TaskUsageTotals): Readonly<Record<string, unknown>> {
  return {
    providerCalls: usage.providerCalls,
    totalTokens: usage.totalTokens,
    estimatedCostUsd: usage.estimatedCostUsd,
    usageComplete: usage.usageComplete,
    pricingComplete: usage.pricingComplete
  };
}

function fenceInput(lease: TaskAttemptLease): {
  attemptId: string;
  ownerId: string;
  fencingToken: number;
} {
  return { attemptId: lease.attemptId, ownerId: lease.ownerId, fencingToken: lease.fencingToken };
}

function emptyRunResult(): MutableRunResult {
  return { reconciled: 0, dispatched: 0, completed: 0, failed: 0, cancelled: 0, leaseLost: 0, warnings: [] };
}

function incrementCapacity(state: CapacityState, task: Task, step: TaskStep): void {
  state.profile++;
  incrementMap(state.task, task.id);
  incrementMap(state.tree, task.rootTaskId);
  incrementMap(state.executor, step.executor.kind);
  incrementMap(state.provider, step.executor.model?.provider ?? "default");
}

function incrementMap(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function compareTasks(left: Task, right: Task): number {
  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

function requireToken(value: string, label: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9._:-]{1,160}$/u.test(normalized)) {
    throw new Error(`Task ${label} must be a bounded stable token.`);
  }
  return normalized;
}

function normalizeCheckpointActivity(activity: TaskAttemptActivity): TaskAttemptActivity {
  if (activity.kind !== "worker" && activity.kind !== "provider" && activity.kind !== "tool") {
    throw new Error("Task Attempt activity kind is invalid.");
  }
  const label = activity.label.replace(/\s+/gu, " ").trim();
  if (label.length === 0 || label.length > 160 || /[\u0000-\u001F\u007F]/u.test(label)) {
    throw new Error("Task Attempt activity label must be bounded display-safe text.");
  }
  const toolCategory = activity.toolCategory === undefined
    ? undefined
    : requireToken(activity.toolCategory, "activity tool category");
  return {
    kind: activity.kind,
    label,
    ...(toolCategory === undefined ? {} : { toolCategory })
  };
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Task ${label} must be a positive integer.`);
  return value;
}

function validateLimitMap(value: Readonly<Record<string, number>> | undefined): Readonly<Record<string, number>> {
  if (value === undefined) return {};
  for (const [key, limit] of Object.entries(value)) {
    requireToken(key, "concurrency key");
    positiveInteger(limit, "concurrency limit");
  }
  return { ...value };
}
