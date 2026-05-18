import type { ChannelKind } from "./channel.js";
import type { ProviderId } from "./provider.js";
import type { ToolRiskClass } from "./tool.js";

export type SecurityDecision = "allow" | "ask" | "deny";
export type SecurityRiskLevel = "low" | "medium" | "high";
export type EnvironmentType =
  | "host"
  | "docker"
  | "singularity"
  | "modal"
  | "daytona"
  | "vercel_sandbox";

export const DEFAULT_ENVIRONMENT_TYPE: EnvironmentType = "host";

const ENVIRONMENT_TYPES = new Set<string>([
  "host",
  "docker",
  "singularity",
  "modal",
  "daytona",
  "vercel_sandbox"
]);

export function isEnvironmentType(value: unknown): value is EnvironmentType {
  return typeof value === "string" && ENVIRONMENT_TYPES.has(value);
}

export type SecurityContext = {
  trustedWorkspace: boolean;
  activeChannel?: ChannelKind;
  targetChannel?: ChannelKind;
  targetConversationIsActive?: boolean;
};

export type SecurityApprovalMode = "strict" | "adaptive" | "open";

export type SecurityAssessorConfig = {
  enabled?: boolean;
  provider?: ProviderId;
  model?: string;
  timeoutMs?: number;
};

export type SecurityRequest = {
  riskClass: ToolRiskClass;
  description: string;
  toolName?: string;
  targetKey?: string;
  targetSummary?: string;
  command?: string;
  environmentType?: EnvironmentType;
  context: SecurityContext;
};

export type SecurityAssessment = {
  decision: SecurityDecision;
  mode: SecurityApprovalMode;
  reason: string;
  risk: SecurityRiskLevel;
  deterministicRule?: string;
  assessor?: {
    used: boolean;
    decision?: SecurityDecision;
    risk?: SecurityRiskLevel;
    reason?: string;
    confidence?: number;
    provider?: string;
    model?: string;
    status?: "ok" | "timeout" | "malformed" | "unavailable" | "disabled" | "hard-block-overrode-assessor";
  };
};

export type SecurityPolicy = {
  decide(request: SecurityRequest): SecurityDecision;
  assess?(request: SecurityRequest): SecurityAssessment | Promise<SecurityAssessment>;
};

export async function assessSecurityPolicy(
  policy: SecurityPolicy,
  request: SecurityRequest,
  fallbackMode: SecurityApprovalMode = "strict"
): Promise<SecurityAssessment> {
  if (policy.assess !== undefined) {
    return await policy.assess(request);
  }

  const decision = policy.decide(request);
  return {
    decision,
    mode: fallbackMode,
    reason: decision === "allow"
      ? "Allowed by security policy."
      : decision === "deny"
        ? "Denied by security policy."
        : "Approval required by security policy.",
    risk: request.riskClass === "destructive-local" ||
      request.riskClass === "credential-access" ||
      request.riskClass === "sandbox-escape" ||
      request.riskClass === "spend-money"
      ? "high"
      : request.riskClass === "workspace-write" ||
          request.riskClass === "external-side-effect" ||
          request.riskClass === "shared-state-mutation"
        ? "medium"
        : "low"
  };
}

export const capabilityFirstDefaults: SecurityPolicy = {
  decide(request) {
    if (request.riskClass === "read-only-local" && request.context.trustedWorkspace) {
      return "allow";
    }

    if (request.riskClass === "read-only-network") {
      return "allow";
    }

    if (request.riskClass === "workspace-write" && request.context.trustedWorkspace) {
      return "allow";
    }

    if (request.riskClass === "shared-state-mutation" && request.context.trustedWorkspace) {
      return "allow";
    }

    if (
      request.riskClass === "external-side-effect" &&
      request.context.targetConversationIsActive
    ) {
      return "allow";
    }

    if (
      request.riskClass === "credential-access" ||
      request.riskClass === "destructive-local" ||
      request.riskClass === "spend-money" ||
      request.riskClass === "sandbox-escape"
    ) {
      return "ask";
    }

    return "ask";
  }
};
