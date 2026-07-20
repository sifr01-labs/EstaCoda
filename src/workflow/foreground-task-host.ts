import type { Task, TaskHostLease } from "../contracts/task.js";
import { isTerminalTaskStatus } from "../contracts/task.js";
import type { TaskStepExecutor } from "./task-step-executor.js";
import { TaskApprovalService } from "./task-approval-service.js";
import type { TaskResultService } from "./task-result-service.js";
import {
  TaskScheduler,
  type TaskSchedulerDispatchResult,
  type TaskSchedulerRunResult
} from "./task-scheduler.js";
import type { TaskStore } from "./task-store.js";

const RUNNABLE_TASK_STATUSES: readonly Task["status"][] = ["queued", "running", "waiting_for_host"];
const DEFAULT_HOST_LEASE_MS = 30_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000;

type ForegroundExecutor = TaskStepExecutor & {
  canExecute?(task: Task, step: Parameters<TaskStepExecutor["execute"]>[0]["step"]): boolean;
};

export type ForegroundTaskExecutorRuntime = {
  executor: ForegroundExecutor;
  dispose(): Promise<void>;
};

export type ForegroundTaskStartResult = {
  taskId: string;
  claimed: boolean;
  lease?: TaskHostLease;
  dispatch?: TaskSchedulerRunResult;
  reason?: "host-stopping" | "task-missing" | "task-terminal" | "workspace-mismatch" | "owned-by-other-host";
};

/**
 * Process-owned foreground scheduler for one profile/workspace pair.
 *
 * Task host leases prevent a background runtime from scheduling work owned by
 * this process. Attempt leases remain the settlement fence for each worker.
 */
export class ForegroundTaskHost {
  readonly #store: TaskStore;
  readonly #scheduler: TaskScheduler;
  readonly #ownerId: string;
  readonly #workspaceIdentityHash: string;
  readonly #leaseMs: number;
  readonly #heartbeatIntervalMs: number;
  readonly #now: () => Date;
  readonly #logWarning: (message: string) => void;
  readonly #createExecutorRuntime: (() => Promise<ForegroundTaskExecutorRuntime>) | undefined;
  readonly #owned = new Map<string, TaskHostLease>();
  #executorRuntime: ForegroundTaskExecutorRuntime | undefined;
  #executor: ForegroundExecutor | undefined;
  #executorCreation: Promise<void> | undefined;
  #operations: Promise<void> = Promise.resolve();
  #heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  #shutdownPromise: Promise<void> | undefined;
  #started = false;
  #stopping = false;

  constructor(options: {
    store: TaskStore;
    resultService: TaskResultService;
    executor?: ForegroundExecutor;
    createExecutorRuntime?: () => Promise<ForegroundTaskExecutorRuntime>;
    ownerId: string;
    workspaceIdentityHash: string;
    approvalService?: TaskApprovalService;
    leaseMs?: number;
    heartbeatIntervalMs?: number;
    now?: () => Date;
    logWarning?: (message: string) => void;
  }) {
    this.#store = options.store;
    this.#ownerId = requireToken(options.ownerId, "foreground Task host owner ID");
    this.#workspaceIdentityHash = requireToken(options.workspaceIdentityHash, "foreground Task host workspace identity");
    this.#leaseMs = positiveInteger(options.leaseMs ?? DEFAULT_HOST_LEASE_MS, "foreground Task host lease duration");
    this.#heartbeatIntervalMs = positiveInteger(
      options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
      "foreground Task host heartbeat interval"
    );
    if (this.#heartbeatIntervalMs >= this.#leaseMs) {
      throw new Error("Foreground Task host heartbeat interval must be shorter than its lease duration.");
    }
    this.#now = options.now ?? (() => new Date());
    this.#logWarning = options.logWarning ?? (() => undefined);
    this.#executor = options.executor;
    this.#createExecutorRuntime = options.createExecutorRuntime;
    if (this.#executor === undefined && this.#createExecutorRuntime === undefined) {
      throw new Error("Foreground Task host requires an executor or executor runtime factory.");
    }

