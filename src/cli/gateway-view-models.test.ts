import { describe, it, expect } from "vitest";
import { renderPlain } from "../ui/renderers/plain-renderer.js";
import {
  buildGatewayStatusViewModel,
  buildGatewayDiagnoseViewModel,
  buildChannelsListViewModel,
  buildChannelsStatusViewModel,
} from "./gateway-view-models.js";
import type { GatewayStatusData, GatewayDiagnoseData, ChannelsStatusData } from "./gateway-view-models.js";

function baseStatusData(): GatewayStatusData {
  return {
    channels: {
      telegram: { enabled: true, ready: true, allowedUserIds: [], allowedChatIds: [], missing: undefined },
      discord: { enabled: false, ready: false, missing: undefined },
      email: { enabled: false, ready: false, missing: undefined },
      whatsapp: { enabled: false, ready: false, experimental: false, missing: undefined },
    },
    cronJobs: [],
    recentCronFailures: [],
    recentDeliveryErrors: [],
    surfacePointers: [],
    approvalCount: 0,
    approvalPolicy: "adaptive",
    missingConfig: [],
    serviceManagerStates: [],
    identityLocks: [],
  };
}

function baseDiagnoseData(note?: GatewayDiagnoseData["runtimeStateNote"], cacheNote?: GatewayDiagnoseData["runtimeCacheStateNote"]): GatewayDiagnoseData {
  return {
    telegram: {
      adapter: "telegram",
      enabled: true,
      ready: true,
      statusLabel: "ok",
      modelRoute: "openai/gpt-4",
      contextWindowTokens: 8192,
      securityLabel: "allowlist",
      allowedUserIds: [],
      allowedChatIds: [],
      groupSessionsPerUser: true,
      threadSessionsPerUser: false,
      sessionResetPolicy: "none",
      botTokenEnv: "BOT_TOKEN",
      botTokenPresent: true,
      defaultChatId: "123",
      missing: [],
      processMode: "foreground",
      logsLocation: "stdout",
      stateRoot: "/tmp/.estacoda",
      sessionDbPath: "/tmp/.estacoda/sessions.sqlite",
      mediaRoot: "/tmp/.estacoda/channel-media",
      approvalStorePath: "/tmp/.estacoda/channel-approvals.json",
      sessionContextPath: "/tmp/.estacoda/channel-sessions.json",
      configSources: [],
    },
    discord: { enabled: false, ready: false, missing: undefined },
    email: { enabled: false, ready: false, missing: undefined },
    whatsapp: {
      adapter: "whatsapp",
      enabled: false,
      experimental: false,
      ready: false,
      statusLabel: "disabled",
      pairingPending: false,
      authDir: "/tmp/.estacoda/whatsapp-auth",
      authDirWritable: false,
      bridgeDir: "/tmp/estacoda/scripts/whatsapp-bridge",
      bridgePackagePresent: false,
      bridgeLockfilePresent: false,
      bridgeEntrypointPresent: false,
      bridgeReadmePresent: false,
      bridgeDependenciesInstalled: false,
      missing: [],
    },
    whatsappExperimental: false,
    cronJobs: [],
    jobsFileReadable: true,
    outputDirWritable: true,
    lockDirWritable: true,
    supervisor: { pidHealthy: true, lockHealthy: true },
    identityLockHealth: { staleLocks: [], duplicateHashes: [], missingLocks: [] },
    runtimeStateNote: note,
    runtimeCacheStateNote: cacheNote,
    approvalCount: 0,
    recentDeliveryErrors: [],
    channels: baseStatusData().channels,
  };
}

function baseChannelsStatusData(overrides?: Partial<NonNullable<ChannelsStatusData["telegram"]>>): ChannelsStatusData {
  return {
    channel: "telegram",
    telegram: {
      diag: {
        adapter: "telegram",
        enabled: true,
        ready: true,
        statusLabel: "ready",
        modelRoute: "openai/gpt-4",
        contextWindowTokens: 8192,
        securityLabel: "allowlist",
        allowedUserIds: [],
        allowedChatIds: [],
        groupSessionsPerUser: true,
        threadSessionsPerUser: false,
        sessionResetPolicy: "none",
        botTokenEnv: "BOT_TOKEN",
        botTokenPresent: true,
        defaultChatId: "123",
        missing: [],
        processMode: "foreground",
        logsLocation: "stdout",
        stateRoot: "/tmp/.estacoda",
        sessionDbPath: "/tmp/.estacoda/sessions.sqlite",
        mediaRoot: "/tmp/.estacoda/channel-media",
        approvalStorePath: "/tmp/.estacoda/channel-approvals.json",
        sessionContextPath: "/tmp/.estacoda/channel-sessions.json",
        configSources: [],
      },
      pointers: [],
      capability: { kind: "telegram", enabled: true, configured: true, inboundMode: "websocket", outboundMode: "push", supportsAttachments: true, supportsThreads: true, supportsApprovals: false, supportsProgressStreaming: false, experimental: false, implementationStatus: "live_proven", missingConfig: undefined },
      runtimeStateNote: "unavailable (supervisor not running)",
      identityLock: undefined,
      busyPolicy: "reject",
      queueDepth: 3,
      ...overrides,
    },
  };
}

