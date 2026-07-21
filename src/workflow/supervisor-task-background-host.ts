import type { Task, TaskHostLease, TaskWorkspaceBinding } from "../contracts/task.js";
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

const RUNNABLE_TASK_STATUSES: readonly Task["status"][] = [
  "queued",
  "running",
  "waiting_for_host",
  "waiting_for_approval"
];
const EXECUTOR_CREATION_RETRY_MS = 30_000;
const DEFAULT_HOST_LEASE_MS = 30_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000;

export type TaskExecutorHostRuntime = {
  taskAgentExecutor?: AgentStepExecutor;
  dispose(): Promise<void>;
};

type WorkspaceExecutorState = {
  workspace: TaskWorkspaceBinding;
  runtime?: TaskExecutorHostRuntime;
  executor?: AgentStepExecutor;
  creation?: Promise<void>;
  nextCreationAt: number;
};

/**
 * Supervisor-owned Task host. The expensive agent runtime is created only when
 * runnable work exists; delivery recovery remains active from the first tick.
 */
export class SupervisorTaskBackgroundHost {
  readonly #store: TaskStore;
  readonly #host: TaskBackgroundHost;
  readonly #createExecutorRuntime: (workspace: TaskWorkspaceBinding) => Promise<TaskExecutorHostRuntime>;
  readonly #resolveWorkspace: (canonicalPath: string) => Promise<TaskWorkspaceBinding>;
  readonly #isWorkspaceTrusted: (canonicalPath: string) => boolean | Promise<boolean>;
  readonly #logWarning: (message: string) => void;
  readonly #ownerId: string;
  readonly #leaseMs: number;
  readonly #heartbeatIntervalMs: number;
  readonly #now: () => Date;
  readonly #owned = new Map<string, TaskHostLease>();
  readonly #workspaces = new Map<string, WorkspaceExecutorState>();
  readonly #workspaceWarnings = new Set<string>();
  #heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  #disposed = false;

