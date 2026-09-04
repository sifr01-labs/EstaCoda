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
  it("offers a unique exact-text role alternative without authorizing the mismatched locator", () => {
    const current = snapshot([{ ref: "@e1", role: "button", name: "Example application" }]);
    const locator = { role: "link", text: "Example application" };
    expect(findBrowserLocator(current, locator)).toMatchObject({
      status: "not-found", candidates: [],
      alternative: { reason: "role-mismatch", requestedRole: "link", candidate: { ref: "@e1", role: "button" } }
    });
    expect(() => resolveBrowserTarget(current, { locator })).toThrowError(expect.objectContaining({ reason: "browser-target-not-found" }));
    expect(findBrowserLocator(snapshot([
      { ref: "@e1", role: "button", name: "Example application" },
      { ref: "@e2", role: "button", name: "Example application" }
    ]), locator)).not.toHaveProperty("alternative");
    expect(findBrowserLocator(current, { ...locator, withinText: "Other section" })).not.toHaveProperty("alternative");
    expect(findBrowserLocator(snapshot([{ ref: "@e1", role: "button", name: "Example application", disabled: true }]), locator))
      .not.toHaveProperty("alternative");
    expect(findBrowserLocator(current, { role: "link", text: "Example" })).not.toHaveProperty("alternative");
  });
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

  it("returns bounded current-document nearby candidates without treating them as exact", () => {
    const current = snapshot([
      { ref: "@e1", role: "button", name: "TikTok notifications", withinText: "Connected apps" },
      { ref: "@e2", role: "button", name: "TikTok settings", withinText: "Developer tools" },
      { ref: "@e3", role: "button", name: "TikTok analytics" },
      { ref: "@e4", role: "button", name: "TikTok business center" },
      { ref: "@e5", role: "button", name: "TikTok account" },
      { ref: "@e6", role: "button", name: "MTN application" }
    ]);

    const result = findBrowserLocator(current, {
      role: "button",
      name: "TikTok Connect application",
      exact: true
    });

    expect(result).toMatchObject({
      status: "not-found",
      candidates: [],
      nearbyCandidates: [
        { ref: "@e1", identity: current.identity, tabRef: "@t2" },
        { ref: "@e2", identity: current.identity, tabRef: "@t2" },
        { ref: "@e3", identity: current.identity, tabRef: "@t2" },
        { ref: "@e4", identity: current.identity, tabRef: "@t2" }
      ]
    });
    expect(() => resolveBrowserTarget(current, {
      locator: { role: "button", name: "TikTok Connect application", exact: true }
    })).toThrowError(expect.objectContaining({ reason: "browser-target-not-found" }));
  });

  it("prioritizes actions in a matching semantic region over incidental notification text", () => {
    const appRegion = "TikTok Connect Callback URL Edit Delete";
    const current = snapshot([
      {
        ref: "@e1",
        role: "link",
        name: "TikTok Connect notification",
        regionText: "Notifications Recent events TikTok Connect was updated by another administrator"
      },
      { ref: "@e2", role: "link", name: "Callback URL", regionText: appRegion },
      { ref: "@e3", role: "button", name: "Edit", regionText: appRegion },
      { ref: "@e4", role: "button", name: "Delete", regionText: appRegion }
    ]);

    const result = findBrowserLocator(current, { name: "TikTok Connect", exact: true });

    expect(result).toMatchObject({
      status: "not-found",
      candidates: [],
      nearbyCandidates: [
        { ref: "@e2", name: "Callback URL", regionText: appRegion },
        { ref: "@e3", name: "Edit", regionText: appRegion },
        { ref: "@e4", name: "Delete", regionText: appRegion },
        { ref: "@e1", name: "TikTok Connect notification" }
      ]
    });

    expect(() => resolveBrowserTarget(current, {
      locator: { name: "TikTok Connect", exact: true }
    })).toThrowError(expect.objectContaining<Partial<BrowserTargetError>>({
      reason: "browser-target-not-found",
      nearbyCandidates: [
        expect.objectContaining({ ref: "@e2" }),
        expect.objectContaining({ ref: "@e3" }),
        expect.objectContaining({ ref: "@e4" }),
        expect.objectContaining({ ref: "@e1" })
      ]
    }));
  });

  it("prefers a directly named scripted app toggle over a richer incidental region", () => {
    const current = snapshot([
      {
        ref: "@e1",
        role: "button",
        name: "TikTok Connect",
        text: "TikTok Connect",
        regionText: "TikTok Connect Callback URL"
      },
      {
        ref: "@e2",
        role: "link",
        name: "TikTok Connect was updated",
        regionText: "Notifications Recent events TikTok Connect was updated Mark as read Dismiss"
      },
      { ref: "@e3", role: "button", name: "Mark as read", regionText: "Notifications Recent events TikTok Connect was updated Mark as read Dismiss" },
      { ref: "@e4", role: "button", name: "Dismiss", regionText: "Notifications Recent events TikTok Connect was updated Mark as read Dismiss" }
    ], {
      regions: [
        { ref: "@r1", text: "TikTok Connect Callback URL", actionRefs: ["@e1"], links: [], hitTestable: true },
        {
          ref: "@r2",
          text: "Notifications Recent events TikTok Connect was updated Mark as read Dismiss",
          actionRefs: ["@e2", "@e3", "@e4"],
          links: [],
          hitTestable: true
        }
      ]
    });

    expect(findBrowserLocator(current, { name: "TikTok Connect" })).toMatchObject({
      status: "found",
      candidates: [{ ref: "@e1", kind: "element", role: "button", name: "TikTok Connect" }]
    });
  });

  it("finds and resolves a trusted visible region when no element names the card", () => {
    const current = snapshot([
      { ref: "@e1", role: "link", name: "Callback URL" },
      { ref: "@e2", role: "button", name: "Edit" },
      { ref: "@e3", role: "button", name: "Delete" },
      { ref: "@e4", role: "link", name: "TikTok Connect notification", regionText: "Notifications TikTok Connect was updated" }
    ], {
      regions: [
        {
          ref: "@r1",
          text: "TikTok Connect Callback URL Edit Delete",
          actionRefs: ["@e1", "@e2", "@e3"],
          links: [{ text: "Callback URL", href: "https://example.com/callback" }],
          hitTestable: true
        },
        {
          ref: "@r2",
          text: "Notifications TikTok Connect was updated",
          actionRefs: ["@e4"],
          links: [],
          hitTestable: true
        }
      ]
    });

    expect(findBrowserLocator(current, { text: "TikTok Connect" })).toMatchObject({
      status: "found",
      candidates: [{ ref: "@r1", kind: "region", text: "TikTok Connect Callback URL Edit Delete" }]
    });
    expect(resolveBrowserTarget(current, {
      sessionId: current.sessionId,
      regionRef: "@r1",
      identity: current.identity,
      tabRef: current.tab!.ref
    })).toMatchObject({ ref: "@r1", kind: "region", tabRef: "@t2" });
  });

  it("rejects a blocked visible region and returns its grounded descendant actions", () => {
    const current = snapshot([
      { ref: "@e1", role: "button", name: "Edit" },
      { ref: "@e2", role: "button", name: "Delete" }
    ], {
      regions: [{
        ref: "@r1",
        text: "TikTok Connect Edit Delete",
        actionRefs: ["@e1", "@e2"],
        links: [],
        hitTestable: false,
        blockedBy: "Consent dialog"
      }]
    });

    expect(() => resolveBrowserTarget(current, {
      sessionId: current.sessionId,
      regionRef: "@r1",
      identity: current.identity,
      tabRef: current.tab!.ref
    })).toThrowError(expect.objectContaining<Partial<BrowserTargetError>>({
      reason: "browser-target-not-interactable",
      nearbyCandidates: [
        expect.objectContaining({ ref: "@e1", name: "Edit" }),
        expect.objectContaining({ ref: "@e2", name: "Delete" })
      ]
    }));
  });

  it("does not invent nearby candidates without structural text overlap", () => {
    const result = findBrowserLocator(snapshot([
      { ref: "@e1", role: "button", name: "MTN developer portal" }
    ]), { role: "button", name: "TikTok Connect" });

    expect(result).toEqual(expect.objectContaining({
      status: "not-found",
      candidates: []
    }));
    expect(result).not.toHaveProperty("nearbyCandidates");
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

  it("uses the shared interactability result for find and action resolution", () => {
    const current = snapshot([
      { ref: "@e1", role: "button", name: "Continue", interactable: false, interactabilityReason: "modal-blocked" },
      { ref: "@e2", role: "button", name: "Cancel" }
    ]);

    expect(findBrowserLocator(current, { role: "button", name: "Continue" })).toMatchObject({
      status: "not-found",
      candidates: []
    });
    expect(() => resolveBrowserTarget(current, {
      sessionId: current.sessionId,
      ref: "@e1",
      identity: current.identity,
      tabRef: current.tab!.ref
    })).toThrowError(expect.objectContaining({ reason: "browser-target-not-interactable" }));
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
