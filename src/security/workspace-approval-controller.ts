import { readApprovalFile, updateApprovalFile } from "./approval-file.js";
import { sameReusableAuthority, samePendingAuthority, validApprovalScope, type ApprovalExecutionScope } from "./approval-scope.js";
import { join, resolve } from "node:path";
import { resolveHomeDir } from "../config/home-dir.js";
import { DEFAULT_ENVIRONMENT_TYPE, assessSecurityPolicy, type EnvironmentType, type SecurityApprovalMode, type SecurityAssessment, type SecurityPolicy, type SecurityRequest } from "../contracts/security.js";
import type { ResolvedAuxiliaryRoute, ResolvedModelRoute } from "../contracts/provider.js";
import type { ToolRiskClass } from "../contracts/tool.js";
import type { ProviderExecutor } from "../providers/provider-executor.js";
import { assessCommandSafety, assessHardlineFloor } from "./command-safety.js";
import { assessCommandRisk, type SmartApprovalDecision } from "./smart-approval-assessor.js";
import { dataEgressHardBlock } from "./data-egress-policy.js";

export type ApprovalScope = "once" | "session" | "always";

export type EphemeralApprovalGrant = {
  executionScope?: ApprovalExecutionScope;
  toolName: string;
  riskClass: ToolRiskClass;
  targetKey?: string;
  targetSummary?: string;
  scope: "once" | "session";
};

export type PersistedWorkspaceApprovalGrant = {
  executionScope?: ApprovalExecutionScope;
  authorizationGeneration?: number;
  id: string;
  workspaceRoot: string;
  toolName: string;
  riskClass: ToolRiskClass;
  targetKey?: string;
  targetSummary?: string;
  grantedAt: string;
};

type MatchingGrant = {
  scope: ApprovalScope;
  grant: EphemeralApprovalGrant | PersistedWorkspaceApprovalGrant;
  index?: number;
};

export type SmartApprovalAssessorRuntimeConfig = {
  enabled?: boolean;
  assessorRoute?: ResolvedAuxiliaryRoute;
  mainRoute?: ResolvedModelRoute;
  providerExecutor?: ProviderExecutor;
  scopeKey: string;
  executionSessionId?: string;
  assessCommandRisk?: typeof assessCommandRisk;
};

export class WorkspaceApprovalStore {
  readonly #path: string;
  readonly #now: () => Date;
  readonly #idFactory: () => string;

  constructor(options: {
    path?: string;
    homeDir?: string;
    now?: () => Date;
    idFactory?: () => string;
  } = {}) {
    this.#path = options.path ?? join(resolveHomeDir(options.homeDir), ".estacoda", "workspace-approvals.json");
    this.#now = options.now ?? (() => new Date());
    this.#idFactory = options.idFactory ?? (() => `approval-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
  }

  get path(): string {
    return this.#path;
  }

