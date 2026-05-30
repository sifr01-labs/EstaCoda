import type { ProviderId, ProviderApiMode, ResolvedModelRoute, ModelProfile } from "../contracts/provider.js";
import { normalizeOptionalPositiveIntegerStrict, type EstaCodaConfig, type ModelAliasDefinition } from "../config/runtime-config.js";
import { getProviderMetadata, providerRequiresBaseUrl } from "./provider-metadata.js";
import type { ModelSelectionCatalog } from "./model-selection-catalog.js";
import { inferModelProfile, fallbackKnownModelProfiles, inferProviderFromModel } from "./model-catalog.js";

export type NormalizedModelInput =
  | {
      kind: "exact";
      route: ResolvedModelRoute;
      resolvedViaAlias?: string;
    }
  | {
      kind: "ambiguous";
      candidates: Array<{ provider: ProviderId; model: string }>;
      reason: string;
    }
  | {
      kind: "unknown";
      input: string;
      reason: string;
    };

export type NormalizeModelInputOptions = {
  config: EstaCodaConfig;
  catalog?: ModelSelectionCatalog;
};

const CURATED_ALIASES: Record<string, { vendor: ProviderId; family: string }> = {
  sonnet:   { vendor: "anthropic", family: "claude-sonnet" },
  opus:     { vendor: "anthropic", family: "claude-opus" },
  gpt4:     { vendor: "openai",    family: "gpt-4" },
  gpt5:     { vendor: "openai",    family: "gpt-5" },
  kimi:     { vendor: "kimi",      family: "kimi" },
  deepseek: { vendor: "deepseek",  family: "deepseek" },
  gemini:   { vendor: "google",    family: "gemini" },
  or:       { vendor: "openrouter", family: "openrouter" }
};

/**
 * Resolve user model input to an exact route before config/session/runtime use.
 *
 * Resolution priority:
 * 1. Exact provider/model route input
 * 2. Direct user aliases from config
 * 3. Curated aliases against catalog/fallback-known models
 * 4. Ambiguous catalog/provider resolver
 */
export async function normalizeModelInput(
  input: string,
  options: NormalizeModelInputOptions
): Promise<NormalizedModelInput> {
  const trimmed = input.trim();

  if (trimmed.includes("/")) {
    return resolveExactRoute(trimmed, options);
  }

  const direct = resolveDirectAlias(trimmed, options.config);
  if (direct !== undefined) {
    return direct;
  }

  const curated = await resolveCuratedAlias(trimmed, options);
  if (curated !== undefined) {
    return curated;
  }

  return resolveAmbiguousModel(trimmed, options);
}

// ── Exact route ─────────────────────────────────────────────────────────────

function resolveExactRoute(
  input: string,
  options: NormalizeModelInputOptions
): NormalizedModelInput {
  const slashIndex = input.indexOf("/");
  const provider = input.slice(0, slashIndex) as ProviderId;
  const model = input.slice(slashIndex + 1);

  if (provider.length === 0 || model.length === 0) {
    return { kind: "unknown", input, reason: "Invalid route format. Use provider/model." };
  }

  const meta = getProviderMetadata(provider);
  const baseUrl = options.config.providers?.[provider]?.baseUrl ?? meta.defaultBaseUrl;
  const apiMode = (options.config.providers?.[provider] as { apiMode?: ProviderApiMode } | undefined)?.apiMode ?? meta.apiMode;

  const profile = inferModelProfile({ provider, model });

  return {
    kind: "exact",
    route: {
      provider,
      id: model,
      profile,
      baseUrl,
      apiKeyEnv: meta.defaultApiKeyEnv,
      contextWindowTokens: profile.contextWindowTokens,
      apiMode
    }
  };
}

// ── Direct alias ────────────────────────────────────────────────────────────

function resolveDirectAlias(
  input: string,
  config: EstaCodaConfig
): NormalizedModelInput | undefined {
  const aliases = config.modelAliases ?? config.model_aliases;
  if (aliases === undefined) {
    return undefined;
  }

  const alias = aliases[input];
  if (alias === undefined) {
    return undefined;
  }

  if (!alias.provider || !alias.model) {
    return {
      kind: "unknown",
      input,
      reason: `Alias '${input}' in config is missing required fields (provider, model).`
    };
  }

  const meta = getProviderMetadata(alias.provider as ProviderId);
  const baseUrl = alias.baseUrl ?? meta.defaultBaseUrl;
  const apiMode = (alias.apiMode as ProviderApiMode | undefined) ?? meta.apiMode;
  const apiKeyEnv = alias.apiKeyEnv ?? meta.defaultApiKeyEnv;
  const maxTokens = normalizeOptionalPositiveIntegerStrict(
    (alias as Record<string, unknown>).maxTokens,
    `modelAliases.${input}.maxTokens`
  );

  const profile = inferModelProfile({
    provider: alias.provider as ProviderId,
    model: alias.model,
    contextWindowTokens: undefined
  });

  return {
    kind: "exact",
    route: {
      provider: alias.provider as ProviderId,
      id: alias.model,
      profile,
      baseUrl,
      apiKeyEnv,
      contextWindowTokens: profile.contextWindowTokens,
      maxTokens,
      apiMode
    },
    resolvedViaAlias: input
  };
}

// ── Curated alias ───────────────────────────────────────────────────────────

