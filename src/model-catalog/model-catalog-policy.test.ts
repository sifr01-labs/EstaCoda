import { describe, expect, it } from "vitest";
import type { ModelProfile, ProviderId } from "../contracts/provider.js";
import {
  buildModelLifecycleWarnings,
  classifyModelForCatalog,
  loadBundledModelCatalogOverrides,
  lookupModelCatalogOverride,
  parseModelCatalogOverrides,
  type ModelCatalogOverrideRegistry
} from "./model-catalog-policy.js";
import type { ModelInfo, ModelModality } from "./models-dev-registry.js";

function registry(
  models: Array<{
    provider?: string;
    model?: string;
    lifecycle?: string;
    usageClass?: string;
    note?: string;
    extra?: Record<string, unknown>;
  }> = [{
    provider: "openai",
    model: "gpt-legacy",
    lifecycle: "deprecated",
    usageClass: "primary-chat",
    note: "Use a current GPT model."
  }]
): Record<string, unknown> {
  return {
    version: 1,
    models: models.map((entry) => ({
      provider: entry.provider ?? "openai",
      model: entry.model ?? "gpt-legacy",
      lifecycle: entry.lifecycle ?? "deprecated",
      usageClass: entry.usageClass ?? "primary-chat",
      ...(entry.note === undefined ? {} : { note: entry.note }),
      ...(entry.extra ?? {})
    }))
  };
}

function profile(input: Partial<ModelProfile> & { id?: string } = {}): ModelProfile {
  return {
    id: input.id ?? "gpt-4.1",
    provider: input.provider ?? "openai",
    contextWindowTokens: input.contextWindowTokens ?? 128000,
    status: input.status ?? "stable",
    supportsTools: input.supportsTools ?? true,
    supportsVision: input.supportsVision ?? false,
    supportsStructuredOutput: input.supportsStructuredOutput ?? true,
    supportsReasoning: input.supportsReasoning ?? false,
    supportsStreaming: input.supportsStreaming ?? true,
    freeOrOpenWeights: input.freeOrOpenWeights ?? false,
    cost: input.cost,
    rateLimits: input.rateLimits
  };
}

function modelInfo(input: {
  id: string;
  providerId?: string;
  name?: string;
  family?: string;
  inputModalities?: ModelModality[];
  outputModalities?: ModelModality[];
  status?: ModelInfo["status"];
}): Pick<ModelInfo, "id" | "name" | "family" | "providerId" | "inputModalities" | "outputModalities" | "status"> {
  return {
    id: input.id,
    name: input.name ?? input.id,
    family: input.family ?? "",
    providerId: input.providerId ?? "openai",
    inputModalities: input.inputModalities ?? [],
    outputModalities: input.outputModalities ?? [],
    status: input.status ?? ""
  };
}

