import { describe, expect, it, vi } from "vitest";
import { resolveStartupSessionId } from "./session-id.js";

describe("resolveStartupSessionId", () => {
  it("generates a fresh session id when no session was explicitly selected", () => {
    expect(resolveStartupSessionId(undefined, () => "new-session")).toBe("new-session");
  });

  it("uses an explicitly selected session without generating a new id", () => {
    const createId = vi.fn(() => "new-session");

    expect(resolveStartupSessionId("selected-session", createId)).toBe("selected-session");
    expect(createId).not.toHaveBeenCalled();
  });
});
