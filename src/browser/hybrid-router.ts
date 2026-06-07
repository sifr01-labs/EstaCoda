import type { HybridClassificationResult } from "./hybrid-classifier.js";

export type BrowserRouteDecision =
  | { kind: "cloud"; reason: string }
  | { kind: "local"; reason: string }
  | { kind: "blocked"; reason: string }
  | { kind: "invalid"; reason: string };

export interface HybridRouterOptions {
  allowPrivateUrls: boolean;
  hybridRouting: boolean;
  cloudProviderConfigured: boolean;
}

export function decideBrowserRoute(
  classification: HybridClassificationResult,
  options: HybridRouterOptions
): BrowserRouteDecision {
  switch (classification.classification) {
    case "always-blocked":
      return {
        kind: "blocked",
        reason: classification.reason
      };
    case "invalid":
      return {
        kind: "invalid",
        reason: classification.reason
      };
    case "private-or-internal":
      if (options.allowPrivateUrls !== true) {
        return {
          kind: "blocked",
          reason: "Private or internal browser URLs are blocked by security.allowPrivateUrls."
        };
      }
      if (!options.cloudProviderConfigured) {
        return {
          kind: "local",
          reason: "No cloud provider is configured; preserving local browser routing."
        };
      }
      if (options.hybridRouting === true) {
        return {
          kind: "local",
          reason: "Hybrid routing sends private or internal browser URLs to the local browser."
        };
      }
      return {
        kind: "blocked",
        reason: "Hybrid routing is disabled for private or internal browser URLs."
      };
    case "public":
      if (options.cloudProviderConfigured) {
        return {
          kind: "cloud",
          reason: "Public browser URL routes to the configured cloud browser."
        };
      }
      return {
        kind: "local",
        reason: "No cloud provider is configured; preserving local browser routing."
      };
  }
}
