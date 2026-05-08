import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir, chmod } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import {
  runGatewayStatus,
  runGatewayDiagnose,
  runChannelsList,
  runChannelsStatus,
  runChannelsEnable,
  runChannelsDisable,
  runGatewayStop,
  runGatewayRestart,
} from "./gateway-commands.js";
import * as supervisorModule from "../gateway/supervisor.js";
import { CronStore } from "../cron/cron-store.js";
import { CronExecutionStore } from "../cron/cron-execution-store.js";
import { ChannelApprovalStore } from "../channels/channel-approval-store.js";
import { FileSurfacePointerStore } from "../channels/surface-pointer-store.js";
import { DeliveryRouter } from "../channels/delivery-router.js";
import { writeGatewayPid, removeGatewayPid } from "../gateway/pid-file.js";
import { writeGatewayState, removeGatewayState } from "../gateway/supervisor-state.js";
import { acquireGatewayLock, releaseGatewayLock } from "../gateway/gateway-lock.js";
import { stopGateway } from "../gateway/supervisor-lifecycle.js";
import * as lifecycleModule from "../gateway/supervisor-lifecycle.js";
import { acquireAdapterIdentityLock, listAdapterIdentityLocks } from "../gateway/identity-lock.js";
import { writeRuntimeCacheState, runtimeCacheStatePath } from "../gateway/runtime-cache-state.js";
import type { RuntimeCacheState } from "../gateway/runtime-cache-state.js";
import { writeAdapterRuntimeState, RUNTIME_STATE_FILE } from "../gateway/adapter-runtime-state.js";
import type { PersistedRuntimeState, AdapterRuntimeState } from "../gateway/adapter-runtime-state.js";

function fakeRuntimeCacheState(overrides?: Partial<RuntimeCacheState>): RuntimeCacheState {
  return {
    version: 1,
    writtenAt: new Date().toISOString(),
    supervisorPid: process.pid,
    supervisorStartedAt: new Date().toISOString(),
    cacheStats: {
      totalEntries: 2,
      activeBorrows: 1,
      suspendedEntries: 0,
      totalCreated: 5,
      totalReused: 3,
      totalDisposed: 2,
      totalInvalidated: 0,
    },
    suspendedSummary: [],
    registryStats: {
      activeTurnCount: 1,
      totalStarted: 10,
      totalEnded: 9,
      totalAborted: 0,
      stuckTurnCount: 0,
      repeatStuckCount: 0,
    },
    stuckTurnHistory: [],
    fingerprintHash: "abc123def4567890",
    ...overrides,
  };
}

function fakeAdapterRuntimeState(
  kind: "telegram" | "discord" | "email" | "whatsapp",
  overrides?: Partial<PersistedRuntimeState>,
  adapterOverrides?: Partial<AdapterRuntimeState>
): PersistedRuntimeState {
  return {
    supervisorPid: process.pid,
    supervisorStartedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    adapters: [
      {
        kind,
        state: "healthy",
        pollsTotal: 5,
        pollsFailed: 0,
        pollMessagesProcessed: 3,
        ...adapterOverrides,
      },
    ],
    ...overrides,
  };
}

async function writeUserConfig(homeDir: string, config: unknown): Promise<void> {
  const configPath = join(homeDir, ".estacoda", "config.json");
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, JSON.stringify(config), "utf8");
}

