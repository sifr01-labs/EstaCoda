import { isDeepStrictEqual } from "node:util";
import type {
  SecureInputDestination,
  SecureInputRequest
} from "../contracts/secure-input.js";

export type SecureInputVerificationPhase = "before-collection" | "before-delivery";

export type SecureInputDestinationRejectionCode =
  | "destination-unavailable"
  | "destination-not-verifiable"
  | "destination-changed";

export type SecureInputDestinationVerification =
  | {
      status: "verified";
      /** Exact observed destination. It must equal the requested destination. */
      destination: SecureInputDestination;
    }
  | {
      status: "rejected";
      code: SecureInputDestinationRejectionCode;
    };

export type SecureInputDestinationVerifier = (input: {
  request: SecureInputRequest;
  phase: SecureInputVerificationPhase;
  signal: AbortSignal;
}) => Promise<SecureInputDestinationVerification> | SecureInputDestinationVerification;

export type VerifiedSecureInputDestination = {
  destination: SecureInputDestination;
  label: string;
};

/**
 * Accepts only an exact destination observation. A transport cannot redirect a
 * value by returning a different tab, process, tool argument, or store entry.
 */
export function verifySecureInputDestination(
  request: SecureInputRequest,
  verification: SecureInputDestinationVerification
): VerifiedSecureInputDestination | undefined {
  if (verification.status !== "verified") return undefined;
  if (!isDeepStrictEqual(request.destination, verification.destination)) return undefined;
  return {
    destination: structuredClone(request.destination),
    label: secureInputDestinationLabel(request.destination)
  };
}

/** Safe, deterministic label derived only from validated destination metadata. */
export function secureInputDestinationLabel(destination: SecureInputDestination): string {
  switch (destination.type) {
    case "browser-field":
      return destination.label ?? `Browser field at ${destination.expectedOrigin}`;
    case "application-field":
      return destination.label ?? `Application field in ${destination.applicationId}`;
    case "process-stdin":
      return destination.promptLabel ?? `Process ${destination.processId} input`;
    case "process-environment":
      return `${destination.variableName} for process ${destination.processId}`;
    case "registered-store":
      return `Registered store ${destination.storeId}`;
    case "tool-argument":
      return `${destination.toolName} protected argument`;
    case "mcp-argument":
      return `${destination.serverId}/${destination.toolName} protected argument`;
  }
}
