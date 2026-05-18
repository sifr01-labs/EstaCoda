import { describe, expect, it, vi } from "vitest";
import type {
  ModelProfile,
  ProviderRequest,
  ResolvedAuxiliaryRoute,
  ResolvedModelRoute
} from "../contracts/provider.js";
import type { ProviderExecutionResult } from "./provider-executor.js";
import { executeAuxiliaryTask } from "./auxiliary-executor.js";

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
});
