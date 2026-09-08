import { isDeepStrictEqual } from "node:util";
import type {
  BrowserActionDelta,
  BrowserProtectedFieldDeliveryInput,
  BrowserProtectedFieldDeliveryResult,
  BrowserProtectedFieldInput,
  BrowserProtectedFieldVerification,
  BrowserSnapshot,
  BrowserStateIdentity,
} from "../contracts/browser.js";
import type { BrowserSnapshotInput } from "./snapshot-state.js";
import type { BrowserFieldSecureInputDestination, SecureInputKind } from "../contracts/secure-input.js";
import { redactUrlForMetadata } from "./url-safety.js";

export type ProtectedFieldPageSession = {
  key: string;
  tabRef: string;
  supervisor: {
    send(method: string, params?: Record<string, unknown>): Promise<unknown>;
    getSnapshot(sessionId?: string): Promise<BrowserSnapshotInput>;
    setSensitiveInputActive?(active: boolean): void;
  };
};

type ProtectedFormTransactionState =
  | "bound"
  | "awaiting-values"
  | "delivering"
  | "submitted"
  | "automatic"
  | "settling"
  | "departed"
  | "still-present"
  | "blocked";

type ProtectedFieldBinding = {
  destination: BrowserFieldSecureInputDestination;
  kind: SecureInputKind;
  objectId: string;
  elementIndex: number;
  explicitEmail: boolean;
  deliveryAttempted: boolean;
  delivered: boolean;
  released: boolean;
};

type ProtectedSubmitBinding = {
  ref: string;
  objectId: string;
  elementIndex: number;
};

type ActiveProtectedFormTransaction = {
  /** Backend-private identity. It is never placed in a destination or tool result. */
  id: number;
  sessionId: string;
  tabRef: string;
  expectedOrigin: string;
  frameId?: string;
  sourceIdentity: BrowserStateIdentity;
  documentObjectId: string;
  supervisor: ProtectedFieldPageSession["supervisor"];
  fields: Map<string, ProtectedFieldBinding>;
  submit?: ProtectedSubmitBinding;
  state: ProtectedFormTransactionState;
  submission: ProtectedFieldDeliveryOutcome["submission"];
  released: boolean;
};

type FieldInspection = {
  connected: boolean;
  current: boolean;
  visible: boolean;
  disabled: boolean;
  editable: boolean;
  semanticsMatch: boolean;
  explicitEmail: boolean;
  conflictCount: number;
};

type SubmitInspection = {
  connected: boolean;
  current: boolean;
  visible: boolean;
  disabled: boolean;
  clickable: boolean;
  semanticsMatch: boolean;
  conflictCount: number;
};

export type ProtectedFieldDeliveryOutcome = {
  submission: "not-requested" | "clicked" | "automatic" | "failed";
};

export class ProtectedBrowserFieldError extends Error {
  constructor(
    public readonly code:
      | "sensitive-input-active"
      | "protected-field-delivery-failed"
      | "protected-field-value-incompatible"
      | "protected-field-clear-unverified",
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "ProtectedBrowserFieldError";
  }
}

/** Owns protected-form bindings, delivery, submission, settlement, and CDP object lifetime. */
export class ProtectedBrowserFormTransactionController {
  readonly #transactions = new Map<string, Map<number, ActiveProtectedFormTransaction>>();
  readonly #transactionsByBinding = new Map<string, Map<string, ActiveProtectedFormTransaction>>();
  readonly #deliveryResults = new Map<string, BrowserProtectedFieldDeliveryResult>();
  #nextTransactionId = 1;

