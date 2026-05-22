import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { handleSlashCommand } from "./session-loop.js";
import { renderPlain } from "../ui/renderers/plain-renderer.js";
import { InMemorySessionDB } from "../session/in-memory-session-db.js";
import { SESSION_RECALL_UNTRUSTED_NOTICE } from "../session/session-recall-service.js";
import { loadRuntimeConfig } from "../config/runtime-config.js";
import { resolveProfileStateHome } from "../config/profile-home.js";

function fakeRuntime(modelInfo: {
  provider: string;
  model: string;
  contextWindowTokens: number;
  supportsTools: boolean;
  supportsVision: boolean;
  supportsStructuredOutput: boolean;
}, sessionDb = new InMemorySessionDB()) {
  return {
    sessionId: "test-session",
    sessionDb,
    getModelInfo: () => ({
      kind: "kv" as const,
      title: "Model",
      entries: [
        { key: "provider", value: modelInfo.provider },
        { key: "model", value: modelInfo.model },
        { key: "context window", value: String(modelInfo.contextWindowTokens) }
      ]
    }),
    getStatus: () => ({
      kind: "status" as const,
      title: "EstaCoda is ready",
      lines: []
    }),
    tools: () => [],
    dispose: async () => {}
  } as any;
}

async function writeProfileConfig(homeDir: string, config: unknown): Promise<void> {
  const configPath = resolveProfileStateHome({ homeDir, profileId: "default" }).configPath;
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");
}

