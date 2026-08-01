import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { WhatsAppAdapter } from "./whatsapp-adapter.js";
import { buildAdapterCapability } from "./adapter-capability.js";
import { AdapterRegistry } from "./adapter-registry.js";
import type { ChannelMessage } from "../contracts/channel.js";
import type { LoadedRuntimeConfig } from "../config/runtime-config.js";
import type {
  WhatsAppBridgeClient,
  WhatsAppBridgeHealth,
  WhatsAppBridgeInboundMessage,
  WhatsAppBridgeEditInput,
  WhatsAppBridgeSendMediaInput,
  WhatsAppBridgeSendTextInput,
  WhatsAppBridgeTypingInput,
} from "./whatsapp-bridge-client.js";

class FakeWhatsAppBridgeClient implements WhatsAppBridgeClient {
  health: WhatsAppBridgeHealth = { ok: true, apiVersion: "whatsapp-bridge.v1", status: "connected" };
  messages: WhatsAppBridgeInboundMessage[] = [];
  sentText: WhatsAppBridgeSendTextInput[] = [];
  edited: WhatsAppBridgeEditInput[] = [];
  sentMedia: WhatsAppBridgeSendMediaInput[] = [];
  typing: WhatsAppBridgeTypingInput[] = [];
  started = false;
  stopped = false;
  sendTextOk = true;
  sendMediaOk = true;
  editOk = true;
  hangText = false;

  async start(): Promise<void> {
    this.started = true;
  }

  async stop(): Promise<void> {
    this.stopped = true;
  }

  async getHealth(): Promise<WhatsAppBridgeHealth> {
    return this.health;
  }

  async pollMessages(): Promise<WhatsAppBridgeInboundMessage[]> {
    return this.messages.splice(0, this.messages.length);
  }

  async sendText(input: WhatsAppBridgeSendTextInput) {
    this.sentText.push(input);
    if (this.hangText) {
      return new Promise<never>(() => {});
    }
    return this.sendTextOk
      ? { ok: true, messageId: "text-1", messageIds: ["text-1"] }
      : { ok: false, error: { code: "send_failed", message: "Text send failed" } };
  }

  async sendMedia(input: WhatsAppBridgeSendMediaInput) {
    this.sentMedia.push(input);
    return this.sendMediaOk
      ? { ok: true, messageId: "media-1", messageIds: ["media-1"] }
      : { ok: false, error: { code: "media_failed", message: "Media send failed" } };
  }

  async editMessage(input: WhatsAppBridgeEditInput) {
    this.edited.push(input);
    return this.editOk
      ? { ok: true, messageId: input.messageId, messageIds: [input.messageId] }
      : { ok: false, error: { code: "edit_failed", message: "Edit failed" } };
  }

  async sendTyping(input: WhatsAppBridgeTypingInput) {
    this.typing.push(input);
    return { ok: true };
  }

  async getChat(chatId: string) {
    return { id: chatId };
  }
}

