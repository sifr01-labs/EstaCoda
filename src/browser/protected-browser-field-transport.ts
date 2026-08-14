import type { BrowserBackend } from "../contracts/browser.js";
import type { SecureInputRequest } from "../contracts/secure-input.js";
import type { SecureInputTransport } from "../security/secure-input-transport-registry.js";

const REJECTION_CODES = new Set(["origin-mismatch", "tab-mismatch", "frame-mismatch", "field-replaced"]);

/** Creates a runtime-only transport for a supervised local CDP backend. */
export function createProtectedBrowserFieldTransport(
  backend: BrowserBackend
): SecureInputTransport {
  return {
    id: "supervised-local-browser-field",
    destinationTypes: ["browser-field"],
    priority: 700,
    verificationStrength: "field-bound",
    persistence: "none",
    disclosureBoundary: "destination",
    requiresApproval: false,
    isAvailable: async (request) => request.destination.type === "browser-field" &&
      backend.kind === "local-cdp" &&
      backend.verifyProtectedField !== undefined &&
      backend.deliverProtectedField !== undefined &&
      backend.abortProtectedFieldGroup !== undefined &&
      await backend.isAvailable(),
    verify: async ({ request, phase, signal }) => {
      if (request.destination.type !== "browser-field" || backend.verifyProtectedField === undefined) {
        return { status: "rejected", code: "destination-unavailable" };
      }
      const result = await backend.verifyProtectedField({
        destination: request.destination,
        kind: request.kind,
        phase,
        signal,
      });
      return result.status === "verified"
        ? { status: "verified", destination: structuredClone(request.destination) }
        : {
            status: "rejected",
            code: REJECTION_CODES.has(result.reason) ? "destination-changed" : "destination-not-verifiable",
          };
    },
    deliver: async ({ value, context, consume }) => {
      if (context.request.destination.type !== "browser-field" || backend.deliverProtectedField === undefined) {
        throw new Error("Protected local browser delivery is unavailable.");
      }
      await backend.deliverProtectedField({
        destination: context.request.destination,
        kind: context.request.kind,
        value,
        signal: context.signal,
      });
      await consume(value, context);
    },
    abort: async (requests) => {
      const destinations = requests.flatMap((request) =>
        request.destination.type === "browser-field" ? [request.destination] : []
      );
      if (destinations.length === 0) return;
      if (backend.abortProtectedFieldGroup === undefined) {
        throw new Error("Protected local browser cleanup is unavailable.");
      }
      await backend.abortProtectedFieldGroup(destinations);
    },
    release: async (request: SecureInputRequest) => {
      if (request.destination.type !== "browser-field") return;
      await backend.releaseProtectedField?.(request.destination);
    },
  };
}
