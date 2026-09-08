import { describe, expect, it } from "vitest";
import type { ModelProfile, ProviderId } from "../contracts/provider.js";
import { supportsMultipleImageInputs } from "./model-image-capabilities.js";

describe("supportsMultipleImageInputs", () => {
  it.each(["kimi", "codex"] as const)("recognizes %s vision routes as multi-image capable", (provider) => {
    expect(supportsMultipleImageInputs(profile(provider))).toBe(true);
  });

  it("keeps unknown vision routes fail-closed", () => {
    expect(supportsMultipleImageInputs(profile("custom-provider"))).toBe(false);
  });

  it("honors explicit capability overrides", () => {
    expect(supportsMultipleImageInputs(profile("kimi", { supportsMultipleImages: false }))).toBe(false);
    expect(supportsMultipleImageInputs(profile("custom-provider", { supportsMultipleImages: true }))).toBe(true);
  });

  it("never treats text-only routes as multi-image capable", () => {
    expect(supportsMultipleImageInputs(profile("kimi", {
      supportsVision: false,
      supportsMultipleImages: true
    }))).toBe(false);
  });
});

function profile(provider: ProviderId, overrides: Partial<ModelProfile> = {}): ModelProfile {
  return {
    id: `${provider}-model`,
    provider,
    contextWindowTokens: 128_000,
    supportsTools: true,
    supportsVision: true,
    supportsStructuredOutput: true,
    ...overrides
  };
}
