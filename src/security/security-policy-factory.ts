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
import { executeAuxiliaryTask } from "../providers/auxiliary-executor.js";
import { buildResolvedModelRoute, getProviderMetadata } from "../providers/provider-metadata.js";
import { ProviderExecutor } from "../providers/provider-executor.js";
import { assessCommandSafety, assessHardlineFloor, normalizeCommandForSafety } from "./command-safety.js";

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
  route?: ResolvedModelRoute;
  auxiliaryRoute?: ResolvedAuxiliaryRoute;
  fallbackToMain?: boolean;
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

  const hasExecutableRoute =
    assessor?.auxiliaryRoute?.route !== undefined ||
    assessor?.route !== undefined ||
    buildSecurityAssessorRoute(assessor) !== undefined;

  if (
    assessor?.enabled !== true ||
    assessor.providerExecutor === undefined ||
    !hasExecutableRoute
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
    Pick<SecurityAssessorRuntimeConfig, "provider" | "model" | "providerExecutor">
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
  assessor: Required<Pick<SecurityAssessorRuntimeConfig, "provider" | "model" | "providerExecutor">> &
    SecurityAssessorRuntimeConfig,
  deterministic: SecurityAssessment
): Promise<SecurityAssessment> {
  try {
    const route = buildSecurityAssessorAuxiliaryRoute(assessor);
    const mainRoute = assessor.mainRoute ?? route.route ?? buildSecurityAssessorRoute(assessor);
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

    const execution = await executeAuxiliaryTask({
      route,
      mainRoute,
      providerExecutor: assessor.providerExecutor,
      preferences: {
        requireStructuredOutput: true,
        providerOrder: undefined
      },
      request: {
        model: route.route.id,
        messages: [
          {
            role: "system",
            content: [
              "You are EstaCoda's security assessor.",
              "Return JSON only.",
              "Schema:",
              "{\"decision\":\"allow|ask|deny\",\"risk\":\"low|medium|high\",\"reason\":\"...\",\"confidence\":0.0}",
              "Never override a hard destructive-command floor."
            ].join("\n")
          },
          {
            role: "user",
            content: JSON.stringify({
              riskClass: request.riskClass,
              toolName: request.toolName,
              targetKey: request.targetKey,
              targetSummary: request.targetSummary,
              command: request.command,
              environmentType: request.environmentType ?? DEFAULT_ENVIRONMENT_TYPE,
              trustedWorkspace: request.context.trustedWorkspace,
              activeChannel: request.context.activeChannel,
              targetChannel: request.context.targetChannel,
              targetConversationIsActive: request.context.targetConversationIsActive
            })
          }
        ],
        temperature: 0,
        maxTokens: 200,
        responseFormat: { type: "json_object" }
      }
    });

    if (!execution.ok || execution.response === undefined) {
      return {
        ...deterministic,
        assessor: {
          used: true,
          provider: assessor.provider,
          model: assessor.model,
          status: execution.status === "timeout" ? "timeout" : "unavailable"
        }
      };
    }

    const parsed = parseAssessorResponse(execution.response.content);
    if (parsed === undefined) {
      return {
        ...deterministic,
        assessor: {
          used: true,
          provider: execution.response.provider,
          model: execution.response.model,
          status: "malformed"
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
          decision: parsed.decision,
          risk: parsed.risk,
          reason: parsed.reason,
          confidence: parsed.confidence,
          provider: execution.response.provider,
          model: execution.response.model,
          status: "hard-block-overrode-assessor"
        }
      };
    }

    return {
      decision: parsed.decision,
      mode: "adaptive",
      reason: parsed.reason,
      risk: parsed.risk,
      deterministicRule: deterministic.deterministicRule,
      assessor: {
        used: true,
        decision: parsed.decision,
        risk: parsed.risk,
        reason: parsed.reason,
        confidence: parsed.confidence,
        provider: execution.response.provider,
        model: execution.response.model,
        status: "ok"
      }
    };
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

function buildSecurityAssessorAuxiliaryRoute(assessor: SecurityAssessorRuntimeConfig): ResolvedAuxiliaryRoute {
  if (assessor.auxiliaryRoute !== undefined) {
    return assessor.auxiliaryRoute;
  }

  const route = buildSecurityAssessorRoute(assessor);
  return {
    task: "assessor",
    route,
    source: route === undefined ? "disabled" : assessor.route !== undefined ? "explicit" : "custom",
    fallbackToMain: assessor.fallbackToMain === true,
    timeoutMs: assessor.timeoutMs,
    diagnostics: route === undefined ? ["No security assessor route configured"] : []
  };
}

function buildSecurityAssessorRoute(
  assessor: Pick<SecurityAssessorRuntimeConfig, "provider" | "model" | "route"> | undefined
): ResolvedModelRoute | undefined {
  if (assessor?.route !== undefined) {
    return assessor.route;
  }
  if (assessor?.provider === undefined || assessor.model === undefined) {
    return undefined;
  }

  const metadata = getProviderMetadata(assessor.provider);
  if (!metadata.runnable || metadata.defaultBaseUrl === undefined) {
    return undefined;
  }

  return buildResolvedModelRoute({
    provider: assessor.provider,
    model: assessor.model,
    profile: {
      id: assessor.model,
      provider: assessor.provider,
      contextWindowTokens: 128_000,
      supportsTools: true,
      supportsVision: false,
      supportsStructuredOutput: true
    },
    baseUrl: metadata.defaultBaseUrl,
    apiKeyEnv: metadata.defaultApiKeyEnv
  });
}

function parseAssessorResponse(content: string): {
  decision: SecurityDecision;
  risk: "low" | "medium" | "high";
  reason: string;
  confidence?: number;
} | undefined {
  const match = content.match(/\{[\s\S]*\}/u);
  if (match === null) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(match[0]) as Record<string, unknown>;
    const decision = parsed.decision;
    const risk = parsed.risk;
    const reason = parsed.reason;
    const confidence = parsed.confidence;

    if (
      (decision !== "allow" && decision !== "ask" && decision !== "deny") ||
      (risk !== "low" && risk !== "medium" && risk !== "high") ||
      typeof reason !== "string"
    ) {
      return undefined;
    }

    return {
      decision,
      risk,
      reason,
      confidence: typeof confidence === "number" ? confidence : undefined
    };
  } catch {
    return undefined;
  }
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
