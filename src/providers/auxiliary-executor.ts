import type {
  ProviderErrorClass,
  ProviderRequest,
  ProviderResponse,
  ProviderRoutePreferences,
  ResolvedAuxiliaryRoute,
  ResolvedModelRoute
} from "../contracts/provider.js";
import type { ProviderExecutionResult, ProviderExecutor } from "./provider-executor.js";

export type AuxiliaryExecutionAttempt = {
  role: "primary" | "fallback";
  provider: string;
  model: string;
  ok: boolean;
  errorClass?: ProviderErrorClass | "aborted" | "exception";
  content: string;
};

export type AuxiliaryExecutionStatus =
  | "ok"
  | "unavailable"
  | "failed"
  | "timeout"
  | "aborted"
  | "exception";

export type AuxiliaryExecutionResult = {
  ok: boolean;
  status: AuxiliaryExecutionStatus;
  response?: ProviderResponse;
  fallbackUsed: boolean;
  attempts: AuxiliaryExecutionAttempt[];
  diagnostics: string[];
};

export type ExecuteAuxiliaryTaskInput = {
  route: ResolvedAuxiliaryRoute;
  mainRoute: ResolvedModelRoute;
  providerExecutor: Pick<ProviderExecutor, "complete">;
  request: Omit<ProviderRequest, "model"> & { model?: string };
  preferences?: ProviderRoutePreferences;
  signal?: AbortSignal;
};

export async function executeAuxiliaryTask(input: ExecuteAuxiliaryTaskInput): Promise<AuxiliaryExecutionResult> {
  const abort = createExecutionAbort({
    signal: input.signal,
    timeoutMs: input.route.timeoutMs
  });

  if (abort.signal?.aborted === true) {
    return failureFromAttemptOutcome({
      kind: "aborted",
      attempt: syntheticAttempt({
        role: "primary",
        route: input.route.route,
        mainRoute: input.mainRoute,
        errorClass: "aborted",
        content: "Auxiliary task was aborted"
      })
    }, false);
  }

  if (input.route.route === undefined) {
    abort.cleanup();
    return {
      ok: false,
      status: "unavailable",
      fallbackUsed: false,
      attempts: [],
      diagnostics: [
        `Auxiliary route ${input.route.task} is unavailable`,
        ...input.route.diagnostics
      ]
    };
  }

  try {
    const primary = await executeRouteAttempt({
      role: "primary",
      providerExecutor: input.providerExecutor,
      request: input.request,
      preferences: input.preferences,
      primaryRoute: input.route.route,
      abort
    });

    if (primary.kind !== "result") {
      return failureFromAttemptOutcome(primary, false);
    }

    const primaryAttempts = toAuxiliaryAttempts(primary.result, "primary");
    if (primary.result.ok) {
      return {
        ok: true,
        status: "ok",
        response: primary.result.response,
        fallbackUsed: false,
        attempts: primaryAttempts,
        diagnostics: []
      };
    }

    if (
      input.route.fallbackToMain !== true ||
      sameRoute(input.route.route, input.mainRoute)
    ) {
      return {
        ok: false,
        status: "failed",
        fallbackUsed: false,
        attempts: primaryAttempts,
        diagnostics: []
      };
    }

    const fallback = await executeRouteAttempt({
      role: "fallback",
      providerExecutor: input.providerExecutor,
      request: input.request,
      preferences: input.preferences,
      primaryRoute: input.mainRoute,
      abort
    });

    if (fallback.kind !== "result") {
      return failureFromAttemptOutcome(fallback, primaryAttempts.length > 0, primaryAttempts);
    }

    const fallbackAttempts = toAuxiliaryAttempts(fallback.result, "fallback");
    return {
      ok: fallback.result.ok,
      status: fallback.result.ok ? "ok" : "failed",
      response: fallback.result.response,
      fallbackUsed: true,
      attempts: [...primaryAttempts, ...fallbackAttempts],
      diagnostics: []
    };
  } finally {
    abort.cleanup();
  }
}

async function executeRouteAttempt(input: {
  role: "primary" | "fallback";
  providerExecutor: Pick<ProviderExecutor, "complete">;
  request: Omit<ProviderRequest, "model"> & { model?: string };
  preferences?: ProviderRoutePreferences;
  primaryRoute: ResolvedModelRoute;
  abort: ExecutionAbort;
}): Promise<
  | { kind: "result"; result: ProviderExecutionResult }
  | { kind: "timeout"; attempt: AuxiliaryExecutionAttempt }
  | { kind: "aborted"; attempt: AuxiliaryExecutionAttempt }
  | { kind: "exception"; attempt: AuxiliaryExecutionAttempt }
