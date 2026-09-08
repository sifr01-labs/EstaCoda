import type { SecureInputRequest } from "../contracts/secure-input.js";
import type { SecureInputTransport } from "./secure-input-transport-registry.js";

export type ProtectedArgumentDeclarationLookup = (
  request: SecureInputRequest
) => boolean;

/** Delegates one declared tool/MCP argument to the trusted executor consumer. */
export function createProtectedToolArgumentTransport(
  isDeclared: ProtectedArgumentDeclarationLookup
): SecureInputTransport {
  return {
    id: "declared-tool-argument",
    destinationTypes: ["tool-argument", "mcp-argument"],
    priority: 900,
    verificationStrength: "declared-target",
    persistence: "none",
    disclosureBoundary: "destination",
    requiresApproval: false,
    isAvailable: (request) => isDeclared(request),
    verify: ({ request }) => isDeclared(request)
      ? { status: "verified", destination: structuredClone(request.destination) }
      : { status: "rejected", code: "destination-not-verifiable" },
    deliver: async ({ value, context, consume }) => {
      if (!isDeclared(context.request)) {
        throw new Error("Protected tool argument declaration changed before delivery.");
      }
      await consume(value, context);
    }
  };
}