describe("buildGatewayStatusViewModel", () => {
  it("renders without runtime state", () => {
    const data = baseStatusData();
    const vm = buildGatewayStatusViewModel(data);
    const rendered = renderPlain(vm);
    expect(rendered).toContain("EstaCoda gateway status");
    expect(rendered).not.toContain("Adapter Runtime");
  });

  it("renders background memory finalization health when available", () => {
    const vm = buildGatewayStatusViewModel({
      ...baseStatusData(),
      sessionFinalization: { pending: 2, running: 1, retrying: 3, failed: 4 },
    });
    const rendered = renderPlain(vm);
    expect(rendered).toContain("Memory finalization");
    expect(rendered).toContain("Pending: 2");
    expect(rendered).toContain("Running: 1");
    expect(rendered).toContain("Retrying: 3");
    expect(rendered).toContain("Failed: 4");
  });

  it("renders with adapter runtime block when state is valid", () => {
    const data: GatewayStatusData = {
      ...baseStatusData(),
      runtimeState: {
        supervisorPid: 1234,
        supervisorStartedAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:01:00.000Z",
        adapters: [
          {
            kind: "telegram",
            state: "healthy",
            pollsTotal: 5,
            pollsFailed: 0,
            pollMessagesProcessed: 12,
          },
          {
            kind: "discord",
            state: "retry_scheduled",
            pendingOperation: "poll",
            pollsTotal: 3,
            pollsFailed: 2,
            pollMessagesProcessed: 0,
            retry: { attempt: 2, maxAttempts: 5, nextRetryAt: "2024-01-01T00:02:00.000Z" },
            lastError: { message: "network timeout", timestamp: "2024-01-01T00:01:00.000Z", count: 2 },
          },
        ],
      },
    };
    const vm = buildGatewayStatusViewModel(data);
    const rendered = renderPlain(vm);
    expect(rendered).toContain("Adapter Runtime");
    expect(rendered).toContain("telegram: healthy | polls=5 processed=12 failed=0");
    expect(rendered).toContain("discord: retry_scheduled");
    expect(rendered).toContain("retry 2/5 at 2024-01-01T00:02:00.000Z");
    expect(rendered).toContain("network timeout (x2)");
  });

  it("renders with runtime cache blocks when state is present", () => {
    const data: GatewayStatusData = {
      ...baseStatusData(),
      runtimeCacheState: {
        version: 1,
        writtenAt: new Date().toISOString(),
        supervisorPid: process.pid,
        supervisorStartedAt: new Date().toISOString(),
        cacheStats: {
          totalEntries: 3,
          activeBorrows: 1,
          suspendedEntries: 1,
          totalCreated: 10,
          totalReused: 5,
          totalDisposed: 2,
          totalInvalidated: 0,
        },
        suspendedSummary: [{ sessionId: "sess-1", reason: "stuck-loop", suspendedAt: new Date().toISOString() }],
        registryStats: {
          activeTurnCount: 2,
          totalStarted: 20,
          totalEnded: 18,
          totalAborted: 0,
          stuckTurnCount: 1,
          repeatStuckCount: 0,
        },
        stuckTurnHistory: [{ turnId: "turn-1", keyHash: "abc", startedAt: "2024-01-01T00:00:00Z", endedAt: "2024-01-01T00:01:00Z", durationMs: 60000, wasAborted: true }],
        fingerprintHash: "abc123",
      },
    };
    const vm = buildGatewayStatusViewModel(data);
    const rendered = renderPlain(vm);
    expect(rendered).toContain("Runtime Cache");
    expect(rendered).toContain("Entries:");
    expect(rendered).toContain("Active Turns");
    expect(rendered).toContain("Active turns:");
    expect(rendered).toContain("Suspended Sessions");
    expect(rendered).toContain("sess-1");
    expect(rendered).toContain("Stuck Turn History");
    expect(rendered).toContain("turn-1");
  });

  it("omits runtime cache blocks when state is absent", () => {
    const data = baseStatusData();
    const vm = buildGatewayStatusViewModel(data);
    const rendered = renderPlain(vm);
    expect(rendered).not.toContain("Runtime Cache");
    expect(rendered).not.toContain("Active Turns");
    expect(rendered).not.toContain("Suspended Sessions");
    expect(rendered).not.toContain("Stuck Turn History");
  });
});

