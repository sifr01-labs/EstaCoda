import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserBackend } from "../contracts/browser.js";
import { deriveAgentEvolutionPolicy } from "../contracts/agent-evolution.js";
import type { MemoryProvider } from "../contracts/memory.js";
import type { ModelProfile, ResolvedModelRoute } from "../contracts/provider.js";
import type { SecurityPolicy } from "../contracts/security.js";
import type { LoadedSkill, SkillDefinition } from "../contracts/skill.js";
import type { RegisteredTool } from "../contracts/tool.js";
import { ArtifactStore } from "../artifacts/artifact-store.js";
import { normalizeMemoryConfig } from "../config/memory-config.js";
import { normalizeExternalMemoryConfig, normalizeSessionCompressionConfig } from "../config/runtime-config.js";
import { ContextReferenceExpander } from "../context/context-reference-expander.js";
import { CronStore } from "../cron/cron-store.js";
import { MemoryFileCompactionService } from "../memory/memory-file-compaction-service.js";
import { LocalMemoryProvider } from "../memory/local-memory-provider.js";
import { MemoryPersistenceService } from "../memory/memory-persistence-service.js";
import { LocalMemoryRetrievalService } from "../memory/memory-retrieval-service.js";
import { MemoryStore } from "../memory/memory-store.js";
import { MemoryPromptContextBuilder } from "../memory/memory-prompt-context-builder.js";
import { MemoryPromotionStore } from "../memory/memory-promotion-store.js";
import { ProcessManager } from "../process/process-manager.js";
import { ProviderExecutor } from "../providers/provider-executor.js";
import { ProviderRegistry } from "../providers/provider-registry.js";
import { SessionCompressionService } from "../prompt/session-compression-service.js";
import { InMemorySessionDB } from "../session/in-memory-session-db.js";
import { SessionRecallService } from "../session/session-recall-service.js";
import { WorkspaceTrustStore } from "../security/workspace-trust-store.js";
import { SkillEvolutionStore } from "../skills/skill-evolution.js";
import { ChangeManifestStore } from "../skills/change-manifest-store.js";
import { SkillLearningManager } from "../skills/skill-learning.js";
import { SkillRegistry } from "../skills/skill-registry.js";
import { ToolExecutor } from "../tools/tool-executor.js";
import { FileStateTracker } from "../delegation/file-state-tracker.js";
import {
  registerPythonCapabilitySpecForTest,
  resetPythonCapabilityRegistryForTest
} from "../python-env/capability-registry.js";
import { resolveManagedPythonCapabilityPaths } from "../python-env/capability-paths.js";
import { writeManagedPythonCapabilityManifest } from "../python-env/manifest.js";
import { fingerprintManagedPythonCapabilitySpec } from "../python-env/spec-hash.js";
import * as capabilityManager from "../python-env/capability-manager.js";
import { createSessionRuntimeContext } from "./session-runtime-context.js";
import { AgentLoopBuilder, defaultSkillVisibilityStrategy, type AgentLoopRuntimeSubstrate } from "./agent-loop-builder.js";

const model: ModelProfile = {
  provider: "openai",
  id: "gpt-test",
  contextWindowTokens: 8_000,
  supportsTools: true,
  supportsVision: true,
  supportsStructuredOutput: true
};

const mainRoute: ResolvedModelRoute = {
  provider: "openai",
  id: "gpt-test",
  profile: model
};

const securityPolicy: SecurityPolicy = {
  decide() {
    return "allow";
  }
};

