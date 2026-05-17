import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readdir, readFile, writeFile, rm } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { tmpdir } from "node:os";
import { loadRuntimeConfig, loadUserRuntimeConfig, loadTrustedRuntimeConfig, mergeConfig, normalizeAuxiliaryModels, saveRuntimeConfig } from "./runtime-config.js";
import { resolveProfileStateHome } from "./profile-home.js";

function profileConfigPath(homeDir: string): string {
  return resolveProfileStateHome({ homeDir, profileId: "default" }).configPath;
}

describe("normalizeAuxiliaryModels", () => {
  it("fills missing tasks with auto/enabled defaults", () => {
    const result = normalizeAuxiliaryModels({});
    expect(result.vision).toEqual({ provider: "auto", enabled: true });
    expect(result.approval).toEqual({ provider: "auto", enabled: true });
    expect(result.compression).toEqual({ provider: "auto", enabled: true });
    expect(result.mcp).toEqual({ provider: "auto", enabled: true });
    expect(result.memory_compaction).toEqual({ provider: "auto", enabled: true });
  });

  it("preserves explicitly configured fields", () => {
    const result = normalizeAuxiliaryModels({
      vision: { provider: "openai", id: "gpt-4o", enabled: false, fallbackToMain: true },
    });
    expect(result.vision).toEqual({ provider: "openai", id: "gpt-4o", enabled: false, fallbackToMain: true });
    expect(result.approval).toEqual({ provider: "auto", enabled: true });
  });

  it("does not include undefined optional fields", () => {
    const result = normalizeAuxiliaryModels({
      vision: { provider: "auto", enabled: true },
    });
    expect(Object.keys(result.vision!)).toEqual(["provider", "enabled"]);
  });
});

describe("mergeConfig auxiliaryModels", () => {
  it("deep-merges auxiliaryModels by task key", () => {
    const merged = mergeConfig(
      { auxiliaryModels: { vision: { provider: "openai", id: "gpt-4o" } } },
      { auxiliaryModels: { vision: { enabled: false } } }
    );
    expect(merged.auxiliaryModels?.vision).toEqual({ provider: "openai", id: "gpt-4o", enabled: false });
  });

  it("adds tasks from both configs", () => {
    const merged = mergeConfig(
      { auxiliaryModels: { vision: { provider: "openai" } } },
      { auxiliaryModels: { approval: { provider: "main" } } }
    );
    expect(merged.auxiliaryModels?.vision).toEqual({ provider: "openai" });
    expect(merged.auxiliaryModels?.approval).toEqual({ provider: "main" });
  });

  it("strips default-only auxiliary slots after merge", () => {
    const merged = mergeConfig(
      { auxiliaryModels: {} },
      { auxiliaryModels: {} }
    );
    expect(merged.auxiliaryModels).toBeUndefined();
  });

  it("preserves non-default slots after merge", () => {
    const merged = mergeConfig(
      { auxiliaryModels: { vision: { provider: "openai", id: "gpt-4o" } } },
      { auxiliaryModels: {} }
    );
    expect(merged.auxiliaryModels?.vision).toEqual({ provider: "openai", id: "gpt-4o" });
  });
});

