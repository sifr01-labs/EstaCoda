import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readdir, readFile, writeFile, rm } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { tmpdir } from "node:os";
import {
  loadRuntimeConfig,
  normalizeAuxiliaryModels,
  normalizeExternalMemoryConfig,
  normalizeSessionCompressionConfig,
  redactExternalMemoryConfig,
  saveRuntimeConfig,
  setupAuxiliaryModelConfig,
  setupVoiceConfig
} from "./runtime-config.js";
import { resolveProfileStateHome } from "./profile-home.js";

function profileConfigPath(homeDir: string): string {
  return resolveProfileStateHome({ homeDir, profileId: "default" }).configPath;
}

async function withAllowPrivateUrlsEnv<T>(value: string | undefined, run: () => Promise<T>): Promise<T> {
  const previous = process.env.ESTACODA_ALLOW_PRIVATE_URLS;
  if (value === undefined) {
    delete process.env.ESTACODA_ALLOW_PRIVATE_URLS;
  } else {
    process.env.ESTACODA_ALLOW_PRIVATE_URLS = value;
  }

  try {
    return await run();
  } finally {
    if (previous === undefined) {
      delete process.env.ESTACODA_ALLOW_PRIVATE_URLS;
    } else {
      process.env.ESTACODA_ALLOW_PRIVATE_URLS = previous;
    }
  }
}

async function withHomeEnv<T>(
  env: { HOME?: string; ESTACODA_HOME?: string },
  run: () => Promise<T>
): Promise<T> {
  const previousHome = process.env.HOME;
  const previousEstacodaHome = process.env.ESTACODA_HOME;

  if (env.HOME === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = env.HOME;
  }

  if (env.ESTACODA_HOME === undefined) {
    delete process.env.ESTACODA_HOME;
  } else {
    process.env.ESTACODA_HOME = env.ESTACODA_HOME;
  }

  try {
    return await run();
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
  }
}

describe("normalizeAuxiliaryModels", () => {
  it("fills missing tasks with auto/enabled defaults", () => {
    const result = normalizeAuxiliaryModels({});
    expect(result.vision).toEqual({ provider: "auto", enabled: true });
    expect(result.assessor).toEqual({ provider: "auto", enabled: true });
    expect(result.compression).toEqual({ provider: "auto", enabled: true });
    expect(result.mcp).toEqual({ provider: "auto", enabled: true });
    expect(result.memory_compaction).toEqual({ provider: "auto", enabled: true });
    expect(result.profile_context).toEqual({ provider: "auto", enabled: true });
  });

  it("preserves explicitly configured fields", () => {
    const result = normalizeAuxiliaryModels({
      vision: { provider: "openai", id: "gpt-4o", enabled: false, fallbackToMain: true },
    });
    expect(result.vision).toEqual({ provider: "openai", id: "gpt-4o", enabled: false, fallbackToMain: true });
    expect(result.assessor).toEqual({ provider: "auto", enabled: true });
  });

  it("does not include undefined optional fields", () => {
    const result = normalizeAuxiliaryModels({
      vision: { provider: "auto", enabled: true },
    });
    expect(Object.keys(result.vision!)).toEqual(["provider", "enabled"]);
  });

  it("accepts and normalizes a default auxiliary slot", () => {
    const result = normalizeAuxiliaryModels({
      default: { provider: "openai", id: "gpt-4.1-mini", timeoutMs: 5000 },
    });
    expect(result.default).toEqual({ provider: "openai", id: "gpt-4.1-mini", timeoutMs: 5000 });
    expect(result.compression).toEqual({ provider: "openai", enabled: true, id: "gpt-4.1-mini", timeoutMs: 5000 });
  });

  it("normalizes string shorthand for auxiliary slots", () => {
    const result = normalizeAuxiliaryModels({
      default: "openai/gpt-4.1-mini",
      assessor: "local/qwen2.5:3b",
    });
    expect(result.default).toEqual({ provider: "openai", id: "gpt-4.1-mini" });
    expect(result.assessor).toEqual({ provider: "local", enabled: true, id: "qwen2.5:3b" });
  });

  it("splits shorthand only on the first slash", () => {
    const result = normalizeAuxiliaryModels({
      vision: "openrouter/anthropic/claude-3.7-sonnet",
    });
    expect(result.vision).toEqual({ provider: "openrouter", enabled: true, id: "anthropic/claude-3.7-sonnet" });
  });

  it("rejects invalid shorthand with clear errors", () => {
    expect(() => normalizeAuxiliaryModels({ vision: "openai" })).toThrow("auxiliaryModels.vision shorthand must be provider/model");
    expect(() => normalizeAuxiliaryModels({ vision: "/gpt-4.1-mini" })).toThrow("auxiliaryModels.vision shorthand is missing provider before /");
    expect(() => normalizeAuxiliaryModels({ vision: "openai/" })).toThrow("auxiliaryModels.vision shorthand is missing model id after /");
  });

  it("rejects approval as an auxiliary route", () => {
    expect(() => normalizeAuxiliaryModels({
      approval: { provider: "openai", id: "gpt-4.1-mini" },
    } as any)).toThrow("Unsupported auxiliary model task 'approval'");
  });
});

