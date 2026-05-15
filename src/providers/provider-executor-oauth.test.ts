import { describe, expect, it, beforeEach, afterEach } from "vitest";
import type {
  ProviderAdapter,
  ProviderCompletionOptions,
  ProviderRequest,
  ProviderResponse,
  ResolvedModelRoute
} from "../contracts/provider.js";
import { ProviderExecutor, type ProviderExecutionOptions, type ProviderRuntimeEvent } from "./provider-executor.js";
import { ProviderRegistry } from "./provider-registry.js";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

type MockCall = {
  request: ProviderRequest;
  options?: ProviderCompletionOptions;
};

function createMockAdapter(options: {
  id: string;
  responses: ProviderResponse[];
}): ProviderAdapter & { calls: MockCall[] } {
  const calls: MockCall[] = [];
  let callIndex = 0;
  return {
    id: options.id as any,
    name: `${options.id} mock`,
    executable: true,
    health() {
      return { available: true };
    },
    listModels() {
      return [];
    },
    async complete(request: ProviderRequest, completionOptions?: ProviderCompletionOptions): Promise<ProviderResponse> {
      calls.push({ request, options: completionOptions });
      const response = options.responses[callIndex] ?? {
        ok: true,
        content: "mock-response",
        model: request.model,
        provider: options.id as any
      };
      callIndex++;
      return response;
    },
    calls
  };
}

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "estacoda-oauth-executor-test-"));
}

async function writeAuthJson(homeDir: string, store: unknown): Promise<void> {
  const path = join(homeDir, ".estacoda", "auth.json");
  await mkdir(join(homeDir, ".estacoda"), { recursive: true });
  await writeFile(path, JSON.stringify(store, null, 2) + "\n", "utf8");
}

async function readAuthJson(homeDir: string): Promise<unknown> {
  const path = join(homeDir, ".estacoda", "auth.json");
  const content = await readFile(path, "utf8");
  return JSON.parse(content);
}

function createOAuthRoute(overrides?: Partial<ResolvedModelRoute>): ResolvedModelRoute {
  return {
    provider: "oauth-provider",
    id: "test-model",
    profile: {
      id: "test-model",
      provider: "oauth-provider",
      contextWindowTokens: 128_000,
      supportsTools: true,
      supportsVision: false,
      supportsStructuredOutput: true
    },
    authMethod: "oauth_device_pkce",
    ...overrides
  };
}

