import type { Task, TaskHostLease } from "../contracts/task.js";
import { isTerminalTaskStatus } from "../contracts/task.js";
import type { AgentStepExecutor } from "./agent-step-executor.js";
import {
  TaskBackgroundHost,
  type TaskBackgroundHostRunResult,
  type TaskBackgroundHostStatus
} from "./task-background-host.js";
import { TaskCompletionDeliveryService, type TaskCompletionDeliveryRouter } from "./task-completion-delivery.js";
import { TaskScheduler } from "./task-scheduler.js";
import type { TaskResultService } from "./task-result-service.js";
import type { TaskStore } from "./task-store.js";
import type { TaskApprovalService } from "./task-approval-service.js";

const RUNNABLE_TASK_STATUSES: readonly Task["status"][] = ["queued", "running", "waiting_for_host"];
const EXECUTOR_CREATION_RETRY_MS = 30_000;
const DEFAULT_HOST_LEASE_MS = 30_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000;

export type TaskExecutorHostRuntime = {
  taskAgentExecutor?: AgentStepExecutor;
  dispose(): Promise<void>;
};

/**
 * Supervisor-owned Task host. The expensive agent runtime is created only when
 * runnable work exists; delivery recovery remains active from the first tick.
 */
export class SupervisorTaskBackgroundHost {
  readonly #store: TaskStore;
  readonly #host: TaskBackgroundHost;
  readonly #createExecutorRuntime: () => Promise<TaskExecutorHostRuntime>;
  readonly #logWarning: (message: string) => void;
  readonly #ownerId: string;
  readonly #workspaceIdentityHash: string;
  readonly #leaseMs: number;
  readonly #heartbeatIntervalMs: number;
  readonly #now: () => Date;
  readonly #owned = new Map<string, TaskHostLease>();
  #executorRuntime: TaskExecutorHostRuntime | undefined;
  #executor: AgentStepExecutor | undefined;
  #executorCreation: Promise<void> | undefined;
  #nextExecutorCreationAt = 0;
  #heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  #disposed = false;

