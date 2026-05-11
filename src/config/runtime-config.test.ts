import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadRuntimeConfig, loadUserRuntimeConfig, loadTrustedRuntimeConfig, mergeConfig, normalizeAuxiliaryModels, saveRuntimeConfig } from "./runtime-config.js";
import { readFile } from "node:fs/promises";

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
    await mkdir(join(workspace, ".estacoda"), { recursive: true });
    const configPath = join(workspace, ".estacoda", "config.json");
    await writeFile(configPath, JSON.stringify({ model: { provider: "openai", id: "gpt-4o" } }));

    const loaded = await loadRuntimeConfig({
      workspaceRoot: workspace,
      userConfigPath: join(workspace, "nonexistent-user-config.json"),
      projectConfigTrust: "trusted"
    });

    expect(loaded.auxiliaryModels).toBeDefined();
    expect(loaded.auxiliaryModels.vision).toEqual({ provider: "auto", enabled: true });
    expect(loaded.auxiliaryModels.approval).toEqual({ provider: "auto", enabled: true });
  });

  it("ignores deprecated auxiliaryProviders without migrating and strips on save", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "estacoda-config-test-"));
    await mkdir(join(workspace, ".estacoda"), { recursive: true });
    const configPath = join(workspace, ".estacoda", "config.json");
    await writeFile(configPath, JSON.stringify({
      model: { provider: "openai", id: "gpt-4o" },
      auxiliaryProviders: { vision: { requireVision: true } }
    }));

    const loaded = await loadRuntimeConfig({
      workspaceRoot: workspace,
      userConfigPath: join(workspace, "nonexistent-user-config.json"),
      projectConfigTrust: "trusted"
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
    await mkdir(join(workspace, ".estacoda"), { recursive: true });
    const configPath = join(workspace, ".estacoda", "config.json");
    await writeFile(configPath, JSON.stringify({
      model: { provider: "openai", id: "gpt-4o" },
      channels: { discord: { enabled: true, botTokenEnv: "DISCORD_BOT_TOKEN" } }
    }));

    const loaded = await loadRuntimeConfig({ workspaceRoot: workspace, userConfigPath: join(workspace, "nonexistent-user-config.json"), projectConfigTrust: "trusted" });
    expect(loaded.channels.discord.ready).toBe(true);
    expect(loaded.channels.discord.missing).toBeUndefined();
    await rm(workspace, { recursive: true, force: true });
  });

  it("discord not ready when enabled but botTokenEnv missing", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "estacoda-config-test-"));
    await mkdir(join(workspace, ".estacoda"), { recursive: true });
    const configPath = join(workspace, ".estacoda", "config.json");
    await writeFile(configPath, JSON.stringify({
      model: { provider: "openai", id: "gpt-4o" },
      channels: { discord: { enabled: true } }
    }));

    const loaded = await loadRuntimeConfig({ workspaceRoot: workspace, userConfigPath: join(workspace, "nonexistent-user-config.json"), projectConfigTrust: "trusted" });
    expect(loaded.channels.discord.ready).toBe(false);
    expect(loaded.channels.discord.missing).toContain("botTokenEnv");
    await rm(workspace, { recursive: true, force: true });
  });

  it("email ready = enabled && required config present", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "estacoda-config-test-"));
    await mkdir(join(workspace, ".estacoda"), { recursive: true });
    const configPath = join(workspace, ".estacoda", "config.json");
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

    const loaded = await loadRuntimeConfig({ workspaceRoot: workspace, userConfigPath: join(workspace, "nonexistent-user-config.json"), projectConfigTrust: "trusted" });
    expect(loaded.channels.email.ready).toBe(true);
    expect(loaded.channels.email.missing).toBeUndefined();
    await rm(workspace, { recursive: true, force: true });
  });

  it("email not ready when enabled but required config missing", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "estacoda-config-test-"));
    await mkdir(join(workspace, ".estacoda"), { recursive: true });
    const configPath = join(workspace, ".estacoda", "config.json");
    await writeFile(configPath, JSON.stringify({
      model: { provider: "openai", id: "gpt-4o" },
      channels: { email: { enabled: true } }
    }));

    const loaded = await loadRuntimeConfig({ workspaceRoot: workspace, userConfigPath: join(workspace, "nonexistent-user-config.json"), projectConfigTrust: "trusted" });
    expect(loaded.channels.email.ready).toBe(false);
    expect(loaded.channels.email.missing).toEqual(["imapHost", "smtpHost", "username", "passwordEnv", "ownAddress"]);
    await rm(workspace, { recursive: true, force: true });
  });

  it("whatsapp ready = enabled && experimental true", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "estacoda-config-test-"));
    await mkdir(join(workspace, ".estacoda"), { recursive: true });
    const configPath = join(workspace, ".estacoda", "config.json");
    await writeFile(configPath, JSON.stringify({
      model: { provider: "openai", id: "gpt-4o" },
      channels: { whatsapp: { enabled: true, experimental: true } }
    }));

    const loaded = await loadRuntimeConfig({ workspaceRoot: workspace, userConfigPath: join(workspace, "nonexistent-user-config.json"), projectConfigTrust: "trusted" });
    expect(loaded.channels.whatsapp.ready).toBe(true);
    expect(loaded.channels.whatsapp.missing).toBeUndefined();
    await rm(workspace, { recursive: true, force: true });
  });

  it("whatsapp not ready when enabled but experimental false", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "estacoda-config-test-"));
    await mkdir(join(workspace, ".estacoda"), { recursive: true });
    const configPath = join(workspace, ".estacoda", "config.json");
    await writeFile(configPath, JSON.stringify({
      model: { provider: "openai", id: "gpt-4o" },
      channels: { whatsapp: { enabled: true, experimental: false } }
    }));

    const loaded = await loadRuntimeConfig({ workspaceRoot: workspace, userConfigPath: join(workspace, "nonexistent-user-config.json"), projectConfigTrust: "trusted" });
    expect(loaded.channels.whatsapp.ready).toBe(false);
    expect(loaded.channels.whatsapp.missing).toContain("experimental");
    await rm(workspace, { recursive: true, force: true });
  });
});