describe("session-loop /model", () => {
  let tempHome: string;
  let outputChunks: string[];
  let output: NodeJS.WritableStream;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), "estacoda-session-model-test-"));
    outputChunks = [];
    output = {
      write: (chunk: string | Buffer) => { outputChunks.push(String(chunk)); },
      end: () => {}
    } as NodeJS.WritableStream;
  });

  afterEach(() => {
    rmSync(tempHome, { recursive: true, force: true });
  });

  it("/model shows current model info", async () => {
    const runtime = fakeRuntime({
      provider: "local",
      model: "qwen2.5:3b",
      contextWindowTokens: 128000,
      supportsTools: true,
      supportsVision: false,
      supportsStructuredOutput: true
    });

    const result = await handleSlashCommand({
      text: "/model",
      runtime,
      output,
      renderer: { render: renderPlain },
      workspaceRoot: tempHome,
      homeDir: tempHome
    });

    expect(result).toBe(false);
    expect(outputChunks.join("")).toContain("provider: local");
    expect(outputChunks.join("")).toContain("model: qwen2.5:3b");
  });

  it("/model set stores a session-scoped override and refreshes the runtime", async () => {
    await writeProfileConfig(tempHome, {
      providers: {
        local: {
          kind: "openai-compatible",
          baseUrl: "http://localhost:11434/v1",
          models: ["qwen2.5:3b", "phi4:latest"],
          enableNetwork: true
        }
      },
      model: { provider: "local", id: "qwen2.5:3b" }
    });
    const sessionDb = new InMemorySessionDB();
    await sessionDb.createSession({ id: "test-session", profileId: "default" });
    const runtime = fakeRuntime({
      provider: "local",
      model: "qwen2.5:3b",
      contextWindowTokens: 128000,
      supportsTools: true,
      supportsVision: false,
      supportsStructuredOutput: true
    }, sessionDb);
    const refreshed = fakeRuntime({
      provider: "local",
      model: "phi4:latest",
      contextWindowTokens: 128000,
      supportsTools: true,
      supportsVision: false,
      supportsStructuredOutput: true
    }, sessionDb);

    const result = await handleSlashCommand({
      text: "/model set local/phi4:latest",
      runtime,
      output,
      renderer: { render: renderPlain },
      modelSwitchContext: async () => {
        const loaded = await loadRuntimeConfig({ workspaceRoot: tempHome, homeDir: tempHome, profileId: "default" });
        return { config: loaded.config, providerRegistry: loaded.providerRegistry, homeDir: tempHome };
      },
      switchRuntime: async () => refreshed as any,
      workspaceRoot: tempHome,
      homeDir: tempHome
    });

    expect(result).not.toBe(false);
    const override = await sessionDb.getSessionModelOverride("test-session");
    expect(override?.route.provider).toBe("local");
    expect(override?.route.id).toBe("phi4:latest");
    expect(override?.source).toBe("cli");
  });

  it("/model set does not write provider config", async () => {
    const configPath = resolveProfileStateHome({ homeDir: tempHome, profileId: "default" }).configPath;
    mkdirSync(dirname(configPath), { recursive: true });
    const original = JSON.stringify({
      providers: {
        local: {
          kind: "openai-compatible",
          baseUrl: "http://localhost:11434/v1",
          models: ["qwen2.5:3b", "phi4:latest"],
          enableNetwork: true
        }
      },
      model: { provider: "local", id: "qwen2.5:3b" }
    }, null, 2);
    writeFileSync(configPath, original);

    const sessionDb = new InMemorySessionDB();
    await sessionDb.createSession({ id: "test-session", profileId: "default" });
    const runtime = fakeRuntime({
      provider: "local",
      model: "qwen2.5:3b",
      contextWindowTokens: 128000,
      supportsTools: true,
      supportsVision: false,
      supportsStructuredOutput: true
    }, sessionDb);

    await handleSlashCommand({
      text: "/model set local/phi4:latest",
      runtime,
      output,
      renderer: { render: renderPlain },
      modelSwitchContext: async () => {
        const loaded = await loadRuntimeConfig({ workspaceRoot: tempHome, homeDir: tempHome, profileId: "default" });
        return { config: loaded.config, providerRegistry: loaded.providerRegistry, homeDir: tempHome };
      },
      switchRuntime: async () => runtime,
      workspaceRoot: tempHome,
      homeDir: tempHome
    });

    const after = readFileSync(configPath, "utf8");
    expect(after).toBe(original);
  });

  it("/model clear removes the session override and refreshes the runtime", async () => {
    const sessionDb = new InMemorySessionDB();
    await sessionDb.createSession({ id: "test-session", profileId: "default" });
    await sessionDb.setSessionModelOverride("test-session", {
      route: {
        provider: "local",
        id: "phi4:latest",
        baseUrl: "http://localhost:11434/v1",
        apiMode: "custom_openai_compatible",
        authMethod: "none",
        contextWindowTokens: 128000
      },
      modelProfile: {
        id: "phi4:latest",
        provider: "local",
        contextWindowTokens: 128000,
        supportsTools: true,
        supportsVision: false,
        supportsStructuredOutput: true
      },
      setAt: "2030-01-01T00:00:00.000Z",
      source: "cli"
    });
    const runtime = fakeRuntime({
      provider: "local",
      model: "phi4:latest",
      contextWindowTokens: 128000,
      supportsTools: true,
      supportsVision: false,
      supportsStructuredOutput: true
    }, sessionDb);

    const result = await handleSlashCommand({
      text: "/model clear",
      runtime,
      output,
      renderer: { render: renderPlain },
      switchRuntime: async () => runtime,
      workspaceRoot: tempHome,
      homeDir: tempHome
    });

    expect(result).not.toBe(false);
    await expect(sessionDb.getSessionModelOverride("test-session")).resolves.toBeUndefined();
  });

  it("/model set does not change persistent config.model.provider or config.model.id", async () => {
    const configPath = resolveProfileStateHome({ homeDir: tempHome, profileId: "default" }).configPath;
    mkdirSync(dirname(configPath), { recursive: true });
    const original = JSON.stringify({
      providers: {
        local: {
          kind: "openai-compatible",
          baseUrl: "http://localhost:11434/v1",
          models: ["qwen2.5:3b"],
          enableNetwork: true
        }
      },
      model: { provider: "local", id: "qwen2.5:3b" }
    }, null, 2);
    writeFileSync(configPath, original);

    const sessionDb = new InMemorySessionDB();
    await sessionDb.createSession({ id: "test-session", profileId: "default" });
    const runtime = fakeRuntime({
      provider: "local",
      model: "qwen2.5:3b",
      contextWindowTokens: 128000,
      supportsTools: true,
      supportsVision: false,
      supportsStructuredOutput: true
    }, sessionDb);

    await handleSlashCommand({
      text: "/model set local/phi4:latest",
      runtime,
      output,
      renderer: { render: renderPlain },
      modelSwitchContext: async () => {
        const loaded = await loadRuntimeConfig({ workspaceRoot: tempHome, homeDir: tempHome, profileId: "default" });
        return { config: loaded.config, providerRegistry: loaded.providerRegistry, homeDir: tempHome };
      },
      switchRuntime: async () => runtime,
      workspaceRoot: tempHome,
      homeDir: tempHome
    });

    const after = JSON.parse(readFileSync(configPath, "utf8"));
    expect(after.model.provider).toBe("local");
    expect(after.model.id).toBe("qwen2.5:3b");
  });

  it("/model set does not add provider entries, API keys, or fallback routes", async () => {
    const configPath = resolveProfileStateHome({ homeDir: tempHome, profileId: "default" }).configPath;
    mkdirSync(dirname(configPath), { recursive: true });
    const original = JSON.stringify({
      providers: {
        local: {
          kind: "openai-compatible",
          baseUrl: "http://localhost:11434/v1",
          models: ["qwen2.5:3b"],
          enableNetwork: true
        }
      },
      model: { provider: "local", id: "qwen2.5:3b" }
    }, null, 2);
    writeFileSync(configPath, original);

    const sessionDb = new InMemorySessionDB();
    await sessionDb.createSession({ id: "test-session", profileId: "default" });
    const runtime = fakeRuntime({
      provider: "local",
      model: "qwen2.5:3b",
      contextWindowTokens: 128000,
      supportsTools: true,
      supportsVision: false,
      supportsStructuredOutput: true
    }, sessionDb);

    await handleSlashCommand({
      text: "/model set local/phi4:latest",
      runtime,
      output,
      renderer: { render: renderPlain },
      modelSwitchContext: async () => {
        const loaded = await loadRuntimeConfig({ workspaceRoot: tempHome, homeDir: tempHome, profileId: "default" });
        return { config: loaded.config, providerRegistry: loaded.providerRegistry, homeDir: tempHome };
      },
      switchRuntime: async () => runtime,
      workspaceRoot: tempHome,
      homeDir: tempHome
    });

    const after = JSON.parse(readFileSync(configPath, "utf8"));
    expect(Object.keys(after.providers)).toEqual(["local"]);
    expect(after.providers.local.apiKey).toBeUndefined();
    expect(after.model.fallbacks).toBeUndefined();
  });

  it("/model set rejects unresolved model input with setup guidance", async () => {
    await writeProfileConfig(tempHome, {
      providers: {
        local: {
          kind: "openai-compatible",
          baseUrl: "http://localhost:11434/v1",
          models: ["qwen2.5:3b"],
          enableNetwork: true
        }
      },
      model: { provider: "local", id: "qwen2.5:3b" }
    });
    const sessionDb = new InMemorySessionDB();
    await sessionDb.createSession({ id: "test-session", profileId: "default" });
    const runtime = fakeRuntime({
      provider: "local",
      model: "qwen2.5:3b",
      contextWindowTokens: 128000,
      supportsTools: true,
      supportsVision: false,
      supportsStructuredOutput: true
    }, sessionDb);

    const result = await handleSlashCommand({
      text: "/model set badmodel",
      runtime,
      output,
      renderer: { render: renderPlain },
      modelSwitchContext: async () => {
        const loaded = await loadRuntimeConfig({ workspaceRoot: tempHome, homeDir: tempHome, profileId: "default" });
        return { config: loaded.config, providerRegistry: loaded.providerRegistry, homeDir: tempHome };
      },
      workspaceRoot: tempHome,
      homeDir: tempHome
    });

    expect(result).toBe(false);
    expect(outputChunks.join("")).toContain("Could not resolve");
    expect(outputChunks.join("")).toContain("estacoda model setup");
  });

  it("/model set rejects missing credentials without collecting secrets", async () => {
    const originalOpenAiKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      await writeProfileConfig(tempHome, {
        providers: {
          openai: {
            kind: "openai-compatible",
            models: ["gpt-4o"],
            apiKeyEnv: "OPENAI_API_KEY"
          }
        },
        model: { provider: "local", id: "qwen2.5:3b" }
      });
      const sessionDb = new InMemorySessionDB();
      await sessionDb.createSession({ id: "test-session", profileId: "default" });
      const runtime = fakeRuntime({
        provider: "local",
        model: "qwen2.5:3b",
        contextWindowTokens: 128000,
        supportsTools: true,
        supportsVision: false,
        supportsStructuredOutput: true
      }, sessionDb);

      const result = await handleSlashCommand({
        text: "/model set openai/gpt-4o",
        runtime,
        output,
        renderer: { render: renderPlain },
        modelSwitchContext: async () => {
          const loaded = await loadRuntimeConfig({ workspaceRoot: tempHome, homeDir: tempHome, profileId: "default" });
          return { config: loaded.config, providerRegistry: loaded.providerRegistry, homeDir: tempHome };
        },
        workspaceRoot: tempHome,
        homeDir: tempHome
      });

      expect(result).toBe(false);
      expect(outputChunks.join("")).toContain("Credentials are not configured for openai/gpt-4o");
      expect(outputChunks.join("")).toContain("estacoda model setup openai");
      await expect(sessionDb.getSessionModelOverride("test-session")).resolves.toBeUndefined();
    } finally {
      if (originalOpenAiKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = originalOpenAiKey;
      }
    }
  });
});