describe("loadRuntimeConfig auxiliaryModels", () => {
  it("normalizes missing tasks to auto/enabled at load time", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "estacoda-config-test-"));
    await mkdir(dirname(profileConfigPath(workspace)), { recursive: true });
    const configPath = profileConfigPath(workspace);
    await writeFile(configPath, JSON.stringify({ model: { provider: "openai", id: "gpt-4o" } }));

    const loaded = await loadRuntimeConfig({
      workspaceRoot: workspace,
      homeDir: workspace
    });

    expect(loaded.auxiliaryModels).toBeDefined();
    expect(loaded.auxiliaryModels.vision).toEqual({ provider: "auto", enabled: true });
    expect(loaded.auxiliaryModels.approval).toEqual({ provider: "auto", enabled: true });
  });

  it("ignores deprecated auxiliaryProviders without migrating and strips on save", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "estacoda-config-test-"));
    await mkdir(dirname(profileConfigPath(workspace)), { recursive: true });
    const configPath = profileConfigPath(workspace);
    await writeFile(configPath, JSON.stringify({
      model: { provider: "openai", id: "gpt-4o" },
      auxiliaryProviders: { vision: { requireVision: true } }
    }));

    const loaded = await loadRuntimeConfig({
      workspaceRoot: workspace,
      homeDir: workspace
    });

    // auxiliaryProviders is not migrated into auxiliaryModels
    expect(loaded.auxiliaryModels.vision).toEqual({ provider: "auto", enabled: true });

    // auxiliaryProviders is stripped on save
    await saveRuntimeConfig(configPath, loaded.config);
    const saved = JSON.parse(await readFile(configPath, "utf8"));
    expect(saved.auxiliaryProviders).toBeUndefined();
    expect(saved.auxiliaryModels).toBeUndefined();
  });
});

describe("loadRuntimeConfig channel readiness", () => {
  it("discord ready = enabled && botTokenEnv present", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "estacoda-config-test-"));
    await mkdir(dirname(profileConfigPath(workspace)), { recursive: true });
    const configPath = profileConfigPath(workspace);
    await writeFile(configPath, JSON.stringify({
      model: { provider: "openai", id: "gpt-4o" },
      channels: { discord: { enabled: true, botTokenEnv: "DISCORD_BOT_TOKEN" } }
    }));

    const loaded = await loadRuntimeConfig({ workspaceRoot: workspace, homeDir: workspace });
    expect(loaded.channels.discord.ready).toBe(true);
    expect(loaded.channels.discord.missing).toBeUndefined();
    await rm(workspace, { recursive: true, force: true });
  });

  it("discord not ready when enabled but botTokenEnv missing", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "estacoda-config-test-"));
    await mkdir(dirname(profileConfigPath(workspace)), { recursive: true });
    const configPath = profileConfigPath(workspace);
    await writeFile(configPath, JSON.stringify({
      model: { provider: "openai", id: "gpt-4o" },
      channels: { discord: { enabled: true } }
    }));

    const loaded = await loadRuntimeConfig({ workspaceRoot: workspace, homeDir: workspace });
    expect(loaded.channels.discord.ready).toBe(false);
    expect(loaded.channels.discord.missing).toContain("botTokenEnv");
    await rm(workspace, { recursive: true, force: true });
  });

  it("email ready = enabled && required config present", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "estacoda-config-test-"));
    await mkdir(dirname(profileConfigPath(workspace)), { recursive: true });
    const configPath = profileConfigPath(workspace);
    await writeFile(configPath, JSON.stringify({
      model: { provider: "openai", id: "gpt-4o" },
      channels: {
        email: {
          enabled: true,
          imapHost: "imap.example.com",
          smtpHost: "smtp.example.com",
          username: "user",
          passwordEnv: "EMAIL_PASS",
          ownAddress: "bot@example.com"
        }
      }
    }));

    const loaded = await loadRuntimeConfig({ workspaceRoot: workspace, homeDir: workspace });
    expect(loaded.channels.email.ready).toBe(true);
    expect(loaded.channels.email.missing).toBeUndefined();
    await rm(workspace, { recursive: true, force: true });
  });

  it("email not ready when enabled but required config missing", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "estacoda-config-test-"));
    await mkdir(dirname(profileConfigPath(workspace)), { recursive: true });
    const configPath = profileConfigPath(workspace);
    await writeFile(configPath, JSON.stringify({
      model: { provider: "openai", id: "gpt-4o" },
      channels: { email: { enabled: true } }
    }));

    const loaded = await loadRuntimeConfig({ workspaceRoot: workspace, homeDir: workspace });
    expect(loaded.channels.email.ready).toBe(false);
    expect(loaded.channels.email.missing).toEqual(["imapHost", "smtpHost", "username", "passwordEnv", "ownAddress"]);
    await rm(workspace, { recursive: true, force: true });
  });

  it("whatsapp ready = enabled && experimental true", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "estacoda-config-test-"));
    await mkdir(dirname(profileConfigPath(workspace)), { recursive: true });
    const configPath = profileConfigPath(workspace);
    await writeFile(configPath, JSON.stringify({
      model: { provider: "openai", id: "gpt-4o" },
      channels: { whatsapp: { enabled: true, experimental: true } }
    }));

    const loaded = await loadRuntimeConfig({ workspaceRoot: workspace, homeDir: workspace });
    expect(loaded.channels.whatsapp.ready).toBe(true);
    expect(loaded.channels.whatsapp.missing).toBeUndefined();
    await rm(workspace, { recursive: true, force: true });
  });

  it("whatsapp not ready when enabled but experimental false", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "estacoda-config-test-"));
    await mkdir(dirname(profileConfigPath(workspace)), { recursive: true });
    const configPath = profileConfigPath(workspace);
    await writeFile(configPath, JSON.stringify({
      model: { provider: "openai", id: "gpt-4o" },
      channels: { whatsapp: { enabled: true, experimental: false } }
    }));

    const loaded = await loadRuntimeConfig({ workspaceRoot: workspace, homeDir: workspace });
    expect(loaded.channels.whatsapp.ready).toBe(false);
    expect(loaded.channels.whatsapp.missing).toContain("experimental");
    await rm(workspace, { recursive: true, force: true });
  });
});