  isActive(sessionId: string): boolean {
    return (this.#transactions.get(sessionId)?.size ?? 0) > 0;
  }

  isSensitive(sessionId: string): boolean {
    return [...(this.#transactions.get(sessionId)?.values() ?? [])]
      .some((transaction) => this.#requiresProtection(transaction));
  }

  isSettling(sessionId: string): boolean {
    return [...(this.#transactions.get(sessionId)?.values() ?? [])]
      .some((transaction) => transaction.state === "settling");
  }

  async verify(
    session: ProtectedFieldPageSession,
    input: BrowserProtectedFieldInput
  ): Promise<BrowserProtectedFieldVerification> {
    if (input.signal?.aborted === true || input.destination.sessionId !== session.key) {
      return { status: "rejected", reason: "session-mismatch" };
    }
    if (input.destination.identity === undefined) {
      return { status: "rejected", reason: "field-replaced" };
    }
    if (input.destination.tabRef !== undefined && input.destination.tabRef !== session.tabRef) {
      return { status: "rejected", reason: "tab-mismatch" };
    }

    const snapshot = await session.supervisor.getSnapshot(session.key);
    if (originOf(snapshot.url) !== normalizeOrigin(input.destination.expectedOrigin)) {
      return { status: "rejected", reason: "origin-mismatch" };
    }
    const frameId = await currentMainFrameId(session.supervisor);
    if (input.destination.frameId !== undefined && input.destination.frameId !== frameId) {
      return { status: "rejected", reason: "frame-mismatch" };
    }

    if (input.phase === "before-collection") {
      const bindingKey = destinationBindingKey(input.destination);
      if (this.#transactionsByBinding.get(session.key)?.has(bindingKey) === true) {
        return { status: "rejected", reason: "field-ambiguous" };
      }
      const compatible = await this.#findCompatibleTransaction(session, input.destination, frameId);
      if ([...(this.#transactions.get(session.key)?.values() ?? [])]
        .some((transaction) => transaction !== compatible && this.#requiresProtection(transaction))) {
        return { status: "rejected", reason: "field-ambiguous" };
      }
      if (compatible !== undefined && await inspectDocument(session.supervisor, compatible.documentObjectId) !== true) {
        return { status: "rejected", reason: "field-replaced" };
      }
      const documentObjectId = compatible?.documentObjectId ?? await resolveDocumentObjectId(session.supervisor);
      if (documentObjectId === undefined) return { status: "rejected", reason: "field-missing" };
      const elementIndex = refToIndex(input.destination.ref);
      if (elementIndex === undefined) {
        if (compatible === undefined) await releaseObject(session.supervisor, documentObjectId);
        return { status: "rejected", reason: "field-missing" };
      }
      const objectId = await resolveFieldObjectId(session.supervisor, elementIndex);
      if (objectId === undefined) {
        if (compatible === undefined) await releaseObject(session.supervisor, documentObjectId);
        return { status: "rejected", reason: "field-missing" };
      }
      const inspection = await inspectField(session.supervisor, objectId, elementIndex, input.kind);
      const rejection = inspectionRejection(inspection, false);
      if (rejection !== undefined) {
        await releaseObject(session.supervisor, objectId);
        if (compatible === undefined) await releaseObject(session.supervisor, documentObjectId);
        return rejection;
      }
      const submit = compatible?.submit ?? await bindSubmit(session.supervisor, input.destination.submit?.ref);
      if (input.destination.submit !== undefined && submit === undefined) {
        await releaseObject(session.supervisor, objectId);
        if (compatible === undefined) await releaseObject(session.supervisor, documentObjectId);
        return { status: "rejected", reason: "field-missing" };
      }
      if (compatible?.submit !== undefined && !submitIsActionable(await inspectSubmit(
        session.supervisor,
        compatible.submit.objectId,
        compatible.submit.elementIndex
      ))) {
        await releaseObject(session.supervisor, objectId);
        return { status: "rejected", reason: "field-replaced" };
      }
      const transaction = compatible ?? this.#createTransaction({
        session,
        destination: input.destination,
        frameId,
        documentObjectId,
        submit,
      });
      const field: ProtectedFieldBinding = {
        destination: structuredClone(input.destination),
        kind: input.kind,
        objectId,
        elementIndex,
        explicitEmail: inspection!.explicitEmail,
        deliveryAttempted: false,
        delivered: false,
        released: false,
      };
      transaction.fields.set(bindingKey, field);
      transaction.state = "awaiting-values";
      const bindings = this.#transactionsByBinding.get(session.key) ?? new Map();
      bindings.set(bindingKey, transaction);
      this.#transactionsByBinding.set(session.key, bindings);
      this.#syncSensitiveState(session.key, session.supervisor);
      return { status: "verified" };
    }

    const transaction = this.#findTransaction(input.destination);
    const active = transaction?.fields.get(destinationBindingKey(input.destination));
    if (transaction === undefined || active === undefined || active.kind !== input.kind ||
        !isDeepStrictEqual(active.destination, input.destination) ||
        !["awaiting-values", "delivering"].includes(transaction.state)) {
      return { status: "rejected", reason: "request-not-active" };
    }
    if (transaction.supervisor !== session.supervisor) return { status: "rejected", reason: "field-replaced" };
    if (transaction.tabRef !== session.tabRef) return { status: "rejected", reason: "tab-mismatch" };
    if (transaction.frameId !== frameId) return { status: "rejected", reason: "frame-mismatch" };
    if (await inspectDocument(session.supervisor, transaction.documentObjectId) !== true) {
      return { status: "rejected", reason: "field-replaced" };
    }
    for (const field of transaction.fields.values()) {
      const inspection = await inspectField(
        session.supervisor,
        field.objectId,
        field.elementIndex,
        field.kind
      );
      const rejection = inspectionRejection(inspection, true);
      if (rejection !== undefined) return rejection;
    }
    if (transaction.submit !== undefined) {
      const submitInspection = await inspectSubmit(
        session.supervisor,
        transaction.submit.objectId,
        transaction.submit.elementIndex
      );
      if (!submitIsActionable(submitInspection)) {
        return { status: "rejected", reason: "field-replaced" };
      }
    }
    return { status: "verified" };
  }

  async deliver(
    session: ProtectedFieldPageSession,
    input: BrowserProtectedFieldDeliveryInput
  ): Promise<ProtectedFieldDeliveryOutcome> {
    const verified = await this.verify(session, {
      destination: input.destination,
      kind: input.kind,
      phase: "before-delivery",
      signal: input.signal,
    });
    if (verified.status !== "verified") {
      throw new ProtectedBrowserFieldError(
        "protected-field-delivery-failed",
        "Protected browser field changed before delivery."
      );
    }
    const transaction = this.#findTransaction(input.destination)!;
    const active = transaction.fields.get(destinationBindingKey(input.destination))!;
    const value = new TextDecoder("utf-8", { fatal: true }).decode(input.value);
    if (active.kind === "account-identifier" && active.explicitEmail && /^\d{6}$/u.test(value.trim())) {
      throw new ProtectedBrowserFieldError(
        "protected-field-value-incompatible",
        "Protected value is incompatible with the verified browser destination."
      );
    }
    try {
      transaction.state = "delivering";
      active.deliveryAttempted = true;
      const result = await session.supervisor.send("Runtime.callFunctionOn", {
        objectId: active.objectId,
        functionDeclaration: PROTECTED_FIELD_DELIVERY_FUNCTION,
        arguments: [
          { value: active.elementIndex },
          { value },
        ],
        returnByValue: true,
        awaitPromise: true,
      }) as { result?: { value?: unknown } };
      if (result.result?.value !== true) {
        throw new Error("Protected browser field rejected delivery.");
      }
      active.delivered = true;
      this.#syncSensitiveState(session.key, session.supervisor);
      if (transaction.submit === undefined || ![...transaction.fields.values()].every((field) => field.delivered)) {
        transaction.submission = "not-requested";
        return { submission: "not-requested" };
      }

      // Give synchronous/very-fast auto-submit handlers a chance to replace the
      // challenge before dispatching an explicit click. This stays entirely in
      // the local runtime; no provider turn occurs between delivery and submit.
      await shortDelay(75, input.signal);
      const challengeCurrent = await this.#isTransactionChallengeCurrent(transaction);
      if (challengeCurrent === false) {
        transaction.state = "automatic";
        transaction.submission = "automatic";
        return { submission: "automatic" };
      }
      const submitInspection = await inspectSubmit(
        session.supervisor,
        transaction.submit.objectId,
        transaction.submit.elementIndex
      );
      if (!submitIsActionable(submitInspection)) {
        transaction.state = "blocked";
        transaction.submission = "failed";
        return { submission: "failed" };
      }
      const clicked = await session.supervisor.send("Runtime.callFunctionOn", {
        objectId: transaction.submit.objectId,
        functionDeclaration: PROTECTED_SUBMIT_FUNCTION,
        arguments: [{ value: transaction.submit.elementIndex }],
        returnByValue: true,
        awaitPromise: true,
      }) as { result?: { value?: unknown } };
      transaction.submission = clicked.result?.value === true ? "clicked" : "failed";
      transaction.state = transaction.submission === "clicked" ? "submitted" : "blocked";
      return { submission: transaction.submission };
    } catch (error) {
      transaction.state = "blocked";
      transaction.submission = "failed";
      if (
        transaction.submit !== undefined &&
        [...transaction.fields.values()].every((field) => field === active || field.delivered) &&
        isNavigationTransitionError(error)
      ) {
        return { submission: "failed" };
      }
      throw new ProtectedBrowserFieldError(
        "protected-field-delivery-failed",
        "Protected browser field delivery failed.",
        { cause: error }
      );
    }
  }

  async release(destination: BrowserFieldSecureInputDestination): Promise<void> {
    const transaction = this.#findTransaction(destination);
    const key = destinationBindingKey(destination);
    const field = transaction?.fields.get(key);
    if (transaction === undefined || field === undefined || field.released) return;
    const finalRelease = [...transaction.fields.values()].every((candidate) => candidate === field || candidate.released);
    const fields = [...transaction.fields.values()];
    if (finalRelease && fields.some((candidate) => candidate.deliveryAttempted) &&
        (fields.some((candidate) => !candidate.delivered) || ["blocked", "still-present"].includes(transaction.state))) {
      await this.#clearDeliveredValues(transaction);
    }
    field.released = true;
    this.#transactionsByBinding.get(destination.sessionId)?.delete(key);
    if ([...transaction.fields.values()].every((candidate) => candidate.released)) {
      if (this.#requiresProtection(transaction)) {
        if (transaction.state === "delivering") transaction.state = "still-present";
        this.#syncSensitiveState(transaction.sessionId, transaction.supervisor);
      } else {
        await this.#releaseTransaction(transaction);
      }
    }
  }

  async abort(
    destinations: readonly BrowserFieldSecureInputDestination[],
    currentIdentity?: BrowserStateIdentity
  ): Promise<void> {
    const transactions = new Set(destinations.flatMap((destination) => {
      const transaction = this.#findTransaction(destination);
      return transaction === undefined ? [] : [transaction];
    }));
    for (const transaction of transactions) {
      if (await this.#hasDeparted(transaction, currentIdentity)) {
        if ([...transaction.fields.values()].some((field) => field.deliveryAttempted)) {
          await this.#clearCurrentChallengeValues(transaction);
        }
        continue;
      }
      if ([...transaction.fields.values()].some((field) => field.deliveryAttempted)) {
        await this.#clearDeliveredValues(transaction);
      }
    }
  }

  async invalidateSession(session: ProtectedFieldPageSession): Promise<void> {
    const active = this.#transactions.get(session.key);
    session.supervisor.setSensitiveInputActive?.(false);
    if (active === undefined) return;
    for (const transaction of [...active.values()]) {
      transaction.state = "departed";
      await this.#releaseTransaction(transaction);
    }
  }

  async clearSession(sessionId: string): Promise<void> {
    const active = this.#transactions.get(sessionId);
    if (active !== undefined) {
      for (const transaction of [...active.values()]) {
        transaction.supervisor.setSensitiveInputActive?.(false);
        await this.#releaseTransaction(transaction);
      }
    }
    for (const key of this.#deliveryResults.keys()) {
      if (key.startsWith(`${sessionId}\u0000`)) this.#deliveryResults.delete(key);
    }
  }

  beginSettlement(destination: BrowserFieldSecureInputDestination): void {
    const transaction = this.#findTransaction(destination);
    if (transaction !== undefined && ["submitted", "automatic", "blocked"].includes(transaction.state)) {
      transaction.state = "settling";
    }
  }

  kindsFor(destination: BrowserFieldSecureInputDestination): readonly SecureInputKind[] {
    const transaction = this.#findTransaction(destination);
    return transaction === undefined
      ? []
      : [...new Set([...transaction.fields.values()].map((field) => field.kind))];
  }

  async reconcile(session: ProtectedFieldPageSession): Promise<void> {
    const active = this.#transactions.get(session.key);
    if (active === undefined) return;
    for (const transaction of [...active.values()]) {
      if (transaction.state === "settling" ||
          ![...transaction.fields.values()].every((field) => field.released)) continue;
      if (!this.#requiresProtection(transaction)) {
        await this.#releaseTransaction(transaction);
        continue;
      }
      const challengeCurrent = await this.#isTransactionChallengeCurrent(transaction);
      if (challengeCurrent === false) {
        transaction.state = "departed";
        await this.#releaseTransaction(transaction);
      } else {
        transaction.state = challengeCurrent === true ? "still-present" : "blocked";
      }
    }
    this.#syncSensitiveState(session.key, session.supervisor);
  }

  async settle(
    session: ProtectedFieldPageSession,
    input: BrowserProtectedFieldDeliveryInput,
    settlement: {
      before: BrowserSnapshot;
      snapshot: BrowserSnapshot;
      fallbackChallengeCurrent?: boolean;
      captureAfterDeparture: () => Promise<BrowserSnapshot>;
    }
  ): Promise<BrowserProtectedFieldDeliveryResult> {
    const transaction = this.#findTransaction(input.destination);
    const submission = transaction?.submission ?? "failed";
    const documentChanged = transaction !== undefined && await this.#hasDeparted(
      transaction,
      settlement.snapshot.identity
    );
    const boundChallengeCurrent = transaction === undefined || documentChanged
      ? undefined
      : await this.#isTransactionChallengeCurrent(transaction);
    // The fresh post-submit snapshot is authoritative even when the original
    // document was replaced. A reload can render the same rejected challenge.
    const challengeCurrent = settlement.fallbackChallengeCurrent ?? boundChallengeCurrent;
    const conditionMet = settlement.snapshot.actionDelta?.conditionMet ?? challengeCurrent === false;
    let snapshot = settlement.snapshot;
    if (challengeCurrent === false) {
      if (transaction !== undefined) transaction.state = "departed";
      await this.invalidateSession(session);
      try {
        snapshot = await settlement.captureAfterDeparture();
      } catch {
        snapshot = releasedProtectedSnapshot(settlement.snapshot);
      }
    } else if (transaction !== undefined) {
      transaction.state = challengeCurrent === true ? "still-present" : "blocked";
      if (transaction.submit !== undefined && submission !== "not-requested") {
        if (documentChanged) {
          await this.#clearCurrentChallengeValues(transaction);
        } else {
          await this.#clearDeliveredValues(transaction);
        }
        snapshot = await settlement.captureAfterDeparture();
      }
    }
    const sensitiveInputActive = this.isSensitive(session.key);
    const result: BrowserProtectedFieldDeliveryResult = {
      delivery: "delivered",
      submission: submission === "failed" && challengeCurrent === false && !sensitiveInputActive
        ? "automatic"
        : submission,
      documentChanged,
      challengeState: challengeCurrent === true
        ? "still-present"
        : !sensitiveInputActive
          ? "departed"
          : "unknown",
      conditionMet,
      beforeIdentity: { ...settlement.before.identity },
      afterIdentity: { ...snapshot.identity },
      sensitiveInputActive,
      snapshot,
    };
    this.#deliveryResults.set(protectedDeliveryKey(input.destination), result);
    return result;
  }

  takeDeliveryResult(destination: BrowserFieldSecureInputDestination): BrowserProtectedFieldDeliveryResult | undefined {
    const key = protectedDeliveryKey(destination);
    const result = this.#deliveryResults.get(key);
    this.#deliveryResults.delete(key);
    return result;
  }

  protectSnapshot(sessionId: string, snapshot: BrowserSnapshot): BrowserSnapshot {
    if (!this.isSensitive(sessionId)) return snapshot;
    return {
      sessionId: snapshot.sessionId,
      url: sensitiveUrl(snapshot.url),
      identity: { ...snapshot.identity },
      observedAt: snapshot.observedAt,
      readiness: snapshot.readiness,
      sensitiveInputActive: true,
      ...(snapshot.actionDelta === undefined ? {} : {
        actionDelta: protectedActionDelta(snapshot.actionDelta),
      }),
      ...(snapshot.tab === undefined ? {} : {
        tab: {
          ref: snapshot.tab.ref,
          url: sensitiveUrl(snapshot.tab.url),
          controlled: snapshot.tab.controlled,
        },
      }),
      ...(snapshot.elements === undefined ? {} : {
        elements: snapshot.elements.map((element) => ({
          ref: element.ref,
          ...(element.role === undefined ? {} : { role: element.role }),
          ...(element.hidden === undefined ? {} : { hidden: element.hidden }),
          ...(element.disabled === undefined ? {} : { disabled: element.disabled }),
          ...(element.checked === undefined ? {} : { checked: element.checked }),
        })),
      }),
    };
  }

  assertVisualObservationAllowed(sessionId: string): void {
    if (!this.isSensitive(sessionId)) return;
    throw new ProtectedBrowserFieldError(
      "sensitive-input-active",
      "Browser screenshots and vision are blocked while protected input is active."
    );
  }

  assertContentObservationAllowed(sessionId: string): void {
    if (!this.isSensitive(sessionId)) return;
    throw new ProtectedBrowserFieldError(
      "sensitive-input-active",
      "Browser extraction is blocked while protected input is active."
    );
  }

  #createTransaction(input: {
    session: ProtectedFieldPageSession;
    destination: BrowserFieldSecureInputDestination;
    frameId?: string;
    documentObjectId: string;
    submit?: ProtectedSubmitBinding;
  }): ActiveProtectedFormTransaction {
    const transaction: ActiveProtectedFormTransaction = {
      id: this.#nextTransactionId++,
      sessionId: input.session.key,
      tabRef: input.session.tabRef,
      expectedOrigin: input.destination.expectedOrigin,
      ...(input.frameId === undefined ? {} : { frameId: input.frameId }),
      sourceIdentity: { ...input.destination.identity! },
      documentObjectId: input.documentObjectId,
      supervisor: input.session.supervisor,
      fields: new Map(),
      ...(input.submit === undefined ? {} : { submit: input.submit }),
      state: "bound",
      submission: "not-requested",
      released: false,
    };
    const transactions = this.#transactions.get(input.session.key) ?? new Map();
    transactions.set(transaction.id, transaction);
    this.#transactions.set(input.session.key, transactions);
    return transaction;
  }

  async #findCompatibleTransaction(
    session: ProtectedFieldPageSession,
    destination: BrowserFieldSecureInputDestination,
    frameId: string | undefined
  ): Promise<ActiveProtectedFormTransaction | undefined> {
    const submitRef = destination.submit?.ref;
    for (const transaction of this.#transactions.get(session.key)?.values() ?? []) {
      if (transaction.state !== "awaiting-values" || transaction.supervisor !== session.supervisor ||
          transaction.tabRef !== session.tabRef || transaction.expectedOrigin !== destination.expectedOrigin ||
          transaction.frameId !== frameId || transaction.submit?.ref !== submitRef ||
          destination.identity === undefined ||
          !sameActionState(transaction.sourceIdentity, destination.identity)) continue;
      return transaction;
    }
    return undefined;
  }

  #findTransaction(destination: BrowserFieldSecureInputDestination): ActiveProtectedFormTransaction | undefined {
    const transaction = this.#transactionsByBinding.get(destination.sessionId)
      ?.get(destinationBindingKey(destination));
    const field = transaction?.fields.get(destinationBindingKey(destination));
    return field !== undefined && isDeepStrictEqual(field.destination, destination) ? transaction : undefined;
  }

  async #isTransactionChallengeCurrent(
    transaction: ActiveProtectedFormTransaction
  ): Promise<boolean | undefined> {
    const documentCurrent = await inspectDocument(transaction.supervisor, transaction.documentObjectId);
    if (documentCurrent === false) return false;
    if (documentCurrent === undefined) return undefined;
    let unknown = false;
    for (const field of transaction.fields.values()) {
      const inspection = await inspectField(
        transaction.supervisor,
        field.objectId,
        field.elementIndex,
        field.kind
      );
      if (inspection === undefined) {
        unknown = true;
        continue;
      }
      if (inspection.connected && inspection.current) return true;
      if (inspection.conflictCount > 0) return true;
    }
    return unknown ? undefined : false;
  }

  async #clearDeliveredValues(transaction: ActiveProtectedFormTransaction): Promise<void> {
    const fields = [...transaction.fields.values()].filter((field) => field.deliveryAttempted);
    if (fields.length === 0) return;
    if (await this.#hasDeparted(transaction)) {
      await this.#clearCurrentChallengeValues(transaction);
      return;
    }
    let verified = true;
    for (const field of fields) {
      try {
        const cleared = await transaction.supervisor.send("Runtime.callFunctionOn", {
          objectId: field.objectId,
          functionDeclaration: PROTECTED_FIELD_CLEAR_FUNCTION,
          arguments: [{ value: field.elementIndex }],
          returnByValue: true,
          awaitPromise: true,
        }) as { result?: { value?: unknown } };
        verified = cleared.result?.value === true && verified;
      } catch {
        verified = false;
      }
    }
    // Allow controlled-input frameworks a brief render turn, then verify every
    // bound field stayed empty without dispatching events that could submit it.
    await shortDelay(25, undefined);
    for (const field of fields) {
      try {
        const inspected = await transaction.supervisor.send("Runtime.callFunctionOn", {
          objectId: field.objectId,
          functionDeclaration: PROTECTED_FIELD_CLEAR_VERIFICATION_FUNCTION,
          arguments: [{ value: field.elementIndex }],
          returnByValue: true,
        }) as { result?: { value?: unknown } };
        verified = inspected.result?.value === true && verified;
      } catch {
        verified = false;
      }
    }
    if (!verified) {
      transaction.state = "blocked";
      throw new ProtectedBrowserFieldError(
        "protected-field-clear-unverified",
        "Protected browser values could not be verified as cleared. The browser remains protected; review it locally before retrying."
      );
    }
    for (const field of fields) {
      field.deliveryAttempted = false;
      field.delivered = false;
    }
    this.#syncSensitiveState(transaction.sessionId, transaction.supervisor);
  }

