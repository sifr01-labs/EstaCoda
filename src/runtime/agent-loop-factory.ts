import type { ChannelKind } from "../contracts/channel.js";
import type {
  DelegateModelOverride,
  DelegateModelOverrideMetadata,
  DelegateRole,
  DelegationConfig
} from "../contracts/delegation.js";
import {
  MAX_DELEGATE_MODEL_OVERRIDE_ID_LENGTH,
  MAX_DELEGATE_PROVIDER_OVERRIDE_ID_LENGTH
} from "../contracts/delegation.js";
import type { ModelProfile, ProviderAuthMethod, ProviderEndpoint, ProviderId, ResolvedModelRoute } from "../contracts/provider.js";
import type { SecurityAssessment, SecurityPolicy, SecurityRequest } from "../contracts/security.js";
import { assessSecurityPolicy, capabilityFirstDefaults } from "../contracts/security.js";
import type { SessionDB, SessionRecord } from "../contracts/session.js";
import type { ToolDefinition, ToolsetName } from "../contracts/tool.js";
import { DEFAULT_DELEGATION_CONFIG } from "../config/delegation-defaults.js";
import type { FileStateTracker } from "../delegation/file-state-tracker.js";
import type { AgentEvolutionPolicy } from "../contracts/agent-evolution.js";
import { DelegationManager } from "../delegation/delegation-manager.js";
import type { SubagentRegistry } from "../delegation/subagent-registry.js";
import {
  applyChildToolAccessResult,
  resolveChildToolAccess,
  type ChildToolAccessResult
} from "../delegation/toolset-security.js";
import {
  buildResolvedModelRoute,
  getProviderMetadata,
  validateResolvedRouteForModelSwitch
} from "../providers/provider-metadata.js";
import type { ProviderRegistry } from "../providers/provider-registry.js";
import { resolveRuntimeCredential } from "../providers/runtime-credential-resolver.js";
import { assessHardlineFloor } from "../security/command-safety.js";
import type { TrajectoryRecorder } from "../trajectory/trajectory-recorder.js";
import { AgentLoop, type AgentLoopInput, type AgentLoopResponse } from "./agent-loop.js";
import {
  AgentLoopBuilder,
  type AgentLoopRouteInput,
  type BuiltAgentLoopSession
} from "./agent-loop-builder.js";
import { createSessionRuntimeContext, type SessionRuntimeContext } from "./session-runtime-context.js";

export const CHILD_DELEGATION_CONFIG_VERSION = "delegation.v0.1.0";
export const CHILD_APPROVAL_MODE = "non-interactive-fail-closed";

export type ChildRuntimeFeature =
  | "memoryRecall"
  | "skillLearning"
  | "sessionCompression"
  | "workflowAdapter"
  | "projectContext";

export type CreateChildAgentLoopInput = {
  parentSessionId: string;
  profileId: string;
  task: string;
  context?: string;
  allowedToolsets?: ToolsetName[];
  allowedTools?: string[];
  role?: DelegateRole;
  modelOverride?: DelegateModelOverride;
  depth?: number;
  channel?: ChannelKind;
  trustedWorkspace: boolean;
  parentVisibleTools: readonly ToolDefinition[];
};

export type ChildAgentLoopRuntime = {
  childSession: SessionRecord;
  childSessionId: string;
  sessionRuntimeContext: SessionRuntimeContext;
  builtSession: BuiltAgentLoopSession;
  agentLoop: AgentLoop;
  suppressedRuntimeFeatures: ChildRuntimeFeature[];
  enabledRuntimeFeatures: string[];
  approvalMode: typeof CHILD_APPROVAL_MODE;
  toolAccess: ChildToolAccessResult;
  modelOverride?: DelegateModelOverrideMetadata;
  handle(input: AgentLoopInput): Promise<AgentLoopResponse>;
  cleanup(): Promise<void>;
};

export type ChildAgentLoopFactory = {
  createChild(input: CreateChildAgentLoopInput): Promise<ChildAgentLoopRuntime>;
};

export class ChildModelOverrideError extends Error {
  readonly metadata: DelegateModelOverrideMetadata;

