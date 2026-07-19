import type { ProjectContextSnapshot } from "../contracts/context.js";
import type { AgentEvolutionPolicy } from "../contracts/agent-evolution.js";
import type { BrowserBackend } from "../contracts/browser.js";
import type { ExternalMemoryProvider, MemoryProvider, MemoryPromptContext } from "../contracts/memory.js";
import type { ModelProfile, ProviderRoutePreferences, ResolvedAuxiliaryRoute, ResolvedModelRoute } from "../contracts/provider.js";
import type { SecurityPolicy } from "../contracts/security.js";
import type { SessionDB } from "../contracts/session.js";
import type { LoadedSkill, SkillCatalogEntry, SkillDefinition, SkillLifecycleState, SkillPythonCapabilityRequirement, SkillPythonCapabilitySetupStatus } from "../contracts/skill.js";
import type { RegisteredTool, ToolDefinition, ToolProvider, ToolsetName } from "../contracts/tool.js";
import type { RuntimeToolContext, SessionToolContext } from "../contracts/tool-context.js";
import type { LoadedRuntimeConfig } from "../config/runtime-config.js";
import type { ArtifactStore } from "../artifacts/artifact-store.js";
import type { TaskResultService } from "../workflow/task-result-service.js";
import type { ContextReferenceExpander } from "../context/context-reference-expander.js";
import type { CronStore } from "../cron/cron-store.js";
import { availableToolsetsFromTools } from "../cron/cron-runtime-validation.js";
import type { DelegationConfig } from "../contracts/delegation.js";
import { DEFAULT_DELEGATION_CONFIG } from "../config/delegation-defaults.js";
import type { DelegationManager } from "../delegation/delegation-manager.js";
import type { FileStateTracker } from "../delegation/file-state-tracker.js";
import type { MemoryFileCompactionService } from "../memory/memory-file-compaction-service.js";
import type { MemoryIndexSync } from "../memory/memory-index-sync.js";
import type { MemoryPersistenceService } from "../memory/memory-persistence-service.js";
import type { LocalMemoryProvider } from "../memory/local-memory-provider.js";
import { MemoryRecallOrchestrator } from "../memory/memory-recall-orchestrator.js";
import type { MemoryCurationService } from "../memory/memory-curation-service.js";
import type { MemoryCurationCheckpointCoordinator } from "../memory/memory-curation-coordinator.js";
import type { LocalMemoryRetrievalService } from "../memory/memory-retrieval-service.js";
import type { MemoryStore } from "../memory/memory-store.js";
import type { ProviderExecutor } from "../providers/provider-executor.js";
import type { ProviderRegistry } from "../providers/provider-registry.js";
import type { SessionCompressionService } from "../prompt/session-compression-service.js";
import type { SessionCompressionConfig } from "../config/runtime-config.js";
import type { WorkspaceTrustStore } from "../security/workspace-trust-store.js";
import { loadSessionContextWindowUsage } from "../session/session-context-window-usage.js";
import type { SkillEvolutionStore } from "../skills/skill-evolution.js";
import type { ChangeManifestStore } from "../skills/change-manifest-store.js";
import type { SkillLearningManager } from "../skills/skill-learning.js";
import { evaluateSkillVisibility } from "../skills/skill-visibility.js";
import { SkillRegistry } from "../skills/skill-registry.js";
import { ToolExecutor } from "../tools/tool-executor.js";
import { ToolRegistry } from "../tools/tool-registry.js";
import { ToolCallPlanner } from "../tools/tool-call-planner.js";
import { buildProviderToolSchemaCatalog, type OpenAICompatibleToolSchema } from "../tools/tool-schema.js";
import { toolRegistrationPlan, type ToolRegistrationPhase } from "../tools/index.js";
import type { WorkspaceFsAdapter } from "../tools/workspace-tools.js";
import type { FetchLike as WebFetchLike } from "../tools/web-tools.js";
import type { ImageGenerationFetchLike } from "../tools/image-generation-tools.js";
import type { VoiceFetchLike } from "../tools/voice-tools.js";
import type { FasterWhisperWorker } from "../tools/stt-local-whisper.js";
import type { ProcessManager } from "../process/process-manager.js";
import type { TrajectoryRecorder } from "../trajectory/trajectory-recorder.js";
import { AgentLoop, type AgentLoopOptions } from "./agent-loop.js";
import { IntentRouter } from "./intent-router.js";
import { NativeToolExecutor } from "./native-tool-executor.js";
import { ProviderTurnLoop, type ProviderTurnLoopBudgets, type ProviderTurnLoopOptions, type ProviderTurnLoopRequestDefaults } from "./provider-turn-loop.js";
import { RunRecorder } from "./run-recorder.js";
import { RuntimeRouter } from "./runtime-router.js";
import { SkillPlaybookRunner } from "./skill-playbook-runner.js";
import { LlmSkillRouteShadowReranker } from "./skill-route-reranker.js";
import { createSessionRuntimeContext, type SessionRuntimeContext } from "./session-runtime-context.js";
import { ToolPlanRunner } from "./tool-plan-runner.js";
import { resolveCapabilityPythonEnv, type CapabilityPythonEnvResolveResult } from "../python-env/capability-resolver.js";