describe("AgentLoopBuilder", () => {
  afterEach(() => {
    resetPythonCapabilityRegistryForTest();
    vi.restoreAllMocks();
  });

  it("creates fresh session-bound instances for each session build", async () => {
    const harness = await createBuilderHarness();
    const first = await harness.build("session-a");
    const second = await harness.build("session-b");

    expect(first.sessionRuntimeContext.currentSessionId()).toBe("session-a");
    expect(second.sessionRuntimeContext.currentSessionId()).toBe("session-b");
    expect(first.toolRegistry).not.toBe(second.toolRegistry);
    expect(first.toolExecutor).not.toBe(second.toolExecutor);
    expect(first.runRecorder).not.toBe(second.runRecorder);
    expect(first.providerTurnLoop).not.toBe(second.providerTurnLoop);
    expect(first.agentLoop).not.toBe(second.agentLoop);
  });

  it("seeds each provider loop from its own persisted session usage", async () => {
    const captured: unknown[] = [];
    const harness = await createBuilderHarness({
      factories: {
        providerTurnLoop(options) {
          captured.push(options.initialContextWindowUsage);
          return { run: vi.fn() } as never;
        },
        agentLoop: () => ({ handle: vi.fn() }) as never
      }
    });
    await harness.sessionDb.createSession({ id: "session-a", profileId: "default" });
    await harness.sessionDb.createSession({ id: "session-b", profileId: "default" });
    await harness.sessionDb.appendEvent("session-a", {
      kind: "context-window-usage",
      usedTokens: 1_000,
      totalTokens: 8_000,
      provider: "openai",
      model: "model-a"
    });
    await harness.sessionDb.appendEvent("session-b", {
      kind: "context-window-usage",
      usedTokens: 2_000,
      totalTokens: 16_000,
      provider: "anthropic",
      model: "model-b",
      routeRole: "fallback"
    });

    await harness.build("session-a");
    await harness.build("session-b");

    expect(captured).toEqual([
      { usedTokens: 1_000, totalTokens: 8_000, provider: "openai", model: "model-a" },
      { usedTokens: 2_000, totalTokens: 16_000, provider: "anthropic", model: "model-b", routeRole: "fallback" }
    ]);
  });

  it("does not mutate an existing built registry when building another filtered session", async () => {
    const mcpTool = registeredTool("mcp.inspect", ["research"]);
    const harness = await createBuilderHarness({ mcpTools: [mcpTool] });
    const parent = await harness.build("parent-session");
    const child = await harness.build("child-session", { disabledToolsets: ["research"] });

    expect(parent.toolRegistry.get("mcp.inspect")).toBe(mcpTool);
    expect(child.toolRegistry.get("mcp.inspect")).toBeUndefined();
    expect(parent.toolRegistry.get("mcp.inspect")).toBe(mcpTool);
  });

  it("reuses MCP tool handlers without owning shared MCP cleanup", async () => {
    const mcpTool = registeredTool("mcp.echo", ["research"]);
    const harness = await createBuilderHarness({ mcpTools: [mcpTool] });
    const first = await harness.build("session-a");
    const second = await harness.build("session-b");

    expect(first.toolRegistry.get("mcp.echo")).toBe(mcpTool);
    expect(second.toolRegistry.get("mcp.echo")).toBe(mcpTool);
    await harness.builder.cleanupSession(first);
    await harness.builder.cleanupSession(second);
    expect(mcpTool.run).not.toHaveBeenCalled();
  });

  it("shares runtime-scoped file-state tracking across parent and child sessions", async () => {
    const harness = await createBuilderHarness();
    const parent = await harness.build("parent-session");
    const child = await harness.build("child-session", { parentSessionId: "parent-session" });
    const parentWrite = parent.toolRegistry.get("file.write");
    const childRead = child.toolRegistry.get("file.read");

    await parentWrite?.run({ path: "shared.txt", content: "parent content" });
    await childRead?.run({ path: "shared.txt" });

    expect(harness.fileStateTracker.listOperations()).toEqual([
      expect.objectContaining({
        sessionId: "parent-session",
        parentSessionId: undefined,
        childSessionId: undefined,
        operation: "write",
        normalizedPath: "shared.txt"
      }),
      expect.objectContaining({
        sessionId: "child-session",
        parentSessionId: "parent-session",
        childSessionId: "child-session",
        operation: "read",
        normalizedPath: "shared.txt"
      })
    ]);
  });

  it("uses an explicit skill visibility strategy", async () => {
    const visibleSkill = skill("visible-skill");
    const hiddenSkill = skill("hidden-skill");
    const sessionSkills = new SkillRegistry();
    sessionSkills.register(visibleSkill);
    const strategy = vi.fn((_input) => sessionSkills);
    const sourceSkills = new SkillRegistry();
    sourceSkills.register(visibleSkill);
    sourceSkills.register(hiddenSkill);
    const harness = await createBuilderHarness({ skillRegistry: sourceSkills });

    const built = await harness.build("session-a", { skillVisibilityStrategy: strategy });

    expect(strategy).toHaveBeenCalledOnce();
    const strategyInput = strategy.mock.calls[0]?.[0];
    expect(strategyInput).toBeDefined();
    expect(strategyInput?.skillRegistry).toBe(sourceSkills);
    expect(built.sessionSkillCatalog.map((entry) => entry.name)).toEqual(["visible-skill"]);
  });

  it("default skill visibility can be re-evaluated against available tools", async () => {
    const visible = skill("web-visible", { visibility: { requiresTools: ["web.extract"] } });
    const hidden = skill("browser-hidden", { visibility: { requiresTools: ["browser.navigate"] } });
    const sourceSkills = new SkillRegistry();
    sourceSkills.register(visible);
    sourceSkills.register(hidden);
    const sessionSkills = defaultSkillVisibilityStrategy({
      skillRegistry: sourceSkills,
      toolAvailability: [
        toolDefinition("web.extract", ["web"]),
        toolDefinition("browser.navigate", ["browser"])
      ],
      browserAvailable: false,
      skillUsageByName: new Map(),
      telegramReady: false,
      webEnabled: true,
      platform: process.platform
    });

    expect(sessionSkills.catalog().map((entry) => entry.name)).toEqual(["web-visible"]);
  });

  it("keeps skills with unavailable required Python capabilities routeable without installing", async () => {
    const spec = registerRuntimePythonCapability();
    const installSpy = vi.spyOn(capabilityManager, "installManagedPythonCapabilityEnvironment");
    const sourceSkills = new SkillRegistry();
    sourceSkills.register(skill("needs-python", {
      pythonCapabilities: [{ id: spec.id, required: true, groups: [] }]
    }));
    const harness = await createBuilderHarness({ skillRegistry: sourceSkills });

    const built = await harness.build("session-python-missing");
    const loaded = built.sessionSkillRegistry.get("needs-python");

    expect(built.sessionSkillCatalog.map((entry) => entry.name)).toContain("needs-python");
    expect(loaded).toMatchObject({
      pythonCapabilitySetup: [
        expect.objectContaining({
          id: spec.id,
          required: true,
          groups: [],
          status: "unavailable",
          reason: "install_required",
          repairCommand: `estacoda python-env setup ${spec.id}`
        })
      ],
      loadWarnings: [expect.stringContaining("Required Python capability")]
    });
    expect(installSpy).not.toHaveBeenCalled();
  });

  it("keeps required base and optional group setup state when both are unavailable", async () => {
    const spec = registerRuntimePythonCapability();
    const installSpy = vi.spyOn(capabilityManager, "installManagedPythonCapabilityEnvironment");
    const sourceSkills = new SkillRegistry();
    sourceSkills.register(skill("needs-python-base", {
      pythonCapabilities: [
        { id: spec.id, required: true, groups: [] },
        { id: spec.id, required: false, groups: ["extra"] }
      ]
    }));
    const harness = await createBuilderHarness({ skillRegistry: sourceSkills });

    const built = await harness.build("session-python-base-missing");
    const loaded = built.sessionSkillRegistry.get("needs-python-base");

    expect(built.sessionSkillCatalog.map((entry) => entry.name)).toContain("needs-python-base");
    expect(loaded?.pythonCapabilitySetup).toEqual([
      expect.objectContaining({
        id: spec.id,
        required: true,
        groups: [],
        status: "unavailable"
      }),
      expect.objectContaining({
        id: spec.id,
        required: false,
        groups: ["extra"],
        status: "unavailable"
      })
    ]);
    expect(installSpy).not.toHaveBeenCalled();
  });

  it("keeps skills with verified required Python capabilities visible", async () => {
    const spec = registerRuntimePythonCapability();
    const sourceSkills = new SkillRegistry();
    sourceSkills.register(skill("ready-python", {
      pythonCapabilities: [{ id: spec.id, required: true, groups: ["extra"] }]
    }));
    const harness = await createBuilderHarness({ skillRegistry: sourceSkills });
    await writeVerifiedCapability(harness.stateRoot, spec, ["extra"]);

    const built = await harness.build("session-python-ready");
    const loaded = built.sessionSkillRegistry.get("ready-python");

    expect(built.sessionSkillCatalog.map((entry) => entry.name)).toContain("ready-python");
    expect(loaded?.pythonCapabilitySetup).toEqual([
      expect.objectContaining({
        id: spec.id,
        required: true,
        groups: ["extra"],
        status: "available",
        installedGroups: ["extra"]
      })
    ]);
  });

  it("keeps optional unavailable Python capabilities as degraded load warnings", async () => {
    const spec = registerRuntimePythonCapability();
    const sourceSkills = new SkillRegistry();
    sourceSkills.register(skill("optional-python", {
      pythonCapabilities: [{ id: spec.id, required: false, groups: [] }]
    }));
    const harness = await createBuilderHarness({ skillRegistry: sourceSkills });

    const built = await harness.build("session-python-optional");
    const loaded = built.sessionSkillRegistry.get("optional-python");

    expect(built.sessionSkillCatalog.map((entry) => entry.name)).toContain("optional-python");
    expect(loaded).toMatchObject({
      loadWarnings: [expect.stringContaining("Optional Python capability")]
    });
  });

  it("keeps a skill visible when a same-id required base capability is verified and an optional group is unavailable", async () => {
    const spec = registerRuntimePythonCapability();
    const installSpy = vi.spyOn(capabilityManager, "installManagedPythonCapabilityEnvironment");
    const sourceSkills = new SkillRegistry();
    sourceSkills.register(skill("optional-python-group", {
      pythonCapabilities: [
        { id: spec.id, required: true, groups: [] },
        { id: spec.id, required: false, groups: ["extra"] }
      ]
    }));
    const harness = await createBuilderHarness({ skillRegistry: sourceSkills });
    await writeVerifiedCapability(harness.stateRoot, spec, []);

    const built = await harness.build("session-python-optional-group");
    const loaded = built.sessionSkillRegistry.get("optional-python-group");

    expect(built.sessionSkillCatalog.map((entry) => entry.name)).toContain("optional-python-group");
    expect(loaded).toMatchObject({
      loadWarnings: [expect.stringContaining("Optional Python capability")]
    });
    expect(installSpy).not.toHaveBeenCalled();
  });

  it("keeps setup-needed Python skills routeable for gateway-style session builds without installing", async () => {
    const spec = registerRuntimePythonCapability();
    const installSpy = vi.spyOn(capabilityManager, "installManagedPythonCapabilityEnvironment");
    const sourceSkills = new SkillRegistry();
    sourceSkills.register(skill("gateway-python", {
      pythonCapabilities: [{ id: spec.id, required: true, groups: [] }]
    }));
    const harness = await createBuilderHarness({ skillRegistry: sourceSkills });

    const built = await harness.build("telegram-session");

    expect(built.sessionSkillCatalog.map((entry) => entry.name)).toContain("gateway-python");
    expect(built.sessionSkillRegistry.get("gateway-python")).toMatchObject({
      pythonCapabilitySetup: [expect.objectContaining({ status: "unavailable" })]
    });
    expect(installSpy).not.toHaveBeenCalled();
  });

  it("passes explicit provider routes to the provider turn loop", async () => {
    const primaryModelRoute = { ...mainRoute, id: "primary-model" };
    const fallbackRoute = { ...mainRoute, id: "fallback-model" };
    const captured: Array<{
      primaryModelRoute?: ResolvedModelRoute;
      modelFallbackRoutes?: ResolvedModelRoute[];
      providerPreferences?: unknown;
      sessionId?: string;
    }> = [];
    const harness = await createBuilderHarness({
      routes: {
        model,
        mainRoute,
        primaryModelRoute,
        modelFallbackRoutes: [fallbackRoute],
        providerPreferences: { providerOrder: ["openai"] }
      },
      factories: {
        providerTurnLoop(options) {
          captured.push({
            primaryModelRoute: options.primaryModelRoute,
            modelFallbackRoutes: options.modelFallbackRoutes,
            providerPreferences: options.providerPreferences,
            sessionId: options.sessionId
          });
          return { run: vi.fn() } as never;
        },
        agentLoop: () => ({ handle: vi.fn() }) as never
      }
    });

    await harness.build("route-session");

    expect(captured).toEqual([
      {
        primaryModelRoute,
        modelFallbackRoutes: [fallbackRoute],
        providerPreferences: { providerOrder: ["openai"] },
        sessionId: "route-session"
      }
    ]);
  });

  it("passes memory curation only to root agent loops", async () => {
    const memoryCurationService = {
      observeCompletedTurn: vi.fn(),
      checkpoint: vi.fn()
    };
    const captured: unknown[] = [];
    const harness = await createBuilderHarness({
      memoryCurationServiceFactory: () => memoryCurationService as never,
      factories: {
        agentLoop(options) {
          captured.push(options.memoryCurationService);
          return { handle: vi.fn() } as never;
        }
      }
    });

    await harness.build("root-session");
    await harness.build("child-session", { parentSessionId: "root-session" });

    expect(captured).toEqual([memoryCurationService, undefined]);
  });

  it("passes explicit benchmark execution controls to the provider turn loop", async () => {
    const captured: Array<{
      budgets: unknown;
      providerRequestDefaults: unknown;
    }> = [];
    const harness = await createBuilderHarness({
      executionControls: {
        providerBudgets: {
          maxProviderIterations: 7,
          maxProviderWallClockMs: 42_000
        },
        providerRequestDefaults: {
          temperature: 0,
          maxTokens: 1200
        }
      },
      factories: {
        providerTurnLoop(options) {
          captured.push({
            budgets: options.budgets,
            providerRequestDefaults: options.providerRequestDefaults
          });
          return { run: vi.fn() } as never;
        },
        agentLoop: () => ({ handle: vi.fn() }) as never
      }
    });

    await harness.build("benchmark-session");

    expect(captured).toEqual([
      {
        budgets: {
          maxProviderIterations: 7,
          maxProviderToolCalls: 100,
          maxRepeatedToolFailures: 5,
          maxProviderWallClockMs: 42_000
        },
        providerRequestDefaults: {
          temperature: 0,
          maxTokens: 1200
        }
      }
    ]);
  });

  it("uses per-session provider routes without mutating shared substrate routes", async () => {
    const parentPrimaryRoute = { ...mainRoute, id: "parent-primary" };
    const childPrimaryRoute = {
      ...mainRoute,
      id: "child-primary",
      profile: { ...model, id: "child-primary" }
    };
    const captured: Array<{
      primaryModelRoute?: ResolvedModelRoute;
      modelFallbackRoutes?: ResolvedModelRoute[];
      model?: { id: string };
    }> = [];
    const harness = await createBuilderHarness({
      routes: {
        model,
        mainRoute,
        primaryModelRoute: parentPrimaryRoute,
        modelFallbackRoutes: [{ ...mainRoute, id: "parent-fallback" }],
        providerPreferences: { providerOrder: ["openai"] }
      },
      factories: {
        providerTurnLoop(options) {
          captured.push({
            primaryModelRoute: options.primaryModelRoute,
            modelFallbackRoutes: options.modelFallbackRoutes,
            model: options.model
          });
          return { run: vi.fn() } as never;
        },
        agentLoop: () => ({ handle: vi.fn() }) as never
      }
    });

    const first = await harness.build("parent-session");
    const second = await harness.build("child-session", {
      providerRoutes: {
        model: childPrimaryRoute.profile,
        mainRoute: childPrimaryRoute,
        primaryModelRoute: childPrimaryRoute,
        modelFallbackRoutes: [],
        providerPreferences: { providerOrder: ["openai"] }
      }
    });

    expect(captured[0]?.primaryModelRoute?.id).toBe("parent-primary");
    expect(captured[0]?.modelFallbackRoutes?.map((route) => route.id)).toEqual(["parent-fallback"]);
    expect(captured[0]?.model?.id).toBe(model.id);
    expect(captured[1]?.primaryModelRoute?.id).toBe("child-primary");
    expect(captured[1]?.modelFallbackRoutes).toEqual([]);
    expect(captured[1]?.model?.id).toBe("child-primary");
    expect(first.providerRoutes.primaryModelRoute?.id).toBe("parent-primary");
    expect(second.providerRoutes.primaryModelRoute?.id).toBe("child-primary");
    expect(first.providerRoutes.primaryModelRoute?.id).toBe("parent-primary");
  });

  it("wires security policy and session context from the supplied session id", async () => {
    const captured = {
      toolExecutorSecurityPolicy: undefined as SecurityPolicy | undefined,
      delegationSessionId: undefined as string | undefined
    };
    const sessionRuntimeContext = createSessionRuntimeContext("explicit-session");
    const harness = await createBuilderHarness({
      factories: {
        toolExecutor(options) {
          captured.toolExecutorSecurityPolicy = options.securityPolicy;
          return new ToolExecutor(options);
        }
      }
    });

    const built = await harness.build("explicit-session", {
      sessionRuntimeContext,
      delegationManagerFactory: ({ sessionRuntimeContext: ctx }) => {
        captured.delegationSessionId = ctx.currentSessionId();
        return {} as never;
      }
    });

    expect(built.sessionRuntimeContext).toBe(sessionRuntimeContext);
    expect(captured.toolExecutorSecurityPolicy).toBe(securityPolicy);
    expect(captured.delegationSessionId).toBe("explicit-session");
  });

  it("creates recall services from the current session context instead of a shared parent closure", async () => {
    const recalledSessionIds: string[] = [];
    const harness = await createBuilderHarness({
      sessionRecallServiceFactory(input) {
        return {
          recall: vi.fn(async () => {
            recalledSessionIds.push(input.sessionRuntimeContext.currentSessionId());
            return {
              triggered: false,
              reason: "test",
              query: "test",
              blocks: [],
              rendered: ""
            };
          })
        } as never;
      }
    });
    const first = await harness.build("first-session");
    const second = await harness.build("second-session");

    expect(first.sessionRecallService).not.toBe(second.sessionRecallService);
    await first.sessionRecallService.recall("test");
    await second.sessionRecallService.recall("test");
    expect(recalledSessionIds).toEqual(["first-session", "second-session"]);
  });

  it("creates compaction services from the current session id instead of a shared parent service", async () => {
    const compactionSessionIds: string[] = [];
    const harness = await createBuilderHarness({
      memoryFileCompactionServiceFactory(input) {
        compactionSessionIds.push(input.sessionId);
        return {
          compact: vi.fn(async () => ({
            ok: false,
            status: "empty",
            file: "MEMORY.md",
            message: input.sessionId,
            code: "memory-file-compaction-empty",
            pressure: {
              kind: "MEMORY.md",
              source: "test",
              chars: 0,
              maxChars: 1,
              ratio: 0,
              percent: 0,
              state: "ok",
              remainingChars: 1,
              overflowChars: 0
            }
          }))
        } as never;
      }
    });
    const first = await harness.build("first-session");
    const second = await harness.build("second-session");

    expect(first.memoryFileCompactionService).not.toBe(second.memoryFileCompactionService);
    expect(compactionSessionIds).toEqual(["first-session", "second-session"]);
    await expect(first.memoryFileCompactionService.compact({ file: "MEMORY.md", dryRun: true }))
      .resolves.toMatchObject({ message: "first-session" });
    await expect(second.memoryFileCompactionService.compact({ file: "MEMORY.md", dryRun: true }))
      .resolves.toMatchObject({ message: "second-session" });
  });

  it("removes disabled toolsets before provider schemas are built", async () => {
    const writeTool = registeredTool("mcp.write", ["shell-write"]);
    const readTool = registeredTool("mcp.read", ["research"]);
    const harness = await createBuilderHarness({ mcpTools: [writeTool, readTool] });

    const built = await harness.build("session-a", { disabledToolsets: ["shell-write"] });

    expect(built.toolRegistry.get("mcp.write")).toBeUndefined();
    expect(built.toolRegistry.get("mcp.read")).toBe(readTool);
    expect(built.providerTools.map((tool) => tool.function.name)).not.toContain("mcp.write");
  });

  it("exposes cron runtime toolsets after disabled toolsets are removed", async () => {
    const observedToolsets: string[][] = [];
    const writeTool = registeredTool("mcp.write", ["shell-write"]);
    const readTool = registeredTool("mcp.read", ["research"]);
    const harness = await createBuilderHarness({
      mcpTools: [writeTool, readTool],
      setAvailableToolsets: (toolsets) => observedToolsets.push(toolsets)
    });

    await harness.build("session-a", { disabledToolsets: ["shell-write"] });

    expect(observedToolsets.at(-1)).toContain("research");
    expect(observedToolsets.at(-1)).not.toContain("shell-write");
  });
});