describe("normalizeSessionCompressionConfig", () => {
  it("defaults semantic compression off", () => {
    expect(normalizeSessionCompressionConfig(undefined)).toEqual({
      enabled: false,
      threshold: 0.50,
      targetRatio: 0.20,
      protectFirstN: 3,
      protectLastN: 20,
      experimental: false
    });
  });

  it("does not enable compression unless experimental is true", () => {
    expect(normalizeSessionCompressionConfig({ enabled: true }).enabled).toBe(false);
    expect(normalizeSessionCompressionConfig({ enabled: true, experimental: true }).enabled).toBe(true);
  });

  it("clamps threshold and target ratio boundaries", () => {
    expect(normalizeSessionCompressionConfig({ threshold: 0.01 }).threshold).toBe(0.10);
    expect(normalizeSessionCompressionConfig({ threshold: 1 }).threshold).toBe(0.95);
    expect(normalizeSessionCompressionConfig({ threshold: 0.10 }).threshold).toBe(0.10);
    expect(normalizeSessionCompressionConfig({ threshold: 0.95 }).threshold).toBe(0.95);
    expect(normalizeSessionCompressionConfig({ targetRatio: 0.01 }).targetRatio).toBe(0.10);
    expect(normalizeSessionCompressionConfig({ targetRatio: 1 }).targetRatio).toBe(0.80);
    expect(normalizeSessionCompressionConfig({ targetRatio: 0.10 }).targetRatio).toBe(0.10);
    expect(normalizeSessionCompressionConfig({ targetRatio: 0.80 }).targetRatio).toBe(0.80);
  });

  it("normalizes protected message counts", () => {
    expect(normalizeSessionCompressionConfig({ protectFirstN: -3, protectLastN: -1 })).toMatchObject({
      protectFirstN: 0,
      protectLastN: 1
    });
    expect(normalizeSessionCompressionConfig({ protectFirstN: "4" as never, protectLastN: "9" as never })).toMatchObject({
      protectFirstN: 4,
      protectLastN: 9
    });
  });

  it("normalizes optional summary model context length only when positive numeric input is supplied", () => {
    expect(normalizeSessionCompressionConfig({ summaryModelContextLength: "128000" as never }).summaryModelContextLength).toBe(128_000);
    expect(normalizeSessionCompressionConfig({ summaryModelContextLength: 64_000 }).summaryModelContextLength).toBe(64_000);
    expect(normalizeSessionCompressionConfig({ summaryModelContextLength: -1 }).summaryModelContextLength).toBe(1);
    expect(normalizeSessionCompressionConfig({ summaryModelContextLength: true as never }).summaryModelContextLength).toBeUndefined();
    expect(normalizeSessionCompressionConfig({ summaryModelContextLength: null as never }).summaryModelContextLength).toBeUndefined();
    expect(normalizeSessionCompressionConfig({ summaryModelContextLength: [] as never }).summaryModelContextLength).toBeUndefined();
  });

  it("is NaN-safe for malformed values", () => {
    const normalized = normalizeSessionCompressionConfig({
      threshold: Number.NaN,
      targetRatio: Number.POSITIVE_INFINITY,
      protectFirstN: null as never,
      protectLastN: [] as never
    });
    expect(normalized).toMatchObject({
      threshold: 0.50,
      targetRatio: 0.20,
      protectFirstN: 3,
      protectLastN: 20
    });
  });
});

