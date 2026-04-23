import type { AuxiliaryProviderConfig, ModelProfile } from "../contracts/provider.js";
import type { BrowserBackend } from "../contracts/browser.js";
import type { MemoryProvider } from "../contracts/memory.js";
import type { SkillCatalogEntry } from "../contracts/skill.js";
import { ArtifactStore } from "../artifacts/artifact-store.js";
import { createBrowserBackendFromConfig, type CdpFetchLike, type CdpWebSocketFactory } from "../browser/browser-backend.js";
import type { ThemeDefinition } from "../contracts/theme.js";
import { createConfigTools } from "../config/config-tools.js";
import { ContextReferenceExpander } from "../context/context-reference-expander.js";
import { ProjectContextLoader, renderProjectContext } from "../context/project-context-loader.js";
import { DelegationManager } from "../delegation/delegation-manager.js";
import { createDelegationTools } from "../delegation/delegation-tools.js";
import { createMemoryTool } from "../memory/memory-tool.js";
import { renderMemorySnapshot } from "../memory/memory-renderer.js";
import { MemoryStore } from "../memory/memory-store.js";
import { LocalMemoryProvider } from "../memory/local-memory-provider.js";
import { createOnboardingTools } from "../onboarding/onboarding-tools.js";
import { ProcessManager } from "../process/process-manager.js";
import { createProcessTools } from "../process/process-tools.js";
import { AuxiliaryProviderRouter, summarizeAuxiliaryRoutes } from "../providers/auxiliary-provider-router.js";
import { createCatalogProvider } from "../providers/catalog-provider.js";
import { inferModelProfile, knownModelProfiles } from "../providers/model-catalog.js";
import { createOpenAICompatibleProvider } from "../providers/openai-compatible-provider.js";
import { ProviderRegistry } from "../providers/provider-registry.js";
import { routeProvider } from "../providers/provider-router.js";
import { capabilityFirstDefaults } from "../contracts/security.js";
import type { SessionDB } from "../contracts/session.js";
import { InMemorySessionDB } from "../session/in-memory-session-db.js";
import { CredentialPoolRegistry } from "../providers/credential-pool.js";
import { ProviderExecutor } from "../providers/provider-executor.js";
import { WorkspaceTrustStore } from "../security/workspace-trust-store.js";
import { createWorkspaceTrustTools } from "../security/workspace-trust-tools.js";
import { loadSkillsFromDirectory } from "../skills/skill-loader.js";
import { SkillRegistry } from "../skills/skill-registry.js";
import { createSkillTools } from "../skills/skill-tools.js";
import { builtinTools } from "../tools/builtin-tools.js";
import { createExecuteCodeTool } from "../tools/execute-code-tool.js";
import { createPythonTools } from "../tools/python-tools.js";
import { createMediaTools } from "../tools/media-tools.js";
import { ToolExecutor } from "../tools/tool-executor.js";
import { ToolRegistry } from "../tools/tool-registry.js";
import { createWebTools, type FetchLike as WebFetchLike } from "../tools/web-tools.js";
import { createWorkspaceTools } from "../tools/workspace-tools.js";
import { ToolCallPlanner } from "../tools/tool-call-planner.js";
import { buildProviderToolSchemaCatalog } from "../tools/tool-schema.js";
import { TrajectoryRecorder } from "../trajectory/trajectory-recorder.js";
import { AgentLoop, type AgentLoopInput, type AgentLoopResponse } from "./agent-loop.js";
import { IntentRouter } from "./intent-router.js";

