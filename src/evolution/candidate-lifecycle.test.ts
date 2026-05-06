import { describe, expect, it } from "vitest";
import { canTransition } from "./candidate-lifecycle.js";

describe("canTransition", () => {
  it("allows proposed -> testing", () => {
    expect(canTransition("proposed", "test")).toEqual({ ok: true });
  });

  it("allows testing -> approved", () => {
    expect(canTransition("testing", "approve")).toEqual({ ok: true });
  });

  it("allows testing -> rejected", () => {
    expect(canTransition("testing", "reject")).toEqual({ ok: true });
  });

  it("allows approved -> promoted", () => {
    expect(canTransition("approved", "promote")).toEqual({ ok: true });
  });

  it("allows promoted -> reverted", () => {
    expect(canTransition("promoted", "rollback")).toEqual({ ok: true });
  });

  it("rejects proposed -> promoted", () => {
    const result = canTransition("proposed", "promote");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("explicitly approved before promotion");
    }
  });

  it("rejects testing -> promoted", () => {
    const result = canTransition("testing", "promote");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("explicitly approved before promotion");
    }
  });

  it("rejects rejected -> approved", () => {
    const result = canTransition("rejected", "approve");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("'testing'");
    }
  });

  it("rejects approved -> rollback", () => {
    const result = canTransition("approved", "rollback");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("has not been promoted");
    }
  });

  it("rejects promoted -> approve", () => {
    const result = canTransition("promoted", "approve");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("'testing'");
    }
  });

  it("rejects proposed -> approve", () => {
    const result = canTransition("proposed", "approve");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("'testing'");
    }
  });
});
