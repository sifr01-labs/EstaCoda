import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { DEFAULT_PROVIDER_TURN_BUDGETS } from "./agent-loop-builder.js";
import { createRuntime, createDefaultProviderRegistry, type RuntimeOptions } from "./create-runtime.js";
import { normalizeMemoryConfig } from "../config/memory-config.js";
import { DEFAULT_DELEGATION_CONFIG } from "../config/delegation-defaults.js";
import { resolveProfileStateHome } from "../config/profile-home.js";
import { createSQLiteSessionDB } from "../session/session-setup.js";
import { InMemorySessionDB } from "../session/in-memory-session-db.js";
import { WorkspaceTrustStore } from "../security/workspace-trust-store.js";
import { WorkspaceApprovalController } from "../security/workspace-approval-controller.js";
import { ProviderRegistry } from "../providers/provider-registry.js";
import type { CdpFetchLike, CdpWebSocketEvent, CdpWebSocketLike } from "../browser/cdp-client.js";
import type { BrowserBackend } from "../contracts/browser.js";
import type { ModelProfile, ProviderAdapter, ProviderCompletionOptions, ProviderRequest } from "../contracts/provider.js";
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
  closeCount = 0;
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
    this.closeCount += 1;
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

type BrowserbaseFetchCall = {
  url: string;
  method: string | undefined;
  body: string | undefined;
};

function createRuntimeBrowserbaseFetch(input: {
  calls: BrowserbaseFetchCall[];
  closeStatus?: number;
}): typeof globalThis.fetch {
  return vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const call = {
      url: url.toString(),
      method: init?.method,
      body: typeof init?.body === "string" ? init.body : undefined
    };
    input.calls.push(call);

    if (call.url.endsWith("/v1/sessions") && call.method === "POST") {
      return browserbaseResponse(200, {
        id: "bb-runtime-session",
        connectUrl: "wss://connect.browserbase.test/runtime-session"
      });
    }

    if (call.url.endsWith("/v1/sessions/bb-runtime-session") && call.method === "POST") {
      return browserbaseResponse(input.closeStatus ?? 200, { id: "bb-runtime-session" });
    }

    return browserbaseResponse(404, {});
  }) as typeof globalThis.fetch;
}

function browserbaseResponse(status: number, payload: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status >= 200 && status < 300 ? "OK" : "Error",
    json: async () => payload,
    text: async () => JSON.stringify(payload)
  } as Response;
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
  it("keeps the expanded default budgets explicit", () => {
    expect(DEFAULT_PROVIDER_TURN_BUDGETS).toEqual({
      maxProviderIterations: 45,
      maxProviderToolCalls: 100,
      maxRepeatedToolFailures: 5,
      maxProviderWallClockMs: 300_000
    });
  });
});

