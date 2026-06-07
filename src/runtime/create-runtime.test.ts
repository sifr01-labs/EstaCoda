import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { createRuntime, createDefaultProviderRegistry, type RuntimeOptions } from "./create-runtime.js";
import { normalizeMemoryConfig } from "../config/memory-config.js";
import { resolveProfileStateHome } from "../config/profile-home.js";
import { createSQLiteSessionDB } from "../session/session-setup.js";
import { InMemorySessionDB } from "../session/in-memory-session-db.js";
import { WorkspaceTrustStore } from "../security/workspace-trust-store.js";
import { WorkspaceApprovalController } from "../security/workspace-approval-controller.js";
import { ProviderRegistry } from "../providers/provider-registry.js";
import type { CdpFetchLike, CdpWebSocketEvent, CdpWebSocketLike } from "../browser/cdp-client.js";
import type { ModelProfile, ProviderAdapter, ProviderRequest } from "../contracts/provider.js";
import type { SecurityApprovalMode, SecurityAssessment, SecurityPolicy, SecurityRequest } from "../contracts/security.js";
import type { SessionToolContext } from "../contracts/tool-context.js";
import type { ResolvedTokens } from "../contracts/ui-tokens.js";
import { resolveTokens } from "../theme/token-resolver.js";
import { knowledgeMemoryToolProvider, memoryToolProvider, sessionSearchToolProvider, toolRegistrationPlan } from "../tools/index.js";
import * as pythonEnvManager from "../python-env/manager.js";

type CapturedFasterWhisperOptions = {
  pythonBinary?: string;
  queueDepth?: number;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
};

const fasterWhisperMockState = vi.hoisted(() => ({
  constructedOptions: [] as CapturedFasterWhisperOptions[],
  disposedCount: 0,
  transcribeCalls: [] as Array<Record<string, unknown>>,
  transcribeResponses: [] as Array<Record<string, unknown>>
}));

vi.mock("../tools/stt-local-whisper.js", () => ({
  FasterWhisperWorkerClient: vi.fn().mockImplementation(function FasterWhisperWorkerClient(options: CapturedFasterWhisperOptions = {}) {
    fasterWhisperMockState.constructedOptions.push(options);
    return {
      dispose: vi.fn(async () => {
        fasterWhisperMockState.disposedCount += 1;
      }),
      probe: vi.fn(),
      status: vi.fn(),
      transcribe: vi.fn(async (request: Record<string, unknown>) => {
        fasterWhisperMockState.transcribeCalls.push(request);
        return fasterWhisperMockState.transcribeResponses.shift() ?? {
          ok: true,
          text: "runtime transcript",
          model: typeof request.model === "string" ? request.model : "base"
        };
      })
    };
  }),
  defaultFasterWhisperWorkerPath: () => "/mock/faster-whisper-worker.py"
}));

afterEach(() => {
  fasterWhisperMockState.constructedOptions.length = 0;
  fasterWhisperMockState.disposedCount = 0;
  fasterWhisperMockState.transcribeCalls.length = 0;
  fasterWhisperMockState.transcribeResponses.length = 0;
});

const mockModel: ModelProfile = {
  id: "mock-model",
  provider: "unconfigured",
  contextWindowTokens: 4096,
  supportsTools: true,
  supportsVision: false,
  supportsStructuredOutput: false
};

class FakeRuntimeCdpSocket implements CdpWebSocketLike {
  readonly readyState = 1;
  readonly sent: Array<{ id: number; method: string; params?: Record<string, unknown> }> = [];
  readonly #listeners = new Map<string, Array<(event: CdpWebSocketEvent) => void>>();
  #contextCounter = 0;
  #targetCounter = 0;

