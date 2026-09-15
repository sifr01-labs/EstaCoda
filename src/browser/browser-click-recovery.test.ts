import { describe, expect, it } from "vitest";
import type { BrowserActionInput, BrowserActionTargetSemantics, BrowserSnapshot } from "../contracts/browser.js";
import { BrowserClickRecovery } from "./browser-click-recovery.js";

const semantics: BrowserActionTargetSemantics = {
  ref: "@e1", kind: "link", tag: "a", label: "Login", href: "https://example.com/login",
  formAssociated: false, submit: false
};
function snapshot(revision = 1): BrowserSnapshot {
  return { observedAt: "2026-09-15T00:00:00.000Z", sessionId: "chat", url: "https://example.com/", identity: {
    documentEpoch: 1, actionRevision: revision, observationId: revision
  }, tab: { ref: "@t1", controlled: true, url: "https://example.com/" },
  elements: [{ ref: "@e1", role: "link", name: "Login", interactable: true }] };
}
function target(s: BrowserSnapshot): BrowserActionInput {
  return { sessionId: s.sessionId, tabRef: s.tab!.ref, identity: s.identity, ref: "@e1" };
}
function fixture() {
  const recovery = new BrowserClickRecovery();
  const old = snapshot();
  const fresh = snapshot(2);
  fresh.elements![0]!.ref = "@e2";
  recovery.observe(old, { "@e1": 101 });
  recovery.review(old, "@e1", semantics);
  recovery.observe(fresh, { "@e2": 101 });
  return { recovery, old, fresh, input: target(old) };
}

describe("bounded browser click recovery", () => {
  it("rebinds the same unchanged CDP node when an unrelated region invalidates the global action map", async () => {
    const { recovery, fresh, input } = fixture();
    expect(recovery.resolve(fresh, input, "preflight").ref).toBe("@e2");
    expect(recovery.resolve(fresh, input, "dispatch").ref).toBe("@e2");
    await expect(recovery.verifyRecoveredDispatch(fresh, input, async () => ({ ...semantics, ref: "@e2" }))).resolves.toBeUndefined();
  });

  it.each([
    ["renamed target", (s: BrowserSnapshot) => { s.elements![0]!.name = "Delete account"; }],
    ["hidden target", (s: BrowserSnapshot) => { s.elements![0]!.hidden = true; }],
    ["disabled target", (s: BrowserSnapshot) => { s.elements![0]!.disabled = true; }],
    ["new document", (s: BrowserSnapshot) => { s.identity.documentEpoch += 1; }],
    ["different URL", (s: BrowserSnapshot) => { s.url = "https://example.com/other"; }],
    ["different tab", (s: BrowserSnapshot) => { s.tab!.ref = "@t2"; }],
    ["different session", (s: BrowserSnapshot) => { s.sessionId = "other"; }],
    ["pending dialog", (s: BrowserSnapshot) => { s.pendingDialogs = [{ id: "dialog", type: "confirm", message: "Confirm" }]; }],
  ] as const)("rejects %s", (_name, mutate) => {
    const { recovery, fresh, input } = fixture();
    mutate(fresh);
    expect(() => recovery.resolve(fresh, input, "preflight")).toThrow();
  });

  it.each<Record<string, number>>([{}, { "@e2": 202 }, { "@e2": 101, "@e3": 101 }])("rejects missing, replaced or ambiguous node provenance: %j", (nodes) => {
    const { recovery, fresh, input } = fixture();
    recovery.observe(fresh, nodes);
    expect(() => recovery.resolve(fresh, input, "preflight")).toThrow();
  });

  it("requires a retained observation and a security preflight before recovering dispatch", () => {
    const recovery = new BrowserClickRecovery();
    const old = snapshot(); const fresh = snapshot(2);
    recovery.observe(old, { "@e1": 101 }); recovery.observe(fresh, { "@e1": 101 });
    expect(recovery.resolve(fresh, target(old), "preflight").ref).toBe("@e1");
    expect(() => recovery.resolve(fresh, target(old), "dispatch")).toThrow();
    for (let i = 3; i < 11; i++) recovery.observe(snapshot(i), { "@e1": 101 });
    expect(() => recovery.resolve(snapshot(10), target(old), "preflight")).toThrow();
  });

  it.each([
    { ...semantics, href: "https://example.com/delete" },
    { ...semantics, kind: "scripted-control" as const },
    { ...semantics, formAssociated: true, submit: true },
    undefined,
  ])("rejects changed security semantics before recovered dispatch", async (current) => {
    const { recovery, fresh, input } = fixture();
    await expect(recovery.verifyRecoveredDispatch(fresh, input, async () => current)).rejects.toMatchObject({ reason: "stale-browser-ref" });
  });

  it("clears provenance on session close and leaves semantic locator dispatch unchanged", async () => {
    const { recovery, fresh, input } = fixture();
    recovery.clear("chat");
    expect(() => recovery.resolve(fresh, input, "preflight")).toThrow();
    const semanticInput = { sessionId: "chat", locator: { role: "link", name: "Login", exact: true } };
    expect(recovery.resolve(fresh, semanticInput, "dispatch").ref).toBe("@e2");
    await expect(recovery.verifyRecoveredDispatch(fresh, semanticInput, async () => { throw new Error("not needed"); })).resolves.toBeUndefined();
  });
});
