import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import {
  runGatewayStatus,
  runGatewayDiagnose,
  runChannelsList,
  runChannelsStatus
} from "./gateway-commands.js";
import { CronStore } from "../cron/cron-store.js";
import { CronExecutionStore } from "../cron/cron-execution-store.js";
import { ChannelApprovalStore } from "../channels/channel-approval-store.js";
import { FileSurfacePointerStore } from "../channels/surface-pointer-store.js";
import { DeliveryRouter } from "../channels/delivery-router.js";

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "estacoda-gateway-test-"));
}

describe("gateway commands", () => {
  let tmpDir: string;
  let stateRoot: string;

  beforeEach(async () => {
    tmpDir = await makeTempDir();
    stateRoot = join(tmpDir, ".estacoda");
    await mkdir(stateRoot, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe("runGatewayStatus", () => {
    it("returns basic status with no config", async () => {
      const result = await runGatewayStatus({ workspaceRoot: tmpDir, homeDir: tmpDir });
      expect(result.ok).toBe(true);
      expect(result.output).toContain("EstaCoda gateway status");
      expect(result.output).toContain("Process");
      expect(result.output).toContain("Channels");
      expect(result.output).toContain("Telegram:");
      expect(result.output).toContain("Discord:");
      expect(result.output).toContain("Email:");
      expect(result.output).toContain("WhatsApp:");
    });

    it("shows cron jobs", async () => {
      const cronStore = new CronStore({ homeDir: tmpDir });
      await cronStore.create({ schedule: "1h", prompt: "test job" });

      const result = await runGatewayStatus({ workspaceRoot: tmpDir, homeDir: tmpDir });
      expect(result.ok).toBe(true);
      expect(result.output).toContain("Jobs: 1 total, 1 active");
    });

    it("shows recent cron failures", async () => {
      const dbPath = join(stateRoot, "sessions.sqlite");
      const db = new Database(dbPath, { create: true });
      db.exec(`
        create table if not exists cron_executions (
          id text primary key,
          job_id text not null,
          session_id text,
          trajectory_id text,
          scheduled_at text,
          started_at text not null,
          completed_at text,
          status text not null,
          output_summary text,
          delivery_results_json text,
          failure_class text,
          failure_message text,
          created_at text not null
        )
      `);
      const executionStore = new CronExecutionStore(db);
      const record = await executionStore.create({ jobId: "job-1" });
      await executionStore.complete(record.id, {
        status: "failed",
        failureClass: "script-failed",
        failureMessage: "script exited 1"
      });

      const result = await runGatewayStatus({ workspaceRoot: tmpDir, homeDir: tmpDir });
      expect(result.ok).toBe(true);
      expect(result.output).toContain("Recent cron failures");
      expect(result.output).toContain("job-1");
      expect(result.output).toContain("[failed]");
      expect(result.output).toContain("script exited 1");

      db.close();
    });

    it("shows recent delivery errors", async () => {
      const router = new DeliveryRouter({ homeDir: tmpDir });
      await router.deliverText([{ kind: "channel", platform: "telegram", chatId: "123" }], "test");

      const result = await runGatewayStatus({ workspaceRoot: tmpDir, homeDir: tmpDir });
      expect(result.ok).toBe(true);
      expect(result.output).toContain("Recent delivery errors");
      expect(result.output).toContain("telegram:123");
    });

    it("shows surface pointers", async () => {
      const store = new FileSurfacePointerStore({ path: join(stateRoot, "surface-pointers.json") });
      await store.setPointer("telegram", "chat-1", { sessionId: "sess-1", attachedAt: "2024-01-01T00:00:00Z", homeDelivery: "local" });

      const result = await runGatewayStatus({ workspaceRoot: tmpDir, homeDir: tmpDir });
      expect(result.ok).toBe(true);
      expect(result.output).toContain("Surface pointers");
      expect(result.output).toContain("telegram:chat-1");
      expect(result.output).toContain("sess-1");
      expect(result.output).toContain("home=local");
    });

    it("shows pending approvals count", async () => {
      const store = new ChannelApprovalStore({ path: join(stateRoot, "channel-approvals.json") });
      await store.grant({
        sessionKey: { platform: "telegram", chatId: "123", userId: "u1" },
        toolName: "terminal",
        riskClass: "high"
      });

      const result = await runGatewayStatus({ workspaceRoot: tmpDir, homeDir: tmpDir });
      expect(result.ok).toBe(true);
      expect(result.output).toContain("Pending approvals");
      expect(result.output).toContain("Total grants: 1");
    });

    it("shows WhatsApp experimental gate status", async () => {
      const result = await runGatewayStatus({ workspaceRoot: tmpDir, homeDir: tmpDir });
      expect(result.ok).toBe(true);
      expect(result.output).toContain("WhatsApp:");
    });

    it("shows Email home/default address when configured", async () => {
      const result = await runGatewayStatus({ workspaceRoot: tmpDir, homeDir: tmpDir });
      expect(result.ok).toBe(true);
      expect(result.output).toContain("Email:");
    });
  });

  describe("runGatewayDiagnose", () => {
    it("checks all channels and reports missing config", async () => {
      const result = await runGatewayDiagnose({ workspaceRoot: tmpDir, homeDir: tmpDir });
      expect(result.ok).toBe(false);
      expect(result.output).toContain("EstaCoda gateway diagnose");
      expect(result.output).toContain("Telegram");
      expect(result.output).toContain("Discord");
      expect(result.output).toContain("Email");
      expect(result.output).toContain("WhatsApp");
      expect(result.output).toContain("Cron");
    });

    it("reports WhatsApp experimental gate closed by default", async () => {
      const result = await runGatewayDiagnose({ workspaceRoot: tmpDir, homeDir: tmpDir });
      expect(result.output).toContain("WhatsApp");
      expect(result.output).toContain("Experimental gate: closed");
    });

    it("reports cron directory status", async () => {
      const result = await runGatewayDiagnose({ workspaceRoot: tmpDir, homeDir: tmpDir });
      expect(result.output).toContain("Cron");
      expect(result.output).toContain("Jobs file readable:");
      expect(result.output).toContain("Output dir writable:");
      expect(result.output).toContain("Lock dir writable:");
    });
  });

  describe("runChannelsList", () => {
    it("lists all channels", async () => {
      const result = await runChannelsList({ workspaceRoot: tmpDir, homeDir: tmpDir });
      expect(result.ok).toBe(true);
      expect(result.output).toContain("EstaCoda channels");
      expect(result.output).toContain("telegram");
      expect(result.output).toContain("discord");
      expect(result.output).toContain("email");
      expect(result.output).toContain("whatsapp");
    });
  });

  describe("runChannelsStatus", () => {
    it("returns telegram status", async () => {
      const result = await runChannelsStatus({ workspaceRoot: tmpDir, homeDir: tmpDir, channel: "telegram" });
      expect(result.ok).toBe(true);
      expect(result.output).toContain("Telegram channel status");
      expect(result.output).toContain("Enabled:");
    });

    it("returns discord status", async () => {
      const result = await runChannelsStatus({ workspaceRoot: tmpDir, homeDir: tmpDir, channel: "discord" });
      expect(result.ok).toBe(true);
      expect(result.output).toContain("Discord channel status");
      expect(result.output).toContain("Enabled:");
    });

    it("returns email status with home address", async () => {
      const result = await runChannelsStatus({ workspaceRoot: tmpDir, homeDir: tmpDir, channel: "email" });
      expect(result.ok).toBe(true);
      expect(result.output).toContain("Email channel status");
      expect(result.output).toContain("Home address:");
    });

    it("returns whatsapp status with experimental gate", async () => {
      const result = await runChannelsStatus({ workspaceRoot: tmpDir, homeDir: tmpDir, channel: "whatsapp" });
      expect(result.ok).toBe(true);
      expect(result.output).toContain("WhatsApp channel status");
      expect(result.output).toContain("Experimental gate:");
    });

    it("returns error for unknown channel", async () => {
      const result = await runChannelsStatus({ workspaceRoot: tmpDir, homeDir: tmpDir, channel: "unknown" });
      expect(result.ok).toBe(false);
      expect(result.output).toContain("Unknown channel");
    });
  });
});
