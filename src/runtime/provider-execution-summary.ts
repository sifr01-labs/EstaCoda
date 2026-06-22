import type {
  ProviderAttemptSummary,
  ProviderExecutionSummary
} from "../contracts/provider.js";
import type { ProviderExecutionResult } from "../providers/provider-executor.js";

type ConfiguredModel = {
  provider: string;
  id: string;
};

export function summarizeProviderExecution(input: {
  configuredModel?: ConfiguredModel;
  execution?: ProviderExecutionResult;
}): ProviderExecutionSummary {
  const configuredPrimary = input.configuredModel === undefined
    ? undefined
    : {
        provider: input.configuredModel.provider,
        model: input.configuredModel.id
      };

  if (input.execution === undefined) {
    return {
      configuredPrimary,
      fallbackUsed: false,
      attempts: [],
      status: "not-run"
    };
  }

  const attempts = summarizeAttempts(input.execution);
  const actual = input.execution.ok && input.execution.response !== undefined
    ? {
        provider: input.execution.response.provider,
        model: input.execution.response.model
      }
    : undefined;
  const primaryFailureClass = firstPrimaryFailure(attempts)?.errorClass;

  return {
    configuredPrimary,
    actual,
    fallbackUsed: input.execution.fallbackUsed,
    primaryFailureClass,
    attempts,
    status: executionStatus(input.execution, attempts)
  };
}

export function renderProviderExecutionSummary(summary: ProviderExecutionSummary): string[] {
  switch (summary.status) {
    case "not-run":
      return [];
    case "primary-success":
      return [
        `provider: ${formatRoute(summary.actual)}`,
        "provider primary used"
      ];
    case "fallback-success": {
      const primaryFailure = firstPrimaryFailure(summary.attempts);
      const fallbackLine = primaryFailure === undefined
        ? "provider fallback used"
        : `provider fallback used: ${formatRoute(primaryFailure)} failed with ${formatErrorClass(primaryFailure.errorClass)}`;
      return [
        `provider: ${formatRoute(summary.actual)}`,
        fallbackLine
      ];
    }
    case "failed":
      return [
        `provider failed: ${summary.attempts.map(formatAttemptFailure).join(", ") || "no route"}`
      ];
  }
}

function summarizeAttempts(execution: ProviderExecutionResult): ProviderAttemptSummary[] {
  return execution.attempts.map((attempt, index) => ({
    provider: attempt.provider,
    model: attempt.model,
    ok: attempt.ok,
    ...(attempt.errorClass === undefined ? {} : { errorClass: attempt.errorClass }),
    routeRole: index === 0 ? "primary" : "fallback",
    attemptedRouteIndex: index
  }));
}

function executionStatus(
  execution: ProviderExecutionResult,
  attempts: ProviderAttemptSummary[]
): ProviderExecutionSummary["status"] {
  if (!execution.ok || execution.response === undefined) {
    return "failed";
  }

  const successfulAttemptIndex = attempts.findIndex((attempt) =>
    attempt.ok &&
    attempt.provider === execution.response?.provider &&
    attempt.model === execution.response.model
  );

  if (execution.fallbackUsed || successfulAttemptIndex > 0) {
    return "fallback-success";
  }

  return "primary-success";
}

function firstPrimaryFailure(attempts: ProviderAttemptSummary[]): ProviderAttemptSummary | undefined {
  return attempts.find((attempt) => !attempt.ok && (attempt.routeRole === "primary" || attempt.attemptedRouteIndex === 0));
}

function formatAttemptFailure(attempt: ProviderAttemptSummary): string {
  return `${formatRoute(attempt)}:${formatErrorClass(attempt.errorClass)}`;
}

function formatRoute(route: { provider: string; model: string } | undefined): string {
  return route === undefined ? "unknown/unknown" : `${route.provider}/${route.model}`;
}

function formatErrorClass(errorClass: string | undefined): string {
  return errorClass ?? "unknown";
}