export type RuntimeOptions = {
  theme: ThemeDefinition;
  model: ModelProfile;
  profileId?: string;
  sessionId?: string;
  sessionDb?: SessionDB;
  workspaceRoot?: string;
  personalSkillsRoot?: string;
  projectSkillsRoot?: string;
  externalSkillRoots?: string[];
  trustStore?: WorkspaceTrustStore;
  trustStorePath?: string;
  providerRegistry?: ProviderRegistry;
  credentialPools?: CredentialPoolRegistry;
  memoryProvider?: MemoryProvider;
  userMemoryRoot?: string;
  projectMemoryRoot?: string;
  auxiliaryProviders?: AuxiliaryProviderConfig;
  homeDir?: string;
  userConfigPath?: string;
  projectConfigPath?: string;
  webFetch?: WebFetchLike;
  cdpFetch?: CdpFetchLike;
  cdpWebSocketFactory?: CdpWebSocketFactory;
  browserBackend?: BrowserBackend;
  browser?: {
    backend: "local-cdp" | "browserbase" | "firecrawl" | "camofox" | "mock" | "unconfigured";
    cdpUrl?: string;
    launchCommand?: string;
    autoLaunch: boolean;
  };
  enableWebNetwork?: boolean;
  webMaxContentChars?: number;
};

export type Runtime = {
  describe(): string;
  tools(): import("../contracts/tool.js").ToolDefinition[];
  skills(): SkillCatalogEntry[];
  latestResumeNote(): Promise<string | undefined>;
  handle(input: AgentLoopInput): Promise<AgentLoopResponse>;
  trustWorkspace(): Promise<void>;
  isWorkspaceTrusted(): Promise<boolean>;
  revokeWorkspaceTrust(): Promise<boolean>;
  sessionDb: SessionDB;
  sessionId: string;
};

