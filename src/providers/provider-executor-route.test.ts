import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import type {
  ModelProfile,
  ProviderAdapter,
  ProviderCompletionOptions,
  ProviderEndpoint,
  ProviderId,
  ProviderRequest,
  ProviderResponse,
  ProviderStreamEvent,
  ResolvedModelRoute
} from "../contracts/provider.js";
import { ProviderExecutor, type ProviderExecutionOptions, type ProviderRuntimeEvent } from "./provider-executor.js";
import { ProviderRegistry } from "./provider-registry.js";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { resolveProfileStateHome, writeActiveProfile } from "../config/profile-home.js";

type MockCall = {
  request: ProviderRequest;
  options?: ProviderCompletionOptions;
};

function createMockAdapter(options: {
  id: ProviderId;
  endpoint?: ProviderEndpoint;
  completeResponse?: ProviderResponse;
  streamEvents?: ProviderStreamEvent[];
  models?: ModelProfile[];
}): ProviderAdapter & { calls: MockCall[] } {
  const calls: MockCall[] = [];
  return {
    id: options.id,
    name: `${options.id} mock`,
    endpoint: options.endpoint,
    executable: true,
    health(_endpointOverride?: ProviderEndpoint) {
      return { available: true };
    },
    listModels() {
      return options.models ?? [];
    },
    async complete(request: ProviderRequest, completionOptions?: ProviderCompletionOptions): Promise<ProviderResponse> {
      calls.push({ request, options: completionOptions });
      return options.completeResponse ?? {
        ok: true,
        content: "mock-response",
        model: request.model,
        provider: options.id
      };
    },
    async *stream(request: ProviderRequest, completionOptions?: ProviderCompletionOptions): AsyncIterable<ProviderStreamEvent> {
      calls.push({ request, options: completionOptions });
      const events = options.streamEvents ?? [
        { kind: "done", provider: options.id, model: request.model, response: { ok: true, content: "mock-stream", model: request.model, provider: options.id } }
      ];
      for (const event of events) {
        yield event;
      }
    },
    calls
  };
}

function createDefaultRoute(overrides?: Partial<ResolvedModelRoute>): ResolvedModelRoute {
  return {
    provider: "openai",
    id: "gpt-4o",
    profile: {
      id: "gpt-4o",
      provider: "openai",
      contextWindowTokens: 128_000,
      supportsTools: true,
      supportsVision: true,
      supportsStructuredOutput: true
    },
    ...overrides
  };
}

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "estacoda-route-test-"));
}

async function writeAuthJson(homeDir: string, store: unknown, profileId = "default"): Promise<void> {
  const path = resolveProfileStateHome({ homeDir, profileId }).authJsonPath;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(store, null, 2) + "\n", "utf8");
}

