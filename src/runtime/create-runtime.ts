import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { AuxiliaryModelConfig, ModelProfile, ResolvedModelRoute } from "../contracts/provider.js";
import { deriveAgentEvolutionPolicy, type AgentEvolutionPolicy } from "../contracts/agent-evolution.js";
import type { BrowserBackend } from "../contracts/browser.js";
import type { DelegationConfig } from "../contracts/delegation.js";
import { DEFAULT_DELEGATION_CONFIG } from "../config/delegation-defaults.js";
import type { ExternalMemoryProvider, MemoryPromotionRecord, MemoryProvider } from "../contracts/memory.js";
import type { LoadedSkill, SkillCatalogEntry, SkillDefinition } from "../contracts/skill.js";
import type { ToolsetName } from "../contracts/tool.js";
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
import { DurableDelegationService } from "../delegation/durable-delegation-service.js";
import { FileStateTracker } from "../delegation/file-state-tracker.js";
import { SubagentRegistry, type OperatorSubagentStatus } from "../delegation/subagent-registry.js";
import { MemoryFileCompactionService } from "../memory/memory-file-compaction-service.js";
import { MemoryCurationService } from "../memory/memory-curation-service.js";
import { SQLiteMemoryCurationCoordinator } from "../memory/memory-curation-coordinator.js";
import { MemoryCurationStore, memoryCurationStorePath, type MemoryCurationTrigger } from "../memory/memory-curation-store.js";
import { MemoryIndex } from "../memory/memory-index.js";
import { MemoryIndexStore, resolveMemoryIndexStorePath } from "../memory/memory-index-store.js";
import { MemoryIndexSync } from "../memory/memory-index-sync.js";
import { MemoryMutationService } from "../memory/memory-mutation-service.js";
import { MemoryPersistenceService } from "../memory/memory-persistence-service.js";
import { LocalMemoryRetrievalService } from "../memory/memory-retrieval-service.js";
import { MemoryStore } from "../memory/memory-store.js";
import { listSharedMemory, renderSharedMemory } from "../memory/shared-memory.js";
import { LocalMemoryProvider } from "../memory/local-memory-provider.js";
import { MemoryPromptContextBuilder } from "../memory/memory-prompt-context-builder.js";
import { createExternalMemoryProvidersFromConfig } from "../memory/external-memory-provider.js";
import { MemoryPromotionStore } from "../memory/memory-promotion-store.js";
import { normalizeExternalMemoryConfig, normalizeSessionCompressionConfig, type AgentProfileMode, type AgentResponseLanguage, type EstaCodaConfig, type LoadedRuntimeConfig, type MCPServerConfig, type UiFlavor, type UiLanguage } from "../config/runtime-config.js";
import { loadMcpServers, type MCPServerSnapshot } from "../mcp/mcp-tools.js";
import { ProcessManager } from "../process/process-manager.js";
import { resolveAuxiliaryModelRoute } from "../providers/auxiliary-model-resolver.js";
import { createCatalogProvider } from "../providers/catalog-provider.js";
import { fallbackKnownModelProfiles, inferModelProfile } from "../providers/model-catalog.js";
import { createOpenAICompatibleProvider } from "../providers/openai-compatible-provider.js";
import { createOpenAIResponsesProvider } from "../providers/openai-responses-provider.js";
import { ProviderRegistry } from "../providers/provider-registry.js";
import { getDefaultApiKeyEnv, getProviderMetadata } from "../providers/provider-metadata.js";
import type { SecurityApprovalMode, SecurityPolicy, SecurityRequest } from "../contracts/security.js";
import type { SessionContextWindowUsage, SessionDB } from "../contracts/session.js";
import type { SessionCostSummary } from "../contracts/usage-cost.js";
import { InMemorySessionDB } from "../session/in-memory-session-db.js";
import { loadSessionContextWindowUsage } from "../session/session-context-window-usage.js";
import { loadSessionCostUsage } from "../session/session-cost-usage.js";
import { SQLiteSessionDB } from "../session/sqlite-session-db.js";
import {
  SessionFinalizationQueue,
  type SessionFinalizationJob,
  type SessionFinalizationReason,
} from "../session/session-finalization-queue.js";
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
import { availableToolsetsFromTools } from "../cron/cron-runtime-validation.js";
import { SQLiteTaskStore } from "../workflow/sqlite-task-store.js";
import { TaskResultService } from "../workflow/task-result-service.js";
import { TaskOperatorService, type TaskStatusProjection } from "../workflow/task-operator-service.js";
import { AgentStepExecutor } from "../workflow/agent-step-executor.js";
import { TaskApprovalService } from "../workflow/task-approval-service.js";
import { createTaskArtifactContentResolver } from "../workflow/task-artifact-content.js";
import { resolveTaskWorkspaceBinding } from "../workflow/task-workspace.js";