describe("normalizeExternalMemoryConfig", () => {
  it("defaults external memory providers off", () => {
    expect(normalizeExternalMemoryConfig(undefined)).toEqual({
      enabled: false,
      timeoutMs: 750,
      maxResults: 3,
      maxChars: 2500,
      mirrorWrites: false
    });
  });

  it("requires explicit enablement and provider id", () => {
    expect(normalizeExternalMemoryConfig({ enabled: true }).enabled).toBe(false);
    expect(normalizeExternalMemoryConfig({ enabled: true, provider: "test" })).toEqual({
      enabled: true,
      provider: "test",
      timeoutMs: 750,
      maxResults: 3,
      maxChars: 2500,
      mirrorWrites: false
    });
  });

  it("normalizes file-backed provider config only when configured", () => {
    expect(normalizeExternalMemoryConfig({
      enabled: true,
      provider: "file"
    })).toEqual({
      enabled: true,
      provider: "file",
      timeoutMs: 750,
      maxResults: 3,
      maxChars: 2500,
      mirrorWrites: false,
      file: {
        maxEntries: 1000
      }
    });
    expect(normalizeExternalMemoryConfig({
      enabled: true,
      provider: "file",
      file: {
        path: "notes/memory.jsonl",
        maxEntries: "20000" as never
      }
    })).toEqual({
      enabled: true,
      provider: "file",
      timeoutMs: 750,
      maxResults: 3,
      maxChars: 2500,
      mirrorWrites: false,
      file: {
        path: "notes/memory.jsonl",
        maxEntries: 10000
      }
    });
  });

  it("normalizes bounds with NaN-safe numeric coercion", () => {
    expect(normalizeExternalMemoryConfig({
      enabled: true,
      provider: "fake",
      timeoutMs: Number.POSITIVE_INFINITY,
      maxResults: "100" as never,
      maxChars: -10,
      mirrorWrites: true
    })).toEqual({
      enabled: true,
      provider: "fake",
      timeoutMs: 750,
      maxResults: 10,
      maxChars: 1,
      mirrorWrites: true
    });
  });

  it("redacts provider credentials in diagnostics", () => {
    const config = normalizeExternalMemoryConfig({
      enabled: true,
      provider: "fake",
      credentials: {
        apiKey: "sk-secretsecretsecretsecretsecret",
        endpoint: "https://example.test"
      }
    });
    expect(redactExternalMemoryConfig(config)).toEqual(expect.objectContaining({
      credentials: {
        apiKey: "[REDACTED]",
        endpoint: "https://example.test"
      }
    }));
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
    expect(loaded.auxiliaryModels.assessor).toEqual({ provider: "auto", enabled: true });
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

  it("setupAuxiliaryModelConfig writes normalized auxiliary config", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "estacoda-config-test-"));
    await mkdir(dirname(profileConfigPath(workspace)), { recursive: true });
    const configPath = profileConfigPath(workspace);
    await writeFile(configPath, JSON.stringify({
      model: { provider: "local", id: "hermes-local" },
      auxiliaryModels: {
        assessor: { provider: "auto", enabled: true }
      }
    }));

    const result = await setupAuxiliaryModelConfig({
      workspaceRoot: workspace,
      homeDir: workspace,
      input: {
        task: "compression",
        provider: "openai",
        id: "gpt-5.5",
        apiKeyEnv: "OPENAI_API_KEY",
        contextWindowTokens: 128_000
      }
    });
    const saved = JSON.parse(await readFile(configPath, "utf8"));

    expect(result.path).toBe(configPath);
    expect(saved.auxiliaryModels.compression).toEqual({
      provider: "openai",
      id: "gpt-5.5",
      apiKeyEnv: "OPENAI_API_KEY",
      contextWindowTokens: 128_000,
      enabled: true
    });
    expect(saved.model).toEqual({ provider: "local", id: "hermes-local" });
  });

  it("setupAuxiliaryModelConfig preserves unrelated auxiliary slots", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "estacoda-config-test-"));
    await mkdir(dirname(profileConfigPath(workspace)), { recursive: true });
    const configPath = profileConfigPath(workspace);
    await writeFile(configPath, JSON.stringify({
      model: {
        provider: "local",
        id: "hermes-local",
        fallbacks: [{ provider: "openai", id: "gpt-5.5" }]
      },
      auxiliaryModels: {
        assessor: { provider: "local", id: "assessor-local", enabled: true },
        session_search: { provider: "local", id: "search-local", enabled: true }
      },
      browser: { backend: "local-cdp" }
    }));

    await setupAuxiliaryModelConfig({
      workspaceRoot: workspace,
      homeDir: workspace,
      input: {
        task: "memory_compaction",
        provider: "openai",
        id: "gpt-5.5"
      }
    });
    const saved = JSON.parse(await readFile(configPath, "utf8"));

    expect(saved.auxiliaryModels.assessor).toEqual({ provider: "local", id: "assessor-local", enabled: true });
    expect(saved.auxiliaryModels.session_search).toEqual({ provider: "local", id: "search-local", enabled: true });
    expect(saved.auxiliaryModels.memory_compaction).toEqual({ provider: "openai", id: "gpt-5.5", enabled: true });
    expect(saved.model).toEqual({
      provider: "local",
      id: "hermes-local",
      fallbacks: [{ provider: "openai", id: "gpt-5.5" }]
    });
    expect(saved.browser).toEqual({ backend: "local-cdp" });
  });

  it("setupVoiceConfig does not patch STT during TTS-only setup", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "estacoda-config-test-"));
    await mkdir(dirname(profileConfigPath(workspace)), { recursive: true });
    const configPath = profileConfigPath(workspace);
    await writeFile(configPath, JSON.stringify({
      stt: {
        provider: "local",
        local: {
          engine: "command",
          command: "existing-stt-command"
        }
      }
    }));

    await setupVoiceConfig({
      workspaceRoot: workspace,
      homeDir: workspace,
      input: {
        ttsProvider: "openai"
      }
    });

    const saved = JSON.parse(await readFile(configPath, "utf8"));
    expect(saved.stt).toEqual({
      provider: "local",
      local: {
        engine: "command",
        command: "existing-stt-command"
      }
    });
  });

  it("setupVoiceConfig writes local faster-whisper schema with python binary", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "estacoda-config-test-"));
    await mkdir(dirname(profileConfigPath(workspace)), { recursive: true });
    const configPath = profileConfigPath(workspace);
    await writeFile(configPath, JSON.stringify({}));

    await setupVoiceConfig({
      workspaceRoot: workspace,
      homeDir: workspace,
      input: {
        sttProvider: "local",
        sttModel: "small",
        pythonBinary: "/custom/python3"
      }
    });

    const saved = JSON.parse(await readFile(configPath, "utf8"));
    expect(saved.stt).toEqual({
      provider: "local",
      local: {
        model: "small",
        engine: "faster-whisper",
        pythonBinary: "/custom/python3",
        fasterWhisper: {
          enabled: true,
          model: "small",
          allowModelDownload: true
        }
      }
    });
  });
});

