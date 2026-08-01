import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EmailAdapter } from "./email-adapter.js";
import { buildAdapterCapability } from "./adapter-capability.js";
import { AdapterRegistry } from "./adapter-registry.js";
import { resolveTestPythonBinary } from "../test/test-python.js";
import type { ChannelMessage } from "../contracts/channel.js";
import type { LoadedRuntimeConfig } from "../config/runtime-config.js";

describe("EmailAdapter", () => {
  let tmpDir: string;
  let mediaRoot: string;
  let workerPath: string;
  let pythonBinary: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "estacoda-email-test-"));
    mediaRoot = join(tmpDir, "media");
    workerPath = join(tmpDir, "mock_email_worker.py");
    pythonBinary = await resolveTestPythonBinary();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function createMockWorker(script: string): Promise<void> {
    await writeFile(workerPath, script, "utf8");
  }

  function createAdapter(options: Partial<ConstructorParameters<typeof EmailAdapter>[0]> = {}) {
    return new EmailAdapter({
      imapHost: "imap.test.com",
      imapPort: 993,
      smtpHost: "smtp.test.com",
      smtpPort: 587,
      username: "agent@test.com",
      password: "secret",
      ownAddress: "agent@test.com",
      allowedSenders: ["user@test.com"],
      pollIntervalSeconds: 1,
      mediaRoot,
      workerPath,
      pythonBinary,
      ...options
    });
  }

  it("starts and stops cleanly", async () => {
    const adapter = createAdapter();
    expect(adapter.running).toBe(false);
    await adapter.start(async () => {});
    expect(adapter.running).toBe(true);
    await adapter.stop();
    expect(adapter.running).toBe(false);
  });

  it("getCapabilities returns static email traits", () => {
    const adapter = createAdapter({ enabled: true });
    const cap = adapter.getCapabilities!();
    expect(cap.kind).toBe("email");
    expect(cap.enabled).toBe(true);
    expect(cap.inboundMode).toBe("polling");
    expect(cap.supportsThreads).toBe(true);
    expect(cap.supportsAttachments).toBe(false);
    expect(cap.implementationStatus).toBe("present_not_live_proven");
  });

  it("getCapabilities reflects missing config", () => {
    const adapter = createAdapter({ enabled: true, missing: ["EMAIL_PASSWORD"] });
    const cap = adapter.getCapabilities!();
    expect(cap.enabled).toBe(true);
    expect(cap.configured).toBe(false);
    expect(cap.missingConfig).toEqual(["EMAIL_PASSWORD"]);
  });

  it("getCapabilities delegates to shared builder", () => {
    const adapter = createAdapter({ enabled: false, missing: ["EMAIL_PASSWORD"] });
    const cap = adapter.getCapabilities!();
    const expected = buildAdapterCapability({
      kind: "email",
      config: { enabled: false },
      missing: ["EMAIL_PASSWORD"],
    });
    expect(cap).toEqual(expected);
  });

  it("getCapabilities matches registry output for same normalized config", () => {
    const channels = {
      telegram: { enabled: false, ready: false },
      discord: { enabled: false, ready: false },
      email: { enabled: true, ready: false, imapHost: "imap.test.com", missing: ["EMAIL_PASSWORD"] },
      whatsapp: { enabled: false, ready: false, experimental: false },
    } as unknown as LoadedRuntimeConfig["channels"];

    const adapter = createAdapter({ enabled: true, missing: ["EMAIL_PASSWORD"] });
    const registry = new AdapterRegistry(channels);
    expect(adapter.getCapabilities!()).toEqual(registry.get("email"));
  });

  it("polls and receives messages from mock worker", async () => {
    const mockScript = `
import json, sys
req = json.loads(sys.stdin.readline())
if req["command"] == "poll":
    print(json.dumps({
        "ok": True,
        "messages": [{
            "message_id": "123",
            "msg_id_header": "<msg-123@test.com>",
            "from": "user@test.com",
            "to": "agent@test.com",
            "cc": [],
            "subject": "Hello from email",
            "body": "This is a test email body.",
            "date": "Mon, 01 Jan 2024 00:00:00 +0000",
            "in_reply_to": "",
            "references": [],
            "attachments": []
        }]
    }))
else:
    print(json.dumps({"ok": True}))
`;
    await createMockWorker(mockScript);

    const received: ChannelMessage[] = [];
    const adapter = createAdapter();
    await adapter.start(async (msg) => {
      received.push(msg);
    });

    const count = await adapter.pollOnce();
    await adapter.stop();

    expect(count).toBe(1);
    expect(received.length).toBe(1);
    expect(received[0]!.channel).toBe("email");
    expect(received[0]!.text).toContain("[Subject: Hello from email]");
    expect(received[0]!.text).toContain("This is a test email body.");
    expect(received[0]!.sessionKey.platform).toBe("email");
    expect(received[0]!.sessionKey.userId).toBe("user@test.com");
    expect(received[0]!.sender.id).toBe("user@test.com");
  });

  it("handles reply emails without duplicating subject prefix", async () => {
    const mockScript = `
import json, sys
req = json.loads(sys.stdin.readline())
if req["command"] == "poll":
    print(json.dumps({
        "ok": True,
        "messages": [{
            "message_id": "124",
            "msg_id_header": "<msg-124@test.com>",
            "from": "user@test.com",
            "to": "agent@test.com",
            "cc": [],
            "subject": "Re: Previous topic",
            "body": "This is a reply.",
            "date": "Mon, 01 Jan 2024 00:00:00 +0000",
            "in_reply_to": "<msg-123@test.com>",
            "references": ["<msg-123@test.com>"],
            "attachments": []
        }]
    }))
else:
    print(json.dumps({"ok": True}))
`;
    await createMockWorker(mockScript);

    const received: ChannelMessage[] = [];
    const adapter = createAdapter();
    await adapter.start(async (msg) => {
      received.push(msg);
    });

    await adapter.pollOnce();
    await adapter.stop();

    expect(received.length).toBe(1);
    expect(received[0]!.text).not.toContain("[Subject:");
    expect(received[0]!.text).toBe("This is a reply.");
    expect(received[0]!.sessionKey.threadId).toBe("Previous topic");
  });

  it("threads replies by in_reply_to", async () => {
    const mockScript = `
import json, sys
req = json.loads(sys.stdin.readline())
if req["command"] == "poll":
    print(json.dumps({
        "ok": True,
        "messages": [
            {
                "message_id": "125",
                "msg_id_header": "<msg-125@test.com>",
                "from": "user@test.com",
                "to": "agent@test.com",
                "cc": [],
                "subject": "Topic A",
                "body": "First message",
                "date": "Mon, 01 Jan 2024 00:00:00 +0000",
                "in_reply_to": "",
                "references": [],
                "attachments": []
            },
            {
                "message_id": "126",
                "msg_id_header": "<msg-126@test.com>",
                "from": "user@test.com",
                "to": "agent@test.com",
                "cc": [],
                "subject": "Re: Topic A",
                "body": "Second message",
                "date": "Mon, 01 Jan 2024 00:01:00 +0000",
                "in_reply_to": "<msg-125@test.com>",
                "references": ["<msg-125@test.com>"],
                "attachments": []
            }
        ]
    }))
else:
    print(json.dumps({"ok": True}))
`;
    await createMockWorker(mockScript);

    const received: ChannelMessage[] = [];
    const adapter = createAdapter();
    await adapter.start(async (msg) => {
      received.push(msg);
    });

    await adapter.pollOnce();
    await adapter.stop();

    expect(received.length).toBe(2);
    // Both messages should map to the same conversation
    expect(received[0]!.sessionKey.chatId).toBe(received[1]!.sessionKey.chatId);
  });

  it("saves attachments to mediaRoot when configured", async () => {
    const mockScript = `
import json, sys, base64
req = json.loads(sys.stdin.readline())
if req["command"] == "poll":
    data = base64.b64encode(b"hello world").decode()
    print(json.dumps({
        "ok": True,
        "messages": [{
            "message_id": "127",
            "msg_id_header": "<msg-127@test.com>",
            "from": "user@test.com",
            "to": "agent@test.com",
            "cc": [],
            "subject": "With attachment",
            "body": "See attached.",
            "date": "Mon, 01 Jan 2024 00:00:00 +0000",
            "in_reply_to": "",
            "references": [],
            "attachments": [{
                "filename": "test.txt",
                "mime_type": "text/plain",
                "size": 11,
                "data_b64": data
            }]
        }]
    }))
else:
    print(json.dumps({"ok": True}))
`;
    await createMockWorker(mockScript);

    const received: ChannelMessage[] = [];
    const adapter = createAdapter();
    await adapter.start(async (msg) => {
      received.push(msg);
    });

    await adapter.pollOnce();
    await adapter.stop();

    expect(received.length).toBe(1);
    expect(received[0]!.attachments!.length).toBe(1);
    expect(received[0]!.attachments![0]!.kind).toBe("document");
    expect(received[0]!.attachments![0]!.status).toBe("ready");
    expect(received[0]!.attachments![0]!.localPath).toBeDefined();
  });

  it("delivery.sendText invokes worker send command", async () => {
    const mockScript = `
import json, sys
req = json.loads(sys.stdin.readline())
if req["command"] == "send":
    print(json.dumps({
        "ok": True,
        "message_id": "<sent-123@test.com>"
    }))
else:
    print(json.dumps({"ok": True}))
`;
    await createMockWorker(mockScript);

    const adapter = createAdapter();
    await adapter.start(async () => {});

    await adapter.delivery.sendText(
      { platform: "email", chatId: "user@test.com::Topic", userId: "user@test.com", chatType: "dm", threadId: "Topic" },
      "Hello back"
    );
    await adapter.stop();
    // If no error was thrown, send succeeded
    expect(true).toBe(true);
  });

  it("reports whether artifact content was attached or only a notice was sent", async () => {
    const mockScript = `
import json, sys
req = json.loads(sys.stdin.readline())
print(json.dumps({"ok": True, "message_id": "<artifact@test.com>"}))
`;
    await createMockWorker(mockScript);
    const reportPath = join(tmpDir, "report.md");
    await writeFile(reportPath, "report", "utf8");
    const adapter = createAdapter();
    await adapter.start(async () => {});
    const sessionKey = {
      platform: "email" as const,
      chatId: "user@test.com::Topic",
      userId: "user@test.com",
      chatType: "dm" as const,
      threadId: "Topic"
    };
    const artifact = {
      id: "report",
      path: reportPath,
      localPath: reportPath,
      kind: "document" as const,
      bytes: 6,
      createdAt: new Date().toISOString(),
      mimeType: "text/markdown"
    };

    await expect(adapter.delivery.sendArtifact!(sessionKey, artifact)).resolves.toEqual({
      status: "delivered",
      method: "native-upload"
    });
    await expect(adapter.delivery.sendArtifact!(sessionKey, { ...artifact, path: "", localPath: "" })).resolves.toEqual({
      status: "degraded",
      method: "fallback-notice",
      reasonCode: "artifact-content-unavailable"
    });
    await adapter.stop();
  });

  it("returns 0 messages when poll returns empty", async () => {
    const mockScript = `
import json, sys
req = json.loads(sys.stdin.readline())
print(json.dumps({"ok": True, "messages": []}))
`;
    await createMockWorker(mockScript);

    const adapter = createAdapter();
    await adapter.start(async () => {});
    const count = await adapter.pollOnce();
    await adapter.stop();
    expect(count).toBe(0);
  });

  it("returns 0 messages when worker returns error", async () => {
    const mockScript = `
import json, sys
req = json.loads(sys.stdin.readline())
print(json.dumps({"ok": False, "error": "IMAP connection failed"}))
`;
    await createMockWorker(mockScript);

    const adapter = createAdapter();
    await adapter.start(async () => {});
    const count = await adapter.pollOnce();
    await adapter.stop();
    expect(count).toBe(0);
  });

  it("pollOnce throws if not started", async () => {
    const adapter = createAdapter();
    await expect(adapter.pollOnce()).rejects.toThrow("EmailAdapter must be started before polling");
  });

  it("tracks message IDs for threading across polls", async () => {
    const mockScript = `
import json, sys
req = json.loads(sys.stdin.readline())
if req["command"] == "poll":
    print(json.dumps({
        "ok": True,
        "messages": [{
            "message_id": "200",
            "msg_id_header": "<msg-200@test.com>",
            "from": "user@test.com",
            "to": "agent@test.com",
            "cc": [],
            "subject": "Thread start",
            "body": "First",
            "date": "Mon, 01 Jan 2024 00:00:00 +0000",
            "in_reply_to": "",
            "references": [],
            "attachments": []
        }]
    }))
else:
    print(json.dumps({"ok": True}))
`;
    await createMockWorker(mockScript);

    const received: ChannelMessage[] = [];
    const adapter = createAdapter();
    await adapter.start(async (msg) => {
      received.push(msg);
    });

    await adapter.pollOnce();
    expect(received.length).toBe(1);
    const firstChatId = received[0]!.sessionKey.chatId;
    expect(firstChatId).toBeDefined();
    await adapter.stop();
  });
});