  send(data: string): void {
    const message = JSON.parse(data) as {
      id: number;
      method: string;
      params?: Record<string, unknown>;
    };
    this.sent.push(message);
    let result: unknown;
    if (message.method === "Target.createBrowserContext") {
      result = { browserContextId: `runtime-context-${++this.#contextCounter}` };
    } else if (message.method === "Target.createTarget") {
      result = { targetId: `runtime-target-${++this.#targetCounter}` };
    } else if (message.method === "Runtime.evaluate") {
      result = {
        result: {
          value: JSON.stringify({
            sessionId: "runtime-cdp-session",
            url: "https://93.184.216.34/",
            title: "Runtime CDP",
            text: "Supervised runtime CDP",
            elements: []
          })
        }
      };
    } else {
      result = { ok: true, method: message.method };
    }
    this.#emit("message", { data: JSON.stringify({ id: message.id, result }) });
    if (message.method === "Page.navigate") {
      setTimeout(() => this.#emit("message", { data: JSON.stringify({ method: "Page.loadEventFired", params: {} }) }), 0);
    }
  }

  close(): void {
    this.#emit("close", {});
  }

  addEventListener(type: "open" | "message" | "error" | "close", listener: (event: CdpWebSocketEvent) => void): void {
    const listeners = this.#listeners.get(type) ?? [];
    listeners.push(listener);
    this.#listeners.set(type, listeners);
  }

  #emit(type: string, event: CdpWebSocketEvent): void {
    for (const listener of this.#listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

function createRuntimeCdpFetch(): CdpFetchLike {
  return vi.fn(async (url: string) => {
    if (url.endsWith("/json/version")) {
      return cdpResponse({
        Browser: "Chrome/125.0.0.0",
        "Protocol-Version": "1.3",
        webSocketDebuggerUrl: "ws://runtime-cdp/browser"
      });
    }
    if (url.endsWith("/json/list")) {
      return cdpResponse([
        { id: "runtime-target-1", type: "page", webSocketDebuggerUrl: "ws://runtime-cdp/target-1" }
      ]);
    }
    throw new Error(`Unexpected CDP URL: ${url}`);
  });
}

function cdpResponse(payload: unknown): Awaited<ReturnType<CdpFetchLike>> {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => payload,
    text: async () => JSON.stringify(payload)
  };
}

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

function fasterWhisperStt(input: {
  pythonBinary?: string;
  hfHome?: string;
  queueDepth?: number;
  timeoutMs?: number;
} = {}): RuntimeOptions["stt"] {
  return {
    provider: "local",
    enabled: true,
    local: {
      model: "base",
      engine: "faster-whisper",
      pythonBinary: input.pythonBinary,
      fasterWhisper: {
        enabled: true,
        model: "base",
        device: "auto",
        computeType: "default",
        hfHome: input.hfHome,
        allowModelDownload: true,
        gatewayAllowModelDownload: false,
        queueDepth: input.queueDepth,
        timeoutMs: input.timeoutMs
      }
    }
  } as RuntimeOptions["stt"];
}

function commandStt(): RuntimeOptions["stt"] {
  return {
    provider: "local",
    enabled: true,
    local: {
      model: "base",
      engine: "command",
      command: "printf transcript",
      fasterWhisper: {
        enabled: false,
        model: "base",
        device: "auto",
        computeType: "default",
        allowModelDownload: true,
        gatewayAllowModelDownload: false
      }
    }
  } as RuntimeOptions["stt"];
}

function expectedManagedPython(stateRoot: string): string {
  return process.platform === "win32"
    ? join(stateRoot, "python-env", "Scripts", "python.exe")
    : join(stateRoot, "python-env", "bin", "python");
}

async function createAudioFixture(prefix = "estacoda-runtime-audio-"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  const path = join(dir, "voice.ogg");
  await writeFile(path, "audio");
  return path;
}

async function writeProfileMemoryFixture(
  homeDir: string,
  profileId: string,
  files: Partial<Record<"USER.md" | "MEMORY.md" | "SOUL.md", string>>
): Promise<void> {
  const paths = resolveProfileStateHome({ homeDir, profileId });
  await mkdir(paths.profileRoot, { recursive: true });
  for (const [file, content] of Object.entries(files)) {
    const path = file === "USER.md"
      ? paths.userMdPath
      : file === "MEMORY.md"
        ? paths.memoryMdPath
        : paths.soulMdPath;
    await writeFile(path, content, "utf8");
  }
}

describe("createRuntime provider turn budgets", () => {
  it("passes the expanded default budgets to ProviderTurnLoop", async () => {
    const source = await readFile(new URL("./create-runtime.ts", import.meta.url), "utf8");

    expect(source).toMatch(/const providerTurnLoop = new ProviderTurnLoop\(\{[\s\S]*?budgets: \{\s*maxProviderIterations: 45,\s*maxProviderToolCalls: 100,\s*maxRepeatedToolFailures: 5,\s*maxProviderWallClockMs: 300_000\s*\}/u);
  });
});

const providerToolNameGroups = [
  { providerName: "builtin", toolNames: ["workflow.plan", "trajectory.record"] },
  { providerName: "python", toolNames: ["python.probe", "document.probe"] },
  {
    providerName: "web",
    toolNames: [
      "web.search",
      "web.extract",
      "web.crawl",
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
      "browser.navigate"
    ]
  },
  { providerName: "workspace", toolNames: ["file.read", "file.write", "file.replace", "file.search", "terminal.run"] },
  { providerName: "glob", toolNames: ["file.glob"] },
  { providerName: "grep", toolNames: ["file.grep"] },
  { providerName: "notebook", toolNames: ["notebook.edit"] },
  { providerName: "media", toolNames: ["media.probe-ffmpeg", "media.inspect", "media.extract-frame", "artifact.record"] },
  { providerName: "voice", toolNames: ["voice.speak", "voice.transcribe"] },
  { providerName: "imageGeneration", toolNames: ["image.generate"] },
  { providerName: "vision", toolNames: ["vision.analyze"] },
  { providerName: "process", toolNames: ["process.start", "process.list", "process.logs", "process.stop"] },
  { providerName: "workspaceTrust", toolNames: ["workspace.trust.status", "workspace.trust.grant", "workspace.trust.revoke"] },
  {
    providerName: "config",
    toolNames: [
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
      "config.image.setup"
    ]
  },
  { providerName: "cron", toolNames: ["cronjob"] },
  { providerName: "memory", toolNames: ["memory.curate"] },
  { providerName: "memoryRetrieval", toolNames: ["memory.read", "memory.search"] },
  { providerName: "memoryFileCompaction", toolNames: ["memory.file_compact", "memory.file_compaction_restore"] },
  { providerName: "sessionSearch", toolNames: ["session_search"] },
  {
    providerName: "skill",
    toolNames: [
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
      "skill.export"
    ]
  },
  { providerName: "knowledgeMemory", toolNames: ["knowledge.memory.inspect", "knowledge.memory.deactivate"] },
  { providerName: "knowledgeCode", toolNames: ["knowledge.code.query"] },
  { providerName: "delegation", toolNames: ["delegate_task"] },
  { providerName: "executeCode", toolNames: ["execute_code"] }
] as const;

function buildProviderMetadataLookup(): Map<string, {
  providerKind: string;
  providerPhase: string;
}> {
  expect(providerToolNameGroups.map((group) => group.providerName)).toEqual(
    toolRegistrationPlan.map((entry) => entry.provider.name)
  );

  const manifestMetadata = new Map(toolRegistrationPlan.map((entry) => [
    entry.provider.name,
    {
      providerKind: entry.provider.kind,
      providerPhase: entry.phase
    }
  ]));
  const metadataByToolName = new Map<string, {
    providerKind: string;
    providerPhase: string;
  }>();

  for (const group of providerToolNameGroups) {
    const metadata = manifestMetadata.get(group.providerName);
    expect(metadata, `missing manifest metadata for ${group.providerName}`).toBeDefined();
    for (const toolName of group.toolNames) {
      metadataByToolName.set(toolName, metadata!);
    }
  }

  return metadataByToolName;
}

function schemaAliasOrder(inputSchema: unknown): string[] {
  const properties = (inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties;
  return Object.keys(properties ?? {}).sort();
}

describe("createRuntime token branding", () => {
  it("generates a non-scaffold session id and default title when omitted", async () => {
    const { sessionId: _sessionId, ...options } = await minimalRuntimeOptions();
    const sessionDb = new InMemorySessionDB();
    const runtime = await createRuntime({ ...options, sessionDb });

    try {
      expect(runtime.sessionId).not.toBe("scaffold");
      expect(runtime.sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
      await expect(sessionDb.getSession(runtime.sessionId)).resolves.toEqual(expect.objectContaining({
        id: runtime.sessionId,
        title: "EstaCoda session"
      }));
    } finally {
      await runtime.dispose();
    }
  });

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
  it("passes memoryRetrievalService through session tool contexts", async () => {
    const options = await minimalRuntimeOptions();
    const homeDir = await mkdtemp(join(tmpdir(), "estacoda-runtime-memory-home-"));
    await writeProfileMemoryFixture(homeDir, "alpha", {
      "USER.md": "Runtime retrieval context."
    });

    const memoryContexts: SessionToolContext[] = [];
    const knowledgeContexts: SessionToolContext[] = [];
    const originalMemoryCreateTools = memoryToolProvider.createTools.bind(memoryToolProvider);
    const originalKnowledgeCreateTools = knowledgeMemoryToolProvider.createTools.bind(knowledgeMemoryToolProvider);
    const memorySpy = vi.spyOn(memoryToolProvider, "createTools").mockImplementation((ctx) => {
      memoryContexts.push(ctx);
      return originalMemoryCreateTools(ctx);
    });
    const knowledgeSpy = vi.spyOn(knowledgeMemoryToolProvider, "createTools").mockImplementation((ctx) => {
      knowledgeContexts.push(ctx);
      return originalKnowledgeCreateTools(ctx);
    });

    let runtime: Awaited<ReturnType<typeof createRuntime>> | undefined;
    try {
      runtime = await createRuntime({
        ...options,
        homeDir,
        profileId: "alpha"
      });

      expect(memoryContexts[0]?.memoryRetrievalService).toBeDefined();
      expect(knowledgeContexts[0]?.memoryRetrievalService).toBe(memoryContexts[0]?.memoryRetrievalService);
      const result = await memoryContexts[0]!.memoryRetrievalService!.read({
        profileId: "alpha",
        sourceType: "memory_file",
        sourceId: "USER.md"
      });
      expect(result.result).toMatchObject({
        source: "USER.md",
        content: "Runtime retrieval context.",
        contextLabel: "local-memory-context"
      });
    } finally {
      await runtime?.dispose();
      memorySpy.mockRestore();
      knowledgeSpy.mockRestore();
    }
  });

  it("constructs memoryRetrievalService with disabled memory index config", async () => {
    const options = await minimalRuntimeOptions();
    const homeDir = await mkdtemp(join(tmpdir(), "estacoda-runtime-memory-disabled-"));
    await writeProfileMemoryFixture(homeDir, "alpha", {
      "USER.md": "Disabled index fallback context."
    });

    const contexts: SessionToolContext[] = [];
    const originalCreateTools = memoryToolProvider.createTools.bind(memoryToolProvider);
    const memorySpy = vi.spyOn(memoryToolProvider, "createTools").mockImplementation((ctx) => {
      contexts.push(ctx);
      return originalCreateTools(ctx);
    });

    let runtime: Awaited<ReturnType<typeof createRuntime>> | undefined;
    try {
      runtime = await createRuntime({
        ...options,
        homeDir,
        profileId: "alpha",
        memory: normalizeMemoryConfig({
          retrieval: { enabled: false },
          index: { enabled: false }
        })
      });

      const service = contexts[0]?.memoryRetrievalService;
      expect(service).toBeDefined();
      const result = await service!.read({
        profileId: "alpha",
        sourceType: "memory_file",
        sourceId: "USER.md"
      });
      expect(result.result).toBeNull();
      expect(JSON.stringify(result)).not.toContain("Disabled index fallback context.");
      expect(result.diagnostics).toMatchObject({
        indexEnabled: false,
        indexAvailable: false,
        fallbackUsed: false
      });
      expect(result.diagnostics.diagnostics).toContainEqual(expect.objectContaining({
        code: "memory-retrieval-disabled"
      }));
    } finally {
      await runtime?.dispose();
      memorySpy.mockRestore();
    }
  });

  it("registers memory read/search tools without changing session_search", async () => {
    const options = await minimalRuntimeOptions();
    const runtime = await createRuntime(options);
    try {
      const names = runtime.tools().map((tool) => tool.name);

      expect(sessionSearchToolProvider.name).toBe("sessionSearch");
      expect(names).toContain("memory.read");
      expect(names).toContain("memory.search");
      expect(names).toContain("session_search");
    } finally {
      await runtime.dispose();
    }
  });

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
      const tools = runtime.tools();
      const expectedToolNames = providerToolNameGroups.flatMap((group) => group.toolNames);
      expect(tools.map((tool) => tool.name)).toEqual(expectedToolNames);

      const providerMetadataByToolName = buildProviderMetadataLookup();
      expect(tools.map((tool, orderIndex) => {
        const providerMetadata = providerMetadataByToolName.get(tool.name);
        expect(providerMetadata, `missing provider metadata for ${tool.name}`).toBeDefined();
        return {
          name: tool.name,
          toolsets: tool.toolsets ?? [],
          orderIndex,
          providerKind: providerMetadata!.providerKind,
          providerPhase: providerMetadata!.providerPhase,
          riskClass: tool.riskClass,
          requiredConfig: tool.requiredConfig,
          maxResultSizeChars: tool.maxResultSizeChars,
          schemaAliasOrder: schemaAliasOrder(tool.inputSchema)
        };
      })).toMatchInlineSnapshot(`
        [
          {
            "maxResultSizeChars": 4000,
            "name": "workflow.plan",
            "orderIndex": 0,
            "providerKind": "static",
            "providerPhase": "pre-skill-visibility",
            "requiredConfig": undefined,
            "riskClass": "read-only-local",
            "schemaAliasOrder": [
              "firstStep",
              "intent",
              "previousResults",
              "skill",
              "stepDescription",
              "workflowStep",
            ],
            "toolsets": [
              "core",
              "research",
            ],
          },
          {
            "maxResultSizeChars": 2000,
            "name": "trajectory.record",
            "orderIndex": 1,
            "providerKind": "static",
            "providerPhase": "pre-skill-visibility",
            "requiredConfig": undefined,
            "riskClass": "read-only-local",
            "schemaAliasOrder": [
              "data",
              "kind",
            ],
            "toolsets": [
              "core",
              "research",
            ],
          },
          {
            "maxResultSizeChars": 2000,
            "name": "python.probe",
            "orderIndex": 2,
            "providerKind": "session",
            "providerPhase": "pre-skill-visibility",
            "requiredConfig": undefined,
            "riskClass": "read-only-local",
            "schemaAliasOrder": [
              "reason",
            ],
            "toolsets": [
              "core",
              "research",
            ],
          },
          {
            "maxResultSizeChars": 4000,
            "name": "document.probe",
            "orderIndex": 3,
            "providerKind": "session",
            "providerPhase": "pre-skill-visibility",
            "requiredConfig": undefined,
            "riskClass": "read-only-local",
            "schemaAliasOrder": [
              "maxPreviewChars",
              "path",
            ],
            "toolsets": [
              "files",
              "media",
              "research",
            ],
          },
          {
            "maxResultSizeChars": 8000,
            "name": "web.search",
            "orderIndex": 4,
            "providerKind": "session",
            "providerPhase": "pre-skill-visibility",
            "requiredConfig": undefined,
            "riskClass": "read-only-network",
            "schemaAliasOrder": [
              "maxResults",
              "query",
            ],
            "toolsets": [
              "web",
              "research",
            ],
          },
          {
            "maxResultSizeChars": 24000,
            "name": "web.extract",
            "orderIndex": 5,
            "providerKind": "session",
            "providerPhase": "pre-skill-visibility",
            "requiredConfig": undefined,
            "riskClass": "read-only-network",
            "schemaAliasOrder": [
              "maxContentChars",
              "text",
              "url",
            ],
            "toolsets": [
              "web",
              "research",
            ],
          },
          {
            "maxResultSizeChars": 12000,
            "name": "web.crawl",
            "orderIndex": 6,
            "providerKind": "session",
            "providerPhase": "pre-skill-visibility",
            "requiredConfig": undefined,
            "riskClass": "read-only-network",
            "schemaAliasOrder": [
              "maxContentChars",
              "maxPages",
              "text",
              "url",
            ],
            "toolsets": [
              "web",
              "research",
            ],
          },
          {
            "maxResultSizeChars": 3000,
            "name": "browser.status",
            "orderIndex": 7,
            "providerKind": "session",
            "providerPhase": "pre-skill-visibility",
            "requiredConfig": undefined,
            "riskClass": "read-only-network",
            "schemaAliasOrder": [],
            "toolsets": [
              "browser",
              "core",
            ],
          },
          {
            "maxResultSizeChars": 8000,
            "name": "browser.snapshot",
            "orderIndex": 8,
            "providerKind": "session",
            "providerPhase": "pre-skill-visibility",
            "requiredConfig": undefined,
            "riskClass": "read-only-network",
            "schemaAliasOrder": [
              "sessionId",
            ],
            "toolsets": [
              "browser",
              "web",
              "research",
            ],
          },
          {
            "maxResultSizeChars": 8000,
            "name": "browser.click",
            "orderIndex": 9,
            "providerKind": "session",
            "providerPhase": "pre-skill-visibility",
            "requiredConfig": undefined,
            "riskClass": "read-only-network",
            "schemaAliasOrder": [
              "ref",
              "sessionId",
            ],
            "toolsets": [
              "browser",
              "web",
              "research",
            ],
          },
          {
            "maxResultSizeChars": 8000,
            "name": "browser.type",
            "orderIndex": 10,
            "providerKind": "session",
            "providerPhase": "pre-skill-visibility",
            "requiredConfig": undefined,
            "riskClass": "read-only-network",
            "schemaAliasOrder": [
              "ref",
              "sessionId",
              "text",
            ],
            "toolsets": [
              "browser",
              "web",
              "research",
            ],
          },
          {
            "maxResultSizeChars": 8000,
            "name": "browser.scroll",
            "orderIndex": 11,
            "providerKind": "session",
            "providerPhase": "pre-skill-visibility",
            "requiredConfig": undefined,
            "riskClass": "read-only-network",
            "schemaAliasOrder": [
              "amount",
              "direction",
              "sessionId",
            ],
            "toolsets": [
              "browser",
              "web",
              "research",
            ],
          },
          {
            "maxResultSizeChars": 8000,
            "name": "browser.press",
            "orderIndex": 12,
            "providerKind": "session",
            "providerPhase": "pre-skill-visibility",
            "requiredConfig": undefined,
            "riskClass": "read-only-network",
            "schemaAliasOrder": [
              "key",
              "sessionId",
            ],
            "toolsets": [
              "browser",
              "web",
              "research",
            ],
          },
          {
            "maxResultSizeChars": 8000,
            "name": "browser.back",
            "orderIndex": 13,
            "providerKind": "session",
            "providerPhase": "pre-skill-visibility",
            "requiredConfig": undefined,
            "riskClass": "read-only-network",
            "schemaAliasOrder": [
              "sessionId",
            ],
            "toolsets": [
              "browser",
              "web",
              "research",
            ],
          },
          {
            "maxResultSizeChars": 5000,
            "name": "browser.get_images",
            "orderIndex": 14,
            "providerKind": "session",
            "providerPhase": "pre-skill-visibility",
            "requiredConfig": undefined,
            "riskClass": "read-only-network",
            "schemaAliasOrder": [
              "sessionId",
            ],
            "toolsets": [
              "browser",
              "web",
              "research",
            ],
          },
          {
            "maxResultSizeChars": 8000,
            "name": "browser.console",
            "orderIndex": 15,
            "providerKind": "session",
            "providerPhase": "pre-skill-visibility",
            "requiredConfig": undefined,
            "riskClass": "read-only-network",
            "schemaAliasOrder": [
              "clear",
              "sessionId",
            ],
            "toolsets": [
              "browser",
              "web",
              "research",
            ],
          },
          {
            "maxResultSizeChars": 8000,
            "name": "browser.cdp",
            "orderIndex": 16,
            "providerKind": "session",
            "providerPhase": "pre-skill-visibility",
            "requiredConfig": undefined,
            "riskClass": "external-side-effect",
            "schemaAliasOrder": [
              "method",
              "params",
              "sessionId",
            ],
            "toolsets": [
              "dangerous",
            ],
          },
          {
            "maxResultSizeChars": 3000,
            "name": "browser.screenshot",
            "orderIndex": 17,
            "providerKind": "session",
            "providerPhase": "pre-skill-visibility",
            "requiredConfig": undefined,
            "riskClass": "read-only-network",
            "schemaAliasOrder": [
              "sessionId",
            ],
            "toolsets": [
              "browser",
              "web",
              "research",
            ],
          },
          {
            "maxResultSizeChars": 8000,
            "name": "browser.vision",
            "orderIndex": 18,
            "providerKind": "session",
            "providerPhase": "pre-skill-visibility",
            "requiredConfig": undefined,
            "riskClass": "read-only-network",
            "schemaAliasOrder": [
              "prompt",
              "sessionId",
            ],
            "toolsets": [
              "browser",
              "web",
              "research",
              "media",
            ],
          },
          {
            "maxResultSizeChars": 8000,
            "name": "browser.dialog",
            "orderIndex": 19,
            "providerKind": "session",
            "providerPhase": "pre-skill-visibility",
            "requiredConfig": undefined,
            "riskClass": "read-only-network",
            "schemaAliasOrder": [
              "action",
              "promptText",
              "sessionId",
            ],
            "toolsets": [
              "browser",
              "web",
              "research",
            ],
          },
          {
            "maxResultSizeChars": 4000,
            "name": "browser.navigate",
            "orderIndex": 20,
            "providerKind": "session",
            "providerPhase": "pre-skill-visibility",
            "requiredConfig": undefined,
            "riskClass": "read-only-network",
            "schemaAliasOrder": [
              "text",
              "url",
            ],
            "toolsets": [
              "browser",
              "web",
              "research",
            ],
          },
          {
            "maxResultSizeChars": 48000,
            "name": "file.read",
            "orderIndex": 21,
            "providerKind": "session",
            "providerPhase": "pre-skill-visibility",
            "requiredConfig": undefined,
            "riskClass": "read-only-local",
            "schemaAliasOrder": [
              "lineEnd",
              "lineStart",
              "path",
            ],
            "toolsets": [
              "files",
              "coding",
              "research",
            ],
          },
          {
            "maxResultSizeChars": 2000,
            "name": "file.write",
            "orderIndex": 22,
            "providerKind": "session",
            "providerPhase": "pre-skill-visibility",
            "requiredConfig": undefined,
            "riskClass": "workspace-write",
            "schemaAliasOrder": [
              "content",
              "path",
            ],
            "toolsets": [
              "files",
              "coding",
            ],
          },
          {
            "maxResultSizeChars": 3000,
            "name": "file.replace",
            "orderIndex": 23,
            "providerKind": "session",
            "providerPhase": "pre-skill-visibility",
            "requiredConfig": undefined,
            "riskClass": "workspace-write",
            "schemaAliasOrder": [
              "newText",
              "oldText",
              "path",
            ],
            "toolsets": [
              "files",
              "coding",
            ],
          },
          {
            "maxResultSizeChars": 12000,
            "name": "file.search",
            "orderIndex": 24,
            "providerKind": "session",
            "providerPhase": "pre-skill-visibility",
            "requiredConfig": undefined,
            "riskClass": "read-only-local",
            "schemaAliasOrder": [
              "path",
              "query",
              "regex",
            ],
            "toolsets": [
              "files",
              "coding",
              "research",
            ],
          },
          {
            "maxResultSizeChars": 16000,
            "name": "terminal.run",
            "orderIndex": 25,
            "providerKind": "session",
            "providerPhase": "pre-skill-visibility",
            "requiredConfig": undefined,
            "riskClass": "workspace-write",
            "schemaAliasOrder": [
              "command",
              "timeoutMs",
            ],
            "toolsets": [
              "shell-readonly",
              "shell-write",
              "coding",
              "research",
            ],
          },
          {
            "maxResultSizeChars": 20000,
            "name": "file.glob",
            "orderIndex": 26,
            "providerKind": "session",
            "providerPhase": "pre-skill-visibility",
            "requiredConfig": undefined,
            "riskClass": "read-only-local",
            "schemaAliasOrder": [
              "include_hidden",
              "limit",
              "offset",
              "path",
              "pattern",
              "sort",
            ],
            "toolsets": [
              "files",
              "coding",
              "research",
            ],
          },
          {
            "maxResultSizeChars": 150000,
            "name": "file.grep",
            "orderIndex": 27,
            "providerKind": "session",
            "providerPhase": "pre-skill-visibility",
            "requiredConfig": undefined,
            "riskClass": "read-only-local",
            "schemaAliasOrder": [
              "after",
              "before",
              "context",
              "glob",
              "ignore_case",
              "include_hidden",
              "limit",
              "line_numbers",
              "max_filesize",
              "max_line_chars",
              "max_result_chars",
              "multiline",
              "offset",
              "output_mode",
              "path",
              "pattern",
              "type",
            ],
            "toolsets": [
              "files",
              "coding",
              "research",
            ],
          },
          {
            "maxResultSizeChars": 4000,
            "name": "notebook.edit",
            "orderIndex": 28,
            "providerKind": "session",
            "providerPhase": "pre-skill-visibility",
            "requiredConfig": undefined,
            "riskClass": "workspace-write",
            "schemaAliasOrder": [
              "cell_id",
              "cell_type",
              "edit_mode",
              "expected_mtime_ms",
              "new_source",
              "notebook_path",
            ],
            "toolsets": [
              "files",
              "coding",
            ],
          },
          {
            "maxResultSizeChars": 2000,
            "name": "media.probe-ffmpeg",
            "orderIndex": 29,
            "providerKind": "session",
            "providerPhase": "pre-skill-visibility",
            "requiredConfig": undefined,
            "riskClass": "read-only-local",
            "schemaAliasOrder": [],
            "toolsets": [
              "media",
              "core",
            ],
          },
          {
            "maxResultSizeChars": 8000,
            "name": "media.inspect",
            "orderIndex": 30,
            "providerKind": "session",
            "providerPhase": "pre-skill-visibility",
            "requiredConfig": undefined,
            "riskClass": "read-only-local",
            "schemaAliasOrder": [
              "path",
            ],
            "toolsets": [
              "media",
              "files",
              "research",
            ],
          },
          {
            "maxResultSizeChars": 4000,
            "name": "media.extract-frame",
            "orderIndex": 31,
            "providerKind": "session",
            "providerPhase": "pre-skill-visibility",
            "requiredConfig": undefined,
            "riskClass": "workspace-write",
            "schemaAliasOrder": [
              "atSeconds",
              "outputPath",
              "path",
            ],
            "toolsets": [
              "media",
              "files",
            ],
          },
          {
            "maxResultSizeChars": 4000,
            "name": "artifact.record",
            "orderIndex": 32,
            "providerKind": "session",
            "providerPhase": "pre-skill-visibility",
            "requiredConfig": undefined,
            "riskClass": "shared-state-mutation",
            "schemaAliasOrder": [
              "kind",
              "path",
              "summary",
            ],
            "toolsets": [
              "media",
              "files",
              "research",
            ],
          },
          {
            "maxResultSizeChars": 4000,
            "name": "voice.speak",
            "orderIndex": 33,
            "providerKind": "session",
            "providerPhase": "pre-skill-visibility",
            "requiredConfig": undefined,
            "riskClass": "external-side-effect",
            "schemaAliasOrder": [
              "format",
              "model",
              "text",
              "voice",
            ],
            "toolsets": [
              "media",
              "core",
            ],
          },
          {
            "maxResultSizeChars": 8000,
            "name": "voice.transcribe",
            "orderIndex": 34,
            "providerKind": "session",
            "providerPhase": "pre-skill-visibility",
            "requiredConfig": undefined,
            "riskClass": "read-only-local",
            "schemaAliasOrder": [
              "language",
              "model",
              "path",
              "prompt",
            ],
            "toolsets": [
              "media",
              "research",
            ],
          },
          {
            "maxResultSizeChars": 4000,
            "name": "image.generate",
            "orderIndex": 35,
            "providerKind": "session",
            "providerPhase": "pre-skill-visibility",
            "requiredConfig": undefined,
            "riskClass": "external-side-effect",
            "schemaAliasOrder": [
              "aspectRatio",
              "model",
              "prompt",
              "seed",
            ],
            "toolsets": [
              "media",
              "telegram",
            ],
          },
          {
            "maxResultSizeChars": 8000,
            "name": "vision.analyze",
            "orderIndex": 36,
            "providerKind": "session",
            "providerPhase": "pre-skill-visibility",
            "requiredConfig": undefined,
            "riskClass": "read-only-local",
            "schemaAliasOrder": [
              "path",
              "prompt",
            ],
            "toolsets": [
              "media",
              "research",
              "telegram",
              "core",
            ],
          },
          {
            "maxResultSizeChars": 3000,
            "name": "process.start",
            "orderIndex": 37,
            "providerKind": "session",
            "providerPhase": "pre-skill-visibility",
            "requiredConfig": undefined,
            "riskClass": "workspace-write",
            "schemaAliasOrder": [
              "command",
            ],
            "toolsets": [
              "shell-write",
              "coding",
              "research",
            ],
          },
          {
            "maxResultSizeChars": 6000,
            "name": "process.list",
            "orderIndex": 38,
            "providerKind": "session",
            "providerPhase": "pre-skill-visibility",
            "requiredConfig": undefined,
            "riskClass": "read-only-local",
            "schemaAliasOrder": [],
            "toolsets": [
              "shell-readonly",
              "coding",
              "research",
            ],
          },
          {
            "maxResultSizeChars": 12000,
            "name": "process.logs",
            "orderIndex": 39,
            "providerKind": "session",
            "providerPhase": "pre-skill-visibility",
            "requiredConfig": undefined,
            "riskClass": "read-only-local",
            "schemaAliasOrder": [
              "id",
              "tailChars",
            ],
            "toolsets": [
              "shell-readonly",
              "coding",
              "research",
            ],
          },
          {
            "maxResultSizeChars": 3000,
            "name": "process.stop",
            "orderIndex": 40,
            "providerKind": "session",
            "providerPhase": "pre-skill-visibility",
            "requiredConfig": undefined,
            "riskClass": "workspace-write",
            "schemaAliasOrder": [
              "id",
              "signal",
            ],
            "toolsets": [
              "shell-write",
              "coding",
              "research",
            ],
          },
          {
            "maxResultSizeChars": 2000,
            "name": "workspace.trust.status",
            "orderIndex": 41,
            "providerKind": "runtime",
            "providerPhase": "pre-skill-visibility",
            "requiredConfig": undefined,
            "riskClass": "read-only-local",
            "schemaAliasOrder": [],
            "toolsets": [
              "core",
              "files",
              "coding",
            ],
          },
          {
            "maxResultSizeChars": 2000,
            "name": "workspace.trust.grant",
            "orderIndex": 42,
            "providerKind": "runtime",
            "providerPhase": "pre-skill-visibility",
            "requiredConfig": undefined,
            "riskClass": "shared-state-mutation",
            "schemaAliasOrder": [
              "label",
            ],
            "toolsets": [
              "core",
              "files",
              "coding",
            ],
          },
          {
            "maxResultSizeChars": 2000,
            "name": "workspace.trust.revoke",
            "orderIndex": 43,
            "providerKind": "runtime",
            "providerPhase": "pre-skill-visibility",
            "requiredConfig": undefined,
            "riskClass": "shared-state-mutation",
            "schemaAliasOrder": [],
            "toolsets": [
              "core",
              "files",
              "coding",
            ],
          },
          {
            "maxResultSizeChars": 4000,
            "name": "config.provider.status",
            "orderIndex": 44,
            "providerKind": "session",
            "providerPhase": "pre-skill-visibility",
            "requiredConfig": undefined,
            "riskClass": "read-only-local",
            "schemaAliasOrder": [],
            "toolsets": [
              "core",
            ],
          },
          {
            "maxResultSizeChars": 3000,
            "name": "config.security.status",
            "orderIndex": 45,
            "providerKind": "session",
            "providerPhase": "pre-skill-visibility",
            "requiredConfig": undefined,
            "riskClass": "read-only-local",
            "schemaAliasOrder": [],
            "toolsets": [
              "core",
            ],
          },
          {
            "maxResultSizeChars": 5000,
            "name": "config.compression.status",
            "orderIndex": 46,
            "providerKind": "session",
            "providerPhase": "pre-skill-visibility",
            "requiredConfig": undefined,
            "riskClass": "read-only-local",
            "schemaAliasOrder": [],
            "toolsets": [
              "core",
            ],
          },
          {
            "maxResultSizeChars": 3000,
            "name": "config.security.setup",
            "orderIndex": 47,
            "providerKind": "session",
            "providerPhase": "pre-skill-visibility",
            "requiredConfig": undefined,
            "riskClass": "shared-state-mutation",
            "schemaAliasOrder": [
              "assessorEnabled",
              "assessorModel",
              "assessorProvider",
              "assessorTimeoutMs",
              "mode",
            ],
            "toolsets": [
              "core",
            ],
          },
          {
            "maxResultSizeChars": 3000,
            "name": "config.web.setup",
            "orderIndex": 48,
            "providerKind": "session",
            "providerPhase": "pre-skill-visibility",
            "requiredConfig": undefined,
            "riskClass": "shared-state-mutation",
            "schemaAliasOrder": [
              "enableNetwork",
              "maxContentChars",
            ],
            "toolsets": [
              "core",
              "web",
            ],
          },
          {
            "maxResultSizeChars": 3000,
            "name": "config.browser.setup",
            "orderIndex": 49,
            "providerKind": "session",
            "providerPhase": "pre-skill-visibility",
            "requiredConfig": undefined,
            "riskClass": "shared-state-mutation",
            "schemaAliasOrder": [
              "autoLaunch",
              "backend",
              "cdpUrl",
              "cloudProvider",
              "launchCommand",
            ],
            "toolsets": [
              "core",
              "browser",
            ],
          },
          {
            "maxResultSizeChars": 5000,
            "name": "config.mcp.status",
            "orderIndex": 50,
            "providerKind": "session",
            "providerPhase": "pre-skill-visibility",
            "requiredConfig": undefined,
            "riskClass": "read-only-local",
            "schemaAliasOrder": [],
            "toolsets": [
              "core",
              "mcp",
            ],
          },
          {
            "maxResultSizeChars": 5000,
            "name": "config.mcp.setup",
            "orderIndex": 51,
            "providerKind": "session",
            "providerPhase": "pre-skill-visibility",
            "requiredConfig": undefined,
            "riskClass": "shared-state-mutation",
            "schemaAliasOrder": [
              "args",
              "command",
              "connectTimeoutMs",
              "cwd",
              "enabled",
              "env",
              "excludeTools",
              "exposePrompts",
              "exposeResources",
              "headers",
              "includeTools",
              "name",
              "promptGetRiskClass",
              "resourceReadRiskClass",
              "timeoutMs",
              "toolPrefix",
              "toolRiskClass",
              "transport",
              "trust",
              "url",
            ],
            "toolsets": [
              "core",
              "mcp",
            ],
          },
          {
            "maxResultSizeChars": 5000,
            "name": "config.telegram.setup",
            "orderIndex": 52,
            "providerKind": "session",
            "providerPhase": "pre-skill-visibility",
            "requiredConfig": undefined,
            "riskClass": "shared-state-mutation",
            "schemaAliasOrder": [
              "allowedChatIds",
              "allowedUserIds",
              "botToken",
              "botTokenEnv",
              "defaultChatId",
              "enabled",
              "pollTimeoutSeconds",
            ],
            "toolsets": [
              "core",
            ],
          },
          {
            "maxResultSizeChars": 3000,
            "name": "config.telegram.status",
            "orderIndex": 53,
            "providerKind": "session",
            "providerPhase": "pre-skill-visibility",
            "requiredConfig": undefined,
            "riskClass": "read-only-local",
            "schemaAliasOrder": [],
            "toolsets": [
              "core",
            ],
          },
          {
            "maxResultSizeChars": 3000,
            "name": "config.image.status",
            "orderIndex": 54,
            "providerKind": "session",
            "providerPhase": "pre-skill-visibility",
            "requiredConfig": undefined,
            "riskClass": "read-only-local",
            "schemaAliasOrder": [],
            "toolsets": [
              "core",
              "media",
            ],
          },
          {
            "maxResultSizeChars": 6000,
            "name": "config.provider.setup",
            "orderIndex": 55,
            "providerKind": "session",
            "providerPhase": "pre-skill-visibility",
            "requiredConfig": undefined,
            "riskClass": "shared-state-mutation",
            "schemaAliasOrder": [
              "apiKey",
              "apiKeyEnv",
              "baseUrl",
              "enableNetwork",
              "model",
              "primary",
              "provider",
            ],
            "toolsets": [
              "core",
            ],
          },
          {
            "maxResultSizeChars": 5000,
            "name": "config.image.setup",
            "orderIndex": 56,
            "providerKind": "session",
            "providerPhase": "pre-skill-visibility",
            "requiredConfig": undefined,
            "riskClass": "shared-state-mutation",
            "schemaAliasOrder": [
              "apiKey",
              "apiKeyEnv",
              "baseUrl",
              "model",
              "modelVersion",
              "provider",
              "useGateway",
            ],
            "toolsets": [
              "core",
              "media",
            ],
          },
          {
            "maxResultSizeChars": 4000,
            "name": "cronjob",
            "orderIndex": 57,
            "providerKind": "runtime",
            "providerPhase": "pre-skill-visibility",
            "requiredConfig": undefined,
            "riskClass": "shared-state-mutation",
            "schemaAliasOrder": [
              "action",
              "add_skill",
              "clear_script",
              "clear_skills",
              "delivery",
              "job_id",
              "name",
              "prompt",
              "remove_skill",
              "repeat",
              "schedule",
              "script",
              "script_args",
              "script_timeout_ms",
              "skill",
              "skills",
            ],
            "toolsets": [
              "core",
              "cron",
            ],
          },
          {
            "maxResultSizeChars": 2000,
            "name": "memory.curate",
            "orderIndex": 58,
            "providerKind": "session",
            "providerPhase": "pre-skill-visibility",
            "requiredConfig": undefined,
            "riskClass": "workspace-write",
            "schemaAliasOrder": [
              "content",
              "file",
              "kind",
              "match",
              "replacement",
            ],
            "toolsets": [
              "core",
              "memory",
            ],
          },
          {
            "maxResultSizeChars": 20000,
            "name": "memory.read",
            "orderIndex": 59,
            "providerKind": "session",
            "providerPhase": "pre-skill-visibility",
            "requiredConfig": undefined,
            "riskClass": "read-only-local",
            "schemaAliasOrder": [
              "includeProtected",
              "key",
              "maxChars",
              "source",
            ],
            "toolsets": [
              "core",
              "memory",
            ],
          },
          {
            "maxResultSizeChars": 20000,
            "name": "memory.search",
            "orderIndex": 60,
            "providerKind": "session",
            "providerPhase": "pre-skill-visibility",
            "requiredConfig": undefined,
            "riskClass": "read-only-local",
            "schemaAliasOrder": [
              "includeProtected",
              "maxChars",
              "maxResults",
              "query",
            ],
            "toolsets": [
              "core",
              "memory",
            ],
          },
          {
            "maxResultSizeChars": 6000,
            "name": "memory.file_compact",
            "orderIndex": 61,
            "providerKind": "session",
            "providerPhase": "pre-skill-visibility",
            "requiredConfig": undefined,
            "riskClass": "workspace-write",
            "schemaAliasOrder": [
              "dryRun",
              "file",
            ],
            "toolsets": [
              "core",
              "memory",
            ],
          },
          {
            "maxResultSizeChars": 2000,
            "name": "memory.file_compaction_restore",
            "orderIndex": 62,
            "providerKind": "session",
            "providerPhase": "pre-skill-visibility",
            "requiredConfig": undefined,
            "riskClass": "workspace-write",
            "schemaAliasOrder": [
              "backupId",
              "file",
            ],
            "toolsets": [
              "core",
              "memory",
            ],
          },
          {
            "maxResultSizeChars": 20000,
            "name": "session_search",
            "orderIndex": 63,
            "providerKind": "session",
            "providerPhase": "pre-skill-visibility",
            "requiredConfig": undefined,
            "riskClass": "read-only-local",
            "schemaAliasOrder": [
              "around_message_id",
              "limit",
              "mode",
              "query",
              "role_filter",
              "session_id",
              "sort",
              "window",
            ],
            "toolsets": [
              "core",
              "memory",
            ],
          },
          {
            "maxResultSizeChars": 12000,
            "name": "skill.list",
            "orderIndex": 64,
            "providerKind": "session",
            "providerPhase": "post-skill-visibility",
            "requiredConfig": undefined,
            "riskClass": "read-only-local",
            "schemaAliasOrder": [
              "category",
            ],
            "toolsets": [
              "core",
              "research",
            ],
          },
          {
            "maxResultSizeChars": 24000,
            "name": "skill.view",
            "orderIndex": 65,
            "providerKind": "session",
            "providerPhase": "post-skill-visibility",
            "requiredConfig": undefined,
            "riskClass": "read-only-local",
            "schemaAliasOrder": [
              "name",
              "path",
            ],
            "toolsets": [
              "core",
              "research",
            ],
          },
          {
            "maxResultSizeChars": 16000,
            "name": "skill.inspect",
            "orderIndex": 66,
            "providerKind": "session",
            "providerPhase": "post-skill-visibility",
            "requiredConfig": undefined,
            "riskClass": "read-only-local",
            "schemaAliasOrder": [
              "name",
            ],
            "toolsets": [
              "core",
              "research",
            ],
          },
          {
            "maxResultSizeChars": 12000,
            "name": "skill.eval",
            "orderIndex": 67,
            "providerKind": "session",
            "providerPhase": "post-skill-visibility",
            "requiredConfig": undefined,
            "riskClass": "read-only-local",
            "schemaAliasOrder": [
              "name",
            ],
            "toolsets": [
              "core",
              "research",
            ],
          },
          {
            "maxResultSizeChars": 12000,
            "name": "skill.usage",
            "orderIndex": 68,
            "providerKind": "session",
            "providerPhase": "post-skill-visibility",
            "requiredConfig": undefined,
            "riskClass": "read-only-local",
            "schemaAliasOrder": [
              "name",
            ],
            "toolsets": [
              "core",
              "research",
            ],
          },
          {
            "maxResultSizeChars": 4000,
            "name": "skill.observe",
            "orderIndex": 69,
            "providerKind": "session",
            "providerPhase": "post-skill-visibility",
            "requiredConfig": undefined,
            "riskClass": "workspace-write",
            "schemaAliasOrder": [
              "candidateImprovement",
              "lesson",
              "name",
              "outcome",
              "promptSummary",
              "selectedWorkflowStep",
              "toolsAttempted",
              "type",
            ],
            "toolsets": [
              "core",
              "files",
              "research",
            ],
          },
          {
            "maxResultSizeChars": 4000,
            "name": "skill.propose_patch",
            "orderIndex": 70,
            "providerKind": "session",
            "providerPhase": "post-skill-visibility",
            "requiredConfig": undefined,
            "riskClass": "workspace-write",
            "schemaAliasOrder": [
              "confidence",
              "failures",
              "name",
              "observationIds",
              "patch",
              "reason",
              "successes",
            ],
            "toolsets": [
              "core",
              "files",
              "research",
            ],
          },
          {
            "maxResultSizeChars": 12000,
            "name": "skill.list_proposals",
            "orderIndex": 71,
            "providerKind": "session",
            "providerPhase": "post-skill-visibility",
            "requiredConfig": undefined,
            "riskClass": "read-only-local",
            "schemaAliasOrder": [
              "name",
              "status",
            ],
            "toolsets": [
              "core",
              "research",
            ],
          },
          {
            "maxResultSizeChars": 16000,
            "name": "skill.review_proposals",
            "orderIndex": 72,
            "providerKind": "session",
            "providerPhase": "post-skill-visibility",
            "requiredConfig": undefined,
            "riskClass": "read-only-local",
            "schemaAliasOrder": [
              "name",
              "status",
            ],
            "toolsets": [
              "core",
              "research",
            ],
          },
          {
            "maxResultSizeChars": 12000,
            "name": "skill.review_proposal",
            "orderIndex": 73,
            "providerKind": "session",
            "providerPhase": "post-skill-visibility",
            "requiredConfig": undefined,
            "riskClass": "read-only-local",
            "schemaAliasOrder": [
              "proposalId",
              "proposal_id",
            ],
            "toolsets": [
              "core",
              "research",
            ],
          },
          {
            "maxResultSizeChars": 4000,
            "name": "skill.approve_patch",
            "orderIndex": 74,
            "providerKind": "session",
            "providerPhase": "post-skill-visibility",
            "requiredConfig": undefined,
            "riskClass": "workspace-write",
            "schemaAliasOrder": [
              "approvedBy",
              "proposalId",
              "proposal_id",
            ],
            "toolsets": [
              "core",
              "research",
            ],
          },
          {
            "maxResultSizeChars": 4000,
            "name": "skill.reject_patch",
            "orderIndex": 75,
            "providerKind": "session",
            "providerPhase": "post-skill-visibility",
            "requiredConfig": undefined,
            "riskClass": "workspace-write",
            "schemaAliasOrder": [
              "proposalId",
              "proposal_id",
            ],
            "toolsets": [
              "core",
              "research",
            ],
          },
          {
            "maxResultSizeChars": 4000,
            "name": "skill.promote_patch",
            "orderIndex": 76,
            "providerKind": "session",
            "providerPhase": "post-skill-visibility",
            "requiredConfig": undefined,
            "riskClass": "workspace-write",
            "schemaAliasOrder": [
              "proposalId",
              "proposal_id",
            ],
            "toolsets": [
              "core",
              "files",
              "coding",
            ],
          },
          {
            "maxResultSizeChars": 4000,
            "name": "skill.create",
            "orderIndex": 77,
            "providerKind": "session",
            "providerPhase": "post-skill-visibility",
            "requiredConfig": undefined,
            "riskClass": "workspace-write",
            "schemaAliasOrder": [
              "category",
              "content",
              "description",
              "instructions",
              "name",
              "requiredToolsets",
              "whenToUse",
            ],
            "toolsets": [
              "core",
              "files",
              "coding",
            ],
          },
          {
            "maxResultSizeChars": 4000,
            "name": "skill.patch",
            "orderIndex": 78,
            "providerKind": "session",
            "providerPhase": "post-skill-visibility",
            "requiredConfig": undefined,
            "riskClass": "workspace-write",
            "schemaAliasOrder": [
              "name",
              "newString",
              "new_string",
              "oldString",
              "old_string",
              "replaceAll",
              "replace_all",
            ],
            "toolsets": [
              "core",
              "files",
              "coding",
            ],
          },
          {
            "maxResultSizeChars": 4000,
            "name": "skill.edit",
            "orderIndex": 79,
            "providerKind": "session",
            "providerPhase": "post-skill-visibility",
            "requiredConfig": undefined,
            "riskClass": "workspace-write",
            "schemaAliasOrder": [
              "content",
              "name",
            ],
            "toolsets": [
              "core",
              "files",
              "coding",
            ],
          },
          {
            "maxResultSizeChars": 4000,
            "name": "skill.delete",
            "orderIndex": 80,
            "providerKind": "session",
            "providerPhase": "post-skill-visibility",
            "requiredConfig": undefined,
            "riskClass": "destructive-local",
            "schemaAliasOrder": [
              "name",
            ],
            "toolsets": [
              "core",
              "files",
              "coding",
            ],
          },
          {
            "maxResultSizeChars": 4000,
            "name": "skill.rollback",
            "orderIndex": 81,
            "providerKind": "session",
            "providerPhase": "post-skill-visibility",
            "requiredConfig": undefined,
            "riskClass": "workspace-write",
            "schemaAliasOrder": [
              "name",
              "snapshotPath",
              "snapshot_path",
            ],
            "toolsets": [
              "core",
              "files",
              "coding",
            ],
          },
          {
            "maxResultSizeChars": 4000,
            "name": "skill.reset",
            "orderIndex": 82,
            "providerKind": "session",
            "providerPhase": "post-skill-visibility",
            "requiredConfig": undefined,
            "riskClass": "workspace-write",
            "schemaAliasOrder": [
              "mode",
              "name",
            ],
            "toolsets": [
              "core",
              "files",
              "coding",
            ],
          },
          {
            "maxResultSizeChars": 4000,
            "name": "skill.write_file",
            "orderIndex": 83,
            "providerKind": "session",
            "providerPhase": "post-skill-visibility",
            "requiredConfig": undefined,
            "riskClass": "workspace-write",
            "schemaAliasOrder": [
              "fileContent",
              "filePath",
              "file_content",
              "file_path",
              "name",
            ],
            "toolsets": [
              "core",
              "files",
              "coding",
            ],
          },
          {
            "maxResultSizeChars": 4000,
            "name": "skill.remove_file",
            "orderIndex": 84,
            "providerKind": "session",
            "providerPhase": "post-skill-visibility",
            "requiredConfig": undefined,
            "riskClass": "destructive-local",
            "schemaAliasOrder": [
              "filePath",
              "file_path",
              "name",
            ],
            "toolsets": [
              "core",
              "files",
              "coding",
            ],
          },
          {
            "maxResultSizeChars": 8000,
            "name": "skill.import",
            "orderIndex": 85,
            "providerKind": "session",
            "providerPhase": "post-skill-visibility",
            "requiredConfig": undefined,
            "riskClass": "workspace-write",
            "schemaAliasOrder": [
              "path",
            ],
            "toolsets": [
              "core",
              "files",
              "coding",
            ],
          },
          {
            "maxResultSizeChars": 4000,
            "name": "skill.export",
            "orderIndex": 86,
            "providerKind": "session",
            "providerPhase": "post-skill-visibility",
            "requiredConfig": undefined,
            "riskClass": "workspace-write",
            "schemaAliasOrder": [
              "destination",
              "name",
            ],
            "toolsets": [
              "core",
              "files",
              "coding",
            ],
          },
          {
            "maxResultSizeChars": 4000,
            "name": "knowledge.memory.inspect",
            "orderIndex": 87,
            "providerKind": "session",
            "providerPhase": "post-memory-provider",
            "requiredConfig": undefined,
            "riskClass": "read-only-local",
            "schemaAliasOrder": [
              "action",
              "activeOnly",
              "id",
              "kind",
              "limit",
            ],
            "toolsets": [
              "core",
              "memory",
            ],
          },
          {
            "maxResultSizeChars": 2000,
            "name": "knowledge.memory.deactivate",
            "orderIndex": 88,
            "providerKind": "session",
            "providerPhase": "post-memory-provider",
            "requiredConfig": undefined,
            "riskClass": "workspace-write",
            "schemaAliasOrder": [
              "id",
            ],
            "toolsets": [
              "core",
              "memory",
            ],
          },
          {
            "maxResultSizeChars": 8000,
            "name": "knowledge.code.query",
            "orderIndex": 89,
            "providerKind": "session",
            "providerPhase": "post-memory-provider",
            "requiredConfig": undefined,
            "riskClass": "read-only-local",
            "schemaAliasOrder": [
              "moduleId",
              "query",
            ],
            "toolsets": [
              "core",
              "coding",
            ],
          },
          {
            "maxResultSizeChars": 8000,
            "name": "delegate_task",
            "orderIndex": 90,
            "providerKind": "session",
            "providerPhase": "post-tool-executor",
            "requiredConfig": undefined,
            "riskClass": "shared-state-mutation",
            "schemaAliasOrder": [
              "allowedTools",
              "allowedToolsets",
              "context",
              "task",
            ],
            "toolsets": [
              "core",
              "research",
              "coding",
            ],
          },
          {
            "maxResultSizeChars": 48000,
            "name": "execute_code",
            "orderIndex": 91,
            "providerKind": "session",
            "providerPhase": "post-tool-executor",
            "requiredConfig": undefined,
            "riskClass": "workspace-write",
            "schemaAliasOrder": [
              "code",
              "input",
              "maxOutputChars",
              "timeoutMs",
            ],
            "toolsets": [
              "coding",
              "research",
            ],
          },
        ]
      `);
      expect(tools.map((tool) => tool.name)).toMatchInlineSnapshot(`
        [
          "workflow.plan",
          "trajectory.record",
          "python.probe",
          "document.probe",
          "web.search",
          "web.extract",
          "web.crawl",
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
          "file.glob",
          "file.grep",
          "notebook.edit",
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
          "memory.read",
          "memory.search",
          "memory.file_compact",
          "memory.file_compaction_restore",
          "session_search",
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

  it("removes disabled toolsets from the registry and execution path", async () => {
    const options = await minimalRuntimeOptions();
    const runtime = await createRuntime({
      ...options,
      disabledToolsets: ["shell-write"]
    });

    try {
      expect(runtime.tools().map((tool) => tool.name)).not.toContain("terminal.run");
      await expect(runtime.executeTool?.({
        tool: "terminal.run",
        toolInput: { command: "echo hidden" }
      })).resolves.toBeUndefined();
    } finally {
      await runtime.dispose();
    }
  });

  it("omits cron tools when cron registration is disabled", async () => {
    const options = await minimalRuntimeOptions();
    const runtime = await createRuntime({
      ...options,
      disableCronTools: true
    });

    try {
      expect(runtime.tools().map((tool) => tool.name)).not.toContain("cronjob");
      await expect(runtime.executeTool?.({
        tool: "cronjob",
        toolInput: { action: "list" }
      })).resolves.toBeUndefined();
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

describe("createRuntime browser backend wiring", () => {
  it("uses supervised local CDP by default from ordinary runtime config", async () => {
    const options = await minimalRuntimeOptions();
    const socket = new FakeRuntimeCdpSocket();
    const runtime = await createRuntime({
      ...options,
      cdpFetch: createRuntimeCdpFetch(),
      cdpWebSocketFactory: () => socket,
      browser: {
        backend: "local-cdp",
        cdpUrl: "http://127.0.0.1:9222",
        autoLaunch: false
      }
    });

    try {
      const result = await runtime.executeTool?.({
        tool: "browser.navigate",
        toolInput: { url: "https://93.184.216.34/" }
      });

      expect(result?.result?.ok).toBe(true);
      expect(socket.sent.map((message) => message.method)).toContain("Fetch.enable");
      expect(socket.sent.map((message) => message.method)).toContain("Page.navigate");
    } finally {
      await runtime.dispose();
    }
  });

  it("preserves injected browserBackend behavior", async () => {
    const options = await minimalRuntimeOptions();
    const runtime = await createRuntime({
      ...options,
      browserBackend: {
        kind: "mock",
        isAvailable: () => true,
        status: () => ({ backend: "mock", available: true }),
        navigate: async (input) => ({
          session: {
            id: "injected",
            backend: "mock",
            currentUrl: input.url,
            createdAt: new Date(0).toISOString()
          },
          snapshot: {
            sessionId: "injected",
            url: input.url,
            text: "Injected backend",
            elements: []
          }
        })
      }
    });

    try {
      const result = await runtime.executeTool?.({
        tool: "browser.navigate",
        toolInput: { url: "https://93.184.216.34/" }
      });

      expect(result?.result?.ok).toBe(true);
      expect(result?.result?.metadata).toMatchObject({ backend: "mock" });
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

describe("createRuntime faster-whisper runtime wiring", () => {
  it("creates managed Python lazily and resolves persistent model cache paths under global state", async () => {
    const originalTransformersCache = process.env.TRANSFORMERS_CACHE;
    delete process.env.TRANSFORMERS_CACHE;
    const homeDir = await mkdtemp(join(tmpdir(), "estacoda-runtime-home-"));
    const options = await minimalRuntimeOptions();
    const stateRoot = join(homeDir, ".estacoda");
    const createSpy = vi.spyOn(pythonEnvManager, "createManagedEnvironment").mockResolvedValue({
      ok: true,
      pythonBinary: expectedManagedPython(stateRoot)
    });
    const checkSpy = vi.spyOn(pythonEnvManager, "checkManagedEnvironment");

    try {
      const runtime = await createRuntime({
        ...options,
        homeDir,
        stt: fasterWhisperStt({
          queueDepth: 4,
          timeoutMs: 12_345
        })
      });
      expect(createSpy).not.toHaveBeenCalled();
      expect(fasterWhisperMockState.constructedOptions).toHaveLength(0);

      const result = await runtime.transcribeAudio?.({ path: await createAudioFixture() });
      await runtime.dispose();

      expect(result).toMatchObject({ ok: true, text: "runtime transcript", model: "base" });
      const persistentHfHome = join(stateRoot, "cache", "huggingface");
      expect(createSpy).toHaveBeenCalledWith({ stateRoot });
      expect(fasterWhisperMockState.constructedOptions).toHaveLength(1);
      expect(fasterWhisperMockState.constructedOptions[0]).toMatchObject({
        pythonBinary: expectedManagedPython(stateRoot),
        queueDepth: 4,
        timeoutMs: 12_345,
        env: {
          HF_HOME: persistentHfHome,
          TRANSFORMERS_CACHE: persistentHfHome
        }
      });
      expect(fasterWhisperMockState.constructedOptions[0].pythonBinary).toContain(join(stateRoot, "python-env"));
      expect(fasterWhisperMockState.constructedOptions[0].env?.HF_HOME).not.toContain("python-env");
      expect(checkSpy).not.toHaveBeenCalled();
    } finally {
      createSpy.mockRestore();
      checkSpy.mockRestore();
      if (originalTransformersCache === undefined) {
        delete process.env.TRANSFORMERS_CACHE;
      } else {
        process.env.TRANSFORMERS_CACHE = originalTransformersCache;
      }
    }
  });

  it("reports faster-whisper unavailable without failing runtime startup when lazy managed Python creation fails", async () => {
    const originalTransformersCache = process.env.TRANSFORMERS_CACHE;
    delete process.env.TRANSFORMERS_CACHE;
    const homeDir = await mkdtemp(join(tmpdir(), "estacoda-runtime-home-"));
    const options = await minimalRuntimeOptions();
    const stateRoot = join(homeDir, ".estacoda");
    const createSpy = vi.spyOn(pythonEnvManager, "createManagedEnvironment").mockResolvedValue({
      ok: false,
      reason: "ensurepip is not available"
    });

    try {
      const runtime = await createRuntime({
        ...options,
        homeDir,
        stt: fasterWhisperStt()
      });
      expect(createSpy).not.toHaveBeenCalled();
      expect(fasterWhisperMockState.constructedOptions).toHaveLength(0);

      const result = await runtime.transcribeAudio?.({ path: await createAudioFixture() });
      await runtime.dispose();

      expect(createSpy).toHaveBeenCalledWith({ stateRoot });
      expect(fasterWhisperMockState.constructedOptions).toHaveLength(0);
      expect(result).toMatchObject({ ok: false });
      if (result?.ok !== false) {
        throw new Error("expected faster-whisper transcription to fail");
      }
      expect(result.content).toContain("Local faster-whisper STT is unavailable");
      expect(result.content).toContain("ensurepip is not available");
    } finally {
      createSpy.mockRestore();
      if (originalTransformersCache === undefined) {
        delete process.env.TRANSFORMERS_CACHE;
      } else {
        process.env.TRANSFORMERS_CACHE = originalTransformersCache;
      }
    }
  });

  it("uses configured Python and Hugging Face cache overrides lazily when provided", async () => {
    const originalTransformersCache = process.env.TRANSFORMERS_CACHE;
    process.env.TRANSFORMERS_CACHE = "/existing/transformers-cache";
    const homeDir = await mkdtemp(join(tmpdir(), "estacoda-runtime-home-"));
    const options = await minimalRuntimeOptions();
    const createSpy = vi.spyOn(pythonEnvManager, "createManagedEnvironment").mockResolvedValue({
      ok: true,
      pythonBinary: "/should-not-be-used"
    });

    try {
      const runtime = await createRuntime({
        ...options,
        homeDir,
        stt: fasterWhisperStt({
          pythonBinary: "/custom/python3",
          hfHome: "/custom/huggingface"
        })
      });
      expect(fasterWhisperMockState.constructedOptions).toHaveLength(0);

      const result = await runtime.transcribeAudio?.({ path: await createAudioFixture() });
      await runtime.dispose();

      expect(result).toMatchObject({ ok: true, text: "runtime transcript", model: "base" });
      expect(fasterWhisperMockState.constructedOptions).toHaveLength(1);
      expect(fasterWhisperMockState.constructedOptions[0]).toMatchObject({
        pythonBinary: "/custom/python3",
        env: {
          HF_HOME: "/custom/huggingface",
          TRANSFORMERS_CACHE: "/existing/transformers-cache"
        }
      });
      expect(createSpy).not.toHaveBeenCalled();
    } finally {
      createSpy.mockRestore();
      if (originalTransformersCache === undefined) {
        delete process.env.TRANSFORMERS_CACHE;
      } else {
        process.env.TRANSFORMERS_CACHE = originalTransformersCache;
      }
    }
  });

  it("does not instantiate faster-whisper resources for local command mode", async () => {
    const options = await minimalRuntimeOptions();
    const runtime = await createRuntime({
      ...options,
      stt: commandStt()
    });

    await runtime.dispose();

    expect(fasterWhisperMockState.constructedOptions).toHaveLength(0);
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

  it("disposes runtime-owned faster-whisper resources", async () => {
    const options = await minimalRuntimeOptions();
    let disposed = false;
    const runtime = await createRuntime({
      ...options,
      localWhisper: {
        dispose: async () => {
          disposed = true;
        }
      } as any
    });

    await runtime.dispose();

    expect(disposed).toBe(true);
  });
});
