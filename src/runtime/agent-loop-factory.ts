import type { ChannelKind } from "../contracts/channel.js";
import type { DelegateRole, DelegationConfig } from "../contracts/delegation.js";
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
import { assessHardlineFloor } from "../security/command-safety.js";
import type { TrajectoryRecorder } from "../trajectory/trajectory-recorder.js";
import { AgentLoop, type AgentLoopInput, type AgentLoopResponse } from "./agent-loop.js";
import {
  AgentLoopBuilder,
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
  handle(input: AgentLoopInput): Promise<AgentLoopResponse>;
  cleanup(): Promise<void>;
};

export type ChildAgentLoopFactory = {
  createChild(input: CreateChildAgentLoopInput): Promise<ChildAgentLoopRuntime>;
};

export type DefaultChildAgentLoopFactoryOptions = {
  builder: AgentLoopBuilder;
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

export class DefaultChildAgentLoopFactory implements ChildAgentLoopFactory {
  readonly #builder: AgentLoopBuilder;
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
      handle: async (handleInput) => await builtSession.agentLoop.handle(handleInput),
      cleanup: async () => {
        await this.#builder.cleanupSession(builtSession);
      }
    };
  }
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