describe("WhatsAppAdapter", () => {
  let tmpDir: string;
  let bridge: FakeWhatsAppBridgeClient;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "estacoda-wa-test-"));
    await mkdir(join(tmpDir, "media"), { recursive: true });
    bridge = new FakeWhatsAppBridgeClient();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function createAdapter(opts: Partial<ConstructorParameters<typeof WhatsAppAdapter>[0]> = {}) {
    return new WhatsAppAdapter({
      authDir: join(tmpDir, "auth"),
      mediaRoot: join(tmpDir, "media"),
      experimental: true,
      bridgeClient: bridge,
      ...opts,
    });
  }

  it("throws if experimental flag is not set", async () => {
    const adapter = createAdapter({ experimental: false });
    await expect(adapter.start(async () => {})).rejects.toThrow(
      "WhatsApp live adapter is experimental. Set experimental: true in config to enable."
    );
  });

  it("getCapabilities returns static whatsapp bridge traits", () => {
    const adapter = createAdapter();
    const cap = adapter.getCapabilities!();
    expect(cap.kind).toBe("whatsapp");
    expect(cap.enabled).toBe(true);
    expect(cap.experimental).toBe(true);
    expect(cap.inboundMode).toBe("polling");
    expect(cap.supportsAttachments).toBe(false);
    expect(cap.supportsProgressStreaming).toBe(false);
    expect(cap.implementationStatus).toBe("present_not_live_proven");
  });

  it("getCapabilities reflects missing config", () => {
    const adapter = createAdapter({ missing: ["bridgeDependencies"] });
    const cap = adapter.getCapabilities!();
    expect(cap.enabled).toBe(true);
    expect(cap.configured).toBe(false);
    expect(cap.missingConfig).toEqual(["bridgeDependencies"]);
  });

  it("getCapabilities delegates to shared builder", () => {
    const authDir = join(tmpDir, "auth");
    const adapter = createAdapter({ authDir, missing: ["bridgeDependencies"] });
    const cap = adapter.getCapabilities!();
    const expected = buildAdapterCapability({
      kind: "whatsapp",
      config: { enabled: true, authDir, experimental: true },
      missing: ["bridgeDependencies"],
    });
    expect(cap).toEqual(expected);
  });

  it("getCapabilities matches registry output for same normalized config", () => {
    const authDir = join(tmpDir, "auth");
    const channels = {
      telegram: { enabled: false, ready: false },
      discord: { enabled: false, ready: false },
      email: { enabled: false, ready: false },
      whatsapp: { enabled: true, ready: false, experimental: true, authDir, missing: ["bridgeDependencies"] },
    } as unknown as LoadedRuntimeConfig["channels"];

    const adapter = createAdapter({ authDir, missing: ["bridgeDependencies"] });
    const registry = new AdapterRegistry(channels);
    expect(adapter.getCapabilities!()).toEqual(registry.get("whatsapp"));
  });

  it("starts and stops the bridge client", async () => {
    const adapter = createAdapter();
    await adapter.start(async () => {});
    expect(adapter.running).toBe(true);
    expect(adapter.connectionStatus).toBe("open");
    expect(bridge.started).toBe(true);

    await adapter.stop();
    expect(adapter.running).toBe(false);
    expect(adapter.connectionStatus).toBe("close");
    expect(bridge.stopped).toBe(true);
  });

  it("keeps connecting status when bridge is not connected yet", async () => {
    bridge.health = { ok: true, apiVersion: "whatsapp-bridge.v1", status: "connecting" };
    const adapter = createAdapter();
    await adapter.start(async () => {});
    expect(adapter.connectionStatus).toBe("connecting");
  });

  it("polls bridge messages and converts them to channel messages", async () => {
    const adapter = createAdapter();
    bridge.messages.push({
      messageId: "msg-1",
      chatId: "971501234567@s.whatsapp.net",
      senderId: "971501234567@s.whatsapp.net",
      senderName: "Test User",
      body: "Hello from bridge",
      timestamp: 1234567890,
    });
    const received: ChannelMessage[] = [];
    await adapter.start(async (msg) => {
      received.push(msg);
    });

    const processed = await adapter.pollOnce();

    expect(processed).toBe(1);
    expect(received).toHaveLength(1);
    expect(received[0]!.channel).toBe("whatsapp");
    expect(received[0]!.text).toBe("Hello from bridge");
    expect(received[0]!.sessionKey.platform).toBe("whatsapp");
    expect(received[0]!.sessionKey.chatId).toBe("971501234567");
    expect(received[0]!.sessionKey.userId).toBe("971501234567");
    expect(received[0]!.sender.displayName).toBe("Test User");
  });

  it("batches messages from the same poll, chat, and sender into one handler call", async () => {
    const adapter = createAdapter();
    bridge.messages.push(
      { messageId: "batch-1", chatId: "971501234567@s.whatsapp.net", senderId: "971501234567@s.whatsapp.net", body: "first" },
      { messageId: "batch-2", chatId: "971501234567@s.whatsapp.net", senderId: "971501234567@s.whatsapp.net", body: "second" }
    );
    const received: ChannelMessage[] = [];
    await adapter.start(async (msg) => {
      received.push(msg);
    });

    const processed = await adapter.pollOnce();

    expect(processed).toBe(2);
    expect(received).toHaveLength(1);
    expect(received[0]!.text).toBe("first\n\nsecond");
    expect(received[0]!.metadata).toMatchObject({
      batchedMessageIds: ["batch-1", "batch-2"],
      batchSize: 2,
    });
  });

  it("does not batch separate chats or senders together", async () => {
    const adapter = createAdapter();
    bridge.messages.push(
      { messageId: "sep-1", chatId: "971501234567@s.whatsapp.net", senderId: "971501234567@s.whatsapp.net", body: "one" },
      { messageId: "sep-2", chatId: "971509999999@s.whatsapp.net", senderId: "971509999999@s.whatsapp.net", body: "two" },
      { messageId: "sep-3", chatId: "120363025555555555@g.us", senderId: "971508888888@s.whatsapp.net", body: "three", isGroup: true }
    );
    const received: ChannelMessage[] = [];
    await adapter.start(async (msg) => {
      received.push(msg);
    });

    await adapter.pollOnce();

    expect(received.map((msg) => msg.text)).toEqual(["one", "two", "three"]);
  });

  it("persists aliases and uses canonical IDs for allowlist/session matching", async () => {
    const adapter = createAdapter({ aliasStorePath: join(tmpDir, "gateway", "whatsapp-identity-aliases.json") });
    bridge.messages.push({
      messageId: "msg-lid",
      chatId: "971501234567@s.whatsapp.net",
      senderId: "ABC123@lid",
      senderName: "Linked User",
      body: "Hello from linked identity",
    });
    const received: ChannelMessage[] = [];
    await adapter.start(async (msg) => {
      received.push(msg);
    });

    await adapter.pollOnce();

    expect(received[0]!.sender.id).toBe("971501234567");
    expect(received[0]!.sessionKey.userId).toBe("971501234567");
    expect(received[0]!.sessionKey.chatId).toBe("971501234567");
  });

  it("normalizes group JIDs for session keys", async () => {
    const adapter = createAdapter();
    bridge.messages.push({
      messageId: "msg-group",
      chatId: "120363025555555555@g.us",
      senderId: "971501234567@s.whatsapp.net",
      body: "group hello",
      isGroup: true,
    });
    const received: ChannelMessage[] = [];
    await adapter.start(async (msg) => {
      received.push(msg);
    });

    await adapter.pollOnce();

    expect(received[0]!.sessionKey.chatType).toBe("group");
    expect(received[0]!.sessionKey.chatId).toBe("120363025555555555@g.us");
    expect(received[0]!.sessionKey.userId).toBe("971501234567");
  });

  it("drops invalid WhatsApp identities before creating session keys", async () => {
    const adapter = createAdapter();
    bridge.messages.push(
      {
        messageId: "invalid-dm",
        chatId: "not a whatsapp chat",
        senderId: "not a whatsapp sender",
        body: "bad dm",
      },
      {
        messageId: "invalid-group",
        chatId: "not-a-group",
        senderId: "971501234567@s.whatsapp.net",
        body: "bad group",
        isGroup: true,
      }
    );
    const received: ChannelMessage[] = [];
    await adapter.start(async (msg) => {
      received.push(msg);
    });

    const processed = await adapter.pollOnce();

    expect(processed).toBe(0);
    expect(received).toEqual([]);
  });

  it("does not silently drop users before gateway authorization", async () => {
    const adapter = createAdapter({ allowedUsers: ["971501234567"] });
    bridge.messages.push({
      messageId: "msg-2",
      chatId: "971509999999@s.whatsapp.net",
      senderId: "971509999999@s.whatsapp.net",
      senderName: "Stranger",
      body: "Unauthorized should reach gateway",
    });
    const received: ChannelMessage[] = [];
    await adapter.start(async (msg) => {
      received.push(msg);
    });

    await adapter.pollOnce();

    expect(received).toHaveLength(1);
    expect(received[0]!.sender.id).toBe("971509999999");
  });

  it("deduplicates bridge messages by message id", async () => {
    const adapter = createAdapter();
    bridge.messages.push(
      { messageId: "msg-3", chatId: "971501234567@s.whatsapp.net", senderId: "971501234567@s.whatsapp.net", body: "one" },
      { messageId: "msg-3", chatId: "971501234567@s.whatsapp.net", senderId: "971501234567@s.whatsapp.net", body: "one again" }
    );
    const received: ChannelMessage[] = [];
    await adapter.start(async (msg) => {
      received.push(msg);
    });

    const processed = await adapter.pollOnce();

    expect(processed).toBe(1);
    expect(received).toHaveLength(1);
  });

  it("ignores fromMe messages in bot mode", async () => {
    const adapter = createAdapter({ mode: "bot" });
    bridge.messages.push({
      messageId: "self-1",
      chatId: "971501234567@s.whatsapp.net",
      senderId: "971501234567@s.whatsapp.net",
      body: "manual self message",
      fromMe: true,
    });
    const received: ChannelMessage[] = [];
    await adapter.start(async (msg) => {
      received.push(msg);
    });

    const processed = await adapter.pollOnce();

    expect(processed).toBe(0);
    expect(received).toEqual([]);
  });

  it("accepts intentional fromMe input in self-chat mode", async () => {
    const adapter = createAdapter({ mode: "self-chat" });
    bridge.messages.push({
      messageId: "self-2",
      chatId: "971501234567@s.whatsapp.net",
      senderId: "971501234567@s.whatsapp.net",
      body: "intentional prompt",
      fromMe: true,
    });
    const received: ChannelMessage[] = [];
    await adapter.start(async (msg) => {
      received.push(msg);
    });

    const processed = await adapter.pollOnce();

    expect(processed).toBe(1);
    expect(received[0]!.text).toBe("intentional prompt");
  });

  it("applies self-chat reply prefix only in self-chat mode and ignores prefix echoes", async () => {
    const selfChat = createAdapter({ mode: "self-chat", replyPrefix: "Bot: " });
    await selfChat.start(async () => {});

    await selfChat.delivery!.sendText(
      { platform: "whatsapp", chatId: "971501234567", userId: "971501234567", chatType: "dm" },
      "Hello"
    );

    expect(bridge.sentText[0]!.message).toBe("Bot: Hello");

    bridge.messages.push({
      messageId: "prefix-echo",
      chatId: "971501234567@s.whatsapp.net",
      senderId: "971501234567@s.whatsapp.net",
      body: "Bot: Hello",
      fromMe: true,
    });
    const received: ChannelMessage[] = [];
    await selfChat.stop();
    await selfChat.start(async (msg) => {
      received.push(msg);
    });

    expect(await selfChat.pollOnce()).toBe(0);
    expect(received).toEqual([]);

    const botBridge = new FakeWhatsAppBridgeClient();
    const bot = createAdapter({ mode: "bot", bridgeClient: botBridge });
    await bot.start(async () => {});
    await bot.delivery!.sendText(
      { platform: "whatsapp", chatId: "971501234567", userId: "971501234567", chatType: "dm" },
      "Hello"
    );
    expect(botBridge.sentText[0]!.message).toBe("Hello");
  });

  it("tracks recent sent ids for self-chat echo prevention with FIFO eviction", async () => {
    const adapter = createAdapter({ mode: "self-chat", replyPrefix: "" });
    await adapter.start(async () => {});
    for (let i = 0; i < 51; i += 1) {
      bridge.sendText = async (input) => {
        bridge.sentText.push(input);
        return { ok: true, messageId: `sent-${i}`, messageIds: [`sent-${i}`] };
      };
      await adapter.delivery!.sendText(
        { platform: "whatsapp", chatId: "971501234567", userId: "971501234567", chatType: "dm" },
        `message ${i}`
      );
    }
    const received: ChannelMessage[] = [];
    await adapter.stop();
    await adapter.start(async (msg) => {
      received.push(msg);
    });
    bridge.messages.push(
      {
        messageId: "sent-0",
        chatId: "971501234567@s.whatsapp.net",
        senderId: "971501234567@s.whatsapp.net",
        body: "evicted manual input",
        fromMe: true,
      },
      {
        messageId: "sent-50",
        chatId: "971501234567@s.whatsapp.net",
        senderId: "971501234567@s.whatsapp.net",
        body: "recent echo",
        fromMe: true,
      }
    );

    const processed = await adapter.pollOnce();

    expect(processed).toBe(1);
    expect(received.map((message) => message.id)).toEqual(["sent-0"]);
  });

  it("preserves bridge attachments", async () => {
    const adapter = createAdapter();
    const inboundRoot = join(tmpDir, "media", "whatsapp", "inbound");
    const photoPath = join(inboundRoot, "photo.jpg");
    await mkdir(inboundRoot, { recursive: true });
    await writeFile(photoPath, "photo");
    const canonicalPhotoPath = await realpath(photoPath);
    bridge.messages.push({
      messageId: "msg-4",
      chatId: "971501234567@s.whatsapp.net",
      senderId: "971501234567@s.whatsapp.net",
      body: "",
      attachments: [
        {
          id: "att-1",
          kind: "image",
          status: "ready",
          mimeType: "image/jpeg",
          originalName: "photo.jpg",
          localPath: photoPath,
          bytes: 123,
        },
      ],
    });
    const received: ChannelMessage[] = [];
    await adapter.start(async (msg) => {
      received.push(msg);
    });

    await adapter.pollOnce();

    expect(received[0]!.attachments).toEqual([
      expect.objectContaining({
        id: "att-1",
        kind: "image",
        status: "ready",
        mimeType: "image/jpeg",
        localPath: canonicalPhotoPath,
        bytes: 123,
      }),
    ]);
  });

  it("delivers inbound voice attachments with validated profile-local paths", async () => {
    const adapter = createAdapter();
    const inboundRoot = join(tmpDir, "media", "whatsapp", "inbound");
    const voicePath = join(inboundRoot, "voice.ogg");
    await mkdir(inboundRoot, { recursive: true });
    await writeFile(voicePath, "voice");
    const canonicalVoicePath = await realpath(voicePath);
    bridge.messages.push({
      messageId: "voice-1",
      chatId: "971501234567@s.whatsapp.net",
      senderId: "971501234567@s.whatsapp.net",
      body: "",
      attachments: [
        {
          id: "voice-att",
          kind: "voice",
          status: "ready",
          mimeType: "audio/ogg",
          localPath: voicePath,
          bytes: 5,
        },
      ],
    });
    const received: ChannelMessage[] = [];
    await adapter.start(async (msg) => {
      received.push(msg);
    });

    await adapter.pollOnce();

    expect(received[0]!.attachments).toEqual([
      expect.objectContaining({
        id: "voice-att",
        kind: "voice",
        status: "ready",
        localPath: canonicalVoicePath,
      }),
    ]);
  });

  it("drops ready inbound attachment paths outside the WhatsApp inbound media root", async () => {
    const adapter = createAdapter();
    const outsidePath = join(tmpDir, "outside", "photo.jpg");
    await mkdir(dirname(outsidePath), { recursive: true });
    await writeFile(outsidePath, "photo");
    bridge.messages.push({
      messageId: "msg-outside",
      chatId: "971501234567@s.whatsapp.net",
      senderId: "971501234567@s.whatsapp.net",
      body: "caption",
      attachments: [
        {
          id: "outside",
          kind: "image",
          status: "ready",
          localPath: outsidePath,
          bytes: 5,
        },
      ],
    });
    const received: ChannelMessage[] = [];
    await adapter.start(async (msg) => {
      received.push(msg);
    });

    await adapter.pollOnce();

    expect(received[0]!.text).toBe("caption");
    expect(received[0]!.attachments).toBeUndefined();
  });

  it("does not let a symlinked inbound media root authorize outside files", async () => {
    const mediaRoot = join(tmpDir, "media");
    const linkRoot = join(mediaRoot, "whatsapp", "inbound");
    const outsideRoot = join(tmpDir, "outside-media");
    const outsidePath = join(outsideRoot, "photo.jpg");
    await mkdir(dirname(linkRoot), { recursive: true });
    await mkdir(outsideRoot, { recursive: true });
    await writeFile(outsidePath, "photo");
    await symlink(outsideRoot, linkRoot, "dir");
    const adapter = createAdapter({ inboundMediaRoot: linkRoot });
    bridge.messages.push({
      messageId: "msg-symlink",
      chatId: "971501234567@s.whatsapp.net",
      senderId: "971501234567@s.whatsapp.net",
      body: "caption",
      attachments: [
        {
          id: "symlinked",
          kind: "image",
          status: "ready",
          localPath: outsidePath,
          bytes: 5,
        },
      ],
    });
    const received: ChannelMessage[] = [];
    await adapter.start(async (msg) => {
      received.push(msg);
    });

    await adapter.pollOnce();

    expect(received[0]!.text).toBe("caption");
    expect(received[0]!.attachments).toBeUndefined();
  });

  it("drops traversal and missing ready inbound attachment files without crashing", async () => {
    const adapter = createAdapter();
    const inboundRoot = join(tmpDir, "media", "whatsapp", "inbound");
    const outsidePath = join(tmpDir, "media", "whatsapp", "outside.jpg");
    await mkdir(inboundRoot, { recursive: true });
    await writeFile(outsidePath, "outside");
    bridge.messages.push({
      messageId: "msg-traversal",
      chatId: "971501234567@s.whatsapp.net",
      senderId: "971501234567@s.whatsapp.net",
      body: "caption",
      attachments: [
        {
          id: "traversal",
          kind: "image",
          status: "ready",
          localPath: join(inboundRoot, "..", "outside.jpg"),
          bytes: 7,
        },
        {
          id: "missing",
          kind: "image",
          status: "ready",
          localPath: join(inboundRoot, "missing.jpg"),
          bytes: 5,
        },
      ],
    });
    const received: ChannelMessage[] = [];
    await adapter.start(async (msg) => {
      received.push(msg);
    });

    await adapter.pollOnce();

    expect(received[0]!.text).toBe("caption");
    expect(received[0]!.attachments).toBeUndefined();
  });

  it("preserves failed inbound attachment metadata without local paths", async () => {
    const adapter = createAdapter();
    bridge.messages.push({
      messageId: "msg-failed",
      chatId: "971501234567@s.whatsapp.net",
      senderId: "971501234567@s.whatsapp.net",
      body: "",
      attachments: [
        {
          id: "failed-doc",
          kind: "document",
          status: "failed",
          failureCode: "download_failed",
          failureMessage: "WhatsApp media could not be downloaded.",
          localPath: join(tmpDir, "media", "whatsapp", "inbound", "ignored.pdf"),
          metadata: { whatsappMediaType: "documentMessage" },
        },
      ],
    });
    const received: ChannelMessage[] = [];
    await adapter.start(async (msg) => {
      received.push(msg);
    });

    await adapter.pollOnce();

    expect(received[0]!.attachments).toEqual([
      expect.objectContaining({
        id: "failed-doc",
        kind: "document",
        status: "failed",
        failureCode: "download_failed",
        metadata: { whatsappMediaType: "documentMessage" },
      }),
    ]);
  });

  it("keeps bounded text previews for text-like inbound documents and skips binary document injection", async () => {
    const adapter = createAdapter();
    const inboundRoot = join(tmpDir, "media", "whatsapp", "inbound");
    await mkdir(inboundRoot, { recursive: true });
    const textDocPath = join(inboundRoot, "notes.txt");
    const binaryDocPath = join(inboundRoot, "archive.bin");
    await writeFile(textDocPath, "notes");
    await writeFile(binaryDocPath, "binary");
    bridge.messages.push({
      messageId: "doc-1",
      chatId: "971501234567@s.whatsapp.net",
      senderId: "971501234567@s.whatsapp.net",
      body: "",
      attachments: [
        {
          id: "text-doc",
          kind: "document",
          status: "ready",
          mimeType: "text/plain",
          originalName: "notes.txt",
          localPath: textDocPath,
          metadata: { textPreview: "a".repeat(5000) },
        },
        {
          id: "binary-doc",
          kind: "document",
          status: "ready",
          mimeType: "application/octet-stream",
          originalName: "archive.bin",
          localPath: binaryDocPath,
          metadata: { textPreview: "do not inject" },
        },
        {
          id: "large-doc",
          kind: "document",
          status: "too-large",
          failureCode: "attachment-too-large",
          failureMessage: "Document is too large.",
        },
      ],
    });
    const received: ChannelMessage[] = [];
    await adapter.start(async (msg) => {
      received.push(msg);
    });

    await adapter.pollOnce();

    expect(received[0]!.attachments![0]!.metadata).toMatchObject({
      textPreview: "a".repeat(4000),
      textPreviewTruncated: true,
    });
    expect(received[0]!.attachments![1]!.metadata).toEqual({ textPreview: "do not inject" });
    expect(received[0]!.attachments![2]).toMatchObject({
      status: "too-large",
      failureCode: "attachment-too-large",
    });
  });

  it("delivery.sendText delegates to bridge client", async () => {
    const adapter = createAdapter();
    await adapter.start(async () => {});

    await adapter.delivery!.sendText(
      { platform: "whatsapp", chatId: "971501234567@s.whatsapp.net", userId: "971501234567", chatType: "dm" },
      "Hello"
    );

    expect(bridge.sentText).toEqual([
      { chatId: "971501234567@s.whatsapp.net", message: "Hello" },
    ]);
  });

  it("formats Markdown for WhatsApp while preserving code spans and fenced code", async () => {
    const adapter = createAdapter();
    await adapter.start(async () => {});

    await adapter.delivery!.sendText(
      { platform: "whatsapp", chatId: "971501234567@s.whatsapp.net", userId: "971501234567", chatType: "dm" },
      [
        "# Header",
        "**bold** __strong__ ~~gone~~ [site](https://example.com)",
        "`**code**`",
        "```",
        "**fenced**",
        "```",
      ].join("\n")
    );

    expect(bridge.sentText[0]!.message).toBe([
      "*Header*",
      "*bold* *strong* ~gone~ site (https://example.com)",
      "`**code**`",
      "```",
      "**fenced**",
      "```",
    ].join("\n"));
  });

  it("chunks long WhatsApp text on boundaries and waits between chunks", async () => {
    vi.useFakeTimers();
    try {
      const adapter = createAdapter({ maxTextLength: 12, chunkDelayMs: 300 });
      await adapter.start(async () => {});

      const sent = adapter.delivery!.sendText(
        { platform: "whatsapp", chatId: "971501234567@s.whatsapp.net", userId: "971501234567", chatType: "dm" },
        "one two three four"
      );
      await Promise.resolve();

      expect(bridge.sentText).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(299);
      expect(bridge.sentText).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      await sent;

      expect(bridge.sentText.map((entry) => entry.message)).toEqual(["one two", "three four"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails stalled text chunks through the general send timeout", async () => {
    vi.useFakeTimers();
    try {
      const adapter = createAdapter({ sendTimeoutMs: 50 });
      bridge.hangText = true;
      await adapter.start(async () => {});

      const sent = adapter.delivery!.sendText(
        { platform: "whatsapp", chatId: "971501234567@s.whatsapp.net", userId: "971501234567", chatType: "dm" },
        "Hello"
      );
      const rejected = expect(sent).rejects.toThrow("WhatsApp bridge text send timed out");
      await vi.advanceTimersByTimeAsync(50);

      await rejected;
    } finally {
      vi.useRealTimers();
    }
  });

  it("quotes the first final-answer chunk when replyTo is supplied", async () => {
    const adapter = createAdapter({ maxTextLength: 8, chunkDelayMs: 0 });
    await adapter.start(async () => {});

    await adapter.delivery!.sendText(
      { platform: "whatsapp", chatId: "971501234567@s.whatsapp.net", userId: "971501234567", chatType: "dm" },
      "first second",
      { replyTo: "incoming-1" }
    );

    expect(bridge.sentText).toEqual([
      expect.objectContaining({ message: "first", replyTo: "incoming-1" }),
      expect.objectContaining({ message: "second", replyTo: undefined }),
    ]);
  });

  it("edits when a message id is available and falls back to send when edit fails", async () => {
    const adapter = createAdapter();
    await adapter.start(async () => {});

    await adapter.delivery!.sendText(
      { platform: "whatsapp", chatId: "971501234567@s.whatsapp.net", userId: "971501234567", chatType: "dm" },
      "Edited",
      { editMessageId: "sent-1" }
    );
    expect(bridge.edited).toEqual([
      { chatId: "971501234567@s.whatsapp.net", messageId: "sent-1", message: "Edited" },
    ]);
    expect(bridge.sentText).toHaveLength(0);

    bridge.editOk = false;
    await adapter.delivery!.sendText(
      { platform: "whatsapp", chatId: "971501234567@s.whatsapp.net", userId: "971501234567", chatType: "dm" },
      "Fallback",
      { editMessageId: "sent-2" }
    );

    expect(bridge.sentText.at(-1)).toMatchObject({ message: "Fallback" });
  });

  it("delivery.sendText throws when bridge send fails", async () => {
    const adapter = createAdapter();
    bridge.sendTextOk = false;
    await adapter.start(async () => {});

    await expect(
      adapter.delivery!.sendText(
        { platform: "whatsapp", chatId: "971501234567@s.whatsapp.net", userId: "971501234567", chatType: "dm" },
        "Hello"
      )
    ).rejects.toThrow("Text send failed");
  });

  it("delivery.sendProgress is final-only and sends ephemeral typing only", async () => {
    const adapter = createAdapter();
    await adapter.start(async () => {});

    await adapter.delivery!.sendProgress!(
      { platform: "whatsapp", chatId: "971501234567@s.whatsapp.net", userId: "971501234567", chatType: "dm" },
      { kind: "tool-start", tool: "web_search" }
    );

    expect(bridge.sentText).toHaveLength(0);
    expect(bridge.sentMedia).toHaveLength(0);
    expect(bridge.typing).toEqual([
      { chatId: "971501234567@s.whatsapp.net", state: "composing" },
    ]);
  });

  it("delivery.sendArtifact delegates path artifacts to bridge media send", async () => {
    const adapter = createAdapter();
    await adapter.start(async () => {});
    const reportPath = join(tmpDir, "media", "report.pdf");
    await writeFile(reportPath, "pdf");

    const outcome = await adapter.delivery!.sendArtifact!(
      { platform: "whatsapp", chatId: "971501234567@s.whatsapp.net", userId: "971501234567", chatType: "dm" },
      { id: "art-1", path: reportPath, mimeType: "application/pdf", kind: "document", bytes: 1024, createdAt: new Date().toISOString() }
    );

    expect(bridge.sentMedia).toEqual([
      expect.objectContaining({
        chatId: "971501234567@s.whatsapp.net",
        filePath: await realpath(reportPath),
        mediaType: "document",
        fileName: "report.pdf",
      }),
    ]);
    expect(outcome).toEqual({ status: "delivered", method: "native-upload" });
  });

  it("sends image, video, audio, voice, and document artifacts with correct bridge media types", async () => {
    const adapter = createAdapter();
    await adapter.start(async () => {});
    const files = {
      image: join(tmpDir, "media", "image.jpg"),
      video: join(tmpDir, "media", "video.mp4"),
      audio: join(tmpDir, "media", "audio.ogg"),
      document: join(tmpDir, "media", "doc.txt"),
    };
    for (const path of Object.values(files)) await writeFile(path, "x");

    await adapter.delivery!.sendArtifact!({ platform: "whatsapp", chatId: "971501234567", chatType: "dm" }, { id: "image", path: files.image, kind: "image", mimeType: "image/jpeg", bytes: 1, createdAt: new Date().toISOString() });
    await adapter.delivery!.sendArtifact!({ platform: "whatsapp", chatId: "971501234567", chatType: "dm" }, { id: "video", path: files.video, kind: "video", mimeType: "video/mp4", bytes: 1, createdAt: new Date().toISOString() });
    await adapter.delivery!.sendArtifact!({ platform: "whatsapp", chatId: "971501234567", chatType: "dm" }, { id: "audio", path: files.audio, kind: "audio", mimeType: "audio/ogg", bytes: 1, createdAt: new Date().toISOString() });
    await adapter.delivery!.sendArtifact!({ platform: "whatsapp", chatId: "971501234567", chatType: "dm" }, { id: "voice", path: files.audio, kind: "audio", mimeType: "audio/ogg", bytes: 1, createdAt: new Date().toISOString(), metadata: { deliveryHint: "voice" } });
    await adapter.delivery!.sendArtifact!({ platform: "whatsapp", chatId: "971501234567", chatType: "dm" }, { id: "doc", path: files.document, kind: "document", mimeType: "text/plain", bytes: 1, createdAt: new Date().toISOString() });

    expect(bridge.sentMedia.map((entry) => entry.mediaType)).toEqual(["image", "video", "audio", "voice", "document"]);
  });

  it("converts incompatible voice-hinted audio to ogg/opus in the main runtime when ffmpeg is available", async () => {
    const ffmpeg = join(tmpDir, "ffmpeg");
    const logPath = join(tmpDir, "ffmpeg.log");
    await writeFile(ffmpeg, [
      "#!/usr/bin/env bash",
      `echo "$@" >> ${JSON.stringify(logPath)}`,
      "echo ogg > \"${!#}\"",
      "",
    ].join("\n"));
    await chmod(ffmpeg, 0o755);
    const source = join(tmpDir, "media", "voice.mp3");
    await writeFile(source, "mp3");
    const adapter = createAdapter({ ffmpegPath: ffmpeg });
    await adapter.start(async () => {});

    await adapter.delivery!.sendArtifact!(
      { platform: "whatsapp", chatId: "971501234567", chatType: "dm" },
      { id: "voice-art", path: source, kind: "audio", mimeType: "audio/mpeg", bytes: 3, createdAt: new Date().toISOString(), metadata: { deliveryHint: "voice" } }
    );

    expect(bridge.sentMedia[0]).toMatchObject({ mediaType: "voice" });
    expect(bridge.sentMedia[0]!.filePath).toContain(join("whatsapp-voice-temp", "opus-"));
    expect(await readFile(logPath, "utf8")).toContain("-c:a libopus");
  });

  it("allows voice conversion temp roots outside mediaRoot when they are inside an explicit profile temp root", async () => {
    const ffmpeg = join(tmpDir, "ffmpeg");
    const logPath = join(tmpDir, "ffmpeg.log");
    await writeFile(ffmpeg, [
      "#!/usr/bin/env bash",
      `echo "$@" >> ${JSON.stringify(logPath)}`,
      "echo ogg > \"${!#}\"",
      "",
    ].join("\n"));
    await chmod(ffmpeg, 0o755);
    const profileTempRoot = join(tmpDir, "profile-temp");
    await mkdir(profileTempRoot, { recursive: true });
    const source = join(tmpDir, "media", "voice.mp3");
    await writeFile(source, "mp3");
    const adapter = createAdapter({
      ffmpegPath: ffmpeg,
      voiceTempRoot: join(profileTempRoot, "audio", "whatsapp"),
      allowedMediaRoots: [profileTempRoot],
    });
    await adapter.start(async () => {});

    await adapter.delivery!.sendArtifact!(
      { platform: "whatsapp", chatId: "971501234567", chatType: "dm" },
      { id: "voice-art", path: source, kind: "audio", mimeType: "audio/mpeg", bytes: 3, createdAt: new Date().toISOString(), metadata: { deliveryHint: "voice" } }
    );

    expect(bridge.sentMedia[0]).toMatchObject({ mediaType: "voice" });
    expect(bridge.sentMedia[0]!.filePath).toContain(join("profile-temp", "audio", "whatsapp", "opus-"));
    expect(await readFile(logPath, "utf8")).toContain("-c:a libopus");
  });

  it("rejects voice conversion temp roots outside configured profile media and temp roots", async () => {
    const ffmpeg = join(tmpDir, "ffmpeg");
    const logPath = join(tmpDir, "ffmpeg.log");
    await writeFile(ffmpeg, [
      "#!/usr/bin/env bash",
      `echo "$@" >> ${JSON.stringify(logPath)}`,
      "echo ogg > \"${!#}\"",
      "",
    ].join("\n"));
    await chmod(ffmpeg, 0o755);
    const profileTempRoot = join(tmpDir, "profile-temp");
    await mkdir(profileTempRoot, { recursive: true });
    const source = join(tmpDir, "media", "voice.mp3");
    await writeFile(source, "mp3");
    const adapter = createAdapter({
      ffmpegPath: ffmpeg,
      voiceTempRoot: join(tmpDir, "untrusted-temp", "whatsapp"),
      allowedMediaRoots: [profileTempRoot],
    });
    await adapter.start(async () => {});

    await adapter.delivery!.sendArtifact!(
      { platform: "whatsapp", chatId: "971501234567", chatType: "dm" },
      { id: "voice-art", path: source, kind: "audio", mimeType: "audio/mpeg", bytes: 3, createdAt: new Date().toISOString(), metadata: { deliveryHint: "voice" } }
    );

    expect(bridge.sentMedia[0]).toMatchObject({
      filePath: await realpath(source),
      mediaType: "audio",
    });
    await expect(readFile(logPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("falls back clearly to normal audio when ffmpeg is unavailable", async () => {
    const source = join(tmpDir, "media", "voice.mp3");
    await writeFile(source, "mp3");
    const adapter = createAdapter({ ffmpegPath: join(tmpDir, "missing-ffmpeg") });
    await adapter.start(async () => {});

    await adapter.delivery!.sendArtifact!(
      { platform: "whatsapp", chatId: "971501234567", chatType: "dm" },
      { id: "voice-art", path: source, kind: "audio", mimeType: "audio/mpeg", bytes: 3, createdAt: new Date().toISOString(), metadata: { deliveryHint: "voice" } }
    );

    expect(bridge.sentMedia[0]).toMatchObject({
      filePath: await realpath(source),
      mediaType: "audio",
    });
    expect(bridge.sentMedia[0]!.caption).toContain("Voice bubble unavailable; sending as audio.");
  });

  it("rejects outbound media paths outside configured roots before bridge delivery", async () => {
    const outside = join(tmpDir, "outside.txt");
    await writeFile(outside, "outside");
    const adapter = createAdapter();
    await adapter.start(async () => {});

    await expect(adapter.delivery!.sendArtifact!(
      { platform: "whatsapp", chatId: "971501234567", chatType: "dm" },
      { id: "outside", path: outside, kind: "document", mimeType: "text/plain", bytes: 7, createdAt: new Date().toISOString() }
    )).rejects.toThrow("outside configured media roots");
    expect(bridge.sentMedia).toHaveLength(0);
  });

  it("caches explicitly allowed remote media URLs locally before bridge delivery", async () => {
    const adapter = createAdapter({
      allowRemoteMediaUrls: true,
      fetch: vi.fn(async () => ({
        ok: true,
        status: 200,
        statusText: "OK",
        arrayBuffer: async () => new TextEncoder().encode("image").buffer,
      })) as unknown as typeof fetch,
    });
    await adapter.start(async () => {});

    await adapter.delivery!.sendArtifact!(
      { platform: "whatsapp", chatId: "971501234567", chatType: "dm" },
      { id: "remote-image", path: "https://example.com/photo.jpg", kind: "image", mimeType: "image/jpeg", bytes: 5, createdAt: new Date().toISOString() }
    );

    expect(bridge.sentMedia[0]).toMatchObject({ mediaType: "image" });
    expect(bridge.sentMedia[0]!.filePath).toContain(join("whatsapp-remote-cache", "remote-image.jpg"));
  });

  it("delivery.sendArtifact delegates pathless artifacts to bridge text send", async () => {
    const adapter = createAdapter();
    await adapter.start(async () => {});

    const outcome = await adapter.delivery!.sendArtifact!(
      { platform: "whatsapp", chatId: "971501234567@s.whatsapp.net", userId: "971501234567", chatType: "dm" },
      { id: "art-2", path: "", mimeType: "text/plain", kind: "document", bytes: 24, createdAt: new Date().toISOString() }
    );

    expect(bridge.sentText[0]!.message).toContain("art-2");
    expect(outcome).toEqual({
      status: "degraded",
      method: "fallback-notice",
      reasonCode: "artifact-path-unavailable"
    });
  });
});