async function resolveCuratedAlias(
  input: string,
  options: NormalizeModelInputOptions
): Promise<NormalizedModelInput | undefined> {
  const curated = CURATED_ALIASES[input];
  if (curated === undefined) {
    return undefined;
  }

  const candidates = await findFamilyMatches(curated.vendor, curated.family, options);

  if (candidates.length === 0) {
    return {
      kind: "unknown",
      input,
      reason: `Alias '${input}' does not match any known model in the catalog. Run 'estacoda model search ${curated.family}' to see available models.`
    };
  }

  const sorted = sortVersionSuffix(candidates);
  const best = sorted[0]!;

  const meta = getProviderMetadata(best.provider);
  const baseUrl = options.config.providers?.[best.provider]?.baseUrl ?? meta.defaultBaseUrl;
  const apiMode = (options.config.providers?.[best.provider] as { apiMode?: ProviderApiMode } | undefined)?.apiMode ?? meta.apiMode;

  return {
    kind: "exact",
    route: {
      provider: best.provider,
      id: best.model,
      profile: best.profile,
      baseUrl,
      apiKeyEnv: meta.defaultApiKeyEnv,
      contextWindowTokens: best.profile.contextWindowTokens,
      apiMode
    },
    resolvedViaAlias: input
  };
}

async function findFamilyMatches(
  vendor: ProviderId,
  family: string,
  options: NormalizeModelInputOptions
): Promise<Array<{ provider: ProviderId; model: string; profile: ModelProfile }>> {
  const results: Array<{ provider: ProviderId; model: string; profile: ModelProfile }> = [];
  const lowerFamily = family.toLowerCase();

  // Catalog models
  if (options.catalog !== undefined) {
    try {
      const catalogModels = await options.catalog.listModels({ provider: vendor, includeCatalogOnly: true });
      for (const m of catalogModels) {
        if (matchesFamily(m.id, lowerFamily)) {
          results.push({ provider: m.provider, model: m.id, profile: m.profile });
        }
      }
    } catch {
      // Catalog unavailable; continue with fallback-known
    }
  }

  // Fallback-known profiles
  for (const profile of fallbackKnownModelProfiles) {
    if (profile.provider === vendor && matchesFamily(profile.id, lowerFamily)) {
      if (!results.some((r) => r.model === profile.id)) {
        results.push({ provider: profile.provider, model: profile.id, profile });
      }
    }
  }

  return results;
}

function matchesFamily(modelId: string, family: string): boolean {
  const lower = modelId.toLowerCase();
  if (lower === family) return true;
  if (lower.startsWith(family)) {
    const next = lower[family.length];
    return next === undefined || next === "-" || next === "." || next === "_";
  }
  const idx = lower.indexOf(`-${family}`);
  if (idx !== -1) {
    const after = lower[idx + family.length + 1];
    return after === undefined || after === "-" || after === "." || after === "_";
  }
  return false;
}

// ── Ambiguous catalog/provider resolver ─────────────────────────────────────

function resolveAmbiguousModel(
  input: string,
  options: NormalizeModelInputOptions
): NormalizedModelInput {
  const inferredProvider = inferProviderFromModel(input);

  if (inferredProvider === "openai-compatible") {
    return {
      kind: "unknown",
      input,
      reason: `Could not resolve '${input}' to a known model or alias. Use provider/model syntax or define an alias in config.`
    };
  }

  const profile = inferModelProfile({ provider: inferredProvider, model: input });
  const meta = getProviderMetadata(inferredProvider);
  const baseUrl = options.config.providers?.[inferredProvider]?.baseUrl ?? meta.defaultBaseUrl;
  const apiMode = (options.config.providers?.[inferredProvider] as { apiMode?: ProviderApiMode } | undefined)?.apiMode ?? meta.apiMode;

  return {
    kind: "exact",
    route: {
      provider: inferredProvider,
      id: input,
      profile,
      baseUrl,
      apiKeyEnv: meta.defaultApiKeyEnv,
      contextWindowTokens: profile.contextWindowTokens,
      apiMode
    }
  };
}

// ── Version / suffix sorting ────────────────────────────────────────────────

type VersionedCandidate = {
  provider: ProviderId;
  model: string;
  profile: ModelProfile;
  version: number[];
  suffixScore: number;
  length: number;
};

export function sortVersionSuffix(
  candidates: Array<{ provider: ProviderId; model: string; profile: ModelProfile }>
): Array<{ provider: ProviderId; model: string; profile: ModelProfile }> {
  const scored = candidates.map((c) => toVersionedCandidate(c));
  scored.sort((a, b) => {
    const vCompare = compareVersionArrays(b.version, a.version);
    if (vCompare !== 0) return vCompare;
    if (b.suffixScore !== a.suffixScore) return b.suffixScore - a.suffixScore;
    return b.length - a.length;
  });
  return scored.map((s) => ({ provider: s.provider, model: s.model, profile: s.profile }));
}

function toVersionedCandidate(
  candidate: { provider: ProviderId; model: string; profile: ModelProfile }
): VersionedCandidate {
  return {
    provider: candidate.provider,
    model: candidate.model,
    profile: candidate.profile,
    version: extractVersion(candidate.model),
    suffixScore: computeSuffixScore(candidate.model),
    length: candidate.model.length
  };
}

function extractVersion(modelId: string): number[] {
  const matches = modelId.match(/(\d+)(?:\.(\d+))?(?:\.(\d+))?/g);
  if (matches === null || matches.length === 0) return [0];
  const last = matches[matches.length - 1]!;
  return last.split(".").map((n) => parseInt(n, 10));
}

function compareVersionArrays(a: number[], b: number[]): number {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

function computeSuffixScore(modelId: string): number {
  const lower = modelId.toLowerCase();
  if (lower.includes("-pro") || lower.includes("pro-")) return 100;
  if (lower.includes("-preview") || lower.includes("preview-")) return 50;
  if (lower.includes("-latest") || lower.includes("latest-")) return 40;
  if (lower.includes("-turbo") || lower.includes("turbo-")) return 30;
  if (lower.includes("-beta") || lower.includes("beta-")) return -5;
  if (lower.includes("-alpha") || lower.includes("alpha-")) return -10;
  return 10;
}