describe("loadRuntimeConfig compression", () => {
  it("exposes disabled normalized compression config by default", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "estacoda-config-test-"));
    await mkdir(dirname(profileConfigPath(workspace)), { recursive: true });
    await writeFile(profileConfigPath(workspace), JSON.stringify({ model: { provider: "openai", id: "gpt-4o" } }));

    const loaded = await loadRuntimeConfig({ workspaceRoot: workspace, homeDir: workspace });

    expect(loaded.compression).toEqual({
      enabled: false,
      threshold: 0.50,
      targetRatio: 0.20,
      protectFirstN: 3,
      protectLastN: 20,
      experimental: false
    });
  });

  it("normalizes configured compression without silently enabling non-experimental compression", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "estacoda-config-test-"));
    await mkdir(dirname(profileConfigPath(workspace)), { recursive: true });
    await writeFile(profileConfigPath(workspace), JSON.stringify({
      model: { provider: "openai", id: "gpt-4o" },
      compression: {
        enabled: true,
        threshold: 0.99,
        targetRatio: "0.05",
        protectFirstN: "2",
        protectLastN: 0,
        summaryModelContextLength: "64000"
      }
    }));

    const loaded = await loadRuntimeConfig({ workspaceRoot: workspace, homeDir: workspace });

    expect(loaded.compression).toEqual({
      enabled: false,
      threshold: 0.95,
      targetRatio: 0.10,
      protectFirstN: 2,
      protectLastN: 1,
      summaryModelContextLength: 64_000,
      experimental: false
    });
  });
});

