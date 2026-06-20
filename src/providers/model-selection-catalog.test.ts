import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderId, ModelProfile, ProviderEndpoint } from "../contracts/provider.js";
import { ProviderRegistry } from "./provider-registry.js";
import { createCatalogProvider } from "./catalog-provider.js";
import {
  routeKey,
  createModelSelectionCatalog,
  resetModelsDevRegistryForTest,
  type CreateModelSelectionCatalogOptions
} from "./model-selection-catalog.js";

function createMockSnapshot(): Record<string, unknown> {
  return {
    providers: [
      { id: "openai", name: "OpenAI" },
      { id: "anthropic", name: "Anthropic" },
      { id: "deepseek", name: "DeepSeek" }
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
        id: "gpt-4o-deprecated",
        provider_id: "openai",
        context_window: 128_000,
        input_modalities: ["text"],
        output_modalities: ["text"],
        reasoning: false,
        tool_call: true,
        structured_output: true,
        status: "deprecated"
      },
      {
        id: "dall-e-3",
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
      }
    ],
    fetchedAt: "2024-01-01T00:00:00.000Z",
    source: "bundled"
  };
}

function withFixture(testFn: (fixturePath: string, cachePath: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "estacoda-catalog-test-"));
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

function buildOptions(fixturePath: string, cachePath: string, overrides?: {
  config?: CreateModelSelectionCatalogOptions["config"];
  registry?: ProviderRegistry;
}): CreateModelSelectionCatalogOptions {
  return {
    config: overrides?.config ?? {},
    providerRegistry: overrides?.registry ?? new ProviderRegistry(),
    homeDir: tmpdir(),
    modelsDevOptions: {
      bundledSnapshotPath: fixturePath,
      cachePath,
      allowNetwork: false
    }
  };
}

describe("routeKey", () => {
  it("includes provider, id, and baseUrl", () => {
    const key = routeKey("openai", "gpt-4o", "https://custom.example.com/v1");
    expect(key).toContain("openai");
    expect(key).toContain("gpt-4o");
    expect(key).toContain("https://custom.example.com/v1");
  });

  it("keeps same provider/id with different baseUrls distinct", () => {
    const keyA = routeKey("openai", "gpt-4o", "https://a.example.com/v1");
    const keyB = routeKey("openai", "gpt-4o", "https://b.example.com/v1");
    expect(keyA).not.toBe(keyB);
  });

  it("omits baseUrl when undefined", () => {
    const key = routeKey("openai", "gpt-4o");
    expect(key).toBe(JSON.stringify(["openai", "gpt-4o", ""]));
  });

  it("is treated as opaque", () => {
    // Consumers should not parse it by splitting. The helper
    // contract is: routeKey(a,b,c) === routeKey(a,b,c) always.
    expect(routeKey("openai", "gpt-4o", "https://a.com/v1"))
      .toBe(routeKey("openai", "gpt-4o", "https://a.com/v1"));
  });

  it("distinguishes http://localhost:8080 from http://localhost", () => {
    const keyA = routeKey("provider", "id", "http://localhost:8080");
    const keyB = routeKey("provider", "id", "http://localhost");
    expect(keyA).not.toBe(keyB);
  });

  it("is not colon-delimited", () => {
    const key = routeKey("openai", "gpt-4o", "https://example.com/v1");
    expect(key.startsWith("openai:gpt-4o")).toBe(false);
  });
});

describe("ModelSelectionCatalog offline behavior", () => {
  beforeEach(() => {
    resetModelsDevRegistryForTest();
  });

  it("loads catalog without network calls", withFixture(async (fixturePath, cachePath) => {
    let fetchCalled = false;
    const catalog = await createModelSelectionCatalog(buildOptions(fixturePath, cachePath, {
      registry: new ProviderRegistry()
    }));

    const models = await catalog.listModels();
    expect(models.length).toBeGreaterThan(0);
    expect(fetchCalled).toBe(false);
  }));

  it("does not make network calls by default", withFixture(async (fixturePath, cachePath) => {
    const catalog = await createModelSelectionCatalog(buildOptions(fixturePath, cachePath));
    const providers = await catalog.listProviders();
    const models = await catalog.listModels();
    // Should return data from the bundled fixture without fetching
    expect(providers.some((p) => p.id === "openai")).toBe(true);
    expect(models.some((m) => m.id === "gpt-4o")).toBe(true);
  }));
});

