import { describe, expect, it, vi } from "vitest";
import { deriveBrowserSessionKey, type BrowserSessionKeyContext } from "./session-key.js";

function contextWithSession(sessionId: string): BrowserSessionKeyContext {
  return {
    currentSessionId: () => sessionId
  };
}

describe("deriveBrowserSessionKey", () => {
  it("prefers an explicit sessionId over the runtime session", () => {
    const currentSessionId = vi.fn(() => "runtime-session");

    expect(deriveBrowserSessionKey({ currentSessionId }, "shared-browser-session")).toBe("shared-browser-session");
    expect(currentSessionId).not.toHaveBeenCalled();
  });

  it("returns an explicit sessionId unchanged", () => {
    expect(deriveBrowserSessionKey(contextWithSession("runtime-session"), "  shared-browser-session  ")).toBe(
      "  shared-browser-session  "
    );
  });

  it("falls back to the runtime session key for an empty explicit sessionId", () => {
    expect(deriveBrowserSessionKey(contextWithSession("runtime-session"), "")).toBe("runtime-session:main");
  });

  it("falls back to the runtime session key for a whitespace-only explicit sessionId", () => {
    expect(deriveBrowserSessionKey(contextWithSession("runtime-session"), "   ")).toBe("runtime-session:main");
  });

  it("derives the main browser key from the current runtime session when explicit sessionId is absent", () => {
    expect(deriveBrowserSessionKey(contextWithSession("runtime-session"))).toBe("runtime-session:main");
  });

  it("produces different browser keys for different runtime sessions", () => {
    expect(deriveBrowserSessionKey(contextWithSession("runtime-a"))).toBe("runtime-a:main");
    expect(deriveBrowserSessionKey(contextWithSession("runtime-b"))).toBe("runtime-b:main");
  });

  it.each(["", "   "])("throws when the runtime session ID is missing: %j", (sessionId) => {
    expect(() => deriveBrowserSessionKey(contextWithSession(sessionId))).toThrow(
      "Browser session key requires a current runtime session ID when no explicit browser sessionId is provided."
    );
  });

  it("throws a deterministic error when the runtime session ID is undefined at runtime", () => {
    const ctx = { currentSessionId: () => undefined } as unknown as BrowserSessionKeyContext;

    expect(() => deriveBrowserSessionKey(ctx)).toThrow(
      "Browser session key requires a current runtime session ID when no explicit browser sessionId is provided."
    );
  });

  it("does not require browser backend, CDP, Chrome launcher, or filesystem inputs", () => {
    expect(deriveBrowserSessionKey({ currentSessionId: () => "runtime-session" })).toBe("runtime-session:main");
  });
});
