import type {
  SecureInputCollector,
  SecureInputConsumer,
  SecureInputGroupReceipt,
  SecureInputGroupRequest,
  GroupedSecureInputRequestHandler,
  SecureInputReceipt,
  SecureInputRequest,
  SecureInputRequestSnapshot,
  SecureInputScope,
  SecureInputTransferRequest,
  SecureInputTransferGroupConsumer,
  SecureInputTransferGroupRequest,
  SecureInputTransferRequestHandler
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
import type { ProtectedBrowserValueSource } from "../security/protected-browser-value-source.js";
import type {
  SecureInputDisclosureBoundary,
  SecureInputPersistenceBehavior,
} from "../security/secure-input-policy.js";

export type SecureInputAuthorizationHandler = (input: {
  request: SecureInputRequest;
  transportId: string;
  destinationLabel: string;
  assessment: SecureInputPolicyAssessment;
  transfer?: {
    sourceLabel: string;
    credentialLabel: string;
    persistence: SecureInputPersistenceBehavior | "unknown";
    sharing: "private" | "workspace" | "account" | "external" | "unknown";
    disclosureBoundary: SecureInputDisclosureBoundary;
  };
  transferGroup?: {
    purpose: string;
    items: readonly {
      sourceLabel: string;
      credentialLabel: string;
      destinationLabel: string;
      persistence: "none" | "destination-managed" | "unknown";
      sharing: "private" | "workspace" | "account" | "external" | "unknown";
    }[];
  };
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
  browserSource?: ProtectedBrowserValueSource;
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
  readonly #browserSource: ProtectedBrowserValueSource | undefined;
  readonly #authorize: SecureInputAuthorizationHandler | undefined;
  readonly #onWaitStateChange: SecureInputWaitHandler | undefined;

  constructor(options: SecureInputCoordinatorOptions) {
    this.#broker = options.broker;
    this.#transports = options.transports;
    this.#collect = options.collect;
    this.#browserSource = options.browserSource;
    this.#authorize = options.authorize;
    this.#onWaitStateChange = options.onWaitStateChange;
  }

  createRequestHandler(scope: SecureInputScope, signal?: AbortSignal): SecureInputTransferRequestHandler {
    const boundScope = structuredClone(scope);
    const handler = (async (request, consume) => await this.request({
      scope: boundScope,
      request,
      consume,
      signal
    })) as SecureInputTransferRequestHandler;
    handler.requestGroup = async (request) => await this.requestGroup({
      scope: boundScope,
      group: request,
      signal
    });
    handler.transfer = async (transfer, consume) => await this.transfer({
      scope: boundScope,
      transfer,
      consume,
      signal,
    });
    handler.transferGroup = async (transfer, consume) => await this.transferGroup({
      scope: boundScope,
      transfer,
      consume,
      signal,
    });
    return handler;
  }

  async transferGroup(input: {
    scope: SecureInputScope;
    transfer: SecureInputTransferGroupRequest;
    consume: SecureInputTransferGroupConsumer;
    signal?: AbortSignal;
  }): Promise<SecureInputGroupReceipt> {
    validateTransferGroup(input.transfer);
    const controller = linkedAbortController(input.signal);
    const entries: Array<{
      id: string;
      request: SecureInputRequest;
      selection: SelectedSecureInputTransport;
      source?: Awaited<ReturnType<ProtectedBrowserValueSource["prepare"]>>;
      snapshot?: SecureInputRequestSnapshot;
      handling: NonNullable<SecureInputTransferGroupRequest["items"][number]["handling"]>;
      receipt?: SecureInputReceipt;
    }> = [];
    try {
      if (this.#browserSource === undefined) throw new Error("Protected browser transfer is unavailable.");
      for (const item of input.transfer.items) {
        const selection = await this.#transports.select({ request: item.request, signal: controller.signal });
        const assessment = assessSecureInputPolicy(item.request, selection.policy);
        if (assessment.decision === "deny") throw new Error("The requested retention is not supported by this destination.");
        const entry: (typeof entries)[number] = {
          id: item.id,
          request: item.request,
          selection,
          handling: item.handling ?? { persistence: "unknown", sharing: "unknown" },
        };
        entries.push(entry);
        entry.source = await this.#browserSource.prepare({
          source: item.source,
          kind: item.request.kind,
          signal: controller.signal,
        });
      }

      const first = entries[0]!;
      const decision = this.#authorize === undefined
        ? "denied"
        : await this.#authorize({
            request: structuredClone(first.request),
            transportId: first.selection.transport.id,
            destinationLabel: `${entries.length} protected destinations`,
            assessment: assessSecureInputPolicy(first.request, first.selection.policy),
            transferGroup: {
              purpose: input.transfer.purpose,
              items: entries.map((entry) => ({
                sourceLabel: entry.source!.label,
                credentialLabel: secureInputKindLabel(entry.request.kind),
                destinationLabel: entry.selection.verifiedDestination.label,
                persistence: entry.handling.persistence,
                sharing: entry.handling.sharing,
              })),
            },
          });
      if (decision !== "approved" || controller.signal.aborted) {
        throw new Error("Protected transfer was not authorized.");
      }

      for (const entry of entries) {
        await this.#transports.reverify({ selection: entry.selection, request: entry.request, signal: controller.signal });
      }
      for (const entry of entries) {
        const value = await this.#browserSource.read({
          verified: entry.source!,
          kind: entry.request.kind,
          signal: controller.signal,
        });
        try {
          entry.snapshot = this.#broker.createRequest({ scope: input.scope, request: entry.request, signal: controller.signal });
          this.#broker.provideSecret({ requestId: entry.snapshot.id, scope: input.scope, value });
        } finally {
          value.fill(0);
        }
      }
      for (const entry of entries) {
        await this.#transports.reverify({ selection: entry.selection, request: entry.request, signal: controller.signal });
      }
      await this.#deliverTransferGroup({
        scope: input.scope,
        entries: entries.map((entry) => ({ ...entry, snapshot: entry.snapshot! })),
        consume: input.consume,
        signal: controller.signal,
      });
      for (const entry of entries) {
        entry.receipt = receipt(entry.selection, "delivered", entry.handling.persistence === "destination-managed");
      }
      return groupReceipt(entries, "delivered");
    } catch {
      for (const entry of entries) {
        if (entry.snapshot !== undefined) cancelPending(this.#broker, entry.snapshot.id, input.scope);
      }
      const cleared = await this.#abort(entries.map((entry) => ({ request: entry.request, selection: entry.selection })));
      return groupReceipt(entries, "failed", cleared ? "Protected group transfer failed before dispatch." : protectedInputClearBlocker());
    } finally {
      for (const entry of entries) {
        if (entry.source !== undefined) {
          await this.#browserSource?.release(entry.source.source).catch(() => undefined);
        }
        try {
          await entry.selection.transport.release?.(structuredClone(entry.request));
        } catch {
          // Runtime-only bindings are best-effort after a terminal receipt.
        }
      }
      controller.dispose();
    }
  }

  async transfer(input: {
    scope: SecureInputScope;
    transfer: SecureInputTransferRequest;
    consume: SecureInputConsumer;
    signal?: AbortSignal;
  }): Promise<SecureInputReceipt> {
    const controller = linkedAbortController(input.signal);
    let selection: SelectedSecureInputTransport | undefined;
    let source: Awaited<ReturnType<ProtectedBrowserValueSource["prepare"]>> | undefined;
    let snapshot: SecureInputRequestSnapshot | undefined;
    try {
      if (this.#browserSource === undefined) throw new Error("Protected browser transfer is unavailable.");
      selection = await this.#transports.select({
        request: input.transfer.request,
        signal: controller.signal,
      });
      const assessment = assessSecureInputPolicy(input.transfer.request, selection.policy);
      if (assessment.decision === "deny") {
        return failureReceipt(selection, "The requested retention is not supported by this destination.");
      }
      source = await this.#browserSource.prepare({
        source: input.transfer.source,
        kind: input.transfer.request.kind,
        signal: controller.signal,
      });
      const decision = this.#authorize === undefined
        ? "denied"
        : await this.#authorize({
            request: structuredClone(input.transfer.request),
            transportId: selection.transport.id,
            destinationLabel: selection.verifiedDestination.label,
            assessment,
            transfer: {
              sourceLabel: source.label,
              credentialLabel: secureInputKindLabel(input.transfer.request.kind),
              persistence: input.transfer.handling?.persistence ?? selection.policy.persistence,
              sharing: input.transfer.handling?.sharing ?? "unknown",
              disclosureBoundary: selection.policy.disclosureBoundary,
            },
          });
      if (decision !== "approved" || controller.signal.aborted) {
        return failureReceipt(selection, "Protected transfer was not authorized.");
      }

      await this.#transports.reverify({
        selection,
        request: input.transfer.request,
        signal: controller.signal,
      });
      const value = await this.#browserSource.read({
        verified: source,
        kind: input.transfer.request.kind,
        signal: controller.signal,
      });
      try {
        snapshot = this.#broker.createRequest({
          scope: input.scope,
          request: input.transfer.request,
          signal: controller.signal,
        });
        this.#broker.provideSecret({
          requestId: snapshot.id,
          scope: input.scope,
          value,
        });
      } finally {
        value.fill(0);
      }
      await this.#transports.reverify({
        selection,
        request: input.transfer.request,
        signal: controller.signal,
      });
      await this.#deliver({
        scope: input.scope,
        request: input.transfer.request,
        consume: input.consume,
        selection,
        snapshot,
        signal: controller.signal,
      });
      return receipt(
        selection,
        "delivered",
        input.transfer.handling?.persistence === "destination-managed" || selection.policy.persistence !== "none"
      );
    } catch {
      if (snapshot !== undefined) cancelPending(this.#broker, snapshot.id, input.scope);
      if (selection !== undefined) await this.#abort([{ request: input.transfer.request, selection }]);
      return receipt(selection, "failed", false, "Protected transfer failed.");
    } finally {
      if (source !== undefined) {
        await this.#browserSource?.release(source.source).catch(() => undefined);
      }
      if (selection !== undefined) {
        try {
          await selection.transport.release?.(structuredClone(input.transfer.request));
        } catch {
          // Runtime-only bindings are best-effort after a terminal receipt.
        }
      }
      controller.dispose();
    }
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

  async #deliverTransferGroup(input: {
    scope: SecureInputScope;
    entries: readonly {
      id: string;
      request: SecureInputRequest;
      selection: SelectedSecureInputTransport;
      snapshot: SecureInputRequestSnapshot;
    }[];
    consume: SecureInputTransferGroupConsumer;
    signal: AbortSignal;
  }): Promise<void> {
    const values: Array<Parameters<SecureInputTransferGroupConsumer>[0][number]> = [];
    const visit = async (index: number): Promise<void> => {
      const entry = input.entries[index];
      if (entry === undefined) {
        await input.consume(values);
        return;
      }
      let consumerCalled = false;
      await this.#broker.consume({
        requestId: entry.snapshot.id,
        scope: input.scope,
        destination: entry.selection.verifiedDestination.destination,
        signal: input.signal,
      }, async (value, context) => {
        await entry.selection.transport.deliver({
          value,
          context,
          consume: async (candidate, candidateContext) => {
            if (consumerCalled) throw new Error("Secure-input consumer replay was blocked.");
            if (candidate !== value || candidateContext !== context) {
              throw new Error("Secure-input transport substitution was blocked.");
            }
            consumerCalled = true;
            values.push({ id: entry.id, value: candidate, context: candidateContext });
            try {
              await visit(index + 1);
            } finally {
              values.pop();
            }
          },
        });
        if (!consumerCalled) throw new Error("Secure-input transport did not invoke its consumer.");
      });
    };
    await visit(0);
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

