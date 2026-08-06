import type { ProviderImageInput } from "../contracts/provider-usage.js";

export type ProviderImageTokenEstimate = {
  tokens: number;
  estimator: string;
};

const MAX_IMAGES_PER_ESTIMATE = 64;

/**
 * Returns a conservative token upper bound only for provider/model families
 * whose public image-token rules are deterministic from normalized dimensions.
 */
export function estimateProviderImageInputTokens(input: {
  provider: string;
  model: string;
  images: readonly ProviderImageInput[];
}): ProviderImageTokenEstimate | undefined {
  if (input.images.length === 0 || input.images.length > MAX_IMAGES_PER_ESTIMATE ||
      !input.images.every(validImageInput)) {
    return undefined;
  }

  const family = downstreamFamily(input.provider, input.model);
  if (family === undefined) return undefined;

  const estimates = input.images.map((image) => estimateImage(family, image));
  if (estimates.some((estimate) => estimate === undefined)) return undefined;
  const first = estimates[0]!;
  if (!estimates.every((estimate) => estimate!.estimator === first.estimator)) return undefined;

  const tokens = estimates.reduce((sum, estimate) => safeAdd(sum, estimate!.tokens), 0);
  return Number.isSafeInteger(tokens)
    ? { tokens, estimator: first.estimator }
    : undefined;
}

type ProviderFamily =
  | { kind: "openai"; model: string }
  | { kind: "anthropic"; model: string }
  | { kind: "google"; model: string };

function downstreamFamily(provider: string, model: string): ProviderFamily | undefined {
  const normalizedProvider = provider.trim().toLowerCase();
  const normalizedModel = model.trim().toLowerCase();
  if (normalizedProvider === "openai") return { kind: "openai", model: normalizedModel };
  if (normalizedProvider === "anthropic") return { kind: "anthropic", model: normalizedModel };
  if (normalizedProvider === "google") return { kind: "google", model: normalizedModel };
  if (normalizedProvider !== "openrouter") return undefined;

  const slash = normalizedModel.indexOf("/");
  if (slash <= 0 || slash === normalizedModel.length - 1) return undefined;
  const downstreamProvider = normalizedModel.slice(0, slash);
  const downstreamModel = normalizedModel.slice(slash + 1);
  if (downstreamProvider === "openai") return { kind: "openai", model: downstreamModel };
  if (downstreamProvider === "anthropic") return { kind: "anthropic", model: downstreamModel };
  if (downstreamProvider === "google") return { kind: "google", model: downstreamModel };
  return undefined;
}

function estimateImage(
  family: ProviderFamily,
  image: ProviderImageInput
): ProviderImageTokenEstimate | undefined {
  switch (family.kind) {
    case "openai":
      return estimateOpenAIImage(family.model, image);
    case "anthropic":
      return estimateAnthropicImage(family.model, image);
    case "google":
      return estimateGoogleImage(family.model, image);
  }
}

function estimateOpenAIImage(
  model: string,
  image: ProviderImageInput
): ProviderImageTokenEstimate | undefined {
  const patches = patchCount(image, 32);
  if (patches === undefined) return undefined;

  if (/^gpt-5\.6(?:-|$)/u.test(model)) {
    return { tokens: patches, estimator: "openai-patch-32-gpt-5.6-auto-v1" };
  }
  if (/^gpt-5\.5(?:-|$)/u.test(model)) {
    return cappedPatchEstimate(patches, 10_000, 1, "openai-patch-32-gpt-5.5-auto-v1");
  }
  if (/^gpt-5\.4-mini(?:-|$)/u.test(model)) {
    return cappedPatchEstimate(patches, 1_536, 1.62, "openai-patch-32-gpt-5.4-mini-auto-v1");
  }
  if (/^gpt-5\.4-nano(?:-|$)/u.test(model)) {
    return cappedPatchEstimate(patches, 1_536, 2.46, "openai-patch-32-gpt-5.4-nano-auto-v1");
  }
  if (/^gpt-5\.4(?:-|$)/u.test(model)) {
    return cappedPatchEstimate(patches, 2_500, 1, "openai-patch-32-gpt-5.4-auto-v1");
  }
  if (/^(?:gpt-5\.2(?:-chat-latest|-codex)?|gpt-5\.3-codex|gpt-5-codex-mini|gpt-5\.1-codex-mini)(?:-|$)/u.test(model)) {
    return cappedPatchEstimate(patches, 1_536, 1, "openai-patch-32-1536-auto-v1");
  }
  if (/^gpt-5-mini(?:-|$)/u.test(model)) {
    return cappedPatchEstimate(patches, 1_536, 1.62, "openai-patch-32-gpt-5-mini-auto-v1");
  }
  if (/^gpt-5-nano(?:-|$)/u.test(model)) {
    return cappedPatchEstimate(patches, 1_536, 2.46, "openai-patch-32-gpt-5-nano-auto-v1");
  }
  if (/^gpt-4\.1-mini-2025-04-14$/u.test(model)) {
    return cappedPatchEstimate(patches, 1_536, 1.62, "openai-patch-32-gpt-4.1-mini-2025-04-14-v1");
  }
  if (/^gpt-4\.1-nano-2025-04-14$/u.test(model)) {
    return cappedPatchEstimate(patches, 1_536, 2.46, "openai-patch-32-gpt-4.1-nano-2025-04-14-v1");
  }
  if (/^o4-mini(?:-|$)/u.test(model)) {
    return cappedPatchEstimate(patches, 1_536, 1.72, "openai-patch-32-o4-mini-auto-v1");
  }

  const tileRates = openAITileRates(model);
  if (tileRates === undefined) return undefined;
  const detail = image.detail ?? "auto";
  if (detail === "original") return undefined;
  const tiles = detail === "low" ? 0 : openAIHighDetailTiles(image);
  if (tiles === undefined) return undefined;
  const tokens = safeAdd(tileRates.base, safeMultiply(tiles, tileRates.tile));
  return Number.isSafeInteger(tokens)
    ? { tokens, estimator: `openai-tile-512-${tileRates.label}-v1` }
    : undefined;
}

