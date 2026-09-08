import type { ModelProfile, ProviderId, ProviderRoutePreferences } from "../contracts/provider.js";
import { supportsMultipleImageInputs } from "./model-image-capabilities.js";

export function routeProvider(models: ModelProfile[], preferences: ProviderRoutePreferences = {}): { primary: ModelProfile; fallbacks: ModelProfile[] } | undefined {
  const candidates = models
    .filter((model) => matchesPreferences(model, preferences))
    .sort((left, right) => compareModels(left, right, preferences));
  const primary = candidates[0];

  if (primary === undefined) {
    return undefined;
  }

  return {
    primary,
    fallbacks: candidates.slice(1)
  };
}

export function matchesPreferences(model: ModelProfile, preferences: ProviderRoutePreferences): boolean {
  if (preferences.providerAllowlist !== undefined && !preferences.providerAllowlist.includes(model.provider)) {
    return false;
  }

  if (preferences.providerBlocklist?.includes(model.provider)) {
    return false;
  }

  if (preferences.requireTools === true && !model.supportsTools) return false;
  if (preferences.requireVision === true && !model.supportsVision) return false;
  if (preferences.requireMultipleImages === true && !supportsMultipleImageInputs(model)) return false;
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

export function compareModels(left: ModelProfile, right: ModelProfile, preferences: ProviderRoutePreferences): number {
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