function secureInputKindLabel(kind: SecureInputRequest["kind"]): string {
  return kind.replaceAll("-", " ");
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

function validateTransferGroup(group: SecureInputTransferGroupRequest): void {
  if (typeof group.purpose !== "string" || group.purpose.trim().length === 0 || group.purpose.length > 500) {
    throw new Error("A protected-transfer group requires a bounded purpose.");
  }
  if (!Array.isArray(group.items) || group.items.length < 2 || group.items.length > 8) {
    throw new Error("A protected-transfer group must contain between two and eight items.");
  }
  const ids = new Set<string>();
  const destinations = new Set<string>();
  let target: string | undefined;
  for (const item of group.items) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/u.test(item.id) || ids.has(item.id)) {
      throw new Error("Protected-transfer group item identifiers must be unique and bounded.");
    }
    ids.add(item.id);
    const destination = item.request.destination;
    if (destination.type !== "tool-argument" && destination.type !== "mcp-argument") {
      throw new Error("Atomic protected-transfer groups support reviewed tool arguments only.");
    }
    const destinationTarget = destination.type === "tool-argument"
      ? `tool:${destination.toolName}`
      : `mcp:${destination.serverId}:${destination.toolName}`;
    if (target !== undefined && target !== destinationTarget) {
      throw new Error("An atomic protected-transfer group must target one tool invocation.");
    }
    target = destinationTarget;
    const destinationKey = `${destinationTarget}:${destination.argumentPath}`;
    if (destinations.has(destinationKey)) {
      throw new Error("Protected-transfer destinations must be unique.");
    }
    destinations.add(destinationKey);
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
