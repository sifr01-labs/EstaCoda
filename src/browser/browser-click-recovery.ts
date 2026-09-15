import { createHash } from "node:crypto";
import type { BrowserActionInput, BrowserSnapshot } from "../contracts/browser.js";
import { BrowserTargetError, resolveBrowserTarget } from "./browser-locator.js";

// CDP provenance stays inside the backend; it is never part of a serialized snapshot.
export const BROWSER_SNAPSHOT_NODE_IDS = Symbol("browserSnapshotNodeIds");
export type BrowserSnapshotNodeIds = { [BROWSER_SNAPSHOT_NODE_IDS]?: Record<string, number> };

type Observation = {
  snapshot: BrowserSnapshot;
  nodes: Record<string, number>;
  reviewed: Map<string, string>;
};

/** Recover only undispatched clicks on the same CDP node after unrelated page changes. */
export class BrowserClickRecovery {
  readonly #history = new Map<string, Observation[]>();

  observe(snapshot: BrowserSnapshot, nodes: Record<string, number> = {}): void {
    const history = this.#history.get(snapshot.sessionId) ?? [];
    const retained: BrowserSnapshot = { observedAt: snapshot.observedAt, sessionId: snapshot.sessionId, url: snapshot.url,
      identity: snapshot.identity, tab: snapshot.tab, elements: snapshot.elements, pendingDialogs: snapshot.pendingDialogs };
    history.push({ snapshot: retained, nodes, reviewed: new Map() });
    this.#history.set(snapshot.sessionId, history.slice(-8));
  }

  clearAll(): void { this.#history.clear(); }

  clear(sessionId: string): void { this.#history.delete(sessionId); }

  #observation(snapshot: BrowserSnapshot, input: BrowserActionInput): Observation | undefined {
    return this.#history.get(snapshot.sessionId)?.slice().reverse().find((entry) =>
      entry.snapshot.tab?.ref === input.tabRef &&
      entry.snapshot.identity.documentEpoch === input.identity?.documentEpoch &&
      entry.snapshot.identity.actionRevision === input.identity?.actionRevision &&
      entry.snapshot.identity.observationId === input.identity?.observationId);
  }

  review(snapshot: BrowserSnapshot, ref: string, semantics: object): void {
    this.#observation(snapshot, { identity: snapshot.identity, tabRef: snapshot.tab?.ref })
      ?.reviewed.set(ref, semanticFingerprint(semantics));
  }

  resolve(snapshot: BrowserSnapshot, input: BrowserActionInput, phase: "preflight" | "dispatch") {
    try { return resolveBrowserTarget(snapshot, input); } catch (error) {
      if (!(error instanceof BrowserTargetError) || error.reason !== "stale-browser-ref" ||
          input.ref === undefined || input.regionRef !== undefined || input.locator !== undefined ||
          input.visualTarget !== undefined || input.sessionId !== snapshot.sessionId ||
          input.tabRef !== snapshot.tab?.ref || input.identity?.documentEpoch !== snapshot.identity.documentEpoch) throw error;
      const previous = this.#observation(snapshot, input);
      const current = this.#observation(snapshot, { identity: snapshot.identity, tabRef: snapshot.tab?.ref });
      if (previous === undefined || current === undefined || previous.snapshot.url !== snapshot.url ||
          (previous.snapshot.pendingDialogs?.length ?? 0) > 0 || (snapshot.pendingDialogs?.length ?? 0) > 0 ||
          (phase === "dispatch" && !previous.reviewed.has(input.ref))) throw error;
      // Validate the original scope and target before considering any replacement reference.
      const original = resolveBrowserTarget(previous.snapshot, input);
      const node = previous.nodes[original.ref];
      if (node === undefined) throw error;
      const matches = Object.entries(current.nodes).filter(([, id]) => id === node);
      if (matches.length !== 1) throw error;
      const ref = matches[0]![0];
      const oldElement = previous.snapshot.elements?.find((element) => element.ref === original.ref);
      const newElement = snapshot.elements?.find((element) => element.ref === ref);
      if (oldElement === undefined || newElement === undefined ||
          withoutRef(oldElement) !== withoutRef(newElement)) throw error;
      return resolveBrowserTarget(snapshot, { ...input, ref, identity: snapshot.identity });
    }
  }

  async verifyRecoveredDispatch(snapshot: BrowserSnapshot, input: BrowserActionInput,
    inspect: () => Promise<object | undefined>): Promise<void> {
    if (input.ref === undefined || input.identity === undefined ||
        input.identity.actionRevision === snapshot.identity.actionRevision) return;
    const reviewed = input.ref === undefined ? undefined : this.#observation(snapshot, input)?.reviewed.get(input.ref);
    const current = await inspect();
    if (reviewed === undefined || current === undefined || reviewed !== semanticFingerprint(current)) {
      throw new BrowserTargetError({ reason: "stale-browser-ref",
        message: "Browser click target changed after security review. Observe and review the target again.",
        currentIdentity: snapshot.identity, currentSessionId: snapshot.sessionId, currentTabRef: snapshot.tab?.ref });
    }
  }
}

function withoutRef(value: object): string {
  return JSON.stringify(Object.fromEntries(Object.entries(value).filter(([key]) => key !== "ref")
    .sort(([left], [right]) => left.localeCompare(right))));
}

// Compare exact structural values before redaction without retaining destinations or labels.
function semanticFingerprint(value: object): string {
  return createHash("sha256").update(withoutRef(value)).digest("hex");
}