describe("loadRuntimeConfig modelFallbackRoutes resolution", () => {
  it("resolves explicit fallback routes with provider defaults and overrides", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "estacoda-config-test-"));
    await mkdir(dirname(profileConfigPath(workspace)), { recursive: true });
    const configPath = profileConfigPath(workspace);

    const config = {
      model: {
        provider: "openai",
        id: "gpt-4o",
        fallbacks: [
          { provider: "deepseek", id: "deepseek-chat" },
          { provider: "kimi", id: "kimi-k2.5", baseUrl: "https://custom.kimi.com/v1", contextWindowTokens: 131072 }
        ]
      },
      providers: {
        deepseek: {
          kind: "catalog" as const,
          baseUrl: "https://api.deepseek.com/v1",
          apiKeyEnv: "DEEPSEEK_KEY"
        }
      }
    };

    await writeFile(configPath, JSON.stringify(config));

    const loaded = await loadRuntimeConfig({
      workspaceRoot: workspace,
      homeDir: workspace
    });

    expect(loaded.modelFallbackRoutes.length).toBe(2);

    const fb1 = loaded.modelFallbackRoutes[0];
    expect(fb1.provider).toBe("deepseek");
    expect(fb1.id).toBe("deepseek-chat");
    expect(fb1.baseUrl).toBe("https://api.deepseek.com/v1");
    expect(fb1.apiKeyEnv).toBe("DEEPSEEK_KEY");
    expect(fb1.profile.provider).toBe("deepseek");
    expect(fb1.profile.id).toBe("deepseek-chat");

    const fb2 = loaded.modelFallbackRoutes[1];
    expect(fb2.provider).toBe("kimi");
    expect(fb2.id).toBe("kimi-k2.5");
    expect(fb2.baseUrl).toBe("https://custom.kimi.com/v1");
    expect(fb2.apiKeyEnv).toBeUndefined();
    expect(fb2.contextWindowTokens).toBe(131072);
    expect(fb2.profile.provider).toBe("kimi");
    expect(fb2.profile.id).toBe("kimi-k2.5");
  });

  it("returns empty modelFallbackRoutes when no fallbacks are configured", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "estacoda-config-test-"));
    await mkdir(dirname(profileConfigPath(workspace)), { recursive: true });
    const configPath = profileConfigPath(workspace);

    const config = {
      model: {
        provider: "openai",
        id: "gpt-4o"
      }
    };

    await writeFile(configPath, JSON.stringify(config));

    const loaded = await loadRuntimeConfig({
      workspaceRoot: workspace,
      homeDir: workspace
    });

    expect(loaded.modelFallbackRoutes).toEqual([]);
  });

  it("deduplicates fallback routes that match the primary route", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "estacoda-config-test-"));
    await mkdir(dirname(profileConfigPath(workspace)), { recursive: true });
    const configPath = profileConfigPath(workspace);

    const config = {
      model: {
        provider: "openai",
        id: "gpt-4o",
        fallbacks: [
          { provider: "openai", id: "gpt-4o" },
          { provider: "deepseek", id: "deepseek-chat" }
        ]
      }
    };

    await writeFile(configPath, JSON.stringify(config));

    const loaded = await loadRuntimeConfig({
      workspaceRoot: workspace,
      homeDir: workspace
    });

    expect(loaded.modelFallbackRoutes.length).toBe(1);
    expect(loaded.modelFallbackRoutes[0].provider).toBe("deepseek");
  });

  it("enriches primaryModelRoute with apiMode from provider metadata", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "estacoda-config-test-"));
    await mkdir(dirname(profileConfigPath(workspace)), { recursive: true });
    const configPath = profileConfigPath(workspace);

    await writeFile(configPath, JSON.stringify({
      model: { provider: "openai", id: "gpt-4o" }
    }));

    const loaded = await loadRuntimeConfig({
      workspaceRoot: workspace,
      homeDir: workspace
    });

    expect(loaded.primaryModelRoute.apiMode).toBe("openai_chat_completions");
  });

  it("preserves provider-configured apiMode on primaryModelRoute", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "estacoda-config-test-"));
    await mkdir(dirname(profileConfigPath(workspace)), { recursive: true });
    const configPath = profileConfigPath(workspace);

    await writeFile(configPath, JSON.stringify({
      providers: {
        openai: {
          kind: "openai-compatible",
          apiMode: "custom_openai_compatible"
        }
      },
      model: { provider: "openai", id: "gpt-4o" }
    }));

    const loaded = await loadRuntimeConfig({
      workspaceRoot: workspace,
      homeDir: workspace
    });

    expect(loaded.primaryModelRoute.apiMode).toBe("custom_openai_compatible");
  });

  it("enriches each modelFallbackRoute with apiMode from provider metadata", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "estacoda-config-test-"));
    await mkdir(dirname(profileConfigPath(workspace)), { recursive: true });
    const configPath = profileConfigPath(workspace);

    await writeFile(configPath, JSON.stringify({
      model: {
        provider: "openai",
        id: "gpt-4o",
        fallbacks: [
          { provider: "deepseek", id: "deepseek-chat" },
          { provider: "kimi", id: "kimi-k2.5" }
        ]
      }
    }));

    const loaded = await loadRuntimeConfig({
      workspaceRoot: workspace,
      homeDir: workspace
    });

    expect(loaded.modelFallbackRoutes.length).toBe(2);
    expect(loaded.modelFallbackRoutes[0].apiMode).toBe("openai_chat_completions");
    expect(loaded.modelFallbackRoutes[1].apiMode).toBe("openai_chat_completions");
  });

  it("preserves explicit apiMode on a route and does not overwrite it", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "estacoda-config-test-"));
    await mkdir(dirname(profileConfigPath(workspace)), { recursive: true });
    const configPath = profileConfigPath(workspace);

    // This test uses a synthetic scenario where the runtime already has an
    // explicit apiMode set on the route object (e.g. from a future caller).
    // The helper must preserve it.
    const { buildResolvedModelRoute } = await import("../providers/provider-metadata.js");
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

  it("does not expose raw secrets during route normalization", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "estacoda-config-test-"));
    await mkdir(dirname(profileConfigPath(workspace)), { recursive: true });
    const configPath = profileConfigPath(workspace);

    await writeFile(configPath, JSON.stringify({
      model: { provider: "openai", id: "gpt-4o" },
      providers: {
        openai: {
          kind: "catalog" as const,
          baseUrl: "https://api.openai.com/v1",
          apiKeyEnv: "OPENAI_API_KEY"
        }
      }
    }));

    const loaded = await loadRuntimeConfig({
      workspaceRoot: workspace,
      homeDir: workspace
    });

    // apiKeyEnv is a reference name, not the secret value
    expect(loaded.primaryModelRoute.apiKeyEnv).toBe("OPENAI_API_KEY");
    expect(loaded.config.providers?.openai?.apiKeyEnv).toBe("OPENAI_API_KEY");
    // No raw secret should ever appear on the route
    expect(loaded.primaryModelRoute).not.toHaveProperty("apiKey");
  });
});

