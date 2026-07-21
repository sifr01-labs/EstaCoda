import {
  DEFAULT_ENVIRONMENT_TYPE,
  capabilityFirstDefaults,
  type EnvironmentType,
  type SecurityAssessment,
  type SecurityApprovalMode,
  type SecurityAssessorConfig,
  type SecurityDecision,
  type SecurityPolicy,
  type SecurityRequest
} from "../contracts/security.js";
import type { ResolvedAuxiliaryRoute, ResolvedModelRoute } from "../contracts/provider.js";
import { ProviderExecutor } from "../providers/provider-executor.js";
import { assessCommandSafety, assessHardlineFloor, normalizeCommandForSafety } from "./command-safety.js";
import { assessCommandRiskDetailed, type SmartApprovalAssessment } from "./smart-approval-assessor.js";

export function normalizeSecurityApprovalMode(mode: string | undefined): SecurityApprovalMode {
  switch (mode) {
    case "manual":
    case "strict":
      return "strict";
    case "smart":
    case "adaptive":
      return "adaptive";
    case "off":
    case "open":
      return "open";
    default:
      return "adaptive";
  }
}

export function createSecurityPolicyForMode(
  mode: SecurityApprovalMode,
  options: {
    assessor?: SecurityAssessorRuntimeConfig;
  } = {}
): SecurityPolicy {
  const assessor = options.assessor;
  switch (mode) {
    case "open":
      return {
        async assess(request) {
          return assessOpen(request);
        },
        decide(request) {
          return assessOpen(request).decision;
        }
      };
    case "adaptive":
      return {
        async assess(request) {
          return await assessAdaptive(request, assessor);
        },
        decide(request) {
          return assessAdaptiveDeterministic(request).decision;
        }
      };
    case "strict":
    default:
      return {
        async assess(request) {
          return assessStrict(request);
        },
        decide(request) {
          return assessStrict(request).decision;
        }
      };
  }
}

export type SecurityAssessorRuntimeConfig = SecurityAssessorConfig & {
  providerExecutor?: ProviderExecutor;
  sessionId?: string;
  auxiliaryRoute?: ResolvedAuxiliaryRoute;
  mainRoute?: ResolvedModelRoute;
};

function assessStrict(request: SecurityRequest): SecurityAssessment {
  const hardBlock = hardBlockFor(request);
  if (hardBlock !== undefined) {
    return {
      decision: "deny",
      mode: "strict",
      reason: hardBlock.reason,
      risk: "high",
      deterministicRule: hardBlock.code
    };
  }

  const nonHostBypass = nonHostCommandBypassFor(request, "strict");
  if (nonHostBypass !== undefined) {
    return nonHostBypass;
  }

  const decision = capabilityFirstDefaults.decide(request);
  return {
    decision,
    mode: "strict",
    reason: deterministicReason(request, decision, "capability-first"),
    risk: inferRiskLevel(request),
    deterministicRule: "capability-first"
  };
}

async function assessAdaptive(
  request: SecurityRequest,
  assessor: SecurityAssessorRuntimeConfig | undefined
): Promise<SecurityAssessment> {
  const deterministic = assessAdaptiveDeterministic(request);

  if (deterministic.decision !== "ask") {
    return deterministic;
  }

  if (
    assessor?.enabled !== true ||
    assessor.providerExecutor === undefined ||
    assessor.auxiliaryRoute?.route === undefined ||
    assessor.mainRoute === undefined
  ) {
    return {
      ...deterministic,
      assessor: {
        used: false,
        status: assessor?.enabled === true ? "unavailable" : "disabled"
      }
    };
  }

  const assessed = await assessWithAuxiliaryProvider(request, assessor as Required<
    Pick<SecurityAssessorRuntimeConfig, "providerExecutor" | "auxiliaryRoute" | "mainRoute">
  > & SecurityAssessorRuntimeConfig, deterministic);
  return assessed;
}

function assessOpen(request: SecurityRequest): SecurityAssessment {
  const hardBlock = hardBlockFor(request);
  if (hardBlock !== undefined) {
    return {
      decision: "deny",
      mode: "open",
      reason: hardBlock.reason,
      risk: "high",
      deterministicRule: hardBlock.code
    };
  }

  const nonHostBypass = nonHostCommandBypassFor(request, "open");
  if (nonHostBypass !== undefined) {
    return nonHostBypass;
  }

  return {
    decision: "allow",
    mode: "open",
    reason: "Open mode allows this action because it does not match the hard dangerous-command floor.",
    risk: inferRiskLevel(request),
    deterministicRule: "open-default-allow"
  };
}