  constructor(message: string, metadata: DelegateModelOverrideMetadata) {
    super(message);
    this.name = "ChildModelOverrideError";
    this.metadata = metadata;
  }
}

export type DefaultChildAgentLoopFactoryOptions = {
  builder: AgentLoopBuilder;
  parentRoutes: AgentLoopRouteInput;
  providerRegistry?: ProviderRegistry;
  providerConfigs?: Record<string, ChildProviderRouteConfig>;
  homeDir?: string;
  sessionDb: SessionDB;
  trajectoryRecorderFactory: (input: { profileId: string; sessionId: string }) => TrajectoryRecorder;
  responseLabel: string;
  workspaceRoot: string;
  delegationConfig?: DelegationConfig;
  skillConfig?: Record<string, Record<string, unknown>>;
  ui?: ConstructorParameters<typeof AgentLoop>[0]["ui"];
  agentProfile?: ConstructorParameters<typeof AgentLoop>[0]["agentProfile"];
  subagentRegistry?: SubagentRegistry;
  diagnosticsRoot?: string;
  fileStateTracker?: FileStateTracker;
  id?: () => string;
};

export type ChildProviderRouteConfig = {
  baseUrl?: string;
  apiKeyEnv?: string;
  apiMode?: ResolvedModelRoute["apiMode"];
  authMethod?: ProviderAuthMethod;
  enableNetwork?: boolean;
  timeoutMs?: number;
  staleTimeoutMs?: number;
};

export class DefaultChildAgentLoopFactory implements ChildAgentLoopFactory {
  readonly #builder: AgentLoopBuilder;
  readonly #parentRoutes: AgentLoopRouteInput;
  readonly #providerRegistry: ProviderRegistry | undefined;
  readonly #providerConfigs: Record<string, ChildProviderRouteConfig> | undefined;
  readonly #homeDir: string | undefined;
  readonly #sessionDb: SessionDB;
  readonly #trajectoryRecorderFactory: (input: { profileId: string; sessionId: string }) => TrajectoryRecorder;
  readonly #responseLabel: string;
  readonly #workspaceRoot: string;
  readonly #delegationConfig: DelegationConfig;
  readonly #skillConfig: Record<string, Record<string, unknown>> | undefined;
  readonly #ui: ConstructorParameters<typeof AgentLoop>[0]["ui"];
  readonly #agentProfile: ConstructorParameters<typeof AgentLoop>[0]["agentProfile"];
  readonly #subagentRegistry: SubagentRegistry | undefined;
  readonly #diagnosticsRoot: string | undefined;
  readonly #fileStateTracker: FileStateTracker | undefined;
  readonly #id: () => string;

  constructor(options: DefaultChildAgentLoopFactoryOptions) {
    this.#builder = options.builder;
    this.#parentRoutes = options.parentRoutes;
    this.#providerRegistry = options.providerRegistry;
    this.#providerConfigs = options.providerConfigs;
    this.#homeDir = options.homeDir;
    this.#sessionDb = options.sessionDb;
    this.#trajectoryRecorderFactory = options.trajectoryRecorderFactory;
    this.#responseLabel = options.responseLabel;
    this.#workspaceRoot = options.workspaceRoot;
    this.#delegationConfig = options.delegationConfig ?? DEFAULT_DELEGATION_CONFIG;
    this.#skillConfig = options.skillConfig;
    this.#ui = options.ui;
    this.#agentProfile = options.agentProfile;
    this.#subagentRegistry = options.subagentRegistry;
    this.#diagnosticsRoot = options.diagnosticsRoot;
    this.#fileStateTracker = options.fileStateTracker;
    this.#id = options.id ?? (() => `child_${crypto.randomUUID()}`);
  }