  async #clearCurrentChallengeValues(transaction: ActiveProtectedFormTransaction): Promise<void> {
    const fields = [...transaction.fields.values()].filter((field) => field.deliveryAttempted);
    if (fields.length === 0) return;
    const documentObjectId = await resolveDocumentObjectId(transaction.supervisor);
    let verified = documentObjectId !== undefined;
    try {
      if (documentObjectId !== undefined) {
        const kinds = [...new Set(fields.map((field) => field.kind))];
        const cleared = await transaction.supervisor.send("Runtime.callFunctionOn", {
          objectId: documentObjectId,
          functionDeclaration: PROTECTED_CURRENT_CHALLENGE_CLEAR_FUNCTION,
          arguments: [{ value: kinds }, { value: true }],
          returnByValue: true,
          awaitPromise: true,
        }) as { result?: { value?: unknown } };
        verified = cleared.result?.value === true;
        await shortDelay(25, undefined);
        const inspected = await transaction.supervisor.send("Runtime.callFunctionOn", {
          objectId: documentObjectId,
          functionDeclaration: PROTECTED_CURRENT_CHALLENGE_CLEAR_FUNCTION,
          arguments: [{ value: kinds }, { value: false }],
          returnByValue: true,
        }) as { result?: { value?: unknown } };
        verified = inspected.result?.value === true && verified;
      }
    } catch {
      verified = false;
    } finally {
      if (documentObjectId !== undefined) await releaseObject(transaction.supervisor, documentObjectId);
    }
    if (!verified) {
      transaction.state = "blocked";
      throw new ProtectedBrowserFieldError(
        "protected-field-clear-unverified",
        "Protected browser values could not be verified as cleared. The browser remains protected; review it locally before retrying."
      );
    }
    for (const field of fields) {
      field.deliveryAttempted = false;
      field.delivered = false;
    }
    this.#syncSensitiveState(transaction.sessionId, transaction.supervisor);
  }

  async #hasDeparted(
    transaction: ActiveProtectedFormTransaction,
    currentIdentity?: BrowserStateIdentity
  ): Promise<boolean> {
    if (
      currentIdentity !== undefined &&
      currentIdentity.documentEpoch > transaction.sourceIdentity.documentEpoch
    ) {
      return true;
    }
    return await inspectDocument(transaction.supervisor, transaction.documentObjectId) === false;
  }

  #requiresProtection(transaction: ActiveProtectedFormTransaction): boolean {
    if (transaction.released || transaction.state === "departed") return false;
    if (transaction.state === "bound" || transaction.state === "awaiting-values") {
      return [...transaction.fields.values()].some((field) => !field.released);
    }
    return [...transaction.fields.values()].some((field) => field.deliveryAttempted || field.delivered);
  }

  #syncSensitiveState(
    sessionId: string,
    supervisor: ProtectedFieldPageSession["supervisor"]
  ): void {
    supervisor.setSensitiveInputActive?.(this.isSensitive(sessionId));
  }

  async #releaseTransaction(transaction: ActiveProtectedFormTransaction): Promise<void> {
    if (transaction.released) return;
    transaction.released = true;
    this.#transactions.get(transaction.sessionId)?.delete(transaction.id);
    if (this.#transactions.get(transaction.sessionId)?.size === 0) {
      this.#transactions.delete(transaction.sessionId);
    }
    const bindings = this.#transactionsByBinding.get(transaction.sessionId);
    for (const key of transaction.fields.keys()) bindings?.delete(key);
    if (bindings?.size === 0) this.#transactionsByBinding.delete(transaction.sessionId);
    this.#syncSensitiveState(transaction.sessionId, transaction.supervisor);
    const objectIds = new Set([
      transaction.documentObjectId,
      ...[...transaction.fields.values()].map((field) => field.objectId),
      ...(transaction.submit === undefined ? [] : [transaction.submit.objectId]),
    ]);
    for (const objectId of objectIds) await releaseObject(transaction.supervisor, objectId);
  }
}