function assessAdaptiveDeterministic(request: SecurityRequest): SecurityAssessment {
  const hardBlock = hardBlockFor(request);
  if (hardBlock !== undefined) {
    return {
      decision: "deny",
      mode: "adaptive",
      reason: hardBlock.reason,
      risk: "high",
      deterministicRule: hardBlock.code
    };
  }

  if (
    request.riskClass === "credential-access" ||
    request.riskClass === "sandbox-escape" ||
    request.riskClass === "spend-money"
  ) {
    return {
      decision: "deny",
      mode: "adaptive",
      reason: deterministicReason(request, "deny", "hard-risk-class"),
      risk: "high",
      deterministicRule: "hard-risk-class"
    };
  }

  const nonHostBypass = nonHostCommandBypassFor(request, "adaptive");
  if (nonHostBypass !== undefined) {
    return nonHostBypass;
  }

  if (request.riskClass !== "destructive-local") {
    const baseline = capabilityFirstDefaults.decide(request);
    return {
      decision: baseline,
      mode: "adaptive",
      reason: deterministicReason(request, baseline, "capability-first"),
      risk: inferRiskLevel(request),
      deterministicRule: "capability-first"
    };
  }

  if (request.command !== undefined && isLikelyFalsePositive(request.command)) {
    return {
      decision: "allow",
      mode: "adaptive",
      reason: "Adaptive mode auto-approved this command because it matches a known benign false-positive pattern.",
      risk: "low",
      deterministicRule: "benign-false-positive"
    };
  }

  return {
    decision: "ask",
    mode: "adaptive",
    reason: "Adaptive mode could not classify this action confidently from deterministic rules alone.",
    risk: inferRiskLevel(request),
    deterministicRule: "ambiguous-destructive-action"
  };
}

function isLikelyFalsePositive(command: string): boolean {
  const normalized = normalizeCommandForSafety(command);
  return /\b(?:echo|printf|python\s+-c|node\s+-e|bun\s+-e)\b/u.test(normalized) &&
    !/\b(?:rm\s+-rf|sudo|chmod\s+-R|chown\s+-R|mkfs\.|dd\b|shutdown|reboot|halt|poweroff|kill\s+-1)\b/u.test(normalized);
}

function hardBlockFor(request: SecurityRequest): {
  code: string;
  reason: string;
} | undefined {
  const command = request.command ?? request.targetSummary ?? "";
  return assessHardlineFloor(command, { environmentType: environmentTypeFor(request) });
}

function nonHostCommandBypassFor(
  request: SecurityRequest,
  mode: SecurityApprovalMode
): SecurityAssessment | undefined {
  const environmentType = environmentTypeFor(request);
  if (environmentType === "host" || request.command === undefined) {
    return undefined;
  }

  if (request.riskClass !== "destructive-local") {
    return undefined;
  }

  const isolatedAssessment = assessCommandSafety(request.command, { environmentType });
  if (isolatedAssessment.hardBlock !== undefined || isolatedAssessment.riskClass !== undefined) {
    return undefined;
  }

  const hostAssessment = assessCommandSafety(request.command, { environmentType: "host" });
  if (hostAssessment.riskClass !== "destructive-local") {
    return undefined;
  }

  return {
    decision: "allow",
    mode,
    reason: `Allowed because ${environmentType} isolates this non-hardline destructive command from the host.`,
    risk: "medium",
    deterministicRule: "non-host-command-bypass"
  };
}

function environmentTypeFor(request: SecurityRequest): EnvironmentType {
  return request.environmentType ?? DEFAULT_ENVIRONMENT_TYPE;
}

