import { join } from "node:path";
import type { AuxiliaryProviderConfig, ModelProfile } from "../contracts/provider.js";
import type { BrowserBackend } from "../contracts/browser.js";
import type { MemoryPromotionRecord, MemoryProvider } from "../contracts/memory.js";
import type { SkillCatalogEntry } from "../contracts/skill.js";
import type { ToolDefinition, ToolsetName } from "../contracts/tool.js";
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
import type { MCPServerConfig } from "../config/runtime-config.js";
import { loadMcpServers, type MCPServerSnapshot } from "../mcp/mcp-tools.js";
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
import type { SecurityPolicy } from "../contracts/security.js";
import type { SessionDB } from "../contracts/session.js";
import { InMemorySessionDB } from "../session/in-memory-session-db.js";
import { CredentialPoolRegistry } from "../providers/credential-pool.js";
import { ProviderExecutor } from "../providers/provider-executor.js";
import { WorkspaceTrustStore } from "../security/workspace-trust-store.js";
import { createWorkspaceTrustTools } from "../security/workspace-trust-tools.js";
import { createSecurityPolicyForMode } from "../security/security-policy-factory.js";
import { loadSkillsFromDirectory } from "../skills/skill-loader.js";
import { SkillRegistry } from "../skills/skill-registry.js";
import { SkillLearningManager, type SkillAutonomy } from "../skills/skill-learning.js";
import { evaluateSkillVisibility } from "../skills/skill-visibility.js";
import { createSkillTools } from "../skills/skill-tools.js";
import { builtinTools } from "../tools/builtin-tools.js";
import { createExecuteCodeTool } from "../tools/execute-code-tool.js";
import { createPythonTools } from "../tools/python-tools.js";
import { createMediaTools } from "../tools/media-tools.js";
import { createVisionTools } from "../tools/vision-tools.js";
import { ToolExecutor } from "../tools/tool-executor.js";
import { ToolRegistry } from "../tools/tool-registry.js";
import { createWebTools, type FetchLike as WebFetchLike } from "../tools/web-tools.js";
import { createWorkspaceTools, type WorkspaceFsAdapter } from "../tools/workspace-tools.js";
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
  mcpServers?: Record<string, MCPServerConfig>;
  skillAutonomy?: SkillAutonomy;
  skillConfig?: Record<string, Record<string, unknown>>;
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
  telegramReady?: boolean;
  currentPlatform?: string;
  enableWebNetwork?: boolean;
  webMaxContentChars?: number;
  securityPolicy?: SecurityPolicy;
  securityMode?: import("../contracts/security.js").SecurityApprovalMode;
  securityAssessor?: import("../security/security-policy-factory.js").SecurityAssessorRuntimeConfig;
  workspaceFsAdapter?: WorkspaceFsAdapter;
};