function sensitiveUrl(value: string): string {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? parsed.origin
      : redactUrlForMetadata(value);
  } catch {
    return redactUrlForMetadata(value);
  }
}

function protectedActionDelta(delta: BrowserActionDelta): BrowserActionDelta {
  const base = {
    ...(delta.beforeIdentity === undefined ? {} : { beforeIdentity: { ...delta.beforeIdentity } }),
    afterIdentity: { ...delta.afterIdentity },
    waitCondition: delta.waitCondition,
    conditionMet: delta.conditionMet,
    url: {
      changed: delta.url.changed,
      ...(delta.url.before === undefined ? {} : { before: sensitiveUrl(delta.url.before) }),
      after: sensitiveUrl(delta.url.after),
    },
  };
  if (delta.outcome === "dispatched-unverified") {
    return {
      ...base,
      outcome: delta.outcome,
      actionDispatched: true,
      settlementFailed: true,
      documentChangeObserved: delta.documentChangeObserved,
      stateObservation: delta.stateObservation,
    };
  }
  return { ...base, outcome: delta.outcome };
}

function inspectionRejection(
  inspection: FieldInspection | undefined,
  existingBinding: boolean
): BrowserProtectedFieldVerification | undefined {
  if (inspection === undefined || !inspection.connected) {
    return { status: "rejected", reason: existingBinding ? "field-replaced" : "field-missing" };
  }
  if (!inspection.current) return { status: "rejected", reason: "field-replaced" };
  if (!inspection.visible) return { status: "rejected", reason: "field-hidden" };
  if (inspection.disabled || !inspection.editable) return { status: "rejected", reason: "field-disabled" };
  if (!inspection.semanticsMatch) return { status: "rejected", reason: "field-semantics-mismatch" };
  if (inspection.conflictCount !== 1) return { status: "rejected", reason: "field-ambiguous" };
  return undefined;
}

