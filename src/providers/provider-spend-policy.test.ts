import { describe, expect, it } from "vitest";
import type { ProviderRequest, ResolvedModelRoute } from "../contracts/provider.js";
import type { ProviderUsageContext } from "../contracts/provider-usage.js";
import { prepareProviderSpend } from "./provider-spend-policy.js";

describe("prepareProviderSpend multimodal bounds", () => {
  it("adds provider-specific image tokens without pricing base64 payload bytes", () => {
    const prepared = prepareProviderSpend({
      profileId: "profile-1",
      request: imageRequest(),
      route: route("openai", "gpt-5.6"),
      routeIndex: 0,
      routeRole: "primary",
      providerAttemptIndex: 0,
      usage: usage([{ width: 1_024, height: 1_024, detail: "auto" }])
    });

    expect(prepared).toMatchObject({ pricingAvailable: true, safelyBounded: true });
    expect(prepared.request).toMatchObject({
      estimatedImageInputTokens: 1_024,
      imageTokenEstimator: "openai-patch-32-gpt-5.6-auto-v1",
      boundedMaximumOutputTokens: 100
    });
    expect(prepared.request.estimatedInputTokens).toBeGreaterThan(1_024);
    expect(prepared.request.estimatedInputTokens).toBeLessThan(2_000);
  });

  it("cannot safely bound media when normalized dimensions are absent or mismatched", () => {
    const missing = prepareProviderSpend({
      profileId: "profile-1",
      request: imageRequest(),
      route: route("openai", "gpt-5.6"),
      routeIndex: 0,
      routeRole: "primary",
      providerAttemptIndex: 0,
      usage: usage()
    });
    const mismatched = prepareProviderSpend({
      profileId: "profile-1",
      request: imageRequest(),
      route: route("openai", "gpt-5.6"),
      routeIndex: 0,
      routeRole: "primary",
      providerAttemptIndex: 0,
      usage: usage([
        { width: 1_024, height: 1_024 },
        { width: 1_024, height: 1_024 }
      ])
    });

    expect(missing.safelyBounded).toBe(false);
    expect(mismatched.safelyBounded).toBe(false);
  });

  it("fails closed when the provider/model image pricing rule is unknown", () => {
    const prepared = prepareProviderSpend({
      profileId: "profile-1",
      request: imageRequest(),
      route: route("custom-provider", "vision-model"),
      routeIndex: 0,
      routeRole: "primary",
      providerAttemptIndex: 0,
      usage: usage([{ width: 1_024, height: 1_024 }])
    });

    expect(prepared.pricingAvailable).toBe(true);
    expect(prepared.safelyBounded).toBe(false);
    expect(prepared.request).not.toHaveProperty("imageTokenEstimator");
  });

  it("keeps explicitly zero-cost local vision usable under a configured limit", () => {
    const localRoute = route("local", "local-vision");
    localRoute.profile.cost = { inputPerMillionTokens: 0, outputPerMillionTokens: 0 };
    const prepared = prepareProviderSpend({
      profileId: "profile-1",
      request: { ...imageRequest(), maxTokens: undefined },
      route: { ...localRoute, maxTokens: undefined },
      routeIndex: 0,
      routeRole: "primary",
      providerAttemptIndex: 0,
      usage: usage([{ width: 1_024, height: 1_024 }])
    });

    expect(prepared).toMatchObject({ pricingAvailable: true, safelyBounded: true });
    expect(prepared.request.maximumEstimatedCostUsd).toBe(0);
  });
});

describe("prepareProviderSpend output bounds", () => {
  it("reserves the registry output limit instead of the entire context window", () => {
    const kimiRoute = route("kimi", "kimi-k3");
    kimiRoute.maxTokens = undefined;
    kimiRoute.contextWindowTokens = 1_048_576;
    kimiRoute.profile.contextWindowTokens = 1_048_576;
    kimiRoute.profile.maxOutputTokens = 131_072;

    const prepared = prepareProviderSpend({
      profileId: "profile-1",
      request: { model: "kimi-k3", messages: [{ role: "user", content: "Inspect this." }] },
      route: kimiRoute,
      routeIndex: 0,
      routeRole: "primary",
      providerAttemptIndex: 0,
      usage: usage()
    });

    expect(prepared).toMatchObject({ pricingAvailable: true, safelyBounded: true });
    expect(prepared.request.boundedMaximumOutputTokens).toBe(131_072);
  });

  it("falls back to the context window when registry output metadata is invalid", () => {
    const fallbackRoute = route("kimi", "kimi-invalid-output");
    fallbackRoute.maxTokens = undefined;
    fallbackRoute.contextWindowTokens = 262_144;
    fallbackRoute.profile.contextWindowTokens = 262_144;
    fallbackRoute.profile.maxOutputTokens = 0;

    const prepared = prepareProviderSpend({
      profileId: "profile-1",
      request: { model: fallbackRoute.id, messages: [{ role: "user", content: "Inspect this." }] },
      route: fallbackRoute,
      routeIndex: 0,
      routeRole: "primary",
      providerAttemptIndex: 0,
      usage: usage()
    });

    expect(prepared.request.boundedMaximumOutputTokens).toBe(262_144);
  });
});

function imageRequest(): ProviderRequest {
  return {
    model: "ignored",
    maxTokens: 100,
    messages: [
      { role: "system", content: "Analyze the image." },
      {
        role: "user",
        content: [
          { type: "text", text: "Describe it." },
          {
            type: "image_url",
            image_url: { url: `data:image/png;base64,${"A".repeat(1_000_000)}` }
          }
        ]
      }
    ]
  };
}

function usage(imageInputs?: ProviderUsageContext["imageInputs"]): ProviderUsageContext {
  return {
    requestKey: "request-1",
    sourceKind: "auxiliary",
    auxiliaryKind: "vision",
    executionSessionId: "session-1",
    visibleTurnId: "turn-1",
    ...(imageInputs === undefined ? {} : { imageInputs })
  };
}

function route(provider: string, id: string): ResolvedModelRoute {
  return {
    provider,
    id,
    maxTokens: 100,
    profile: {
      provider,
      id,
      contextWindowTokens: 100_000,
      supportsTools: true,
      supportsVision: true,
      supportsStructuredOutput: false,
      cost: { inputPerMillionTokens: 1, outputPerMillionTokens: 2 }
    }
  };
}
