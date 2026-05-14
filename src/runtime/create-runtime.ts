import { join } from "node:path";
import type { AuxiliaryModelConfig, ModelProfile, ResolvedModelRoute } from "../contracts/provider.js";
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
import { CronStore } from "../cron/cron-store.js";
import { createCronTools } from "../cron/cron-tools.js";
import { DelegationManager } from "../delegation/delegation-manager.js";
import { createDelegationTools } from "../delegation/delegation-tools.js";
import { createMemoryTool } from "../memory/memory-tool.js";
import { createKnowledgeMemoryTools } from "../memory/knowledge-memory-tools.js";
import { createKnowledgeCodeTools } from "../knowledge/knowledge-code-tools.js";
import { MemoryStore } from "../memory/memory-store.js";
import { LocalMemoryProvider } from "../memory/local-memory-provider.js";
import type { AgentProfileMode, AgentResponseLanguage, LoadedRuntimeConfig, MCPServerConfig, UiFlavor, UiLanguage } from "../config/runtime-config.js";
import { loadMcpServers, type MCPServerSnapshot } from "../mcp/mcp-tools.js";
import { ProcessManager } from "../process/process-manager.js";
import { createProcessTools } from "../process/process-tools.js";
import { resolveAuxiliaryModelRoute } from "../providers/auxiliary-model-resolver.js";
import { createCatalogProvider } from "../providers/catalog-provider.js";
import { fallbackKnownModelProfiles, inferModelProfile } from "../providers/model-catalog.js";
import { createOpenAICompatibleProvider } from "../providers/openai-compatible-provider.js";
import { ProviderRegistry } from "../providers/provider-registry.js";
import { getDefaultBaseUrl, getDefaultApiKeyEnv } from "../providers/provider-metadata.js";
import { capabilityFirstDefaults } from "../contracts/security.js";
import type { SecurityApprovalMode, SecurityPolicy, SecurityRequest } from "../contracts/security.js";
import type { SessionDB } from "../contracts/session.js";
import { InMemorySessionDB } from "../session/in-memory-session-db.js";
import { SQLiteSessionDB } from "../session/sqlite-session-db.js";
import { CredentialPoolRegistry } from "../providers/credential-pool.js";
import { ProviderExecutor } from "../providers/provider-executor.js";
import { WorkspaceTrustStore } from "../security/workspace-trust-store.js";
import { createWorkspaceTrustTools } from "../security/workspace-trust-tools.js";
import { createSecurityPolicyForMode } from "../security/security-policy-factory.js";
import { type ApprovalScope, type PersistedWorkspaceApprovalGrant, type WorkspaceApprovalController } from "../security/workspace-approval-controller.js";
import { loadSkillsFromDirectory } from "../skills/skill-loader.js";
import { SkillRegistry } from "../skills/skill-registry.js";
import { SkillEvolutionStore } from "../skills/skill-evolution.js";
import { ChangeManifestStore } from "../skills/change-manifest-store.js";
import { SkillLearningManager, type SkillAutonomy } from "../skills/skill-learning.js";
import { syncBundledSkills } from "../skills/skill-bundled-sync.js";
import { evaluateSkillVisibility } from "../skills/skill-visibility.js";
import { createSkillTools } from "../skills/skill-tools.js";

// TaskFlow v0.8 imports
import { SQLiteTaskFlowStore } from "../taskflow/sqlite-taskflow-store.js";
import { FlowLockService } from "../taskflow/flow-lock-service.js";
import { TaskFlowEngine } from "../taskflow/taskflow-engine.js";
import { OperatorCommandDispatcher } from "../taskflow/operator-command-dispatcher.js";
import { FlowProcessRegistry } from "../taskflow/flow-process-registry.js";
import { FlowCompactionService, DEFAULT_COMPACTION_CONFIG } from "../taskflow/flow-compaction-service.js";
import { FlowRestartRecovery } from "../taskflow/flow-restart-recovery.js";
import { TaskFlowAgentLoopAdapter } from "../taskflow/taskflow-agent-loop-adapter.js";

