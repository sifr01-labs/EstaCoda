import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { createRuntime, createDefaultProviderRegistry } from "./create-runtime.js";
import { createSQLiteSessionDB } from "../session/session-setup.js";
import { WorkspaceTrustStore } from "../security/workspace-trust-store.js";
import { ProviderRegistry } from "../providers/provider-registry.js";
import type { ModelProfile, ProviderAdapter } from "../contracts/provider.js";
import type { ThemeDefinition } from "../contracts/theme.js";

const mockModel: ModelProfile = {
  id: "mock-model",
  provider: "unconfigured",
  contextWindowTokens: 4096,
  supportsTools: true,
  supportsVision: false,
  supportsStructuredOutput: false
};

const mockTheme: ThemeDefinition = {
  name: "test",
  description: "test theme",
  colors: {
    bannerBorder: "",
    bannerTitle: "",
    bannerAccent: "",
    bannerDim: "",
    bannerText: "",
    uiAccent: "",
    uiLabel: "",
    uiOk: "",
    uiError: "",
    uiWarn: "",
    prompt: "",
    inputRule: "",
    responseBorder: "",
    sessionLabel: "",
    sessionBorder: "",
    statusBarBg: "",
    voiceStatusBg: "",
    completionMenuBg: "",
    completionMenuCurrentBg: "",
    completionMenuMetaBg: "",
    completionMenuMetaCurrentBg: ""
  },
  spinner: {
    waitingFaces: [],
    thinkingFaces: [],
    thinkingVerbs: [],
    wings: []
  },
  branding: {
    agentName: "Test",
    responseLabel: "Test",
    promptSymbol: ">",
    helpHeader: "",
    taglinePrimary: "",
    taglineSecondary: ""
  },
  toolPrefix: "",
  toolSymbols: {}
};

function createMockProviderRegistry(): ProviderRegistry {
  const registry = new ProviderRegistry();
  const mockProvider: ProviderAdapter = {
    id: "unconfigured",
    name: "Mock",
    health: () => ({ available: false }),
    listModels: () => [mockModel],
    complete: async () => ({ ok: true, content: "", model: "mock-model", provider: "unconfigured" })
  };
  registry.register(mockProvider);
  return registry;
}

async function minimalRuntimeOptions(overrides: {
  workspaceTrusted?: boolean;
  mcpServers?: Record<string, { command: string; args?: string[] }>;
} = {}) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "estacoda-runtime-test-"));
  return {
    theme: mockTheme,
    model: mockModel,
    providerRegistry: createMockProviderRegistry(),
    workspaceRoot,
    localSkillsRoot: join(workspaceRoot, "skills"),
    sessionId: `test-${Date.now()}`,
    ...overrides
  };
}

describe("createRuntime MCP trust gating", () => {
  it("does not expose legacy onboarding runtime tools", async () => {
    const options = await minimalRuntimeOptions();
    const runtime = await createRuntime(options);
    try {
      const names = runtime.tools().map((tool) => tool.name);

      expect(names.filter((name) => name.startsWith("onboarding."))).toEqual([]);
    } finally {
      await runtime.dispose();
    }
  });

  it("does not start/register MCP when workspaceTrusted is omitted", async () => {
    const options = await minimalRuntimeOptions({
      mcpServers: { echo: { command: "echo", args: ["hello"] } }
    });
    const runtime = await createRuntime(options);
    const servers = runtime.inspectMcpServers();
    expect(servers).toEqual([]);
  });

  it("does not start/register MCP when workspaceTrusted is false", async () => {
    const options = await minimalRuntimeOptions({
      mcpServers: { echo: { command: "echo", args: ["hello"] } },
      workspaceTrusted: false
    });
    const runtime = await createRuntime(options);
    const servers = runtime.inspectMcpServers();
    expect(servers).toEqual([]);
  });

  it("attempts to start/register MCP when workspaceTrusted is true", async () => {
    const options = await minimalRuntimeOptions({
      mcpServers: { echo: { command: "echo", args: ["hello"] } },
      workspaceTrusted: true
    });
    const runtime = await createRuntime(options);
    const servers = runtime.inspectMcpServers();
    expect(servers.length).toBe(1);
    expect(servers[0].name).toBe("echo");
  });
});

