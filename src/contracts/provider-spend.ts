import type { ProviderRouteRole } from "./provider.js";

export type ProviderPricingSnapshot = {
  currency: "USD";
  inputPerMillionTokens?: number;
  outputPerMillionTokens?: number;
  reasoningPerMillionTokens?: number;
  cacheReadPerMillionTokens?: number;
  cacheWritePerMillionTokens?: number;
  fingerprint: string;
};

export type ProviderSpendRequest = {
  requestKey: string;
  profileId: string;
  executionSessionId?: string;
  sessionBudgetScopeId?: string;
  visibleTurnId?: string;
  taskId?: string;
  rootTaskId?: string;
  planRevisionId?: string;
  stepId?: string;
  attemptId?: string;
  sourceKind: "main" | "task" | "auxiliary";
  auxiliaryKind?: string;
  provider: string;
  model: string;
  routeRole: ProviderRouteRole;
  routeIndex: number;
  providerAttemptIndex: number;
  pricing: ProviderPricingSnapshot;
  estimatedInputTokens: number;
  boundedMaximumOutputTokens: number;
  boundedMaximumReasoningTokens?: number;
  maximumEstimatedCostUsd: number;
};

export type ProviderSpendState =
  | "reserved"
  | "dispatching"
  | "settled"
  | "released"
  | "uncertain";

const ROUTE_ROLES = new Set<ProviderRouteRole>(["primary", "fallback", "alias", "override", "unknown"]);
const SOURCE_KINDS = new Set<ProviderSpendRequest["sourceKind"]>(["main", "task", "auxiliary"]);

/** Fails closed before a spend envelope reaches reservation or persistence. */
export function assertProviderSpendRequest(request: ProviderSpendRequest): void {
  requireText(request.requestKey, "request key", 512);
  requireText(request.profileId, "profile ID", 128);
  optionalText(request.executionSessionId, "execution Session ID", 256);
  optionalText(request.sessionBudgetScopeId, "session budget scope ID", 256);
  optionalText(request.visibleTurnId, "visible turn ID", 512);
  optionalText(request.auxiliaryKind, "auxiliary kind", 128);
  if (!SOURCE_KINDS.has(request.sourceKind)) throw new Error("Provider spend source kind is invalid.");
  requireText(request.provider, "provider", 128);
  requireText(request.model, "model", 256);
  if (!ROUTE_ROLES.has(request.routeRole)) throw new Error("Provider spend route role is invalid.");
  requireCount(request.routeIndex, "route index");
  requireCount(request.providerAttemptIndex, "provider Attempt index");
  requireCount(request.estimatedInputTokens, "estimated input tokens");
  requireCount(request.boundedMaximumOutputTokens, "bounded maximum output tokens");
  if (request.boundedMaximumReasoningTokens !== undefined) {
    requireCount(request.boundedMaximumReasoningTokens, "bounded maximum reasoning tokens");
  }
  if (!Number.isFinite(request.maximumEstimatedCostUsd) || request.maximumEstimatedCostUsd < 0) {
    throw new Error("Provider spend maximum estimated cost must be a non-negative finite amount.");
  }
  assertPricingSnapshot(request.pricing);

  if ((request.sessionBudgetScopeId !== undefined || request.visibleTurnId !== undefined) &&
      request.executionSessionId === undefined) {
    throw new Error("Provider spend Session attribution requires an execution Session.");
  }
  const taskValues = [
    request.taskId,
    request.rootTaskId,
    request.planRevisionId,
    request.stepId,
    request.attemptId
  ];
  taskValues.forEach((value, index) => optionalText(value, [
    "Task ID",
    "root Task ID",
    "PlanRevision ID",
    "Step ID",
    "Attempt ID"
  ][index]!, 256));
  const hasTaskAttribution = taskValues.every((value) => value !== undefined);
  if (!taskValues.every((value) => value === undefined) && !hasTaskAttribution) {
    throw new Error("Provider spend Task attribution must be complete or absent.");
  }
  if (request.sourceKind === "task" && (!hasTaskAttribution || request.executionSessionId === undefined)) {
    throw new Error("Task provider spend requires complete leaf attribution and an execution Session.");
  }
  if (request.sourceKind === "auxiliary") {
    if (request.auxiliaryKind === undefined) throw new Error("Auxiliary provider spend requires its auxiliary kind.");
  } else if (request.auxiliaryKind !== undefined) {
    throw new Error("Only auxiliary provider spend can declare an auxiliary kind.");
  }
}

function assertPricingSnapshot(pricing: ProviderPricingSnapshot): void {
  if (pricing.currency !== "USD") throw new Error("Provider pricing snapshot currency must be USD.");
  requireText(pricing.fingerprint, "pricing fingerprint", 256);
  for (const [label, rate] of [
    ["input", pricing.inputPerMillionTokens],
    ["output", pricing.outputPerMillionTokens],
    ["reasoning", pricing.reasoningPerMillionTokens],
    ["cache read", pricing.cacheReadPerMillionTokens],
    ["cache write", pricing.cacheWritePerMillionTokens]
  ] as const) {
    if (rate !== undefined && (!Number.isFinite(rate) || rate < 0)) {
      throw new Error(`Provider pricing snapshot ${label} rate must be non-negative and finite.`);
    }
  }
}

function requireCount(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Provider spend ${label} is invalid.`);
}

function optionalText(value: string | undefined, label: string, max: number): void {
  if (value !== undefined) requireText(value, label, max);
}

function requireText(value: string, label: string, max: number): void {
  if (value.trim().length === 0 || value.length > max) throw new Error(`Provider spend ${label} is invalid.`);
}
