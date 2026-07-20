import { createHash } from "node:crypto";
import type { ResolvedModelRoute } from "../contracts/provider.js";
import type { SessionEvent } from "../contracts/session.js";
import type { TaskAttempt, TaskUsageEntry, TaskUsageTotals } from "../contracts/task.js";
import type { ProviderExecutionResult } from "../providers/provider-executor.js";
import type { AgentLoopRouteInput } from "../runtime/agent-loop-builder.js";

/** Aggregates every finalized provider Attempt in one child turn, including fallbacks and retries. */
export function taskUsageFromAgentResponse(
  execution: ProviderExecutionResult | undefined,
  routes: AgentLoopRouteInput
): TaskUsageTotals {
  const attempts = execution?.attempts ?? [];
  const availableRoutes = routeCatalog(routes);
  let inputTokens = 0;
  let outputTokens = 0;
  let reasoningTokens = 0;
  let totalTokens = 0;
  let estimatedCostUsd = 0;
  let usageComplete = attempts.length > 0;
  let pricingComplete = attempts.length > 0;
  const incompleteReasons = new Set<string>();

  attempts.forEach((attempt, index) => {
    const usage = attempt.usage;
    if (usage === undefined) {
      usageComplete = false;
      pricingComplete = false;
      incompleteReasons.add(`provider-attempt-${index + 1}-usage-missing`);
      return;
    }

    const input = tokenCount(usage.inputTokens);
    const output = tokenCount(usage.outputTokens);
    const reasoning = tokenCount(usage.reasoningTokens) ?? 0;
    const reportedTotal = tokenCount(usage.totalTokens);
    if (input === undefined || output === undefined) {
      usageComplete = false;
      pricingComplete = false;
      incompleteReasons.add(`provider-attempt-${index + 1}-token-breakdown-incomplete`);
    }
    const derivedTotal = (input ?? 0) + (output ?? 0);
    if (reportedTotal === undefined && (input === undefined || output === undefined)) {
      usageComplete = false;
      incompleteReasons.add(`provider-attempt-${index + 1}-total-tokens-missing`);
    }
    if (reportedTotal !== undefined && reportedTotal < derivedTotal) {
      usageComplete = false;
      incompleteReasons.add(`provider-attempt-${index + 1}-total-tokens-invalid`);
    }

    inputTokens += input ?? 0;
    outputTokens += output ?? 0;
    reasoningTokens += reasoning;
    totalTokens += reportedTotal ?? derivedTotal;

    const route = availableRoutes.find((candidate) =>
      candidate.provider === attempt.provider && candidate.id === attempt.model
    );
    const inputRate = price(route?.profile.cost?.inputPerMillionTokens);
    const outputRate = price(route?.profile.cost?.outputPerMillionTokens);
    if ((input ?? 0) > 0) {
      if (inputRate === undefined) {
        pricingComplete = false;
        incompleteReasons.add(`provider-attempt-${index + 1}-input-pricing-missing`);
      } else {
        estimatedCostUsd += ((input ?? 0) / 1_000_000) * inputRate;
      }
    }
    if ((output ?? 0) > 0) {
      if (outputRate === undefined) {
        pricingComplete = false;
        incompleteReasons.add(`provider-attempt-${index + 1}-output-pricing-missing`);
      } else {
        estimatedCostUsd += ((output ?? 0) / 1_000_000) * outputRate;
      }
    }
  });

  if (attempts.length === 0) {
    incompleteReasons.add("provider-usage-unavailable");
  }

  return {
    providerCalls: attempts.length,
    inputTokens,
    outputTokens,
    reasoningTokens,
    totalTokens,
    estimatedCostUsd: roundCost(estimatedCostUsd),
    usageComplete,
    pricingComplete,
    incompleteReasons: [...incompleteReasons].slice(0, 32)
  };
}

export function taskUsageEntriesFromSessionEvents(
  events: readonly SessionEvent[],
  routes: AgentLoopRouteInput,
  context: Pick<TaskAttempt, "profileId" | "taskId" | "planRevisionId" | "stepId" | "id"> & {
    workerSessionId: string;
    occurredAt: string;
  }
): TaskUsageEntry[] {
  const providerEvents = events.filter((event): event is Extract<SessionEvent, {
    kind: "provider-completion" | "provider-continuation";
  }> => event.kind === "provider-completion" || event.kind === "provider-continuation");
  const catalog = routeEntries(routes);
  const entries: TaskUsageEntry[] = [];
  providerEvents.forEach((event, eventIndex) => {
    event.attempts.forEach((attempt, providerAttemptIndex) => {
      const turnId = `${String(eventIndex).padStart(6, "0")}:${event.kind}:${event.iteration ?? eventIndex + 1}`;
      const requestKey = `${context.workerSessionId}:${turnId}:${providerAttemptIndex}`;
      const route = catalog.find((candidate) =>
        candidate.route.provider === attempt.provider && candidate.route.id === attempt.model
      );
      const dispatched = attempt.dispatched ?? (
        attempt.errorClass !== "unsupported" && attempt.errorClass !== "missing-route" && attempt.errorClass !== "auth"
      );
      const totals = usageForAttempt(attempt.usage, route?.route, providerAttemptIndex);
      entries.push({
        id: createHash("sha256").update(`${context.profileId}\0${requestKey}`).digest("hex"),
        profileId: context.profileId,
        taskId: context.taskId,
        planRevisionId: context.planRevisionId,
        stepId: context.stepId,
        attemptId: context.id,
        requestKey,
        turnId,
        providerAttemptIndex,
        provider: attempt.provider,
        model: attempt.model,
        routeRole: route?.role ?? (event.kind === "provider-completion" && event.fallbackUsed ? "fallback" : "primary"),
        routeIndex: route?.index ?? 0,
        dispatched,
        ...totals,
        occurredAt: context.occurredAt
      });
    });
  });
  return entries;
}