describe("loadRuntimeConfig media boundary", () => {
  it("keeps voice and image-generation config separate from LLM route normalization", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "estacoda-config-test-"));
    await mkdir(dirname(profileConfigPath(workspace)), { recursive: true });
    const configPath = profileConfigPath(workspace);

    await writeFile(configPath, JSON.stringify({
      model: { provider: "openai", id: "gpt-4o" },
      imageGen: {
        enabled: true,
        provider: "fal",
        model: "fal-ai/flux/dev"
      },
      tts: {
        enabled: true,
        provider: "edge",
        voice: "en-US-AriaNeural"
      },
      stt: {
        enabled: true,
        provider: "groq",
        model: "whisper-large-v3"
      }
    }));

    const loaded = await loadRuntimeConfig({
      workspaceRoot: workspace,
      homeDir: workspace
    });

    // LLM route should not absorb media config
    expect(loaded.primaryModelRoute.provider).toBe("openai");
    expect(loaded.primaryModelRoute.id).toBe("gpt-4o");

    // Media config remains on the raw config object
    expect(loaded.config.imageGen).toEqual({
      enabled: true,
      provider: "fal",
      model: "fal-ai/flux/dev"
    });
    expect(loaded.config.tts).toEqual({
      enabled: true,
      provider: "edge",
      voice: "en-US-AriaNeural"
    });
    expect(loaded.config.stt).toEqual({
      enabled: true,
      provider: "groq",
      model: "whisper-large-v3"
    });
  });
});

