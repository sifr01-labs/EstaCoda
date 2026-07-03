import { describe, expect, it } from "vitest";
import {
  getProviderMetadata,
  getProviderDefaultBaseUrl,
  getDefaultApiKeyEnv,
  isProviderRunnable,
  isProviderConfigurable,
  listProvidersVisibleInSetup,
  listProvidersVisibleInModelPicker,
  listCatalogKnownProviders,
  isProviderMediaOnly,
  resolveChatMaxTokenParam,
  resolveCustomProviderMetadata,
  buildResolvedModelRoute,
  type ProviderMetadata
} from "./provider-metadata.js";
import {
  DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS,
  DEFAULT_PROVIDER_STALE_TIMEOUT_MS,
  type ProviderId
} from "../contracts/provider.js";

describe("provider-metadata", () => {
  describe("built-in providers", () => {
    it.each([
      ["openai", "OpenAI", "https://api.openai.com/v1", "OPENAI_API_KEY", true, true, "api_key", "openai_chat_completions"],
      ["deepseek", "DeepSeek", "https://api.deepseek.com/v1", "DEEPSEEK_API_KEY", true, true, "api_key", "openai_chat_completions"],
      ["kimi", "Kimi", "https://api.moonshot.ai/v1", "KIMI_API_KEY", true, true, "api_key", "openai_chat_completions"],
      ["google", "Google", "https://generativelanguage.googleapis.com/v1beta/openai", "GOOGLE_API_KEY", true, true, "api_key", "openai_chat_completions"],
      ["openrouter", "OpenRouter", "https://openrouter.ai/api/v1", "OPENROUTER_API_KEY", true, true, "api_key", "openai_chat_completions"],
      ["zai", "Z.AI", "https://api.z.ai/api/paas/v4", "ZAI_API_KEY", true, true, "api_key", "openai_chat_completions"],
      ["local", "Local / Custom", "http://localhost:11434/v1", undefined, true, true, "none", "custom_openai_compatible"],
      ["anthropic", "Anthropic", "https://api.anthropic.com/v1", "ANTHROPIC_API_KEY", true, false, "api_key", "anthropic_messages"],
      ["codex", "OpenAI Codex", "https://chatgpt.com/backend-api/codex", undefined, true, true, "oauth_device_pkce", "openai_responses"],
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
    it("provider default base URL returns real metadata defaults only", () => {
      expect(getProviderDefaultBaseUrl("openai")).toBe("https://api.openai.com/v1");
      expect(getProviderDefaultBaseUrl("deepseek")).toBe("https://api.deepseek.com/v1");
      expect(getProviderDefaultBaseUrl("kimi")).toBe("https://api.moonshot.ai/v1");
      expect(getProviderDefaultBaseUrl("google")).toBe("https://generativelanguage.googleapis.com/v1beta/openai");
      expect(getProviderDefaultBaseUrl("openrouter")).toBe("https://openrouter.ai/api/v1");
      expect(getProviderDefaultBaseUrl("zai")).toBe("https://api.z.ai/api/paas/v4");
      expect(getProviderDefaultBaseUrl("local")).toBe("http://localhost:11434/v1");
      expect(getProviderDefaultBaseUrl("unknown-provider" as ProviderId)).toBeUndefined();
      expect(getProviderDefaultBaseUrl("nous")).toBeUndefined();
    });

    it("keeps OpenRouter attribution defaults in provider metadata", () => {
      expect(getProviderMetadata("openrouter").defaultHeaders).toEqual({
        "HTTP-Referer": "https://www.estacoda.com",
        "X-Title": "EstaCoda"
      });
      expect(getProviderMetadata("openai").defaultHeaders).toBeUndefined();
    });

    it("defaultApiKeyEnv matches runtime-config and create-runtime expectations", () => {
      expect(getDefaultApiKeyEnv("openai")).toBe("OPENAI_API_KEY");
      expect(getDefaultApiKeyEnv("deepseek")).toBe("DEEPSEEK_API_KEY");
      expect(getDefaultApiKeyEnv("kimi")).toBe("KIMI_API_KEY");
      expect(getDefaultApiKeyEnv("google")).toBe("GOOGLE_API_KEY");
      expect(getDefaultApiKeyEnv("openrouter")).toBe("OPENROUTER_API_KEY");
      expect(getDefaultApiKeyEnv("zai")).toBe("ZAI_API_KEY");
      expect(getDefaultApiKeyEnv("local")).toBe("OPENAI_COMPATIBLE_API_KEY");
      expect(getDefaultApiKeyEnv("anthropic")).toBe("ANTHROPIC_API_KEY");
      expect(getDefaultApiKeyEnv("unknown-provider" as ProviderId)).toBe("OPENAI_COMPATIBLE_API_KEY");
    });

    it("local provider keeps no-auth as default while allowing optional API keys", () => {
      const local = getProviderMetadata("local");
      expect(local.defaultApiKeyEnv).toBeUndefined();
      expect(local.authMethods).toContain("api_key");
      expect(local.defaultAuthMethod).toBe("none");
      expect(getDefaultApiKeyEnv("local")).toBe("OPENAI_COMPATIBLE_API_KEY");
    });

    it("exposes optional provider finalization metadata knobs without enabling reasoning echo by default", () => {
      const openai = getProviderMetadata("openai");
      const codex = getProviderMetadata("codex");
      const custom = getProviderMetadata("custom-corp" as ProviderId);

      expect(openai).toHaveProperty("apiMode");
      expect(openai.chatMaxTokenParam).toBeUndefined();
      expect(openai.reasoningEchoField).toBeUndefined();
      expect(openai.requiresReasoningEcho).toBeUndefined();
      expect(codex.reasoningEchoField).toBeUndefined();
      expect(codex.requiresReasoningEcho).toBeUndefined();
      expect(custom.chatMaxTokenParam).toBeUndefined();
      expect(custom.reasoningEchoField).toBeUndefined();
      expect(custom.requiresReasoningEcho).toBeUndefined();
    });

    it("types provider metadata token parameter and reasoning echo fields", () => {
      const metadata: ProviderMetadata = {
        ...getProviderMetadata("openai"),
        chatMaxTokenParam: "max_completion_tokens",
        reasoningEchoField: "reasoning_content"
      };

      expect(metadata.chatMaxTokenParam).toBe("max_completion_tokens");
      expect(metadata.reasoningEchoField).toBe("reasoning_content");
    });

    it("defaults native tool history support off for custom and deferred providers", () => {
      for (const id of ["custom-corp", "codex", "anthropic", "minimax", "nous", "local", "google", "zai"] as const) {
        const metadata = getProviderMetadata(id as ProviderId);
        expect(metadata.supportsNativeToolHistory).not.toBe(true);
        expect(metadata.allowReasoningEchoPlaceholder).not.toBe(true);
      }
    });

    it("enables tested Chat Completions native history routes only", () => {
      expect(getProviderMetadata("openai")).toMatchObject({
        apiMode: "openai_chat_completions",
        supportsNativeToolHistory: true
      });
      expect(getProviderMetadata("deepseek")).toMatchObject({
        apiMode: "openai_chat_completions",
        supportsNativeToolHistory: true,
        requiresReasoningEcho: true,
        reasoningEchoField: "reasoning_content",
        reasoningEchoRequiredForToolCalls: true,
        reasoningEchoProviderFamily: "deepseek"
      });
      expect(getProviderMetadata("kimi")).toMatchObject({
        apiMode: "openai_chat_completions",
        supportsNativeToolHistory: true,
        requiresReasoningEcho: true,
        reasoningEchoField: "reasoning_content",
        reasoningEchoRequiredForToolCalls: true,
        reasoningEchoProviderFamily: "kimi"
      });
      expect(getProviderMetadata("openrouter")).toMatchObject({
        apiMode: "openai_chat_completions",
        supportsNativeToolHistory: true
      });
      expect(getProviderMetadata("codex").apiMode).toBe("openai_responses");
      expect(getProviderMetadata("codex").supportsNativeToolHistory).not.toBe(true);
      expect(getProviderMetadata("zai")).toMatchObject({
        apiMode: "openai_chat_completions"
      });
      expect(getProviderMetadata("zai").supportsNativeToolHistory).toBeUndefined();
      expect(getProviderMetadata("anthropic").apiMode).toBe("anthropic_messages");
      expect(getProviderMetadata("anthropic").supportsNativeToolHistory).not.toBe(true);
    });

    it("resolves chat max token parameter names from provider metadata", () => {
      expect(resolveChatMaxTokenParam("openai")).toBe("max_completion_tokens");
      expect(resolveChatMaxTokenParam("deepseek")).toBe("max_tokens");
      expect(resolveChatMaxTokenParam("custom-corp" as ProviderId)).toBe("max_tokens");
      expect(resolveChatMaxTokenParam("custom-corp" as ProviderId, {
        chatMaxTokenParam: "max_completion_tokens"
      })).toBe("max_completion_tokens");
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
      expect(setupVisible).toContain("zai");
      expect(setupVisible).toContain("local");
      expect(setupVisible).toContain("codex");

      expect(pickerVisible).toContain("openai");
      expect(pickerVisible).toContain("deepseek");
      expect(pickerVisible).toContain("kimi");
      expect(pickerVisible).toContain("google");
      expect(pickerVisible).toContain("openrouter");
      expect(pickerVisible).toContain("zai");
      expect(pickerVisible).toContain("local");
      expect(pickerVisible).toContain("codex");
    });

    it("catalog-only providers are not setup or model-picker visible", () => {
      const setupVisible = listProvidersVisibleInSetup().map((m) => m.id);
      const pickerVisible = listProvidersVisibleInModelPicker().map((m) => m.id);

      expect(setupVisible).not.toContain("anthropic");
      expect(setupVisible).not.toContain("minimax");
      expect(setupVisible).not.toContain("nous");

      expect(pickerVisible).not.toContain("anthropic");
      expect(pickerVisible).not.toContain("minimax");
      expect(pickerVisible).not.toContain("nous");
    });

    it("codex is catalog-known and visible in setup and model picker", () => {
      const meta = getProviderMetadata("codex");
      expect(meta.catalogKnown).toBe(true);
      expect(meta.visibility.setup).toBe(true);
      expect(meta.visibility.modelPicker).toBe(true);
      expect(meta.visibility.catalogExplore).toBe(true);
      expect(meta.configurable).toBe(true);
      expect(meta.runnable).toBe(true);
    });
  });

  describe("runnable boundary", () => {
    it("catalog-only providers are not runnable", () => {
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
      expect(isProviderRunnable("zai")).toBe(true);
      expect(isProviderRunnable("local")).toBe(true);
      expect(isProviderRunnable("codex")).toBe(true);
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
      expect(isProviderMediaOnly("zai")).toBe(false);
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
      expect(known).toContain("zai");
      expect(known).toContain("local");
      expect(known).toContain("anthropic");
      expect(known).toContain("codex");
      expect(known).toContain("minimax");
      expect(known).toContain("nous");
      expect(known).not.toContain("unconfigured");
    });
  });

  describe("buildResolvedModelRoute", () => {
    it("constructs a ResolvedModelRoute with provider-derived apiMode", () => {
      const route = buildResolvedModelRoute({
        provider: "openai",
        model: "gpt-4o",
        profile: {
          id: "gpt-4o",
          provider: "openai",
          contextWindowTokens: 128000,
          supportsTools: true,
          supportsVision: true,
          supportsStructuredOutput: true
        }
      });

      expect(route.provider).toBe("openai");
      expect(route.id).toBe("gpt-4o");
      expect(route.apiMode).toBe("openai_chat_completions");
      expect(route.baseUrl).toBeUndefined();
      expect(route.apiKeyEnv).toBeUndefined();
      expect((route as ResolvedRouteNativeMetadata).supportsNativeToolHistory).toBe(true);
    });

    it("applies provider timeout defaults when omitted", () => {
      const route = buildResolvedModelRoute({
        provider: "openai",
        model: "gpt-4o",
        profile: {
          id: "gpt-4o",
          provider: "openai",
          contextWindowTokens: 128000,
          supportsTools: true,
          supportsVision: true,
          supportsStructuredOutput: true
        }
      });

      expect(route.timeoutMs).toBe(DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS);
      expect(route.staleTimeoutMs).toBe(DEFAULT_PROVIDER_STALE_TIMEOUT_MS);
    });

    it("preserves explicit provider timeout fields", () => {
      const route = buildResolvedModelRoute({
        provider: "openai",
        model: "gpt-4o",
        profile: {
          id: "gpt-4o",
          provider: "openai",
          contextWindowTokens: 128000,
          supportsTools: true,
          supportsVision: true,
          supportsStructuredOutput: true
        },
        timeoutMs: 1234,
        staleTimeoutMs: 567
      });

      expect(route.timeoutMs).toBe(1234);
      expect(route.staleTimeoutMs).toBe(567);
    });

    it("preserves explicit apiMode when provided", () => {
      const route = buildResolvedModelRoute({
        provider: "openai",
        model: "gpt-4o",
        profile: {
          id: "gpt-4o",
          provider: "openai",
          contextWindowTokens: 128000,
          supportsTools: true,
          supportsVision: true,
          supportsStructuredOutput: true
        },
        apiMode: "openai_responses"
      });

      expect(route.apiMode).toBe("openai_responses");
    });

    it("carries baseUrl and apiKeyEnv when provided", () => {
      const route = buildResolvedModelRoute({
        provider: "deepseek",
        model: "deepseek-chat",
        profile: {
          id: "deepseek-chat",
          provider: "deepseek",
          contextWindowTokens: 128000,
          supportsTools: true,
          supportsVision: false,
          supportsStructuredOutput: true
        },
        baseUrl: "https://custom.deepseek.com/v1",
        apiKeyEnv: "DEEPSEEK_KEY"
      });

      expect(route.baseUrl).toBe("https://custom.deepseek.com/v1");
      expect(route.apiKeyEnv).toBe("DEEPSEEK_KEY");
      expect(route.apiMode).toBe("openai_chat_completions");
      expect((route as ResolvedRouteNativeMetadata).supportsNativeToolHistory).toBe(true);
      expect((route as ResolvedRouteNativeMetadata).requiresReasoningEcho).toBe(true);
      expect((route as ResolvedRouteNativeMetadata).reasoningEchoProviderFamily).toBe("deepseek");
    });

    it("defaults unknown providers to custom_openai_compatible apiMode", () => {
      const route = buildResolvedModelRoute({
        provider: "unknown-corp" as ProviderId,
        model: "custom-model",
        profile: {
          id: "custom-model",
          provider: "unknown-corp" as ProviderId,
          contextWindowTokens: 128000,
          supportsTools: true,
          supportsVision: false,
          supportsStructuredOutput: true
        }
      });

      expect(route.apiMode).toBe("custom_openai_compatible");
    });

    it("does not include raw secrets in the route", () => {
      const route = buildResolvedModelRoute({
        provider: "openai",
        model: "gpt-4o",
        profile: {
          id: "gpt-4o",
          provider: "openai",
          contextWindowTokens: 128000,
          supportsTools: true,
          supportsVision: true,
          supportsStructuredOutput: true
        }
      });

      expect(route).not.toHaveProperty("apiKey");
      expect(route).not.toHaveProperty("credential");
    });
  });
});

type ResolvedRouteNativeMetadata = {
  supportsNativeToolHistory?: boolean;
  requiresReasoningEcho?: boolean;
  reasoningEchoProviderFamily?: string;
};
