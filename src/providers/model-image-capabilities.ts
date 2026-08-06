import type { ModelProfile } from "../contracts/provider.js";

/**
 * Vision protocols generally accept repeated image parts. Routes with a known
 * single-image restriction opt out explicitly so comparison fails or reroutes
 * before provider dispatch.
 */
export function supportsMultipleImageInputs(profile: ModelProfile): boolean {
  return profile.supportsVision && profile.supportsMultipleImages !== false;
}