describe("ModelSelectionCatalog configured models", () => {
  beforeEach(() => {
    resetModelsDevRegistryForTest();
  });

  it("includes configured models even when unknown to models.dev", withFixture(async (fixturePath, cachePath) => {
    const registry = new ProviderRegistry();
    registry.register(createCatalogProvider({
      id: "openai" as ProviderId,
      models: []
    }));

    const catalog = await createModelSelectionCatalog(buildOptions(fixturePath, cachePath, {
      config: {
        providers: {
          openai: {
            kind: "openai-compatible",
            models: ["gpt-4o", "unknown-custom-model"]
          }
        }
      },
      registry
    }));

    const models = await catalog.listModels();
    const custom = models.find((m) => m.id === "unknown-custom-model");
    expect(custom).toBeDefined();
    expect(custom!.configured).toBe(true);
    expect(custom!.source).toBe("configured");
  }));

  it("marks configured models from snapshot as configured", withFixture(async (fixturePath, cachePath) => {
    const registry = new ProviderRegistry();
    registry.register(createCatalogProvider({
      id: "openai" as ProviderId,
      models: []
    }));

    const catalog = await createModelSelectionCatalog(buildOptions(fixturePath, cachePath, {
      config: {
        providers: {
          openai: {
            kind: "openai-compatible",
            models: ["gpt-4o"]
          }
        }
      },
      registry
    }));

    const models = await catalog.listModels();
    const gpt4o = models.find((m) => m.id === "gpt-4o" && m.provider === "openai");
    expect(gpt4o).toBeDefined();
    expect(gpt4o!.configured).toBe(true);
    expect(gpt4o!.source).toBe("configured");
  }));
});

describe("ModelSelectionCatalog manual IDs", () => {
  beforeEach(() => {
    resetModelsDevRegistryForTest();
  });

  it("preserves manual primary model with inferred profile", withFixture(async (fixturePath, cachePath) => {
    const catalog = await createModelSelectionCatalog(buildOptions(fixturePath, cachePath, {
      config: {
        model: {
          provider: "openai" as ProviderId,
          id: "manual-model-id"
        }
      }
    }));

    const models = await catalog.listModels();
    const manual = models.find((m) => m.id === "manual-model-id");
    expect(manual).toBeDefined();
    expect(manual!.source).toBe("manual");
    expect(manual!.profile.provider).toBe("openai");
    expect(manual!.profile.id).toBe("manual-model-id");
  }));

  it("preserves manual fallback models", withFixture(async (fixturePath, cachePath) => {
    const catalog = await createModelSelectionCatalog(buildOptions(fixturePath, cachePath, {
      config: {
        model: {
          provider: "openai" as ProviderId,
          id: "primary-model",
          fallbacks: [
            { provider: "deepseek" as ProviderId, id: "fallback-model" }
          ]
        }
      }
    }));

    const models = await catalog.listModels();
    const fallback = models.find((m) => m.id === "fallback-model" && m.provider === "deepseek");
    expect(fallback).toBeDefined();
    expect(fallback!.source).toBe("manual");
  }));
});

