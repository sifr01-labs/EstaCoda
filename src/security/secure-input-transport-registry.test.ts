import { describe, expect, it, vi } from "vitest";
import type { SecureInputRequest } from "../contracts/secure-input.js";
import {
  SecureInputTransportRegistry,
  type SecureInputTransport
} from "./secure-input-transport-registry.js";

const request: SecureInputRequest = {
  kind: "api-key",
  purpose: "Authenticate one tool call",
  destination: {
    type: "tool-argument",
    toolName: "service.call",
    argumentPath: "credential"
  },
  retention: "use-once"
};

describe("SecureInputTransportRegistry", () => {
  it("chooses the strongest available transport deterministically", async () => {
    const registry = new SecureInputTransportRegistry();
    registry.register(transport("declared", "declared-target", 100));
    registry.register(transport("field", "field-bound", 1));
    registry.register(transport("runtime", "runtime-bound", 999));

    const selected = await registry.select({ request, signal: new AbortController().signal });

    expect(selected.transport.id).toBe("field");
  });

  it("fails closed instead of falling back after the strongest available transport rejects", async () => {
    const registry = new SecureInputTransportRegistry();
    const weaker = transport("weaker", "declared-target", 1);
    const stronger = transport("stronger", "field-bound", 1, {
      verify: vi.fn(() => ({ status: "rejected" as const, code: "destination-changed" as const }))
    });
    registry.register(weaker);
    registry.register(stronger);

    await expect(registry.select({ request, signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: "verification_failed" });
    expect(weaker.verify).not.toHaveBeenCalled();
  });

  it("rejects a verifier that redirects to another argument", async () => {
    const registry = new SecureInputTransportRegistry();
    registry.register(transport("redirect", "runtime-bound", 1, {
      verify: () => ({
        status: "verified",
        destination: { ...request.destination, argumentPath: "differentCredential" }
      })
    }));

    await expect(registry.select({ request, signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: "verification_failed" });
  });
});

function transport(
  id: string,
  verificationStrength: SecureInputTransport["verificationStrength"],
  priority: number,
  overrides: Partial<SecureInputTransport> = {}
): SecureInputTransport {
  return {
    id,
    destinationTypes: ["tool-argument"],
    priority,
    verificationStrength,
    persistence: "none",
    disclosureBoundary: "local-runtime",
    requiresApproval: false,
    isAvailable: vi.fn(() => true),
    verify: vi.fn(({ request: candidate }) => ({
      status: "verified" as const,
      destination: candidate.destination
    })),
    deliver: async ({ value, context, consume }) => await consume(value, context),
    ...overrides
  };
}
