import { describe, expect, it } from "vitest";
import type { BrowserSnapshot } from "../contracts/browser.js";
import { compactBrowserSnapshot } from "./snapshot-compactor.js";

function snapshot(overrides: Partial<BrowserSnapshot> = {}): BrowserSnapshot {
  return {
    sessionId: "session-1",
    url: "https://portal.example.com/login",
    identity: { documentEpoch: 2, actionRevision: 4, observationId: 7 },
    observedAt: "2026-08-18T00:00:00.000Z",
    readiness: "complete",
    title: "Developer Portal",
    tab: { ref: "@t1", url: "https://portal.example.com/login", title: "Developer Portal", controlled: true },
    text: "Sign in\nEmail\nPassword\nContinue",
    elements: [
      { ref: "@e1", role: "textbox", name: "Email", label: "Email" },
      { ref: "@e2", role: "textbox", name: "Password", label: "Password" },
      { ref: "@e3", role: "button", name: "Continue", withinText: "Sign in" }
    ],
    ...overrides
  };
}

describe("compactBrowserSnapshot", () => {
  it("produces byte-identical output for identical structured input", () => {
    const current = snapshot({ text: "Overview\nOverview\nSign in\nSign in" });

    const first = compactBrowserSnapshot(current, { maxChars: 2_000, inputChars: 9_000 });
    const second = compactBrowserSnapshot(current, { maxChars: 2_000, inputChars: 9_000 });

    expect(second).toEqual(first);
    expect(first.mode).toBe("deterministic");
    expect(first.compacted).toBe(true);
  });

  it("preserves identity, dialogs, errors, actionable refs, protected guidance, frames, and console failures", () => {
    const current = snapshot({
      url: "https://portal.example.com/login?api_key=do-not-render",
      text: [
        "Account login",
        "Verification code required",
        "Invalid code. Try again.",
        "Account login",
        "General background copy."
      ].join("\n"),
      elements: [
        { ref: "@e1", role: "textbox", name: "Email", label: "Email" },
        { ref: "@e2", role: "textbox", name: "Password", label: "Password" },
        { ref: "@e3", role: "button", name: "Continue", withinText: "Account login" },
        { ref: "@e4", role: "alert", name: "Invalid code" },
        { ref: "@e5", role: "heading", name: "Verify account" }
      ],
      pendingDialogs: [{ id: "dialog-1", type: "confirm", message: "Approve sign in?" }],
      frameTree: [{ frameId: "frame-1", url: "https://challenge.example.com/", origin: "https://challenge.example.com", isOopif: true }],
      consoleHistory: [{ level: "error", text: "Authentication request failed", timestamp: "2026-08-18T00:00:01.000Z" }]
    });

    const result = compactBrowserSnapshot(current, { maxChars: 4_000, inputChars: 12_000 });

    expect(result.content).toContain("Identity: documentEpoch=2 actionRevision=4 observationId=7");
    expect(result.content).toContain("URL: [REDACTED_URL_WITH_SECRET]");
    expect(result.content).toContain("dialog-1 confirm: Approve sign in?");
    expect(result.content).toContain("Invalid code");
    expect(result.content).toContain("@e1 textbox Email");
    expect(result.content).toContain("@e2 textbox Password");
    expect(result.content).toContain("@e3 button Continue");
    expect(result.content).toContain("browser.fill_protected_form");
    expect(result.content).toContain("frame-1 https://challenge.example.com/");
    expect(result.content).toContain("[error] 2026-08-18T00:00:01.000Z Authentication request failed");
    expect(result.content).not.toContain("do-not-render");
  });

  it("preserves navigation failures and redacts protected field values", () => {
    const current = snapshot({
      actionDelta: {
        outcome: "dispatched-unverified",
        actionDispatched: true,
        settlementFailed: true,
        documentChangeObserved: false,
        stateObservation: "last-known",
        beforeIdentity: { documentEpoch: 2, actionRevision: 3, observationId: 6 },
        afterIdentity: { documentEpoch: 2, actionRevision: 4, observationId: 7 },
        waitCondition: "dom-stable",
        conditionMet: false,
        url: {
          changed: false,
          before: "https://portal.example.com/login",
          after: "https://portal.example.com/login"
        }
      },
      elements: [
        { ref: "@e1", role: "textbox", name: "Email", label: "Email", value: "ada@example.com" },
        { ref: "@e2", role: "textbox", name: "Password", label: "Password", value: "plain-secret" }
      ]
    });

    const result = compactBrowserSnapshot(current, { maxChars: 2_000 });

    expect(result.content).toContain("Outcome=dispatched-unverified wait=dom-stable conditionMet=false");
    expect(result.content).toContain("Settlement verification failed; observation=last-known documentChangeObserved=false");
    expect(result.content).toContain('value="ada@example.com"');
    expect(result.content).toContain('value="[REDACTED]"');
    expect(result.content).not.toContain("plain-secret");
  });

  it("deduplicates repeated navigation and boilerplate while retaining the first safe ref", () => {
    const current = snapshot({
      text: "Privacy policy. Privacy policy. Privacy policy. Account settings.",
      elements: [
        { ref: "@e1", role: "link", name: "Home", withinText: "Main navigation" },
        { ref: "@e2", role: "link", name: "Home", withinText: "Main navigation" },
        { ref: "@e3", role: "button", name: "Save" }
      ]
    });

    const result = compactBrowserSnapshot(current, { maxChars: 2_000, inputChars: 8_000 });

    expect(result.content).toContain("@e1 link Home");
    expect(result.content).not.toContain("@e2 link Home");
    expect(result.content.match(/Privacy policy\./gu)).toHaveLength(1);
    expect(result.content).toContain("@e3 button Save");
  });

  it("uses a stable hard budget and visibly marks omitted content", () => {
    const current = snapshot({
      text: Array.from({ length: 100 }, (_, index) => `Unique page region ${index} with explanatory content.`).join("\n"),
      elements: Array.from({ length: 40 }, (_, index) => ({
        ref: `@e${index + 1}`,
        role: "button",
        name: `Action ${index}`
      }))
    });

    const result = compactBrowserSnapshot(current, { maxChars: 700, inputChars: 30_000 });

    expect(result.content.length).toBeLessThanOrEqual(700);
    expect(result.content).toMatch(/\.\.\. \[deterministically compacted\]$/u);
    expect(result.truncated).toBe(true);
    expect(result.omittedItems).toBeGreaterThan(0);
  });

  it("keeps a representative sign-in form executable without viewport filtering", () => {
    const result = compactBrowserSnapshot(snapshot({
      elements: [
        { ref: "@e1", role: "textbox", name: "Email", label: "Work email" },
        { ref: "@e2", role: "textbox", name: "Password", label: "Password" },
        { ref: "@e3", role: "button", name: "Sign in", withinText: "Developer account" },
        { ref: "@e4", role: "link", name: "Forgot password" }
      ]
    }), { maxChars: 2_000 });

    expect(result.content).toContain("@e1 textbox Email label=\"Work email\"");
    expect(result.content).toContain("@e2 textbox Password");
    expect(result.content).toContain("@e3 button Sign in within=\"Developer account\"");
    expect(result.content).toContain("identity={\"documentEpoch\":2,\"actionRevision\":4,\"observationId\":7}");
  });

  it("soft-hints a grounded API description export without forcing a workflow", () => {
    const result = compactBrowserSnapshot(snapshot({
      text: "OAuth V1 documentation",
      elements: [
        { ref: "@e17", role: "link", name: "Read endpoint details" },
        { ref: "@e18", role: "link", name: "Download Swagger" },
        { ref: "@e19", role: "link", name: "Export CSV report" }
      ]
    }), { maxChars: 2_000 });

    expect(result.content).toContain("Machine-readable API description available: @e18 Download Swagger");
    expect(result.content).not.toContain("Machine-readable API description available: @e19");
  });
});
