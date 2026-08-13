import { describe, expect, it } from "vitest";
import type { SecureInputRequest } from "../contracts/secure-input.js";
import { assessSecureInputPolicy, type SecureInputTransportPolicy } from "./secure-input-policy.js";

const request: SecureInputRequest = {
  kind: "password",
  purpose: "Sign in",
  destination: {
    type: "browser-field",
    sessionId: "browser-1",
    ref: "field-1",
    expectedOrigin: "https://example.com"
  },
  retention: "use-once"
};

const localOneUse: SecureInputTransportPolicy = {
  verificationStrength: "field-bound",
  persistence: "none",
  disclosureBoundary: "destination",
  requiresApproval: false
};

describe("secure-input policy", () => {
  it("allows exact one-use delivery without conflating it with approval", () => {
    expect(assessSecureInputPolicy(request, localOneUse)).toEqual({
      decision: "allow",
      reason: "policy-allow"
    });
  });

  it("denies retention a transport cannot honor", () => {
    expect(assessSecureInputPolicy(request, {
      ...localOneUse,
      persistence: "destination-managed"
    })).toEqual({
      decision: "deny",
      reason: "retention-not-supported"
    });
  });

  it("requires explicit approval for profile persistence and third-party disclosure", () => {
    expect(assessSecureInputPolicy({ ...request, retention: "profile-secret-store" }, {
      ...localOneUse,
      persistence: "profile-secret-store"
    }).decision).toBe("ask");
    expect(assessSecureInputPolicy(request, {
      ...localOneUse,
      disclosureBoundary: "third-party-service"
    }).decision).toBe("ask");
  });
});
