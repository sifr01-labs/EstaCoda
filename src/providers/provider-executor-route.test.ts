import { describe, expect, it, beforeEach, afterEach } from "vitest";
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

describe("ProviderExecutor route-based execution", () => {
  let registry: ProviderRegistry;
  let executor: ProviderExecutor;

  beforeEach(() => {
    registry = new ProviderRegistry();
    executor = new ProviderExecutor({ registry });
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

  it("falls back to credential pool when route has no apiKeyEnv", async () => {
    const { CredentialPool, CredentialPoolRegistry } = await import("./credential-pool.js");
    const poolRegistry = new CredentialPoolRegistry();
    poolRegistry.register(new CredentialPool({
      provider: "openai",
      entries: [
        {
          id: "openai-pool-1",
          source: { kind: "literal", value: "pool-secret" },
          priority: 1
        }
      ]
    }));

    const adapter = createMockAdapter({ id: "openai" });
    registry.register(adapter);

    const route = createDefaultRoute();
    const exec = new ProviderExecutor({ registry, credentialPools: poolRegistry });
    const result = await exec.complete({ messages: [] }, {}, {
      primaryRoute: route
    });

    expect(result.ok).toBe(true);
    expect(adapter.calls.length).toBe(1);
    expect(adapter.calls[0].options?.credential?.id).toBe("openai-pool-1");
    expect(adapter.calls[0].options?.credential?.value).toBe("pool-secret");
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
});