describe("loadRuntimeConfig profile loading", () => {
  it("loads exactly the selected profile config", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "estacoda-config-test-"));
    await mkdir(dirname(profileConfigPath(workspace)), { recursive: true });
    await writeFile(profileConfigPath(workspace), JSON.stringify({
      model: { provider: "project", id: "project-model" }
    }));
    await mkdir(join(workspace, ".estacoda", "profiles", "default"), { recursive: true });
    await writeFile(profileConfigPath(workspace), JSON.stringify({
      model: { provider: "openai", id: "gpt-4o" },
      mcpServers: { test: { command: "echo", args: ["hello"] } }
    }));

    const loaded = await loadRuntimeConfig({ workspaceRoot: workspace, homeDir: workspace });

    expect(loaded.sources).toEqual([profileConfigPath(workspace)]);
    expect(loaded.model.provider).toBe("openai");
    expect(loaded.model.id).toBe("gpt-4o");
    expect(loaded.mcp.servers).toHaveProperty("test");
    await rm(workspace, { recursive: true, force: true });
  });

  it("legacy trust wrappers load the same selected profile config", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "estacoda-config-test-"));
    await mkdir(join(workspace, ".estacoda", "profiles", "default"), { recursive: true });
    await writeFile(profileConfigPath(workspace), JSON.stringify({
      model: { provider: "openai", id: "gpt-4o" }
    }));

    const userLoaded = await loadUserRuntimeConfig({ workspaceRoot: workspace, homeDir: workspace });
    const trustedLoaded = await loadTrustedRuntimeConfig({ workspaceRoot: workspace, homeDir: workspace });

    expect(userLoaded.sources).toEqual([profileConfigPath(workspace)]);
    expect(trustedLoaded.sources).toEqual([profileConfigPath(workspace)]);
    expect(userLoaded.model.provider).toBe("openai");
    expect(trustedLoaded.model.provider).toBe("openai");
    await rm(workspace, { recursive: true, force: true });
  });

  it("ignores invalid workspace project config", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "estacoda-config-test-"));
    await mkdir(join(workspace, ".estacoda", "profiles", "default"), { recursive: true });
    await writeFile(profileConfigPath(workspace), "this is not json");
    await writeFile(profileConfigPath(workspace), JSON.stringify({
      model: { provider: "openai", id: "gpt-4o" }
    }));

    const loaded = await loadRuntimeConfig({ workspaceRoot: workspace, homeDir: workspace });

    expect(loaded.model.provider).toBe("openai");
    expect(loaded.sources).toEqual([profileConfigPath(workspace)]);
    await rm(workspace, { recursive: true, force: true });
  });
});

