import { describe, it, expect, vi } from "vitest";
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TelegramAdapter, updateToChannelMessage } from "./telegram-adapter.js";
import { buildAdapterCapability } from "./adapter-capability.js";
import { AdapterRegistry } from "./adapter-registry.js";
import type { LoadedRuntimeConfig } from "../config/runtime-config.js";
import { renderApprovalActions } from "./approval-actions.js";
import { modelPickerSelectActionKey, renderModelPickerActions } from "./model-picker-actions.js";
import type { ArtifactRecord } from "../contracts/artifact.js";

function createTelegramTextHarness(options: { failOnSendMessage?: number } = {}): {
  adapter: TelegramAdapter;
  bodies: Array<Record<string, unknown>>;
} {
  const bodies: Array<Record<string, unknown>> = [];
  let sendMessageCount = 0;
  const fetch = vi.fn(async (url: string, init?: { body?: string }) => {
    if (url.endsWith("/sendMessage")) {
      sendMessageCount += 1;
      bodies.push(JSON.parse(init?.body ?? "{}") as Record<string, unknown>);

      if (sendMessageCount === options.failOnSendMessage) {
        return {
          ok: false,
          status: 400,
          statusText: "Bad Request",
          json: async () => ({ ok: false, description: "message is too long" })
        };
      }
    }

    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: { message_id: sendMessageCount } })
    };
  });

  return {
    adapter: new TelegramAdapter({ botToken: "test-token", fetch }),
    bodies
  };
}

function sentText(body: Record<string, unknown>): string {
  return String(body.text ?? "");
}