describe("ProviderExecutor OAuth 401 refresh/retry", () => {
  let registry: ProviderRegistry;
  let tmpDir: string;

  let originalFetch: typeof globalThis.fetch;

  beforeEach(async () => {
    registry = new ProviderRegistry();
    tmpDir = await makeTempDir();
    originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      ({
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({
          access_token: "new-access-token",
          refresh_token: "new-refresh-token",
          expires_in: 3600
        }),
        text: async () => "",
        body: null
      }) as any;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("401 auth error triggers OAuth refresh and retries once", async () => {
    await writeAuthJson(tmpDir, {
      version: 1,
      providers: {
        "oauth-provider": {
          authMethod: "oauth_device_pkce",
          accessToken: "eyJfake.codex.token.12345",
          refreshToken: "def502.fake.refresh.token.67890",
          expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
          source: "estacoda"
        }
      }
    });

    const adapter = createMockAdapter({
      id: "oauth-provider",
      responses: [
        { ok: false, content: "Unauthorized", model: "test-model", provider: "oauth-provider", errorClass: "auth" },
        { ok: true, content: "success-after-refresh", model: "test-model", provider: "oauth-provider" }
      ]
    });
    registry.register(adapter);

    const executor = new ProviderExecutor({ registry, homeDir: tmpDir });
    const route = createOAuthRoute();
    const result = await executor.complete({ messages: [] }, {}, { primaryRoute: route });

    expect(result.ok).toBe(true);
    expect(result.attempts.length).toBe(2);
    expect(adapter.calls.length).toBe(2);
    expect(result.attempts[0].ok).toBe(false);
    expect(result.attempts[0].errorClass).toBe("auth");
    expect(result.attempts[1].ok).toBe(true);
    expect(result.attempts[1].content).toBe("success-after-refresh");
  });

  it("Retry succeeds on second attempt", async () => {
    await writeAuthJson(tmpDir, {
      version: 1,
      providers: {
        "oauth-provider": {
          authMethod: "oauth_device_pkce",
          accessToken: "eyJfake.codex.token.12345",
          refreshToken: "def502.fake.refresh.token.67890",
          expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
          source: "estacoda"
        }
      }
    });

    const adapter = createMockAdapter({
      id: "oauth-provider",
      responses: [
        { ok: false, content: "Unauthorized", model: "test-model", provider: "oauth-provider", errorClass: "auth" },
        { ok: true, content: "second-attempt-ok", model: "test-model", provider: "oauth-provider" }
      ]
    });
    registry.register(adapter);

    const executor = new ProviderExecutor({ registry, homeDir: tmpDir });
    const route = createOAuthRoute();
    const result = await executor.complete({ messages: [] }, {}, { primaryRoute: route });

    expect(result.ok).toBe(true);
    expect(result.attempts.length).toBe(2);
    expect(adapter.calls.length).toBe(2);
    expect(result.attempts[1].content).toBe("second-attempt-ok");
  });

  it("Second auth failure stops with actionable diagnostic", async () => {
    await writeAuthJson(tmpDir, {
      version: 1,
      providers: {
        "oauth-provider": {
          authMethod: "oauth_device_pkce",
          accessToken: "eyJfake.codex.token.12345",
          refreshToken: "def502.fake.refresh.token.67890",
          expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
          source: "estacoda"
        }
      }
    });

    const adapter = createMockAdapter({
      id: "oauth-provider",
      responses: [
        { ok: false, content: "Unauthorized", model: "test-model", provider: "oauth-provider", errorClass: "auth" },
        { ok: false, content: "Still unauthorized", model: "test-model", provider: "oauth-provider", errorClass: "auth" }
      ]
    });
    registry.register(adapter);

    const executor = new ProviderExecutor({ registry, homeDir: tmpDir });
    const route = createOAuthRoute();
    const result = await executor.complete({ messages: [] }, {}, { primaryRoute: route });

    expect(result.ok).toBe(false);
    expect(result.attempts.length).toBe(2);
    expect(adapter.calls.length).toBe(2);
    expect(result.attempts[1].content).toContain("authentication failed after 2 attempt");
    expect(result.attempts[1].content).toContain("estacoda model setup oauth-provider");
  });

  it("Max total attempts is 2", async () => {
    await writeAuthJson(tmpDir, {
      version: 1,
      providers: {
        "oauth-provider": {
          authMethod: "oauth_device_pkce",
          accessToken: "eyJfake.codex.token.12345",
          refreshToken: "def502.fake.refresh.token.67890",
          expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
          source: "estacoda"
        }
      }
    });

    const adapter = createMockAdapter({
      id: "oauth-provider",
      responses: [
        { ok: false, content: "Unauthorized", model: "test-model", provider: "oauth-provider", errorClass: "auth" },
        { ok: false, content: "Still unauthorized", model: "test-model", provider: "oauth-provider", errorClass: "auth" }
      ]
    });
    registry.register(adapter);

    const executor = new ProviderExecutor({ registry, homeDir: tmpDir });
    const route = createOAuthRoute();
    const result = await executor.complete({ messages: [] }, {}, { primaryRoute: route });

    expect(result.ok).toBe(false);
    expect(adapter.calls.length).toBe(2);
    expect(result.attempts.length).toBe(2);
  });

  it("Non-auth error does not trigger refresh", async () => {
    await writeAuthJson(tmpDir, {
      version: 1,
      providers: {
        "oauth-provider": {
          authMethod: "oauth_device_pkce",
          accessToken: "eyJfake.codex.token.12345",
          refreshToken: "def502.fake.refresh.token.67890",
          expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
          source: "estacoda"
        }
      }
    });

    const adapter = createMockAdapter({
      id: "oauth-provider",
      responses: [
        { ok: false, content: "Rate limited", model: "test-model", provider: "oauth-provider", errorClass: "rate-limit" }
      ]
    });
    registry.register(adapter);

    const executor = new ProviderExecutor({ registry, homeDir: tmpDir });
    const route = createOAuthRoute();
    const result = await executor.complete({ messages: [] }, {}, { primaryRoute: route });

    expect(result.ok).toBe(false);
    expect(result.attempts.length).toBe(1);
    expect(adapter.calls.length).toBe(1);
    expect(result.attempts[0].errorClass).toBe("rate-limit");
  });

  it("API-key provider 401 does not trigger OAuth refresh", async () => {
    process.env.API_KEY = "test-key";
    const adapter = createMockAdapter({
      id: "openai",
      responses: [
        { ok: false, content: "Unauthorized", model: "gpt-4o", provider: "openai", errorClass: "auth" }
      ]
    });
    registry.register(adapter);

    const executor = new ProviderExecutor({ registry, homeDir: tmpDir });
    const route: ResolvedModelRoute = {
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
      apiKeyEnv: "API_KEY"
    };
    const result = await executor.complete({ messages: [] }, {}, { primaryRoute: route });

    expect(result.ok).toBe(false);
    expect(result.attempts.length).toBe(1);
    expect(adapter.calls.length).toBe(1);
    delete process.env.API_KEY;
  });

  it("Missing OAuth credential does not trigger adapter call or refresh", async () => {
    const adapter = createMockAdapter({
      id: "oauth-provider",
      responses: [
        { ok: false, content: "Unauthorized", model: "test-model", provider: "oauth-provider", errorClass: "auth" }
      ]
    });
    registry.register(adapter);

    const executor = new ProviderExecutor({ registry, homeDir: tmpDir });
    const route = createOAuthRoute();
    const result = await executor.complete({ messages: [] }, {}, { primaryRoute: route });

    expect(result.ok).toBe(false);
    expect(result.attempts.length).toBe(1);
    expect(adapter.calls.length).toBe(0);
    expect(result.attempts[0].errorClass).toBe("auth");
    expect(result.attempts[0].content).toContain("requires OAuth authentication");
  });

  it("Refresh failure stops retry and returns diagnostic", async () => {
    await writeAuthJson(tmpDir, {
      version: 1,
      providers: {
        "oauth-provider": {
          authMethod: "oauth_device_pkce",
          accessToken: "eyJfake.codex.token.12345",
          expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
          source: "estacoda"
        }
      }
    });

    const adapter = createMockAdapter({
      id: "oauth-provider",
      responses: [
        { ok: false, content: "Unauthorized", model: "test-model", provider: "oauth-provider", errorClass: "auth" }
      ]
    });
    registry.register(adapter);

    const executor = new ProviderExecutor({ registry, homeDir: tmpDir });
    const route = createOAuthRoute();
    const result = await executor.complete({ messages: [] }, {}, { primaryRoute: route });

    expect(result.ok).toBe(false);
    expect(result.attempts.length).toBe(1);
    expect(adapter.calls.length).toBe(1);
    expect(result.attempts[0].content).toContain("authentication failed");
  });

  it("Successful refresh updates auth.json", async () => {
    await writeAuthJson(tmpDir, {
      version: 1,
      providers: {
        "oauth-provider": {
          authMethod: "oauth_device_pkce",
          accessToken: "old-access",
          refreshToken: "valid-refresh",
          expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
          source: "estacoda"
        }
      }
    });

    const adapter = createMockAdapter({
      id: "oauth-provider",
      responses: [
        { ok: false, content: "Unauthorized", model: "test-model", provider: "oauth-provider", errorClass: "auth" },
        { ok: true, content: "success", model: "test-model", provider: "oauth-provider" }
      ]
    });
    registry.register(adapter);

    const executor = new ProviderExecutor({ registry, homeDir: tmpDir });
    const route = createOAuthRoute();
    const result = await executor.complete({ messages: [] }, {}, { primaryRoute: route });

    expect(result.ok).toBe(true);

    const auth = (await readAuthJson(tmpDir)) as any;
    expect(auth.providers["oauth-provider"].accessToken).toBe("new-access-token");
    expect(auth.providers["oauth-provider"].refreshToken).toBe("new-refresh-token");
  });

  it("Attempt events never include token values", async () => {
    await writeAuthJson(tmpDir, {
      version: 1,
      providers: {
        "oauth-provider": {
          authMethod: "oauth_device_pkce",
          accessToken: "eyJfake.codex.token.12345",
          refreshToken: "def502.fake.refresh.token.67890",
          expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
          source: "estacoda"
        }
      }
    });

    const adapter = createMockAdapter({
      id: "oauth-provider",
      responses: [
        { ok: false, content: "Unauthorized", model: "test-model", provider: "oauth-provider", errorClass: "auth" },
        { ok: true, content: "success", model: "test-model", provider: "oauth-provider" }
      ]
    });
    registry.register(adapter);

    const executor = new ProviderExecutor({ registry, homeDir: tmpDir });
    const events: ProviderRuntimeEvent[] = [];
    const route = createOAuthRoute();
    const result = await executor.complete({ messages: [] }, {}, {
      primaryRoute: route,
      onEvent: (event) => {
        events.push(event);
      }
    });

    const allOutput = JSON.stringify(events) + JSON.stringify(result.attempts) + JSON.stringify(result.response);
    expect(allOutput).not.toContain("eyJfake.codex.token.12345");
    expect(allOutput).not.toContain("def502.fake.refresh.token.67890");
    expect(allOutput).not.toContain("Bearer");
    expect(allOutput).not.toContain("accessToken");
    expect(allOutput).not.toContain("refreshToken");
  });

  it("Codex primary auth exhaustion proceeds to next eligible fallback route", async () => {
    await writeAuthJson(tmpDir, {
      version: 1,
      providers: {
        "oauth-provider": {
          authMethod: "oauth_device_pkce",
          accessToken: "eyJfake.codex.token.12345",
          refreshToken: "def502.fake.refresh.token.67890",
          expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
          source: "estacoda"
        }
      }
    });

    const primaryAdapter = createMockAdapter({
      id: "oauth-provider",
      responses: [
        { ok: false, content: "Unauthorized", model: "test-model", provider: "oauth-provider", errorClass: "auth" },
        { ok: false, content: "Still unauthorized", model: "test-model", provider: "oauth-provider", errorClass: "auth" }
      ]
    });
    const fallbackAdapter = createMockAdapter({
      id: "fallback",
      responses: [
        { ok: true, content: "fallback-success", model: "fallback-model", provider: "fallback" }
      ]
    });
    registry.register(primaryAdapter);
    registry.register(fallbackAdapter);

    const executor = new ProviderExecutor({ registry, homeDir: tmpDir });
    const primaryRoute = createOAuthRoute();
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

    const result = await executor.complete({ messages: [] }, {}, {
      primaryRoute: primaryRoute,
      fallbackChain: [fallbackRoute]
    });

    expect(result.ok).toBe(true);
    expect(result.fallbackUsed).toBe(true);
    expect(result.attempts.length).toBe(3);
    expect(primaryAdapter.calls.length).toBe(2);
    expect(fallbackAdapter.calls.length).toBe(1);
    expect(result.response?.content).toBe("fallback-success");
  });

  it("Codex fallback route retry happens only when fallback route is reached", async () => {
    process.env.OPENAI_API_KEY = "test-key";

    try {
      await writeAuthJson(tmpDir, {
        version: 1,
        providers: {
          "oauth-provider": {
            authMethod: "oauth_device_pkce",
            accessToken: "eyJfake.codex.token.12345",
            refreshToken: "def502.fake.refresh.token.67890",
            expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
            source: "estacoda"
          }
        }
      });

      const primaryAdapter = createMockAdapter({
        id: "openai",
        responses: [
          { ok: true, content: "primary-success", model: "gpt-4o", provider: "openai" }
        ]
      });
      const fallbackAdapter = createMockAdapter({
        id: "oauth-provider",
        responses: [
          { ok: true, content: "fallback-success", model: "test-model", provider: "oauth-provider" }
        ]
      });
      registry.register(primaryAdapter);
      registry.register(fallbackAdapter);

      const executor = new ProviderExecutor({ registry, homeDir: tmpDir });
      const primaryRoute: ResolvedModelRoute = {
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
        apiKeyEnv: "OPENAI_API_KEY"
      };
      const fallbackRoute = createOAuthRoute();

      const result = await executor.complete({ messages: [] }, {}, {
        primaryRoute: primaryRoute,
        fallbackChain: [fallbackRoute]
      });

      expect(result.ok).toBe(true);
      expect(result.fallbackUsed).toBe(false);
      expect(primaryAdapter.calls.length).toBe(1);
      expect(fallbackAdapter.calls.length).toBe(0);
    } finally {
      delete process.env.OPENAI_API_KEY;
    }
  });

  it("Codex fallback route retry does not reset the overall route chain", async () => {
    process.env.OPENAI_API_KEY = "test-key";

    try {
      await writeAuthJson(tmpDir, {
        version: 1,
        providers: {
          "oauth-provider": {
            authMethod: "oauth_device_pkce",
            accessToken: "eyJfake.codex.token.12345",
            refreshToken: "def502.fake.refresh.token.67890",
            expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
            source: "estacoda"
          }
        }
      });

      const primaryAdapter = createMockAdapter({
        id: "openai",
        responses: [
          { ok: false, content: "Rate limited", model: "gpt-4o", provider: "openai", errorClass: "rate-limit" }
        ]
      });
      const fallbackAdapter = createMockAdapter({
        id: "oauth-provider",
        responses: [
          { ok: false, content: "Unauthorized", model: "test-model", provider: "oauth-provider", errorClass: "auth" },
          { ok: true, content: "fallback-success", model: "test-model", provider: "oauth-provider" }
        ]
      });
      registry.register(primaryAdapter);
      registry.register(fallbackAdapter);

      const executor = new ProviderExecutor({ registry, homeDir: tmpDir });
      const primaryRoute: ResolvedModelRoute = {
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
        apiKeyEnv: "OPENAI_API_KEY"
      };
      const fallbackRoute = createOAuthRoute();

      const result = await executor.complete({ messages: [] }, {}, {
        primaryRoute: primaryRoute,
        fallbackChain: [fallbackRoute]
      });

      expect(result.ok).toBe(true);
      expect(result.fallbackUsed).toBe(true);
      expect(result.attempts.length).toBe(3);
      expect(result.attempts[0].provider).toBe("openai");
      expect(result.attempts[1].provider).toBe("oauth-provider");
      expect(result.attempts[2].provider).toBe("oauth-provider");
      expect(primaryAdapter.calls.length).toBe(1);
      expect(fallbackAdapter.calls.length).toBe(2);
      expect(result.response?.content).toBe("fallback-success");
    } finally {
      delete process.env.OPENAI_API_KEY;
    }
  });

  it("Previous provider is not retried after Codex fallback refresh", async () => {
    process.env.OPENAI_API_KEY = "test-key";

    try {
      await writeAuthJson(tmpDir, {
        version: 1,
        providers: {
          "oauth-provider": {
            authMethod: "oauth_device_pkce",
            accessToken: "eyJfake.codex.token.12345",
            refreshToken: "def502.fake.refresh.token.67890",
            expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
            source: "estacoda"
          }
        }
      });

      const primaryAdapter = createMockAdapter({
        id: "openai",
        responses: [
          { ok: false, content: "Rate limited", model: "gpt-4o", provider: "openai", errorClass: "rate-limit" }
        ]
      });
      const fallbackAdapter = createMockAdapter({
        id: "oauth-provider",
        responses: [
          { ok: false, content: "Unauthorized", model: "test-model", provider: "oauth-provider", errorClass: "auth" },
          { ok: true, content: "fallback-success", model: "test-model", provider: "oauth-provider" }
        ]
      });
      registry.register(primaryAdapter);
      registry.register(fallbackAdapter);

      const executor = new ProviderExecutor({ registry, homeDir: tmpDir });
      const primaryRoute: ResolvedModelRoute = {
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
        apiKeyEnv: "OPENAI_API_KEY"
      };
      const fallbackRoute = createOAuthRoute();

      const result = await executor.complete({ messages: [] }, {}, {
        primaryRoute: primaryRoute,
        fallbackChain: [fallbackRoute]
      });

      expect(result.ok).toBe(true);
      expect(primaryAdapter.calls.length).toBe(1);
      expect(fallbackAdapter.calls.length).toBe(2);
    } finally {
      delete process.env.OPENAI_API_KEY;
    }
  });
});
