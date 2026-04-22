import type { ModelProfile, ProviderId, ProviderRoute, ProviderRoutePreferences } from "../contracts/provider.js";

export function routeProvider(models: ModelProfile[], preferences: ProviderRoutePreferences = {}): ProviderRoute | undefined {
  const candidates = models
    .filter((model) => matchesPreferences(model, preferences))
    .sort((left, right) => compareModels(left, right, preferences));
  const primary = candidates[0];

  if (primary === undefined) {
    return undefined;
  }

  return {
    primary,
    fallbacks: candidates.slice(1),
    reason: describeRoute(primary, preferences)
  };
}

export function buildFallbackChain(models: ModelProfile[], primary: ModelProfile, preferences: ProviderRoutePreferences = {}): ModelProfile[] {
  return models
    .filter((model) => model.id !== primary.id || model.provider !== primary.provider)
    .filter((model) => matchesPreferences(model, preferences))
    .sort((left, right) => compareModels(left, right, preferences));
}

function matchesPreferences(model: ModelProfile, preferences: ProviderRoutePreferences): boolean {
  if (preferences.providerAllowlist !== undefined && !preferences.providerAllowlist.includes(model.provider)) {
    return false;
  }

  if (preferences.providerBlocklist?.includes(model.provider)) {
    return false;
  }

  if (preferences.requireTools === true && !model.supportsTools) return false;
  if (preferences.requireVision === true && !model.supportsVision) return false;
  if (preferences.requireStructuredOutput === true && !model.supportsStructuredOutput) return false;
  if (preferences.requireReasoning === true && model.supportsReasoning !== true) return false;

  if (
    preferences.maxCostInputPerMillionTokens !== undefined &&
    model.cost?.inputPerMillionTokens !== undefined &&
    model.cost.inputPerMillionTokens > preferences.maxCostInputPerMillionTokens
  ) {
    return false;
  }

  return true;
}

function compareModels(left: ModelProfile, right: ModelProfile, preferences: ProviderRoutePreferences): number {
  const providerOrderScore = scoreProviderOrder(left.provider, preferences.providerOrder) -
    scoreProviderOrder(right.provider, preferences.providerOrder);

  if (providerOrderScore !== 0) return providerOrderScore;

  if (preferences.preferFreeOrOpenWeights === true) {
    const openScore = Number(right.freeOrOpenWeights === true) - Number(left.freeOrOpenWeights === true);
    if (openScore !== 0) return openScore;
  }

  return right.contextWindowTokens - left.contextWindowTokens;
}

function scoreProviderOrder(provider: ProviderId, order: ProviderId[] | undefined): number {
  if (order === undefined) return 0;
  const index = order.indexOf(provider);
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

function describeRoute(primary: ModelProfile, preferences: ProviderRoutePreferences): string {
  const reasons = [`selected ${primary.provider}/${primary.id}`];

  if (preferences.providerOrder !== undefined) reasons.push("provider order applied");
  if (preferences.preferFreeOrOpenWeights === true && primary.freeOrOpenWeights === true) reasons.push("free/open-weights preference matched");
  if (preferences.requireTools === true) reasons.push("tool support required");
  if (preferences.requireVision === true) reasons.push("vision support required");
  if (preferences.requireStructuredOutput === true) reasons.push("structured output required");
  if (preferences.requireReasoning === true) reasons.push("reasoning support required");

  return reasons.join("; ");
}
