import { describe, expect, it, vi } from "vitest";
import type { BrowserSnapshot } from "../contracts/browser.js";
import { createBrowserActionDelta, settleBrowserAction, withBrowserActionDelta } from "./action-settling.js";

function snapshot(input: {
  revision: number;
  url?: string;
  text?: string;
  elements?: BrowserSnapshot["elements"];
}): BrowserSnapshot {
  return {
    sessionId: "session-1",
    url: input.url ?? "https://example.com/start",
    revision: input.revision,
    observedAt: new Date(input.revision * 1_000).toISOString(),
    readiness: "complete",
    text: input.text ?? "Loading",
    elements: input.elements ?? []
  };
}

describe("browser action settling", () => {
  it("captures an asynchronous React-style update after an action", async () => {
    const before = snapshot({ revision: 4 });
    const after = snapshot({
      revision: 5,
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

    expect(settlement).toMatchObject({ conditionMet: true, timedOut: false, snapshot: { revision: 5 } });
  });

  it("detects URL transitions and added elements in a compact delta", () => {
    const before = snapshot({ revision: 8 });
    const after = snapshot({
      revision: 9,
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
      beforeRevision: 8,
      afterRevision: 9,
      url: { changed: true, after: "https://example.com/products/loans" },
      addedElements: [{ role: "button", name: "View product" }]
    });
  });

  it("returns current state on timeout without claiming success", async () => {
    const current = snapshot({ revision: 2 });
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
      beforeRevision: 2,
      afterRevision: 2
    });
  });

  it("uses a monotonic elapsed clock when the wall clock is frozen", async () => {
    const wallClock = vi.spyOn(Date, "now").mockReturnValue(1_000);
    try {
      const settlement = await settleBrowserAction({
        capture: async () => snapshot({ revision: 2 }),
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
    const current = snapshot({ revision: 3 });
    const delta = createBrowserActionDelta({
      before: current,
      after: current,
      waitCondition: "dom-stable",
      conditionMet: true,
      timedOut: false
    });

    expect(delta.outcome).toBe("no-change");
  });

  it("redacts secret-looking labels, titles, and URLs from deltas", () => {
    const before = snapshot({ revision: 1 });
    const after = snapshot({
      revision: 2,
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
});