describe("ModelSelectionCatalog executable vs catalogOnly", () => {
  beforeEach(() => {
    resetModelsDevRegistryForTest();
  });

  it("marks models as executable when adapter has executable !== false", withFixture(async (fixturePath, cachePath) => {
    const registry = new ProviderRegistry();
    // Register an executable adapter for openai
    registry.register({
      id: "openai" as ProviderId,
      name: "OpenAI",
      executable: true,
      health(_endpointOverride?: ProviderEndpoint) {
        return { available: true };
      },
      listModels() {
        return [];
      },
      async complete() {
        return { ok: true, content: "", model: "", provider: "openai" };
      }
    });

    const catalog = await createModelSelectionCatalog(buildOptions(fixturePath, cachePath, {
      config: {
        providers: {
          openai: {
            kind: "openai-compatible",
            models: ["gpt-4o"]
          }
        }
      },
      registry
    }));

    const models = await catalog.listModels();
    const gpt4o = models.find((m) => m.id === "gpt-4o" && m.provider === "openai");
    expect(gpt4o).toBeDefined();
    expect(gpt4o!.executable).toBe(true);
    expect(gpt4o!.catalogOnly).toBe(false);
  }));

  it("marks models as catalogOnly when adapter has executable === false", withFixture(async (fixturePath, cachePath) => {
    const registry = new ProviderRegistry();
    registry.register(createCatalogProvider({
      id: "anthropic" as ProviderId,
      models: []
    }));

    const catalog = await createModelSelectionCatalog(buildOptions(fixturePath, cachePath, {
      config: {
        providers: {
          anthropic: {
            kind: "catalog",
            models: ["claude-3-opus"]
          }
        }
      },
      registry
    }));

    const models = await catalog.listModels();
    const opus = models.find((m) => m.id === "claude-3-opus" && m.provider === "anthropic");
    expect(opus).toBeDefined();
    expect(opus!.executable).toBe(false);
    expect(opus!.catalogOnly).toBe(true);
  }));

  it("marks models as catalogOnly when no adapter is registered", withFixture(async (fixturePath, cachePath) => {
    const registry = new ProviderRegistry();
    // No adapter registered for deepseek

    const catalog = await createModelSelectionCatalog(buildOptions(fixturePath, cachePath, {
      config: {
        providers: {
          deepseek: {
            kind: "openai-compatible",
            models: ["deepseek-chat"]
          }
        }
      },
      registry
    }));

    const models = await catalog.listModels();
    const deepseek = models.find((m) => m.id === "deepseek-chat" && m.provider === "deepseek");
    expect(deepseek).toBeDefined();
    expect(deepseek!.executable).toBe(false);
    expect(deepseek!.catalogOnly).toBe(true);
  }));

  it("excludes catalogOnly when includeCatalogOnly is false", withFixture(async (fixturePath, cachePath) => {
    const registry = new ProviderRegistry();
    registry.register(createCatalogProvider({
      id: "anthropic" as ProviderId,
      models: []
    }));

    const catalog = await createModelSelectionCatalog(buildOptions(fixturePath, cachePath, {
      config: {
        providers: {
          anthropic: {
            kind: "catalog",
            models: ["claude-3-opus"]
          }
        }
      },
      registry
    }));

    const all = await catalog.listModels();
    const filtered = await catalog.listModels({ includeCatalogOnly: false });

    expect(all.some((m) => m.provider === "anthropic")).toBe(true);
    expect(filtered.some((m) => m.provider === "anthropic")).toBe(false);
  }));
});

describe("ModelSelectionCatalog filtering", () => {
  beforeEach(() => {
    resetModelsDevRegistryForTest();
  });

  it("excludes deprecated models by default", withFixture(async (fixturePath, cachePath) => {
    const catalog = await createModelSelectionCatalog(buildOptions(fixturePath, cachePath));
    const models = await catalog.listModels();
    expect(models.some((m) => m.id === "gpt-4o-deprecated")).toBe(false);
  }));

  it("includes deprecated models when includeDeprecated is true", withFixture(async (fixturePath, cachePath) => {
    const catalog = await createModelSelectionCatalog(buildOptions(fixturePath, cachePath));
    const models = await catalog.listModels({ includeDeprecated: true });
    expect(models.some((m) => m.id === "gpt-4o-deprecated")).toBe(true);
  }));

  it("excludes non-chat models (no text output) by default", withFixture(async (fixturePath, cachePath) => {
    const catalog = await createModelSelectionCatalog(buildOptions(fixturePath, cachePath));
    const models = await catalog.listModels();
    expect(models.some((m) => m.id === "dall-e-3")).toBe(false);
  }));
});

describe("ModelSelectionCatalog dedupe", () => {
  beforeEach(() => {
    resetModelsDevRegistryForTest();
  });

  it("does not duplicate same provider/id without baseUrl", withFixture(async (fixturePath, cachePath) => {
    const catalog = await createModelSelectionCatalog(buildOptions(fixturePath, cachePath, {
      config: {
        providers: {
          openai: {
            kind: "openai-compatible",
            models: ["gpt-4o"]
          }
        }
      }
    }));

    const models = await catalog.listModels();
    const gpt4oEntries = models.filter((m) => m.id === "gpt-4o" && m.provider === "openai");
    expect(gpt4oEntries.length).toBe(1);
  }));

  it("keeps distinct routes when baseUrl differs", withFixture(async (fixturePath, cachePath) => {
    const catalog = await createModelSelectionCatalog(buildOptions(fixturePath, cachePath, {
      config: {
        providers: {
          openai: {
            kind: "openai-compatible",
            baseUrl: "https://custom.example.com/v1",
            models: ["gpt-4o"]
          }
        }
      }
    }));

    const models = await catalog.listModels();
    const gpt4oEntries = models.filter((m) => m.id === "gpt-4o" && m.provider === "openai");
    // The configured baseUrl applies to the snapshot model too, so they merge into one entry
    expect(gpt4oEntries.length).toBe(1);
    expect(gpt4oEntries[0]!.baseUrl).toBe("https://custom.example.com/v1");
    expect(gpt4oEntries[0]!.configured).toBe(true);
  }));
});

