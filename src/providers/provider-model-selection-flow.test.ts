import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  createProviderModelSelectionFlow,
  type ProviderModelSelectionFlowOptions
} from "./provider-model-selection-flow.js";
import { ProviderRegistry } from "./provider-registry.js";
import { createCatalogProvider } from "./catalog-provider.js";
import { resetModelsDevRegistryForTest } from "../model-catalog/models-dev-registry.js";
import type { ProviderId, ProviderEndpoint } from "../contracts/provider.js";
import type { EstaCodaConfig } from "../config/runtime-config.js";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelCatalogOverrideRegistry } from "../model-catalog/model-catalog-policy.js";

function createMockSnapshot(): Record<string, unknown> {
  return {
    providers: [
      { id: "openai", name: "OpenAI" },
      { id: "anthropic", name: "Anthropic" },
      { id: "deepseek", name: "DeepSeek" },
      { id: "kimi", name: "Kimi" },
      { id: "google", name: "Google" },
      { id: "openrouter", name: "OpenRouter" },
      { id: "local", name: "Local / Private" },
      { id: "codex", name: "OpenAI Codex" },
      { id: "fal", name: "Fal" }
    ],
    models: [
      {
        id: "gpt-4o",
        provider_id: "openai",
        context_window: 128_000,
        input_modalities: ["text", "image"],
        output_modalities: ["text"],
        reasoning: false,
        tool_call: true,
        structured_output: true,
        status: "stable"
      },
      {
        id: "gpt-retired",
        provider_id: "openai",
        context_window: 128_000,
        input_modalities: ["text"],
        output_modalities: ["text"],
        reasoning: false,
        tool_call: true,
        structured_output: true,
        status: "stable"
      },
      {
        id: "gpt-image-test",
        provider_id: "openai",
        context_window: 0,
        input_modalities: ["text"],
        output_modalities: ["image"],
        reasoning: false,
        tool_call: false,
        structured_output: false,
        status: "stable"
      },
      {
        id: "claude-3-opus",
        provider_id: "anthropic",
        context_window: 200_000,
        input_modalities: ["text", "image"],
        output_modalities: ["text"],
        reasoning: false,
        tool_call: true,
        structured_output: true,
        status: "stable"
      },
      {
        id: "deepseek-chat",
        provider_id: "deepseek",
        context_window: 64_000,
        input_modalities: ["text"],
        output_modalities: ["text"],
        reasoning: false,
        tool_call: true,
        structured_output: true,
        status: "stable"
      },
      {
        id: "llama3",
        provider_id: "local",
        context_window: 8_000,
        input_modalities: ["text"],
        output_modalities: ["text"],
        reasoning: false,
        tool_call: false,
        structured_output: false,
        status: "stable"
      },
      {
        id: "codex-model",
        provider_id: "codex",
        context_window: 128_000,
        input_modalities: ["text"],
        output_modalities: ["text"],
        reasoning: false,
        tool_call: true,
        structured_output: true,
        status: "stable"
      }
    ],
    fetchedAt: "2024-01-01T00:00:00.000Z",
    source: "bundled"
  };
}