export type AgentLoopRouteInput = {
  model: ModelProfile;
  mainRoute: ResolvedModelRoute;
  primaryModelRoute?: ResolvedModelRoute;
  modelFallbackRoutes?: ResolvedModelRoute[];
  assessorRoute?: ResolvedAuxiliaryRoute;
  visionRoute?: ResolvedAuxiliaryRoute;
  compressionRoute?: ResolvedAuxiliaryRoute;
  providerPreferences: ProviderRoutePreferences;
};

export type AgentLoopSessionRouteOverride = AgentLoopRouteInput;

export const DEFAULT_PROVIDER_TURN_BUDGETS: ProviderTurnLoopBudgets = {
  maxProviderIterations: 45,
  maxProviderToolCalls: 100,
  maxRepeatedToolFailures: 5,
  maxProviderWallClockMs: 300_000
};

export type AgentLoopExecutionControls = {
  providerBudgets?: Partial<ProviderTurnLoopBudgets>;
  providerRequestDefaults?: ProviderTurnLoopRequestDefaults;
  childProcessEnv?: SessionToolContext["childProcessEnv"];
};

export type AgentLoopSkillVisibilityInput = {
  skillRegistry: SkillRegistry;
  toolAvailability: ToolDefinition[];
  browserAvailable: boolean;
  skillUsageByName: ReadonlyMap<string, { state?: SkillLifecycleState }>;
  telegramReady: boolean;
  webEnabled: boolean;
  platform: string;
};

export type AgentLoopSkillVisibilityStrategy = (
  input: AgentLoopSkillVisibilityInput
) => SkillRegistry;

export type AgentLoopToolRegistryFilterInput = {
  registry: ToolRegistry;
  availableTools: ToolDefinition[];
};

export type AgentLoopToolRegistryFilterResult = {
  effectiveAllowedTools: string[];
  effectiveAllowedToolsets: ToolsetName[];
  strippedTools: Array<{
    name: string;
    reasons: string[];
  }>;
  blockedTools: Array<{
    name: string;
    reasons: string[];
  }>;
};

export type AgentLoopToolRegistryFilter = (
  input: AgentLoopToolRegistryFilterInput
) => AgentLoopToolRegistryFilterResult;

