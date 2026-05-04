import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { WhatsAppAdapter } from "./whatsapp-adapter.js";
import type { ChannelMessage } from "../contracts/channel.js";
import type { WASocket, BaileysEventMap } from "@whiskeysockets/baileys";

describe("WhatsAppAdapter", () => {
  let tmpDir: string;
  let mediaRoot: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "estacoda-wa-test-"));
    mediaRoot = join(tmpDir, "media");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function createMockSocket(): { socket: any; events: EventEmitter } {
    const events = new EventEmitter();
    const socket = {
      ev: events,
      sendMessage: async (_jid: string, _content: any) => {},
      end: (_err?: Error) => {},
    };
    return { socket, events };
  }

  function createAdapter(opts: Partial<ConstructorParameters<typeof WhatsAppAdapter>[0]> = {}) {
    const mock = createMockSocket();
    return {
      adapter: new WhatsAppAdapter({
        authDir: join(tmpDir, "auth"),
        mediaRoot,
        ...opts,
        socketFactory: async () => mock.socket as WASocket,
      }),
      events: mock.events,
      socket: mock.socket,
    };
  }

  it("starts and stops cleanly", async () => {
    const { adapter, events } = createAdapter();
    expect(adapter.running).toBe(false);
    await adapter.start(async () => {});
    expect(adapter.running).toBe(true);
    await adapter.stop();
    expect(adapter.running).toBe(false);
  });

  it("transitions to open on connection.update", async () => {
    const { adapter, events } = createAdapter();
    await adapter.start(async () => {});
    events.emit("connection.update", { connection: "open" });
    expect(adapter.connectionStatus).toBe("open");
    await adapter.stop();
  });

  it("stores qr code on connection.update", async () => {
    const { adapter, events } = createAdapter();
    await adapter.start(async () => {});
    events.emit("connection.update", { qr: "mock-qr-code" });
    expect(adapter.qrCode).toBe("mock-qr-code");
    expect(adapter.connectionStatus).toBe("qr");
    await adapter.stop();
  });

  it("receives a text message from allowed user", async () => {
    const { adapter, events } = createAdapter({ allowedUsers: ["971501234567"] });
    const received: ChannelMessage[] = [];
    await adapter.start(async (msg) => {
      received.push(msg);
    });

    events.emit("messages.upsert", {
      messages: [
        {
          key: { id: "msg-1", remoteJid: "971501234567@s.whatsapp.net", fromMe: false },
          message: { conversation: "Hello from WhatsApp" },
          messageTimestamp: 1234567890,
          pushName: "Test User",
        },
      ],
      type: "notify",
    });

    // Allow async handler to run
    await new Promise((r) => setTimeout(r, 50));
    await adapter.stop();

    expect(received.length).toBe(1);
    expect(received[0]!.channel).toBe("whatsapp");
    expect(received[0]!.text).toBe("Hello from WhatsApp");
    expect(received[0]!.sessionKey.platform).toBe("whatsapp");
    expect(received[0]!.sessionKey.userId).toBe("971501234567");
    expect(received[0]!.sender.displayName).toBe("Test User");
  });

  it("ignores messages from non-allowed users", async () => {
    const { adapter, events } = createAdapter({ allowedUsers: ["971501234567"] });
    const received: ChannelMessage[] = [];
    await adapter.start(async (msg) => {
      received.push(msg);
    });

    events.emit("messages.upsert", {
      messages: [
        {
          key: { id: "msg-2", remoteJid: "971509999999@s.whatsapp.net", fromMe: false },
          message: { conversation: "Unauthorized" },
          messageTimestamp: 1234567890,
          pushName: "Stranger",
        },
      ],
      type: "notify",
    });

    await new Promise((r) => setTimeout(r, 50));
    await adapter.stop();

    expect(received.length).toBe(0);
  });

  it("ignores group messages in MVP", async () => {
    const { adapter, events } = createAdapter({ allowedUsers: ["971501234567"] });
    const received: ChannelMessage[] = [];
    await adapter.start(async (msg) => {
      received.push(msg);
    });

    events.emit("messages.upsert", {
      messages: [
        {
          key: { id: "msg-3", remoteJid: "1234567890@g.us", fromMe: false },
          message: { conversation: "Group msg" },
          messageTimestamp: 1234567890,
          pushName: "Group User",
        },
      ],
      type: "notify",
    });

    await new Promise((r) => setTimeout(r, 50));
    await adapter.stop();

    expect(received.length).toBe(0);
  });

  it("ignores messages from self", async () => {
    const { adapter, events } = createAdapter();
    const received: ChannelMessage[] = [];
    await adapter.start(async (msg) => {
      received.push(msg);
    });

    events.emit("messages.upsert", {
      messages: [
        {
          key: { id: "msg-4", remoteJid: "971501234567@s.whatsapp.net", fromMe: true },
          message: { conversation: "Self msg" },
          messageTimestamp: 1234567890,
        },
      ],
      type: "notify",
    });

    await new Promise((r) => setTimeout(r, 50));
    await adapter.stop();

    expect(received.length).toBe(0);
  });

  it("ignores non-notify message upserts", async () => {
    const { adapter, events } = createAdapter();
    const received: ChannelMessage[] = [];
    await adapter.start(async (msg) => {
      received.push(msg);
    });

    events.emit("messages.upsert", {
      messages: [
        {
          key: { id: "msg-5", remoteJid: "971501234567@s.whatsapp.net", fromMe: false },
          message: { conversation: "Append msg" },
          messageTimestamp: 1234567890,
        },
      ],
      type: "append",
    });

    await new Promise((r) => setTimeout(r, 50));
    await adapter.stop();

    expect(received.length).toBe(0);
  });

  it("deduplicates messages by key id", async () => {
    const { adapter, events } = createAdapter();
    const received: ChannelMessage[] = [];
    await adapter.start(async (msg) => {
      received.push(msg);
    });

    const msg = {
      key: { id: "msg-6", remoteJid: "971501234567@s.whatsapp.net", fromMe: false },
      message: { conversation: "Dup" },
      messageTimestamp: 1234567890,
    };

    events.emit("messages.upsert", { messages: [msg], type: "notify" });
    events.emit("messages.upsert", { messages: [msg], type: "notify" });

    await new Promise((r) => setTimeout(r, 50));
    await adapter.stop();

    expect(received.length).toBe(1);
  });

  it("delivery.sendText chunks long messages", async () => {
    const { adapter, events, socket } = createAdapter();
    const sentMessages: { jid: string; content: any }[] = [];
    socket.sendMessage = async (jid: string, content: any) => {
      sentMessages.push({ jid, content });
    };

    await adapter.start(async () => {});
    events.emit("connection.update", { connection: "open" });

    const longText = "A".repeat(5000);
    await adapter.delivery!.sendText(
      { platform: "whatsapp", chatId: "971501234567@s.whatsapp.net", userId: "971501234567", chatType: "dm" },
      longText
    );

    await adapter.stop();

    expect(sentMessages.length).toBe(2);
    expect(sentMessages[0]!.content.text.length).toBeLessThanOrEqual(4096);
    expect(sentMessages[1]!.content.text.length).toBeLessThanOrEqual(4096);
  });

  it("delivery.sendText throws when not connected", async () => {
    const { adapter } = createAdapter();
    await adapter.start(async () => {});
    // Do not emit connection open
    await expect(
      adapter.delivery!.sendText(
        { platform: "whatsapp", chatId: "971501234567@s.whatsapp.net", userId: "971501234567", chatType: "dm" },
        "Hello"
      )
    ).rejects.toThrow("WhatsApp not connected");
    await adapter.stop();
  });

  it("delivery.sendProgress sends typing indicator text", async () => {
    const { adapter, events, socket } = createAdapter();
    const sentMessages: { jid: string; content: any }[] = [];
    socket.sendMessage = async (jid: string, content: any) => {
      sentMessages.push({ jid, content });
    };

    await adapter.start(async () => {});
    events.emit("connection.update", { connection: "open" });

    await adapter.delivery!.sendProgress(
      { platform: "whatsapp", chatId: "971501234567@s.whatsapp.net", userId: "971501234567", chatType: "dm" },
      { kind: "tool-start", tool: "web_search" }
    );

    await adapter.stop();

    expect(sentMessages.length).toBe(1);
    expect(sentMessages[0]!.content.text).toContain("🌐");
  });

  it("delivery.sendArtifact sends document when path exists", async () => {
    const { adapter, events, socket } = createAdapter();
    const sentMessages: { jid: string; content: any }[] = [];
    socket.sendMessage = async (jid: string, content: any) => {
      sentMessages.push({ jid, content });
    };

    await adapter.start(async () => {});
    events.emit("connection.update", { connection: "open" });

    await adapter.delivery!.sendArtifact(
      { platform: "whatsapp", chatId: "971501234567@s.whatsapp.net", userId: "971501234567", chatType: "dm" },
      { id: "art-1", path: "/tmp/report.pdf", mimeType: "application/pdf", kind: "document", bytes: 1024, createdAt: new Date().toISOString() }
    );

    await adapter.stop();

    expect(sentMessages.length).toBe(1);
    expect(sentMessages[0]!.content.document).toBeDefined();
    expect(sentMessages[0]!.content.fileName).toBe("report.pdf");
  });

  it("converts markdown to WhatsApp formatting in delivery", async () => {
    const { adapter, events, socket } = createAdapter();
    const sentMessages: { jid: string; content: any }[] = [];
    socket.sendMessage = async (jid: string, content: any) => {
      sentMessages.push({ jid, content });
    };

    await adapter.start(async () => {});
    events.emit("connection.update", { connection: "open" });

    await adapter.delivery!.sendText(
      { platform: "whatsapp", chatId: "971501234567@s.whatsapp.net", userId: "971501234567", chatType: "dm" },
      "**bold** __italic__ ~~strike~~"
    );

    await adapter.stop();

    expect(sentMessages[0]!.content.text).toBe("*bold* _italic_ ~strike~");
  });

  it("extracts text from extendedTextMessage", async () => {
    const { adapter, events } = createAdapter();
    const received: ChannelMessage[] = [];
    await adapter.start(async (msg) => {
      received.push(msg);
    });

    events.emit("messages.upsert", {
      messages: [
        {
          key: { id: "msg-7", remoteJid: "971501234567@s.whatsapp.net", fromMe: false },
          message: { extendedTextMessage: { text: "Extended text" } },
          messageTimestamp: 1234567890,
        },
      ],
      type: "notify",
    });

    await new Promise((r) => setTimeout(r, 50));
    await adapter.stop();

    expect(received.length).toBe(1);
    expect(received[0]!.text).toBe("Extended text");
  });

  it("extracts caption from image message", async () => {
    const { adapter, events } = createAdapter();
    const received: ChannelMessage[] = [];
    await adapter.start(async (msg) => {
      received.push(msg);
    });

    events.emit("messages.upsert", {
      messages: [
        {
          key: { id: "msg-8", remoteJid: "971501234567@s.whatsapp.net", fromMe: false },
          message: {
            imageMessage: { caption: "Photo caption", mimetype: "image/jpeg" },
          },
          messageTimestamp: 1234567890,
        },
      ],
      type: "notify",
    });

    await new Promise((r) => setTimeout(r, 50));
    await adapter.stop();

    expect(received.length).toBe(1);
    expect(received[0]!.text).toBe("Photo caption");
  });

  it("records lastError on loggedOut disconnect", async () => {
    const { adapter, events } = createAdapter();
    await adapter.start(async () => {});
    events.emit("connection.update", {
      connection: "close",
      lastDisconnect: { error: { output: { statusCode: 401 } } },
    });
    expect(adapter.connectionStatus).toBe("close");
    expect(adapter.lastError).toBe("Logged out");
    await adapter.stop();
  });

  it("attempts reconnect on non-loggedOut disconnect", async () => {
    const { adapter, events } = createAdapter();
    await adapter.start(async () => {});
    events.emit("connection.update", {
      connection: "close",
      lastDisconnect: { error: { output: { statusCode: 408 } } },
    });
    expect(adapter.connectionStatus).toBe("connecting");
    await adapter.stop();
  });
});
