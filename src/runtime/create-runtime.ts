import { existsSync } from "node:fs";
import { join } from "node:path";
import type { AuxiliaryModelConfig, ModelProfile, ResolvedModelRoute } from "../contracts/provider.js";
import type { BrowserBackend } from "../contracts/browser.js";
import type { ExternalMemoryProvider, MemoryPromotionRecord, MemoryProvider } from "../contracts/memory.js";
import type { SkillCatalogEntry } from "../contracts/skill.js";
import type { RegisteredTool, ToolDefinition, ToolProvider, ToolsetName } from "../contracts/tool.js";
import type { RuntimeToolContext, SessionToolContext } from "../contracts/tool-context.js";
import { ArtifactStore } from "../artifacts/artifact-store.js";
import { createBrowserBackendFromConfig, type CdpFetchLike, type CdpWebSocketFactory } from "../browser/browser-backend.js";
import { createSupervisedLocalCdpBrowserBackend } from "../browser/supervised-local-cdp-backend.js";
import { BrowserSessionLifecycle, registerEmergencyCleanup } from "../browser/session-lifecycle.js";
import type { ResolvedTokens, TokenBranding } from "../contracts/ui-tokens.js";
import { resolveGlobalStateHome, resolveProfileStateHome } from "../config/profile-home.js";
import { normalizeMemoryConfig } from "../config/memory-config.js";
import { ContextReferenceExpander } from "../context/context-reference-expander.js";
import { ProjectContextLoader, renderProjectContext } from "../context/project-context-loader.js";
import { CronStore } from "../cron/cron-store.js";
import { DelegationManager } from "../delegation/delegation-manager.js";
import { MemoryFileCompactionService } from "../memory/memory-file-compaction-service.js";
import { MemoryIndex } from "../memory/memory-index.js";
import { MemoryIndexStore, resolveMemoryIndexStorePath } from "../memory/memory-index-store.js";
import { MemoryIndexSync } from "../memory/memory-index-sync.js";
import { MemoryPersistenceService } from "../memory/memory-persistence-service.js";
import { LocalMemoryRetrievalService } from "../memory/memory-retrieval-service.js";
import { MemoryStore } from "../memory/memory-store.js";
import { listSharedMemory, type SharedMemoryEntry } from "../memory/shared-memory.js";
import { LocalMemoryProvider } from "../memory/local-memory-provider.js";
import { MemoryPromptContextBuilder } from "../memory/memory-prompt-context-builder.js";
import { MemoryRecallOrchestrator } from "../memory/memory-recall-orchestrator.js";
import { createExternalMemoryProvidersFromConfig } from "../memory/external-memory-provider.js";
import { MemoryPromotionStore } from "../memory/memory-promotion-store.js";
import { normalizeExternalMemoryConfig, normalizeSessionCompressionConfig, type AgentProfileMode, type AgentResponseLanguage, type LoadedRuntimeConfig, type MCPServerConfig, type UiFlavor, type UiLanguage } from "../config/runtime-config.js";
import { loadMcpServers, type MCPServerSnapshot } from "../mcp/mcp-tools.js";
import { ProcessManager } from "../process/process-manager.js";
import { resolveAuxiliaryModelRoute } from "../providers/auxiliary-model-resolver.js";
import { createCatalogProvider } from "../providers/catalog-provider.js";
import { fallbackKnownModelProfiles, inferModelProfile } from "../providers/model-catalog.js";
import { createOpenAICompatibleProvider } from "../providers/openai-compatible-provider.js";
import { createOpenAIResponsesProvider } from "../providers/openai-responses-provider.js";
import { ProviderRegistry } from "../providers/provider-registry.js";
import { getDefaultApiKeyEnv, getProviderMetadata } from "../providers/provider-metadata.js";
import { capabilityFirstDefaults } from "../contracts/security.js";
import type { SecurityApprovalMode, SecurityPolicy, SecurityRequest } from "../contracts/security.js";
import type { SessionDB } from "../contracts/session.js";
import type { TrajectoryStore } from "../contracts/trajectory-store.js";
import { InMemorySessionDB } from "../session/in-memory-session-db.js";
import { SQLiteSessionDB } from "../session/sqlite-session-db.js";
import { SessionRecallService, type SessionRecallResult } from "../session/session-recall-service.js";
import { ProviderExecutor } from "../providers/provider-executor.js";
import { SessionCompressionService, type CompactResult } from "../prompt/session-compression-service.js";
import { WorkspaceTrustStore } from "../security/workspace-trust-store.js";
import { createSecurityPolicyForMode } from "../security/security-policy-factory.js";
import { type ApprovalScope, type PersistedWorkspaceApprovalGrant, type SmartApprovalAssessorRuntimeConfig, type WorkspaceApprovalController } from "../security/workspace-approval-controller.js";
import { loadSkillsFromDirectory } from "../skills/skill-loader.js";
import { SkillRegistry } from "../skills/skill-registry.js";
import { SkillEvolutionStore } from "../skills/skill-evolution.js";
import { ChangeManifestStore } from "../skills/change-manifest-store.js";
import { SkillLearningManager, type SkillAutonomy } from "../skills/skill-learning.js";
import { evaluateSkillVisibility } from "../skills/skill-visibility.js";

// TaskFlow v0.8 imports
import { SQLiteTaskFlowStore } from "../taskflow/sqlite-taskflow-store.js";
import { FlowLockService } from "../taskflow/flow-lock-service.js";
import { TaskFlowEngine } from "../taskflow/taskflow-engine.js";
import { OperatorCommandDispatcher } from "../taskflow/operator-command-dispatcher.js";
import { FlowProcessRegistry } from "../taskflow/flow-process-registry.js";
import { FlowCompactionService, DEFAULT_COMPACTION_CONFIG } from "../taskflow/flow-compaction-service.js";
import { FlowRestartRecovery } from "../taskflow/flow-restart-recovery.js";
import { TaskFlowAgentLoopAdapter } from "../taskflow/taskflow-agent-loop-adapter.js";

