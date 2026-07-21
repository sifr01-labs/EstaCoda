import { describe, expect, it, vi } from "vitest";
import type {
  ModelProfile,
  ProviderRequest,
  ResolvedAuxiliaryRoute,
  ResolvedModelRoute
} from "../contracts/provider.js";
import type { ProviderExecutionResult } from "./provider-executor.js";
import {
  executeAuxiliaryTask,
  getAuxiliaryInFlight,
  getAuxiliaryQueued
} from "./auxiliary-executor.js";

function fakeProfile(overrides?: Partial<ModelProfile>): ModelProfile {
  return {
    id: "gpt-4.1-mini",
    provider: "openai",
    contextWindowTokens: 128_000,
    supportsTools: true,
    supportsVision: true,
    supportsStructuredOutput: true,
    ...overrides,
  };
}

function fakeRoute(overrides?: Partial<ResolvedModelRoute>): ResolvedModelRoute {
  return {
    provider: "openai",
    id: "gpt-4.1-mini",
    profile: fakeProfile(),
    ...overrides,
  };
}

function fakeAuxiliaryRoute(overrides?: Partial<ResolvedAuxiliaryRoute>): ResolvedAuxiliaryRoute {
  return {
    task: "compression",
    route: fakeRoute(),
    source: "explicit",
    fallbackToMain: false,
    diagnostics: [],
    ...overrides,
  };
}

function executionResult(route: ResolvedModelRoute, ok: boolean, content = ok ? "done" : "failed"): ProviderExecutionResult {
  return {
    ok,
    response: ok
      ? {
        ok: true,
        content,
        provider: route.provider,
        model: route.id,
      }
      : undefined,
    fallbackUsed: false,
    attempts: [
      {
        provider: route.provider,
        model: route.id,
        state: "dispatched",
        dispatchedAt: "2030-01-01T00:00:00.000Z",
        ok,
        errorClass: ok ? undefined : "server",
        content,
      }
    ],
    toolCalls: [],
  };
}

