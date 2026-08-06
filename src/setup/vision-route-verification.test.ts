import { describe, expect, it, vi } from "vitest";
import type { LoadedRuntimeConfig } from "../config/runtime-config.js";
import type { ModelProfile, ProviderAdapter, ProviderResponse } from "../contracts/provider.js";
import { ProviderRegistry } from "../providers/provider-registry.js";
import {
  buildVisionRouteVerificationPlan,
  renderVisionRouteVerification,
  runVisionRouteVerification,
} from "./vision-route-verification.js";

describe("Vision Analysis route verification", () => {
  it("reports automatic main routing as native and verifies a local route without hosted consent", async () => {
    const config = testConfig({ provider: "local", auxiliaryVision: { provider: "auto" } });
    const execute = vi.fn(async () => ({
      ok: true,
      content: "VISION READY / الرؤية جاهزة",
      metadata: {
        latencyMs: 37,
        width: 720,
        height: 320,
        bytes: 4_096,
        usage: { inputTokens: 100, outputTokens: 8, totalTokens: 108 },
        fallback: { configured: false, used: false },
        attempts: ["local/local-vision:ok"],
      },
    }));

    const plan = await buildVisionRouteVerificationPlan(config);
    const report = await runVisionRouteVerification({ config, execute });

    expect(plan).toMatchObject({ routeSource: "auto-main", dispatch: "native", inference: "local" });
    expect(report).toMatchObject({
      status: "passed",
      provider: "local",
      model: "local-vision",
      credentialReady: true,
      expectedEnglishDetected: true,
      expectedArabicDetected: true,
      latencyMs: 37,
      normalizedImage: { width: 720, height: 320, bytes: 4_096 },
    });
    expect(execute).toHaveBeenCalledOnce();
  });

  it("executes an automatic main route directly instead of mistaking a native continuation for verification", async () => {
    const requests: unknown[] = [];
    const config = testConfig({
      provider: "local",
      auxiliaryVision: { provider: "auto" },
      complete: async (request) => {
        requests.push(request);
        return {
          ok: true,
          provider: "local",
          model: "local-vision",
          content: "VISION READY / الرؤية جاهزة",
          usage: { inputTokens: 100, outputTokens: 8, totalTokens: 108 },
        };
      },
    });

    const report = await runVisionRouteVerification({ config });

    expect(report.status).toBe("passed");
    expect(requests).toHaveLength(1);
    expect(JSON.stringify(requests[0])).not.toContain("VISION READY");
    expect(JSON.stringify(requests[0])).not.toContain("الرؤية جاهزة");
  });

  it("does not call a hosted dedicated route without explicit consent", async () => {
    const config = testConfig({
      provider: "openai",
      apiKeyEnv: "VISION_VERIFY_TEST_KEY",
      auxiliaryVision: { provider: "openai", id: "hosted-vision" },
    });
    process.env.VISION_VERIFY_TEST_KEY = "secret-not-for-output";
    const execute = vi.fn();
    try {
      const report = await runVisionRouteVerification({ config, execute });
      expect(report).toMatchObject({
        status: "consent-required",
        routeSource: "explicit",
        dispatch: "auxiliary",
        inference: "hosted",
        hostedConsent: "missing",
      });
      expect(execute).not.toHaveBeenCalled();
      expect(JSON.stringify(report)).not.toContain("secret-not-for-output");
      expect(renderVisionRouteVerification(report)).toContain("Re-run with explicit hosted-processing consent");
    } finally {
      delete process.env.VISION_VERIFY_TEST_KEY;
    }
  });

  it("requires hosted consent when a local dedicated route can fall back to the hosted main route", async () => {
    const execute = vi.fn();
    const report = await runVisionRouteVerification({ config: mixedFallbackConfig(), execute });

    expect(report).toMatchObject({
      status: "consent-required",
      inference: "local",
      hostedConsent: "missing",
    });
    expect(report.hostedDestinations).toHaveLength(1);
    expect(execute).not.toHaveBeenCalled();
  });

  it("fails before dispatch when the selected route lacks credential readiness", async () => {
    const config = testConfig({
      provider: "openai",
      apiKeyEnv: "MISSING_VISION_VERIFY_KEY",
      auxiliaryVision: { provider: "main" },
    });
    const execute = vi.fn();
    const report = await runVisionRouteVerification({ config, consentHosted: true, execute });

    expect(report.status).toBe("credential-blocked");
    expect(report.credentialDiagnostic).toContain("MISSING_VISION_VERIFY_KEY");
    expect(execute).not.toHaveBeenCalled();
  });

  it("does not pass a responsive route that misses either expected language", async () => {
    const config = testConfig({ provider: "local", auxiliaryVision: { provider: "main" } });
    const report = await runVisionRouteVerification({
      config,
      execute: async () => ({ ok: true, content: "VISION READY", metadata: { latencyMs: 5 } }),
    });

    expect(report).toMatchObject({
      status: "failed",
      expectedEnglishDetected: true,
      expectedArabicDetected: false,
    });
    expect(report.error).toContain("not both detected");
  });

  it("uses the same truthful plan for main, dedicated local, and custom OpenAI-compatible route modes", async () => {
    process.env.VISION_VERIFY_MATRIX_KEY = "matrix-key";
    try {
      const main = await buildVisionRouteVerificationPlan(testConfig({
        provider: "openai",
        apiKeyEnv: "VISION_VERIFY_MATRIX_KEY",
        auxiliaryVision: { provider: "main" },
      }));
      const dedicatedLocal = await buildVisionRouteVerificationPlan(testConfig({
        provider: "local",
        auxiliaryVision: { provider: "local", id: "local-vision" },
      }));
      const custom = await buildVisionRouteVerificationPlan(testConfig({
        provider: "local",
        auxiliaryVision: {
          provider: "local",
          id: "local-vision",
          baseUrl: "http://127.0.0.1:11434/v1",
        },
      }));

      expect(main).toMatchObject({ routeSource: "main", dispatch: "native", inference: "hosted" });
      expect(dedicatedLocal).toMatchObject({ routeSource: "explicit", dispatch: "auxiliary", inference: "local" });
      expect(custom).toMatchObject({ routeSource: "custom", dispatch: "auxiliary", inference: "local" });
    } finally {
      delete process.env.VISION_VERIFY_MATRIX_KEY;
    }
  });
});