async function resolveFieldObjectId(
  supervisor: ProtectedFieldPageSession["supervisor"],
  elementIndex: number
): Promise<string | undefined> {
  const resolved = await supervisor.send("Runtime.evaluate", {
    expression: `window.__estacodaElements?.[${elementIndex}]`,
    returnByValue: false,
  }) as { result?: { objectId?: unknown; subtype?: unknown } };
  return typeof resolved.result?.objectId === "string" && resolved.result.subtype !== "null"
    ? resolved.result.objectId
    : undefined;
}

async function resolveDocumentObjectId(
  supervisor: ProtectedFieldPageSession["supervisor"]
): Promise<string | undefined> {
  try {
    const resolved = await supervisor.send("Runtime.evaluate", {
      expression: "document",
      returnByValue: false,
    }) as { result?: { objectId?: unknown; subtype?: unknown } };
    return typeof resolved.result?.objectId === "string" && resolved.result.subtype !== "null"
      ? resolved.result.objectId
      : undefined;
  } catch {
    return undefined;
  }
}

async function inspectDocument(
  supervisor: ProtectedFieldPageSession["supervisor"],
  objectId: string
): Promise<boolean | undefined> {
  try {
    const inspected = await supervisor.send("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: PROTECTED_DOCUMENT_INSPECTION_FUNCTION,
      returnByValue: true,
    }) as { result?: { value?: unknown } };
    return typeof inspected.result?.value === "boolean" ? inspected.result.value : undefined;
  } catch {
    return undefined;
  }
}