describe("buildGatewayDiagnoseViewModel", () => {
  it("renders without runtime state notes when healthy", () => {
    const data = baseDiagnoseData();
    const vm = buildGatewayDiagnoseViewModel(data);
    const rendered = renderPlain(vm);
    expect(rendered).toContain("EstaCoda gateway diagnose");
    expect(rendered).not.toContain("Adapter Runtime");
  });

  it("renders stale runtime state warning", () => {
    const data = baseDiagnoseData("stale");
    const vm = buildGatewayDiagnoseViewModel(data);
    const rendered = renderPlain(vm);
    expect(rendered).toContain("[WARN] Adapter Runtime: runtime state is stale (supervisor may have crashed)");
  });

  it("renders stale runtime-cache-state warning", () => {
    const data = baseDiagnoseData(undefined, "stale");
    const vm = buildGatewayDiagnoseViewModel(data);
    const rendered = renderPlain(vm);
    expect(rendered).toContain("[WARN] Runtime Cache: runtime-cache-state is stale (supervisor may have crashed)");
  });

  it("renders pid-mismatch runtime-cache-state warning", () => {
    const data = baseDiagnoseData(undefined, "pid-mismatch");
    const vm = buildGatewayDiagnoseViewModel(data);
    const rendered = renderPlain(vm);
    expect(rendered).toContain("[WARN] Runtime Cache: runtime-cache-state PID does not match current supervisor PID");
  });

  it("renders supervisor-not-live runtime-cache-state warning", () => {
    const data = baseDiagnoseData(undefined, "supervisor-not-live");
    const vm = buildGatewayDiagnoseViewModel(data);
    const rendered = renderPlain(vm);
    expect(rendered).toContain("[WARN] Runtime Cache: runtime-cache-state exists but supervisor is not live");
  });

  it("summarizes cron directory problems in one warning block", () => {
    const data: GatewayDiagnoseData = {
      ...baseDiagnoseData(),
      jobsFileReadable: false,
      outputDirWritable: false,
      lockDirWritable: false,
    };
    const vm = buildGatewayDiagnoseViewModel(data);
    const rendered = renderPlain(vm);
    const cronWarningCount = rendered.match(/\[WARN\] Cron:/g)?.length ?? 0;

    expect(rendered).toContain("[WARN] Jobs file: not readable");
    expect(rendered).toContain("[WARN] Output dir: not writable");
    expect(rendered).toContain("[WARN] Lock dir: not writable");
    expect(cronWarningCount).toBe(1);
    expect(rendered).toContain(
      "[WARN] Cron: jobs file not readable; output directory not writable; lock directory not writable. Run estacoda init if this is a fresh state home."
    );
  });

  it("warns when recent delivery errors >= 3", () => {
    const data: GatewayDiagnoseData = {
      ...baseDiagnoseData(),
      recentDeliveryErrors: [
        { timestamp: "2024-01-01T00:00:00Z", target: "telegram:123", error: "fail", retryCount: 0 },
        { timestamp: "2024-01-01T00:01:00Z", target: "telegram:123", error: "fail", retryCount: 0 },
        { timestamp: "2024-01-01T00:02:00Z", target: "telegram:123", error: "fail", retryCount: 0 },
      ],
    };
    const vm = buildGatewayDiagnoseViewModel(data);
    const rendered = renderPlain(vm);
    expect(rendered).toContain("[WARN] Delivery: 3 recent delivery errors (last 5 records)");
  });

  it("shows info note when granted approvals >= 20", () => {
    const data: GatewayDiagnoseData = {
      ...baseDiagnoseData(),
      approvalCount: 20,
    };
    const vm = buildGatewayDiagnoseViewModel(data);
    const rendered = renderPlain(vm);
    expect(rendered).toContain("[INFO] Approvals: 20 granted approvals accumulated");
  });

  it("shows info note when enabled channel queueDepth > 5", () => {
    const data: GatewayDiagnoseData = {
      ...baseDiagnoseData(),
      channels: {
        ...baseDiagnoseData().channels,
        telegram: { ...baseDiagnoseData().channels.telegram, enabled: true, queueDepth: 7 },
      },
    };
    const vm = buildGatewayDiagnoseViewModel(data);
    const rendered = renderPlain(vm);
    expect(rendered).toContain("[INFO] Channels: telegram queue depth is 7 (potential memory pressure)");
  });
});