import type { ImageGenerationFetchLike } from "../tools/image-generation-tools.js";
import { defaultImageGenerationConfig, verifyImageGeneration, type ImageGenerationVerification } from "../tools/image-generation-verify.js";
import { transcribeAudioFile, type VoiceFetchLike } from "../tools/voice-tools.js";
import type { FasterWhisperWorker } from "../tools/stt-local-whisper.js";
import { isFasterWhisperConfig } from "../tools/stt-providers.js";
import { ManagedFasterWhisperWorker } from "../python-env/managed-faster-whisper-worker.js";
import { ToolExecutor } from "../tools/tool-executor.js";
import { ToolRegistry } from "../tools/tool-registry.js";
import { toolRegistrationPlan, type ToolRegistrationPhase } from "../tools/index.js";
import type { FetchLike as WebFetchLike } from "../tools/web-tools.js";
import type { WorkspaceFsAdapter } from "../tools/workspace-tools.js";
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
import { createSessionRuntimeContext } from "./session-runtime-context.js";
import { buildStatusViewModel, buildKeyValueBlockViewModel, kv, buildWarningErrorViewModel, buildStartupViewModel } from "../ui/view-models/builders.js";
import { collectStartupReadinessSnapshot, type StartupReadinessSnapshot } from "./startup-readiness.js";
import { collectSetupVerificationReport } from "../setup/verification.js";
import { readCachedUpdateInfo } from "../lifecycle/update-engine.js";
import { detectInstallMethod } from "../lifecycle/install-method.js";
import { buildStartupUpdateHint } from "../lifecycle/startup-update.js";
import { createSessionId } from "../session/session-id.js";

