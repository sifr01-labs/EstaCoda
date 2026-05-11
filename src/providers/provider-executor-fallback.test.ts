import { describe, expect, it, beforeEach } from "vitest";
import type {
  ModelProfile,
  ProviderAdapter,
  ProviderCompletionOptions,
  ProviderRequest,
  ProviderResponse,
  ProviderStreamEvent,
  ResolvedModelRoute
} from "../contracts/provider.js";
import { ProviderExecutor, type ProviderRuntimeEvent } from "./provider-executor.js";
import { ProviderRegistry } from "./provider-registry.js";

type MockCall = {
  request: ProviderRequest;
  options?: ProviderCompletionOptions;
};

function createMockAdapter(options: {
  id: string;
  completeResponse?: ProviderResponse;
  completeHandler?: (request: ProviderRequest, completionOptions?: ProviderCompletionOptions) => ProviderResponse;
  streamEvents?: ProviderStreamEvent[];
  models?: ModelProfile[];
  delayMs?: number;
}): ProviderAdapter & { calls: MockCall[] } {
  const calls: MockCall[] = [];
  return {
    id: options.id as any,
    name: `${options.id} mock`,
    executable: true,
    health() {
      return { available: true };
    },
    listModels() {
      return options.models ?? [];
    },
    async complete(request: ProviderRequest, completionOptions?: ProviderCompletionOptions): Promise<ProviderResponse> {
      calls.push({ request, options: completionOptions });
      if (options.delayMs !== undefined && options.delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      }
      if (options.completeHandler !== undefined) {
        return options.completeHandler(request, completionOptions);
      }
      return options.completeResponse ?? {
        ok: true,
        content: "mock-response",
        model: request.model,
        provider: options.id as any
      };
    },
    async *stream(request: ProviderRequest, completionOptions?: ProviderCompletionOptions): AsyncIterable<ProviderStreamEvent> {
      calls.push({ request, options: completionOptions });
      const events = options.streamEvents ?? [
        { kind: "done", provider: options.id as any, model: request.model, response: { ok: true, content: "mock-stream", model: request.model, provider: options.id as any } }
      ];
      for (const event of events) {
        yield event;
      }
    },
    calls
  };
}

function createRoute(provider: string, id: string, overrides?: Partial<ResolvedModelRoute>): ResolvedModelRoute {
  return {
    provider: provider as any,
    id,
    profile: {
      id,
      provider: provider as any,
      contextWindowTokens: 128_000,
      supportsTools: true,
      supportsVision: true,
      supportsStructuredOutput: true
    },
    ...overrides
  };
}

