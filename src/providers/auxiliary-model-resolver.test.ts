import { describe, it, expect } from "vitest";
import {
  resolveAuxiliaryModelRoute,
  resolveAllAuxiliaryRoutes
} from "./auxiliary-model-resolver.js";
import type {
  AuxiliaryModelTask,
  ModelProfile,
  ResolvedModelRoute
} from "../contracts/provider.js";

function fakeMainRoute(overrides?: Partial<ResolvedModelRoute>): ResolvedModelRoute {
  return {
    provider: "openai",
    id: "gpt-4o",
    profile: {
      id: "gpt-4o",
      provider: "openai",
      contextWindowTokens: 128_000,
      supportsTools: true,
      supportsVision: true,
      supportsStructuredOutput: true,
    },
    ...overrides,
  };
}

function fakeModelProfile(overrides?: Partial<ModelProfile>): ModelProfile {
  return {
    id: "gpt-4o-mini",
    provider: "openai",
    contextWindowTokens: 128_000,
    supportsTools: false,
    supportsVision: false,
    supportsStructuredOutput: true,
    ...overrides,
  };
}

function fakeRegistry(models: ModelProfile[] = []) {
  return {
    listModels: async () => models,
  } as unknown as import("./provider-registry.js").ProviderRegistry;
}

describe("resolveAuxiliaryModelRoute", () => {
  it("returns disabled when enabled: false", () => {
    const result = resolveAuxiliaryModelRoute("vision", { enabled: false }, {
      mainRoute: fakeMainRoute(),
      providerRegistry: fakeRegistry(),
    });
    expect(result.route).toBeUndefined();
    expect(result.source).toBe("disabled");
    expect(result.fallbackToMain).toBe(false);
    expect(result.diagnostics).toContain("Slot is explicitly disabled");
  });

  it("returns custom route when baseUrl and id are set", () => {
    const result = resolveAuxiliaryModelRoute("assessor", {
      baseUrl: "http://localhost:11434/v1",
      id: "qwen2.5:3b",
      apiKeyEnv: "LOCAL_API_KEY",
    }, {
      mainRoute: fakeMainRoute(),
      providerRegistry: fakeRegistry(),
    });
    expect(result.source).toBe("custom");
    expect(result.route?.provider).toBe("openai-compatible");
    expect(result.route?.id).toBe("qwen2.5:3b");
    expect(result.route?.baseUrl).toBe("http://localhost:11434/v1");
    expect(result.route?.apiKeyEnv).toBe("LOCAL_API_KEY");
    expect(result.fallbackToMain).toBe(false);
  });

  it("returns unavailable when baseUrl is set but id is missing", () => {
    const result = resolveAuxiliaryModelRoute("assessor", {
      baseUrl: "http://localhost:11434/v1",
    }, {
      mainRoute: fakeMainRoute(),
      providerRegistry: fakeRegistry(),
    });
    expect(result.route).toBeUndefined();
    expect(result.source).toBe("custom");
    expect(result.diagnostics.some((d) => d.includes("slot.id is missing"))).toBe(true);
  });

  it("uses main route when provider is main", () => {
    const mainRoute = fakeMainRoute();
    const result = resolveAuxiliaryModelRoute("assessor", { provider: "main" }, {
      mainRoute,
      providerRegistry: fakeRegistry(),
    });
    expect(result.source).toBe("main");
    expect(result.route).toBe(mainRoute);
    expect(result.fallbackToMain).toBe(false);
  });

  it("resolves explicit provider+id to exact route", () => {
    const result = resolveAuxiliaryModelRoute("assessor", {
      provider: "openai",
      id: "gpt-4o-mini",
    }, {
      mainRoute: fakeMainRoute(),
      providerRegistry: fakeRegistry(),
    });
    expect(result.source).toBe("explicit");
    expect(result.route?.provider).toBe("openai");
    expect(result.route?.id).toBe("gpt-4o-mini");
    expect(result.fallbackToMain).toBe(false);
  });

  it("propagates slot timeoutMs and maxConcurrency", () => {
    const result = resolveAuxiliaryModelRoute("assessor", {
      provider: "openai",
      id: "gpt-4o-mini",
      timeoutMs: 7000,
      maxConcurrency: 3,
    }, {
      mainRoute: fakeMainRoute(),
      providerRegistry: fakeRegistry(),
    });
    expect(result.timeoutMs).toBe(7000);
    expect(result.maxConcurrency).toBe(3);
  });

  it("leaves omitted timeoutMs and maxConcurrency undefined", () => {
    const result = resolveAuxiliaryModelRoute("assessor", {
      provider: "openai",
      id: "gpt-4o-mini",
    }, {
      mainRoute: fakeMainRoute(),
      providerRegistry: fakeRegistry(),
    });
    expect(result.timeoutMs).toBeUndefined();
    expect(result.maxConcurrency).toBeUndefined();
  });

  it("chooses best model on explicit provider when id is missing", () => {
    const models = [
      fakeModelProfile({ provider: "deepseek", id: "deepseek-chat", supportsTools: true, supportsStructuredOutput: true, contextWindowTokens: 64_000 }),
      fakeModelProfile({ provider: "deepseek", id: "deepseek-reasoner", supportsTools: false, supportsStructuredOutput: true, contextWindowTokens: 32_000 }),
    ];
    const result = resolveAuxiliaryModelRoute("assessor", { provider: "deepseek" }, {
      mainRoute: fakeMainRoute(),
      providerRegistry: fakeRegistry(models),
      providerModels: models,
    });
    expect(result.source).toBe("explicit");
    expect(result.route?.provider).toBe("deepseek");
    expect(result.route?.id).toBe("deepseek-chat");
  });

  it("returns unavailable when explicit provider has no matching models", () => {
    const models = [
      fakeModelProfile({ provider: "deepseek", id: "deepseek-chat", supportsTools: false, supportsStructuredOutput: false }),
    ];
    const result = resolveAuxiliaryModelRoute("assessor", { provider: "deepseek" }, {
      mainRoute: fakeMainRoute(),
      providerRegistry: fakeRegistry(models),
      providerModels: models,
    });
    expect(result.route).toBeUndefined();
    expect(result.source).toBe("explicit");
    expect(result.diagnostics.some((d) => d.includes("No model on provider"))).toBe(true);
  });

  it("auto resolves to main when main supports task requirements", () => {
    const mainRoute = fakeMainRoute({ profile: { ...fakeMainRoute().profile, supportsVision: true } });
    const result = resolveAuxiliaryModelRoute("vision", { provider: "auto" }, {
      mainRoute,
      providerRegistry: fakeRegistry(),
    });
    expect(result.source).toBe("auto-main");
    expect(result.route).toBe(mainRoute);
    expect(result.diagnostics).toContain("Main model satisfies task requirements");
  });

  it("auto resolves to best configured model when main does not support capabilities", () => {
    const mainRoute = fakeMainRoute({ profile: { ...fakeMainRoute().profile, supportsVision: false } });
    const models = [
      fakeModelProfile({ provider: "openai", id: "gpt-4o-mini", supportsVision: true, contextWindowTokens: 128_000 }),
    ];
    const result = resolveAuxiliaryModelRoute("vision", { provider: "auto" }, {
      mainRoute,
      providerRegistry: fakeRegistry(models),
      providerModels: models,
    });
    expect(result.source).toBe("auto-configured");
    expect(result.route?.provider).toBe("openai");
    expect(result.route?.id).toBe("gpt-4o-mini");
    expect(result.diagnostics.some((d) => d.includes("Auto-selected"))).toBe(true);
  });

  it("resolves a task with no task slot through auxiliaryModels.default", () => {
    const mainRoute = fakeMainRoute();
    const result = resolveAuxiliaryModelRoute("compression", {
      default: { provider: "openai", id: "gpt-4.1-mini" },
    }, {
      mainRoute,
      providerRegistry: fakeRegistry(),
    });
    expect(result.source).toBe("explicit");
    expect(result.route).not.toBe(mainRoute);
    expect(result.route?.provider).toBe("openai");
    expect(result.route?.id).toBe("gpt-4.1-mini");
  });

  it("inherits missing provider, model, and operational fields from auxiliaryModels.default", () => {
    const result = resolveAuxiliaryModelRoute("compression", {
      default: {
        provider: "openai",
        id: "gpt-4.1-mini",
        apiKeyEnv: "OPENAI_API_KEY",
        fallbackToMain: true,
        timeoutMs: 5000,
        maxConcurrency: 2,
      },
      compression: { contextWindowTokens: 64_000 },
    }, {
      mainRoute: fakeMainRoute(),
      providerRegistry: fakeRegistry(),
    });
    expect(result.source).toBe("explicit");
    expect(result.route?.provider).toBe("openai");
    expect(result.route?.id).toBe("gpt-4.1-mini");
    expect(result.route?.apiKeyEnv).toBe("OPENAI_API_KEY");
    expect(result.route?.contextWindowTokens).toBe(64_000);
    expect(result.fallbackToMain).toBe(true);
    expect(result.timeoutMs).toBe(5000);
    expect(result.maxConcurrency).toBe(2);
  });

  it("inherits default-lane timeoutMs and maxConcurrency into task routes", () => {
    const result = resolveAuxiliaryModelRoute("compression", {
      default: { provider: "openai", id: "gpt-4.1-mini", timeoutMs: 7000, maxConcurrency: 4 },
      compression: { fallbackToMain: true },
    }, {
      mainRoute: fakeMainRoute(),
      providerRegistry: fakeRegistry(),
    });
    expect(result.timeoutMs).toBe(7000);
    expect(result.maxConcurrency).toBe(4);
  });

  it("lets task timeoutMs and maxConcurrency override default-lane values", () => {
    const result = resolveAuxiliaryModelRoute("compression", {
      default: { provider: "openai", id: "gpt-4.1-mini", timeoutMs: 7000, maxConcurrency: 4 },
      compression: { timeoutMs: 3000, maxConcurrency: 1 },
    }, {
      mainRoute: fakeMainRoute(),
      providerRegistry: fakeRegistry(),
    });
    expect(result.timeoutMs).toBe(3000);
    expect(result.maxConcurrency).toBe(1);
  });

  it("lets task provider and model override auxiliaryModels.default", () => {
    const result = resolveAuxiliaryModelRoute("compression", {
      default: { provider: "openai", id: "gpt-4.1-mini" },
      compression: { provider: "deepseek", id: "deepseek-chat" },
    }, {
      mainRoute: fakeMainRoute(),
      providerRegistry: fakeRegistry(),
    });
    expect(result.source).toBe("explicit");
    expect(result.route?.provider).toBe("deepseek");
    expect(result.route?.id).toBe("deepseek-chat");
  });

  it("uses configured default instead of accidentally auto-selecting main", () => {
    const mainRoute = fakeMainRoute();
    const result = resolveAuxiliaryModelRoute("compression", {
      default: { provider: "openai", id: "gpt-4.1-mini" },
    }, {
      mainRoute,
      providerRegistry: fakeRegistry(),
    });
    expect(result.source).toBe("explicit");
    expect(result.route).not.toBe(mainRoute);
    expect(result.route?.id).toBe("gpt-4.1-mini");
  });

  it("lets explicit provider main select main over auxiliaryModels.default", () => {
    const mainRoute = fakeMainRoute();
    const result = resolveAuxiliaryModelRoute("compression", {
      default: { provider: "openai", id: "gpt-4.1-mini" },
      compression: { provider: "main" },
    }, {
      mainRoute,
      providerRegistry: fakeRegistry(),
    });
    expect(result.source).toBe("main");
    expect(result.route).toBe(mainRoute);
  });

  it("auto returns unavailable when no configured model matches and main is unsuitable", () => {
    const mainRoute = fakeMainRoute({ profile: { ...fakeMainRoute().profile, supportsVision: false } });
    const models = [
      fakeModelProfile({ provider: "openai", id: "gpt-4o-mini", supportsVision: false }),
    ];
    const result = resolveAuxiliaryModelRoute("vision", { provider: "auto" }, {
      mainRoute,
      providerRegistry: fakeRegistry(models),
      providerModels: models,
    });
    expect(result.route).toBeUndefined();
    expect(result.source).toBe("auto-configured");
    expect(result.diagnostics.some((d) => d.includes("No configured model matches"))).toBe(true);
  });

  it("defaults fallbackToMain to false for non-vision structured tasks", () => {
    const mainRoute = fakeMainRoute();
    const result = resolveAuxiliaryModelRoute("compression", { provider: "auto" }, {
      mainRoute,
      providerRegistry: fakeRegistry(),
    });
    expect(result.source).toBe("auto-main");
    expect(result.fallbackToMain).toBe(false);
  });

  it("defaults fallbackToMain to false for explicit routes", () => {
    const result = resolveAuxiliaryModelRoute("assessor", {
      provider: "openai",
      id: "gpt-4o-mini",
    }, {
      mainRoute: fakeMainRoute(),
      providerRegistry: fakeRegistry(),
    });
    expect(result.source).toBe("explicit");
    expect(result.fallbackToMain).toBe(false);
  });

  it("defaults fallbackToMain to false for custom routes", () => {
    const result = resolveAuxiliaryModelRoute("assessor", {
      baseUrl: "http://localhost:11434/v1",
      id: "qwen2.5:3b",
    }, {
      mainRoute: fakeMainRoute(),
      providerRegistry: fakeRegistry(),
    });
    expect(result.source).toBe("custom");
    expect(result.fallbackToMain).toBe(false);
  });

  it("respects explicit fallbackToMain override", () => {
    const result = resolveAuxiliaryModelRoute("assessor", {
      provider: "openai",
      id: "gpt-4o-mini",
      fallbackToMain: true,
    }, {
      mainRoute: fakeMainRoute(),
      providerRegistry: fakeRegistry(),
    });
    expect(result.fallbackToMain).toBe(true);
  });

  it("defaults fallbackToMain for vision to true when main supports vision", () => {
    const mainRoute = fakeMainRoute({ profile: { ...fakeMainRoute().profile, supportsVision: true } });
    const models = [
      fakeModelProfile({ provider: "openai", id: "gpt-4o-mini", supportsVision: true }),
    ];
    const result = resolveAuxiliaryModelRoute("vision", { provider: "auto" }, {
      mainRoute,
      providerRegistry: fakeRegistry(models),
      providerModels: models,
    });
    expect(result.fallbackToMain).toBe(true);
  });

  it("defaults fallbackToMain for vision to false when main does not support vision", () => {
    const mainRoute = fakeMainRoute({ profile: { ...fakeMainRoute().profile, supportsVision: false } });
    const models = [
      fakeModelProfile({ provider: "openai", id: "gpt-4o-mini", supportsVision: true }),
    ];
    const result = resolveAuxiliaryModelRoute("vision", { provider: "auto" }, {
      mainRoute,
      providerRegistry: fakeRegistry(models),
      providerModels: models,
    });
    expect(result.fallbackToMain).toBe(false);
  });

  it("defaults fallbackToMain for tool-reasoning tasks to false", () => {
    const mainRouteTools = fakeMainRoute({ profile: { ...fakeMainRoute().profile, supportsTools: true } });
    const resultMcp = resolveAuxiliaryModelRoute("mcp", { provider: "auto" }, {
      mainRoute: mainRouteTools,
      providerRegistry: fakeRegistry(),
    });
    expect(resultMcp.fallbackToMain).toBe(false);

    const mainRouteNoTools = fakeMainRoute({ profile: { ...fakeMainRoute().profile, supportsTools: false } });
    const resultDelegation = resolveAuxiliaryModelRoute("delegation", { provider: "auto" }, {
      mainRoute: mainRouteNoTools,
      providerRegistry: fakeRegistry(),
    });
    expect(resultDelegation.fallbackToMain).toBe(false);
  });

  it("vision task requires vision capability in auto mode", () => {
    const mainRoute = fakeMainRoute({ profile: { ...fakeMainRoute().profile, supportsVision: false } });
    const models = [
      fakeModelProfile({ provider: "openai", id: "gpt-4o-mini", supportsVision: false }),
    ];
    const result = resolveAuxiliaryModelRoute("vision", { provider: "auto" }, {
      mainRoute,
      providerRegistry: fakeRegistry(models),
      providerModels: models,
    });
    expect(result.route).toBeUndefined();
    expect(result.diagnostics.some((d) => d.includes("No configured model matches"))).toBe(true);
  });

  it("assessor exists as the structured security-assessor route", () => {
    const mainRoute = fakeMainRoute({ profile: { ...fakeMainRoute().profile, supportsStructuredOutput: true } });
    const result = resolveAuxiliaryModelRoute("assessor", { provider: "auto" }, {
      mainRoute,
      providerRegistry: fakeRegistry(),
    });
    expect(result.source).toBe("auto-main");
    expect(result.route).toBe(mainRoute);
    expect(result.fallbackToMain).toBe(false);
  });

  it("assessor task requires structured output capability", () => {
    const mainRoute = fakeMainRoute({ profile: { ...fakeMainRoute().profile, supportsStructuredOutput: false } });
    const models = [
      fakeModelProfile({ provider: "openai", id: "gpt-4o-mini", supportsStructuredOutput: false }),
    ];
    const result = resolveAuxiliaryModelRoute("assessor", { provider: "auto" }, {
      mainRoute,
      providerRegistry: fakeRegistry(models),
      providerModels: models,
    });
    expect(result.route).toBeUndefined();
    expect(result.diagnostics.some((d) => d.includes("No configured model matches"))).toBe(true);
  });

  it("profile_context exists as a structured auxiliary route", () => {
    const mainRoute = fakeMainRoute({ profile: { ...fakeMainRoute().profile, supportsStructuredOutput: true } });
    const result = resolveAuxiliaryModelRoute("profile_context", { provider: "auto" }, {
      mainRoute,
      providerRegistry: fakeRegistry(),
    });
    expect(result.source).toBe("auto-main");
    expect(result.route).toBe(mainRoute);
    expect(result.fallbackToMain).toBe(false);
  });

  it("rejects approval as an auxiliary route", () => {
    expect(() => resolveAuxiliaryModelRoute("approval" as any, { provider: "auto" }, {
      mainRoute: fakeMainRoute(),
      providerRegistry: fakeRegistry(),
    })).toThrow("Unsupported auxiliary model task 'approval'");
  });

  it("includes diagnostic metadata explaining resolution path", () => {
    const result = resolveAuxiliaryModelRoute("assessor", { provider: "main" }, {
      mainRoute: fakeMainRoute(),
      providerRegistry: fakeRegistry(),
    });
    expect(result.diagnostics).toContain("Using main model route");
  });
});