  async createChild(input: CreateChildAgentLoopInput): Promise<ChildAgentLoopRuntime> {
    const childSessionId = this.#id();
    const depth = input.depth ?? 1;
    const role = input.role ?? "leaf";
    const allowedToolsets = input.allowedToolsets ?? [];
    const allowedTools = input.allowedTools ?? [];
    const modelOverride = await deriveChildRoutes({
      parentRoutes: this.#parentRoutes,
      providerRegistry: this.#providerRegistry,
      providerConfigs: this.#providerConfigs,
      homeDir: this.#homeDir,
      override: input.modelOverride
    });
    const suppressedRuntimeFeatures = suppressedFeaturesFromConfig(this.#delegationConfig);
    const enabledRuntimeFeatures = [
      "agentLoop",
      "providerExecution",
      "toolExecution",
      "mcpToolRegistrations"
    ];
    const trajectoryRecorder = this.#trajectoryRecorderFactory({
      profileId: input.profileId,
      sessionId: childSessionId
    });
    const sessionRuntimeContext = createSessionRuntimeContext(childSessionId);
    let toolAccess: ChildToolAccessResult | undefined;
    let builtSession: BuiltAgentLoopSession | undefined;
    builtSession = await this.#builder.buildSession({
      sessionId: childSessionId,
      parentSessionId: input.parentSessionId,
      sessionRuntimeContext,
      sessionDb: this.#sessionDb,
      trajectoryRecorder,
      skillConfig: this.#skillConfig,
      responseLabel: this.#responseLabel,
      ui: this.#ui,
      agentProfile: this.#agentProfile,
      securityPolicy: createChildFailClosedSecurityPolicy(),
      delegationManagerFactory: () => new DelegationManager({
        sessionDb: this.#sessionDb,
        childFactory: this,
        trajectoryRecorder,
        delegationConfig: this.#delegationConfig,
        currentDepth: depth,
        subagentRegistry: this.#subagentRegistry,
        diagnosticsRoot: this.#diagnosticsRoot,
        fileStateTracker: this.#fileStateTracker,
        parentVisibleTools: () => builtSession?.toolRegistry.list() ?? []
      }),
      trustedWorkspace: async () => input.trustedWorkspace,
      memoryRecall: "disabled",
      sessionCompression: "disabled",
      projectContext: {
        workspaceRoot: this.#workspaceRoot,
        files: [],
        warnings: []
      },
      skillLearningManager: undefined,
      agentEvolutionPolicy: undefined as AgentEvolutionPolicy | undefined,
      providerRoutes: modelOverride.routes,
      toolRegistryFilter: ({ registry, availableTools }) => {
        const result = resolveChildToolAccess({
          parentVisibleTools: input.parentVisibleTools,
          childCandidateTools: availableTools,
          config: this.#delegationConfig,
          request: {
            allowedToolsets,
            allowedTools,
            role,
            depth
          }
        });
        applyChildToolAccessResult(registry, result);
        toolAccess = result;
        return result;
      }
    });
    const effectiveToolAccess = toolAccess ?? {
      effectiveAllowedTools: builtSession.toolRegistry.list().map((tool) => tool.name),
      effectiveAllowedToolsets: [],
      strippedTools: [],
      blockedTools: [],
      rejectedRequestedTools: [],
      rejectedRequestedToolsets: []
    };
    const childSession = await this.#sessionDb.createSession({
      id: childSessionId,
      profileId: input.profileId,
      parentSessionId: input.parentSessionId,
      title: `Delegated: ${input.task.slice(0, 60)}`,
      metadata: {
        kind: "delegated-child",
        parentSessionId: input.parentSessionId,
        role,
        depth,
        allowedToolsets,
        allowedTools,
        effectiveAllowedToolsets: effectiveToolAccess.effectiveAllowedToolsets,
        effectiveAllowedTools: effectiveToolAccess.effectiveAllowedTools,
        strippedTools: effectiveToolAccess.strippedTools,
        blockedTools: effectiveToolAccess.blockedTools,
        rejectedRequestedTools: effectiveToolAccess.rejectedRequestedTools,
        rejectedRequestedToolsets: effectiveToolAccess.rejectedRequestedToolsets,
        modelOverride: modelOverride.metadata,
        delegationConfigVersion: CHILD_DELEGATION_CONFIG_VERSION,
        suppressedRuntimeFeatures,
        enabledRuntimeFeatures,
        approvalMode: CHILD_APPROVAL_MODE,
        workspaceRoot: this.#workspaceRoot,
        context: input.context ?? ""
      }
    });

    return {
      childSession,
      childSessionId: childSession.id,
      sessionRuntimeContext,
      builtSession,
      agentLoop: builtSession.agentLoop,
      suppressedRuntimeFeatures,
      enabledRuntimeFeatures,
      approvalMode: CHILD_APPROVAL_MODE,
      toolAccess: effectiveToolAccess,
      modelOverride: modelOverride.metadata,
      handle: async (handleInput) => await builtSession.agentLoop.handle(handleInput),
      cleanup: async () => {
        await this.#builder.cleanupSession(builtSession);
      }
    };
  }
}

