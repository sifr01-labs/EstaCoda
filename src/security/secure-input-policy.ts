import type { SecureInputRequest, SecureInputRetention } from "../contracts/secure-input.js";

export type SecureInputVerificationStrength =
  | "declared-target"
  | "runtime-bound"
  | "field-bound";

export type SecureInputPersistenceBehavior =
  | "none"
  | "destination-managed"
  | "profile-secret-store";

export type SecureInputDisclosureBoundary =
  | "local-runtime"
  | "destination"
  | "third-party-service";

export type SecureInputTransportPolicy = {
  verificationStrength: SecureInputVerificationStrength;
  persistence: SecureInputPersistenceBehavior;
  disclosureBoundary: SecureInputDisclosureBoundary;
  requiresApproval: boolean;
};

export type SecureInputPolicyDecision = "allow" | "ask" | "deny";

export type SecureInputPolicyReason =
  | "retention-not-supported"
  | "persistent-secret-requires-approval"
  | "transport-requires-approval"
  | "third-party-disclosure-requires-approval"
  | "policy-allow";

export type SecureInputPolicyAssessment = {
  decision: SecureInputPolicyDecision;
  reason: SecureInputPolicyReason;
};

/**
 * Assesses authority only. Destination verification remains a separate,
 * mandatory check and is repeated immediately before delivery.
 */
export function assessSecureInputPolicy(
  request: SecureInputRequest,
  transport: SecureInputTransportPolicy
): SecureInputPolicyAssessment {
  if (!supportsRetention(request.retention, transport.persistence)) {
    return { decision: "deny", reason: "retention-not-supported" };
  }
  if (request.retention === "profile-secret-store") {
    return { decision: "ask", reason: "persistent-secret-requires-approval" };
  }
  if (transport.requiresApproval) {
    return { decision: "ask", reason: "transport-requires-approval" };
  }
  if (transport.disclosureBoundary === "third-party-service") {
    return { decision: "ask", reason: "third-party-disclosure-requires-approval" };
  }
  return { decision: "allow", reason: "policy-allow" };
}

function supportsRetention(
  requested: SecureInputRetention,
  behavior: SecureInputPersistenceBehavior
): boolean {
  switch (requested) {
    case "use-once":
      return behavior === "none";
    case "destination-managed":
      return behavior === "destination-managed";
    case "profile-secret-store":
      return behavior === "profile-secret-store";
  }
}