  async listForWorkspace(workspaceRoot: string): Promise<PersistedWorkspaceApprovalGrant[]> {
    return readApprovalFile(this.#path, isPersistedGrant).grants.filter((grant) => grant.workspaceRoot === resolve(workspaceRoot));
  }

  revision(): number { return readApprovalFile(this.#path, isPersistedGrant).revision; }

  async grant(input: {
    workspaceRoot: string; toolName: string; riskClass: ToolRiskClass;
    targetKey?: string; targetSummary?: string; executionScope?: ApprovalExecutionScope;
  }): Promise<PersistedWorkspaceApprovalGrant> {
    if (input.executionScope !== undefined && !validApprovalScope(input.executionScope)) throw new Error("Invalid approval execution scope.");
    return updateApprovalFile(this.#path, isPersistedGrant, (file) => {
      const workspaceRoot = resolve(input.workspaceRoot);
      const existing = file.grants.find((grant) => grant.workspaceRoot === workspaceRoot && grant.toolName === input.toolName &&
        grant.riskClass === input.riskClass && grant.targetKey === input.targetKey && sameReusableAuthority(grant.executionScope, input.executionScope));
      if (existing) return existing;
      const grant: PersistedWorkspaceApprovalGrant = { ...input, workspaceRoot, id: this.#idFactory(),
        authorizationGeneration: ++file.revision, grantedAt: this.#now().toISOString() };
      file.grants.push(grant);
      return grant;
    });
  }

  async revoke(id: string, workspaceRoot: string): Promise<boolean> {
    return updateApprovalFile(this.#path, isPersistedGrant, (file) => {
      const before = file.grants.length;
      file.grants = file.grants.filter((grant) => !(grant.id === id && grant.workspaceRoot === resolve(workspaceRoot)));
      if (before === file.grants.length) return false;
      file.revision++;
      return true;
    });
  }

}

export class WorkspaceApprovalController {
  readonly #store: WorkspaceApprovalStore;
  readonly #sessionGrants = new Map<string, EphemeralApprovalGrant[]>();

  constructor(options: {
    store?: WorkspaceApprovalStore;
  } = {}) {
    this.#store = options.store ?? new WorkspaceApprovalStore();
  }

  get storePath(): string {
    return this.#store.path;
  }

  async assess(
    basePolicy: SecurityPolicy,
    request: SecurityRequest,
    options: {
      workspaceRoot: string;
      sessionId: string;
      mode: SecurityApprovalMode;
      smartApproval?: SmartApprovalAssessorRuntimeConfig;
    }
  ): Promise<SecurityAssessment> {
    const hardlineBlock = hardlineBlockFor(request);
    if (hardlineBlock !== undefined) {
      return {
        decision: "deny",
        mode: options.mode,
        reason: hardlineBlock.reason,
        risk: "high",
        deterministicRule: hardlineBlock.code,
        assessor: {
          used: false,
          status: "disabled"
        }
      };
    }

    if (!request.context.trustedWorkspace || basePolicy.decide(request) === "deny") {
      return await assessSecurityPolicy(basePolicy, request, options.mode);
    }

    const matched = await this.#findMatchingGrant(request, options);
    if (matched !== undefined) {
      if (matched.scope === "once") {
        const sessionGrants = this.#sessionGrants.get(options.sessionId) ?? [];
        if (matched.index !== undefined) {
          sessionGrants.splice(matched.index, 1);
        }
        if (sessionGrants.length === 0) {
          this.#sessionGrants.delete(options.sessionId);
        } else {
          this.#sessionGrants.set(options.sessionId, sessionGrants);
        }
      }

      return {
        decision: "allow",
        mode: options.mode,
        reason: matched.scope === "always"
          ? "Allowed by a persistent workspace approval grant."
          : matched.scope === "session"
            ? "Allowed by a session approval grant."
            : "Allowed by a one-time approval grant.",
        risk: inferRiskLevel(request.riskClass),
        deterministicRule: matched.scope === "always"
          ? "persistent-workspace-approval"
          : matched.scope === "session"
            ? "session-approval"
            : "one-time-approval",
        assessor: {
          used: false,
          status: "disabled"
        }
      };
    }

    const smartAssessment = await smartAssessmentFor(request, options.mode, options.smartApproval);
    if (smartAssessment !== undefined) {
      return smartAssessment;
    }

    return await assessSecurityPolicy(basePolicy, request, options.mode);
  }

  async grant(input: {
    workspaceRoot: string;
    sessionId: string;
    toolName: string;
    riskClass: ToolRiskClass;
    targetKey?: string;
    targetSummary?: string;
    scope: ApprovalScope;
    executionScope?: ApprovalExecutionScope;
  }): Promise<void> {
    if (input.scope === "always") {
      await this.#store.grant({
        executionScope: input.executionScope,
        workspaceRoot: input.workspaceRoot,
        toolName: input.toolName,
        riskClass: input.riskClass,
        targetKey: input.targetKey,
        targetSummary: input.targetSummary
      });
      return;
    }

    const scopedGrant: EphemeralApprovalGrant = {
      executionScope: input.executionScope === undefined ? undefined : structuredClone(input.executionScope),
      toolName: input.toolName,
      riskClass: input.riskClass,
      targetKey: input.targetKey,
      targetSummary: input.targetSummary,
      scope: input.scope
    };
    const grants = this.#sessionGrants.get(input.sessionId) ?? [];
    if (!grants.some((grant) => sameGrant(grant, scopedGrant))) {
      grants.push(scopedGrant);
      this.#sessionGrants.set(input.sessionId, grants);
    }
  }

