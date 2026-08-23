import { describe, expect, it } from "vitest";
import type { ModelProfile, ResolvedModelRoute } from "../contracts/provider.js";
import { normalizePositiveTokenLimit, resolveProviderOutputTokenBound } from "./provider-output-limit.js";

const profile: ModelProfile = {
  id: "fixture-model",
  provider: "fixture-provider",
  contextWindowTokens: 1_000_000,
  maxOutputTokens: 100_000,
  supportsTools: true,
  supportsVision: false,
  supportsStructuredOutput: true
};

const route: ResolvedModelRoute = {
  provider: profile.provider,
  id: profile.id,
  profile,
  contextWindowTokens: 900_000
};

describe("resolveProviderOutputTokenBound", () => {
  it("uses explicit limits before registry metadata", () => {
    expect(resolveProviderOutputTokenBound({ maxTokens: 2_000 }, { ...route, maxTokens: 4_000 })).toBe(2_000);
    expect(resolveProviderOutputTokenBound({}, { ...route, maxTokens: 4_000 })).toBe(4_000);
  });

  it("uses registry output metadata before the conservative context fallback", () => {
    expect(resolveProviderOutputTokenBound({}, route)).toBe(100_000);
  });

  it("skips invalid limits and falls back conservatively", () => {
    expect(resolveProviderOutputTokenBound(
      { maxTokens: 0 },
      {
        ...route,
        maxTokens: -1,
        profile: { ...profile, maxOutputTokens: Number.NaN }
      }
    )).toBe(900_000);
  });

  it("returns no bound when every source is missing or invalid", () => {
    expect(resolveProviderOutputTokenBound({}, {
      ...route,
      contextWindowTokens: undefined,
      profile: {
        ...profile,
        contextWindowTokens: 0,
        maxOutputTokens: undefined
      }
    })).toBeUndefined();
  });
});

describe("normalizePositiveTokenLimit", () => {
  it.each([undefined, null, 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid token limit %s",
    (value) => expect(normalizePositiveTokenLimit(value)).toBeUndefined()
  );
});
