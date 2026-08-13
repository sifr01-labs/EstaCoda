import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ChannelMessage } from "../contracts/channel.js";
import { TelegramSecureInputReplayStore } from "./telegram-secure-input-replay-store.js";

function message(text = "must never persist"): ChannelMessage {
  return {
    id: "telegram-91-17",
    channel: "telegram",
    sessionKey: {
      platform: "telegram",
      accountId: "telegram",
      chatId: "chat-1",
      chatType: "dm",
      userId: "user-1"
    },
    sender: { id: "user-1" },
    text,
    receivedAt: new Date().toISOString()
  };
}

describe("TelegramSecureInputReplayStore", () => {
  it("blocks captured update replay after restart without persisting message text", async () => {
    const directory = await mkdtemp(join(tmpdir(), "estacoda-telegram-replay-"));
    const path = join(directory, "replays.json");
    const sentinel = "SENTINEL-restart-secret-5519";
    try {
      const first = new TelegramSecureInputReplayStore({ path });
      await first.record(message(sentinel));

      const restarted = new TelegramSecureInputReplayStore({ path });
      await expect(restarted.has(message(sentinel))).resolves.toBe(true);
      expect(await readFile(path, "utf8")).not.toContain(sentinel);
      expect(await readFile(path, "utf8")).not.toContain("chat-1");
      expect(await readFile(path, "utf8")).not.toContain("user-1");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("expires bounded replay metadata", async () => {
    const directory = await mkdtemp(join(tmpdir(), "estacoda-telegram-replay-"));
    const path = join(directory, "replays.json");
    let now = new Date("2026-08-13T00:00:00.000Z");
    try {
      const store = new TelegramSecureInputReplayStore({ path, now: () => now, retentionMs: 1_000 });
      await store.record(message());
      await expect(store.has(message())).resolves.toBe(true);
      now = new Date("2026-08-13T00:00:01.001Z");
      await expect(store.has(message())).resolves.toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
