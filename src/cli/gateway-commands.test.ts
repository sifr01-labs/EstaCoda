import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir, chmod } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";

const fsPromisesMock = vi.hoisted(() => ({
  rename: vi.fn(),
}));

const childProcessMock = vi.hoisted(() => ({
  spawn: vi.fn(),
}));

const serviceManagerMock = vi.hoisted(() => ({
  detectServiceManager: vi.fn(),
  installService: vi.fn(),
  uninstallService: vi.fn(),
  probeServiceState: vi.fn(),
  restartService: vi.fn(),
  startService: vi.fn(),
  stopService: vi.fn(),
}));

const execResolverMock = vi.hoisted(() => ({
  resolveGatewayExec: vi.fn(),
}));

const installMethodMock = vi.hoisted(() => ({
  detectInstallMethod: vi.fn(),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  fsPromisesMock.rename.mockImplementation(actual.rename);
  return {
    ...actual,
    rename: fsPromisesMock.rename,
  };
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: childProcessMock.spawn,
  };
});

vi.mock("../gateway/service-manager.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../gateway/service-manager.js")>();
  return {
    ...actual,
    detectServiceManager: serviceManagerMock.detectServiceManager,
    installService: serviceManagerMock.installService,
    uninstallService: serviceManagerMock.uninstallService,
    probeServiceState: serviceManagerMock.probeServiceState,
    restartService: serviceManagerMock.restartService,
    startService: serviceManagerMock.startService,
    stopService: serviceManagerMock.stopService,
  };
});

vi.mock("../gateway/service-exec-resolver.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../gateway/service-exec-resolver.js")>();
  return {
    ...actual,
    resolveGatewayExec: execResolverMock.resolveGatewayExec,
  };
});

vi.mock("../lifecycle/install-method.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lifecycle/install-method.js")>();
  return {
    ...actual,
    detectInstallMethod: installMethodMock.detectInstallMethod,
  };
});

import {
  runGatewayStatus,
  runGatewayDiagnose,
  runChannelsList,
  runChannelsStatus,
  runChannelsEnable,
  runChannelsDisable,
  runGatewayStop,
  runGatewayRestart,
  runGatewayStartDryRun,
  runGatewayStartService,
  runGatewayApprovals,
  runGatewayInstallService,
  runGatewayUninstallService,
} from "./gateway-commands.js";
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
import { readGatewayRestartPlannedMarker } from "../runtime/gateway-restart-marker.js";
import { writeAdapterRuntimeState, RUNTIME_STATE_FILE } from "../gateway/adapter-runtime-state.js";
import type { PersistedRuntimeState, AdapterRuntimeState } from "../gateway/adapter-runtime-state.js";
import { openDefaultSQLiteDatabase } from "../storage/factory.js";
import { createSQLiteSessionDB } from "../session/session-setup.js";
import { SessionFinalizationQueue } from "../session/session-finalization-queue.js";
import { createCommandHash } from "../gateway/approval-queue.js";
import { resolveGlobalStateHome, resolveProfileStateHome, type ProfileStatePaths } from "../config/profile-home.js";

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
  const configPath = defaultProfileConfigPath(homeDir);
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, JSON.stringify(config), "utf8");
}

function defaultProfileConfigPath(homeDir: string): string {
  return resolveProfileStateHome({ homeDir, profileId: "default" }).configPath;
}

async function writeRawAdapterRuntimeState(homeDir: string, content: string): Promise<void> {
  const path = join(resolveProfileStateHome({ homeDir, profileId: "default" }).gatewayStatePath, RUNTIME_STATE_FILE);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

async function writeStaleLock(homeDir: string, kind: string, content: string): Promise<void> {
  const locksDir = join(resolveProfileStateHome({ homeDir, profileId: "default" }).gatewayStatePath, "locks");
  await mkdir(locksDir, { recursive: true });
  await writeFile(join(locksDir, `identity-${kind}-deadbeef.lock`), content, "utf8");
}

async function createGatewayStateDirs(paths: ProfileStatePaths): Promise<void> {
  await mkdir(join(paths.cronPath, "output"), { recursive: true });
  await mkdir(join(paths.cronPath, "locks"), { recursive: true });
  await mkdir(paths.logsPath, { recursive: true });
}

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "estacoda-gateway-test-"));
}