describe("loadRuntimeConfig modelFallbackRoutes resolution", () => {
  it("resolves explicit fallback routes with provider defaults and overrides", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "estacoda-config-test-"));
    await mkdir(join(workspace, ".estacoda"), { recursive: true });
    const configPath = join(workspace, ".estacoda", "config.json");

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
      userConfigPath: join(workspace, "nonexistent-user-config.json"),
      projectConfigTrust: "trusted"
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
    await mkdir(join(workspace, ".estacoda"), { recursive: true });
    const configPath = join(workspace, ".estacoda", "config.json");

    const config = {
      model: {
        provider: "openai",
        id: "gpt-4o"
      }
    };

    await writeFile(configPath, JSON.stringify(config));

    const loaded = await loadRuntimeConfig({
      workspaceRoot: workspace,
      userConfigPath: join(workspace, "nonexistent-user-config.json"),
      projectConfigTrust: "trusted"
    });

    expect(loaded.modelFallbackRoutes).toEqual([]);
  });

  it("deduplicates fallback routes that match the primary route", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "estacoda-config-test-"));
    await mkdir(join(workspace, ".estacoda"), { recursive: true });
    const configPath = join(workspace, ".estacoda", "config.json");

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
      userConfigPath: join(workspace, "nonexistent-user-config.json"),
      projectConfigTrust: "trusted"
    });

    expect(loaded.modelFallbackRoutes.length).toBe(1);
    expect(loaded.modelFallbackRoutes[0].provider).toBe("deepseek");
  });
});

describe("loadUserRuntimeConfig trust isolation", () => {
  it("excludes project-defined MCP servers when untrusted", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "estacoda-config-test-"));
    await mkdir(join(workspace, ".estacoda"), { recursive: true });
    const projectConfigPath = join(workspace, ".estacoda", "config.json");
    await writeFile(projectConfigPath, JSON.stringify({
      model: { provider: "openai", id: "gpt-4o" },
      mcpServers: { test: { command: "echo", args: ["hello"] } }
    }));

    const loaded = await loadUserRuntimeConfig({ workspaceRoot: workspace });
    expect(loaded.mcp.servers).toEqual({});
    await rm(workspace, { recursive: true, force: true });
  });

  it("excludes project-defined custom providers when untrusted", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "estacoda-config-test-"));
    await mkdir(join(workspace, ".estacoda"), { recursive: true });
    const projectConfigPath = join(workspace, ".estacoda", "config.json");
    await writeFile(projectConfigPath, JSON.stringify({
      model: { provider: "openai", id: "gpt-4o" },
      providers: { custom: { kind: "openai-compatible", baseUrl: "https://custom.example.com/v1" } }
    }));

    const loaded = await loadUserRuntimeConfig({ workspaceRoot: workspace });
    expect(loaded.providerRegistry.get("custom")).toBeUndefined();
    await rm(workspace, { recursive: true, force: true });
  });

  it("does not throw when project config is invalid JSON", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "estacoda-config-test-"));
    await mkdir(join(workspace, ".estacoda"), { recursive: true });
    const projectConfigPath = join(workspace, ".estacoda", "config.json");
    await writeFile(projectConfigPath, "this is not json");

    const loaded = await loadUserRuntimeConfig({ workspaceRoot: workspace });
    expect(loaded.model.provider).toBe("unconfigured");
    await rm(workspace, { recursive: true, force: true });
  });

  it("excludes project MCP servers so runtime cannot spawn them", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "estacoda-config-test-"));
    await mkdir(join(workspace, ".estacoda"), { recursive: true });
    const markerPath = join(workspace, "marker.txt");
    const projectConfigPath = join(workspace, ".estacoda", "config.json");
    await writeFile(projectConfigPath, JSON.stringify({
      model: { provider: "openai", id: "gpt-4o" },
      mcpServers: {
        marker: {
          command: "sh",
          args: ["-c", `touch "${markerPath}"`]
        }
      }
    }));

    const loaded = await loadUserRuntimeConfig({ workspaceRoot: workspace });
    expect(Object.keys(loaded.mcp.servers)).toEqual([]);
    await rm(workspace, { recursive: true, force: true });
  });
});

