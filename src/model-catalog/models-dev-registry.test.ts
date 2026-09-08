import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  modelInfoToProfile,
  normalizeProviderIdForEstaCoda,
  resolveModelsDevSnapshot,
  resetModelsDevRegistryForTest,
  type ModelInfo
} from "./models-dev-registry.js";

function withFixture(
  data: Record<string, unknown>,
  testFn: (fixturePath: string, cachePath: string) => Promise<void>
): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "estacoda-models-dev-registry-test-"));
    const fixturePath = join(dir, "models_dev_snapshot.json");
    const cachePath = join(dir, "models_dev_cache.json");
    writeFileSync(fixturePath, JSON.stringify(data, null, 2), "utf8");

    try {
      await testFn(fixturePath, cachePath);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

describe("models-dev provider canonicalization", () => {
  beforeEach(() => {
    resetModelsDevRegistryForTest();
  });

  it("canonicalizes Zhipu and Z.ai provider IDs", () => {
    expect(normalizeProviderIdForEstaCoda("zai")).toBe("zai");
    expect(normalizeProviderIdForEstaCoda("zhipuai")).toBe("zai");
    expect(normalizeProviderIdForEstaCoda("zhipu")).toBe("zai");
  });

  it("canonicalizes Zhipu provider and model rows without stray providers", withFixture({
    providers: [
      { id: "zhipuai", name: "Zhipu AI" },
      { id: "zhipu", name: "Zhipu" },
      { id: "zai", name: "Z.AI" }
    ],
    models: [
      {
        id: "glm-5.1",
        provider_id: "zhipuai",
        context_window: 128000,
        input_modalities: ["text"],
        output_modalities: ["text"],
        tool_call: true,
        structured_output: true
      },
      {
        id: "glm-5",
        provider_id: "zhipu",
        context_window: 128000,
        input_modalities: ["text"],
        output_modalities: ["text"],
        tool_call: true,
        structured_output: true
      }
    ],
    fetchedAt: "2026-01-01T00:00:00.000Z"
  }, async (fixturePath, cachePath) => {
    const snapshot = await resolveModelsDevSnapshot({
      bundledSnapshotPath: fixturePath,
      cachePath,
      allowNetwork: false
    });

    expect(snapshot.providers.map((provider) => provider.id)).toEqual(["zai"]);
    expect(snapshot.providers.some((provider) => provider.id === "zhipuai")).toBe(false);
    expect(snapshot.providers.some((provider) => provider.id === "zhipu")).toBe(false);
    expect(snapshot.models.map((model) => `${model.providerId}:${model.id}`)).toEqual([
      "zai:glm-5",
      "zai:glm-5.1"
    ]);
  }));

  it("canonicalizes provider-keyed Zhipu rows", withFixture({
    zhipuai: {
      id: "zhipuai",
      name: "Zhipu AI",
      models: {
        "glm-4.7-flash": {
          id: "glm-4.7-flash",
          context_window: 128000,
          input_modalities: ["text"],
          output_modalities: ["text"],
          tool_call: true,
          structured_output: true
        }
      }
    },
    fetchedAt: "2026-01-01T00:00:00.000Z"
  }, async (fixturePath, cachePath) => {
    const snapshot = await resolveModelsDevSnapshot({
      bundledSnapshotPath: fixturePath,
      cachePath,
      allowNetwork: false
    });

    expect(snapshot.providers.map((provider) => provider.id)).toEqual(["zai"]);
    expect(snapshot.models.map((model) => `${model.providerId}:${model.id}`)).toEqual([
      "zai:glm-4.7-flash"
    ]);
  }));
});

describe("modelInfoToProfile output limits", () => {
  it("preserves a valid registry max output without changing other provider metadata", () => {
    const model = modelInfoFixture({
      providerId: "openai",
      maxOutput: 16_384,
      costInput: 2.5,
      costOutput: 10
    });
    const original = structuredClone(model);

    const profile = modelInfoToProfile(model);

    expect(profile).toMatchObject({
      id: "fixture-model",
      provider: "openai",
      contextWindowTokens: 128_000,
      maxOutputTokens: 16_384,
      supportsTools: true,
      supportsVision: false,
      supportsStructuredOutput: true,
      cost: {
        inputPerMillionTokens: 2.5,
        outputPerMillionTokens: 10
      }
    });
    expect(model).toEqual(original);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "omits invalid registry max output %s",
    (maxOutput) => {
      const profile = modelInfoToProfile(modelInfoFixture({ maxOutput }));

      expect(profile).not.toHaveProperty("maxOutputTokens");
    }
  );
});

function modelInfoFixture(overrides: Partial<ModelInfo> = {}): ModelInfo {
  return {
    id: "fixture-model",
    name: "Fixture Model",
    family: "fixture",
    providerId: "fixture-provider",
    reasoning: false,
    toolCall: true,
    attachment: false,
    temperature: true,
    structuredOutput: true,
    openWeights: false,
    inputModalities: ["text"],
    outputModalities: ["text"],
    contextWindow: 128_000,
    maxOutput: 4_096,
    status: "",
    interleaved: false,
    ...overrides
  };
}