async function deriveChildRoutes(input: {
  parentRoutes: AgentLoopRouteInput;
  providerRegistry: ProviderRegistry | undefined;
  providerConfigs: Record<string, ChildProviderRouteConfig> | undefined;
  homeDir: string | undefined;
  override: DelegateModelOverride | undefined;
}): Promise<{ routes?: AgentLoopRouteInput; metadata?: DelegateModelOverrideMetadata }> {
  if (input.override === undefined) {
    return {};
  }

  const { parentRoutes, override } = input;
  const requestedModel = override.model.trim();
  const parentPrimaryRoute = parentRoutes.primaryModelRoute ?? parentRoutes.mainRoute;
  const parentProvider = parentPrimaryRoute.provider;
  const requestedProvider = (override.provider ?? parentProvider).trim();
  const metadataModel = boundRouteMetadataText(requestedModel);
  const metadataProvider = boundProviderMetadataText(requestedProvider);

  if (requestedModel.length === 0) {
    throw new ChildModelOverrideError("Child model override requires a non-empty model.", {
      requested: true,
      status: "rejected",
      provider: metadataProvider,
      reason: "invalid-model-override"
    });
  }

  if (requestedModel.length > MAX_DELEGATE_MODEL_OVERRIDE_ID_LENGTH) {
    throw new ChildModelOverrideError(`Child model override model must be ${MAX_DELEGATE_MODEL_OVERRIDE_ID_LENGTH} characters or fewer.`, {
      requested: true,
      status: "rejected",
      provider: metadataProvider,
      model: metadataModel,
      reason: "invalid-model-override"
    });
  }

  if (requestedProvider.length === 0) {
    throw new ChildModelOverrideError("Child model override provider must be non-empty when provided.", {
      requested: true,
      status: "rejected",
      reason: "invalid-model-override"
    });
  }

  if (requestedProvider.length > MAX_DELEGATE_PROVIDER_OVERRIDE_ID_LENGTH) {
    throw new ChildModelOverrideError(`Child model override provider must be ${MAX_DELEGATE_PROVIDER_OVERRIDE_ID_LENGTH} characters or fewer.`, {
      requested: true,
      status: "rejected",
      provider: metadataProvider,
      model: metadataModel,
      reason: "invalid-model-override"
    });
  }

  if (requestedProvider !== parentProvider) {
    return await deriveCrossProviderChildRoutes({
      parentRoutes,
      providerRegistry: input.providerRegistry,
      providerConfigs: input.providerConfigs,
      homeDir: input.homeDir,
      requestedProvider,
      requestedModel,
      metadataProvider,
      metadataModel
    });
  }

  const route = cloneRouteForModel(parentPrimaryRoute, requestedModel);
  return {
    routes: {
      ...parentRoutes,
      model: route.profile,
      mainRoute: route,
      primaryModelRoute: route,
      modelFallbackRoutes: [],
      providerPreferences: {
        ...parentRoutes.providerPreferences,
        providerOrder: [parentProvider]
      }
    },
    metadata: {
      requested: true,
      status: "applied",
      provider: parentProvider,
      model: metadataModel,
      fallbackBehavior: "disabled-for-override"
    }
  };
}