export type AgentLoopRuntimeSubstrate = {
  workspaceRoot: string;
  homeDir: string | undefined;
  stateRoot: string;
  profileId: string;
  loadedConfig?: LoadedRuntimeConfig;
  delegationConfig?: DelegationConfig;
  providerRegistry: ProviderRegistry;
  providerExecutor: ProviderExecutor;
  routes: AgentLoopRouteInput;
  mcpTools: readonly RegisteredTool[];
  skillRegistry: SkillRegistry;
  localSkillsRoot: string;
  bundledSkillsRoot: string;
  skillEvolutionStore: SkillEvolutionStore;
  changeManifestStore: ChangeManifestStore;
  skillUsageByName: ReadonlyMap<string, { state?: SkillLifecycleState }>;
  memoryStore: MemoryStore;
  memoryProvider: MemoryProvider;
  memoryPromptContextBuilder: import("../memory/memory-prompt-context-builder.js").MemoryPromptContextBuilder;
  memoryPromptContext: MemoryPromptContext | undefined;
  memoryRetrievalService: LocalMemoryRetrievalService;
  sessionRecallServiceFactory: (input: AgentLoopSessionServiceInput) => import("../session/session-recall-service.js").SessionRecallService;
  memoryFileCompactionServiceFactory: (input: AgentLoopSessionServiceInput) => MemoryFileCompactionService;
  memoryCurationServiceFactory?: (input: AgentLoopSessionServiceInput) => MemoryCurationService;
  fileStateTracker: FileStateTracker;
  memoryPersistenceService: MemoryPersistenceService;
  memoryPersistencePaths: Record<string, string>;
  memoryMutationCoordinator?: MemoryCurationCheckpointCoordinator;
  memoryIndexSync: MemoryIndexSync | undefined;
  sessionCompressionService: Pick<SessionCompressionService, "compactIfNeeded">;
  compressionConfig: SessionCompressionConfig;
  externalMemory: LoadedRuntimeConfig["externalMemory"];
  externalMemoryProviders: ExternalMemoryProvider[];
  processManager: ProcessManager;
  browserBackend: BrowserBackend;
  browserConfig: SessionToolContext["browserConfig"];
  artifactStore: ArtifactStore;
  taskResultService?: TaskResultService;
  trustStore: WorkspaceTrustStore;
  cronStore: CronStore;
  disableCronTools?: boolean;
  cronRuntimeControls?: RuntimeToolContext["cronRuntimeControls"];
  setAvailableToolsets?: (toolsets: string[]) => void;
  contextReferenceExpander: ContextReferenceExpander;
  projectContext: ProjectContextSnapshot;
  pythonStateRoot?: string;
  channelMediaRoot?: string;
  audioCacheRoot?: string;
  audioTempRoot?: string;
  imageCacheRoot?: string;
  workspaceFsAdapter?: WorkspaceFsAdapter;
  webFetch?: WebFetchLike;
  enableWebNetwork?: boolean;
  webMaxContentChars?: number;
  webConfig?: Pick<LoadedRuntimeConfig["web"], "backend" | "searchBackend" | "extractBackend" | "crawlBackend" | "brave">;
  securityConfig?: Pick<LoadedRuntimeConfig["security"], "allowPrivateUrls" | "websiteBlocklist">;
  voiceFetch?: VoiceFetchLike;
  localWhisper?: FasterWhisperWorker;
  tts?: LoadedRuntimeConfig["tts"];
  stt?: LoadedRuntimeConfig["stt"];
  imageGen?: LoadedRuntimeConfig["imageGen"];
  imageGenerationFetch?: ImageGenerationFetchLike;
  telegramReady?: boolean;
  currentPlatform?: string;
  executionControls?: AgentLoopExecutionControls;
};

export type AgentLoopSessionServiceInput = {
  sessionId: string;
  sessionRuntimeContext: SessionRuntimeContext;
  sessionDb: SessionDB;
  trajectoryRecorder: TrajectoryRecorder;
};

export type AgentLoopSessionInput = {
  sessionId: string;
  sessionRuntimeContext?: SessionRuntimeContext;
  parentSessionId?: string;
  sessionDb: SessionDB;
  trajectoryRecorder: TrajectoryRecorder;
  skillConfig?: Record<string, Record<string, unknown>>;
  skillLearningManager?: SkillLearningManager;
  agentEvolutionPolicy?: AgentEvolutionPolicy;
  responseLabel: string;
  ui?: AgentLoopOptions["ui"];
  agentProfile?: AgentLoopOptions["agentProfile"];
  securityPolicy: SecurityPolicy;
  delegationManagerFactory: (input: {
    toolExecutor: ToolExecutor;
    toolRegistry: ToolRegistry;
    sessionRuntimeContext: SessionRuntimeContext;
  }) => DelegationManager;
  trustedWorkspace: () => Promise<boolean>;
  disabledToolsets?: ToolsetName[];
  skillVisibilityStrategy?: AgentLoopSkillVisibilityStrategy;
  memoryRecall?: "enabled" | "disabled";
  sessionCompression?: "enabled" | "disabled";
  projectContext?: ProjectContextSnapshot;
  providerRoutes?: AgentLoopSessionRouteOverride;
  toolRegistryFilter?: AgentLoopToolRegistryFilter;
};

export type BuiltAgentLoopSession = {
  sessionRuntimeContext: SessionRuntimeContext;
  toolRegistry: ToolRegistry;
  toolExecutor: ToolExecutor;
  toolCallPlanner: ToolCallPlanner;
  runRecorder: RunRecorder;
  toolPlanRunner: ToolPlanRunner;
  providerTurnLoop: ProviderTurnLoop;
  skillPlaybookRunner: SkillPlaybookRunner;
  nativeToolExecutor: NativeToolExecutor;
  runtimeRouter: RuntimeRouter;
  intentRouter: IntentRouter;
  agentLoop: AgentLoop;
  sessionSkillRegistry: SkillRegistry;
  sessionSkillCatalog: SkillCatalogEntry[];
  providerTools: OpenAICompatibleToolSchema[];
  providerRoutes: AgentLoopRouteInput;
  delegationManager: DelegationManager;
  sessionRecallService: import("../session/session-recall-service.js").SessionRecallService;
  memoryFileCompactionService: MemoryFileCompactionService;
  memoryCurationService?: MemoryCurationService;
  toolFilterResult?: AgentLoopToolRegistryFilterResult;
};

