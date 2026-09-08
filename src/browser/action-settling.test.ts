import { describe, expect, it, vi } from "vitest";
import type { BrowserSnapshot } from "../contracts/browser.js";
import {
  createBrowserActionDelta,
  normalizeBrowserActionSettlementInput,
  settleBrowserAction,
  withBrowserActionDelta,
  withDispatchedActionSettlementFailure
} from "./action-settling.js";

function snapshot(input: {
  actionRevision: number;
  documentEpoch?: number;
  url?: string;
  text?: string;
  elements?: BrowserSnapshot["elements"];
  tabRef?: string;
}): BrowserSnapshot {
  return {
    sessionId: "session-1",
    url: input.url ?? "https://example.com/start",
    identity: { documentEpoch: input.documentEpoch ?? 1, actionRevision: input.actionRevision, observationId: input.actionRevision },
    observedAt: new Date(input.actionRevision * 1_000).toISOString(),
    readiness: "complete",
    text: input.text ?? "Loading",
    elements: input.elements ?? [],
    ...(input.tabRef === undefined ? {} : {
      tab: {
        ref: input.tabRef,
        url: input.url ?? "https://example.com/start",
        controlled: true
      }
    })
  };
}

describe("browser action settling", () => {
  it("rejects incomplete discriminated waits before settlement begins", () => {
    expect(() => normalizeBrowserActionSettlementInput({
      waitFor: { kind: "url" }
    })).toThrow("URL wait text is required.");
    expect(() => normalizeBrowserActionSettlementInput({
      waitFor: { kind: "text" }
    })).toThrow("page wait text is required.");
    expect(() => normalizeBrowserActionSettlementInput({
      waitFor: { kind: "element" }
    })).toThrow("Browser element wait requires role or name.");
    expect(() => normalizeBrowserActionSettlementInput({
      waitFor: { kind: "url", contains: "/edit", value: "wrong branch" }
    })).toThrow("does not allow field 'value' for kind 'url'");
  });

  it("captures an asynchronous React-style update after an action", async () => {
    const before = snapshot({ actionRevision: 4 });
    const after = snapshot({
      actionRevision: 5,
      text: "Loaded asynchronously",
      elements: [{ ref: "@e1", role: "button", name: "View product" }]
    });
    let captures = 0;

    const settlement = await settleBrowserAction({
      capture: async () => ++captures < 3 ? before : after,
      waitFor: { kind: "text", value: "Loaded asynchronously" },
      waitTimeoutMs: 100,
      pollIntervalMs: 1
    });

    expect(settlement).toMatchObject({ conditionMet: true, timedOut: false, snapshot: { identity: { actionRevision: 5 } } });
  });

  it("detects URL transitions and added elements in a compact delta", () => {
    const before = snapshot({ actionRevision: 8 });
    const after = snapshot({
      actionRevision: 9,
      url: "https://example.com/products/loans",
      elements: [{ ref: "@e2", role: "button", name: "View product" }]
    });
    const result = withBrowserActionDelta({
      before,
      settlement: {
        snapshot: after,
        waitCondition: "url",
        conditionMet: true,
        timedOut: false
      }
    });

    expect(result.actionDelta).toMatchObject({
      outcome: "changed",
      beforeIdentity: before.identity,
      afterIdentity: after.identity,
      url: { changed: true, after: "https://example.com/products/loans" },
      addedElements: [{ role: "button", name: "View product" }]
    });
  });

  it("returns current state on timeout without claiming success", async () => {
    const current = snapshot({ actionRevision: 2 });
    const settlement = await settleBrowserAction({
      capture: async () => current,
      waitFor: { kind: "text", value: "Never appears" },
      waitTimeoutMs: 5,
      pollIntervalMs: 1
    });
    const result = withBrowserActionDelta({ before: current, settlement });

    expect(result.actionDelta).toMatchObject({
      outcome: "timeout",
      conditionMet: false,
      beforeIdentity: current.identity,
      afterIdentity: current.identity
    });
  });

  it("uses a monotonic elapsed clock when the wall clock is frozen", async () => {
    const wallClock = vi.spyOn(Date, "now").mockReturnValue(1_000);
    try {
      const settlement = await settleBrowserAction({
        capture: async () => snapshot({ actionRevision: 2 }),
        waitFor: { kind: "text", value: "Never appears" },
        waitTimeoutMs: 5,
        pollIntervalMs: 1
      });

      expect(settlement.timedOut).toBe(true);
    } finally {
      wallClock.mockRestore();
    }
  });

  it("makes a stale no-change action explicit", () => {
    const current = snapshot({ actionRevision: 3 });
    const delta = createBrowserActionDelta({
      before: current,
      after: current,
      waitCondition: "dom-stable",
      conditionMet: true,
      timedOut: false
    });

    expect(delta.outcome).toBe("no-change");
  });

  it("preserves the grounded target region for no-change recovery", () => {
    const current = snapshot({ actionRevision: 3 });
    const delta = createBrowserActionDelta({
      before: current,
      after: current,
      waitCondition: "dom-stable",
      conditionMet: true,
      timedOut: false,
      target: {
        ref: "@e7",
        identity: current.identity,
        tabRef: "@t1",
        role: "button",
        name: "Edit",
        regionText: "TikTok Connect Callback URL Edit Delete"
      }
    });

    expect(delta).toMatchObject({
      outcome: "no-change",
      target: {
        ref: "@e7",
        role: "button",
        name: "Edit",
        regionText: "TikTok Connect Callback URL Edit Delete"
      }
    });
  });

  it("preserves a dispatched action when post-action settlement cannot be verified", () => {
    const before = snapshot({ actionRevision: 3, documentEpoch: 2, url: "https://example.com/apps" });
    const latest = snapshot({
      actionRevision: 4,
      documentEpoch: 3,
      url: "https://example.com/apps/example/edit"
    });
    const result = withDispatchedActionSettlementFailure({
      before,
      latest,
      waitCondition: "url",
      stateObservation: "post-dispatch"
    });

    expect(result.actionDelta).toMatchObject({
      outcome: "dispatched-unverified",
      actionDispatched: true,
      settlementFailed: true,
      documentChangeObserved: true,
      stateObservation: "post-dispatch",
      beforeIdentity: before.identity,
      afterIdentity: latest.identity,
      url: {
        changed: true,
        before: "https://example.com/apps",
        after: "https://example.com/apps/example/edit"
      }
    });
  });

  it("redacts secret-looking labels, titles, and URLs from deltas", () => {
    const before = snapshot({ actionRevision: 1 });
    const after = snapshot({
      actionRevision: 2,
      url: "https://example.com/?token=do-not-render",
      elements: [{ ref: "@e1", role: "button", name: "api_key=abcdefghijklmnopqrstuvwxyz" }]
    });
    const delta = createBrowserActionDelta({
      before,
      after,
      waitCondition: "dom-stable",
      conditionMet: true,
      timedOut: false,
      openedTabs: [{
        ref: "@t2",
        url: "https://example.com/?token=another-secret",
        title: "Bearer abcdefghijklmnopqrstuvwxyz",
        controlled: true
      }]
    });
    const serialized = JSON.stringify(delta);

    expect(serialized).not.toContain("do-not-render");
    expect(serialized).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(serialized).not.toContain("another-secret");
    expect(serialized).toContain("[REDACTED]");
  });

  it("preserves source and destination when an action changes the controlled tab", () => {
    const before = snapshot({ actionRevision: 4, tabRef: "@t1", url: "https://example.com/source" });
    const after = snapshot({ actionRevision: 5, tabRef: "@t2", url: "https://example.com/destination" });
    const delta = createBrowserActionDelta({
      before,
      after,
      waitCondition: "dom-stable",
      conditionMet: true,
      timedOut: false,
      openedTabs: [after.tab!]
    });

    expect(delta.tabTransition).toEqual({
      source: { ref: "@t1", url: "https://example.com/source" },
      destination: { ref: "@t2", url: "https://example.com/destination" }
    });
    expect(delta.outcome).toBe("changed");
  });

  it("bounds safe new-tab choices and preserves an explicit navigation outcome", () => {
    const before = snapshot({ actionRevision: 4, tabRef: "@t1" });
    const after = snapshot({ actionRevision: 5, tabRef: "@t1" });
    const openedTabs = Array.from({ length: 8 }, (_, index) => ({
      ref: `@t${index + 2}`,
      url: `https://example.com/choice-${index + 1}`,
      controlled: false
    }));
    const delta = createBrowserActionDelta({
      before,
      after,
      waitCondition: "dom-stable",
      conditionMet: true,
      timedOut: false,
      openedTabs,
      outcome: "new-tab-opened"
    });

    expect(delta.outcome).toBe("new-tab-opened");
    expect(delta.openedTabs).toHaveLength(5);
    expect(delta.openedTabs?.map((tab) => tab.ref)).toEqual(["@t2", "@t3", "@t4", "@t5", "@t6"]);
  });
});