describe("buildProviderRegistry custom provider baseUrl behavior", () => {
  it("custom provider without baseUrl does not register an executable OpenAI-compatible adapter", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "estacoda-config-test-"));
    await mkdir(dirname(profileConfigPath(workspace)), { recursive: true });
    await writeFile(profileConfigPath(workspace), JSON.stringify({
      providers: {
        "custom-corp": {
          kind: "openai-compatible",
          models: ["custom-model"]
        }
      }
    }));

    const loaded = await loadRuntimeConfig({
      workspaceRoot: workspace,
      homeDir: workspace
    });

    const adapter = loaded.providerRegistry.get("custom-corp");
    expect(adapter).toBeUndefined();
    await rm(workspace, { recursive: true, force: true });
  });

  it("custom provider with explicit baseUrl registers executable adapter", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "estacoda-config-test-"));
    await mkdir(dirname(profileConfigPath(workspace)), { recursive: true });
    await writeFile(profileConfigPath(workspace), JSON.stringify({
      providers: {
        "custom-corp": {
          kind: "openai-compatible",
          baseUrl: "https://custom.corp.com/v1",
          models: ["custom-model"]
        }
      }
    }));

    const loaded = await loadRuntimeConfig({
      workspaceRoot: workspace,
      homeDir: workspace
    });

    const adapter = loaded.providerRegistry.get("custom-corp");
    expect(adapter).toBeDefined();
    await rm(workspace, { recursive: true, force: true });
  });

  it("known provider without explicit baseUrl registers executable adapter with metadata default", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "estacoda-config-test-"));
    await mkdir(dirname(profileConfigPath(workspace)), { recursive: true });
    await writeFile(profileConfigPath(workspace), JSON.stringify({
      providers: {
        openai: {
          kind: "openai-compatible",
          models: ["gpt-4o"]
        }
      }
    }));

    const loaded = await loadRuntimeConfig({
      workspaceRoot: workspace,
      homeDir: workspace
    });

    const adapter = loaded.providerRegistry.get("openai");
    expect(adapter).toBeDefined();
    await rm(workspace, { recursive: true, force: true });
  });

  it("loadRuntimeConfig primary route for custom provider without baseUrl has baseUrl === undefined", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "estacoda-config-test-"));
    await mkdir(dirname(profileConfigPath(workspace)), { recursive: true });
    await writeFile(profileConfigPath(workspace), JSON.stringify({
      model: { provider: "custom-corp", id: "custom-model" },
      providers: {
        "custom-corp": {
          kind: "openai-compatible",
          models: ["custom-model"]
        }
      }
    }));

    const loaded = await loadRuntimeConfig({
      workspaceRoot: workspace,
      homeDir: workspace
    });

    expect(loaded.primaryModelRoute.baseUrl).toBeUndefined();
    await rm(workspace, { recursive: true, force: true });
  });

  it("no placeholder endpoint is used for runtime execution", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "estacoda-config-test-"));
    await mkdir(dirname(profileConfigPath(workspace)), { recursive: true });
    await writeFile(profileConfigPath(workspace), JSON.stringify({
      providers: {
        "custom-corp": {
          kind: "openai-compatible",
          models: ["custom-model"]
        }
      }
    }));

    const loaded = await loadRuntimeConfig({
      workspaceRoot: workspace,
      homeDir: workspace
    });

    const json = JSON.stringify(loaded);
    expect(json).not.toContain("https://example.invalid/v1");
    await rm(workspace, { recursive: true, force: true });
  });

  it("openai_responses adapter is registered for providers with matching metadata apiMode", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "estacoda-config-test-"));
    await mkdir(dirname(profileConfigPath(workspace)), { recursive: true });
    await writeFile(profileConfigPath(workspace), JSON.stringify({
      providers: {
        codex: {
          kind: "openai-compatible",
          models: ["codex-model"]
        }
      }
    }));

    const loaded = await loadRuntimeConfig({
      workspaceRoot: workspace,
      homeDir: workspace
    });

    const adapter = loaded.providerRegistry.get("codex");
    expect(adapter).toBeDefined();
    expect(adapter?.name).toContain("Responses");
    await rm(workspace, { recursive: true, force: true });
  });

  it("setup-generated Codex config round-trips to Responses adapter", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "estacoda-config-test-"));
    await mkdir(dirname(profileConfigPath(workspace)), { recursive: true });
    // Exact shape emitted by model-setup-codex.ts (no kind field)
    await writeFile(profileConfigPath(workspace), JSON.stringify({
      model: { provider: "codex", id: "o3" },
      providers: {
        codex: {
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authMethod: "oauth_device_pkce"
        }
      }
    }));

    const loaded = await loadRuntimeConfig({
      workspaceRoot: workspace,
      homeDir: workspace
    });

    // 1. Adapter is registered
    const adapter = loaded.providerRegistry.get("codex");
    expect(adapter).toBeDefined();
    expect(adapter?.name).toContain("Responses");

    // 2. Codex is runnable in metadata after Stage 6 flip
    const { getProviderMetadata } = await import("../providers/provider-metadata.js");
    const metadata = getProviderMetadata("codex");
    expect(metadata.runnable).toBe(true);

    // 3. Without OAuth credential, executor rejects with auth error (not unsupported)
    const { ProviderExecutor } = await import("../providers/provider-executor.js");
    const executor = new ProviderExecutor({
      registry: loaded.providerRegistry
    });

    const route = loaded.primaryModelRoute;
    expect(route.apiMode).toBe("openai_responses");

    const result = await executor.complete({ messages: [] }, {}, { primaryRoute: route });
    expect(result.ok).toBe(false);
    expect(result.attempts.length).toBe(1);
    expect(result.attempts[0].errorClass).toBe("auth");
    expect(result.attempts[0].content).toContain("requires OAuth authentication");

    await rm(workspace, { recursive: true, force: true });
  });
});