async function bindSubmit(
  supervisor: ProtectedFieldPageSession["supervisor"],
  ref: string | undefined
): Promise<ProtectedSubmitBinding | undefined> {
  if (ref === undefined) return undefined;
  const elementIndex = refToIndex(ref);
  if (elementIndex === undefined) return undefined;
  const objectId = await resolveFieldObjectId(supervisor, elementIndex);
  if (objectId === undefined) return undefined;
  const inspection = await inspectSubmit(supervisor, objectId, elementIndex);
  if (!submitIsActionable(inspection)) {
    await releaseObject(supervisor, objectId);
    return undefined;
  }
  return { ref, objectId, elementIndex };
}

async function inspectSubmit(
  supervisor: ProtectedFieldPageSession["supervisor"],
  objectId: string,
  elementIndex: number
): Promise<SubmitInspection | undefined> {
  try {
    const result = await supervisor.send("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: PROTECTED_SUBMIT_INSPECTION_FUNCTION,
      arguments: [{ value: elementIndex }],
      returnByValue: true,
      awaitPromise: true,
    }) as { result?: { value?: unknown } };
    const value = result.result?.value;
    if (!isRecord(value)) return undefined;
    return {
      connected: value.connected === true,
      current: value.current === true,
      visible: value.visible === true,
      disabled: value.disabled === true,
      clickable: value.clickable === true,
      semanticsMatch: value.semanticsMatch === true,
      conflictCount: typeof value.conflictCount === "number" && Number.isSafeInteger(value.conflictCount)
        ? value.conflictCount
        : 0,
    };
  } catch {
    return undefined;
  }
}

function submitIsActionable(inspection: SubmitInspection | undefined): boolean {
  return inspection !== undefined && inspection.connected && inspection.current &&
    inspection.visible && !inspection.disabled && inspection.clickable && inspection.semanticsMatch &&
    inspection.conflictCount === 1;
}

async function shortDelay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new Error("Protected browser submission cancelled."));
      return;
    }
    const onAbort = () => {
      clearTimeout(timeout);
      reject(new Error("Protected browser submission cancelled."));
    };
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function inspectField(
  supervisor: ProtectedFieldPageSession["supervisor"],
  objectId: string,
  elementIndex: number,
  kind: SecureInputKind
): Promise<FieldInspection | undefined> {
  try {
    const inspected = await supervisor.send("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: PROTECTED_FIELD_INSPECTION_FUNCTION,
      arguments: [{ value: elementIndex }, { value: kind }],
      returnByValue: true,
    }) as { result?: { value?: unknown } };
    return parseInspection(inspected.result?.value);
  } catch {
    return undefined;
  }
}

function parseInspection(value: unknown): FieldInspection | undefined {
  if (!isRecord(value)) return undefined;
  if (!["connected", "current", "visible", "disabled", "editable", "semanticsMatch", "explicitEmail"].every((key) =>
    typeof value[key] === "boolean"
  )) return undefined;
  if (typeof value.conflictCount !== "number" || !Number.isSafeInteger(value.conflictCount)) return undefined;
  return value as FieldInspection;
}

