import type { TerminalLifecycle, TerminalLifecycleStopResult } from "./terminalLifecycle.js";

export type SuspendResumeLifecycle = Pick<TerminalLifecycle, "start" | "stop" | "isStarted">;

export type SuspendResult = {
  type: "suspend";
  wasStarted: boolean;
  alreadySuspended: boolean;
  errors: unknown[];
};

export type ResumeResult = {
  type: "resume";
  attempted: boolean;
  started: boolean;
  alreadyRunning: boolean;
  error?: unknown;
};

export type SuspendResumeManager = {
  suspend(): SuspendResult;
  resume(): ResumeResult;
  isSuspended(): boolean;
};

export type SuspendResumeOptions = {
  lifecycle: SuspendResumeLifecycle;
};

export function createSuspendResumeManager(options: SuspendResumeOptions): SuspendResumeManager {
  return new InjectedSuspendResumeManager(options.lifecycle);
}

class InjectedSuspendResumeManager implements SuspendResumeManager {
  readonly #lifecycle: SuspendResumeLifecycle;
  #suspended = false;
  #resumeNeeded = false;

  constructor(lifecycle: SuspendResumeLifecycle) {
    this.#lifecycle = lifecycle;
  }

  suspend(): SuspendResult {
    if (this.#suspended) {
      return {
        type: "suspend",
        wasStarted: this.#resumeNeeded,
        alreadySuspended: true,
        errors: [],
      };
    }

    const wasStarted = this.#lifecycle.isStarted();
    const stopped = this.#stopLifecycle();
    this.#suspended = true;
    this.#resumeNeeded = wasStarted;

    return {
      type: "suspend",
      wasStarted: wasStarted,
      alreadySuspended: false,
      errors: stopped.errors,
    };
  }

  resume(): ResumeResult {
    if (this.#lifecycle.isStarted()) {
      this.#suspended = false;
      this.#resumeNeeded = false;
      return {
        type: "resume",
        attempted: false,
        started: true,
        alreadyRunning: true,
      };
    }

    if (!this.#suspended || !this.#resumeNeeded) {
      this.#suspended = false;
      this.#resumeNeeded = false;
      return {
        type: "resume",
        attempted: false,
        started: false,
        alreadyRunning: false,
      };
    }

    try {
      this.#lifecycle.start();
      this.#suspended = false;
      this.#resumeNeeded = false;
      return {
        type: "resume",
        attempted: true,
        started: this.#lifecycle.isStarted(),
        alreadyRunning: false,
      };
    } catch (error) {
      return {
        type: "resume",
        attempted: true,
        started: false,
        alreadyRunning: false,
        error: error,
      };
    }
  }

  isSuspended(): boolean {
    return this.#suspended;
  }

  #stopLifecycle(): TerminalLifecycleStopResult {
    return this.#lifecycle.stop();
  }
}
