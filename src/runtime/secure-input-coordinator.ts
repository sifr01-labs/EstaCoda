import type {
  SecureInputCollector,
  SecureInputConsumer,
  SecureInputReceipt,
  SecureInputRequest,
  SecureInputRequestHandler,
  SecureInputRequestSnapshot,
  SecureInputScope
} from "../contracts/secure-input.js";
import {
  EphemeralSecretBroker,
  SecureInputBrokerError
} from "../security/ephemeral-secret-broker.js";
import {
  assessSecureInputPolicy,
  type SecureInputPolicyAssessment
} from "../security/secure-input-policy.js";
import {
  SecureInputTransportRegistry,
  type SelectedSecureInputTransport
} from "../security/secure-input-transport-registry.js";

export type SecureInputAuthorizationHandler = (input: {
  request: SecureInputRequest;
  transportId: string;
  destinationLabel: string;
  assessment: SecureInputPolicyAssessment;
}) => Promise<"approved" | "denied">;

export type SecureInputWaitEvent = {
  state: "waiting_for_input" | "input_resolved";
  request: SecureInputRequestSnapshot;
};

export type SecureInputWaitHandler = (event: SecureInputWaitEvent) => Promise<void> | void;

export type SecureInputCoordinatorOptions = {
  broker: EphemeralSecretBroker;
  transports: SecureInputTransportRegistry;
  collect: SecureInputCollector;
  authorize?: SecureInputAuthorizationHandler;
  onWaitStateChange?: SecureInputWaitHandler;
};

/**
 * Coordinates policy, collection, re-verification, and one-use delivery. It
 * returns receipts only; the protected value never becomes a tool result.
 */
export class SecureInputCoordinator {
  readonly #broker: EphemeralSecretBroker;
  readonly #transports: SecureInputTransportRegistry;
  readonly #collect: SecureInputCollector;
  readonly #authorize: SecureInputAuthorizationHandler | undefined;
  readonly #onWaitStateChange: SecureInputWaitHandler | undefined;

  constructor(options: SecureInputCoordinatorOptions) {
    this.#broker = options.broker;
    this.#transports = options.transports;
    this.#collect = options.collect;
    this.#authorize = options.authorize;
    this.#onWaitStateChange = options.onWaitStateChange;
  }

  createRequestHandler(scope: SecureInputScope, signal?: AbortSignal): SecureInputRequestHandler {
    const boundScope = structuredClone(scope);
    return async (request, consume) => await this.request({
      scope: boundScope,
      request,
      consume,
      signal
    });
  }

  async request(input: {
    scope: SecureInputScope;
    request: SecureInputRequest;
    consume: SecureInputConsumer;
    signal?: AbortSignal;
  }): Promise<SecureInputReceipt> {
    const controller = linkedAbortController(input.signal);
    let selection: SelectedSecureInputTransport | undefined;
    let snapshot: SecureInputRequestSnapshot | undefined;
    let waitAnnounced = false;
    try {
      selection = await this.#transports.select({
        request: input.request,
        signal: controller.signal
      });
      const assessment = assessSecureInputPolicy(input.request, selection.policy);
      if (assessment.decision === "deny") {
        return failureReceipt(selection, "The requested retention is not supported by this destination.");
      }
      if (assessment.decision === "ask") {
        const decision = this.#authorize === undefined
          ? "denied"
          : await this.#authorize({
              request: structuredClone(input.request),
              transportId: selection.transport.id,
              destinationLabel: selection.verifiedDestination.label,
              assessment
            });
        if (decision !== "approved" || controller.signal.aborted) {
          return failureReceipt(selection, "Protected input delivery was not authorized.");
        }
      }

      snapshot = this.#broker.createRequest({
        scope: input.scope,
        request: input.request,
        signal: controller.signal
      });
      waitAnnounced = true;
      await this.#onWaitStateChange?.({
        state: "waiting_for_input",
        request: structuredClone(snapshot)
      });

      const collected = await this.#collect(structuredClone(snapshot), controller.signal);
      if (collected.status === "cancelled" || controller.signal.aborted) {
        this.#broker.cancelRequest(snapshot.id, input.scope);
        return receipt(selection, "cancelled", false, "Protected input collection was cancelled.");
      }

      try {
        this.#broker.provideSecret({
          requestId: snapshot.id,
          scope: input.scope,
          value: collected.value
        });
      } finally {
        collected.value.fill(0);
      }

      await this.#transports.reverify({
        selection,
        request: input.request,
        signal: controller.signal
      });

      const selectedTransport = selection.transport;
      let consumerCalled = false;
      await this.#broker.consume({
        requestId: snapshot.id,
        scope: input.scope,
        destination: selection.verifiedDestination.destination,
        signal: controller.signal
      }, async (value, context) => {
        await selectedTransport.deliver({
          value,
          context,
          consume: async (candidate, candidateContext) => {
            if (consumerCalled) throw new Error("Secure-input consumer replay was blocked.");
            if (candidate !== value || candidateContext !== context) {
              throw new Error("Secure-input transport substitution was blocked.");
            }
            consumerCalled = true;
            await input.consume(candidate, candidateContext);
          }
        });
        if (!consumerCalled) throw new Error("Secure-input transport did not invoke its consumer.");
      });

      return receipt(
        selection,
        "delivered",
        selection.policy.persistence !== "none"
      );
    } catch (error) {
      if (snapshot !== undefined) cancelPending(this.#broker, snapshot.id, input.scope);
      if (error instanceof SecureInputBrokerError) {
        if (error.code === "expired") {
          return receipt(selection, "expired", false, "Protected input expired before delivery.");
        }
        if (error.code === "cancelled") {
          return receipt(selection, "cancelled", false, "Protected input delivery was cancelled.");
        }
      }
      return receipt(selection, "failed", false, "Protected input delivery failed.");
    } finally {
      if (waitAnnounced && snapshot !== undefined) {
        const current = this.#broker.getRequest(snapshot.id, input.scope) ?? snapshot;
        try {
          await this.#onWaitStateChange?.({
            state: "input_resolved",
            request: structuredClone(current)
          });
        } catch {
          // Delivery outcome remains authoritative after the wait has settled.
        }
      }
      controller.dispose();
    }
  }
}

function receipt(
  selection: SelectedSecureInputTransport | undefined,
  status: SecureInputReceipt["status"],
  persisted: boolean,
  reason?: string
): SecureInputReceipt {
  return {
    status,
    destinationLabel: selection?.verifiedDestination.label ?? "Protected destination",
    persisted,
    ...(reason === undefined ? {} : { reason })
  };
}

function failureReceipt(selection: SelectedSecureInputTransport, reason: string): SecureInputReceipt {
  return receipt(selection, "failed", false, reason);
}

function cancelPending(broker: EphemeralSecretBroker, requestId: string, scope: SecureInputScope): void {
  try {
    const current = broker.getRequest(requestId, scope);
    if (current !== undefined && (current.status === "awaiting_input" || current.status === "ready" || current.status === "consuming")) {
      broker.cancelRequest(requestId, scope);
    }
  } catch {
    // A terminal or already-pruned request needs no further cleanup.
  }
}

function linkedAbortController(signal: AbortSignal | undefined): AbortController & { dispose(): void } {
  const controller = new AbortController() as AbortController & { dispose(): void };
  const onAbort = () => controller.abort(signal?.reason);
  if (signal?.aborted === true) controller.abort(signal.reason);
  else signal?.addEventListener("abort", onAbort, { once: true });
  controller.dispose = () => signal?.removeEventListener("abort", onAbort);
  return controller;
}