import type { ImageGenerationFetchLike } from "../tools/image-generation-tools.js";
import { defaultImageGenerationConfig, verifyImageGeneration, type ImageGenerationVerification } from "../tools/image-generation-verify.js";
import { transcribeAudioFile, type VoiceFetchLike } from "../tools/voice-tools.js";
import type { FasterWhisperWorker } from "../tools/stt-local-whisper.js";
import { isFasterWhisperConfig } from "../tools/stt-providers.js";
import { ManagedFasterWhisperWorker } from "../python-env/managed-faster-whisper-worker.js";
import type { FetchLike as WebFetchLike } from "../tools/web-tools.js";
import type { WorkspaceFsAdapter } from "../tools/workspace-tools.js";
import { TrajectoryRecorder } from "../trajectory/trajectory-recorder.js";
import type { AgentLoopInput, AgentLoopResponse } from "./agent-loop.js";
import { AgentLoopBuilder, type AgentLoopExecutionControls } from "./agent-loop-builder.js";
import { DefaultChildAgentLoopFactory } from "./agent-loop-factory.js";
import { createSessionRuntimeContext } from "./session-runtime-context.js";
import { buildStatusViewModel, buildKeyValueBlockViewModel, kv, buildWarningErrorViewModel, buildStartupViewModel, buildTableViewModel } from "../ui/view-models/builders.js";
import { collectStartupReadinessSnapshot, type StartupReadinessSnapshot } from "./startup-readiness.js";
import { collectSetupVerificationReport } from "../setup/verification.js";
import { readCachedUpdateInfo } from "../lifecycle/update-engine.js";
import { detectInstallMethod } from "../lifecycle/install-method.js";
import { buildStartupUpdateHint } from "../lifecycle/startup-update.js";
import { createSessionId } from "../session/session-id.js";
import { isTaskDeliveryDestination, type TaskDeliveryDestination, type TaskExecutionPreference, type TaskSource } from "../contracts/task.js";

export type TaskCreationOrigin = {
  source: Extract<TaskSource, "cli" | "gateway" | "runtime">;
  completionDestination?: TaskDeliveryDestination;
};

function normalizeTaskCreationOrigin(origin: TaskCreationOrigin | undefined): TaskCreationOrigin {
  if (origin === undefined) return { source: "cli" };
  if (origin.source !== "cli" && origin.source !== "gateway" && origin.source !== "runtime") {
    throw new Error("Task creation origin is invalid.");
  }
  if (origin.completionDestination === undefined) return { source: origin.source };
  if (!isTaskDeliveryDestination(origin.completionDestination)) {
    throw new Error("Task completion destination is invalid.");
  }
  return {
    source: origin.source,
    completionDestination: structuredClone(origin.completionDestination)
  };
}

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
  executionControls?: AgentLoopExecutionControls;
  localSkillsRoot?: string;
  externalSkillRoots?: string[];
  mcpServers?: Record<string, MCPServerConfig>;
  skillAutonomy?: SkillAutonomy;
  skillConfig?: Record<string, Record<string, unknown>>;
  trustStore?: WorkspaceTrustStore;
  trustStorePath?: string;
  providerRegistry?: ProviderRegistry;
  providerConfigs?: EstaCodaConfig["providers"];
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
  webConfig?: Pick<LoadedRuntimeConfig["web"], "backend" | "searchBackend" | "extractBackend" | "crawlBackend" | "brave">;
  securityConfig?: Pick<LoadedRuntimeConfig["security"], "allowPrivateUrls" | "websiteBlocklist">;
  securityPolicy?: SecurityPolicy;
  securityMode?: import("../contracts/security.js").SecurityApprovalMode;
  securityAssessor?: import("../security/security-policy-factory.js").SecurityAssessorRuntimeConfig;
  approvalController?: WorkspaceApprovalController;
  cronStore?: CronStore;
  disableCronTools?: boolean;
  disabledToolsets?: ToolsetName[];
  enabledToolsets?: ToolsetName[];
  delegationConfig?: DelegationConfig;
  workspaceFsAdapter?: WorkspaceFsAdapter;
  sessionMetadata?: Record<string, unknown>;
  /** Optional authorized origin for Tasks created outside the local CLI. */
  taskCreationOrigin?: TaskCreationOrigin;
  /** Process-level activation hook invoked after a durable Task graph is committed. */
  onTaskCreated?: (taskId: string) => Promise<void>;
  /** Process-local view of whether a compatible gateway can continue durable Tasks. */
  taskBackgroundContinuation?: TaskStatusProjection["backgroundContinuation"];
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