type AgentLoopBuilderFactories = {
  toolExecutor?: (options: ConstructorParameters<typeof ToolExecutor>[0]) => ToolExecutor;
  runRecorder?: (options: ConstructorParameters<typeof RunRecorder>[0]) => RunRecorder;
  toolPlanRunner?: (options: ConstructorParameters<typeof ToolPlanRunner>[0]) => ToolPlanRunner;
  providerTurnLoop?: (options: ProviderTurnLoopOptions) => ProviderTurnLoop;
  skillPlaybookRunner?: (options: ConstructorParameters<typeof SkillPlaybookRunner>[0]) => SkillPlaybookRunner;
  nativeToolExecutor?: (options: ConstructorParameters<typeof NativeToolExecutor>[0]) => NativeToolExecutor;
  runtimeRouter?: (options: ConstructorParameters<typeof RuntimeRouter>[0]) => RuntimeRouter;
  agentLoop?: (options: AgentLoopOptions) => AgentLoop;
};

export class AgentLoopBuilder {
  readonly #substrate: AgentLoopRuntimeSubstrate;
  readonly #factories: AgentLoopBuilderFactories;

  constructor(input: {
    substrate: AgentLoopRuntimeSubstrate;
    factories?: AgentLoopBuilderFactories;
  }) {
    this.#substrate = input.substrate;
    this.#factories = input.factories ?? {};
  }

