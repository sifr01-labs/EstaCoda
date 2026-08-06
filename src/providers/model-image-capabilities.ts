import type { ModelProfile } from "../contracts/provider.js";

/**
 * Known provider families and EstaCoda's managed local OpenAI-compatible lane
 * accept repeated image parts. Other custom routes must opt in explicitly so
 * comparison fails or reroutes when endpoint capability is unknown.
 */
export function supportsMultipleImageInputs(profile: ModelProfile): boolean {
  if (!profile.supportsVision) return false;
  if (profile.supportsMultipleImages !== undefined) return profile.supportsMultipleImages;
  return ["openai", "anthropic", "google", "openrouter", "local"].includes(profile.provider);
}
