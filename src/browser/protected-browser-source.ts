import { isDeepStrictEqual } from "node:util";
import type {
  BrowserProtectedSourceInput,
  BrowserProtectedSourceReadInput,
  BrowserProtectedSourceReadResult,
  BrowserProtectedSourceVerification,
  BrowserSnapshot,
} from "../contracts/browser.js";
import type { BrowserFieldSecureInputSource } from "../contracts/secure-input.js";

export type ProtectedBrowserSourceSession = {
  key: string;
  tabRef: string;
  supervisor: {
    send(method: string, params?: Record<string, unknown>): Promise<unknown>;
    getSnapshot(sessionId?: string): Promise<Pick<BrowserSnapshot, "url">>;
  };
};

type SourceBinding = {
  source: BrowserFieldSecureInputSource;
  kind: BrowserProtectedSourceInput["kind"];
  supervisor: ProtectedBrowserSourceSession["supervisor"];
  objectId: string;
  documentObjectId: string;
  elementIndex: number;
  fingerprint: string;
};

type SourceInspection = {
  connected: boolean;
  current: boolean;
  visible: boolean;
  empty: boolean;
  fingerprint: string;
  value?: string;
};

/** Owns exact browser-source bindings for one-use protected transfers. */
export class ProtectedBrowserSourceController {
  readonly #bindings = new Map<string, SourceBinding>();

  async verify(
    session: ProtectedBrowserSourceSession,
    input: BrowserProtectedSourceInput,
  ): Promise<BrowserProtectedSourceVerification> {
    if (input.signal?.aborted === true || input.source.sessionId !== session.key) {
      return { status: "rejected", reason: "session-mismatch" };
    }
    if (input.source.tabRef !== undefined && input.source.tabRef !== session.tabRef) {
      return { status: "rejected", reason: "tab-mismatch" };
    }
    const snapshot = await session.supervisor.getSnapshot(session.key);
    if (originOf(snapshot.url) !== normalizeOrigin(input.source.expectedOrigin)) {
      return { status: "rejected", reason: "origin-mismatch" };
    }
    const frameId = await currentMainFrameId(session.supervisor);
    if (input.source.frameId !== undefined && input.source.frameId !== frameId) {
      return { status: "rejected", reason: "frame-mismatch" };
    }

    const key = sourceBindingKey(input.source);
    if (input.phase === "before-authorization") {
      if (this.#bindings.has(key)) return { status: "rejected", reason: "request-not-active" };
      const elementIndex = refToIndex(input.source.ref);
      if (elementIndex === undefined) return { status: "rejected", reason: "source-missing" };
      const documentObjectId = await resolveObject(session.supervisor, "document");
      const objectId = await resolveObject(session.supervisor, `window.__estacodaElements?.[${elementIndex}]`);
      if (documentObjectId === undefined || objectId === undefined) {
        await releaseObject(session.supervisor, documentObjectId);
        await releaseObject(session.supervisor, objectId);
        return { status: "rejected", reason: "source-missing" };
      }
      const inspection = await inspectSource(session.supervisor, objectId, elementIndex, false);
      const rejection = sourceRejection(inspection, false);
      if (rejection !== undefined) {
        await releaseObject(session.supervisor, objectId);
        await releaseObject(session.supervisor, documentObjectId);
        return rejection;
      }
      this.#bindings.set(key, {
        source: structuredClone(input.source),
        kind: input.kind,
        supervisor: session.supervisor,
        objectId,
        documentObjectId,
        elementIndex,
        fingerprint: inspection!.fingerprint,
      });
      return { status: "verified", sourceLabel: `Browser value at ${normalizeOrigin(input.source.expectedOrigin)}` };
    }

    const binding = this.#bindings.get(key);
    if (binding === undefined || binding.kind !== input.kind || binding.supervisor !== session.supervisor ||
        !isDeepStrictEqual(binding.source, input.source)) {
      return { status: "rejected", reason: "request-not-active" };
    }
    if (await inspectDocument(session.supervisor, binding.documentObjectId) !== true) {
      return { status: "rejected", reason: "source-replaced" };
    }
    const inspection = await inspectSource(session.supervisor, binding.objectId, binding.elementIndex, false);
    const rejection = sourceRejection(inspection, true);
    if (rejection !== undefined) return rejection;
    if (inspection!.fingerprint !== binding.fingerprint) {
      return { status: "rejected", reason: "source-replaced" };
    }
    return { status: "verified", sourceLabel: `Browser value at ${normalizeOrigin(input.source.expectedOrigin)}` };
  }

  async read(
    session: ProtectedBrowserSourceSession,
    input: BrowserProtectedSourceReadInput,
  ): Promise<BrowserProtectedSourceReadResult> {
    const verified = await this.verify(session, { ...input, phase: "before-delivery" });
    if (verified.status !== "verified") return verified;
    const binding = this.#bindings.get(sourceBindingKey(input.source));
    if (binding === undefined) return { status: "rejected", reason: "request-not-active" };
    const inspection = await inspectSource(session.supervisor, binding.objectId, binding.elementIndex, true);
    const rejection = sourceRejection(inspection, true);
    if (rejection !== undefined) return rejection;
    if (inspection?.fingerprint !== binding.fingerprint) return { status: "rejected", reason: "source-replaced" };
    if (inspection.value === undefined) return { status: "rejected", reason: "source-empty" };
    return { status: "read", value: new TextEncoder().encode(inspection.value) };
  }

  async release(source: BrowserFieldSecureInputSource): Promise<void> {
    const binding = this.#bindings.get(sourceBindingKey(source));
    if (binding === undefined) return;
    this.#bindings.delete(sourceBindingKey(source));
    await releaseObject(binding.supervisor, binding.objectId);
    await releaseObject(binding.supervisor, binding.documentObjectId);
  }
}