describe("loadTrustedRuntimeConfig trust inclusion", () => {
  it("includes project-defined MCP servers when trusted", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "estacoda-config-test-"));
    await mkdir(join(workspace, ".estacoda"), { recursive: true });
    const projectConfigPath = join(workspace, ".estacoda", "config.json");
    await writeFile(projectConfigPath, JSON.stringify({
      model: { provider: "openai", id: "gpt-4o" },
      mcpServers: { test: { command: "echo", args: ["hello"] } }
    }));

    const loaded = await loadTrustedRuntimeConfig({ workspaceRoot: workspace });
    expect(loaded.mcp.servers).toHaveProperty("test");
    expect(loaded.mcp.servers.test.command).toBe("echo");
    await rm(workspace, { recursive: true, force: true });
  });

  it("includes project-defined custom providers when trusted", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "estacoda-config-test-"));
    await mkdir(join(workspace, ".estacoda"), { recursive: true });
    const projectConfigPath = join(workspace, ".estacoda", "config.json");
    await writeFile(projectConfigPath, JSON.stringify({
      model: { provider: "openai", id: "gpt-4o" },
      providers: { custom: { kind: "openai-compatible", baseUrl: "https://custom.example.com/v1" } }
    }));

    const loaded = await loadTrustedRuntimeConfig({ workspaceRoot: workspace });
    const resolved = loaded.providerRegistry.get("custom");
    expect(resolved).toBeDefined();
    await rm(workspace, { recursive: true, force: true });
  });
});

describe("loadRuntimeConfig fail-closed behavior", () => {
  it("does not load project config when projectConfigTrust is omitted", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "estacoda-config-test-"));
    await mkdir(join(workspace, ".estacoda"), { recursive: true });
    const projectConfigPath = join(workspace, ".estacoda", "config.json");
    await writeFile(projectConfigPath, JSON.stringify({
      model: { provider: "openai", id: "gpt-4o" }
    }));

    const loaded = await loadRuntimeConfig({
      workspaceRoot: workspace,
      userConfigPath: join(workspace, "nonexistent-user-config.json")
    });

    // Project config should be skipped when trust is omitted
    expect(loaded.model.provider).toBe("unconfigured");
    await rm(workspace, { recursive: true, force: true });
  });

  it("does not load project config when projectConfigTrust is 'untrusted'", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "estacoda-config-test-"));
    await mkdir(join(workspace, ".estacoda"), { recursive: true });
    const projectConfigPath = join(workspace, ".estacoda", "config.json");
    await writeFile(projectConfigPath, JSON.stringify({
      model: { provider: "openai", id: "gpt-4o" }
    }));

    const loaded = await loadRuntimeConfig({
      workspaceRoot: workspace,
      userConfigPath: join(workspace, "nonexistent-user-config.json"),
      projectConfigTrust: "untrusted"
    });

    expect(loaded.model.provider).toBe("unconfigured");
    await rm(workspace, { recursive: true, force: true });
  });

  it("loads project config when projectConfigTrust is 'trusted'", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "estacoda-config-test-"));
    await mkdir(join(workspace, ".estacoda"), { recursive: true });
    const projectConfigPath = join(workspace, ".estacoda", "config.json");
    await writeFile(projectConfigPath, JSON.stringify({
      model: { provider: "openai", id: "gpt-4o" }
    }));

    const loaded = await loadRuntimeConfig({
      workspaceRoot: workspace,
      userConfigPath: join(workspace, "nonexistent-user-config.json"),
      projectConfigTrust: "trusted"
    });

    expect(loaded.model.provider).toBe("openai");
    expect(loaded.model.id).toBe("gpt-4o");
    await rm(workspace, { recursive: true, force: true });
  });
});

describe("production loadRuntimeConfig callsite safety", () => {
  it("has no production loadRuntimeConfig calls that omit projectConfigTrust and are not wrappers", async () => {
    const { execSync } = await import("node:child_process");
    const repoRoot = new URL("../..", import.meta.url).pathname;
    const output = execSync(
      `rg "loadRuntimeConfig\\(" src --type ts -n | grep -v "\\.test\\." | grep -v "_legacy" | grep -v "src/config/runtime-config.ts:"`,
      { cwd: repoRoot, encoding: "utf8" }
    );
    const lines = output.trim().split("\n").filter((line) => line.length > 0);

    const unsafe = lines.filter((line) => {
      // Allow wrapper definitions in runtime-config.ts
      if (line.includes("src/config/runtime-config.ts:")) return false;
      // Allow calls that pass 'options' (types carry projectConfigTrust)
      if (line.includes("loadRuntimeConfig(options)")) return false;
      // Allow calls that explicitly pass projectConfigTrust
      if (line.includes("projectConfigTrust")) return false;
      return true;
    });

    expect(unsafe).toEqual([]);
  });
});