import { builtinTools } from "../tools/builtin-tools.js";
import { createExecuteCodeTool } from "../tools/execute-code-tool.js";
import { createPythonTools } from "../tools/python-tools.js";
import { createMediaTools } from "../tools/media-tools.js";
import { createImageGenerationTools, type ImageGenerationFetchLike } from "../tools/image-generation-tools.js";
import { defaultImageGenerationConfig, verifyImageGeneration, type ImageGenerationVerification } from "../tools/image-generation-verify.js";
import { createVoiceTools, type VoiceFetchLike } from "../tools/voice-tools.js";
import { analyzeImageWithVision, createVisionTools } from "../tools/vision-tools.js";
import { ToolExecutor } from "../tools/tool-executor.js";
import { ToolRegistry } from "../tools/tool-registry.js";
import { createWebTools, type FetchLike as WebFetchLike } from "../tools/web-tools.js";
import { createWorkspaceTools, type WorkspaceFsAdapter } from "../tools/workspace-tools.js";
import { ToolCallPlanner } from "../tools/tool-call-planner.js";
import { buildProviderToolSchemaCatalog } from "../tools/tool-schema.js";
import { TrajectoryRecorder } from "../trajectory/trajectory-recorder.js";
import { AgentLoop, type AgentLoopInput, type AgentLoopResponse } from "./agent-loop.js";
import { IntentRouter } from "./intent-router.js";
import { RunRecorder } from "./run-recorder.js";
import { RuntimeRouter } from "./runtime-router.js";
import { ToolPlanRunner } from "./tool-plan-runner.js";
import { ProviderTurnLoop } from "./provider-turn-loop.js";
import { SkillWorkflowExecutor } from "./skill-workflow-executor.js";
import { NativeToolExecutor } from "./native-tool-executor.js";
import { buildStatusViewModel, buildKeyValueBlockViewModel, kv, buildWarningErrorViewModel, buildStartupViewModel } from "../ui/view-models/builders.js";
import { collectStartupReadinessSnapshot, type StartupReadinessSnapshot } from "./startup-readiness.js";
import { collectSetupVerificationReport } from "../onboarding/verification.js";
import { readCachedUpdateStatus } from "../lifecycle/update-engine.js";

export type RuntimeOptions = {
  theme: ThemeDefinition;
  model: ModelProfile;
  primaryModelRoute?: ResolvedModelRoute;
  modelFallbackRoutes?: ResolvedModelRoute[];
  profileId?: string;
  sessionId?: string;
  sessionDb?: SessionDB;
  closeSessionDbOnDispose?: boolean;
  workspaceRoot?: string;
  localSkillsRoot?: string;
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
  auxiliaryModels?: AuxiliaryModelConfig;
  homeDir?: string;
  userConfigPath?: string;
  projectConfigPath?: string;
  projectConfigTrust?: "trusted" | "untrusted";
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
  tts?: LoadedRuntimeConfig["tts"];
  stt?: LoadedRuntimeConfig["stt"];
  voiceFetch?: VoiceFetchLike;
  imageGen?: LoadedRuntimeConfig["imageGen"];
  imageGenerationFetch?: ImageGenerationFetchLike;
  ui?: {
    language: UiLanguage;
    flavor: UiFlavor;
    activityLabels: "en" | "ar";
  };
  agentProfile?: {
    mode: AgentProfileMode;
    responseLanguage: AgentResponseLanguage;
  };
  telegramReady?: boolean;
  currentPlatform?: string;
  enableWebNetwork?: boolean;
  webMaxContentChars?: number;
  securityPolicy?: SecurityPolicy;
  securityMode?: import("../contracts/security.js").SecurityApprovalMode;
  securityAssessor?: import("../security/security-policy-factory.js").SecurityAssessorRuntimeConfig;
  approvalController?: WorkspaceApprovalController;
  cronStore?: CronStore;
  disableCronTools?: boolean;
  disabledToolsets?: ToolsetName[];
  workspaceFsAdapter?: WorkspaceFsAdapter;
  sessionMetadata?: Record<string, unknown>;
};

