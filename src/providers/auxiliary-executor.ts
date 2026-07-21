import { randomUUID } from "node:crypto";
import type {
  AuxiliaryModelTask,
  ProviderErrorClass,
  ProviderFinishReason,
  ProviderReasoningMetadata,
  ProviderRequest,
  ProviderResponse,
  ProviderRoutePreferences,
  ProviderUsage,
  ResolvedAuxiliaryRoute,
  ResolvedModelRoute
} from "../contracts/provider.js";
import type { ProviderUsageContext } from "../contracts/provider-usage.js";
import type { ProviderSpendDenialReason } from "../contracts/provider-spend.js";
import type { ProviderExecutionResult, ProviderExecutor } from "./provider-executor.js";

export type AuxiliaryExecutionAttempt = {
  role: "primary" | "fallback";
  provider: string;
  model: string;
  ok: boolean;
  errorClass?: ProviderErrorClass | "aborted" | "exception" | "spend-denied";
  content: string;
  finishReason?: ProviderFinishReason;
  incompleteReason?: string;
  usage?: ProviderUsage;
  reasoningMetadata?: ProviderReasoningMetadata;
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
  spendDenialReason?: ProviderSpendDenialReason;
};

export type ExecuteAuxiliaryTaskInput = {
  route: ResolvedAuxiliaryRoute;
  mainRoute: ResolvedModelRoute;
  providerExecutor: Pick<ProviderExecutor, "complete">;
  request: Omit<ProviderRequest, "model"> & { model?: string };
  preferences?: ProviderRoutePreferences;
  signal?: AbortSignal;
  scopeKey?: string;
  usage?: Omit<ProviderUsageContext, "requestKey" | "sourceKind" | "auxiliaryKind" | "routeRole" | "routeIndex">;
};

export async function executeAuxiliaryTask(input: ExecuteAuxiliaryTaskInput): Promise<AuxiliaryExecutionResult> {
  const usageKey = `auxiliary:${input.route.task}:${randomUUID()}`;
  const abort = createExecutionAbort({
    signal: input.signal,
    timeoutMs: input.route.timeoutMs
  });

  try {
    if (abort.signal?.aborted === true) {
      return executionAbortResult({
        abort,
        role: "primary",
        route: input.route.route,
        mainRoute: input.mainRoute
      });
    }

    if (input.route.route === undefined) {
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

    const permit = await acquireAuxiliaryPermit({
      task: input.route.task,
      maxConcurrency: input.route.maxConcurrency,
      scopeKey: input.scopeKey,
      abort,
      route: input.route.route,
      mainRoute: input.mainRoute
    });
    if (permit.kind === "interrupted") {
      return permit.result;
    }

    try {
      const primary = await executeRouteAttempt({
        role: "primary",
        providerExecutor: input.providerExecutor,
        request: input.request,
        preferences: input.preferences,
        primaryRoute: input.route.route,
        usage: auxiliaryUsage(input, usageKey, "primary", 0),
        abort
      });

      if (primary.kind !== "result") {
        return failureFromAttemptOutcome(primary, false);
      }

      const primaryAttempts = toAuxiliaryAttempts(primary.result, "primary");
      if (primary.result.spendDenialReason !== undefined) {
        return {
          ok: false,
          status: "failed",
          fallbackUsed: false,
          attempts: primaryAttempts,
          diagnostics: [],
          spendDenialReason: primary.result.spendDenialReason
        };
      }
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
        usage: auxiliaryUsage(input, `${usageKey}:fallback`, "fallback", 1),
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
        diagnostics: [],
        ...(fallback.result.spendDenialReason === undefined
          ? {}
          : { spendDenialReason: fallback.result.spendDenialReason })
      };
    } finally {
      permit.release();
    }
  } finally {
    abort.cleanup();
  }
}

const defaultAuxiliaryScope = "global";

type AuxiliaryPermitOutcome =
  | {
      kind: "acquired";
      release(): void;
    }
  | {
      kind: "interrupted";
      result: AuxiliaryExecutionResult;
    };

type AuxiliaryQueueEntry = {
  maxConcurrency: number;
  settled: boolean;
  resolve(outcome: AuxiliaryPermitOutcome): void;
  cleanup(): void;
};

type AuxiliarySemaphoreState = {
  inFlight: number;
  queue: AuxiliaryQueueEntry[];
};

const auxiliarySemaphores = new Map<string, AuxiliarySemaphoreState>();

export function getAuxiliaryInFlight(task: AuxiliaryModelTask, scopeKey?: string): number {
  return auxiliarySemaphores.get(auxiliarySemaphoreKey(task, scopeKey))?.inFlight ?? 0;
}

export function getAuxiliaryQueued(task: AuxiliaryModelTask, scopeKey?: string): number {
  return auxiliarySemaphores.get(auxiliarySemaphoreKey(task, scopeKey))?.queue.length ?? 0;
}

