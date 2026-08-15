import { describe, expect, it } from "vitest";
import type { BrowserSnapshot } from "../contracts/browser.js";
import {
  createBrowserSnapshotIdentityState,
  observeBrowserState
} from "./snapshot-state.js";

function snapshot(overrides: Partial<BrowserSnapshot> = {}): BrowserSnapshot {
  return {
    sessionId: "session-1",
    url: "https://example.com",
    revision: 0,
    observedAt: "1970-01-01T00:00:00.000Z",
    readiness: "complete",
    text: "Initial",
    tab: { ref: "@t1", url: "https://example.com", controlled: true },
    elements: [{ ref: "@e1", role: "button", name: "Continue" }],
    ...overrides
  };
}

describe("browser snapshot state identity", () => {
  it("advances only observationId for repeated observations", () => {
    const state = createBrowserSnapshotIdentityState();
    let now = 1_000;

    const first = observeBrowserState(snapshot(), state, { frameId: "main", loaderId: "loader-1" }, () => now);
    now += 1_000;
    const repeated = observeBrowserState(snapshot(), state, { frameId: "main", loaderId: "loader-1" }, () => now);

    expect(first.identity).toEqual({ documentEpoch: 1, actionRevision: 1, observationId: 1 });
    expect(repeated.identity).toEqual({ documentEpoch: 1, actionRevision: 1, observationId: 2 });
    expect(first.snapshot.observedAt).toBe("1970-01-01T00:00:01.000Z");
    expect(repeated.snapshot.observedAt).toBe("1970-01-01T00:00:02.000Z");
  });

  it("keeps compact and full observations on the same actionable revision", () => {
    const state = createBrowserSnapshotIdentityState();
    const compact = observeBrowserState(snapshot(), state, { frameId: "main", loaderId: "loader-1" });
    const full = observeBrowserState(snapshot({
      elements: [
        { ref: "@e1", role: "button", name: "Continue" },
        { ref: "@e2", role: "heading", name: "Account details" }
      ]
    }), state, { frameId: "main", loaderId: "loader-1" });

    expect(full.identity.actionRevision).toBe(compact.identity.actionRevision);
    expect(full.snapshot.revision).toBe(compact.snapshot.revision);
  });

  it("does not invalidate unrelated actions when field values change", () => {
    const state = createBrowserSnapshotIdentityState();
    const initial = observeBrowserState(snapshot({
      elements: [
        { ref: "@e1", role: "textbox", name: "Email", value: "first@example.com" },
        { ref: "@e2", role: "button", name: "Continue" }
      ]
    }), state, { frameId: "main", loaderId: "loader-1" });
    const edited = observeBrowserState(snapshot({
      elements: [
        { ref: "@e1", role: "textbox", name: "Email", value: "second@example.com" },
        { ref: "@e2", role: "button", name: "Continue" }
      ]
    }), state, { frameId: "main", loaderId: "loader-1" });

    expect(edited.identity.actionRevision).toBe(initial.identity.actionRevision);
  });

  it("advances actionRevision when the actionable control map changes", () => {
    const state = createBrowserSnapshotIdentityState();
    const initial = observeBrowserState(snapshot(), state, { frameId: "main", loaderId: "loader-1" });
    const changed = observeBrowserState(snapshot({
      elements: [
        { ref: "@e1", role: "button", name: "Continue" },
        { ref: "@e2", role: "link", name: "Cancel" }
      ]
    }), state, { frameId: "main", loaderId: "loader-1" });

    expect(changed.identity).toEqual({
      documentEpoch: initial.identity.documentEpoch,
      actionRevision: initial.identity.actionRevision + 1,
      observationId: initial.identity.observationId + 1
    });
  });

  it("advances documentEpoch for same-URL document replacement", () => {
    const state = createBrowserSnapshotIdentityState();
    const initial = observeBrowserState(snapshot(), state, { frameId: "main", loaderId: "loader-1" });
    const replacement = observeBrowserState(snapshot(), state, { frameId: "main", loaderId: "loader-2" });

    expect(replacement.identity.documentEpoch).toBe(initial.identity.documentEpoch + 1);
    expect(replacement.identity.actionRevision).toBe(initial.identity.actionRevision + 1);
    expect(replacement.snapshot.url).toBe(initial.snapshot.url);
  });
});