async function deriveCrossProviderChildRoutes(input: {
  parentRoutes: AgentLoopRouteInput;
  providerRegistry: ProviderRegistry | undefined;
  providerConfigs: Record<string, ChildProviderRouteConfig> | undefined;
  homeDir: string | undefined;
  requestedProvider: string;
  requestedModel: string;
  metadataProvider: string;
  metadataModel: string;
}): Promise<{ routes: AgentLoopRouteInput; metadata: DelegateModelOverrideMetadata }> {
  const provider = input.requestedProvider as ProviderId;
  const model = input.requestedModel;
  const providerConfig = input.providerConfigs?.[provider];
  if (input.providerConfigs !== undefined && providerConfig === undefined) {
    throw rejectedModelOverride("Child model override provider is not configured.", {
      provider: input.metadataProvider,
      model: input.metadataModel,
      reason: "unknown-provider"
    });
  }
  const adapter = input.providerRegistry?.get(provider);
  if (adapter === undefined) {
    throw rejectedModelOverride("Child model override provider is not registered.", {
      provider: input.metadataProvider,
      model: input.metadataModel,
      reason: "unknown-provider"
    });
  }

  if (adapter.executable === false) {
    throw rejectedModelOverride("Child model override provider is not executable.", {
      provider: input.metadataProvider,
      model: input.metadataModel,
      reason: "provider-not-executable"
    });
  }

  let models: ModelProfile[];
  try {
    models = await adapter.listModels();
  } catch {
    throw rejectedModelOverride("Child model override provider models could not be listed.", {
      provider: input.metadataProvider,
      model: input.metadataModel,
      reason: "provider-not-executable"
    });
  }
  const profile = models.find((candidate) => candidate.provider === provider && candidate.id === model)
    ?? models.find((candidate) => candidate.id === model);
  if (profile === undefined) {
    throw rejectedModelOverride("Child model override model is not registered for the requested provider.", {
      provider: input.metadataProvider,
      model: input.metadataModel,
      reason: "unknown-model"
    });
  }

  const route = buildTargetProviderRoute({
    provider,
    model,
    profile,
    providerConfig,
    adapterEndpoint: adapter.endpoint
  });
  if (providerConfig !== undefined && providerConfig.enableNetwork !== true) {
    throw rejectedModelOverride("Child model override provider network execution is not enabled.", {
      provider: input.metadataProvider,
      model: input.metadataModel,
      reason: "provider-network-disabled"
    });
  }
  const gate = validateResolvedRouteForModelSwitch(route);
  if (!gate.ok) {
    throw rejectedModelOverride("Child model override route is not executable.", {
      provider: input.metadataProvider,
      model: input.metadataModel,
      reason: "invalid-route"
    });
  }
  const credential = await resolveRuntimeCredential({
    providerId: provider,
    route: { apiKeyEnv: route.apiKeyEnv, authMethod: route.authMethod },
    metadata: getProviderMetadata(provider),
    homeDir: input.homeDir
  });
  if (!credential.diagnostic.ok) {
    throw rejectedModelOverride("Child model override provider credentials are not configured.", {
      provider: input.metadataProvider,
      model: input.metadataModel,
      reason: "missing-credentials"
    });
  }

  return {
    routes: {
      ...input.parentRoutes,
      model: route.profile,
      mainRoute: route,
      primaryModelRoute: route,
      modelFallbackRoutes: [],
      providerPreferences: {
        ...input.parentRoutes.providerPreferences,
        providerOrder: [provider]
      }
    },
    metadata: {
      requested: true,
      status: "applied",
      provider: input.metadataProvider,
      model: input.metadataModel,
      fallbackBehavior: "disabled-for-override"
    }
  };
}

function buildTargetProviderRoute(input: {
  provider: ProviderId;
  model: string;
  profile: ModelProfile;
  providerConfig: ChildProviderRouteConfig | undefined;
  adapterEndpoint: ProviderEndpoint | undefined;
}): ResolvedModelRoute {
  const metadata = getProviderMetadata(input.provider);
  const endpoint = input.adapterEndpoint;
  const providerConfig = input.providerConfig;
  const baseUrl = providerConfig?.baseUrl ?? endpoint?.baseUrl ?? metadata.defaultBaseUrl;
  const endpointAuth = endpoint?.apiKey;
  if (endpointAuth?.kind === "literal") {
    throw rejectedModelOverride("Child model override route cannot use literal provider credentials.", {
      provider: boundProviderMetadataText(input.provider),
      model: boundRouteMetadataText(input.model),
      reason: "invalid-route"
    });
  }
  if (endpointAuth?.kind === "none" && providerConfig?.authMethod !== "none" && metadata.defaultAuthMethod !== "none") {
    throw rejectedModelOverride("Child model override provider credentials are not configured.", {
      provider: boundProviderMetadataText(input.provider),
      model: boundRouteMetadataText(input.model),
      reason: "missing-credentials"
    });
  }

  const authMethod: ProviderAuthMethod | undefined = providerConfig?.authMethod
    ?? (endpointAuth?.kind === "none" ? "none" : metadata.defaultAuthMethod);
  const apiKeyEnv = providerConfig?.apiKeyEnv
    ?? (endpointAuth?.kind === "env" ? endpointAuth.name : undefined);
  const profile: ModelProfile = {
    ...input.profile,
    id: input.model,
    provider: input.provider
  };

  return buildResolvedModelRoute({
    provider: input.provider,
    model: input.model,
    profile,
    baseUrl,
    apiKeyEnv,
    apiMode: providerConfig?.apiMode ?? metadata.apiMode,
    authMethod,
    timeoutMs: providerConfig?.timeoutMs,
    staleTimeoutMs: providerConfig?.staleTimeoutMs
  });
}