describe("loadRuntimeConfig external memory", () => {
  it("exposes disabled normalized external memory config by default", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "estacoda-config-test-"));
    await mkdir(dirname(profileConfigPath(workspace)), { recursive: true });
    await writeFile(profileConfigPath(workspace), JSON.stringify({ model: { provider: "openai", id: "gpt-4o" } }));

    const loaded = await loadRuntimeConfig({ workspaceRoot: workspace, homeDir: workspace });

    expect(loaded.externalMemory).toEqual({
      enabled: false,
      timeoutMs: 750,
      maxResults: 3,
      maxChars: 2500,
      mirrorWrites: false
    });
  });

  it("loads explicit external memory provider config separately from local memory", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "estacoda-config-test-"));
    await mkdir(dirname(profileConfigPath(workspace)), { recursive: true });
    await writeFile(profileConfigPath(workspace), JSON.stringify({
      model: { provider: "openai", id: "gpt-4o" },
      externalMemory: {
        enabled: true,
        provider: "file",
        maxResults: 2,
        maxChars: 1000,
        mirrorWrites: true,
        file: {
          path: "memory.jsonl",
          maxEntries: 50
        }
      }
    }));

    const loaded = await loadRuntimeConfig({ workspaceRoot: workspace, homeDir: workspace });

    expect(loaded.externalMemory).toEqual({
      enabled: true,
      provider: "file",
      timeoutMs: 750,
      maxResults: 2,
      maxChars: 1000,
      mirrorWrites: true,
      file: {
        path: "memory.jsonl",
        maxEntries: 50
      }
    });
  });
});

describe("loadRuntimeConfig browser security", () => {
  async function loadSecurityConfig(config: Record<string, unknown>) {
    const workspace = await mkdtemp(join(tmpdir(), "estacoda-config-test-"));
    await mkdir(dirname(profileConfigPath(workspace)), { recursive: true });
    await writeFile(profileConfigPath(workspace), JSON.stringify({
      model: { provider: "openai", id: "gpt-4o" },
      ...config
    }));

    return await loadRuntimeConfig({ workspaceRoot: workspace, homeDir: workspace });
  }

  it("defaults allowPrivateUrls to false", async () => {
    await withAllowPrivateUrlsEnv(undefined, async () => {
      const loaded = await loadSecurityConfig({});
      expect(loaded.security.allowPrivateUrls).toBe(false);
    });
  });

  it("loads canonical security.allowPrivateUrls", async () => {
    await withAllowPrivateUrlsEnv(undefined, async () => {
      const loaded = await loadSecurityConfig({
        security: { allowPrivateUrls: true }
      });
      expect(loaded.security.allowPrivateUrls).toBe(true);
    });
  });

  it("loads deprecated browser.allowPrivateUrls alias", async () => {
    await withAllowPrivateUrlsEnv(undefined, async () => {
      const loaded = await loadSecurityConfig({
        browser: { allowPrivateUrls: true }
      });
      expect(loaded.security.allowPrivateUrls).toBe(true);
    });
  });

  it("prefers canonical security.allowPrivateUrls over browser alias unless env is present", async () => {
    await withAllowPrivateUrlsEnv(undefined, async () => {
      const loaded = await loadSecurityConfig({
        security: { allowPrivateUrls: false },
        browser: { allowPrivateUrls: true }
      });
      expect(loaded.security.allowPrivateUrls).toBe(false);
    });

    await withAllowPrivateUrlsEnv("on", async () => {
      const loaded = await loadSecurityConfig({
        security: { allowPrivateUrls: false },
        browser: { allowPrivateUrls: false }
      });
      expect(loaded.security.allowPrivateUrls).toBe(true);
    });
  });

  it("accepts env true values", async () => {
    for (const value of ["1", "true", "yes", "on"]) {
      await withAllowPrivateUrlsEnv(value, async () => {
        const loaded = await loadSecurityConfig({});
        expect(loaded.security.allowPrivateUrls).toBe(true);
      });
    }
  });

  it("accepts env false values", async () => {
    for (const value of ["0", "false", "no", "off"]) {
      await withAllowPrivateUrlsEnv(value, async () => {
        const loaded = await loadSecurityConfig({
          security: { allowPrivateUrls: true }
        });
        expect(loaded.security.allowPrivateUrls).toBe(false);
      });
    }
  });

  it("rejects invalid env and config string values", async () => {
    await withAllowPrivateUrlsEnv("maybe", async () => {
      await expect(loadSecurityConfig({})).rejects.toThrow("ESTACODA_ALLOW_PRIVATE_URLS must be a boolean value");
    });

    await withAllowPrivateUrlsEnv(undefined, async () => {
      await expect(loadSecurityConfig({
        security: { allowPrivateUrls: "maybe" }
      })).rejects.toThrow("security.allowPrivateUrls must be a boolean value");
    });
  });

  it("exposes website blocklist config", async () => {
    await withAllowPrivateUrlsEnv(undefined, async () => {
      const loaded = await loadSecurityConfig({
        security: {
          websiteBlocklist: {
            domains: ["example.com"],
            sharedFiles: ["/tmp/example-blocklist.txt"]
          }
        }
      });

      expect(loaded.security.websiteBlocklist).toEqual({
        domains: ["example.com"],
        sharedFiles: ["/tmp/example-blocklist.txt"]
      });
    });
  });
});