describe("modelAliases normalization", () => {
  it("merges model_aliases into canonical modelAliases", async () => {
    const { mergeConfig } = await import("./runtime-config.js");
    const merged = mergeConfig(
      { model_aliases: { qwen: { provider: "local", model: "qwen2.5" } } },
      { modelAliases: { gpt4: { provider: "openai", model: "gpt-4o" } } }
    );
    expect(merged.modelAliases).toBeDefined();
    expect(merged.modelAliases?.qwen).toEqual({ provider: "local", model: "qwen2.5" });
    expect(merged.modelAliases?.gpt4).toEqual({ provider: "openai", model: "gpt-4o" });
    expect(merged.model_aliases).toBeUndefined();
  });

  it("loads model_aliases input into canonical modelAliases", async () => {
    const { loadRuntimeConfig } = await import("./runtime-config.js");
    const workspace = await mkdtemp(join(tmpdir(), "estacoda-config-alias-test-"));
    await mkdir(dirname(profileConfigPath(workspace)), { recursive: true });
    await writeFile(profileConfigPath(workspace), JSON.stringify({
      model_aliases: {
        myllm: { provider: "local", model: "llama3" }
      }
    }));

    const loaded = await loadRuntimeConfig({
      workspaceRoot: workspace,
      homeDir: workspace
    });

    expect(loaded.config.modelAliases?.myllm).toEqual({ provider: "local", model: "llama3" });
    await rm(workspace, { recursive: true, force: true });
  });

  it("saves config with canonical modelAliases, not model_aliases", async () => {
    const { saveRuntimeConfig } = await import("./runtime-config.js");
    const workspace = await mkdtemp(join(tmpdir(), "estacoda-config-save-alias-test-"));
    await mkdir(dirname(profileConfigPath(workspace)), { recursive: true });
    const configPath = profileConfigPath(workspace);

    await saveRuntimeConfig(configPath, {
      modelAliases: {
        qwen: { provider: "local", model: "qwen2.5" }
      }
    });

    const raw = await readFile(configPath, "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed.modelAliases).toBeDefined();
    expect(parsed.model_aliases).toBeUndefined();
    await rm(workspace, { recursive: true, force: true });
  });
});

describe("OAuth store config boundary", () => {
  it("saveRuntimeConfig output never contains raw OAuth token fields", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "estacoda-config-oauth-boundary-test-"));
    await mkdir(dirname(profileConfigPath(workspace)), { recursive: true });
    const configPath = profileConfigPath(workspace);

    const config = {
      model: { provider: "openai", id: "gpt-4o" },
      providers: {
        openai: {
          kind: "openai-compatible" as const,
          apiKeyEnv: "OPENAI_API_KEY"
        }
      }
    };

    await saveRuntimeConfig(configPath, config);
    const raw = await readFile(configPath, "utf8");

    expect(raw).not.toContain("accessToken");
    expect(raw).not.toContain("refreshToken");
    expect(raw).not.toContain("auth.json");
    await rm(workspace, { recursive: true, force: true });
  });
});