> {
  if (input.abort.signal?.aborted === true) {
    return {
      kind: input.abort.timedOut ? "timeout" : "aborted",
      attempt: syntheticAttempt({
        role: input.role,
        route: input.primaryRoute,
        errorClass: input.abort.timedOut ? "timeout" : "aborted",
        content: input.abort.timedOut
          ? `Auxiliary task timed out after ${input.abort.timeoutMs}ms`
          : "Auxiliary task was aborted"
      })
    };
  }

  try {
    const execution = input.providerExecutor.complete(
      input.request,
      input.preferences ?? {},
      { primaryRoute: input.primaryRoute, signal: input.abort.signal }
    );
    const result = await input.abort.race(execution);
    return { kind: "result", result };
  } catch (error) {
    if (input.abort.timedOut) {
      return {
        kind: "timeout",
        attempt: syntheticAttempt({
          role: input.role,
          route: input.primaryRoute,
          errorClass: "timeout",
          content: `Auxiliary task timed out after ${input.abort.timeoutMs}ms`
        })
      };
    }

    if (isAbortError(error) || isSignalAborted(input.abort.signal)) {
      return {
        kind: "aborted",
        attempt: syntheticAttempt({
          role: input.role,
          route: input.primaryRoute,
          errorClass: "aborted",
          content: "Auxiliary task was aborted"
        })
      };
    }

    return {
      kind: "exception",
      attempt: syntheticAttempt({
        role: input.role,
        route: input.primaryRoute,
        errorClass: "exception",
        content: error instanceof Error ? error.message : String(error)
      })
    };
  }
}

type ExecutionAbort = {
  signal?: AbortSignal;
  timedOut: boolean;
  timeoutMs?: number;
  race<T>(promise: Promise<T>): Promise<T>;
  cleanup(): void;
};

function createExecutionAbort(input: {
  signal?: AbortSignal;
  timeoutMs?: number;
}): ExecutionAbort {
  if (input.signal !== undefined || input.timeoutMs === undefined || input.timeoutMs <= 0) {
    return {
      signal: input.signal,
      timedOut: false,
      race: (promise) => promise,
      cleanup: () => {}
    };
  }

  const controller = new AbortController();
  let timedOut = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error(`Timed out after ${input.timeoutMs}ms`));
      reject(new Error(`Timed out after ${input.timeoutMs}ms`));
    }, input.timeoutMs);
  });

  return {
    signal: controller.signal,
    get timedOut() {
      return timedOut;
    },
    timeoutMs: input.timeoutMs,
    race: (promise) => Promise.race([promise, timeoutPromise]),
    cleanup: () => {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
    }
  };
}

function failureFromAttemptOutcome(
  outcome:
    | { kind: "timeout"; attempt: AuxiliaryExecutionAttempt }
    | { kind: "aborted"; attempt: AuxiliaryExecutionAttempt }
    | { kind: "exception"; attempt: AuxiliaryExecutionAttempt },
  fallbackUsed: boolean,
  previousAttempts: AuxiliaryExecutionAttempt[] = []
): AuxiliaryExecutionResult {
  return {
    ok: false,
    status: outcome.kind,
    fallbackUsed,
    attempts: [...previousAttempts, outcome.attempt],
    diagnostics: []
  };
}

function toAuxiliaryAttempts(result: ProviderExecutionResult, role: "primary" | "fallback"): AuxiliaryExecutionAttempt[] {
  return result.attempts.map((attempt) => ({
    role,
    provider: attempt.provider,
    model: attempt.model,
    ok: attempt.ok,
    errorClass: attempt.errorClass as ProviderErrorClass | undefined,
    content: attempt.content
  }));
}

function sameRoute(left: ResolvedModelRoute, right: ResolvedModelRoute): boolean {
  return left.provider === right.provider &&
    left.id === right.id &&
    left.baseUrl === right.baseUrl;
}

function syntheticAttempt(input: {
  role: "primary" | "fallback";
  route: ResolvedModelRoute | undefined;
  mainRoute?: ResolvedModelRoute;
  errorClass: AuxiliaryExecutionAttempt["errorClass"];
  content: string;
}): AuxiliaryExecutionAttempt {
  const route = input.route ?? input.mainRoute;
  return {
    role: input.role,
    provider: route?.provider ?? "none",
    model: route?.id ?? "none",
    ok: false,
    errorClass: input.errorClass,
    content: input.content
  };
}

function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "AbortError" || error.message.toLowerCase().includes("abort");
}

function isSignalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}
