import type { Task } from "../contracts/task.js";
import type { AgentStepExecutor } from "./agent-step-executor.js";
import {
  TaskBackgroundHost,
  type TaskBackgroundHostRunResult,
  type TaskBackgroundHostStatus
} from "./task-background-host.js";
import { TaskCompletionDeliveryService, type TaskCompletionDeliveryRouter } from "./task-completion-delivery.js";
import { WorkflowScheduler } from "./task-scheduler.js";
import type { TaskResultService } from "./task-result-service.js";
import type { TaskStore } from "./task-store.js";

const RUNNABLE_TASK_STATUSES: readonly Task["status"][] = ["queued", "running", "waiting_for_host"];
const EXECUTOR_CREATION_RETRY_MS = 30_000;

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
  #executorRuntime: TaskExecutorHostRuntime | undefined;
  #executor: AgentStepExecutor | undefined;
  #executorCreation: Promise<void> | undefined;
  #nextExecutorCreationAt = 0;
  #disposed = false;

  constructor(options: {
    store: TaskStore;
    resultService: TaskResultService;
    router: TaskCompletionDeliveryRouter;
    ownerId: string;
    createExecutorRuntime: () => Promise<TaskExecutorHostRuntime>;
    logWarning?: (message: string) => void;
  }) {
    this.#store = options.store;
    this.#createExecutorRuntime = options.createExecutorRuntime;
    this.#logWarning = options.logWarning ?? (() => undefined);
    const scheduler = new WorkflowScheduler({
      store: options.store,
      resultService: options.resultService,
      ownerId: options.ownerId,
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
          await this.#ensureExecutorForRunnableWork();
          return await scheduler.runOnce();
        }
      },
      delivery
    });
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
    await this.#host.waitForIdle().catch(() => undefined);
    await this.#executorCreation?.catch(() => undefined);
    const runtime = this.#executorRuntime;
    this.#executorRuntime = undefined;
    this.#executor = undefined;
    await runtime?.dispose().catch(() => undefined);
  }

  async #ensureExecutorForRunnableWork(): Promise<void> {
    if (this.#disposed || this.#executor !== undefined || Date.now() < this.#nextExecutorCreationAt) return;
    if (this.#store.listTasks({ statuses: RUNNABLE_TASK_STATUSES, limit: 1 }).length === 0) return;
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
}

function errorClass(error: unknown): string {
  if (error instanceof Error && error.name.trim().length > 0) return error.name;
  return "task-executor-host-error";
}
