import type { ModelProfile, ProviderRequest, ResolvedModelRoute } from "../contracts/provider.js";

type OutputLimitRoute = Pick<ResolvedModelRoute, "maxTokens" | "contextWindowTokens" | "profile">;

export function normalizePositiveTokenLimit(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

export function resolveProviderOutputTokenBound(
  request: Pick<ProviderRequest, "maxTokens">,
  route: OutputLimitRoute | undefined,
  fallbackProfile?: ModelProfile
): number | undefined {
  for (const candidate of [
    request.maxTokens,
    route?.maxTokens,
    route?.profile.maxOutputTokens,
    fallbackProfile?.maxOutputTokens,
    route?.contextWindowTokens,
    route?.profile.contextWindowTokens,
    fallbackProfile?.contextWindowTokens
  ]) {
    const normalized = normalizePositiveTokenLimit(candidate);
    if (normalized !== undefined) return normalized;
  }
  return undefined;
}