const request: Omit<ProviderRequest, "model"> & { model?: string } = {
  messages: [{ role: "user", content: "Summarize this." }]
};

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("executeAuxiliaryTask", () => {
  it("returns structured unavailable when route.route is undefined", async () => {
    const result = await executeAuxiliaryTask({
      route: fakeAuxiliaryRoute({ route: undefined, diagnostics: ["No configured model matches"] }),
      mainRoute: fakeRoute({ id: "gpt-4o" }),
      providerExecutor: { complete: vi.fn() },
      request,
    });

    expect(result).toMatchObject({
      ok: false,
      status: "unavailable",
      fallbackUsed: false,
      attempts: [],
    });
    expect(result.diagnostics).toContain("No configured model matches");
  });

  it("executes the primary route through ProviderExecutor.complete", async () => {
    const route = fakeRoute({ provider: "openai", id: "gpt-4.1-mini" });
    const complete = vi.fn(async (_request, _preferences, _options) => executionResult(route, true, "primary ok"));

    const result = await executeAuxiliaryTask({
      route: fakeAuxiliaryRoute({ route }),
      mainRoute: fakeRoute({ id: "gpt-4o" }),
      providerExecutor: { complete },
      request,
    });

    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete.mock.calls[0]![2]!.primaryRoute).toEqual(route);
    expect(result.ok).toBe(true);
    expect(result.attempts).toEqual([
      { role: "primary", provider: "openai", model: "gpt-4.1-mini", ok: true, errorClass: undefined, content: "primary ok" }
    ]);
  });

  it("preserves safe provider final-state metadata without copying raw reasoning", async () => {
    const route = fakeRoute({ provider: "openai", id: "gpt-4.1-mini" });
    const providerResult = executionResult(route, true, "primary ok");
    providerResult.response = {
      ok: true,
      content: "primary ok",
      provider: route.provider,
      model: route.id,
      finishReason: "length",
      incompleteReason: "max_output_tokens",
      usage: {
        inputTokens: 12,
        outputTokens: 6,
        totalTokens: 18,
        reasoningTokens: 4
      },
      reasoning: "hidden auxiliary reasoning",
      reasoningMetadata: {
        present: true,
        chars: 26,
        format: "reasoning_content"
      }
    };
    providerResult.attempts[0] = {
      ...providerResult.attempts[0],
      finishReason: "length",
      incompleteReason: "max_output_tokens",
      usage: {
        inputTokens: 12,
        outputTokens: 6,
        totalTokens: 18,
        reasoningTokens: 4
      },
      reasoningMetadata: {
        present: true,
        chars: 26,
        format: "reasoning_content"
      },
      reasoning: "hidden auxiliary reasoning"
    } as typeof providerResult.attempts[number] & { reasoning: string };
    const complete = vi.fn(async () => providerResult);

    const result = await executeAuxiliaryTask({
      route: fakeAuxiliaryRoute({ route }),
      mainRoute: fakeRoute({ id: "gpt-4o" }),
      providerExecutor: { complete },
      request,
    });

    expect(result.ok).toBe(true);
    expect(result.attempts[0]).toEqual(expect.objectContaining({
      finishReason: "length",
      incompleteReason: "max_output_tokens",
      usage: {
        inputTokens: 12,
        outputTokens: 6,
        totalTokens: 18,
        reasoningTokens: 4
      },
      reasoningMetadata: {
        present: true,
        chars: 26,
        format: "reasoning_content"
      }
    }));
    expect(result.attempts[0]).not.toHaveProperty("reasoning");
    expect(JSON.stringify(result.attempts)).not.toContain("hidden auxiliary reasoning");
  });

  it("falls back to mainRoute only when fallbackToMain is true", async () => {
    const route = fakeRoute({ id: "gpt-4.1-mini" });
    const mainRoute = fakeRoute({ id: "gpt-4o" });
    const complete = vi.fn(async (_request, _preferences, options) =>
      options.primaryRoute.id === route.id
        ? executionResult(route, false, "primary failed")
        : executionResult(mainRoute, true, "main ok")
    );

    const result = await executeAuxiliaryTask({
      route: fakeAuxiliaryRoute({ route, fallbackToMain: true }),
      mainRoute,
      providerExecutor: { complete },
      request,
    });

    expect(complete).toHaveBeenCalledTimes(2);
    expect(complete.mock.calls[0]![2]!.primaryRoute).toEqual(route);
    expect(complete.mock.calls[1]![2]!.primaryRoute).toEqual(mainRoute);
    expect(result.ok).toBe(true);
    expect(result.fallbackUsed).toBe(true);
    expect(result.attempts.map((attempt) => attempt.role)).toEqual(["primary", "fallback"]);
    expect(result.attempts.map((attempt) => attempt.content)).toEqual(["primary failed", "main ok"]);
  });

  it("does not fall back when fallbackToMain is false", async () => {
    const route = fakeRoute({ id: "gpt-4.1-mini" });
    const complete = vi.fn(async () => executionResult(route, false, "primary failed"));

    const result = await executeAuxiliaryTask({
      route: fakeAuxiliaryRoute({ route, fallbackToMain: false }),
      mainRoute: fakeRoute({ id: "gpt-4o" }),
      providerExecutor: { complete },
      request,
    });

    expect(complete).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
    expect(result.status).toBe("failed");
    expect(result.fallbackUsed).toBe(false);
  });

  it("never double-calls main when primary route already equals main", async () => {
    const mainRoute = fakeRoute({ id: "gpt-4o" });
    const complete = vi.fn(async () => executionResult(mainRoute, false, "main failed"));

    const result = await executeAuxiliaryTask({
      route: fakeAuxiliaryRoute({ route: mainRoute, source: "main", fallbackToMain: true }),
      mainRoute,
      providerExecutor: { complete },
      request,
    });

    expect(complete).toHaveBeenCalledTimes(1);
    expect(result.fallbackUsed).toBe(false);
  });

  it("does not fallback-call main when primary matches main except apiKeyEnv", async () => {
    const mainRoute = fakeRoute({ id: "gpt-4o", baseUrl: "https://api.openai.com/v1", apiKeyEnv: "OPENAI_API_KEY" });
    const primaryRoute = fakeRoute({ id: "gpt-4o", baseUrl: "https://api.openai.com/v1", apiKeyEnv: "ALT_OPENAI_KEY" });
    const complete = vi.fn(async () => executionResult(primaryRoute, false, "main failed"));

    const result = await executeAuxiliaryTask({
      route: fakeAuxiliaryRoute({ route: primaryRoute, source: "main", fallbackToMain: true }),
      mainRoute,
      providerExecutor: { complete },
      request,
    });

    expect(complete).toHaveBeenCalledTimes(1);
    expect(result.fallbackUsed).toBe(false);
  });

  it("converts thrown provider errors into structured exception failures", async () => {
    const route = fakeRoute();
    const complete = vi.fn(async () => {
      throw new Error("provider exploded");
    });

    const result = await executeAuxiliaryTask({
      route: fakeAuxiliaryRoute({ route }),
      mainRoute: fakeRoute({ id: "gpt-4o" }),
      providerExecutor: { complete },
      request,
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe("exception");
    expect(result.attempts).toEqual([
      { role: "primary", provider: "openai", model: "gpt-4.1-mini", ok: false, errorClass: "exception", content: "provider exploded" }
    ]);
  });

  it("returns aborted without calling provider when external signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const complete = vi.fn(async () => executionResult(fakeRoute(), true));

    const result = await executeAuxiliaryTask({
      route: fakeAuxiliaryRoute({ route: fakeRoute() }),
      mainRoute: fakeRoute({ id: "gpt-4o" }),
      providerExecutor: { complete },
      request,
      signal: controller.signal,
    });

    expect(complete).not.toHaveBeenCalled();
    expect(result.status).toBe("aborted");
    expect(result.attempts[0]).toMatchObject({ role: "primary", errorClass: "aborted" });
  });

  it("honors timeoutMs with a local abort race when no external signal is provided", async () => {
    const route = fakeRoute();
    let observedSignal: AbortSignal | undefined;
    const complete = vi.fn((_request, _preferences, options) => {
      observedSignal = options.signal;
      return new Promise<ProviderExecutionResult>(() => {});
    });

    const result = await executeAuxiliaryTask({
      route: fakeAuxiliaryRoute({ route, timeoutMs: 5 }),
      mainRoute: fakeRoute({ id: "gpt-4o" }),
      providerExecutor: { complete },
      request,
    });

    expect(result.status).toBe("timeout");
    expect(result.attempts[0]).toMatchObject({ role: "primary", ok: false, errorClass: "timeout" });
    expect(observedSignal?.aborted).toBe(true);
  });

  it("uses one timeout budget across primary and fallback", async () => {
    const route = fakeRoute({ id: "gpt-4.1-mini" });
    const mainRoute = fakeRoute({ id: "gpt-4o" });
    const complete = vi.fn(async (_request, _preferences, options) => {
      if (options.primaryRoute.id === route.id) {
        await new Promise((resolve) => setTimeout(resolve, 8));
        return executionResult(route, false, "primary failed");
      }
      return new Promise<ProviderExecutionResult>(() => {});
    });

    const result = await executeAuxiliaryTask({
      route: fakeAuxiliaryRoute({ route, fallbackToMain: true, timeoutMs: 12 }),
      mainRoute,
      providerExecutor: { complete },
      request,
    });

    expect(complete).toHaveBeenCalledTimes(2);
    expect(result.status).toBe("timeout");
    expect(result.fallbackUsed).toBe(true);
    expect(result.attempts.map((attempt) => attempt.role)).toEqual(["primary", "fallback"]);
    expect(result.attempts[1]).toMatchObject({ errorClass: "timeout" });
  });

  it("does not create an internal timeout for timeoutMs zero", async () => {
    const route = fakeRoute();
    let observedSignal: AbortSignal | undefined;
    const complete = vi.fn(async (_request, _preferences, options) => {
      observedSignal = options.signal;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return executionResult(route, true, "no timeout");
    });

    const result = await executeAuxiliaryTask({
      route: fakeAuxiliaryRoute({ route, timeoutMs: 0 }),
      mainRoute: fakeRoute({ id: "gpt-4o" }),
      providerExecutor: { complete },
      request,
    });

    expect(result.status).toBe("ok");
    expect(observedSignal).toBeUndefined();
  });

  it("does not create an internal timeout for negative timeoutMs", async () => {
    const route = fakeRoute();
    let observedSignal: AbortSignal | undefined;
    const complete = vi.fn(async (_request, _preferences, options) => {
      observedSignal = options.signal;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return executionResult(route, true, "no timeout");
    });

    const result = await executeAuxiliaryTask({
      route: fakeAuxiliaryRoute({ route, timeoutMs: -1 }),
      mainRoute: fakeRoute({ id: "gpt-4o" }),
      providerExecutor: { complete },
      request,
    });

    expect(result.status).toBe("ok");
    expect(observedSignal).toBeUndefined();
  });

  it("uses an external AbortSignal and does not create an internal timeout", async () => {
    const route = fakeRoute();
    const controller = new AbortController();
    let observedSignal: AbortSignal | undefined;
    const complete = vi.fn(async (_request, _preferences, options) => {
      observedSignal = options.signal;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return executionResult(route, true, "external signal ok");
    });

    const result = await executeAuxiliaryTask({
      route: fakeAuxiliaryRoute({ route, timeoutMs: 1 }),
      mainRoute: fakeRoute({ id: "gpt-4o" }),
      providerExecutor: { complete },
      request,
      signal: controller.signal,
    });

    expect(result.status).toBe("ok");
    expect(observedSignal).toBe(controller.signal);
  });

  it("distinguishes external aborts from timeouts and exceptions", async () => {
    const route = fakeRoute();
    const controller = new AbortController();
    const complete = vi.fn(async () => {
      controller.abort();
      throw new Error("aborted by caller");
    });

    const result = await executeAuxiliaryTask({
      route: fakeAuxiliaryRoute({ route }),
      mainRoute: fakeRoute({ id: "gpt-4o" }),
      providerExecutor: { complete },
      request,
      signal: controller.signal,
    });

    expect(result.status).toBe("aborted");
    expect(result.attempts[0]).toMatchObject({ role: "primary", errorClass: "aborted" });
  });

  it("increments and decrements the in-flight counter while a limited task runs", async () => {
    const route = fakeRoute();
    const scopeKey = "in-flight-counter";
    const pending = deferred<ProviderExecutionResult>();
    const complete = vi.fn(() => pending.promise);

    const run = executeAuxiliaryTask({
      route: fakeAuxiliaryRoute({ route, maxConcurrency: 1 }),
      mainRoute: fakeRoute({ id: "gpt-4o" }),
      providerExecutor: { complete },
      request,
      scopeKey,
    });
    await flushMicrotasks();

    expect(getAuxiliaryInFlight("compression", scopeKey)).toBe(1);
    pending.resolve(executionResult(route, true, "done"));
    await run;
    expect(getAuxiliaryInFlight("compression", scopeKey)).toBe(0);
  });

  it("queues when maxConcurrency is reached and reports queued count", async () => {
    const route = fakeRoute();
    const scopeKey = "queue-count";
    const first = deferred<ProviderExecutionResult>();
    const second = deferred<ProviderExecutionResult>();
    const complete = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);

    const firstRun = executeAuxiliaryTask({
      route: fakeAuxiliaryRoute({ route, maxConcurrency: 1 }),
      mainRoute: fakeRoute({ id: "gpt-4o" }),
      providerExecutor: { complete },
      request,
      scopeKey,
    });
    await flushMicrotasks();

    const secondRun = executeAuxiliaryTask({
      route: fakeAuxiliaryRoute({ route, maxConcurrency: 1 }),
      mainRoute: fakeRoute({ id: "gpt-4o" }),
      providerExecutor: { complete },
      request,
      scopeKey,
    });
    await flushMicrotasks();

    expect(complete).toHaveBeenCalledTimes(1);
    expect(getAuxiliaryInFlight("compression", scopeKey)).toBe(1);
    expect(getAuxiliaryQueued("compression", scopeKey)).toBe(1);

    first.resolve(executionResult(route, true, "first"));
    await flushMicrotasks();
    expect(complete).toHaveBeenCalledTimes(2);
    expect(getAuxiliaryQueued("compression", scopeKey)).toBe(0);

    second.resolve(executionResult(route, true, "second"));
    await Promise.all([firstRun, secondRun]);
    expect(getAuxiliaryInFlight("compression", scopeKey)).toBe(0);
  });

  it("starts a queued request only after the first request releases", async () => {
    const route = fakeRoute();
    const scopeKey = "queued-start";
    const first = deferred<ProviderExecutionResult>();
    const second = deferred<ProviderExecutionResult>();
    const complete = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);

    const firstRun = executeAuxiliaryTask({
      route: fakeAuxiliaryRoute({ route, maxConcurrency: 1 }),
      mainRoute: fakeRoute({ id: "gpt-4o" }),
      providerExecutor: { complete },
      request,
      scopeKey,
    });
    const secondRun = executeAuxiliaryTask({
      route: fakeAuxiliaryRoute({ route, maxConcurrency: 1 }),
      mainRoute: fakeRoute({ id: "gpt-4o" }),
      providerExecutor: { complete },
      request,
      scopeKey,
    });
    await flushMicrotasks();

    expect(complete).toHaveBeenCalledTimes(1);
    first.resolve(executionResult(route, true, "first"));
    await flushMicrotasks();
    expect(complete).toHaveBeenCalledTimes(2);

    second.resolve(executionResult(route, true, "second"));
    await Promise.all([firstRun, secondRun]);
  });

  it("allows a queued request to be aborted before it starts", async () => {
    const route = fakeRoute();
    const scopeKey = "queued-abort";
    const first = deferred<ProviderExecutionResult>();
    const complete = vi.fn(() => first.promise);
    const controller = new AbortController();

    const firstRun = executeAuxiliaryTask({
      route: fakeAuxiliaryRoute({ route, maxConcurrency: 1 }),
      mainRoute: fakeRoute({ id: "gpt-4o" }),
      providerExecutor: { complete },
      request,
      scopeKey,
    });
    await flushMicrotasks();
    const queuedRun = executeAuxiliaryTask({
      route: fakeAuxiliaryRoute({ route, maxConcurrency: 1 }),
      mainRoute: fakeRoute({ id: "gpt-4o" }),
      providerExecutor: { complete },
      request,
      scopeKey,
      signal: controller.signal,
    });
    await flushMicrotasks();

    expect(getAuxiliaryQueued("compression", scopeKey)).toBe(1);
    controller.abort();
    const queuedResult = await queuedRun;

    expect(queuedResult.status).toBe("aborted");
    expect(complete).toHaveBeenCalledTimes(1);
    expect(getAuxiliaryQueued("compression", scopeKey)).toBe(0);
    expect(getAuxiliaryInFlight("compression", scopeKey)).toBe(1);

    first.resolve(executionResult(route, true, "first"));
    await firstRun;
    expect(getAuxiliaryInFlight("compression", scopeKey)).toBe(0);
  });

  it("returns structured timeout when a queued request times out before it starts", async () => {
    const route = fakeRoute();
    const scopeKey = "queued-timeout";
    const first = deferred<ProviderExecutionResult>();
    const complete = vi.fn(() => first.promise);

    const firstRun = executeAuxiliaryTask({
      route: fakeAuxiliaryRoute({ route, maxConcurrency: 1 }),
      mainRoute: fakeRoute({ id: "gpt-4o" }),
      providerExecutor: { complete },
      request,
      scopeKey,
    });
    await flushMicrotasks();

    const queuedRun = executeAuxiliaryTask({
      route: fakeAuxiliaryRoute({ route, maxConcurrency: 1, timeoutMs: 5 }),
      mainRoute: fakeRoute({ id: "gpt-4o" }),
      providerExecutor: { complete },
      request,
      scopeKey,
    });

    const queuedResult = await queuedRun;
    expect(queuedResult.status).toBe("timeout");
    expect(queuedResult.attempts[0]).toMatchObject({
      role: "primary",
      ok: false,
      errorClass: "timeout",
    });
    expect(complete).toHaveBeenCalledTimes(1);
    expect(getAuxiliaryQueued("compression", scopeKey)).toBe(0);
    expect(getAuxiliaryInFlight("compression", scopeKey)).toBe(1);

    first.resolve(executionResult(route, true, "first"));
    await firstRun;
    expect(getAuxiliaryInFlight("compression", scopeKey)).toBe(0);
  });

  it("fails an already-aborted signal before queueing", async () => {
    const route = fakeRoute();
    const scopeKey = "already-aborted-queue";
    const complete = vi.fn(async () => executionResult(route, true));
    const controller = new AbortController();
    controller.abort();

    const result = await executeAuxiliaryTask({
      route: fakeAuxiliaryRoute({ route, maxConcurrency: 1 }),
      mainRoute: fakeRoute({ id: "gpt-4o" }),
      providerExecutor: { complete },
      request,
      scopeKey,
      signal: controller.signal,
    });

    expect(result.status).toBe("aborted");
    expect(complete).not.toHaveBeenCalled();
    expect(getAuxiliaryInFlight("compression", scopeKey)).toBe(0);
    expect(getAuxiliaryQueued("compression", scopeKey)).toBe(0);
  });

  it("isolates concurrency by scope key and task", async () => {
    const route = fakeRoute();
    const first = deferred<ProviderExecutionResult>();
    const second = deferred<ProviderExecutionResult>();
    const complete = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);

    const profileA = executeAuxiliaryTask({
      route: fakeAuxiliaryRoute({ task: "vision", route, maxConcurrency: 1 }),
      mainRoute: fakeRoute({ id: "gpt-4o" }),
      providerExecutor: { complete },
      request,
      scopeKey: "profile-a",
    });
    const profileB = executeAuxiliaryTask({
      route: fakeAuxiliaryRoute({ task: "vision", route, maxConcurrency: 1 }),
      mainRoute: fakeRoute({ id: "gpt-4o" }),
      providerExecutor: { complete },
      request,
      scopeKey: "profile-b",
    });
    await flushMicrotasks();

    expect(complete).toHaveBeenCalledTimes(2);
    expect(getAuxiliaryInFlight("vision", "profile-a")).toBe(1);
    expect(getAuxiliaryInFlight("vision", "profile-b")).toBe(1);

    first.resolve(executionResult(route, true, "a"));
    second.resolve(executionResult(route, true, "b"));
    await Promise.all([profileA, profileB]);
  });

  it("isolates concurrency by task within the same scope", async () => {
    const route = fakeRoute();
    const compression = deferred<ProviderExecutionResult>();
    const vision = deferred<ProviderExecutionResult>();
    const complete = vi
      .fn()
      .mockImplementationOnce(() => compression.promise)
      .mockImplementationOnce(() => vision.promise);
    const scopeKey = "same-profile-different-tasks";

    const compressionRun = executeAuxiliaryTask({
      route: fakeAuxiliaryRoute({ task: "compression", route, maxConcurrency: 1 }),
      mainRoute: fakeRoute({ id: "gpt-4o" }),
      providerExecutor: { complete },
      request,
      scopeKey,
    });
    const visionRun = executeAuxiliaryTask({
      route: fakeAuxiliaryRoute({ task: "vision", route, maxConcurrency: 1 }),
      mainRoute: fakeRoute({ id: "gpt-4o" }),
      providerExecutor: { complete },
      request,
      scopeKey,
    });
    await flushMicrotasks();

    expect(complete).toHaveBeenCalledTimes(2);
    expect(getAuxiliaryInFlight("compression", scopeKey)).toBe(1);
    expect(getAuxiliaryInFlight("vision", scopeKey)).toBe(1);

    compression.resolve(executionResult(route, true, "compression"));
    vision.resolve(executionResult(route, true, "vision"));
    await Promise.all([compressionRun, visionRun]);
  });

  it("releases the permit after provider success", async () => {
    const route = fakeRoute();
    const scopeKey = "release-success";
    const complete = vi.fn(async () => executionResult(route, true, "ok"));

    const result = await executeAuxiliaryTask({
      route: fakeAuxiliaryRoute({ route, maxConcurrency: 1 }),
      mainRoute: fakeRoute({ id: "gpt-4o" }),
      providerExecutor: { complete },
      request,
      scopeKey,
    });

    expect(result.status).toBe("ok");
    expect(getAuxiliaryInFlight("compression", scopeKey)).toBe(0);
  });

  it("releases the permit after provider failure", async () => {
    const route = fakeRoute();
    const scopeKey = "release-failure";
    const complete = vi.fn(async () => executionResult(route, false, "failed"));

    const result = await executeAuxiliaryTask({
      route: fakeAuxiliaryRoute({ route, maxConcurrency: 1 }),
      mainRoute: fakeRoute({ id: "gpt-4o" }),
      providerExecutor: { complete },
      request,
      scopeKey,
    });

    expect(result.status).toBe("failed");
    expect(getAuxiliaryInFlight("compression", scopeKey)).toBe(0);
  });

  it("releases the permit after provider throw", async () => {
    const route = fakeRoute();
    const scopeKey = "release-throw";
    const complete = vi.fn(async () => {
      throw new Error("provider exploded");
    });

    const result = await executeAuxiliaryTask({
      route: fakeAuxiliaryRoute({ route, maxConcurrency: 1 }),
      mainRoute: fakeRoute({ id: "gpt-4o" }),
      providerExecutor: { complete },
      request,
      scopeKey,
    });

    expect(result.status).toBe("exception");
    expect(getAuxiliaryInFlight("compression", scopeKey)).toBe(0);
  });

  it("releases the permit after timeout", async () => {
    const route = fakeRoute();
    const scopeKey = "release-timeout";
    const complete = vi.fn(() => new Promise<ProviderExecutionResult>(() => {}));

    const result = await executeAuxiliaryTask({
      route: fakeAuxiliaryRoute({ route, maxConcurrency: 1, timeoutMs: 5 }),
      mainRoute: fakeRoute({ id: "gpt-4o" }),
      providerExecutor: { complete },
      request,
      scopeKey,
    });

    expect(result.status).toBe("timeout");
    expect(getAuxiliaryInFlight("compression", scopeKey)).toBe(0);
  });

  it("releases the permit after external abort while running", async () => {
    const route = fakeRoute();
    const scopeKey = "release-running-abort";
    const controller = new AbortController();
    const complete = vi.fn((_request, _preferences, options) => new Promise<ProviderExecutionResult>((_resolve, reject) => {
      options.signal?.addEventListener("abort", () => reject(new Error("aborted by caller")), { once: true });
    }));

    const run = executeAuxiliaryTask({
      route: fakeAuxiliaryRoute({ route, maxConcurrency: 1 }),
      mainRoute: fakeRoute({ id: "gpt-4o" }),
      providerExecutor: { complete },
      request,
      scopeKey,
      signal: controller.signal,
    });
    await flushMicrotasks();
    expect(getAuxiliaryInFlight("compression", scopeKey)).toBe(1);

    controller.abort();
    const result = await run;
    expect(result.status).toBe("aborted");
    expect(getAuxiliaryInFlight("compression", scopeKey)).toBe(0);
  });

  it("releases the permit after fallback failure", async () => {
    const route = fakeRoute({ id: "gpt-4.1-mini" });
    const mainRoute = fakeRoute({ id: "gpt-4o" });
    const scopeKey = "release-fallback-failure";
    const complete = vi.fn(async (_request, _preferences, options) =>
      options.primaryRoute.id === route.id
        ? executionResult(route, false, "primary failed")
        : executionResult(mainRoute, false, "fallback failed")
    );

    const result = await executeAuxiliaryTask({
      route: fakeAuxiliaryRoute({ route, fallbackToMain: true, maxConcurrency: 1 }),
      mainRoute,
      providerExecutor: { complete },
      request,
      scopeKey,
    });

    expect(result.status).toBe("failed");
    expect(result.fallbackUsed).toBe(true);
    expect(getAuxiliaryInFlight("compression", scopeKey)).toBe(0);
  });

  it("releases the permit after fallback throw", async () => {
    const route = fakeRoute({ id: "gpt-4.1-mini" });
    const mainRoute = fakeRoute({ id: "gpt-4o" });
    const scopeKey = "release-fallback-throw";
    const complete = vi.fn(async (_request, _preferences, options) => {
      if (options.primaryRoute.id === route.id) {
        return executionResult(route, false, "primary failed");
      }
      throw new Error("fallback exploded");
    });

    const result = await executeAuxiliaryTask({
      route: fakeAuxiliaryRoute({ route, fallbackToMain: true, maxConcurrency: 1 }),
      mainRoute,
      providerExecutor: { complete },
      request,
      scopeKey,
    });

    expect(result.status).toBe("exception");
    expect(result.fallbackUsed).toBe(true);
    expect(getAuxiliaryInFlight("compression", scopeKey)).toBe(0);
  });

  it("releases the permit after fallback timeout", async () => {
    const route = fakeRoute({ id: "gpt-4.1-mini" });
    const mainRoute = fakeRoute({ id: "gpt-4o" });
    const scopeKey = "release-fallback-timeout";
    const complete = vi.fn((_request, _preferences, options) =>
      options.primaryRoute.id === route.id
        ? Promise.resolve(executionResult(route, false, "primary failed"))
        : new Promise<ProviderExecutionResult>(() => {})
    );

    const result = await executeAuxiliaryTask({
      route: fakeAuxiliaryRoute({ route, fallbackToMain: true, maxConcurrency: 1, timeoutMs: 5 }),
      mainRoute,
      providerExecutor: { complete },
      request,
      scopeKey,
    });

    expect(result.status).toBe("timeout");
    expect(result.fallbackUsed).toBe(true);
    expect(getAuxiliaryInFlight("compression", scopeKey)).toBe(0);
  });

  it("uses one acquired permit across primary and fallback attempts", async () => {
    const route = fakeRoute({ id: "gpt-4.1-mini" });
    const mainRoute = fakeRoute({ id: "gpt-4o" });
    const scopeKey = "fallback-shared-permit";
    const inFlightDuringAttempts: number[] = [];
    const complete = vi.fn(async (_request, _preferences, options) => {
      inFlightDuringAttempts.push(getAuxiliaryInFlight("compression", scopeKey));
      return options.primaryRoute.id === route.id
        ? executionResult(route, false, "primary failed")
        : executionResult(mainRoute, true, "main ok");
    });

    const result = await executeAuxiliaryTask({
      route: fakeAuxiliaryRoute({ route, fallbackToMain: true, maxConcurrency: 1 }),
      mainRoute,
      providerExecutor: { complete },
      request,
      scopeKey,
    });

    expect(result.status).toBe("ok");
    expect(result.fallbackUsed).toBe(true);
    expect(inFlightDuringAttempts).toEqual([1, 1]);
    expect(getAuxiliaryQueued("compression", scopeKey)).toBe(0);
    expect(getAuxiliaryInFlight("compression", scopeKey)).toBe(0);
  });

  it("does not limit concurrency when maxConcurrency is undefined or non-positive", async () => {
    async function runNoLimit(maxConcurrency: number | undefined, scopeKey: string): Promise<void> {
      const route = fakeRoute();
      const first = deferred<ProviderExecutionResult>();
      const second = deferred<ProviderExecutionResult>();
      const complete = vi
        .fn()
        .mockImplementationOnce(() => first.promise)
        .mockImplementationOnce(() => second.promise);

      const firstRun = executeAuxiliaryTask({
        route: fakeAuxiliaryRoute({ route, maxConcurrency }),
        mainRoute: fakeRoute({ id: "gpt-4o" }),
        providerExecutor: { complete },
        request,
        scopeKey,
      });
      const secondRun = executeAuxiliaryTask({
        route: fakeAuxiliaryRoute({ route, maxConcurrency }),
        mainRoute: fakeRoute({ id: "gpt-4o" }),
        providerExecutor: { complete },
        request,
        scopeKey,
      });
      await flushMicrotasks();

      expect(complete).toHaveBeenCalledTimes(2);
      expect(getAuxiliaryInFlight("compression", scopeKey)).toBe(2);
      expect(getAuxiliaryQueued("compression", scopeKey)).toBe(0);

      first.resolve(executionResult(route, true, "first"));
      second.resolve(executionResult(route, true, "second"));
      await Promise.all([firstRun, secondRun]);
      expect(getAuxiliaryInFlight("compression", scopeKey)).toBe(0);
    }

    await runNoLimit(undefined, "no-limit-undefined");
    await runNoLimit(0, "no-limit-zero");
    await runNoLimit(-1, "no-limit-negative");
  });
});