export type Runtime = {
  describe(): string;
  getStatus(): import("../contracts/view-model.js").StatusViewModel;
  getModelInfo(): import("../contracts/view-model.js").KeyValueBlockViewModel;
  getStartup(): import("../contracts/view-model.js").StartupViewModel;
  getStartupReadiness(): Promise<StartupReadinessSnapshot>;
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
  verifyImageGeneration?(options?: {
    checkProvider?: boolean;
  }): Promise<ImageGenerationVerification>;
  grantApproval?(input: {
    toolName: string;
    riskClass: import("../contracts/tool.js").ToolRiskClass;
    targetKey?: string;
    targetSummary?: string;
    scope: ApprovalScope;
  }): Promise<void>;
  inspectApprovals?(): Promise<{
    session: Array<{
      toolName: string;
      riskClass: import("../contracts/tool.js").ToolRiskClass;
      targetKey?: string;
      targetSummary?: string;
      scope: "once" | "session";
    }>;
    persistent: PersistedWorkspaceApprovalGrant[];
  }>;
  revokeApproval?(id: string): Promise<boolean>;
  securityMode?(): SecurityApprovalMode;
  toggleYoloMode?(): { enabled: boolean; mode: SecurityApprovalMode };
  trustWorkspace(): Promise<void>;
  isWorkspaceTrusted(): Promise<boolean>;
  revokeWorkspaceTrust(): Promise<boolean>;
  dispose(): Promise<void>;
  sessionDb: SessionDB;
  sessionId: string;

  // TaskFlow v0.8 integration (available when SQLiteSessionDB is used)
  taskflow?: {
    engine: import("../taskflow/taskflow-engine.js").TaskFlowEngine;
    store: import("../taskflow/taskflow-store.js").TaskFlowStore;
    dispatcher: import("../taskflow/operator-command-dispatcher.js").OperatorCommandDispatcher;
    processRegistry: import("../taskflow/flow-process-registry.js").FlowProcessRegistry;
    compactionService: import("../taskflow/flow-compaction-service.js").FlowCompactionService;
    adapter: import("../taskflow/taskflow-agent-loop-adapter.js").TaskFlowAgentLoopAdapter;
    activeFlowId: string | null;
    setActiveFlowId(flowId: string | null): void;
    recoverFromRestart(): Promise<{
      interruptedFlows: number;
      recoveredLocks: number;
    }>;
  };
};

