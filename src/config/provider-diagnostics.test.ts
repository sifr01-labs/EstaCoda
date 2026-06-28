import { afterEach, describe, expect, it } from "vitest";
import type { LoadedRuntimeConfig } from "./runtime-config.js";
import type { ModelProfile, ProviderAdapter, ProviderId, ResolvedModelRoute } from "../contracts/provider.js";
import { ProviderRegistry } from "../providers/provider-registry.js";
import { createOpenAICompatibleProvider, type FetchLike } from "../providers/openai-compatible-provider.js";
import { diagnoseProviderConfig, diagnoseProviderLive, formatProviderTruthStatus } from "./provider-diagnostics.js";
import { normalizeMemoryConfig } from "./memory-config.js";
import { normalizeDelegationConfig } from "./runtime-config.js";

const modelProfile: ModelProfile = {
  id: "gpt-5",
  provider: "openai",
  contextWindowTokens: 128_000,
  supportsTools: true,
  supportsVision: true,
  supportsStructuredOutput: true
};

function adapter(id: ProviderId, models: ModelProfile[] = [modelProfile]): ProviderAdapter {
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
    profile: modelProfile,
    apiKeyEnv: "TEST_OPENAI_KEY",
    ...overrides
  };
}

function loadedConfig(input: {
  registry: ProviderRegistry;
  model?: ModelProfile;
  primaryRoute?: ResolvedModelRoute;
  providerConfig?: LoadedRuntimeConfig["config"]["providers"];
}): LoadedRuntimeConfig {
  const selectedModel = input.model ?? modelProfile;
  return {
    config: {
      model: { provider: selectedModel.provider, id: selectedModel.id },
      providers: input.providerConfig ?? {
        openai: {
          enableNetwork: true,
          apiKeyEnv: "TEST_OPENAI_KEY"
        }
      }
    },
    sources: [],
    model: selectedModel,
    primaryModelRoute: input.primaryRoute ?? route(),
    modelFallbackRoutes: [],
    providerRegistry: input.registry,
    auxiliaryModels: {},
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

describe("provider diagnostics", () => {
  const originalEnv = process.env.TEST_OPENAI_KEY;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.TEST_OPENAI_KEY;
    } else {
      process.env.TEST_OPENAI_KEY = originalEnv;
    }
  });

  it("shows provider default when route maxTokens is unset", async () => {
    process.env.TEST_OPENAI_KEY = "sk-test";
    const registry = new ProviderRegistry();
    registry.register(adapter("openai"));

    const diagnostic = await diagnoseProviderConfig(loadedConfig({ registry }));

    expect(diagnostic.lines).toContain("Max output tokens: provider default");
  });

  it("shows configured maxTokens and warns below 2048", async () => {
    process.env.TEST_OPENAI_KEY = "sk-test";
    const registry = new ProviderRegistry();
    registry.register(adapter("openai"));

    const diagnostic = await diagnoseProviderConfig(loadedConfig({
      registry,
      primaryRoute: route({ maxTokens: 1024 })
    }));

    expect(diagnostic.lines).toContain("Max output tokens: 1,024");
    expect(diagnostic.warnings).toContain(
      "Max output tokens is below 2,048. Long answers and tool calls are more likely to truncate."
    );
  });

  it("does not require apiKeyEnv for Codex OAuth routes", async () => {
    const codexProfile: ModelProfile = {
      ...modelProfile,
      id: "gpt-5.5",
      provider: "codex"
    };
    const registry = new ProviderRegistry();
    registry.register(adapter("codex", [codexProfile]));

    const diagnostic = await diagnoseProviderConfig(loadedConfig({
      registry,
      model: codexProfile,
      primaryRoute: route({
        provider: "codex",
        id: "gpt-5.5",
        profile: codexProfile,
        apiKeyEnv: undefined,
        authMethod: "oauth_device_pkce"
      }),
      providerConfig: {
        codex: {
          enableNetwork: true,
          authMethod: "oauth_device_pkce"
        }
      }
    }));

    expect(diagnostic.status).toBe("ready");
    expect(diagnostic.warnings).not.toContain("No apiKeyEnv is configured for codex.");
  });

  it("blocks unsupported authMethod overrides instead of suppressing credential warnings", async () => {
    const registry = new ProviderRegistry();
    registry.register(adapter("openai"));

    const diagnostic = await diagnoseProviderConfig(loadedConfig({
      registry,
      primaryRoute: route({
        apiKeyEnv: undefined,
        authMethod: "none"
      }),
      providerConfig: {
        openai: {
          enableNetwork: true,
          authMethod: "none"
        }
      }
    }));

    expect(diagnostic.status).toBe("blocked");
    expect(diagnostic.warnings).toContain("Provider openai has unsupported authMethod none.");
  });

  it("uses provider-aware token naming for live diagnostic request maxTokens", async () => {
    process.env.TEST_OPENAI_KEY = "sk-test";
    let capturedBody: Record<string, unknown> | undefined;
    const fetch: FetchLike = async (_url, init) => {
      capturedBody = JSON.parse(init.body) as Record<string, unknown>;
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({
          choices: [
            {
              finish_reason: "stop",
              message: { content: "OK" }
            }
          ]
        }),
        text: async () => "",
        body: null
      };
    };
    const registry = new ProviderRegistry();
    registry.register(createOpenAICompatibleProvider({
      id: "openai",
      endpoint: {
        baseUrl: "https://api.openai.com/v1",
        apiKey: { kind: "env", name: "TEST_OPENAI_KEY" }
      },
      enableNetwork: true,
      fetch
    }));

    const diagnostic = await diagnoseProviderLive(loadedConfig({
      registry,
      primaryRoute: route({
        baseUrl: "https://api.openai.com/v1"
      })
    }));

    expect(diagnostic.status).toBe("ready");
    expect(capturedBody?.max_completion_tokens).toBe(8);
    expect(capturedBody).not.toHaveProperty("max_tokens");
  });

  it("formats config health separately from last execution truth", async () => {
    process.env.TEST_OPENAI_KEY = "sk-test";
    const registry = new ProviderRegistry();
    registry.register(adapter("openai"));
    const diagnostic = await diagnoseProviderConfig(loadedConfig({ registry }));

    const content = formatProviderTruthStatus({
      config: diagnostic,
      lastExecution: {
        configuredPrimary: { provider: "kimi", model: "kimi-k2.7-code" },
        actual: { provider: "deepseek", model: "deepseek-v4-pro" },
        fallbackUsed: true,
        primaryFailureClass: "rate-limit",
        attempts: [
          {
            provider: "kimi",
            model: "kimi-k2.7-code",
            ok: false,
            errorClass: "rate-limit",
            routeRole: "primary",
            attemptedRouteIndex: 0
          },
          {
            provider: "deepseek",
            model: "deepseek-v4-pro",
            ok: true,
            routeRole: "fallback",
            attemptedRouteIndex: 1
          }
        ],
        status: "fallback-success"
      }
    });

    expect(content).toContain("Configured provider route:");
    expect(content).toContain("Health check: env/config only, not a live inference check.");
    expect(content).toContain("Configured provider status: ready");
    expect(content).toContain("Last execution:");
    expect(content).toContain("provider: deepseek/deepseek-v4-pro");
    expect(content).toContain("provider fallback used: kimi/kimi-k2.7-code failed with rate-limit");
    expect(content).not.toContain("Live provider check:");
  });

  it("formats missing last execution gracefully", async () => {
    process.env.TEST_OPENAI_KEY = "sk-test";
    const registry = new ProviderRegistry();
    registry.register(adapter("openai"));
    const diagnostic = await diagnoseProviderConfig(loadedConfig({ registry }));

    const content = formatProviderTruthStatus({ config: diagnostic });

    expect(content).toContain("Last execution:\nnone recorded for this session");
  });
});