async function withEnv<T>(env: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const key of Object.keys(env)) {
    previous.set(key, process.env[key]);
    const value = env[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

describe("gateway commands", () => {
  let tmpDir: string;
  let stateRoot: string;
  let profilePaths: ProfileStatePaths;

  beforeEach(async () => {
    tmpDir = await makeTempDir();
    stateRoot = join(tmpDir, ".estacoda");
    profilePaths = resolveProfileStateHome({ homeDir: tmpDir, profileId: "default" });
    await mkdir(stateRoot, { recursive: true });
    fsPromisesMock.rename.mockClear();
    childProcessMock.spawn.mockReset();
    serviceManagerMock.detectServiceManager.mockReset();
    serviceManagerMock.installService.mockReset();
    serviceManagerMock.uninstallService.mockReset();
    serviceManagerMock.probeServiceState.mockReset();
    serviceManagerMock.restartService.mockReset();
    serviceManagerMock.startService.mockReset();
    serviceManagerMock.stopService.mockReset();
    execResolverMock.resolveGatewayExec.mockReset();
    installMethodMock.detectInstallMethod.mockReset();
    serviceManagerMock.detectServiceManager.mockReturnValue("none");
    serviceManagerMock.restartService.mockResolvedValue({ ok: true });
    serviceManagerMock.startService.mockResolvedValue({ ok: true });
    serviceManagerMock.stopService.mockResolvedValue({ ok: true });
    installMethodMock.detectInstallMethod.mockResolvedValue({
      method: "unknown",
      source: "unknown",
      recommendedUpdateCommand: "reinstall using documented install path",
      canSelfUpdate: false,
      reason: "test default",
    });
    execResolverMock.resolveGatewayExec.mockReturnValue({
      ok: true,
      resolved: {
        mode: "compiled",
        command: "/usr/bin/node",
        args: [join(tmpDir, "dist", "index.js")],
        cwd: tmpDir,
      },
    });
    serviceManagerMock.probeServiceState.mockImplementation(async (options: { profileId: string; system?: boolean }) => ({
      kind: "none",
      installed: false,
      scope: options.system ? "system" : "user",
      activeState: "unknown",
      unitName: `estacoda-gateway-${options.profileId}.service`,
      profileId: options.profileId,
    }));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe("runGatewayStatus", () => {
    it("returns basic status with no config", async () => {
      const result = await runGatewayStatus({ workspaceRoot: tmpDir, homeDir: tmpDir });
      expect(result.ok).toBe(true);
      expect(result.output).toContain("EstaCoda gateway status");
      expect(result.output).toContain("Durable tasks");
      expect(result.output).toContain("Active: 0");
      expect(result.output).toContain("Process");
      expect(result.output).toContain("Channels");
      expect(result.output).toContain("Telegram:");
      expect(result.output).toContain("Discord:");
      expect(result.output).toContain("Email:");
      expect(result.output).toContain("WhatsApp:");
      expect(result.output).toContain("Memory finalization");
      expect(result.output).toContain("Pending: 0");
    });

    it("shows profile-scoped background memory finalization health", async () => {
      const db = await createSQLiteSessionDB({ homeDir: tmpDir });
      const queue = new SessionFinalizationQueue({ db: db.db });
      await db.createSession({ id: "finalize-session", profileId: "default" });
      await db.appendMessage({
        id: "finalize-message",
        sessionId: "finalize-session",
        role: "user",
        content: "private status content",
      });
      queue.enqueue({ profileId: "default", sessionId: "finalize-session", reason: "cli-exit" });
      db.close();

      const result = await runGatewayStatus({ workspaceRoot: tmpDir, homeDir: tmpDir });
      expect(result.output).toContain("Memory finalization");
      expect(result.output).toContain("Pending: 1");
      expect(result.output).not.toContain("private status content");
    });

    it("shows cron jobs", async () => {
      const cronStore = new CronStore({
        path: join(profilePaths.cronPath, "jobs.json"),
        outputRoot: join(profilePaths.cronPath, "output"),
      });
      await cronStore.create({ schedule: "1h", prompt: "test job" });

      const result = await runGatewayStatus({ workspaceRoot: tmpDir, homeDir: tmpDir });
      expect(result.ok).toBe(true);
      expect(result.output).toContain("Jobs: 1 total, 1 active");
    });

    it("handles unreadable cron execution DB gracefully", async () => {
      await mkdir(join(stateRoot, "sessions.sqlite"), { recursive: true });

      const result = await runGatewayStatus({ workspaceRoot: tmpDir, homeDir: tmpDir });
      expect(result.ok).toBe(true);
      expect(result.output).toContain("EstaCoda gateway status");
      expect(result.output).toContain("Recent cron failures");
      expect(result.output).toContain("- none");
    });

    it("shows recent cron failures", async () => {
      const dbPath = join(stateRoot, "sessions.sqlite");
      const db = openDefaultSQLiteDatabase({ path: dbPath });
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
      const executionStore = new CronExecutionStore({ db });
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
      const router = new DeliveryRouter({
        homeDir: tmpDir,
        deliveryRoot: join(profilePaths.gatewayStatePath, "delivery"),
        deliveryErrorLogPath: join(profilePaths.gatewayStatePath, "logs", "delivery-errors.jsonl"),
      });
      await router.deliverText([{ kind: "channel", platform: "telegram", chatId: "123" }], "test");

      const result = await runGatewayStatus({ workspaceRoot: tmpDir, homeDir: tmpDir });
      expect(result.ok).toBe(true);
      expect(result.output).toContain("Recent delivery errors");
      expect(result.output).toContain("telegram:123");
    });

    it("shows surface pointers", async () => {
      const store = new FileSurfacePointerStore({ path: join(profilePaths.gatewayStatePath, "surface-pointers.json") });
      await store.setPointer("telegram", "chat-1", { sessionId: "sess-1", attachedAt: "2024-01-01T00:00:00Z", homeDelivery: "local" });

      const result = await runGatewayStatus({ workspaceRoot: tmpDir, homeDir: tmpDir });
      expect(result.ok).toBe(true);
      expect(result.output).toContain("Surface pointers");
      expect(result.output).toContain("telegram:chat-1");
      expect(result.output).toContain("sess-1");
      expect(result.output).toContain("home=local");
    });

    it("shows approvals block with policy and granted count", async () => {
      const store = new ChannelApprovalStore({ path: join(profilePaths.gatewayStatePath, "channel-approvals.json") });
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
      await writeGatewayState(profilePaths, {
        lifecycle: "running",
        startedAt: new Date().toISOString(),
        pid: process.pid,
        version: "0.0.5",
        backgroundServices: { tasks: "running", cron: "running" }
      });
      await writeGatewayPid(profilePaths, { pid: process.pid, startedAt: new Date().toISOString(), version: "0.0.5" });

      const result = await runGatewayStatus({ workspaceRoot: tmpDir, homeDir: tmpDir });
      expect(result.ok).toBe(true);
      expect(result.output).toContain("Supervisor");
      expect(result.output).toContain(`PID: ${process.pid}`);
      expect(result.output).toContain("State: running");
      expect(result.output).toContain("Version: 0.0.5");
      expect(result.output).toContain("Task host: running");
      expect(result.output).toContain("Cron host: running");
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
      await acquireAdapterIdentityLock(profilePaths, "telegram", hash);

      const result = await runGatewayStatus({ workspaceRoot: tmpDir, homeDir: tmpDir });
      expect(result.ok).toBe(true);
      expect(result.output).not.toContain("Identity Locks");
      expect(result.output).not.toContain("primitives only");
    });

    it("shows corrupt identity lock in status", async () => {
      const { writeFile, mkdir } = await import("node:fs/promises");
      const locksDir = join(profilePaths.gatewayStatePath, "locks");
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
      const locksDir = join(profilePaths.gatewayStatePath, "locks");
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
      await writeGatewayPid(profilePaths, { pid: process.pid, startedAt: new Date().toISOString(), version: "0.0.5" });
      await writeRuntimeCacheState(runtimeCacheStatePath(profilePaths), fakeRuntimeCacheState());

      const result = await runGatewayStatus({ workspaceRoot: tmpDir, homeDir: tmpDir });
      expect(result.ok).toBe(true);
      expect(result.output).toContain("Runtime Cache");
      expect(result.output).toContain("Active Turns");
      expect(result.output).toContain("Entries:");
      expect(result.output).toContain("Active turns:");
    });

    it("omits runtime-cache blocks when state is stale", async () => {
      await writeGatewayPid(profilePaths, { pid: process.pid, startedAt: new Date().toISOString(), version: "0.0.5" });
      const staleState = fakeRuntimeCacheState({ writtenAt: new Date(Date.now() - 300_000).toISOString() });
      await writeRuntimeCacheState(runtimeCacheStatePath(profilePaths), staleState);

      const result = await runGatewayStatus({ workspaceRoot: tmpDir, homeDir: tmpDir });
      expect(result.ok).toBe(true);
      expect(result.output).not.toContain("Runtime Cache");
      expect(result.output).not.toContain("Active Turns");
    });

    it("omits runtime-cache blocks when PID mismatches", async () => {
      await writeGatewayPid(profilePaths, { pid: process.pid, startedAt: new Date().toISOString(), version: "0.0.5" });
      const mismatchedState = fakeRuntimeCacheState({ supervisorPid: 99999 });
      await writeRuntimeCacheState(runtimeCacheStatePath(profilePaths), mismatchedState);

      const result = await runGatewayStatus({ workspaceRoot: tmpDir, homeDir: tmpDir });
      expect(result.ok).toBe(true);
      expect(result.output).not.toContain("Runtime Cache");
      expect(result.output).not.toContain("Active Turns");
    });

    it("omits runtime-cache blocks when supervisor is not live", async () => {
      await writeGatewayPid(profilePaths, { pid: 99999, startedAt: new Date().toISOString(), version: "0.0.5" });
      await writeRuntimeCacheState(runtimeCacheStatePath(profilePaths), fakeRuntimeCacheState({ supervisorPid: 99999 }));

      const result = await runGatewayStatus({ workspaceRoot: tmpDir, homeDir: tmpDir });
      expect(result.ok).toBe(true);
      expect(result.output).not.toContain("Runtime Cache");
      expect(result.output).not.toContain("Active Turns");
    });
  });

  describe("runGatewayApprovals", () => {
    it("lists pending approvals for the selected profile without raw payloads", async () => {
      const globalPaths = resolveGlobalStateHome({ homeDir: tmpDir });
      const sessionDb = await createSQLiteSessionDB({ path: globalPaths.sessionsSqlitePath });
      try {
        sessionDb.db.query(
          `insert into pending_approvals (
            id, session_id, profile_id, command_preview, command_hash, command_payload,
            tool_name, requested_at, expires_at, status, resolved_at, resolved_by, channel, chat_id
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', null, null, ?, ?)`
        ).run(
          "approval-a",
          "session-a",
          "default",
          "sudo apt update",
          createCommandHash("sudo apt update SECRET=abc"),
          "sudo apt update SECRET=abc",
          "terminal.run",
          "2026-05-18T10:00:00.000Z",
          "2099-05-18T10:05:00.000Z",
          "telegram",
          "chat-a"
        );

        const result = await runGatewayApprovals({ workspaceRoot: tmpDir, homeDir: tmpDir }, ["list"]);

        expect(result.ok).toBe(true);
        expect(result.output).toContain("approval-a");
        expect(result.output).toContain("sudo apt update");
        expect(result.output).toContain(createCommandHash("sudo apt update SECRET=abc"));
        expect(result.output).not.toContain("SECRET=abc");
      } finally {
        sessionDb.close();
      }
    });

    it("resolves pending approvals by id for the selected profile", async () => {
      const globalPaths = resolveGlobalStateHome({ homeDir: tmpDir });
      const sessionDb = await createSQLiteSessionDB({ path: globalPaths.sessionsSqlitePath });
      try {
        sessionDb.db.query(
          `insert into pending_approvals (
            id, session_id, profile_id, command_preview, command_hash, command_payload,
            tool_name, requested_at, expires_at, status, resolved_at, resolved_by, channel, chat_id
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', null, null, ?, ?)`
        ).run(
          "approval-a",
          "session-a",
          "default",
          "sudo apt update",
          createCommandHash("sudo apt update"),
          "sudo apt update",
          "terminal.run",
          "2026-05-18T10:00:00.000Z",
          "2099-05-18T10:05:00.000Z",
          "telegram",
          "chat-a"
        );

        const result = await runGatewayApprovals({ workspaceRoot: tmpDir, homeDir: tmpDir }, ["approve", "approval-a"]);
        const row = sessionDb.db.query<{ status: string; command_payload: string | null }>(
          "select status, command_payload from pending_approvals where id = ?"
        ).get("approval-a");

        expect(result.ok).toBe(true);
        expect(result.output).toContain("approved");
        expect(row).toMatchObject({ status: "approved", command_payload: null });
      } finally {
        sessionDb.close();
      }
    });

    it("denies pending approvals by id for the selected profile", async () => {
      const globalPaths = resolveGlobalStateHome({ homeDir: tmpDir });
      const sessionDb = await createSQLiteSessionDB({ path: globalPaths.sessionsSqlitePath });
      try {
        sessionDb.db.query(
          `insert into pending_approvals (
            id, session_id, profile_id, command_preview, command_hash, command_payload,
            tool_name, requested_at, expires_at, status, resolved_at, resolved_by, channel, chat_id
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', null, null, ?, ?)`
        ).run(
          "approval-deny",
          "session-a",
          "default",
          "sudo apt update",
          createCommandHash("sudo apt update"),
          "sudo apt update",
          "terminal.run",
          "2026-05-18T10:00:00.000Z",
          "2099-05-18T10:05:00.000Z",
          "telegram",
          "chat-a"
        );

        const result = await runGatewayApprovals({ workspaceRoot: tmpDir, homeDir: tmpDir }, ["deny", "approval-deny"]);
        const row = sessionDb.db.query<{ status: string; command_payload: string | null }>(
          "select status, command_payload from pending_approvals where id = ?"
        ).get("approval-deny");

        expect(result.ok).toBe(true);
        expect(result.output).toContain("denied");
        expect(row).toMatchObject({ status: "denied", command_payload: null });
      } finally {
        sessionDb.close();
      }
    });
  });

  describe("gateway service commands", () => {
    it("installs a user service with source-mode warnings", async () => {
      serviceManagerMock.detectServiceManager.mockReturnValue("systemd-user");
      serviceManagerMock.installService.mockResolvedValue({
        ok: true,
        mode: "source",
        unitName: "estacoda-gateway-default-37a8eec1.service",
        logCommand: "journalctl --user -u estacoda-gateway-default-37a8eec1.service -f",
        lingerStatus: { kind: "message", text: "Systemd linger is enabled." },
      });

      const result = await withEnv({ HOME: tmpDir }, () => runGatewayInstallService({ workspaceRoot: tmpDir, homeDir: tmpDir }));

      expect(result.ok).toBe(true);
      expect(result.output).toContain("Gateway service installed (user scope, profile: default).");
      expect(result.output).toContain("Logs: journalctl --user -u estacoda-gateway-default-37a8eec1.service -f");
      expect(result.output).toContain("profile-local");
      expect(result.output).toContain("not interactive shell environment");
      expect(result.output).toContain("Systemd linger is enabled.");
      expect(result.output).not.toContain("Could not enable systemd linger");
      expect(result.output).toContain("Installed in source mode");
      expect(serviceManagerMock.installService).toHaveBeenCalledWith(expect.objectContaining({
        stateHomeDir: tmpDir,
        serviceUserHomeDir: tmpDir,
        serviceUserHomeDirExplicit: false,
        workspaceRoot: tmpDir,
        profileId: "default",
      }));
    });

    it("uses the detected EstaCoda install directory when installing the service", async () => {
      const cwdWorkspace = join(tmpDir, "shell-cwd");
      const installDir = join(tmpDir, "estacoda-install");
      serviceManagerMock.installService.mockResolvedValue({ ok: true, mode: "compiled" });
      installMethodMock.detectInstallMethod.mockResolvedValue({
        method: "manual-source",
        source: "path",
        installDir,
        recommendedUpdateCommand: "git fetch origin && git status",
        canSelfUpdate: false,
        reason: "A git checkout was detected without a managed-source install stamp.",
      });

      const result = await runGatewayInstallService({ workspaceRoot: cwdWorkspace, homeDir: tmpDir });

      expect(result.ok).toBe(true);
      expect(installMethodMock.detectInstallMethod).toHaveBeenCalledWith({ includeCwd: false });
      expect(serviceManagerMock.installService).toHaveBeenCalledWith(expect.objectContaining({
        workspaceRoot: installDir,
      }));
    });

    it("uses ESTACODA_HOME for profile lookup but OS HOME for service install semantics", async () => {
      const envRoot = await makeTempDir();
      const prodHome = join(envRoot, "prod-home");
      const devHome = join(envRoot, "dev-home");
      await mkdir(join(devHome, ".estacoda"), { recursive: true });
      await writeFile(join(devHome, ".estacoda", "active-profile.json"), JSON.stringify({ profileId: "dev-profile" }), "utf8");
      serviceManagerMock.installService.mockResolvedValue({ ok: true, mode: "compiled" });

      try {
        const result = await withEnv({ HOME: prodHome, ESTACODA_HOME: devHome }, () => (
          runGatewayInstallService({ workspaceRoot: tmpDir })
        ));

        expect(result.ok).toBe(true);
        expect(serviceManagerMock.installService).toHaveBeenCalledWith(expect.objectContaining({
          stateHomeDir: devHome,
          serviceUserHomeDir: prodHome,
          serviceUserHomeDirExplicit: false,
          workspaceRoot: tmpDir,
          profileId: "dev-profile",
        }));
        expect(result.output).toContain(join(devHome, ".estacoda", "profiles", "dev-profile", ".env"));
        expect(result.output).not.toContain("~/.estacoda/profiles/dev-profile/.env");
      } finally {
        await rm(envRoot, { recursive: true, force: true });
      }
    });

    it("omits source-mode warning for package installs", async () => {
      serviceManagerMock.detectServiceManager.mockReturnValue("systemd-user");
      serviceManagerMock.installService.mockResolvedValue({ ok: true, mode: "package-bin" });

      const result = await runGatewayInstallService({ workspaceRoot: tmpDir, homeDir: tmpDir });

      expect(result.ok).toBe(true);
      expect(result.output).not.toContain("Installed in source mode");
    });

    it("renders systemd linger enabled status without a warning prefix", async () => {
      serviceManagerMock.installService.mockResolvedValue({
        ok: true,
        mode: "compiled",
        lingerStatus: { kind: "message", text: "Systemd linger enabled." },
      });

      const result = await runGatewayInstallService({ workspaceRoot: tmpDir, homeDir: tmpDir });

      expect(result.ok).toBe(true);
      expect(result.output).toContain("Systemd linger enabled.");
      expect(result.output).not.toContain("Warning: Systemd linger enabled.");
      expect(result.output).not.toContain("Could not enable systemd linger");
    });

    it("renders systemd linger auto-enable failure as a single warning", async () => {
      serviceManagerMock.installService.mockResolvedValue({
        ok: true,
        mode: "compiled",
        lingerStatus: {
          kind: "warning",
          text: "Warning: Could not enable systemd linger. The gateway may stop after logout. Run: loginctl enable-linger $USER",
        },
      });

      const result = await runGatewayInstallService({ workspaceRoot: tmpDir, homeDir: tmpDir });

      expect(result.ok).toBe(true);
      expect(result.output).toContain("Warning: Could not enable systemd linger. The gateway may stop after logout. Run: loginctl enable-linger $USER");
      expect(result.output.match(/Could not enable systemd linger/gu)).toHaveLength(1);
      expect(result.output).not.toContain("secret-token-value");
    });

    it("returns install failures", async () => {
      serviceManagerMock.installService.mockResolvedValue({ ok: false, error: "already installed" });

      const result = await runGatewayInstallService({ workspaceRoot: tmpDir, homeDir: tmpDir });

      expect(result).toEqual({ ok: false, output: "already installed" });
    });

    it("propagates explicit profile, system scope, runAsUser, and force", async () => {
      serviceManagerMock.installService.mockResolvedValue({
        ok: true,
        mode: "compiled",
        unitName: "estacoda-gateway-work-6b7fb7c6.service",
        logCommand: "sudo journalctl -u estacoda-gateway-work-6b7fb7c6.service -f",
      });

      const result = await runGatewayInstallService({
        workspaceRoot: tmpDir,
        homeDir: tmpDir,
        profileId: "work",
        system: true,
        runAsUser: "estacoda",
        serviceHomeDir: "/home/estacoda",
        force: true,
      });

      expect(result.ok).toBe(true);
      expect(result.output).toContain("system scope, profile: work");
      expect(result.output).toContain("Logs: sudo journalctl -u estacoda-gateway-work-6b7fb7c6.service -f");
      expect(serviceManagerMock.installService).toHaveBeenCalledWith(expect.objectContaining({
        profileId: "work",
        stateHomeDir: tmpDir,
        serviceUserHomeDir: "/home/estacoda",
        serviceUserHomeDirExplicit: true,
        system: true,
        runAsUser: "estacoda",
        force: true,
      }));
    });

    it("uninstalls a service and returns failures", async () => {
      serviceManagerMock.uninstallService.mockResolvedValueOnce({ ok: true });
      const success = await withEnv({ HOME: tmpDir }, () => runGatewayUninstallService({
        workspaceRoot: tmpDir,
        homeDir: tmpDir,
        profileId: "work",
        system: true,
      }));
      expect(success).toEqual({
        ok: true,
        output: "Gateway service uninstalled (system scope, profile: work).",
      });
      expect(serviceManagerMock.uninstallService).toHaveBeenCalledWith(expect.objectContaining({
        serviceUserHomeDir: tmpDir,
        profileId: "work",
        system: true,
      }));

      serviceManagerMock.uninstallService.mockResolvedValueOnce({ ok: false, error: "not supported" });
      const failure = await runGatewayUninstallService({ workspaceRoot: tmpDir, homeDir: tmpDir });
      expect(failure).toEqual({ ok: false, output: "not supported" });
    });

    it("uses ESTACODA_HOME for profile lookup but OS HOME for service uninstall semantics", async () => {
      const envRoot = await makeTempDir();
      const prodHome = join(envRoot, "prod-home");
      const devHome = join(envRoot, "dev-home");
      await mkdir(join(devHome, ".estacoda"), { recursive: true });
      await writeFile(join(devHome, ".estacoda", "active-profile.json"), JSON.stringify({ profileId: "dev-profile" }), "utf8");
      serviceManagerMock.uninstallService.mockResolvedValue({ ok: true });

      try {
        const result = await withEnv({ HOME: prodHome, ESTACODA_HOME: devHome }, () => (
          runGatewayUninstallService({ workspaceRoot: tmpDir })
        ));

        expect(result.ok).toBe(true);
        expect(serviceManagerMock.uninstallService).toHaveBeenCalledWith(expect.objectContaining({
          serviceUserHomeDir: prodHome,
          profileId: "dev-profile",
        }));
      } finally {
        await rm(envRoot, { recursive: true, force: true });
      }
    });

    it("renders user and system service state in status on systemd", async () => {
      serviceManagerMock.detectServiceManager.mockReturnValue("systemd-user");
      serviceManagerMock.probeServiceState.mockImplementation(async (options: { profileId: string; system?: boolean }) => ({
        kind: options.system ? "systemd-system" : "systemd-user",
        installed: true,
        scope: options.system ? "system" : "user",
        activeState: options.system ? "inactive" : "active",
        subState: options.system ? "dead" : "running",
        unitName: "unit",
        profileId: options.profileId,
      }));

      const result = await runGatewayStatus({ workspaceRoot: tmpDir, homeDir: tmpDir });

      expect(result.ok).toBe(true);
      expect(result.output).toContain("Service Manager");
      expect(result.output).toContain("systemd-user (user): active (running)");
      expect(result.output).toContain("systemd-system (system): inactive (dead)");
    });

    it("uses ESTACODA_HOME for status state and OS HOME for service probing", async () => {
      const envRoot = await makeTempDir();
      const prodHome = join(envRoot, "prod-home");
      const devHome = join(envRoot, "dev-home");
      await mkdir(join(devHome, ".estacoda"), { recursive: true });
      await writeFile(join(devHome, ".estacoda", "active-profile.json"), JSON.stringify({ profileId: "dev-profile" }), "utf8");
      serviceManagerMock.detectServiceManager.mockReturnValue("systemd-user");

      try {
        const result = await withEnv({ HOME: prodHome, ESTACODA_HOME: devHome }, () => (
          runGatewayStatus({ workspaceRoot: tmpDir })
        ));

        expect(result.ok).toBe(true);
        expect(serviceManagerMock.probeServiceState).toHaveBeenCalledWith(expect.objectContaining({
          serviceUserHomeDir: prodHome,
          profileId: "dev-profile",
          system: false,
        }));
        expect(serviceManagerMock.probeServiceState).toHaveBeenCalledWith(expect.objectContaining({
          serviceUserHomeDir: prodHome,
          profileId: "dev-profile",
          system: true,
        }));
      } finally {
        await rm(envRoot, { recursive: true, force: true });
      }
    });

    it("keeps status ok when service probing degrades", async () => {
      serviceManagerMock.detectServiceManager.mockReturnValue("systemd-user");
      serviceManagerMock.probeServiceState.mockImplementation(async (options: { profileId: string; system?: boolean }) => ({
        kind: options.system ? "systemd-system" : "systemd-user",
        installed: false,
        scope: options.system ? "system" : "user",
        activeState: "unknown",
        unitName: "unit",
        profileId: options.profileId,
      }));

      const result = await runGatewayStatus({ workspaceRoot: tmpDir, homeDir: tmpDir });

      expect(result.ok).toBe(true);
      expect(result.output).toContain("Service Manager");
      expect(result.output).toContain("systemd-user (user): not installed");
      expect(result.output).toContain("systemd-system (system): not installed");
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
      await writeGatewayPid(profilePaths, { pid: 99999, startedAt: new Date().toISOString(), version: "0.0.1" });
      const result = await runGatewayDiagnose({ workspaceRoot: tmpDir, homeDir: tmpDir });
      expect(result.output).toContain("Supervisor");
      expect(result.output).toContain("PID healthy: no");
    });

    it("reports stale identity lock in diagnose", async () => {
      const { writeFile, mkdir } = await import("node:fs/promises");
      const locksDir = join(profilePaths.gatewayStatePath, "locks");
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
      const locksDir = join(profilePaths.gatewayStatePath, "locks");
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
      await writeGatewayPid(profilePaths, { pid: process.pid, startedAt: new Date().toISOString(), version: "0.0.5" });
      const staleState = fakeRuntimeCacheState({ writtenAt: new Date(Date.now() - 300_000).toISOString() });
      await writeRuntimeCacheState(runtimeCacheStatePath(profilePaths), staleState);

      const result = await runGatewayDiagnose({ workspaceRoot: tmpDir, homeDir: tmpDir });
      expect(result.output).toContain("Runtime Cache");
      expect(result.output).toContain("stale");
      expect(result.output).toContain("runtime-cache-state is stale");
    });

    it("reports PID-mismatch runtime-cache-state warning", async () => {
      await writeGatewayPid(profilePaths, { pid: process.pid, startedAt: new Date().toISOString(), version: "0.0.5" });
      const mismatchedState = fakeRuntimeCacheState({ supervisorPid: 99999 });
      await writeRuntimeCacheState(runtimeCacheStatePath(profilePaths), mismatchedState);

      const result = await runGatewayDiagnose({ workspaceRoot: tmpDir, homeDir: tmpDir });
      expect(result.output).toContain("Runtime Cache");
      expect(result.output).toContain("runtime-cache-state PID does not match");
    });

    it("reports supervisor-not-live runtime-cache-state warning", async () => {
      await writeGatewayPid(profilePaths, { pid: 99999, startedAt: new Date().toISOString(), version: "0.0.5" });
      await writeRuntimeCacheState(runtimeCacheStatePath(profilePaths), fakeRuntimeCacheState({ supervisorPid: 99999 }));

      const result = await runGatewayDiagnose({ workspaceRoot: tmpDir, homeDir: tmpDir });
      expect(result.output).toContain("Runtime Cache");
      expect(result.output).toContain("runtime-cache-state exists but supervisor is not live");
    });

    it("reports suspended sessions warning in diagnose", async () => {
      await writeGatewayPid(profilePaths, { pid: process.pid, startedAt: new Date().toISOString(), version: "0.0.5" });
      const state = fakeRuntimeCacheState({
        suspendedSummary: [{ sessionId: "sess-1", reason: "stuck-loop", suspendedAt: new Date().toISOString() }],
      });
      await writeRuntimeCacheState(runtimeCacheStatePath(profilePaths), state);

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
        await writeGatewayPid(profilePaths, { pid: process.pid, startedAt: new Date().toISOString(), version: "0.0.5" });
        await writeAdapterRuntimeState(profilePaths, fakeAdapterRuntimeState("telegram"));

        const result = await runChannelsStatus({ workspaceRoot: tmpDir, homeDir: tmpDir, channel: "telegram" });
        expect(result.output).toContain("State: healthy");
        expect(result.output).toContain("Polls: 5");
        expect(result.output).toContain("Processed: 3");
        expect(result.output).toContain("Failed: 0");
      });

      it("shows unavailable when supervisor is not live", async () => {
        await writeAdapterRuntimeState(profilePaths, fakeAdapterRuntimeState("telegram"));

        const result = await runChannelsStatus({ workspaceRoot: tmpDir, homeDir: tmpDir, channel: "telegram" });
        expect(result.output).toContain("Runtime state: unavailable (supervisor not running)");
        expect(result.output).not.toContain("Polls: 5");
      });

      it("shows unavailable when runtime state file is missing", async () => {
        await writeGatewayPid(profilePaths, { pid: process.pid, startedAt: new Date().toISOString(), version: "0.0.5" });

        const result = await runChannelsStatus({ workspaceRoot: tmpDir, homeDir: tmpDir, channel: "telegram" });
        expect(result.output).toContain("Runtime state: unavailable (adapter runtime state not found)");
      });

      it("shows unavailable when runtime state file is corrupt", async () => {
        await writeGatewayPid(profilePaths, { pid: process.pid, startedAt: new Date().toISOString(), version: "0.0.5" });
        await writeRawAdapterRuntimeState(tmpDir, "{ not json");

        const result = await runChannelsStatus({ workspaceRoot: tmpDir, homeDir: tmpDir, channel: "telegram" });
        expect(result.output).toContain("Runtime state: unavailable (adapter runtime state unreadable)");
      });

      it("shows stale warning when runtime state is old", async () => {
        await writeGatewayPid(profilePaths, { pid: process.pid, startedAt: new Date().toISOString(), version: "0.0.5" });
        await writeAdapterRuntimeState(profilePaths, fakeAdapterRuntimeState("telegram", { updatedAt: new Date(Date.now() - 6 * 60 * 1000).toISOString() }));

        const result = await runChannelsStatus({ workspaceRoot: tmpDir, homeDir: tmpDir, channel: "telegram" });
        expect(result.output).toContain("Runtime state: stale (last update >5min ago)");
      });

      it("shows stale warning when runtime state PID mismatches", async () => {
        await writeGatewayPid(profilePaths, { pid: process.pid, startedAt: new Date().toISOString(), version: "0.0.5" });
        await writeAdapterRuntimeState(profilePaths, fakeAdapterRuntimeState("telegram", { supervisorPid: 99999 }));

        const result = await runChannelsStatus({ workspaceRoot: tmpDir, homeDir: tmpDir, channel: "telegram" });
        expect(result.output).toContain("Runtime state: stale (supervisor restarted since last update)");
      });

      it("shows not-registered when adapter entry is missing", async () => {
        await writeGatewayPid(profilePaths, { pid: process.pid, startedAt: new Date().toISOString(), version: "0.0.5" });
        await writeAdapterRuntimeState(profilePaths, { ...fakeAdapterRuntimeState("discord"), adapters: [] });

        const result = await runChannelsStatus({ workspaceRoot: tmpDir, homeDir: tmpDir, channel: "telegram" });
        expect(result.output).toContain("Adapter: not registered in runtime state");
      });

      it("shows identity lock status when locked", async () => {
        await acquireAdapterIdentityLock(profilePaths, "telegram", "a".repeat(64));

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
        await writeGatewayPid(profilePaths, { pid: process.pid, startedAt: new Date().toISOString(), version: "0.0.5" });
        await writeAdapterRuntimeState(profilePaths, fakeAdapterRuntimeState(channel));
        await acquireAdapterIdentityLock(profilePaths, channel, "b".repeat(64));

        const result = await runChannelsStatus({ workspaceRoot: tmpDir, homeDir: tmpDir, channel });
        expect(result.output).toContain("State: healthy");
        expect(result.output).toContain("Identity lock:");
        expect(result.output).toContain("Busy policy:");
        expect(result.output).toContain("Queue depth:");
      });
    }
  });

  describe("runGatewayStop", () => {
    it("delegates to user systemd stop when a user service is installed", async () => {
      serviceManagerMock.detectServiceManager.mockReturnValue("systemd-user");
      serviceManagerMock.probeServiceState.mockImplementation(async (options: { profileId: string; system?: boolean }) => ({
        kind: options.system ? "systemd-system" : "systemd-user",
        installed: options.system !== true,
        scope: options.system ? "system" : "user",
        activeState: "active",
        unitName: "unit",
        profileId: options.profileId,
      }));
      const stopGatewaySpy = vi.spyOn(lifecycleModule, "stopGateway");

      const result = await withEnv({ HOME: tmpDir }, () => runGatewayStop({ workspaceRoot: tmpDir, homeDir: tmpDir }));

      expect(result).toEqual({
        ok: true,
        output: "Gateway service stopped (user scope, profile: default).",
      });
      expect(serviceManagerMock.stopService).toHaveBeenCalledWith(expect.objectContaining({
        serviceUserHomeDir: tmpDir,
        profileId: "default",
        system: false,
      }));
      expect(stopGatewaySpy).not.toHaveBeenCalled();
      stopGatewaySpy.mockRestore();
    });

    it("keeps --force service-aware instead of force-killing a systemd-managed gateway", async () => {
      serviceManagerMock.detectServiceManager.mockReturnValue("systemd-user");
      serviceManagerMock.probeServiceState.mockImplementation(async (options: { profileId: string; system?: boolean }) => ({
        kind: options.system ? "systemd-system" : "systemd-user",
        installed: options.system !== true,
        scope: options.system ? "system" : "user",
        activeState: "active",
        unitName: "unit",
        profileId: options.profileId,
      }));
      const stopGatewaySpy = vi.spyOn(lifecycleModule, "stopGateway");

      const result = await runGatewayStop({ workspaceRoot: tmpDir, homeDir: tmpDir, force: true });

      expect(result.ok).toBe(true);
      expect(serviceManagerMock.stopService).toHaveBeenCalledWith(expect.objectContaining({ system: false }));
      expect(stopGatewaySpy).not.toHaveBeenCalled();
      stopGatewaySpy.mockRestore();
    });

    it("does not silently control a system service when --system is absent", async () => {
      serviceManagerMock.detectServiceManager.mockReturnValue("systemd-user");
      serviceManagerMock.probeServiceState.mockImplementation(async (options: { profileId: string; system?: boolean }) => ({
        kind: options.system ? "systemd-system" : "systemd-user",
        installed: options.system === true,
        scope: options.system ? "system" : "user",
        activeState: "active",
        unitName: "unit",
        profileId: options.profileId,
      }));
      const stopGatewaySpy = vi.spyOn(lifecycleModule, "stopGateway");

      const result = await runGatewayStop({ workspaceRoot: tmpDir, homeDir: tmpDir });

      expect(result.ok).toBe(false);
      expect(result.output).toContain("Rerun with --system");
      expect(serviceManagerMock.stopService).not.toHaveBeenCalled();
      expect(stopGatewaySpy).not.toHaveBeenCalled();
      stopGatewaySpy.mockRestore();
    });

    it("controls the system service only when --system is passed", async () => {
      serviceManagerMock.detectServiceManager.mockReturnValue("systemd-user");
      serviceManagerMock.probeServiceState.mockImplementation(async (options: { profileId: string; system?: boolean }) => ({
        kind: options.system ? "systemd-system" : "systemd-user",
        installed: options.system === true,
        scope: options.system ? "system" : "user",
        activeState: "active",
        unitName: "unit",
        profileId: options.profileId,
      }));

      const result = await runGatewayStop({ workspaceRoot: tmpDir, homeDir: tmpDir, system: true });

      expect(result).toEqual({
        ok: true,
        output: "Gateway service stopped (system scope, profile: default).",
      });
      expect(serviceManagerMock.probeServiceState).toHaveBeenCalledWith(expect.objectContaining({ system: true }));
      expect(serviceManagerMock.stopService).toHaveBeenCalledWith(expect.objectContaining({ system: true }));
    });

    it("does not fall back to a user service when --system is passed and no system service exists", async () => {
      serviceManagerMock.detectServiceManager.mockReturnValue("systemd-user");
      serviceManagerMock.probeServiceState.mockImplementation(async (options: { profileId: string; system?: boolean }) => ({
        kind: options.system ? "systemd-system" : "systemd-user",
        installed: options.system !== true,
        scope: options.system ? "system" : "user",
        activeState: "active",
        unitName: "unit",
        profileId: options.profileId,
      }));
      const stopGatewaySpy = vi.spyOn(lifecycleModule, "stopGateway");

      const result = await runGatewayStop({ workspaceRoot: tmpDir, homeDir: tmpDir, system: true });

      expect(result.ok).toBe(false);
      expect(result.output).toContain("system service is not installed");
      expect(serviceManagerMock.stopService).not.toHaveBeenCalled();
      expect(stopGatewaySpy).not.toHaveBeenCalled();
      stopGatewaySpy.mockRestore();
    });

    it("defaults to the user service when both user and system services exist", async () => {
      serviceManagerMock.detectServiceManager.mockReturnValue("systemd-user");
      serviceManagerMock.probeServiceState.mockImplementation(async (options: { profileId: string; system?: boolean }) => ({
        kind: options.system ? "systemd-system" : "systemd-user",
        installed: true,
        scope: options.system ? "system" : "user",
        activeState: "active",
        unitName: "unit",
        profileId: options.profileId,
      }));

      const result = await runGatewayStop({ workspaceRoot: tmpDir, homeDir: tmpDir });

      expect(result.output).toContain("user scope");
      expect(serviceManagerMock.stopService).toHaveBeenCalledWith(expect.objectContaining({ system: false }));
    });

    it("reports was not running with stale PID", async () => {
      await writeGatewayPid(profilePaths, { pid: 99999, startedAt: new Date().toISOString(), version: "0.0.1" });
      const result = await runGatewayStop({ workspaceRoot: tmpDir, homeDir: tmpDir });
      expect(result.ok).toBe(true);
      expect(result.output).toContain("was not running");
      expect(result.output).toContain("99999");
    });

    it("uses ESTACODA_HOME state paths for unmanaged stop and OS HOME for service probes", async () => {
      const envRoot = await makeTempDir();
      const prodHome = join(envRoot, "prod-home");
      const devHome = join(envRoot, "dev-home");
      const devPaths = resolveProfileStateHome({ homeDir: devHome, profileId: "default" });
      await writeGatewayPid(devPaths, { pid: 99999, startedAt: new Date().toISOString(), version: "0.0.1" });

      try {
        const result = await withEnv({ HOME: prodHome, ESTACODA_HOME: devHome }, () => (
          runGatewayStop({ workspaceRoot: tmpDir })
        ));

        expect(result.ok).toBe(true);
        expect(result.output).toContain("was not running");
        expect(result.output).toContain("99999");
        expect(serviceManagerMock.probeServiceState).toHaveBeenCalledWith(expect.objectContaining({
          serviceUserHomeDir: prodHome,
          profileId: "default",
          system: false,
        }));
      } finally {
        await rm(envRoot, { recursive: true, force: true });
      }
    });

    it("reports not running when no PID file exists", async () => {
      const result = await runGatewayStop({ workspaceRoot: tmpDir, homeDir: tmpDir });
      expect(result.ok).toBe(true);
      expect(result.output).toBe("Gateway is not running");
    });

    it("reports live lock exists when no PID but live lock is held", async () => {
      await acquireGatewayLock(profilePaths);
      await writeGatewayState(profilePaths, { lifecycle: "running", startedAt: new Date().toISOString(), pid: process.pid, version: "0.0.1" });

      const result = await runGatewayStop({ workspaceRoot: tmpDir, homeDir: tmpDir });
      expect(result.ok).toBe(true);
      expect(result.output).toBe("Gateway is not running (live operation lock exists)");

      await releaseGatewayLock(profilePaths);
    });
  });

  describe("runGatewayStartDryRun", () => {
    it("fails in cron-only mode when state dirs are missing", async () => {
      const result = await runGatewayStartDryRun({ workspaceRoot: tmpDir, homeDir: tmpDir });

      expect(result.ok).toBe(false);
      expect(result.output).toContain("Adapters: none");
      expect(result.output).toContain("Mode: cron-only");
      expect(result.output).toContain("Adapter identities: none");
      expect(result.output).toContain("State dirs: not initialized");
      expect(result.output).toContain("run estacoda init");
      expect(result.output).toContain("Gateway lock: no active owner detected");
    });

    it("passes in cron-only mode when state dirs exist and no blockers are present", async () => {
      await createGatewayStateDirs(profilePaths);

      const result = await runGatewayStartDryRun({ workspaceRoot: tmpDir, homeDir: tmpDir });

      expect(result.ok).toBe(true);
      expect(result.output).toContain("Adapters: none");
      expect(result.output).toContain("Mode: cron-only");
      expect(result.output).toContain("State dirs: ready");
      expect(result.output).not.toContain("run estacoda init");
    });

    it("passes when an enabled adapter has locally derivable identity", async () => {
      const tokenEnv = "ESTACODA_TEST_TELEGRAM_TOKEN";
      process.env[tokenEnv] = "telegram-token";
      try {
        await createGatewayStateDirs(profilePaths);
        await writeUserConfig(tmpDir, {
          channels: {
            telegram: {
              enabled: true,
              botTokenEnv: tokenEnv,
            },
          },
        });

        const result = await runGatewayStartDryRun({ workspaceRoot: tmpDir, homeDir: tmpDir });

        expect(result.ok).toBe(true);
        expect(result.output).toContain("Adapters: telegram");
        expect(result.output).toContain("Adapter identities: telegram locally valid");
        await expect(readFile(join(tmpDir, ".estacoda", "gateway", "identity-lock-key"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        delete process.env[tokenEnv];
      }
    });

    it("fails when Telegram is enabled without a usable token", async () => {
      const tokenEnv = "ESTACODA_TEST_MISSING_TELEGRAM_TOKEN";
      delete process.env[tokenEnv];
      await writeUserConfig(tmpDir, {
        channels: {
          telegram: {
            enabled: true,
            botTokenEnv: tokenEnv,
          },
        },
      });

      const result = await runGatewayStartDryRun({ workspaceRoot: tmpDir, homeDir: tmpDir });

      expect(result.ok).toBe(false);
      expect(result.output).toContain("telegram: missing");
      expect(result.output).toContain("telegram: configured but no derivable identity");
    });

    it("fails when WhatsApp is enabled without a derivable auth identity", async () => {
      await writeUserConfig(tmpDir, {
        channels: {
          whatsapp: {
            enabled: true,
            experimental: true,
          },
        },
      });

      const result = await runGatewayStartDryRun({ workspaceRoot: tmpDir, homeDir: tmpDir });

      expect(result.ok).toBe(false);
      expect(result.output).toContain("whatsapp: configured but no derivable identity");
    });
  });

  describe("runGatewayStartService and runGatewayRestart", () => {
    let stopGatewaySpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      stopGatewaySpy = vi.spyOn(lifecycleModule, "stopGateway").mockResolvedValue({
        ok: true,
        action: "was_not_running",
      });
    });

    afterEach(() => {
      stopGatewaySpy.mockRestore();
    });

    it("starts the installed user service", async () => {
      serviceManagerMock.detectServiceManager.mockReturnValue("systemd-user");
      serviceManagerMock.probeServiceState.mockImplementation(async (options: { profileId: string; system?: boolean }) => ({
        kind: options.system ? "systemd-system" : "systemd-user",
        installed: options.system !== true,
        scope: options.system ? "system" : "user",
        activeState: "inactive",
        unitName: "unit",
        profileId: options.profileId,
      }));

      const result = await withEnv({ HOME: tmpDir }, () => runGatewayStartService({ workspaceRoot: tmpDir, homeDir: tmpDir }));

      expect(result).toEqual({
        ok: true,
        output: "Gateway service started (user scope, profile: default).",
      });
      expect(serviceManagerMock.startService).toHaveBeenCalledWith(expect.objectContaining({
        serviceUserHomeDir: tmpDir,
        profileId: "default",
        system: false,
      }));
      expect(stopGatewaySpy).not.toHaveBeenCalled();
      expect(childProcessMock.spawn).not.toHaveBeenCalled();
    });

    it("succeeds gracefully when the installed user service is already running", async () => {
      serviceManagerMock.detectServiceManager.mockReturnValue("systemd-user");
      serviceManagerMock.probeServiceState.mockImplementation(async (options: { profileId: string; system?: boolean }) => ({
        kind: options.system ? "systemd-system" : "systemd-user",
        installed: options.system !== true,
        scope: options.system ? "system" : "user",
        activeState: "active",
        subState: "running",
        unitName: "unit",
        profileId: options.profileId,
      }));

      const result = await withEnv({ HOME: tmpDir }, () => runGatewayStartService({ workspaceRoot: tmpDir, homeDir: tmpDir }));

      expect(result.ok).toBe(true);
      expect(result.output).toContain("Gateway service started (user scope");
      expect(serviceManagerMock.startService).toHaveBeenCalledWith(expect.objectContaining({ system: false }));
      expect(childProcessMock.spawn).not.toHaveBeenCalled();
    });

    it("starts the system service only when --system is passed", async () => {
      serviceManagerMock.detectServiceManager.mockReturnValue("systemd-user");
      serviceManagerMock.probeServiceState.mockImplementation(async (options: { profileId: string; system?: boolean }) => ({
        kind: options.system ? "systemd-system" : "systemd-user",
        installed: options.system === true,
        scope: options.system ? "system" : "user",
        activeState: "inactive",
        unitName: "unit",
        profileId: options.profileId,
      }));

      const result = await runGatewayStartService({ workspaceRoot: tmpDir, homeDir: tmpDir, system: true });

      expect(result).toEqual({
        ok: true,
        output: "Gateway service started (system scope, profile: default).",
      });
      expect(serviceManagerMock.startService).toHaveBeenCalledWith(expect.objectContaining({ system: true }));
      expect(stopGatewaySpy).not.toHaveBeenCalled();
      expect(childProcessMock.spawn).not.toHaveBeenCalled();
    });

    it("fails when no service is installed", async () => {
      const result = await runGatewayStartService({ workspaceRoot: tmpDir, homeDir: tmpDir });

      expect(result.ok).toBe(false);
      expect(result.output).toContain("Gateway service is not installed for profile 'default'.");
      expect(result.output).toContain("Run: estacoda gateway install");
      expect(result.output).toContain("For foreground mode: estacoda gateway run");
      expect(serviceManagerMock.startService).not.toHaveBeenCalled();
      expect(stopGatewaySpy).not.toHaveBeenCalled();
      expect(childProcessMock.spawn).not.toHaveBeenCalled();
    });

    it("fails when only a system service exists and --system is absent", async () => {
      serviceManagerMock.detectServiceManager.mockReturnValue("systemd-user");
      serviceManagerMock.probeServiceState.mockImplementation(async (options: { profileId: string; system?: boolean }) => ({
        kind: options.system ? "systemd-system" : "systemd-user",
        installed: options.system === true,
        scope: options.system ? "system" : "user",
        activeState: "active",
        unitName: "unit",
        profileId: options.profileId,
      }));

      const result = await runGatewayStartService({ workspaceRoot: tmpDir, homeDir: tmpDir });

      expect(result.ok).toBe(false);
      expect(result.output).toContain("Rerun with --system");
      expect(serviceManagerMock.startService).not.toHaveBeenCalled();
      expect(stopGatewaySpy).not.toHaveBeenCalled();
      expect(childProcessMock.spawn).not.toHaveBeenCalled();
    });

    it("fails when --system is passed and only a user service exists", async () => {
      serviceManagerMock.detectServiceManager.mockReturnValue("systemd-user");
      serviceManagerMock.probeServiceState.mockImplementation(async (options: { profileId: string; system?: boolean }) => ({
        kind: options.system ? "systemd-system" : "systemd-user",
        installed: options.system !== true,
        scope: options.system ? "system" : "user",
        activeState: "active",
        unitName: "unit",
        profileId: options.profileId,
      }));

      const result = await runGatewayStartService({ workspaceRoot: tmpDir, homeDir: tmpDir, system: true });

      expect(result.ok).toBe(false);
      expect(result.output).toContain("system service is not installed");
      expect(serviceManagerMock.startService).not.toHaveBeenCalled();
      expect(stopGatewaySpy).not.toHaveBeenCalled();
      expect(childProcessMock.spawn).not.toHaveBeenCalled();
    });

    it("defaults to the user service when both user and system services exist", async () => {
      serviceManagerMock.detectServiceManager.mockReturnValue("systemd-user");
      serviceManagerMock.probeServiceState.mockImplementation(async (options: { profileId: string; system?: boolean }) => ({
        kind: options.system ? "systemd-system" : "systemd-user",
        installed: true,
        scope: options.system ? "system" : "user",
        activeState: "active",
        unitName: "unit",
        profileId: options.profileId,
      }));

      const plain = await runGatewayStartService({ workspaceRoot: tmpDir, homeDir: tmpDir });
      const system = await runGatewayStartService({ workspaceRoot: tmpDir, homeDir: tmpDir, system: true });

      expect(plain.output).toContain("user scope");
      expect(system.output).toContain("system scope");
      expect(serviceManagerMock.startService).toHaveBeenNthCalledWith(1, expect.objectContaining({ system: false }));
      expect(serviceManagerMock.startService).toHaveBeenNthCalledWith(2, expect.objectContaining({ system: true }));
      expect(childProcessMock.spawn).not.toHaveBeenCalled();
    });

    it("delegates to systemd restart when a user service is installed", async () => {
      serviceManagerMock.detectServiceManager.mockReturnValue("systemd-user");
      serviceManagerMock.probeServiceState.mockImplementation(async (options: { profileId: string; system?: boolean }) => ({
        kind: options.system ? "systemd-system" : "systemd-user",
        installed: options.system !== true,
        scope: options.system ? "system" : "user",
        activeState: "active",
        unitName: "unit",
        profileId: options.profileId,
      }));

      const result = await withEnv({ HOME: tmpDir }, () => runGatewayRestart({ workspaceRoot: tmpDir, homeDir: tmpDir }));

      expect(result).toEqual({
        ok: true,
        output: "Gateway service restarted (user scope, profile: default).",
      });
      expect(serviceManagerMock.restartService).toHaveBeenCalledWith(expect.objectContaining({
        serviceUserHomeDir: tmpDir,
        profileId: "default",
        system: false,
      }));
      expect(stopGatewaySpy).not.toHaveBeenCalled();
      expect(childProcessMock.spawn).not.toHaveBeenCalled();
    });

    it("writes a planned restart marker before user service restart when lifecycle notifications are enabled", async () => {
      const configPath = defaultProfileConfigPath(tmpDir);
      await mkdir(dirname(configPath), { recursive: true });
      await writeFile(configPath, JSON.stringify({
        gateway: { lifecycleNotifications: { enabled: true } }
      }), "utf8");
      serviceManagerMock.detectServiceManager.mockReturnValue("systemd-user");
      serviceManagerMock.probeServiceState.mockImplementation(async (options: { profileId: string; system?: boolean }) => ({
        kind: options.system ? "systemd-system" : "systemd-user",
        installed: options.system !== true,
        scope: options.system ? "system" : "user",
        activeState: "active",
        unitName: "unit",
        profileId: options.profileId,
      }));

      const result = await withEnv({ HOME: tmpDir }, () => runGatewayRestart({ workspaceRoot: tmpDir, homeDir: tmpDir }));

      expect(result.ok).toBe(true);
      const marker = await readGatewayRestartPlannedMarker(profilePaths);
      expect(marker?.reason).toBe("gateway-restart");
      expect(typeof marker?.plannedAt).toBe("string");
      const persisted = JSON.parse(await readFile(join(profilePaths.gatewayStatePath, "restart-planned.json"), "utf8")) as Record<string, unknown>;
      expect(Object.keys(persisted).sort()).toEqual(["plannedAt", "reason"]);
      expect(persisted).not.toHaveProperty("chatId");
      expect(persisted).not.toHaveProperty("threadId");
      expect(persisted).not.toHaveProperty("sessionId");
      expect(persisted).not.toHaveProperty("resume");
      expect(persisted).not.toHaveProperty("channels");
    });

    it("does not write a planned restart marker when lifecycle notifications are absent", async () => {
      serviceManagerMock.detectServiceManager.mockReturnValue("systemd-user");
      serviceManagerMock.probeServiceState.mockImplementation(async (options: { profileId: string; system?: boolean }) => ({
        kind: options.system ? "systemd-system" : "systemd-user",
        installed: options.system !== true,
        scope: options.system ? "system" : "user",
        activeState: "active",
        unitName: "unit",
        profileId: options.profileId,
      }));

      const result = await withEnv({ HOME: tmpDir }, () => runGatewayRestart({ workspaceRoot: tmpDir, homeDir: tmpDir }));

      expect(result.ok).toBe(true);
      await expect(readGatewayRestartPlannedMarker(profilePaths)).resolves.toBeUndefined();
    });

    it("clears the planned restart marker when service restart fails", async () => {
      const configPath = defaultProfileConfigPath(tmpDir);
      await mkdir(dirname(configPath), { recursive: true });
      await writeFile(configPath, JSON.stringify({
        gateway: { lifecycleNotifications: { enabled: true } }
      }), "utf8");
      serviceManagerMock.detectServiceManager.mockReturnValue("systemd-user");
      serviceManagerMock.probeServiceState.mockImplementation(async (options: { profileId: string; system?: boolean }) => ({
        kind: options.system ? "systemd-system" : "systemd-user",
        installed: options.system !== true,
        scope: options.system ? "system" : "user",
        activeState: "active",
        unitName: "unit",
        profileId: options.profileId,
      }));
      serviceManagerMock.restartService.mockResolvedValueOnce({ ok: false, error: "boom" });

      const result = await withEnv({ HOME: tmpDir }, () => runGatewayRestart({ workspaceRoot: tmpDir, homeDir: tmpDir }));

      expect(result.ok).toBe(false);
      await expect(readGatewayRestartPlannedMarker(profilePaths)).resolves.toBeUndefined();
    });

    it("restarts the system service only when --system is passed", async () => {
      serviceManagerMock.detectServiceManager.mockReturnValue("systemd-user");
      serviceManagerMock.probeServiceState.mockImplementation(async (options: { profileId: string; system?: boolean }) => ({
        kind: options.system ? "systemd-system" : "systemd-user",
        installed: options.system === true,
        scope: options.system ? "system" : "user",
        activeState: "active",
        unitName: "unit",
        profileId: options.profileId,
      }));

      const result = await runGatewayRestart({ workspaceRoot: tmpDir, homeDir: tmpDir, system: true });

      expect(result).toEqual({
        ok: true,
        output: "Gateway service restarted (system scope, profile: default).",
      });
      expect(serviceManagerMock.restartService).toHaveBeenCalledWith(expect.objectContaining({ system: true }));
      expect(stopGatewaySpy).not.toHaveBeenCalled();
      expect(childProcessMock.spawn).not.toHaveBeenCalled();
    });

    it("does not fall back to user restart when --system is passed and no system service exists", async () => {
      serviceManagerMock.detectServiceManager.mockReturnValue("systemd-user");
      serviceManagerMock.probeServiceState.mockImplementation(async (options: { profileId: string; system?: boolean }) => ({
        kind: options.system ? "systemd-system" : "systemd-user",
        installed: options.system !== true,
        scope: options.system ? "system" : "user",
        activeState: "active",
        unitName: "unit",
        profileId: options.profileId,
      }));

      const result = await runGatewayRestart({ workspaceRoot: tmpDir, homeDir: tmpDir, system: true });

      expect(result.ok).toBe(false);
      expect(result.output).toContain("system service is not installed");
      expect(serviceManagerMock.restartService).not.toHaveBeenCalled();
      expect(stopGatewaySpy).not.toHaveBeenCalled();
      expect(childProcessMock.spawn).not.toHaveBeenCalled();
    });

    it("does not spawn an unmanaged gateway when only a system service exists", async () => {
      serviceManagerMock.detectServiceManager.mockReturnValue("systemd-user");
      serviceManagerMock.probeServiceState.mockImplementation(async (options: { profileId: string; system?: boolean }) => ({
        kind: options.system ? "systemd-system" : "systemd-user",
        installed: options.system === true,
        scope: options.system ? "system" : "user",
        activeState: "active",
        unitName: "unit",
        profileId: options.profileId,
      }));

      const result = await runGatewayRestart({ workspaceRoot: tmpDir, homeDir: tmpDir });

      expect(result.ok).toBe(false);
      expect(result.output).toContain("Rerun with --system");
      expect(serviceManagerMock.restartService).not.toHaveBeenCalled();
      expect(stopGatewaySpy).not.toHaveBeenCalled();
      expect(childProcessMock.spawn).not.toHaveBeenCalled();
    });

    it("fails restart when no service is installed instead of spawning", async () => {
      serviceManagerMock.detectServiceManager.mockReturnValue("systemd-user");
      serviceManagerMock.probeServiceState.mockImplementation(async (options: { profileId: string; system?: boolean }) => ({
        kind: options.system ? "systemd-system" : "systemd-user",
        installed: false,
        scope: options.system ? "system" : "user",
        activeState: "unknown",
        unitName: "unit",
        profileId: options.profileId,
      }));

      const result = await runGatewayRestart({ workspaceRoot: tmpDir, homeDir: tmpDir });

      expect(result.ok).toBe(false);
      expect(result.output).toContain("Gateway service is not installed for profile 'default'.");
      expect(stopGatewaySpy).not.toHaveBeenCalled();
      expect(serviceManagerMock.restartService).not.toHaveBeenCalled();
      expect(childProcessMock.spawn).not.toHaveBeenCalled();
    });

    it("treats --graceful as a v0.1.0 alias for service restart", async () => {
      serviceManagerMock.detectServiceManager.mockReturnValue("systemd-user");
      serviceManagerMock.probeServiceState.mockImplementation(async (options: { profileId: string; system?: boolean }) => ({
        kind: options.system ? "systemd-system" : "systemd-user",
        installed: options.system !== true,
        scope: options.system ? "system" : "user",
        activeState: "active",
        unitName: "unit",
        profileId: options.profileId,
      }));

      const plain = await runGatewayRestart({ workspaceRoot: tmpDir, homeDir: tmpDir });
      const graceful = await runGatewayRestart({ workspaceRoot: tmpDir, homeDir: tmpDir, graceful: true });

      expect(plain.output).toContain("Gateway service restarted");
      expect(graceful.output).toContain("Gateway service restarted");
      expect(serviceManagerMock.restartService).toHaveBeenCalledTimes(2);
      expect(stopGatewaySpy).not.toHaveBeenCalled();
      expect(childProcessMock.spawn).not.toHaveBeenCalled();
    });
  });

  describe("runChannelsEnable", () => {
    it("enables a disabled channel", async () => {
      const configPath = defaultProfileConfigPath(tmpDir);
      await mkdir(dirname(configPath), { recursive: true });
      await writeFile(configPath, JSON.stringify({ channels: { telegram: { enabled: false } } }), "utf8");

      const result = await runChannelsEnable({ workspaceRoot: tmpDir, homeDir: tmpDir, channel: "telegram" });
      expect(result.ok).toBe(true);
      expect(result.output).toBe("Telegram enabled");

      const parsed = JSON.parse(await readFile(configPath, "utf8"));
      expect(parsed.channels.telegram.enabled).toBe(true);
    });

    it("is idempotent when channel already enabled", async () => {
      const configPath = defaultProfileConfigPath(tmpDir);
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
      const configPath = defaultProfileConfigPath(tmpDir);
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
      const configPath = defaultProfileConfigPath(tmpDir);
      await mkdir(dirname(configPath), { recursive: true });
      await writeFile(configPath, JSON.stringify({ channels: { discord: { enabled: true }, telegram: { enabled: false } } }), "utf8");

      const result = await runChannelsEnable({ workspaceRoot: tmpDir, homeDir: tmpDir, channel: "telegram" });
      expect(result.ok).toBe(true);

      const parsed = JSON.parse(await readFile(configPath, "utf8"));
      expect(parsed.channels.discord.enabled).toBe(true);
    });

    it("preserves non-channel config", async () => {
      const configPath = defaultProfileConfigPath(tmpDir);
      await mkdir(dirname(configPath), { recursive: true });
      await writeFile(configPath, JSON.stringify({ model: { provider: "openai" }, channels: { telegram: { enabled: false } } }), "utf8");

      const result = await runChannelsEnable({ workspaceRoot: tmpDir, homeDir: tmpDir, channel: "telegram" });
      expect(result.ok).toBe(true);

      const parsed = JSON.parse(await readFile(configPath, "utf8"));
      expect(parsed.model.provider).toBe("openai");
    });

    it("preserves unknown top-level fields", async () => {
      const configPath = defaultProfileConfigPath(tmpDir);
      await mkdir(dirname(configPath), { recursive: true });
      await writeFile(configPath, JSON.stringify({ customField: 123, channels: { telegram: { enabled: false } } }), "utf8");

      const result = await runChannelsEnable({ workspaceRoot: tmpDir, homeDir: tmpDir, channel: "telegram" });
      expect(result.ok).toBe(true);

      const parsed = JSON.parse(await readFile(configPath, "utf8"));
      expect(parsed.customField).toBe(123);
    });

    it("preserves unknown nested channel fields", async () => {
      const configPath = defaultProfileConfigPath(tmpDir);
      await mkdir(dirname(configPath), { recursive: true });
      await writeFile(configPath, JSON.stringify({ channels: { telegram: { customFlag: true, enabled: false } } }), "utf8");

      const result = await runChannelsEnable({ workspaceRoot: tmpDir, homeDir: tmpDir, channel: "telegram" });
      expect(result.ok).toBe(true);

      const parsed = JSON.parse(await readFile(configPath, "utf8"));
      expect(parsed.channels.telegram.customFlag).toBe(true);
    });

    it("preserves busyPolicy and queueDepth", async () => {
      const configPath = defaultProfileConfigPath(tmpDir);
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

      const configPath = defaultProfileConfigPath(tmpDir);
      const parsed = JSON.parse(await readFile(configPath, "utf8"));
      expect(parsed.channels.telegram.enabled).toBe(true);
    });

    it("fails on invalid JSON without overwriting", async () => {
      const configPath = defaultProfileConfigPath(tmpDir);
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
      const configPath = defaultProfileConfigPath(tmpDir);
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
      const configPath = defaultProfileConfigPath(tmpDir);
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
        const configPath = defaultProfileConfigPath(tmpDir);
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
      const configPath = defaultProfileConfigPath(tmpDir);
      await mkdir(dirname(configPath), { recursive: true });
      await writeFile(configPath, JSON.stringify({ channels: { telegram: { enabled: false } } }), "utf8");

      await runChannelsEnable({ workspaceRoot: tmpDir, homeDir: tmpDir, channel: "telegram" });

      const files = await readdir(dirname(configPath));
      const tempFiles = files.filter((f) => f.startsWith("config.json.tmp-"));
      expect(tempFiles).toHaveLength(0);
    });

    it("leaves original intact on write failure", async () => {
      const configPath = defaultProfileConfigPath(tmpDir);
      await mkdir(dirname(configPath), { recursive: true });
      const original = JSON.stringify({ channels: { telegram: { enabled: false } } });
      await writeFile(configPath, original, "utf8");

      fsPromisesMock.rename.mockRejectedValueOnce(new Error("rename failed"));

      await expect(runChannelsEnable({ workspaceRoot: tmpDir, homeDir: tmpDir, channel: "telegram" })).rejects.toThrow("rename failed");

      const after = await readFile(configPath, "utf8");
      expect(after).toBe(original);
    });
  });

  describe("runChannelsDisable", () => {
    it("disables an enabled channel", async () => {
      const configPath = defaultProfileConfigPath(tmpDir);
      await mkdir(dirname(configPath), { recursive: true });
      await writeFile(configPath, JSON.stringify({ channels: { telegram: { enabled: true } } }), "utf8");

      const result = await runChannelsDisable({ workspaceRoot: tmpDir, homeDir: tmpDir, channel: "telegram" });
      expect(result.ok).toBe(true);
      expect(result.output).toBe("Telegram disabled");

      const parsed = JSON.parse(await readFile(configPath, "utf8"));
      expect(parsed.channels.telegram.enabled).toBe(false);
    });

    it("is idempotent when channel already disabled", async () => {
      const configPath = defaultProfileConfigPath(tmpDir);
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
      const configPath = defaultProfileConfigPath(tmpDir);
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

      const configPath = defaultProfileConfigPath(tmpDir);
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
      const configPath = defaultProfileConfigPath(tmpDir);
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
      const configPath = defaultProfileConfigPath(tmpDir);
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
      const configPath = defaultProfileConfigPath(tmpDir);
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
      const configPath = defaultProfileConfigPath(tmpDir);
      await mkdir(dirname(configPath), { recursive: true });
      await writeFile(configPath, JSON.stringify({ channels: { whatsapp: { enabled: true } } }), "utf8");

      const result = await runChannelsDisable({ workspaceRoot: tmpDir, homeDir: tmpDir, channel: "whatsapp" });
      expect(result.ok).toBe(true);
      expect(result.output).toBe("WhatsApp disabled");
    });
  });
});