describe("session-loop session recall", () => {
  let tempHome: string;
  let outputChunks: string[];
  let output: NodeJS.WritableStream;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), "estacoda-session-recall-test-"));
    outputChunks = [];
    output = {
      write: (chunk: string | Buffer) => { outputChunks.push(String(chunk)); },
      end: () => {}
    } as NodeJS.WritableStream;
  });

  afterEach(() => {
    rmSync(tempHome, { recursive: true, force: true });
  });

  it("/session recall uses the manual recall surface", async () => {
    const runtime = {
      ...fakeRuntime({
        provider: "local",
        model: "test",
        contextWindowTokens: 4096,
        supportsTools: false,
        supportsVision: false,
        supportsStructuredOutput: true
      }),
      recallSession: async (query: string) => ({
        query,
        blocks: [
          {
            sessionId: "historical-session",
            sourceSessionIds: ["historical-session"],
            summary: "Source session historical-session: recalled alpha detail",
            hitMessageIds: ["message-1"],
            usedFallback: false,
            untrustedNotice: SESSION_RECALL_UNTRUSTED_NOTICE
          }
        ],
        diagnostics: {
          rawHitCount: 1,
          groupedSessionCount: 1,
          returnedSessionCount: 1,
          fallbackCount: 0,
          warnings: []
        }
      })
    };

    const result = await handleSlashCommand({
      text: "/session recall alpha detail",
      runtime: runtime as any,
      output,
      renderer: { render: renderPlain },
      workspaceRoot: tempHome,
      homeDir: tempHome
    });

    expect(result).toBe(false);
    const text = outputChunks.join("");
    expect(text).toContain("Session recall for \"alpha detail\"");
    expect(text).toContain(SESSION_RECALL_UNTRUSTED_NOTICE);
    expect(text).toContain("Source session historical-session");
  });

  it("/search remains a raw session search surface", async () => {
    const sessionDb = new InMemorySessionDB();
    await sessionDb.createSession({ id: "active-session", profileId: "default" });
    await sessionDb.createSession({ id: "historical-session", profileId: "default" });
    await sessionDb.appendMessage({
      id: "message-1",
      sessionId: "historical-session",
      role: "user",
      content: "alpha raw search detail"
    });
    const runtime = {
      ...fakeRuntime({
        provider: "local",
        model: "test",
        contextWindowTokens: 4096,
        supportsTools: false,
        supportsVision: false,
        supportsStructuredOutput: true
      }),
      sessionId: "active-session",
      sessionDb
    };

    const result = await handleSlashCommand({
      text: "/search alpha",
      runtime: runtime as any,
      output,
      renderer: { render: renderPlain },
      workspaceRoot: tempHome,
      homeDir: tempHome
    });

    expect(result).toBe(false);
    const text = outputChunks.join("");
    expect(text).toContain("Search results for \"alpha\"");
    expect(text).toContain("[historical-session] user: alpha raw search detail");
    expect(text).not.toContain(SESSION_RECALL_UNTRUSTED_NOTICE);
  });
});

