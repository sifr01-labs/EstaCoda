import { createHash } from "node:crypto";
import type { BrowserSnapshot } from "../contracts/browser.js";

export type BrowserSnapshotRevisionState = {
  revision: number;
  fingerprint?: string;
};

export function observeBrowserSnapshot(
  snapshot: BrowserSnapshot,
  state: BrowserSnapshotRevisionState,
  now: () => number = Date.now
): BrowserSnapshot {
  const fingerprint = browserSnapshotFingerprint(snapshot);
  if (state.fingerprint !== fingerprint) {
    state.revision += 1;
    state.fingerprint = fingerprint;
  }
  return {
    ...snapshot,
    revision: state.revision,
    observedAt: new Date(now()).toISOString()
  };
}

export function browserSnapshotFingerprint(snapshot: BrowserSnapshot): string {
  const stableState = {
    url: snapshot.url,
    title: snapshot.title,
    text: snapshot.text,
    readiness: snapshot.readiness,
    tab: snapshot.tab === undefined ? undefined : {
      ref: snapshot.tab.ref,
      url: snapshot.tab.url
    },
    elements: snapshot.elements,
    pendingDialogs: snapshot.pendingDialogs,
    frameTree: snapshot.frameTree
  };
  return createHash("sha256").update(JSON.stringify(stableState)).digest("hex");
}
