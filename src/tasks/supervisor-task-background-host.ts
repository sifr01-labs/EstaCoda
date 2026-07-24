import type { Task, TaskHostLease, TaskWorkspaceBinding } from "../contracts/task.js";
import { isTerminalTaskStatus } from "../contracts/task.js";
import type { AgentStepExecutor } from "./agent-step-executor.js";
import {
  TaskBackgroundHost,
  type TaskBackgroundHostRunResult,
  type TaskBackgroundHostStatus
} from "./task-background-host.js";
import { TaskCompletionDeliveryService, type TaskCompletionDeliveryRouter } from "./task-completion-delivery.js";
import { TaskScheduler, taskHostDispatchGrant, type TaskSchedulerLimits } from "./task-scheduler.js";
import type { TaskResultService } from "./task-result-service.js";
import { taskListCursor, type TaskStore } from "./task-store.js";
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
  cleanupPending?: boolean;
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
  #claimCursor: ReturnType<typeof taskListCursor> | undefined;
  #dispatchOffset = 0;
  #heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  #disposed = false;
  #disposePromise: Promise<void> | undefined;

  constructor(options: {
    store: TaskStore;
    resultService: TaskResultService;
    router: TaskCompletionDeliveryRouter;
    ownerId: string;
    resolveWorkspace: (canonicalPath: string) => Promise<TaskWorkspaceBinding>;
    isWorkspaceTrusted: (canonicalPath: string) => boolean | Promise<boolean>;
    createExecutorRuntime: (workspace: TaskWorkspaceBinding) => Promise<TaskExecutorHostRuntime>;
    schedulerLimits?: TaskSchedulerLimits;
    approvalService?: TaskApprovalService;
    leaseMs?: number;
    heartbeatIntervalMs?: number;
    now?: () => Date;
    logWarning?: (message: string) => void;
    locale?: "en" | "ar";
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
      limits: options.schedulerLimits,
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
      router: options.router,
      locale: options.locale
    });
    this.#host = new TaskBackgroundHost({
      scheduler: {
        runOnce: async () => {
          await this.#revalidateOwnedWorkspaces();
          this.#renewOwnedTasks();
          await this.#claimAvailableTasks();
          await this.#ensureExecutorsForRunnableWork(
            scheduler.availableProfileDispatchCapacity(),
            scheduler.profileDispatchCapacityLimit()
          );
          const result = await scheduler.runOnce({ dispatchGrants: this.#dispatchGrants() });
          this.#renewOwnedTasks();
          await this.#disposeUnusedWorkspaceRuntimes();
          return result;
        }
      },
      delivery,
      logWarning: this.#logWarning
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
    return this.#host.hasPendingWork() || [...this.#workspaces.values()].some(
      (state) => state.creation !== undefined || state.cleanupPending === true
    );
  }

  waitForIdle(): Promise<void> {
    return this.#host.waitForIdle();
  }

  status(): TaskBackgroundHostStatus {
    return this.#host.status();
  }

  dispose(): Promise<void> {
    if (this.#disposePromise !== undefined) return this.#disposePromise;
    if (this.#disposed && this.#workspaces.size === 0) return Promise.resolve();
    this.#disposed = true;
    if (this.#heartbeatTimer !== undefined) {
      clearInterval(this.#heartbeatTimer);
      this.#heartbeatTimer = undefined;
    }
    const disposal = this.#disposeRetainedResources();
    this.#disposePromise = disposal;
    void disposal.then(
      () => { if (this.#disposePromise === disposal) this.#disposePromise = undefined; },
      () => { if (this.#disposePromise === disposal) this.#disposePromise = undefined; }
    );
    return disposal;
  }

  async #disposeRetainedResources(): Promise<void> {
    await this.#host.waitForIdle().catch(() => undefined);
    await Promise.allSettled([...this.#workspaces.values()].map((state) => state.creation));
    this.#releaseOwnedTasks();
    let failures = 0;
    for (const [workspaceId, state] of [...this.#workspaces]) {
      if (await this.#disposeWorkspaceRuntime(state, "host-shutdown")) this.#workspaces.delete(workspaceId);
      else failures++;
    }
    if (failures > 0) {
      throw new Error(`${failures} Task executor workspace runtime(s) could not be disposed.`);
    }
  }

  async #ensureExecutorsForRunnableWork(availableDispatchCapacity: number, runtimeCapacityLimit: number): Promise<void> {
    const workspaceIds = new Set([...this.#owned.values()].map((lease) => lease.workspaceIdentityHash));
    const states = [...workspaceIds]
      .map((workspaceId) => this.#workspaces.get(workspaceId))
      .filter((state): state is WorkspaceExecutorState => state !== undefined);
    await Promise.all(states.filter((state) => state.cleanupPending === true).map(async (state) => {
      await this.#disposeWorkspaceRuntime(state, "cleanup-retry");
    }));
    const admittedRuntimes = [...this.#workspaces.values()].filter(
      (state) => state.runtime !== undefined || state.creation !== undefined
    ).length;
    const availableCapacity = Math.min(
      availableDispatchCapacity,
      Math.max(0, runtimeCapacityLimit - admittedRuntimes)
    );
    if (availableCapacity <= 0) return;
    const candidates = states.filter((state) =>
      state.runtime === undefined && state.executor === undefined && state.creation === undefined &&
      Date.now() >= state.nextCreationAt
    ).slice(0, availableCapacity);
    await Promise.all(candidates.map((state) => this.#ensureWorkspaceExecutor(state)));
  }

  async #ensureWorkspaceExecutor(state: WorkspaceExecutorState): Promise<void> {
    if (this.#disposed || state.executor !== undefined || state.runtime !== undefined || Date.now() < state.nextCreationAt) return;
    if (state.creation !== undefined) return await state.creation;

    const creation = (async () => {
      let runtime: TaskExecutorHostRuntime | undefined;
      try {
        runtime = await this.#createExecutorRuntime(state.workspace);
        state.runtime = runtime;
        if (runtime.taskAgentExecutor === undefined) {
          await this.#disposeWorkspaceRuntime(state, "executor-not-configured");
          state.nextCreationAt = Date.now() + EXECUTOR_CREATION_RETRY_MS;
          this.#logWarning("Task executor host unavailable (executor-not-configured).");
          return;
        }
        if (await this.#verifyWorkspace(state.workspace) === undefined) {
          const disposed = await this.#disposeWorkspaceRuntime(state, "workspace-ineligible");
          this.#releaseWorkspaceOwnership(state.workspace.identityHash);
          if (disposed) this.#workspaces.delete(state.workspace.identityHash);
          return;
        }
        if (this.#disposed) {
          await this.#disposeWorkspaceRuntime(state, "host-stopped-during-creation");
          return;
        }
        state.executor = runtime.taskAgentExecutor;
      } catch (error) {
        if (runtime !== undefined && state.runtime === undefined) state.runtime = runtime;
        if (state.runtime !== undefined) await this.#disposeWorkspaceRuntime(state, "creation-failed");
        state.nextCreationAt = Date.now() + EXECUTOR_CREATION_RETRY_MS;
        this.#logWarning(`Task executor host unavailable (${errorClass(error)}).`);
      }
    })();
    state.creation = creation;
    await creation;
    if (state.creation === creation) state.creation = undefined;
  }

  #dispatchGrants(limit = 1_000) {
    const leases = [...this.#owned.values()];
    if (leases.length <= limit) return leases.map(taskHostDispatchGrant);
    const start = this.#dispatchOffset % leases.length;
    const selected = [...leases.slice(start), ...leases.slice(0, start)].slice(0, limit);
    this.#dispatchOffset = (start + selected.length) % leases.length;
    return selected.map(taskHostDispatchGrant);
  }

  async #claimAvailableTasks(): Promise<void> {
    const verified = new Map<string, Promise<TaskWorkspaceBinding | undefined>>();
    const tasks = this.#store.listTasks({
      statuses: RUNNABLE_TASK_STATUSES,
      order: "created_asc",
      cursor: this.#claimCursor,
      limit: 1_000
    });
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
    this.#claimCursor = tasks.length < 1_000
      ? undefined
      : taskListCursor(tasks[tasks.length - 1]!, "created_asc");
  }

  async #revalidateOwnedWorkspaces(): Promise<void> {
    for (const [workspaceId, state] of [...this.#workspaces]) {
      if (await this.#verifyWorkspace(state.workspace) !== undefined) continue;
      this.#releaseWorkspaceOwnership(workspaceId);
      await state.creation?.catch(() => undefined);
      if (await this.#disposeWorkspaceRuntime(state, "workspace-revalidation")) {
        this.#workspaces.delete(workspaceId);
      }
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
      if (await this.#disposeWorkspaceRuntime(state, "workspace-unused")) {
        this.#workspaces.delete(workspaceId);
      }
    }
  }

  async #disposeWorkspaceRuntime(state: WorkspaceExecutorState, reason: string): Promise<boolean> {
    const runtime = state.runtime;
    state.executor = undefined;
    if (runtime === undefined) {
      state.cleanupPending = false;
      return true;
    }
    try {
      await runtime.dispose();
      if (state.runtime === runtime) state.runtime = undefined;
      state.cleanupPending = false;
      return true;
    } catch (error) {
      state.cleanupPending = true;
      this.#logWarning(`Task executor runtime disposal failed (${reason}; ${errorClass(error)}).`);
      return false;
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
  const name = error instanceof Error ? error.name.trim() : "";
  if (/^[A-Za-z][A-Za-z0-9._:-]{0,63}$/u.test(name)) return name;
  return "task-executor-host-error";
}