  async buildSession(input: AgentLoopSessionInput): Promise<BuiltAgentLoopSession> {
    const substrate = this.#substrate;
    const routes = input.providerRoutes ?? substrate.routes;
    const sessionRuntimeContext = input.sessionRuntimeContext ?? createSessionRuntimeContext(input.sessionId);
    const initialContextWindowUsage = await loadSessionContextWindowUsage({
      sessionDb: input.sessionDb,
      sessionId: input.sessionId,
      profileId: substrate.profileId
    });
    const toolRegistry = new ToolRegistry();
    const runtimeToolContext = buildRuntimeToolContext({
      workspaceRoot: substrate.workspaceRoot,
      homeDir: substrate.homeDir,
      profileId: substrate.profileId,
      cronStore: substrate.cronStore,
      trustStore: substrate.trustStore,
      disableCronTools: substrate.disableCronTools,
      cronRuntimeControls: substrate.cronRuntimeControls
    });
    const sessionServiceInput = {
      sessionId: input.sessionId,
      sessionRuntimeContext,
      sessionDb: input.sessionDb,
      trajectoryRecorder: input.trajectoryRecorder
    };
    const sessionRecallService = substrate.sessionRecallServiceFactory(sessionServiceInput);
    const memoryFileCompactionService = substrate.memoryFileCompactionServiceFactory(sessionServiceInput);
    const memoryCurationService = input.parentSessionId === undefined
      ? substrate.memoryCurationServiceFactory?.(sessionServiceInput)
      : undefined;

    for (const tool of substrate.mcpTools) {
      toolRegistry.register(tool);
    }

    registerToolRegistrationPhase({
      registry: toolRegistry,
      phase: "pre-skill-visibility",
      runtimeCtx: runtimeToolContext,
      sessionCtx: buildPreSkillVisibilityToolContext({
        workspaceRoot: substrate.workspaceRoot,
        profileId: substrate.profileId,
        sessionId: input.sessionId,
        parentSessionId: input.parentSessionId,
        childSessionId: input.parentSessionId === undefined ? undefined : input.sessionId,
        currentSessionId: () => sessionRuntimeContext.currentSessionId(),
        homeDir: substrate.homeDir,
        childProcessEnv: substrate.executionControls?.childProcessEnv,
        pythonStateRoot: substrate.pythonStateRoot,
        channelMediaRoot: substrate.channelMediaRoot,
        audioCacheRoot: substrate.audioCacheRoot,
        audioTempRoot: substrate.audioTempRoot,
        imageCacheRoot: substrate.imageCacheRoot,
        browserBackend: substrate.browserBackend,
        browserConfig: substrate.browserConfig,
        mainRoute: routes.mainRoute,
        visionRoute: routes.visionRoute,
        compressionRoute: routes.compressionRoute,
        providerRegistry: substrate.providerRegistry,
        providerExecutor: substrate.providerExecutor,
        processManager: substrate.processManager,
        artifactStore: substrate.artifactStore,
        taskResultService: substrate.taskResultService,
        sessionDb: input.sessionDb,
        trajectoryRecorder: input.trajectoryRecorder,
        memoryStore: substrate.memoryStore,
        memoryPersistenceService: substrate.memoryPersistenceService,
        memoryPersistencePaths: substrate.memoryPersistencePaths,
        memoryMutationCoordinator: substrate.memoryMutationCoordinator,
        memoryIndexSync: substrate.memoryIndexSync,
        memoryRetrievalService: substrate.memoryRetrievalService,
        memoryFileCompactionService,
        fileStateTracker: substrate.fileStateTracker,
        workspaceFsAdapter: substrate.workspaceFsAdapter,
        webFetch: substrate.webFetch,
        enableWebNetwork: substrate.enableWebNetwork,
        webMaxContentChars: substrate.webMaxContentChars,
        webConfig: substrate.webConfig,
        securityConfig: substrate.securityConfig,
        voiceFetch: substrate.voiceFetch,
        localWhisper: substrate.localWhisper,
        tts: substrate.tts,
        stt: substrate.stt,
        imageGen: substrate.imageGen,
        imageGenerationFetch: substrate.imageGenerationFetch,
        externalMemory: substrate.externalMemory,
        externalMemoryProviders: substrate.externalMemoryProviders
      })
    });

    const browserAvailable = await substrate.browserBackend.isAvailable();
    const toolAvailability = await toolRegistry.snapshot();
    const visibilityStrategy = input.skillVisibilityStrategy ?? defaultSkillVisibilityStrategy;
    const visibilityFilteredSkillRegistry = visibilityStrategy({
      skillRegistry: substrate.skillRegistry,
      toolAvailability: toolAvailability.available,
      browserAvailable,
      skillUsageByName: substrate.skillUsageByName,
      telegramReady: substrate.telegramReady === true,
      webEnabled: substrate.enableWebNetwork === true,
      platform: substrate.currentPlatform ?? process.platform
    });
    const sessionSkillRegistry = await applyPythonCapabilityAvailability({
      skillRegistry: visibilityFilteredSkillRegistry,
      stateRoot: substrate.stateRoot
    });
    const sessionSkillCatalog = sessionSkillRegistry.catalog();

    registerToolRegistrationPhase({
      registry: toolRegistry,
      phase: "post-skill-visibility",
      runtimeCtx: runtimeToolContext,
      sessionCtx: buildPostSkillVisibilityToolContext({
        workspaceRoot: substrate.workspaceRoot,
        profileId: substrate.profileId,
        sessionId: input.sessionId,
        currentSessionId: () => sessionRuntimeContext.currentSessionId(),
        skillRegistry: substrate.skillRegistry,
        sessionSkillRegistry,
        skillConfig: input.skillConfig,
        localSkillsRoot: substrate.localSkillsRoot,
        bundledSkillsRoot: substrate.bundledSkillsRoot,
        skillEvolutionStore: substrate.skillEvolutionStore,
        changeManifestStore: substrate.changeManifestStore
      })
    });

    registerToolRegistrationPhase({
      registry: toolRegistry,
      phase: "post-memory-provider",
      runtimeCtx: runtimeToolContext,
      sessionCtx: buildPostMemoryProviderToolContext({
        workspaceRoot: substrate.workspaceRoot,
        profileId: substrate.profileId,
        sessionId: input.sessionId,
        currentSessionId: () => sessionRuntimeContext.currentSessionId(),
        memoryInspector: (substrate.memoryProvider as LocalMemoryProvider).inspector,
        memoryRetrievalService: substrate.memoryRetrievalService
      })
    });

    const toolExecutor = (this.#factories.toolExecutor ?? ((options) => new ToolExecutor(options)))({
      registry: toolRegistry,
      securityPolicy: input.securityPolicy,
      sessionDb: input.sessionDb,
      trajectoryRecorder: input.trajectoryRecorder,
      workspaceRoot: substrate.workspaceRoot
    });
    const delegationManager = input.delegationManagerFactory({
      toolExecutor,
      toolRegistry,
      sessionRuntimeContext
    });

