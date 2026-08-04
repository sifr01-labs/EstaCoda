import { describe, expect, it } from "vitest";
import { resolveSessionLaunchIntent } from "./session-launch-intent.js";

describe("session launch intent", () => {
  it("starts fresh by default", () => {
    expect(resolveSessionLaunchIntent({ argv: [], continueSession: false })).toEqual({ kind: "new" });
  });

  it("represents each explicit continuation route", () => {
    expect(resolveSessionLaunchIntent({ argv: [], continueSession: true })).toEqual({ kind: "continue" });
    expect(resolveSessionLaunchIntent({ argv: ["sessions"], continueSession: false })).toEqual({
      kind: "pick",
      includeOtherWorkspaces: false,
    });
    expect(resolveSessionLaunchIntent({
      argv: ["sessions", "open", "session-1"],
      continueSession: false,
    })).toEqual({ kind: "open", sessionId: "session-1" });
  });

  it("uses a validated picker handoff over the original command shape", () => {
    expect(resolveSessionLaunchIntent({
      argv: [],
      continueSession: false,
      selectedSessionId: "selected-session",
    })).toEqual({ kind: "open", sessionId: "selected-session" });
  });
});