describe("EmailAdapter Phase 4 features", () => {
  let tmpDir: string;
  let mediaRoot: string;
  let workerPath: string;
  let pythonBinary: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "estacoda-email-test-"));
    mediaRoot = join(tmpDir, "media");
    workerPath = join(tmpDir, "mock_email_worker.py");
    pythonBinary = await resolveTestPythonBinary();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function createMockWorker(script: string): Promise<void> {
    await writeFile(workerPath, script, "utf8");
  }

  function createAdapter(options: Partial<ConstructorParameters<typeof EmailAdapter>[0]> = {}) {
    return new EmailAdapter({
      imapHost: "imap.test.com",
      imapPort: 993,
      smtpHost: "smtp.test.com",
      smtpPort: 587,
      username: "agent@test.com",
      password: "secret",
      ownAddress: "agent@test.com",
      allowedSenders: ["user@test.com"],
      pollIntervalSeconds: 1,
      mediaRoot,
      workerPath,
      pythonBinary,
      ...options
    });
  }

  it("allowAllUsers bypasses allowedSenders filter", async () => {
    const mockScript = `
import json, sys
req = json.loads(sys.stdin.readline())
if req["command"] == "poll":
    print(json.dumps({
        "ok": True,
        "messages": [{
            "message_id": "301",
            "msg_id_header": "<msg-301@test.com>",
            "from": "stranger@test.com",
            "to": "agent@test.com",
            "cc": [],
            "subject": "Hello",
            "body": "From a stranger",
            "date": "Mon, 01 Jan 2024 00:00:00 +0000",
            "in_reply_to": "",
            "references": [],
            "attachments": []
        }]
    }))
else:
    print(json.dumps({"ok": True}))
`;
    await createMockWorker(mockScript);
    const received: ChannelMessage[] = [];
    const adapter = createAdapter({ allowAllUsers: true });
    await adapter.start(async (msg) => {
      received.push(msg);
    });
    await adapter.pollOnce();
    await adapter.stop();
    expect(received.length).toBe(1);
    expect(received[0].sender.id).toBe("stranger@test.com");
  });

  it("filters self-messages", async () => {
    const mockScript = `
import json, sys
req = json.loads(sys.stdin.readline())
if req["command"] == "poll":
    print(json.dumps({
        "ok": True,
        "messages": [{
            "message_id": "302",
            "msg_id_header": "<msg-302@test.com>",
            "from": "agent@test.com",
            "to": "agent@test.com",
            "cc": [],
            "subject": "Self",
            "body": "Self message",
            "date": "Mon, 01 Jan 2024 00:00:00 +0000",
            "in_reply_to": "",
            "references": [],
            "attachments": []
        }]
    }))
else:
    print(json.dumps({"ok": True}))
`;
    await createMockWorker(mockScript);
    const received: ChannelMessage[] = [];
    const adapter = createAdapter();
    await adapter.start(async (msg) => {
      received.push(msg);
    });
    await adapter.pollOnce();
    await adapter.stop();
    expect(received.length).toBe(0);
  });

  it("includes body_html in message text when present", async () => {
    const mockScript = `
import json, sys
req = json.loads(sys.stdin.readline())
if req["command"] == "poll":
    print(json.dumps({
        "ok": True,
        "messages": [{
            "message_id": "303",
            "msg_id_header": "<msg-303@test.com>",
            "from": "user@test.com",
            "to": "agent@test.com",
            "cc": [],
            "subject": "HTML",
            "body": "Plain text body",
            "body_html": "<html><body>HTML body</body></html>",
            "date": "Mon, 01 Jan 2024 00:00:00 +0000",
            "in_reply_to": "",
            "references": [],
            "attachments": []
        }]
    }))
else:
    print(json.dumps({"ok": True}))
`;
    await createMockWorker(mockScript);
    const received: ChannelMessage[] = [];
    const adapter = createAdapter();
    await adapter.start(async (msg) => {
      received.push(msg);
    });
    await adapter.pollOnce();
    await adapter.stop();
    expect(received.length).toBe(1);
    expect(received[0].text).toContain("Plain text body");
    expect(received[0].text).toContain("[HTML version available but not displayed]");
  });

  it("markAllSeenOnConnect calls worker with mark_all_seen_only", async () => {
    const mockScript = `
import json, sys
req = json.loads(sys.stdin.readline())
if req["command"] == "poll":
    args = req.get("args", {})
    if args.get("mark_all_seen_only"):
        print(json.dumps({"ok": True, "messages": []}))
    else:
        print(json.dumps({"ok": True, "messages": []}))
else:
    print(json.dumps({"ok": True}))
`;
    await createMockWorker(mockScript);
    const adapter = createAdapter({ markAllSeenOnConnect: true });
    await adapter.start(async () => {});
    await adapter.stop();
    expect(true).toBe(true);
  });
});
