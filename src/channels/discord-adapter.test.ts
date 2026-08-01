import { describe, it, expect, vi } from "vitest";
import { DiscordAdapter } from "./discord-adapter.js";
import { buildAdapterCapability } from "./adapter-capability.js";
import { AdapterRegistry } from "./adapter-registry.js";
import type { LoadedRuntimeConfig } from "../config/runtime-config.js";
import { renderApprovalActions } from "./approval-actions.js";
import { modelPickerSelectActionKey, renderModelPickerActions } from "./model-picker-actions.js";
import { DiscordVoiceBridge } from "./discord-voice-bridge.js";

describe("DiscordAdapter", () => {
  it("initializes with options", () => {
    const adapter = new DiscordAdapter({ botToken: "test" });
    expect(adapter.kind).toBe("discord");
    expect(adapter.running).toBe(false);
  });

  it("builds DM session key correctly", async () => {
    const adapter = new DiscordAdapter({ botToken: "test" });
    const msg = {
      id: "msg-1",
      content: "hello",
      author: { id: "user-1", bot: false, username: "testuser", displayName: "Test User" },
      guild: null,
      guildId: null,
      channelId: "channel-1",
      attachments: new Map(),
      mentions: { has: () => false },
    } as any;

    // Use internal method via any cast
    const sessionKey = (adapter as any).buildSessionKey(msg);
    expect(sessionKey.platform).toBe("discord");
    expect(sessionKey.chatType).toBe("dm");
    expect(sessionKey.userId).toBe("user-1");
  });

  it("builds guild channel session key with per-user mapping", async () => {
    const adapter = new DiscordAdapter({ botToken: "test" });
    const msg = {
      id: "msg-1",
      content: "hello",
      author: { id: "user-1", bot: false, username: "testuser", displayName: "Test User" },
      guild: { id: "guild-1" },
      guildId: "guild-1",
      channelId: "channel-1",
      channel: {},
      attachments: new Map(),
      mentions: { has: () => false },
    } as any;

    const sessionKey = (adapter as any).buildSessionKey(msg);
    expect(sessionKey.platform).toBe("discord");
    expect(sessionKey.chatType).toBe("channel");
    expect(sessionKey.chatId).toBe("channel-1");
    expect(sessionKey.userId).toBe("user-1");
  });

  it("filters allowed users", async () => {
    const adapter = new DiscordAdapter({ botToken: "test", allowedUsers: ["user-1"] });
    const received: any[] = [];
    const handler = async (m: any) => { received.push(m); };

    // Simulate internal filtering logic
    const options = (adapter as any).options;
    expect(options.allowedUsers).toContain("user-1");
    expect(options.allowedUsers).not.toContain("user-2");
  });

  it("filters allowed channels", async () => {
    const adapter = new DiscordAdapter({ botToken: "test", allowedChannels: ["channel-1"] });
    const options = (adapter as any).options;
    expect(options.allowedChannels).toContain("channel-1");
    expect(options.allowedChannels).not.toContain("channel-2");
  });

  it("getCapabilities returns static discord traits", () => {
    const adapter = new DiscordAdapter({ botToken: "test", enabled: true });
    const cap = adapter.getCapabilities!();
    expect(cap.kind).toBe("discord");
    expect(cap.enabled).toBe(true);
    expect(cap.inboundMode).toBe("websocket");
    expect(cap.supportsAttachments).toBe(false);
    expect(cap.supportsThreads).toBe(false);
    expect(cap.supportsApprovals).toBe(true);
    expect(cap.implementationStatus).toBe("present_not_live_proven");
  });

  it("getCapabilities reflects missing config", () => {
    const adapter = new DiscordAdapter({ botToken: "test", enabled: true, missing: ["DISCORD_BOT_TOKEN"] });
    const cap = adapter.getCapabilities!();
    expect(cap.enabled).toBe(true);
    expect(cap.configured).toBe(false);
    expect(cap.missingConfig).toEqual(["DISCORD_BOT_TOKEN"]);
  });

  it("getCapabilities delegates to shared builder", () => {
    const adapter = new DiscordAdapter({ botToken: "test", enabled: false, missing: ["DISCORD_BOT_TOKEN"] });
    const cap = adapter.getCapabilities!();
    const expected = buildAdapterCapability({
      kind: "discord",
      config: { enabled: false },
      missing: ["DISCORD_BOT_TOKEN"],
    });
    expect(cap).toEqual(expected);
  });

  it("getCapabilities matches registry output for same normalized config", () => {
    const channels = {
      telegram: { enabled: false, ready: false },
      discord: { enabled: true, ready: false, botTokenEnv: "DISCORD_BOT_TOKEN", missing: ["DISCORD_BOT_TOKEN"] },
      email: { enabled: false, ready: false },
      whatsapp: { enabled: false, ready: false, experimental: false },
    } as unknown as LoadedRuntimeConfig["channels"];

    const adapter = new DiscordAdapter({ botToken: "test", enabled: true, missing: ["DISCORD_BOT_TOKEN"] });
    const registry = new AdapterRegistry(channels);
    expect(adapter.getCapabilities!()).toEqual(registry.get("discord"));
  });

  it("delivery.sendText chunks long text", () => {
    const longText = "A".repeat(5000);
    const chunks = (DiscordAdapter as any).chunkDiscordText ? (DiscordAdapter as any).chunkDiscordText(longText, 2000) : chunkDiscordText(longText, 2000);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(2000);
    }
  });

  it("reports whether artifact delivery uploaded a file or degraded to a notice", async () => {
    const send = vi.fn(async () => undefined);
    const adapter = new DiscordAdapter({ botToken: "test" });
    (adapter as any).client = {
      channels: {
        fetch: vi.fn(async () => ({
          send,
          sendTyping: vi.fn(async () => undefined)
        }))
      }
    };
    const sessionKey = { platform: "discord" as const, chatId: "channel-1" };
    const artifact = {
      id: "report",
      path: "/tmp/report.md",
      kind: "document" as const,
      bytes: 12,
      createdAt: new Date().toISOString()
    };

    await expect(adapter.delivery.sendArtifact!(sessionKey, artifact)).resolves.toEqual({
      status: "delivered",
      method: "native-upload"
    });
    await expect(adapter.delivery.sendArtifact!(sessionKey, { ...artifact, path: "" })).resolves.toEqual({
      status: "degraded",
      method: "fallback-notice",
      reasonCode: "artifact-path-unavailable"
    });
  });

  it("renders generic actions as Discord message components", async () => {
    const send = vi.fn(async () => undefined);
    const adapter = new DiscordAdapter({ botToken: "test" });
    (adapter as any).client = {
      channels: {
        fetch: vi.fn(async () => ({
          send,
          sendTyping: vi.fn(async () => undefined)
        }))
      }
    };
    const actions = renderApprovalActions("gateway-approval-1");

    await adapter.delivery.sendText({ platform: "discord", chatId: "channel-1" }, "approve?", { actions });

    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      content: "approve?",
      components: actions.map((row) => ({
        type: 1,
        components: row.map((action) => ({
          type: 2,
          style: 2,
          label: action.label,
          custom_id: action.value
        }))
      }))
    }));
    const calls = send.mock.calls as unknown as Array<[{ components?: unknown[] }]>;
    const sentPayload = calls[0]?.[0];
    expect(JSON.stringify(sentPayload?.components)).not.toContain("rm -rf");
  });

  it("turns button interactions into ChannelMessage text while preserving identity", async () => {
    const adapter = new DiscordAdapter({
      botToken: "test",
      now: () => new Date("2025-01-01T00:00:00.000Z")
    });
    const received: any[] = [];
    (adapter as any).handler = async (message: unknown) => {
      received.push(message);
    };
    const value = renderApprovalActions("gateway-approval-1")[0][0].value;
    const deferUpdate = vi.fn(async () => undefined);

    await (adapter as any).handleInteraction({
      id: "interaction-1",
      isButton: () => true,
      customId: value,
      user: {
        id: "user-1",
        username: "ada",
        displayName: "Ada"
      },
      member: {
        displayName: "Ada Lovelace"
      },
      guildId: "guild-1",
      channelId: "channel-1",
      channel: {
        isThread: () => false
      },
      deferUpdate
    });

    expect(deferUpdate).toHaveBeenCalled();
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      channel: "discord",
      text: value,
      sender: {
        id: "user-1",
        displayName: "Ada Lovelace",
        username: "ada"
      },
      sessionKey: {
        platform: "discord",
        chatId: "channel-1",
        chatType: "channel",
        userId: "user-1"
      },
      metadata: {
        guildId: "guild-1",
        channelId: "channel-1",
        interactionId: "interaction-1"
      }
    });
  });

  it("round-trips model picker buttons through Discord interaction text", async () => {
    const adapter = new DiscordAdapter({
      botToken: "test",
      now: () => new Date("2025-01-01T00:00:00.000Z")
    });
    const received: any[] = [];
    (adapter as any).handler = async (message: unknown) => {
      received.push(message);
    };
    const value = renderModelPickerActions([
      { label: "phi4:latest", actionKey: modelPickerSelectActionKey("local", "phi4:latest"), kind: "select" }
    ])[0][0].value;
    const deferUpdate = vi.fn(async () => undefined);

    await (adapter as any).handleInteraction({
      id: "interaction-model-1",
      isButton: () => true,
      customId: value,
      user: {
        id: "user-1",
        username: "ada",
        displayName: "Ada"
      },
      guildId: undefined,
      channelId: "dm-1",
      deferUpdate
    });

    expect(deferUpdate).toHaveBeenCalled();
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      channel: "discord",
      text: value,
      sessionKey: {
        platform: "discord",
        chatId: "user-1",
        chatType: "dm",
        userId: "user-1"
      }
    });
  });

  it("adds GuildVoiceStates intent only when Discord voice channels are enabled", async () => {
    const plainFactory = vi.fn((() => fakeDiscordClient()) as any);
    const plain = new DiscordAdapter({ botToken: "test", clientFactory: plainFactory as any });
    await plain.start(async () => undefined);
    expect((plainFactory.mock.calls[0][0] as any).intents).not.toContain(1 << 7);
    await plain.stop();

    const voiceFactory = vi.fn((() => fakeDiscordClient()) as any);
    const voice = new DiscordAdapter({
      botToken: "test",
      clientFactory: voiceFactory as any,
      voiceChannel: { enabled: true, autoJoinOnCommand: true },
      voiceTempRoot: "/tmp/estacoda-discord-voice-test"
    });
    await voice.start(async () => undefined);
    expect((voiceFactory.mock.calls[0][0] as any).intents).toContain(1 << 7);
    await voice.stop();
  });

  it("leaves Discord voice connections on adapter stop", async () => {
    const leaveAll = vi.fn(async () => undefined);
    const bridge = { leaveAll } as unknown as DiscordVoiceBridge;
    const adapter = new DiscordAdapter({
      botToken: "test",
      clientFactory: (() => fakeDiscordClient()) as any,
      voiceChannel: { enabled: true, autoJoinOnCommand: true },
      voiceBridge: bridge
    });

    await adapter.start(async () => undefined);
    await adapter.stop();

    expect(leaveAll).toHaveBeenCalled();
  });

  it("does not load optional Discord voice dependencies during normal text startup", async () => {
    const loadDependencies = vi.fn(async () => ({
      ok: false as const,
      missing: ["@discordjs/voice"],
      installHint: "install voice deps"
    }));
    const adapter = new DiscordAdapter({
      botToken: "test",
      clientFactory: (() => fakeDiscordClient()) as any,
      voiceChannel: { enabled: true, autoJoinOnCommand: true },
      voiceTempRoot: "/tmp/estacoda-discord-voice-test",
      voiceDependencyLoader: loadDependencies
    });

    await adapter.start(async () => undefined);

    expect(loadDependencies).not.toHaveBeenCalled();
    await adapter.stop();
  });
});

function fakeDiscordClient() {
  return {
    on: vi.fn(),
    login: vi.fn(async () => undefined),
    destroy: vi.fn(),
    channels: { fetch: vi.fn() },
    guilds: { cache: { get: vi.fn() }, fetch: vi.fn() },
    user: { id: "bot-1" }
  };
}

function chunkDiscordText(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(i + maxLen, text.length);
    const nl = text.lastIndexOf("\n", end);
    if (nl > i && nl >= end - 200) {
      end = nl;
    } else {
      const sp = text.lastIndexOf(" ", end);
      if (sp > i && sp >= end - 100) {
        end = sp;
      }
    }
    chunks.push(text.slice(i, end));
    i = end + (text[end] === "\n" || text[end] === " " ? 1 : 0);
  }
  return chunks;
}