    registerToolRegistrationPhase({
      registry: toolRegistry,
      phase: "post-tool-executor",
      runtimeCtx: runtimeToolContext,
      sessionCtx: buildPostToolExecutorToolContext({
        workspaceRoot: substrate.workspaceRoot,
        profileId: substrate.profileId,
        sessionId: input.sessionId,
        currentSessionId: () => sessionRuntimeContext.currentSessionId(),
        toolExecutor,
        delegationManager,
        delegationConfig: substrate.delegationConfig ?? DEFAULT_DELEGATION_CONFIG,
        sessionDb: input.sessionDb,
        trajectoryRecorder: input.trajectoryRecorder,
        trustedWorkspace: input.trustedWorkspace
      })
    });

    let providerToolAvailability = await toolRegistry.snapshot();
    substrate.setAvailableToolsets?.(availableToolsetsFromTools(providerToolAvailability.available));
    const toolFilterResult = input.toolRegistryFilter?.({
      registry: toolRegistry,
      availableTools: providerToolAvailability.available
    });
    if (toolFilterResult !== undefined) {
      providerToolAvailability = await toolRegistry.snapshot();
      substrate.setAvailableToolsets?.(availableToolsetsFromTools(providerToolAvailability.available));
    }
    applyDisabledToolsets(toolRegistry, providerToolAvailability.available, input.disabledToolsets);
    if (input.disabledToolsets !== undefined && input.disabledToolsets.length > 0) {
      providerToolAvailability = await toolRegistry.snapshot();
      substrate.setAvailableToolsets?.(availableToolsetsFromTools(providerToolAvailability.available));
    }
    const providerToolSchemaCatalog = buildProviderToolSchemaCatalog({
      tools: providerToolAvailability.available
    });
    const toolCallPlanner = new ToolCallPlanner({
      registry: toolRegistry,
      aliases: providerToolSchemaCatalog.aliases
    });
    const runRecorder = (this.#factories.runRecorder ?? ((options) => new RunRecorder(options)))({
      sessionDb: input.sessionDb,
      sessionId: input.sessionId,
      sessionRuntimeContext,
      trajectoryRecorder: input.trajectoryRecorder,
      trajectoryStore: hasTrajectoryStore(input.sessionDb) ? input.sessionDb : undefined,
      profileId: substrate.profileId,
      skillEvolutionStore: substrate.skillEvolutionStore
    });
    const memoryRecallOrchestrator = input.memoryRecall === "disabled"
      ? undefined
      : new MemoryRecallOrchestrator({
        builder: substrate.memoryPromptContextBuilder,
        sessionRecallService,
        recorder: runRecorder,
        externalMemory: substrate.externalMemory,
        externalMemoryProviders: substrate.externalMemoryProviders,
        profileId: substrate.profileId,
        sessionId: () => sessionRuntimeContext.currentSessionId(),
        workspaceRoot: substrate.workspaceRoot
      });
    const toolPlanRunner = (this.#factories.toolPlanRunner ?? ((options) => new ToolPlanRunner(options)))({
      toolCallPlanner,
      toolExecutor,
      runRecorder,
      sessionId: input.sessionId,
      sessionRuntimeContext,
      maxConcurrentSafeTools: 4,
      delegateTaskCallLimit: (substrate.delegationConfig ?? DEFAULT_DELEGATION_CONFIG).maxDelegateCallsPerTurn
    });
    const providerTurnLoop = (this.#factories.providerTurnLoop ?? ((options) => new ProviderTurnLoop(options)))({
      providerExecutor: substrate.providerExecutor,
      model: routes.model,
      primaryModelRoute: routes.primaryModelRoute,
      modelFallbackRoutes: routes.modelFallbackRoutes,
      providerPreferences: routes.providerPreferences,
      sessionDb: input.sessionDb,
      sessionId: input.sessionId,
      sessionRuntimeContext,
      profileId: substrate.profileId,
      trajectoryRecorder: input.trajectoryRecorder,
      runRecorder,
      toolPlanRunner,
      soul: undefined,
      memoryPromptContext: substrate.memoryPromptContext,
      skillsIndex: sessionSkillCatalog,
      ui: input.ui,
      agentProfile: input.agentProfile,
      budgets: {
        ...DEFAULT_PROVIDER_TURN_BUDGETS,
        ...substrate.executionControls?.providerBudgets
      },
      providerRequestDefaults: substrate.executionControls?.providerRequestDefaults,
      initialContextWindowUsage
    });
    const skillPlaybookRunner = (this.#factories.skillPlaybookRunner ?? ((options) => new SkillPlaybookRunner(options)))({
      toolExecutor,
      sessionId: input.sessionId,
      sessionRuntimeContext,
      runRecorder
    });
    const nativeToolExecutor = (this.#factories.nativeToolExecutor ?? ((options) => new NativeToolExecutor(options)))({
      toolExecutor,
      runRecorder,
      sessionId: input.sessionId,
      sessionRuntimeContext
    });
    const intentRouter = new IntentRouter({
      skillRegistry: sessionSkillRegistry,
      model: routes.model
    });
    const runtimeRouter = (this.#factories.runtimeRouter ?? ((options) => new RuntimeRouter(options)))({
      intentRouter,
      skillConfig: input.skillConfig ?? {}
    });
    const agentLoop = (this.#factories.agentLoop ?? ((options) => new AgentLoop(options)))({
      runRecorder,
      runtimeRouter,
      toolPlanRunner,
      providerTurnLoop,
      skillPlaybookRunner,
      nativeToolExecutor,
      responseLabel: input.responseLabel,
      intentRouter,
      securityPolicy: input.securityPolicy,
      trajectoryRecorder: input.trajectoryRecorder,
      sessionDb: input.sessionDb,
      sessionId: input.sessionId,
      sessionRuntimeContext,
      profileId: substrate.profileId,
      toolExecutor,
      toolCallPlanner,
      memoryProvider: substrate.memoryProvider,
      memoryPromptContext: substrate.memoryPromptContext,
      memoryRecallOrchestrator,
      sessionCompressionService: input.sessionCompression === "disabled" ? undefined : substrate.sessionCompressionService,
      memoryCurationService,
      compressionConfig: input.sessionCompression === "disabled" ? undefined : substrate.compressionConfig,
      model: routes.model,
      providerPreferences: routes.providerPreferences,
      contextReferenceExpander: substrate.contextReferenceExpander,
      projectContext: input.projectContext ?? substrate.projectContext,
      providerTools: providerToolSchemaCatalog.tools,
      soul: undefined,
      skillsIndex: sessionSkillCatalog,
      skillConfig: input.skillConfig,
      skillLearningManager: input.skillLearningManager,
      skillRouteShadowReranker: routes.assessorRoute === undefined
        ? undefined
        : new LlmSkillRouteShadowReranker({
            providerExecutor: substrate.providerExecutor,
            route: routes.assessorRoute,
            mainRoute: routes.mainRoute
          }),
      skillEvolutionStore: substrate.skillEvolutionStore,
      agentEvolutionPolicy: input.agentEvolutionPolicy,
      ui: input.ui,
      agentProfile: input.agentProfile
    });

    return {
      sessionRuntimeContext,
      toolRegistry,
      toolExecutor,
      toolCallPlanner,
      runRecorder,
      toolPlanRunner,
      providerTurnLoop,
      skillPlaybookRunner,
      nativeToolExecutor,
      runtimeRouter,
      intentRouter,
      agentLoop,
      sessionSkillRegistry,
      sessionSkillCatalog,
      providerTools: providerToolSchemaCatalog.tools,
      providerRoutes: routes,
      delegationManager,
      sessionRecallService,
      memoryFileCompactionService,
      memoryCurationService,
      toolFilterResult
    };
  }

  async cleanupSession(_session: BuiltAgentLoopSession): Promise<void> {
    // Shared substrate lifecycles, including MCP servers, remain owned by createRuntime().
  }
}