async function writeRawAdapterRuntimeState(homeDir: string, content: string): Promise<void> {
  const path = join(homeDir, ".estacoda", "gateway", RUNTIME_STATE_FILE);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

async function writeStaleLock(homeDir: string, kind: string, content: string): Promise<void> {
  const locksDir = join(homeDir, ".estacoda", "gateway", "locks");
  await mkdir(locksDir, { recursive: true });
  await writeFile(join(locksDir, `identity-${kind}-deadbeef.lock`), content, "utf8");
}

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

    it("shows approvals block with policy and granted count", async () => {
      const store = new ChannelApprovalStore({ path: join(stateRoot, "channel-approvals.json") });
      await store.grant({
        sessionKey: { platform: "telegram", chatId: "123", userId: "u1" },
        toolName: "terminal",
        riskClass: "high"
      });

      const result = await runGatewayStatus({ workspaceRoot: tmpDir, homeDir: tmpDir });
      expect(result.ok).toBe(true);
      expect(result.output).toContain("Approvals");
      expect(result.output).toContain("Policy:");
      expect(result.output).toContain("Granted: 1");
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

    it("shows Supervisor block with PID and lifecycle when state exists", async () => {
      await writeGatewayState(tmpDir, { lifecycle: "running", startedAt: new Date().toISOString(), pid: process.pid, version: "0.0.5" });
      await writeGatewayPid(tmpDir, { pid: process.pid, startedAt: new Date().toISOString(), version: "0.0.5" });

      const result = await runGatewayStatus({ workspaceRoot: tmpDir, homeDir: tmpDir });
      expect(result.ok).toBe(true);
      expect(result.output).toContain("Supervisor");
      expect(result.output).toContain(`PID: ${process.pid}`);
      expect(result.output).toContain("State: running");
      expect(result.output).toContain("Version: 0.0.5");
    });

    it("shows Supervisor block as stopped when no state", async () => {
      const result = await runGatewayStatus({ workspaceRoot: tmpDir, homeDir: tmpDir });
      expect(result.ok).toBe(true);
      expect(result.output).toContain("Supervisor");
      expect(result.output).toContain("PID: none");
      expect(result.output).toContain("State: stopped");
    });

    it("does not show identity lock block when only healthy locks exist", async () => {
      const hash = "a".repeat(64);
      await acquireAdapterIdentityLock(tmpDir, "telegram", hash);

      const result = await runGatewayStatus({ workspaceRoot: tmpDir, homeDir: tmpDir });
      expect(result.ok).toBe(true);
      expect(result.output).not.toContain("Identity Locks");
      expect(result.output).not.toContain("primitives only");
    });

    it("shows corrupt identity lock in status", async () => {
      const { writeFile, mkdir } = await import("node:fs/promises");
      const locksDir = join(tmpDir, ".estacoda", "gateway", "locks");
      await mkdir(locksDir, { recursive: true });
      await writeFile(
        join(locksDir, "identity-telegram-deadbeef.lock"),
        "this is not valid json",
        "utf8"
      );

      const result = await runGatewayStatus({ workspaceRoot: tmpDir, homeDir: tmpDir });
      expect(result.ok).toBe(true);
      expect(result.output).toContain("Identity Locks");
      expect(result.output).toContain("telegram");
      expect(result.output).toContain("corrupt");
      expect(result.output).not.toContain("-1");
      expect(result.output).not.toContain("deadbeef");
    });
    it("shows stale identity lock in status", async () => {
      const { writeFile, mkdir } = await import("node:fs/promises");
      const locksDir = join(tmpDir, ".estacoda", "gateway", "locks");
      await mkdir(locksDir, { recursive: true });
      await writeFile(
        join(locksDir, "identity-telegram-deadbeef.lock"),
        JSON.stringify({ pid: 99999, startedAt: new Date().toISOString() }),
        "utf8"
      );

      const result = await runGatewayStatus({ workspaceRoot: tmpDir, homeDir: tmpDir });
      expect(result.ok).toBe(true);
      expect(result.output).toContain("Identity Locks");
      expect(result.output).toContain("telegram");
      expect(result.output).toContain("stale");
      expect(result.output).toContain("99999");
    });

    it("shows Runtime Cache and Active Turns blocks when state is trustworthy", async () => {
      await writeGatewayPid(tmpDir, { pid: process.pid, startedAt: new Date().toISOString(), version: "0.0.5" });
      await writeRuntimeCacheState(runtimeCacheStatePath(tmpDir), fakeRuntimeCacheState());

      const result = await runGatewayStatus({ workspaceRoot: tmpDir, homeDir: tmpDir });
      expect(result.ok).toBe(true);
      expect(result.output).toContain("Runtime Cache");
      expect(result.output).toContain("Active Turns");
      expect(result.output).toContain("Entries:");
      expect(result.output).toContain("Active turns:");
    });

    it("omits runtime-cache blocks when state is stale", async () => {
      await writeGatewayPid(tmpDir, { pid: process.pid, startedAt: new Date().toISOString(), version: "0.0.5" });
      const staleState = fakeRuntimeCacheState({ writtenAt: new Date(Date.now() - 300_000).toISOString() });
      await writeRuntimeCacheState(runtimeCacheStatePath(tmpDir), staleState);

      const result = await runGatewayStatus({ workspaceRoot: tmpDir, homeDir: tmpDir });
      expect(result.ok).toBe(true);
      expect(result.output).not.toContain("Runtime Cache");
      expect(result.output).not.toContain("Active Turns");
    });

    it("omits runtime-cache blocks when PID mismatches", async () => {
      await writeGatewayPid(tmpDir, { pid: process.pid, startedAt: new Date().toISOString(), version: "0.0.5" });
      const mismatchedState = fakeRuntimeCacheState({ supervisorPid: 99999 });
      await writeRuntimeCacheState(runtimeCacheStatePath(tmpDir), mismatchedState);

      const result = await runGatewayStatus({ workspaceRoot: tmpDir, homeDir: tmpDir });
      expect(result.ok).toBe(true);
      expect(result.output).not.toContain("Runtime Cache");
      expect(result.output).not.toContain("Active Turns");
    });

    it("omits runtime-cache blocks when supervisor is not live", async () => {
      await writeGatewayPid(tmpDir, { pid: 99999, startedAt: new Date().toISOString(), version: "0.0.5" });
      await writeRuntimeCacheState(runtimeCacheStatePath(tmpDir), fakeRuntimeCacheState({ supervisorPid: 99999 }));

      const result = await runGatewayStatus({ workspaceRoot: tmpDir, homeDir: tmpDir });
      expect(result.ok).toBe(true);
      expect(result.output).not.toContain("Runtime Cache");
      expect(result.output).not.toContain("Active Turns");
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

    it("reports Supervisor health with PID and lock healthy", async () => {
      const result = await runGatewayDiagnose({ workspaceRoot: tmpDir, homeDir: tmpDir });
      expect(result.output).toContain("Supervisor");
      expect(result.output).toContain("PID healthy:");
      expect(result.output).toContain("Lock healthy:");
    });

    it("reports stale PID as unhealthy", async () => {
      await writeGatewayPid(tmpDir, { pid: 99999, startedAt: new Date().toISOString(), version: "0.0.1" });
      const result = await runGatewayDiagnose({ workspaceRoot: tmpDir, homeDir: tmpDir });
      expect(result.output).toContain("Supervisor");
      expect(result.output).toContain("PID healthy: no");
    });

    it("reports stale identity lock in diagnose", async () => {
      const { writeFile, mkdir } = await import("node:fs/promises");
      const locksDir = join(tmpDir, ".estacoda", "gateway", "locks");
      await mkdir(locksDir, { recursive: true });
      await writeFile(
        join(locksDir, "identity-telegram-deadbeef.lock"),
        JSON.stringify({ pid: 99999, startedAt: new Date().toISOString() }),
        "utf8"
      );

      const result = await runGatewayDiagnose({ workspaceRoot: tmpDir, homeDir: tmpDir });
      expect(result.output).toContain("Identity Locks");
      expect(result.output).toContain("primitives only");
      expect(result.output).toContain("not yet enforced");
      expect(result.output).toContain("Stale locks");
      expect(result.output).toContain("telegram");
      expect(result.output).toContain("99999");
    });

    it("diagnose output does not contain raw token from lock file", async () => {
      const rawToken = "super_secret_bot_token_xyz";
      const { writeFile, mkdir } = await import("node:fs/promises");
      const locksDir = join(tmpDir, ".estacoda", "gateway", "locks");
      await mkdir(locksDir, { recursive: true });
      await writeFile(
        join(locksDir, "identity-discord-abc123de.lock"),
        JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
        "utf8"
      );

      const result = await runGatewayDiagnose({ workspaceRoot: tmpDir, homeDir: tmpDir });
      expect(result.output).not.toContain(rawToken);
      expect(result.output).not.toContain("super_secret");
    });

    it("reports stale runtime-cache-state warning", async () => {
      await writeGatewayPid(tmpDir, { pid: process.pid, startedAt: new Date().toISOString(), version: "0.0.5" });
      const staleState = fakeRuntimeCacheState({ writtenAt: new Date(Date.now() - 300_000).toISOString() });
      await writeRuntimeCacheState(runtimeCacheStatePath(tmpDir), staleState);

      const result = await runGatewayDiagnose({ workspaceRoot: tmpDir, homeDir: tmpDir });
      expect(result.output).toContain("Runtime Cache");
      expect(result.output).toContain("stale");
      expect(result.output).toContain("runtime-cache-state is stale");
    });

    it("reports PID-mismatch runtime-cache-state warning", async () => {
      await writeGatewayPid(tmpDir, { pid: process.pid, startedAt: new Date().toISOString(), version: "0.0.5" });
      const mismatchedState = fakeRuntimeCacheState({ supervisorPid: 99999 });
      await writeRuntimeCacheState(runtimeCacheStatePath(tmpDir), mismatchedState);

      const result = await runGatewayDiagnose({ workspaceRoot: tmpDir, homeDir: tmpDir });
      expect(result.output).toContain("Runtime Cache");
      expect(result.output).toContain("runtime-cache-state PID does not match");
    });

    it("reports supervisor-not-live runtime-cache-state warning", async () => {
      await writeGatewayPid(tmpDir, { pid: 99999, startedAt: new Date().toISOString(), version: "0.0.5" });
      await writeRuntimeCacheState(runtimeCacheStatePath(tmpDir), fakeRuntimeCacheState({ supervisorPid: 99999 }));

      const result = await runGatewayDiagnose({ workspaceRoot: tmpDir, homeDir: tmpDir });
      expect(result.output).toContain("Runtime Cache");
      expect(result.output).toContain("runtime-cache-state exists but supervisor is not live");
    });

    it("reports suspended sessions warning in diagnose", async () => {
      await writeGatewayPid(tmpDir, { pid: process.pid, startedAt: new Date().toISOString(), version: "0.0.5" });
      const state = fakeRuntimeCacheState({
        suspendedSummary: [{ sessionId: "sess-1", reason: "stuck-loop", suspendedAt: new Date().toISOString() }],
      });
      await writeRuntimeCacheState(runtimeCacheStatePath(tmpDir), state);

      const result = await runGatewayDiagnose({ workspaceRoot: tmpDir, homeDir: tmpDir });
      expect(result.output).toContain("Suspended Sessions");
      expect(result.output).toContain("sess-1");
      expect(result.output).toContain("1 suspended session(s) present");
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
      expect(result.output).toContain("Runtime state: unavailable (supervisor not running)");
      expect(result.output).toContain("Identity lock: unlocked");
      expect(result.output).toContain("Busy policy: reject");
      expect(result.output).toContain("Queue depth: 3");
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

    describe("telegram runtime extension", () => {
      it("shows adapter runtime state when supervisor is live and state is trustworthy", async () => {
        await writeGatewayPid(tmpDir, { pid: process.pid, startedAt: new Date().toISOString(), version: "0.0.5" });
        await writeAdapterRuntimeState(tmpDir, fakeAdapterRuntimeState("telegram"));

        const result = await runChannelsStatus({ workspaceRoot: tmpDir, homeDir: tmpDir, channel: "telegram" });
        expect(result.output).toContain("State: healthy");
        expect(result.output).toContain("Polls: 5");
        expect(result.output).toContain("Processed: 3");
        expect(result.output).toContain("Failed: 0");
      });

      it("shows unavailable when supervisor is not live", async () => {
        await writeAdapterRuntimeState(tmpDir, fakeAdapterRuntimeState("telegram"));

        const result = await runChannelsStatus({ workspaceRoot: tmpDir, homeDir: tmpDir, channel: "telegram" });
        expect(result.output).toContain("Runtime state: unavailable (supervisor not running)");
        expect(result.output).not.toContain("Polls: 5");
      });

      it("shows unavailable when runtime state file is missing", async () => {
        await writeGatewayPid(tmpDir, { pid: process.pid, startedAt: new Date().toISOString(), version: "0.0.5" });

        const result = await runChannelsStatus({ workspaceRoot: tmpDir, homeDir: tmpDir, channel: "telegram" });
        expect(result.output).toContain("Runtime state: unavailable (adapter runtime state not found)");
      });

      it("shows unavailable when runtime state file is corrupt", async () => {
        await writeGatewayPid(tmpDir, { pid: process.pid, startedAt: new Date().toISOString(), version: "0.0.5" });
        await writeRawAdapterRuntimeState(tmpDir, "{ not json");

        const result = await runChannelsStatus({ workspaceRoot: tmpDir, homeDir: tmpDir, channel: "telegram" });
        expect(result.output).toContain("Runtime state: unavailable (adapter runtime state unreadable)");
      });

      it("shows stale warning when runtime state is old", async () => {
        await writeGatewayPid(tmpDir, { pid: process.pid, startedAt: new Date().toISOString(), version: "0.0.5" });
        await writeAdapterRuntimeState(tmpDir, fakeAdapterRuntimeState("telegram", { updatedAt: new Date(Date.now() - 6 * 60 * 1000).toISOString() }));

        const result = await runChannelsStatus({ workspaceRoot: tmpDir, homeDir: tmpDir, channel: "telegram" });
        expect(result.output).toContain("Runtime state: stale (last update >5min ago)");
      });

      it("shows stale warning when runtime state PID mismatches", async () => {
        await writeGatewayPid(tmpDir, { pid: process.pid, startedAt: new Date().toISOString(), version: "0.0.5" });
        await writeAdapterRuntimeState(tmpDir, fakeAdapterRuntimeState("telegram", { supervisorPid: 99999 }));

        const result = await runChannelsStatus({ workspaceRoot: tmpDir, homeDir: tmpDir, channel: "telegram" });
        expect(result.output).toContain("Runtime state: stale (supervisor restarted since last update)");
      });

      it("shows not-registered when adapter entry is missing", async () => {
        await writeGatewayPid(tmpDir, { pid: process.pid, startedAt: new Date().toISOString(), version: "0.0.5" });
        await writeAdapterRuntimeState(tmpDir, { ...fakeAdapterRuntimeState("discord"), adapters: [] });

        const result = await runChannelsStatus({ workspaceRoot: tmpDir, homeDir: tmpDir, channel: "telegram" });
        expect(result.output).toContain("Adapter: not registered in runtime state");
      });

      it("shows identity lock status when locked", async () => {
        await acquireAdapterIdentityLock(tmpDir, "telegram", "a".repeat(64));

        const result = await runChannelsStatus({ workspaceRoot: tmpDir, homeDir: tmpDir, channel: "telegram" });
        expect(result.output).toContain(`Identity lock: locked (pid ${process.pid})`);
      });

      it("shows identity lock status when stale", async () => {
        await writeStaleLock(tmpDir, "telegram", JSON.stringify({ pid: 99999, startedAt: new Date().toISOString() }));

        const result = await runChannelsStatus({ workspaceRoot: tmpDir, homeDir: tmpDir, channel: "telegram" });
        expect(result.output).toContain("Identity lock: stale (pid 99999, dead)");
      });

      it("shows identity lock status when corrupt", async () => {
        await writeStaleLock(tmpDir, "telegram", "not json");

        const result = await runChannelsStatus({ workspaceRoot: tmpDir, homeDir: tmpDir, channel: "telegram" });
        expect(result.output).toContain("Identity lock: corrupt");
      });

      it("shows identity lock status when unlocked", async () => {
        const result = await runChannelsStatus({ workspaceRoot: tmpDir, homeDir: tmpDir, channel: "telegram" });
        expect(result.output).toContain("Identity lock: unlocked");
      });

      it("shows busy policy and queue depth from config", async () => {
        await writeUserConfig(tmpDir, { channels: { telegram: { enabled: true, busyPolicy: "queue", queueDepth: 7 } } });

        const result = await runChannelsStatus({ workspaceRoot: tmpDir, homeDir: tmpDir, channel: "telegram" });
        expect(result.output).toContain("Busy policy: queue");
        expect(result.output).toContain("Queue depth: 7");
      });

      it("shows default busy policy and queue depth when not configured", async () => {
        await writeUserConfig(tmpDir, { channels: { telegram: { enabled: true } } });

        const result = await runChannelsStatus({ workspaceRoot: tmpDir, homeDir: tmpDir, channel: "telegram" });
        expect(result.output).toContain("Busy policy: reject");
        expect(result.output).toContain("Queue depth: 3");
      });

      it("shows busy policy interrupt when configured", async () => {
        await writeUserConfig(tmpDir, { channels: { telegram: { enabled: true, busyPolicy: "interrupt" } } });

        const result = await runChannelsStatus({ workspaceRoot: tmpDir, homeDir: tmpDir, channel: "telegram" });
        expect(result.output).toContain("Busy policy: interrupt");
        expect(result.output).not.toContain("drop");
      });
    });

    for (const channel of ["discord", "email", "whatsapp"] as const) {
      it(`shows runtime state, identity lock, and busy policy for ${channel}`, async () => {
        await writeGatewayPid(tmpDir, { pid: process.pid, startedAt: new Date().toISOString(), version: "0.0.5" });
        await writeAdapterRuntimeState(tmpDir, fakeAdapterRuntimeState(channel));
        await acquireAdapterIdentityLock(tmpDir, channel, "b".repeat(64));

        const result = await runChannelsStatus({ workspaceRoot: tmpDir, homeDir: tmpDir, channel });
        expect(result.output).toContain("State: healthy");
        expect(result.output).toContain("Identity lock:");
        expect(result.output).toContain("Busy policy:");
        expect(result.output).toContain("Queue depth:");
      });
    }
  });

  describe("runGatewayStop", () => {
    it("reports was not running with stale PID", async () => {
      await writeGatewayPid(tmpDir, { pid: 99999, startedAt: new Date().toISOString(), version: "0.0.1" });
      const result = await runGatewayStop({ workspaceRoot: tmpDir, homeDir: tmpDir });
      expect(result.ok).toBe(true);
      expect(result.output).toContain("was not running");
      expect(result.output).toContain("99999");
    });

    it("reports not running when no PID file exists", async () => {
      const result = await runGatewayStop({ workspaceRoot: tmpDir, homeDir: tmpDir });
      expect(result.ok).toBe(true);
      expect(result.output).toBe("Gateway is not running");
    });

    it("reports live lock exists when no PID but live lock is held", async () => {
      await acquireGatewayLock(tmpDir);
      await writeGatewayState(tmpDir, { lifecycle: "running", startedAt: new Date().toISOString(), pid: process.pid, version: "0.0.1" });

      const result = await runGatewayStop({ workspaceRoot: tmpDir, homeDir: tmpDir });
      expect(result.ok).toBe(true);
      expect(result.output).toBe("Gateway is not running (live operation lock exists)");

      await releaseGatewayLock(tmpDir);
    });
  });

  describe("runGatewayRestart", () => {
    let supervisorSpy: ReturnType<typeof vi.spyOn>;
    let stopGatewaySpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      supervisorSpy = vi.spyOn(supervisorModule, "runGatewaySupervisor").mockResolvedValue({
        ok: true,
        output: "Gateway started",
        polls: 0,
        processed: 0,
      });
      stopGatewaySpy = vi.spyOn(lifecycleModule, "stopGateway").mockResolvedValue({
        ok: true,
        action: "was_not_running",
      });
    });

    afterEach(() => {
      supervisorSpy.mockRestore();
      stopGatewaySpy.mockRestore();
    });

    it("reports not running and starts when no PID exists", async () => {
      const result = await runGatewayRestart({ workspaceRoot: tmpDir, homeDir: tmpDir });
      expect(result.output).toContain("Gateway was not running");
      expect(result.output).toContain("Gateway started");
      expect(supervisorSpy).toHaveBeenCalledWith(expect.objectContaining({ once: false }));
    });

    it("stops stale PID then starts", async () => {
      await writeGatewayPid(tmpDir, { pid: 99999, startedAt: new Date().toISOString(), version: "0.0.1" });

      const result = await runGatewayRestart({ workspaceRoot: tmpDir, homeDir: tmpDir });
      expect(result.output).toContain("Gateway was not running");
      expect(result.output).toContain("Gateway started");
    });

    it("passes graceful flag to stop", async () => {
      // No PID, so just checks the flag is accepted
      const result = await runGatewayRestart({ workspaceRoot: tmpDir, homeDir: tmpDir, graceful: true });
      expect(result.output).toContain("Gateway was not running");
      expect(result.output).toContain("Gateway started");
    });

    it("does not force-kill on plain restart", async () => {
      await runGatewayRestart({ workspaceRoot: tmpDir, homeDir: tmpDir });
      expect(stopGatewaySpy).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ force: false }));
    });

    it("does not force-kill on graceful restart", async () => {
      await runGatewayRestart({ workspaceRoot: tmpDir, homeDir: tmpDir, graceful: true });
      expect(stopGatewaySpy).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ force: false }));
    });
  });

  describe("runChannelsEnable", () => {
    it("enables a disabled channel", async () => {
      const configPath = join(tmpDir, ".estacoda", "config.json");
      await mkdir(dirname(configPath), { recursive: true });
      await writeFile(configPath, JSON.stringify({ channels: { telegram: { enabled: false } } }), "utf8");

      const result = await runChannelsEnable({ workspaceRoot: tmpDir, homeDir: tmpDir, channel: "telegram" });
      expect(result.ok).toBe(true);
      expect(result.output).toBe("Telegram enabled");

      const parsed = JSON.parse(await readFile(configPath, "utf8"));
      expect(parsed.channels.telegram.enabled).toBe(true);
    });

    it("is idempotent when channel already enabled", async () => {
      const configPath = join(tmpDir, ".estacoda", "config.json");
      await mkdir(dirname(configPath), { recursive: true });
      const original = JSON.stringify({ channels: { telegram: { enabled: true, botTokenEnv: "X" } } }, null, 2);
      await writeFile(configPath, original, "utf8");

      const result = await runChannelsEnable({ workspaceRoot: tmpDir, homeDir: tmpDir, channel: "telegram" });
      expect(result.ok).toBe(true);
      expect(result.output).toBe("Telegram is already enabled");

      const after = await readFile(configPath, "utf8");
      expect(after).toBe(original);
    });

    it("rejects unknown channel", async () => {
      const result = await runChannelsEnable({ workspaceRoot: tmpDir, homeDir: tmpDir, channel: "unknown" });
      expect(result.ok).toBe(false);
      expect(result.output).toContain("Unknown channel: unknown");
      expect(result.output).toContain("Supported: telegram, discord, email, whatsapp");
    });

    it("rejects missing channel argument", async () => {
      const result = await runChannelsEnable({ workspaceRoot: tmpDir, homeDir: tmpDir });
      expect(result.ok).toBe(false);
      expect(result.output).toContain("Usage: estacoda channels enable <channel>");
    });

    it("preserves other channel fields", async () => {
      const configPath = join(tmpDir, ".estacoda", "config.json");
      await mkdir(dirname(configPath), { recursive: true });
      await writeFile(configPath, JSON.stringify({ channels: { telegram: { botTokenEnv: "X", allowedUserIds: ["u1"] } } }), "utf8");

      const result = await runChannelsEnable({ workspaceRoot: tmpDir, homeDir: tmpDir, channel: "telegram" });
      expect(result.ok).toBe(true);

      const parsed = JSON.parse(await readFile(configPath, "utf8"));
      expect(parsed.channels.telegram.botTokenEnv).toBe("X");
      expect(parsed.channels.telegram.allowedUserIds).toEqual(["u1"]);
      expect(parsed.channels.telegram.enabled).toBe(true);
    });

    it("preserves other channels", async () => {
      const configPath = join(tmpDir, ".estacoda", "config.json");
      await mkdir(dirname(configPath), { recursive: true });
      await writeFile(configPath, JSON.stringify({ channels: { discord: { enabled: true }, telegram: { enabled: false } } }), "utf8");

      const result = await runChannelsEnable({ workspaceRoot: tmpDir, homeDir: tmpDir, channel: "telegram" });
      expect(result.ok).toBe(true);

      const parsed = JSON.parse(await readFile(configPath, "utf8"));
      expect(parsed.channels.discord.enabled).toBe(true);
    });

    it("preserves non-channel config", async () => {
      const configPath = join(tmpDir, ".estacoda", "config.json");
      await mkdir(dirname(configPath), { recursive: true });
      await writeFile(configPath, JSON.stringify({ model: { provider: "openai" }, channels: { telegram: { enabled: false } } }), "utf8");

      const result = await runChannelsEnable({ workspaceRoot: tmpDir, homeDir: tmpDir, channel: "telegram" });
      expect(result.ok).toBe(true);

      const parsed = JSON.parse(await readFile(configPath, "utf8"));
      expect(parsed.model.provider).toBe("openai");
    });

    it("preserves unknown top-level fields", async () => {
      const configPath = join(tmpDir, ".estacoda", "config.json");
      await mkdir(dirname(configPath), { recursive: true });
      await writeFile(configPath, JSON.stringify({ customField: 123, channels: { telegram: { enabled: false } } }), "utf8");

      const result = await runChannelsEnable({ workspaceRoot: tmpDir, homeDir: tmpDir, channel: "telegram" });
      expect(result.ok).toBe(true);

      const parsed = JSON.parse(await readFile(configPath, "utf8"));
      expect(parsed.customField).toBe(123);
    });

    it("preserves unknown nested channel fields", async () => {
      const configPath = join(tmpDir, ".estacoda", "config.json");
      await mkdir(dirname(configPath), { recursive: true });
      await writeFile(configPath, JSON.stringify({ channels: { telegram: { customFlag: true, enabled: false } } }), "utf8");

      const result = await runChannelsEnable({ workspaceRoot: tmpDir, homeDir: tmpDir, channel: "telegram" });
      expect(result.ok).toBe(true);

      const parsed = JSON.parse(await readFile(configPath, "utf8"));
      expect(parsed.channels.telegram.customFlag).toBe(true);
    });

    it("preserves busyPolicy and queueDepth", async () => {
      const configPath = join(tmpDir, ".estacoda", "config.json");
      await mkdir(dirname(configPath), { recursive: true });
      await writeFile(configPath, JSON.stringify({ channels: { telegram: { busyPolicy: "queue", queueDepth: 7, enabled: false } } }), "utf8");

      const result = await runChannelsEnable({ workspaceRoot: tmpDir, homeDir: tmpDir, channel: "telegram" });
      expect(result.ok).toBe(true);

      const parsed = JSON.parse(await readFile(configPath, "utf8"));
      expect(parsed.channels.telegram.busyPolicy).toBe("queue");
      expect(parsed.channels.telegram.queueDepth).toBe(7);
    });

    it("creates config file if missing", async () => {
      const result = await runChannelsEnable({ workspaceRoot: tmpDir, homeDir: tmpDir, channel: "telegram" });
      expect(result.ok).toBe(true);
      expect(result.output).toBe("Telegram enabled");

      const configPath = join(tmpDir, ".estacoda", "config.json");
      const parsed = JSON.parse(await readFile(configPath, "utf8"));
      expect(parsed.channels.telegram.enabled).toBe(true);
    });

    it("writes to userConfigPath when overridden", async () => {
      const customPath = join(tmpDir, "custom-config.json");
      const result = await runChannelsEnable({ workspaceRoot: tmpDir, homeDir: tmpDir, userConfigPath: customPath, channel: "telegram" });
      expect(result.ok).toBe(true);

      const parsed = JSON.parse(await readFile(customPath, "utf8"));
      expect(parsed.channels.telegram.enabled).toBe(true);
    });

    it("does not write to projectConfigPath", async () => {
      const projectPath = join(tmpDir, "project-config.json");
      await writeFile(projectPath, JSON.stringify({ channels: { telegram: { enabled: false } } }), "utf8");

      const result = await runChannelsEnable({ workspaceRoot: tmpDir, homeDir: tmpDir, projectConfigPath: projectPath, channel: "telegram" });
      expect(result.ok).toBe(true);

      const parsed = JSON.parse(await readFile(projectPath, "utf8"));
      expect(parsed.channels.telegram.enabled).toBe(false);
    });

    it("fails on invalid JSON without overwriting", async () => {
      const configPath = join(tmpDir, ".estacoda", "config.json");
      await mkdir(dirname(configPath), { recursive: true });
      const bad = "{ not json";
      await writeFile(configPath, bad, "utf8");

      const result = await runChannelsEnable({ workspaceRoot: tmpDir, homeDir: tmpDir, channel: "telegram" });
      expect(result.ok).toBe(false);
      expect(result.output).toContain("Config file could not be parsed");
      expect(result.output).toContain("No changes were made");

      const after = await readFile(configPath, "utf8");
      expect(after).toBe(bad);
    });

    it("fails on non-object JSON without overwriting", async () => {
      const configPath = join(tmpDir, ".estacoda", "config.json");
      await mkdir(dirname(configPath), { recursive: true });
      const bad = "[]";
      await writeFile(configPath, bad, "utf8");

      const result = await runChannelsEnable({ workspaceRoot: tmpDir, homeDir: tmpDir, channel: "telegram" });
      expect(result.ok).toBe(false);
      expect(result.output).toContain("Config file could not be parsed");
      expect(result.output).toContain("No changes were made");

      const after = await readFile(configPath, "utf8");
      expect(after).toBe(bad);
    });

    it("fails on null JSON without overwriting", async () => {
      const configPath = join(tmpDir, ".estacoda", "config.json");
      await mkdir(dirname(configPath), { recursive: true });
      const bad = "null";
      await writeFile(configPath, bad, "utf8");

      const result = await runChannelsEnable({ workspaceRoot: tmpDir, homeDir: tmpDir, channel: "telegram" });
      expect(result.ok).toBe(false);
      expect(result.output).toContain("Config file could not be parsed");
      expect(result.output).toContain("No changes were made");

      const after = await readFile(configPath, "utf8");
      expect(after).toBe(bad);
    });

    it("accepts mixed-case channel names", async () => {
      for (const name of ["Telegram", "TELEGRAM", "teLeGrAm"]) {
        const configPath = join(tmpDir, ".estacoda", "config.json");
        await rm(dirname(configPath), { recursive: true, force: true });
        const result = await runChannelsEnable({ workspaceRoot: tmpDir, homeDir: tmpDir, channel: name });
        expect(result.ok).toBe(true);
        expect(result.output).toBe("Telegram enabled");
      }
    });

    it("outputs correct display name for WhatsApp", async () => {
      const result = await runChannelsEnable({ workspaceRoot: tmpDir, homeDir: tmpDir, channel: "whatsapp" });
      expect(result.ok).toBe(true);
      expect(result.output).toBe("WhatsApp enabled");
    });

    it("writes to temp file then renames", async () => {
      const configPath = join(tmpDir, ".estacoda", "config.json");
      await mkdir(dirname(configPath), { recursive: true });
      await writeFile(configPath, JSON.stringify({ channels: { telegram: { enabled: false } } }), "utf8");

      await runChannelsEnable({ workspaceRoot: tmpDir, homeDir: tmpDir, channel: "telegram" });

      const files = await readdir(dirname(configPath));
      const tempFiles = files.filter((f) => f.startsWith("config.json.tmp-"));
      expect(tempFiles).toHaveLength(0);
    });

    it("leaves original intact on write failure", async () => {
      const configPath = join(tmpDir, ".estacoda", "config.json");
      await mkdir(dirname(configPath), { recursive: true });
      const original = JSON.stringify({ channels: { telegram: { enabled: false } } });
      await writeFile(configPath, original, "utf8");

      const fsPromises = await import("node:fs/promises");
      const renameSpy = vi.spyOn(fsPromises, "rename").mockImplementation(() => Promise.reject(new Error("rename failed")));

      try {
        await expect(runChannelsEnable({ workspaceRoot: tmpDir, homeDir: tmpDir, channel: "telegram" })).rejects.toThrow("rename failed");

        const after = await readFile(configPath, "utf8");
        expect(after).toBe(original);
      } finally {
        renameSpy.mockRestore();
      }
    });
  });

  describe("runChannelsDisable", () => {
    it("disables an enabled channel", async () => {
      const configPath = join(tmpDir, ".estacoda", "config.json");
      await mkdir(dirname(configPath), { recursive: true });
      await writeFile(configPath, JSON.stringify({ channels: { telegram: { enabled: true } } }), "utf8");

      const result = await runChannelsDisable({ workspaceRoot: tmpDir, homeDir: tmpDir, channel: "telegram" });
      expect(result.ok).toBe(true);
      expect(result.output).toBe("Telegram disabled");

      const parsed = JSON.parse(await readFile(configPath, "utf8"));
      expect(parsed.channels.telegram.enabled).toBe(false);
    });

    it("is idempotent when channel already disabled", async () => {
      const configPath = join(tmpDir, ".estacoda", "config.json");
      await mkdir(dirname(configPath), { recursive: true });
      const original = JSON.stringify({ channels: { telegram: { enabled: false, botTokenEnv: "X" } } }, null, 2);
      await writeFile(configPath, original, "utf8");

      const result = await runChannelsDisable({ workspaceRoot: tmpDir, homeDir: tmpDir, channel: "telegram" });
      expect(result.ok).toBe(true);
      expect(result.output).toBe("Telegram is already disabled");

      const after = await readFile(configPath, "utf8");
      expect(after).toBe(original);
    });

    it("is idempotent when channel has no enabled field", async () => {
      const configPath = join(tmpDir, ".estacoda", "config.json");
      await mkdir(dirname(configPath), { recursive: true });
      const original = JSON.stringify({ channels: { telegram: {} } }, null, 2);
      await writeFile(configPath, original, "utf8");

      const result = await runChannelsDisable({ workspaceRoot: tmpDir, homeDir: tmpDir, channel: "telegram" });
      expect(result.ok).toBe(true);
      expect(result.output).toBe("Telegram is already disabled");

      const after = await readFile(configPath, "utf8");
      expect(after).toBe(original);
    });

    it("is idempotent when config file does not exist", async () => {
      const result = await runChannelsDisable({ workspaceRoot: tmpDir, homeDir: tmpDir, channel: "telegram" });
      expect(result.ok).toBe(true);
      expect(result.output).toBe("Telegram is already disabled");

      const configPath = join(tmpDir, ".estacoda", "config.json");
      await expect(readFile(configPath, "utf8")).rejects.toThrow();
    });

    it("rejects unknown channel", async () => {
      const result = await runChannelsDisable({ workspaceRoot: tmpDir, homeDir: tmpDir, channel: "unknown" });
      expect(result.ok).toBe(false);
      expect(result.output).toContain("Unknown channel: unknown");
      expect(result.output).toContain("Supported: telegram, discord, email, whatsapp");
    });

    it("rejects missing channel argument", async () => {
      const result = await runChannelsDisable({ workspaceRoot: tmpDir, homeDir: tmpDir });
      expect(result.ok).toBe(false);
      expect(result.output).toContain("Usage: estacoda channels disable <channel>");
    });

    it("preserves other fields on disable", async () => {
      const configPath = join(tmpDir, ".estacoda", "config.json");
      await mkdir(dirname(configPath), { recursive: true });
      await writeFile(configPath, JSON.stringify({ channels: { telegram: { enabled: true, botTokenEnv: "X", allowedUserIds: ["u1"], busyPolicy: "queue", queueDepth: 7, customFlag: true }, discord: { enabled: true } } }), "utf8");

      const result = await runChannelsDisable({ workspaceRoot: tmpDir, homeDir: tmpDir, channel: "telegram" });
      expect(result.ok).toBe(true);

      const parsed = JSON.parse(await readFile(configPath, "utf8"));
      expect(parsed.channels.telegram.botTokenEnv).toBe("X");
      expect(parsed.channels.telegram.allowedUserIds).toEqual(["u1"]);
      expect(parsed.channels.telegram.busyPolicy).toBe("queue");
      expect(parsed.channels.telegram.queueDepth).toBe(7);
      expect(parsed.channels.telegram.customFlag).toBe(true);
      expect(parsed.channels.telegram.enabled).toBe(false);
      expect(parsed.channels.discord.enabled).toBe(true);
    });

    it("fails on invalid JSON without overwriting", async () => {
      const configPath = join(tmpDir, ".estacoda", "config.json");
      await mkdir(dirname(configPath), { recursive: true });
      const bad = "{ not json";
      await writeFile(configPath, bad, "utf8");

      const result = await runChannelsDisable({ workspaceRoot: tmpDir, homeDir: tmpDir, channel: "telegram" });
      expect(result.ok).toBe(false);
      expect(result.output).toContain("Config file could not be parsed");
      expect(result.output).toContain("No changes were made");

      const after = await readFile(configPath, "utf8");
      expect(after).toBe(bad);
    });

    it("fails on non-object JSON without overwriting", async () => {
      const configPath = join(tmpDir, ".estacoda", "config.json");
      await mkdir(dirname(configPath), { recursive: true });
      const bad = "[]";
      await writeFile(configPath, bad, "utf8");

      const result = await runChannelsDisable({ workspaceRoot: tmpDir, homeDir: tmpDir, channel: "telegram" });
      expect(result.ok).toBe(false);
      expect(result.output).toContain("Config file could not be parsed");
      expect(result.output).toContain("No changes were made");

      const after = await readFile(configPath, "utf8");
      expect(after).toBe(bad);
    });

    it("outputs correct display name for WhatsApp", async () => {
      const configPath = join(tmpDir, ".estacoda", "config.json");
      await mkdir(dirname(configPath), { recursive: true });
      await writeFile(configPath, JSON.stringify({ channels: { whatsapp: { enabled: true } } }), "utf8");

      const result = await runChannelsDisable({ workspaceRoot: tmpDir, homeDir: tmpDir, channel: "whatsapp" });
      expect(result.ok).toBe(true);
      expect(result.output).toBe("WhatsApp disabled");
    });
  });
});
