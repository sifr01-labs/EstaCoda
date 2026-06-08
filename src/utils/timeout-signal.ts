export type TimeoutKind = "total" | "stale";

export type TimeoutSignalController = {
  signal: AbortSignal;
  markProgress(): void;
  disableStale(): void;
  timedOut(): boolean;
  timeoutKind(): TimeoutKind | undefined;
  classify(error: unknown): "timeout" | undefined;
  cleanup(): void;
};

export function createTimeoutSignal(options: {
  timeoutMs: number;
  staleTimeoutMs?: number;
  parentSignal?: AbortSignal;
  timeoutMessage?: string;
  staleTimeoutMessage?: string;
}): TimeoutSignalController {
  const controller = new AbortController();
  let timeoutKind: TimeoutKind | undefined;
  let totalTimer: ReturnType<typeof setTimeout> | undefined;
  let staleTimer: ReturnType<typeof setTimeout> | undefined;
  let staleDisabled = false;

  const abortForTimeout = (kind: TimeoutKind, message: string) => {
    if (controller.signal.aborted) {
      return;
    }
    timeoutKind = kind;
    controller.abort(createTimeoutAbortReason(message));
  };

  const clearStaleTimer = () => {
    if (staleTimer !== undefined) {
      clearTimeout(staleTimer);
      staleTimer = undefined;
    }
  };

  const resetStaleTimer = () => {
    if (staleDisabled || options.staleTimeoutMs === undefined || options.staleTimeoutMs <= 0 || controller.signal.aborted) {
      return;
    }
    clearStaleTimer();
    staleTimer = setTimeout(
      () => abortForTimeout("stale", options.staleTimeoutMessage ?? `No progress for ${options.staleTimeoutMs}ms`),
      options.staleTimeoutMs
    );
  };

  const abortFromParent = () => {
    if (controller.signal.aborted) {
      return;
    }
    controller.abort(options.parentSignal?.reason);
  };

  if (options.timeoutMs > 0) {
    totalTimer = setTimeout(
      () => abortForTimeout("total", options.timeoutMessage ?? `Timed out after ${options.timeoutMs}ms`),
      options.timeoutMs
    );
  }
  resetStaleTimer();

  if (options.parentSignal?.aborted === true) {
    abortFromParent();
  } else {
    options.parentSignal?.addEventListener("abort", abortFromParent, { once: true });
  }

  return {
    signal: controller.signal,
    markProgress() {
      resetStaleTimer();
    },
    disableStale() {
      staleDisabled = true;
      clearStaleTimer();
    },
    timedOut() {
      return timeoutKind !== undefined;
    },
    timeoutKind() {
      return timeoutKind;
    },
    classify(_error: unknown) {
      return timeoutKind === undefined ? undefined : "timeout";
    },
    cleanup() {
      if (totalTimer !== undefined) {
        clearTimeout(totalTimer);
        totalTimer = undefined;
      }
      clearStaleTimer();
      options.parentSignal?.removeEventListener("abort", abortFromParent);
    }
  };
}

function createTimeoutAbortReason(message: string): Error | DOMException {
  if (typeof DOMException === "function") {
    return new DOMException(message, "TimeoutError");
  }
  return new Error(message);
}