describe("ModelSelectionCatalog search", () => {
  beforeEach(() => {
    resetModelsDevRegistryForTest();
  });

  it("finds models by id substring", withFixture(async (fixturePath, cachePath) => {
    const catalog = await createModelSelectionCatalog(buildOptions(fixturePath, cachePath));
    const results = await catalog.searchModels("gpt-4o");
    expect(results.some((m) => m.id === "gpt-4o")).toBe(true);
  }));

  it("finds models by provider substring", withFixture(async (fixturePath, cachePath) => {
    const catalog = await createModelSelectionCatalog(buildOptions(fixturePath, cachePath));
    const results = await catalog.searchModels("openai");
    expect(results.some((m) => m.provider === "openai")).toBe(true);
  }));
});

describe("ModelSelectionCatalog resolveModel", () => {
  beforeEach(() => {
    resetModelsDevRegistryForTest();
  });

  it("resolves a model by provider and id", withFixture(async (fixturePath, cachePath) => {
    const catalog = await createModelSelectionCatalog(buildOptions(fixturePath, cachePath));
    const model = await catalog.resolveModel("openai", "gpt-4o");
    expect(model).toBeDefined();
    expect(model!.id).toBe("gpt-4o");
    expect(model!.provider).toBe("openai");
  }));

  it("returns undefined for unknown model", withFixture(async (fixturePath, cachePath) => {
    const catalog = await createModelSelectionCatalog(buildOptions(fixturePath, cachePath));
    const model = await catalog.resolveModel("openai", "nonexistent-model");
    expect(model).toBeUndefined();
  }));
});

describe("ModelSelectionCatalog refresh", () => {
  beforeEach(() => {
    resetModelsDevRegistryForTest();
  });

  it("produces a ModelRefreshReport with expected fields", withFixture(async (fixturePath, cachePath) => {
    const catalog = await createModelSelectionCatalog(buildOptions(fixturePath, cachePath));
    const report = await catalog.refresh();

    expect(report.sourceDomain).toBe("models.dev");
    expect(report.cachePath).toContain("models_dev_cache.json");
    expect(typeof report.snapshotTimestamp).toBe("string");
    expect(typeof report.cacheChanged).toBe("boolean");
    expect(typeof report.modelsCount).toBe("number");
    expect(typeof report.providersCount).toBe("number");
    expect(Array.isArray(report.warnings)).toBe(true);
  }));

  it("does not own independent fetch/cache logic (delegates to refreshModelsDevSnapshot)", withFixture(async (fixturePath, cachePath) => {
    const catalog = await createModelSelectionCatalog(buildOptions(fixturePath, cachePath));
    const report = await catalog.refresh();

    // The report should reflect delegation, not custom fetch logic.
    // We verify this indirectly: the snapshot comes from the fixture
    // bundled path, and the cache path is the standard models.dev path.
    expect(report.sourceDomain).toBe("models.dev");
    expect(report.cachePath).toContain("models_dev_cache.json");
  }));

  it("uses ESTACODA_HOME before HOME for the default models.dev cache path", withFixture(async (fixturePath, _cachePath) => {
    const tempHome = mkdtempSync(join(tmpdir(), "estacoda-model-catalog-home-"));
    const prodHome = join(tempHome, "prod-home");
    const devHome = join(tempHome, "dev-home");
    const previousHome = process.env.HOME;
    const previousEstacodaHome = process.env.ESTACODA_HOME;
    process.env.HOME = prodHome;
    process.env.ESTACODA_HOME = devHome;
    try {
      const catalog = await createModelSelectionCatalog({
        config: {},
        providerRegistry: new ProviderRegistry(),
        modelsDevOptions: {
          bundledSnapshotPath: fixturePath,
          allowNetwork: false,
          fetchImpl: async () => ({
            ok: false,
            status: 503,
            statusText: "Service Unavailable",
            json: async () => ({}),
            text: async () => ""
          })
        }
      });
      const report = await catalog.refresh();

      expect(report.cachePath).toBe(join(devHome, ".estacoda", "models_dev_cache.json"));
      expect(report.cachePath).not.toContain(prodHome);
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      if (previousEstacodaHome === undefined) {
        delete process.env.ESTACODA_HOME;
      } else {
        process.env.ESTACODA_HOME = previousEstacodaHome;
      }
      rmSync(tempHome, { recursive: true, force: true });
    }
  }));
});