describe("parseModelCatalogOverrides", () => {
  it("parses a valid override file", () => {
    const parsed = parseModelCatalogOverrides(registry());

    expect(parsed).toEqual({
      version: 1,
      models: [{
        provider: "openai",
        model: "gpt-legacy",
        lifecycle: "deprecated",
        usageClass: "primary-chat",
        note: "Use a current GPT model."
      }]
    });
  });

  it("loads the bundled override file", async () => {
    const parsed = await loadBundledModelCatalogOverrides();

    expect(lookupModelCatalogOverride(parsed, "openai", "text-embedding-3-large")).toEqual({
      lifecycle: "available",
      usageClass: "embedding",
      note: "Embedding model; hidden from primary chat selection by default."
    });
    expect(lookupModelCatalogOverride(parsed, "openai", "gpt-image-2")).toEqual({
      lifecycle: "available",
      usageClass: "image",
      note: "Image model; hidden from primary chat selection by default."
    });
  });

  it("rejects an invalid version", () => {
    expect(() => parseModelCatalogOverrides({ ...registry(), version: 2 }))
      .toThrow("version must be 1");
  });

  it("rejects missing models", () => {
    expect(() => parseModelCatalogOverrides({ version: 1 }))
      .toThrow("models must be an array");
  });

  it("rejects unknown top-level keys", () => {
    expect(() => parseModelCatalogOverrides({ ...registry(), sourceUrl: "https://example.com" }))
      .toThrow("unknown key 'sourceUrl'");
  });

  it("rejects unknown model-entry keys", () => {
    expect(() => parseModelCatalogOverrides(registry([{ extra: { sourceUrl: "https://example.com" } }])))
      .toThrow("unknown key 'sourceUrl'");
  });

  it("rejects invalid provider IDs", () => {
    expect(() => parseModelCatalogOverrides(registry([{ provider: "bad provider" }])))
      .toThrow("provider is invalid");
  });

  it("rejects non-canonical provider IDs", () => {
    expect(() => parseModelCatalogOverrides(registry([{ provider: "zhipuai" }])))
      .toThrow("provider must be canonical");
  });

  it("rejects empty providers", () => {
    expect(() => parseModelCatalogOverrides(registry([{ provider: " " }])))
      .toThrow("provider must not be empty");
  });

  it("rejects empty models", () => {
    expect(() => parseModelCatalogOverrides(registry([{ model: " " }])))
      .toThrow("model must not be empty");
  });

  it("rejects invalid lifecycle values", () => {
    expect(() => parseModelCatalogOverrides(registry([{ lifecycle: "unverified" }])))
      .toThrow("lifecycle is invalid");
  });

  it("rejects invalid usage classes", () => {
    expect(() => parseModelCatalogOverrides(registry([{ usageClass: "video" }])))
      .toThrow("usageClass is invalid");
  });

  it("rejects secret-like notes", () => {
    expect(() => parseModelCatalogOverrides(registry([{ note: "OPENAI_API_KEY=sk_test_12345678" }])))
      .toThrow("note contains secret-like material");
  });

  it("preserves valid notes", () => {
    const parsed = parseModelCatalogOverrides(registry([{ note: "Embedding model." }]));

    expect(parsed.models[0]?.note).toBe("Embedding model.");
  });

  it("looks up exact provider/model overrides", () => {
    const parsed = parseModelCatalogOverrides(registry([{ model: "gpt-4o", usageClass: "primary-chat" }]));

    expect(lookupModelCatalogOverride(parsed, "openai", "gpt-4o")).toEqual({
      lifecycle: "deprecated",
      usageClass: "primary-chat"
    });
  });

  it("does not match prefix or glob-like partial IDs", () => {
    const parsed = parseModelCatalogOverrides(registry([{ model: "gpt-image-1", usageClass: "image" }]));

    expect(lookupModelCatalogOverride(parsed, "openai", "gpt-image-1-mini")).toBeUndefined();
    expect(lookupModelCatalogOverride(parsed, "openai", "gpt-image-*")).toBeUndefined();
  });
});

