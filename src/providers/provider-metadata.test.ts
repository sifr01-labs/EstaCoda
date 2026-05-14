import { describe, expect, it } from "vitest";
import {
  getProviderMetadata,
  getDefaultBaseUrl,
  getDefaultApiKeyEnv,
  isProviderRunnable,
  isProviderConfigurable,
  listProvidersVisibleInSetup,
  listProvidersVisibleInModelPicker,
  listCatalogKnownProviders,
  isProviderMediaOnly,
  resolveCustomProviderMetadata
} from "./provider-metadata.js";
import type { ProviderId } from "../contracts/provider.js";

describe("provider-metadata", () => {
  describe("built-in providers", () => {
    it.each([
      ["openai", "OpenAI", "https://api.openai.com/v1", "OPENAI_API_KEY", true, true, "api_key", "openai_chat_completions"],
      ["deepseek", "DeepSeek", "https://api.deepseek.com/v1", "DEEPSEEK_API_KEY", true, true, "api_key", "openai_chat_completions"],
      ["kimi", "Kimi For Coding", "https://api.moonshot.cn/v1", "KIMI_API_KEY", true, true, "api_key", "openai_chat_completions"],
      ["google", "Google", "https://generativelanguage.googleapis.com/v1beta/openai", "GOOGLE_API_KEY", true, true, "api_key", "openai_chat_completions"],
      ["openrouter", "OpenRouter", "https://openrouter.ai/api/v1", "OPENROUTER_API_KEY", true, true, "api_key", "openai_chat_completions"],
      ["local", "Local", "http://localhost:11434/v1", undefined, true, true, "none", "custom_openai_compatible"],
      ["anthropic", "Anthropic", "https://api.anthropic.com/v1", "ANTHROPIC_API_KEY", true, false, "api_key", "anthropic_messages"],
      ["codex", "OpenAI Codex", undefined, undefined, true, false, "oauth_device_pkce", "openai_responses"],
      ["minimax", "MiniMax", undefined, undefined, true, false, "api_key", "openai_chat_completions"],
      ["nous", "Nous", undefined, undefined, true, false, "api_key", "custom_openai_compatible"],
      ["unconfigured", "Unconfigured", undefined, undefined, false, false, "none", "custom_openai_compatible"],
    ] as const)("%s metadata is correct", (
      id,
      displayName,
      defaultBaseUrl,
      defaultApiKeyEnv,
      catalogKnown,
      runnable,
      defaultAuthMethod,
      apiMode
    ) => {
      const meta = getProviderMetadata(id as ProviderId);
      expect(meta.id).toBe(id);
      expect(meta.displayName).toBe(displayName);
      expect(meta.defaultBaseUrl).toBe(defaultBaseUrl);
      expect(meta.defaultApiKeyEnv).toBe(defaultApiKeyEnv);
      expect(meta.catalogKnown).toBe(catalogKnown);
      expect(meta.runnable).toBe(runnable);
      expect(meta.configurable).toBe(runnable);
      expect(meta.defaultAuthMethod).toBe(defaultAuthMethod);
      expect(meta.apiMode).toBe(apiMode);
    });
  });

  describe("defaults match legacy consumers", () => {
    it("defaultBaseUrl matches runtime-config and create-runtime expectations", () => {
      expect(getDefaultBaseUrl("openai")).toBe("https://api.openai.com/v1");
      expect(getDefaultBaseUrl("deepseek")).toBe("https://api.deepseek.com/v1");
      expect(getDefaultBaseUrl("kimi")).toBe("https://api.moonshot.cn/v1");
      expect(getDefaultBaseUrl("google")).toBe("https://generativelanguage.googleapis.com/v1beta/openai");
      expect(getDefaultBaseUrl("openrouter")).toBe("https://openrouter.ai/api/v1");
      expect(getDefaultBaseUrl("local")).toBe("http://localhost:11434/v1");
      expect(getDefaultBaseUrl("unknown-provider" as ProviderId)).toBe("https://example.invalid/v1");
    });

    it("defaultApiKeyEnv matches runtime-config and create-runtime expectations", () => {
      expect(getDefaultApiKeyEnv("openai")).toBe("OPENAI_API_KEY");
      expect(getDefaultApiKeyEnv("deepseek")).toBe("DEEPSEEK_API_KEY");
      expect(getDefaultApiKeyEnv("kimi")).toBe("KIMI_API_KEY");
      expect(getDefaultApiKeyEnv("google")).toBe("GOOGLE_API_KEY");
      expect(getDefaultApiKeyEnv("openrouter")).toBe("OPENROUTER_API_KEY");
      expect(getDefaultApiKeyEnv("local")).toBe("OPENAI_COMPATIBLE_API_KEY");
      expect(getDefaultApiKeyEnv("anthropic")).toBe("ANTHROPIC_API_KEY");
      expect(getDefaultApiKeyEnv("unknown-provider" as ProviderId)).toBe("OPENAI_COMPATIBLE_API_KEY");
    });
  });

  describe("visibility", () => {
    it("runnable providers are visible in setup and model picker", () => {
      const setupVisible = listProvidersVisibleInSetup().map((m) => m.id);
      const pickerVisible = listProvidersVisibleInModelPicker().map((m) => m.id);

      expect(setupVisible).toContain("openai");
      expect(setupVisible).toContain("deepseek");
      expect(setupVisible).toContain("kimi");
      expect(setupVisible).toContain("google");
      expect(setupVisible).toContain("openrouter");
      expect(setupVisible).toContain("local");

      expect(pickerVisible).toContain("openai");
      expect(pickerVisible).toContain("deepseek");
      expect(pickerVisible).toContain("kimi");
      expect(pickerVisible).toContain("google");
      expect(pickerVisible).toContain("openrouter");
      expect(pickerVisible).toContain("local");
    });

    it("catalog-only providers are not setup or model-picker visible", () => {
      const setupVisible = listProvidersVisibleInSetup().map((m) => m.id);
      const pickerVisible = listProvidersVisibleInModelPicker().map((m) => m.id);

      expect(setupVisible).not.toContain("codex");
      expect(setupVisible).not.toContain("anthropic");
      expect(setupVisible).not.toContain("minimax");
      expect(setupVisible).not.toContain("nous");

      expect(pickerVisible).not.toContain("codex");
      expect(pickerVisible).not.toContain("anthropic");
      expect(pickerVisible).not.toContain("minimax");
      expect(pickerVisible).not.toContain("nous");
    });

    it("codex is catalog-known but hidden from setup/model-picker", () => {
      const meta = getProviderMetadata("codex");
      expect(meta.catalogKnown).toBe(true);
      expect(meta.visibility.setup).toBe(false);
      expect(meta.visibility.modelPicker).toBe(false);
      expect(meta.visibility.catalogExplore).toBe(true);
      expect(meta.configurable).toBe(false);
      expect(meta.runnable).toBe(false);
    });
  });

  describe("runnable boundary", () => {
    it("catalog-only providers are not runnable", () => {
      expect(isProviderRunnable("codex")).toBe(false);
      expect(isProviderRunnable("anthropic")).toBe(false);
      expect(isProviderRunnable("minimax")).toBe(false);
      expect(isProviderRunnable("nous")).toBe(false);
      expect(isProviderRunnable("unconfigured")).toBe(false);
    });

    it("runnable providers remain runnable", () => {
      expect(isProviderRunnable("openai")).toBe(true);
      expect(isProviderRunnable("deepseek")).toBe(true);
      expect(isProviderRunnable("kimi")).toBe(true);
      expect(isProviderRunnable("google")).toBe(true);
      expect(isProviderRunnable("openrouter")).toBe(true);
      expect(isProviderRunnable("local")).toBe(true);
    });
  });

  describe("custom providers", () => {
    it("unknown provider resolves as custom-compatible with no default base URL", () => {
      const meta = getProviderMetadata("custom-corp" as ProviderId);
      expect(meta.catalogKnown).toBe(false);
      expect(meta.configurable).toBe(true);
      expect(meta.runnable).toBe(true);
      expect(meta.defaultBaseUrl).toBeUndefined();
      expect(meta.allowsCustomBaseUrl).toBe(true);
      expect(meta.requiresModelSelection).toBe(true);
    });

    it("custom provider factory requires explicit base URL", () => {
      const meta = resolveCustomProviderMetadata("my-custom" as ProviderId, "https://custom.example/v1");
      expect(meta.id).toBe("my-custom");
      expect(meta.configurable).toBe(true);
      expect(meta.runnable).toBe(true);
      expect(meta.defaultBaseUrl).toBe("https://custom.example/v1");
    });

    it("custom provider factory without base URL is still valid", () => {
      const meta = resolveCustomProviderMetadata("my-custom" as ProviderId);
      expect(meta.id).toBe("my-custom");
      expect(meta.defaultBaseUrl).toBeUndefined();
    });
  });

  describe("media boundary", () => {
    it("native media providers are not treated as runnable LLM providers", () => {
      expect(isProviderMediaOnly("fal" as ProviderId)).toBe(true);
      expect(isProviderMediaOnly("byteplus" as ProviderId)).toBe(true);
      expect(isProviderMediaOnly("edge" as ProviderId)).toBe(true);
      expect(isProviderMediaOnly("elevenlabs" as ProviderId)).toBe(true);
      expect(isProviderMediaOnly("neutts" as ProviderId)).toBe(true);
      expect(isProviderMediaOnly("kittentts" as ProviderId)).toBe(true);
      expect(isProviderMediaOnly("groq" as ProviderId)).toBe(true);
    });

    it("LLM providers are not media-only", () => {
      expect(isProviderMediaOnly("openai")).toBe(false);
      expect(isProviderMediaOnly("deepseek")).toBe(false);
      expect(isProviderMediaOnly("kimi")).toBe(false);
      expect(isProviderMediaOnly("google")).toBe(false);
      expect(isProviderMediaOnly("openrouter")).toBe(false);
      expect(isProviderMediaOnly("local")).toBe(false);
      expect(isProviderMediaOnly("anthropic")).toBe(false);
      expect(isProviderMediaOnly("codex")).toBe(false);
    });
  });

  describe("catalog known list", () => {
    it("includes all catalog-known providers", () => {
      const known = listCatalogKnownProviders().map((m) => m.id);
      expect(known).toContain("openai");
      expect(known).toContain("deepseek");
      expect(known).toContain("kimi");
      expect(known).toContain("google");
      expect(known).toContain("openrouter");
      expect(known).toContain("local");
      expect(known).toContain("anthropic");
      expect(known).toContain("codex");
      expect(known).toContain("minimax");
      expect(known).toContain("nous");
      expect(known).not.toContain("unconfigured");
    });
  });
});