async function assessWithAuxiliaryProvider(
  request: SecurityRequest,
  assessor: Required<Pick<SecurityAssessorRuntimeConfig, "providerExecutor" | "auxiliaryRoute" | "mainRoute">> &
    SecurityAssessorRuntimeConfig,
  deterministic: SecurityAssessment
): Promise<SecurityAssessment> {
  try {
    const route = assessor.auxiliaryRoute;
    const mainRoute = assessor.mainRoute;
    if (route.route === undefined || mainRoute === undefined) {
      return {
        ...deterministic,
        assessor: {
          used: true,
          provider: assessor.provider,
          model: assessor.model,
          status: "unavailable"
        }
      };
    }

    const assessment = await assessCommandRiskDetailed(request.command ?? request.targetSummary ?? request.description, {
      assessorRoute: route,
      mainRoute,
      providerExecutor: assessor.providerExecutor,
      scopeKey: assessor.sessionId ?? "security-policy",
      executionSessionId: assessor.sessionId
    });

    if (assessment.status !== "ok") {
      return {
        ...deterministic,
        assessor: {
          used: true,
          provider: assessment.provider ?? assessor.provider,
          model: assessment.model ?? assessor.model,
          status: assessment.status
        }
      };
    }

    const postAssessorHardBlock = hardBlockFor(request);
    if (postAssessorHardBlock !== undefined) {
      return {
        decision: "deny",
        mode: "adaptive",
        reason: postAssessorHardBlock.reason,
        risk: "high",
        deterministicRule: postAssessorHardBlock.code,
        assessor: {
          used: true,
          ...assessorMetadataFor(assessment),
          status: "hard-block-overrode-assessor"
        }
      };
    }

    return smartAssessmentToSecurityAssessment(assessment, deterministic);
  } catch {
    return {
      ...deterministic,
      assessor: {
        used: true,
        provider: assessor.provider,
        model: assessor.model,
        status: "unavailable"
      }
    };
  }
}

function smartAssessmentToSecurityAssessment(
  assessment: SmartApprovalAssessment,
  deterministic: SecurityAssessment
): SecurityAssessment {
  if (assessment.decision === "APPROVE") {
    return {
      decision: "allow",
      mode: "adaptive",
      reason: "Smart approval classified this command as safe to run automatically.",
      risk: "low",
      deterministicRule: deterministic.deterministicRule,
      assessor: {
        used: true,
        ...assessorMetadataFor(assessment),
        status: "ok"
      }
    };
  }

  if (assessment.decision === "DENY") {
    return {
      decision: "deny",
      mode: "adaptive",
      reason: "Smart approval classified this command as too risky to run.",
      risk: "high",
      deterministicRule: deterministic.deterministicRule,
      assessor: {
        used: true,
        ...assessorMetadataFor(assessment),
        status: "ok"
      }
    };
  }

  return {
    ...deterministic,
    assessor: {
      used: true,
      decision: "ask",
      risk: deterministic.risk,
      provider: assessment.provider,
      model: assessment.model,
      status: assessment.status
    }
  };
}

function assessorMetadataFor(assessment: SmartApprovalAssessment): {
  decision: "allow" | "ask" | "deny";
  risk: "low" | "medium" | "high";
  provider?: string;
  model?: string;
} {
  if (assessment.decision === "APPROVE") {
    return {
      decision: "allow",
      risk: "low",
      provider: assessment.provider,
      model: assessment.model
    };
  }

  if (assessment.decision === "DENY") {
    return {
      decision: "deny",
      risk: "high",
      provider: assessment.provider,
      model: assessment.model
    };
  }

  return {
    decision: "ask",
    risk: "high",
    provider: assessment.provider,
    model: assessment.model
  };
}

function inferRiskLevel(request: SecurityRequest): "low" | "medium" | "high" {
  if (
    request.riskClass === "destructive-local" ||
    request.riskClass === "credential-access" ||
    request.riskClass === "sandbox-escape" ||
    request.riskClass === "spend-money"
  ) {
    return "high";
  }

  if (
    request.riskClass === "workspace-write" ||
    request.riskClass === "shared-state-mutation" ||
    request.riskClass === "external-side-effect"
  ) {
    return "medium";
  }

  return "low";
}

function deterministicReason(
  request: SecurityRequest,
  decision: SecurityDecision,
  rule: string
): string {
  if (rule === "hard-risk-class") {
    return "Adaptive mode denied this action because it falls into a non-overridable high-risk category.";
  }
  if (rule === "capability-first") {
    if (decision === "allow") {
      return "Allowed by skills-first policy for this tool and workspace state.";
    }
    if (decision === "deny") {
      return "Denied by skills-first policy.";
    }
    return "Approval required by skills-first policy.";
  }

  return `Security decision recorded by ${rule}.`;
}