describe("loadRuntimeConfig browser provider compatibility", () => {
  async function loadBrowserConfig(config: Record<string, unknown>) {
    const workspace = await mkdtemp(join(tmpdir(), "estacoda-config-test-"));
    await mkdir(dirname(profileConfigPath(workspace)), { recursive: true });
    await writeFile(profileConfigPath(workspace), JSON.stringify({
      model: { provider: "openai", id: "gpt-4o" },
      ...config
    }));

    return await loadRuntimeConfig({ workspaceRoot: workspace, homeDir: workspace });
  }

  it("loads legacy browser backend values and separate cloud provider config", async () => {
    for (const backend of ["browserbase", "firecrawl", "camofox"] as const) {
      const loaded = await loadBrowserConfig({
        browser: {
          backend,
          cloudProvider: "browser-use"
        }
      });

      expect(loaded.browser).toMatchObject({
        backend,
        cloudProvider: "browser-use",
        supervised: false,
        autoLaunch: false
      });
    }
  });

  it("defaults loaded local CDP config to supervised mode", async () => {
    const loaded = await loadBrowserConfig({
      browser: {
        backend: "local-cdp",
        cdpUrl: "http://127.0.0.1:9222"
      }
    });

    expect(loaded.browser).toMatchObject({
      backend: "local-cdp",
      cdpUrl: "http://127.0.0.1:9222",
      supervised: true
    });
  });

  it("preserves explicit local CDP supervised escape hatch", async () => {
    const loaded = await loadBrowserConfig({
      browser: {
        backend: "local-cdp",
        supervised: false
      }
    });

    expect(loaded.browser).toMatchObject({
      backend: "local-cdp",
      supervised: false
    });
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

  it("normalizes Discord voice channel config as disabled by default", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "estacoda-config-test-"));
    await mkdir(dirname(profileConfigPath(workspace)), { recursive: true });
    const configPath = profileConfigPath(workspace);
    await writeFile(configPath, JSON.stringify({
      model: { provider: "openai", id: "gpt-4o" },
      channels: { discord: { enabled: true, botTokenEnv: "DISCORD_BOT_TOKEN" } }
    }));

    const loaded = await loadRuntimeConfig({ workspaceRoot: workspace, homeDir: workspace });
    expect(loaded.channels.discord.voiceChannel).toEqual({
      enabled: false,
      autoJoinOnCommand: true
    });
    await rm(workspace, { recursive: true, force: true });
  });

  it("normalizes explicit Discord voice channel enablement", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "estacoda-config-test-"));
    await mkdir(dirname(profileConfigPath(workspace)), { recursive: true });
    const configPath = profileConfigPath(workspace);
    await writeFile(configPath, JSON.stringify({
      model: { provider: "openai", id: "gpt-4o" },
      channels: {
        discord: {
          enabled: true,
          botTokenEnv: "DISCORD_BOT_TOKEN",
          voiceChannel: { enabled: true, autoJoinOnCommand: false }
        }
      }
    }));

    const loaded = await loadRuntimeConfig({ workspaceRoot: workspace, homeDir: workspace });
    expect(loaded.channels.discord.voiceChannel).toEqual({
      enabled: true,
      autoJoinOnCommand: false
    });
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
  it("defaults TTS to openai and normalizes inert voice auto-TTS fields", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "estacoda-config-test-"));
    await mkdir(dirname(profileConfigPath(workspace)), { recursive: true });
    const configPath = profileConfigPath(workspace);

    await writeFile(configPath, JSON.stringify({
      model: { provider: "openai", id: "gpt-4o" },
      voice: {
        autoTts: true,
        autoTtsMaxCharsPerReply: 1200,
        autoTtsMaxCharsPerHourPerChat: 5000
      }
    }));

    const loaded = await loadRuntimeConfig({
      workspaceRoot: workspace,
      homeDir: workspace
    });

    expect(loaded.tts.provider).toBe("openai");
    expect(loaded.tts.enabled).toBe(true);
    expect(loaded.stt.enabled).toBe(true);
    expect(loaded.voice).toEqual({
      autoTts: true,
      autoTtsMaxCharsPerReply: 1200,
      autoTtsMaxCharsPerHourPerChat: 5000
    });
  });

  it("defaults local STT to managed faster-whisper settings", async () => {
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

    expect(loaded.stt.local).toMatchObject({
      model: "base",
      engine: "faster-whisper",
      fasterWhisper: {
        enabled: true,
        model: "base",
        device: "auto",
        computeType: "default",
        allowModelDownload: true,
        gatewayAllowModelDownload: false
      }
    });
  });

  it("normalizes local STT python binary aliases", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "estacoda-config-test-"));
    await mkdir(dirname(profileConfigPath(workspace)), { recursive: true });
    const configPath = profileConfigPath(workspace);

    await writeFile(configPath, JSON.stringify({
      model: { provider: "openai", id: "gpt-4o" },
      stt: {
        local: {
          python_binary: "/usr/bin/python3"
        }
      }
    }));

    const loaded = await loadRuntimeConfig({
      workspaceRoot: workspace,
      homeDir: workspace
    });

    expect(loaded.stt.local?.pythonBinary).toBe("/usr/bin/python3");

    await writeFile(configPath, JSON.stringify({
      model: { provider: "openai", id: "gpt-4o" },
      stt: {
        local: {
          pythonBinary: "/opt/python/bin/python"
        }
      }
    }));

    const loadedCamel = await loadRuntimeConfig({
      workspaceRoot: workspace,
      homeDir: workspace
    });

    expect(loadedCamel.stt.local?.pythonBinary).toBe("/opt/python/bin/python");
  });

  it("preserves explicit local command mode without defaulting faster-whisper on", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "estacoda-config-test-"));
    await mkdir(dirname(profileConfigPath(workspace)), { recursive: true });
    const configPath = profileConfigPath(workspace);

    await writeFile(configPath, JSON.stringify({
      model: { provider: "openai", id: "gpt-4o" },
      stt: {
        local: {
          engine: "command",
          command: "whisper-cli"
        }
      }
    }));

    const loaded = await loadRuntimeConfig({
      workspaceRoot: workspace,
      homeDir: workspace
    });

    expect(loaded.stt.local?.engine).toBe("command");
    expect(loaded.stt.local?.fasterWhisper?.enabled).toBe(false);
  });

  it("normalizes xAI native TTS config without adding a model field", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "estacoda-config-test-"));
    await mkdir(dirname(profileConfigPath(workspace)), { recursive: true });
    const configPath = profileConfigPath(workspace);

    await writeFile(configPath, JSON.stringify({
      model: { provider: "openai", id: "gpt-4o" },
      tts: {
        provider: "xai",
        xai: {
          voice_id: "nova",
          language: "en-US",
          sample_rate: 48_000,
          bit_rate: 192_000,
          base_url: "https://api.x.ai/v1",
          api_key_env: "CUSTOM_XAI_KEY",
          speed: 1.4
        }
      }
    }));

    const loaded = await loadRuntimeConfig({
      workspaceRoot: workspace,
      homeDir: workspace
    });

    expect(loaded.tts.xai).toEqual({
      voiceId: "nova",
      language: "en-US",
      sampleRate: 48_000,
      bitRate: 192_000,
      baseUrl: "https://api.x.ai/v1",
      apiKeyEnv: "CUSTOM_XAI_KEY",
      speed: 1.4
    });
    expect(loaded.tts.xai).not.toHaveProperty("model");
  });

  it("normalizes xAI native STT config and faster-whisper local settings", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "estacoda-config-test-"));
    await mkdir(dirname(profileConfigPath(workspace)), { recursive: true });
    const configPath = profileConfigPath(workspace);

    await writeFile(configPath, JSON.stringify({
      model: { provider: "openai", id: "gpt-4o" },
      stt: {
        provider: "xai",
        local: {
          engine: "faster-whisper",
          normalize_with_ffmpeg: false,
          ffmpeg_path: "/opt/bin/ffmpeg",
          faster_whisper: {
            enabled: true,
            model: "small",
            compute_type: "int8",
            hf_home: "/tmp/hf",
            allow_model_download: true,
            gateway_allow_model_download: false,
            queue_depth: 3,
            timeout_ms: 300000
          }
        },
        xai: {
          base_url: "https://api.x.ai/v1",
          api_key_env: "CUSTOM_XAI_STT_KEY",
          language: "en",
          format: "json",
          diarization: true,
          key_terms: ["EstaCoda"],
          filler_words: true
        }
      }
    }));

    const loaded = await loadRuntimeConfig({ workspaceRoot: workspace, homeDir: workspace });

    expect(loaded.stt.provider).toBe("xai");
    expect(loaded.stt.xai).toEqual({
      baseUrl: "https://api.x.ai/v1",
      apiKeyEnv: "CUSTOM_XAI_STT_KEY",
      language: "en",
      format: "json",
      diarize: true,
      keyterms: ["EstaCoda"],
      fillerWords: true,
      rawAudioHints: undefined
    });
    expect(loaded.stt.xai).not.toHaveProperty("model");
    expect(loaded.stt.local?.fasterWhisper).toMatchObject({
      enabled: true,
      model: "small",
      computeType: "int8",
      hfHome: "/tmp/hf",
      allowModelDownload: true,
      gatewayAllowModelDownload: false,
      queueDepth: 3,
      timeoutMs: 300000
    });
  });

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

  it("expands configured tilde paths with OS home, not ESTACODA_HOME", async () => {
    const prodHome = await mkdtemp(join(tmpdir(), "estacoda-config-prod-home-"));
    const devHome = await mkdtemp(join(tmpdir(), "estacoda-config-dev-home-"));

    try {
      await withHomeEnv({ HOME: prodHome, ESTACODA_HOME: devHome }, async () => {
        await mkdir(dirname(profileConfigPath(devHome)), { recursive: true });
        await writeFile(profileConfigPath(devHome), JSON.stringify({
          model: { provider: "openai", id: "gpt-4o" },
          mcpServers: {
            local: {
              command: "echo",
              cwd: "~/mcp-server"
            }
          },
          skills: {
            externalDirs: ["~/skills"]
          }
        }));

        const loaded = await loadRuntimeConfig({ workspaceRoot: devHome, homeDir: devHome });

        expect(loaded.sources).toEqual([profileConfigPath(devHome)]);
        expect(loaded.skills.externalDirs).toEqual([join(prodHome, "skills")]);
        expect(loaded.mcp.servers.local?.cwd).toBe(join(prodHome, "mcp-server"));
      });
    } finally {
      await rm(prodHome, { recursive: true, force: true });
      await rm(devHome, { recursive: true, force: true });
    }
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
      model: { provider: "kimi", id: "kimi-k2.5" },
      providers: {
        kimi: {
          kind: "openai-compatible",
          models: ["kimi-k2.5"]
        }
      }
    }));

    const loaded = await loadRuntimeConfig({
      workspaceRoot: workspace,
      homeDir: workspace
    });

    const adapter = loaded.providerRegistry.get("kimi");
    expect(adapter).toBeDefined();
    expect(adapter?.endpoint?.baseUrl).toBe("https://api.moonshot.ai/v1");
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