  async inspect(input: {
    workspaceRoot: string;
    sessionId: string;
  }): Promise<{
    session: EphemeralApprovalGrant[];
    persistent: PersistedWorkspaceApprovalGrant[];
  }> {
    return {
      session: structuredClone(this.#sessionGrants.get(input.sessionId) ?? []),
      persistent: await this.#store.listForWorkspace(input.workspaceRoot)
    };
  }

  async revokePersistent(input: {
    id: string;
    workspaceRoot: string;
  }): Promise<boolean> {
    return await this.#store.revoke(input.id, input.workspaceRoot);
  }

  preflightGatewayApproval(input: {
    toolName: string;
    commandPreview: string;
    commandPayload?: string;
    environmentType?: EnvironmentType;
  }): SecurityAssessment | undefined {
    const command = input.commandPayload ?? input.commandPreview;
    const hardlineBlock = hardlineBlockFor({
      riskClass: "destructive-local",
      description: "gateway approval request",
      toolName: input.toolName,
      targetSummary: input.commandPreview,
      command,
      environmentType: input.environmentType,
      context: {
        trustedWorkspace: true,
        targetConversationIsActive: false
      }
    });

    if (hardlineBlock === undefined) {
      return undefined;
    }

    return {
      decision: "deny",
      mode: "strict",
      reason: hardlineBlock.reason,
      risk: "high",
      deterministicRule: hardlineBlock.code,
      assessor: {
        used: false,
        status: "hard-block-overrode-assessor"
      }
    };
  }

  async #findMatchingGrant(
    request: SecurityRequest,
    options: {
      workspaceRoot: string;
      sessionId: string;
    }
  ): Promise<MatchingGrant | undefined> {
    const sessionGrants = this.#sessionGrants.get(options.sessionId) ?? [];
    const sessionIndex = sessionGrants.findIndex((grant) => matchesRequest(grant, request) && samePendingAuthority(grant.executionScope, request.executionScope));
    if (sessionIndex >= 0) {
      const grant = sessionGrants[sessionIndex];
      if (grant !== undefined) {
        return {
          scope: grant.scope,
          grant,
          index: sessionIndex
        };
      }
    }

    const persistent = await this.#store.listForWorkspace(options.workspaceRoot);
    const persistentGrant = persistent.find((grant) => Number.isSafeInteger(grant.authorizationGeneration) && grant.authorizationGeneration! > 0 && matchesRequest(grant, request));
    if (persistentGrant !== undefined) {
      return {
        scope: "always",
        grant: persistentGrant
      };
    }

    return undefined;
  }
}

function hardlineBlockFor(request: SecurityRequest): {
  code: string;
  reason: string;
} | undefined {
  const dataEgressBlock = dataEgressHardBlock(request);
  if (dataEgressBlock !== undefined) return dataEgressBlock;
  const command = request.command ?? request.targetSummary ?? "";
  const hardBlock = assessHardlineFloor(command, {
    environmentType: request.environmentType ?? DEFAULT_ENVIRONMENT_TYPE
  });

  return hardBlock !== undefined
    ? { code: hardBlock.code, reason: hardBlock.reason }
    : undefined;
}