  constructor(options: {
    store: TaskStore;
    resultService: TaskResultService;
    router: TaskCompletionDeliveryRouter;
    ownerId: string;
    resolveWorkspace: (canonicalPath: string) => Promise<TaskWorkspaceBinding>;
    isWorkspaceTrusted: (canonicalPath: string) => boolean | Promise<boolean>;
    createExecutorRuntime: (workspace: TaskWorkspaceBinding) => Promise<TaskExecutorHostRuntime>;
    approvalService?: TaskApprovalService;
    leaseMs?: number;
    heartbeatIntervalMs?: number;
    now?: () => Date;
    logWarning?: (message: string) => void;
  }) {
    this.#store = options.store;
    this.#createExecutorRuntime = options.createExecutorRuntime;
    this.#resolveWorkspace = options.resolveWorkspace;
    this.#isWorkspaceTrusted = options.isWorkspaceTrusted;
    this.#logWarning = options.logWarning ?? (() => undefined);
    this.#ownerId = requireToken(options.ownerId, "background Task host owner ID");
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
      resolveExecutor: (task, step) => {
        const executor = this.#workspaces.get(task.workspace.identityHash)?.executor;
        return executor?.canExecute(task, step) === true
          ? executor
          : undefined;
      }
    });
    const delivery = new TaskCompletionDeliveryService({
      store: options.store,
      resultService: options.resultService,
      router: options.router
    });
    this.#host = new TaskBackgroundHost({
      scheduler: {
        runOnce: async () => {
          await this.#revalidateOwnedWorkspaces();
          this.#renewOwnedTasks();
          await this.#claimAvailableTasks();
          await this.#ensureExecutorsForRunnableWork();
          const result = await scheduler.runOnce({ eligibleTaskIds: this.#eligibleTaskIds() });
          this.#renewOwnedTasks();
          await this.#disposeUnusedWorkspaceRuntimes();
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
    return this.#host.hasPendingWork() || [...this.#workspaces.values()].some((state) => state.creation !== undefined);
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
    await Promise.allSettled([...this.#workspaces.values()].map((state) => state.creation));
    this.#releaseOwnedTasks();
    const runtimes = [...this.#workspaces.values()].map((state) => state.runtime);
    this.#workspaces.clear();
    await Promise.allSettled(runtimes.map((runtime) => runtime?.dispose()));
  }

  async #ensureExecutorsForRunnableWork(): Promise<void> {
    const workspaceIds = new Set([...this.#owned.values()].map((lease) => lease.workspaceIdentityHash));
    await Promise.all([...workspaceIds].map(async (workspaceId) => {
      const state = this.#workspaces.get(workspaceId);
      if (state !== undefined) await this.#ensureWorkspaceExecutor(state);
    }));
  }

  async #ensureWorkspaceExecutor(state: WorkspaceExecutorState): Promise<void> {
    if (this.#disposed || state.executor !== undefined || Date.now() < state.nextCreationAt) return;
    if (state.creation !== undefined) return await state.creation;

    const creation = (async () => {
      let runtime: TaskExecutorHostRuntime | undefined;
      try {
        runtime = await this.#createExecutorRuntime(state.workspace);
        if (runtime.taskAgentExecutor === undefined) {
          await runtime.dispose().catch(() => undefined);
          state.nextCreationAt = Date.now() + EXECUTOR_CREATION_RETRY_MS;
          this.#logWarning("Task executor host unavailable (executor-not-configured).");
          return;
        }
        if (await this.#verifyWorkspace(state.workspace) === undefined) {
          await runtime.dispose().catch(() => undefined);
          this.#releaseWorkspaceOwnership(state.workspace.identityHash);
          this.#workspaces.delete(state.workspace.identityHash);
          return;
        }
        if (this.#disposed) {
          await runtime.dispose().catch(() => undefined);
          return;
        }
        state.runtime = runtime;
        state.executor = runtime.taskAgentExecutor;
      } catch (error) {
        await runtime?.dispose().catch(() => undefined);
        state.nextCreationAt = Date.now() + EXECUTOR_CREATION_RETRY_MS;
        this.#logWarning(`Task executor host unavailable (${errorClass(error)}).`);
      }
    })();
    state.creation = creation;
    await creation;
    if (state.creation === creation) state.creation = undefined;
  }

  #eligibleTaskIds(limit = 1_000): string[] {
    return [...this.#owned.keys()].slice(0, limit);
  }

  async #claimAvailableTasks(): Promise<void> {
    const tasks = this.#store.listTasks({ statuses: RUNNABLE_TASK_STATUSES, limit: 1_000 });
    const verified = new Map<string, Promise<TaskWorkspaceBinding | undefined>>();
    for (const task of tasks) {
      if (this.#owned.has(task.id)) continue;
      const workspaceKey = `${task.workspace.identityHash}:${task.workspace.canonicalPath}`;
      let verification = verified.get(workspaceKey);
      if (verification === undefined) {
        verification = this.#verifyWorkspace(task.workspace);
        verified.set(workspaceKey, verification);
      }
      const workspace = await verification;
      if (workspace === undefined) continue;
      const now = this.#now();
      const acquired = this.#store.acquireTaskHostLease({
        taskId: task.id,
        workspaceIdentityHash: workspace.identityHash,
        ownerId: this.#ownerId,
        kind: "background",
        acquiredAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + this.#leaseMs).toISOString()
      });
      if (acquired?.ownerId === this.#ownerId && acquired.kind === "background") {
        this.#owned.set(task.id, acquired);
        this.#workspaces.set(workspace.identityHash, this.#workspaces.get(workspace.identityHash) ?? {
          workspace,
          nextCreationAt: 0
        });
      }
    }
  }

  async #revalidateOwnedWorkspaces(): Promise<void> {
    for (const [workspaceId, state] of [...this.#workspaces]) {
      if (await this.#verifyWorkspace(state.workspace) !== undefined) continue;
      this.#releaseWorkspaceOwnership(workspaceId);
      this.#workspaces.delete(workspaceId);
      await state.creation?.catch(() => undefined);
      await state.runtime?.dispose().catch(() => undefined);
    }
  }

  #releaseWorkspaceOwnership(workspaceIdentityHash: string): void {
    for (const [taskId, lease] of this.#owned) {
      if (lease.workspaceIdentityHash !== workspaceIdentityHash) continue;
      this.#releaseLease(lease);
      this.#owned.delete(taskId);
    }
  }

  async #verifyWorkspace(workspace: TaskWorkspaceBinding): Promise<TaskWorkspaceBinding | undefined> {
    try {
      const resolved = await this.#resolveWorkspace(workspace.canonicalPath);
      if (resolved.canonicalPath !== workspace.canonicalPath || resolved.identityHash !== workspace.identityHash) {
        this.#warnWorkspaceOnce(workspace.identityHash, "identity-mismatch");
        return undefined;
      }
      if (!await this.#isWorkspaceTrusted(resolved.canonicalPath)) {
        this.#warnWorkspaceOnce(workspace.identityHash, "untrusted");
        return undefined;
      }
      this.#workspaceWarnings.delete(`${workspace.identityHash}:identity-mismatch`);
      this.#workspaceWarnings.delete(`${workspace.identityHash}:untrusted`);
      this.#workspaceWarnings.delete(`${workspace.identityHash}:unavailable`);
      return resolved;
    } catch {
      this.#warnWorkspaceOnce(workspace.identityHash, "unavailable");
      return undefined;
    }
  }

  #warnWorkspaceOnce(workspaceIdentityHash: string, reason: string): void {
    const key = `${workspaceIdentityHash}:${reason}`;
    if (this.#workspaceWarnings.has(key)) return;
    this.#workspaceWarnings.add(key);
    this.#logWarning(`Task workspace is not eligible for background execution (${reason}).`);
  }

  #renewOwnedTasks(): void {
    const now = this.#now();
    for (const [taskId, lease] of this.#owned) {
      const task = this.#store.getTask(taskId);
      if (task === null || task.workspace.identityHash !== lease.workspaceIdentityHash) {
        this.#releaseLease(lease);
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

  async #disposeUnusedWorkspaceRuntimes(): Promise<void> {
    const used = new Set([...this.#owned.values()].map((lease) => lease.workspaceIdentityHash));
    for (const [workspaceId, state] of [...this.#workspaces]) {
      if (used.has(workspaceId) || state.creation !== undefined) continue;
      this.#workspaces.delete(workspaceId);
      await state.runtime?.dispose().catch(() => undefined);
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
