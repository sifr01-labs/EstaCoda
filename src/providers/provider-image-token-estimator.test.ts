import { describe, expect, it } from "vitest";
import { estimateProviderImageInputTokens } from "./provider-image-token-estimator.js";

describe("estimateProviderImageInputTokens", () => {
  it("uses uncapped 32px patches for GPT-5.6 auto detail", () => {
    expect(estimate("openai", "gpt-5.6", 1_024, 1_024)).toEqual({
      tokens: 1_024,
      estimator: "openai-patch-32-gpt-5.6-auto-v1"
    });
  });

  it("applies documented OpenAI patch budgets and model multipliers", () => {
    expect(estimate("openai", "gpt-5.4-mini", 4_000, 4_000)).toEqual({
      tokens: 2_489,
      estimator: "openai-patch-32-gpt-5.4-mini-auto-v1"
    });
    expect(estimate("openai", "o4-mini", 4_000, 4_000)).toEqual({
      tokens: 2_642,
      estimator: "openai-patch-32-o4-mini-auto-v1"
    });
  });

  it("uses the conservative high-detail tile bound for omitted OpenAI detail", () => {
    expect(estimate("openai", "gpt-4o", 1_024, 1_024)).toEqual({
      tokens: 765,
      estimator: "openai-tile-512-gpt-4o-4.1-4.5-v1"
    });
    expect(estimate("openai", "gpt-4o", 1_024, 1_024, "low")).toEqual({
      tokens: 85,
      estimator: "openai-tile-512-gpt-4o-4.1-4.5-v1"
    });
  });

  it("bounds Anthropic patches by the model resolution tier", () => {
    expect(estimate("anthropic", "claude-3-5-sonnet-20241022", 1_000, 1_000)).toEqual({
      tokens: 1_296,
      estimator: "anthropic-patch-28-standard-v1"
    });
    expect(estimate("anthropic", "claude-opus-5", 7_680, 7_680)).toEqual({
      tokens: 4_784,
      estimator: "anthropic-patch-28-high-v1"
    });
  });

  it("uses Gemini's normalized-dimension crop units", () => {
    expect(estimate("google", "gemini-3-pro", 384, 384)).toEqual({
      tokens: 258,
      estimator: "google-gemini-tiles-258-v1"
    });
    expect(estimate("google", "gemini-3-pro", 960, 540)).toEqual({
      tokens: 1_548,
      estimator: "google-gemini-tiles-258-v1"
    });
  });

  it("recognizes explicit OpenRouter downstream families", () => {
    expect(estimate("openrouter", "anthropic/claude-sonnet-4-7", 1_000, 1_000)).toEqual({
      tokens: 1_296,
      estimator: "anthropic-patch-28-high-v1"
    });
  });

  it("fails closed for unknown providers, model rules, and invalid dimensions", () => {
    expect(estimate("local", "vision-model", 1_024, 1_024)).toBeUndefined();
    expect(estimate("openai", "future-vision-model", 1_024, 1_024)).toBeUndefined();
    expect(estimate("google", "gemini-3-pro", 0, 1_024)).toBeUndefined();
  });

  it("adds multiple image estimates without changing estimator lineage", () => {
    expect(estimateProviderImageInputTokens({
      provider: "openai",
      model: "gpt-5.6",
      images: [
        { width: 320, height: 320, detail: "auto" },
        { width: 640, height: 320, detail: "auto" }
      ]
    })).toEqual({
      tokens: 300,
      estimator: "openai-patch-32-gpt-5.6-auto-v1"
    });
  });
});

function estimate(
  provider: string,
  model: string,
  width: number,
  height: number,
  detail: "low" | "high" | "original" | "auto" = "auto"
) {
  return estimateProviderImageInputTokens({
    provider,
    model,
    images: [{ width, height, detail }]
  });
}