export async function createRuntime(options: RuntimeOptions): Promise<Runtime> {
  const toolRegistry = new ToolRegistry();
  const skillRegistry = new SkillRegistry();
  const memoryStore = new MemoryStore();
  const artifactStore = new ArtifactStore();
  const profileId = options.profileId ?? "default";
  const sessionId = options.sessionId ?? "scaffold";
  const sessionDb = options.sessionDb ?? new InMemorySessionDB();
  const workspaceRoot = options.workspaceRoot ?? process.cwd();
  const personalSkillsRoot = options.personalSkillsRoot ?? new URL("../../skills/personal", import.meta.url).pathname;
  const projectSkillsRoot = options.projectSkillsRoot ?? `${workspaceRoot}/.estacoda/skills`;
  const trustStore = options.trustStore ?? new WorkspaceTrustStore({ path: options.trustStorePath });
  const providerRegistry = options.providerRegistry ?? createDefaultProviderRegistry(options.model);
  const providerModels = await providerRegistry.listModels();
  const auxiliaryProviderRouter = new AuxiliaryProviderRouter({
    models: providerModels,
    config: options.auxiliaryProviders
  });
  const auxiliaryRoutes = options.model.provider === "unconfigured"
    ? []
    : auxiliaryProviderRouter.resolveAll();
  const providerRoute = options.model.provider === "unconfigured"
    ? undefined
    : routeProvider(providerModels, {
      requireTools: options.model.supportsTools,
      requireVision: options.model.supportsVision,
      requireStructuredOutput: options.model.supportsStructuredOutput,
      providerOrder: [options.model.provider],
      preferFreeOrOpenWeights: true
    });
  const processManager = new ProcessManager({ workspaceRoot });
  let activeTrustedWorkspace = false;
  const existingSession = await sessionDb.getSession(sessionId);

  if (existingSession === undefined) {
    await sessionDb.createSession({
      id: sessionId,
      profileId,
      title: "EstaCoda v2 scaffold"
    });
  }

  const trajectoryRecorder = new TrajectoryRecorder({
    profileId,
    sessionId,
    modelId: options.model.id
  });

  const loadedOfficialSkills = await loadSkillsFromDirectory(new URL("../../skills/official", import.meta.url).pathname, {
    sourceKind: "official"
  });

  if (loadedOfficialSkills.errors.length > 0) {
    throw new Error(
      `Failed to load official skills: ${loadedOfficialSkills.errors
        .map((error) => `${error.path}: ${error.message}`)
        .join("; ")}`
    );
  }

  for (const skill of loadedOfficialSkills.skills) {
    skillRegistry.register(skill);
  }
  for (const root of [personalSkillsRoot, projectSkillsRoot, ...(options.externalSkillRoots ?? [])]) {
    const loaded = await loadSkillsFromDirectory(root, {
      sourceKind: root === personalSkillsRoot ? "personal" : root === projectSkillsRoot ? "project" : "external",
      sourceRoot: root
    }).catch(() => ({ skills: [], errors: [] }));

    for (const skill of loaded.skills) {
      skillRegistry.register(skill);
    }
  }
  const sessionSkillRegistry = new SkillRegistry();
  for (const skill of skillRegistry.list()) {
    sessionSkillRegistry.register(skill);
  }
  const sessionSkillCatalog = sessionSkillRegistry.catalog();

  for (const tool of builtinTools) {
    toolRegistry.register(tool);
  }
  for (const tool of createSkillTools({ registry: skillRegistry, personalSkillsRoot, projectSkillsRoot })) {
    toolRegistry.register(tool);
  }
  for (const tool of createPythonTools({ workspaceRoot })) {
    toolRegistry.register(tool);
  }
  for (const tool of createWebTools({
    fetch: options.webFetch,
    browserBackend: options.browserBackend ?? createBrowserBackendFromConfig({
      backend: options.browser?.backend ?? "unconfigured",
      cdpUrl: options.browser?.cdpUrl,
      launchCommand: options.browser?.launchCommand,
      autoLaunch: options.browser?.autoLaunch,
      fetch: options.cdpFetch,
      webSocketFactory: options.cdpWebSocketFactory
    }),
    enableNetwork: options.enableWebNetwork,
    maxContentChars: options.webMaxContentChars
  })) {
    toolRegistry.register(tool);
  }
  for (const tool of createWorkspaceTools({ workspaceRoot })) {
    toolRegistry.register(tool);
  }
  for (const tool of createMediaTools({ workspaceRoot, artifactStore })) {
    toolRegistry.register(tool);
  }
  for (const tool of createProcessTools({ processManager })) {
    toolRegistry.register(tool);
  }
  for (const tool of createWorkspaceTrustTools({ workspaceRoot, profileId, trustStore })) {
    toolRegistry.register(tool);
  }
  for (const tool of createConfigTools({
    workspaceRoot,
    homeDir: options.homeDir,
    userConfigPath: options.userConfigPath,
    projectConfigPath: options.projectConfigPath
  })) {
    toolRegistry.register(tool);
  }
  for (const tool of createOnboardingTools({
    workspaceRoot,
    homeDir: options.homeDir,
    userConfigPath: options.userConfigPath,
    projectConfigPath: options.projectConfigPath
  })) {
    toolRegistry.register(tool);
  }
  toolRegistry.register(createMemoryTool(memoryStore));

  const userMemoryRoot = options.userMemoryRoot ?? `${options.homeDir ?? process.env.HOME ?? ""}/.estacoda/memory/default`;
  const projectMemoryRoot = options.projectMemoryRoot ?? `${workspaceRoot}/.estacoda/memory`;
  await memoryStore.loadFromDirectory(new URL("../../memory/default", import.meta.url).pathname);
  await memoryStore.loadFromDirectory(userMemoryRoot);
  await memoryStore.loadFromDirectory(projectMemoryRoot);
  const memoryProvider = options.memoryProvider ?? new LocalMemoryProvider({
    store: memoryStore,
    saveRoot: projectMemoryRoot
  });
  const frozenMemorySnapshot = memoryStore.snapshot();
  const memoryContext = await memoryProvider.context();
  const contextReferenceExpander = new ContextReferenceExpander({ workspaceRoot });
  const projectContext = await new ProjectContextLoader({ workspaceRoot }).load();
  const renderedProjectContext = renderProjectContext(projectContext);

  trajectoryRecorder.record("session-start", {
    theme: options.theme.name,
    model: options.model.id,
    profile: profileId,
    projectContextFiles: projectContext.files.map((file) => file.source)
  });

  await sessionDb.appendEvent(sessionId, {
    kind: "trajectory-linked",
    trajectoryId: trajectoryRecorder.snapshot().id
  });

  const intentRouter = new IntentRouter({ skillRegistry: sessionSkillRegistry });
  const providerExecutor = new ProviderExecutor({
    registry: providerRegistry,
    credentialPools: options.credentialPools
  });
  const toolExecutor = new ToolExecutor({
    registry: toolRegistry,
    securityPolicy: capabilityFirstDefaults,
    sessionDb,
    trajectoryRecorder
  });
  const delegationManager = new DelegationManager({
    sessionDb,
    toolExecutor,
    trajectoryRecorder
  });
  for (const tool of createDelegationTools({
    manager: delegationManager,
    parentSessionId: sessionId,
    profileId,
    trustedWorkspace: async () => activeTrustedWorkspace || await trustStore.isTrusted(workspaceRoot, { profileId })
  })) {
    toolRegistry.register(tool);
  }
  toolRegistry.register(createExecuteCodeTool({
    workspaceRoot,
    toolExecutor,
    sessionDb,
    trajectoryRecorder,
    sessionId,
    trustedWorkspace: async () => activeTrustedWorkspace || await trustStore.isTrusted(workspaceRoot, { profileId })
  }));
  const providerToolSchemaCatalog = buildProviderToolSchemaCatalog({
    tools: toolRegistry.list()
  });
  const toolCallPlanner = new ToolCallPlanner({
    registry: toolRegistry,
    aliases: providerToolSchemaCatalog.aliases
  });

  const agentLoop = new AgentLoop({
    responseLabel: options.theme.branding.responseLabel,
    intentRouter,
    securityPolicy: capabilityFirstDefaults,
    trajectoryRecorder,
    sessionDb,
    sessionId,
    toolExecutor,
    toolCallPlanner,
    providerExecutor,
    memoryProvider,
    memoryContext,
    model: options.model,
    providerPreferences: {
      providerOrder: [options.model.provider],
      preferFreeOrOpenWeights: true
    },
    contextReferenceExpander,
    projectContext,
    providerTools: providerToolSchemaCatalog.tools,
    soul: frozenMemorySnapshot.files.get("SOUL.md"),
    frozenMemory: {
      user: frozenMemorySnapshot.files.get("USER.md"),
      memory: frozenMemorySnapshot.files.get("MEMORY.md")
    },
    skillsIndex: sessionSkillCatalog
  });

  return {
    sessionDb,
    sessionId,
    tools() {
      return toolRegistry.list();
    },
    skills() {
      return sessionSkillCatalog;
    },
    async latestResumeNote() {
      const events = await sessionDb.listEvents(sessionId);
      const cancelled = [...events].reverse().find((event) => event.kind === "agent-cancelled" && event.resumeNote !== undefined);

      return cancelled?.kind === "agent-cancelled" ? cancelled.resumeNote : undefined;
    },
    async handle(input) {
      const trustedWorkspace = input.trustedWorkspace ?? await trustStore.isTrusted(workspaceRoot, { profileId });
      activeTrustedWorkspace = trustedWorkspace;

      return agentLoop.handle({
        ...input,
        trustedWorkspace
      });
    },
    async trustWorkspace() {
      await trustStore.grant(workspaceRoot, {
        profileId,
        label: "EstaCoda workspace"
      });
    },
    isWorkspaceTrusted() {
      return trustStore.isTrusted(workspaceRoot, { profileId });
    },
    revokeWorkspaceTrust() {
      return trustStore.revoke(workspaceRoot, { profileId });
    },
    describe() {
      const memorySnapshot = memoryStore.snapshot();
      const renderedMemory = renderMemorySnapshot(memorySnapshot);
      const trajectory = trajectoryRecorder.snapshot();

      return [
        `${options.theme.branding.responseLabel} v2 runtime scaffold`,
        `theme: ${options.theme.name}`,
        `model: ${options.model.provider}/${options.model.id}`,
        `provider route: ${providerRoute === undefined ? "unavailable" : `${providerRoute.primary.provider}/${providerRoute.primary.id}`}`,
        `provider fallbacks: ${providerRoute === undefined ? 0 : providerRoute.fallbacks.length}`,
        `auxiliary routes: ${auxiliaryRoutes.length === 0 ? "unavailable" : summarizeAuxiliaryRoutes(auxiliaryRoutes)}`,
        `tools: ${toolRegistry.list().length}`,
        `skills: ${skillRegistry.list().length}`,
        `project context files: ${projectContext.files.length}`,
        `project context bytes: ${renderedProjectContext.length}`,
        `trust store: ${trustStore.path}`,
        `memory files: ${memorySnapshot.files.size}`,
        `memory usage: ${renderedMemory.usage
          .map((entry) =>
            entry.maxChars === undefined
              ? `${entry.kind} ${entry.chars}`
              : `${entry.kind} ${entry.chars}/${entry.maxChars}`
          )
          .join(", ")}`,
        `trajectory events: ${trajectory.events.length}`,
        `session: ${sessionId}`,
        "status: ready for first runtime loop"
      ].join("\n");
    }
  };
}