describe("TelegramAdapter", () => {
  it("getCapabilities exists and returns correct kind", () => {
    const adapter = new TelegramAdapter({ botToken: "test-token" });
    expect(typeof adapter.getCapabilities).toBe("function");
    const cap = adapter.getCapabilities!();
    expect(cap.kind).toBe("telegram");
  });

  it("getCapabilities returns live_proven traits", () => {
    const adapter = new TelegramAdapter({ botToken: "test-token", enabled: true });
    const cap = adapter.getCapabilities!();
    expect(cap.enabled).toBe(true);
    expect(cap.configured).toBe(true);
    expect(cap.inboundMode).toBe("polling");
    expect(cap.outboundMode).toBe("push");
    expect(cap.supportsAttachments).toBe(true);
    expect(cap.supportsThreads).toBe(true);
    expect(cap.supportsApprovals).toBe(true);
    expect(cap.supportsProgressStreaming).toBe(true);
    expect(cap.experimental).toBe(false);
    expect(cap.implementationStatus).toBe("live_proven");
  });

  it("getCapabilities reflects missing config", () => {
    const adapter = new TelegramAdapter({
      botToken: "test-token",
      enabled: true,
      missing: ["BOT_TOKEN_ENV"],
    });
    const cap = adapter.getCapabilities!();
    expect(cap.enabled).toBe(true);
    expect(cap.configured).toBe(false);
    expect(cap.missingConfig).toEqual(["BOT_TOKEN_ENV"]);
  });

  it("getCapabilities delegates to shared builder", () => {
    const adapter = new TelegramAdapter({
      botToken: "test-token",
      enabled: false,
      defaultChatId: "123",
      missing: ["BOT_TOKEN_ENV"],
    });
    const cap = adapter.getCapabilities!();
    const expected = buildAdapterCapability({
      kind: "telegram",
      config: {
        enabled: false,
        defaultChatId: "123",
      },
      missing: ["BOT_TOKEN_ENV"],
    });
    expect(cap).toEqual(expected);
  });

  it("getCapabilities matches registry output for same normalized config", () => {
    const channels = {
      telegram: {
        enabled: true,
        ready: false,
        botTokenEnv: "BOT_TOKEN",
        missing: ["BOT_TOKEN_ENV"],
      },
      discord: { enabled: false, ready: false },
      email: { enabled: false, ready: false },
      whatsapp: { enabled: false, ready: false, experimental: false },
    } as unknown as LoadedRuntimeConfig["channels"];

    const adapter = new TelegramAdapter({
      botToken: "test-token",
      enabled: true,
      missing: ["BOT_TOKEN_ENV"],
    });

    const registry = new AdapterRegistry(channels);
    expect(adapter.getCapabilities!()).toEqual(registry.get("telegram"));
  });

  it("renders generic actions as Telegram inline keyboard buttons", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetch = vi.fn(async (_url: string, init?: { body?: string }) => {
      bodies.push(JSON.parse(init?.body ?? "{}") as Record<string, unknown>);
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, result: { message_id: 1 } })
      };
    });
    const adapter = new TelegramAdapter({ botToken: "test-token", fetch });
    const actions = renderApprovalActions("gateway-approval-1");

    await adapter.delivery.sendText({ platform: "telegram", chatId: "123" }, "approve?", { actions });

    expect(bodies[0]?.reply_markup).toEqual({
      inline_keyboard: actions.map((row) =>
        row.map((action) => ({
          text: action.label,
          callback_data: action.value
        }))
      )
    });
    expect(JSON.stringify(bodies[0]?.reply_markup)).not.toContain("rm -rf");
  });

  it("delivery.sendText sends short messages once", async () => {
    const { adapter, bodies } = createTelegramTextHarness();

    await adapter.delivery.sendText({ platform: "telegram", chatId: "123" }, "short reply");

    expect(bodies).toHaveLength(1);
    expect(sentText(bodies[0])).toBe("short reply");
    expect(bodies[0]?.parse_mode).toBe("HTML");
  });

  it("delivery.sendText chunks long plain messages", async () => {
    const { adapter, bodies } = createTelegramTextHarness();

    await adapter.delivery.sendText(
      { platform: "telegram", chatId: "123" },
      "A ".repeat(5_000),
      { format: "plain" }
    );

    expect(bodies.length).toBeGreaterThan(1);
    for (const body of bodies) {
      expect(sentText(body).length).toBeLessThanOrEqual(4096);
    }
    expect(sentText(bodies[0])).toMatch(/ \(1\/\d+\)$/u);
  });

  it("delivery.sendText measures emoji as UTF-16 code units", async () => {
    const { adapter, bodies } = createTelegramTextHarness();

    await adapter.delivery.sendText(
      { platform: "telegram", chatId: "123" },
      "🙂".repeat(3_000),
      { format: "plain" }
    );

    expect(bodies.length).toBeGreaterThan(1);
    for (const body of bodies) {
      expect(sentText(body).length).toBeLessThanOrEqual(4096);
      expect(sentText(body)).not.toContain("\uFFFD");
    }
  });

  it("delivery.sendText chunks after default HTML formatting expands text", async () => {
    const { adapter, bodies } = createTelegramTextHarness();

    await adapter.delivery.sendText({ platform: "telegram", chatId: "123" }, "<>&".repeat(700));

    expect(bodies.length).toBeGreaterThan(1);
    expect(sentText(bodies[0])).toContain("&lt;&gt;&amp;");
    for (const body of bodies) {
      expect(body.parse_mode).toBe("HTML");
      expect(sentText(body).length).toBeLessThanOrEqual(4096);
    }
  });

  it("delivery.sendText avoids obvious broken HTML boundaries when chunking", async () => {
    const { adapter, bodies } = createTelegramTextHarness();

    await adapter.delivery.sendText({ platform: "telegram", chatId: "123" }, [
      "# Heading",
      "<>& ".repeat(1_000),
      "**bold text** ".repeat(800)
    ].join("\n"));

    expect(bodies.length).toBeGreaterThan(1);
    for (const body of bodies) {
      const text = sentText(body);
      expect(text.length).toBeLessThanOrEqual(4096);
      expect(text).not.toMatch(/<\/?[^>]*$/u);
      expect(text).not.toMatch(/&[^;\s]{0,20}$/u);
    }
  });

  it("delivery.sendText chunks long code fences without oversized payloads", async () => {
    const { adapter, bodies } = createTelegramTextHarness();
    const code = [
      "```ts",
      "const ok = value < limit && other > floor;".repeat(600),
      "```"
    ].join("\n");

    await adapter.delivery.sendText({ platform: "telegram", chatId: "123" }, code);

    expect(bodies.length).toBeGreaterThan(1);
    for (const body of bodies) {
      const text = sentText(body);
      expect(text.length).toBeLessThanOrEqual(4096);
      expect(text).not.toMatch(/<\/?[^>]*$/u);
      expect(text).not.toMatch(/&[^;\s]{0,20}$/u);
    }
  });

  it("delivery.sendText attaches inline actions only to the final chunk", async () => {
    const { adapter, bodies } = createTelegramTextHarness();
    const actions = renderApprovalActions("gateway-approval-1");

    await adapter.delivery.sendText(
      { platform: "telegram", chatId: "123" },
      "Approve this ".repeat(1_000),
      { actions }
    );

    expect(bodies.length).toBeGreaterThan(1);
    for (const body of bodies.slice(0, -1)) {
      expect(body.reply_markup).toBeUndefined();
    }
    expect(bodies.at(-1)?.reply_markup).toEqual({
      inline_keyboard: actions.map((row) =>
        row.map((action) => ({
          text: action.label,
          callback_data: action.value
        }))
      )
    });
  });

  it("delivery.sendText rejects on a failed chunk and does not send later chunks", async () => {
    const { adapter, bodies } = createTelegramTextHarness({ failOnSendMessage: 2 });

    await expect(adapter.delivery.sendText(
      { platform: "telegram", chatId: "123" },
      "Failure chunk ".repeat(2_000),
      { format: "plain" }
    )).rejects.toThrow("Telegram sendMessage failed: message is too long");

    expect(bodies).toHaveLength(2);
  });

  it("turns callback query data into ChannelMessage text", () => {
    const value = renderApprovalActions("gateway-approval-1")[0][0].value;
    const message = updateToChannelMessage({
      update_id: 42,
      callback_query: {
        id: "callback-1",
        data: value,
        from: {
          id: "user-1",
          first_name: "Ada",
          username: "ada"
        },
        message: {
          message_id: 7,
          date: 1700000000,
          chat: {
            id: "chat-1",
            type: "private"
          }
        }
      }
    });

    expect(message?.text).toBe(value);
    expect(message?.sender.id).toBe("user-1");
    expect(message?.sessionKey).toMatchObject({
      platform: "telegram",
      chatId: "chat-1",
      userId: "user-1",
      chatType: "dm"
    });
  });

  it("round-trips model picker actions through Telegram callback text", () => {
    const value = renderModelPickerActions([
      { label: "phi4:latest", actionKey: modelPickerSelectActionKey("local", "phi4:latest"), kind: "select" }
    ])[0][0].value;
    const message = updateToChannelMessage({
      update_id: 43,
      callback_query: {
        id: "callback-2",
        data: value,
        from: {
          id: "user-1",
          first_name: "Ada",
          username: "ada"
        },
        message: {
          message_id: 8,
          date: 1700000000,
          chat: {
            id: "chat-1",
            type: "private"
          }
        }
      }
    });

    expect(message?.text).toBe(value);
    expect(message?.sessionKey.platform).toBe("telegram");
  });

  it("delivers voice-hinted OGG audio as a Telegram voice bubble", async () => {
    const calls: string[] = [];
    const fetch = vi.fn(async (url: string) => {
      calls.push(url);
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, result: { message_id: 1 } })
      };
    });
    const tempDir = await mkdtemp(join(tmpdir(), "estacoda-telegram-voice-"));
    try {
      const path = join(tempDir, "reply.ogg");
      await writeFile(path, "audio");
      const adapter = new TelegramAdapter({ botToken: "test-token", fetch });
      const artifact: ArtifactRecord = {
        id: "auto-tts-1",
        path,
        localPath: path,
        kind: "audio",
        bytes: 5,
        createdAt: new Date().toISOString(),
        mimeType: "audio/ogg",
        metadata: { deliveryHint: "voice", ephemeral: true }
      };

      await adapter.delivery.sendArtifact({ platform: "telegram", chatId: "123" }, artifact);

      expect(calls.some((url) => url.endsWith("/sendVoice"))).toBe(true);
      expect(calls.some((url) => url.endsWith("/sendAudio"))).toBe(false);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("preserves Telegram voice delivery for ordinary OGG audio artifacts", async () => {
    const calls: string[] = [];
    const fetch = vi.fn(async (url: string) => {
      calls.push(url);
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, result: { message_id: 1 } })
      };
    });
    const tempDir = await mkdtemp(join(tmpdir(), "estacoda-telegram-durable-voice-"));
    try {
      const path = join(tempDir, "manual.ogg");
      await writeFile(path, "audio");
      const adapter = new TelegramAdapter({ botToken: "test-token", fetch });
      const artifact: ArtifactRecord = {
        id: "voice-manual-1",
        path,
        localPath: path,
        kind: "audio",
        bytes: 5,
        createdAt: new Date().toISOString(),
        mimeType: "audio/ogg"
      };

      await adapter.delivery.sendArtifact({ platform: "telegram", chatId: "123" }, artifact);

      expect(calls.some((url) => url.endsWith("/sendVoice"))).toBe(true);
      expect(calls.some((url) => url.endsWith("/sendAudio"))).toBe(false);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("preserves Telegram voice delivery for ordinary OPUS audio artifacts without delivery hints", async () => {
    const calls: string[] = [];
    const fetch = vi.fn(async (url: string) => {
      calls.push(url);
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, result: { message_id: 1 } })
      };
    });
    const tempDir = await mkdtemp(join(tmpdir(), "estacoda-telegram-durable-opus-"));
    try {
      const path = join(tempDir, "manual.opus");
      await writeFile(path, "audio");
      const adapter = new TelegramAdapter({ botToken: "test-token", fetch });
      const artifact: ArtifactRecord = {
        id: "voice-manual-opus-1",
        path,
        localPath: path,
        kind: "audio",
        bytes: 5,
        createdAt: new Date().toISOString()
      };

      await adapter.delivery.sendArtifact({ platform: "telegram", chatId: "123" }, artifact);

      expect(calls.some((url) => url.endsWith("/sendVoice"))).toBe(true);
      expect(calls.some((url) => url.endsWith("/sendAudio"))).toBe(false);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("converts non-OGG voice-hinted audio to Opus before Telegram voice delivery when ffmpeg is available", async () => {
    const calls: string[] = [];
    const fetch = vi.fn(async (url: string) => {
      calls.push(url);
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, result: { message_id: 1 } })
      };
    });
    const tempDir = await mkdtemp(join(tmpdir(), "estacoda-telegram-convert-"));
    try {
      const path = join(tempDir, "reply.mp3");
      const ffmpeg = join(tempDir, "ffmpeg");
      const logPath = join(tempDir, "ffmpeg.log");
      await writeFile(path, "audio");
      await writeFile(ffmpeg, [
        "#!/usr/bin/env bash",
        `echo "$@" >> ${JSON.stringify(logPath)}`,
        "printf opus > \"${!#}\""
      ].join("\n"), "utf8");
      await chmod(ffmpeg, 0o755);
      const adapter = new TelegramAdapter({
        botToken: "test-token",
        fetch,
        voiceTempRoot: join(tempDir, "voice-temp"),
        ffmpegPath: ffmpeg
      });
      const artifact: ArtifactRecord = {
        id: "auto-tts-mp3",
        path,
        localPath: path,
        kind: "audio",
        bytes: 5,
        createdAt: new Date().toISOString(),
        mimeType: "audio/mpeg",
        metadata: { deliveryHint: "voice", ephemeral: true }
      };

      await adapter.delivery.sendArtifact({ platform: "telegram", chatId: "123" }, artifact);

      expect(calls.some((url) => url.endsWith("/sendVoice"))).toBe(true);
      expect(calls.some((url) => url.endsWith("/sendAudio"))).toBe(false);
      const log = await readFile(logPath, "utf8");
      expect(log).toContain("-c:a libopus -b:a 24k");
      expect(await readdir(join(tempDir, "voice-temp"))).toEqual([]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("falls back to normal audio delivery for non-compatible voice-hinted audio", async () => {
    const calls: string[] = [];
    const fetch = vi.fn(async (url: string) => {
      calls.push(url);
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, result: { message_id: 1 } })
      };
    });
    const tempDir = await mkdtemp(join(tmpdir(), "estacoda-telegram-audio-"));
    try {
      const path = join(tempDir, "reply.mp3");
      await writeFile(path, "audio");
      const adapter = new TelegramAdapter({
        botToken: "test-token",
        fetch,
        voiceTempRoot: join(tempDir, "voice-temp"),
        ffmpegPath: join(tempDir, "missing-ffmpeg")
      });
      const artifact: ArtifactRecord = {
        id: "auto-tts-2",
        path,
        localPath: path,
        kind: "audio",
        bytes: 5,
        createdAt: new Date().toISOString(),
        mimeType: "audio/mpeg",
        metadata: { deliveryHint: "voice", ephemeral: true }
      };

      await adapter.delivery.sendArtifact({ platform: "telegram", chatId: "123" }, artifact);

      expect(calls.some((url) => url.endsWith("/sendAudio"))).toBe(true);
      expect(calls.some((url) => url.endsWith("/sendVoice"))).toBe(false);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
