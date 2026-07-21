import type { ResolvedAuxiliaryRoute, ResolvedModelRoute } from "../contracts/provider.js";
import type { ProviderExecutor } from "../providers/provider-executor.js";
import { executeAuxiliaryTask } from "../providers/auxiliary-executor.js";

export type SmartApprovalDecision = "APPROVE" | "DENY" | "ESCALATE";
export type SmartApprovalStatus = "ok" | "timeout" | "malformed" | "unavailable";

export type SmartApprovalAssessment = {
  decision: SmartApprovalDecision;
  status: SmartApprovalStatus;
  provider?: string;
  model?: string;
};

export async function assessCommandRisk(
  command: string,
  options: {
    assessorRoute: ResolvedAuxiliaryRoute;
    mainRoute: ResolvedModelRoute;
    providerExecutor: ProviderExecutor;
    scopeKey: string;
    executionSessionId?: string;
    signal?: AbortSignal;
  }
): Promise<SmartApprovalDecision> {
  return (await assessCommandRiskDetailed(command, options)).decision;
}

export async function assessCommandRiskDetailed(
  command: string,
  options: {
    assessorRoute: ResolvedAuxiliaryRoute;
    mainRoute: ResolvedModelRoute;
    providerExecutor: ProviderExecutor;
    scopeKey: string;
    executionSessionId?: string;
    signal?: AbortSignal;
  }
): Promise<SmartApprovalAssessment> {
  try {
    if (options.assessorRoute.task !== "assessor") {
      return escalate("unavailable");
    }

    const execution = await executeAuxiliaryTask({
      route: options.assessorRoute,
      mainRoute: options.mainRoute,
      providerExecutor: options.providerExecutor,
      scopeKey: options.scopeKey,
      preferences: {
        requireStructuredOutput: true,
        providerOrder: undefined
      },
      signal: options.signal,
      ...(options.executionSessionId === undefined ? {} : {
        usage: {
          executionSessionId: options.executionSessionId,
        }
      }),
      request: {
        model: options.assessorRoute.route?.id,
        messages: [
          {
            role: "system",
            content: [
              "You are EstaCoda's smart command approval classifier.",
              "Evaluate whether a shell command is safe to execute automatically.",
              "You are not an agent and must not execute tools.",
              "Return JSON only with this schema:",
              "{\"risk_score\":0-100,\"reasoning\":\"one-line explanation\",\"confidence\":\"high|medium|low\"}",
              "Do not include tool calls or extra text."
            ].join("\n")
          },
          {
            role: "user",
            content: JSON.stringify({
              command
            })
          }
        ],
        temperature: 0,
        maxTokens: 160,
        tools: [],
        responseFormat: { type: "json_object" }
      }
    });

    if (!execution.ok || execution.response === undefined) {
      return escalate(execution.status === "timeout" ? "timeout" : "unavailable");
    }

    const decision = parseClassifierDecision(execution.response.content);
    if (decision === undefined) {
      return escalate("malformed", execution.response.provider, execution.response.model);
    }

    return {
      decision,
      status: "ok",
      provider: execution.response.provider,
      model: execution.response.model
    };
  } catch {
    return escalate("unavailable");
  }
}

function escalate(status: SmartApprovalStatus, provider?: string, model?: string): SmartApprovalAssessment {
  return {
    decision: "ESCALATE",
    status,
    provider,
    model
  };
}

function parseClassifierDecision(content: string): SmartApprovalDecision | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return undefined;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }

  const record = parsed as Record<string, unknown>;
  const riskScore = record.risk_score;
  if (typeof riskScore !== "number" || !Number.isFinite(riskScore) || riskScore < 0 || riskScore > 100) {
    return undefined;
  }

  if (typeof record.reasoning !== "string" || record.reasoning.trim().length === 0 || /[\r\n]/u.test(record.reasoning)) {
    return undefined;
  }

  if (record.confidence !== "high" && record.confidence !== "medium" && record.confidence !== "low") {
    return undefined;
  }

  const mapped = decisionForScore(riskScore);
  const explicitDecision = record.decision ?? record.verdict ?? record.classification;
  if (explicitDecision !== undefined) {
    if (typeof explicitDecision !== "string") {
      return "ESCALATE";
    }
    const normalized = explicitDecision.toUpperCase();
    if (
      (normalized !== "APPROVE" && normalized !== "DENY" && normalized !== "ESCALATE") ||
      normalized !== mapped
    ) {
      return undefined;
    }
  }

  return mapped;
}

function decisionForScore(riskScore: number): SmartApprovalDecision {
  if (riskScore <= 30) {
    return "APPROVE";
  }
  if (riskScore <= 60) {
    return "ESCALATE";
  }
  return "DENY";
}
