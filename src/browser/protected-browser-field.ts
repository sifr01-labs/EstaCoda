import { isDeepStrictEqual } from "node:util";
import type {
  BrowserProtectedFieldDeliveryInput,
  BrowserProtectedFieldInput,
  BrowserProtectedFieldVerification,
  BrowserSnapshot,
} from "../contracts/browser.js";
import type { BrowserFieldSecureInputDestination, SecureInputKind } from "../contracts/secure-input.js";
import { redactUrlForMetadata } from "./url-safety.js";

export type ProtectedFieldPageSession = {
  key: string;
  tabRef: string;
  supervisor: {
    send(method: string, params?: Record<string, unknown>): Promise<unknown>;
    getSnapshot(sessionId?: string): Promise<BrowserSnapshot>;
    setSensitiveInputActive?(active: boolean): void;
  };
};

type ActiveProtectedField = {
  destination: BrowserFieldSecureInputDestination;
  kind: SecureInputKind;
  objectId: string;
  elementIndex: number;
  frameId?: string;
  supervisor: ProtectedFieldPageSession["supervisor"];
  delivered: boolean;
};

type FieldInspection = {
  connected: boolean;
  current: boolean;
  visible: boolean;
  disabled: boolean;
  editable: boolean;
  semanticsMatch: boolean;
  conflictCount: number;
};

export class ProtectedBrowserFieldError extends Error {
  constructor(
    public readonly code: "sensitive-input-active" | "protected-field-delivery-failed",
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "ProtectedBrowserFieldError";
  }
}

/** Owns live DOM bindings and observation guards for supervised local browser delivery. */
export class ProtectedBrowserFieldController {
  readonly #active = new Map<string, ActiveProtectedField>();
  readonly #sensitiveSessions = new Set<string>();

  isActive(sessionId: string): boolean {
    return this.#active.has(sessionId);
  }

  isSensitive(sessionId: string): boolean {
    return this.isActive(sessionId) || this.#sensitiveSessions.has(sessionId);
  }

  async verify(
    session: ProtectedFieldPageSession,
    input: BrowserProtectedFieldInput
  ): Promise<BrowserProtectedFieldVerification> {
    if (input.signal?.aborted === true || input.destination.sessionId !== session.key) {
      return { status: "rejected", reason: "session-mismatch" };
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
      if (this.isSensitive(session.key)) {
        return { status: "rejected", reason: "field-ambiguous" };
      }
      const elementIndex = refToIndex(input.destination.ref);
      if (elementIndex === undefined) return { status: "rejected", reason: "field-missing" };
      const objectId = await resolveFieldObjectId(session.supervisor, elementIndex);
      if (objectId === undefined) return { status: "rejected", reason: "field-missing" };
      const inspection = await inspectField(session.supervisor, objectId, elementIndex, input.kind);
      const rejection = inspectionRejection(inspection, false);
      if (rejection !== undefined) {
        await releaseObject(session.supervisor, objectId);
        return rejection;
      }
      this.#active.set(session.key, {
        destination: structuredClone(input.destination),
        kind: input.kind,
        objectId,
        elementIndex,
        ...(frameId === undefined ? {} : { frameId }),
        supervisor: session.supervisor,
        delivered: false,
      });
      session.supervisor.setSensitiveInputActive?.(true);
      return { status: "verified" };
    }

    const active = this.#active.get(session.key);
    if (active === undefined || active.kind !== input.kind || !isDeepStrictEqual(active.destination, input.destination)) {
      return { status: "rejected", reason: "request-not-active" };
    }
    if (active.frameId !== frameId) return { status: "rejected", reason: "frame-mismatch" };
    const inspection = await inspectField(
      session.supervisor,
      active.objectId,
      active.elementIndex,
      active.kind
    );
    return inspectionRejection(inspection, true) ?? { status: "verified" };
  }

  async deliver(
    session: ProtectedFieldPageSession,
    input: BrowserProtectedFieldDeliveryInput
  ): Promise<void> {
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
    const active = this.#active.get(session.key)!;
    const value = new TextDecoder("utf-8", { fatal: true }).decode(input.value);
    try {
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
      this.#sensitiveSessions.add(session.key);
    } catch (error) {
      throw new ProtectedBrowserFieldError(
        "protected-field-delivery-failed",
        "Protected browser field delivery failed.",
        { cause: error }
      );
    }
  }

  async release(destination: BrowserFieldSecureInputDestination): Promise<void> {
    const active = this.#active.get(destination.sessionId);
    if (active === undefined || !isDeepStrictEqual(active.destination, destination)) return;
    this.#active.delete(destination.sessionId);
    if (!active.delivered) this.#sensitiveSessions.delete(destination.sessionId);
    if (!active.delivered) active.supervisor.setSensitiveInputActive?.(false);
    await releaseObject(active.supervisor, active.objectId);
  }

  async invalidateSession(session: ProtectedFieldPageSession): Promise<void> {
    const active = this.#active.get(session.key);
    this.#sensitiveSessions.delete(session.key);
    session.supervisor.setSensitiveInputActive?.(false);
    if (active === undefined) return;
    this.#active.delete(session.key);
    if (active.supervisor !== session.supervisor) {
      active.supervisor.setSensitiveInputActive?.(false);
    }
    await releaseObject(active.supervisor, active.objectId);
  }

  async clearSession(sessionId: string): Promise<void> {
    const active = this.#active.get(sessionId);
    this.#active.delete(sessionId);
    this.#sensitiveSessions.delete(sessionId);
    active?.supervisor.setSensitiveInputActive?.(false);
    if (active !== undefined) await releaseObject(active.supervisor, active.objectId);
  }

  protectSnapshot(sessionId: string, snapshot: BrowserSnapshot): BrowserSnapshot {
    if (!this.isSensitive(sessionId)) return snapshot;
    return {
      sessionId: snapshot.sessionId,
      url: sensitiveUrl(snapshot.url),
      revision: snapshot.revision,
      observedAt: snapshot.observedAt,
      readiness: snapshot.readiness,
      sensitiveInputActive: true,
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
  if (!["connected", "current", "visible", "disabled", "editable", "semanticsMatch"].every((key) =>
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
    if (kind === 'password') return element instanceof HTMLInputElement && type === 'password';
    if (kind === 'one-time-code') return element instanceof HTMLInputElement && autocomplete.includes('one-time-code');
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
    conflictCount: candidates.length
  };
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
