import type {
  SecureInputCollector,
  SecureInputConsumer,
  SecureInputGroupReceipt,
  SecureInputGroupRequest,
  GroupedSecureInputRequestHandler,
  SecureInputReceipt,
  SecureInputRequest,
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

  createRequestHandler(scope: SecureInputScope, signal?: AbortSignal): GroupedSecureInputRequestHandler {
    const boundScope = structuredClone(scope);
    const handler = (async (request, consume) => await this.request({
      scope: boundScope,
      request,
      consume,
      signal
    })) as GroupedSecureInputRequestHandler;
    handler.requestGroup = async (request) => await this.requestGroup({
      scope: boundScope,
      group: request,
      signal
    });
    return handler;
  }

  async requestGroup(input: {
    scope: SecureInputScope;
    group: SecureInputGroupRequest;
    signal?: AbortSignal;
  }): Promise<SecureInputGroupReceipt> {
    validateGroup(input.group);
    const controller = linkedAbortController(input.signal);
    const entries: Array<{
      id: string;
      request: SecureInputRequest;
      consume: SecureInputConsumer;
      selection: SelectedSecureInputTransport;
      snapshot?: SecureInputRequestSnapshot;
      waitAnnounced: boolean;
      receipt?: SecureInputReceipt;
    }> = [];

    try {
      // Bind and authorize every destination before asking the operator for any value.
      for (const item of input.group.items) {
        const selection = await this.#transports.select({
          request: item.request,
          signal: controller.signal
        });
        entries.push({
          id: item.id,
          request: item.request,
          consume: item.consume,
          selection,
          waitAnnounced: false
        });
        const assessment = assessSecureInputPolicy(item.request, selection.policy);
        if (assessment.decision === "deny") {
          throw new Error("The requested retention is not supported by this destination.");
        }
        if (assessment.decision === "ask") {
          const decision = this.#authorize === undefined
            ? "denied"
            : await this.#authorize({
                request: structuredClone(item.request),
                transportId: selection.transport.id,
                destinationLabel: selection.verifiedDestination.label,
                assessment
              });
          if (decision !== "approved" || controller.signal.aborted) {
            throw new Error("Protected input delivery was not authorized.");
          }
        }
      }

      for (const entry of entries) {
        entry.snapshot = this.#broker.createRequest({
          scope: input.scope,
          request: entry.request,
          signal: controller.signal
        });
        entry.waitAnnounced = true;
        await this.#onWaitStateChange?.({
          state: "waiting_for_input",
          request: structuredClone(entry.snapshot)
        });
      }

      // Collection is deliberately sequential inside one runtime call. The model
      // cannot observe, relay, or run another provider turn between fields.
      for (const [index, entry] of entries.entries()) {
        const collected = await this.#collect(
          structuredClone(entry.snapshot!),
          controller.signal,
          {
            verifiedDestinationLabel: entry.selection.verifiedDestination.label,
            group: {
              purpose: input.group.purpose,
              index: index + 1,
              total: entries.length
            }
          }
        );
        if (collected.status === "cancelled" || controller.signal.aborted) {
          for (const candidate of entries) {
            if (candidate.snapshot !== undefined) {
              cancelPending(this.#broker, candidate.snapshot.id, input.scope);
            }
          }
          const cleared = await this.#abort(entries.map((entry) => ({
            request: entry.request,
            selection: entry.selection
          })));
          return groupReceipt(
            entries,
            cleared ? "cancelled" : "failed",
            cleared
              ? "Protected input collection was cancelled."
              : protectedInputClearBlocker()
          );
        }
        try {
          this.#broker.provideSecret({
            requestId: entry.snapshot!.id,
            scope: input.scope,
            value: collected.value
          });
        } finally {
          collected.value.fill(0);
        }
      }

      // Re-verify the complete form before any value is delivered. This prevents
      // collection-time navigation or DOM replacement from redirecting a field.
      for (const entry of entries) {
        await this.#transports.reverify({
          selection: entry.selection,
          request: entry.request,
          signal: controller.signal
        });
      }

      for (const entry of entries) {
        await this.#deliver({
          scope: input.scope,
          request: entry.request,
          consume: entry.consume,
          selection: entry.selection,
          snapshot: entry.snapshot!,
          signal: controller.signal
        });
        entry.receipt = receipt(
          entry.selection,
          "delivered",
          entry.selection.policy.persistence !== "none"
        );
      }
      return groupReceipt(entries, "delivered");
    } catch (error) {
      for (const entry of entries) {
        if (entry.snapshot !== undefined) cancelPending(this.#broker, entry.snapshot.id, input.scope);
      }
      const cleared = await this.#abort(entries.map((entry) => ({
        request: entry.request,
        selection: entry.selection
      })));
      const status = error instanceof SecureInputBrokerError && error.code === "expired"
        ? "expired"
        : error instanceof SecureInputBrokerError && error.code === "cancelled"
          ? "cancelled"
          : "failed";
      return groupReceipt(
        entries,
        cleared ? status : "failed",
        !cleared
          ? protectedInputClearBlocker()
          : status === "expired"
          ? "Protected input expired before delivery."
          : status === "cancelled"
            ? "Protected input delivery was cancelled."
            : "Protected input delivery failed."
      );
    } finally {
      for (const entry of entries) {
        try {
          await entry.selection.transport.release?.(structuredClone(entry.request));
        } catch {
          // Guard cleanup is best-effort and cannot change the group receipt.
        }
        if (entry.waitAnnounced && entry.snapshot !== undefined) {
          const current = this.#broker.getRequest(entry.snapshot.id, input.scope) ?? entry.snapshot;
          try {
            await this.#onWaitStateChange?.({
              state: "input_resolved",
              request: structuredClone(current)
            });
          } catch {
            // Delivery outcome remains authoritative after the wait has settled.
          }
        }
      }
      controller.dispose();
    }
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

      const collected = await this.#collect(structuredClone(snapshot), controller.signal, {
        verifiedDestinationLabel: selection.verifiedDestination.label
      });
      if (collected.status === "cancelled" || controller.signal.aborted) {
        this.#broker.cancelRequest(snapshot.id, input.scope);
        const cleared = await this.#abort([{ request: input.request, selection }]);
        return receipt(
          selection,
          cleared ? "cancelled" : "failed",
          false,
          cleared ? "Protected input collection was cancelled." : protectedInputClearBlocker()
        );
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

      await this.#deliver({
        scope: input.scope,
        request: input.request,
        consume: input.consume,
        selection,
        snapshot,
        signal: controller.signal
      });

      return receipt(
        selection,
        "delivered",
        selection.policy.persistence !== "none"
      );
    } catch (error) {
      if (snapshot !== undefined) cancelPending(this.#broker, snapshot.id, input.scope);
      const cleared = selection === undefined
        ? true
        : await this.#abort([{ request: input.request, selection }]);
      if (!cleared) {
        return receipt(selection, "failed", false, protectedInputClearBlocker());
      }
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
      if (selection !== undefined) {
        try {
          await selection.transport.release?.(structuredClone(input.request));
        } catch {
          // Guard cleanup is best-effort and cannot change the delivery receipt.
        }
      }
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

  async #deliver(input: {
    scope: SecureInputScope;
    request: SecureInputRequest;
    consume: SecureInputConsumer;
    selection: SelectedSecureInputTransport;
    snapshot: SecureInputRequestSnapshot;
    signal: AbortSignal;
  }): Promise<void> {
    const selectedTransport = input.selection.transport;
    let consumerCalled = false;
    await this.#broker.consume({
      requestId: input.snapshot.id,
      scope: input.scope,
      destination: input.selection.verifiedDestination.destination,
      signal: input.signal
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
  }

  async #abort(entries: readonly {
    request: SecureInputRequest;
    selection: SelectedSecureInputTransport;
  }[]): Promise<boolean> {
    const byTransport = new Map<SelectedSecureInputTransport["transport"], SecureInputRequest[]>();
    for (const entry of entries) {
      const requests = byTransport.get(entry.selection.transport) ?? [];
      requests.push(structuredClone(entry.request));
      byTransport.set(entry.selection.transport, requests);
    }
    try {
      for (const [transport, requests] of byTransport) {
        await transport.abort?.(requests);
      }
      return true;
    } catch {
      return false;
    }
  }
}