    this.#scheduler = new TaskScheduler({
      store: options.store,
      resultService: options.resultService,
      ownerId: options.ownerId,
      approvalService: options.approvalService ?? new TaskApprovalService({ store: options.store, now: this.#now }),
      now: this.#now,
      resolveExecutor: (task, step) => {
        const executor = this.#executor;
        return executor !== undefined && executor.kind === step.executor.kind && executor.canExecute?.(task, step) !== false
          ? executor
          : undefined
      }
    });
  }

  get ownerId(): string {
    return this.#ownerId;
  }

  /** Recovers interrupted foreground Tasks and starts the heartbeat loop. */
  async start(): Promise<void> {
    if (this.#stopping) return;
    this.#ensureStarted();
    await this.runOnce();
  }

  /** Claims one newly persisted Task and returns after its first dispatch is durable. */
  startTask(taskId: string): Promise<ForegroundTaskStartResult> {
    const normalizedTaskId = requireToken(taskId, "foreground Task ID");
    if (this.#stopping) {
      return Promise.resolve({ taskId: normalizedTaskId, claimed: false, reason: "host-stopping" });
    }
    this.#ensureStarted();
    return this.#serialize(async () => {
      if (this.#stopping) {
        return { taskId: normalizedTaskId, claimed: false, reason: "host-stopping" };
      }
      const claim = this.#claimTask(normalizedTaskId);
      if (claim.claimed === false) return claim;
      await this.#ensureExecutorRuntime();
      const dispatch = await this.#scheduler.dispatchOnce({ eligibleTaskIds: [normalizedTaskId] });
      this.#observeCompletion(dispatch);
      return {
        taskId: normalizedTaskId,
        claimed: true,
        lease: claim.lease,
        dispatch: dispatchSnapshot(dispatch)
      };
    });
  }

  /** Renews ownership, discovers eligible Tasks, and performs one non-blocking dispatch pass. */
  runOnce(): Promise<TaskSchedulerRunResult> {
    if (this.#stopping) return Promise.resolve(emptyRunResult());
    this.#ensureStarted();
    return this.#serialize(async () => {
      if (this.#stopping) return emptyRunResult();
      this.#renewOwnedTasks();
      this.#claimAvailableTasks();
      const eligibleTaskIds = [...this.#owned.keys()];
      if (eligibleTaskIds.length === 0) return emptyRunResult();
      await this.#ensureExecutorRuntime();
      const dispatch = await this.#scheduler.dispatchOnce({ eligibleTaskIds });
      this.#observeCompletion(dispatch);
      return dispatchSnapshot(dispatch);
    });
  }

  ownedTaskIds(): readonly string[] {
    return [...this.#owned.keys()];
  }

  hasPendingWork(): boolean {
    return this.#scheduler.hasPendingWork() || this.#owned.size > 0;
  }

  /** Commit 25 adds interruption/handoff; this boundary currently drains owned Attempts. */
  shutdown(): Promise<void> {
    if (this.#shutdownPromise !== undefined) return this.#shutdownPromise;
    const shutdown = this.#performShutdown();
    this.#shutdownPromise = shutdown;
    return shutdown;
  }

  async #performShutdown(): Promise<void> {
    this.#stopping = true;
    if (this.#heartbeatTimer !== undefined) {
      clearInterval(this.#heartbeatTimer);
      this.#heartbeatTimer = undefined;
    }
    await this.#operations;
    await this.#scheduler.shutdown();
    this.#releaseOwnedTasks();
    await this.#executorCreation?.catch(() => undefined);
    const executorRuntime = this.#executorRuntime;
    this.#executorRuntime = undefined;
    this.#executor = undefined;
    await executorRuntime?.dispose().catch(() => undefined);
  }

  #ensureStarted(): void {
    if (this.#started) return;
    this.#started = true;
    this.#heartbeatTimer = setInterval(() => {
      try {
        // Lease renewal must not wait behind a slow executor-runtime creation.
        this.#renewOwnedTasks();
      } catch (error) {
        this.#logWarning(`Foreground Task host heartbeat failed (${errorClass(error)}).`);
      }
      void this.runOnce().catch((error) => {
        this.#logWarning(`Foreground Task host tick failed (${errorClass(error)}).`);
      });
    }, this.#heartbeatIntervalMs);
    this.#heartbeatTimer.unref?.();
  }

  #claimAvailableTasks(): void {
    const tasks = this.#store.listTasks({ statuses: RUNNABLE_TASK_STATUSES, limit: 1_000 });
    for (const task of tasks) {
      if (task.workspace.identityHash !== this.#workspaceIdentityHash || this.#owned.has(task.id)) continue;
      const existingLease = this.#store.getTaskHostLease(task.id);
      if (existingLease?.kind !== "foreground") continue;
      this.#claimTask(task.id);
    }
  }

  async #ensureExecutorRuntime(): Promise<void> {
    if (this.#executor !== undefined) return;
    if (this.#executorCreation !== undefined) return await this.#executorCreation;
    const createExecutorRuntime = this.#createExecutorRuntime;
    if (createExecutorRuntime === undefined) throw new Error("Foreground Task executor is unavailable.");
    const creation = (async () => {
      const runtime = await createExecutorRuntime();
      if (this.#stopping) {
        await runtime.dispose().catch(() => undefined);
        throw new Error("Foreground Task host stopped while creating its executor runtime.");
      }
      this.#executorRuntime = runtime;
      this.#executor = runtime.executor;
    })();
    this.#executorCreation = creation;
    try {
      await creation;
    } finally {
      if (this.#executorCreation === creation) this.#executorCreation = undefined;
    }
  }

  #claimTask(taskId: string): ForegroundTaskStartResult & { lease?: TaskHostLease } {
    const task = this.#store.getTask(taskId);
    if (task === null) return { taskId, claimed: false, reason: "task-missing" };
    if (isTerminalTaskStatus(task.status)) return { taskId, claimed: false, reason: "task-terminal" };
    if (task.workspace.identityHash !== this.#workspaceIdentityHash) {
      return { taskId, claimed: false, reason: "workspace-mismatch" };
    }

    const now = this.#now();
    const existing = this.#store.getTaskHostLease(taskId);
    if (existing !== null && Date.parse(existing.expiresAt) > now.getTime()) {
      if (existing.ownerId !== this.#ownerId || existing.kind !== "foreground") {
        return { taskId, claimed: false, reason: "owned-by-other-host" };
      }
      const renewed = this.#renewLease(existing, now);
      if (renewed === null) return { taskId, claimed: false, reason: "owned-by-other-host" };
      this.#owned.set(taskId, renewed);
      return { taskId, claimed: true, lease: renewed };
    }

    const acquired = this.#store.acquireTaskHostLease({
      taskId,
      workspaceIdentityHash: this.#workspaceIdentityHash,
      ownerId: this.#ownerId,
      kind: "foreground",
      acquiredAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.#leaseMs).toISOString()
    });
    if (acquired === null || acquired.ownerId !== this.#ownerId || acquired.kind !== "foreground") {
      return { taskId, claimed: false, reason: "owned-by-other-host" };
    }
    this.#owned.set(taskId, acquired);
    return { taskId, claimed: true, lease: acquired };
  }

  #renewOwnedTasks(): void {
    const now = this.#now();
    for (const [taskId, lease] of this.#owned) {
      const task = this.#store.getTask(taskId);
      if (task === null || task.workspace.identityHash !== this.#workspaceIdentityHash) {
        this.#owned.delete(taskId);
        continue;
      }
      if (isTerminalTaskStatus(task.status)) {
        this.#releaseLease(lease);
        this.#owned.delete(taskId);
        continue;
      }
      const renewed = this.#renewLease(lease, now);
      if (renewed === null) this.#owned.delete(taskId);
      else this.#owned.set(taskId, renewed);
    }
  }

  #renewLease(lease: TaskHostLease, now: Date): TaskHostLease | null {
    return this.#store.renewTaskHostLease({
      taskId: lease.taskId,
      workspaceIdentityHash: lease.workspaceIdentityHash,
      ownerId: lease.ownerId,
      kind: lease.kind,
      fencingToken: lease.fencingToken,
      heartbeatAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.#leaseMs).toISOString()
    });
  }

  #observeCompletion(dispatch: TaskSchedulerDispatchResult): void {
    if (dispatch.dispatched === 0) return;
    void dispatch.completion.then(
      () => { if (!this.#stopping) void this.runOnce().catch((error) => this.#logWarning(
        `Foreground Task continuation failed (${errorClass(error)}).`
      )); },
      (error) => this.#logWarning(`Foreground Task execution failed (${errorClass(error)}).`)
    );
  }

  #releaseOwnedTasks(): void {
    for (const lease of this.#owned.values()) this.#releaseLease(lease);
    this.#owned.clear();
  }

  #releaseLease(lease: TaskHostLease): void {
    this.#store.releaseTaskHostLease({
      taskId: lease.taskId,
      workspaceIdentityHash: lease.workspaceIdentityHash,
      ownerId: lease.ownerId,
      kind: lease.kind,
      fencingToken: lease.fencingToken
    });
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.#operations.then(operation, operation);
    this.#operations = run.then(() => undefined, () => undefined);
    return run;
  }
}

function dispatchSnapshot(dispatch: TaskSchedulerDispatchResult): TaskSchedulerRunResult {
  return {
    reconciled: dispatch.reconciled,
    dispatched: dispatch.dispatched,
    completed: dispatch.completed,
    failed: dispatch.failed,
    cancelled: dispatch.cancelled,
    leaseLost: dispatch.leaseLost,
    warnings: [...dispatch.warnings]
  };
}

function emptyRunResult(): TaskSchedulerRunResult {
  return { reconciled: 0, dispatched: 0, completed: 0, failed: 0, cancelled: 0, leaseLost: 0, warnings: [] };
}

function requireToken(value: string, label: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9._:-]{1,256}$/u.test(normalized)) throw new Error(`${label} must be a bounded stable token.`);
  return normalized;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer.`);
  return value;
}

function errorClass(error: unknown): string {
  if (error instanceof Error && error.name.trim().length > 0) return error.name;
  return "foreground-task-host-error";
}
