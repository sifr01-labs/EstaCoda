import type { WebResearchProvider } from "../web-research-provider.js";

export const fetchExtractProvider: WebResearchProvider = {
  name: "fetch",
  publicExtractReuse: true,
  displayName: "Fetch Extract",
  capabilities: { extract: true },
  getAvailability: () => ({ available: true }),
  async extract() {
    throw new Error("Fetch extraction is handled by the built-in guarded web.extract fallback.");
  }
};