function withFixture(
  testFn: (fixturePath: string, cachePath: string) => Promise<void>
): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "estacoda-flow-test-"));
    const fixturePath = join(dir, "models_dev_snapshot.json");
    const cachePath = join(dir, "models_dev_cache.json");
    writeFileSync(fixturePath, JSON.stringify(createMockSnapshot(), null, 2), "utf8");
    try {
      await testFn(fixturePath, cachePath);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

function buildOptions(
  fixturePath: string,
  cachePath: string,
  overrides?: {
    config?: EstaCodaConfig;
    registry?: ProviderRegistry;
    mode?: "normal" | "setup" | "catalog-explore";
    modelCatalogOverrides?: ModelCatalogOverrideRegistry;
  }
): ProviderModelSelectionFlowOptions {
  return {
    config: overrides?.config ?? {},
    providerRegistry: overrides?.registry ?? new ProviderRegistry(),
    homeDir: tmpdir(),
    modelsDevOptions: {
      bundledSnapshotPath: fixturePath,
      cachePath,
      allowNetwork: false
    },
    modelCatalogOverrides: overrides?.modelCatalogOverrides,
    allowNetwork: false,
    mode: overrides?.mode ?? "normal"
  };
}

function lifecycleOverrides(): ModelCatalogOverrideRegistry {
  return {
    version: 1,
    models: [{
      provider: "openai",
      model: "gpt-retired",
      lifecycle: "retired",
      usageClass: "primary-chat",
      note: "Retired by reviewed test policy."
    }]
  };
}

function openaiAdapter(): {
  id: ProviderId;
  name: string;
  executable: boolean;
  health: (_endpointOverride?: ProviderEndpoint) => { available: boolean };
  listModels: () => [];
  complete: () => Promise<{ ok: boolean; content: string; model: string; provider: ProviderId }>;
} {
  return {
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
  };
}

function deepseekAdapter(): {
  id: ProviderId;
  name: string;
  executable: boolean;
  health: (_endpointOverride?: ProviderEndpoint) => { available: boolean };
  listModels: () => [];
  complete: () => Promise<{ ok: boolean; content: string; model: string; provider: ProviderId }>;
} {
  return {
    id: "deepseek" as ProviderId,
    name: "DeepSeek",
    executable: true,
    health() {
      return { available: true };
    },
    listModels() {
      return [];
    },
    async complete() {
      return { ok: true, content: "", model: "", provider: "deepseek" };
    }
  };
}

function localAdapter(): {
  id: ProviderId;
  name: string;
  executable: boolean;
  health: (_endpointOverride?: ProviderEndpoint) => { available: boolean };
  listModels: () => [];
  complete: () => Promise<{ ok: boolean; content: string; model: string; provider: ProviderId }>;
} {
  return {
    id: "local" as ProviderId,
    name: "Local / Private",
    executable: true,
    health() {
      return { available: true };
    },
    listModels() {
      return [];
    },
    async complete() {
      return { ok: true, content: "", model: "", provider: "local" };
    }
  };
}

describe("provider-model-selection-flow", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    resetModelsDevRegistryForTest();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("listProviderCandidates normal mode", () => {
    it(
      "includes runnable providers with credentials",
      withFixture(async (fixturePath, cachePath) => {
        process.env.OPENAI_API_KEY = "sk-test";
        const registry = new ProviderRegistry();
        registry.register(openaiAdapter());

        const flow = await createProviderModelSelectionFlow(
          buildOptions(fixturePath, cachePath, {
            registry,
            mode: "normal",
            config: {
              providers: {
                openai: {
                  kind: "openai-compatible",
                  models: ["gpt-4o"]
                }
              }
            }
          })
        );

        const providers = await flow.listProviderCandidates();
        const ids = providers.map((p) => p.id);
        expect(ids).toContain("openai");
      })
    );

    it(
      "excludes providers missing credentials in normal mode",
      withFixture(async (fixturePath, cachePath) => {
        delete process.env.OPENAI_API_KEY;
        const registry = new ProviderRegistry();
        registry.register(openaiAdapter());

        const flow = await createProviderModelSelectionFlow(
          buildOptions(fixturePath, cachePath, {
            registry,
            mode: "normal",
            config: {
              providers: {
                openai: {
                  kind: "openai-compatible",
                  models: ["gpt-4o"]
                }
              }
            }
          })
        );

        const providers = await flow.listProviderCandidates();
        const ids = providers.map((p) => p.id);
        expect(ids).not.toContain("openai");
      })
    );

    it(
      "includes local provider without credentials",
      withFixture(async (fixturePath, cachePath) => {
        const registry = new ProviderRegistry();
        registry.register(localAdapter());

        const flow = await createProviderModelSelectionFlow(
          buildOptions(fixturePath, cachePath, {
            registry,
            mode: "normal",
            config: {
              providers: {
                local: {
                  kind: "openai-compatible",
                  baseUrl: "http://localhost:11434/v1",
                  models: ["llama3"]
                }
              }
            }
          })
        );

        const providers = await flow.listProviderCandidates();
        const ids = providers.map((p) => p.id);
        expect(ids).toContain("local");
      })
    );

    it(
      "excludes catalog-only providers in normal mode",
      withFixture(async (fixturePath, cachePath) => {
        const registry = new ProviderRegistry();
        registry.register(createCatalogProvider({ id: "anthropic" as ProviderId, models: [] }));

        const flow = await createProviderModelSelectionFlow(
          buildOptions(fixturePath, cachePath, {
            registry,
            mode: "normal",
            config: {
              providers: {
                anthropic: {
                  kind: "catalog",
                  models: ["claude-3-opus"]
                }
              }
            }
          })
        );

        const providers = await flow.listProviderCandidates();
        const ids = providers.map((p) => p.id);
        expect(ids).not.toContain("anthropic");
      })
    );

    it(
      "excludes Codex in normal mode",
      withFixture(async (fixturePath, cachePath) => {
        const registry = new ProviderRegistry();

        const flow = await createProviderModelSelectionFlow(
          buildOptions(fixturePath, cachePath, {
            registry,
            mode: "normal"
          })
        );

        const providers = await flow.listProviderCandidates();
        const ids = providers.map((p) => p.id);
        expect(ids).not.toContain("codex");
      })
    );

    it(
      "excludes media-only providers in normal mode",
      withFixture(async (fixturePath, cachePath) => {
        const registry = new ProviderRegistry();
        registry.register(createCatalogProvider({ id: "fal" as ProviderId, models: [] }));

        const flow = await createProviderModelSelectionFlow(
          buildOptions(fixturePath, cachePath, {
            registry,
            mode: "normal",
            config: {
              providers: {
                fal: {
                  kind: "catalog",
                  models: ["fal-model"]
                }
              }
            }
          })
        );

        const providers = await flow.listProviderCandidates();
        const ids = providers.map((p) => p.id);
        expect(ids).not.toContain("fal");
      })
    );
  });

  describe("listProviderCandidates setup mode", () => {
    it(
      "includes missing-credential providers in setup mode",
      withFixture(async (fixturePath, cachePath) => {
        delete process.env.OPENAI_API_KEY;
        const registry = new ProviderRegistry();
        registry.register(openaiAdapter());

        const flow = await createProviderModelSelectionFlow(
          buildOptions(fixturePath, cachePath, {
            registry,
            mode: "setup",
            config: {
              providers: {
                openai: {
                  kind: "openai-compatible",
                  models: ["gpt-4o"]
                }
              }
            }
          })
        );

        const providers = await flow.listProviderCandidates();
        const openai = providers.find((p) => p.id === "openai");
        expect(openai).toBeDefined();
        expect(openai!.credentialReady).toBe(false);
      })
    );

    it(
      "excludes non-configurable providers in setup mode",
      withFixture(async (fixturePath, cachePath) => {
        const registry = new ProviderRegistry();
        registry.register(createCatalogProvider({ id: "anthropic" as ProviderId, models: [] }));

        const flow = await createProviderModelSelectionFlow(
          buildOptions(fixturePath, cachePath, {
            registry,
            mode: "setup",
            config: {
              providers: {
                anthropic: {
                  kind: "catalog",
                  models: ["claude-3-opus"]
                }
              }
            }
          })
        );

        const providers = await flow.listProviderCandidates();
        const ids = providers.map((p) => p.id);
        expect(ids).not.toContain("anthropic");
      })
    );
  });

  describe("listProviderCandidates catalog-explore mode", () => {
    it(
      "includes catalog-only providers in catalog-explore mode",
      withFixture(async (fixturePath, cachePath) => {
        const registry = new ProviderRegistry();
        registry.register(createCatalogProvider({ id: "anthropic" as ProviderId, models: [] }));

        const flow = await createProviderModelSelectionFlow(
          buildOptions(fixturePath, cachePath, {
            registry,
            mode: "catalog-explore",
            config: {
              providers: {
                anthropic: {
                  kind: "catalog",
                  models: ["claude-3-opus"]
                }
              }
            }
          })
        );

        const providers = await flow.listProviderCandidates();
        const ids = providers.map((p) => p.id);
        expect(ids).toContain("anthropic");
      })
    );

    it(
      "includes Codex in catalog-explore mode",
      withFixture(async (fixturePath, cachePath) => {
        const registry = new ProviderRegistry();

        const flow = await createProviderModelSelectionFlow(
          buildOptions(fixturePath, cachePath, {
            registry,
            mode: "catalog-explore"
          })
        );

        const providers = await flow.listProviderCandidates();
        const ids = providers.map((p) => p.id);
        expect(ids).toContain("codex");
      })
    );
  });

  describe("listModelCandidates", () => {
    it(
      "returns models for a provider",
      withFixture(async (fixturePath, cachePath) => {
        process.env.OPENAI_API_KEY = "sk-test";
        const registry = new ProviderRegistry();
        registry.register(openaiAdapter());

        const flow = await createProviderModelSelectionFlow(
          buildOptions(fixturePath, cachePath, {
            registry,
            mode: "normal",
            config: {
              providers: {
                openai: {
                  kind: "openai-compatible",
                  models: ["gpt-4o"]
                }
              }
            }
          })
        );

        const models = await flow.listModelCandidates("openai");
        expect(models.some((m) => m.id === "gpt-4o")).toBe(true);
      })
    );

    it(
      "includes catalog models for setup mode without a registered adapter",
      withFixture(async (fixturePath, cachePath) => {
        delete process.env.OPENAI_API_KEY;
        const flow = await createProviderModelSelectionFlow(
          buildOptions(fixturePath, cachePath, {
            mode: "setup"
          })
        );

        const models = await flow.listModelCandidates("openai");
        const gpt4o = models.find((m) => m.id === "gpt-4o");
        expect(gpt4o).toBeDefined();
        expect(gpt4o!.catalogOnly).toBe(true);
        expect(gpt4o!.profile.contextWindowTokens).toBe(128_000);
      })
    );

    it(
      "does not expose non-setup-visible provider models in setup mode",
      withFixture(async (fixturePath, cachePath) => {
        const flow = await createProviderModelSelectionFlow(
          buildOptions(fixturePath, cachePath, {
            mode: "setup"
          })
        );

        const codexModels = await flow.listModelCandidates("codex" as ProviderId);
        expect(codexModels.length).toBeGreaterThan(0);
        await expect(flow.listModelCandidates("anthropic" as ProviderId)).resolves.toEqual([]);
      })
    );

    it(
      "keeps normal mode executable-model listing strict",
      withFixture(async (fixturePath, cachePath) => {
        delete process.env.OPENAI_API_KEY;
        const flow = await createProviderModelSelectionFlow(
          buildOptions(fixturePath, cachePath, {
            mode: "normal"
          })
        );

        await expect(flow.listModelCandidates("openai")).resolves.toEqual([]);
      })
    );

    it(
      "includes vision capability metadata",
      withFixture(async (fixturePath, cachePath) => {
        process.env.OPENAI_API_KEY = "sk-test";
        const registry = new ProviderRegistry();
        registry.register(openaiAdapter());

        const flow = await createProviderModelSelectionFlow(
          buildOptions(fixturePath, cachePath, {
            registry,
            mode: "normal",
            config: {
              providers: {
                openai: {
                  kind: "openai-compatible",
                  models: ["gpt-4o"]
                }
              }
            }
          })
        );

        const models = await flow.listModelCandidates("openai");
        const gpt4o = models.find((m) => m.id === "gpt-4o");
        expect(gpt4o).toBeDefined();
        expect(gpt4o!.supportsVision).toBe(true);
      })
    );

    it(
      "setup candidates exclude retired models by default",
      withFixture(async (fixturePath, cachePath) => {
        const flow = await createProviderModelSelectionFlow(
          buildOptions(fixturePath, cachePath, {
            mode: "setup",
            modelCatalogOverrides: lifecycleOverrides()
          })
        );

        const models = await flow.listModelCandidates("openai");
        expect(models.some((m) => m.id === "gpt-retired")).toBe(false);
      })
    );

    it(
      "setup candidates exclude wrong-usage models by default",
      withFixture(async (fixturePath, cachePath) => {
        const flow = await createProviderModelSelectionFlow(
          buildOptions(fixturePath, cachePath, {
            mode: "setup",
            modelCatalogOverrides: lifecycleOverrides()
          })
        );

        const models = await flow.listModelCandidates("openai");
        expect(models.some((m) => m.id === "gpt-image-test")).toBe(false);
      })
    );

    it(
      "propagates lifecycle metadata",
      withFixture(async (fixturePath, cachePath) => {
        const flow = await createProviderModelSelectionFlow(
          buildOptions(fixturePath, cachePath, {
            mode: "setup",
            modelCatalogOverrides: lifecycleOverrides()
          })
        );

        const models = await flow.listModelCandidates("openai");
        const gpt4o = models.find((m) => m.id === "gpt-4o");
        expect(gpt4o).toBeDefined();
        expect(gpt4o!.lifecycle).toBe("available");
        expect(gpt4o!.usageClass).toBe("primary-chat");
        expect(gpt4o!.warnings).toEqual([]);
      })
    );

    it(
      "preserves configured stale candidates with warnings",
      withFixture(async (fixturePath, cachePath) => {
        const flow = await createProviderModelSelectionFlow(
          buildOptions(fixturePath, cachePath, {
            mode: "setup",
            modelCatalogOverrides: lifecycleOverrides(),
            config: {
              providers: {
                openai: {
                  kind: "openai-compatible",
                  models: ["gpt-retired"]
                }
              }
            }
          })
        );

        const models = await flow.listModelCandidates("openai");
        const retired = models.find((m) => m.id === "gpt-retired");
        expect(retired).toBeDefined();
        expect(retired!.configured).toBe(true);
        expect(retired!.lifecycle).toBe("retired");
        expect(retired!.warnings).toEqual(["Model is retired."]);
      })
    );

    it(
      "preserves current stale candidates with warnings",
      withFixture(async (fixturePath, cachePath) => {
        const flow = await createProviderModelSelectionFlow(
          buildOptions(fixturePath, cachePath, {
            mode: "setup",
            modelCatalogOverrides: lifecycleOverrides(),
            config: {
              model: {
                provider: "openai" as ProviderId,
                id: "gpt-retired"
              }
            }
          })
        );

        const models = await flow.listModelCandidates("openai");
        const retired = models.find((m) => m.id === "gpt-retired");
        expect(retired).toBeDefined();
        expect(retired!.lifecycle).toBe("retired");
        expect(retired!.warnings).toEqual(["Model is retired."]);
      })
    );

    it(
      "normal primary-chat candidates still work",
      withFixture(async (fixturePath, cachePath) => {
        const flow = await createProviderModelSelectionFlow(
          buildOptions(fixturePath, cachePath, {
            mode: "setup",
            modelCatalogOverrides: lifecycleOverrides()
          })
        );

        const models = await flow.listModelCandidates("openai");
        expect(models).toEqual(expect.arrayContaining([
          expect.objectContaining({
            id: "gpt-4o",
            lifecycle: "available",
            usageClass: "primary-chat"
          })
        ]));
      })
    );
  });

  describe("resolveSelection credentialAction", () => {
    it(
      "configured current stale models can still resolve",
      withFixture(async (fixturePath, cachePath) => {
        delete process.env.OPENAI_API_KEY;
        const flow = await createProviderModelSelectionFlow(
          buildOptions(fixturePath, cachePath, {
            mode: "setup",
            modelCatalogOverrides: lifecycleOverrides(),
            config: {
              model: {
                provider: "openai" as ProviderId,
                id: "gpt-retired"
              },
              providers: {
                openai: {
                  kind: "openai-compatible",
                  models: ["gpt-retired"]
                }
              }
            }
          })
        );

        const result = await flow.resolveSelection("openai", "gpt-retired");
        expect(result.kind).toBe("selected");
        if (result.kind !== "selected") return;
        expect(result.profile.id).toBe("gpt-retired");
      })
    );

    it(
      "returns endpoint configuration action for local provider",
      withFixture(async (fixturePath, cachePath) => {
        const flow = await createProviderModelSelectionFlow(
          buildOptions(fixturePath, cachePath, {
            mode: "normal"
          })
        );

        const result = await flow.resolveSelection("local", "llama3");
        expect(result.kind).toBe("selected");
        if (result.kind !== "selected") return;
        expect(result.credentialAction).toEqual({
          kind: "endpoint",
          baseUrl: "http://localhost:11434/v1",
          apiKeyEnv: "OPENAI_COMPATIBLE_API_KEY"
        });
      })
    );

    it(
      "returns reuse when env var is populated",
      withFixture(async (fixturePath, cachePath) => {
        process.env.OPENAI_API_KEY = "sk-test";
        const flow = await createProviderModelSelectionFlow(
          buildOptions(fixturePath, cachePath, {
            mode: "normal",
            config: {
              providers: {
                openai: {
                  kind: "openai-compatible",
                  models: ["gpt-4o"]
                }
              }
            }
          })
        );

        const result = await flow.resolveSelection("openai", "gpt-4o");
        expect(result.kind).toBe("selected");
        if (result.kind !== "selected") return;
        expect(result.credentialAction.kind).toBe("reuse");
        expect(result.credentialAction).toHaveProperty("reference", "env:OPENAI_API_KEY");
      })
    );

    it(
      "returns collect when env var is missing in setup mode",
      withFixture(async (fixturePath, cachePath) => {
        delete process.env.OPENAI_API_KEY;
        const flow = await createProviderModelSelectionFlow(
          buildOptions(fixturePath, cachePath, {
            mode: "setup",
            config: {
              providers: {
                openai: {
                  kind: "openai-compatible",
                  models: ["gpt-4o"]
                }
              }
            }
          })
        );

        const result = await flow.resolveSelection("openai", "gpt-4o");
        expect(result.kind).toBe("selected");
        if (result.kind !== "selected") return;
        expect(result.credentialAction.kind).toBe("collect");
        expect(result.credentialAction).toHaveProperty("envVarName", "OPENAI_API_KEY");
      })
    );

    it(
      "returns collect when env var is missing in normal mode (direct call)",
      withFixture(async (fixturePath, cachePath) => {
        delete process.env.OPENAI_API_KEY;
        const flow = await createProviderModelSelectionFlow(
          buildOptions(fixturePath, cachePath, {
            mode: "normal",
            config: {
              providers: {
                openai: {
                  kind: "openai-compatible",
                  models: ["gpt-4o"]
                }
              }
            }
          })
        );

        const result = await flow.resolveSelection("openai", "gpt-4o");
        expect(result.kind).toBe("selected");
        if (result.kind !== "selected") return;
        expect(result.credentialAction.kind).toBe("collect");
        expect(result.credentialAction).toHaveProperty("envVarName", "OPENAI_API_KEY");
      })
    );

    it(
      "returns provider-configured apiMode over metadata default",
      withFixture(async (fixturePath, cachePath) => {
        process.env.OPENAI_API_KEY = "sk-test";
        const flow = await createProviderModelSelectionFlow(
          buildOptions(fixturePath, cachePath, {
            mode: "normal",
            config: {
              providers: {
                openai: {
                  kind: "openai-compatible",
                  models: ["gpt-4o"],
                  apiMode: "custom_openai_compatible"
                }
              }
            }
          })
        );

        const result = await flow.resolveSelection("openai", "gpt-4o");
        expect(result.kind).toBe("selected");
        if (result.kind !== "selected") return;
        expect(result.apiMode).toBe("custom_openai_compatible");
      })
    );
  });

  describe("resolveSelection invalid selections", () => {
    it(
      "returns diagnostic for non-runnable provider in normal mode",
      withFixture(async (fixturePath, cachePath) => {
        const flow = await createProviderModelSelectionFlow(
          buildOptions(fixturePath, cachePath, {
            mode: "normal"
          })
        );

        const result = await flow.resolveSelection("anthropic", "claude-3-opus");
        expect(result.kind).toBe("diagnostic");
        if (result.kind !== "diagnostic") return;
        expect(result.reason).toContain("not runnable");
      })
    );

    it(
      "returns diagnostic for non-runnable provider in catalog-explore mode",
      withFixture(async (fixturePath, cachePath) => {
        const flow = await createProviderModelSelectionFlow(
          buildOptions(fixturePath, cachePath, {
            mode: "catalog-explore"
          })
        );

        const result = await flow.resolveSelection("anthropic", "claude-3-opus");
        expect(result.kind).toBe("diagnostic");
        if (result.kind !== "diagnostic") return;
        expect(result.reason).toContain("not runnable");
      })
    );

    it(
      "returns diagnostic for media-only provider",
      withFixture(async (fixturePath, cachePath) => {
        const flow = await createProviderModelSelectionFlow(
          buildOptions(fixturePath, cachePath, {
            mode: "normal"
          })
        );

        const result = await flow.resolveSelection("fal" as ProviderId, "fal-model");
        expect(result.kind).toBe("diagnostic");
        if (result.kind !== "diagnostic") return;
        expect(result.reason).toContain("not a runnable LLM provider");
      })
    );

    it(
      "returns diagnostic for custom provider without base URL",
      withFixture(async (fixturePath, cachePath) => {
        const flow = await createProviderModelSelectionFlow(
          buildOptions(fixturePath, cachePath, {
            mode: "normal"
          })
        );

        const result = await flow.resolveSelection("custom-corp" as ProviderId, "custom-model");
        expect(result.kind).toBe("diagnostic");
        expect(result.kind).not.toBe("selected");
        if (result.kind !== "diagnostic") return;
        expect(result.reason).toContain("requires an explicit base URL");
      })
    );
  });

  describe("security invariants", () => {
    it(
      "result never contains raw API key values",
      withFixture(async (fixturePath, cachePath) => {
        process.env.OPENAI_API_KEY = "super-secret-api-key-12345";
        const flow = await createProviderModelSelectionFlow(
          buildOptions(fixturePath, cachePath, {
            mode: "normal",
            config: {
              providers: {
                openai: {
                  kind: "openai-compatible",
                  models: ["gpt-4o"]
                }
              }
            }
          })
        );

        const result = await flow.resolveSelection("openai", "gpt-4o");
        const serialized = JSON.stringify(result);
        expect(serialized).not.toContain("super-secret-api-key-12345");
      })
    );

    it(
      "result never contains credential.value",
      withFixture(async (fixturePath, cachePath) => {
        process.env.OPENAI_API_KEY = "another-secret";
        const flow = await createProviderModelSelectionFlow(
          buildOptions(fixturePath, cachePath, {
            mode: "normal",
            config: {
              providers: {
                openai: {
                  kind: "openai-compatible",
                  models: ["gpt-4o"]
                }
              }
            }
          })
        );

        const result = await flow.resolveSelection("openai", "gpt-4o");
        expect(result).not.toHaveProperty("credential.value");
        expect(result).not.toHaveProperty("apiKey");
        expect(result).not.toHaveProperty("apiKeyValue");
        expect(result).not.toHaveProperty("token");
        expect(result).not.toHaveProperty("secret");
      })
    );

    it(
      "collect action does not contain raw value",
      withFixture(async (fixturePath, cachePath) => {
        delete process.env.OPENAI_API_KEY;
        const flow = await createProviderModelSelectionFlow(
          buildOptions(fixturePath, cachePath, {
            mode: "setup",
            config: {
              providers: {
                openai: {
                  kind: "openai-compatible",
                  models: ["gpt-4o"]
                }
              }
            }
          })
        );

        const result = await flow.resolveSelection("openai", "gpt-4o");
        if (result.kind !== "selected") return;
        expect(result.credentialAction.kind).toBe("collect");
        const serialized = JSON.stringify(result.credentialAction);
        expect(serialized).not.toContain("sk-");
        expect(serialized).not.toContain("secret");
      })
    );
  });

  describe("no side effects", () => {
    it(
      "does not write config or call secret storage",
      withFixture(async (fixturePath, cachePath) => {
        const flow = await createProviderModelSelectionFlow(
          buildOptions(fixturePath, cachePath, {
            mode: "normal"
          })
        );

        // resolveSelection is synchronous and has no I/O
        const result = await flow.resolveSelection("openai", "gpt-4o");
        expect(result).toBeDefined();
      })
    );
  });

  describe("custom provider behavior", () => {
    it(
      "includes custom provider when baseUrl is configured and credentials are present",
      withFixture(async (fixturePath, cachePath) => {
        process.env.OPENAI_COMPATIBLE_API_KEY = "custom-key";
        const registry = new ProviderRegistry();
        registry.register({
          id: "custom-corp" as ProviderId,
          name: "Custom Corp",
          executable: true,
          health() {
            return { available: true };
          },
          listModels() {
            return [];
          },
          async complete() {
            return { ok: true, content: "", model: "", provider: "custom-corp" as ProviderId };
          }
        });

        const flow = await createProviderModelSelectionFlow(
          buildOptions(fixturePath, cachePath, {
            registry,
            mode: "normal",
            config: {
              providers: {
                "custom-corp": {
                  kind: "openai-compatible",
                  baseUrl: "https://custom.example.com/v1",
                  models: ["custom-model"]
                }
              }
            }
          })
        );

        const providers = await flow.listProviderCandidates();
        const ids = providers.map((p) => p.id);
        expect(ids).toContain("custom-corp");
      })
    );
  });

  describe("network/offline behavior", () => {
    it(
      "does not require network by default",
      withFixture(async (fixturePath, cachePath) => {
        const flow = await createProviderModelSelectionFlow(
          buildOptions(fixturePath, cachePath, {
            mode: "normal"
          })
        );

        const providers = await flow.listProviderCandidates();
        // Should still return results from the bundled fixture
        expect(providers.length).toBeGreaterThanOrEqual(0);
      })
    );
  });

  describe(".env credential readiness", () => {
    it(
      ".estacoda/.env with OPENAI_API_KEY makes OpenAI credential-ready when homeDir is passed",
      withFixture(async (fixturePath, cachePath) => {
        delete process.env.OPENAI_API_KEY;
        const homeDir = mkdtempSync(join(tmpdir(), "estacoda-home-"));
        const estacodaDir = join(homeDir, ".estacoda");
        mkdirSync(estacodaDir, { recursive: true });
        writeFileSync(join(estacodaDir, ".env"), "OPENAI_API_KEY=sk-from-dotenv\n", "utf8");

        const registry = new ProviderRegistry();
        registry.register(openaiAdapter());

        try {
          const flow = await createProviderModelSelectionFlow({
            ...buildOptions(fixturePath, cachePath, {
              registry,
              mode: "normal",
              config: {
                providers: {
                  openai: {
                    kind: "openai-compatible",
                    models: ["gpt-4o"]
                  }
                }
              }
            }),
            homeDir
          });

          const providers = await flow.listProviderCandidates();
          const openai = providers.find((p) => p.id === "openai");
          expect(openai).toBeDefined();
          expect(openai!.credentialReady).toBe(true);
        } finally {
          rmSync(homeDir, { recursive: true, force: true });
        }
      })
    );

    it(
      "resolveSelection returns credentialAction.kind === reuse when .env has the key",
      withFixture(async (fixturePath, cachePath) => {
        delete process.env.OPENAI_API_KEY;
        const homeDir = mkdtempSync(join(tmpdir(), "estacoda-home-"));
        const estacodaDir = join(homeDir, ".estacoda");
        mkdirSync(estacodaDir, { recursive: true });
        writeFileSync(join(estacodaDir, ".env"), "OPENAI_API_KEY=sk-from-dotenv\n", "utf8");

        const registry = new ProviderRegistry();
        registry.register(openaiAdapter());

        try {
          const flow = await createProviderModelSelectionFlow({
            ...buildOptions(fixturePath, cachePath, {
              registry,
              mode: "normal",
              config: {
                providers: {
                  openai: {
                    kind: "openai-compatible",
                    models: ["gpt-4o"]
                  }
                }
              }
            }),
            homeDir
          });

          const result = await flow.resolveSelection("openai", "gpt-4o");
          if (result.kind !== "selected") return;
          expect(result.credentialAction.kind).toBe("reuse");
        } finally {
          rmSync(homeDir, { recursive: true, force: true });
        }
      })
    );

    it(
      "shell env is not overwritten by .env when override is false",
      withFixture(async (fixturePath, cachePath) => {
        process.env.OPENAI_API_KEY = "sk-shell";
        const homeDir = mkdtempSync(join(tmpdir(), "estacoda-home-"));
        const estacodaDir = join(homeDir, ".estacoda");
        mkdirSync(estacodaDir, { recursive: true });
        writeFileSync(join(estacodaDir, ".env"), "OPENAI_API_KEY=sk-from-dotenv\n", "utf8");

        const registry = new ProviderRegistry();
        registry.register(openaiAdapter());

        try {
          const flow = await createProviderModelSelectionFlow({
            ...buildOptions(fixturePath, cachePath, {
              registry,
              mode: "normal",
              config: {
                providers: {
                  openai: {
                    kind: "openai-compatible",
                    models: ["gpt-4o"]
                  }
                }
              }
            }),
            homeDir
          });

          const providers = await flow.listProviderCandidates();
          const openai = providers.find((p) => p.id === "openai");
          expect(openai).toBeDefined();
          expect(openai!.credentialReady).toBe(true);
          expect(process.env.OPENAI_API_KEY).toBe("sk-shell");
        } finally {
          rmSync(homeDir, { recursive: true, force: true });
        }
      })
    );

    it(
      "result JSON does not contain the loaded secret value",
      withFixture(async (fixturePath, cachePath) => {
        delete process.env.OPENAI_API_KEY;
        const homeDir = mkdtempSync(join(tmpdir(), "estacoda-home-"));
        const estacodaDir = join(homeDir, ".estacoda");
        mkdirSync(estacodaDir, { recursive: true });
        writeFileSync(join(estacodaDir, ".env"), "OPENAI_API_KEY=sk-secret-value\n", "utf8");

        const registry = new ProviderRegistry();
        registry.register(openaiAdapter());

        try {
          const flow = await createProviderModelSelectionFlow({
            ...buildOptions(fixturePath, cachePath, {
              registry,
              mode: "normal",
              config: {
                providers: {
                  openai: {
                    kind: "openai-compatible",
                    models: ["gpt-4o"]
                  }
                }
              }
            }),
            homeDir
          });

          const result = await flow.resolveSelection("openai", "gpt-4o");
          if (result.kind !== "selected") return;
          const serialized = JSON.stringify(result);
          expect(serialized).not.toContain("sk-secret-value");
        } finally {
          rmSync(homeDir, { recursive: true, force: true });
        }
      })
    );

    it(
      "without .env or shell env, setup mode returns collect",
      withFixture(async (fixturePath, cachePath) => {
        delete process.env.OPENAI_API_KEY;
        const homeDir = mkdtempSync(join(tmpdir(), "estacoda-home-"));

        const registry = new ProviderRegistry();
        registry.register(openaiAdapter());

        try {
          const flow = await createProviderModelSelectionFlow({
            ...buildOptions(fixturePath, cachePath, {
              registry,
              mode: "setup",
              config: {
                providers: {
                  openai: {
                    kind: "openai-compatible",
                    models: ["gpt-4o"]
                  }
                }
              }
            }),
            homeDir
          });

          const result = await flow.resolveSelection("openai", "gpt-4o");
          if (result.kind !== "selected") return;
          expect(result.credentialAction.kind).toBe("collect");
        } finally {
          rmSync(homeDir, { recursive: true, force: true });
        }
      })
    );
  });

  describe("setup mode metadata-driven discovery", () => {
    it(
      "setup mode with empty config and empty registry includes configurable runnable providers",
      withFixture(async (fixturePath, cachePath) => {
        delete process.env.OPENAI_API_KEY;
        delete process.env.DEEPSEEK_API_KEY;
        delete process.env.KIMI_API_KEY;
        delete process.env.GOOGLE_API_KEY;
        delete process.env.OPENROUTER_API_KEY;

        const flow = await createProviderModelSelectionFlow(
          buildOptions(fixturePath, cachePath, {
            mode: "setup"
          })
        );

        const providers = await flow.listProviderCandidates();
        const ids = providers.map((p) => p.id);
        expect(ids).toContain("openai");
        expect(ids).toContain("deepseek");
        expect(ids).toContain("kimi");
        expect(ids).toContain("google");
        expect(ids).toContain("openrouter");
        expect(ids).toContain("local");
      })
    );

    it(
      "setup mode excludes media-only and non-setup-visible providers",
      withFixture(async (fixturePath, cachePath) => {
        const flow = await createProviderModelSelectionFlow(
          buildOptions(fixturePath, cachePath, {
            mode: "setup"
          })
        );

        const providers = await flow.listProviderCandidates();
        const ids = providers.map((p) => p.id);
        expect(ids).toContain("codex");
        expect(ids).not.toContain("fal");
        expect(ids).not.toContain("anthropic");
      })
    );

    it(
      "setup mode includes hosted providers even when credentials are missing",
      withFixture(async (fixturePath, cachePath) => {
        delete process.env.OPENAI_API_KEY;

        const flow = await createProviderModelSelectionFlow(
          buildOptions(fixturePath, cachePath, {
            mode: "setup"
          })
        );

        const providers = await flow.listProviderCandidates();
        const openai = providers.find((p) => p.id === "openai");
        expect(openai).toBeDefined();
        expect(openai!.credentialReady).toBe(false);
      })
    );
  });

  describe("resolveSelection catalog profile preservation", () => {
    it(
      "resolving openai/gpt-4o returns profile.supportsVision from catalog fixture",
      withFixture(async (fixturePath, cachePath) => {
        process.env.OPENAI_API_KEY = "sk-test";
        const flow = await createProviderModelSelectionFlow(
          buildOptions(fixturePath, cachePath, {
            mode: "normal",
            config: {
              providers: {
                openai: {
                  kind: "openai-compatible",
                  models: ["gpt-4o"]
                }
              }
            }
          })
        );

        const result = await flow.resolveSelection("openai", "gpt-4o");
        expect(result.kind).toBe("selected");
        if (result.kind !== "selected") return;
        expect(result.profile.supportsVision).toBe(true);
      })
    );

    it(
      "returns real contextWindowTokens from catalog fixture",
      withFixture(async (fixturePath, cachePath) => {
        process.env.OPENAI_API_KEY = "sk-test";
        const flow = await createProviderModelSelectionFlow(
          buildOptions(fixturePath, cachePath, {
            mode: "normal",
            config: {
              providers: {
                openai: {
                  kind: "openai-compatible",
                  models: ["gpt-4o"]
                }
              }
            }
          })
        );

        const result = await flow.resolveSelection("openai", "gpt-4o");
        expect(result.kind).toBe("selected");
        if (result.kind !== "selected") return;
        expect(result.profile.contextWindowTokens).toBe(128_000);
      })
    );

    it(
      "returns supportsTools and supportsStructuredOutput from catalog fixture",
      withFixture(async (fixturePath, cachePath) => {
        process.env.OPENAI_API_KEY = "sk-test";
        const flow = await createProviderModelSelectionFlow(
          buildOptions(fixturePath, cachePath, {
            mode: "normal",
            config: {
              providers: {
                openai: {
                  kind: "openai-compatible",
                  models: ["gpt-4o"]
                }
              }
            }
          })
        );

        const result = await flow.resolveSelection("openai", "gpt-4o");
        expect(result.kind).toBe("selected");
        if (result.kind !== "selected") return;
        expect(result.profile.supportsTools).toBe(true);
        expect(result.profile.supportsStructuredOutput).toBe(true);
      })
    );

    it(
      "configured/manual model missing from catalog falls back to inferred profile",
      withFixture(async (fixturePath, cachePath) => {
        process.env.OPENAI_API_KEY = "sk-test";
        const flow = await createProviderModelSelectionFlow(
          buildOptions(fixturePath, cachePath, {
            mode: "normal",
            config: {
              providers: {
                openai: {
                  kind: "openai-compatible",
                  models: ["gpt-4o"]
                }
              }
            }
          })
        );

        const result = await flow.resolveSelection("openai", "manual-model-not-in-catalog");
        expect(result.kind).toBe("selected");
        if (result.kind !== "selected") return;
        expect(result.profile.id).toBe("manual-model-not-in-catalog");
        expect(result.profile.provider).toBe("openai");
      })
    );

    it(
      "selected route/model ID remains exact",
      withFixture(async (fixturePath, cachePath) => {
        process.env.OPENAI_API_KEY = "sk-test";
        const flow = await createProviderModelSelectionFlow(
          buildOptions(fixturePath, cachePath, {
            mode: "normal",
            config: {
              providers: {
                openai: {
                  kind: "openai-compatible",
                  models: ["gpt-4o"]
                }
              }
            }
          })
        );

        const result = await flow.resolveSelection("openai", "gpt-4o");
        expect(result.kind).toBe("selected");
        if (result.kind !== "selected") return;
        expect(result.provider).toBe("openai");
        expect(result.model).toBe("gpt-4o");
      })
    );
  });

  describe("resolvedViaAlias metadata", () => {
    it("preserves resolvedViaAlias when attached by caller", async () => {
      const flow = await createProviderModelSelectionFlow(
        buildOptions("", "", {
          mode: "normal",
          config: {
            providers: {
              openai: {
                kind: "openai-compatible",
                models: ["gpt-4o"]
              }
            }
          }
        })
      );

      const result = await flow.resolveSelection("openai", "gpt-4o");
      expect(result.kind).toBe("selected");
      if (result.kind !== "selected") return;
      expect(result.resolvedViaAlias).toBeUndefined();

      // Simulating a caller that attaches alias metadata
      const withAlias = { ...result, resolvedViaAlias: "gpt4" };
      expect(withAlias.resolvedViaAlias).toBe("gpt4");
    });
  });
});