export function defaultSkillVisibilityStrategy(input: AgentLoopSkillVisibilityInput): SkillRegistry {
  const skillVisibilityContext = createSkillVisibilityContext({
    availableTools: input.toolAvailability,
    browserAvailable: input.browserAvailable,
    telegramReady: input.telegramReady,
    webEnabled: input.webEnabled,
    platform: input.platform
  });
  const sessionSkillRegistry = new SkillRegistry();
  for (const skill of input.skillRegistry.list()) {
    if (evaluateSkillVisibility(skill, {
      ...skillVisibilityContext,
      lifecycleState: input.skillUsageByName.get(skill.name)?.state
    }).visible) {
      sessionSkillRegistry.register(skill);
    }
  }
  return sessionSkillRegistry;
}

async function applyPythonCapabilityAvailability(input: {
  skillRegistry: SkillRegistry;
  stateRoot: string;
}): Promise<SkillRegistry> {
  const registry = new SkillRegistry();
  for (const skill of input.skillRegistry.list()) {
    const capabilities = skill.pythonCapabilities ?? [];
    if (capabilities.length === 0) {
      registry.register(skill);
      continue;
    }

    const unavailable: Array<{ capability: SkillPythonCapabilityRequirement; result: Exclude<CapabilityPythonEnvResolveResult, { ok: true }> }> = [];
    const setupStatus: SkillPythonCapabilitySetupStatus[] = [];
    for (const capability of capabilities) {
      const result = await resolveCapabilityPythonEnv(capability.id, {
        groups: capability.groups,
        install: false,
        stateRoot: input.stateRoot
      });
      if (!result.ok) {
        unavailable.push({ capability, result });
        setupStatus.push({
          ...capability,
          status: "unavailable",
          reason: result.reason,
          message: result.message,
          repairCommand: result.repairCommand,
          expectedSpecHash: result.expectedSpecHash,
          installedGroups: result.installedGroups
        });
        continue;
      }
      setupStatus.push({
        ...capability,
        status: "available",
        installedGroups: result.installedGroups
      });
    }

    const pythonWarnings = unavailable.map(({ capability, result }) =>
      `${capability.required === false ? "Optional" : "Required"} Python capability '${capability.id}' is unavailable: ${result.reason}${result.repairCommand === undefined ? "" : `; repair with ${result.repairCommand}`}`
    );
    registry.register({
      ...skill,
      pythonCapabilitySetup: setupStatus,
      loadWarnings: [...("loadWarnings" in skill ? skill.loadWarnings ?? [] : []), ...pythonWarnings]
    });
  }
  return registry;
}

