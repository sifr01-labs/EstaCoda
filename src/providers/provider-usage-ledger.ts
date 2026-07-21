import { createHash } from "node:crypto";
import type { ResolvedModelRoute } from "../contracts/provider.js";
import type {
  ProviderUsageEntry,
  ProviderUsageContext,
  ProviderUsageQuery,
  ProviderUsageTotals
} from "../contracts/provider-usage.js";
import type { ProviderPricingSnapshot } from "../contracts/provider-spend.js";
import { assertProviderAttemptState, type ProviderExecutionResult } from "./provider-executor.js";
import { estimateProviderUsage } from "./provider-usage-estimator.js";

export type ProviderUsageTaskAttribution = {
  taskId: string;
  rootTaskId: string;
  planRevisionId: string;
  stepId: string;
  attemptId: string;
  originSessionId?: string;
  originTurnId?: string;
};

export function providerUsageEntriesFromExecution(input: {
  execution: ProviderExecutionResult;
  profileId: string;
  context: ProviderUsageContext;
  routes: readonly ResolvedModelRoute[];
}): ProviderUsageEntry[] {
  assertProviderUsageContext(input.context);
  return input.execution.attempts.flatMap((attempt, providerAttemptIndex) => {
    assertProviderAttemptState(attempt);
    if (attempt.state === "preflight") return [];
    const inferredRouteIndex = input.routes.findIndex((route) =>
      route.provider === attempt.provider && route.id === attempt.model
    );
    if (attempt.routeIndex !== undefined &&
        (!Number.isSafeInteger(attempt.routeIndex) || attempt.routeIndex < 0)) {
      throw new Error("A dispatched provider request has an invalid resolved route index.");
    }
    const routeIndex = input.context.routeIndex ?? attempt.routeIndex ?? Math.max(0, inferredRouteIndex);
    const route = attempt.routeIndex === undefined && inferredRouteIndex < 0
      ? undefined
      : input.routes[attempt.routeIndex ?? Math.max(0, inferredRouteIndex)];
    if (attempt.routeIndex !== undefined &&
        (route?.provider !== attempt.provider || route.id !== attempt.model)) {
      throw new Error("A dispatched provider request does not match its resolved route.");
    }
    const routeRole = input.context.routeRole ?? attempt.routeRole ?? (
      inferredRouteIndex < 0 ? "unknown" as const : routeIndex === 0 ? "primary" as const : "fallback" as const
    );
    const requestIdentity = [input.context.requestKey, String(providerAttemptIndex)].join("\0");
    const requestKey = `sha256:${createHash("sha256").update(requestIdentity).digest("hex")}`;
    const pricing = providerPricingSnapshot(attempt.provider, attempt.model, route);
    return [{
      id: createHash("sha256").update(`${input.profileId}\0${requestKey}`).digest("hex"),
      profileId: input.profileId,
      ...(input.context.executionSessionId === undefined ? {} : { sessionId: input.context.executionSessionId }),
      ...(input.context.sessionBudgetScopeId === undefined ? {} : {
        sessionBudgetScopeId: input.context.sessionBudgetScopeId
      }),
      ...(input.context.visibleTurnId === undefined ? {} : { visibleTurnId: input.context.visibleTurnId }),
      requestKey,
      provider: attempt.provider,
      model: attempt.model,
      routeRole,
      routeIndex,
      providerAttemptIndex,
      sourceKind: input.context.sourceKind,
      ...(input.context.auxiliaryKind === undefined ? {} : { auxiliaryKind: input.context.auxiliaryKind }),
      pricing,
      pricingFingerprint: pricing.fingerprint,
      ...estimateProviderUsage(attempt.usage, route, providerAttemptIndex),
      ...taskAttribution(input.context),
      dispatchedAt: attempt.dispatchedAt
    }];
  });
}

export function createProviderUsageRecorder(input: {
  profileId: string;
  record(entries: readonly ProviderUsageEntry[]): Promise<void>;
}): NonNullable<import("./provider-executor.js").ProviderExecutorOptions["usageRecorder"]> {
  return async ({ execution, context, routes }) => {
    const entries = providerUsageEntriesFromExecution({
      execution,
      profileId: input.profileId,
      context,
      routes
    });
    if (entries.length > 0) await input.record(entries);
  };
}