describe("ProviderExecutor route-based execution", () => {
  let registry: ProviderRegistry;
  let executor: ProviderExecutor;
  let tmpDir: string;

  beforeEach(() => {
    registry = new ProviderRegistry();
    executor = new ProviderExecutor({ registry });
  });

  afterEach(async () => {
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("honors route-level baseUrl during execution", async () => {
    const adapter = createMockAdapter({ id: "test-provider" });
    registry.register(adapter);

    const route = createDefaultRoute({ provider: "test-provider", baseUrl: "https://custom.example.com/v1" });
    const result = await executor.complete({ messages: [] }, {}, {
      primaryRoute: route
    });

    expect(result.ok).toBe(true);
    expect(adapter.calls.length).toBe(1);
    expect(adapter.calls[0].options?.endpoint?.baseUrl).toBe("https://custom.example.com/v1");
  });

  it("settles an attributed execution through the configured immutable usage recorder", async () => {
    const adapter = createMockAdapter({ id: "test-provider" });
    registry.register(adapter);
    const usageRecorder = vi.fn(async () => {});
    executor = new ProviderExecutor({ registry, usageRecorder });
    const route = createDefaultRoute({ provider: "test-provider" });

    const result = await executor.complete({ messages: [] }, {}, {
      primaryRoute: route,
      usage: {
        requestKey: "main:session-1:turn-1:0",
        sourceKind: "main",
        executionSessionId: "session-1",
        visibleTurnId: "turn-1"
      }
    });

    expect(result.ok).toBe(true);
    expect(usageRecorder).toHaveBeenCalledOnce();
    expect(usageRecorder).toHaveBeenCalledWith({
      execution: result,
      context: expect.objectContaining({ requestKey: "main:session-1:turn-1:0", sourceKind: "main" }),
      routes: [route]
    });
  });

  it("refuses attributed execution before dispatch when no immutable usage recorder exists", async () => {
    const adapter = createMockAdapter({ id: "test-provider" });
    registry.register(adapter);

    await expect(executor.complete({ messages: [] }, {}, {
      primaryRoute: createDefaultRoute({ provider: "test-provider" }),
      usage: {
        requestKey: "main:session-1:turn-1:0",
        sourceKind: "main",
        executionSessionId: "session-1",
        visibleTurnId: "turn-1"
      }
    })).rejects.toThrow(/immutable usage recorder before dispatch/i);
    expect(adapter.calls).toHaveLength(0);
  });

  it("passes route timeout options during completion", async () => {
    const adapter = createMockAdapter({ id: "test-provider" });
    registry.register(adapter);

    const route = createDefaultRoute({ provider: "test-provider", timeoutMs: 1234, staleTimeoutMs: 567 });
    const result = await executor.complete({ messages: [] }, {}, {
      primaryRoute: route
    });

    expect(result.ok).toBe(true);
    expect(adapter.calls[0].options?.timeoutMs).toBe(1234);
    expect(adapter.calls[0].options?.staleTimeoutMs).toBe(567);
  });

  it("passes route timeout options during streaming", async () => {
    const adapter = createMockAdapter({ id: "test-provider" });
    registry.register(adapter);

    const route = createDefaultRoute({ provider: "test-provider", timeoutMs: 1234, staleTimeoutMs: 567 });
    const result = await executor.complete({ messages: [] }, {}, {
      primaryRoute: route,
      stream: true
    });

    expect(result.ok).toBe(true);
    expect(adapter.calls[0].options?.timeoutMs).toBe(1234);
    expect(adapter.calls[0].options?.staleTimeoutMs).toBe(567);
  });

  it("passes route maxTokens when request maxTokens is unset", async () => {
    const adapter = createMockAdapter({ id: "test-provider" });
    registry.register(adapter);

    const route = createDefaultRoute({ provider: "test-provider", maxTokens: 8192 });
    const result = await executor.complete({ messages: [] }, {}, {
      primaryRoute: route
    });

    expect(result.ok).toBe(true);
    expect(adapter.calls[0].request.maxTokens).toBe(8192);
    expect(route.maxTokens).toBe(8192);
  });

  it("lets request maxTokens override route maxTokens without mutating the route", async () => {
    const adapter = createMockAdapter({ id: "test-provider" });
    registry.register(adapter);

    const route = createDefaultRoute({ provider: "test-provider", maxTokens: 8192 });
    const result = await executor.complete({ messages: [], maxTokens: 2048 }, {}, {
      primaryRoute: route
    });

    expect(result.ok).toBe(true);
    expect(adapter.calls[0].request.maxTokens).toBe(2048);
    expect(route.maxTokens).toBe(8192);
  });

  it("omits maxTokens when neither request nor route sets it", async () => {
    const adapter = createMockAdapter({ id: "test-provider" });
    registry.register(adapter);

    const route = createDefaultRoute({ provider: "test-provider" });
    const result = await executor.complete({ messages: [] }, {}, {
      primaryRoute: route
    });

    expect(result.ok).toBe(true);
    expect(adapter.calls[0].request).not.toHaveProperty("maxTokens");
  });

  it("honors route-level apiKeyEnv during execution", async () => {
    const originalEnv = process.env.CUSTOM_OPENAI_KEY;
    process.env.CUSTOM_OPENAI_KEY = "sk-custom-key";

    try {
      const adapter = createMockAdapter({ id: "openai" });
      registry.register(adapter);

      const route = createDefaultRoute({ apiKeyEnv: "CUSTOM_OPENAI_KEY" });
      const result = await executor.complete({ messages: [] }, {}, {
        primaryRoute: route
      });

      expect(result.ok).toBe(true);
      expect(adapter.calls.length).toBe(1);
      expect(adapter.calls[0].options?.credential?.id).toBe("CUSTOM_OPENAI_KEY");
      expect(adapter.calls[0].options?.credential?.value).toBe("sk-custom-key");
    } finally {
      if (originalEnv === undefined) {
        delete process.env.CUSTOM_OPENAI_KEY;
      } else {
        process.env.CUSTOM_OPENAI_KEY = originalEnv;
      }
    }
  });

  it("same provider ID with different base URLs does not overwrite each other", async () => {
    const adapter = createMockAdapter({ id: "test-provider" });
    registry.register(adapter);

    const routeA = createDefaultRoute({ provider: "test-provider", baseUrl: "https://a.example.com/v1" });
    const routeB = createDefaultRoute({ provider: "test-provider", baseUrl: "https://b.example.com/v1" });

    await executor.complete({ messages: [] }, {}, { primaryRoute: routeA });
    await executor.complete({ messages: [] }, {}, { primaryRoute: routeB });

    expect(adapter.calls.length).toBe(2);
    expect(adapter.calls[0].options?.endpoint?.baseUrl).toBe("https://a.example.com/v1");
    expect(adapter.calls[1].options?.endpoint?.baseUrl).toBe("https://b.example.com/v1");
  });

  it("returns structured auth error for missing route credential", async () => {
    const originalEnv = process.env.MISSING_ROUTE_KEY;
    delete process.env.MISSING_ROUTE_KEY;

    try {
      const adapter = createMockAdapter({ id: "openai" });
      registry.register(adapter);

      const route = createDefaultRoute({ apiKeyEnv: "MISSING_ROUTE_KEY" });
      const result = await executor.complete({ messages: [] }, {}, {
        primaryRoute: route
      });

      expect(result.ok).toBe(false);
      expect(result.attempts.length).toBe(1);
      expect(result.attempts[0].errorClass).toBe("auth");
      expect(result.attempts[0]).toMatchObject({ state: "preflight" });
      expect(result.attempts[0]).not.toHaveProperty("dispatchedAt");
      expect(result.attempts[0].content).toBe("Missing env var MISSING_ROUTE_KEY");
      expect(adapter.calls.length).toBe(0);
    } finally {
      if (originalEnv !== undefined) {
        process.env.MISSING_ROUTE_KEY = originalEnv;
      }
    }
  });

  it("allows local no-key route to execute when setup mode allows it", async () => {
    const adapter = createMockAdapter({ id: "local" });
    registry.register(adapter);

    const route: ResolvedModelRoute = {
      provider: "local",
      id: "qwen3-coder:32b",
      profile: {
        id: "qwen3-coder:32b",
        provider: "local",
        contextWindowTokens: 32_000,
        supportsTools: true,
        supportsVision: false,
        supportsStructuredOutput: false
      }
    };

    const result = await executor.complete({ messages: [] }, {}, {
      primaryRoute: route
    });

    expect(result.ok).toBe(true);
    expect(adapter.calls.length).toBe(1);
    expect(adapter.calls[0].options?.credential).toBeUndefined();
  });

  it("does not leak secrets in runtime events", async () => {
    const originalEnv = process.env.LEAK_TEST_KEY;
    process.env.LEAK_TEST_KEY = "super-secret-value";

    try {
      const adapter = createMockAdapter({ id: "openai" });
      registry.register(adapter);

      const events: ProviderRuntimeEvent[] = [];
      const route = createDefaultRoute({ apiKeyEnv: "LEAK_TEST_KEY" });
      await executor.complete({ messages: [] }, {}, {
        primaryRoute: route,
        onEvent: (event) => {
          events.push(event);
        }
      });

      const eventJson = JSON.stringify(events);
      expect(eventJson).not.toContain("super-secret-value");
      expect(eventJson).not.toContain("sk-");
    } finally {
      if (originalEnv === undefined) {
        delete process.env.LEAK_TEST_KEY;
      } else {
        process.env.LEAK_TEST_KEY = originalEnv;
      }
    }
  });

  it("fails clearly without primaryRoute", async () => {
    const adapter = createMockAdapter({
      id: "test-provider",
      completeResponse: {
        ok: true,
        content: "should not be called",
        model: "legacy-model",
        provider: "test-provider"
      },
      models: [
        {
          id: "legacy-model",
          provider: "test-provider",
          contextWindowTokens: 128_000,
          supportsTools: true,
          supportsVision: true,
          supportsStructuredOutput: true
        }
      ]
    });
    registry.register(adapter);

    const result = await executor.complete({
      provider: "test-provider",
      model: "legacy-model",
      messages: []
    });

    expect(result.ok).toBe(false);
    expect(result.attempts.length).toBe(1);
    expect(result.attempts[0].errorClass).toBe("missing-route");
    expect(result.attempts[0]).toMatchObject({ state: "preflight" });
    expect(result.attempts[0].content).toContain("No explicit primary route");
    expect(adapter.calls.length).toBe(0);
  });

  it("fails early with clear not-executable error for catalog-only providers", async () => {
    const catalogAdapter = createMockAdapter({
      id: "anthropic",
      completeResponse: {
        ok: false,
        content: "should not be called",
        model: "claude-3",
        provider: "anthropic",
        errorClass: "unsupported"
      }
    });
    catalogAdapter.executable = false;
    registry.register(catalogAdapter);

    const route: ResolvedModelRoute = {
      provider: "anthropic",
      id: "claude-3",
      profile: {
        id: "claude-3",
        provider: "anthropic",
        contextWindowTokens: 200_000,
        supportsTools: true,
        supportsVision: true,
        supportsStructuredOutput: true
      }
    };

    const result = await executor.complete({ messages: [] }, {}, {
      primaryRoute: route
    });

    expect(result.ok).toBe(false);
    expect(result.attempts.length).toBe(1);
    expect(result.attempts[0].errorClass).toBe("unsupported");
    expect(result.attempts[0].content).toContain("not yet executable");
    expect(catalogAdapter.calls.length).toBe(0);
  });

  it("passes both baseUrl and apiKeyEnv when both are set on the route", async () => {
    const originalEnv = process.env.COMBINED_KEY;
    process.env.COMBINED_KEY = "combined-value";

    try {
      const adapter = createMockAdapter({ id: "openai" });
      registry.register(adapter);

      const route = createDefaultRoute({
        baseUrl: "https://combined.example.com/v1",
        apiKeyEnv: "COMBINED_KEY"
      });
      const result = await executor.complete({ messages: [] }, {}, {
        primaryRoute: route
      });

      expect(result.ok).toBe(true);
      expect(adapter.calls.length).toBe(1);
      expect(adapter.calls[0].options?.endpoint?.baseUrl).toBe("https://combined.example.com/v1");
      expect(adapter.calls[0].options?.endpoint?.apiKey).toEqual({ kind: "env", name: "COMBINED_KEY" });
      expect(adapter.calls[0].options?.credential?.value).toBe("combined-value");
    } finally {
      if (originalEnv === undefined) {
        delete process.env.COMBINED_KEY;
      } else {
        process.env.COMBINED_KEY = originalEnv;
      }
    }
  });

  it("streams with route-level endpoint override", async () => {
    const adapter = createMockAdapter({
      id: "test-provider",
      streamEvents: [
        { kind: "start", provider: "test-provider", model: "legacy-model" },
        { kind: "token", provider: "test-provider", model: "legacy-model", text: "hello" },
        { kind: "done", provider: "test-provider", model: "legacy-model", response: { ok: true, content: "hello", model: "legacy-model", provider: "test-provider" } }
      ]
    });
    registry.register(adapter);

    const route = createDefaultRoute({ provider: "test-provider", baseUrl: "https://stream.example.com/v1" });
    const result = await executor.complete({ messages: [] }, {}, {
      primaryRoute: route,
      stream: true
    });

    expect(result.ok).toBe(true);
    expect(adapter.calls.length).toBe(1);
    expect(adapter.calls[0].options?.endpoint?.baseUrl).toBe("https://stream.example.com/v1");
  });

  it("captures safe streaming diagnostics for a successful streamed attempt", async () => {
    const adapter = createMockAdapter({
      id: "test-provider",
      streamEvents: [
        { kind: "start", provider: "test-provider", model: "gpt-4o" },
        { kind: "token", provider: "test-provider", model: "gpt-4o", text: "hello" },
        {
          kind: "tool-call",
          provider: "test-provider",
          model: "gpt-4o",
          index: 0,
          id: "tool-1",
          name: "read_file",
          argumentsText: "{\"path\":\"src/index.ts\"}"
        },
        { kind: "token", provider: "test-provider", model: "gpt-4o", text: " world" },
        {
          kind: "done",
          provider: "test-provider",
          model: "gpt-4o",
          response: {
            ok: true,
            content: "hello world",
            model: "gpt-4o",
            provider: "test-provider",
            finishReason: "stop",
            reasoning: "hidden chain of thought",
            reasoningMetadata: {
              present: true,
              chars: "hidden chain of thought".length,
              format: "reasoning"
            }
          }
        }
      ]
    });
    registry.register(adapter);

    let nowMs = 1_000;
    const result = await executor.complete({ messages: [] }, {}, {
      primaryRoute: createDefaultRoute({ provider: "test-provider" }),
      stream: true,
      now: () => {
        const value = nowMs;
        nowMs += 5;
        return value;
      }
    });

    const diagnostics = result.attempts[0]?.streamDiagnostics;
    expect(result.ok).toBe(true);
    expect(diagnostics).toEqual(expect.objectContaining({
      stream: true,
      startedAtMs: 1_000,
      eventCount: 5,
      tokenChunks: 2,
      visibleChars: "hello world".length,
      toolCallChunks: 1,
      transportDone: false,
      finish: "done",
      finishReason: "stop",
      reasoningMetadata: {
        present: true,
        chars: "hidden chain of thought".length,
        format: "reasoning"
      }
    }));
    expect(diagnostics?.durationMs).toBeGreaterThan(0);
    expect(diagnostics?.firstEventMs).toBeGreaterThan(0);
    expect(diagnostics?.firstTokenMs).toBeGreaterThan(0);
    expect(JSON.stringify(diagnostics)).not.toContain("hidden chain of thought");
  });

  it("captures incomplete streaming diagnostics with bounded visible counters", async () => {
    const adapter = createMockAdapter({
      id: "test-provider",
      streamEvents: [
        { kind: "start", provider: "test-provider", model: "gpt-4o" },
        { kind: "token", provider: "test-provider", model: "gpt-4o", text: "partial" }
      ]
    });
    registry.register(adapter);

    const result = await executor.complete({ messages: [] }, {}, {
      primaryRoute: createDefaultRoute({ provider: "test-provider" }),
      stream: true
    });

    expect(result.ok).toBe(false);
    expect(result.attempts[0]?.streamDiagnostics).toEqual(expect.objectContaining({
      finish: "incomplete-stream",
      errorClass: "incomplete-stream",
      tokenChunks: 1,
      visibleChars: "partial".length,
      transportDone: false
    }));
  });

  it("keeps stream diagnostics separate across fallback attempts", async () => {
    const primaryAdapter = createMockAdapter({
      id: "primary",
      streamEvents: [
        { kind: "start", provider: "primary", model: "primary-model" },
        {
          kind: "error",
          provider: "primary",
          model: "primary-model",
          response: {
            ok: false,
            content: "Rate limited",
            model: "primary-model",
            provider: "primary",
            errorClass: "rate-limit"
          }
        }
      ]
    });
    const fallbackAdapter = createMockAdapter({
      id: "fallback",
      streamEvents: [
        { kind: "start", provider: "fallback", model: "fallback-model" },
        { kind: "token", provider: "fallback", model: "fallback-model", text: "fallback ok" },
        {
          kind: "done",
          provider: "fallback",
          model: "fallback-model",
          response: {
            ok: true,
            content: "fallback ok",
            model: "fallback-model",
            provider: "fallback"
          }
        }
      ]
    });
    registry.register(primaryAdapter);
    registry.register(fallbackAdapter);

    const result = await executor.complete({ messages: [] }, {}, {
      primaryRoute: createDefaultRoute({ provider: "primary", id: "primary-model" }),
      fallbackChain: [createDefaultRoute({ provider: "fallback", id: "fallback-model" })],
      stream: true
    });

    expect(result.ok).toBe(true);
    expect(result.fallbackUsed).toBe(true);
    expect(result.attempts[0]?.streamDiagnostics).toEqual(expect.objectContaining({
      finish: "error",
      errorClass: "rate-limit",
      tokenChunks: 0,
      visibleChars: 0
    }));
    expect(result.attempts[1]?.streamDiagnostics).toEqual(expect.objectContaining({
      finish: "done",
      tokenChunks: 1,
      visibleChars: "fallback ok".length
    }));
  });

  it("skips fallback routes that do not satisfy required vision", async () => {
    const primaryAdapter = createMockAdapter({
      id: "primary",
      completeResponse: {
        ok: false,
        content: "Rate limited",
        model: "primary-model",
        provider: "primary",
        errorClass: "rate-limit"
      }
    });
    const nonVisionAdapter = createMockAdapter({ id: "nonvision" });
    const visionAdapter = createMockAdapter({ id: "vision" });
    registry.register(primaryAdapter);
    registry.register(nonVisionAdapter);
    registry.register(visionAdapter);

    const nonVisionRoute = createDefaultRoute({
      provider: "nonvision",
      id: "nonvision-model",
      profile: {
        id: "nonvision-model",
        provider: "nonvision",
        contextWindowTokens: 128_000,
        supportsTools: true,
        supportsVision: false,
        supportsStructuredOutput: true
      }
    });
    const visionRoute = createDefaultRoute({
      provider: "vision",
      id: "vision-model",
      profile: {
        id: "vision-model",
        provider: "vision",
        contextWindowTokens: 128_000,
        supportsTools: true,
        supportsVision: true,
        supportsStructuredOutput: true
      }
    });

    const result = await executor.complete(
      { messages: [] },
      { requireVision: true },
      {
        primaryRoute: createDefaultRoute({ provider: "primary", id: "primary-model" }),
        fallbackChain: [nonVisionRoute, visionRoute]
      }
    );

    expect(result.ok).toBe(true);
    expect(result.fallbackUsed).toBe(true);
    expect(primaryAdapter.calls).toHaveLength(1);
    expect(nonVisionAdapter.calls).toHaveLength(0);
    expect(visionAdapter.calls).toHaveLength(1);
    expect(result.attempts[1]).toEqual(expect.objectContaining({
      provider: "nonvision",
      model: "nonvision-model",
      ok: false,
      errorClass: "unsupported",
      content: expect.stringContaining("does not support vision")
    }));
    expect(result.response?.provider).toBe("vision");
  });

  it("captures cancelled streaming diagnostics without counting the aborted token as visible", async () => {
    const controller = new AbortController();
    const calls: MockCall[] = [];
    const adapter: ProviderAdapter & { calls: MockCall[] } = {
      id: "test-provider",
      name: "test-provider mock",
      executable: true,
      health: () => ({ available: true }),
      listModels: () => [],
      complete: async (request, options) => {
        calls.push({ request, options });
        return { ok: true, content: "unused", model: request.model, provider: "test-provider" };
      },
      stream: async function* (request, options) {
        calls.push({ request, options });
        yield { kind: "start", provider: "test-provider", model: request.model };
        controller.abort("test cancellation");
        yield { kind: "token", provider: "test-provider", model: request.model, text: "should not count" };
      },
      calls
    };
    registry.register(adapter);

    const result = await executor.complete({ messages: [] }, {}, {
      primaryRoute: createDefaultRoute({ provider: "test-provider" }),
      stream: true,
      signal: controller.signal
    });

    expect(result.ok).toBe(false);
    expect(result.attempts[0]?.streamDiagnostics).toEqual(expect.objectContaining({
      finish: "cancelled",
      errorClass: "timeout",
      tokenChunks: 0,
      visibleChars: 0
    }));
  });

  it("openai_responses route executes without runnable=false rejection after metadata flip", async () => {
    tmpDir = await makeTempDir();
    await writeAuthJson(tmpDir, {
      version: 1,
      providers: {
        codex: {
          authMethod: "oauth_device_pkce",
          accessToken: "eyJfake.codex.token.12345",
          expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
          source: "estacoda"
        }
      }
    });

    const codexAdapter = createMockAdapter({ id: "codex" });
    registry.register(codexAdapter);

    const route: ResolvedModelRoute = {
      provider: "codex",
      id: "gpt-5.5",
      profile: {
        id: "gpt-5.5",
        provider: "codex",
        contextWindowTokens: 128_000,
        supportsTools: true,
        supportsVision: true,
        supportsStructuredOutput: true
      },
      apiMode: "openai_responses",
      authMethod: "oauth_device_pkce"
    };

    const exec = new ProviderExecutor({ registry, homeDir: tmpDir });
    const result = await exec.complete({ messages: [] }, {}, { primaryRoute: route });

    expect(result.ok).toBe(true);
    expect(codexAdapter.calls.length).toBe(1);
    expect(codexAdapter.calls[0].options?.credential?.id).toBe("codex:oauth");
  });

  it("openai_responses route resolves OAuth from the selected profile", async () => {
    tmpDir = await makeTempDir();
    writeActiveProfile("default", { homeDir: tmpDir });
    await writeAuthJson(tmpDir, {
      version: 1,
      providers: {
        codex: {
          authMethod: "oauth_device_pkce",
          accessToken: "research-codex-token",
          expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
          source: "estacoda"
        }
      }
    }, "research");

    const codexAdapter = createMockAdapter({ id: "codex" });
    registry.register(codexAdapter);

    const route: ResolvedModelRoute = {
      provider: "codex",
      id: "gpt-5.5",
      profile: {
        id: "gpt-5.5",
        provider: "codex",
        contextWindowTokens: 128_000,
        supportsTools: true,
        supportsVision: true,
        supportsStructuredOutput: true
      },
      apiMode: "openai_responses",
      authMethod: "oauth_device_pkce"
    };

    const exec = new ProviderExecutor({ registry, homeDir: tmpDir, profileId: "research" });
    const result = await exec.complete({ messages: [] }, {}, { primaryRoute: route });

    expect(result.ok).toBe(true);
    expect(codexAdapter.calls.length).toBe(1);
    expect(codexAdapter.calls[0].options?.credential).toEqual({
      id: "codex:oauth",
      value: "research-codex-token"
    });
  });

  it("Codex can be configured as the primary route", async () => {
    tmpDir = await makeTempDir();
    await writeAuthJson(tmpDir, {
      version: 1,
      providers: {
        codex: {
          authMethod: "oauth_device_pkce",
          accessToken: "eyJfake.codex.token.12345",
          expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
          source: "estacoda"
        }
      }
    });

    const codexAdapter = createMockAdapter({ id: "codex" });
    registry.register(codexAdapter);

    const route: ResolvedModelRoute = {
      provider: "codex",
      id: "gpt-5.5",
      profile: {
        id: "gpt-5.5",
        provider: "codex",
        contextWindowTokens: 128_000,
        supportsTools: true,
        supportsVision: true,
        supportsStructuredOutput: true
      },
      baseUrl: "https://chatgpt.com/backend-api/codex",
      apiMode: "openai_responses",
      authMethod: "oauth_device_pkce"
    };

    const exec = new ProviderExecutor({ registry, homeDir: tmpDir });
    const result = await exec.complete({ messages: [] }, {}, { primaryRoute: route });

    expect(result.ok).toBe(true);
    expect(result.attempts.length).toBe(1);
    expect(result.attempts[0].provider).toBe("codex");
    expect(codexAdapter.calls[0].options?.endpoint?.baseUrl).toBe("https://chatgpt.com/backend-api/codex");
  });

  it("Codex can be configured as a fallback route behind another provider", async () => {
    tmpDir = await makeTempDir();
    await writeAuthJson(tmpDir, {
      version: 1,
      providers: {
        codex: {
          authMethod: "oauth_device_pkce",
          accessToken: "eyJfake.codex.token.12345",
          expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
          source: "estacoda"
        }
      }
    });

    const primaryAdapter = createMockAdapter({
      id: "openai",
      completeResponse: {
        ok: false,
        content: "Rate limited",
        model: "gpt-4o",
        provider: "openai",
        errorClass: "rate-limit"
      }
    });
    const codexAdapter = createMockAdapter({ id: "codex" });
    registry.register(primaryAdapter);
    registry.register(codexAdapter);

    const primaryRoute = createDefaultRoute({ apiKeyEnv: "OPENAI_API_KEY" });
    const fallbackRoute: ResolvedModelRoute = {
      provider: "codex",
      id: "gpt-5.5",
      profile: {
        id: "gpt-5.5",
        provider: "codex",
        contextWindowTokens: 128_000,
        supportsTools: true,
        supportsVision: true,
        supportsStructuredOutput: true
      },
      apiMode: "openai_responses",
      authMethod: "oauth_device_pkce"
    };

    process.env.OPENAI_API_KEY = "test-key";
    const exec = new ProviderExecutor({ registry, homeDir: tmpDir });
    const result = await exec.complete({ messages: [] }, {}, {
      primaryRoute: primaryRoute,
      fallbackChain: [fallbackRoute]
    });
    delete process.env.OPENAI_API_KEY;

    expect(result.ok).toBe(true);
    expect(result.fallbackUsed).toBe(true);
    expect(primaryAdapter.calls.length).toBe(1);
    expect(codexAdapter.calls.length).toBe(1);
    expect(result.response?.provider).toBe("codex");
  });

  it("Codex can fall back to another provider using existing fallback behavior", async () => {
    tmpDir = await makeTempDir();
    await writeAuthJson(tmpDir, {
      version: 1,
      providers: {
        codex: {
          authMethod: "oauth_device_pkce",
          accessToken: "eyJfake.codex.token.12345",
          expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
          source: "estacoda"
        }
      }
    });

    const codexAdapter = createMockAdapter({
      id: "codex",
      completeResponse: {
        ok: false,
        content: "Auth failed",
        model: "gpt-5.5",
        provider: "codex",
        errorClass: "auth"
      }
    });
    const fallbackAdapter = createMockAdapter({ id: "fallback" });
    registry.register(codexAdapter);
    registry.register(fallbackAdapter);

    const primaryRoute: ResolvedModelRoute = {
      provider: "codex",
      id: "gpt-5.5",
      profile: {
        id: "gpt-5.5",
        provider: "codex",
        contextWindowTokens: 128_000,
        supportsTools: true,
        supportsVision: true,
        supportsStructuredOutput: true
      },
      apiMode: "openai_responses",
      authMethod: "oauth_device_pkce"
    };
    const fallbackRoute: ResolvedModelRoute = {
      provider: "fallback",
      id: "fallback-model",
      profile: {
        id: "fallback-model",
        provider: "fallback",
        contextWindowTokens: 128_000,
        supportsTools: true,
        supportsVision: false,
        supportsStructuredOutput: true
      }
    };

    const exec = new ProviderExecutor({ registry, homeDir: tmpDir });
    const result = await exec.complete({ messages: [] }, {}, {
      primaryRoute: primaryRoute,
      fallbackChain: [fallbackRoute]
    });

    expect(result.ok).toBe(true);
    expect(result.fallbackUsed).toBe(true);
    expect(codexAdapter.calls.length).toBe(1);
    expect(fallbackAdapter.calls.length).toBe(1);
  });

  it("Codex fallback use does not bypass OAuth credential resolution", async () => {
    tmpDir = await makeTempDir();
    // No auth.json written — missing OAuth credential

    const codexAdapter = createMockAdapter({ id: "codex" });
    const fallbackAdapter = createMockAdapter({ id: "fallback" });
    registry.register(codexAdapter);
    registry.register(fallbackAdapter);

    const primaryRoute: ResolvedModelRoute = {
      provider: "codex",
      id: "gpt-5.5",
      profile: {
        id: "gpt-5.5",
        provider: "codex",
        contextWindowTokens: 128_000,
        supportsTools: true,
        supportsVision: true,
        supportsStructuredOutput: true
      },
      apiMode: "openai_responses",
      authMethod: "oauth_device_pkce"
    };
    const fallbackRoute: ResolvedModelRoute = {
      provider: "fallback",
      id: "fallback-model",
      profile: {
        id: "fallback-model",
        provider: "fallback",
        contextWindowTokens: 128_000,
        supportsTools: true,
        supportsVision: false,
        supportsStructuredOutput: true
      }
    };

    const exec = new ProviderExecutor({ registry, homeDir: tmpDir });
    const result = await exec.complete({ messages: [] }, {}, {
      primaryRoute: primaryRoute,
      fallbackChain: [fallbackRoute]
    });

    expect(result.ok).toBe(true);
    expect(result.fallbackUsed).toBe(true);
    expect(codexAdapter.calls.length).toBe(0);
    expect(fallbackAdapter.calls.length).toBe(1);
    expect(result.attempts[0].errorClass).toBe("auth");
    expect(result.attempts[0].content).toContain("requires OAuth authentication");
  });

  it("Codex primary/fallback route config uses same route schema as API-key providers with authMethod instead of apiKeyEnv", async () => {
    const codexRoute: ResolvedModelRoute = {
      provider: "codex",
      id: "gpt-5.5",
      profile: {
        id: "gpt-5.5",
        provider: "codex",
        contextWindowTokens: 128_000,
        supportsTools: true,
        supportsVision: true,
        supportsStructuredOutput: true
      },
      baseUrl: "https://chatgpt.com/backend-api/codex",
      apiMode: "openai_responses",
      authMethod: "oauth_device_pkce"
    };

    expect(codexRoute).toHaveProperty("authMethod", "oauth_device_pkce");
    expect(codexRoute).not.toHaveProperty("apiKeyEnv");
    expect(codexRoute.baseUrl).toBe("https://chatgpt.com/backend-api/codex");
    expect(codexRoute.apiMode).toBe("openai_responses");
  });

  it("registered adapter for anthropic does not execute while metadata says non-runnable / unsupported mode", async () => {
    const anthropicAdapter = createMockAdapter({ id: "anthropic" });
    registry.register(anthropicAdapter);

    const route: ResolvedModelRoute = {
      provider: "anthropic",
      id: "claude-3-opus",
      profile: {
        id: "claude-3-opus",
        provider: "anthropic",
        contextWindowTokens: 200_000,
        supportsTools: true,
        supportsVision: true,
        supportsStructuredOutput: true
      }
    };

    const result = await executor.complete({ messages: [] }, {}, { primaryRoute: route });

    expect(result.ok).toBe(false);
    expect(result.attempts.length).toBe(1);
    expect(result.attempts[0].errorClass).toBe("unsupported");
    expect(anthropicAdapter.calls.length).toBe(0);
  });

    it("openai_responses route executes when provider is runnable and adapter is registered", async () => {
    const mockAdapter = createMockAdapter({ id: "openai" });
    registry.register(mockAdapter);
    process.env.OPENAI_API_KEY = "sk-test";

    try {
      const route = createDefaultRoute({ apiMode: "openai_responses", apiKeyEnv: "OPENAI_API_KEY" });
      const result = await executor.complete({ messages: [] }, {}, { primaryRoute: route });

      expect(result.ok).toBe(true);
      expect(mockAdapter.calls.length).toBe(1);
    } finally {
      delete process.env.OPENAI_API_KEY;
    }
  });

  it("legitimate runnable OpenAI-compatible providers still execute", async () => {
    const openaiAdapter = createMockAdapter({ id: "openai" });
    registry.register(openaiAdapter);
    process.env.OPENAI_API_KEY = "sk-test";

    try {
      const route = createDefaultRoute({ apiMode: "openai_chat_completions", apiKeyEnv: "OPENAI_API_KEY" });
      const result = await executor.complete({ messages: [] }, {}, { primaryRoute: route });

      expect(result.ok).toBe(true);
      expect(openaiAdapter.calls.length).toBe(1);
    } finally {
      delete process.env.OPENAI_API_KEY;
    }
  });

  it("custom route with explicit base URL and executable API mode still works", async () => {
    process.env.CUSTOM_API_KEY = "custom-secret";
    const customAdapter = createMockAdapter({ id: "custom-provider" });
    registry.register(customAdapter);

    try {
      const route: ResolvedModelRoute = {
        provider: "custom-provider",
        id: "custom-model",
        profile: {
          id: "custom-model",
          provider: "custom-provider",
          contextWindowTokens: 128_000,
          supportsTools: false,
          supportsVision: false,
          supportsStructuredOutput: false
        },
        baseUrl: "https://custom.example.com/v1",
        apiMode: "custom_openai_compatible"
      };

      const result = await executor.complete({ messages: [] }, {}, { primaryRoute: route });

      expect(result.ok).toBe(true);
      expect(customAdapter.calls.length).toBe(1);
      expect(customAdapter.calls[0].options?.endpoint?.baseUrl).toBe("https://custom.example.com/v1");
    } finally {
      delete process.env.CUSTOM_API_KEY;
    }
  });
});
