import type { TaskSchedulerRunResult, WorkflowScheduler } from "./task-scheduler.js";
import type {
  TaskCompletionDeliveryRunResult,
  TaskCompletionDeliveryService
} from "./task-completion-delivery.js";

export type TaskBackgroundHostRunResult = {
  skipped: boolean;
  scheduler?: TaskSchedulerRunResult;
  delivery?: TaskCompletionDeliveryRunResult;
};

export type TaskBackgroundHostStatus = {
  running: boolean;
  runs: number;
  lastStartedAt?: string;
  lastCompletedAt?: string;
  lastErrorClass?: string;
};

/** Long-lived supervisor projection around the deterministic scheduler and delivery outbox. */
export class TaskBackgroundHost {
  readonly #scheduler: Pick<WorkflowScheduler, "runOnce">;
  readonly #delivery: Pick<TaskCompletionDeliveryService, "recoverInterrupted" | "runOnce">;
  readonly #now: () => Date;
  #activeRun: Promise<TaskBackgroundHostRunResult> | undefined;
  #runs = 0;
  #lastStartedAt: string | undefined;
  #lastCompletedAt: string | undefined;
  #lastErrorClass: string | undefined;
  #recovered = false;

  constructor(options: {
    scheduler: Pick<WorkflowScheduler, "runOnce">;
    delivery: Pick<TaskCompletionDeliveryService, "recoverInterrupted" | "runOnce">;
    now?: () => Date;
  }) {
    this.#scheduler = options.scheduler;
    this.#delivery = options.delivery;
    this.#now = options.now ?? (() => new Date());
  }

  runOnce(): Promise<TaskBackgroundHostRunResult> {
    if (this.#activeRun !== undefined) return Promise.resolve({ skipped: true });
    const run = this.#execute();
    this.#activeRun = run;
    void run.then(
      () => { if (this.#activeRun === run) this.#activeRun = undefined; },
      () => { if (this.#activeRun === run) this.#activeRun = undefined; }
    );
    return run;
  }

  hasPendingWork(): boolean {
    return this.#activeRun !== undefined;
  }

  async waitForIdle(): Promise<void> {
    await this.#activeRun;
  }

  status(): TaskBackgroundHostStatus {
    return {
      running: this.#activeRun !== undefined,
      runs: this.#runs,
      ...(this.#lastStartedAt === undefined ? {} : { lastStartedAt: this.#lastStartedAt }),
      ...(this.#lastCompletedAt === undefined ? {} : { lastCompletedAt: this.#lastCompletedAt }),
      ...(this.#lastErrorClass === undefined ? {} : { lastErrorClass: this.#lastErrorClass })
    };
  }

  async #execute(): Promise<TaskBackgroundHostRunResult> {
    this.#lastStartedAt = this.#now().toISOString();
    this.#lastErrorClass = undefined;
    this.#runs++;
    try {
      const recovered = this.#recovered ? 0 : this.#delivery.recoverInterrupted();
      this.#recovered = true;
      const scheduler = await this.#scheduler.runOnce();
      const delivery = await this.#delivery.runOnce();
      delivery.recovered += recovered;
      this.#lastCompletedAt = this.#now().toISOString();
      return { skipped: false, scheduler, delivery };
    } catch (error) {
      this.#lastErrorClass = error instanceof Error && error.name.length > 0 ? error.name : "task-host-error";
      this.#lastCompletedAt = this.#now().toISOString();
      throw error;
    }
  }
}
