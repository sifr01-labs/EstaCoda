import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DEFAULT_ENVIRONMENT_TYPE, assessSecurityPolicy, type EnvironmentType, type SecurityApprovalMode, type SecurityAssessment, type SecurityPolicy, type SecurityRequest } from "../contracts/security.js";
import type { ResolvedAuxiliaryRoute, ResolvedModelRoute } from "../contracts/provider.js";
import type { ToolRiskClass } from "../contracts/tool.js";
import type { ProviderExecutor } from "../providers/provider-executor.js";
import { assessCommandSafety, assessHardlineFloor } from "./command-safety.js";
import { assessCommandRisk, type SmartApprovalDecision } from "./smart-approval-assessor.js";

export type ApprovalScope = "once" | "session" | "always";

export type EphemeralApprovalGrant = {
  toolName: string;
  riskClass: ToolRiskClass;
  targetKey?: string;
  targetSummary?: string;
  scope: "once" | "session";
};

export type PersistedWorkspaceApprovalGrant = {
  id: string;
  workspaceRoot: string;
  toolName: string;
  riskClass: ToolRiskClass;
  targetKey?: string;
  targetSummary?: string;
  grantedAt: string;
};

type ApprovalFile = {
  version: 1;
  grants: PersistedWorkspaceApprovalGrant[];
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
  assessCommandRisk?: typeof assessCommandRisk;
};

export class WorkspaceApprovalStore {
  readonly #path: string;
  readonly #now: () => Date;
  readonly #idFactory: () => string;

  constructor(options: {
    path?: string;
    now?: () => Date;
    idFactory?: () => string;
  } = {}) {
    this.#path = options.path ?? join(homedir(), ".estacoda", "workspace-approvals.json");
    this.#now = options.now ?? (() => new Date());
    this.#idFactory = options.idFactory ?? (() => `approval-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
  }

  get path(): string {
    return this.#path;
  }

  async listForWorkspace(workspaceRoot: string): Promise<PersistedWorkspaceApprovalGrant[]> {
    const normalizedWorkspaceRoot = resolve(workspaceRoot);
    const file = await this.#read();
    return file.grants.filter((grant) => grant.workspaceRoot === normalizedWorkspaceRoot);
  }

  async grant(input: {
    workspaceRoot: string;
    toolName: string;
    riskClass: ToolRiskClass;
    targetKey?: string;
    targetSummary?: string;
  }): Promise<PersistedWorkspaceApprovalGrant> {
    const normalizedWorkspaceRoot = resolve(input.workspaceRoot);
    const file = await this.#read();
    const existing = file.grants.find((grant) =>
      grant.workspaceRoot === normalizedWorkspaceRoot &&
      grant.toolName === input.toolName &&
      grant.riskClass === input.riskClass &&
      grant.targetKey === input.targetKey &&
      grant.targetSummary === input.targetSummary
    );

    if (existing !== undefined) {
      return existing;
    }

    const grant: PersistedWorkspaceApprovalGrant = {
      id: this.#idFactory(),
      workspaceRoot: normalizedWorkspaceRoot,
      toolName: input.toolName,
      riskClass: input.riskClass,
      targetKey: input.targetKey,
      targetSummary: input.targetSummary,
      grantedAt: this.#now().toISOString()
    };

    file.grants.push(grant);
    file.grants.sort((left, right) => left.grantedAt.localeCompare(right.grantedAt) || left.id.localeCompare(right.id));
    await this.#write(file);

    return grant;
  }

  async revoke(id: string, workspaceRoot: string): Promise<boolean> {
    const normalizedWorkspaceRoot = resolve(workspaceRoot);
    const file = await this.#read();
    const before = file.grants.length;
    file.grants = file.grants.filter((grant) =>
      !(grant.id === id && grant.workspaceRoot === normalizedWorkspaceRoot)
    );

    if (file.grants.length === before) {
      return false;
    }

    await this.#write(file);
    return true;
  }

  async #read(): Promise<ApprovalFile> {
    try {
      const parsed = JSON.parse(await readFile(this.#path, "utf8")) as Partial<ApprovalFile>;
      return {
        version: 1,
        grants: Array.isArray(parsed.grants) ? parsed.grants.filter(isPersistedGrant) : []
      };
    } catch {
      return {
        version: 1,
        grants: []
      };
    }
  }

  async #write(file: ApprovalFile): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true });
    await writeFile(this.#path, `${JSON.stringify(file, null, 2)}\n`, "utf8");
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
  }): Promise<void> {
    if (input.scope === "always") {
      await this.#store.grant({
        workspaceRoot: input.workspaceRoot,
        toolName: input.toolName,
        riskClass: input.riskClass,
        targetKey: input.targetKey,
        targetSummary: input.targetSummary
      });
      return;
    }

    const scopedGrant: EphemeralApprovalGrant = {
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
      session: [...(this.#sessionGrants.get(input.sessionId) ?? [])],
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
    const sessionIndex = sessionGrants.findIndex((grant) => matchesRequest(grant, request));
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
    const persistentGrant = persistent.find((grant) => matchesRequest(grant, request));
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
    scopeKey: smartApproval.scopeKey
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
  grant: Pick<EphemeralApprovalGrant, "toolName" | "riskClass" | "targetKey">,
  request: SecurityRequest
): boolean {
  return grant.toolName === request.toolName &&
    grant.riskClass === request.riskClass &&
    grant.targetKey === request.targetKey;
}

function sameGrant(
  left: Pick<EphemeralApprovalGrant, "toolName" | "riskClass" | "targetKey" | "scope">,
  right: Pick<EphemeralApprovalGrant, "toolName" | "riskClass" | "targetKey" | "scope">
): boolean {
  return left.toolName === right.toolName &&
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