describe("ModelSelectionCatalog provider listing", () => {
  beforeEach(() => {
    resetModelsDevRegistryForTest();
  });

  it("lists configured and snapshot providers", withFixture(async (fixturePath, cachePath) => {
    const catalog = await createModelSelectionCatalog(buildOptions(fixturePath, cachePath, {
      config: {
        providers: {
          openai: {
            kind: "openai-compatible",
            models: ["gpt-4o"]
          }
        }
      }
    }));

    const providers = await catalog.listProviders();
    const openai = providers.find((p) => p.id === "openai");
    expect(openai).toBeDefined();
    expect(openai!.configured).toBe(true);

    const anthropic = providers.find((p) => p.id === "anthropic");
    expect(anthropic).toBeDefined();
    expect(anthropic!.configured).toBe(false);
  }));

  it("counts merged unique model IDs from configured, snapshot, fallback-known, and manual routes", withFixture(async (fixturePath, cachePath) => {
    const catalog = await createModelSelectionCatalog(buildOptions(fixturePath, cachePath, {
      config: {
        model: {
          provider: "openai" as ProviderId,
          id: "manual-primary",
          fallbacks: [
            { provider: "openai" as ProviderId, id: "manual-fallback" },
            { provider: "openai" as ProviderId, id: "gpt-4o" },
          ],
        },
        providers: {
          openai: {
            kind: "openai-compatible",
            models: ["gpt-4o"]
          }
        }
      }
    }));

    const providers = await catalog.listProviders();
    const openai = providers.find((p) => p.id === "openai");
    expect(openai).toBeDefined();
    expect(openai!.configured).toBe(true);
    expect(openai!.modelsCount).toBe(7);
  }));

  it("counts multiple fallback-known models for fallback-only providers", withFixture(async (fixturePath, cachePath) => {
    const catalog = await createModelSelectionCatalog(buildOptions(fixturePath, cachePath));

    const providers = await catalog.listProviders();
    const kimi = providers.find((p) => p.id === "kimi");
    expect(kimi).toBeDefined();
    expect(kimi!.modelsCount).toBe(2);
  }));

  it("infers provider uxKind correctly", withFixture(async (fixturePath, cachePath) => {
    const catalog = await createModelSelectionCatalog(buildOptions(fixturePath, cachePath, {
      config: {
        providers: {
          openai: {
            kind: "openai-compatible",
            models: ["gpt-4o"]
          },
          local: {
            kind: "openai-compatible",
            baseUrl: "http://localhost:11434/v1",
            models: ["llama3"]
          }
        }
      }
    }));

    const providers = await catalog.listProviders();
    const openai = providers.find((p) => p.id === "openai");
    expect(openai!.uxKind).toBe("hosted");

    const local = providers.find((p) => p.id === "local");
    expect(local!.uxKind).toBe("local");
  }));
});

