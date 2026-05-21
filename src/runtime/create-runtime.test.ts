import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { createRuntime, createDefaultProviderRegistry, type RuntimeOptions } from "./create-runtime.js";
import { createSQLiteSessionDB } from "../session/session-setup.js";
import { InMemorySessionDB } from "../session/in-memory-session-db.js";
import { WorkspaceTrustStore } from "../security/workspace-trust-store.js";
import { WorkspaceApprovalController } from "../security/workspace-approval-controller.js";
import { ProviderRegistry } from "../providers/provider-registry.js";
import type { ModelProfile, ProviderAdapter, ProviderRequest } from "../contracts/provider.js";
import type { SecurityApprovalMode, SecurityAssessment, SecurityPolicy, SecurityRequest } from "../contracts/security.js";
import type { ResolvedTokens } from "../contracts/ui-tokens.js";
import { resolveTokens } from "../theme/token-resolver.js";

const mockModel: ModelProfile = {
  id: "mock-model",
  provider: "unconfigured",
  contextWindowTokens: 4096,
  supportsTools: true,
  supportsVision: false,
  supportsStructuredOutput: false
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
  tokens?: ResolvedTokens | undefined;
} = {}) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "estacoda-runtime-test-"));
  return {
    tokens: resolveTokens("standard", "dark", "kemetBlue"),
    model: mockModel,
    providerRegistry: createMockProviderRegistry(),
    workspaceRoot,
    localSkillsRoot: join(workspaceRoot, "skills"),
    sessionId: `test-${Date.now()}`,
    ...overrides
  };
}

describe("createRuntime token branding", () => {
  it("accepts resolved tokens and uses token branding", async () => {
    const tokens = resolveTokens("standard", "dark", "kemetBlue");
    const options = await minimalRuntimeOptions({ tokens });
    const runtime = await createRuntime(options);

    try {
      expect(runtime.describe()).toContain(`${tokens.contract.branding.responseLabel} is ready`);
      expect(runtime.getStatus().agentName).toBe(tokens.contract.branding.responseLabel);
      expect(runtime.getStartup().agentName).toBe(tokens.contract.branding.agentName);
    } finally {
      await runtime.dispose();
    }
  });

  it("fails closed when tokens are missing", async () => {
    const { tokens: _tokens, ...options } = await minimalRuntimeOptions();

    await expect(createRuntime(options as RuntimeOptions)).rejects.toThrow(
      "createRuntime requires tokens."
    );
  });
});

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

  it("keeps the current built-in tool registration order", async () => {
    const options = await minimalRuntimeOptions();
    const runtime = await createRuntime(options);
    try {
      expect(runtime.tools().map((tool) => tool.name)).toMatchInlineSnapshot(`
        [
          "workflow.plan",
          "trajectory.record",
          "python.probe",
          "document.probe",
          "web.extract",
          "browser.status",
          "browser.snapshot",
          "browser.click",
          "browser.type",
          "browser.scroll",
          "browser.press",
          "browser.back",
          "browser.get_images",
          "browser.console",
          "browser.cdp",
          "browser.screenshot",
          "browser.vision",
          "browser.dialog",
          "browser.navigate",
          "file.read",
          "file.write",
          "file.replace",
          "file.search",
          "terminal.run",
          "media.probe-ffmpeg",
          "media.inspect",
          "media.extract-frame",
          "artifact.record",
          "voice.speak",
          "voice.transcribe",
          "image.generate",
          "vision.analyze",
          "process.start",
          "process.list",
          "process.logs",
          "process.stop",
          "workspace.trust.status",
          "workspace.trust.grant",
          "workspace.trust.revoke",
          "config.provider.status",
          "config.security.status",
          "config.compression.status",
          "config.security.setup",
          "config.web.setup",
          "config.browser.setup",
          "config.mcp.status",
          "config.mcp.setup",
          "config.telegram.setup",
          "config.telegram.status",
          "config.image.status",
          "config.provider.setup",
          "config.image.setup",
          "cronjob",
          "memory.curate",
          "memory.file_compact",
          "memory.file_compaction_restore",
          "skill.list",
          "skill.view",
          "skill.inspect",
          "skill.eval",
          "skill.usage",
          "skill.observe",
          "skill.propose_patch",
          "skill.list_proposals",
          "skill.review_proposals",
          "skill.review_proposal",
          "skill.approve_patch",
          "skill.reject_patch",
          "skill.promote_patch",
          "skill.create",
          "skill.patch",
          "skill.edit",
          "skill.delete",
          "skill.rollback",
          "skill.reset",
          "skill.write_file",
          "skill.remove_file",
          "skill.import",
          "skill.export",
          "knowledge.memory.inspect",
          "knowledge.memory.deactivate",
          "knowledge.code.query",
          "delegate_task",
          "execute_code",
        ]
      `);
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

describe("createRuntime external memory providers", () => {
  it("wires explicitly configured file-backed external memory without enabling providers by default", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "estacoda-runtime-external-memory-"));
    const options = await minimalRuntimeOptions({
      workspaceTrusted: true
    });
    const runtime = await createRuntime({
      ...options,
      homeDir,
      profileId: "default",
      securityMode: "open",
      externalMemory: {
        enabled: true,
        provider: "file",
        timeoutMs: 750,
        maxResults: 3,
        maxChars: 2500,
        mirrorWrites: true,
        file: {
          path: "memory.jsonl",
          maxEntries: 100
        }
      }
    });

    try {
      const result = await runtime.executeTool?.({
        tool: "memory.curate",
        toolInput: {
          kind: "append",
          file: "USER.md",
          content: "- Runtime file external memory mirror works"
        }
      });

      expect(result?.result?.ok).toBe(true);
      const mirrored = await readFile(
        join(homeDir, ".estacoda", "profiles", "default", "external-memory", "memory.jsonl"),
        "utf8"
      );
      expect(mirrored).toContain("Runtime file external memory mirror works");
    } finally {
      await runtime.dispose();
    }
  });
});