function resolveRuntimeUiIdentity(options: RuntimeOptions): string {
  const tokens = resolveRuntimeTokens(options);
  return `${tokens.skin}-${tokens.theme}`;
}

export type Runtime = {
  agentEvolutionPolicy(): AgentEvolutionPolicy;
  describe(): string;
  getStatus(): import("../contracts/view-model.js").StatusViewModel;
  getModelInfo(): import("../contracts/view-model.js").KeyValueBlockViewModel;
  // Legacy compact startup hero. The interactive CLI composes the richer dashboard
  // from this identity data plus getStartupReadiness(), and keeps this as fallback.
  getStartup(): import("../contracts/view-model.js").StartupViewModel;
  getStartupReadiness(): Promise<StartupReadinessSnapshot>;
  tools(): import("../contracts/tool.js").ToolDefinition[];
  skills(): SkillCatalogEntry[];
  resolveSkill?(name: string): LoadedSkill | SkillDefinition | undefined;
  latestResumeNote(): Promise<string | undefined>;
  currentContextWindowUsage?(): Promise<SessionContextWindowUsage | undefined>;
  currentSessionCost?(): Promise<SessionCostSummary | undefined>;
  inspectMemoryPromotions(): Promise<MemoryPromotionRecord[]>;
  recallSession?(query: string): Promise<SessionRecallResult>;
  compactSession?(input?: {
    sessionId?: string;
    focusTopic?: string;
    preserveTranscript?: boolean;
    signal?: AbortSignal;
  }): Promise<CompactResult>;
  auditMemoryCuration?(input: {
    trigger: MemoryCurationTrigger;
    sessionId?: string;
    minNewMessages?: number;
    signal?: AbortSignal;
  }): Promise<import("../memory/memory-curation-service.js").MemoryCurationCheckpointResult | undefined>;
  inspectMcpServers(): MCPServerSnapshot[];
  hasActiveSubagents?(parentSessionId: string): boolean;
  activeSubagents?(parentSessionId?: string): OperatorSubagentStatus;
  handle(input: AgentLoopInput): Promise<AgentLoopResponse>;
  executeTool?(input: {
    tool: string;
    toolInput: Record<string, unknown>;
    toolCallId?: string;
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
  enqueueSessionFinalization?(reason: SessionFinalizationReason): SessionFinalizationJob | undefined;
  dispose(): Promise<void>;
  sessionDb: SessionDB;
  sessionId: string;
  readonly trajectoryId: string | undefined;
  consumeSessionRotation?(): { originalSessionId: string; activeSessionId: string } | undefined;

  /** Available only for profile-backed runtimes that can host durable agent Steps. */
  taskAgentExecutor?: AgentStepExecutor;
  taskOperator?: TaskOperatorService;
  beginTask?(objective: string, options?: { executionPreference?: TaskExecutionPreference }): Promise<TaskStatusProjection>;
  /** Scopes Task provenance to one authorized surface invocation, including cached runtimes. */
  withTaskCreationOrigin?<T>(origin: TaskCreationOrigin, work: () => Promise<T>): Promise<T>;
};

export async function createRuntime(options: RuntimeOptions): Promise<Runtime> {
  const runtimeBranding = resolveRuntimeBranding(options);
  const runtimeUiIdentity = resolveRuntimeUiIdentity(options);
  const skillRegistry = new SkillRegistry();
  const memoryStore = new MemoryStore();
  const artifactStore = new ArtifactStore();
  const profileId = options.profileId ?? "default";
  const globalPaths = resolveGlobalStateHome({ homeDir: options.homeDir });
  const profilePaths = resolveProfileStateHome({ homeDir: options.homeDir, profileId });
  const sessionId = options.sessionId ?? createSessionId();
  const sessionRuntimeContext = createSessionRuntimeContext(sessionId);
  const defaultTaskCreationOrigin = normalizeTaskCreationOrigin(options.taskCreationOrigin);
  const taskCreationOriginContext = new AsyncLocalStorage<TaskCreationOrigin>();
  const currentTaskCreationOrigin = () => taskCreationOriginContext.getStore() ?? defaultTaskCreationOrigin;
  let observedRuntimeSessionId = sessionId;
  const sessionDb = options.sessionDb ?? new InMemorySessionDB();
  const taskStore = sessionDb instanceof SQLiteSessionDB
    ? new SQLiteTaskStore({ db: sessionDb.db, profileId })
    : undefined;
  const taskResultService = taskStore === undefined
    ? undefined
    : new TaskResultService({
        store: taskStore,
        profileId,
        contentRoot: profilePaths.taskResultsPath,
        sessionDb
      });
  const taskOperatorService = taskStore === undefined ? undefined : new TaskOperatorService({
    store: taskStore,
    backgroundContinuation: () => options.taskBackgroundContinuation ?? "unknown"
  });
  const closeSessionDbOnDispose = options.closeSessionDbOnDispose ?? true;
  const workspaceRoot = options.workspaceRoot ?? process.cwd();
  const taskWorkspace = taskStore === undefined ? undefined : await resolveTaskWorkspaceBinding(workspaceRoot);
  const localSkillsRoot = options.localSkillsRoot ?? profilePaths.skillsPath;
  const profileMemoryRoot = profilePaths.profileRoot;
  const memoryPersistenceService = new MemoryPersistenceService();
  const memoryCurationStore = new MemoryCurationStore({
    path: memoryCurationStorePath(profileMemoryRoot)
  });
  const memoryPersistencePaths = {
    "USER.md": profilePaths.userMdPath,
    "MEMORY.md": profilePaths.memoryMdPath,
    "SOUL.md": profilePaths.soulMdPath
  };
  const memoryMutationCoordinator = sessionDb instanceof SQLiteSessionDB
    ? new SQLiteMemoryCurationCoordinator({ db: sessionDb.db, profileId })
    : undefined;
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
    registry: providerRegistry,
    homeDir: globalPaths.homeDir,
    profileId
  });
  const processManager = new ProcessManager({ workspaceRoot });
  const pythonStateRoot = globalPaths.stateRoot;
  const channelMediaRoot = profilePaths.channelMediaPath;
  const audioCacheRoot = profilePaths.audioCachePath;
  const audioTempRoot = join(profilePaths.tempPath, "audio");
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
  const mcpTools = loadedMcpServers.flatMap((server) => server.tools);
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
  const skillEvolutionStore = new SkillEvolutionStore({
    usagePath: join(localSkillsRoot, ".usage.json"),
    evolutionRoot: join(localSkillsRoot, ".evolution")
  });
  const changeManifestStore = new ChangeManifestStore({
    root: join(localSkillsRoot, ".evolution", "manifests")
  });
  const skillUsageByName = new Map((await skillEvolutionStore.usage()).map((record) => [record.skillName, record]));

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
    memoryStore.hydrate("SHARED.md", sharedMemoryContent);
  }
  if (userMemory !== undefined) {
    memoryStore.hydrate("USER.md", userMemory);
  }
  if (soulMemory !== undefined) {
    memoryStore.hydrate("SOUL.md", soulMemory);
  }
  if (profileMemory !== undefined) {
    memoryStore.hydrate("MEMORY.md", profileMemory);
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
    mutationCoordinator: memoryMutationCoordinator,
    profileId
  });
  const skillAutonomy = options.skillAutonomy ?? "suggest";
  const agentEvolutionPolicy = deriveAgentEvolutionPolicy(skillAutonomy);
  const skillLearningManager = new SkillLearningManager({
    autonomy: skillAutonomy,
    registry: skillRegistry,
    localSkillsRoot,
    storePath: skillLearningStorePath,
    sessionDb,
    skillEvolutionStore
  });
  try {
    await skillLearningManager.reconcileCreatedPaths();
  } catch {
    // Old learning records are best-effort startup hygiene; runtime creation should continue.
  }
  const memoryPromptContextBuilder = new MemoryPromptContextBuilder({
    store: memoryStore,
    promotionStore: memoryPromotionStore
  });
  const memoryPromptContext = await memoryPromptContextBuilder.build();
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
  const taskBaseSecurityPolicy: SecurityPolicy = {
    decide: (request) => baseSecurityPolicyForActiveMode().decide(request),
    assess: async (request) => {
      const policy = baseSecurityPolicyForActiveMode();
      return await policy.assess?.(request) ?? {
        decision: policy.decide(request),
        mode: activeSecurityMode,
        reason: "Decided by the active security policy.",
        risk: "medium"
      };
    }
  };
  const fileStateTracker = new FileStateTracker();
  const agentLoopRoutes = {
    model: options.model,
    mainRoute,
    primaryModelRoute: options.primaryModelRoute,
    modelFallbackRoutes: options.modelFallbackRoutes,
    assessorRoute,
    visionRoute,
    compressionRoute,
    providerPreferences: {
      providerOrder: [options.model.provider]
    }
  };
  let registeredCronToolsets: string[] = [];
  const cronRuntimeControls = {
    config: {
      model: options.model,
      primaryModelRoute: options.primaryModelRoute ?? mainRoute,
      modelFallbackRoutes: options.modelFallbackRoutes ?? [],
      providerRegistry,
      config: {
        providers: options.providerConfigs ?? {},
        model: {
          provider: options.primaryModelRoute?.provider ?? options.model.provider,
          id: options.primaryModelRoute?.id ?? options.model.id
        }
      }
    } as unknown as LoadedRuntimeConfig,
    availableToolsets: () => registeredCronToolsets
  };
  const builder = new AgentLoopBuilder({
    substrate: {
      workspaceRoot,
      homeDir: options.homeDir,
      stateRoot: globalPaths.stateRoot,
      profileId,
      delegationConfig: options.delegationConfig ?? DEFAULT_DELEGATION_CONFIG,
      providerRegistry,
      providerExecutor,
      routes: agentLoopRoutes,
      mcpTools,
      skillRegistry,
      localSkillsRoot,
      bundledSkillsRoot: bundledSkillsDir,
      skillEvolutionStore,
      changeManifestStore,
      skillUsageByName,
      memoryStore,
      memoryProvider,
      memoryPromptContextBuilder,
      memoryPromptContext,
      memoryRetrievalService,
      sessionRecallServiceFactory: ({ sessionRuntimeContext, sessionDb }) => new SessionRecallService({
        sessionDb,
        profileId,
        workspaceRoot,
        excludeSessionIds: () => [sessionRuntimeContext.currentSessionId()],
        route: sessionSearchRoute,
        mainRoute,
        providerExecutor
      }),
      memoryFileCompactionServiceFactory: ({ sessionId, sessionDb, trajectoryRecorder }) => new MemoryFileCompactionService({
        store: memoryStore,
        memoryRoot: profileMemoryRoot,
        route: memoryFileCompactionRoute,
        mainRoute,
        providerExecutor,
        trajectoryRecorder,
        sessionDb,
        sessionId,
        mutationCoordinator: memoryMutationCoordinator,
        persistence: memoryPersistenceService
      }),
      memoryCurationServiceFactory: ({ sessionRuntimeContext, sessionDb, trajectoryRecorder }) => new MemoryCurationService({
        config: memoryConfig.curation,
        profileId,
        sessionId: () => sessionRuntimeContext.currentSessionId(),
        sessionDb,
        memoryStore,
        curationStore: memoryCurationStore,
        extractorOptions: {
          route: compressionRoute,
          mainRoute,
          providerExecutor
        },
        persistence: memoryPersistenceService,
        persistencePaths: {
          "USER.md": profilePaths.userMdPath,
          "MEMORY.md": profilePaths.memoryMdPath
        },
        memoryIndexSync,
        checkpointCoordinator: memoryMutationCoordinator,
        memoryMutationService: new MemoryMutationService({
          memoryStore,
          profileId,
          sessionId: () => sessionRuntimeContext.currentSessionId(),
          workspaceRoot,
          sessionDb,
          trajectoryRecorder,
          persistence: memoryPersistenceService,
          persistencePaths: memoryPersistencePaths,
          memoryIndexSync,
          externalMemory: externalMemoryConfig,
          externalMemoryProviders
        })
      }),
      fileStateTracker,
      memoryPersistenceService,
      memoryPersistencePaths,
      memoryMutationCoordinator,
      memoryIndexSync,
      sessionCompressionService,
      compressionConfig,
      externalMemory: externalMemoryConfig,
      externalMemoryProviders,
      processManager,
      browserBackend,
      browserConfig: options.browser,
      artifactStore,
      taskResultService,
      taskOperatorService,
      trustStore,
      cronStore,
      disableCronTools: options.disableCronTools,
      cronRuntimeControls,
      setAvailableToolsets: (toolsets) => {
        registeredCronToolsets = toolsets;
      },
      contextReferenceExpander,
      projectContext,
      pythonStateRoot,
      channelMediaRoot,
      audioCacheRoot,
      audioTempRoot,
      imageCacheRoot,
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
      telegramReady: options.telegramReady,
      currentPlatform: options.currentPlatform,
      executionControls: options.executionControls
    }
  });
  const subagentRegistry = new SubagentRegistry();
  const childFactory = new DefaultChildAgentLoopFactory({
    builder,
    parentRoutes: agentLoopRoutes,
    providerRegistry,
    providerConfigs: options.providerConfigs,
    homeDir: globalPaths.homeDir,
    profileId,
    sessionDb,
    trajectoryRecorderFactory: ({ profileId, sessionId }) => new TrajectoryRecorder({
      profileId,
      sessionId,
      modelId: options.model.id
    }),
    responseLabel: runtimeBranding.responseLabel,
    workspaceRoot,
    delegationConfig: options.delegationConfig,
    skillConfig: options.skillConfig,
    ui: options.ui,
    agentProfile: options.agentProfile,
    taskStore,
    taskWorkspace,
    onTaskCreated: options.onTaskCreated
  });
  const builtSession = await builder.buildSession({
    sessionId,
    sessionRuntimeContext,
    sessionDb,
    trajectoryRecorder,
    skillConfig: options.skillConfig,
    skillLearningManager,
    agentEvolutionPolicy,
    responseLabel: runtimeBranding.responseLabel,
    ui: options.ui,
    agentProfile: options.agentProfile,
    securityPolicy,
    delegationServiceFactory: taskStore === undefined || taskWorkspace === undefined
      ? undefined
      : ({ toolRegistry, sessionRuntimeContext }) => new DurableDelegationService({
          store: taskStore,
          creatorSessionId: () => sessionRuntimeContext.currentSessionId(),
          workspace: taskWorkspace,
          config: options.delegationConfig ?? DEFAULT_DELEGATION_CONFIG,
          visibleTools: () => toolRegistry.list(),
          completionDestination: () => currentTaskCreationOrigin().completionDestination,
          executionPreference: () => currentTaskCreationOrigin().source === "gateway" ? "background" : "auto",
          backgroundContinuation: () => options.taskBackgroundContinuation ?? "unknown",
          onTaskCreated: options.onTaskCreated
        }),
    trustedWorkspace: async () => activeTrustedWorkspace || await trustStore.isTrusted(workspaceRoot),
    disabledToolsets: options.disabledToolsets,
    toolRegistryFilter: options.enabledToolsets === undefined
      ? undefined
      : ({ registry, availableTools }) => {
          const allowed = new Set(options.enabledToolsets);
          const strippedTools: Array<{ name: string; reasons: string[] }> = [];
          const effectiveAllowedTools: string[] = [];
          for (const tool of availableTools) {
            if (tool.toolsets.some((toolset) => allowed.has(toolset))) {
              effectiveAllowedTools.push(tool.name);
            } else {
              registry.unregister(tool.name);
              strippedTools.push({ name: tool.name, reasons: ["toolset-not-enabled"] });
            }
          }
          return {
            effectiveAllowedTools,
            effectiveAllowedToolsets: availableToolsetsFromTools(availableTools).filter((toolset) => allowed.has(toolset)),
            strippedTools,
            blockedTools: []
          };
        }
  });
  const {
    agentLoop,
    toolRegistry,
    toolExecutor,
    sessionSkillRegistry,
    sessionSkillCatalog,
    sessionRecallService,
    memoryCurationService
  } = builtSession;
  const taskAgentExecutor = taskStore === undefined
    ? undefined
    : new AgentStepExecutor({
        childFactory,
        sessionDb,
        taskStore,
        approvalService: new TaskApprovalService({ store: taskStore }),
        securityPolicy: taskBaseSecurityPolicy,
        hostWorkspace: taskWorkspace!,
        isWorkspaceTrusted: (workspace) => trustStore.isTrusted(workspace.canonicalPath),
        parentVisibleTools: () => toolRegistry.list(),
        delegationConfig: options.delegationConfig,
        subagentRegistry,
        diagnosticsRoot: profilePaths.tempPath,
        resolveArtifactContent: await createTaskArtifactContentResolver([
          workspaceRoot,
          channelMediaRoot,
          audioCacheRoot,
          imageCacheRoot,
          profilePaths.tempPath
        ])
      });

  return {
    sessionDb,
    taskAgentExecutor,
    taskOperator: taskOperatorService,
    beginTask: taskOperatorService === undefined || taskWorkspace === undefined
      ? undefined
      : async (objective, beginOptions = {}) => {
          if (!activeTrustedWorkspace && !(await trustStore.isTrusted(workspaceRoot))) {
            throw new Error("Task creation requires a trusted workspace.");
          }
          const origin = currentTaskCreationOrigin();
          const task = taskOperatorService.begin({
            objective,
            workspace: taskWorkspace,
            creatorSessionId: sessionRuntimeContext.currentSessionId(),
            source: origin.source,
            executionPreference: beginOptions.executionPreference,
            completionDestination: origin.completionDestination
          });
          if (task.executionPreference === "auto") await options.onTaskCreated?.(task.taskId);
          return taskOperatorService.status(task.taskId, sessionRuntimeContext.currentSessionId());
        },
    withTaskCreationOrigin(origin, work) {
      return taskCreationOriginContext.run(normalizeTaskCreationOrigin(origin), work);
    },
    agentEvolutionPolicy() {
      return agentEvolutionPolicy;
    },
    get sessionId() {
      return sessionRuntimeContext.currentSessionId();
    },
    get trajectoryId() {
      return agentLoop.trajectoryId;
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
    resolveSkill(name) {
      return sessionSkillRegistry.resolve(name);
    },
    async latestResumeNote() {
      const events = await sessionDb.listEvents(sessionRuntimeContext.currentSessionId());
      const cancelled = [...events].reverse().find((event) => event.kind === "agent-cancelled" && event.resumeNote !== undefined);

      return cancelled?.kind === "agent-cancelled" ? cancelled.resumeNote : undefined;
    },
    async currentContextWindowUsage() {
      return await loadSessionContextWindowUsage({
        sessionDb,
        sessionId: sessionRuntimeContext.currentSessionId(),
        profileId
      });
    },
    async currentSessionCost() {
      return await loadSessionCostUsage({
        sessionDb,
        taskStore,
        sessionId: sessionRuntimeContext.currentSessionId(),
        profileId
      });
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
      await memoryCurationService?.checkpoint({
        trigger: "compact",
        sessionId: targetSessionId,
        signal: input.signal
      }).catch(() => undefined);
      return await sessionCompressionService.compactNow({
        profileId,
        sessionId: targetSessionId,
        focusTopic: input.focusTopic,
        preserveTranscript: input.preserveTranscript === true,
        signal: input.signal
      });
    },
    async auditMemoryCuration(input) {
      return await memoryCurationService?.checkpoint(input);
    },
    inspectMcpServers() {
      return loadedMcpServers.map((server) => structuredClone(server.snapshot));
    },
    hasActiveSubagents(parentSessionId) {
      return subagentRegistry.hasActiveSubagents(parentSessionId);
    },
    activeSubagents(parentSessionId = sessionId) {
      return subagentRegistry.operatorStatus({ parentSessionId });
    },
    async handle(input) {
      const trustedWorkspace = input.trustedWorkspace ?? await trustStore.isTrusted(workspaceRoot);
      activeTrustedWorkspace = trustedWorkspace;

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
        toolCallId: input.toolCallId,
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
        tempRoot: audioTempRoot,
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
    enqueueSessionFinalization(reason) {
      if (!(sessionDb instanceof SQLiteSessionDB)) {
        return undefined;
      }
      return new SessionFinalizationQueue({
        db: sessionDb.db,
        enqueueBusyTimeoutMs: 50
      }).enqueue({
        profileId,
        sessionId: sessionRuntimeContext.currentSessionId(),
        reason,
      });
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
        "status: ready"
      ].filter((line) => line !== undefined).join("\n");
    },
    getStatus() {
      const activeSubagents = subagentRegistry.operatorStatus({ parentSessionId: sessionId });
      const sections = [];
      if (taskStore !== undefined) {
        const tasks = taskStore.listTasks({ limit: 1_000 });
        const active = tasks.filter((task) => !["completed", "partial", "failed", "cancelled"].includes(task.status));
        sections.push(buildKeyValueBlockViewModel({
          title: "Durable tasks",
          entries: [
            kv("Active", active.length),
            kv("Queued", tasks.filter((task) => task.status === "queued").length),
            kv("Running", tasks.filter((task) => task.status === "running").length),
            kv("Waiting", active.filter((task) => task.status.startsWith("waiting_")).length)
          ]
        }));
      }
      if (activeSubagents.activeCount > 0) {
        sections.push(buildTableViewModel({
          title: activeSubagents.omittedCount === 0
            ? `Active subagents (${activeSubagents.activeCount})`
            : `Active subagents (${activeSubagents.activeCount}, ${activeSubagents.omittedCount} omitted)`,
          columns: [
            { key: "child", header: "Child" },
            { key: "parent", header: "Parent" },
            { key: "role", header: "Role" },
            { key: "depth", header: "Depth", alignment: "right" },
            { key: "model", header: "Model" },
            { key: "status", header: "Status" },
            { key: "duration", header: "Duration" },
            { key: "batch", header: "Batch" }
          ],
          rows: activeSubagents.subagents.map((subagent) => ({
            child: subagent.childSessionId,
            parent: subagent.parentSessionId,
            role: subagent.role,
            depth: subagent.depth,
            model: `${subagent.provider}/${subagent.model}`,
            status: subagent.cancellationState === undefined
              ? subagent.status
              : `${subagent.status} (${subagent.cancellationState})`,
            duration: formatSubagentDuration(subagent.durationMs),
            batch: formatSubagentBatch(subagent.batchId, subagent.taskIndex)
          }))
        }));
      }
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
        warnings: skillLoadWarnings.map((message) =>
          buildWarningErrorViewModel({ severity: "warn", title: "Skill load", message })
        ),
        sections: sections.length === 0 ? undefined : sections,
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
    }
  };
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

function formatSubagentDuration(durationMs: number): string {
  const safeMs = Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0;
  if (safeMs < 1000) {
    return `${Math.round(safeMs)}ms`;
  }
  const seconds = Math.floor(safeMs / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
}

function formatSubagentBatch(batchId: string | undefined, taskIndex: number | undefined): string {
  if (batchId === undefined && taskIndex === undefined) {
    return "";
  }
  if (batchId === undefined) {
    return `#${taskIndex}`;
  }
  if (taskIndex === undefined) {
    return batchId;
  }
  return `${batchId} #${taskIndex}`;
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
              : { kind: "env", name: getDefaultApiKeyEnv(provider) },
            headers: metadata.defaultHeaders
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
            : { kind: "env", name: getDefaultApiKeyEnv(provider) },
          headers: metadata.defaultHeaders
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
    "nous",
    "zai"
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