describe("buildChannelsStatusViewModel runtime extension", () => {
  it("renders busy policy and queue depth", () => {
    const rendered = renderPlain(buildChannelsStatusViewModel(baseChannelsStatusData({ busyPolicy: "queue", queueDepth: 7 })));
    expect(rendered).toContain("Busy policy: queue");
    expect(rendered).toContain("Queue depth: 7");
  });

  it("renders default busy policy and queue depth", () => {
    const rendered = renderPlain(buildChannelsStatusViewModel(baseChannelsStatusData()));
    expect(rendered).toContain("Busy policy: reject");
    expect(rendered).toContain("Queue depth: 3");
  });

  it("renders busy policy interrupt", () => {
    const rendered = renderPlain(buildChannelsStatusViewModel(baseChannelsStatusData({ busyPolicy: "interrupt" })));
    expect(rendered).toContain("Busy policy: interrupt");
    expect(rendered).not.toContain("drop");
  });

  it("renders identity lock locked", () => {
    const rendered = renderPlain(buildChannelsStatusViewModel(baseChannelsStatusData({ identityLock: { kind: "telegram", state: "locked", pid: 12345 } })));
    expect(rendered).toContain("Identity lock: locked (pid 12345)");
  });

  it("renders identity lock stale", () => {
    const rendered = renderPlain(buildChannelsStatusViewModel(baseChannelsStatusData({ identityLock: { kind: "telegram", state: "stale", pid: 99999 } })));
    expect(rendered).toContain("Identity lock: stale (pid 99999, dead)");
  });

  it("renders identity lock corrupt", () => {
    const rendered = renderPlain(buildChannelsStatusViewModel(baseChannelsStatusData({ identityLock: { kind: "telegram", state: "stale", pid: -1 } })));
    expect(rendered).toContain("Identity lock: corrupt");
  });

  it("renders identity lock unlocked", () => {
    const rendered = renderPlain(buildChannelsStatusViewModel(baseChannelsStatusData({ identityLock: undefined })));
    expect(rendered).toContain("Identity lock: unlocked");
  });

  it("renders runtime state unavailable when supervisor not running", () => {
    const rendered = renderPlain(buildChannelsStatusViewModel(baseChannelsStatusData({ runtimeStateNote: "unavailable (supervisor not running)" })));
    expect(rendered).toContain("Runtime state: unavailable (supervisor not running)");
  });

  it("renders runtime state stale when old", () => {
    const rendered = renderPlain(buildChannelsStatusViewModel(baseChannelsStatusData({ runtimeStateNote: "stale (last update >5min ago)" })));
    expect(rendered).toContain("Runtime state: stale (last update >5min ago)");
  });

  it("renders adapter runtime details when trusted", () => {
    const rendered = renderPlain(buildChannelsStatusViewModel(baseChannelsStatusData({
      runtimeStateNote: undefined,
      adapterRuntime: {
        kind: "telegram",
        state: "healthy",
        pollsTotal: 5,
        pollMessagesProcessed: 3,
        pollsFailed: 0,
      },
    })));
    expect(rendered).toContain("State: healthy");
    expect(rendered).toContain("Polls: 5");
    expect(rendered).toContain("Processed: 3");
    expect(rendered).toContain("Failed: 0");
  });

  it("renders not-registered when adapter entry missing", () => {
    const rendered = renderPlain(buildChannelsStatusViewModel(baseChannelsStatusData({ runtimeStateNote: undefined, adapterRuntime: undefined })));
    expect(rendered).toContain("Adapter: not registered in runtime state");
  });
});

describe("buildChannelsListViewModel", () => {
  it("renders channel list", () => {
    const vm = buildChannelsListViewModel({
      channels: baseStatusData().channels,
      capabilities: [
        { kind: "telegram", enabled: true, configured: true, inboundMode: "websocket", outboundMode: "push", supportsAttachments: true, supportsThreads: true, supportsApprovals: false, supportsProgressStreaming: false, experimental: false, implementationStatus: "live_proven", missingConfig: undefined },
        { kind: "discord", enabled: false, configured: false, inboundMode: "websocket", outboundMode: "push", supportsAttachments: true, supportsThreads: true, supportsApprovals: false, supportsProgressStreaming: false, experimental: false, implementationStatus: "live_proven", missingConfig: undefined },
        { kind: "email", enabled: false, configured: false, inboundMode: "polling", outboundMode: "push", supportsAttachments: true, supportsThreads: false, supportsApprovals: false, supportsProgressStreaming: false, experimental: false, implementationStatus: "live_proven", missingConfig: undefined },
        { kind: "whatsapp", enabled: false, configured: false, inboundMode: "websocket", outboundMode: "push", supportsAttachments: true, supportsThreads: true, supportsApprovals: false, supportsProgressStreaming: false, experimental: true, implementationStatus: "present_not_live_proven", missingConfig: undefined },
      ],
    });
    const rendered = renderPlain(vm);
    expect(rendered).toContain("EstaCoda channels");
    expect(rendered).toContain("telegram");
    expect(rendered).toContain("discord");
  });
});
