import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DeliveryRouter } from "./delivery-router.js";
import { createFakeTelegramAdapter } from "../test/fakes/fake-telegram-adapter.js";
import { createFakeDiscordAdapter } from "../test/fakes/fake-discord-adapter.js";
import { createFakeEmailAdapter } from "../test/fakes/fake-email-adapter.js";
import { createFakeWhatsAppAdapter } from "../test/fakes/fake-whatsapp-adapter.js";
import { PlainLogSurfaceAdapter } from "./surface-adapters/plain-log-surface-adapter.js";
import type { ChannelAdapter, ChannelSessionKey } from "../contracts/channel.js";
import type { FakeDeliveryRecord } from "../test/fakes/fake-channel-adapter.js";

type FakeAdapter = ChannelAdapter & { records: FakeDeliveryRecord[]; clearRecords(): void };

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "estacoda-delivery-test-"));
}

describe("DeliveryRouter", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTempDir();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  const baseSessionKey: ChannelSessionKey = {
    platform: "telegram",
    chatId: "123456"
  };

  describe("target parsing", () => {
    it("parses origin", () => {
      const router = new DeliveryRouter({ homeDir: tmpDir });
      const targets = router.parseTarget("origin", baseSessionKey);
      expect(targets).toHaveLength(1);
      expect(targets[0]).toEqual({ kind: "origin", originalSessionKey: baseSessionKey });
    });

    it("parses local", () => {
      const router = new DeliveryRouter({ homeDir: tmpDir });
      const targets = router.parseTarget("local", baseSessionKey);
      expect(targets).toHaveLength(1);
      expect(targets[0]).toEqual({ kind: "local" });
    });

    it("parses silent", () => {
      const router = new DeliveryRouter({ homeDir: tmpDir });
      const targets = router.parseTarget("silent", baseSessionKey);
      expect(targets).toHaveLength(1);
      expect(targets[0]).toEqual({ kind: "silent" });
    });

    it("parses telegram with chatId", () => {
      const router = new DeliveryRouter({ homeDir: tmpDir });
      const targets = router.parseTarget("telegram:789", baseSessionKey);
      expect(targets[0]).toEqual({ kind: "channel", platform: "telegram", chatId: "789" });
    });

    it("parses telegram with chatId and threadId", () => {
      const router = new DeliveryRouter({ homeDir: tmpDir });
      const targets = router.parseTarget("telegram:789:42", baseSessionKey);
      expect(targets[0]).toEqual({ kind: "channel", platform: "telegram", chatId: "789", threadId: "42" });
    });

    it("parses discord with chatId", () => {
      const router = new DeliveryRouter({ homeDir: tmpDir });
      const targets = router.parseTarget("discord:channel-1", baseSessionKey);
      expect(targets[0]).toEqual({ kind: "channel", platform: "discord", chatId: "channel-1" });
    });

    it("parses email with address", () => {
      const router = new DeliveryRouter({ homeDir: tmpDir });
      const targets = router.parseTarget("email:user@example.com", baseSessionKey);
      expect(targets[0]).toEqual({ kind: "channel", platform: "email", address: "user@example.com" });
    });

    it("parses whatsapp with chatId", () => {
      const router = new DeliveryRouter({ homeDir: tmpDir });
      const targets = router.parseTarget("whatsapp:971501234567", baseSessionKey);
      expect(targets[0]).toEqual({ kind: "channel", platform: "whatsapp", chatId: "971501234567" });
    });

    it("parses comma-separated multi-targets", () => {
      const router = new DeliveryRouter({ homeDir: tmpDir });
      const targets = router.parseTarget("telegram:789, local, email:user@example.com", baseSessionKey);
      expect(targets).toHaveLength(3);
      expect(targets[0]).toEqual({ kind: "channel", platform: "telegram", chatId: "789" });
      expect(targets[1]).toEqual({ kind: "local" });
      expect(targets[2]).toEqual({ kind: "channel", platform: "email", address: "user@example.com" });
    });

    it("falls back to origin for unrecognized targets", () => {
      const router = new DeliveryRouter({ homeDir: tmpDir });
      const targets = router.parseTarget("unknown:thing", baseSessionKey);
      expect(targets[0]).toEqual({ kind: "origin", originalSessionKey: baseSessionKey });
    });
  });

  describe("text delivery", () => {
    it("delivers to registered telegram adapter", async () => {
      const router = new DeliveryRouter({ homeDir: tmpDir });
      const telegram = createFakeTelegramAdapter() as FakeAdapter;
      router.registerAdapter(telegram);

      const targets = router.parseTarget("telegram:123", baseSessionKey);
      const results = await router.deliverText(targets, "Hello");

      expect(results.get("telegram:123")?.success).toBe(true);
      expect(telegram.records).toHaveLength(1);
      expect(telegram.records[0].text).toBe("Hello");
      expect(telegram.records[0].sessionKey.chatId).toBe("123");
    });

    it("delivers to origin via original session platform", async () => {
      const router = new DeliveryRouter({ homeDir: tmpDir });
      const telegram = createFakeTelegramAdapter() as FakeAdapter;
      router.registerAdapter(telegram);

      const targets = router.parseTarget("origin", baseSessionKey);
      const results = await router.deliverText(targets, "Hello origin");

      expect(results.get("origin")?.success).toBe(true);
      expect(telegram.records[0].sessionKey.chatId).toBe("123456");
    });

    it("saves local delivery to disk", async () => {
      const router = new DeliveryRouter({ homeDir: tmpDir });
      const targets = router.parseTarget("local", baseSessionKey);
      await router.deliverText(targets, "Local content");

      const deliveryDir = join(tmpDir, ".estacoda", "delivery");
      const files = await readdir(deliveryDir);
      expect(files.length).toBeGreaterThan(0);

      const content = await readFile(join(deliveryDir, files[0]), "utf-8");
      expect(content).toBe("Local content");
    });

    it("silent target does nothing and succeeds", async () => {
      const router = new DeliveryRouter({ homeDir: tmpDir });
      const targets = router.parseTarget("silent", baseSessionKey);
      const results = await router.deliverText(targets, "Hidden");

      expect(results.get("silent")?.success).toBe(true);
    });

    it("returns failure when adapter is not registered", async () => {
      const router = new DeliveryRouter({ homeDir: tmpDir });
      const targets = router.parseTarget("discord:456", baseSessionKey);
      const results = await router.deliverText(targets, "Hello");

      expect(results.get("discord:456")?.success).toBe(false);
      expect(results.get("discord:456")?.error).toContain("No delivery adapter available");
    });

    it("returns failure when adapter delivery fails", async () => {
      const router = new DeliveryRouter({ homeDir: tmpDir });
      const telegram = createFakeTelegramAdapter({ shouldFailDelivery: true, failureMessage: "Network error" }) as FakeAdapter;
      router.registerAdapter(telegram);

      const targets = router.parseTarget("telegram:123", baseSessionKey);
      const results = await router.deliverText(targets, "Hello");

      expect(results.get("telegram:123")?.success).toBe(false);
      expect(results.get("telegram:123")?.error).toBe("Network error");
    });

    it("truncates oversized output and saves full to disk", async () => {
      const router = new DeliveryRouter({ homeDir: tmpDir, maxOutputChars: 20 });
      const telegram = createFakeTelegramAdapter() as FakeAdapter;
      router.registerAdapter(telegram);

      const longText = "This is a very long message that should be truncated by the delivery router.";
      const targets = router.parseTarget("telegram:123", baseSessionKey);
      await router.deliverText(targets, longText);

      const record = telegram.records[0];
      expect(record.text).toContain("[Output truncated. Full response saved to disk.]");
      expect(record.text!.length).toBeLessThan(longText.length);

      // Full output saved to disk (async, may need a tick)
      await new Promise((r) => setTimeout(r, 50));
      const truncatedDir = join(tmpDir, ".estacoda", "delivery", "truncated");
      const files = await readdir(truncatedDir);
      expect(files.length).toBeGreaterThan(0);

      const fullContent = await readFile(join(truncatedDir, files[0]), "utf-8");
      expect(fullContent).toBe(longText);
    });
  });

  describe("multi-target delivery", () => {
    it("delivers to multiple targets independently", async () => {
      const router = new DeliveryRouter({ homeDir: tmpDir });
      const telegram = createFakeTelegramAdapter() as FakeAdapter;
      const discord = createFakeDiscordAdapter() as FakeAdapter;
      router.registerAdapter(telegram);
      router.registerAdapter(discord);

      const targets = router.parseTarget("telegram:123, discord:456", baseSessionKey);
      const results = await router.deliverText(targets, "Multicast");

      expect(results.get("telegram:123")?.success).toBe(true);
      expect(results.get("discord:456")?.success).toBe(true);
      expect(telegram.records).toHaveLength(1);
      expect(discord.records).toHaveLength(1);
    });

    it("continues delivery to remaining targets after one fails", async () => {
      const router = new DeliveryRouter({ homeDir: tmpDir });
      const telegram = createFakeTelegramAdapter() as FakeAdapter;
      const discord = createFakeDiscordAdapter({ shouldFailDelivery: true }) as FakeAdapter;
      router.registerAdapter(telegram);
      router.registerAdapter(discord);

      const targets = router.parseTarget("discord:456, telegram:123", baseSessionKey);
      const results = await router.deliverText(targets, "Partial");

      expect(results.get("discord:456")?.success).toBe(false);
      expect(results.get("telegram:123")?.success).toBe(true);
    });
  });

  describe("progress delivery", () => {
    it("delivers progress to registered adapter", async () => {
      const router = new DeliveryRouter({ homeDir: tmpDir });
      const telegram = createFakeTelegramAdapter() as FakeAdapter;
      router.registerAdapter(telegram);

      const event = { kind: "tool-start" as const, tool: "search", input: "query" };
      const targets = router.parseTarget("telegram:123", baseSessionKey);
      await router.deliverProgress(targets[0], event);

      expect(telegram.records).toHaveLength(1);
      expect(telegram.records[0].kind).toBe("progress");
    });

    it("ignores progress for silent and local targets", async () => {
      const router = new DeliveryRouter({ homeDir: tmpDir });
      const telegram = createFakeTelegramAdapter() as FakeAdapter;
      router.registerAdapter(telegram);

      const event = { kind: "tool-start" as const, tool: "search", input: "query" };
      await router.deliverProgress({ kind: "silent" }, event);
      await router.deliverProgress({ kind: "local" }, event);

      expect(telegram.records).toHaveLength(0);
    });
  });

  describe("artifact delivery", () => {
    it("delivers artifact to registered adapter", async () => {
      const router = new DeliveryRouter({ homeDir: tmpDir });
      const telegram = createFakeTelegramAdapter() as FakeAdapter;
      router.registerAdapter(telegram);

      const artifact = { id: "art-1", kind: "document" as const, name: "report.md", mimeType: "text/markdown", path: "/tmp/report.md", bytes: 100, createdAt: new Date().toISOString() };
      const targets = router.parseTarget("telegram:123", baseSessionKey);
      await router.deliverArtifact(targets[0], artifact);

      expect(telegram.records).toHaveLength(1);
      expect(telegram.records[0].kind).toBe("artifact");
    });
  });

  describe("adapter registration", () => {
    it("lists registered platforms", () => {
      const router = new DeliveryRouter({ homeDir: tmpDir });
      router.registerAdapter(createFakeTelegramAdapter());
      router.registerAdapter(createFakeDiscordAdapter());

      expect(router.getRegisteredPlatforms()).toContain("telegram");
      expect(router.getRegisteredPlatforms()).toContain("discord");
    });

    it("allows unregistering adapters", () => {
      const router = new DeliveryRouter({ homeDir: tmpDir });
      router.registerAdapter(createFakeTelegramAdapter());
      router.unregisterAdapter("telegram");

      expect(router.getRegisteredPlatforms()).not.toContain("telegram");
    });
  });

  describe("delivery error recording", () => {
    it("records delivery errors to jsonl", async () => {
      const router = new DeliveryRouter({ homeDir: tmpDir });
      const telegram = createFakeTelegramAdapter({ shouldFailDelivery: true }) as FakeAdapter;
      router.registerAdapter(telegram);

      const targets = router.parseTarget("telegram:123", baseSessionKey);
      await router.deliverText(targets, "Hello");

      // Wait for async write
      await new Promise((r) => setTimeout(r, 50));

      const errorPath = join(tmpDir, ".estacoda", "gateway", "delivery-errors.jsonl");
      const content = await readFile(errorPath, "utf-8");
      const lines = content.trim().split("\n");
      expect(lines.length).toBe(1);

      const record = JSON.parse(lines[0]);
      expect(record.target).toBe("telegram:123");
      expect(record.error).toBe("telegram delivery failed");
      expect(record.retryCount).toBe(0);
    });

    it("returns recent errors via getRecentErrors", async () => {
      const router = new DeliveryRouter({ homeDir: tmpDir });
      const telegram = createFakeTelegramAdapter({ shouldFailDelivery: true, failureMessage: "fail-1" }) as FakeAdapter;
      router.registerAdapter(telegram);

      const targets = router.parseTarget("telegram:123", baseSessionKey);
      await router.deliverText(targets, "Hello 1");
      await router.deliverText(targets, "Hello 2");

      await new Promise((r) => setTimeout(r, 50));

      const errors = await router.getRecentErrors(10);
      expect(errors.length).toBe(2);
      expect(errors[0].error).toBe("fail-1");
      expect(errors[1].error).toBe("fail-1");
    });

    it("returns empty array for getRecentErrors when no errors exist", async () => {
      const router = new DeliveryRouter({ homeDir: tmpDir });
      const errors = await router.getRecentErrors(10);
      expect(errors).toEqual([]);
    });
  });

  describe("surface adapter compatibility", () => {
    it("can set and get a surface adapter", () => {
      const router = new DeliveryRouter({ homeDir: tmpDir });
      const adapter = new PlainLogSurfaceAdapter();
      router.setSurfaceAdapter(adapter);
      expect(router.surfaceAdapter).toBe(adapter);
    });

    it("can unset a surface adapter", () => {
      const router = new DeliveryRouter({ homeDir: tmpDir });
      const adapter = new PlainLogSurfaceAdapter();
      router.setSurfaceAdapter(adapter);
      router.setSurfaceAdapter(undefined);
      expect(router.surfaceAdapter).toBeUndefined();
    });

    it("deliverViewModel uses surface adapter when configured", async () => {
      const router = new DeliveryRouter({ homeDir: tmpDir });
      const telegram = createFakeTelegramAdapter() as FakeAdapter;
      router.registerAdapter(telegram);

      const adapter = new PlainLogSurfaceAdapter();
      router.setSurfaceAdapter(adapter);

      const vm = {
        kind: "plainFallback" as const,
        lines: ["hello from vm"],
      };
      const targets = router.parseTarget("telegram:123", baseSessionKey);
      const results = await router.deliverViewModel(targets, vm);

      expect(results.get("telegram:123")?.success).toBe(true);
      expect(telegram.records).toHaveLength(1);
      expect(telegram.records[0].text).toContain("hello from vm");
    });

    it("deliverViewModel falls back to plain renderer when no surface adapter", async () => {
      const router = new DeliveryRouter({ homeDir: tmpDir });
      const telegram = createFakeTelegramAdapter() as FakeAdapter;
      router.registerAdapter(telegram);

      const vm = {
        kind: "plainFallback" as const,
        lines: ["fallback plain"],
      };
      const targets = router.parseTarget("telegram:123", baseSessionKey);
      const results = await router.deliverViewModel(targets, vm);

      expect(results.get("telegram:123")?.success).toBe(true);
      expect(telegram.records).toHaveLength(1);
      expect(telegram.records[0].text).toBe("fallback plain");
    });

    it("deliverViewModel preserves existing routing behavior", async () => {
      const router = new DeliveryRouter({ homeDir: tmpDir });
      const telegram = createFakeTelegramAdapter() as FakeAdapter;
      router.registerAdapter(telegram);

      router.setSurfaceAdapter(new PlainLogSurfaceAdapter());

      const targets = router.parseTarget("telegram:123", baseSessionKey);
      const results = await router.deliverText(targets, "Direct text");

      expect(results.get("telegram:123")?.success).toBe(true);
      expect(telegram.records[0].text).toBe("Direct text");
    });
  });
});