describe("ProviderExecutor fallback behavior", () => {
  let registry: ProviderRegistry;

  beforeEach(() => {
    registry = new ProviderRegistry();
  });

  it("uses explicit fallback route order when primary fails", async () => {
    const primary = createMockAdapter({
      id: "primary",
      completeResponse: { ok: false, content: "rate limited", model: "m1", provider: "primary", errorClass: "rate-limit" }
    });
    const fallback1 = createMockAdapter({
      id: "fallback1",
      completeResponse: { ok: true, content: "fallback1 ok", model: "m2", provider: "fallback1" }
    });
    const fallback2 = createMockAdapter({
      id: "fallback2",
      completeResponse: { ok: true, content: "fallback2 ok", model: "m3", provider: "fallback2" }
    });
    registry.register(primary);
    registry.register(fallback1);
    registry.register(fallback2);

    const executor = new ProviderExecutor({ registry });
    const result = await executor.complete(
      { messages: [] },
      {},
      {
        primaryRoute: createRoute("primary", "m1"),
        fallbackChain: [createRoute("fallback1", "m2"), createRoute("fallback2", "m3")]
      }
    );

    expect(result.ok).toBe(true);
    expect(result.fallbackUsed).toBe(true);
    expect(result.attempts.length).toBe(2);
    expect(result.attempts[0].provider).toBe("primary");
    expect(result.attempts[1].provider).toBe("fallback1");
    expect(fallback2.calls.length).toBe(0);
  });

  it("preserves fallback route metadata during execution", async () => {
    const primary = createMockAdapter({
      id: "openai",
      completeResponse: { ok: false, content: "fail", model: "gpt-4o", provider: "openai", errorClass: "server" }
    });
    const fallback = createMockAdapter({
      id: "deepseek",
      completeResponse: { ok: true, content: "ok", model: "ds", provider: "deepseek" }
    });
    registry.register(primary);
    registry.register(fallback);

    const executor = new ProviderExecutor({ registry });
    await executor.complete(
      { messages: [] },
      {},
      {
        primaryRoute: createRoute("openai", "gpt-4o", { baseUrl: "https://primary.example.com/v1" }),
        fallbackChain: [createRoute("deepseek", "ds", { baseUrl: "https://fallback.example.com/v1" })]
      }
    );

    expect(primary.calls.length).toBe(1);
    expect(primary.calls[0].options?.endpoint?.baseUrl).toBe("https://primary.example.com/v1");
    expect(fallback.calls.length).toBe(1);
    expect(fallback.calls[0].options?.endpoint?.baseUrl).toBe("https://fallback.example.com/v1");
  });

  it("executes primary only when no fallback chain exists", async () => {
    const primary = createMockAdapter({
      id: "openai",
      completeResponse: { ok: false, content: "fail", model: "gpt-4o", provider: "openai", errorClass: "rate-limit" }
    });
    registry.register(primary);

    const executor = new ProviderExecutor({ registry });
    const result = await executor.complete(
      { messages: [] },
      {},
      {
        primaryRoute: createRoute("openai", "gpt-4o")
      }
    );

    expect(result.ok).toBe(false);
    expect(result.fallbackUsed).toBe(false);
    expect(result.attempts.length).toBe(1);
    expect(primary.calls.length).toBe(1);
  });

  it("does not use arbitrary registered models as fallbacks", async () => {
    const primary = createMockAdapter({
      id: "openai",
      completeResponse: { ok: false, content: "fail", model: "gpt-4o", provider: "openai", errorClass: "model-unavailable" }
    });
    const other = createMockAdapter({
      id: "kimi",
      completeResponse: { ok: true, content: "kimi ok", model: "kimi-k2.5", provider: "kimi" }
    });
    registry.register(primary);
    registry.register(other);

    const executor = new ProviderExecutor({ registry });
    const result = await executor.complete(
      { messages: [] },
      {},
      {
        primaryRoute: createRoute("openai", "gpt-4o"),
        fallbackChain: []
      }
    );

    expect(result.ok).toBe(false);
    expect(other.calls.length).toBe(0);
  });

  it("retries primary on each new turn regardless of prior fallback", async () => {
    const primary = createMockAdapter({
      id: "openai",
      completeResponse: { ok: false, content: "fail", model: "gpt-4o", provider: "openai", errorClass: "rate-limit" }
    });
    const fallback = createMockAdapter({
      id: "kimi",
      completeResponse: { ok: true, content: "ok", model: "kimi-k2.5", provider: "kimi" }
    });
    registry.register(primary);
    registry.register(fallback);

    const executor = new ProviderExecutor({ registry });
    const options = {
      primaryRoute: createRoute("openai", "gpt-4o"),
      fallbackChain: [createRoute("kimi", "kimi-k2.5")]
    };

    const result1 = await executor.complete({ messages: [] }, {}, options);
    expect(result1.ok).toBe(true);
    expect(result1.attempts[0].provider).toBe("openai");

    const result2 = await executor.complete({ messages: [] }, {}, options);
    expect(result2.ok).toBe(true);
    expect(result2.attempts[0].provider).toBe("openai");

    expect(primary.calls.length).toBe(2);
    expect(fallback.calls.length).toBe(2);
  });

  it.each([
    ["rate-limit", true],
    ["quota", true],
    ["network", true],
    ["server", true],
    ["model-unavailable", true],
    ["unknown", true],
    ["timeout", true],
    ["incomplete-stream", false],
    ["unsupported", false]
  ])("eligible failure class %s triggers fallback: %s", async (errorClass, shouldTrigger) => {
    const primary = createMockAdapter({
      id: "openai",
      completeResponse: {
        ok: false,
        content: "fail",
        model: "gpt-4o",
        provider: "openai",
        errorClass: errorClass as any
      }
    });
    const fallback = createMockAdapter({
      id: "kimi",
      completeResponse: { ok: true, content: "ok", model: "kimi-k2.5", provider: "kimi" }
    });
    registry.register(primary);
    registry.register(fallback);

    const executor = new ProviderExecutor({ registry });
    const result = await executor.complete(
      { messages: [] },
      {},
      {
        primaryRoute: createRoute("openai", "gpt-4o"),
        fallbackChain: [createRoute("kimi", "kimi-k2.5")]
      }
    );

    if (shouldTrigger) {
      expect(result.ok).toBe(true);
      expect(result.attempts.length).toBe(2);
      expect(result.attempts[1].provider).toBe("kimi");
    } else {
      expect(result.ok).toBe(false);
      expect(result.attempts.length).toBe(1);
      expect(fallback.calls.length).toBe(0);
    }
  });

  it("falls back on auth error when explicit fallback chain exists", async () => {
    const primary = createMockAdapter({
      id: "openai",
      completeResponse: { ok: false, content: "auth fail", model: "gpt-4o", provider: "openai", errorClass: "auth" }
    });
    const fallback = createMockAdapter({
      id: "kimi",
      completeResponse: { ok: true, content: "ok", model: "kimi-k2.5", provider: "kimi" }
    });
    registry.register(primary);
    registry.register(fallback);

    const events: ProviderRuntimeEvent[] = [];
    const executor = new ProviderExecutor({ registry });
    const result = await executor.complete(
      { messages: [] },
      {},
      {
        primaryRoute: createRoute("openai", "gpt-4o"),
        fallbackChain: [createRoute("kimi", "kimi-k2.5")],
        onEvent: (event) => {
          events.push(event);
        }
      }
    );

    expect(result.ok).toBe(true);
    expect(result.attempts.length).toBe(2);
    const primaryEnd = events.find((e): e is Extract<ProviderRuntimeEvent, { kind: "provider-attempt-end" }> => e.kind === "provider-attempt-end" && e.provider === "openai");
    expect(primaryEnd).toBeDefined();
    expect(primaryEnd!.willFallback).toBe(true);
  });

  it("blocks on auth error when no fallback chain exists", async () => {
    const primary = createMockAdapter({
      id: "openai",
      completeResponse: { ok: false, content: "auth fail", model: "gpt-4o", provider: "openai", errorClass: "auth" }
    });
    registry.register(primary);

    const events: ProviderRuntimeEvent[] = [];
    const executor = new ProviderExecutor({ registry });
    const result = await executor.complete(
      { messages: [] },
      {},
      {
        primaryRoute: createRoute("openai", "gpt-4o"),
        onEvent: (event) => {
          events.push(event);
        }
      }
    );

    expect(result.ok).toBe(false);
    expect(result.attempts.length).toBe(1);
    const primaryEnd = events.find((e): e is Extract<ProviderRuntimeEvent, { kind: "provider-attempt-end" }> => e.kind === "provider-attempt-end" && e.provider === "openai");
    expect(primaryEnd).toBeDefined();
    expect(primaryEnd!.willFallback).toBe(false);
  });

  it("does not fallback on cancellation", async () => {
    const primary = createMockAdapter({
      id: "openai",
      completeResponse: { ok: false, content: "fail", model: "gpt-4o", provider: "openai", errorClass: "rate-limit" },
      delayMs: 50
    });
    const fallback = createMockAdapter({
      id: "kimi",
      completeResponse: { ok: true, content: "ok", model: "kimi-k2.5", provider: "kimi" }
    });
    registry.register(primary);
    registry.register(fallback);

    const controller = new AbortController();
    const executor = new ProviderExecutor({ registry });
    const promise = executor.complete(
      { messages: [] },
      {},
      {
        primaryRoute: createRoute("openai", "gpt-4o"),
        fallbackChain: [createRoute("kimi", "kimi-k2.5")],
        signal: controller.signal
      }
    );

    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();

    const result = await promise;
    expect(result.ok).toBe(false);
    expect(primary.calls.length).toBe(1);
    expect(fallback.calls.length).toBe(0);
  });

  it("registry caller fallback when primary fails", async () => {
    const primary = createMockAdapter({
      id: "openai",
      completeResponse: { ok: false, content: "rate limited", model: "gpt-4o", provider: "openai", errorClass: "rate-limit" },
      models: [
        {
          id: "gpt-4o",
          provider: "openai",
          contextWindowTokens: 128_000,
          supportsTools: true,
          supportsVision: true,
          supportsStructuredOutput: true
        }
      ]
    });
    const fallback = createMockAdapter({
      id: "kimi",
      completeResponse: { ok: true, content: "kimi ok", model: "kimi-k2.5", provider: "kimi" },
      models: [
        {
          id: "kimi-k2.5",
          provider: "kimi",
          contextWindowTokens: 128_000,
          supportsTools: true,
          supportsVision: true,
          supportsStructuredOutput: true
        }
      ]
    });
    registry.register(primary);
    registry.register(fallback);

    const executor = new ProviderExecutor({ registry });
    const result = await executor.complete({
      provider: "openai",
      model: "gpt-4o",
      messages: []
    });

    expect(result.ok).toBe(true);
    expect(result.fallbackUsed).toBe(true);
    expect(result.attempts.length).toBe(2);
    expect(result.attempts[0].provider).toBe("openai");
    expect(result.attempts[1].provider).toBe("kimi");
  });

  it("blocks auth fallback when same provider and same apiKeyEnv", async () => {
    process.env.OPENAI_KEY = "valid-key";
    const adapter = createMockAdapter({
      id: "openai",
      completeHandler: (request) => ({ ok: false, content: "auth fail", model: request.model, provider: "openai", errorClass: "auth" })
    });
    registry.register(adapter);

    const executor = new ProviderExecutor({ registry });
    const result = await executor.complete(
      { messages: [] },
      {},
      {
        primaryRoute: createRoute("openai", "gpt-4o", { apiKeyEnv: "OPENAI_KEY" }),
        fallbackChain: [createRoute("openai", "gpt-4o-mini", { apiKeyEnv: "OPENAI_KEY" })]
      }
    );

    delete process.env.OPENAI_KEY;
    expect(result.ok).toBe(false);
    expect(result.attempts.length).toBe(1);
    expect(adapter.calls.length).toBe(1);
  });

  it("blocks auth fallback when same provider and both use pool", async () => {
    const adapter = createMockAdapter({
      id: "openai",
      completeHandler: (request) => ({ ok: false, content: "auth fail", model: request.model, provider: "openai", errorClass: "auth" })
    });
    registry.register(adapter);

    const executor = new ProviderExecutor({ registry });
    const result = await executor.complete(
      { messages: [] },
      {},
      {
        primaryRoute: createRoute("openai", "gpt-4o"),
        fallbackChain: [createRoute("openai", "gpt-4o-mini")]
      }
    );

    expect(result.ok).toBe(false);
    expect(result.attempts.length).toBe(1);
    expect(adapter.calls.length).toBe(1);
  });

  it("allows auth fallback when same provider but different apiKeyEnv", async () => {
    process.env.OPENAI_KEY_A = "valid-key-a";
    process.env.OPENAI_KEY_B = "valid-key-b";
    const adapter = createMockAdapter({
      id: "openai",
      completeHandler: (request) =>
        request.model === "gpt-4o"
          ? { ok: false, content: "auth fail", model: request.model, provider: "openai", errorClass: "auth" }
          : { ok: true, content: "ok", model: request.model, provider: "openai" }
    });
    registry.register(adapter);

    const executor = new ProviderExecutor({ registry });
    const result = await executor.complete(
      { messages: [] },
      {},
      {
        primaryRoute: createRoute("openai", "gpt-4o", { apiKeyEnv: "OPENAI_KEY_A" }),
        fallbackChain: [createRoute("openai", "gpt-4o-mini", { apiKeyEnv: "OPENAI_KEY_B" })]
      }
    );

    delete process.env.OPENAI_KEY_A;
    delete process.env.OPENAI_KEY_B;
    expect(result.ok).toBe(true);
    expect(result.attempts.length).toBe(2);
    expect(adapter.calls.length).toBe(2);
  });

  it("all fallbacks fail -> attempts length is complete and final error is clear", async () => {
    const primary = createMockAdapter({
      id: "openai",
      completeResponse: { ok: false, content: "primary fail", model: "gpt-4o", provider: "openai", errorClass: "rate-limit" }
    });
    const fallback1 = createMockAdapter({
      id: "kimi",
      completeResponse: { ok: false, content: "fallback1 fail", model: "kimi-k2.5", provider: "kimi", errorClass: "server" }
    });
    const fallback2 = createMockAdapter({
      id: "deepseek",
      completeResponse: { ok: false, content: "fallback2 fail", model: "ds", provider: "deepseek", errorClass: "network" }
    });
    registry.register(primary);
    registry.register(fallback1);
    registry.register(fallback2);

    const executor = new ProviderExecutor({ registry });
    const result = await executor.complete(
      { messages: [] },
      {},
      {
        primaryRoute: createRoute("openai", "gpt-4o"),
        fallbackChain: [createRoute("kimi", "kimi-k2.5"), createRoute("deepseek", "ds")]
      }
    );

    expect(result.ok).toBe(false);
    expect(result.attempts.length).toBe(3);
    expect(result.attempts[0].provider).toBe("openai");
    expect(result.attempts[1].provider).toBe("kimi");
    expect(result.attempts[2].provider).toBe("deepseek");
    expect(result.attempts[2].errorClass).toBe("network");
    expect(result.attempts[2].content).toBe("fallback2 fail");
  });
});