function createDefaultProviderRegistry(selectedModel: ModelProfile): ProviderRegistry {
  const registry = new ProviderRegistry();
  const catalogModels = uniqueModels([
    inferModelProfile({
      provider: selectedModel.provider,
      model: selectedModel.id,
      contextWindowTokens: selectedModel.contextWindowTokens
    }),
    ...knownModelProfiles
  ]);

  for (const provider of new Set(catalogModels.map((model) => model.provider))) {
    const models = catalogModels.filter((model) => model.provider === provider);

    if (isOpenAICompatibleProvider(provider)) {
      registry.register(createOpenAICompatibleProvider({
        id: provider,
        endpoint: {
          baseUrl: defaultBaseUrl(provider),
          apiKey: provider === "local"
            ? { kind: "none" }
            : { kind: "env", name: defaultEnvKey(provider) }
        },
        models
      }));
    } else {
      registry.register(createCatalogProvider({
        id: provider,
        models
      }));
    }
  }

  return registry;
}

function isOpenAICompatibleProvider(provider: string): boolean {
  return [
    "openai-compatible",
    "local",
    "deepseek",
    "kimi",
    "google",
    "openai",
    "openrouter",
    "nous"
  ].includes(provider);
}

function uniqueModels(models: ModelProfile[]): ModelProfile[] {
  const seen = new Set<string>();
  const unique: ModelProfile[] = [];

  for (const model of models) {
    const key = `${model.provider}/${model.id}`;

    if (!seen.has(key)) {
      seen.add(key);
      unique.push(model);
    }
  }

  return unique;
}

function defaultBaseUrl(provider: string): string {
  switch (provider) {
    case "openai":
      return "https://api.openai.com/v1";
    case "anthropic":
      return "https://api.anthropic.com/v1";
    case "google":
      return "https://generativelanguage.googleapis.com/v1beta/openai";
    case "deepseek":
      return "https://api.deepseek.com/v1";
    case "kimi":
      return "https://api.moonshot.ai/v1";
    case "openrouter":
      return "https://openrouter.ai/api/v1";
    case "local":
      return "http://localhost:11434/v1";
    default:
      return "https://example.invalid/v1";
  }
}

function defaultEnvKey(provider: string): string {
  switch (provider) {
    case "openai":
      return "OPENAI_API_KEY";
    case "anthropic":
      return "ANTHROPIC_API_KEY";
    case "google":
      return "GOOGLE_API_KEY";
    case "deepseek":
      return "DEEPSEEK_API_KEY";
    case "kimi":
      return "KIMI_API_KEY";
    case "openrouter":
      return "OPENROUTER_API_KEY";
    default:
      return "OPENAI_COMPATIBLE_API_KEY";
  }
}
