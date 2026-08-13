import { describe, expect, it } from "vitest";
import type { BrowserSnapshot } from "../contracts/browser.js";
import { observeBrowserSnapshot, type BrowserSnapshotRevisionState } from "./snapshot-state.js";

function snapshot(text: string): BrowserSnapshot {
  return {
    sessionId: "session-1",
    url: "https://example.com",
    revision: 0,
    observedAt: "1970-01-01T00:00:00.000Z",
    readiness: "complete",
    text,
    elements: [{ ref: "@e1", role: "button", name: "Continue" }]
  };
}

describe("browser snapshot state", () => {
  it("increments revision only after meaningful state changes", () => {
    const state: BrowserSnapshotRevisionState = { revision: 0 };
    let now = 1_000;

    const first = observeBrowserSnapshot(snapshot("Initial"), state, () => now);
    now += 1_000;
    const unchanged = observeBrowserSnapshot(snapshot("Initial"), state, () => now);
    now += 1_000;
    const changed = observeBrowserSnapshot(snapshot("React update complete"), state, () => now);

    expect(first).toMatchObject({ revision: 1, observedAt: "1970-01-01T00:00:01.000Z" });
    expect(unchanged).toMatchObject({ revision: 1, observedAt: "1970-01-01T00:00:02.000Z" });
    expect(changed).toMatchObject({ revision: 2, observedAt: "1970-01-01T00:00:03.000Z" });
  });
});