export type RuntimeOptions = {
  tokens: ResolvedTokens;
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
  memoryProvider?: MemoryProvider;
  memory?: LoadedRuntimeConfig["memory"];
  externalMemory?: LoadedRuntimeConfig["externalMemory"];
  externalMemoryProviders?: ExternalMemoryProvider[];
  userMemoryRoot?: string;
  projectMemoryRoot?: string;
  auxiliaryModels?: AuxiliaryModelConfig;
  compression?: LoadedRuntimeConfig["compression"];
  homeDir?: string;
  workspaceTrusted?: boolean;
  webFetch?: WebFetchLike;
  cdpFetch?: CdpFetchLike;
  cdpWebSocketFactory?: CdpWebSocketFactory;
  browserBackend?: BrowserBackend;
  browser?: {
    backend: "local-cdp" | "browserbase" | "firecrawl" | "camofox" | "mock" | "unconfigured";
    cloudProvider?: string;
    cdpUrl?: string;
    launchCommand?: string;
    launchExecutable?: string;
    launchArgs?: string[];
    chromeFlags?: string[];
    autoLaunch: boolean;
    supervised?: boolean;
    hybridRouting?: boolean;
    cloudFallback?: boolean;
    cloudSpendApproved?: "pending" | boolean;
    summarizeSnapshots?: LoadedRuntimeConfig["browser"]["summarizeSnapshots"];
    snapshotSummarizeThreshold?: LoadedRuntimeConfig["browser"]["snapshotSummarizeThreshold"];
  };
  tts?: LoadedRuntimeConfig["tts"];
  stt?: LoadedRuntimeConfig["stt"];
  voiceFetch?: VoiceFetchLike;
  localWhisper?: FasterWhisperWorker;
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
  webConfig?: Pick<LoadedRuntimeConfig["web"], "backend" | "searchBackend" | "extractBackend" | "crawlBackend">;
  securityConfig?: Pick<LoadedRuntimeConfig["security"], "allowPrivateUrls" | "websiteBlocklist">;
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

type RuntimeBranding = Pick<
  TokenBranding,
  "agentName" | "responseLabel" | "taglinePrimary" | "taglineSecondary"
>;

function resolveRuntimeTokens(options: RuntimeOptions): ResolvedTokens {
  if (options.tokens !== undefined) {
    return options.tokens;
  }
  throw new TypeError("createRuntime requires tokens.");
}

function resolveRuntimeBranding(options: RuntimeOptions): RuntimeBranding {
  return resolveRuntimeTokens(options).contract.branding;
}

function buildRuntimeToolContext(input: RuntimeToolContext): RuntimeToolContext {
  return {
    workspaceRoot: input.workspaceRoot,
    homeDir: input.homeDir,
    profileId: input.profileId,
    cronStore: input.cronStore,
    trustStore: input.trustStore,
    disableCronTools: input.disableCronTools
  };
}

function buildPreSkillVisibilityToolContext(input: SessionToolContext): SessionToolContext {
  return {
    workspaceRoot: input.workspaceRoot,
    profileId: input.profileId,
    sessionId: input.sessionId,
    currentSessionId: input.currentSessionId,
    homeDir: input.homeDir,
    channelMediaRoot: input.channelMediaRoot,
    audioCacheRoot: input.audioCacheRoot,
    imageCacheRoot: input.imageCacheRoot,
    browserBackend: input.browserBackend,
    browserConfig: input.browserConfig,
    mainRoute: input.mainRoute,
    visionRoute: input.visionRoute,
    compressionRoute: input.compressionRoute,
    providerRegistry: input.providerRegistry,
    providerExecutor: input.providerExecutor,
    processManager: input.processManager,
    artifactStore: input.artifactStore,
    sessionDb: input.sessionDb,
    trajectoryRecorder: input.trajectoryRecorder,
    memoryStore: input.memoryStore,
    memoryPersistenceService: input.memoryPersistenceService,
    memoryPersistencePaths: input.memoryPersistencePaths,
    memoryIndexSync: input.memoryIndexSync,
    memoryRetrievalService: input.memoryRetrievalService,
    memoryFileCompactionService: input.memoryFileCompactionService,
    workspaceFsAdapter: input.workspaceFsAdapter,
    webFetch: input.webFetch,
    enableWebNetwork: input.enableWebNetwork,
    webMaxContentChars: input.webMaxContentChars,
    webConfig: input.webConfig,
    securityConfig: input.securityConfig,
    voiceFetch: input.voiceFetch,
    localWhisper: input.localWhisper,
    tts: input.tts,
    stt: input.stt,
    imageGen: input.imageGen,
    imageGenerationFetch: input.imageGenerationFetch,
    externalMemory: input.externalMemory,
    externalMemoryProviders: input.externalMemoryProviders
  };
}

function buildPostSkillVisibilityToolContext(input: SessionToolContext): SessionToolContext {
  return {
    workspaceRoot: input.workspaceRoot,
    profileId: input.profileId,
    sessionId: input.sessionId,
    currentSessionId: input.currentSessionId,
    skillRegistry: input.skillRegistry,
    sessionSkillRegistry: input.sessionSkillRegistry,
    localSkillsRoot: input.localSkillsRoot,
    bundledSkillsRoot: input.bundledSkillsRoot,
    skillEvolutionStore: input.skillEvolutionStore,
    changeManifestStore: input.changeManifestStore
  };
}

function buildPostMemoryProviderToolContext(input: SessionToolContext): SessionToolContext {
  return {
    workspaceRoot: input.workspaceRoot,
    profileId: input.profileId,
    sessionId: input.sessionId,
    currentSessionId: input.currentSessionId,
    memoryInspector: input.memoryInspector,
    memoryRetrievalService: input.memoryRetrievalService
  };
}

function buildPostToolExecutorToolContext(input: SessionToolContext): SessionToolContext {
  return {
    workspaceRoot: input.workspaceRoot,
    profileId: input.profileId,
    sessionId: input.sessionId,
    currentSessionId: input.currentSessionId,
    toolExecutor: input.toolExecutor,
    delegationManager: input.delegationManager,
    sessionDb: input.sessionDb,
    trajectoryRecorder: input.trajectoryRecorder,
    trustedWorkspace: input.trustedWorkspace
  };
}

function registerToolRegistrationPhase(input: {
  registry: ToolRegistry;
  phase: ToolRegistrationPhase;
  runtimeCtx: RuntimeToolContext;
  sessionCtx?: SessionToolContext;
}): void {
  for (const entry of toolRegistrationPlan) {
    if (entry.phase !== input.phase) {
      continue;
    }
    for (const tool of createToolsForProvider(entry.provider, input.runtimeCtx, input.sessionCtx)) {
      input.registry.register(tool);
    }
  }
}

function createToolsForProvider(
  provider: ToolProvider,
  runtimeCtx: RuntimeToolContext,
  sessionCtx: SessionToolContext | undefined
): readonly RegisteredTool[] {
  switch (provider.kind) {
    case "static":
      return provider.tools;
    case "runtime":
      return provider.createTools(runtimeCtx);
    case "session":
      if (sessionCtx === undefined) {
        throw new TypeError(`${provider.name}ToolProvider requires session context.`);
      }
      return provider.createTools(sessionCtx);
  }
}

function resolveRuntimeUiIdentity(options: RuntimeOptions): string {
  const tokens = resolveRuntimeTokens(options);
  return `${tokens.skin}-${tokens.theme}`;
}

export type Runtime = {
  describe(): string;
  getStatus(): import("../contracts/view-model.js").StatusViewModel;
  getModelInfo(): import("../contracts/view-model.js").KeyValueBlockViewModel;
  // Legacy compact startup hero. The interactive CLI composes the richer dashboard
  // from this identity data plus getStartupReadiness(), and keeps this as fallback.
  getStartup(): import("../contracts/view-model.js").StartupViewModel;
  getStartupReadiness(): Promise<StartupReadinessSnapshot>;
  tools(): import("../contracts/tool.js").ToolDefinition[];
  skills(): SkillCatalogEntry[];
  latestResumeNote(): Promise<string | undefined>;
  inspectMemoryPromotions(): Promise<MemoryPromotionRecord[]>;
  recallSession?(query: string): Promise<SessionRecallResult>;
  compactSession?(input?: {
    sessionId?: string;
    focusTopic?: string;
    preserveTranscript?: boolean;
    signal?: AbortSignal;
  }): Promise<CompactResult>;
  inspectMcpServers(): MCPServerSnapshot[];
  handle(input: AgentLoopInput): Promise<AgentLoopResponse>;
  executeTool?(input: {
    tool: string;
    toolInput: Record<string, unknown>;
    signal?: AbortSignal;
  }): Promise<import("../tools/tool-executor.js").ToolExecutionRecord | undefined>;
  transcribeAudio?(input: {
    path: string;
    language?: string;
    prompt?: string;
    model?: string;
    signal?: AbortSignal;
  }): Promise<Awaited<ReturnType<typeof transcribeAudioFile>>>;
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
  consumeSessionRotation?(): { originalSessionId: string; activeSessionId: string } | undefined;

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
  const runtimeBranding = resolveRuntimeBranding(options);
  const runtimeUiIdentity = resolveRuntimeUiIdentity(options);
  const toolRegistry = new ToolRegistry();
  const skillRegistry = new SkillRegistry();
  const memoryStore = new MemoryStore();
  const artifactStore = new ArtifactStore();
  const profileId = options.profileId ?? "default";
  const globalPaths = resolveGlobalStateHome({ homeDir: options.homeDir });
  const profilePaths = resolveProfileStateHome({ homeDir: options.homeDir, profileId });
  const sessionId = options.sessionId ?? createSessionId();
  const sessionRuntimeContext = createSessionRuntimeContext(sessionId);
  let observedRuntimeSessionId = sessionId;
  const sessionDb = options.sessionDb ?? new InMemorySessionDB();
  const closeSessionDbOnDispose = options.closeSessionDbOnDispose ?? true;
  const workspaceRoot = options.workspaceRoot ?? process.cwd();
  const localSkillsRoot = options.localSkillsRoot ?? profilePaths.skillsPath;
  const profileMemoryRoot = profilePaths.profileRoot;
  const memoryPersistenceService = new MemoryPersistenceService();
  const memoryPersistencePaths = {
    "USER.md": profilePaths.userMdPath,
    "MEMORY.md": profilePaths.memoryMdPath,
    "SOUL.md": profilePaths.soulMdPath
  };
  const memoryConfig = options.memory ?? normalizeMemoryConfig(undefined);
  const memoryIndexPath = resolveMemoryIndexStorePath({ homeDir: options.homeDir, profileId });
  const memoryIndexEnabled = memoryConfig.index.enabled === true;
  const memoryIndexFileMissingAtStartup = !existsSync(memoryIndexPath);
  const memoryIndexStore = memoryIndexEnabled
    ? new MemoryIndexStore({ path: memoryIndexPath })
    : undefined;
  const memoryIndex = memoryIndexStore === undefined
    ? undefined
    : new MemoryIndex({ store: memoryIndexStore });
  const memoryIndexSync = memoryIndexStore === undefined || memoryIndex === undefined
    ? undefined
    : new MemoryIndexSync({
        index: memoryIndex,
        store: memoryIndexStore,
        profileId,
        homeDir: options.homeDir,
        config: memoryConfig,
        indexFileMissingAtStartup: memoryIndexFileMissingAtStartup
      });
  const memoryRetrievalService = new LocalMemoryRetrievalService({
    index: memoryIndex,
    config: memoryConfig,
    homeDir: options.homeDir
  });
  const trustStore = options.trustStore ?? new WorkspaceTrustStore({ path: options.trustStorePath });
  const cronStore = options.cronStore ?? new CronStore({
    path: join(profilePaths.cronPath, "jobs.json"),
    outputRoot: join(profilePaths.cronPath, "output"),
  });
  const providerRegistry = options.providerRegistry ?? createDefaultProviderRegistry(options.model);
  const providerModels = await providerRegistry.listModels();
  const mainRoute: ResolvedModelRoute = options.primaryModelRoute ?? {
    provider: options.model.provider,
    id: options.model.id,
    profile: options.model
  };
  const auxiliaryModels = options.auxiliaryModels ?? {};
  const assessorRoute = options.model.provider === "unconfigured"
    ? undefined
    : resolveAuxiliaryModelRoute("assessor", auxiliaryModels, {
      mainRoute,
      providerRegistry,
      providerModels
    });
  const visionRoute = options.model.provider === "unconfigured"
    ? undefined
    : resolveAuxiliaryModelRoute("vision", auxiliaryModels, {
      mainRoute,
      providerRegistry,
      providerModels
    });
  const memoryFileCompactionRoute = options.model.provider === "unconfigured"
    ? undefined
    : resolveAuxiliaryModelRoute("memory_compaction", auxiliaryModels, {
      mainRoute,
      providerRegistry,
      providerModels
    });
  const sessionSearchRoute = options.model.provider === "unconfigured"
    ? undefined
    : resolveAuxiliaryModelRoute("session_search", auxiliaryModels, {
      mainRoute,
      providerRegistry,
      providerModels
    });
  const compressionRoute = options.model.provider === "unconfigured"
    ? undefined
    : resolveAuxiliaryModelRoute("compression", auxiliaryModels, {
      mainRoute,
      providerRegistry,
      providerModels
    });
  const providerExecutor = new ProviderExecutor({
    registry: providerRegistry
  });
  const processManager = new ProcessManager({ workspaceRoot });
  const channelMediaRoot = profilePaths.channelMediaPath;
  const audioCacheRoot = profilePaths.audioCachePath;
  const imageCacheRoot = profilePaths.imageCachePath;
  const persistentHfHome = options.stt?.local?.fasterWhisper?.hfHome ?? join(globalPaths.stateRoot, "cache", "huggingface");
  const localWhisper = options.localWhisper ?? (options.stt !== undefined && isFasterWhisperConfig(options.stt)
    ? new ManagedFasterWhisperWorker({
        stateRoot: globalPaths.stateRoot,
        stt: options.stt,
        defaultHfHome: persistentHfHome
      })
    : undefined);
  let activeTrustedWorkspace = false;
  let disposed = false;
  const existingSession = await sessionDb.getSession(sessionId);

  if (existingSession !== undefined && existingSession.profileId !== profileId) {
    throw new Error(`Session ${sessionId} belongs to profile ${existingSession.profileId}, not ${profileId}.`);
  }

  if (existingSession === undefined) {
    await sessionDb.createSession({
      id: sessionId,
      profileId,
      title: "EstaCoda session",
      metadata: {
        workspaceRoot,
        ...(options.sessionMetadata ?? {})
      }
    });
  }

  const trajectoryRecorder = new TrajectoryRecorder({
    profileId,
    sessionId,
    modelId: options.model.id
  });

  const bundledSkillsDir = new URL("../../skills/official", import.meta.url).pathname;
  const skillLoadWarnings: string[] = [];
  const effectiveMcpServers = options.workspaceTrusted === true ? (options.mcpServers ?? {}) : {};
  const loadedMcpServers = await loadMcpServers({
    servers: effectiveMcpServers
  });

  for (const server of loadedMcpServers) {
    for (const tool of server.tools) {
      toolRegistry.register(tool);
    }
  }
  // Load skills from explicit profile-local and package sources:
  // 1. packs/ under the selected profile (external, lowest priority)
  // 2. package bundled skills (middle priority)
  // 3. profiles/<id>/skills/ direct directories (local, highest priority)
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

  // bundled: built-in package skills
  const bundledLoaded = await loadSkillsFromDirectory(bundledSkillsDir, {
    sourceKind: "bundled",
    sourceRoot: bundledSkillsDir
  }).catch(() => ({ skills: [], errors: [] }));
  skillLoadWarnings.push(...bundledLoaded.errors.map((error) => error.message));
  for (const skill of bundledLoaded.skills) {
    skillRegistry.register(skill);
  }

  // local: selected profile skills (highest priority, loaded last to win conflicts)
  const localLoaded = await loadSkillsFromDirectory(localSkillsRoot, {
    sourceKind: "local",
    sourceRoot: localSkillsRoot,
    exclude: ["packs"]
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
  const supervisedLocalCdp = options.browserBackend === undefined
    && options.browser?.backend === "local-cdp"
    && options.browser.supervised !== false;
  let browserLifecycleBackend: (BrowserBackend & {
    closeSession?: (sessionId: string) => void | Promise<void>;
  }) | undefined;
  let ownedBrowserBackend: (BrowserBackend & {
    close?: () => void | Promise<void>;
  }) | undefined;
  const browserSessionLifecycle = supervisedLocalCdp
    ? new BrowserSessionLifecycle({
      onCleanup: async (sessionId) => {
        await browserLifecycleBackend?.closeSession?.(sessionId);
      }
    })
    : undefined;
  const unregisterBrowserEmergencyCleanup = browserSessionLifecycle === undefined
    ? undefined
    : registerEmergencyCleanup(browserSessionLifecycle);
  const browserBackend = options.browserBackend ?? (() => {
    const created = supervisedLocalCdp
      ? createSupervisedLocalCdpBrowserBackend({
        cdpUrl: options.browser?.cdpUrl,
        launchCommand: options.browser?.launchCommand,
        launchExecutable: options.browser?.launchExecutable,
        launchArgs: options.browser?.launchArgs,
        chromeFlags: options.browser?.chromeFlags,
        autoLaunch: options.browser?.autoLaunch,
        fetch: options.cdpFetch,
        webSocketFactory: options.cdpWebSocketFactory,
        securityConfig: options.securityConfig,
        lifecycle: browserSessionLifecycle
      })
      : createBrowserBackendFromConfig({
        backend: options.browser?.backend ?? "unconfigured",
        cloudProvider: options.browser?.cloudProvider,
        cdpUrl: options.browser?.cdpUrl,
        launchCommand: options.browser?.launchCommand,
        launchExecutable: options.browser?.launchExecutable,
        launchArgs: options.browser?.launchArgs,
        chromeFlags: options.browser?.chromeFlags,
        autoLaunch: options.browser?.autoLaunch,
        hybridRouting: options.browser?.hybridRouting,
        cloudFallback: options.browser?.cloudFallback,
        cloudSpendApproved: options.browser?.cloudSpendApproved,
        fetch: options.cdpFetch,
        webSocketFactory: options.cdpWebSocketFactory,
        supervised: options.browser?.supervised,
        securityConfig: options.securityConfig
      });
    ownedBrowserBackend = created as BrowserBackend & {
      close?: () => void | Promise<void>;
    };
    return created;
  })();
  browserLifecycleBackend = browserBackend as BrowserBackend & {
    closeSession?: (sessionId: string) => void | Promise<void>;
  };
  const externalMemoryConfig = normalizeExternalMemoryConfig(options.externalMemory);
  const externalMemoryProviders = [
    ...createExternalMemoryProvidersFromConfig(externalMemoryConfig, { profileRoot: profileMemoryRoot }),
    ...(options.externalMemoryProviders ?? [])
  ];
  const memoryFileCompactionService = new MemoryFileCompactionService({
    store: memoryStore,
    memoryRoot: profileMemoryRoot,
    route: memoryFileCompactionRoute,
    mainRoute,
    providerExecutor,
    trajectoryRecorder,
    sessionDb,
    sessionId
  });
  const runtimeToolContext = buildRuntimeToolContext({
    workspaceRoot,
    homeDir: options.homeDir,
    profileId,
    cronStore,
    trustStore,
    disableCronTools: options.disableCronTools
  });
  const preSkillVisibilityToolContext = buildPreSkillVisibilityToolContext({
    workspaceRoot,
    profileId,
    sessionId,
    currentSessionId: () => sessionRuntimeContext.currentSessionId(),
    homeDir: options.homeDir,
    channelMediaRoot,
    audioCacheRoot,
    imageCacheRoot,
    browserBackend,
    browserConfig: options.browser,
    mainRoute,
    visionRoute,
    compressionRoute,
    providerRegistry,
    providerExecutor,
    processManager,
    artifactStore,
    sessionDb,
    trajectoryRecorder,
    memoryStore,
    memoryPersistenceService,
    memoryPersistencePaths,
    memoryIndexSync,
    memoryRetrievalService,
    memoryFileCompactionService,
    workspaceFsAdapter: options.workspaceFsAdapter,
    webFetch: options.webFetch,
    enableWebNetwork: options.enableWebNetwork,
    webMaxContentChars: options.webMaxContentChars,
    webConfig: options.webConfig,
    securityConfig: options.securityConfig,
    voiceFetch: options.voiceFetch,
    localWhisper,
    tts: options.tts,
    stt: options.stt,
    imageGen: options.imageGen,
    imageGenerationFetch: options.imageGenerationFetch,
    externalMemory: externalMemoryConfig,
    externalMemoryProviders
  });
  registerToolRegistrationPhase({
    registry: toolRegistry,
    phase: "pre-skill-visibility",
    runtimeCtx: runtimeToolContext,
    sessionCtx: preSkillVisibilityToolContext
  });
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
  registerToolRegistrationPhase({
    registry: toolRegistry,
    phase: "post-skill-visibility",
    runtimeCtx: runtimeToolContext,
    sessionCtx: buildPostSkillVisibilityToolContext({
      workspaceRoot,
      profileId,
      sessionId,
      currentSessionId: () => sessionRuntimeContext.currentSessionId(),
      skillRegistry,
      sessionSkillRegistry,
      localSkillsRoot,
      bundledSkillsRoot: bundledSkillsDir,
      skillEvolutionStore,
      changeManifestStore
    })
  });

  const [userMemory, soulMemory, profileMemory] = await Promise.all([
    memoryPersistenceService.readFile({
      path: profilePaths.userMdPath,
      kind: "USER.md"
    }),
    memoryPersistenceService.readFile({
      path: profilePaths.soulMdPath,
      kind: "SOUL.md"
    }),
    memoryPersistenceService.readFile({
      path: profilePaths.memoryMdPath,
      kind: "MEMORY.md"
    })
  ]);
  const sharedMemoryContent = renderSharedMemory(await listSharedMemory({ homeDir: options.homeDir }));
  const skillLearningStorePath = join(workspaceRoot, ".estacoda", "skill-learning.json");
  if (sharedMemoryContent !== undefined) {
    memoryStore.write("SHARED.md", sharedMemoryContent);
  }
  if (userMemory !== undefined) {
    memoryStore.write("USER.md", userMemory);
  }
  if (soulMemory !== undefined) {
    memoryStore.write("SOUL.md", soulMemory);
  }
  if (profileMemory !== undefined) {
    memoryStore.write("MEMORY.md", profileMemory);
  }
  await memoryIndexSync?.backfillOnStartup();
  const memoryPromotionStore = new MemoryPromotionStore({
    path: profilePaths.promotionsPath,
    persistence: memoryPersistenceService
  });
  const memoryProvider = options.memoryProvider ?? new LocalMemoryProvider({
    store: memoryStore,
    saveRoots: {
      "USER.md": profileMemoryRoot,
      "MEMORY.md": profileMemoryRoot,
      "SOUL.md": profileMemoryRoot
    },
    promotionStore: memoryPromotionStore,
    persistence: memoryPersistenceService,
    memoryIndexSync,
    memorySearchService: memoryRetrievalService,
    profileId
  });
  registerToolRegistrationPhase({
    registry: toolRegistry,
    phase: "post-memory-provider",
    runtimeCtx: runtimeToolContext,
    sessionCtx: buildPostMemoryProviderToolContext({
      workspaceRoot,
      profileId,
      sessionId,
      currentSessionId: () => sessionRuntimeContext.currentSessionId(),
      memoryInspector: memoryProvider instanceof LocalMemoryProvider ? memoryProvider.inspector : undefined,
      memoryRetrievalService
    })
  });
  const skillLearningManager = new SkillLearningManager({
    autonomy: options.skillAutonomy ?? "suggest",
    registry: skillRegistry,
    localSkillsRoot,
    storePath: skillLearningStorePath,
    sessionDb
  });
  const memoryPromptContextBuilder = new MemoryPromptContextBuilder({
    store: memoryStore,
    promotionStore: memoryPromotionStore
  });
  const memoryPromptContext = await memoryPromptContextBuilder.build();
  const sessionRecallService = new SessionRecallService({
    sessionDb,
    profileId,
    workspaceRoot,
    excludeSessionIds: () => [sessionRuntimeContext.currentSessionId()],
    route: sessionSearchRoute,
    mainRoute,
    providerExecutor
  });
  const compressionConfig = normalizeSessionCompressionConfig(options.compression);
  const sessionCompressionService = new SessionCompressionService({
    sessionDb,
    config: compressionConfig,
    route: compressionRoute,
    mainRoute,
    providerExecutor
  });
  const contextReferenceExpander = new ContextReferenceExpander({ workspaceRoot });
  const projectContext = await new ProjectContextLoader({ workspaceRoot }).load();
  const renderedProjectContext = renderProjectContext(projectContext);

  trajectoryRecorder.record("session-start", {
    theme: runtimeUiIdentity,
    model: options.model.id,
    profile: profileId,
    projectContextFiles: projectContext.files.map((file) => file.source)
  });

  await sessionDb.appendEvent(sessionId, {
    kind: "trajectory-linked",
    trajectoryId: trajectoryRecorder.snapshot().id
  });

  const intentRouter = new IntentRouter({ skillRegistry: sessionSkillRegistry, model: options.model });
  const configuredSecurityMode = options.securityMode ?? "adaptive";
  let activeSecurityMode: SecurityApprovalMode = configuredSecurityMode;
  const effectiveSecurityAssessor = options.securityAssessor === undefined
    ? undefined
    : {
      ...options.securityAssessor,
      provider: options.securityAssessor.provider ?? assessorRoute?.route?.provider,
      model: options.securityAssessor.model ?? assessorRoute?.route?.id,
      auxiliaryRoute: options.securityAssessor.auxiliaryRoute ?? assessorRoute,
      mainRoute: options.securityAssessor.mainRoute ?? mainRoute
    };
  const baseSecurityPolicyForActiveMode = () => options.securityPolicy ?? createSecurityPolicyForMode(activeSecurityMode, {
    assessor: effectiveSecurityAssessor === undefined
      ? undefined
      : {
        ...effectiveSecurityAssessor,
        providerExecutor: effectiveSecurityAssessor.providerExecutor ?? providerExecutor,
        sessionId: sessionRuntimeContext.currentSessionId()
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

      const smartApproval = effectiveSecurityAssessor?.enabled === true
        ? {
          enabled: true,
          assessorRoute: effectiveSecurityAssessor.auxiliaryRoute ?? assessorRoute,
          mainRoute,
          providerExecutor: effectiveSecurityAssessor.providerExecutor ?? providerExecutor,
          scopeKey: profileId
        } satisfies SmartApprovalAssessorRuntimeConfig
        : undefined;

      return await options.approvalController.assess(basePolicy, request, {
          workspaceRoot,
          sessionId: sessionRuntimeContext.currentSessionId(),
          mode: activeSecurityMode,
          smartApproval
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
  registerToolRegistrationPhase({
    registry: toolRegistry,
    phase: "post-tool-executor",
    runtimeCtx: runtimeToolContext,
    sessionCtx: buildPostToolExecutorToolContext({
      workspaceRoot,
      profileId,
      sessionId,
      currentSessionId: () => sessionRuntimeContext.currentSessionId(),
      toolExecutor,
      delegationManager,
      sessionDb,
      trajectoryRecorder,
      trustedWorkspace: async () => activeTrustedWorkspace || await trustStore.isTrusted(workspaceRoot)
    })
  });
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
    sessionRuntimeContext,
    trajectoryRecorder,
    trajectoryStore: hasTrajectoryStore(sessionDb) ? sessionDb : undefined,
    profileId,
    skillEvolutionStore,
    memoryProvider
  });
  const memoryRecallOrchestrator = new MemoryRecallOrchestrator({
    builder: memoryPromptContextBuilder,
    sessionRecallService,
    recorder: runRecorder,
    externalMemory: externalMemoryConfig,
    externalMemoryProviders,
    profileId,
    sessionId: () => sessionRuntimeContext.currentSessionId(),
    workspaceRoot
  });

  const toolPlanRunner = new ToolPlanRunner({
    toolCallPlanner,
    toolExecutor,
    runRecorder,
    sessionId,
    sessionRuntimeContext,
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
    sessionRuntimeContext,
    profileId,
    trajectoryRecorder,
    runRecorder,
    toolPlanRunner,
    soul: undefined,
    memoryPromptContext,
    skillsIndex: sessionSkillCatalog,
    ui: options.ui,
    agentProfile: options.agentProfile,
    budgets: {
      maxProviderIterations: 45,
      maxProviderToolCalls: 100,
      maxRepeatedToolFailures: 5,
      maxProviderWallClockMs: 300_000
    }
  });

  const skillWorkflowExecutor = new SkillWorkflowExecutor({
    toolExecutor,
    sessionId,
    sessionRuntimeContext,
    runRecorder
  });

  const nativeToolExecutor = new NativeToolExecutor({
    toolExecutor,
    runRecorder,
    sessionId,
    sessionRuntimeContext
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
    responseLabel: runtimeBranding.responseLabel,
    intentRouter,
    securityPolicy,
    trajectoryRecorder,
    sessionDb,
    sessionId,
    sessionRuntimeContext,
    profileId,
    toolExecutor,
    toolCallPlanner,
    memoryProvider,
    memoryPromptContext,
    memoryRecallOrchestrator,
    sessionCompressionService,
    compressionConfig,
    model: options.model,
    providerPreferences: {
      providerOrder: [options.model.provider]
    },
    contextReferenceExpander,
    projectContext,
    providerTools: providerToolSchemaCatalog.tools,
    soul: undefined,
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
      const taskflowStore = new SQLiteTaskFlowStore({ db: sessionDb.db, profileId });
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
    get sessionId() {
      return sessionRuntimeContext.currentSessionId();
    },
    consumeSessionRotation() {
      const activeSessionId = sessionRuntimeContext.currentSessionId();
      if (activeSessionId === observedRuntimeSessionId) {
        return undefined;
      }
      const originalSessionId = observedRuntimeSessionId;
      observedRuntimeSessionId = activeSessionId;
      return {
        originalSessionId,
        activeSessionId
      };
    },
    tools() {
      return toolRegistry.list();
    },
    skills() {
      return sessionSkillCatalog;
    },
    async latestResumeNote() {
      const events = await sessionDb.listEvents(sessionRuntimeContext.currentSessionId());
      const cancelled = [...events].reverse().find((event) => event.kind === "agent-cancelled" && event.resumeNote !== undefined);

      return cancelled?.kind === "agent-cancelled" ? cancelled.resumeNote : undefined;
    },
    async inspectMemoryPromotions() {
      return await memoryProvider.inspectPromotions?.() ?? [];
    },
    async recallSession(query) {
      return await sessionRecallService.recall(query);
    },
    async compactSession(input = {}) {
      const targetSessionId = input.sessionId ?? sessionRuntimeContext.currentSessionId();
      const targetSession = await sessionDb.getSession(targetSessionId);
      if (targetSession === undefined) {
        throw new Error(`Session not found: ${targetSessionId}`);
      }
      if (targetSession.profileId !== profileId) {
        throw new Error(`Session not found in active profile: ${targetSessionId}`);
      }
      return await sessionCompressionService.compactNow({
        profileId,
        sessionId: targetSessionId,
        focusTopic: input.focusTopic,
        preserveTranscript: input.preserveTranscript === true,
        signal: input.signal
      });
    },
    inspectMcpServers() {
      return loadedMcpServers.map((server) => structuredClone(server.snapshot));
    },
    async handle(input) {
      const trustedWorkspace = input.trustedWorkspace ?? await trustStore.isTrusted(workspaceRoot);
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
      const trustedWorkspace = await trustStore.isTrusted(workspaceRoot);
      activeTrustedWorkspace = trustedWorkspace;
      return await toolExecutor.executeTool({
        tool: input.tool,
        input: input.toolInput,
        trustedWorkspace,
        sessionId: sessionRuntimeContext.currentSessionId(),
        signal: input.signal
      });
    },
    async transcribeAudio(input) {
      return await transcribeAudioFile({
        path: input.path,
        language: input.language,
        prompt: input.prompt,
        model: input.model,
        stt: options.stt ?? { provider: "local" },
        fetch: options.voiceFetch,
        localWhisper,
        audioCacheRoot,
        tempRoot: join(profilePaths.tempPath, "audio"),
        signal: input.signal
      });
    },
    async verifyImageGeneration(input = {}) {
      return await verifyImageGeneration({
        imageGen: options.imageGen ?? defaultImageGenerationConfig(),
        telegramReady: options.telegramReady,
        homeDir: options.homeDir,
        imageCachePath: profilePaths.imageCachePath,
        workspaceRoot,
        fetch: options.imageGenerationFetch,
        checkProvider: input.checkProvider
      });
    },
    async grantApproval(input) {
      await options.approvalController?.grant({
        workspaceRoot,
        sessionId: sessionRuntimeContext.currentSessionId(),
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
        sessionId: sessionRuntimeContext.currentSessionId()
      }) ?? {
        session: [],
        persistent: []
      };
    },
    async revokeApproval(id) {
      return await options.approvalController?.revokePersistent({
        id,
        workspaceRoot
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
        label: "EstaCoda workspace"
      });
    },
    isWorkspaceTrusted() {
      return trustStore.isTrusted(workspaceRoot);
    },
    revokeWorkspaceTrust() {
      return trustStore.revoke(workspaceRoot);
    },
    async dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      unregisterBrowserEmergencyCleanup?.();
      browserSessionLifecycle?.stop();
      await browserSessionLifecycle?.cleanupAll();
      await ownedBrowserBackend?.close?.();
      await localWhisper?.dispose?.();
      await Promise.all(loadedMcpServers.map((server) => server.stop().catch(() => undefined)));
      memoryIndexSync?.dispose();
      const closeSessionDb = closeSessionDbOnDispose
        ? (sessionDb as { close?: () => void | Promise<void> }).close
        : undefined;
      if (closeSessionDbOnDispose && typeof closeSessionDb === "function") {
        await closeSessionDb.call(sessionDb);
      }
    },
    describe() {
      return [
        `${runtimeBranding.responseLabel} is ready`,
        `model: ${options.model.provider}/${options.model.id}`,
        `profile: ${options.profileId}`,
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
        agentName: runtimeBranding.responseLabel,
        model: { provider: options.model.provider, id: options.model.id },
        profileId: options.profileId,
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
      // Legacy compact startup hero used as the fallback when dashboard readiness
      // collection cannot complete during interactive session launch.
      return buildStartupViewModel({
        agentName: runtimeBranding.agentName,
        taglines: [
          runtimeBranding.taglinePrimary,
          runtimeBranding.taglineSecondary,
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
      const workspaceTrusted = await trustStore.isTrusted(workspaceRoot);
      const verificationReport = await collectSetupVerificationReport({
        workspaceRoot,
        homeDir: options.homeDir,
        profileId: options.profileId,
        trustStorePath: options.trustStorePath,
        runtime: this as Runtime,
      });
      const cachedUpdate = options.homeDir !== undefined
        ? await readCachedUpdateInfo(options.homeDir)
        : { versionStatus: "unknown" as const };
      const updateHint = cachedUpdate.versionStatus === "update-available"
        ? cachedUpdate.hint ?? await resolveCachedStartupUpdateHint(workspaceRoot, cachedUpdate.versionStatus)
        : undefined;
      return collectStartupReadinessSnapshot({
        workspaceRoot,
        workspaceTrusted,
        verificationReport,
        model: { provider: options.model.provider, id: options.model.id },
        securityMode: activeSecurityMode,
        skillAutonomy: options.skillAutonomy,
        versionStatus: cachedUpdate.versionStatus,
        updateHint,
      });
    },
    taskflow
  };
}

function hasTrajectoryStore(db: SessionDB): db is SessionDB & Pick<TrajectoryStore, "saveTrajectory"> {
  return typeof (db as { saveTrajectory?: unknown }).saveTrajectory === "function";
}

async function resolveCachedStartupUpdateHint(
  workspaceRoot: string,
  versionStatus: "update-available"
): Promise<string | undefined> {
  const installMethod = await detectInstallMethod({
    cwd: workspaceRoot,
    includeCwd: true,
    entrypointPath: process.argv[1],
    moduleUrl: import.meta.url
  }).catch(() => undefined);

  if (installMethod === undefined) {
    return undefined;
  }

  return buildStartupUpdateHint({
    installMethod,
    versionStatus
  });
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

/**
 * Default/scaffold provider registry construction.
 *
 * This is not a route-selection mechanism and must not be used to infer
 * executable routes from catalog presence alone.
 *
 * It must not create executable adapters with placeholder endpoints such as
 * `https://example.invalid/v1`.
 *
 * TODO(provider-cleanup): remove or shrink once all runtime/smoke/test callers
 * have explicit registry or route construction.
 */
export function createDefaultProviderRegistry(selectedModel: ModelProfile): ProviderRegistry {
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
      const metadata = getProviderMetadata(provider);
      if (!metadata.runnable || metadata.defaultBaseUrl === undefined) {
        registry.register(createCatalogProvider({
          id: provider,
          models
        }));
        continue;
      }

      if (metadata.apiMode === "openai_responses") {
        registry.register(createOpenAIResponsesProvider({
          id: provider,
          endpoint: {
            baseUrl: metadata.defaultBaseUrl,
            apiKey: provider === "local"
              ? { kind: "none" }
              : { kind: "env", name: getDefaultApiKeyEnv(provider) }
          },
          models
        }));
        continue;
      }

      registry.register(createOpenAICompatibleProvider({
        id: provider,
        endpoint: {
          baseUrl: metadata.defaultBaseUrl,
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

function renderSharedMemory(entries: SharedMemoryEntry[]): string | undefined {
  const sections = entries
    .filter((entry) => entry.content.trim().length > 0)
    .map((entry) => `## ${entry.key}\n${entry.content.trim()}`);

  return sections.length === 0 ? undefined : sections.join("\n\n");
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