describe("AuxiliaryModelTask coverage", () => {
  it("keeps existing auxiliary task names routable", () => {
    const existingTasks: AuxiliaryModelTask[] = [
      "vision",
      "compression",
      "web_extract",
      "session_search",
      "mcp",
      "memory_flush",
      "delegation",
      "skills_library",
      "title_generation",
      "curator",
      "memory_compaction",
    ];

    for (const task of existingTasks) {
      expect(() => resolveAuxiliaryModelRoute(task, { provider: "auto" }, {
        mainRoute: fakeMainRoute(),
        providerRegistry: fakeRegistry(),
      })).not.toThrow();
    }
  });
});

describe("resolveAllAuxiliaryRoutes", () => {
  it("resolves all configured tasks", async () => {
    const mainRoute = fakeMainRoute();
    const models = [
      fakeModelProfile({ provider: "openai", id: "gpt-4o-mini", supportsVision: true }),
    ];
    const registry = fakeRegistry(models);
    const config = {
      vision: { provider: "auto", enabled: true },
      assessor: { provider: "main", enabled: true },
    };
    const results = await resolveAllAuxiliaryRoutes(config, {
      mainRoute,
      providerRegistry: registry,
    });
    expect(results.length).toBe(2);
    expect(results.find((r) => r.task === "vision")?.source).toBe("auto-main");
    expect(results.find((r) => r.task === "assessor")?.source).toBe("main");
  });

  it("excludes default as a task route while applying default inheritance", async () => {
    const mainRoute = fakeMainRoute();
    const registry = fakeRegistry();
    const results = await resolveAllAuxiliaryRoutes({
      default: { provider: "openai", id: "gpt-4.1-mini", fallbackToMain: true },
      compression: { contextWindowTokens: 64_000 },
    }, {
      mainRoute,
      providerRegistry: registry,
    });
    expect(results.map((r) => r.task)).toEqual(["compression"]);
    expect(results[0]!.route?.provider).toBe("openai");
    expect(results[0]!.route?.id).toBe("gpt-4.1-mini");
    expect(results[0]!.route?.contextWindowTokens).toBe(64_000);
    expect(results[0]!.fallbackToMain).toBe(true);
  });
});
