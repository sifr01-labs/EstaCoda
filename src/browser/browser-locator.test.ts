import { describe, expect, it } from "vitest";
import type { BrowserSnapshot } from "../contracts/browser.js";
import { BrowserTargetError, findBrowserLocator, resolveBrowserTarget } from "./browser-locator.js";

function snapshot(elements: BrowserSnapshot["elements"], overrides: Partial<BrowserSnapshot> = {}): BrowserSnapshot {
  return {
    sessionId: "session-1",
    url: "https://example.com/products",
    identity: { documentEpoch: 3, actionRevision: 7, observationId: 9 },
    observedAt: "2026-08-13T00:00:00.000Z",
    readiness: "complete",
    tab: { ref: "@t2", url: "https://example.com/products", controlled: true },
    elements,
    ...overrides
  };
}

describe("semantic browser locators", () => {
  it("selects a card-scoped button", () => {
    const current = snapshot([
      { ref: "@e1", role: "button", name: "View product", withinText: "Loans V2 View product" },
      { ref: "@e2", role: "button", name: "View product", withinText: "Security MTN OAuth V1 View product" }
    ]);

    expect(resolveBrowserTarget(current, {
      locator: { role: "button", name: "View product", withinText: "OAuth V1" }
    })).toMatchObject({ ref: "@e2", identity: { documentEpoch: 3, actionRevision: 7, observationId: 9 }, tabRef: "@t2" });
  });

  it("finds a form input by its label", () => {
    const result = findBrowserLocator(snapshot([
      { ref: "@e1", role: "textbox", name: "Email address", label: "Email address" }
    ]), { role: "textbox", label: "Email address" });

    expect(result).toMatchObject({ status: "found", candidates: [{ ref: "@e1" }] });
  });

  it("returns candidates for duplicate button names instead of guessing", () => {
    const current = snapshot([
      { ref: "@e1", role: "button", name: "Open" },
      { ref: "@e2", role: "button", name: "Open" }
    ]);

    expect(() => resolveBrowserTarget(current, { locator: { role: "button", name: "Open" } })).toThrowError(
      expect.objectContaining<Partial<BrowserTargetError>>({
        reason: "browser-target-ambiguous",
        candidates: [
          expect.objectContaining({ ref: "@e1" }),
          expect.objectContaining({ ref: "@e2" })
        ]
      })
    );
  });

  it("rejects stale refs and refs from another tab", () => {
    const current = snapshot([{ ref: "@e1", role: "button", name: "Open" }]);

    expect(() => resolveBrowserTarget(current, { sessionId: "session-1", ref: "@e1", identity: { ...current.identity, actionRevision: 6 }, tabRef: "@t2" })).toThrowError(
      expect.objectContaining({ reason: "stale-browser-ref", currentIdentity: current.identity })
    );
    expect(() => resolveBrowserTarget(current, { sessionId: "session-1", ref: "@e1", identity: current.identity, tabRef: "@t1" })).toThrowError(
      expect.objectContaining({ reason: "browser-ref-wrong-tab", currentTabRef: "@t2" })
    );
  });

  it("scopes refs to session, document, and action state without invalidating a fresh observation", () => {
    const current = snapshot([{ ref: "@e1", role: "button", name: "Open" }]);

    expect(resolveBrowserTarget(current, {
      sessionId: current.sessionId,
      ref: "@e1",
      identity: { ...current.identity, observationId: current.identity.observationId - 1 },
      tabRef: current.tab!.ref,
    })).toMatchObject({ ref: "@e1" });
    expect(() => resolveBrowserTarget(current, {
      sessionId: "another-session",
      ref: "@e1",
      identity: current.identity,
      tabRef: current.tab!.ref,
    })).toThrowError(expect.objectContaining({ reason: "browser-ref-wrong-session" }));
    expect(() => resolveBrowserTarget(current, {
      sessionId: current.sessionId,
      ref: "@e1",
      identity: { ...current.identity, documentEpoch: current.identity.documentEpoch - 1 },
      tabRef: current.tab!.ref,
    })).toThrowError(expect.objectContaining({ reason: "stale-browser-ref" }));
  });

  it("resolves semantically after element order changes", () => {
    const before = snapshot([
      { ref: "@e1", role: "button", name: "Cancel" },
      { ref: "@e2", role: "button", name: "Continue" }
    ], { identity: { documentEpoch: 1, actionRevision: 2, observationId: 2 } });
    const after = snapshot([
      { ref: "@e1", role: "button", name: "Continue" },
      { ref: "@e2", role: "button", name: "Cancel" }
    ], { identity: { documentEpoch: 1, actionRevision: 3, observationId: 3 } });

    expect(resolveBrowserTarget(before, { locator: { role: "button", name: "Continue", exact: true } }).ref).toBe("@e2");
    expect(resolveBrowserTarget(after, { locator: { role: "button", name: "Continue", exact: true } }).ref).toBe("@e1");
  });

  it("matches Arabic and mixed-direction labels without damaging their text", () => {
    const current = snapshot([
      { ref: "@e1", role: "button", name: "فتح OAuth V1", withinText: "الأمان MTN OAuth V1" }
    ]);

    expect(findBrowserLocator(current, {
      role: "button",
      name: "فتح OAuth V1",
      withinText: "الأمان MTN"
    })).toMatchObject({ status: "found", candidates: [{ name: "فتح OAuth V1" }] });
  });

  it("does not select hidden or disabled targets by default", () => {
    const current = snapshot([
      { ref: "@e1", role: "button", name: "Continue", hidden: true },
      { ref: "@e2", role: "button", name: "Continue", disabled: true }
    ]);

    expect(findBrowserLocator(current, { role: "button", name: "Continue" })).toMatchObject({
      status: "not-found",
      candidates: []
    });
  });

  it("redacts secret-looking candidate text", () => {
    const result = findBrowserLocator(snapshot([
      { ref: "@e1", role: "button", name: "token=do-not-render", withinText: "Bearer abcdefghijklmnopqrstuvwxyz" }
    ]), { role: "button", name: "token=" });
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain("do-not-render");
    expect(serialized).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(serialized).toContain("[REDACTED]");
  });
});