async function currentMainFrameId(
  supervisor: ProtectedFieldPageSession["supervisor"]
): Promise<string | undefined> {
  try {
    const result = await supervisor.send("Page.getFrameTree") as {
      frameTree?: { frame?: { id?: unknown } };
    };
    return typeof result.frameTree?.frame?.id === "string" ? result.frameTree.frame.id : undefined;
  } catch {
    return undefined;
  }
}

async function releaseObject(
  supervisor: ProtectedFieldPageSession["supervisor"],
  objectId: string
): Promise<void> {
  await supervisor.send("Runtime.releaseObject", { objectId }).then(() => undefined, () => undefined);
}

function refToIndex(ref: string): number | undefined {
  const match = /^@e([1-9]\d*)$/u.exec(ref);
  if (match === null) return undefined;
  const index = Number(match[1]) - 1;
  return Number.isSafeInteger(index) ? index : undefined;
}

function normalizeOrigin(value: string): string | undefined {
  try {
    const parsed = new URL(value);
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.origin !== value.replace(/\/$/u, "")) {
      return undefined;
    }
    return parsed.origin;
  } catch {
    return undefined;
  }
}

function originOf(value: string): string | undefined {
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function destinationBindingKey(destination: BrowserFieldSecureInputDestination): string {
  return [destination.tabRef ?? "", destination.frameId ?? "", destination.ref].join("\u0000");
}

function sameActionState(left: BrowserStateIdentity, right: BrowserStateIdentity): boolean {
  return left.documentEpoch === right.documentEpoch && left.actionRevision === right.actionRevision;
}

function isNavigationTransitionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /execution context was destroyed|cannot find (?:context|execution context)|context with specified id|no frame with given id|inspected target navigated/iu
    .test(message);
}

function releasedProtectedSnapshot(snapshot: BrowserSnapshot): BrowserSnapshot {
  const { sensitiveInputActive: _sensitiveInputActive, ...released } = snapshot;
  return released;
}

function protectedDeliveryKey(destination: BrowserFieldSecureInputDestination): string {
  return [destination.sessionId, destination.tabRef ?? "", destination.frameId ?? "", destination.ref]
    .join("\u0000");
}

const PROTECTED_DOCUMENT_INSPECTION_FUNCTION = `function() {
  return this === document;
}`;

const PROTECTED_FIELD_INSPECTION_FUNCTION = `function(index, kind) {
  const field = this;
  const visible = (element) => {
    if (!element?.isConnected) return false;
    const style = getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden' && style.visibility !== 'collapse' && element.getClientRects().length > 0;
  };
  const editable = (element) => element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element.isContentEditable === true;
  const descriptor = (element) => [
    element.getAttribute?.('aria-label'),
    element.getAttribute?.('name'),
    element.getAttribute?.('id'),
    element.getAttribute?.('placeholder'),
    Array.from(element.labels || []).map((label) => label.innerText || label.textContent || '').join(' ')
  ].filter(Boolean).join(' ').toLowerCase().slice(0, 500);
  const semantics = (element) => {
    const type = element instanceof HTMLInputElement ? element.type.toLowerCase() : '';
    const autocomplete = String(element.getAttribute?.('autocomplete') || '').toLowerCase().split(/\\s+/);
    const hint = descriptor(element);
    if (kind === 'account-identifier') return element instanceof HTMLInputElement && (
      type === 'email' || autocomplete.includes('email') || autocomplete.includes('username') ||
      /email|e-mail|user[ _-]?name|account|login/.test(hint)
    );
    if (kind === 'password') return element instanceof HTMLInputElement && type === 'password';
    if (kind === 'one-time-code') return element instanceof HTMLInputElement && (
      autocomplete.includes('one-time-code') || /one[ _-]?time|otp|verification[ _-]?code|security[ _-]?code/.test(hint)
    );
    if (kind === 'private-key') return editable(element) && /private[ _-]?key|pem/.test(hint);
    if (kind === 'recovery-code') return editable(element) && /recovery|backup[ _-]?code/.test(hint);
    if (kind === 'api-key') return editable(element) && /api[ _-]?key/.test(hint);
    if (kind === 'client-secret') return editable(element) && /client[ _-]?secret/.test(hint);
    if (kind === 'access-token') return editable(element) && /access[ _-]?token|bearer[ _-]?token/.test(hint);
    return editable(element) && /secret|credential|token|key|password/.test(hint);
  };
  const candidates = Array.from(document.querySelectorAll('input,textarea,[contenteditable="true"]'))
    .filter((element) => visible(element) && !element.matches(':disabled,[aria-disabled="true"]') && semantics(element));
  return {
    connected: field?.isConnected === true,
    current: window.__estacodaElements?.[index] === field,
    visible: visible(field),
    disabled: field?.matches?.(':disabled,[aria-disabled="true"]') === true,
    editable: editable(field),
    semanticsMatch: semantics(field),
    explicitEmail: field instanceof HTMLInputElement && (
      field.type.toLowerCase() === 'email' ||
      String(field.getAttribute('autocomplete') || '').toLowerCase().split(/\\s+/).includes('email') ||
      /email|e-mail/.test(descriptor(field))
    ),
    conflictCount: candidates.length
  };
}`;

