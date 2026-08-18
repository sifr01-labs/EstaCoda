import { createHash } from "node:crypto";
import type { BrowserSnapshot, BrowserStateIdentity } from "../contracts/browser.js";
import { isBrowserSnapshotElementInteractable } from "./browser-interactability.js";

export type BrowserDocumentSignal = {
  frameId?: string;
  loaderId?: string;
  executionContextId?: number;
};

export type BrowserSnapshotInput = Omit<BrowserSnapshot, "identity" | "observedAt">;

export type BrowserSnapshotIdentityState = {
  identity: BrowserStateIdentity;
  lastActionFingerprint?: string;
  lastDocumentSignal?: string;
  lastTabRef?: string;
};

export type BrowserSnapshotObservation = {
  snapshot: BrowserSnapshot;
  identity: BrowserStateIdentity;
};

export function createBrowserSnapshotIdentityState(): BrowserSnapshotIdentityState {
  return {
    identity: {
      documentEpoch: 0,
      actionRevision: 0,
      observationId: 0
    }
  };
}

export function observeBrowserState(
  snapshot: BrowserSnapshotInput,
  state: BrowserSnapshotIdentityState,
  documentSignal?: BrowserDocumentSignal,
  now: () => number = Date.now
): BrowserSnapshotObservation {
  const actionFingerprint = browserActionMapFingerprint(snapshot);
  const nextDocumentSignal = browserDocumentSignalFingerprint(documentSignal);
  const nextTabRef = snapshot.tab?.ref;
  const firstObservation = state.identity.observationId === 0;
  const tabChanged = state.lastTabRef !== undefined && nextTabRef !== undefined && state.lastTabRef !== nextTabRef;
  const documentChanged = state.lastDocumentSignal !== undefined &&
    nextDocumentSignal !== undefined &&
    state.lastDocumentSignal !== nextDocumentSignal;
  const actionMapChanged = state.lastActionFingerprint !== undefined &&
    state.lastActionFingerprint !== actionFingerprint;

  state.identity = {
    documentEpoch: state.identity.documentEpoch + (firstObservation || tabChanged || documentChanged ? 1 : 0),
    actionRevision: state.identity.actionRevision +
      (firstObservation || tabChanged || documentChanged || actionMapChanged ? 1 : 0),
    observationId: state.identity.observationId + 1
  };
  state.lastActionFingerprint = actionFingerprint;
  if (nextDocumentSignal !== undefined) state.lastDocumentSignal = nextDocumentSignal;
  if (nextTabRef !== undefined) state.lastTabRef = nextTabRef;

  const identity = { ...state.identity };
  return {
    identity,
    snapshot: {
      ...snapshot,
      identity,
      observedAt: new Date(now()).toISOString()
    }
  };
}

export function observeBrowserSnapshot(
  snapshot: BrowserSnapshotInput,
  state: BrowserSnapshotIdentityState,
  now: () => number = Date.now,
  documentSignal?: BrowserDocumentSignal
): BrowserSnapshot {
  return observeBrowserState(snapshot, state, documentSignal, now).snapshot;
}

export function browserActionMapFingerprint(snapshot: BrowserSnapshotInput): string {
  const stableState = {
    elements: snapshot.elements
      ?.filter((element) => isActionableBrowserRole(element.role) && isBrowserSnapshotElementInteractable(element))
      .map(({ value: _value, checked: _checked, ...element }) => element),
    pendingDialogs: snapshot.pendingDialogs?.map(({ id: _id, ...dialog }) => dialog)
  };
  return createHash("sha256").update(JSON.stringify(stableState)).digest("hex");
}

const ACTIONABLE_BROWSER_ROLES = new Set([
  "button",
  "checkbox",
  "combobox",
  "link",
  "listbox",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "radio",
  "searchbox",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "textbox",
  "treeitem"
]);

export function isActionableBrowserRole(role: string | undefined): boolean {
  return role !== undefined && ACTIONABLE_BROWSER_ROLES.has(role);
}

function browserDocumentSignalFingerprint(signal: BrowserDocumentSignal | undefined): string | undefined {
  if (signal === undefined || signal.frameId === undefined) return undefined;
  if (signal.loaderId !== undefined) return `frame:${signal.frameId}:loader:${signal.loaderId}`;
  if (signal.executionContextId !== undefined) {
    return `frame:${signal.frameId}:context:${signal.executionContextId}`;
  }
  return `frame:${signal.frameId}`;
}
