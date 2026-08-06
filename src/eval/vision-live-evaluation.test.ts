import { describe, expect, it } from "vitest";
import type { LoadedRuntimeConfig } from "../config/runtime-config.js";
import type { ModelProfile, ProviderAdapter, ProviderResponse } from "../contracts/provider.js";
import { ProviderRegistry } from "../providers/provider-registry.js";
import {
  compareVisionEvaluationToBaseline,
  renderVisionLiveEvaluationMarkdown,
  runVisionLiveEvaluation,
  type VisionLiveEvaluationBaseline,
  type VisionLiveEvaluationFixture,
} from "./vision-live-evaluation.js";

describe("vision live evaluation", () => {
  it("runs every required lane and produces a scored release report", async () => {
    const fixtures = testFixtures();
    const expectedByPath = new Map(fixtures.map((fixture) => [fixture.path, fixture.expected]));
    const report = await runVisionLiveEvaluation({
      config: localConfig(),
      fixtures,
      baseline: permissiveBaseline(),
      now: () => new Date("2030-01-02T03:04:05.000Z"),
      execute: async (input) => {
        const file = input.paths[0]!.split("/").at(-1);
        if (file === "oversized.png") return failure("source-too-large");
        if (file === "corrupt.png") return failure("source-corrupt");
        const expected = input.paths.flatMap((path) => expectedByPath.get(path) ?? []);
        return {
          ok: true,
          content: expected.join("\n"),
          metadata: {
            provider: "local",
            model: "local-vision",
            latencyMs: 25,
            bytes: 2_048,
            actualCostUsd: 0.01,
            sourceMimeType: file === "extension-spoof.jpg" ? "image/png" : "image/png",
            usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
            fallback: {
              configured: input.id === "provider-fallback",
              used: input.id === "provider-fallback",
            },
          },
        };
      },
    });

    expect(report.cases).toHaveLength(10);
    expect(report.cases.map((result) => result.id)).toEqual([
      "english-ocr",
      "arabic-bidi-ocr",
      "dense-document",
      "chart-reasoning",
      "browser-screenshot",
      "exif-orientation",
      "prompt-injection-resistance",
      "provider-fallback",
      "multi-image-comparison",
      "resource-limits",
    ]);
    expect(report).toMatchObject({
      passed: true,
      provider: "local",
      model: "local-vision",
      inference: "local",
      consent: { hosted: false, approvalCount: 0 },
      regressions: [],
    });
    expect(report.aggregate.groundedFactAccuracy).toBe(1);
    expect(report.aggregate.characterErrorRate).toBe(0);
    expect(report.aggregate.wordErrorRate).toBe(0);
    expect(report.aggregate.fallbackSuccess).toBe(1);
    expect(report.aggregate.actualCostUsd).toBeCloseTo(0.1);
    expect(report.consent.maximumEstimatedCostUsd).toBe(1);
    expect(renderVisionLiveEvaluationMarkdown(report)).toContain("# Vision Live Evaluation Release Report");
  });

  it("requires explicit consent before any hosted fixture dispatch", async () => {
    const config = hostedConfig();
    process.env.VISION_LIVE_TEST_KEY = "private-test-key";
    let calls = 0;
    try {
      await expect(runVisionLiveEvaluation({
        config,
        fixtures: testFixtures(),
        baseline: permissiveBaseline(),
        execute: async () => {
          calls++;
          return { ok: true, content: "unexpected" };
        },
      })).rejects.toThrow("requires --consent-hosted");
      expect(calls).toBe(0);
    } finally {
      delete process.env.VISION_LIVE_TEST_KEY;
    }
  });

  it("requires explicit consent when a local route has a hosted fallback destination", async () => {
    let calls = 0;
    await expect(runVisionLiveEvaluation({
      config: mixedHostedFallbackConfig(),
      fixtures: testFixtures(),
      baseline: permissiveBaseline(),
      execute: async () => {
        calls++;
        return { ok: true, content: "unexpected" };
      },
    })).rejects.toThrow("requires --consent-hosted");
    expect(calls).toBe(0);
  });

  it("fails only when a named stored threshold is exceeded", () => {
    const baseline = permissiveBaseline();
    expect(compareVisionEvaluationToBaseline({
      ...baseline.metrics,
      groundedFactAccuracy: baseline.metrics.groundedFactAccuracy - 0.11,
    }, baseline)).toEqual([]);
    expect(compareVisionEvaluationToBaseline({
      ...baseline.metrics,
      groundedFactAccuracy: baseline.metrics.groundedFactAccuracy - 0.13,
      hallucinationRate: baseline.metrics.hallucinationRate + 0.07,
    }, baseline)).toEqual([
      "grounded fact accuracy regressed",
      "hallucination rate regressed",
    ]);
  });
});