  constructor(options: {
    store: TaskStore;
    resultService: TaskResultService;
    router: TaskCompletionDeliveryRouter;
    ownerId: string;
    workspaceIdentityHash: string;
    createExecutorRuntime: () => Promise<TaskExecutorHostRuntime>;
    approvalService?: TaskApprovalService;
    leaseMs?: number;
    heartbeatIntervalMs?: number;
    now?: () => Date;
    logWarning?: (message: string) => void;
  }) {
    this.#store = options.store;
    this.#createExecutorRuntime = options.createExecutorRuntime;
    this.#logWarning = options.logWarning ?? (() => undefined);
    this.#ownerId = requireToken(options.ownerId, "background Task host owner ID");
    this.#workspaceIdentityHash = requireToken(options.workspaceIdentityHash, "background Task host workspace identity");
    this.#leaseMs = positiveInteger(options.leaseMs ?? DEFAULT_HOST_LEASE_MS, "background Task host lease duration");
    this.#heartbeatIntervalMs = positiveInteger(
      options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
      "background Task host heartbeat interval"
    );
    if (this.#heartbeatIntervalMs >= this.#leaseMs) {
      throw new Error("Background Task host heartbeat interval must be shorter than its lease duration.");
    }
    this.#now = options.now ?? (() => new Date());
    const resultRecovery = options.resultService.recoverPrepared();
    if (resultRecovery.removed > 0) {
      this.#logWarning(`Removed ${resultRecovery.removed} abandoned prepared Task result bodies.`);
    }
    if (resultRecovery.unresolved > 0) {
      this.#logWarning(`Could not safely reconcile ${resultRecovery.unresolved} prepared Task result markers.`);
    }
    const scheduler = new TaskScheduler({
      store: options.store,
      resultService: options.resultService,
      ownerId: options.ownerId,
      approvalService: options.approvalService,
      now: this.#now,
      resolveExecutor: (task, step) => this.#executor?.canExecute(task, step) === true
        ? this.#executor
        : undefined
    });
    const delivery = new TaskCompletionDeliveryService({
      store: options.store,
      resultService: options.resultService,
      router: options.router
    });
    this.#host = new TaskBackgroundHost({
      scheduler: {
        runOnce: async () => {
          this.#renewOwnedTasks();
          this.#claimAvailableTasks();
          await this.#ensureExecutorForRunnableWork();
          const result = await scheduler.runOnce({ eligibleTaskIds: this.#eligibleTaskIds() });
          this.#renewOwnedTasks();
          return result;
        }
      },
      delivery
    });
    this.#heartbeatTimer = setInterval(() => {
      try {
        this.#renewOwnedTasks();
      } catch (error) {
        this.#logWarning(`Background Task host heartbeat failed (${errorClass(error)}).`);
      }
    }, this.#heartbeatIntervalMs);
    this.#heartbeatTimer.unref?.();
  }

  runOnce(): Promise<TaskBackgroundHostRunResult> {
    if (this.#disposed) return Promise.resolve({ skipped: true });
    return this.#host.runOnce();
  }

  hasPendingWork(): boolean {
    return this.#host.hasPendingWork() || this.#executorCreation !== undefined;
  }

  waitForIdle(): Promise<void> {
    return this.#host.waitForIdle();
  }

  status(): TaskBackgroundHostStatus {
    return this.#host.status();
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    if (this.#heartbeatTimer !== undefined) {
      clearInterval(this.#heartbeatTimer);
      this.#heartbeatTimer = undefined;
    }
    await this.#host.waitForIdle().catch(() => undefined);
    await this.#executorCreation?.catch(() => undefined);
    this.#releaseOwnedTasks();
    const runtime = this.#executorRuntime;
    this.#executorRuntime = undefined;
    this.#executor = undefined;
    await runtime?.dispose().catch(() => undefined);
  }

  async #ensureExecutorForRunnableWork(): Promise<void> {
    if (this.#disposed || this.#executor !== undefined || Date.now() < this.#nextExecutorCreationAt) return;
    if (this.#owned.size === 0) return;
    if (this.#executorCreation !== undefined) return await this.#executorCreation;

    const creation = (async () => {
      let runtime: TaskExecutorHostRuntime | undefined;
      try {
        runtime = await this.#createExecutorRuntime();
        if (runtime.taskAgentExecutor === undefined) {
          await runtime.dispose().catch(() => undefined);
          this.#nextExecutorCreationAt = Date.now() + EXECUTOR_CREATION_RETRY_MS;
          this.#logWarning("Task executor host unavailable (executor-not-configured).");
          return;
        }
        if (this.#disposed) {
          await runtime.dispose().catch(() => undefined);
          return;
        }
        this.#executorRuntime = runtime;
        this.#executor = runtime.taskAgentExecutor;
      } catch (error) {
        await runtime?.dispose().catch(() => undefined);
        this.#nextExecutorCreationAt = Date.now() + EXECUTOR_CREATION_RETRY_MS;
        this.#logWarning(`Task executor host unavailable (${errorClass(error)}).`);
      }
    })();
    this.#executorCreation = creation;
    await creation;
    if (this.#executorCreation === creation) this.#executorCreation = undefined;
  }

  #eligibleTaskIds(limit = 1_000): string[] {
    return [...this.#owned.keys()].slice(0, limit);
  }

  #claimAvailableTasks(): void {
    const tasks = this.#store.listTasks({ statuses: RUNNABLE_TASK_STATUSES, limit: 1_000 });
    for (const task of tasks) {
      if (task.workspace.identityHash !== this.#workspaceIdentityHash || this.#owned.has(task.id)) continue;
      const now = this.#now();
      const acquired = this.#store.acquireTaskHostLease({
        taskId: task.id,
        workspaceIdentityHash: this.#workspaceIdentityHash,
        ownerId: this.#ownerId,
        kind: "background",
        acquiredAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + this.#leaseMs).toISOString()
      });
      if (acquired?.ownerId === this.#ownerId && acquired.kind === "background") {
        this.#owned.set(task.id, acquired);
      }
    }
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
      const renewed = this.#store.renewTaskHostLease({
        taskId,
        workspaceIdentityHash: lease.workspaceIdentityHash,
        ownerId: lease.ownerId,
        kind: lease.kind,
        fencingToken: lease.fencingToken,
        heartbeatAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + this.#leaseMs).toISOString()
      });
      if (renewed === null) this.#owned.delete(taskId);
      else this.#owned.set(taskId, renewed);
    }
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
  return "task-executor-host-error";
}