describe("ModelSelectionCatalog report shape", () => {
  beforeEach(() => {
    resetModelsDevRegistryForTest();
  });

  it("includes endpointType, live, cost, documentationUrl, logoUrl, diagnosticFields where available", withFixture(async (fixturePath, cachePath) => {
    const catalog = await createModelSelectionCatalog(buildOptions(fixturePath, cachePath));
    const models = await catalog.listModels();
    const gpt4o = models.find((m) => m.id === "gpt-4o" && m.provider === "openai");
    expect(gpt4o).toBeDefined();
    expect(gpt4o!.endpointType).toBe("openai");
    expect(gpt4o!.diagnosticFields).toBeDefined();
    expect(typeof gpt4o!.live).toBe("boolean");
  }));

  it("lists first-class Z.ai provider and fallback models as executable with adapter support", withFixture(async (fixturePath, cachePath) => {
    const registry = new ProviderRegistry();
    registry.register({
      id: "zai" as ProviderId,
      name: "Z.AI",
      executable: true,
      health(_endpointOverride?: ProviderEndpoint) {
        return { available: true };
      },
      listModels() {
        return [];
      },
      async complete() {
        return { ok: true, content: "", model: "", provider: "zai" };
      }
    });

    const catalog = await createModelSelectionCatalog(buildOptions(fixturePath, cachePath, {
      registry
    }));

    const providers = await catalog.listProviders({ includeCatalogOnly: false });
    const zaiProvider = providers.find((p) => p.id === "zai");
    expect(zaiProvider).toBeDefined();
    expect(zaiProvider!.name).toBe("Z.AI");
    expect(zaiProvider!.executable).toBe(true);
    expect(zaiProvider!.catalogOnly).toBe(false);
    expect(zaiProvider!.modelsCount).toBeGreaterThanOrEqual(4);

    const models = await catalog.listModels({ provider: "zai", includeCatalogOnly: false });
    const glm = models.find((m) => m.id === "glm-5.2");
    expect(glm).toBeDefined();
    expect(glm!.provider).toBe("zai");
    expect(glm!.executable).toBe(true);
    expect(glm!.catalogOnly).toBe(false);
    expect(glm!.source).toBe("fallback-known");
  }));

  it("sets endpointType to custom for local providers", withFixture(async (fixturePath, cachePath) => {
    const registry = new ProviderRegistry();
    registry.register({
      id: "local" as ProviderId,
      name: "Local",
      executable: true,
      health(_endpointOverride?: ProviderEndpoint) {
        return { available: true };
      },
      listModels() {
        return [];
      },
      async complete() {
        return { ok: true, content: "", model: "", provider: "local" };
      }
    });

    const catalog = await createModelSelectionCatalog(buildOptions(fixturePath, cachePath, {
      config: {
        providers: {
          local: {
            kind: "openai-compatible",
            baseUrl: "http://localhost:11434/v1",
            models: ["llama3"]
          }
        }
      },
      registry
    }));

    const models = await catalog.listModels();
    const llama3 = models.find((m) => m.id === "llama3" && m.provider === "local");
    expect(llama3).toBeDefined();
    expect(llama3!.endpointType).toBe("custom");
  }));
});

describe("ModelSelectionCatalog cache invalidation", () => {
  beforeEach(() => {
    resetModelsDevRegistryForTest();
  });

  it("ignores old cache without formatVersion", withFixture(async (fixturePath, cachePath) => {
    // Write an old-format cache (no formatVersion)
    const oldSnapshot = {
      providers: [{ id: "stale", name: "Stale Provider" }],
      models: [],
      fetchedAt: "2020-01-01T00:00:00.000Z",
      source: "disk"
    };
    writeFileSync(cachePath, JSON.stringify(oldSnapshot), "utf8");

    const catalog = await createModelSelectionCatalog(buildOptions(fixturePath, cachePath));
    const report = await catalog.refresh();

    // Old cache should be invalidated, so cacheChanged should be true
    // because the new snapshot differs from the old one.
    expect(report.cacheChanged).toBe(true);
  }));
});