async function createBuilderHarness(input: {
  mcpTools?: RegisteredTool[];
  skillRegistry?: SkillRegistry;
  routes?: AgentLoopRuntimeSubstrate["routes"];
  executionControls?: AgentLoopRuntimeSubstrate["executionControls"];
  factories?: ConstructorParameters<typeof AgentLoopBuilder>[0]["factories"];
  sessionRecallServiceFactory?: AgentLoopRuntimeSubstrate["sessionRecallServiceFactory"];
  memoryFileCompactionServiceFactory?: AgentLoopRuntimeSubstrate["memoryFileCompactionServiceFactory"];
  memoryCurationServiceFactory?: AgentLoopRuntimeSubstrate["memoryCurationServiceFactory"];
  setAvailableToolsets?: AgentLoopRuntimeSubstrate["setAvailableToolsets"];
} = {}) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "estacoda-builder-test-"));
  const homeDir = workspaceRoot;
  const profileId = "default";
  const sessionDb = new InMemorySessionDB();
  const memoryStore = new MemoryStore();
  const memoryPersistenceService = new MemoryPersistenceService();
  const memoryConfig = normalizeMemoryConfig(undefined);
  const memoryRetrievalService = new LocalMemoryRetrievalService({
    index: undefined,
    config: memoryConfig,
    homeDir
  });
  const providerRegistry = new ProviderRegistry();
  const providerExecutor = new ProviderExecutor({ registry: providerRegistry });
  const promotionStore = new MemoryPromotionStore({
    path: join(workspaceRoot, "promotions.json"),
    persistence: memoryPersistenceService
  });
  const memoryProvider: MemoryProvider = new LocalMemoryProvider({
    store: memoryStore,
    saveRoots: {
      "USER.md": workspaceRoot,
      "MEMORY.md": workspaceRoot,
      "SOUL.md": workspaceRoot
    },
    promotionStore,
    persistence: memoryPersistenceService,
    memorySearchService: memoryRetrievalService,
    profileId
  });
  const skillRegistry = input.skillRegistry ?? new SkillRegistry();
  const fileStateTracker = new FileStateTracker();
  const skillEvolutionStore = new SkillEvolutionStore({
    usagePath: join(workspaceRoot, "usage.json"),
    evolutionRoot: join(workspaceRoot, "evolution")
  });
  const substrate: AgentLoopRuntimeSubstrate = {
    workspaceRoot,
    homeDir,
    stateRoot: join(homeDir, ".estacoda"),
    profileId,
    providerRegistry,
    providerExecutor,
    routes: input.routes ?? {
      model,
      mainRoute,
      providerPreferences: { providerOrder: ["openai"] }
    },
    executionControls: input.executionControls,
    mcpTools: input.mcpTools ?? [],
    skillRegistry,
    localSkillsRoot: join(workspaceRoot, "skills"),
    bundledSkillsRoot: join(workspaceRoot, "bundled-skills"),
    skillEvolutionStore,
    changeManifestStore: new ChangeManifestStore({ root: join(workspaceRoot, "manifests") }),
    skillUsageByName: new Map(),
    memoryStore,
    memoryProvider,
    memoryPromptContextBuilder: new MemoryPromptContextBuilder({
      store: memoryStore,
      promotionStore
    }),
    memoryPromptContext: undefined,
    memoryRetrievalService,
    sessionRecallServiceFactory: input.sessionRecallServiceFactory ?? (({ sessionRuntimeContext, sessionDb }) => new SessionRecallService({
      sessionDb,
      profileId,
      workspaceRoot,
      excludeSessionIds: () => [sessionRuntimeContext.currentSessionId()],
      mainRoute,
      providerExecutor
    })),
    memoryFileCompactionServiceFactory: input.memoryFileCompactionServiceFactory ?? (({ sessionId, sessionDb, trajectoryRecorder }) => new MemoryFileCompactionService({
      store: memoryStore,
      memoryRoot: workspaceRoot,
      mainRoute,
      providerExecutor,
      trajectoryRecorder,
      sessionDb,
      sessionId
    })),
    memoryCurationServiceFactory: input.memoryCurationServiceFactory,
    fileStateTracker,
    memoryPersistenceService,
    memoryPersistencePaths: {
      "USER.md": join(workspaceRoot, "USER.md"),
      "MEMORY.md": join(workspaceRoot, "MEMORY.md"),
      "SOUL.md": join(workspaceRoot, "SOUL.md")
    },
    memoryIndexSync: undefined,
    sessionCompressionService: new SessionCompressionService({
      sessionDb,
      config: normalizeSessionCompressionConfig(undefined),
      mainRoute,
      providerExecutor
    }),
    compressionConfig: normalizeSessionCompressionConfig(undefined),
    externalMemory: normalizeExternalMemoryConfig(undefined),
    externalMemoryProviders: [],
    processManager: new ProcessManager({ workspaceRoot }),
    browserBackend: {
      isAvailable: async () => false
    } as BrowserBackend,
    browserConfig: undefined,
    artifactStore: new ArtifactStore(),
    trustStore: new WorkspaceTrustStore({ path: join(workspaceRoot, "trust.json") }),
    cronStore: new CronStore({
      path: join(workspaceRoot, "cron", "jobs.json"),
      outputRoot: join(workspaceRoot, "cron", "output")
    }),
    contextReferenceExpander: new ContextReferenceExpander({ workspaceRoot }),
    projectContext: {
      workspaceRoot,
      files: [],
      warnings: []
    },
    channelMediaRoot: join(workspaceRoot, "channel-media"),
    audioCacheRoot: join(workspaceRoot, "audio-cache"),
    imageCacheRoot: join(workspaceRoot, "image-cache"),
    setAvailableToolsets: input.setAvailableToolsets
  };
  const builder = new AgentLoopBuilder({
    substrate,
    factories: input.factories
  });

  return {
    builder,
    fileStateTracker,
    sessionDb,
    workspaceRoot,
    stateRoot: join(homeDir, ".estacoda"),
    async build(sessionId: string, overrides: Partial<Parameters<AgentLoopBuilder["buildSession"]>[0]> = {}) {
      return await builder.buildSession({
        sessionId,
        sessionDb,
        trajectoryRecorder: {} as never,
        skillLearningManager: {} as never,
        agentEvolutionPolicy: deriveAgentEvolutionPolicy("none"),
        responseLabel: "EstaCoda",
        securityPolicy,
        delegationManagerFactory: () => ({} as never),
        trustedWorkspace: async () => true,
        ...overrides
      });
    }
  };
}

