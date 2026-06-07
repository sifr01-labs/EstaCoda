import { describe, expect, it } from "vitest";
import type { HybridClassificationResult } from "./hybrid-classifier.js";
import { decideBrowserRoute } from "./hybrid-router.js";

const classification = (value: HybridClassificationResult["classification"]): HybridClassificationResult => ({
  classification: value,
  reason: `${value} reason`
});

describe("decideBrowserRoute", () => {
  it("routes public URLs to cloud when a cloud provider is configured", () => {
    expect(decideBrowserRoute(classification("public"), {
      allowPrivateUrls: false,
      hybridRouting: true,
      cloudProviderConfigured: true
    })).toEqual({
      kind: "cloud",
      reason: "Public browser URL routes to the configured cloud browser."
    });
  });

  it("blocks private URLs when allowPrivateUrls is false", () => {
    expect(decideBrowserRoute(classification("private-or-internal"), {
      allowPrivateUrls: false,
      hybridRouting: true,
      cloudProviderConfigured: true
    })).toEqual({
      kind: "blocked",
      reason: "Private or internal browser URLs are blocked by security.allowPrivateUrls."
    });
  });

  it("routes private URLs to local only when private URLs, hybrid routing, and cloud provider are enabled", () => {
    expect(decideBrowserRoute(classification("private-or-internal"), {
      allowPrivateUrls: true,
      hybridRouting: true,
      cloudProviderConfigured: true
    })).toEqual({
      kind: "local",
      reason: "Hybrid routing sends private or internal browser URLs to the local browser."
    });
  });

  it("blocks metadata URLs even when private URLs are allowed", () => {
    expect(decideBrowserRoute(classification("always-blocked"), {
      allowPrivateUrls: true,
      hybridRouting: true,
      cloudProviderConfigured: true
    })).toEqual({
      kind: "blocked",
      reason: "always-blocked reason"
    });
  });

  it("returns invalid for invalid URLs", () => {
    expect(decideBrowserRoute(classification("invalid"), {
      allowPrivateUrls: true,
      hybridRouting: true,
      cloudProviderConfigured: true
    })).toEqual({
      kind: "invalid",
      reason: "invalid reason"
    });
  });

  it("does not route private URLs to local when hybrid routing is disabled for a cloud provider", () => {
    expect(decideBrowserRoute(classification("private-or-internal"), {
      allowPrivateUrls: true,
      hybridRouting: false,
      cloudProviderConfigured: true
    })).toEqual({
      kind: "blocked",
      reason: "Hybrid routing is disabled for private or internal browser URLs."
    });
  });

  it("preserves local routing when no cloud provider is configured", () => {
    expect(decideBrowserRoute(classification("public"), {
      allowPrivateUrls: false,
      hybridRouting: false,
      cloudProviderConfigured: false
    })).toEqual({
      kind: "local",
      reason: "No cloud provider is configured; preserving local browser routing."
    });

    expect(decideBrowserRoute(classification("private-or-internal"), {
      allowPrivateUrls: true,
      hybridRouting: false,
      cloudProviderConfigured: false
    })).toEqual({
      kind: "local",
      reason: "No cloud provider is configured; preserving local browser routing."
    });
  });
});