async function smartAssessmentFor(
  request: SecurityRequest,
  mode: SecurityApprovalMode,
  smartApproval: SmartApprovalAssessorRuntimeConfig | undefined
): Promise<SecurityAssessment | undefined> {
  if (mode !== "adaptive" || smartApproval?.enabled !== true) {
    return undefined;
  }

  if (
    request.command === undefined ||
    request.riskClass !== "destructive-local" ||
    smartApproval.assessorRoute === undefined ||
    smartApproval.mainRoute === undefined ||
    smartApproval.providerExecutor === undefined
  ) {
    return undefined;
  }

  const commandSafety = assessCommandSafety(request.command, {
    environmentType: request.environmentType ?? DEFAULT_ENVIRONMENT_TYPE
  });
  if (commandSafety.hardBlock === undefined && commandSafety.riskClass !== "destructive-local") {
    return undefined;
  }

  const assess = smartApproval.assessCommandRisk ?? assessCommandRisk;
  const decision = await assess(request.command, {
    assessorRoute: smartApproval.assessorRoute,
    mainRoute: smartApproval.mainRoute,
    providerExecutor: smartApproval.providerExecutor,
    scopeKey: smartApproval.scopeKey,
    executionSessionId: smartApproval.executionSessionId
  });

  return smartDecisionToAssessment(decision, request);
}

function smartDecisionToAssessment(
  decision: SmartApprovalDecision,
  request: SecurityRequest
): SecurityAssessment {
  if (decision === "APPROVE") {
    return {
      decision: "allow",
      mode: "adaptive",
      reason: "Smart approval classified this command as safe to run automatically.",
      risk: "low",
      deterministicRule: "smart-approval",
      assessor: {
        used: true,
        decision: "allow",
        risk: "low",
        status: "ok"
      }
    };
  }

  if (decision === "DENY") {
    return {
      decision: "deny",
      mode: "adaptive",
      reason: "Smart approval classified this command as too risky to run.",
      risk: "high",
      deterministicRule: "smart-approval",
      assessor: {
        used: true,
        decision: "deny",
        risk: "high",
        status: "ok"
      }
    };
  }

  return {
    decision: "ask",
    mode: "adaptive",
    reason: "Smart approval escalated this command for manual approval.",
    risk: inferRiskLevel(request.riskClass),
    deterministicRule: "smart-approval-escalated",
    assessor: {
      used: true,
      decision: "ask",
      risk: inferRiskLevel(request.riskClass),
      status: "ok"
    }
  };
}

function matchesRequest(
  grant: Pick<EphemeralApprovalGrant, "toolName" | "riskClass" | "targetKey" | "executionScope">,
  request: SecurityRequest
): boolean {
  return sameReusableAuthority(grant.executionScope, request.executionScope) &&
    grant.toolName === request.toolName &&
    grant.riskClass === request.riskClass &&
    grant.targetKey === request.targetKey;
}

function sameGrant(
  left: Pick<EphemeralApprovalGrant, "toolName" | "riskClass" | "targetKey" | "scope" | "executionScope">,
  right: Pick<EphemeralApprovalGrant, "toolName" | "riskClass" | "targetKey" | "scope" | "executionScope">
): boolean {
  return samePendingAuthority(left.executionScope, right.executionScope) && left.toolName === right.toolName &&
    left.riskClass === right.riskClass &&
    left.targetKey === right.targetKey &&
    left.scope === right.scope;
}

function inferRiskLevel(riskClass: ToolRiskClass): "low" | "medium" | "high" {
  if (
    riskClass === "destructive-local" ||
    riskClass === "credential-access" ||
    riskClass === "sandbox-escape" ||
    riskClass === "spend-money"
  ) {
    return "high";
  }

  if (
    riskClass === "workspace-write" ||
    riskClass === "external-side-effect" ||
    riskClass === "shared-state-mutation"
  ) {
    return "medium";
  }

  return "low";
}

function isPersistedGrant(value: unknown): value is PersistedWorkspaceApprovalGrant {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Partial<PersistedWorkspaceApprovalGrant>;
  return typeof candidate.id === "string" &&
    typeof candidate.workspaceRoot === "string" &&
    typeof candidate.toolName === "string" &&
    typeof candidate.riskClass === "string" &&
    typeof candidate.grantedAt === "string";
}
