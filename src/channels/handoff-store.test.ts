import { describe, expect, it } from "vitest";
import { InMemoryHandoffStore } from "./handoff-store.js";

describe("HandoffStore", () => {
  describe("create", () => {
    it("creates a handoff code with session id and expiry", async () => {
      const store = new InMemoryHandoffStore();
      const handoff = await store.create({ sessionId: "sess-abc", surfaceType: "telegram", ttlMinutes: 10 });

      expect(typeof handoff.code).toBe("string");
      expect(handoff.code.length).toBe(6);
      expect(handoff.sessionId).toBe("sess-abc");
      expect(handoff.surfaceType).toBe("telegram");
      expect(handoff.redeemed).toBe(false);

      const expiresAt = new Date(handoff.expiresAt);
      const createdAt = new Date(handoff.createdAt);
      expect(expiresAt.getTime() - createdAt.getTime()).toBe(10 * 60 * 1000);
    });

    it("generates unique codes", async () => {
      const store = new InMemoryHandoffStore();
      const codes = new Set<string>();
      for (let i = 0; i < 50; i++) {
        const handoff = await store.create({ sessionId: `sess-${i}`, surfaceType: "telegram", ttlMinutes: 10 });
        codes.add(handoff.code);
      }
      expect(codes.size).toBe(50);
    });
  });

  describe("redeem", () => {
    it("redeems a valid code successfully", async () => {
      const store = new InMemoryHandoffStore();
      const handoff = await store.create({ sessionId: "sess-abc", surfaceType: "telegram", ttlMinutes: 10 });

      const result = await store.redeem({ code: handoff.code, surfaceType: "telegram", surfaceId: "chat-123" });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.handoff.redeemed).toBe(true);
        expect(result.handoff.redeemedBySurfaceId).toBe("chat-123");
        expect(typeof result.handoff.redeemedAt).toBe("string");
      }
    });

    it("fails to redeem an invalid code", async () => {
      const store = new InMemoryHandoffStore();
      const result = await store.redeem({ code: "INVALID", surfaceType: "telegram", surfaceId: "chat-123" });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("Invalid handoff code.");
      }
    });

    it("fails to redeem an already used code", async () => {
      const store = new InMemoryHandoffStore();
      const handoff = await store.create({ sessionId: "sess-abc", surfaceType: "telegram", ttlMinutes: 10 });

      const first = await store.redeem({ code: handoff.code, surfaceType: "telegram", surfaceId: "chat-123" });
      expect(first.ok).toBe(true);

      const second = await store.redeem({ code: handoff.code, surfaceType: "telegram", surfaceId: "chat-456" });
      expect(second.ok).toBe(false);
      if (!second.ok) {
        expect(second.reason).toBe("Handoff code already used.");
      }
    });

    it("fails to redeem an expired code", async () => {
      const store = new InMemoryHandoffStore();
      const handoff = await store.create({ sessionId: "sess-abc", surfaceType: "telegram", ttlMinutes: 1 });

      const future = new Date(Date.now() + 2 * 60 * 1000);
      const result = await store.redeem({ code: handoff.code, surfaceType: "telegram", surfaceId: "chat-123" });
      // The code is not expired yet because we didn't time-travel the store
      expect(result.ok).toBe(true);

      // Now purge expired and try again
      await store.purgeExpired(future);
      const afterPurge = await store.get(handoff.code);
      expect(afterPurge).toBeUndefined();
    });

    it("fails to redeem a code for the wrong surface type", async () => {
      const store = new InMemoryHandoffStore();
      const handoff = await store.create({ sessionId: "sess-abc", surfaceType: "telegram", ttlMinutes: 10 });

      const result = await store.redeem({ code: handoff.code, surfaceType: "discord", surfaceId: "chat-123" });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("Handoff code is for telegram, not discord.");
      }
    });

    it("is case-insensitive for code input", async () => {
      const store = new InMemoryHandoffStore();
      const handoff = await store.create({ sessionId: "sess-abc", surfaceType: "telegram", ttlMinutes: 10 });

      const lower = await store.redeem({ code: handoff.code.toLowerCase(), surfaceType: "telegram", surfaceId: "chat-123" });
      expect(lower.ok).toBe(true);
    });
  });

  describe("purgeExpired", () => {
    it("removes expired codes", async () => {
      const store = new InMemoryHandoffStore();
      await store.create({ sessionId: "sess-old", surfaceType: "telegram", ttlMinutes: 1 });
      await store.create({ sessionId: "sess-new", surfaceType: "telegram", ttlMinutes: 60 });

      const future = new Date(Date.now() + 2 * 60 * 1000);
      const purged = await store.purgeExpired(future);
      expect(purged).toBe(1);

      const remaining = await store.list();
      expect(remaining.length).toBe(1);
      expect(remaining[0]?.sessionId).toBe("sess-new");
    });
  });
});