function registerRuntimePythonCapability() {
  const spec = {
    id: "fake-runtime-python",
    version: "0.1.0",
    packages: ["demo-package==1.2.3"],
    verifyImports: ["json"],
    optionalGroups: {
      extra: {
        packages: ["demo-extra==2.0.0"],
        verifyImports: ["email"]
      }
    }
  };
  registerPythonCapabilitySpecForTest(spec);
  return spec;
}

async function writeVerifiedCapability(
  stateRoot: string,
  spec: ReturnType<typeof registerRuntimePythonCapability>,
  groups: string[]
): Promise<void> {
  const paths = resolveManagedPythonCapabilityPaths({ stateRoot, capabilityId: spec.id });
  await mkdir(join(paths.envPath, "bin"), { recursive: true });
  await writeFile(paths.pythonPath, "", "utf8");
  await writeManagedPythonCapabilityManifest({
    stateRoot,
    capabilityId: spec.id
  }, {
    id: spec.id,
    version: spec.version,
    specHash: fingerprintManagedPythonCapabilitySpec(spec, groups),
    installedPackages: ["demo-package==1.2.3"],
    installedGroups: [...groups],
    pythonPath: paths.pythonPath,
    envPath: paths.envPath,
    createdAt: "2026-06-13T00:00:00.000Z",
    updatedAt: "2026-06-13T00:00:00.000Z",
    verifiedAt: "2026-06-13T00:00:00.000Z",
    status: "verified"
  });
}

function registeredTool(name: string, toolsets: string[]): RegisteredTool {
  return {
    ...toolDefinition(name, toolsets),
    isAvailable: async () => true,
    run: vi.fn(async () => ({ ok: true, content: "ok" }))
  };
}

function toolDefinition(name: string, toolsets: string[]) {
  return {
    name,
    description: name,
    inputSchema: { type: "object", properties: {} },
    riskClass: "read-only-local" as const,
    toolsets,
    progressLabel: name,
    maxResultSizeChars: 1_000
  };
}

function skill(name: string, overrides: Partial<SkillDefinition> = {}): LoadedSkill {
  return {
    name,
    description: name,
    version: "0.1.0",
    whenToUse: [name],
    requiredToolsets: [],
    playbook: [],
    permissionExpectations: [],
    examples: [],
    evaluations: [],
    sourcePath: `/tmp/${name}`,
    sourceKind: "local",
    sourceRoot: "/tmp",
    instructions: "Use this skill.",
    ...overrides
  };
}
