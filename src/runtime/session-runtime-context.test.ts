import { describe, expect, it } from "vitest";
import { createSessionRuntimeContext } from "./session-runtime-context.js";

describe("SessionRuntimeContext browser state", () => {
  it("isolates browser projections across rotated runtime sessions", () => {
    const context = createSessionRuntimeContext("session-a");
    context.setBrowserState({
      sessionStatus: "active",
      sessionId: "session-a:main",
      freshness: "current"
    });

    context.rotateSession("session-b");
    expect(context.browserState()).toBeUndefined();
    context.setBrowserState({
      sessionStatus: "missing",
      sessionId: "session-b:main",
      freshness: "current"
    });

    context.rotateSession("session-a");
    expect(context.browserState()).toMatchObject({
      sessionStatus: "active",
      sessionId: "session-a:main"
    });
  });
});
