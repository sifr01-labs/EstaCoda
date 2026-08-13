import type {
  SecureInputConsumer,
  SecureInputConsumptionContext,
  SecureInputDestination,
  SecureInputRequest
} from "../contracts/secure-input.js";
import {
  verifySecureInputDestination,
  type SecureInputDestinationVerifier,
  type SecureInputVerificationPhase,
  type VerifiedSecureInputDestination
} from "./secure-input-destination-verifier.js";
import type {
  SecureInputDisclosureBoundary,
  SecureInputPersistenceBehavior,
  SecureInputTransportPolicy,
  SecureInputVerificationStrength
} from "./secure-input-policy.js";

const VERIFICATION_RANK: Readonly<Record<SecureInputVerificationStrength, number>> = {
  "declared-target": 0,
  "runtime-bound": 1,
  "field-bound": 2
};

export type SecureInputTransportDelivery = (input: {
  value: Uint8Array;
  context: SecureInputConsumptionContext;
  consume: SecureInputConsumer;
}) => Promise<void> | void;

export type SecureInputTransport = {
  id: string;
  destinationTypes: readonly SecureInputDestination["type"][];
  priority: number;
  verificationStrength: SecureInputVerificationStrength;
  persistence: SecureInputPersistenceBehavior;
  disclosureBoundary: SecureInputDisclosureBoundary;
  requiresApproval: boolean;
  isAvailable(request: SecureInputRequest): Promise<boolean> | boolean;
  verify: SecureInputDestinationVerifier;
  /** Reviewed delivery boundary. Generic transports may delegate to a trusted consumer. */
  deliver: SecureInputTransportDelivery;
  /** Releases transport-local collection guards after every terminal outcome. */
  release?(request: SecureInputRequest): Promise<void> | void;
};

export type SelectedSecureInputTransport = {
  transport: SecureInputTransport;
  verifiedDestination: VerifiedSecureInputDestination;
  policy: SecureInputTransportPolicy;
};

export class SecureInputTransportRegistryError extends Error {
  constructor(
    public readonly code: "invalid_transport" | "duplicate_transport" | "transport_unavailable" | "verification_failed",
    message: string
  ) {
    super(message);
    this.name = "SecureInputTransportRegistryError";
  }
}

/** Runtime-only registry. Transport identifiers and entries are never model capabilities. */
export class SecureInputTransportRegistry {
  readonly #transports = new Map<string, SecureInputTransport>();

  register(transport: SecureInputTransport): void {
    validateTransport(transport);
    if (this.#transports.has(transport.id)) {
      throw new SecureInputTransportRegistryError("duplicate_transport", "A secure-input transport with this id already exists.");
    }
    this.#transports.set(transport.id, freezeTransport(transport));
  }

  unregister(id: string): boolean {
    return this.#transports.delete(id);
  }

  list(): readonly SecureInputTransport[] {
    return this.#sorted([...this.#transports.values()]);
  }

  async select(input: {
    request: SecureInputRequest;
    signal: AbortSignal;
  }): Promise<SelectedSecureInputTransport> {
    const candidates = this.#sorted([...this.#transports.values()].filter((transport) =>
      transport.destinationTypes.includes(input.request.destination.type)
    ));

    for (const transport of candidates) {
      if (input.signal.aborted) {
        throw new SecureInputTransportRegistryError("transport_unavailable", "Secure-input transport selection was cancelled.");
      }
      let available = false;
      try {
        available = await transport.isAvailable(structuredClone(input.request));
      } catch {
        available = false;
      }
      if (!available) continue;

      const verifiedDestination = await this.#verify({
        transport,
        request: input.request,
        phase: "before-collection",
        signal: input.signal
      });
      if (verifiedDestination === undefined) {
        // Fail closed once the strongest available transport observes a mismatch.
        throw new SecureInputTransportRegistryError("verification_failed", "The secure-input destination could not be verified.");
      }
      return {
        transport,
        verifiedDestination,
        policy: policyOf(transport)
      };
    }

    throw new SecureInputTransportRegistryError("transport_unavailable", "No reviewed secure-input transport is available for this destination.");
  }

  async reverify(input: {
    selection: SelectedSecureInputTransport;
    request: SecureInputRequest;
    signal: AbortSignal;
  }): Promise<VerifiedSecureInputDestination> {
    const registered = this.#transports.get(input.selection.transport.id);
    if (registered !== input.selection.transport) {
      throw new SecureInputTransportRegistryError("verification_failed", "The selected secure-input transport is no longer registered.");
    }
    const verified = await this.#verify({
      transport: registered,
      request: input.request,
      phase: "before-delivery",
      signal: input.signal
    });
    if (verified === undefined) {
      throw new SecureInputTransportRegistryError("verification_failed", "The secure-input destination changed before delivery.");
    }
    return verified;
  }

  async #verify(input: {
    transport: SecureInputTransport;
    request: SecureInputRequest;
    phase: SecureInputVerificationPhase;
    signal: AbortSignal;
  }): Promise<VerifiedSecureInputDestination | undefined> {
    try {
      const result = await input.transport.verify({
        request: structuredClone(input.request),
        phase: input.phase,
        signal: input.signal
      });
      return verifySecureInputDestination(input.request, result);
    } catch {
      return undefined;
    }
  }

  #sorted(transports: SecureInputTransport[]): SecureInputTransport[] {
    return transports.sort((left, right) =>
      VERIFICATION_RANK[right.verificationStrength] - VERIFICATION_RANK[left.verificationStrength] ||
      right.priority - left.priority ||
      left.id.localeCompare(right.id)
    );
  }
}

function policyOf(transport: SecureInputTransport): SecureInputTransportPolicy {
  return {
    verificationStrength: transport.verificationStrength,
    persistence: transport.persistence,
    disclosureBoundary: transport.disclosureBoundary,
    requiresApproval: transport.requiresApproval
  };
}

function validateTransport(transport: SecureInputTransport): void {
  const idValid = typeof transport.id === "string" && transport.id.trim().length > 0 &&
    transport.id.length <= 128 && !/[\u0000-\u001F\u007F]/u.test(transport.id);
  const destinationTypes = new Set<SecureInputDestination["type"]>([
    "browser-field",
    "application-field",
    "process-stdin",
    "process-environment",
    "registered-store",
    "tool-argument",
    "mcp-argument"
  ]);
  if (!idValid || !Number.isSafeInteger(transport.priority) || transport.destinationTypes.length === 0 ||
      transport.destinationTypes.some((type) => !destinationTypes.has(type)) ||
      !Object.hasOwn(VERIFICATION_RANK, transport.verificationStrength) ||
      !["none", "destination-managed", "profile-secret-store"].includes(transport.persistence) ||
      !["local-runtime", "destination", "third-party-service"].includes(transport.disclosureBoundary) ||
      typeof transport.requiresApproval !== "boolean" || typeof transport.isAvailable !== "function" ||
      typeof transport.verify !== "function" || typeof transport.deliver !== "function" ||
      (transport.release !== undefined && typeof transport.release !== "function")) {
    throw new SecureInputTransportRegistryError("invalid_transport", "Invalid secure-input transport declaration.");
  }
}

function freezeTransport(transport: SecureInputTransport): SecureInputTransport {
  return Object.freeze({
    ...transport,
    destinationTypes: Object.freeze([...new Set(transport.destinationTypes)])
  });
}