export type Runtime = {
  describe(): string;
  tools(): import("../contracts/tool.js").ToolDefinition[];
  skills(): SkillCatalogEntry[];
  latestResumeNote(): Promise<string | undefined>;
  inspectMemoryPromotions(): Promise<MemoryPromotionRecord[]>;
  inspectMcpServers(): MCPServerSnapshot[];
  handle(input: AgentLoopInput): Promise<AgentLoopResponse>;
  executeTool?(input: {
    tool: string;
    toolInput: Record<string, unknown>;
    signal?: AbortSignal;
  }): Promise<import("../tools/tool-executor.js").ToolExecutionRecord | undefined>;
  trustWorkspace(): Promise<void>;
  isWorkspaceTrusted(): Promise<boolean>;
  revokeWorkspaceTrust(): Promise<boolean>;
  dispose(): Promise<void>;
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
  const personalSkillsRoot = options.personalSkillsRoot ?? `${options.homeDir ?? process.env.HOME ?? ""}/.estacoda/skills`;
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
  const channelMediaRoot = join(options.homeDir ?? process.env.HOME ?? workspaceRoot, ".estacoda", "channel-media");
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
  const loadedMcpServers = await loadMcpServers({
    servers: options.mcpServers ?? {}
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
  for (const server of loadedMcpServers) {
    for (const tool of server.tools) {
      toolRegistry.register(tool);
    }
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
  for (const tool of builtinTools) {
    toolRegistry.register(tool);
  }
  const browserBackend = options.browserBackend ?? createBrowserBackendFromConfig({
    backend: options.browser?.backend ?? "unconfigured",
    cdpUrl: options.browser?.cdpUrl,
    launchCommand: options.browser?.launchCommand,
    autoLaunch: options.browser?.autoLaunch,
    fetch: options.cdpFetch,
    webSocketFactory: options.cdpWebSocketFactory
  });
  for (const tool of createPythonTools({
    workspaceRoot,
    allowedRoots: [channelMediaRoot]
  })) {
    toolRegistry.register(tool);
  }
  for (const tool of createWebTools({
    fetch: options.webFetch,
    browserBackend,
    enableNetwork: options.enableWebNetwork,
    maxContentChars: options.webMaxContentChars
  })) {
    toolRegistry.register(tool);
  }
  for (const tool of createWorkspaceTools({
    workspaceRoot,
    fsAdapter: options.workspaceFsAdapter
  })) {
    toolRegistry.register(tool);
  }
  for (const tool of createMediaTools({
    workspaceRoot,
    artifactStore,
    allowedRoots: [channelMediaRoot]
  })) {
    toolRegistry.register(tool);
  }
  for (const tool of createVisionTools({
    workspaceRoot,
    allowedRoots: [channelMediaRoot],
    providerRegistry,
    credentialPools: options.credentialPools,
    routePreferences: auxiliaryProviderRouter.resolve("vision").preferences
  })) {
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
  const browserAvailable = await browserBackend.isAvailable();
  const toolAvailability = await toolRegistry.snapshot();
  const skillVisibilityContext = createSkillVisibilityContext({
    availableTools: toolAvailability.available,
    browserAvailable,
    telegramReady: options.telegramReady === true,
    webEnabled: options.enableWebNetwork === true,
    platform: options.currentPlatform ?? process.platform
  });
  const sessionSkillRegistry = new SkillRegistry();
  for (const skill of skillRegistry.list()) {
    if (evaluateSkillVisibility(skill, skillVisibilityContext).visible) {
      sessionSkillRegistry.register(skill);
    }
  }
  const sessionSkillCatalog = sessionSkillRegistry.catalog();
  for (const tool of createSkillTools({
    registry: skillRegistry,
    visibleRegistry: sessionSkillRegistry,
    personalSkillsRoot,
    projectSkillsRoot
  })) {
    toolRegistry.register(tool);
  }

  const userMemoryRoot = options.userMemoryRoot ?? `${options.homeDir ?? process.env.HOME ?? ""}/.estacoda/memory/default`;
  const projectMemoryRoot = options.projectMemoryRoot ?? `${workspaceRoot}/.estacoda/memory`;
  const skillLearningStorePath = join(workspaceRoot, ".estacoda", "skill-learning.json");
  await memoryStore.loadFromDirectory(new URL("../../memory/default", import.meta.url).pathname);
  await memoryStore.loadFromDirectory(userMemoryRoot);
  await memoryStore.loadFromDirectory(projectMemoryRoot);
  const memoryProvider = options.memoryProvider ?? new LocalMemoryProvider({
    store: memoryStore,
    saveRoots: {
      "USER.md": userMemoryRoot,
      "MEMORY.md": projectMemoryRoot,
      "SOUL.md": projectMemoryRoot,
      "AGENTS.md": projectMemoryRoot
    },
    promotionStorePath: join(userMemoryRoot, "promotions.json")
  });
  const skillLearningManager = new SkillLearningManager({
    autonomy: options.skillAutonomy ?? "suggest",
    registry: skillRegistry,
    projectSkillsRoot,
    storePath: skillLearningStorePath,
    sessionDb
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

  const intentRouter = new IntentRouter({ skillRegistry: sessionSkillRegistry, model: options.model });
  const providerExecutor = new ProviderExecutor({
    registry: providerRegistry,
    credentialPools: options.credentialPools
  });
  const securityPolicy = options.securityPolicy ?? createSecurityPolicyForMode(options.securityMode ?? "adaptive", {
    assessor: options.securityAssessor === undefined
      ? undefined
      : {
        ...options.securityAssessor,
        providerExecutor: options.securityAssessor.providerExecutor ?? providerExecutor,
        sessionId
      }
  });
  const toolExecutor = new ToolExecutor({
    registry: toolRegistry,
    securityPolicy,
    sessionDb,
    trajectoryRecorder,
    workspaceRoot
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
    securityPolicy,
    trajectoryRecorder,
    sessionDb,
    sessionId,
    profileId,
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
    skillsIndex: sessionSkillCatalog,
    skillConfig: options.skillConfig,
    skillLearningManager
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
    async inspectMemoryPromotions() {
      return await memoryProvider.inspectPromotions?.() ?? [];
    },
    inspectMcpServers() {
      return loadedMcpServers.map((server) => structuredClone(server.snapshot));
    },
    async handle(input) {
      const trustedWorkspace = input.trustedWorkspace ?? await trustStore.isTrusted(workspaceRoot, { profileId });
      activeTrustedWorkspace = trustedWorkspace;

      return agentLoop.handle({
        ...input,
        trustedWorkspace
      });
    },
    async executeTool(input) {
      const trustedWorkspace = await trustStore.isTrusted(workspaceRoot, { profileId });
      activeTrustedWorkspace = trustedWorkspace;
      return await toolExecutor.executeTool({
        tool: input.tool,
        input: input.toolInput,
        trustedWorkspace,
        sessionId,
        signal: input.signal
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
    async dispose() {
      await Promise.all(loadedMcpServers.map((server) => server.stop().catch(() => undefined)));
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
        `mcp servers: ${loadedMcpServers.filter((server) => server.snapshot.available).length}/${loadedMcpServers.length}`,
        `skills: ${sessionSkillCatalog.length}`,
        `skill autonomy: ${options.skillAutonomy ?? "suggest"}`,
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

function createSkillVisibilityContext(input: {
  availableTools: ToolDefinition[];
  browserAvailable: boolean;
  telegramReady: boolean;
  webEnabled: boolean;
  platform: string;
}) {
  const availableTools = new Set(
    input.availableTools
      .filter((tool) => isSkillVisibleToolUsable(tool.name, input))
      .map((tool) => tool.name)
  );
  const availableToolsets = new Set<ToolsetName>();

  for (const tool of input.availableTools) {
    if (!availableTools.has(tool.name)) {
      continue;
    }

    for (const toolset of tool.toolsets) {
      availableToolsets.add(toolset);
    }
  }

  setToolsetAvailability(availableToolsets, "web", input.webEnabled && availableTools.has("web.extract"));
  setToolsetAvailability(availableToolsets, "browser", input.browserAvailable && availableTools.has("browser.navigate"));
  setToolsetAvailability(availableToolsets, "telegram", input.telegramReady);
  setToolsetAvailability(availableToolsets, "shell-readonly", availableTools.has("terminal.run"));
  setToolsetAvailability(
    availableToolsets,
    "shell-write",
    availableTools.has("terminal.run") || availableTools.has("process.start") || availableTools.has("execute_code")
  );

  return {
    platform: input.platform,
    availableToolsets,
    availableTools
  };
}

function isSkillVisibleToolUsable(
  toolName: string,
  input: {
    availableTools: ToolDefinition[];
    browserAvailable: boolean;
    telegramReady: boolean;
    webEnabled: boolean;
    platform: string;
  }
): boolean {
  if (toolName === "web.extract") {
    return input.webEnabled;
  }

  if (toolName === "browser.navigate" || toolName === "browser.status") {
    return input.browserAvailable;
  }

  return true;
}

function setToolsetAvailability(availableToolsets: Set<ToolsetName>, toolset: ToolsetName, available: boolean) {
  if (available) {
    availableToolsets.add(toolset);
    return;
  }

  availableToolsets.delete(toolset);
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
