import type { ProviderAttempt, ProviderExecutionResult } from "./provider-executor.js";

export function summarizeProviderFailure(execution: ProviderExecutionResult): string {
  if (execution.attempts.length === 0) {
    return "No configured provider route was available for this request.";
  }

  const successfulAttempts = execution.attempts.filter((attempt) => attempt.ok).length;
  const failedAttempts = execution.attempts.filter((attempt) => !attempt.ok);
  const successContext = successfulAttempts === 0
    ? ""
    : ` after ${successfulAttempts} successful provider ${successfulAttempts === 1 ? "call" : "calls"}`;

  if (failedAttempts.length === 0) {
    return `The configured model path did not complete${successContext}. No failed provider attempt was recorded.`;
  }

  const lastFailure = failedAttempts[failedAttempts.length - 1]!;
  const attempts = groupProviderFailures(failedAttempts)
    .map(renderProviderFailureGroup)
    .join(", ");

  return `The configured model path did not complete${successContext}. Last issue: ${lastFailure.provider}/${lastFailure.model} (${humanProviderIssue(lastFailure.errorClass)}). Failed attempts: ${attempts}.`;
}

type ProviderFailureGroup = {
  provider: string;
  model: string;
  issue: string;
  preflight: number;
  dispatched: number;
};

function groupProviderFailures(attempts: ProviderAttempt[]): ProviderFailureGroup[] {
  const groups = new Map<string, ProviderFailureGroup>();

  for (const attempt of attempts) {
    const issue = humanProviderIssue(attempt.errorClass);
    const key = JSON.stringify([attempt.provider, attempt.model, issue]);
    const group = groups.get(key) ?? {
      provider: attempt.provider,
      model: attempt.model,
      issue,
      preflight: 0,
      dispatched: 0
    };
    group[attempt.state] += 1;
    groups.set(key, group);
  }

  return [...groups.values()];
}

function renderProviderFailureGroup(group: ProviderFailureGroup): string {
  const count = group.preflight + group.dispatched;
  if (count === 1) {
    return `${group.provider}/${group.model} (${group.issue}; ${group.preflight === 1 ? "preflight" : "dispatched"})`;
  }

  const states = [
    group.preflight === 0 ? undefined : `${group.preflight} preflight`,
    group.dispatched === 0 ? undefined : `${group.dispatched} dispatched`
  ].filter((state): state is string => state !== undefined).join(", ");
  return `${group.provider}/${group.model} (${group.issue}; ${count} attempts: ${states})`;
}

export function humanProviderIssue(errorClass: string | undefined): string {
  switch (errorClass) {
    case "auth":
      return "authentication needs attention";
    case "rate-limit":
      return "rate limited";
    case "quota":
      return "quota or billing limit";
    case "network":
      return "network issue";
    case "server":
      return "provider server issue";
    case "model-unavailable":
      return "model unavailable";
    case "timeout":
      return "timed out";
    case undefined:
      return "unknown provider issue";
    default:
      return errorClass;
  }
}