describe("createRuntime session recall", () => {
  it("excludes the active runtime session from recall", async () => {
    const options = await minimalRuntimeOptions();
    const sessionDb = new InMemorySessionDB();
    const activeSessionId = "runtime-active-recall-session";
    const runtime = await createRuntime({
      ...options,
      sessionDb,
      sessionId: activeSessionId
    });

    try {
      await sessionDb.appendMessage({
        id: "active-recall-message",
        sessionId: activeSessionId,
        role: "user",
        content: "alpha detail already present in the active session"
      });
      await sessionDb.createSession({
        id: "historical-recall-session",
        profileId: "default",
        title: "Historical recall session",
        metadata: { workspaceRoot: options.workspaceRoot }
      });
      await sessionDb.appendMessage({
        id: "historical-recall-message",
        sessionId: "historical-recall-session",
        role: "user",
        content: "alpha detail from a prior session"
      });

      const result = await runtime.recallSession?.("alpha");

      expect(result?.blocks.map((block) => block.sessionId)).toEqual(["historical-recall-session"]);
      expect(result?.blocks.flatMap((block) => block.sourceSessionIds)).not.toContain(activeSessionId);
    } finally {
      await runtime.dispose();
    }
  });
});

describe("createRuntime semantic compression construction", () => {
  it("keeps runtime compactSession non-rotating unless caller opts into transcript preservation", async () => {
    const options = await minimalRuntimeOptions();
    const sessionDb = new InMemorySessionDB({
      now: () => new Date("2030-01-01T00:00:00.000Z"),
      id: () => crypto.randomUUID()
    });
    const runtime = await createRuntime({
      ...options,
      sessionDb,
      sessionId: "active-runtime-session",
      compression: {
        enabled: false,
        threshold: 0.95,
        targetRatio: 0.20,
        protectFirstN: 0,
        protectLastN: 1,
        summaryModelContextLength: 100_000
      }
    });

    try {
      await sessionDb.createSession({ id: "non-rotating-session", profileId: "default" });
      await sessionDb.createSession({ id: "preserving-session", profileId: "default" });
      for (const sessionId of ["non-rotating-session", "preserving-session"]) {
        for (let index = 0; index < 4; index += 1) {
          await sessionDb.appendMessage({
            id: `${sessionId}-m${index}`,
            sessionId,
            role: index % 2 === 0 ? "user" : "agent",
            content: `message ${index} ${"x".repeat(120)}`
          });
        }
      }

      const defaultResult = await runtime.compactSession?.({ sessionId: "non-rotating-session" });
      const preservedResult = await runtime.compactSession?.({
        sessionId: "preserving-session",
        preserveTranscript: true
      });

      expect(defaultResult).toEqual(expect.objectContaining({
        didCompress: true,
        originalSessionId: "non-rotating-session",
        activeSessionId: "non-rotating-session",
        rotated: false
      }));
      expect(preservedResult).toEqual(expect.objectContaining({
        didCompress: true,
        originalSessionId: "preserving-session",
        replacementSessionId: preservedResult?.activeSessionId,
        rotated: true
      }));
      expect(preservedResult?.activeSessionId).not.toBe("preserving-session");
      await expect(sessionDb.getSession("preserving-session")).resolves.toEqual(expect.objectContaining({
        endReason: "compression"
      }));
      await expect(sessionDb.getSession(preservedResult!.activeSessionId)).resolves.toEqual(expect.objectContaining({
        parentSessionId: "preserving-session"
      }));
    } finally {
      await runtime.dispose();
    }
  });

  it("uses the compression auxiliary route and not memory_compaction for semantic compression", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "estacoda-runtime-compression-"));
    const requests: ProviderRequest[] = [];
    const mainModel: ModelProfile = {
      id: "main-model",
      provider: "local",
      contextWindowTokens: 128_000,
      supportsTools: false,
      supportsVision: false,
      supportsStructuredOutput: true
    };
    const compressionModel: ModelProfile = {
      ...mainModel,
      id: "compression-model"
    };
    const memoryCompactionModel: ModelProfile = {
      ...mainModel,
      id: "memory-compaction-model"
    };
    const registry = new ProviderRegistry();
    registry.register({
      id: "local",
      name: "Local",
      executable: true,
      health: () => ({ available: true }),
      listModels: () => [mainModel, compressionModel, memoryCompactionModel],
      complete: async (request: ProviderRequest) => {
        requests.push(request);
        return {
          ok: true,
          content: request.model === "compression-model" ? "Compressed summary" : "Final response",
          model: request.model,
          provider: "local"
        };
      }
    });
    const sessionDb = new InMemorySessionDB();
    const sessionId = "compression-runtime-session";
    const runtime = await createRuntime({
      tokens: resolveTokens("standard", "dark", "kemetBlue"),
      model: mainModel,
      primaryModelRoute: { provider: "local", id: "main-model", profile: mainModel },
      providerRegistry: registry,
      workspaceRoot,
      localSkillsRoot: join(workspaceRoot, "skills"),
      sessionDb,
      sessionId,
      compression: {
        enabled: true,
        experimental: true,
        threshold: 0.10,
        targetRatio: 0.20,
        protectFirstN: 0,
        protectLastN: 1,
        summaryModelContextLength: 50
      },
      auxiliaryModels: {
        compression: { provider: "local", id: "compression-model" },
        memory_compaction: { provider: "local", id: "memory-compaction-model" }
      }
    });

    try {
      await sessionDb.appendMessage({
        id: "old-history",
        sessionId,
        role: "user",
        content: "older history ".repeat(200)
      });

      await runtime.handle({
        text: "continue",
        channel: "cli"
      });

      expect(requests.map((request) => request.model)).toContain("compression-model");
      expect(requests.map((request) => request.model)).not.toContain("memory-compaction-model");
    } finally {
      await runtime.dispose();
    }
  });

  it("rotates provider-turn auto compression before provider prompt assembly and writes the response to the child", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "estacoda-runtime-rotate-compression-"));
    const requests: ProviderRequest[] = [];
    const mainModel: ModelProfile = {
      id: "main-model",
      provider: "local",
      contextWindowTokens: 128_000,
      supportsTools: false,
      supportsVision: false,
      supportsStructuredOutput: true
    };
    const compressionModel: ModelProfile = {
      ...mainModel,
      id: "compression-model"
    };
    const registry = new ProviderRegistry();
    registry.register({
      id: "local",
      name: "Local",
      executable: true,
      health: () => ({ available: true }),
      listModels: () => [mainModel, compressionModel],
      complete: async (request: ProviderRequest) => {
        requests.push(request);
        return {
          ok: true,
          content: request.model === "compression-model" ? "Compressed summary" : "Final child response",
          model: request.model,
          provider: "local",
          usage: { inputTokens: 321 }
        };
      }
    });
    const sessionDb = new InMemorySessionDB();
    const sessionId = "auto-compression-parent";
    const runtime = await createRuntime({
      tokens: resolveTokens("standard", "dark", "kemetBlue"),
      model: mainModel,
      primaryModelRoute: { provider: "local", id: "main-model", profile: mainModel },
      providerRegistry: registry,
      workspaceRoot,
      localSkillsRoot: join(workspaceRoot, "skills"),
      sessionDb,
      sessionId,
      compression: {
        enabled: true,
        experimental: true,
        threshold: 0.10,
        targetRatio: 0.20,
        protectFirstN: 0,
        protectLastN: 1,
        summaryModelContextLength: 50
      },
      auxiliaryModels: {
        compression: { provider: "local", id: "compression-model" }
      }
    });

    try {
      await sessionDb.appendMessage({
        id: "old-history",
        sessionId,
        role: "user",
        content: "older history ".repeat(200)
      });

      const response = await runtime.handle({
        text: "continue",
        channel: "cli"
      });

      const childSessionId = runtime.sessionId;
      expect(childSessionId).not.toBe(sessionId);
      expect(response.text).toContain("Final child response");
      await expect(sessionDb.getSession(sessionId)).resolves.toEqual(expect.objectContaining({
        endReason: "compression"
      }));
      await expect(sessionDb.getSession(childSessionId)).resolves.toEqual(expect.objectContaining({
        parentSessionId: sessionId
      }));
      await expect(sessionDb.listMessages(sessionId)).resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ id: "old-history", content: expect.stringContaining("older history") })
      ]));
      const childMessages = await sessionDb.listMessages(childSessionId);
      expect(childMessages).toEqual(expect.arrayContaining([
        expect.objectContaining({ role: "system", metadata: expect.objectContaining({ semanticCompression: true }) }),
        expect.objectContaining({ role: "agent", content: expect.stringContaining("Final child response") })
      ]));
      expect(await sessionDb.listEvents(childSessionId)).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "prompt-assembled" }),
        expect.objectContaining({ kind: "provider-completion" })
      ]));
      const recall = await runtime.recallSession?.("continue");
      expect(recall?.blocks.flatMap((block) => block.sourceSessionIds)).not.toContain(childSessionId);
      const finalProviderRequest = requests.find((request) => request.model === "main-model");
      expect(JSON.stringify(finalProviderRequest?.messages)).toContain("CONTEXT COMPACTION");
    } finally {
      await runtime.dispose();
    }
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
    await trustStore.grant(options.workspaceRoot);
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
    await trustStore.grant(options.workspaceRoot);
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