function openAITileRates(model: string): { base: number; tile: number; label: string } | undefined {
  if (/^(?:gpt-4o-mini)(?:-|$)/u.test(model)) return { base: 2_833, tile: 5_667, label: "gpt-4o-mini" };
  if (/^(?:gpt-4o|gpt-4\.1|gpt-4\.5)(?:-|$)/u.test(model)) return { base: 85, tile: 170, label: "gpt-4o-4.1-4.5" };
  if (/^(?:gpt-5|gpt-5-chat-latest)$/u.test(model)) return { base: 70, tile: 140, label: "gpt-5" };
  if (/^(?:o1|o1-pro|o3)(?:-|$)/u.test(model)) return { base: 75, tile: 150, label: "o1-o3" };
  if (/^computer-use-preview(?:-|$)/u.test(model)) return { base: 65, tile: 129, label: "computer-use-preview" };
  return undefined;
}

function openAIHighDetailTiles(image: ProviderImageInput): number | undefined {
  const fitScale = Math.min(1, 2_048 / image.width, 2_048 / image.height);
  const fitWidth = image.width * fitScale;
  const fitHeight = image.height * fitScale;
  const shortEdge = Math.min(fitWidth, fitHeight);
  if (!Number.isFinite(shortEdge) || shortEdge <= 0) return undefined;
  const detailScale = 768 / shortEdge;
  const width = Math.max(1, Math.ceil(fitWidth * detailScale));
  const height = Math.max(1, Math.ceil(fitHeight * detailScale));
  return safeMultiply(Math.ceil(width / 512), Math.ceil(height / 512));
}

function estimateAnthropicImage(
  model: string,
  image: ProviderImageInput
): ProviderImageTokenEstimate | undefined {
  const tier = anthropicResolutionTier(model);
  if (tier === undefined) return undefined;
  const patches = patchCount(image, 28);
  if (patches === undefined) return undefined;
  return {
    tokens: Math.min(patches, tier.maximumTokens),
    estimator: `anthropic-patch-28-${tier.label}-v1`
  };
}

function anthropicResolutionTier(model: string): { maximumTokens: number; label: string } | undefined {
  const familyFirst = model.match(/^claude-(?:opus|sonnet|haiku)-(\d+)(?:[.-](\d+))?/u);
  const versionFirst = model.match(/^claude-(\d+)(?:[.-](\d+))?-(?:opus|sonnet|haiku)/u);
  const match = familyFirst ?? versionFirst;
  if (match === null) return undefined;
  const major = Number(match[1]);
  const minor = Number(match[2] ?? 0);
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor)) return undefined;
  return major > 4 || (major === 4 && minor >= 7)
    ? { maximumTokens: 4_784, label: "high" }
    : { maximumTokens: 1_568, label: "standard" };
}

function estimateGoogleImage(
  model: string,
  image: ProviderImageInput
): ProviderImageTokenEstimate | undefined {
  if (!/^gemini(?:-|$)/u.test(model)) return undefined;
  if (image.width <= 384 && image.height <= 384) {
    return { tokens: 258, estimator: "google-gemini-tiles-258-v1" };
  }
  const cropUnit = Math.floor(Math.min(image.width, image.height) / 1.5);
  if (cropUnit <= 0) return undefined;
  const tiles = safeMultiply(Math.ceil(image.width / cropUnit), Math.ceil(image.height / cropUnit));
  const tokens = safeMultiply(tiles, 258);
  return Number.isSafeInteger(tokens)
    ? { tokens, estimator: "google-gemini-tiles-258-v1" }
    : undefined;
}

function cappedPatchEstimate(
  patches: number,
  maximumPatches: number,
  multiplier: number,
  estimator: string
): ProviderImageTokenEstimate {
  return {
    tokens: Math.ceil(Math.min(patches, maximumPatches) * multiplier),
    estimator
  };
}

function patchCount(image: ProviderImageInput, patchSize: number): number | undefined {
  const count = safeMultiply(Math.ceil(image.width / patchSize), Math.ceil(image.height / patchSize));
  return Number.isSafeInteger(count) ? count : undefined;
}

function validImageInput(image: ProviderImageInput): boolean {
  return Number.isSafeInteger(image.width) && image.width > 0 &&
    Number.isSafeInteger(image.height) && image.height > 0 &&
    (image.detail === undefined || ["low", "high", "original", "auto"].includes(image.detail));
}

function safeAdd(left: number, right: number): number {
  const value = left + right;
  return Number.isSafeInteger(value) ? value : Number.NaN;
}

function safeMultiply(left: number, right: number): number {
  const value = left * right;
  return Number.isSafeInteger(value) ? value : Number.NaN;
}
