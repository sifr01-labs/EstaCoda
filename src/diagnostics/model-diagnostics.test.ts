import { describe, it, expect } from "vitest";
import { produceModelStatusReport } from "./model-diagnostics.js";
import type { LoadedRuntimeConfig } from "../config/runtime-config.js";
import { ProviderRegistry } from "../providers/provider-registry.js";
import type { ProviderId } from "../contracts/provider.js";
import type { ProviderEndpoint } from "../contracts/provider.js";

function makeMinimalConfig(overrides?: Partial<LoadedRuntimeConfig>): LoadedRuntimeConfig {
  const registry = new ProviderRegistry();
  return {
    config: {},
    sources: [],
    model: {
      id: "gpt-4o",
      provider: "openai" as ProviderId,
      contextWindowTokens: 128_000,
      supportsTools: true,
      supportsVision: true,
      supportsStructuredOutput: true
    },
    primaryModelRoute: {
      provider: "openai" as ProviderId,
      id: "gpt-4o",
      profile: {
        id: "gpt-4o",
        provider: "openai" as ProviderId,
        contextWindowTokens: 128_000,
        supportsTools: true,
        supportsVision: true,
        supportsStructuredOutput: true
      }
    },
    modelFallbackRoutes: [],
    providerRegistry: registry,
    auxiliaryModels: {},
    web: { enableNetwork: false },
    browser: { backend: "unconfigured", autoLaunch: false },
    imageGen: { provider: "unconfigured", model: "unconfigured", useGateway: false },
    tts: { provider: "edge", speed: 1 },
    stt: { provider: "local" },
    mcp: { servers: {} },
    skills: { externalDirs: [], autonomy: "suggest", config: {} },
    ui: { language: "en", flavor: "default", activityLabels: "en" },
    profile: { mode: "default", responseLanguage: "en" },
    security: { approvalMode: "manual", assessor: { enabled: false, timeoutMs: 30_000 } },
    channels: {
      telegram: { ready: false },
      discord: { ready: false },
      email: { ready: false },
      whatsapp: { ready: false }
    },
    ...overrides
  } as LoadedRuntimeConfig;
}

describe("produceModelStatusReport", () => {
  it("produces a structured report for primary route", async () => {
    const config = makeMinimalConfig();
    const report = await produceModelStatusReport(config);
    expect(report.primary.route.provider).toBe("openai");
    expect(report.primary.executable).toBe(false); // no adapter registered
    expect(report.primary.catalogOnly).toBe(true);
    expect(Array.isArray(report.primary.errors)).toBe(true);
    expect(Array.isArray(report.primary.warnings)).toBe(true);
  });

  it("marks route as executable when adapter is registered", async () => {
    const registry = new ProviderRegistry();
    registry.register({
      id: "openai" as ProviderId,
      name: "OpenAI",
      executable: true,
      health(_endpointOverride?: ProviderEndpoint) {
        return { available: true };
      },
      listModels() {
        return [];
      },
      async complete() {
        return { ok: true, content: "", model: "", provider: "openai" };
      }
    });
    const config = makeMinimalConfig({ providerRegistry: registry });
    const report = await produceModelStatusReport(config);
    expect(report.primary.executable).toBe(true);
    expect(report.primary.catalogOnly).toBe(false);
  });

  it("includes fallback routes", async () => {
    const config = makeMinimalConfig({
      modelFallbackRoutes: [
        {
          provider: "deepseek" as ProviderId,
          id: "deepseek-chat",
          profile: {
            id: "deepseek-chat",
            provider: "deepseek" as ProviderId,
            contextWindowTokens: 64_000,
            supportsTools: true,
            supportsVision: false,
            supportsStructuredOutput: true
          }
        }
      ]
    });
    const report = await produceModelStatusReport(config);
    expect(report.fallbacks.length).toBe(1);
    expect(report.fallbacks[0]!.route.provider).toBe("deepseek");
  });

  it("includes auxiliary routes", async () => {
    const config = makeMinimalConfig({
      auxiliaryModels: {
        vision: { provider: "auto" }
      }
    });
    const report = await produceModelStatusReport(config);
    expect(Object.keys(report.auxiliary).length).toBeGreaterThan(0);
  });
});