function sourceRejection(
  inspection: SourceInspection | undefined,
  existing: boolean,
): Extract<BrowserProtectedSourceVerification, { status: "rejected" }> | undefined {
  if (inspection === undefined || !inspection.connected || !inspection.current) {
    return { status: "rejected", reason: existing ? "source-replaced" : "source-missing" };
  }
  if (!inspection.visible) return { status: "rejected", reason: "source-hidden" };
  if (inspection.empty) return { status: "rejected", reason: "source-empty" };
  return undefined;
}

async function inspectSource(
  supervisor: ProtectedBrowserSourceSession["supervisor"],
  objectId: string,
  elementIndex: number,
  includeValue: boolean,
): Promise<SourceInspection | undefined> {
  try {
    const response = await supervisor.send("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: PROTECTED_SOURCE_INSPECTION_FUNCTION,
      arguments: [{ value: elementIndex }, { value: includeValue }],
      returnByValue: true,
      awaitPromise: true,
    }) as { result?: { value?: unknown } };
    const value = response.result?.value;
    if (!isRecord(value) || typeof value.connected !== "boolean" || typeof value.current !== "boolean" ||
        typeof value.visible !== "boolean" || typeof value.empty !== "boolean" || typeof value.fingerprint !== "string") {
      return undefined;
    }
    return {
      connected: value.connected,
      current: value.current,
      visible: value.visible,
      empty: value.empty,
      fingerprint: value.fingerprint,
      ...(typeof value.value === "string" ? { value: value.value } : {}),
    };
  } catch {
    return undefined;
  }
}

async function inspectDocument(
  supervisor: ProtectedBrowserSourceSession["supervisor"],
  objectId: string,
): Promise<boolean | undefined> {
  try {
    const response = await supervisor.send("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: "function () { return this === document; }",
      returnByValue: true,
    }) as { result?: { value?: unknown } };
    return typeof response.result?.value === "boolean" ? response.result.value : undefined;
  } catch {
    return undefined;
  }
}

async function resolveObject(
  supervisor: ProtectedBrowserSourceSession["supervisor"],
  expression: string,
): Promise<string | undefined> {
  try {
    const response = await supervisor.send("Runtime.evaluate", {
      expression,
      returnByValue: false,
    }) as { result?: { objectId?: unknown; subtype?: unknown } };
    return typeof response.result?.objectId === "string" && response.result.subtype !== "null"
      ? response.result.objectId
      : undefined;
  } catch {
    return undefined;
  }
}

async function currentMainFrameId(
  supervisor: ProtectedBrowserSourceSession["supervisor"],
): Promise<string | undefined> {
  try {
    const result = await supervisor.send("Page.getFrameTree") as { frameTree?: { frame?: { id?: unknown } } };
    return typeof result.frameTree?.frame?.id === "string" ? result.frameTree.frame.id : undefined;
  } catch {
    return undefined;
  }
}

async function releaseObject(
  supervisor: ProtectedBrowserSourceSession["supervisor"],
  objectId: string | undefined,
): Promise<void> {
  if (objectId === undefined) return;
  await supervisor.send("Runtime.releaseObject", { objectId }).then(() => undefined, () => undefined);
}

function sourceBindingKey(source: BrowserFieldSecureInputSource): string {
  return JSON.stringify([
    source.sessionId,
    source.tabRef ?? "",
    source.ref,
    source.identity.documentEpoch,
    source.identity.actionRevision,
    source.expectedOrigin,
    source.frameId ?? "",
  ]);
}

function refToIndex(ref: string): number | undefined {
  const match = /^@e(\d+)$/u.exec(ref);
  if (match === null) return undefined;
  const index = Number(match[1]);
  return Number.isSafeInteger(index) && index > 0 ? index - 1 : undefined;
}

function normalizeOrigin(value: string): string {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : "null";
  } catch {
    return "null";
  }
}

function originOf(value: string): string {
  return normalizeOrigin(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const PROTECTED_SOURCE_INSPECTION_FUNCTION = `async function (elementIndex, includeValue) {
  const connected = this?.isConnected === true && this.ownerDocument === document;
  const current = window.__estacodaElements?.[elementIndex] === this;
  const rect = this?.getBoundingClientRect?.();
  const style = this == null ? undefined : getComputedStyle(this);
  const visible = connected && rect != null && rect.width > 0 && rect.height > 0 &&
    style?.display !== "none" && style?.visibility !== "hidden" && style?.opacity !== "0";
  const raw = typeof this?.value === "string" ? this.value : (this?.textContent ?? "");
  const bytes = new TextEncoder().encode(raw);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  bytes.fill(0);
  const fingerprint = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
  const result = { connected, current, visible, empty: raw.length === 0, fingerprint };
  if (includeValue) result.value = raw;
  return result;
}`;