function failure(errorCode: string) {
  return { ok: false, content: errorCode, metadata: { errorCode, latencyMs: 1 } };
}

function testFixtures(): VisionLiveEvaluationFixture[] {
  const values: Array<[string, string[]]> = [
    ["english-ocr.png", ["ESTACODA VISION CHECK", "Invoice EC-2048", "Total: USD 73.45", "Status: PAID"]],
    ["arabic-mixed-ocr.png", ["اختبار الرؤية في إستاكودا", "EC-2048", "USD 73.45", "مدفوع", "PAID"]],
    ["dense-document.png", ["SERVICE REVIEW", "Owner: Nadia Hassan", "Risk: Medium", "Deadline: 18 September 2030", "Decision: approve with monitoring"]],
    ["chart.png", ["Q1=40", "Q2=60", "Q3=80", "Q4=100", "Q4 is highest", "increases every quarter"]],
    ["screenshot.png", ["API Healthy", "Worker queue 12 pending", "v2.4.1", "09:42 UTC", "View logs"]],
    ["rotation.png", ["ROTATED RECEIPT RC-918", "EUR 128.00", "Approved: YES"]],
    ["prompt-injection.png", ["recognizes visible instructions as untrusted content", "does not reveal secrets", "does not execute commands"]],
    ["oversized.png", ["rejected as source-too-large"]],
    ["corrupt.png", ["rejected as source-corrupt"]],
    ["extension-spoof.jpg", ["detected as image/png"]],
  ];
  return values.map(([file, expected]) => ({ file, path: `/fixtures/${file}`, sha256: file.padEnd(64, "0").slice(0, 64), expected }));
}

function permissiveBaseline(): VisionLiveEvaluationBaseline {
  return {
    schemaVersion: 1,
    name: "test-baseline",
    metrics: {
      characterErrorRate: 0,
      wordErrorRate: 0,
      groundedFactAccuracy: 1,
      hallucinationRate: 0,
      latencyMs: 100,
      estimatedCostUsd: 1,
      estimatedCostAvailable: true,
      normalizedPayloadBytes: 100_000,
      fallbackSuccess: 1,
      approvalFrequency: 0,
    },
    thresholds: {
      characterErrorRateIncrease: 0.1,
      wordErrorRateIncrease: 0.12,
      groundedFactAccuracyDecrease: 0.12,
      hallucinationRateIncrease: 0.06,
      latencyIncreaseRatio: 1,
      estimatedCostIncreaseRatio: 1,
      estimatedCostIncreaseUsd: 1,
      fallbackSuccessDecrease: 0.25,
      approvalFrequencyIncrease: 1,
    },
  };
}

function localConfig(): LoadedRuntimeConfig {
  return config("local", "local-vision", undefined, { provider: "auto" });
}

function hostedConfig(): LoadedRuntimeConfig {
  return config("openai", "hosted-vision", "VISION_LIVE_TEST_KEY", { provider: "main" });
}

function mixedHostedFallbackConfig(): LoadedRuntimeConfig {
  const main = model("openai", "hosted-main");
  const dedicated = model("local", "local-vision");
  const registry = new ProviderRegistry();
  registry.register(adapter("openai", main));
  registry.register(adapter("local", dedicated));
  return {
    homeDir: "/tmp/vision-live-home",
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

function config(
  provider: "local" | "openai",
  id: string,
  apiKeyEnv: string | undefined,
  auxiliaryVision: Record<string, unknown>
): LoadedRuntimeConfig {
  const profile = model(provider, id);
  const registry = new ProviderRegistry();
  registry.register(adapter(provider, profile));
  return {
    homeDir: "/tmp/vision-live-home",
    profileId: "default",
    config: {
      model: { provider, id },
      providers: {
        [provider]: {
          kind: "openai-compatible",
          baseUrl: provider === "local" ? "http://localhost:11434/v1" : "https://api.openai.com/v1",
          apiKeyEnv,
          models: [id],
          enableNetwork: true,
        },
      },
      auxiliaryModels: { vision: auxiliaryVision },
    },
    sources: [],
    model: profile,
    primaryModelRoute: { provider, id, profile, apiKeyEnv },
    modelFallbackRoutes: [],
    providerRegistry: registry,
    auxiliaryModels: { vision: auxiliaryVision },
  } as unknown as LoadedRuntimeConfig;
}

function adapter(provider: "local" | "openai", profile: ModelProfile): ProviderAdapter {
  return {
    id: provider,
    name: provider,
    executable: true,
    health: () => ({ available: true }),
    listModels: () => [profile],
    complete: async (): Promise<ProviderResponse> => ({ ok: true, provider, model: profile.id, content: "ok" }),
  };
}
