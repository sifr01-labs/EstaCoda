import { describe, expect, it } from "vitest";
import { InMemorySurfacePointerStore } from "./surface-pointer-store.js";

describe("SurfacePointerStore", () => {
  describe("getPointer / setPointer", () => {
    it("returns undefined when no pointer is set", async () => {
      const store = new InMemorySurfacePointerStore();
      const pointer = await store.getPointer("telegram", "123456");
      expect(pointer).toBeUndefined();
    });

    it("stores and retrieves a pointer", async () => {
      const store = new InMemorySurfacePointerStore();
      await store.setPointer("telegram", "123456", { sessionId: "sess-abc", attachedAt: "2024-01-01T00:00:00Z" });

      const pointer = await store.getPointer("telegram", "123456");
      expect(pointer).toBeDefined();
      expect(pointer?.sessionId).toBe("sess-abc");
      expect(pointer?.attachedAt).toBe("2024-01-01T00:00:00Z");
    });

    it("overwrites an existing pointer", async () => {
      const store = new InMemorySurfacePointerStore();
      await store.setPointer("telegram", "123456", { sessionId: "sess-abc", attachedAt: "2024-01-01T00:00:00Z" });
      await store.setPointer("telegram", "123456", { sessionId: "sess-def", attachedAt: "2024-01-02T00:00:00Z" });

      const pointer = await store.getPointer("telegram", "123456");
      expect(pointer?.sessionId).toBe("sess-def");
    });

    it("keeps pointers for different surfaces independent", async () => {
      const store = new InMemorySurfacePointerStore();
      await store.setPointer("telegram", "123456", { sessionId: "sess-abc", attachedAt: "2024-01-01T00:00:00Z" });
      await store.setPointer("discord", "789012", { sessionId: "sess-def", attachedAt: "2024-01-02T00:00:00Z" });

      const telegram = await store.getPointer("telegram", "123456");
      const discord = await store.getPointer("discord", "789012");
      const missing = await store.getPointer("telegram", "789012");

      expect(telegram?.sessionId).toBe("sess-abc");
      expect(discord?.sessionId).toBe("sess-def");
      expect(missing).toBeUndefined();
    });
  });

  describe("removePointer", () => {
    it("removes a pointer", async () => {
      const store = new InMemorySurfacePointerStore();
      await store.setPointer("telegram", "123456", { sessionId: "sess-abc", attachedAt: "2024-01-01T00:00:00Z" });
      await store.removePointer("telegram", "123456");

      const pointer = await store.getPointer("telegram", "123456");
      expect(pointer).toBeUndefined();
    });

    it("is idempotent for missing pointers", async () => {
      const store = new InMemorySurfacePointerStore();
      await store.removePointer("telegram", "999999");
      const pointer = await store.getPointer("telegram", "999999");
      expect(pointer).toBeUndefined();
    });
  });

  describe("listPointers", () => {
    it("lists all pointers", async () => {
      const store = new InMemorySurfacePointerStore();
      await store.setPointer("telegram", "123456", { sessionId: "sess-abc", attachedAt: "2024-01-01T00:00:00Z" });
      await store.setPointer("telegram", "789012", { sessionId: "sess-def", attachedAt: "2024-01-02T00:00:00Z" });
      await store.setPointer("discord", "111111", { sessionId: "sess-ghi", attachedAt: "2024-01-03T00:00:00Z" });

      const pointers = await store.listPointers();
      expect(pointers.length).toBe(3);

      const telegram1 = pointers.find((p) => p.surfaceType === "telegram" && p.surfaceId === "123456");
      expect(telegram1?.record.sessionId).toBe("sess-abc");
    });
  });
});
