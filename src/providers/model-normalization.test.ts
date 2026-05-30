import { describe, it, expect } from "vitest";
import { normalizeModelInput } from "./model-normalization.js";
import type { EstaCodaConfig } from "../config/runtime-config.js";

describe("model-normalization", () => {
  const emptyConfig: EstaCodaConfig = {};

  describe("exact route input", () => {
    it("bypasses alias rewriting and returns exact route", async () => {
      const result = await normalizeModelInput("openai/gpt-4o", { config: emptyConfig });
      expect(result.kind).toBe("exact");
      if (result.kind !== "exact") return;
      expect(result.route.provider).toBe("openai");
      expect(result.route.id).toBe("gpt-4o");
      expect(result.resolvedViaAlias).toBeUndefined();
    });

    it("returns unknown for empty provider or model", async () => {
      const r1 = await normalizeModelInput("/model", { config: emptyConfig });
      expect(r1.kind).toBe("unknown");

      const r2 = await normalizeModelInput("openai/", { config: emptyConfig });
      expect(r2.kind).toBe("unknown");
    });

    it("fills baseUrl and apiMode from provider metadata", async () => {
      const result = await normalizeModelInput("deepseek/deepseek-chat", { config: emptyConfig });
      expect(result.kind).toBe("exact");
      if (result.kind !== "exact") return;
      expect(result.route.baseUrl).toBe("https://api.deepseek.com/v1");
      expect(result.route.apiMode).toBe("openai_chat_completions");
    });
  });

  describe("direct config alias", () => {
    it("resolves to exact route and bypasses catalog matching", async () => {
      const config: EstaCodaConfig = {
        modelAliases: {
          qwen: {
            provider: "custom",
            model: "qwen3.5:397b",
            baseUrl: "http://localhost:11434/v1",
            apiMode: "custom_openai_compatible"
          }
        }
      };
      const result = await normalizeModelInput("qwen", { config });
      expect(result.kind).toBe("exact");
      if (result.kind !== "exact") return;
      expect(result.route.provider).toBe("custom");
      expect(result.route.id).toBe("qwen3.5:397b");
      expect(result.route.baseUrl).toBe("http://localhost:11434/v1");
      expect(result.route.apiMode).toBe("custom_openai_compatible");
      expect(result.resolvedViaAlias).toBe("qwen");
    });

    it("reads from model_aliases (snake_case) when modelAliases absent", async () => {
      const config: EstaCodaConfig = {
        model_aliases: {
          qwen: { provider: "local", model: "llama3" }
        }
      };
      const result = await normalizeModelInput("qwen", { config });
      expect(result.kind).toBe("exact");
      if (result.kind !== "exact") return;
      expect(result.route.provider).toBe("local");
      expect(result.route.id).toBe("llama3");
    });

    it("fails clearly when alias is missing required fields", async () => {
      const config: EstaCodaConfig = {
        modelAliases: {
          bad: { provider: "", model: "" }
        }
      };
      const result = await normalizeModelInput("bad", { config });
      expect(result.kind).toBe("unknown");
      if (result.kind !== "unknown") return;
      expect(result.reason).toContain("missing required fields");
    });

    it("preserves apiKeyEnv from alias definition", async () => {
      const config: EstaCodaConfig = {
        modelAliases: {
          mykey: { provider: "openai", model: "gpt-4o", apiKeyEnv: "MY_OPENAI_KEY" }
        }
      };
      const result = await normalizeModelInput("mykey", { config });
      expect(result.kind).toBe("exact");
      if (result.kind !== "exact") return;
      expect(result.route.apiKeyEnv).toBe("MY_OPENAI_KEY");
    });

    it("preserves maxTokens from alias definition", async () => {
      const config: EstaCodaConfig = {
        modelAliases: {
          mykey: { provider: "openai", model: "gpt-4o", maxTokens: 8192 }
        }
      };
      const result = await normalizeModelInput("mykey", { config });
      expect(result.kind).toBe("exact");
      if (result.kind !== "exact") return;
      expect(result.route.maxTokens).toBe(8192);
    });

    it("rejects invalid alias maxTokens", async () => {
      const config: EstaCodaConfig = {
        modelAliases: {
          mykey: { provider: "openai", model: "gpt-4o", maxTokens: 0 }
        }
      };

      await expect(normalizeModelInput("mykey", { config }))
        .rejects
        .toThrow("modelAliases.mykey.maxTokens must be a positive integer when set.");
    });
  });

  describe("curated alias", () => {
    it("resolves kimi to a kimi catalog model", async () => {
      const result = await normalizeModelInput("kimi", { config: emptyConfig });
      expect(result.kind).toBe("exact");
      if (result.kind !== "exact") return;
      expect(result.route.provider).toBe("kimi");
      expect(result.resolvedViaAlias).toBe("kimi");
    });

    it("resolves gpt4 to an openai catalog model", async () => {
      const result = await normalizeModelInput("gpt4", { config: emptyConfig });
      expect(result.kind).toBe("exact");
      if (result.kind !== "exact") return;
      expect(result.route.provider).toBe("openai");
      expect(result.resolvedViaAlias).toBe("gpt4");
    });

    it("fails clearly for stale alias with no catalog match", async () => {
      const result = await normalizeModelInput("nonexistent-alias", { config: emptyConfig });
      expect(result.kind).toBe("unknown");
      if (result.kind !== "unknown") return;
      expect(result.reason).toContain("Could not resolve");
    });

    it("does not pick arbitrary registry models for stale alias", async () => {
      const result = await normalizeModelInput("stale-alias-12345", { config: emptyConfig });
      expect(result.kind).toBe("unknown");
    });
  });

  describe("version/suffix sorting", () => {
    it("picks pro over base for same version", async () => {
      // This tests the sorting logic directly
      const { sortVersionSuffix } = await import("./model-normalization.js");
      const candidates = [
        { provider: "test" as const, model: "mimo-v2.5", profile: { id: "mimo-v2.5", provider: "test", contextWindowTokens: 0, supportsTools: false, supportsVision: false, supportsStructuredOutput: false } as any },
        { provider: "test" as const, model: "mimo-v2.5-pro", profile: { id: "mimo-v2.5-pro", provider: "test", contextWindowTokens: 0, supportsTools: false, supportsVision: false, supportsStructuredOutput: false } as any }
      ];
      const sorted = sortVersionSuffix(candidates);
      expect(sorted[0]!.model).toBe("mimo-v2.5-pro");
      expect(sorted[1]!.model).toBe("mimo-v2.5");
    });
  });

  describe("resolvedViaAlias metadata", () => {
    it("is absent for exact route input", async () => {
      const result = await normalizeModelInput("openai/gpt-4o", { config: emptyConfig });
      expect(result.kind).toBe("exact");
      if (result.kind !== "exact") return;
      expect(result.resolvedViaAlias).toBeUndefined();
    });

    it("is present for direct alias", async () => {
      const config: EstaCodaConfig = {
        modelAliases: { qwen: { provider: "local", model: "qwen2.5" } }
      };
      const result = await normalizeModelInput("qwen", { config });
      expect(result.kind).toBe("exact");
      if (result.kind !== "exact") return;
      expect(result.resolvedViaAlias).toBe("qwen");
    });

    it("is present for curated alias", async () => {
      const result = await normalizeModelInput("gpt4", { config: emptyConfig });
      expect(result.kind).toBe("exact");
      if (result.kind !== "exact") return;
      expect(result.resolvedViaAlias).toBe("gpt4");
    });
  });
});
