import { describe, expect, it } from "vitest";
import { SessionMessageQueue } from "./session-message-queue.js";
import type { ChannelMessage } from "../contracts/channel.js";

function makeMessage(id: string, overrides: Partial<ChannelMessage> = {}): ChannelMessage {
  return {
    id,
    channel: "telegram",
    sessionKey: { platform: "telegram", chatId: "123", userId: "u1" },
    text: "hello",
    sender: { id: "u1" },
    receivedAt: `2026-08-06T12:00:0${id.slice(-1)}.000Z`,
    ...overrides,
  };
}

const coalescing = {
  enabled: true,
  windowMs: 1_500,
  maxMessages: 5,
  maxChars: 8_000,
};

describe("SessionMessageQueue", () => {
  it("enqueue accepts message and reports position", () => {
    const q = new SessionMessageQueue();
    const result = q.enqueue("key1", makeMessage("m1"), "queue", 3);
    expect(result.accepted).toBe(true);
    expect(result.position).toBe(1);
  });

  it("enqueue rejects when queue is full", () => {
    const q = new SessionMessageQueue();
    q.enqueue("key1", makeMessage("m1"), "queue", 2);
    q.enqueue("key1", makeMessage("m2"), "queue", 2);
    const result = q.enqueue("key1", makeMessage("m3"), "queue", 2);
    expect(result.accepted).toBe(false);
    expect(result.rejectedBecauseFull).toBe(true);
  });

  it("dequeue returns FIFO order", () => {
    const q = new SessionMessageQueue();
    q.enqueue("key1", makeMessage("m1"), "queue", 3);
    q.enqueue("key1", makeMessage("m2"), "queue", 3);
    const first = q.dequeue("key1");
    expect(first?.message.id).toBe("m1");
    const second = q.dequeue("key1");
    expect(second?.message.id).toBe("m2");
  });

  it("dequeue returns undefined for empty queue", () => {
    const q = new SessionMessageQueue();
    expect(q.dequeue("key1")).toBeUndefined();
  });

  it("peek returns next item without removing", () => {
    const q = new SessionMessageQueue();
    q.enqueue("key1", makeMessage("m1"), "queue", 3);
    expect(q.peek("key1")?.message.id).toBe("m1");
    expect(q.peek("key1")?.message.id).toBe("m1");
    expect(q.size("key1")).toBe(1);
  });

  it("size returns count per key", () => {
    const q = new SessionMessageQueue();
    q.enqueue("key1", makeMessage("m1"), "queue", 3);
    q.enqueue("key1", makeMessage("m2"), "queue", 3);
    q.enqueue("key2", makeMessage("m3"), "queue", 3);
    expect(q.size("key1")).toBe(2);
    expect(q.size("key2")).toBe(1);
    expect(q.size("key3")).toBe(0);
  });

  it("totalSize counts across all keys", () => {
    const q = new SessionMessageQueue();
    q.enqueue("key1", makeMessage("m1"), "queue", 3);
    q.enqueue("key1", makeMessage("m2"), "queue", 3);
    q.enqueue("key2", makeMessage("m3"), "queue", 3);
    expect(q.totalSize()).toBe(3);
    q.dequeue("key1");
    expect(q.totalSize()).toBe(2);
    q.dequeue("key1");
    q.dequeue("key2");
    expect(q.totalSize()).toBe(0);
  });

  it("clear removes all messages for a key", () => {
    const q = new SessionMessageQueue();
    q.enqueue("key1", makeMessage("m1"), "queue", 3);
    q.enqueue("key1", makeMessage("m2"), "queue", 3);
    q.clear("key1");
    expect(q.size("key1")).toBe(0);
    expect(q.totalSize()).toBe(0);
  });

  it("unshift inserts at front of queue", () => {
    const q = new SessionMessageQueue();
    q.enqueue("key1", makeMessage("m1"), "queue", 3);
    q.enqueue("key1", makeMessage("m2"), "queue", 3);
    q.unshift("key1", makeMessage("m0"), "interrupt", 3);
    const first = q.dequeue("key1");
    expect(first?.message.id).toBe("m0");
    expect(first?.policyAtArrival).toBe("interrupt");
  });

  it("stores channelKind from message", () => {
    const q = new SessionMessageQueue();
    const msg = makeMessage("m1");
    q.enqueue("key1", msg, "queue", 3);
    const item = q.peek("key1");
    expect(item?.channelKind).toBe("telegram");
  });

  it("stores enqueuedAt timestamp", () => {
    const q = new SessionMessageQueue();
    const before = Date.now();
    q.enqueue("key1", makeMessage("m1"), "queue", 3);
    const after = Date.now();
    const item = q.peek("key1");
    expect(item?.enqueuedAt).toBeGreaterThanOrEqual(before);
    expect(item?.enqueuedAt).toBeLessThanOrEqual(after);
  });

  it("coalesces eligible adjacent text into the FIFO tail with bounded provenance", () => {
    const q = new SessionMessageQueue();
    q.enqueueOrCoalesceText("key1", makeMessage("m1", {
      text: "first",
      metadata: { telegram: { messageId: 101 } }
    }), "queue", 3, coalescing, true, 1_000);
    const result = q.enqueueOrCoalesceText(
      "key1",
      makeMessage("m2", { text: "second", metadata: { telegram: { messageId: 102 } } }),
      "queue",
      3,
      coalescing,
      true,
      2_000
    );

    expect(result).toEqual({ accepted: true, position: 1, coalesced: true });
    expect(q.size("key1")).toBe(1);
    expect(q.peek("key1")?.message).toMatchObject({
      id: "m1",
      receivedAt: "2026-08-06T12:00:01.000Z",
      text: "first\n\nsecond",
      metadata: {
        telegram: expect.objectContaining({ attributionMessageIds: [101, 102] }),
        busyTextCoalescedMessageIds: ["m1", "m2"],
        busyTextCoalescedReceivedAts: [
          "2026-08-06T12:00:01.000Z",
          "2026-08-06T12:00:02.000Z",
        ],
        busyTextCoalescingSize: 2,
        busyTextCoalescingWindowMs: 1_500,
      },
    });
  });

  it("keeps the existing FIFO position when coalescing the tail", () => {
    const q = new SessionMessageQueue();
    q.enqueue("key1", makeMessage("m0", { text: "earlier" }), "queue", 3);
    q.enqueueOrCoalesceText("key1", makeMessage("m1", { text: "first" }), "queue", 3, coalescing, true, 1_000);
    const result = q.enqueueOrCoalesceText("key1", makeMessage("m2", { text: "second" }), "queue", 3, coalescing, true, 1_100);

    expect(result.position).toBe(2);
    expect(q.dequeue("key1")?.message.text).toBe("earlier");
    expect(q.dequeue("key1")?.message.text).toBe("first\n\nsecond");
  });

  it("does not coalesce text from a different sender or canonical session key", () => {
    const q = new SessionMessageQueue();
    q.enqueueOrCoalesceText("key1", makeMessage("m1"), "queue", 4, coalescing, true, 1_000);
    q.enqueueOrCoalesceText(
      "key1",
      makeMessage("m2", { sender: { id: "u2" } }),
      "queue",
      4,
      coalescing,
      true,
      1_100
    );
    q.enqueueOrCoalesceText("key2", makeMessage("m3"), "queue", 4, coalescing, true, 1_200);

    expect(q.size("key1")).toBe(2);
    expect(q.size("key2")).toBe(1);
  });

  it.each([
    {
      name: "window",
      policy: coalescing,
      firstText: "hello",
      secondText: "again",
      firstAt: 1_000,
      secondAt: 2_501,
    },
    {
      name: "message limit",
      policy: { ...coalescing, maxMessages: 1 },
      firstText: "hello",
      secondText: "again",
      firstAt: 1_000,
      secondAt: 1_100,
    },
    {
      name: "character limit",
      policy: { ...coalescing, maxChars: 11 },
      firstText: "hello",
      secondText: "again",
      firstAt: 1_000,
      secondAt: 1_100,
    },
  ])("enqueues a new FIFO entry when the $name is reached", ({ policy, firstText, secondText, firstAt, secondAt }) => {
    const q = new SessionMessageQueue();
    q.enqueueOrCoalesceText("key1", makeMessage("m1", { text: firstText }), "queue", 3, policy, true, firstAt);
    const result = q.enqueueOrCoalesceText(
      "key1",
      makeMessage("m2", { text: secondText }),
      "queue",
      3,
      policy,
      true,
      secondAt
    );

    expect(result).toEqual({ accepted: true, position: 2, coalesced: false });
    expect(q.size("key1")).toBe(2);
  });

  it("keeps ineligible commands and attachments as separate entries", () => {
    const q = new SessionMessageQueue();
    q.enqueueOrCoalesceText("key1", makeMessage("m1"), "queue", 4, coalescing, true, 1_000);
    q.enqueueOrCoalesceText("key1", makeMessage("m2", { text: "/status" }), "queue", 4, coalescing, false, 1_100);
    q.enqueueOrCoalesceText(
      "key1",
      makeMessage("m3", { attachments: [{ id: "attachment-1", kind: "file", name: "note.txt" }] }),
      "queue",
      4,
      coalescing,
      false,
      1_200
    );

    expect(q.size("key1")).toBe(3);
  });

  it("uses the unchanged enqueue behavior when coalescing is disabled", () => {
    const q = new SessionMessageQueue();
    const disabled = { ...coalescing, enabled: false };
    const first = q.enqueueOrCoalesceText("key1", makeMessage("m1"), "queue", 2, disabled, true, 1_000);
    const second = q.enqueueOrCoalesceText("key1", makeMessage("m2"), "queue", 2, disabled, true, 1_100);
    const full = q.enqueueOrCoalesceText("key1", makeMessage("m3"), "queue", 2, disabled, true, 1_200);

    expect(first).toEqual({ accepted: true, position: 1 });
    expect(second).toEqual({ accepted: true, position: 2 });
    expect(full).toEqual({ accepted: false, rejectedBecauseFull: true });
    expect(q.size("key1")).toBe(2);
  });

  it("never coalesces non-queue policy entries", () => {
    const q = new SessionMessageQueue();
    q.enqueueOrCoalesceText("key1", makeMessage("m1"), "interrupt", 3, coalescing, true, 1_000);
    q.enqueueOrCoalesceText("key1", makeMessage("m2"), "interrupt", 3, coalescing, true, 1_100);

    expect(q.size("key1")).toBe(2);
    expect(q.dequeue("key1")?.message.id).toBe("m1");
    expect(q.dequeue("key1")?.message.id).toBe("m2");
  });

  it("retains queue-full behavior when a bounded tail cannot accept more text", () => {
    const q = new SessionMessageQueue();
    const oneMessage = { ...coalescing, maxMessages: 1 };
    q.enqueueOrCoalesceText("key1", makeMessage("m1"), "queue", 1, oneMessage, true, 1_000);
    const result = q.enqueueOrCoalesceText("key1", makeMessage("m2"), "queue", 1, oneMessage, true, 1_100);

    expect(result).toEqual({ accepted: false, rejectedBecauseFull: true });
    expect(q.size("key1")).toBe(1);
  });
});
