import { afterEach, describe, expect, it } from "vitest";
import type { LoadedRuntimeConfig } from "../../config/runtime-config.js";
import type { ModelProfile, ProviderAdapter, ProviderId, ResolvedModelRoute } from "../../contracts/provider.js";
import { ProviderRegistry } from "../../providers/provider-registry.js";
import { normalizeDelegationConfig } from "../../config/runtime-config.js";
import { normalizeMemoryConfig } from "../../config/memory-config.js";
import { diagnoseProviderChain } from "./provider-chain.js";

const primaryProfile: ModelProfile = {
  id: "gpt-5",
  provider: "openai",
  contextWindowTokens: 128_000,
  supportsTools: true,
  supportsVision: true,
  supportsStructuredOutput: true
};

const fallbackProfile: ModelProfile = {
  ...primaryProfile,
  id: "claude-sonnet",
  provider: "openrouter"
};

const codexProfile: ModelProfile = {
  ...primaryProfile,
  id: "gpt-5.5",
  provider: "codex"
};

function adapter(id: ProviderId, models: ModelProfile[]): ProviderAdapter {
  return {
    id,
    name: id,
    executable: true,
    health: () => ({ available: true }),
    listModels: () => models,
    complete: async (request) => ({
      ok: true,
      content: "OK",
      provider: id,
      model: request.model
    })
  };
}

function route(overrides: Partial<ResolvedModelRoute> = {}): ResolvedModelRoute {
  return {
    provider: "openai",
    id: "gpt-5",
    profile: primaryProfile,
    authMethod: "api_key",
    apiKeyEnv: "TEST_OPENAI_KEY",
    ...overrides
  };
}

function loadedConfig(overrides: {
  readonly primaryRoute?: ResolvedModelRoute;
  readonly fallbackRoutes?: ResolvedModelRoute[];
  readonly registry?: ProviderRegistry;
  readonly providers?: LoadedRuntimeConfig["config"]["providers"];
  readonly auxiliaryModels?: LoadedRuntimeConfig["auxiliaryModels"];
} = {}): LoadedRuntimeConfig {
  const registry = overrides.registry ?? new ProviderRegistry();
  if (overrides.registry === undefined) {
    registry.register(adapter("openai", [primaryProfile]));
    registry.register(adapter("openrouter", [fallbackProfile]));
  }

  return {
    config: {
      model: { provider: "openai", id: "gpt-5" },
      providers: overrides.providers ?? {
        openai: { enableNetwork: true, apiKeyEnv: "TEST_OPENAI_KEY" },
        openrouter: { enableNetwork: true, apiKeyEnv: "OPENROUTER_API_KEY" }
      },
      auxiliaryModels: overrides.auxiliaryModels
    },
    sources: [],
    homeDir: "/tmp/estacoda-test-home",
    profileId: "default",
    model: primaryProfile,
    primaryModelRoute: overrides.primaryRoute ?? route(),
    modelFallbackRoutes: overrides.fallbackRoutes ?? [],
    providerRegistry: registry,
    auxiliaryModels: overrides.auxiliaryModels ?? {},
    web: { enableNetwork: false },
    compression: {
      enabled: false,
      threshold: 0.5,
      targetRatio: 0.2,
      protectFirstN: 3,
      protectLastN: 20
    },
    memory: normalizeMemoryConfig(undefined),
    externalMemory: {
      enabled: false,
      timeoutMs: 750,
      maxResults: 3,
      maxChars: 2500,
      mirrorWrites: false
    },
    delegation: normalizeDelegationConfig(undefined),
    browser: { backend: "unconfigured", autoLaunch: false, supervised: false },
    imageGen: { provider: "fal", model: "test", useGateway: false },
    gateway: { lifecycleNotifications: { enabled: false } },
    tts: { provider: "edge", speed: 1 },
    stt: { provider: "local" },
    voice: { autoTts: false },
    mcp: { servers: {} },
    skills: { externalDirs: [], autonomy: "suggest", config: {} },
    ui: { language: "en", flavor: "standard", activityLabels: "en", showResponseProgress: false },
    profile: { mode: "focused", responseLanguage: "en" },
    security: {
      approvalMode: "adaptive",
      allowPrivateUrls: false,
      websiteBlocklist: {},
      assessor: { enabled: false, timeoutMs: 30_000 }
    },
    channels: {
      telegram: { ready: false },
      discord: { ready: false },
      email: { ready: false },
      whatsapp: { ready: false }
    }
  } as LoadedRuntimeConfig;
}