async function findProductionTypeScriptFiles(repoRoot: string): Promise<string[]> {
  const files: string[] = [];

  for (const root of ["src", "scripts"]) {
    await collectTypeScriptFiles(join(repoRoot, root), repoRoot, files);
  }

  return files.sort();
}

async function collectTypeScriptFiles(directory: string, repoRoot: string, files: string[]): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      await collectTypeScriptFiles(fullPath, repoRoot, files);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }

    const relativePath = relative(repoRoot, fullPath).split(sep).join("/");
    if (!relativePath.endsWith(".ts")) {
      continue;
    }
    if (relativePath.endsWith(".test.ts")) {
      continue;
    }
    if (relativePath.includes("_legacy")) {
      continue;
    }
    if (relativePath === "src/config/runtime-config.ts") {
      continue;
    }

    files.push(relativePath);
  }
}

function collectLoadRuntimeConfigCalls(source: string): Array<{ start: number; call: string }> {
  const calls: Array<{ start: number; call: string }> = [];
  const needle = "loadRuntimeConfig(";
  let searchFrom = 0;
  while (true) {
    const start = source.indexOf(needle, searchFrom);
    if (start === -1) break;
    const end = findMatchingCallEnd(source, start + "loadRuntimeConfig".length);
    if (end !== -1) {
      calls.push({ start, call: source.slice(start, end + 1) });
      searchFrom = end + 1;
    } else {
      searchFrom = start + needle.length;
    }
  }
  return calls;
}

function findMatchingCallEnd(source: string, openParen: number): number {
  let depth = 0;
  let quote: "'" | "\"" | "`" | undefined;
  let lineComment = false;
  let blockComment = false;

  for (let index = openParen; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];

    if (lineComment) {
      if (char === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote !== undefined) {
      if (char === "\\") {
        index += 1;
        continue;
      }
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (char === "'" || char === "\"" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "(") {
      depth += 1;
      continue;
    }
    if (char === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }

  return -1;
}

function lineNumberAt(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (source[index] === "\n") line += 1;
  }
  return line;
}