export function providerUsageTotals(
  entries: readonly ProviderUsageEntry[],
  options: { readonly emptyUsageIsComplete?: boolean } = {}
): ProviderUsageTotals {
  const reasons = new Set(entries.flatMap((entry) => entry.incompleteReasons));
  const emptyComplete = entries.length === 0 && options.emptyUsageIsComplete === true;
  if (entries.length === 0 && !emptyComplete) reasons.add("provider-usage-unavailable");
  return {
    providerCalls: entries.length,
    inputTokens: sum(entries, "inputTokens"),
    outputTokens: sum(entries, "outputTokens"),
    reasoningTokens: sum(entries, "reasoningTokens"),
    cacheReadTokens: sum(entries, "cacheReadTokens"),
    cacheWriteTokens: sum(entries, "cacheWriteTokens"),
    totalTokens: sum(entries, "totalTokens"),
    estimatedCostUsd: entries.reduce((total, entry) => total + entry.estimatedCostUsd, 0),
    usageComplete: emptyComplete || (entries.length > 0 && entries.every((entry) => entry.usageComplete)),
    pricingComplete: emptyComplete || (entries.length > 0 && entries.every((entry) => entry.pricingComplete)),
    incompleteReasons: [...reasons].slice(0, 32)
  };
}

export function providerUsageMatches(entry: ProviderUsageEntry, query: ProviderUsageQuery): boolean {
  return (query.sessionId === undefined || entry.sessionId === query.sessionId) &&
    (query.sessionBudgetScopeId === undefined || entry.sessionBudgetScopeId === query.sessionBudgetScopeId) &&
    (query.visibleTurnId === undefined || entry.visibleTurnId === query.visibleTurnId) &&
    (query.taskId === undefined || entry.taskId === query.taskId) &&
    (query.rootTaskId === undefined || entry.rootTaskId === query.rootTaskId) &&
    (query.attemptId === undefined || entry.attemptId === query.attemptId);
}

function providerPricingSnapshot(
  provider: string,
  model: string,
  route: ResolvedModelRoute | undefined
): ProviderPricingSnapshot {
  const cost = route?.profile.cost;
  const rates = {
    currency: "USD" as const,
    ...(cost?.inputPerMillionTokens === undefined ? {} : { inputPerMillionTokens: cost.inputPerMillionTokens }),
    ...(cost?.outputPerMillionTokens === undefined ? {} : { outputPerMillionTokens: cost.outputPerMillionTokens }),
    ...(cost?.reasoningPerMillionTokens === undefined ? {} : { reasoningPerMillionTokens: cost.reasoningPerMillionTokens }),
    ...(cost?.cacheReadPerMillionTokens === undefined ? {} : { cacheReadPerMillionTokens: cost.cacheReadPerMillionTokens }),
    ...(cost?.cacheWritePerMillionTokens === undefined ? {} : { cacheWritePerMillionTokens: cost.cacheWritePerMillionTokens })
  };
  const fingerprint = `sha256:${createHash("sha256")
    .update(JSON.stringify({ provider, model, ...rates }))
    .digest("hex")}`;
  return { ...rates, fingerprint };
}

function taskAttribution(context: ProviderUsageContext): ProviderUsageTaskAttribution | Record<string, never> {
  if (context.taskId === undefined) return {};
  return {
    taskId: context.taskId,
    rootTaskId: context.rootTaskId!,
    planRevisionId: context.planRevisionId!,
    stepId: context.stepId!,
    attemptId: context.attemptId!
  };
}

function assertProviderUsageContext(context: ProviderUsageContext): void {
  if (context.requestKey.trim().length === 0 || context.requestKey.length > 512) {
    throw new Error("Provider usage request key is invalid.");
  }
  const task = [context.taskId, context.rootTaskId, context.planRevisionId, context.stepId, context.attemptId];
  if (!task.every((value) => value === undefined) && !task.every((value) => value !== undefined)) {
    throw new Error("Provider usage Task attribution must be complete or absent.");
  }
  if (context.sourceKind === "task" && !task.every((value) => value !== undefined)) {
    throw new Error("Task provider usage requires complete leaf attribution.");
  }
  if (context.sourceKind === "auxiliary" && context.auxiliaryKind === undefined) {
    throw new Error("Auxiliary provider usage requires its auxiliary kind.");
  }
  if (context.sourceKind !== "auxiliary" && context.auxiliaryKind !== undefined) {
    throw new Error("Only auxiliary provider usage can declare an auxiliary kind.");
  }
  if (context.visibleTurnId !== undefined &&
      context.executionSessionId === undefined && context.sessionBudgetScopeId === undefined) {
    throw new Error("Provider usage visible-turn attribution requires a Session.");
  }
  if (context.routeIndex !== undefined && (!Number.isSafeInteger(context.routeIndex) || context.routeIndex < 0)) {
    throw new Error("Provider usage route index is invalid.");
  }
}

function sum(
  entries: readonly ProviderUsageEntry[],
  field: "inputTokens" | "outputTokens" | "reasoningTokens" | "cacheReadTokens" | "cacheWriteTokens" | "totalTokens"
): number {
  return entries.reduce((total, entry) => total + entry[field], 0);
}