describe("createRuntime auxiliary consumer wiring", () => {
  it("passes visionAuxiliaryRoute into the vision tool", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "estacoda-runtime-vision-"));
    const imagePath = join(workspaceRoot, "image.png");
    await writeFile(imagePath, Buffer.from("fake-png"));
    const visionModel: ModelProfile = {
      id: "vision-model",
      provider: "local",
      contextWindowTokens: 32000,
      supportsTools: true,
      supportsVision: true,
      supportsStructuredOutput: true
    };
    const mainModel: ModelProfile = {
      id: "main-model",
      provider: "local",
      contextWindowTokens: 32000,
      supportsTools: true,
      supportsVision: false,
      supportsStructuredOutput: true
    };
    let observedRequest: ProviderRequest | undefined;
    let observedRouteId: string | undefined;
    const registry = new ProviderRegistry();
    registry.register({
      id: "local",
      name: "Local",
      endpoint: { baseUrl: "http://localhost:11434/v1" },
      health: () => ({ available: true }),
      listModels: () => [mainModel, visionModel],
      complete: async (request, _options) => {
        observedRequest = request;
        observedRouteId = request.model;
        return {
          ok: true,
          content: "vision ok",
          provider: "local",
          model: request.model
        };
      }
    });
    const trustStorePath = join(workspaceRoot, "trust.json");
    const trustStore = new WorkspaceTrustStore({ path: trustStorePath });
    await trustStore.grant(workspaceRoot);
    const runtime = await createRuntime({
      tokens: resolveTokens("standard", "dark", "kemetBlue"),
      model: mainModel,
      primaryModelRoute: { provider: "local", id: "main-model", profile: mainModel },
      providerRegistry: registry,
      workspaceRoot,
      localSkillsRoot: join(workspaceRoot, "skills"),
      trustStore,
      trustStorePath,
      auxiliaryModels: {
        vision: { provider: "local", id: "vision-model", timeoutMs: 1000, maxConcurrency: 1 }
      }
    });

    try {
      const result = await runtime.executeTool?.({
        tool: "vision.analyze",
        toolInput: { path: "image.png" }
      });

      expect(result?.result?.ok).toBe(true);
      expect(observedRouteId).toBe("vision-model");
      expect(observedRequest?.model).toBe("vision-model");
    } finally {
      await runtime.dispose();
    }
  });

  it("passes assessor fallbackToMain and mainRoute into effective security assessor", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "estacoda-runtime-assessor-"));
    const mainModel: ModelProfile = {
      id: "main-model",
      provider: "local",
      contextWindowTokens: 32000,
      supportsTools: true,
      supportsVision: false,
      supportsStructuredOutput: true
    };
    const assessorModel: ModelProfile = {
      id: "assessor-model",
      provider: "local",
      contextWindowTokens: 32000,
      supportsTools: true,
      supportsVision: false,
      supportsStructuredOutput: true
    };
    const observedModels: string[] = [];
    const registry = new ProviderRegistry();
    registry.register({
      id: "local",
      name: "Local",
      endpoint: { baseUrl: "http://localhost:11434/v1" },
      health: () => ({ available: true }),
      listModels: () => [mainModel, assessorModel],
      complete: async (request) => {
        observedModels.push(request.model);
        if (request.model === "assessor-model") {
          return {
            ok: false,
            content: "primary failed",
            provider: "local",
            model: request.model,
            errorClass: "server"
          };
        }
        return {
          ok: true,
          content: JSON.stringify({ risk_score: 45, reasoning: "Fallback assessor response.", confidence: "medium" }),
          provider: "local",
          model: request.model
        };
      }
    });
    const runtime = await createRuntime({
      tokens: resolveTokens("standard", "dark", "kemetBlue"),
      model: mainModel,
      primaryModelRoute: { provider: "local", id: "main-model", profile: mainModel },
      providerRegistry: registry,
      workspaceRoot,
      localSkillsRoot: join(workspaceRoot, "skills"),
      securityMode: "adaptive",
      securityAssessor: { enabled: true },
      auxiliaryModels: {
        assessor: {
          provider: "local",
          id: "assessor-model",
          fallbackToMain: true,
          timeoutMs: 1000
        }
      }
    });

    try {
      const result = await runtime.executeTool?.({
        tool: "terminal.run",
        toolInput: { command: "sudo true" }
      });

      expect(result?.decision).toBe("ask");
      expect(observedModels).toEqual(["assessor-model", "main-model"]);
    } finally {
      await runtime.dispose();
    }
  });

  it("passes active profileId as smart approval scope key", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "estacoda-runtime-smart-approval-"));
    const mainModel: ModelProfile = {
      id: "main-model",
      provider: "local",
      contextWindowTokens: 32000,
      supportsTools: true,
      supportsVision: false,
      supportsStructuredOutput: true
    };
    const assessorModel: ModelProfile = {
      id: "assessor-model",
      provider: "local",
      contextWindowTokens: 32000,
      supportsTools: true,
      supportsVision: false,
      supportsStructuredOutput: true
    };
    const registry = new ProviderRegistry();
    registry.register({
      id: "local",
      name: "Local",
      endpoint: { baseUrl: "http://localhost:11434/v1" },
      health: () => ({ available: true }),
      listModels: () => [mainModel, assessorModel],
      complete: async (request) => ({
        ok: true,
        content: JSON.stringify({ risk_score: 45, reasoning: "Escalate.", confidence: "medium" }),
        provider: "local",
        model: request.model
      })
    });
    class ObservingApprovalController extends WorkspaceApprovalController {
      observedScopeKey: string | undefined;
      observedTask: string | undefined;

      override async assess(
        _basePolicy: SecurityPolicy,
        _request: SecurityRequest,
        options: {
          workspaceRoot: string;
          sessionId: string;
          mode: SecurityApprovalMode;
          smartApproval?: {
            scopeKey: string;
            assessorRoute?: { task: string };
          };
        }
      ): Promise<SecurityAssessment> {
        this.observedScopeKey = options.smartApproval?.scopeKey;
        this.observedTask = options.smartApproval?.assessorRoute?.task;
        return {
          decision: "ask",
          mode: options.mode,
          reason: "observed",
          risk: "high"
        };
      }
    }
    const approvalController = new ObservingApprovalController();
    const runtime = await createRuntime({
      tokens: resolveTokens("standard", "dark", "kemetBlue"),
      model: mainModel,
      primaryModelRoute: { provider: "local", id: "main-model", profile: mainModel },
      providerRegistry: registry,
      workspaceRoot,
      localSkillsRoot: join(workspaceRoot, "skills"),
      profileId: "profile-smart",
      securityMode: "adaptive",
      securityAssessor: { enabled: true },
      auxiliaryModels: {
        assessor: {
          provider: "local",
          id: "assessor-model",
          timeoutMs: 1000
        }
      },
      approvalController
    });

    try {
      await runtime.executeTool?.({
        tool: "terminal.run",
        toolInput: { command: "sudo apt update" }
      });

      expect(approvalController.observedScopeKey).toBe("profile-smart");
      expect(approvalController.observedTask).toBe("assessor");
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