export function taskUsageFromEntries(entries: readonly TaskUsageEntry[]): TaskUsageTotals {
  const dispatched = entries.filter((entry) => entry.dispatched);
  const reasons = new Set(dispatched.flatMap((entry) => entry.incompleteReasons));
  if (dispatched.length === 0) reasons.add("provider-usage-unavailable");
  return {
    providerCalls: dispatched.length,
    inputTokens: dispatched.reduce((sum, entry) => sum + entry.inputTokens, 0),
    outputTokens: dispatched.reduce((sum, entry) => sum + entry.outputTokens, 0),
    reasoningTokens: dispatched.reduce((sum, entry) => sum + entry.reasoningTokens, 0),
    totalTokens: dispatched.reduce((sum, entry) => sum + entry.totalTokens, 0),
    estimatedCostUsd: dispatched.reduce((sum, entry) => sum + entry.estimatedCostUsd, 0),
    usageComplete: dispatched.length > 0 && dispatched.every((entry) => entry.usageComplete),
    pricingComplete: dispatched.length > 0 && dispatched.every((entry) => entry.pricingComplete),
    incompleteReasons: [...reasons].slice(0, 32)
  };
}

function usageForAttempt(
  usage: Extract<SessionEvent, { kind: "provider-completion" }>["attempts"][number]["usage"],
  route: ResolvedModelRoute | undefined,
  index: number
): Omit<TaskUsageEntry, "id" | "profileId" | "taskId" | "planRevisionId" | "stepId" | "attemptId" |
  "requestKey" | "turnId" | "providerAttemptIndex" | "provider" | "model" | "routeRole" | "routeIndex" |
  "dispatched" | "occurredAt"> {
  const reasons = new Set<string>();
  const input = tokenCount(usage?.inputTokens);
  const output = tokenCount(usage?.outputTokens);
  const reasoning = tokenCount(usage?.reasoningTokens) ?? 0;
  const reportedTotal = tokenCount(usage?.totalTokens);
  let usageComplete = usage !== undefined && input !== undefined && output !== undefined;
  if (usage === undefined) reasons.add(`provider-attempt-${index + 1}-usage-missing`);
  if (input === undefined || output === undefined) reasons.add(`provider-attempt-${index + 1}-token-breakdown-incomplete`);
  const derivedTotal = (input ?? 0) + (output ?? 0);
  if (reportedTotal !== undefined && reportedTotal < derivedTotal) {
    usageComplete = false;
    reasons.add(`provider-attempt-${index + 1}-total-tokens-invalid`);
  }
  let pricingComplete = usageComplete;
  let estimatedCostUsd = 0;
  const inputRate = price(route?.profile.cost?.inputPerMillionTokens);
  const outputRate = price(route?.profile.cost?.outputPerMillionTokens);
  if ((input ?? 0) > 0) {
    if (inputRate === undefined) {
      pricingComplete = false;
      reasons.add(`provider-attempt-${index + 1}-input-pricing-missing`);
    } else estimatedCostUsd += ((input ?? 0) / 1_000_000) * inputRate;
  }
  if ((output ?? 0) > 0) {
    if (outputRate === undefined) {
      pricingComplete = false;
      reasons.add(`provider-attempt-${index + 1}-output-pricing-missing`);
    } else estimatedCostUsd += ((output ?? 0) / 1_000_000) * outputRate;
  }
  return {
    inputTokens: input ?? 0,
    outputTokens: output ?? 0,
    reasoningTokens: reasoning,
    totalTokens: reportedTotal ?? derivedTotal,
    estimatedCostUsd,
    usageComplete,
    pricingComplete,
    incompleteReasons: [...reasons]
  };
}

function routeEntries(routes: AgentLoopRouteInput): Array<{
  route: ResolvedModelRoute;
  role: "primary" | "fallback";
  index: number;
}> {
  const primary = routes.primaryModelRoute ?? routes.mainRoute;
  return [
    { route: primary, role: "primary" as const, index: 0 },
    ...(routes.modelFallbackRoutes ?? []).map((route, index) => ({
      route,
      role: "fallback" as const,
      index: index + 1
    }))
  ];
}

function routeCatalog(routes: AgentLoopRouteInput): ResolvedModelRoute[] {
  const values = [
    routes.primaryModelRoute,
    routes.mainRoute,
    ...(routes.modelFallbackRoutes ?? [])
  ].filter((route): route is ResolvedModelRoute => route !== undefined);
  const seen = new Set<string>();
  return values.filter((route) => {
    const key = `${route.provider}\u0000${route.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function tokenCount(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : undefined;
}

function price(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function roundCost(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
