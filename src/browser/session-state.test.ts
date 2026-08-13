import { describe, expect, it } from "vitest";
import { BrowserSessionStateError, browserSessionStateReason } from "./session-state.js";

describe("browser session state", () => {
  it("preserves explicit structured session and tab loss reasons", () => {
    expect(browserSessionStateReason(
      new BrowserSessionStateError("session_missing", "Browser session not found")
    )).toBe("session_missing");
    expect(browserSessionStateReason(
      new BrowserSessionStateError("tab_missing", "Browser tab not found")
    )).toBe("tab_missing");
  });

  it("classifies closed CDP connections as a missing browser process", () => {
    expect(browserSessionStateReason(new Error("CDP WebSocket closed."))).toBe("browser_process_missing");
    expect(browserSessionStateReason(new Error("CDP WebSocket connection failed."))).toBe("browser_process_missing");
  });

  it("does not invent a structured reason for unrelated browser failures", () => {
    expect(browserSessionStateReason(new Error("Browser element ref not found"))).toBeUndefined();
  });
});