describe("classifyModelForCatalog", () => {
  it("lets exact overrides win", () => {
    const overrides = parseModelCatalogOverrides(registry([{
      model: "gpt-special",
      lifecycle: "retired",
      usageClass: "other",
      note: "Blocked by reviewed policy."
    }]));

    expect(classifyModelForCatalog({
      provider: "openai",
      model: "gpt-special",
      profile: profile({ id: "gpt-special", status: "stable" }),
      overrides
    })).toEqual({
      lifecycle: "retired",
      usageClass: "other",
      note: "Blocked by reviewed policy."
    });
  });

  it("defaults a text-capable model with no override to available primary chat", () => {
    expect(classifyModelForCatalog({
      provider: "openai",
      model: "gpt-4.1",
      profile: profile({ id: "gpt-4.1", supportsTools: true, supportsStructuredOutput: true })
    })).toEqual({
      lifecycle: "available",
      usageClass: "primary-chat"
    });
  });

  it("defaults an unclear model to available other", () => {
    expect(classifyModelForCatalog({
      provider: "custom-corp" as ProviderId,
      model: "opaque-model",
      profile: profile({
        id: "opaque-model",
        provider: "custom-corp" as ProviderId,
        status: "unknown",
        supportsTools: false,
        supportsStructuredOutput: false,
        supportsReasoning: false,
        supportsVision: false
      })
    })).toEqual({
      lifecycle: "available",
      usageClass: "other"
    });
  });

  it("maps deprecated profile status to deprecated lifecycle", () => {
    expect(classifyModelForCatalog({
      provider: "openai",
      model: "gpt-old",
      profile: profile({ id: "gpt-old", status: "deprecated" })
    })).toEqual({
      lifecycle: "deprecated",
      usageClass: "primary-chat"
    });
  });

  it("classifies embedding models", () => {
    expect(classifyModelForCatalog({
      provider: "openai",
      model: "text-embedding-3-large",
      modelInfo: modelInfo({ id: "text-embedding-3-large", outputModalities: ["text"] })
    })).toEqual({
      lifecycle: "available",
      usageClass: "embedding"
    });
  });

  it("classifies image models by name", () => {
    expect(classifyModelForCatalog({
      provider: "openai",
      model: "gpt-image-1",
      modelInfo: modelInfo({ id: "gpt-image-1" })
    })).toEqual({
      lifecycle: "available",
      usageClass: "image"
    });
  });

  it("classifies image-only output models", () => {
    expect(classifyModelForCatalog({
      provider: "fal" as ProviderId,
      model: "creative-renderer",
      modelInfo: modelInfo({
        id: "creative-renderer",
        providerId: "fal",
        inputModalities: ["text"],
        outputModalities: ["image"]
      })
    })).toEqual({
      lifecycle: "available",
      usageClass: "image"
    });
  });

  it("classifies audio models", () => {
    expect(classifyModelForCatalog({
      provider: "openai",
      model: "whisper-1",
      modelInfo: modelInfo({
        id: "whisper-1",
        inputModalities: ["audio"],
        outputModalities: ["text"]
      })
    })).toEqual({
      lifecycle: "available",
      usageClass: "audio"
    });
  });

  it("classifies deep-research models", () => {
    expect(classifyModelForCatalog({
      provider: "openai",
      model: "o3-deep-research",
      modelInfo: modelInfo({ id: "o3-deep-research", outputModalities: ["text"] })
    })).toEqual({
      lifecycle: "available",
      usageClass: "deep-research"
    });
  });

  it("classifies moderation models", () => {
    expect(classifyModelForCatalog({
      provider: "openai",
      model: "omni-moderation-latest",
      modelInfo: modelInfo({ id: "omni-moderation-latest", outputModalities: ["text"] })
    })).toEqual({
      lifecycle: "available",
      usageClass: "moderation"
    });
  });

  it("only produces retired lifecycle from overrides", () => {
    expect(classifyModelForCatalog({
      provider: "openai",
      model: "retired-looking-model",
      profile: profile({ id: "retired-looking-model", status: "deprecated" })
    }).lifecycle).toBe("deprecated");

    const overrides: ModelCatalogOverrideRegistry = parseModelCatalogOverrides(registry([{
      model: "retired-looking-model",
      lifecycle: "retired",
      usageClass: "primary-chat"
    }]));

    expect(classifyModelForCatalog({
      provider: "openai",
      model: "retired-looking-model",
      overrides
    }).lifecycle).toBe("retired");
  });
});

describe("buildModelLifecycleWarnings", () => {
  it("builds deterministic retired warnings", () => {
    expect(buildModelLifecycleWarnings({
      policy: { lifecycle: "retired", usageClass: "primary-chat" },
      context: "primary-selection"
    })).toEqual(["Model is retired."]);
  });

  it("builds deterministic deprecated warnings", () => {
    expect(buildModelLifecycleWarnings({
      policy: { lifecycle: "deprecated", usageClass: "primary-chat" },
      context: "primary-selection"
    })).toEqual(["Model is deprecated."]);
  });

  it("adds non-primary warnings only in primary-selection context", () => {
    expect(buildModelLifecycleWarnings({
      policy: { lifecycle: "available", usageClass: "embedding" },
      context: "primary-selection"
    })).toEqual(["Model is not a primary chat model."]);
  });

  it("does not add primary-selection warnings in report or status contexts", () => {
    const policy = { lifecycle: "available" as const, usageClass: "image" as const };

    expect(buildModelLifecycleWarnings({ policy, context: "report" })).toEqual([]);
    expect(buildModelLifecycleWarnings({ policy, context: "status" })).toEqual([]);
  });

  it("emits secret-free warnings", () => {
    const warnings = buildModelLifecycleWarnings({
      policy: { lifecycle: "retired", usageClass: "embedding", note: "token=sk_test_12345678" },
      context: "primary-selection"
    });

    expect(warnings.join(" ")).toBe("Model is retired. Model is not a primary chat model.");
  });
});