const providerToolNameGroups = [
  { providerName: "builtin", toolNames: ["playbook.plan", "trajectory.record"] },
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
  { providerName: "workspace", toolNames: ["file.read", "file.write", "file.replace", "file.search", "terminal.inspect", "terminal.run"] },
  { providerName: "glob", toolNames: ["file.glob"] },
  { providerName: "grep", toolNames: ["file.grep"] },
  { providerName: "notebook", toolNames: ["notebook.edit"] },
  { providerName: "media", toolNames: ["media.probe-ffmpeg", "media.inspect", "media.extract-frame", "artifact.record"] },
  { providerName: "voice", toolNames: ["voice.speak", "voice.transcribe"] },
  { providerName: "imageGeneration", toolNames: ["image.generate", "image.edit"] },
  { providerName: "vision", toolNames: ["vision.analyze"] },
  { providerName: "process", toolNames: ["process.start", "process.list", "process.logs", "process.stop"] },
  { providerName: "workspaceTrust", toolNames: ["workspace.trust.status", "workspace.trust.grant", "workspace.trust.revoke"] },
  {
    providerName: "config",
    toolNames: [
      "config.provider.status",
      "config.provider.execution_status",
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
      "skill.read",
      "skill.search",
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
      expect(runtime.trajectoryId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
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

  it("exposes a memory curation checkpoint on the runtime", async () => {
    const options = await minimalRuntimeOptions();
    const sessionDb = new InMemorySessionDB();
    const runtime = await createRuntime({
      ...options,
      sessionDb,
      memory: normalizeMemoryConfig({
        curation: { mode: "review" }
      })
    });

    try {
      await sessionDb.appendMessage({
        id: "m1",
        sessionId: runtime.sessionId,
        role: "user",
        content: "Remember I use pnpm."
      });

      const result = await runtime.auditMemoryCuration?.({ trigger: "manual" });

      expect(result).toMatchObject({
        trigger: "manual",
        status: "ignored",
        reviewedMessageCount: 1
      });
      await expect(sessionDb.listEvents(runtime.sessionId)).resolves.toContainEqual(expect.objectContaining({
        kind: "memory-curation",
        trigger: "manual",
        status: "ignored"
      }));
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

  it("derives AgentEvolutionPolicy from skill autonomy without changing skill routing", async () => {
    async function runtimeWithAlphaSkill(skillAutonomy: NonNullable<RuntimeOptions["skillAutonomy"]>) {
      const options = await minimalRuntimeOptions();
      const skillDir = join(options.localSkillsRoot, "alpha-route-skill");
      await mkdir(skillDir, { recursive: true });
      await writeFile(
        join(skillDir, "SKILL.md"),
        [
          "---",
          JSON.stringify({
            name: "alpha-route-skill",
            description: "Routes alpha prompts.",
            version: "1.0.0",
            category: "test",
            routing: {
              triggerPatterns: [{ type: "contains", value: "alpha route" }]
            },
            playbook: [{ id: "respond", description: "Respond to alpha route prompts" }]
          }),
          "---",
          "Use this skill for alpha route prompts."
        ].join("\n"),
        "utf8"
      );
      return await createRuntime({
        ...options,
        homeDir: await mkdtemp(join(tmpdir(), "estacoda-runtime-agent-evolution-home-")),
        sessionId: `agent-evolution-${skillAutonomy}`,
        skillAutonomy
      });
    }

    const suggestRuntime = await runtimeWithAlphaSkill("suggest");
    let suggestMatchedSkills: string[];
    let suggestSuggestedSkills: string[];
    try {
      const suggestResponse = await suggestRuntime.handle({
        text: "please use the alpha route",
        channel: "cli"
      });
      suggestMatchedSkills = suggestResponse.matchedSkills;
      suggestSuggestedSkills = suggestResponse.intent.suggestedSkills.map((skill) => skill.name);
    } finally {
      await suggestRuntime.dispose();
    }

    const autonomousRuntime = await runtimeWithAlphaSkill("autonomous");
    try {
      expect(autonomousRuntime.agentEvolutionPolicy()).toMatchObject({
        mode: "autonomous",
        routingMode: "hybrid-plus",
        shadowAutonomousDecisions: true,
        autoPromoteEligibleLocalChanges: false,
        autoRollbackEligibleLocalChanges: false
      });

      const autonomousResponse = await autonomousRuntime.handle({
        text: "please use the alpha route",
        channel: "cli"
      });

      expect(suggestMatchedSkills).toEqual(["alpha-route-skill"]);
      expect(autonomousResponse.matchedSkills).toEqual(suggestMatchedSkills);
      expect(autonomousResponse.intent.suggestedSkills.map((skill) => skill.name))
        .toEqual(suggestSuggestedSkills);
    } finally {
      await autonomousRuntime.dispose();
    }
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
            "name": "playbook.plan",
            "orderIndex": 0,
            "providerKind": "static",
            "providerPhase": "pre-skill-visibility",
            "requiredConfig": undefined,
            "riskClass": "read-only-local",
            "schemaAliasOrder": [
              "firstStep",
              "intent",
              "playbookStep",
              "previousResults",
              "skill",
              "stepDescription",
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
              "full",
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
            "name": "terminal.inspect",
            "orderIndex": 25,
            "providerKind": "session",
            "providerPhase": "pre-skill-visibility",
            "requiredConfig": undefined,
            "riskClass": "read-only-local",
            "schemaAliasOrder": [
              "argv",
            ],
            "toolsets": [
              "shell-readonly",
              "coding",
              "research",
            ],
          },
          {
            "maxResultSizeChars": 16000,
            "name": "terminal.run",
            "orderIndex": 26,
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
            "orderIndex": 27,
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
            "orderIndex": 28,
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
            "orderIndex": 29,
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
            "orderIndex": 30,
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
            "orderIndex": 31,
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
            "orderIndex": 32,
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
            "orderIndex": 33,
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
            "orderIndex": 34,
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
            "orderIndex": 35,
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
            "orderIndex": 36,
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
            "maxResultSizeChars": 4000,
            "name": "image.edit",
            "orderIndex": 37,
            "providerKind": "session",
            "providerPhase": "pre-skill-visibility",
            "requiredConfig": undefined,
            "riskClass": "external-side-effect",
            "schemaAliasOrder": [
              "aspectRatio",
              "model",
              "prompt",
              "sourceImage",
              "sourceImages",
            ],
            "toolsets": [
              "media",
              "telegram",
            ],
          },
          {
            "maxResultSizeChars": 8000,
            "name": "vision.analyze",
            "orderIndex": 38,
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
            "orderIndex": 39,
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
            "orderIndex": 40,
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
            "orderIndex": 41,
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
            "orderIndex": 42,
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
            "orderIndex": 43,
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
            "orderIndex": 44,
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
            "orderIndex": 45,
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
            "maxResultSizeChars": 4000,
            "name": "config.provider.execution_status",
            "orderIndex": 47,
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
            "orderIndex": 48,
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
            "orderIndex": 49,
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
            "orderIndex": 50,
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
            "orderIndex": 51,
            "providerKind": "session",
            "providerPhase": "pre-skill-visibility",
            "requiredConfig": undefined,
            "riskClass": "shared-state-mutation",
            "schemaAliasOrder": [
              "backend",
              "brave",
              "crawlBackend",
              "enableNetwork",
              "extractBackend",
              "maxContentChars",
              "searchBackend",
            ],
            "toolsets": [
              "core",
              "web",
            ],
          },
          {
            "maxResultSizeChars": 3000,
            "name": "config.browser.setup",
            "orderIndex": 52,
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
            "orderIndex": 53,
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
            "orderIndex": 54,
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
            "orderIndex": 55,
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
            "orderIndex": 56,
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
            "orderIndex": 57,
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
            "orderIndex": 58,
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
            "orderIndex": 59,
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
            "orderIndex": 60,
            "providerKind": "runtime",
            "providerPhase": "pre-skill-visibility",
            "requiredConfig": undefined,
            "riskClass": "shared-state-mutation",
            "schemaAliasOrder": [
              "action",
              "add_skill",
              "clear_script",
              "clear_skills",
              "contextFrom",
              "context_from",
              "delivery",
              "enabledToolsets",
              "enabled_toolsets",
              "job_id",
              "model",
              "name",
              "noAgent",
              "no_agent",
              "prompt",
              "remove_skill",
              "repeat",
              "schedule",
              "script",
              "script_args",
              "script_timeout_ms",
              "skill",
              "skills",
              "workdir",
            ],
            "toolsets": [
              "core",
              "cron",
            ],
          },
          {
            "maxResultSizeChars": 2000,
            "name": "memory.curate",
            "orderIndex": 61,
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
            "orderIndex": 62,
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
            "orderIndex": 63,
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
            "orderIndex": 64,
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
            "orderIndex": 65,
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
            "orderIndex": 66,
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
            "orderIndex": 67,
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
            "name": "skill.read",
            "orderIndex": 68,
            "providerKind": "session",
            "providerPhase": "post-skill-visibility",
            "requiredConfig": undefined,
            "riskClass": "read-only-local",
            "schemaAliasOrder": [
              "mode",
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
            "name": "skill.search",
            "orderIndex": 69,
            "providerKind": "session",
            "providerPhase": "post-skill-visibility",
            "requiredConfig": undefined,
            "riskClass": "read-only-local",
            "schemaAliasOrder": [
              "maxResults",
              "name",
              "query",
            ],
            "toolsets": [
              "core",
              "research",
            ],
          },
          {
            "maxResultSizeChars": 24000,
            "name": "skill.view",
            "orderIndex": 70,
            "providerKind": "session",
            "providerPhase": "post-skill-visibility",
            "requiredConfig": undefined,
            "riskClass": "read-only-local",
            "schemaAliasOrder": [
              "mode",
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
            "orderIndex": 71,
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
            "orderIndex": 72,
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
            "orderIndex": 73,
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
            "orderIndex": 74,
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
              "selectedPlaybookStep",
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
            "orderIndex": 75,
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
            "orderIndex": 76,
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
            "orderIndex": 77,
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
            "orderIndex": 78,
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
            "orderIndex": 79,
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
            "orderIndex": 80,
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
            "orderIndex": 81,
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
            "orderIndex": 82,
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
            "orderIndex": 83,
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
            "orderIndex": 84,
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
            "orderIndex": 85,
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
            "orderIndex": 86,
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
            "orderIndex": 87,
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
            "orderIndex": 88,
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
            "orderIndex": 89,
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
            "orderIndex": 90,
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
            "orderIndex": 91,
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
            "orderIndex": 92,
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
            "orderIndex": 93,
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
            "orderIndex": 94,
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
            "orderIndex": 95,
            "providerKind": "session",
            "providerPhase": "post-tool-executor",
            "requiredConfig": undefined,
            "riskClass": "shared-state-mutation",
            "schemaAliasOrder": [
              "allowedTools",
              "allowedToolsets",
              "context",
              "modelOverride",
              "role",
              "task",
              "tasks",
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
            "orderIndex": 96,
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
          "playbook.plan",
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
          "terminal.inspect",
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
          "image.edit",
          "vision.analyze",
          "process.start",
          "process.list",
          "process.logs",
          "process.stop",
          "workspace.trust.status",
          "workspace.trust.grant",
          "workspace.trust.revoke",
          "config.provider.status",
          "config.provider.execution_status",
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
          "skill.read",
          "skill.search",
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

  it("rejects cron tool controls for toolsets removed by runtime disabledToolsets", async () => {
    const options = await minimalRuntimeOptions();
    const runtime = await createRuntime({
      ...options,
      disabledToolsets: ["shell-write"]
    });

    try {
      await runtime.trustWorkspace?.();
      expect(runtime.tools().map((tool) => tool.name)).not.toContain("terminal.run");
      const execution = await runtime.executeTool?.({
        tool: "cronjob",
        toolInput: {
          action: "create",
          prompt: "Check the status",
          schedule: "1h",
          enabled_toolsets: ["shell-write"]
        }
      });

      expect(execution?.result).toMatchObject({
        ok: false
      });
      expect(execution?.result?.content).toContain("Unknown cron toolset: shell-write");
      const availableToolsets = execution?.result?.content.split("Available toolsets: ")[1]?.split(", ") ?? [];
      expect(availableToolsets).not.toContain("shell-write");
    } finally {
      await runtime.dispose();
    }
  });

  it("filters runtime tools to enabled registered toolsets", async () => {
    const options = await minimalRuntimeOptions();
    const runtime = await createRuntime({
      ...options,
      enabledToolsets: ["files"]
    });

    try {
      const toolNames = runtime.tools().map((tool) => tool.name);
      expect(toolNames).toContain("file.read");
      expect(toolNames).not.toContain("terminal.run");
      expect(toolNames).not.toContain("web.extract");
      await expect(runtime.executeTool?.({
        tool: "terminal.run",
        toolInput: { command: "echo hidden" }
      })).resolves.toBeUndefined();
    } finally {
      await runtime.dispose();
    }
  });

  it("runs delegate_task through a real child AgentLoop and records child metadata", async () => {
    const options = await minimalRuntimeOptions();
    const sessionDb = new InMemorySessionDB();
    const providerRequests: ProviderRequest[] = [];
    const model: ModelProfile = {
      id: "local-child",
      provider: "local",
      contextWindowTokens: 4096,
      supportsTools: true,
      supportsVision: false,
      supportsStructuredOutput: false
    };
    const registry = new ProviderRegistry();
    registry.register({
      id: "local",
      name: "Local",
      health: () => ({ available: true }),
      listModels: () => [model],
      complete: async (request) => {
        providerRequests.push(request);
        return {
          ok: true,
          provider: "local",
          model: "local-child",
          content: "Child final answer",
          usage: {
            inputTokens: 12,
            outputTokens: 5,
            totalTokens: 17
          }
        };
      }
    });
    const runtime = await createRuntime({
      ...options,
      model,
      primaryModelRoute: { provider: "local", id: "local-child", profile: model },
      providerRegistry: registry,
      sessionDb
    });

    try {
      await runtime.trustWorkspace?.();
      const execution = await runtime.executeTool?.({
        tool: "delegate_task",
        toolInput: {
          task: "Inspect delegated runtime",
          context: "Use bounded context only."
        }
      });
      const metadata = execution?.result?.metadata as { childSessionId?: string; status?: string; usage?: Record<string, unknown> } | undefined;
      const childSessionId = metadata?.childSessionId;

      expect(execution?.result?.ok).toBe(true);
      expect(metadata).toMatchObject({
        status: "completed",
        usage: {
          inputTokens: 12,
          outputTokens: 5,
          totalTokens: 17
        }
      });
      expect(typeof childSessionId).toBe("string");
      const childSession = await sessionDb.getSession(childSessionId!);
      expect(childSession).toMatchObject({
        parentSessionId: runtime.sessionId,
        metadata: expect.objectContaining({
          kind: "delegated-child",
          parentSessionId: runtime.sessionId,
          role: "leaf",
          depth: 1,
          approvalMode: "non-interactive-fail-closed",
          suppressedRuntimeFeatures: expect.arrayContaining(["memoryRecall", "skillLearning", "sessionCompression"])
        })
      });
      expect(childSession?.metadata?.effectiveAllowedTools).toEqual(expect.arrayContaining(["file.read", "file.search", "terminal.inspect"]));
      expect(childSession?.metadata?.strippedTools).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "delegate_task" }),
        expect.objectContaining({ name: "execute_code" }),
        expect.objectContaining({ name: "terminal.run" }),
        expect.objectContaining({ name: "file.write" })
      ]));
      const childMessages = await sessionDb.listMessages(childSessionId!);
      expect(childMessages.filter((message) => message.role === "user").map((message) => message.content)).toEqual([
        [
          "Delegated task: Inspect delegated runtime",
          "",
          "Context: Use bounded context only."
        ].join("\n")
      ]);
      expect(childMessages.some((message) => message.role === "agent" && message.content.includes("Child final answer"))).toBe(true);
      expect(providerRequests[0]?.messages.some((message) =>
        typeof message.content === "string" && message.content.includes("Inspect delegated runtime")
      )).toBe(true);
      const childToolSchemas = providerToolNames(providerRequests[0]?.tools);
      expect(childToolSchemas).toEqual(expect.arrayContaining(["file_read", "file_search", "terminal_inspect"]));
      expect(childToolSchemas).not.toEqual(expect.arrayContaining([
        "delegate_task",
        "execute_code",
        "terminal_run",
        "file_write",
        "process_start",
        "process_stop"
      ]));
    } finally {
      await runtime.dispose();
    }
  });

  it("exposes bounded active subagent operator status during child execution", async () => {
    const options = await minimalRuntimeOptions();
    const sessionDb = new InMemorySessionDB();
    let providerStarted: (() => void) | undefined;
    let providerRelease: (() => void) | undefined;
    const providerStartedPromise = new Promise<void>((resolve) => { providerStarted = resolve; });
    const providerReleasePromise = new Promise<void>((resolve) => { providerRelease = resolve; });
    const model: ModelProfile = {
      id: "local-child",
      provider: "local",
      contextWindowTokens: 4096,
      supportsTools: true,
      supportsVision: false,
      supportsStructuredOutput: false
    };
    const registry = new ProviderRegistry();
    registry.register({
      id: "local",
      name: "Local",
      health: () => ({ available: true }),
      listModels: () => [model],
      complete: async () => {
        providerStarted?.();
        await providerReleasePromise;
        return {
          ok: true,
          provider: "local",
          model: "local-child",
          content: "Child final answer"
        };
      }
    });
    const runtime = await createRuntime({
      ...options,
      model,
      primaryModelRoute: { provider: "local", id: "local-child", profile: model },
      providerRegistry: registry,
      sessionDb
    });

    try {
      await runtime.trustWorkspace?.();
      const delegated = runtime.executeTool?.({
        tool: "delegate_task",
        toolInput: {
          task: "Inspect api_key=sk-secret and do not expose it",
          context: "Context with token ghp_secret should stay out of status."
        }
      });
      await providerStartedPromise;

      const status = runtime.activeSubagents?.();
      expect(status).toBeDefined();
      expect(status?.activeCount).toBe(1);
      expect(status?.subagents[0]).toMatchObject({
        parentSessionId: runtime.sessionId,
        role: "leaf",
        depth: 1,
        provider: "local",
        model: "local-child",
        status: "running"
      });
      expect(status?.subagents[0]).not.toHaveProperty("abortController");
      expect(JSON.stringify(status)).not.toContain("sk-secret");
      expect(JSON.stringify(status)).not.toContain("ghp_secret");
      expect(JSON.stringify(status)).not.toContain("Inspect api_key");

      const runtimeStatus = runtime.getStatus();
      expect(runtimeStatus.sections?.[0]).toMatchObject({
        kind: "table",
        title: "Active subagents (1)"
      });
      expect(JSON.stringify(runtimeStatus)).not.toContain("Inspect api_key");

      providerRelease?.();
      const execution = await delegated;
      expect(execution?.result?.metadata).toMatchObject({ status: "completed" });
      expect(runtime.activeSubagents?.().activeCount).toBe(0);
    } finally {
      providerRelease?.();
      await runtime.dispose();
    }
  });

  it("runs same-provider child model overrides through filtered child tool schemas", async () => {
    const options = await minimalRuntimeOptions();
    const sessionDb = new InMemorySessionDB();
    const providerRequests: ProviderRequest[] = [];
    const parentModel: ModelProfile = {
      id: "local-parent",
      provider: "local",
      contextWindowTokens: 4096,
      supportsTools: true,
      supportsVision: false,
      supportsStructuredOutput: false
    };
    const registry = new ProviderRegistry();
    registry.register({
      id: "local",
      name: "Local",
      health: () => ({ available: true }),
      listModels: () => [parentModel, { ...parentModel, id: "local-child-override" }],
      complete: async (request) => {
        providerRequests.push(request);
        return {
          ok: true,
          provider: "local",
          model: request.model,
          content: "Override child answer"
        };
      }
    });
    const runtime = await createRuntime({
      ...options,
      model: parentModel,
      primaryModelRoute: { provider: "local", id: "local-parent", profile: parentModel },
      modelFallbackRoutes: [
        {
          provider: "local",
          id: "local-fallback",
          profile: { ...parentModel, id: "local-fallback" }
        }
      ],
      providerRegistry: registry,
      providerConfigs: {
        deepseek: {
          baseUrl: "https://configured.deepseek.example/v1",
          apiKeyEnv: "DEEPSEEK_API_KEY",
          apiMode: "custom_openai_compatible",
          authMethod: "api_key",
          enableNetwork: true
        }
      },
      sessionDb
    });

    try {
      await runtime.trustWorkspace?.();
      const execution = await runtime.executeTool?.({
        tool: "delegate_task",
        toolInput: {
          task: "Use override",
          modelOverride: { provider: "local", model: "local-child-override" }
        }
      });
      const metadata = execution?.result?.metadata as {
        childSessionId?: string;
        modelOverride?: Record<string, unknown>;
      } | undefined;
      const childSession = await sessionDb.getSession(metadata?.childSessionId ?? "");
      const childToolSchemas = providerToolNames(providerRequests[0]?.tools);

      expect(execution?.result?.ok).toBe(true);
      expect(providerRequests[0]?.provider).toBe("local");
      expect(providerRequests[0]?.model).toBe("local-child-override");
      expect(metadata?.modelOverride).toEqual({
        requested: true,
        status: "applied",
        provider: "local",
        model: "local-child-override",
        fallbackBehavior: "disabled-for-override"
      });
      expect(childSession?.metadata?.modelOverride).toEqual(metadata?.modelOverride);
      expect(childToolSchemas).toEqual(expect.arrayContaining(["file_read", "file_search", "terminal_inspect"]));
      expect(childToolSchemas).not.toEqual(expect.arrayContaining(["delegate_task", "terminal_run", "file_write"]));
      expect(JSON.stringify(metadata?.modelOverride)).not.toContain("KEY");
    } finally {
      await runtime.dispose();
    }
  });

  it("runs reviewed cross-provider child model overrides with target provider routing", async () => {
    const options = await minimalRuntimeOptions();
    const sessionDb = new InMemorySessionDB();
    const providerRequests: ProviderRequest[] = [];
    const providerOptions: ProviderCompletionOptions[] = [];
    const parentModel: ModelProfile = {
      id: "local-parent",
      provider: "local",
      contextWindowTokens: 4096,
      supportsTools: true,
      supportsVision: false,
      supportsStructuredOutput: false
    };
    const targetModel: ModelProfile = {
      id: "deepseek-chat",
      provider: "deepseek",
      contextWindowTokens: 64_000,
      supportsTools: true,
      supportsVision: false,
      supportsStructuredOutput: true
    };
    const registry = new ProviderRegistry();
    registry.register({
      id: "local",
      name: "Local",
      health: () => ({ available: true }),
      listModels: () => [parentModel],
      complete: async (request) => {
        providerRequests.push(request);
        return {
          ok: true,
          provider: "local",
          model: request.model,
          content: "Unexpected parent provider answer"
        };
      }
    });
    registry.register({
      id: "deepseek",
      name: "DeepSeek",
      endpoint: {
        baseUrl: "https://api.deepseek.com/v1",
        apiKey: { kind: "env", name: "DEEPSEEK_API_KEY" }
      },
      health: () => ({ available: true }),
      listModels: () => [targetModel],
      complete: async (request, completionOptions) => {
        providerRequests.push(request);
        providerOptions.push(completionOptions ?? {});
        return {
          ok: true,
          provider: "deepseek",
          model: request.model,
          content: "Cross-provider child answer"
        };
      }
    });
    const previous = process.env.DEEPSEEK_API_KEY;
    process.env.DEEPSEEK_API_KEY = "secret-deepseek-value";
    const runtime = await createRuntime({
      ...options,
      model: parentModel,
      primaryModelRoute: { provider: "local", id: "local-parent", profile: parentModel },
      modelFallbackRoutes: [
        {
          provider: "local",
          id: "local-fallback",
          profile: { ...parentModel, id: "local-fallback" }
        }
      ],
      providerRegistry: registry,
      providerConfigs: {
        deepseek: {
          baseUrl: "https://configured.deepseek.example/v1",
          apiKeyEnv: "DEEPSEEK_API_KEY",
          apiMode: "custom_openai_compatible",
          authMethod: "api_key",
          enableNetwork: true
        }
      },
      sessionDb
    });

    try {
      await runtime.trustWorkspace?.();
      const execution = await runtime.executeTool?.({
        tool: "delegate_task",
        toolInput: {
          task: "Use cross-provider override",
          modelOverride: { provider: "deepseek", model: "deepseek-chat" }
        }
      });
      const metadata = execution?.result?.metadata as {
        childSessionId?: string;
        modelOverride?: Record<string, unknown>;
      } | undefined;
      const childSession = await sessionDb.getSession(metadata?.childSessionId ?? "");
      const childToolSchemas = providerToolNames(providerRequests[0]?.tools);

      expect(execution?.result?.ok).toBe(true);
      expect(providerRequests).toHaveLength(1);
      expect(providerRequests[0]?.provider).toBe("deepseek");
      expect(providerRequests[0]?.model).toBe("deepseek-chat");
      expect(providerOptions[0]?.endpoint).toMatchObject({
        baseUrl: "https://configured.deepseek.example/v1",
        apiKey: { kind: "env", name: "DEEPSEEK_API_KEY" }
      });
      expect(metadata?.modelOverride).toEqual({
        requested: true,
        status: "applied",
        provider: "deepseek",
        model: "deepseek-chat",
        fallbackBehavior: "disabled-for-override"
      });
      expect(childSession?.metadata?.modelOverride).toEqual(metadata?.modelOverride);
      expect(childToolSchemas).toEqual(expect.arrayContaining(["file_read", "file_search", "terminal_inspect"]));
      expect(childToolSchemas).not.toEqual(expect.arrayContaining(["delegate_task", "terminal_run", "file_write"]));
      expect(JSON.stringify(metadata?.modelOverride)).not.toContain("secret-deepseek-value");
    } finally {
      if (previous === undefined) {
        delete process.env.DEEPSEEK_API_KEY;
      } else {
        process.env.DEEPSEEK_API_KEY = previous;
      }
      await runtime.dispose();
    }
  });

  it("blocks cross-provider child model overrides with missing target credentials before execution", async () => {
    const options = await minimalRuntimeOptions();
    const sessionDb = new InMemorySessionDB();
    const providerRequests: ProviderRequest[] = [];
    const parentModel: ModelProfile = {
      id: "local-parent",
      provider: "local",
      contextWindowTokens: 4096,
      supportsTools: true,
      supportsVision: false,
      supportsStructuredOutput: false
    };
    const targetModel: ModelProfile = {
      id: "deepseek-chat",
      provider: "deepseek",
      contextWindowTokens: 64_000,
      supportsTools: true,
      supportsVision: false,
      supportsStructuredOutput: true
    };
    const registry = new ProviderRegistry();
    registry.register({
      id: "local",
      name: "Local",
      health: () => ({ available: true }),
      listModels: () => [parentModel],
      complete: async (request) => {
        providerRequests.push(request);
        return { ok: true, provider: "local", model: request.model, content: "parent" };
      }
    });
    registry.register({
      id: "deepseek",
      name: "DeepSeek",
      endpoint: {
        baseUrl: "https://api.deepseek.com/v1",
        apiKey: { kind: "env", name: "DEEPSEEK_MISSING_API_KEY" }
      },
      health: () => ({ available: true }),
      listModels: () => [targetModel],
      complete: async (request) => {
        providerRequests.push(request);
        return { ok: true, provider: "deepseek", model: request.model, content: "child" };
      }
    });
    delete process.env.DEEPSEEK_MISSING_API_KEY;
    const runtime = await createRuntime({
      ...options,
      model: parentModel,
      primaryModelRoute: { provider: "local", id: "local-parent", profile: parentModel },
      providerRegistry: registry,
      providerConfigs: {
        deepseek: {
          baseUrl: "https://api.deepseek.com/v1",
          apiKeyEnv: "DEEPSEEK_MISSING_API_KEY",
          enableNetwork: true
        }
      },
      sessionDb
    });

    try {
      await runtime.trustWorkspace?.();
      const execution = await runtime.executeTool?.({
        tool: "delegate_task",
        toolInput: {
          task: "Use cross-provider override",
          modelOverride: { provider: "deepseek", model: "deepseek-chat" }
        }
      });
      const metadata = execution?.result?.metadata as {
        status?: string;
        reason?: string;
        modelOverride?: Record<string, unknown>;
      } | undefined;

      expect(execution?.result?.ok).toBe(false);
      expect(metadata).toMatchObject({
        status: "blocked",
        reason: "model-override-unsupported",
        modelOverride: {
          requested: true,
          status: "rejected",
          provider: "deepseek",
          model: "deepseek-chat",
          reason: "missing-credentials"
        }
      });
      expect(providerRequests).toEqual([]);
    } finally {
      await runtime.dispose();
    }
  });

  it("reflects delegation config limits in delegate_task provider schema descriptions", async () => {
    const options = await minimalRuntimeOptions();
    const providerRequests: ProviderRequest[] = [];
    const model: ModelProfile = {
      id: "local-schema",
      provider: "local",
      contextWindowTokens: 4096,
      supportsTools: true,
      supportsVision: false,
      supportsStructuredOutput: false
    };
    const registry = new ProviderRegistry();
    registry.register({
      id: "local",
      name: "Local",
      health: () => ({ available: true }),
      listModels: () => [model],
      complete: async (request) => {
        providerRequests.push(request);
        return {
          ok: true,
          provider: "local",
          model: model.id,
          content: "ok"
        };
      }
    });
    const runtime = await createRuntime({
      ...options,
      model,
      primaryModelRoute: { provider: "local", id: model.id, profile: model },
      providerRegistry: registry,
      delegationConfig: {
        ...DEFAULT_DELEGATION_CONFIG,
        maxConcurrentChildren: 2,
        maxBatchTasks: 4,
        maxSpawnDepth: 3
      }
    });

    try {
      await runtime.handle({ text: "hello", channel: "cli", trustedWorkspace: true });
      const delegateSchema = (providerRequests[0]?.tools as Array<{ function: { name: string; description: string } }> | undefined)?.find((tool) =>
        tool.function.name === "delegate_task"
      );
      expect(delegateSchema?.function.description).toContain("up to 4 batch tasks");
      expect(delegateSchema?.function.description).toContain("at most 2 children");
      expect(delegateSchema?.function.description).toContain("limited to 3");
      expect(JSON.stringify(delegateSchema)).not.toContain(options.workspaceRoot);
    } finally {
      await runtime.dispose();
    }
  });

  it("lets a child provider request a safe tool and receive tool feedback", async () => {
    const options = await minimalRuntimeOptions();
    await writeFile(join(options.workspaceRoot, "needle.txt"), "needle-value");
    const sessionDb = new InMemorySessionDB();
    const providerRequests: ProviderRequest[] = [];
    const model: ModelProfile = {
      id: "local-child-tools",
      provider: "local",
      contextWindowTokens: 4096,
      supportsTools: true,
      supportsVision: false,
      supportsStructuredOutput: false
    };
    const responses = [
      {
        ok: true,
        provider: "local" as const,
        model: "local-child-tools",
        content: "",
        finishReason: "tool_calls" as const,
        raw: {
          choices: [
            {
              message: {
                tool_calls: [
                  {
                    id: "call-1",
                    function: {
                      name: "file.search",
                      arguments: JSON.stringify({ query: "needle-value" })
                    }
                  }
                ]
              }
            }
          ]
        }
      },
      {
        ok: true,
        provider: "local" as const,
        model: "local-child-tools",
        content: "Tool feedback received."
      }
    ];
    const registry = new ProviderRegistry();
    registry.register({
      id: "local",
      name: "Local",
      health: () => ({ available: true }),
      listModels: () => [model],
      complete: async (request) => {
        providerRequests.push(request);
        return responses.shift()!;
      }
    });
    const runtime = await createRuntime({
      ...options,
      model,
      primaryModelRoute: { provider: "local", id: "local-child-tools", profile: model },
      providerRegistry: registry,
      sessionDb
    });

    try {
      await runtime.trustWorkspace?.();
      const execution = await runtime.executeTool?.({
        tool: "delegate_task",
        toolInput: {
          task: "Find the needle"
        }
      });

      expect(execution?.result?.metadata).toMatchObject({
        status: "completed",
        summary: "Tool feedback received."
      });
      expect(providerRequests.length).toBeGreaterThanOrEqual(2);
      expect(providerToolNames(providerRequests[0]?.tools)).toContain("file_search");
      const metadata = execution?.result?.metadata as { childSessionId?: string } | undefined;
      const childMessages = await sessionDb.listMessages(metadata!.childSessionId!);
      expect(childMessages.some((message) => message.role === "tool" && message.metadata?.tool === "file.search")).toBe(true);
      const childEvents = await sessionDb.listEvents(metadata!.childSessionId!);
      expect(childEvents).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "tool-called", tool: "file.search" }),
        expect.objectContaining({ kind: "tool-result", tool: "file.search" })
      ]));
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
      await runtime.dispose();
      expect(socket.closeCount).toBeGreaterThan(0);
      await expect(runtime.dispose()).resolves.toBeUndefined();
    } finally {
      await runtime.dispose();
    }
  });

  it("releases a runtime-owned Browserbase session during runtime dispose", async () => {
    const options = await minimalRuntimeOptions();
    const browserbaseCalls: BrowserbaseFetchCall[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = createRuntimeBrowserbaseFetch({ calls: browserbaseCalls });
    vi.stubEnv("BROWSERBASE_API_KEY", "bb_runtime_key");
    vi.stubEnv("BROWSERBASE_PROJECT_ID", "project_runtime");
    const runtime = await createRuntime({
      ...options,
      cdpFetch: createRuntimeCdpFetch(),
      cdpWebSocketFactory: () => new FakeRuntimeCdpSocket(),
      browser: {
        backend: "browserbase",
        autoLaunch: false,
        cloudSpendApproved: true,
        cloudFallback: false
      }
    });

    try {
      expect(browserbaseCalls).toEqual([]);

      const result = await runtime.executeTool?.({
        tool: "browser.navigate",
        toolInput: { url: "https://93.184.216.34/" }
      });

      expect(result?.result?.ok).toBe(true);
      expect(browserbaseCalls.map((call) => `${call.method} ${new URL(call.url).pathname}`)).toEqual([
        "POST /v1/sessions"
      ]);

      await runtime.dispose();
      await expect(runtime.dispose()).resolves.toBeUndefined();

      expect(browserbaseCalls.map((call) => `${call.method} ${new URL(call.url).pathname}`)).toEqual([
        "POST /v1/sessions",
        "POST /v1/sessions/bb-runtime-session"
      ]);
      expect(JSON.parse(browserbaseCalls[1]?.body ?? "{}")).toEqual({
        status: "REQUEST_RELEASE"
      });
    } finally {
      await runtime.dispose();
      globalThis.fetch = originalFetch;
      vi.unstubAllEnvs();
    }
  });

  it("does not call Browserbase when an unused runtime-owned Browserbase backend is disposed", async () => {
    const options = await minimalRuntimeOptions();
    const browserbaseCalls: BrowserbaseFetchCall[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = createRuntimeBrowserbaseFetch({ calls: browserbaseCalls });
    vi.stubEnv("BROWSERBASE_API_KEY", "bb_runtime_key");
    vi.stubEnv("BROWSERBASE_PROJECT_ID", "project_runtime");
    const runtime = await createRuntime({
      ...options,
      cdpFetch: createRuntimeCdpFetch(),
      cdpWebSocketFactory: () => new FakeRuntimeCdpSocket(),
      browser: {
        backend: "browserbase",
        autoLaunch: false,
        cloudSpendApproved: true
      }
    });

    try {
      await runtime.dispose();
      await expect(runtime.dispose()).resolves.toBeUndefined();

      expect(browserbaseCalls).toEqual([]);
    } finally {
      await runtime.dispose();
      globalThis.fetch = originalFetch;
      vi.unstubAllEnvs();
    }
  });

  it("surfaces Browserbase release failures during runtime dispose", async () => {
    const options = await minimalRuntimeOptions();
    const browserbaseCalls: BrowserbaseFetchCall[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = createRuntimeBrowserbaseFetch({ calls: browserbaseCalls, closeStatus: 400 });
    vi.stubEnv("BROWSERBASE_API_KEY", "bb_runtime_key");
    vi.stubEnv("BROWSERBASE_PROJECT_ID", "project_runtime");
    const runtime = await createRuntime({
      ...options,
      cdpFetch: createRuntimeCdpFetch(),
      cdpWebSocketFactory: () => new FakeRuntimeCdpSocket(),
      browser: {
        backend: "browserbase",
        autoLaunch: false,
        cloudSpendApproved: true,
        cloudFallback: false
      }
    });

    try {
      const result = await runtime.executeTool?.({
        tool: "browser.navigate",
        toolInput: { url: "https://93.184.216.34/" }
      });

      expect(result?.result?.ok).toBe(true);
      await expect(runtime.dispose()).rejects.toThrow("Browserbase POST /v1/sessions/bb-runtime-session failed with HTTP 400.");
      await expect(runtime.dispose()).resolves.toBeUndefined();
      expect(browserbaseCalls.map((call) => `${call.method} ${new URL(call.url).pathname}`)).toEqual([
        "POST /v1/sessions",
        "POST /v1/sessions/bb-runtime-session"
      ]);
    } finally {
      await runtime.dispose();
      globalThis.fetch = originalFetch;
      vi.unstubAllEnvs();
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

  it("does not close an injected browserBackend during runtime dispose", async () => {
    const options = await minimalRuntimeOptions();
    const close = vi.fn(async () => undefined);
    const injectedBackend: BrowserBackend & { close: () => Promise<void> } = {
      kind: "mock",
      close,
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
    };
    const runtime = await createRuntime({
      ...options,
      browserBackend: injectedBackend
    });

    await expect(runtime.dispose()).resolves.toBeUndefined();
    await expect(runtime.dispose()).resolves.toBeUndefined();
    expect(close).not.toHaveBeenCalled();
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

    const zai = registry.get("zai");
    expect(zai).toBeDefined();
    expect(zai!.executable).not.toBe(false);
    expect(zai!.endpoint?.baseUrl).toBe("https://api.z.ai/api/paas/v4");

    const openrouter = registry.get("openrouter");
    expect(openrouter).toBeDefined();
    expect(openrouter!.executable).not.toBe(false);
    expect(openrouter!.endpoint?.headers).toMatchObject({
      "HTTP-Referer": "https://www.estacoda.com",
      "X-Title": "EstaCoda"
    });
  });

  it("registers selected zai model through the OpenAI-compatible adapter path", () => {
    const registry = createDefaultProviderRegistry({
      id: "glm-5.2",
      provider: "zai",
      contextWindowTokens: 128000,
      supportsTools: true,
      supportsVision: false,
      supportsStructuredOutput: true,
      supportsReasoning: true
    });

    const zai = registry.get("zai");
    expect(zai).toBeDefined();
    expect(zai!.executable).not.toBe(false);
    expect(zai!.endpoint?.baseUrl).toBe("https://api.z.ai/api/paas/v4");
    expect(zai!.endpoint?.apiKey).toEqual({ kind: "env", name: "ZAI_API_KEY" });
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

function providerToolNames(tools: unknown[] | undefined): string[] {
  return (tools ?? []).map((tool) => {
    const record = tool as { function?: { name?: unknown }; name?: unknown };
    return typeof record.function?.name === "string"
      ? record.function.name
      : typeof record.name === "string"
        ? record.name
        : "";
  }).filter((name) => name.length > 0);
}