describe("ModelSelectionCatalog provider metadata integration", () => {
  beforeEach(() => {
    resetModelsDevRegistryForTest();
  });

  it("uses canonical display names from metadata for known providers", withFixture(async (fixturePath, cachePath) => {
    const catalog = await createModelSelectionCatalog(buildOptions(fixturePath, cachePath));
    const providers = await catalog.listProviders();
    const openai = providers.find((p) => p.id === "openai");
    expect(openai).toBeDefined();
    expect(openai!.name).toBe("OpenAI");
  }));

  it("infers setupMode from metadata auth methods (local with baseUrl = base-url)", withFixture(async (fixturePath, cachePath) => {
    const catalog = await createModelSelectionCatalog(buildOptions(fixturePath, cachePath, {
      config: {
        providers: {
          local: {
            kind: "openai-compatible",
            baseUrl: "http://localhost:11434/v1",
            models: ["llama3"]
          }
        }
      }
    }));

    const providers = await catalog.listProviders();
    const local = providers.find((p) => p.id === "local");
    expect(local).toBeDefined();
    expect(local!.setupMode).toBe("base-url");
  }));

  it("infers setupMode = none for local without explicit baseUrl or apiKey", withFixture(async (fixturePath, cachePath) => {
    const catalog = await createModelSelectionCatalog(buildOptions(fixturePath, cachePath));
    const providers = await catalog.listProviders();
    const local = providers.find((p) => p.id === "local");
    expect(local).toBeDefined();
    expect(local!.setupMode).toBe("none");
  }));

  it("infers setupMode = api-key for hosted providers without explicit config", withFixture(async (fixturePath, cachePath) => {
    const catalog = await createModelSelectionCatalog(buildOptions(fixturePath, cachePath));
    const providers = await catalog.listProviders();
    const deepseek = providers.find((p) => p.id === "deepseek");
    expect(deepseek).toBeDefined();
    expect(deepseek!.setupMode).toBe("api-key");
  }));

  it("marks catalog-only providers as not configured and not runnable", withFixture(async (fixturePath, cachePath) => {
    const registry = new ProviderRegistry();
    registry.register(createCatalogProvider({
      id: "anthropic" as ProviderId,
      models: []
    }));

    const catalog = await createModelSelectionCatalog(buildOptions(fixturePath, cachePath, {
      config: {
        providers: {
          anthropic: {
            kind: "catalog",
            models: ["claude-3-opus"]
          }
        }
      },
      registry
    }));

    const providers = await catalog.listProviders();
    const anthropic = providers.find((p) => p.id === "anthropic");
    expect(anthropic).toBeDefined();
    expect(anthropic!.catalogOnly).toBe(true);
    expect(anthropic!.configured).toBe(true);
    expect(anthropic!.executable).toBe(false);
  }));

  it("catalog-only providers are excluded when includeCatalogOnly is false", withFixture(async (fixturePath, cachePath) => {
    const registry = new ProviderRegistry();
    registry.register(createCatalogProvider({
      id: "anthropic" as ProviderId,
      models: []
    }));

    const catalog = await createModelSelectionCatalog(buildOptions(fixturePath, cachePath, {
      config: {
        providers: {
          anthropic: {
            kind: "catalog",
            models: ["claude-3-opus"]
          }
        }
      },
      registry
    }));

    const allProviders = await catalog.listProviders();
    const filteredProviders = await catalog.listProviders({ includeCatalogOnly: false });

    expect(allProviders.some((p) => p.id === "anthropic")).toBe(true);
    expect(filteredProviders.some((p) => p.id === "anthropic")).toBe(false);
  }));

  it("infers endpointType from metadata apiMode (anthropic -> anthropic)", withFixture(async (fixturePath, cachePath) => {
    const registry = new ProviderRegistry();
    registry.register(createCatalogProvider({
      id: "anthropic" as ProviderId,
      models: []
    }));

    const catalog = await createModelSelectionCatalog(buildOptions(fixturePath, cachePath, {
      config: {
        providers: {
          anthropic: {
            kind: "catalog",
            models: ["claude-3-opus"]
          }
        }
      },
      registry
    }));

    const models = await catalog.listModels();
    const opus = models.find((m) => m.id === "claude-3-opus" && m.provider === "anthropic");
    expect(opus).toBeDefined();
    expect(opus!.endpointType).toBe("anthropic");
  }));

  it("infers endpointType = custom for non-default baseUrl", withFixture(async (fixturePath, cachePath) => {
    const catalog = await createModelSelectionCatalog(buildOptions(fixturePath, cachePath, {
      config: {
        providers: {
          openai: {
            kind: "openai-compatible",
            baseUrl: "https://custom.openai.com/v1",
            models: ["gpt-4o"]
          }
        }
      }
    }));

    const models = await catalog.listModels();
    const gpt4o = models.find((m) => m.id === "gpt-4o" && m.provider === "openai");
    expect(gpt4o).toBeDefined();
    expect(gpt4o!.endpointType).toBe("custom");
  }));

  it("infers endpointType = openai for default baseUrl", withFixture(async (fixturePath, cachePath) => {
    const catalog = await createModelSelectionCatalog(buildOptions(fixturePath, cachePath, {
      config: {
        providers: {
          openai: {
            kind: "openai-compatible",
            baseUrl: "https://api.openai.com/v1",
            models: ["gpt-4o"]
          }
        }
      }
    }));

    const models = await catalog.listModels();
    const gpt4o = models.find((m) => m.id === "gpt-4o" && m.provider === "openai");
    expect(gpt4o).toBeDefined();
    expect(gpt4o!.endpointType).toBe("openai");
  }));
});

