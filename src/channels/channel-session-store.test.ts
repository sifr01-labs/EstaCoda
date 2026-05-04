import { describe, expect, it } from "vitest";
import { PersistentChannelSessionStore, shouldAutoResetSession } from "./channel-session-store.js";
import { InMemorySurfacePointerStore } from "./surface-pointer-store.js";

describe("PersistentChannelSessionStore with surface pointers", () => {
  it("returns channel-local session id by default", async () => {
    const store = new PersistentChannelSessionStore({
      path: "/tmp/test-channel-sessions-" + Math.random().toString(36).slice(2) + ".json",
      policy: {}
    });

    const sessionKey = {
      platform: "telegram",
      accountId: "default",
      chatId: "123456",
      chatType: "dm" as const
    };

    const sessionId = await store.getOrCreateSessionId(sessionKey);
    expect(sessionId.startsWith("channel-telegram")).toBe(true);
  });

  it("returns attached session id when a surface pointer exists", async () => {
    const surfacePointerStore = new InMemorySurfacePointerStore();
    const store = new PersistentChannelSessionStore({
      path: "/tmp/test-channel-sessions-" + Math.random().toString(36).slice(2) + ".json",
      policy: {},
      surfacePointerStore
    });

    await surfacePointerStore.setPointer("telegram", "123456", {
      sessionId: "cli-session-abc",
      attachedAt: new Date().toISOString()
    });

    const sessionKey = {
      platform: "telegram",
      accountId: "default",
      chatId: "123456",
      chatType: "dm" as const
    };

    const sessionId = await store.getOrCreateSessionId(sessionKey);
    expect(sessionId).toBe("cli-session-abc");
  });

  it("returns channel-local session after detach", async () => {
    const surfacePointerStore = new InMemorySurfacePointerStore();
    const store = new PersistentChannelSessionStore({
      path: "/tmp/test-channel-sessions-" + Math.random().toString(36).slice(2) + ".json",
      policy: {},
      surfacePointerStore
    });

    const sessionKey = {
      platform: "telegram",
      accountId: "default",
      chatId: "123456",
      chatType: "dm" as const
    };

    // Attach
    await surfacePointerStore.setPointer("telegram", "123456", {
      sessionId: "cli-session-abc",
      attachedAt: new Date().toISOString()
    });
    const attachedId = await store.getOrCreateSessionId(sessionKey);
    expect(attachedId).toBe("cli-session-abc");

    // Detach
    await surfacePointerStore.removePointer("telegram", "123456");
    const detachedId = await store.getOrCreateSessionId(sessionKey);
    expect(detachedId.startsWith("channel-telegram")).toBe(true);
  });

  it("keeps independent sessions for different chats", async () => {
    const surfacePointerStore = new InMemorySurfacePointerStore();
    const store = new PersistentChannelSessionStore({
      path: "/tmp/test-channel-sessions-" + Math.random().toString(36).slice(2) + ".json",
      policy: {},
      surfacePointerStore
    });

    // Chat 1 is attached
    await surfacePointerStore.setPointer("telegram", "111", {
      sessionId: "shared-session",
      attachedAt: new Date().toISOString()
    });

    // Chat 2 is independent
    const chat1Key = { platform: "telegram" as const, accountId: "default", chatId: "111", chatType: "dm" as const };
    const chat2Key = { platform: "telegram" as const, accountId: "default", chatId: "222", chatType: "dm" as const };

    const chat1Id = await store.getOrCreateSessionId(chat1Key);
    const chat2Id = await store.getOrCreateSessionId(chat2Key);

    expect(chat1Id).toBe("shared-session");
    expect(chat2Id.startsWith("channel-telegram")).toBe(true);
    expect(chat1Id).not.toBe(chat2Id);
  });
});

describe("shouldAutoResetSession", () => {
  it("returns false when policy is none", () => {
    const result = shouldAutoResetSession("2024-01-01T00:00:00Z", new Date("2024-01-02T00:00:00Z"), { resetPolicy: "none" });
    expect(result).toBe(false);
  });

  it("returns true when idle time exceeds threshold", () => {
    const updatedAt = "2024-01-01T00:00:00Z";
    const receivedAt = new Date("2024-01-01T05:00:00Z");
    const result = shouldAutoResetSession(updatedAt, receivedAt, { resetPolicy: "idle", idleResetMinutes: 240 });
    expect(result).toBe(true);
  });

  it("returns false when idle time is within threshold", () => {
    const updatedAt = "2024-01-01T00:00:00Z";
    const receivedAt = new Date("2024-01-01T01:00:00Z");
    const result = shouldAutoResetSession(updatedAt, receivedAt, { resetPolicy: "idle", idleResetMinutes: 240 });
    expect(result).toBe(false);
  });
});
