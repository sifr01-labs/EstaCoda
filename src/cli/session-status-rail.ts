import type { ProviderExecutionSummary } from "../contracts/provider.js";
import type { SessionStatusRailViewModel } from "../contracts/view-model.js";
import type { Runtime } from "../runtime/create-runtime.js";
import type { StatusRailState } from "../ui/papyrus/operator-console/index.js";
import { buildSessionStatusRailViewModel } from "../ui/view-models/builders.js";
import type { SessionRenderer } from "./session-renderer.js";
import type { SessionCostSummary } from "../contracts/usage-cost.js";

export type ContextUsageSnapshot = NonNullable<SessionStatusRailViewModel["contextUsage"]>;
export type RuntimeModelInfo = ReturnType<NonNullable<Runtime["getModelInfo"]>>;
export type StatusRailTimerMode = "idle" | "active-turn" | "last-turn";
export type ProviderServingStatus = "primary" | "fallback" | "failed";

export type ProviderRouteServingState = {
  readonly status: ProviderServingStatus;
  readonly primary?: {
    readonly provider: string;
    readonly model: string;
  };
  readonly actual?: {
    readonly provider: string;
    readonly model: string;
  };
  readonly reason?: string;
};

export type StatusRailTiming = {
  readonly now: () => number;
  readonly sessionStartedAtMs: number;
  readonly mode: StatusRailTimerMode;
  readonly activeTurnStartedAtMs?: number;
  readonly lastCompletedTurnSeconds?: number;
};

export function operatorConsoleStatusRailState(input: {
  runtime: Runtime;
  renderer: SessionRenderer;
  contextUsage?: ContextUsageSnapshot;
  sessionCost?: SessionCostSummary;
  timing?: StatusRailTiming;
  providerExecutionSummary?: ProviderExecutionSummary;
}): StatusRailState {
  const { runtime, timing, providerExecutionSummary } = input;
  const modelInfo = typeof runtime.getModelInfo === "function" ? runtime.getModelInfo() : undefined;
  const configuredModel = configuredModelFromInfo(modelInfo);
  const providerRail = providerExecutionRailState(configuredModel, providerExecutionSummary);
  const contextWindow = modelContextWindow(runtime, modelInfo);
  const sessionElapsedMs = timing === undefined
    ? undefined
    : Math.max(0, timing.now() - timing.sessionStartedAtMs);
  const contextUsage = input.contextUsage ?? (contextWindow !== undefined
    ? { total: contextWindow }
    : undefined);
  const usedTokens = contextUsage?.filled;
  const totalTokens = contextUsage?.total;

  return {
    model: {
      label: providerRail.servingModelLabel ?? providerRail.modelLabel,
      state: providerRail.modelState === "failed" ? "degraded" : timing?.mode === "active-turn" ? "working" : "idle",
      route: providerRailStatusRoute(providerRail.modelState),
    },
    context: {
      ...(usedTokens === undefined ? {} : { usedTokens }),
      ...(totalTokens === undefined ? {} : { totalTokens }),
      ...(usedTokens === undefined || totalTokens === undefined
        ? {}
        : { percent: totalTokens > 0 ? Math.round((usedTokens / totalTokens) * 100) : 0 }),
    },
    sessionTimer: {
      elapsedMs: sessionElapsedMs ?? 0,
      startedAtMs: timing?.sessionStartedAtMs,
    },
    ...(input.sessionCost === undefined ? {} : {
      sessionCost: {
        estimatedCostUsd: input.sessionCost.estimatedCostUsd,
        costComplete: input.sessionCost.costComplete
      }
    }),
    ...(runtime.securityMode?.() === "open"
      ? { security: { yolo: true } }
      : {}),
  };
}

function providerRailStatusRoute(
  modelState: NonNullable<SessionStatusRailViewModel["modelState"]>
): NonNullable<StatusRailState["model"]["route"]> {
  switch (modelState) {
    case "fallback-serving":
      return "fallback";
    case "failed":
      return "failed";
    case "configured":
    case "primary-serving":
      return "primary";
  }
}

export function sessionStatusRailViewModel(input: {
  runtime: Runtime;
  renderer: SessionRenderer;
  contextUsage?: ContextUsageSnapshot;
  sessionCost?: SessionCostSummary;
  timing?: StatusRailTiming;
  providerExecutionSummary?: ProviderExecutionSummary;
}): SessionStatusRailViewModel {
  const modelInfo = typeof input.runtime.getModelInfo === "function" ? input.runtime.getModelInfo() : undefined;
  const configuredModel = configuredModelFromInfo(modelInfo);
  const providerRail = providerExecutionRailState(configuredModel, input.providerExecutionSummary);
  const contextWindow = modelContextWindow(input.runtime, modelInfo);
  const sessionElapsedMs = input.timing === undefined
    ? undefined
    : Math.max(0, input.timing.now() - input.timing.sessionStartedAtMs);
  const currentTurnSeconds = currentTurnSecondsForTiming(input.timing);
  const showTurnState = input.timing === undefined || input.timing.mode === "idle";

  return buildSessionStatusRailViewModel({
    ...providerRail,
    turnState: "idle",
    showTurnState,
    sessionElapsedMs,
    currentTurnSeconds,
    sessionCost: input.sessionCost === undefined ? undefined : {
      estimatedCostUsd: input.sessionCost.estimatedCostUsd,
      costComplete: input.sessionCost.costComplete
    },
    contextUsage: input.contextUsage ?? (contextWindow !== undefined
      ? { total: contextWindow }
      : undefined),
  });
}