function validateGroup(group: SecureInputGroupRequest): void {
  if (typeof group.purpose !== "string" || group.purpose.trim().length === 0 || group.purpose.length > 500) {
    throw new Error("A protected-input group requires a bounded purpose.");
  }
  if (!Array.isArray(group.items) || group.items.length < 1 || group.items.length > 8) {
    throw new Error("A protected-input group must contain between one and eight items.");
  }
  const ids = new Set<string>();
  for (const item of group.items) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/u.test(item.id) || ids.has(item.id)) {
      throw new Error("Protected-input group item identifiers must be unique and bounded.");
    }
    ids.add(item.id);
    if (typeof item.consume !== "function") throw new Error("A protected-input group item requires a consumer.");
  }
}

function groupReceipt(
  entries: readonly {
    id: string;
    selection: SelectedSecureInputTransport;
    receipt?: SecureInputReceipt;
  }[],
  status: SecureInputReceipt["status"],
  reason?: string
): SecureInputGroupReceipt {
  return {
    status,
    items: entries.map((entry) => ({
      id: entry.id,
      receipt: entry.receipt ?? receipt(entry.selection, status, false, reason)
    })),
    ...(reason === undefined ? {} : { reason })
  };
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

function protectedInputClearBlocker(): string {
  return "Protected input delivery failed and clearing could not be verified. The destination remains protected; review it locally before retrying.";
}

function linkedAbortController(signal: AbortSignal | undefined): AbortController & { dispose(): void } {
  const controller = new AbortController() as AbortController & { dispose(): void };
  const onAbort = () => controller.abort(signal?.reason);
  if (signal?.aborted === true) controller.abort(signal.reason);
  else signal?.addEventListener("abort", onAbort, { once: true });
  controller.dispose = () => signal?.removeEventListener("abort", onAbort);
  return controller;
}