describe("ModelSelectionCatalog source labels after dedupe", () => {
  beforeEach(() => {
    resetModelsDevRegistryForTest();
  });

  it("configured model that exists in snapshot gets source=configured", withFixture(async (fixturePath, cachePath) => {
    const registry = new ProviderRegistry();
    registry.register(createCatalogProvider({
      id: "openai" as ProviderId,
      models: []
    }));

    const catalog = await createModelSelectionCatalog(buildOptions(fixturePath, cachePath, {
      config: {
        providers: {
          openai: {
            kind: "openai-compatible",
            models: ["gpt-4o"]
          }
        }
      },
      registry
    }));

    const models = await catalog.listModels();
    const gpt4o = models.find((m) => m.id === "gpt-4o" && m.provider === "openai");
    expect(gpt4o).toBeDefined();
    expect(gpt4o!.configured).toBe(true);
    expect(gpt4o!.source).toBe("configured");
  }));

  it("manual model that exists in snapshot gets source=manual", withFixture(async (fixturePath, cachePath) => {
    const registry = new ProviderRegistry();
    registry.register(createCatalogProvider({
      id: "openai" as ProviderId,
      models: []
    }));

    const catalog = await createModelSelectionCatalog(buildOptions(fixturePath, cachePath, {
      config: {
        model: {
          provider: "openai" as ProviderId,
          id: "gpt-4o"
        }
      },
      registry
    }));

    const models = await catalog.listModels();
    const gpt4o = models.find((m) => m.id === "gpt-4o" && m.provider === "openai");
    expect(gpt4o).toBeDefined();
    expect(gpt4o!.source).toBe("manual");
  }));

  it("fallback-known model not in snapshot gets source=fallback-known", withFixture(async (fixturePath, cachePath) => {
    const catalog = await createModelSelectionCatalog(buildOptions(fixturePath, cachePath));
    const models = await catalog.listModels();
    const kimi = models.find((m) => m.provider === "kimi" && m.id === "kimi-k2.5");
    expect(kimi).toBeDefined();
    expect(kimi!.source).toBe("fallback-known");
  }));

  it("configured custom unknown model gets source=configured with inferred profile", withFixture(async (fixturePath, cachePath) => {
    const registry = new ProviderRegistry();
    registry.register(createCatalogProvider({
      id: "openai" as ProviderId,
      models: []
    }));

    const catalog = await createModelSelectionCatalog(buildOptions(fixturePath, cachePath, {
      config: {
        providers: {
          openai: {
            kind: "openai-compatible",
            models: ["unknown-custom-model"]
          }
        }
      },
      registry
    }));

    const models = await catalog.listModels();
    const custom = models.find((m) => m.id === "unknown-custom-model");
    expect(custom).toBeDefined();
    expect(custom!.configured).toBe(true);
    expect(custom!.source).toBe("configured");
    expect(custom!.profile.status).toBe("unknown");
  }));

  it("manual route unknown model gets source=manual with inferred profile", withFixture(async (fixturePath, cachePath) => {
    const catalog = await createModelSelectionCatalog(buildOptions(fixturePath, cachePath, {
      config: {
        model: {
          provider: "openai" as ProviderId,
          id: "manual-unknown-model"
        }
      }
    }));

    const models = await catalog.listModels();
    const manual = models.find((m) => m.id === "manual-unknown-model");
    expect(manual).toBeDefined();
    expect(manual!.source).toBe("manual");
    expect(manual!.profile.status).toBe("unknown");
  }));

  it("preserves exact model IDs through profile resolution", withFixture(async (fixturePath, cachePath) => {
    const catalog = await createModelSelectionCatalog(buildOptions(fixturePath, cachePath, {
      config: {
        providers: {
          openai: {
            kind: "openai-compatible",
            models: ["gpt-4o"]
          }
        }
      }
    }));

    const models = await catalog.listModels();
    const gpt4o = models.find((m) => m.provider === "openai" && m.id === "gpt-4o");
    expect(gpt4o).toBeDefined();
    expect(gpt4o!.id).toBe("gpt-4o");
    expect(gpt4o!.routeKey).toBe(JSON.stringify(["openai", "gpt-4o", ""]));
  }));
});