function acquireAuxiliaryPermit(input: {
  task: AuxiliaryModelTask;
  maxConcurrency?: number;
  scopeKey?: string;
  abort: ExecutionAbort;
  route: ResolvedModelRoute;
  mainRoute: ResolvedModelRoute;
}): Promise<AuxiliaryPermitOutcome> {
  if (input.abort.signal?.aborted === true) {
    return Promise.resolve({
      kind: "interrupted",
      result: executionAbortResult({
        abort: input.abort,
        role: "primary",
        route: input.route,
        mainRoute: input.mainRoute
      })
    });
  }

  const key = auxiliarySemaphoreKey(input.task, input.scopeKey);
  const state = getAuxiliarySemaphoreState(key);
  if (input.maxConcurrency === undefined || input.maxConcurrency <= 0) {
    state.inFlight += 1;
    return Promise.resolve({ kind: "acquired", release: createPermitRelease(key) });
  }
  const maxConcurrency = input.maxConcurrency;

  if (state.inFlight < maxConcurrency) {
    state.inFlight += 1;
    return Promise.resolve({ kind: "acquired", release: createPermitRelease(key) });
  }

  return new Promise((resolve) => {
    let entry: AuxiliaryQueueEntry;
    const cleanup = () => {
      input.abort.signal?.removeEventListener("abort", onAbort);
    };
    const settle = (outcome: AuxiliaryPermitOutcome) => {
      if (entry.settled) return;
      entry.settled = true;
      cleanup();
      resolve(outcome);
    };
    const onAbort = () => {
      const current = auxiliarySemaphores.get(key);
      if (current !== undefined) {
        const index = current.queue.indexOf(entry);
        if (index >= 0) {
          current.queue.splice(index, 1);
        }
        cleanupAuxiliarySemaphore(key, current);
      }
      settle({
        kind: "interrupted",
        result: executionAbortResult({
          abort: input.abort,
          role: "primary",
          route: input.route,
          mainRoute: input.mainRoute
        })
      });
    };

    entry = {
      maxConcurrency,
      settled: false,
      resolve: settle,
      cleanup
    };

    input.abort.signal?.addEventListener("abort", onAbort, { once: true });
    state.queue.push(entry);
  });
}

function releaseAuxiliaryPermit(key: string): void {
  const state = auxiliarySemaphores.get(key);
  if (state === undefined) return;

  state.inFlight = Math.max(0, state.inFlight - 1);
  startQueuedAuxiliaryPermits(key, state);
  cleanupAuxiliarySemaphore(key, state);
}

function startQueuedAuxiliaryPermits(key: string, state: AuxiliarySemaphoreState): void {
  while (state.queue.length > 0) {
    const next = state.queue[0]!;
    if (state.inFlight >= next.maxConcurrency) return;

    state.queue.shift();
    state.inFlight += 1;
    next.resolve({ kind: "acquired", release: createPermitRelease(key) });
  }
}

function createPermitRelease(key: string): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    releaseAuxiliaryPermit(key);
  };
}

function getAuxiliarySemaphoreState(key: string): AuxiliarySemaphoreState {
  let state = auxiliarySemaphores.get(key);
  if (state === undefined) {
    state = { inFlight: 0, queue: [] };
    auxiliarySemaphores.set(key, state);
  }
  return state;
}

function cleanupAuxiliarySemaphore(key: string, state: AuxiliarySemaphoreState): void {
  if (state.inFlight === 0 && state.queue.length === 0) {
    auxiliarySemaphores.delete(key);
  }
}

function auxiliarySemaphoreKey(task: AuxiliaryModelTask, scopeKey: string | undefined): string {
  return `${scopeKey ?? defaultAuxiliaryScope}:${task}`;
}

function executionAbortResult(input: {
  abort: ExecutionAbort;
  role: "primary" | "fallback";
  route: ResolvedModelRoute | undefined;
  mainRoute: ResolvedModelRoute;
}): AuxiliaryExecutionResult {
  const timedOut = input.abort.timedOut;
  return failureFromAttemptOutcome({
    kind: timedOut ? "timeout" : "aborted",
    attempt: syntheticAttempt({
      role: input.role,
      route: input.route,
      mainRoute: input.mainRoute,
      errorClass: timedOut ? "timeout" : "aborted",
      content: timedOut
        ? `Auxiliary task timed out after ${input.abort.timeoutMs}ms`
        : "Auxiliary task was aborted"
    })
  }, false);
}

async function executeRouteAttempt(input: {
  role: "primary" | "fallback";
  providerExecutor: Pick<ProviderExecutor, "complete">;
  request: Omit<ProviderRequest, "model"> & { model?: string };
  preferences?: ProviderRoutePreferences;
  primaryRoute: ResolvedModelRoute;
  usage: ProviderUsageContext;
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
      { primaryRoute: input.primaryRoute, signal: input.abort.signal, usage: input.usage }
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

function auxiliaryUsage(
  input: ExecuteAuxiliaryTaskInput,
  requestKey: string,
  routeRole: "primary" | "fallback",
  routeIndex: number
): ProviderUsageContext {
  return {
    requestKey,
    sourceKind: "auxiliary",
    auxiliaryKind: input.route.task,
    routeRole,
    routeIndex,
    ...(input.usage ?? {})
  };
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
  timeoutPromise.catch(() => {});

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
    content: attempt.content,
    finishReason: attempt.finishReason,
    incompleteReason: attempt.incompleteReason,
    usage: attempt.usage,
    reasoningMetadata: attempt.reasoningMetadata
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
