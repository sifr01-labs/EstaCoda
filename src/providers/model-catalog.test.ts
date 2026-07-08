import { describe, expect, it } from "vitest";
import {
  buildProfileResolutionContext,
  resolveModelProfile,
  fallbackKnownModelProfiles,
  inferModelProfile,
  inferProviderFromModel
} from "./model-catalog.js";
import type { ModelsDevSnapshot } from "../model-catalog/models-dev-registry.js";

function makeSnapshot(models: Array<{ id: string; providerId: string; contextWindow: number; status?: string }>): ModelsDevSnapshot {
  return {
    providers: [],
    models: models.map((m) => ({
      id: m.id,
      name: m.id,
      family: m.id,
      providerId: m.providerId,
      reasoning: false,
      toolCall: false,
      attachment: false,
      temperature: true,
      structuredOutput: false,
      openWeights: false,
      inputModalities: ["text"],
      outputModalities: ["text"],
      contextWindow: m.contextWindow,
      maxOutput: 4096,
      status: (m.status as any) ?? "stable",
      interleaved: false
    })),
    fetchedAt: "2024-01-01T00:00:00.000Z",
    source: "bundled"
  };
}

describe("buildProfileResolutionContext", () => {
  it("includes all snapshot profiles with alpha/beta/deprecated", () => {
    const snapshot = makeSnapshot([
      { id: "gpt-4o", providerId: "openai", contextWindow: 128000 },
      { id: "gpt-4o-beta", providerId: "openai", contextWindow: 128000, status: "beta" },
      { id: "gpt-4o-deprecated", providerId: "openai", contextWindow: 128000, status: "deprecated" }
    ]);
    const ctx = buildProfileResolutionContext(snapshot);
    expect(ctx.snapshotProfiles.has("openai:gpt-4o")).toBe(true);
    expect(ctx.snapshotProfiles.has("openai:gpt-4o-beta")).toBe(true);
    expect(ctx.snapshotProfiles.has("openai:gpt-4o-deprecated")).toBe(true);
  });

  it("references fallbackKnownModelProfiles", () => {
    const ctx = buildProfileResolutionContext(makeSnapshot([]));
    expect(ctx.fallbackProfiles).toBe(fallbackKnownModelProfiles);
  });
});

describe("fallbackKnownModelProfiles", () => {
  it("includes Codex GPT-5.5 as a vision-capable route", () => {
    const codex = fallbackKnownModelProfiles.find((profile) =>
      profile.provider === "codex" && profile.id === "gpt-5.5"
    );

    expect(codex).toEqual(expect.objectContaining({
      supportsTools: true,
      supportsVision: true,
      supportsStructuredOutput: true
    }));
  });

  it("includes first-class Z.ai GLM fallback profiles", () => {
    const zaiModels = fallbackKnownModelProfiles
      .filter((profile) => profile.provider === "zai")
      .map((profile) => profile.id);

    expect(zaiModels).toEqual(expect.arrayContaining([
      "glm-5.2",
      "glm-5.1",
      "glm-5",
      "glm-4.7-flash"
    ]));
  });
});

describe("resolveModelProfile", () => {
  it("returns snapshot profile when model exists in snapshot", () => {
    const snapshot = makeSnapshot([
      { id: "gpt-4o", providerId: "openai", contextWindow: 128000 }
    ]);
    const ctx = buildProfileResolutionContext(snapshot);
    const result = resolveModelProfile("openai", "gpt-4o", ctx);
    expect(result.source).toBe("models-dev");
    expect(result.profile.id).toBe("gpt-4o");
    expect(result.profile.provider).toBe("openai");
    expect(result.profile.contextWindowTokens).toBe(128000);
  });

  it("returns fallback-known profile when missing from snapshot", () => {
    const ctx = buildProfileResolutionContext(makeSnapshot([]));
    const result = resolveModelProfile("deepseek", "deepseek-chat", ctx);
    expect(result.source).toBe("fallback-known");
    expect(result.profile.id).toBe("deepseek-chat");
    expect(result.profile.provider).toBe("deepseek");
  });

  it("returns inferred profile when missing from both", () => {
    const ctx = buildProfileResolutionContext(makeSnapshot([]));
    const result = resolveModelProfile("openai", "unknown-model-xyz", ctx);
    expect(result.source).toBe("inferred");
    expect(result.profile.id).toBe("unknown-model-xyz");
    expect(result.profile.provider).toBe("openai");
    expect(result.profile.status).toBe("unknown");
  });

  it("prefers snapshot over fallback-known when both exist", () => {
    const snapshot = makeSnapshot([
      { id: "deepseek-chat", providerId: "deepseek", contextWindow: 99999 }
    ]);
    const ctx = buildProfileResolutionContext(snapshot);
    const result = resolveModelProfile("deepseek", "deepseek-chat", ctx);
    expect(result.source).toBe("models-dev");
    expect(result.profile.contextWindowTokens).toBe(99999);
  });

  it("does not mutate model IDs", () => {
    const snapshot = makeSnapshot([
      { id: "gpt-4o", providerId: "openai", contextWindow: 128000 }
    ]);
    const ctx = buildProfileResolutionContext(snapshot);
    const result = resolveModelProfile("openai", "gpt-4o", ctx);
    expect(result.profile.id).toBe("gpt-4o");
  });
});

describe("inferProviderFromModel", () => {
  it("keeps known OpenRouter fallback model IDs on OpenRouter", () => {
    expect(inferProviderFromModel("openrouter/auto")).toBe("openrouter");
    expect(inferProviderFromModel("qwen/qwen3.6-plus")).toBe("openrouter");
  });

  it("does not infer OpenRouter for arbitrary slash model IDs", () => {
    for (const modelId of [
      "huggingface/mistral-large",
      "togetherai/llama-3.3-70b",
      "fireworks/qwen2.5-coder",
      "perplexity/sonar"
    ]) {
      expect(inferProviderFromModel(modelId)).toBe("openai-compatible");
    }
  });

  it("keeps explicit native provider prefixes native", () => {
    expect(inferProviderFromModel("openai/gpt-4o")).toBe("openai");
    expect(inferProviderFromModel("anthropic/claude-sonnet-4.5")).toBe("anthropic");
    expect(inferProviderFromModel("google/gemini-2.5-pro")).toBe("google");
    expect(inferProviderFromModel("deepseek/deepseek-chat")).toBe("deepseek");
  });
});

describe("inferModelProfile", () => {
  it("profiles arbitrary slash model IDs as OpenAI-compatible instead of OpenRouter", () => {
    const profile = inferModelProfile({ model: "huggingface/mistral-large" });

    expect(profile.provider).toBe("openai-compatible");
    expect(profile.id).toBe("huggingface/mistral-large");
    expect(profile.status).toBe("unknown");
  });

  it("infers context from upstream family names instead of OpenRouter catch-all text", () => {
    const profile = inferModelProfile({
      provider: "openrouter",
      model: "openrouter/meta-llama/llama-3.1-70b"
    });

    expect(profile.contextWindowTokens).toBe(8192);
  });
});
