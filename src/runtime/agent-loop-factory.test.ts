import { describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { DEFAULT_DELEGATION_CONFIG } from "../config/delegation-defaults.js";
import {
  MAX_DELEGATE_MODEL_OVERRIDE_ID_LENGTH,
  MAX_DELEGATE_PROVIDER_OVERRIDE_ID_LENGTH
} from "../contracts/delegation.js";
import type { ModelProfile, ProviderId, ResolvedModelRoute } from "../contracts/provider.js";
import type { SessionRecord } from "../contracts/session.js";
import type { ToolDefinition, ToolRiskClass, ToolsetName } from "../contracts/tool.js";
import { ProviderRegistry } from "../providers/provider-registry.js";
import { resolveProfileStateHome, writeActiveProfile } from "../config/profile-home.js";
import { InMemorySessionDB } from "../session/in-memory-session-db.js";
import { ToolRegistry } from "../tools/tool-registry.js";
import { TrajectoryRecorder } from "../trajectory/trajectory-recorder.js";
import type { BuiltAgentLoopSession } from "./agent-loop-builder.js";
import {
  CHILD_APPROVAL_MODE,
  CHILD_DELEGATION_CONFIG_VERSION,
  DefaultChildAgentLoopFactory,
  createChildFailClosedSecurityPolicy
} from "./agent-loop-factory.js";

describe("DefaultChildAgentLoopFactory", () => {
  it("creates a child session with delegated metadata and suppressed runtime features", async () => {
    const db = new InMemorySessionDB();
    const built = fakeBuiltSession();
    const builder = fakeBuilder(built);
    const factory = new DefaultChildAgentLoopFactory({
      builder: builder as never,
      parentRoutes: parentRoutes(),
      sessionDb: db,
      trajectoryRecorderFactory: ({ profileId, sessionId }) => new TrajectoryRecorder({ profileId, sessionId, modelId: "model" }),
      responseLabel: "EstaCoda",
      workspaceRoot: "/workspace",
      id: () => "child-1"
    });

    const child = await factory.createChild({
      parentSessionId: "parent-1",
      profileId: "default",
      task: "Inspect the thing",
      context: "Extra context",
      allowedToolsets: ["research"],
      allowedTools: ["file.search"],
      trustedWorkspace: true,
      parentVisibleTools: readOnlyParentTools()
    });

    const session = await db.getSession("child-1");
    expect(child.childSessionId).toBe("child-1");
    expect(session).toMatchObject({
      id: "child-1",
      parentSessionId: "parent-1",
      metadata: {
        kind: "delegated-child",
        parentSessionId: "parent-1",
        role: "leaf",
        depth: 1,
        allowedToolsets: ["research"],
        allowedTools: ["file.search"],
        effectiveAllowedTools: ["file.search"],
        strippedTools: expect.arrayContaining([
          expect.objectContaining({ name: "terminal.run" })
        ]),
        delegationConfigVersion: CHILD_DELEGATION_CONFIG_VERSION,
        approvalMode: CHILD_APPROVAL_MODE,
        workspaceRoot: "/workspace"
      }
    } satisfies Partial<SessionRecord>);
    expect(session?.metadata?.suppressedRuntimeFeatures).toEqual(expect.arrayContaining([
      "memoryRecall",
      "skillLearning",
      "sessionCompression",
      "workflowAdapter",
      "projectContext"
    ]));
  });

  it("records durable Task ownership in Task Step worker sessions", async () => {
    const db = new InMemorySessionDB();
    const factory = new DefaultChildAgentLoopFactory({
      builder: fakeBuilder(fakeBuiltSession()) as never,
      parentRoutes: parentRoutes(),
      sessionDb: db,
      trajectoryRecorderFactory: ({ profileId, sessionId }) => new TrajectoryRecorder({ profileId, sessionId, modelId: "model" }),
      responseLabel: "EstaCoda",
      workspaceRoot: "/workspace",
      id: () => "task-child-1"
    });

    await factory.createChild({
      parentSessionId: "parent-1",
      profileId: "default",
      task: "Run the durable Step",
      trustedWorkspace: true,
      parentVisibleTools: readOnlyParentTools(),
      taskExecution: {
        taskId: "task-1",
        planRevisionId: "revision-1",
        stepId: "step-1",
        attemptId: "attempt-1"
      }
    });

    await expect(db.getSession("task-child-1")).resolves.toMatchObject({
      title: "Task Step: Run the durable Step",
      metadata: {
        kind: "task-step-worker",
        taskId: "task-1",
        planRevisionId: "revision-1",
        stepId: "step-1",
        attemptId: "attempt-1"
      }
    });
  });

  it("builds a runnable child loop without parent recall, compression, learning, or full project context", async () => {
    const db = new InMemorySessionDB();
    const built = fakeBuiltSession();
    const builder = fakeBuilder(built);
    const factory = new DefaultChildAgentLoopFactory({
      builder: builder as never,
      parentRoutes: parentRoutes(),
      sessionDb: db,
      trajectoryRecorderFactory: ({ profileId, sessionId }) => new TrajectoryRecorder({ profileId, sessionId, modelId: "model" }),
      responseLabel: "EstaCoda",
      workspaceRoot: "/workspace",
      id: () => "child-1"
    });

    const child = await factory.createChild({
      parentSessionId: "parent-1",
      profileId: "default",
      task: "Run child",
      trustedWorkspace: true,
      parentVisibleTools: readOnlyParentTools()
    });
    const response = await child.handle({ text: "hello", channel: "cli" });
    const buildInput = builder.buildSession.mock.calls[0]?.[0] as {
      memoryRecall?: string;
      sessionCompression?: string;
      skillLearningManager?: unknown;
      agentEvolutionPolicy?: unknown;
      projectContext?: unknown;
    } | undefined;

    expect(response.text).toBe("child answer");
    expect(buildInput?.memoryRecall).toBe("disabled");
    expect(buildInput?.sessionCompression).toBe("disabled");
    expect(buildInput?.skillLearningManager).toBeUndefined();
    expect(buildInput?.agentEvolutionPolicy).toBeUndefined();
    expect(buildInput?.projectContext).toEqual({ workspaceRoot: "/workspace", files: [], warnings: [] });
  });

  it("strips delegate_task from leaf child registries", async () => {
    const db = new InMemorySessionDB();
    const built = fakeBuiltSession();
    const tools = parentToolsWithDelegate();
    const builder = fakeBuilder(built, tools);
    const factory = new DefaultChildAgentLoopFactory({
      builder: builder as never,
      parentRoutes: parentRoutes(),
      sessionDb: db,
      trajectoryRecorderFactory: ({ profileId, sessionId }) => new TrajectoryRecorder({ profileId, sessionId, modelId: "model" }),
      responseLabel: "EstaCoda",
      workspaceRoot: "/workspace",
      delegationConfig: { ...DEFAULT_DELEGATION_CONFIG, maxSpawnDepth: 3 },
      id: () => "child-1"
    });

    const child = await factory.createChild({
      parentSessionId: "parent-1",
      profileId: "default",
      task: "Leaf child",
      trustedWorkspace: true,
      role: "leaf",
      depth: 1,
      parentVisibleTools: tools
    });

    expect(child.builtSession.toolRegistry.get("delegate_task")).toBeUndefined();
    expect(child.toolAccess.blockedTools).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "delegate_task", reasons: expect.arrayContaining(["leaf-delegation-disabled"]) })
    ]));
  });

  it("keeps delegate_task for orchestrators below max spawn depth", async () => {
    const db = new InMemorySessionDB();
    const built = fakeBuiltSession();
    const tools = parentToolsWithDelegate();
    const builder = fakeBuilder(built, tools);
    const factory = new DefaultChildAgentLoopFactory({
      builder: builder as never,
      parentRoutes: parentRoutes(),
      sessionDb: db,
      trajectoryRecorderFactory: ({ profileId, sessionId }) => new TrajectoryRecorder({ profileId, sessionId, modelId: "model" }),
      responseLabel: "EstaCoda",
      workspaceRoot: "/workspace",
      delegationConfig: { ...DEFAULT_DELEGATION_CONFIG, maxSpawnDepth: 3 },
      id: () => "child-1"
    });

    const child = await factory.createChild({
      parentSessionId: "parent-1",
      profileId: "default",
      task: "Orchestrator child",
      trustedWorkspace: true,
      role: "orchestrator",
      depth: 1,
      parentVisibleTools: tools
    });

    expect(child.builtSession.toolRegistry.get("delegate_task")).toBeDefined();
    expect(child.toolAccess.effectiveAllowedTools).toContain("delegate_task");
  });

  it("applies same-provider child model overrides and disables child fallbacks", async () => {
    const db = new InMemorySessionDB();
    const built = fakeBuiltSession();
    const builder = fakeBuilder(built);
    const factory = new DefaultChildAgentLoopFactory({
      builder: builder as never,
      parentRoutes: parentRoutes(),
      sessionDb: db,
      trajectoryRecorderFactory: ({ profileId, sessionId }) => new TrajectoryRecorder({ profileId, sessionId, modelId: "model" }),
      responseLabel: "EstaCoda",
      workspaceRoot: "/workspace",
      id: () => "child-override"
    });

    const child = await factory.createChild({
      parentSessionId: "parent-1",
      profileId: "default",
      task: "Use another model",
      trustedWorkspace: true,
      modelOverride: { provider: "local", model: "child-model" },
      parentVisibleTools: readOnlyParentTools()
    });
    const buildInput = builder.buildSession.mock.calls[0]?.[0] as {
      providerRoutes?: {
        model: ModelProfile;
        primaryModelRoute?: ResolvedModelRoute;
        modelFallbackRoutes?: ResolvedModelRoute[];
        providerPreferences?: { providerOrder?: string[] };
      };
    };
    const session = await db.getSession("child-override");

    expect(buildInput.providerRoutes?.model.id).toBe("child-model");
    expect(buildInput.providerRoutes?.primaryModelRoute?.id).toBe("child-model");
    expect(buildInput.providerRoutes?.primaryModelRoute?.provider).toBe("local");
    expect(buildInput.providerRoutes?.modelFallbackRoutes).toEqual([]);
    expect(buildInput.providerRoutes?.providerPreferences?.providerOrder).toEqual(["local"]);
    expect(child.modelOverride).toEqual({
      requested: true,
      status: "applied",
      provider: "local",
      model: "child-model",
      fallbackBehavior: "disabled-for-override"
    });
    expect(session?.metadata?.modelOverride).toEqual(child.modelOverride);
    expect(JSON.stringify(session?.metadata?.modelOverride)).not.toContain("KEY");
  });

  it("uses exact valid-length model override ids when constructing child routes", async () => {
    const db = new InMemorySessionDB();
    const built = fakeBuiltSession();
    const builder = fakeBuilder(built);
    const factory = new DefaultChildAgentLoopFactory({
      builder: builder as never,
      parentRoutes: parentRoutes(),
      sessionDb: db,
      trajectoryRecorderFactory: ({ profileId, sessionId }) => new TrajectoryRecorder({ profileId, sessionId, modelId: "model" }),
      responseLabel: "EstaCoda",
      workspaceRoot: "/workspace",
      id: () => "child-valid-long-model"
    });
    const modelId = `model-${"x".repeat(MAX_DELEGATE_MODEL_OVERRIDE_ID_LENGTH - "model-".length)}`;

    const child = await factory.createChild({
      parentSessionId: "parent-1",
      profileId: "default",
      task: "Use a long model id",
      trustedWorkspace: true,
      modelOverride: { provider: "local", model: modelId },
      parentVisibleTools: readOnlyParentTools()
    });
    const buildInput = builder.buildSession.mock.calls[0]?.[0] as {
      providerRoutes?: {
        model: ModelProfile;
        primaryModelRoute?: ResolvedModelRoute;
      };
    };

    expect(modelId).toHaveLength(MAX_DELEGATE_MODEL_OVERRIDE_ID_LENGTH);
    expect(buildInput.providerRoutes?.model.id).toBe(modelId);
    expect(buildInput.providerRoutes?.primaryModelRoute?.id).toBe(modelId);
    expect(child.modelOverride?.model).toBe(modelId);
    expect(JSON.stringify(child.modelOverride)).not.toContain("[truncated]");
  });

  it("rejects overlong model override ids without building a child session", async () => {
    const db = new InMemorySessionDB();
    const built = fakeBuiltSession();
    const builder = fakeBuilder(built);
    const factory = new DefaultChildAgentLoopFactory({
      builder: builder as never,
      parentRoutes: parentRoutes(),
      sessionDb: db,
      trajectoryRecorderFactory: ({ profileId, sessionId }) => new TrajectoryRecorder({ profileId, sessionId, modelId: "model" }),
      responseLabel: "EstaCoda",
      workspaceRoot: "/workspace",
      id: () => "child-overlong-model"
    });
    const overlongModelId = `model-${"x".repeat(MAX_DELEGATE_MODEL_OVERRIDE_ID_LENGTH + 1)}`;
    let error: unknown;

    try {
      await factory.createChild({
        parentSessionId: "parent-1",
        profileId: "default",
        task: "Use an overlong model id",
        trustedWorkspace: true,
        modelOverride: { provider: "local", model: overlongModelId },
        parentVisibleTools: readOnlyParentTools()
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toMatchObject({
      metadata: {
        requested: true,
        status: "rejected",
        provider: "local",
        reason: "invalid-model-override"
      }
    });
    expect(JSON.stringify((error as { metadata?: unknown }).metadata)).not.toContain(overlongModelId);
    expect(builder.buildSession).not.toHaveBeenCalled();
    await expect(db.getSession("child-overlong-model")).resolves.toBeUndefined();
  });

  it("applies reviewed cross-provider child model overrides with target provider route data", async () => {
    const db = new InMemorySessionDB();
    const built = fakeBuiltSession();
    const builder = fakeBuilder(built);
    const registry = new ProviderRegistry();
    registry.register({
      id: "deepseek",
      name: "DeepSeek",
      endpoint: {
        baseUrl: "https://api.deepseek.com/v1",
        apiKey: { kind: "env", name: "DEEPSEEK_API_KEY" }
      },
      health: () => ({ available: true }),
      listModels: async () => [modelProfile("deepseek", "deepseek-chat")],
      complete: async () => ({ ok: true, content: "", provider: "deepseek", model: "deepseek-chat" })
    });
    const factory = new DefaultChildAgentLoopFactory({
      builder: builder as never,
      parentRoutes: parentRoutes(),
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
      sessionDb: db,
      trajectoryRecorderFactory: ({ profileId, sessionId }) => new TrajectoryRecorder({ profileId, sessionId, modelId: "model" }),
      responseLabel: "EstaCoda",
      workspaceRoot: "/workspace",
      id: () => "child-cross-provider"
    });
    const previous = process.env.DEEPSEEK_API_KEY;
    process.env.DEEPSEEK_API_KEY = "secret-route-value";

    try {
      const child = await factory.createChild({
        parentSessionId: "parent-1",
        profileId: "default",
        task: "Use another provider",
        trustedWorkspace: true,
        modelOverride: { provider: "deepseek", model: "deepseek-chat" },
        parentVisibleTools: readOnlyParentTools()
      });
      const buildInput = builder.buildSession.mock.calls[0]?.[0] as {
        providerRoutes?: {
          model: ModelProfile;
          primaryModelRoute?: ResolvedModelRoute;
          modelFallbackRoutes?: ResolvedModelRoute[];
          providerPreferences?: { providerOrder?: string[] };
        };
      };
      const session = await db.getSession("child-cross-provider");

      expect(buildInput.providerRoutes?.model).toMatchObject({
        provider: "deepseek",
        id: "deepseek-chat"
      });
      expect(buildInput.providerRoutes?.primaryModelRoute).toMatchObject({
        provider: "deepseek",
        id: "deepseek-chat",
        baseUrl: "https://configured.deepseek.example/v1",
        apiKeyEnv: "DEEPSEEK_API_KEY",
        apiMode: "custom_openai_compatible",
        authMethod: "api_key"
      });
      expect(buildInput.providerRoutes?.modelFallbackRoutes).toEqual([]);
      expect(buildInput.providerRoutes?.providerPreferences?.providerOrder).toEqual(["deepseek"]);
      expect(child.modelOverride).toEqual({
        requested: true,
        status: "applied",
        provider: "deepseek",
        model: "deepseek-chat",
        fallbackBehavior: "disabled-for-override"
      });
      expect(session?.metadata?.modelOverride).toEqual(child.modelOverride);
      expect(JSON.stringify(session?.metadata?.modelOverride)).not.toContain("secret-route-value");
    } finally {
      if (previous === undefined) {
        delete process.env.DEEPSEEK_API_KEY;
      } else {
        process.env.DEEPSEEK_API_KEY = previous;
      }
    }
  });

  it("rejects unknown cross-provider overrides before building a child session", async () => {
    const db = new InMemorySessionDB();
    const built = fakeBuiltSession();
    const builder = fakeBuilder(built);
    const factory = new DefaultChildAgentLoopFactory({
      builder: builder as never,
      parentRoutes: parentRoutes(),
      providerRegistry: new ProviderRegistry(),
      sessionDb: db,
      trajectoryRecorderFactory: ({ profileId, sessionId }) => new TrajectoryRecorder({ profileId, sessionId, modelId: "model" }),
      responseLabel: "EstaCoda",
      workspaceRoot: "/workspace",
      id: () => "child-cross-provider"
    });

    await expect(factory.createChild({
      parentSessionId: "parent-1",
      profileId: "default",
      task: "Use another provider",
      trustedWorkspace: true,
      modelOverride: { provider: "openai", model: "gpt-test" },
      parentVisibleTools: readOnlyParentTools()
    })).rejects.toMatchObject({
      metadata: {
        requested: true,
        status: "rejected",
        provider: "openai",
        model: "gpt-test",
        reason: "unknown-provider"
      }
    });
    expect(builder.buildSession).not.toHaveBeenCalled();
    await expect(db.getSession("child-cross-provider")).resolves.toBeUndefined();
  });

  it("rejects unknown cross-provider models before building a child session", async () => {
    const db = new InMemorySessionDB();
    const built = fakeBuiltSession();
    const builder = fakeBuilder(built);
    const registry = new ProviderRegistry();
    registry.register({
      id: "deepseek",
      name: "DeepSeek",
      endpoint: {
        baseUrl: "https://api.deepseek.com/v1",
        apiKey: { kind: "env", name: "DEEPSEEK_API_KEY" }
      },
      health: () => ({ available: true }),
      listModels: async () => [modelProfile("deepseek", "deepseek-chat")],
      complete: async () => ({ ok: true, content: "", provider: "deepseek", model: "deepseek-chat" })
    });
    const factory = new DefaultChildAgentLoopFactory({
      builder: builder as never,
      parentRoutes: parentRoutes(),
      providerRegistry: registry,
      providerConfigs: {
        deepseek: {
          baseUrl: "https://api.deepseek.com/v1",
          apiKeyEnv: "DEEPSEEK_API_KEY",
          enableNetwork: true
        }
      },
      sessionDb: db,
      trajectoryRecorderFactory: ({ profileId, sessionId }) => new TrajectoryRecorder({ profileId, sessionId, modelId: "model" }),
      responseLabel: "EstaCoda",
      workspaceRoot: "/workspace",
      id: () => "child-unknown-model"
    });

    await expect(factory.createChild({
      parentSessionId: "parent-1",
      profileId: "default",
      task: "Use another provider",
      trustedWorkspace: true,
      modelOverride: { provider: "deepseek", model: "not-registered" },
      parentVisibleTools: readOnlyParentTools()
    })).rejects.toMatchObject({
      metadata: {
        requested: true,
        status: "rejected",
        provider: "deepseek",
        model: "not-registered",
        reason: "unknown-model"
      }
    });
    expect(builder.buildSession).not.toHaveBeenCalled();
    await expect(db.getSession("child-unknown-model")).resolves.toBeUndefined();
  });

  it("rejects cross-provider model overrides with missing credentials before building a child session", async () => {
    const db = new InMemorySessionDB();
    const built = fakeBuiltSession();
    const builder = fakeBuilder(built);
    const registry = new ProviderRegistry();
    registry.register({
      id: "deepseek",
      name: "DeepSeek",
      endpoint: {
        baseUrl: "https://api.deepseek.com/v1",
        apiKey: { kind: "env", name: "DEEPSEEK_MISSING_API_KEY" }
      },
      health: () => ({ available: true }),
      listModels: async () => [modelProfile("deepseek", "deepseek-chat")],
      complete: async () => ({ ok: true, content: "", provider: "deepseek", model: "deepseek-chat" })
    });
    const factory = new DefaultChildAgentLoopFactory({
      builder: builder as never,
      parentRoutes: parentRoutes(),
      providerRegistry: registry,
      providerConfigs: {
        deepseek: {
          baseUrl: "https://api.deepseek.com/v1",
          apiKeyEnv: "DEEPSEEK_MISSING_API_KEY",
          enableNetwork: true
        }
      },
      sessionDb: db,
      trajectoryRecorderFactory: ({ profileId, sessionId }) => new TrajectoryRecorder({ profileId, sessionId, modelId: "model" }),
      responseLabel: "EstaCoda",
      workspaceRoot: "/workspace",
      id: () => "child-missing-provider-key"
    });
    delete process.env.DEEPSEEK_MISSING_API_KEY;

    await expect(factory.createChild({
      parentSessionId: "parent-1",
      profileId: "default",
      task: "Use another provider",
      trustedWorkspace: true,
      modelOverride: { provider: "deepseek", model: "deepseek-chat" },
      parentVisibleTools: readOnlyParentTools()
    })).rejects.toMatchObject({
      metadata: {
        requested: true,
        status: "rejected",
        provider: "deepseek",
        model: "deepseek-chat",
        reason: "missing-credentials"
      }
    });
    expect(builder.buildSession).not.toHaveBeenCalled();
    await expect(db.getSession("child-missing-provider-key")).resolves.toBeUndefined();
  });

  it("checks cross-provider OAuth credentials in the selected profile", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "estacoda-child-oauth-profile-"));
    try {
      writeActiveProfile("default", { homeDir });
      const authPath = resolveProfileStateHome({ homeDir, profileId: "research" }).authJsonPath;
      await mkdir(dirname(authPath), { recursive: true });
      await writeFile(authPath, JSON.stringify({
        version: 1,
        providers: {
          codex: {
            authMethod: "oauth_device_pkce",
            accessToken: "research-codex-token",
            expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
            source: "estacoda"
          }
        }
      }, null, 2) + "\n", "utf8");

      const db = new InMemorySessionDB();
      const built = fakeBuiltSession();
      const builder = fakeBuilder(built);
      const registry = new ProviderRegistry();
      registry.register({
        id: "codex",
        name: "Codex",
        endpoint: {
          baseUrl: "https://chatgpt.com/backend-api/codex",
          apiKey: { kind: "none" }
        },
        health: () => ({ available: true }),
        listModels: async () => [modelProfile("codex", "gpt-5.5")],
        complete: async () => ({ ok: true, content: "", provider: "codex", model: "gpt-5.5" })
      });
      const factory = new DefaultChildAgentLoopFactory({
        builder: builder as never,
        parentRoutes: parentRoutes(),
        providerRegistry: registry,
        providerConfigs: {
          codex: {
            baseUrl: "https://chatgpt.com/backend-api/codex",
            apiMode: "openai_responses",
            authMethod: "oauth_device_pkce",
            enableNetwork: true
          }
        },
        homeDir,
        profileId: "research",
        sessionDb: db,
        trajectoryRecorderFactory: ({ profileId, sessionId }) => new TrajectoryRecorder({ profileId, sessionId, modelId: "model" }),
        responseLabel: "EstaCoda",
        workspaceRoot: "/workspace",
        id: () => "child-codex-profile"
      });

      const child = await factory.createChild({
        parentSessionId: "parent-1",
        profileId: "research",
        task: "Use Codex child",
        trustedWorkspace: true,
        modelOverride: { provider: "codex", model: "gpt-5.5" },
        parentVisibleTools: readOnlyParentTools()
      });

      expect(child.modelOverride).toEqual({
        requested: true,
        status: "applied",
        provider: "codex",
        model: "gpt-5.5",
        fallbackBehavior: "disabled-for-override"
      });
      expect(builder.buildSession).toHaveBeenCalled();
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it("allows cross-provider authMethod none without requiring credentials", async () => {
    const db = new InMemorySessionDB();
    const built = fakeBuiltSession();
    const builder = fakeBuilder(built);
    const registry = new ProviderRegistry();
    registry.register({
      id: "custom-local",
      name: "Custom Local",
      endpoint: {
        baseUrl: "http://localhost:9000/v1",
        apiKey: { kind: "none" }
      },
      health: () => ({ available: true }),
      listModels: async () => [modelProfile("custom-local", "local-no-auth-model")],
      complete: async () => ({ ok: true, content: "", provider: "custom-local", model: "local-no-auth-model" })
    });
    const factory = new DefaultChildAgentLoopFactory({
      builder: builder as never,
      parentRoutes: parentRoutes(),
      providerRegistry: registry,
      providerConfigs: {
        "custom-local": {
          baseUrl: "http://localhost:9000/v1",
          apiMode: "custom_openai_compatible",
          authMethod: "none",
          enableNetwork: true
        }
      },
      sessionDb: db,
      trajectoryRecorderFactory: ({ profileId, sessionId }) => new TrajectoryRecorder({ profileId, sessionId, modelId: "model" }),
      responseLabel: "EstaCoda",
      workspaceRoot: "/workspace",
      id: () => "child-no-auth-provider"
    });

    const child = await factory.createChild({
      parentSessionId: "parent-1",
      profileId: "default",
      task: "Use no-auth provider",
      trustedWorkspace: true,
      modelOverride: { provider: "custom-local", model: "local-no-auth-model" },
      parentVisibleTools: readOnlyParentTools()
    });
    const buildInput = builder.buildSession.mock.calls[0]?.[0] as {
      providerRoutes?: {
        primaryModelRoute?: ResolvedModelRoute;
        providerPreferences?: { providerOrder?: string[] };
      };
    };

    expect(child.modelOverride).toMatchObject({
      requested: true,
      status: "applied",
      provider: "custom-local",
      model: "local-no-auth-model"
    });
    expect(buildInput.providerRoutes?.primaryModelRoute).toMatchObject({
      provider: "custom-local",
      id: "local-no-auth-model",
      apiMode: "custom_openai_compatible",
      authMethod: "none",
      baseUrl: "http://localhost:9000/v1"
    });
    expect(buildInput.providerRoutes?.primaryModelRoute?.apiKeyEnv).toBeUndefined();
    expect(buildInput.providerRoutes?.providerPreferences?.providerOrder).toEqual(["custom-local"]);
  });

  it("rejects cross-provider overrides when target provider network execution is disabled", async () => {
    const db = new InMemorySessionDB();
    const built = fakeBuiltSession();
    const builder = fakeBuilder(built);
    const registry = new ProviderRegistry();
    registry.register({
      id: "deepseek",
      name: "DeepSeek",
      endpoint: {
        baseUrl: "https://api.deepseek.com/v1",
        apiKey: { kind: "env", name: "DEEPSEEK_API_KEY" }
      },
      health: () => ({ available: true }),
      listModels: async () => [modelProfile("deepseek", "deepseek-chat")],
      complete: async () => ({ ok: true, content: "", provider: "deepseek", model: "deepseek-chat" })
    });
    const factory = new DefaultChildAgentLoopFactory({
      builder: builder as never,
      parentRoutes: parentRoutes(),
      providerRegistry: registry,
      providerConfigs: {
        deepseek: {
          baseUrl: "https://api.deepseek.com/v1",
          apiKeyEnv: "DEEPSEEK_API_KEY",
          enableNetwork: false
        }
      },
      sessionDb: db,
      trajectoryRecorderFactory: ({ profileId, sessionId }) => new TrajectoryRecorder({ profileId, sessionId, modelId: "model" }),
      responseLabel: "EstaCoda",
      workspaceRoot: "/workspace",
      id: () => "child-network-disabled"
    });
    const previous = process.env.DEEPSEEK_API_KEY;
    process.env.DEEPSEEK_API_KEY = "secret-route-value";

    try {
      await expect(factory.createChild({
        parentSessionId: "parent-1",
        profileId: "default",
        task: "Use another provider",
        trustedWorkspace: true,
        modelOverride: { provider: "deepseek", model: "deepseek-chat" },
        parentVisibleTools: readOnlyParentTools()
      })).rejects.toMatchObject({
        metadata: {
          requested: true,
          status: "rejected",
          provider: "deepseek",
          model: "deepseek-chat",
          reason: "provider-network-disabled"
        }
      });
      expect(builder.buildSession).not.toHaveBeenCalled();
      await expect(db.getSession("child-network-disabled")).resolves.toBeUndefined();
    } finally {
      if (previous === undefined) {
        delete process.env.DEEPSEEK_API_KEY;
      } else {
        process.env.DEEPSEEK_API_KEY = previous;
      }
    }
  });

  it("rejects overlong provider override ids without exposing the full value", async () => {
    const db = new InMemorySessionDB();
    const built = fakeBuiltSession();
    const builder = fakeBuilder(built);
    const factory = new DefaultChildAgentLoopFactory({
      builder: builder as never,
      parentRoutes: parentRoutes(),
      sessionDb: db,
      trajectoryRecorderFactory: ({ profileId, sessionId }) => new TrajectoryRecorder({ profileId, sessionId, modelId: "model" }),
      responseLabel: "EstaCoda",
      workspaceRoot: "/workspace",
      id: () => "child-overlong-provider"
    });
    const overlongProvider = `provider-${"x".repeat(MAX_DELEGATE_PROVIDER_OVERRIDE_ID_LENGTH + 1)}`;
    let error: unknown;

    try {
      await factory.createChild({
        parentSessionId: "parent-1",
        profileId: "default",
        task: "Use an overlong provider id",
        trustedWorkspace: true,
        modelOverride: { provider: overlongProvider, model: "child-model" },
        parentVisibleTools: readOnlyParentTools()
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toMatchObject({
      metadata: {
        requested: true,
        status: "rejected",
        reason: "invalid-model-override"
      }
    });
    expect(builder.buildSession).not.toHaveBeenCalled();
    expect(JSON.stringify((error as { metadata?: unknown }).metadata)).not.toContain(overlongProvider);
    await expect(db.getSession("child-overlong-provider")).resolves.toBeUndefined();
  });

  it("uses a non-interactive fail-closed child approval policy", async () => {
    const policy = createChildFailClosedSecurityPolicy();

    await expect(policy.assess?.({
      riskClass: "credential-access",
      description: "read secret",
      context: { trustedWorkspace: true }
    })).resolves.toMatchObject({
      decision: "deny",
      reason: expect.stringContaining("non-interactive")
    });

    await expect(policy.assess?.({
      riskClass: "read-only-local",
      description: "read file",
      context: { trustedWorkspace: true }
    })).resolves.toMatchObject({
      decision: "allow"
    });
  });
});

function fakeBuilder(built: BuiltAgentLoopSession, tools: readonly ToolDefinition[] = readOnlyParentTools()) {
  return {
    buildSession: vi.fn(async (input: {
      toolRegistryFilter?: BuiltAgentLoopSession["toolFilterResult"] extends never ? never : (filterInput: {
        registry: ToolRegistry;
        availableTools: ReturnType<ToolRegistry["list"]>;
      }) => unknown;
    }) => {
      const registry = new ToolRegistry();
      for (const tool of tools) {
        registry.register({
          ...tool,
          isAvailable: () => true,
          run: async () => ({ ok: true, content: "" })
        });
      }
      input.toolRegistryFilter?.({
        registry,
        availableTools: registry.list()
      });
      return {
        ...built,
        toolRegistry: registry
      };
    }),
    cleanupSession: vi.fn(async () => undefined)
  };
}

function fakeBuiltSession(): BuiltAgentLoopSession {
  return {
    agentLoop: {
      handle: vi.fn(async () => ({
        label: "EstaCoda",
        text: "child answer",
        matchedSkills: [],
        intent: {
          nativeIntent: "general",
          labels: ["general"],
          confidence: 1,
          suggestedToolsets: [],
          suggestedSkills: [],
          confirmationRequired: false,
          rationale: "test",
          evidence: []
        },
        securityDecision: "allow",
        toolExecutions: [],
        toolPlans: [],
        skillOutcomes: [],
        artifacts: [],
        context: undefined,
        projectContext: undefined,
        progress: []
      }))
    },
    sessionRuntimeContext: { currentSessionId: () => "child-1" },
    toolRegistry: {},
    toolExecutor: {},
    toolCallPlanner: {},
    runRecorder: {},
    toolPlanRunner: {},
    providerTurnLoop: {},
    skillPlaybookRunner: {},
    nativeToolExecutor: {},
    runtimeRouter: {},
    intentRouter: {},
    sessionSkillRegistry: {},
    sessionSkillCatalog: [],
    providerTools: [],
    providerRoutes: {},
    delegationService: {},
    sessionRecallService: {},
    memoryFileCompactionService: {}
  } as never;
}

function readOnlyParentTools() {
  return [
    tool("file.search", "read-only-local", ["files", "research"]),
    tool("web.search", "read-only-network", ["web", "research"]),
    tool("terminal.run", "workspace-write", ["shell-write", "coding"])
  ];
}

function parentToolsWithDelegate() {
  return [
    ...readOnlyParentTools(),
    tool("delegate_task", "shared-state-mutation", ["core", "research", "coding"])
  ] as const;
}

function parentRoutes() {
  const model = modelProfile("local", "parent-model");
  const mainRoute: ResolvedModelRoute = {
    provider: "local",
    id: model.id,
    profile: model
  };
  return {
    model,
    mainRoute,
    primaryModelRoute: mainRoute,
    modelFallbackRoutes: [
      {
        provider: "local",
        id: "fallback-model",
        profile: { ...model, id: "fallback-model" }
      }
    ],
    providerPreferences: { providerOrder: ["local"] }
  };
}

function modelProfile(provider: ProviderId, id: string): ModelProfile {
  return {
    id,
    provider,
    contextWindowTokens: 128_000,
    supportsTools: true,
    supportsVision: false,
    supportsStructuredOutput: true
  };
}

function tool(name: string, riskClass: ToolRiskClass, toolsets: ToolsetName[]) {
  return {
    name,
    description: name,
    inputSchema: { type: "object" },
    riskClass,
    toolsets,
    progressLabel: name,
    maxResultSizeChars: 1000
  };
}