describe("session-loop session compaction", () => {
  let tempHome: string;
  let outputChunks: string[];
  let output: NodeJS.WritableStream;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), "estacoda-session-compact-test-"));
    outputChunks = [];
    output = {
      write: (chunk: string | Buffer) => { outputChunks.push(String(chunk)); },
      end: () => {}
    } as NodeJS.WritableStream;
  });

  afterEach(() => {
    rmSync(tempHome, { recursive: true, force: true });
  });

  it("/compact uses manual session compaction and passes the focus topic", async () => {
    const calls: Array<{ focusTopic?: string; preserveTranscript?: boolean }> = [];
    const runtime = {
      ...fakeRuntime({
        provider: "local",
        model: "test",
        contextWindowTokens: 4096,
        supportsTools: false,
        supportsVision: false,
        supportsStructuredOutput: true
      }),
      compactSession: async (input?: { focusTopic?: string; preserveTranscript?: boolean }) => {
        calls.push(input ?? {});
        return compactResult();
      }
    };

    const result = await handleSlashCommand({
      text: "/compact billing topic",
      runtime: runtime as any,
      output,
      renderer: { render: renderPlain },
      workspaceRoot: tempHome,
      homeDir: tempHome
    });

    expect(result).toBe(false);
    expect(calls).toEqual([{ focusTopic: "billing topic", preserveTranscript: false }]);
    const text = outputChunks.join("");
    expect(text).toContain("Compacted 8 messages -> 4 messages");
    expect(text).toContain("Token estimate: 2000 -> 900");
    expect(text).toContain("Focus topic: billing topic");
  });

  it("/compact stays separate from TaskFlow /flow compact", async () => {
    let flowDispatched = false;
    let compactCalled = false;
    const runtime = {
      ...fakeRuntime({
        provider: "local",
        model: "test",
        contextWindowTokens: 4096,
        supportsTools: false,
        supportsVision: false,
        supportsStructuredOutput: true
      }),
      compactSession: async () => {
        compactCalled = true;
        return compactResult();
      },
      taskflow: {
        dispatcher: {
          dispatch: async () => {
            flowDispatched = true;
            return { ok: true, message: "flow compacted" };
          }
        }
      }
    };

    await handleSlashCommand({
      text: "/compact",
      runtime: runtime as any,
      output,
      renderer: { render: renderPlain },
      workspaceRoot: tempHome,
      homeDir: tempHome
    });

    expect(compactCalled).toBe(true);
    expect(flowDispatched).toBe(false);
  });
});

function compactResult() {
  return {
    didCompress: true,
    messages: [
      { id: "m1", role: "user", content: "head" },
      { id: "summary", role: "system", content: "summary", metadata: { semanticCompression: true } },
      { id: "m7", role: "agent", content: "tail" },
      { id: "m8", role: "user", content: "latest" }
    ],
    diagnostics: {
      shouldCompress: true,
      reason: "forced",
      preTokens: 2000,
      postTokens: 900,
      estimatedSavingsTokens: 1100,
      estimatedSavingsRatio: 0.55,
      sourceMessageCount: 8,
      summarizedMessageCount: 4,
      protectedMessageCount: 4,
      protectedFirstN: 1,
      protectedLastN: 1,
      protectedSpans: [],
      protectedCategories: [],
      summaryFormatVersion: "v1",
      summaryChars: 100,
      fallbackUsed: false,
      warnings: [],
      eventWarnings: [],
      prunedToolResults: 0,
      scopeKey: "profile:session",
      ineffectiveCompressionCount: 0
    },
    userFacingMessage: "Session history compacted"
  };
}