export function currentTurnSecondsForTiming(timing: StatusRailTiming | undefined): number | undefined {
  if (timing === undefined) {
    return undefined;
  }
  if (timing.mode === "active-turn" && timing.activeTurnStartedAtMs !== undefined) {
    return elapsedSeconds(timing.activeTurnStartedAtMs, timing.now());
  }
  if (timing.mode === "last-turn") {
    return timing.lastCompletedTurnSeconds;
  }
  return undefined;
}

export function elapsedSeconds(startedAtMs: number, finishedAtMs: number): number {
  return Math.max(0, Math.floor((finishedAtMs - startedAtMs) / 1000));
}

export function configuredModelForRuntime(runtime: Runtime): { provider: string; id: string } | undefined {
  const modelInfo = typeof runtime.getModelInfo === "function" ? runtime.getModelInfo() : undefined;
  const configured = configuredModelFromInfo(modelInfo);
  if (configured.id === "unknown" && configured.provider === undefined) {
    return undefined;
  }
  return {
    provider: configured.provider ?? "unknown",
    id: configured.id,
  };
}

export function configuredModelFromInfo(modelInfo?: RuntimeModelInfo): {
  provider?: string;
  id: string;
  label: string;
} {
  if (modelInfo?.kind !== "kv") {
    return { id: "unknown", label: "unknown" };
  }

  const model = String(modelInfo.entries.find((entry) => entry.key === "model")?.value ?? "unknown");
  const providerValue = modelInfo.entries.find((entry) => entry.key === "provider")?.value;
  const provider = providerValue === undefined ? undefined : String(providerValue);
  return {
    provider,
    id: model,
    label: model,
  };
}

export function providerExecutionRailState(
  configuredModel: { label: string },
  summary?: ProviderExecutionSummary
): {
  modelLabel: string;
  modelState: NonNullable<SessionStatusRailViewModel["modelState"]>;
  configuredModelLabel?: string;
  servingModelLabel?: string;
} {
  if (summary === undefined || summary.status === "not-run") {
    return {
      modelLabel: configuredModel.label,
      modelState: "configured",
    };
  }

  if (summary.status === "failed") {
    return {
      modelLabel: configuredModel.label,
      modelState: "failed",
    };
  }

  if (summary.actual === undefined) {
    return {
      modelLabel: configuredModel.label,
      modelState: "configured",
    };
  }

  return {
    modelLabel: summary.actual.model,
    modelState: summary.status === "fallback-success" ? "fallback-serving" : "primary-serving",
    configuredModelLabel: summary.configuredPrimary?.model,
    servingModelLabel: summary.actual.model,
  };
}

export function providerServingTransitionAlert(
  previous: ProviderRouteServingState | undefined,
  summary: ProviderExecutionSummary
): string | undefined {
  const next = providerServingStateFromSummary(summary);
  if (next === undefined) {
    return undefined;
  }

  if (next.status === "primary") {
    if (previous?.status === "fallback" || previous?.status === "failed") {
      return `primary model available again: ${routeModelLabel(next.actual ?? next.primary)}`;
    }
    return undefined;
  }

  if (next.status === "fallback") {
    if (previous?.status === "failed") {
      return `provider recovered via fallback: ${routeModelLabel(next.actual)}; primary ${routeModelLabel(next.primary)} failed with ${formatProviderFailureReason(next.reason)}`;
    }
    if (previous?.status !== "fallback") {
      return `primary model failed: ${routeModelLabel(next.primary)} ${formatProviderFailureReason(next.reason)}; using fallback ${routeModelLabel(next.actual)}`;
    }
    return undefined;
  }

  if (previous?.status !== "failed") {
    return `provider failed: ${routeModelLabel(next.primary ?? next.actual)} ${formatProviderFailureReason(next.reason)}`;
  }

  return undefined;
}

export function providerServingStateFromSummary(
  summary: ProviderExecutionSummary
): ProviderRouteServingState | undefined {
  if (summary.status === "not-run") {
    return undefined;
  }

  if (summary.status === "failed") {
    const primary = firstProviderSummaryRoute(summary) ?? summary.configuredPrimary;
    return {
      status: "failed",
      primary,
      reason: summary.primaryFailureClass ?? firstProviderFailureReason(summary),
    };
  }

  if (summary.actual === undefined) {
    return undefined;
  }

  if (summary.status === "fallback-success") {
    return {
      status: "fallback",
      primary: firstProviderSummaryRoute(summary) ?? summary.configuredPrimary,
      actual: summary.actual,
      reason: summary.primaryFailureClass ?? firstProviderFailureReason(summary),
    };
  }

  return {
    status: "primary",
    primary: summary.configuredPrimary,
    actual: summary.actual,
  };
}

export function modelContextWindow(
  runtime: Runtime,
  modelInfo = typeof runtime.getModelInfo === "function" ? runtime.getModelInfo() : undefined
): number | undefined {
  const contextWindow = modelInfo?.kind === "kv"
    ? Number(modelInfo.entries.find((e) => e.key === "context window")?.value)
    : Number.NaN;
  return Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : undefined;
}

function firstProviderSummaryRoute(
  summary: ProviderExecutionSummary
): { provider: string; model: string } | undefined {
  const attempt = summary.attempts.find((candidate) => candidate.attemptedRouteIndex === 0) ?? summary.attempts[0];
  return attempt === undefined
    ? undefined
    : {
        provider: attempt.provider,
        model: attempt.model,
      };
}

function firstProviderFailureReason(summary: ProviderExecutionSummary): string | undefined {
  return summary.attempts.find((attempt) => !attempt.ok)?.errorClass;
}

function routeModelLabel(route: { model: string } | undefined): string {
  return route?.model ?? "unknown";
}

function formatProviderFailureReason(reason: string | undefined): string {
  return reason ?? "unknown";
}