describe("createDefaultProviderRegistry", () => {
  it("does not register metadata-non-runnable fallback providers as executable adapters", () => {
    const registry = createDefaultProviderRegistry({
      id: "gpt-4o",
      provider: "openai",
      contextWindowTokens: 128000,
      supportsTools: true,
      supportsVision: true,
      supportsStructuredOutput: true
    });

    const nous = registry.get("nous");
    expect(nous).toBeDefined();
    expect(nous!.executable).toBe(false);
    expect(nous!.endpoint).toBeUndefined();

    const anthropic = registry.get("anthropic");
    expect(anthropic).toBeDefined();
    expect(anthropic!.executable).toBe(false);
    expect(anthropic!.endpoint).toBeUndefined();
  });

  it("registers known runnable providers with real metadata default endpoints", () => {
    const registry = createDefaultProviderRegistry({
      id: "gpt-4o",
      provider: "openai",
      contextWindowTokens: 128000,
      supportsTools: true,
      supportsVision: true,
      supportsStructuredOutput: true
    });

    const openai = registry.get("openai");
    expect(openai).toBeDefined();
    expect(openai!.executable).not.toBe(false);
    expect(openai!.endpoint?.baseUrl).toBe("https://api.openai.com/v1");

    const local = registry.get("local");
    expect(local).toBeDefined();
    expect(local!.executable).not.toBe(false);
    expect(local!.endpoint?.baseUrl).toBe("http://localhost:11434/v1");
  });

  it("does not use placeholder endpoints in executable provider adapters", () => {
    const registry = createDefaultProviderRegistry({
      id: "gpt-4o",
      provider: "openai",
      contextWindowTokens: 128000,
      supportsTools: true,
      supportsVision: true,
      supportsStructuredOutput: true
    });

    for (const provider of registry.list()) {
      if (provider.executable === false) continue;
      expect(provider.endpoint?.baseUrl).not.toBe("https://example.invalid/v1");
    }
  });
});

describe("createRuntime getStartupReadiness trust threading", () => {
  const originalKey = process.env.OPENAI_API_KEY;

  beforeEach(() => {
    process.env.OPENAI_API_KEY = "test-key";
  });

  afterEach(() => {
    if (originalKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalKey;
    }
  });

  it("ignores project config in verification when workspaceTrusted is trusted", async () => {
    const options = await minimalRuntimeOptions({ workspaceTrusted: true });
    await mkdir(join(options.workspaceRoot, ".estacoda"), { recursive: true });
    await writeFile(
      join(options.workspaceRoot, ".estacoda", "config.json"),
      JSON.stringify({
        model: { provider: "openai", id: "gpt-4o" },
        providers: {
          openai: {
            kind: "openai-compatible",
            baseUrl: "https://api.openai.com/v1",
            apiKeyEnv: "OPENAI_API_KEY",
            models: ["gpt-4o"],
            enableNetwork: true,
          },
        },
      })
    );
    const trustStorePath = join(options.workspaceRoot, ".estacoda", "trust.json");
    const trustStore = new WorkspaceTrustStore({ path: trustStorePath });
    await trustStore.grant(options.workspaceRoot, { profileId: "default" });
    const runtime = await createRuntime({ ...options, trustStore, trustStorePath });
    try {
      const readiness = await runtime.getStartupReadiness();
      expect(readiness.providerReadiness).toBe("missing-config");
      expect(readiness.workspaceVerification).toBe("unverified");
    } finally {
      await runtime.dispose();
    }
  });

  it("skips project config in verification when workspaceTrusted is untrusted", async () => {
    const options = await minimalRuntimeOptions({ workspaceTrusted: false });
    await mkdir(join(options.workspaceRoot, ".estacoda"), { recursive: true });
    await writeFile(
      join(options.workspaceRoot, ".estacoda", "config.json"),
      JSON.stringify({
        model: { provider: "openai", id: "gpt-4o" },
        providers: {
          openai: {
            kind: "openai-compatible",
            baseUrl: "https://api.openai.com/v1",
            apiKeyEnv: "OPENAI_API_KEY",
            models: ["gpt-4o"],
            enableNetwork: true,
          },
        },
      })
    );
    const trustStorePath = join(options.workspaceRoot, ".estacoda", "trust.json");
    const trustStore = new WorkspaceTrustStore({ path: trustStorePath });
    await trustStore.grant(options.workspaceRoot, { profileId: "default" });
    const runtime = await createRuntime({ ...options, trustStore, trustStorePath });
    try {
      const readiness = await runtime.getStartupReadiness();
      expect(readiness.providerReadiness).toBe("missing-config");
      expect(readiness.workspaceVerification).toBe("unverified");
    } finally {
      await runtime.dispose();
    }
  });
});

describe("createRuntime SQLite session lifecycle", () => {
  it("closes an injected SQLite session DB when disposed", async () => {
    const options = await minimalRuntimeOptions();
    const sessionDb = await createSQLiteSessionDB({
      path: join(options.workspaceRoot, ".estacoda", "sessions.sqlite")
    });
    const runtime = await createRuntime({ ...options, sessionDb });

    await runtime.dispose();
    await expect(sessionDb.listSessions()).rejects.toThrow(/closed|open/iu);
    await expect(runtime.dispose()).resolves.toBeUndefined();
  });

  it("leaves shared SQLite session DB open when disposal ownership is disabled", async () => {
    const options = await minimalRuntimeOptions();
    const sessionDb = await createSQLiteSessionDB({
      path: join(options.workspaceRoot, ".estacoda", "sessions.sqlite")
    });
    const runtime = await createRuntime({ ...options, sessionDb, closeSessionDbOnDispose: false });

    await runtime.dispose();
    await expect(sessionDb.listSessions()).resolves.toEqual(expect.any(Array));
    sessionDb.close();
  });
});
