import type { ProviderRouteRole } from "../contracts/provider.js";
import type {
  SessionContextWindowUsage,
  SessionDB
} from "../contracts/session.js";

const MAX_ROUTE_LABEL_CHARS = 256;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;

export function reconstructSessionContextWindowUsage(
  events: readonly unknown[]
): SessionContextWindowUsage | undefined {
  let latest: SessionContextWindowUsage | undefined;

  for (const event of events) {
    if (!isRecord(event) || event.kind !== "context-window-usage") {
      continue;
    }
    const normalized = normalizeSessionContextWindowUsage(event);
    if (normalized !== undefined) {
      latest = normalized;
    }
  }

  return latest === undefined ? undefined : { ...latest };
}

export async function loadSessionContextWindowUsage(input: {
  sessionDb: SessionDB;
  sessionId: string;
  profileId: string;
}): Promise<SessionContextWindowUsage | undefined> {
  const session = await input.sessionDb.getSession(input.sessionId);
  if (session === undefined || session.profileId !== input.profileId) {
    return undefined;
  }

  return reconstructSessionContextWindowUsage(await input.sessionDb.listEvents(input.sessionId));
}

export function normalizeSessionContextWindowUsage(value: unknown): SessionContextWindowUsage | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const usedTokens = normalizeOptionalNonNegativeInteger(value.usedTokens);
  const totalTokens = normalizeOptionalPositiveInteger(value.totalTokens);
  const provider = normalizeRouteLabel(value.provider);
  const model = normalizeRouteLabel(value.model);
  if (usedTokens === undefined || totalTokens === undefined || provider === undefined || model === undefined) {
    return undefined;
  }

  const routeRole = normalizeProviderRouteRole(value.routeRole);
  return {
    usedTokens,
    totalTokens,
    provider,
    model,
    ...(routeRole === undefined ? {} : { routeRole })
  };
}

function normalizeOptionalNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

function normalizeOptionalPositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

function normalizeRouteLabel(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length === 0 ||
    normalized.length > MAX_ROUTE_LABEL_CHARS ||
    CONTROL_CHARACTER_PATTERN.test(normalized)
    ? undefined
    : normalized;
}

function normalizeProviderRouteRole(value: unknown): ProviderRouteRole | undefined {
  return value === "primary" ||
    value === "fallback" ||
    value === "alias" ||
    value === "override" ||
    value === "unknown"
    ? value
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