describe("diagnoseProviderChain", () => {
  const originalOpenAiKey = process.env.TEST_OPENAI_KEY;
  const originalOpenRouterKey = process.env.OPENROUTER_API_KEY;

  afterEach(() => {
    restoreEnv("TEST_OPENAI_KEY", originalOpenAiKey);
    restoreEnv("OPENROUTER_API_KEY", originalOpenRouterKey);
  });

  it("reports primary and fallback routes with missing fallback env as warning", async () => {
    process.env.TEST_OPENAI_KEY = "sk-test";
    delete process.env.OPENROUTER_API_KEY;

    const diagnostic = await diagnoseProviderChain(loadedConfig({
      fallbackRoutes: [
        route({
          provider: "openrouter",
          id: "claude-sonnet",
          profile: fallbackProfile,
          apiKeyEnv: "OPENROUTER_API_KEY"
        })
      ]
    }));

    expect(diagnostic.status).toBe("warning");
    expect(diagnostic.unavailableCount).toBe(1);
    expect(diagnostic.routes).toEqual([
      expect.objectContaining({ kind: "primary", label: "primary", status: "ready" }),
      expect.objectContaining({
        kind: "fallback",
        label: "fallback 1",
        status: "warning",
        summary: expect.stringContaining("missing env var OPENROUTER_API_KEY")
      })
    ]);
  });

  it("includes auxiliary routes resolved from auxiliaryModels", async () => {
    process.env.TEST_OPENAI_KEY = "sk-test";

    const diagnostic = await diagnoseProviderChain(loadedConfig({
      auxiliaryModels: {
        assessor: { provider: "main" },
        vision: { enabled: false }
      }
    }));

    expect(diagnostic.routes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "auxiliary", label: "assessor", status: "ready" }),
      expect.objectContaining({ kind: "auxiliary", label: "vision", status: "disabled" })
    ]));
  });

  it("does not report implicit normalized auxiliary defaults when none are configured", async () => {
    process.env.TEST_OPENAI_KEY = "sk-test";

    const diagnostic = await diagnoseProviderChain(loadedConfig());

    expect(diagnostic.routes.map((route) => route.kind)).toEqual(["primary"]);
    expect(diagnostic.unavailableCount).toBe(0);
  });

  it("does not include raw credential values in route warnings", async () => {
    delete process.env.TEST_OPENAI_KEY;

    const diagnostic = await diagnoseProviderChain(loadedConfig());
    const serializedRoutes = JSON.stringify(diagnostic.routes);

    expect(diagnostic.warnings).toEqual([]);
    expect(serializedRoutes).toContain("TEST_OPENAI_KEY");
    expect(serializedRoutes).not.toContain("sk-test");
  });

  it("blocks an OAuth primary route when profile credentials are missing", async () => {
    const registry = new ProviderRegistry();
    registry.register(adapter("codex", [codexProfile]));

    const diagnostic = await diagnoseProviderChain(loadedConfig({
      registry,
      providers: {
        codex: {
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authMethod: "oauth_device_pkce",
          enableNetwork: true
        }
      },
      primaryRoute: route({
        provider: "codex",
        id: "gpt-5.5",
        profile: codexProfile,
        authMethod: "oauth_device_pkce",
        apiKeyEnv: undefined
      })
    }), {
      oauthStatus: {
        status: "ready",
        providerStatuses: [],
        warnings: [],
        notes: ["OAuth auth store has no provider records."]
      }
    });

    expect(diagnostic.status).toBe("warning");
    expect(diagnostic.unavailableCount).toBe(1);
    expect(diagnostic.routes).toEqual([
      expect.objectContaining({
        kind: "primary",
        label: "primary",
        status: "blocked",
        summary: "missing OAuth credentials for codex"
      })
    ]);
    expect(diagnostic.warnings).toEqual([
      "Provider route primary is unavailable: missing OAuth credentials for codex"
    ]);
  });
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
