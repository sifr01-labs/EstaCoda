import { describe, expect, it } from "vitest";
import {
  getProviderMetadata,
  isProviderRunnable,
  isProviderConfigurable,
  listProvidersVisibleInSetup,
  listProvidersVisibleInModelPicker,
  listCatalogKnownProviders,
  isProviderMediaOnly
} from "./provider-metadata.js";
import { ProviderRegistry } from "./provider-registry.js";
import { createModelSelectionCatalog } from "./model-selection-catalog.js";
import type { ProviderId } from "../contracts/provider.js";
import type { EstaCodaConfig } from "../config/runtime-config.js";

const EMPTY_CONFIG: EstaCodaConfig = {};

async function makeCatalog(config: EstaCodaConfig = EMPTY_CONFIG, registry = new ProviderRegistry()) {
  return createModelSelectionCatalog({
    config,
    providerRegistry: registry,
    homeDir: "/tmp",
    modelsDevOptions: {
      allowNetwork: false
    }
  });
}

describe("provider architecture invariants", () => {
  describe("visibility invariants", () => {
    it("no setup-visible provider is non-runnable", () => {
      const setupVisible = listProvidersVisibleInSetup();
      for (const meta of setupVisible) {
        expect(meta.runnable).toBe(true);
      }
    });

    it("no model-picker-visible provider is non-runnable", () => {
      const pickerVisible = listProvidersVisibleInModelPicker();
      for (const meta of pickerVisible) {
        expect(meta.runnable).toBe(true);
      }
    });

    it("catalog-known non-runnable providers are not setup or model-picker visible", () => {
      const catalogKnown = listCatalogKnownProviders();
      const nonRunnable = catalogKnown.filter((m) => !m.runnable);
      for (const meta of nonRunnable) {
        expect(meta.visibility.setup).toBe(false);
        expect(meta.visibility.modelPicker).toBe(false);
      }
    });
  });

  describe("apiMode invariants", () => {
    it("unsupported apiMode cannot be runnable except codex openai_responses", () => {
      const knownProviders = [
        "openai", "deepseek", "kimi", "google", "openrouter",
        "local", "anthropic", "codex", "minimax", "nous", "zai"
      ] as ProviderId[];
      for (const id of knownProviders) {
        const meta = getProviderMetadata(id);
        if (meta.apiMode === "anthropic_messages") {
          expect(meta.runnable).toBe(false);
        }
        if (meta.apiMode === "openai_responses") {
          // Only codex is currently runnable with openai_responses
          if (meta.runnable) {
            expect(id).toBe("codex");
          }
        }
      }
    });

    it("supported apiMode providers are runnable when metadata says so", () => {
      expect(getProviderMetadata("openai").apiMode).toBe("openai_chat_completions");
      expect(isProviderRunnable("openai")).toBe(true);

      expect(getProviderMetadata("local").apiMode).toBe("custom_openai_compatible");
      expect(isProviderRunnable("local")).toBe(true);
    });
  });

  describe("Codex invariants", () => {
    it("Codex is catalog-known and visible in setup and model picker", () => {
      const meta = getProviderMetadata("codex");
      expect(meta.catalogKnown).toBe(true);
      expect(meta.runnable).toBe(true);
      expect(meta.configurable).toBe(true);
      expect(meta.visibility.setup).toBe(true);
      expect(meta.visibility.modelPicker).toBe(true);
      expect(meta.visibility.catalogExplore).toBe(true);
    });

    it("Codex is included in setup-visible and picker-visible lists", () => {
      const setupIds = listProvidersVisibleInSetup().map((m) => m.id);
      const pickerIds = listProvidersVisibleInModelPicker().map((m) => m.id);
      expect(setupIds).toContain("codex");
      expect(pickerIds).toContain("codex");
    });

    it("Codex adapter registration makes provider executable when runnable=true", async () => {
      const registry = new ProviderRegistry();
      registry.register({
        id: "codex" as ProviderId,
        name: "OpenAI Codex",
        executable: true,
        health() {
          return { available: true };
        },
        listModels() {
          return [];
        },
        async complete() {
          return { ok: true, content: "", model: "", provider: "codex" };
        }
      });

      const catalog = await makeCatalog({
        providers: {
          codex: {
            kind: "catalog",
            models: ["gpt-5.5"]
          }
        }
      }, registry);

      const models = await catalog.listModels();
      const codex = models.find((m) => m.provider === "codex" && m.id === "gpt-5.5");
      expect(codex).toBeDefined();
      expect(codex!.executable).toBe(true);
      expect(codex!.catalogOnly).toBe(false);
    });

    it("Codex is exposed through normal picker flows", async () => {
      const registry = new ProviderRegistry();
      registry.register({
        id: "codex" as ProviderId,
        name: "OpenAI Codex",
        executable: true,
        health() {
          return { available: true };
        },
        listModels() {
          return [];
        },
        async complete() {
          return { ok: true, content: "", model: "", provider: "codex" };
        }
      });
      const catalog = await makeCatalog({
        providers: {
          codex: {
            kind: "catalog",
            models: ["gpt-5.5"]
          }
        }
      }, registry);

      const providers = await catalog.listProviders({ includeCatalogOnly: false });
      expect(providers.some((p) => p.id === "codex")).toBe(true);
    });

    it("Codex can be selected through normal model/setup picker flows", async () => {
      const registry = new ProviderRegistry();
      registry.register({
        id: "codex" as ProviderId,
        name: "OpenAI Codex",
        executable: true,
        health() {
          return { available: true };
        },
        listModels() {
          return [];
        },
        async complete() {
          return { ok: true, content: "", model: "", provider: "codex" };
        }
      });
      const catalog = await makeCatalog({
        providers: {
          codex: {
            kind: "catalog",
            models: ["gpt-5.5"]
          }
        }
      }, registry);

      const models = await catalog.listModels();
      const codexModel = models.find((m) => m.provider === "codex" && m.id === "gpt-5.5");
      if (codexModel !== undefined) {
        expect(codexModel.executable).toBe(true);
        expect(codexModel.catalogOnly).toBe(false);
      }

      expect(listProvidersVisibleInSetup().some((m) => m.id === "codex")).toBe(true);
      expect(listProvidersVisibleInModelPicker().some((m) => m.id === "codex")).toBe(true);
    });
  });

  describe("Anthropic invariants", () => {
    it("Anthropic is not runnable without native adapter", () => {
      const meta = getProviderMetadata("anthropic");
      expect(meta.catalogKnown).toBe(true);
      expect(meta.runnable).toBe(false);
      expect(meta.configurable).toBe(false);
      expect(meta.apiMode).toBe("anthropic_messages");
    });

    it("Anthropic is not setup or model-picker visible", () => {
      const meta = getProviderMetadata("anthropic");
      expect(meta.visibility.setup).toBe(false);
      expect(meta.visibility.modelPicker).toBe(false);
    });
  });

  describe("media boundary invariants", () => {
    it("media-only providers are not runnable LLM providers", () => {
      const mediaProviders: ProviderId[] = ["fal", "byteplus", "edge", "elevenlabs", "neutts", "kittentts", "groq"];
      for (const id of mediaProviders) {
        expect(isProviderMediaOnly(id)).toBe(true);
        // They must not be in the runnable metadata
        const meta = getProviderMetadata(id as ProviderId);
        // If they happen to be in STATIC_REGISTRY, they must not be runnable
        if (meta.catalogKnown) {
          expect(meta.runnable).toBe(false);
        }
      }
    });

    it("media-only providers are not setup or model-picker visible", () => {
      const setupIds = listProvidersVisibleInSetup().map((m) => m.id);
      const pickerIds = listProvidersVisibleInModelPicker().map((m) => m.id);

      const mediaProviders: ProviderId[] = ["fal", "byteplus", "edge", "elevenlabs", "neutts", "kittentts", "groq"];
      for (const id of mediaProviders) {
        expect(setupIds).not.toContain(id);
        expect(pickerIds).not.toContain(id);
      }
    });
  });

  describe("catalog executable boundary", () => {
    it("metadata runnable=false overrides adapter presence in catalog", async () => {
      const registry = new ProviderRegistry();
      // Register an adapter for anthropic (simulating a future scenario)
      registry.register({
        id: "anthropic" as ProviderId,
        name: "Anthropic",
        executable: true,
        health() {
          return { available: true };
        },
        listModels() {
          return [];
        },
        async complete() {
          return { ok: true, content: "", model: "", provider: "anthropic" };
        }
      });

      const catalog = await makeCatalog({
        providers: {
          anthropic: {
            kind: "catalog",
            models: ["claude-3-opus"]
          }
        }
      }, registry);

      const models = await catalog.listModels();
      const opus = models.find((m) => m.id === "claude-3-opus" && m.provider === "anthropic");
      expect(opus).toBeDefined();
      // Even though an adapter is registered, metadata says runnable=false
      expect(opus!.executable).toBe(false);
      expect(opus!.catalogOnly).toBe(true);
    });

    it("metadata runnable=true plus adapter makes provider executable", async () => {
      const registry = new ProviderRegistry();
      registry.register({
        id: "openai" as ProviderId,
        name: "OpenAI",
        executable: true,
        health() {
          return { available: true };
        },
        listModels() {
          return [];
        },
        async complete() {
          return { ok: true, content: "", model: "", provider: "openai" };
        }
      });

      const catalog = await makeCatalog({
        providers: {
          openai: {
            kind: "openai-compatible",
            models: ["gpt-4o"]
          }
        }
      }, registry);

      const models = await catalog.listModels();
      const gpt4o = models.find((m) => m.id === "gpt-4o" && m.provider === "openai");
      expect(gpt4o).toBeDefined();
      expect(gpt4o!.executable).toBe(true);
      expect(gpt4o!.catalogOnly).toBe(false);
    });
  });

  describe("vision model filtering", () => {
    it("requireVision excludes non-executable vision-capable models", async () => {
      const registry = new ProviderRegistry();
      // Register executable openai adapter
      registry.register({
        id: "openai" as ProviderId,
        name: "OpenAI",
        executable: true,
        health() {
          return { available: true };
        },
        listModels() {
          return [];
        },
        async complete() {
          return { ok: true, content: "", model: "", provider: "openai" };
        }
      });

      // Do NOT register anthropic adapter, but anthropic models in snapshot support vision
      const catalog = await makeCatalog({
        providers: {
          openai: {
            kind: "openai-compatible",
            models: ["gpt-4o"]
          },
          anthropic: {
            kind: "catalog",
            models: ["claude-3-opus"]
          }
        }
      }, registry);

      const visionModels = await catalog.listModels({ requireVision: true });
      // gpt-4o from openai is executable and supports vision
      expect(visionModels.some((m) => m.provider === "openai" && m.id === "gpt-4o")).toBe(true);
      // claude-3-opus supports vision but provider is not executable
      expect(visionModels.some((m) => m.provider === "anthropic")).toBe(false);
    });
  });

  describe("credential isolation", () => {
    it("provider metadata never stores raw API key values", () => {
      const knownProviders = [
        "openai", "deepseek", "kimi", "google", "openrouter",
        "local", "anthropic", "codex", "minimax", "nous", "zai"
      ] as ProviderId[];
      for (const id of knownProviders) {
        const meta = getProviderMetadata(id);
        expect(meta).not.toHaveProperty("apiKey");
        expect(meta).not.toHaveProperty("apiKeyValue");
        expect(meta).not.toHaveProperty("token");
        expect(meta).not.toHaveProperty("secret");
      }
    });

    it("catalog model entries do not contain raw secret fields", async () => {
      const catalog = await makeCatalog({
        providers: {
          openai: {
            kind: "openai-compatible",
            apiKeyEnv: "OPENAI_API_KEY",
            models: ["gpt-4o"]
          }
        }
      });

      const models = await catalog.listModels();
      for (const model of models) {
        expect(model).not.toHaveProperty("apiKeyValue");
        expect(model).not.toHaveProperty("token");
        expect(model).not.toHaveProperty("secret");
      }
    });
  });

  describe("setup picker boundaries", () => {
    it("setup-visible providers are all configurable and runnable", () => {
      const setupVisible = listProvidersVisibleInSetup();
      for (const meta of setupVisible) {
        expect(meta.configurable).toBe(true);
        expect(meta.runnable).toBe(true);
      }
    });

    it("catalog-only providers are not presented as normal setup choices", async () => {
      const registry = new ProviderRegistry();
      registry.register({
        id: "anthropic" as ProviderId,
        name: "Anthropic",
        executable: false,
        health() {
          return { available: true };
        },
        listModels() {
          return [];
        },
        async complete() {
          return { ok: false, content: "", model: "", provider: "anthropic", errorClass: "unsupported" };
        }
      });

      const catalog = await makeCatalog({
        providers: {
          anthropic: {
            kind: "catalog",
            models: ["claude-3-opus"]
          }
        }
      }, registry);

      const providers = await catalog.listProviders({ includeCatalogOnly: false });
      expect(providers.some((p) => p.id === "anthropic")).toBe(false);
    });
  });
});