const PROTECTED_CURRENT_CHALLENGE_CLEAR_FUNCTION = `function(currentProtectedKinds, clearValues) {
  const visible = (element) => {
    if (!element?.isConnected) return false;
    const style = getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden' && style.visibility !== 'collapse' && element.getClientRects().length > 0;
  };
  const editable = (element) => element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element.isContentEditable === true;
  const descriptor = (element) => [
    element.getAttribute?.('aria-label'),
    element.getAttribute?.('name'),
    element.getAttribute?.('id'),
    element.getAttribute?.('placeholder'),
    Array.from(element.labels || []).map((label) => label.innerText || label.textContent || '').join(' ')
  ].filter(Boolean).join(' ').toLowerCase().slice(0, 500);
  const semantics = (element, kind) => {
    const type = element instanceof HTMLInputElement ? element.type.toLowerCase() : '';
    const autocomplete = String(element.getAttribute?.('autocomplete') || '').toLowerCase().split(/\\s+/);
    const hint = descriptor(element);
    if (kind === 'account-identifier') return element instanceof HTMLInputElement && (
      type === 'email' || autocomplete.includes('email') || autocomplete.includes('username') ||
      /email|e-mail|user[ _-]?name|account|login/.test(hint)
    );
    if (kind === 'password') return element instanceof HTMLInputElement && type === 'password';
    if (kind === 'one-time-code') return element instanceof HTMLInputElement && (
      autocomplete.includes('one-time-code') || /one[ _-]?time|otp|verification[ _-]?code|security[ _-]?code/.test(hint)
    );
    if (kind === 'private-key') return editable(element) && /private[ _-]?key|pem/.test(hint);
    if (kind === 'recovery-code') return editable(element) && /recovery|backup[ _-]?code/.test(hint);
    if (kind === 'api-key') return editable(element) && /api[ _-]?key/.test(hint);
    if (kind === 'client-secret') return editable(element) && /client[ _-]?secret/.test(hint);
    if (kind === 'access-token') return editable(element) && /access[ _-]?token|bearer[ _-]?token/.test(hint);
    return editable(element) && /secret|credential|token|key|password/.test(hint);
  };
  const all = Array.from(document.querySelectorAll('input,textarea,[contenteditable="true"]'));
  const fields = [];
  for (const kind of currentProtectedKinds) {
    const candidates = all.filter((element) => visible(element) &&
      !element.matches(':disabled,[aria-disabled="true"]') && semantics(element, kind));
    if (candidates.length !== 1) return false;
    fields.push(candidates[0]);
  }
  if (clearValues) {
    for (const field of fields) {
      if (field.isContentEditable) {
        field.textContent = '';
      } else {
        const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
        if (setter) setter.call(field, ''); else field.value = '';
      }
    }
  }
  return fields.every((field) => field.isContentEditable ? (field.textContent || '') === '' : field.value === '');
}`;

const PROTECTED_FIELD_DELIVERY_FUNCTION = `function(index, protectedValue) {
  if (!this?.isConnected || window.__estacodaElements?.[index] !== this) return false;
  const style = getComputedStyle(this);
  if (style.display === 'none' || style.visibility === 'hidden' || this.getClientRects().length === 0) return false;
  if (this.matches(':disabled,[aria-disabled="true"]')) return false;
  this.focus();
  if (this.isContentEditable) {
    this.textContent = protectedValue;
  } else {
    const prototype = this instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    if (setter) setter.call(this, protectedValue); else this.value = protectedValue;
  }
  this.dispatchEvent(new Event('input', { bubbles: true }));
  this.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}`;

const PROTECTED_FIELD_CLEAR_FUNCTION = `function(index) {
  if (!this?.isConnected || window.__estacodaElements?.[index] !== this) return false;
  if (this.isContentEditable) {
    this.textContent = '';
  } else {
    const prototype = this instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    if (setter) setter.call(this, ''); else this.value = '';
  }
  return true;
}`;

const PROTECTED_FIELD_CLEAR_VERIFICATION_FUNCTION = `function(index) {
  if (!this?.isConnected || window.__estacodaElements?.[index] !== this) return false;
  return this.isContentEditable ? (this.textContent || '') === '' : this.value === '';
}`;

const PROTECTED_SUBMIT_INSPECTION_FUNCTION = `function(index) {
  const control = this;
  const visible = control?.isConnected === true && (() => {
    const style = getComputedStyle(control);
    return style.display !== 'none' && style.visibility !== 'hidden' && style.visibility !== 'collapse' && control.getClientRects().length > 0;
  })();
  const descriptor = [
    control?.innerText,
    control?.textContent,
    control?.getAttribute?.('aria-label'),
    control?.getAttribute?.('name'),
    control?.getAttribute?.('id'),
    control?.getAttribute?.('value')
  ].filter(Boolean).join(' ').toLowerCase().slice(0, 500);
  const buttonLike = control instanceof HTMLButtonElement ||
    (control instanceof HTMLInputElement && ['submit', 'button'].includes(control.type.toLowerCase())) ||
    control?.getAttribute?.('role') === 'button';
  const authenticationShaped = (element) => {
    const candidateDescriptor = [
      element?.innerText,
      element?.textContent,
      element?.getAttribute?.('aria-label'),
      element?.getAttribute?.('name'),
      element?.getAttribute?.('id'),
      element?.getAttribute?.('value')
    ].filter(Boolean).join(' ').toLowerCase().slice(0, 500);
    const candidateButtonLike = element instanceof HTMLButtonElement ||
      (element instanceof HTMLInputElement && ['submit', 'button'].includes(element.type.toLowerCase())) ||
      element?.getAttribute?.('role') === 'button';
    return candidateButtonLike && /authenticat|verify|continue|submit|sign[ _-]?in|log[ _-]?in|next|confirm|تحقق|تأكيد|تاكيد|دخول|متابعة/.test(candidateDescriptor);
  };
  const scope = control?.form || document;
  const candidates = Array.from(scope.querySelectorAll('button,input[type="submit"],input[type="button"],[role="button"]'))
    .filter((element) => {
      if (!element?.isConnected || element.matches?.(':disabled,[aria-disabled="true"]')) return false;
      const style = getComputedStyle(element);
      return style.display !== 'none' && style.visibility !== 'hidden' && style.visibility !== 'collapse' &&
        element.getClientRects().length > 0 && authenticationShaped(element);
    });
  return {
    connected: control?.isConnected === true,
    current: window.__estacodaElements?.[index] === control,
    visible,
    disabled: control?.matches?.(':disabled,[aria-disabled="true"]') === true,
    clickable: typeof control?.click === 'function',
    semanticsMatch: buttonLike && /authenticat|verify|continue|submit|sign[ _-]?in|log[ _-]?in|next|confirm|تحقق|تأكيد|تاكيد|دخول|متابعة/.test(descriptor),
    conflictCount: candidates.length
  };
}`;

const PROTECTED_SUBMIT_FUNCTION = `function(index) {
  if (!this?.isConnected || window.__estacodaElements?.[index] !== this) return false;
  const style = getComputedStyle(this);
  if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || this.getClientRects().length === 0) return false;
  if (this.matches?.(':disabled,[aria-disabled="true"]') === true || typeof this.click !== 'function') return false;
  this.click();
  return true;
}`;
