import type { ImageGenerationProvider } from "../config/runtime-config.js";

export const DEFAULT_FAL_IMAGE_MODEL = "fal-ai/flux-2/klein/9b";
export const DEFAULT_BYTEPLUS_IMAGE_MODEL = "seedream-5-0-260128";
export const BYTEPLUS_IMAGE_BASE_URL = "https://ark.ap-southeast.bytepluses.com/api/v3";
export const FAL_IMAGE_BASE_URL = "https://fal.run";

export type ImageModelOption = {
  id: string;
  label: string;
  aliases: readonly string[];
  description: string;
};

export const IMAGE_MODEL_OPTIONS: Record<ImageGenerationProvider, readonly ImageModelOption[]> = {
  fal: [
    {
      id: DEFAULT_FAL_IMAGE_MODEL,
      label: "Flux 2 Klein 9B",
      aliases: ["flux-2", "klein", "fal-default"],
      description: "Default FAL model for text-to-image generation."
    }
  ],
  byteplus: [
    {
      id: DEFAULT_BYTEPLUS_IMAGE_MODEL,
      label: "Seedream 5.0",
      aliases: ["seedream-5", "seedream-5.0", "seedream5", "5"],
      description: "Current BytePlus ModelArk Seedream default for text-to-image generation."
    },
    {
      id: "seedream-4-5-251128",
      label: "Seedream 4.5",
      aliases: ["seedream-4.5", "seedream-45", "4.5"],
      description: "Previous Seedream generation model; useful if enabled on your Ark account."
    },
    {
      id: "seedream-4-0-250828",
      label: "Seedream 4.0",
      aliases: ["seedream-4", "seedream-4.0", "seedream4", "4"],
      description: "Older Seedream generation model; accounts may need explicit activation."
    }
  ]
};

export function defaultImageModel(provider: ImageGenerationProvider): string {
  return provider === "byteplus" ? DEFAULT_BYTEPLUS_IMAGE_MODEL : DEFAULT_FAL_IMAGE_MODEL;
}

export function defaultImageApiKeyEnv(provider: ImageGenerationProvider): string {
  return provider === "byteplus" ? "BYTEPLUS_ARK_API_KEY" : "FAL_KEY";
}

export function defaultImageBaseUrl(provider: ImageGenerationProvider): string {
  return provider === "byteplus" ? BYTEPLUS_IMAGE_BASE_URL : FAL_IMAGE_BASE_URL;
}

export function resolveImageModel(provider: ImageGenerationProvider, value: string | undefined): string | undefined {
  if (value === undefined || value.trim().length === 0) return undefined;
  const normalized = value.trim().toLowerCase();
  const option = IMAGE_MODEL_OPTIONS[provider].find((candidate) =>
    candidate.id.toLowerCase() === normalized ||
    candidate.aliases.some((alias) => alias.toLowerCase() === normalized)
  );
  return option?.id ?? value;
}
