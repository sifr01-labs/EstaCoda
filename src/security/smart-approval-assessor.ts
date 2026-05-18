import type { ResolvedAuxiliaryRoute, ResolvedModelRoute } from "../contracts/provider.js";
import type { ProviderExecutor } from "../providers/provider-executor.js";
import { executeAuxiliaryTask } from "../providers/auxiliary-executor.js";

export type SmartApprovalDecision = "APPROVE" | "DENY" | "ESCALATE";

export async function assessCommandRisk(
  command: string,
  options: {
    assessorRoute: ResolvedAuxiliaryRoute;
    mainRoute: ResolvedModelRoute;
    providerExecutor: ProviderExecutor;
    scopeKey: string;
    signal?: AbortSignal;
  }
): Promise<SmartApprovalDecision> {
  try {
    if (options.assessorRoute.task !== "assessor") {
      return "ESCALATE";
    }

    const route: ResolvedAuxiliaryRoute = {
      ...options.assessorRoute,
      fallbackToMain: false
    };
    const execution = await executeAuxiliaryTask({
      route,
      mainRoute: options.mainRoute,
      providerExecutor: options.providerExecutor,
      scopeKey: options.scopeKey,
      preferences: {
        requireStructuredOutput: true,
        providerOrder: undefined
      },
      signal: options.signal,
      request: {
        model: route.route?.id,
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
      return "ESCALATE";
    }

    return parseClassifierDecision(execution.response.content);
  } catch {
    return "ESCALATE";
  }
}

function parseClassifierDecision(content: string): SmartApprovalDecision {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return "ESCALATE";
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return "ESCALATE";
  }

  const record = parsed as Record<string, unknown>;
  const riskScore = record.risk_score;
  if (typeof riskScore !== "number" || !Number.isFinite(riskScore) || riskScore < 0 || riskScore > 100) {
    return "ESCALATE";
  }

  if (typeof record.reasoning !== "string" || record.reasoning.trim().length === 0 || /[\r\n]/u.test(record.reasoning)) {
    return "ESCALATE";
  }

  if (record.confidence !== "high" && record.confidence !== "medium" && record.confidence !== "low") {
    return "ESCALATE";
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
      return "ESCALATE";
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