function cloneRouteForModel(route: ResolvedModelRoute, modelId: string): ResolvedModelRoute {
  const profile: ModelProfile = {
    ...route.profile,
    id: modelId,
    provider: route.provider
  };
  return {
    ...route,
    id: modelId,
    profile
  };
}

function boundRouteMetadataText(value: string): string {
  return value.length <= MAX_DELEGATE_MODEL_OVERRIDE_ID_LENGTH
    ? value
    : `${value.slice(0, MAX_DELEGATE_MODEL_OVERRIDE_ID_LENGTH - " [truncated]".length)} [truncated]`;
}

function boundProviderMetadataText(value: string): string {
  return value.length <= MAX_DELEGATE_PROVIDER_OVERRIDE_ID_LENGTH
    ? value
    : `${value.slice(0, MAX_DELEGATE_PROVIDER_OVERRIDE_ID_LENGTH - " [truncated]".length)} [truncated]`;
}

function rejectedModelOverride(
  message: string,
  metadata: Pick<DelegateModelOverrideMetadata, "provider" | "model" | "reason">
): ChildModelOverrideError {
  return new ChildModelOverrideError(message, {
    requested: true,
    status: "rejected",
    ...metadata
  });
}

export function createChildFailClosedSecurityPolicy(): SecurityPolicy {
  return {
    decide(request) {
      if (hardlineAssessment(request) !== undefined) {
        return "deny";
      }
      const decision = capabilityFirstDefaults.decide(request);
      return decision === "ask" ? "deny" : decision;
    },
    async assess(request) {
      const hardline = hardlineAssessment(request);
      if (hardline !== undefined) {
        return hardline;
      }

      const assessment = await assessSecurityPolicy(capabilityFirstDefaults, request, "strict");
      if (assessment.decision !== "ask") {
        return assessment;
      }

      return {
        ...assessment,
        decision: "deny",
        reason: "Child runtime is non-interactive; approval requests fail closed instead of prompting or consuming parent grants."
      };
    }
  };
}

function hardlineAssessment(request: SecurityRequest): SecurityAssessment | undefined {
  if (request.command === undefined) {
    return undefined;
  }
  const hardBlock = assessHardlineFloor(request.command, {
    environmentType: request.environmentType
  });
  if (hardBlock === undefined) {
    return undefined;
  }
  return {
    decision: "deny",
    mode: "strict",
    reason: hardBlock.reason,
    risk: hardBlock.severity === "critical" || hardBlock.severity === "high" ? "high" : "medium",
    deterministicRule: hardBlock.code
  };
}

function suppressedFeaturesFromConfig(config: DelegationConfig): ChildRuntimeFeature[] {
  const suppressed: ChildRuntimeFeature[] = ["workflowAdapter"];
  if (config.childRuntime.memoryRecall === "disabled") {
    suppressed.push("memoryRecall");
  }
  if (config.childRuntime.skillLearning === "disabled") {
    suppressed.push("skillLearning");
  }
  if (config.childRuntime.sessionCompression === "disabled") {
    suppressed.push("sessionCompression");
  }
  if (config.childRuntime.projectContext === "disabled" || config.childRuntime.projectContext === "bounded") {
    suppressed.push("projectContext");
  }
  return suppressed;
}