export async function createRuntime(options: RuntimeOptions): Promise<Runtime> {
  const toolRegistry = new ToolRegistry();
  const skillRegistry = new SkillRegistry();
  const memoryStore = new MemoryStore();
  const artifactStore = new ArtifactStore();
  const profileId = options.profileId ?? "default";
  const sessionId = options.sessionId ?? "scaffold";
  const sessionDb = options.sessionDb ?? new InMemorySessionDB();
  const closeSessionDbOnDispose = options.closeSessionDbOnDispose ?? true;
  const workspaceRoot = options.workspaceRoot ?? process.cwd();
  const localSkillsRoot = options.localSkillsRoot ?? `${options.homeDir ?? process.env.HOME ?? ""}/.estacoda/skills`;
  const trustStore = options.trustStore ?? new WorkspaceTrustStore({ path: options.trustStorePath });
  const cronStore = options.cronStore ?? new CronStore({ homeDir: options.homeDir });
  const providerRegistry = options.providerRegistry ?? createDefaultProviderRegistry(options.model);
  const providerModels = await providerRegistry.listModels();
  const mainRoute: ResolvedModelRoute = options.primaryModelRoute ?? {
    provider: options.model.provider,
    id: options.model.id,
    profile: options.model
  };
  const auxiliaryModels = options.auxiliaryModels ?? {};
  const approvalRoute = options.model.provider === "unconfigured"
    ? undefined
    : resolveAuxiliaryModelRoute("approval", auxiliaryModels.approval ?? { provider: "auto", enabled: true }, {
      mainRoute,
      providerRegistry,
      providerModels
    });
  const visionRoute = options.model.provider === "unconfigured"
    ? undefined
    : resolveAuxiliaryModelRoute("vision", auxiliaryModels.vision ?? { provider: "auto", enabled: true }, {
      mainRoute,
      providerRegistry,
      providerModels
    });
  const processManager = new ProcessManager({ workspaceRoot });
  const channelMediaRoot = join(options.homeDir ?? process.env.HOME ?? workspaceRoot, ".estacoda", "channel-media");
  const audioCacheRoot = join(options.homeDir ?? process.env.HOME ?? workspaceRoot, ".estacoda", "audio-cache");
  const imageCacheRoot = join(options.homeDir ?? process.env.HOME ?? workspaceRoot, ".estacoda", "image-cache");
  let activeTrustedWorkspace = false;
  let disposed = false;
  const existingSession = await sessionDb.getSession(sessionId);

  if (existingSession === undefined) {
    await sessionDb.createSession({
      id: sessionId,
      profileId,
      title: "EstaCoda v2 scaffold",
      metadata: options.sessionMetadata
    });
  }

  const trajectoryRecorder = new TrajectoryRecorder({
    profileId,
    sessionId,
    modelId: options.model.id
  });

  const bundledSkillsDir = new URL("../../skills/official", import.meta.url).pathname;
  const bundledSync = await syncBundledSkills({
    bundledSkillsDir,
    localSkillsRoot
  });
  const skillLoadWarnings = [...bundledSync.warnings];
  const effectiveMcpServers = options.projectConfigTrust === "trusted" ? (options.mcpServers ?? {}) : {};
  const loadedMcpServers = await loadMcpServers({
    servers: effectiveMcpServers
  });

  for (const server of loadedMcpServers) {
    for (const tool of server.tools) {
      toolRegistry.register(tool);
    }
  }
  // Load skills from three sources with explicit priority:
  // 1. local/        -> sourceKind: "local"    (highest priority)
  // 2. packs/        -> sourceKind: "external"  (lowest priority)
  // 3. everything else -> sourceKind: "bundled" (middle priority)
  const localUserRoot = join(localSkillsRoot, "local");
  const packsRoot = join(localSkillsRoot, "packs");

  // external: pack-materialized skills
  const packsLoaded = await loadSkillsFromDirectory(packsRoot, {
    sourceKind: "external",
    sourceRoot: packsRoot
  }).catch(() => ({ skills: [], errors: [] }));
  skillLoadWarnings.push(...packsLoaded.errors.map((error) => error.message));
  for (const skill of packsLoaded.skills) {
    skillRegistry.register(skill);
  }

  // bundled: synced built-in skills (excluding local/ and packs/)
  const bundledLoaded = await loadSkillsFromDirectory(localSkillsRoot, {
    sourceKind: "bundled",
    sourceRoot: localSkillsRoot,
    exclude: ["local", "packs"]
  }).catch(() => ({ skills: [], errors: [] }));
  skillLoadWarnings.push(...bundledLoaded.errors.map((error) => error.message));
  for (const skill of bundledLoaded.skills) {
    skillRegistry.register(skill);
  }

  // local: user-local skills (highest priority, loaded last to win conflicts)
  const localLoaded = await loadSkillsFromDirectory(localUserRoot, {
    sourceKind: "local",
    sourceRoot: localUserRoot
  }).catch(() => ({ skills: [], errors: [] }));
  skillLoadWarnings.push(...localLoaded.errors.map((error) => error.message));
  for (const skill of localLoaded.skills) {
    skillRegistry.register(skill);
  }

  for (const root of options.externalSkillRoots ?? []) {
    const loaded = await loadSkillsFromDirectory(root, {
      sourceKind: "external",
      sourceRoot: root
    }).catch(() => ({ skills: [], errors: [] }));
    skillLoadWarnings.push(...loaded.errors.map((error) => error.message));
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
    maxContentChars: options.webMaxContentChars,
    workspaceRoot,
    visionAnalyzer: (input, signal) => analyzeImageWithVision({
      workspaceRoot,
      allowedRoots: [channelMediaRoot],
      resolvedVisionRoute: visionRoute?.route,
      mainRoute,
      fallbackToMain: visionRoute?.fallbackToMain,
      providerExecutor: new ProviderExecutor({
        registry: providerRegistry,
        credentialPools: options.credentialPools
      })
    }, input, signal)
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
  for (const tool of createVoiceTools({
    audioCacheRoot,
    artifactStore,
    workspaceRoot,
    allowedRoots: [channelMediaRoot],
    tts: options.tts,
    stt: options.stt,
    fetch: options.voiceFetch
  })) {
    toolRegistry.register(tool);
  }
  for (const tool of createImageGenerationTools({
    imageCacheRoot,
    artifactStore,
    imageGen: options.imageGen,
    fetch: options.imageGenerationFetch
  })) {
    toolRegistry.register(tool);
  }
  for (const tool of createVisionTools({
    workspaceRoot,
    allowedRoots: [channelMediaRoot],
    resolvedVisionRoute: visionRoute?.route,
    mainRoute,
    fallbackToMain: visionRoute?.fallbackToMain,
    providerExecutor: new ProviderExecutor({
      registry: providerRegistry,
      credentialPools: options.credentialPools
    })
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
    projectConfigPath: options.projectConfigPath,
    projectConfigTrust: options.projectConfigTrust
  })) {
    toolRegistry.register(tool);
  }
  if (options.disableCronTools !== true) {
    for (const tool of createCronTools({ store: cronStore })) {
      toolRegistry.register(tool);
    }
  }
  toolRegistry.register(createMemoryTool(memoryStore));
  const browserAvailable = await browserBackend.isAvailable();
  const toolAvailability = await toolRegistry.snapshot();
  const skillEvolutionStore = new SkillEvolutionStore({
    usagePath: join(localSkillsRoot, ".usage.json"),
    evolutionRoot: join(localSkillsRoot, ".evolution")
  });
  const changeManifestStore = new ChangeManifestStore({
    root: join(localSkillsRoot, ".evolution", "manifests")
  });
  const skillUsageByName = new Map((await skillEvolutionStore.usage()).map((record) => [record.skillName, record]));
  const skillVisibilityContext = createSkillVisibilityContext({
    availableTools: toolAvailability.available,
    browserAvailable,
    telegramReady: options.telegramReady === true,
    webEnabled: options.enableWebNetwork === true,
    platform: options.currentPlatform ?? process.platform
  });
  const sessionSkillRegistry = new SkillRegistry();
  for (const skill of skillRegistry.list()) {
    if (evaluateSkillVisibility(skill, {
      ...skillVisibilityContext,
      lifecycleState: skillUsageByName.get(skill.name)?.state
    }).visible) {
      sessionSkillRegistry.register(skill);
    }
  }
  const sessionSkillCatalog = sessionSkillRegistry.catalog();
  for (const tool of createSkillTools({
    registry: skillRegistry,
    visibleRegistry: sessionSkillRegistry,
    localSkillsRoot,
    bundledSkillsRoot: bundledSkillsDir,
    skillEvolutionStore,
    changeManifestStore
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
  for (const tool of createKnowledgeMemoryTools(
    memoryProvider instanceof LocalMemoryProvider ? memoryProvider.inspector : undefined
  )) {
    toolRegistry.register(tool);
  }
  for (const tool of createKnowledgeCodeTools(workspaceRoot)) {
    toolRegistry.register(tool);
  }
  const skillLearningManager = new SkillLearningManager({
    autonomy: options.skillAutonomy ?? "suggest",
    registry: skillRegistry,
    localSkillsRoot,
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
  const configuredSecurityMode = options.securityMode ?? "adaptive";
  let activeSecurityMode: SecurityApprovalMode = configuredSecurityMode;
  const effectiveSecurityAssessor = options.securityAssessor === undefined
    ? undefined
    : {
      ...options.securityAssessor,
      provider: options.securityAssessor.provider ?? approvalRoute?.route?.provider,
      model: options.securityAssessor.model ?? approvalRoute?.route?.id,
      route: options.securityAssessor.route ?? approvalRoute?.route
    };
  const baseSecurityPolicyForActiveMode = () => options.securityPolicy ?? createSecurityPolicyForMode(activeSecurityMode, {
    assessor: effectiveSecurityAssessor === undefined
      ? undefined
      : {
        ...effectiveSecurityAssessor,
        providerExecutor: effectiveSecurityAssessor.providerExecutor ?? providerExecutor,
        sessionId
      }
  });
  const securityPolicy: SecurityPolicy = {
    decide(request: SecurityRequest) {
      return baseSecurityPolicyForActiveMode().decide(request);
    },
    async assess(request: SecurityRequest) {
      const basePolicy = baseSecurityPolicyForActiveMode();

      if (options.approvalController === undefined) {
        return await basePolicy.assess?.(request) ?? {
          decision: basePolicy.decide(request),
          mode: activeSecurityMode,
          reason: "Decided by the active security policy.",
          risk: "medium"
        };
      }

      return await options.approvalController.assess(basePolicy, request, {
          workspaceRoot,
          profileId,
          sessionId,
          mode: activeSecurityMode
        });
    }
  };
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
  const providerToolAvailability = await toolRegistry.snapshot();

  // Remove tools from disabled toolsets (e.g. cron recursion guard)
  if (options.disabledToolsets !== undefined && options.disabledToolsets.length > 0) {
    for (const tool of providerToolAvailability.available) {
      if (tool.toolsets?.some((ts) => options.disabledToolsets!.includes(ts))) {
        toolRegistry.unregister(tool.name);
      }
    }
  }

  const providerToolSchemaCatalog = buildProviderToolSchemaCatalog({
    tools: providerToolAvailability.available
      .filter((t) => !options.disabledToolsets?.some((dt) => t.toolsets?.includes(dt)))
  });
  const toolCallPlanner = new ToolCallPlanner({
    registry: toolRegistry,
    aliases: providerToolSchemaCatalog.aliases
  });

  const runRecorder = new RunRecorder({
    sessionDb,
    sessionId,
    trajectoryRecorder,
    profileId,
    skillEvolutionStore,
    memoryProvider
  });

  const toolPlanRunner = new ToolPlanRunner({
    toolCallPlanner,
    toolExecutor,
    runRecorder,
    sessionId,
    maxConcurrentSafeTools: 4
  });

  const providerTurnLoop = new ProviderTurnLoop({
    providerExecutor,
    model: options.model,
    primaryModelRoute: options.primaryModelRoute,
    modelFallbackRoutes: options.modelFallbackRoutes,
    providerPreferences: {
      providerOrder: [options.model.provider]
    },
    sessionDb,
    sessionId,
    trajectoryRecorder,
    runRecorder,
    toolPlanRunner,
    soul: frozenMemorySnapshot.files.get("SOUL.md"),
    frozenMemory: {
      user: frozenMemorySnapshot.files.get("USER.md"),
      memory: frozenMemorySnapshot.files.get("MEMORY.md")
    },
    skillsIndex: sessionSkillCatalog,
    ui: options.ui,
    agentProfile: options.agentProfile,
    budgets: {
      maxProviderIterations: 6,
      maxProviderToolCalls: 20,
      maxRepeatedToolFailures: 3,
      maxProviderWallClockMs: 120_000
    }
  });

  const skillWorkflowExecutor = new SkillWorkflowExecutor({
    toolExecutor,
    sessionId,
    runRecorder
  });

  const nativeToolExecutor = new NativeToolExecutor({
    toolExecutor,
    runRecorder,
    sessionId
  });

  const agentLoop = new AgentLoop({
    runRecorder,
    runtimeRouter: new RuntimeRouter({
      intentRouter,
      skillConfig: options.skillConfig ?? {}
    }),
    toolPlanRunner,
    providerTurnLoop,
    skillWorkflowExecutor,
    nativeToolExecutor,
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
      providerOrder: [options.model.provider]
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
    skillLearningManager,
    skillEvolutionStore,
    ui: options.ui,
    agentProfile: options.agentProfile
  });

  // ─── TaskFlow v0.8 Integration ───
  let taskflow: Runtime["taskflow"] | undefined;

  // Only wire TaskFlow when using SQLiteSessionDB (real persistence required)
  try {
    if (sessionDb instanceof SQLiteSessionDB) {
      const taskflowStore = new SQLiteTaskFlowStore({ db: sessionDb.db });
      const lockService = new FlowLockService({ store: taskflowStore });
      const taskflowEngine = new TaskFlowEngine({ store: taskflowStore, lockService, ownerId: "runtime" });
      const processRegistry = new FlowProcessRegistry({ store: taskflowStore });
      const compactionService = new FlowCompactionService({
        store: taskflowStore,
        config: DEFAULT_COMPACTION_CONFIG
      });
      const dispatcher = new OperatorCommandDispatcher({
        engine: taskflowEngine,
        store: taskflowStore,
        processRegistry,
        compactionService
      });
      const adapter = new TaskFlowAgentLoopAdapter({
        agentLoop,
        store: taskflowStore,
        compactionService
      });

      // Run restart recovery on startup
      const restartRecovery = new FlowRestartRecovery({
        store: taskflowStore,
        lockService,
        now: () => new Date()
      });

      const recoveryResult = await restartRecovery.recover();
      if (recoveryResult.interrupted > 0 || recoveryResult.staleLocksReleased > 0) {
        // Non-critical diagnostic; do not write to stdout to avoid breaking CLI output contracts
        // eslint-disable-next-line no-console
        console.error(
          `[TaskFlow] Restart recovery: ${recoveryResult.interrupted} flows interrupted, ${recoveryResult.staleLocksReleased} stale locks recovered.`
        );
      }

      taskflow = {
        engine: taskflowEngine,
        store: taskflowStore,
        dispatcher,
        processRegistry,
        compactionService,
        adapter,
        activeFlowId: null,
        setActiveFlowId(flowId: string | null) {
          this.activeFlowId = flowId;
        },
        async recoverFromRestart() {
          const result = await restartRecovery.recover();
          return {
            interruptedFlows: result.interrupted,
            recoveredLocks: result.staleLocksReleased
          };
        }
      };
    }
  } catch {
    // TaskFlow integration is best-effort for v0.8. Do not block runtime creation.
    taskflow = undefined;
  }

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

      // If an active TaskFlow is set, route through the adapter
      if (taskflow?.activeFlowId) {
        const flow = await taskflow.store.getFlow(taskflow.activeFlowId);
        if (flow && flow.status === "running") {
          const steps = await taskflow.store.listSteps(flow.id);
          const activeStep = steps.find((s) => s.status === "running");
          const turnResult = await taskflow.adapter.runTurn({
            flow,
            step: activeStep,
            text: input.text,
            channel: input.channel,
            signal: input.signal,
            onEvent: input.onEvent
          });
          return turnResult.response;
        }
      }

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
    async verifyImageGeneration(input = {}) {
      return await verifyImageGeneration({
        imageGen: options.imageGen ?? defaultImageGenerationConfig(),
        telegramReady: options.telegramReady,
        homeDir: options.homeDir,
        workspaceRoot,
        fetch: options.imageGenerationFetch,
        checkProvider: input.checkProvider
      });
    },
    async grantApproval(input) {
      await options.approvalController?.grant({
        workspaceRoot,
        profileId,
        sessionId,
        toolName: input.toolName,
        riskClass: input.riskClass,
        targetKey: input.targetKey,
        targetSummary: input.targetSummary,
        scope: input.scope
      });
    },
    async inspectApprovals() {
      return await options.approvalController?.inspect({
        workspaceRoot,
        profileId,
        sessionId
      }) ?? {
        session: [],
        persistent: []
      };
    },
    async revokeApproval(id) {
      return await options.approvalController?.revokePersistent({
        id,
        workspaceRoot,
        profileId
      }) ?? false;
    },
    securityMode() {
      return activeSecurityMode;
    },
    toggleYoloMode() {
      const enabled = activeSecurityMode !== "open";
      activeSecurityMode = enabled
        ? "open"
        : configuredSecurityMode === "open" ? "adaptive" : configuredSecurityMode;

      return {
        enabled,
        mode: activeSecurityMode
      };
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
      if (disposed) {
        return;
      }
      disposed = true;
      await Promise.all(loadedMcpServers.map((server) => server.stop().catch(() => undefined)));
      const closeSessionDb = closeSessionDbOnDispose
        ? (sessionDb as { close?: () => void | Promise<void> }).close
        : undefined;
      if (closeSessionDbOnDispose && typeof closeSessionDb === "function") {
        await closeSessionDb.call(sessionDb);
      }
    },
    describe() {
      return [
        `${options.theme.branding.responseLabel} is ready`,
        `model: ${options.model.provider}/${options.model.id}`,
        `security: ${activeSecurityMode}${activeSecurityMode === "open" ? " (YOLO)" : ""}`,
        `skills: ${sessionSkillCatalog.length} (${options.skillAutonomy ?? "suggest"})`,
        `tools: ${toolRegistry.list().length}`,
        `mcp: ${loadedMcpServers.filter((server) => server.snapshot.available).length}/${loadedMcpServers.length}`,
        skillLoadWarnings.length === 0 ? undefined : `skill load warnings: ${skillLoadWarnings.length}`,
        taskflow ? `taskflow: active (SQLite)` : undefined,
        "status: ready"
      ].filter((line) => line !== undefined).join("\n");
    },
    getStatus() {
      return buildStatusViewModel({
        agentName: options.theme.branding.responseLabel,
        model: { provider: options.model.provider, id: options.model.id },
        securityMode: `${activeSecurityMode}${activeSecurityMode === "open" ? " (YOLO)" : ""}`,
        skillCount: sessionSkillCatalog.length,
        skillAutonomy: options.skillAutonomy ?? "suggest",
        toolCount: toolRegistry.list().length,
        mcpActive: loadedMcpServers.filter((server) => server.snapshot.available).length,
        mcpTotal: loadedMcpServers.length,
        taskflowActive: taskflow !== undefined,
        warnings: skillLoadWarnings.map((message) =>
          buildWarningErrorViewModel({ severity: "warn", title: "Skill load", message })
        ),
      });
    },
    getModelInfo() {
      return buildKeyValueBlockViewModel({
        title: "Model",
        entries: [
          kv("provider", options.model.provider),
          kv("model", options.model.id),
          kv("context window", options.model.contextWindowTokens ?? "unknown"),
          kv("security mode", activeSecurityMode),
        ],
      });
    },
    getStartup() {
      return buildStartupViewModel({
        agentName: options.theme.branding.agentName,
        taglines: [
          options.theme.branding.taglinePrimary,
          options.theme.branding.taglineSecondary,
        ].filter((t) => t.length > 0),
        model: { provider: options.model.provider, id: options.model.id },
        readiness: skillLoadWarnings.length > 0 || loadedMcpServers.some((s) => !s.snapshot.available)
          ? "degraded"
          : "ready",
        warnings: skillLoadWarnings.map((message) =>
          buildWarningErrorViewModel({ severity: "warn", title: "Skill load", message })
        ),
      });
    },
    async getStartupReadiness() {
      const workspaceTrusted = await trustStore.isTrusted(workspaceRoot, { profileId });
      const verificationReport = await collectSetupVerificationReport({
        workspaceRoot,
        homeDir: options.homeDir,
        userConfigPath: options.userConfigPath,
        projectConfigPath: options.projectConfigPath,
        trustStorePath: options.trustStorePath,
        runtime: this as Runtime,
        projectConfigTrust: options.projectConfigTrust,
      });
      const versionStatus = options.homeDir !== undefined
        ? await readCachedUpdateStatus(options.homeDir)
        : "unknown";
      return collectStartupReadinessSnapshot({
        workspaceRoot,
        workspaceTrusted,
        verificationReport,
        model: { provider: options.model.provider, id: options.model.id },
        securityMode: activeSecurityMode,
        skillAutonomy: options.skillAutonomy,
        versionStatus,
      });
    },
    taskflow
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

  if (toolName.startsWith("browser.")) {
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
    ...fallbackKnownModelProfiles
  ]);

  for (const provider of new Set(catalogModels.map((model) => model.provider))) {
    const models = catalogModels.filter((model) => model.provider === provider);

    if (isOpenAICompatibleProvider(provider)) {
      registry.register(createOpenAICompatibleProvider({
        id: provider,
        endpoint: {
          baseUrl: getDefaultBaseUrl(provider),
          apiKey: provider === "local"
            ? { kind: "none" }
            : { kind: "env", name: getDefaultApiKeyEnv(provider) }
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