function testConfig(input: {
  provider: "local" | "openai";
  apiKeyEnv?: string;
  auxiliaryVision: Record<string, unknown>;
  complete?: ProviderAdapter["complete"];
}): LoadedRuntimeConfig {
  const profile = model(input.provider, input.provider === "local" ? "local-vision" : "hosted-vision");
  const route = { provider: input.provider, id: profile.id, profile, apiKeyEnv: input.apiKeyEnv };
  const registry = new ProviderRegistry();
  registry.register(adapter(input.provider, profile, input.complete));
  return {
    homeDir: "/tmp/vision-verify-home",
    profileId: "default",
    config: {
      model: { provider: input.provider, id: profile.id },
      providers: {
        [input.provider]: {
          kind: "openai-compatible",
          baseUrl: input.provider === "local" ? "http://localhost:11434/v1" : "https://api.openai.com/v1",
          apiKeyEnv: input.apiKeyEnv,
          models: [profile.id],
          enableNetwork: true,
        },
      },
      auxiliaryModels: { vision: input.auxiliaryVision },
    },
    sources: [],
    model: profile,
    primaryModelRoute: route,
    modelFallbackRoutes: [],
    providerRegistry: registry,
    auxiliaryModels: { vision: input.auxiliaryVision },
  } as unknown as LoadedRuntimeConfig;
}

function mixedFallbackConfig(): LoadedRuntimeConfig {
  const main = model("openai", "hosted-main");
  const dedicated = model("local", "local-vision");
  const registry = new ProviderRegistry();
  registry.register(adapter("openai", main));
  registry.register(adapter("local", dedicated));
  return {
    homeDir: "/tmp/vision-verify-home",
    profileId: "default",
    config: {
      model: { provider: "openai", id: main.id },
      providers: {
        openai: {
          kind: "openai-compatible",
          baseUrl: "https://api.openai.com/v1",
          models: [main.id],
          enableNetwork: true,
        },
        local: {
          kind: "openai-compatible",
          baseUrl: "http://localhost:11434/v1",
          models: [dedicated.id],
          enableNetwork: true,
        },
      },
      auxiliaryModels: { vision: { provider: "local", id: dedicated.id, fallbackToMain: true } },
    },
    sources: [],
    model: main,
    primaryModelRoute: { provider: "openai", id: main.id, profile: main },
    modelFallbackRoutes: [],
    providerRegistry: registry,
    auxiliaryModels: { vision: { provider: "local", id: dedicated.id, fallbackToMain: true } },
  } as unknown as LoadedRuntimeConfig;
}

function model(provider: "local" | "openai", id: string): ModelProfile {
  return {
    provider,
    id,
    contextWindowTokens: 128_000,
    supportsTools: true,
    supportsVision: true,
    supportsStructuredOutput: true,
  };
}

function adapter(
  provider: "local" | "openai",
  profile: ModelProfile,
  complete?: ProviderAdapter["complete"]
): ProviderAdapter {
  return {
    id: provider,
    name: provider,
    executable: true,
    health: () => ({ available: true }),
    listModels: () => [profile],
    complete: complete ?? (async (): Promise<ProviderResponse> => ({
        ok: true,
        provider,
        model: profile.id,
        content: "VISION READY / الرؤية جاهزة",
      })),
  };
}
