import { describe, expect, it, beforeEach } from "vitest";
import type {
  ModelProfile,
  ProviderAdapter,
  ProviderCompletionOptions,
  ProviderEndpoint,
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
    health(_endpointOverride?: ProviderEndpoint) {
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

function rawToolCall(id: string, name = "test.tool", argumentsText = "{}"): unknown {
  return {
    choices: [
      {
        message: {
          tool_calls: [
            {
              id,
              function: {
                name,
                arguments: argumentsText
              }
            }
          ]
        }
      }
    ]
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

  it("does not fallback when empty content includes tool calls", async () => {
    const primary = createMockAdapter({
      id: "primary",
      completeResponse: {
        ok: true,
        content: "",
        model: "m1",
        provider: "primary",
        raw: rawToolCall("call-1")
      }
    });
    const fallback = createMockAdapter({
      id: "fallback",
      completeResponse: { ok: true, content: "fallback ok", model: "m2", provider: "fallback" }
    });
    registry.register(primary);
    registry.register(fallback);

    const events: ProviderRuntimeEvent[] = [];
    const executor = new ProviderExecutor({ registry });
    const result = await executor.complete(
      { messages: [] },
      {},
      {
        primaryRoute: createRoute("primary", "m1"),
        fallbackChain: [createRoute("fallback", "m2")],
        onEvent: (event) => {
          events.push(event);
        }
      }
    );

    expect(result.ok).toBe(true);
    expect(result.fallbackUsed).toBe(false);
    expect(result.response?.content).toBe("");
    expect(result.toolCalls).toEqual([
      expect.objectContaining({
        id: "call-1",
        name: "test.tool",
        argumentsText: "{}"
      })
    ]);
    expect(fallback.calls.length).toBe(0);
    expect(events).toContainEqual(expect.objectContaining({
      kind: "provider-attempt-end",
      provider: "primary",
      ok: true,
      willFallback: false
    }));
  });

  it("falls back when successful primary content is empty and has no tool calls", async () => {
    const primary = createMockAdapter({
      id: "primary",
      completeResponse: { ok: true, content: "", model: "m1", provider: "primary" }
    });
    const fallback = createMockAdapter({
      id: "fallback",
      completeResponse: { ok: true, content: "fallback ok", model: "m2", provider: "fallback" }
    });
    registry.register(primary);
    registry.register(fallback);

    const events: ProviderRuntimeEvent[] = [];
    const executor = new ProviderExecutor({ registry });
    const result = await executor.complete(
      { messages: [] },
      {},
      {
        primaryRoute: createRoute("primary", "m1"),
        fallbackChain: [createRoute("fallback", "m2")],
        onEvent: (event) => {
          events.push(event);
        }
      }
    );

    expect(result.ok).toBe(true);
    expect(result.fallbackUsed).toBe(true);
    expect(result.response?.content).toBe("fallback ok");
    expect(result.attempts).toEqual([
      expect.objectContaining({
        provider: "primary",
        ok: false,
        errorClass: "empty-response",
        content: "Provider returned empty content with no tool calls."
      }),
      expect.objectContaining({
        provider: "fallback",
        ok: true,
        content: "fallback ok"
      })
    ]);
    expect(events).toContainEqual(expect.objectContaining({
      kind: "provider-attempt-end",
      provider: "primary",
      ok: false,
      errorClass: "empty-response",
      willFallback: true
    }));
    const primaryAttemptEndEvents = events.filter((event) =>
      event.kind === "provider-attempt-end" &&
      event.provider === "primary"
    );
    expect(primaryAttemptEndEvents).toEqual([
      expect.objectContaining({
        ok: false,
        errorClass: "empty-response",
        willFallback: true
      })
    ]);
    expect(primaryAttemptEndEvents).not.toContainEqual(expect.objectContaining({
      ok: true
    }));
  });

  it("returns fallback content when primary succeeds with empty content and no tool calls", async () => {
    const primary = createMockAdapter({
      id: "primary",
      completeResponse: { ok: true, content: "", model: "m1", provider: "primary" }
    });
    const fallback = createMockAdapter({
      id: "fallback",
      completeResponse: { ok: true, content: "visible fallback", model: "m2", provider: "fallback" }
    });
    registry.register(primary);
    registry.register(fallback);

    const executor = new ProviderExecutor({ registry });
    const result = await executor.complete(
      { messages: [] },
      {},
      {
        primaryRoute: createRoute("primary", "m1"),
        fallbackChain: [createRoute("fallback", "m2")]
      }
    );

    expect(result.ok).toBe(true);
    expect(result.fallbackUsed).toBe(true);
    expect(result.response?.content).toBe("visible fallback");
  });

  it("returns fallback tool calls when primary succeeds with empty content and no tool calls", async () => {
    const primary = createMockAdapter({
      id: "primary",
      completeResponse: { ok: true, content: "", model: "m1", provider: "primary" }
    });
    const fallback = createMockAdapter({
      id: "fallback",
      completeResponse: {
        ok: true,
        content: "",
        model: "m2",
        provider: "fallback",
        raw: rawToolCall("fallback-call")
      }
    });
    registry.register(primary);
    registry.register(fallback);

    const executor = new ProviderExecutor({ registry });
    const result = await executor.complete(
      { messages: [] },
      {},
      {
        primaryRoute: createRoute("primary", "m1"),
        fallbackChain: [createRoute("fallback", "m2")]
      }
    );

    expect(result.ok).toBe(true);
    expect(result.fallbackUsed).toBe(true);
    expect(result.response?.provider).toBe("fallback");
    expect(result.toolCalls).toEqual([
      expect.objectContaining({
        id: "fallback-call",
        name: "test.tool"
      })
    ]);
  });

  it("keeps empty successful content when no fallback route exists", async () => {
    const primary = createMockAdapter({
      id: "primary",
      completeResponse: { ok: true, content: "", model: "m1", provider: "primary" }
    });
    registry.register(primary);

    const executor = new ProviderExecutor({ registry });
    const result = await executor.complete(
      { messages: [] },
      {},
      {
        primaryRoute: createRoute("primary", "m1")
      }
    );

    expect(result.ok).toBe(true);
    expect(result.fallbackUsed).toBe(false);
    expect(result.response?.content).toBe("");
    expect(result.attempts).toEqual([
      expect.objectContaining({
        provider: "primary",
        ok: true,
        content: ""
      })
    ]);
  });

  it("does not fallback when primary returns normal content", async () => {
    const primary = createMockAdapter({
      id: "primary",
      completeResponse: { ok: true, content: "primary ok", model: "m1", provider: "primary" }
    });
    const fallback = createMockAdapter({
      id: "fallback",
      completeResponse: { ok: true, content: "fallback ok", model: "m2", provider: "fallback" }
    });
    registry.register(primary);
    registry.register(fallback);

    const events: ProviderRuntimeEvent[] = [];
    const executor = new ProviderExecutor({ registry });
    const result = await executor.complete(
      { messages: [] },
      {},
      {
        primaryRoute: createRoute("primary", "m1"),
        fallbackChain: [createRoute("fallback", "m2")],
        onEvent: (event) => {
          events.push(event);
        }
      }
    );

    expect(result.ok).toBe(true);
    expect(result.fallbackUsed).toBe(false);
    expect(result.response?.content).toBe("primary ok");
    expect(fallback.calls.length).toBe(0);
    expect(events).toContainEqual(expect.objectContaining({
      kind: "provider-attempt-end",
      provider: "primary",
      ok: true,
      willFallback: false
    }));
  });

  it("preserves fallback route metadata during execution", async () => {
    const primary = createMockAdapter({
      id: "test-primary",
      completeResponse: { ok: false, content: "fail", model: "m1", provider: "test-primary", errorClass: "server" }
    });
    const fallback = createMockAdapter({
      id: "test-fallback",
      completeResponse: { ok: true, content: "ok", model: "m2", provider: "test-fallback" }
    });
    registry.register(primary);
    registry.register(fallback);

    const executor = new ProviderExecutor({ registry });
    await executor.complete(
      { messages: [] },
      {},
      {
        primaryRoute: createRoute("test-primary", "m1", { baseUrl: "https://primary.example.com/v1" }),
        fallbackChain: [createRoute("test-fallback", "m2", { baseUrl: "https://fallback.example.com/v1" })]
      }
    );

    expect(primary.calls.length).toBe(1);
    expect(primary.calls[0].options?.endpoint?.baseUrl).toBe("https://primary.example.com/v1");
    expect(fallback.calls.length).toBe(1);
    expect(fallback.calls[0].options?.endpoint?.baseUrl).toBe("https://fallback.example.com/v1");
  });

  it("executes primary only when no fallback chain exists", async () => {
    const primary = createMockAdapter({
      id: "test-primary",
      completeResponse: { ok: false, content: "fail", model: "m1", provider: "test-primary", errorClass: "rate-limit" }
    });
    registry.register(primary);

    const executor = new ProviderExecutor({ registry });
    const result = await executor.complete(
      { messages: [] },
      {},
      {
        primaryRoute: createRoute("test-primary", "m1")
      }
    );

    expect(result.ok).toBe(false);
    expect(result.fallbackUsed).toBe(false);
    expect(result.attempts.length).toBe(1);
    expect(primary.calls.length).toBe(1);
  });

  it("does not use arbitrary registered models as fallbacks", async () => {
    const primary = createMockAdapter({
      id: "test-primary",
      completeResponse: { ok: false, content: "fail", model: "m1", provider: "test-primary", errorClass: "model-unavailable" }
    });
    const other = createMockAdapter({
      id: "test-other",
      completeResponse: { ok: true, content: "other ok", model: "m2", provider: "test-other" }
    });
    registry.register(primary);
    registry.register(other);

    const executor = new ProviderExecutor({ registry });
    const result = await executor.complete(
      { messages: [] },
      {},
      {
        primaryRoute: createRoute("test-primary", "m1"),
        fallbackChain: []
      }
    );

    expect(result.ok).toBe(false);
    expect(other.calls.length).toBe(0);
  });

  it("retries primary on each new turn regardless of prior fallback", async () => {
    const primary = createMockAdapter({
      id: "test-primary",
      completeResponse: { ok: false, content: "fail", model: "m1", provider: "test-primary", errorClass: "rate-limit" }
    });
    const fallback = createMockAdapter({
      id: "test-fallback",
      completeResponse: { ok: true, content: "ok", model: "m2", provider: "test-fallback" }
    });
    registry.register(primary);
    registry.register(fallback);

    const executor = new ProviderExecutor({ registry });
    const options = {
      primaryRoute: createRoute("test-primary", "m1"),
      fallbackChain: [createRoute("test-fallback", "m2")]
    };

    const result1 = await executor.complete({ messages: [] }, {}, options);
    expect(result1.ok).toBe(true);
    expect(result1.attempts[0].provider).toBe("test-primary");

    const result2 = await executor.complete({ messages: [] }, {}, options);
    expect(result2.ok).toBe(true);
    expect(result2.attempts[0].provider).toBe("test-primary");

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
  ])("eligible failure class %s triggers fallback: %s", async (errorClass: string, shouldTrigger: boolean) => {
    const primary = createMockAdapter({
      id: "test-primary",
      completeResponse: {
        ok: false,
        content: "fail",
        model: "m1",
        provider: "test-primary",
        errorClass: errorClass as any
      }
    });
    const fallback = createMockAdapter({
      id: "test-fallback",
      completeResponse: { ok: true, content: "ok", model: "m2", provider: "test-fallback" }
    });
    registry.register(primary);
    registry.register(fallback);

    const executor = new ProviderExecutor({ registry });
    const result = await executor.complete(
      { messages: [] },
      {},
      {
        primaryRoute: createRoute("test-primary", "m1"),
        fallbackChain: [createRoute("test-fallback", "m2")]
      }
    );

    if (shouldTrigger) {
      expect(result.ok).toBe(true);
      expect(result.attempts.length).toBe(2);
      expect(result.attempts[1].provider).toBe("test-fallback");
    } else {
      expect(result.ok).toBe(false);
      expect(result.attempts.length).toBe(1);
      expect(fallback.calls.length).toBe(0);
    }
  });

  it("falls back on auth error when explicit fallback chain exists", async () => {
    const primary = createMockAdapter({
      id: "test-primary",
      completeResponse: { ok: false, content: "auth fail", model: "m1", provider: "test-primary", errorClass: "auth" }
    });
    const fallback = createMockAdapter({
      id: "test-fallback",
      completeResponse: { ok: true, content: "ok", model: "m2", provider: "test-fallback" }
    });
    registry.register(primary);
    registry.register(fallback);

    const events: ProviderRuntimeEvent[] = [];
    const executor = new ProviderExecutor({ registry });
    const result = await executor.complete(
      { messages: [] },
      {},
      {
        primaryRoute: createRoute("test-primary", "m1"),
        fallbackChain: [createRoute("test-fallback", "m2")],
        onEvent: (event) => {
          events.push(event);
        }
      }
    );

    expect(result.ok).toBe(true);
    expect(result.attempts.length).toBe(2);
    const primaryEnd = events.find((e): e is Extract<ProviderRuntimeEvent, { kind: "provider-attempt-end" }> => e.kind === "provider-attempt-end" && e.provider === "test-primary");
    expect(primaryEnd).toBeDefined();
    expect(primaryEnd!.willFallback).toBe(true);
  });

  it("blocks on auth error when no fallback chain exists", async () => {
    const primary = createMockAdapter({
      id: "test-primary",
      completeResponse: { ok: false, content: "auth fail", model: "m1", provider: "test-primary", errorClass: "auth" }
    });
    registry.register(primary);

    const events: ProviderRuntimeEvent[] = [];
    const executor = new ProviderExecutor({ registry });
    const result = await executor.complete(
      { messages: [] },
      {},
      {
        primaryRoute: createRoute("test-primary", "m1"),
        onEvent: (event) => {
          events.push(event);
        }
      }
    );

    expect(result.ok).toBe(false);
    expect(result.attempts.length).toBe(1);
    const primaryEnd = events.find((e): e is Extract<ProviderRuntimeEvent, { kind: "provider-attempt-end" }> => e.kind === "provider-attempt-end" && e.provider === "test-primary");
    expect(primaryEnd).toBeDefined();
    expect(primaryEnd!.willFallback).toBe(false);
  });

  it("does not fallback on cancellation", async () => {
    const primary = createMockAdapter({
      id: "test-primary",
      completeResponse: { ok: false, content: "fail", model: "m1", provider: "test-primary", errorClass: "rate-limit" },
      delayMs: 50
    });
    const fallback = createMockAdapter({
      id: "test-fallback",
      completeResponse: { ok: true, content: "ok", model: "m2", provider: "test-fallback" }
    });
    registry.register(primary);
    registry.register(fallback);

    const controller = new AbortController();
    const executor = new ProviderExecutor({ registry });
    const promise = executor.complete(
      { messages: [] },
      {},
      {
        primaryRoute: createRoute("test-primary", "m1"),
        fallbackChain: [createRoute("test-fallback", "m2")],
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
      id: "test-primary",
      completeHandler: (request) => ({ ok: false, content: "auth fail", model: request.model, provider: "test-primary", errorClass: "auth" })
    });
    registry.register(adapter);

    const executor = new ProviderExecutor({ registry });
    const result = await executor.complete(
      { messages: [] },
      {},
      {
        primaryRoute: createRoute("test-primary", "m1"),
        fallbackChain: [createRoute("test-primary", "m2")]
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
      id: "test-primary",
      completeResponse: { ok: false, content: "primary fail", model: "m1", provider: "test-primary", errorClass: "rate-limit" }
    });
    const fallback1 = createMockAdapter({
      id: "test-fallback1",
      completeResponse: { ok: false, content: "fallback1 fail", model: "m2", provider: "test-fallback1", errorClass: "server" }
    });
    const fallback2 = createMockAdapter({
      id: "test-fallback2",
      completeResponse: { ok: false, content: "fallback2 fail", model: "m3", provider: "test-fallback2", errorClass: "network" }
    });
    registry.register(primary);
    registry.register(fallback1);
    registry.register(fallback2);

    const executor = new ProviderExecutor({ registry });
    const result = await executor.complete(
      { messages: [] },
      {},
      {
        primaryRoute: createRoute("test-primary", "m1"),
        fallbackChain: [createRoute("test-fallback1", "m2"), createRoute("test-fallback2", "m3")]
      }
    );

    expect(result.ok).toBe(false);
    expect(result.attempts.length).toBe(3);
    expect(result.attempts[0].provider).toBe("test-primary");
    expect(result.attempts[1].provider).toBe("test-fallback1");
    expect(result.attempts[2].provider).toBe("test-fallback2");
    expect(result.attempts[2].errorClass).toBe("network");
    expect(result.attempts[2].content).toBe("fallback2 fail");
  });
});
