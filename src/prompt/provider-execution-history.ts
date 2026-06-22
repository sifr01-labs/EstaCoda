import type {
  ProviderAttemptSummary,
  ProviderExecutionSummary
} from "../contracts/provider.js";

export function sanitizeProviderExecutionMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (metadata === undefined) {
    return undefined;
  }

  const sanitized = sanitizeProviderExecutionSummary(metadata.providerExecution);
  if (sanitized === undefined) {
    return undefined;
  }

  return {
    providerExecution: sanitized
  };
}

function sanitizeProviderExecutionSummary(value: unknown): ProviderExecutionSummary | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const status = readExecutionStatus(value.status);
  const fallbackUsed = typeof value.fallbackUsed === "boolean" ? value.fallbackUsed : undefined;
  const attemptsValue = Array.isArray(value.attempts) ? value.attempts : undefined;
  if (status === undefined || fallbackUsed === undefined || attemptsValue === undefined) {
    return undefined;
  }

  const configuredPrimary = readRoute(value.configuredPrimary);
  const actual = readRoute(value.actual);
  const attempts = attemptsValue.map(readAttemptSummary).filter((attempt) => attempt !== undefined);

  return {
    ...(configuredPrimary === undefined ? {} : { configuredPrimary }),
    ...(actual === undefined ? {} : { actual }),
    fallbackUsed,
    ...(typeof value.primaryFailureClass === "string" ? { primaryFailureClass: value.primaryFailureClass } : {}),
    attempts,
    status
  };
}

function readAttemptSummary(value: unknown): ProviderAttemptSummary | undefined {
  if (!isRecord(value) || typeof value.provider !== "string" || typeof value.model !== "string" || typeof value.ok !== "boolean") {
    return undefined;
  }
  const provider = safeProviderToken(value.provider);
  const model = safeLabelToken(value.model);
  if (provider === undefined || model === undefined) {
    return undefined;
  }

  return {
    provider,
    model,
    ok: value.ok,
    ...(safeLabelToken(value.errorClass) === undefined ? {} : { errorClass: safeLabelToken(value.errorClass) }),
    ...(value.routeRole === "primary" || value.routeRole === "fallback" ? { routeRole: value.routeRole } : {}),
    ...(typeof value.attemptedRouteIndex === "number" ? { attemptedRouteIndex: value.attemptedRouteIndex } : {})
  };
}

function readRoute(value: unknown): { provider: string; model: string } | undefined {
  if (!isRecord(value) || typeof value.provider !== "string" || typeof value.model !== "string") {
    return undefined;
  }
  const provider = safeProviderToken(value.provider);
  const model = safeLabelToken(value.model);
  if (provider === undefined || model === undefined) {
    return undefined;
  }

  return {
    provider,
    model
  };
}

function readExecutionStatus(value: unknown): ProviderExecutionSummary["status"] | undefined {
  return value === "not-run" || value === "primary-success" || value === "fallback-success" || value === "failed"
    ? value
    : undefined;
}

function safeProviderToken(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,80}$/u.test(value) ? value : undefined;
}

function safeLabelToken(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,120}$/u.test(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