function buildRuntimeToolContext(input: RuntimeToolContext): RuntimeToolContext {
  return {
    workspaceRoot: input.workspaceRoot,
    homeDir: input.homeDir,
    profileId: input.profileId,
    cronStore: input.cronStore,
    trustStore: input.trustStore,
    disableCronTools: input.disableCronTools,
    cronRuntimeControls: input.cronRuntimeControls
  };
}

function buildPreSkillVisibilityToolContext(input: SessionToolContext): SessionToolContext {
  return {
    workspaceRoot: input.workspaceRoot,
    profileId: input.profileId,
    sessionId: input.sessionId,
    parentSessionId: input.parentSessionId,
    childSessionId: input.childSessionId,
    currentSessionId: input.currentSessionId,
    homeDir: input.homeDir,
    childProcessEnv: input.childProcessEnv,
    pythonStateRoot: input.pythonStateRoot,
    channelMediaRoot: input.channelMediaRoot,
    audioCacheRoot: input.audioCacheRoot,
    audioTempRoot: input.audioTempRoot,
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
    taskResultService: input.taskResultService,
    sessionDb: input.sessionDb,
    trajectoryRecorder: input.trajectoryRecorder,
    memoryStore: input.memoryStore,
    memoryPersistenceService: input.memoryPersistenceService,
    memoryPersistencePaths: input.memoryPersistencePaths,
    memoryMutationCoordinator: input.memoryMutationCoordinator,
    memoryIndexSync: input.memoryIndexSync,
    memoryRetrievalService: input.memoryRetrievalService,
    memoryFileCompactionService: input.memoryFileCompactionService,
    fileStateTracker: input.fileStateTracker,
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
    delegationConfig: input.delegationConfig,
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

function applyDisabledToolsets(
  registry: ToolRegistry,
  availableTools: ToolDefinition[],
  disabledToolsets: readonly ToolsetName[] | undefined
): void {
  if (disabledToolsets === undefined || disabledToolsets.length === 0) {
    return;
  }

  for (const tool of availableTools) {
    if (tool.toolsets?.some((toolset) => disabledToolsets.includes(toolset))) {
      registry.unregister(tool.name);
    }
  }
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
  setToolsetAvailability(
    availableToolsets,
    "shell-readonly",
    availableTools.has("terminal.inspect") ||
      availableTools.has("terminal.run") ||
      availableTools.has("process.list") ||
      availableTools.has("process.logs")
  );
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

function hasTrajectoryStore(db: SessionDB): db is SessionDB & import("../contracts/trajectory-store.js").TrajectoryStore {
  return typeof (db as { saveTrajectory?: unknown }).saveTrajectory === "function";
}
