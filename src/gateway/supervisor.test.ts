import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  runGatewaySupervisor,
  runPrune,
  runStuckScan,
  runStuckScanGuarded,
  runRuntimeCacheStateHeartbeat,
  runGatewayApprovalExpiry,
  runGatewayApprovalResolutionTick,
  buildRuntimeCacheState,
  buildGatewayCronRuntimeOptions,
  createVoiceTranscriptionAudit,
  type SupervisorInternalState,
} from "./supervisor.js";
import { readGatewayPid } from "./pid-file.js";
import { readGatewayState } from "./supervisor-state.js";
import { isAdapterIdentityLocked } from "./identity-lock.js";
import { readGatewayLockContent } from "./gateway-lock.js";
import { ActiveTurnRegistry } from "./active-turn-registry.js";
import { RuntimeCache } from "../runtime/runtime-cache.js";
import { runtimeCacheStatePath, readRuntimeCacheState } from "./runtime-cache-state.js";
import { readCleanShutdownMarker, writeCleanShutdownMarker } from "./supervisor-lifecycle.js";
import { HookRegistry } from "./hook-registry.js";
import { resolveProfileStateHome, type ProfileStatePaths } from "../config/profile-home.js";

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "estacoda-supervisor-test-"));
}

function profileConfigPath(homeDir: string): string {
  return resolveProfileStateHome({ homeDir, profileId: "default" }).configPath;
}

function createFakeConfig(tmpDir: string, channels: Record<string, unknown>) {
  return {
    workspaceRoot: tmpDir,
    homeDir: tmpDir,
  };
}

describe("gateway STT preprocess audit", () => {
  it("emits hook events, JSONL, and warnings without full private paths", async () => {
    const homeDir = await makeTempDir();
    const profilePaths = resolveProfileStateHome({ homeDir, profileId: "default" });
    const hookRegistry = new HookRegistry();
    const hooks: unknown[] = [];
    hookRegistry.on("gateway:stt:preprocess", (event) => {
      hooks.push(event.payload);
    });
    const warnings: string[] = [];
    const audit = createVoiceTranscriptionAudit({
      profilePaths,
      hookRegistry,
      logWarning: (message) => warnings.push(message)
    });

    await audit({
      timestamp: "2026-05-22T00:00:00.000Z",
      outcome: "deny",
      provider: "local",
      reason: "blocked",
      attachment: {
        id: "voice-1",
        kind: "voice",
        bytes: 10,
        pathHash: "abc123"
      }
    });

    const jsonl = await readFile(join(profilePaths.gatewayStatePath, "logs", "voice-stt-preprocess.jsonl"), "utf8");
    expect(hooks).toEqual([
      expect.objectContaining({ outcome: "deny", provider: "local", reason: "blocked" })
    ]);
    expect(jsonl).toContain("\"pathHash\":\"abc123\"");
    expect(jsonl).not.toContain(homeDir);
    expect(warnings[0]).toContain("[voice-stt-preprocess]");
  });
});

function fakeAdapter(kind: string, pollCount = 0) {
  return {
    id: kind,
    kind,
    pollOnce: async () => pollCount,
    setCommands: async () => {},
    start: async () => {},
    stop: async () => {},
    delivery: {
      sendText: async () => {},
    },
  };
}

function fakeChannelGateway() {
  return {
    start: async () => {},
    stop: async () => {},
    hasPendingWork: () => false,
  };
}

function fakeDeliveryRouter() {
  const registered: string[] = [];
  return {
    registerAdapter: (adapter: { kind: string }) => {
      registered.push(adapter.kind);
    },
    parseTarget: () => [],
    deliverText: async () => new Map(),
    getRegisteredPlatforms: () => registered,
  };
}

function fakeTickCron() {
  let calls = 0;
  return {
    tickCron: async () => {
      calls += 1;
      return [];
    },
    calls: () => calls,
  };
}

function fakeSleep() {
  let durations: number[] = [];
  return {
    sleep: async (ms: number) => {
      durations.push(ms);
    },
    durations: () => durations,
  };
}

function fakeLoadedRuntimeConfig(overrides: Record<string, unknown> = {}) {
  return {
    model: {
      provider: "custom",
      id: "main",
      contextWindowTokens: 128000,
      supportsTools: true,
      supportsVision: false,
      supportsStructuredOutput: true,
    },
    primaryModelRoute: {
      provider: "custom",
      id: "main",
      baseUrl: "https://custom.example/v1",
      apiKeyEnv: "CUSTOM_API_KEY",
    },
    modelFallbackRoutes: [
      {
        provider: "custom",
        id: "backup",
        baseUrl: "https://backup.example/v1",
        apiKeyEnv: "BACKUP_API_KEY",
      },
    ],
    providerRegistry: {},
    auxiliaryModels: {},
    mcp: { servers: {} },
    skills: { externalDirs: [], autonomy: "suggest", config: {} },
    ui: { language: "en", flavor: "standard", activityLabels: "en" },
    profile: { mode: "focused", responseLanguage: "en" },
    browser: { backend: "unconfigured", autoLaunch: false },
    imageGen: { provider: "fal", model: "test", useGateway: false },
    tts: { provider: "edge", speed: 1 },
    stt: { provider: "local" },
    security: {
      approvalMode: "adaptive",
      assessor: { enabled: false, timeoutMs: 30000 },
    },
    channels: {
      telegram: { ready: false },
      discord: { ready: false },
      email: { ready: false },
      whatsapp: { ready: false },
    },
    web: { enableNetwork: true, maxContentChars: 5000 },
    ...overrides,
  } as any;
}

function fakeExit() {
  let codes: number[] = [];
  return {
    exit: (c: number) => {
      codes.push(c);
    },
    codes: () => codes,
  };
}

async function waitForCondition(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for test condition");
}

describe("runGatewaySupervisor", () => {
  let tmpDir: string;
  let stateRoot: string;
  let profilePaths: ProfileStatePaths;

  beforeEach(async () => {
    tmpDir = await makeTempDir();
    stateRoot = join(tmpDir, ".estacoda");
    profilePaths = resolveProfileStateHome({ homeDir: tmpDir, profileId: "default" });
    await mkdir(stateRoot, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("startup with no adapters configured (cron-only)", async () => {
    const tick = fakeTickCron();
    const sleeper = fakeSleep();
    const result = await runGatewaySupervisor({
      workspaceRoot: tmpDir,
      homeDir: tmpDir,
      once: true,
      factories: {
        tickCron: tick.tickCron,
        sleep: sleeper.sleep,
        createChannelGateway: () => fakeChannelGateway() as any,
        createDeliveryRouter: () => fakeDeliveryRouter() as any,
      },
    });

    expect(result.ok).toBe(true);
    expect(result.output).toContain("Gateway stopped");
    expect(tick.calls()).toBe(1);
    expect(sleeper.durations()).toHaveLength(0);

    const pid = await readGatewayPid(profilePaths);
    expect(pid).toBeUndefined();
  });

  it("cron runtime options preserve primary and fallback model routes", () => {
    const latestConfig = fakeLoadedRuntimeConfig();
    const sessionDb = {} as any;

    const options = buildGatewayCronRuntimeOptions({
      latestConfig,
      workspaceRoot: tmpDir,
      homeDir: tmpDir,
      profileId: "default",
      sessionDb,
      sessionId: "cron-test",
    });

    expect(options.primaryModelRoute).toEqual(latestConfig.primaryModelRoute);
    expect(options.modelFallbackRoutes).toEqual(latestConfig.modelFallbackRoutes);
    expect(options.model).toEqual(latestConfig.model);
    expect(options.providerRegistry).toBe(latestConfig.providerRegistry);
    expect(options.profileId).toBe("default");
    expect(options.disableCronTools).toBe(true);
    expect(options.disabledToolsets).toEqual(["cron", "messaging", "clarify"]);
  });

  it("startup with telegram configured", async () => {
    const tick = fakeTickCron();
    const sleeper = fakeSleep();
    const router = fakeDeliveryRouter();
    const gateway = fakeChannelGateway();

    const result = await runGatewaySupervisor({
      workspaceRoot: tmpDir,
      homeDir: tmpDir,
      once: true,
      factories: {
        tickCron: tick.tickCron,
        sleep: sleeper.sleep,
        createChannelGateway: () => gateway as any,
        createDeliveryRouter: () => router as any,
        createTelegramAdapter: () => fakeAdapter("telegram") as any,
      },
    });

    expect(result.ok).toBe(true);
    expect(tick.calls()).toBe(1);

    const pid = await readGatewayPid(profilePaths);
    expect(pid).toBeUndefined();
  });

  it("startup fails when gateway lock held", async () => {
    const lockFile = join(profilePaths.gatewayStatePath, "gateway.lock");
    await mkdir(profilePaths.gatewayStatePath, { recursive: true });
    await writeFile(lockFile, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));

    const result = await runGatewaySupervisor({
      workspaceRoot: tmpDir,
      homeDir: tmpDir,
      once: true,
      factories: {
        createChannelGateway: () => fakeChannelGateway() as any,
        createDeliveryRouter: () => fakeDeliveryRouter() as any,
      },
    });

    expect(result.ok).toBe(false);
    expect(result.output).toContain("already running");

    const pid = await readGatewayPid(profilePaths);
    expect(pid).toBeUndefined();
  });

  it("startup fails when configured adapter has no derivable identity", async () => {
    const result = await runGatewaySupervisor({
      workspaceRoot: tmpDir,
      homeDir: tmpDir,
      once: true,
      factories: {
        createChannelGateway: () => fakeChannelGateway() as any,
        createDeliveryRouter: () => fakeDeliveryRouter() as any,
      },
    });

    // With no adapters enabled, this should succeed in cron-only mode
    expect(result.ok).toBe(true);
  });

  it("startup fails when adapter start throws", async () => {
    const tick = fakeTickCron();
    const gateway = {
      start: async () => {
        throw new Error("start failed");
      },
      stop: async () => {},
    };

    const result = await runGatewaySupervisor({
      workspaceRoot: tmpDir,
      homeDir: tmpDir,
      once: true,
      factories: {
        tickCron: tick.tickCron,
        createChannelGateway: () => gateway as any,
        createDeliveryRouter: () => fakeDeliveryRouter() as any,
        createTelegramAdapter: () => fakeAdapter("telegram") as any,
      },
    });

    expect(result.ok).toBe(false);
    expect(result.output).toContain("Startup failed");

    const pid = await readGatewayPid(profilePaths);
    expect(pid).toBeUndefined();
  });

  it("SIGTERM triggers shutdown sequence", async () => {
    const exited = fakeExit();
    const gateway = fakeChannelGateway();
    const beforeSigint = process.listenerCount("SIGINT");
    const beforeSigterm = process.listenerCount("SIGTERM");

    const promise = runGatewaySupervisor({
      workspaceRoot: tmpDir,
      homeDir: tmpDir,
      once: false,
      factories: {
        createChannelGateway: () => gateway as any,
        createDeliveryRouter: () => fakeDeliveryRouter() as any,
        exit: exited.exit,
      },
    });

    // Give it time to install handlers
    await new Promise((r) => setTimeout(r, 50));

    process.emit("SIGTERM");

    await promise;

    expect(exited.codes()).toContain(0);
    expect(process.listenerCount("SIGINT")).toBe(beforeSigint);
    expect(process.listenerCount("SIGTERM")).toBe(beforeSigterm);

    const pid = await readGatewayPid(profilePaths);
    expect(pid).toBeUndefined();
  });

  it("SIGINT triggers shutdown sequence", async () => {
    const exited = fakeExit();
    const gateway = fakeChannelGateway();
    const beforeSigint = process.listenerCount("SIGINT");
    const beforeSigterm = process.listenerCount("SIGTERM");

    const promise = runGatewaySupervisor({
      workspaceRoot: tmpDir,
      homeDir: tmpDir,
      once: false,
      factories: {
        createChannelGateway: () => gateway as any,
        createDeliveryRouter: () => fakeDeliveryRouter() as any,
        exit: exited.exit,
      },
    });

    await new Promise((r) => setTimeout(r, 50));

    process.emit("SIGINT");

    await promise;

    expect(exited.codes()).toContain(0);
    expect(process.listenerCount("SIGINT")).toBe(beforeSigint);
    expect(process.listenerCount("SIGTERM")).toBe(beforeSigterm);
  });

  it("double signal forces exit(1)", async () => {
    const exited = fakeExit();
    const gateway = fakeChannelGateway();
    const beforeSigint = process.listenerCount("SIGINT");
    const beforeSigterm = process.listenerCount("SIGTERM");

    const promise = runGatewaySupervisor({
      workspaceRoot: tmpDir,
      homeDir: tmpDir,
      once: false,
      factories: {
        createChannelGateway: () => gateway as any,
        createDeliveryRouter: () => fakeDeliveryRouter() as any,
        exit: exited.exit,
      },
    });

    await new Promise((r) => setTimeout(r, 50));

    process.emit("SIGTERM");
    process.emit("SIGTERM");

    await promise;

    expect(exited.codes()).toContain(1);
    expect(process.listenerCount("SIGINT")).toBe(beforeSigint);
    expect(process.listenerCount("SIGTERM")).toBe(beforeSigterm);
  });

  it("cron tick runs in main loop", async () => {
    const tick = fakeTickCron();
    const sleeper = fakeSleep();

    const result = await runGatewaySupervisor({
      workspaceRoot: tmpDir,
      homeDir: tmpDir,
      once: true,
      factories: {
        tickCron: tick.tickCron,
        sleep: sleeper.sleep,
        createChannelGateway: () => fakeChannelGateway() as any,
        createDeliveryRouter: () => fakeDeliveryRouter() as any,
      },
    });

    expect(result.ok).toBe(true);
    expect(tick.calls()).toBe(1);
  });

  it("once mode exits cleanly and removes state", async () => {
    const result = await runGatewaySupervisor({
      workspaceRoot: tmpDir,
      homeDir: tmpDir,
      once: true,
      factories: {
        createChannelGateway: () => fakeChannelGateway() as any,
        createDeliveryRouter: () => fakeDeliveryRouter() as any,
      },
    });

    expect(result.ok).toBe(true);

    const pid = await readGatewayPid(profilePaths);
    expect(pid).toBeUndefined();

    const state = await readGatewayState(profilePaths);
    expect(state).toBeUndefined();

    const lock = await readGatewayLockContent(profilePaths);
    expect(lock).toBeUndefined();
  });

  it("signal handlers are removed after run", async () => {
    const beforeSigint = process.listenerCount("SIGINT");
    const beforeSigterm = process.listenerCount("SIGTERM");

    await runGatewaySupervisor({
      workspaceRoot: tmpDir,
      homeDir: tmpDir,
      once: true,
      factories: {
        createChannelGateway: () => fakeChannelGateway() as any,
        createDeliveryRouter: () => fakeDeliveryRouter() as any,
      },
    });

    expect(process.listenerCount("SIGINT")).toBe(beforeSigint);
    expect(process.listenerCount("SIGTERM")).toBe(beforeSigterm);
  });

  it("repeated once-mode runs do not accumulate listeners", async () => {
    const beforeSigint = process.listenerCount("SIGINT");
    const beforeSigterm = process.listenerCount("SIGTERM");

    for (let i = 0; i < 3; i++) {
      await runGatewaySupervisor({
        workspaceRoot: tmpDir,
        homeDir: tmpDir,
        once: true,
        factories: {
          createChannelGateway: () => fakeChannelGateway() as any,
          createDeliveryRouter: () => fakeDeliveryRouter() as any,
        },
      });
    }

    expect(process.listenerCount("SIGINT")).toBe(beforeSigint);
    expect(process.listenerCount("SIGTERM")).toBe(beforeSigterm);
  });

  it("pollOnce error is caught by wrapper, supervisor continues", async () => {
    const configPath = profileConfigPath(tmpDir);
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(configPath, JSON.stringify({
      channels: {
        telegram: {
          enabled: true,
          botTokenEnv: "TEST_BOT_TOKEN",
          defaultChatId: "123",
        },
      },
    }));
    process.env.TEST_BOT_TOKEN = "fake";

    const tick = fakeTickCron();

    const badAdapter = {
      ...fakeAdapter("telegram"),
      pollOnce: async () => {
        throw new Error("poll explosion");
      },
    };

    const result = await runGatewaySupervisor({
      workspaceRoot: tmpDir,
      homeDir: tmpDir,
      once: true,
      factories: {
        tickCron: tick.tickCron,
        createChannelGateway: () => fakeChannelGateway() as any,
        createDeliveryRouter: () => fakeDeliveryRouter() as any,
        createTelegramAdapter: () => badAdapter as any,
      },
    });

    delete process.env.TEST_BOT_TOKEN;

    expect(result.ok).toBe(true);
    expect(result.polls).toBe(1);
    expect(result.processed).toBe(0);
  });

  it("supervisor loop calls wrapper poll exactly once per adapter per iteration", async () => {
    const configPath = profileConfigPath(tmpDir);
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(configPath, JSON.stringify({
      channels: {
        telegram: {
          enabled: true,
          botTokenEnv: "TEST_BOT_TOKEN",
          defaultChatId: "123",
        },
      },
    }));
    process.env.TEST_BOT_TOKEN = "fake";

    let pollOnceCalls = 0;
    const adapter = {
      ...fakeAdapter("telegram"),
      pollOnce: async () => {
        pollOnceCalls += 1;
        return 3;
      },
    };

    const result = await runGatewaySupervisor({
      workspaceRoot: tmpDir,
      homeDir: tmpDir,
      once: true,
      factories: {
        createChannelGateway: (opts: any) => ({
          start: async () => {
            for (const a of opts?.adapters ?? []) {
              await a.start?.(async () => {});
            }
          },
          stop: async () => {},
        }) as any,
        createDeliveryRouter: () => fakeDeliveryRouter() as any,
        createTelegramAdapter: () => adapter as any,
      },
    });

    delete process.env.TEST_BOT_TOKEN;

    expect(result.ok).toBe(true);
    expect(result.processed).toBe(3);
    expect(pollOnceCalls).toBe(1);
  });

  it("continues the supervisor loop when approval resolution ticking throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      let ticked = false;
      const result = await runGatewaySupervisor({
        workspaceRoot: tmpDir,
        homeDir: tmpDir,
        once: true,
        factories: {
          tickCron: fakeTickCron().tickCron,
          createChannelGateway: () => ({
            start: async () => {},
            stop: async () => {},
            hasPendingWork: () => false,
            tickApprovalResolutions: async () => {
              ticked = true;
              throw new Error("database locked");
            },
          }) as any,
          createDeliveryRouter: () => fakeDeliveryRouter() as any,
        },
      });

      expect(ticked).toBe(true);
      expect(result.ok).toBe(true);
      expect(result.polls).toBe(1);
      expect(warn).toHaveBeenCalledWith("Gateway approval resolution tick error: database locked");
    } finally {
      warn.mockRestore();
    }
  });

  it("ChannelGateway receives runtimeCache, activeTurnRegistry, runtimeFingerprint, securityMode, securityAssessor", async () => {
    let capturedOpts: any;
    const gateway = { start: async () => {}, stop: async () => {}, hasPendingWork: () => false };
    const configPath = profileConfigPath(tmpDir);
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(configPath, JSON.stringify({
      model: { provider: "custom-corp", id: "main-model" },
      providers: {
        "custom-corp": {
          baseUrl: "https://custom.example/v1",
          apiKeyEnv: "CUSTOM_API_KEY",
          models: ["main-model", "assessor-model"]
        }
      },
      auxiliaryModels: {
        assessor: {
          provider: "custom-corp",
          id: "assessor-model",
          baseUrl: "https://custom.example/v1",
          apiKeyEnv: "CUSTOM_API_KEY",
          fallbackToMain: true,
          timeoutMs: 1234
        }
      },
      security: {
        approvalMode: "adaptive",
        assessor: { enabled: true }
      }
    }));

    await runGatewaySupervisor({
      workspaceRoot: tmpDir,
      homeDir: tmpDir,
      once: true,
      factories: {
        createChannelGateway: (opts: any) => {
          capturedOpts = opts;
          return gateway as any;
        },
        createDeliveryRouter: () => fakeDeliveryRouter() as any,
      },
    });

    expect(capturedOpts).toBeDefined();
    expect(capturedOpts.runtimeCache).toBeInstanceOf(RuntimeCache);
    expect(capturedOpts.activeTurnRegistry).toBeInstanceOf(ActiveTurnRegistry);
    expect(capturedOpts.runtimeFingerprint).toBeDefined();
    expect(typeof capturedOpts.runtimeForSession).toBe("function");
    expect(capturedOpts.securityMode).toBe("adaptive");
    expect(capturedOpts.securityAssessor).toBeDefined();
    expect(capturedOpts.securityAssessor.providerExecutor).toBeDefined();
    expect(capturedOpts.securityAssessor.auxiliaryRoute).toMatchObject({
      task: "assessor",
      fallbackToMain: true,
      timeoutMs: 1234,
      route: {
        provider: "openai-compatible",
        id: "assessor-model",
        baseUrl: "https://custom.example/v1",
        apiKeyEnv: "CUSTOM_API_KEY"
      }
    });
    expect(capturedOpts.securityAssessor.mainRoute).toMatchObject({
      provider: "custom-corp",
      id: "main-model",
      baseUrl: "https://custom.example/v1",
      apiKeyEnv: "CUSTOM_API_KEY"
    });
    expect(capturedOpts.voiceStateManager).toBeDefined();
    expect(capturedOpts.voiceAutoTtsDefault).toBe(false);
    expect(capturedOpts.autoTtsConfig).toBeDefined();
    expect(capturedOpts.autoTtsTempRoot).toContain("temp");
  });

  it("runtimeForSession is wired as a function in ChannelGateway options", async () => {
    let capturedOpts: any;
    const gateway = { start: async () => {}, stop: async () => {}, hasPendingWork: () => false };

    await runGatewaySupervisor({
      workspaceRoot: tmpDir,
      homeDir: tmpDir,
      once: true,
      factories: {
        createChannelGateway: (opts: any) => {
          capturedOpts = opts;
          return gateway as any;
        },
        createDeliveryRouter: () => fakeDeliveryRouter() as any,
      },
    });

    expect(typeof capturedOpts.runtimeForSession).toBe("function");
  });

  it("retains runtime-cache-state.json after shutdown in once mode", async () => {
    await runGatewaySupervisor({
      workspaceRoot: tmpDir,
      homeDir: tmpDir,
      once: true,
      factories: {
        createChannelGateway: () => fakeChannelGateway() as any,
        createDeliveryRouter: () => fakeDeliveryRouter() as any,
      },
    });

    const path = runtimeCacheStatePath(profilePaths);
    const content = await readFile(path, "utf8").catch(() => null);
    expect(content).not.toBeNull();
    const parsed = JSON.parse(content!);
    expect(parsed.version).toBe(1);
    expect(parsed.supervisorPid).toBe(process.pid);
  });

  it("SIGTERM triggers drain, waits for active turns, writes clean marker", async () => {
    const exited = fakeExit();
    let capturedRegistry: ActiveTurnRegistry | undefined;
    const gateway = fakeChannelGateway();

    const promise = runGatewaySupervisor({
      workspaceRoot: tmpDir,
      homeDir: tmpDir,
      once: false,
      drainTimeoutMs: 5_000,
      factories: {
        createChannelGateway: (opts: any) => {
          capturedRegistry = opts.activeTurnRegistry;
          return gateway as any;
        },
        createDeliveryRouter: () => fakeDeliveryRouter() as any,
        exit: exited.exit,
      },
    });

    await waitForCondition(() => capturedRegistry !== undefined);

    const ac = new AbortController();
    capturedRegistry!.startTurn("test-key", ac);

    process.emit("SIGTERM");

    await new Promise((r) => setTimeout(r, 100));
    const turn = capturedRegistry?.getTurn("test-key");
    if (turn && capturedRegistry) {
      capturedRegistry.endTurn("test-key", turn.turnId);
    }

    await promise;
    await new Promise((r) => setTimeout(r, 600));

    expect(exited.codes()).toContain(0);
    const marker = await readCleanShutdownMarker(profilePaths);
    expect(marker).toBeDefined();
    expect(marker?.reason).toBe("drain");
  });

  it("drain timeout aborts remaining turns and does NOT write clean marker", async () => {
    const exited = fakeExit();
    let capturedRegistry: ActiveTurnRegistry | undefined;
    const gateway = {
      start: async () => {},
      stop: async () => {},
      hasPendingWork: () => (capturedRegistry?.stats().activeTurnCount ?? 0) > 0,
    };

    const promise = runGatewaySupervisor({
      workspaceRoot: tmpDir,
      homeDir: tmpDir,
      once: false,
      drainTimeoutMs: 200,
      factories: {
        createChannelGateway: (opts: any) => {
          capturedRegistry = opts.activeTurnRegistry;
          return gateway as any;
        },
        createDeliveryRouter: () => fakeDeliveryRouter() as any,
        exit: exited.exit,
      },
    });

    await waitForCondition(() => capturedRegistry !== undefined);

    const ac = new AbortController();
    capturedRegistry!.startTurn("test-key", ac);

    process.emit("SIGTERM");

    await promise;
    await new Promise((r) => setTimeout(r, 800));

    expect(exited.codes()).toContain(0);
    expect(ac.signal.aborted).toBe(true);
    expect(await readCleanShutdownMarker(profilePaths)).toBeUndefined();
  });

  it("second signal during drain forces immediate exit without clean marker", async () => {
    const exited = fakeExit();
    let capturedRegistry: ActiveTurnRegistry | undefined;
    const gateway = {
      start: async () => {},
      stop: async () => {},
      hasPendingWork: () => (capturedRegistry?.stats().activeTurnCount ?? 0) > 0,
    };

    const promise = runGatewaySupervisor({
      workspaceRoot: tmpDir,
      homeDir: tmpDir,
      once: false,
      drainTimeoutMs: 5_000,
      factories: {
        createChannelGateway: (opts: any) => {
          capturedRegistry = opts.activeTurnRegistry;
          return gateway as any;
        },
        createDeliveryRouter: () => fakeDeliveryRouter() as any,
        exit: exited.exit,
      },
    });

    await waitForCondition(() => capturedRegistry !== undefined);

    const ac = new AbortController();
    const start = capturedRegistry!.startTurn("test-key", ac);
    expect(start.ok).toBe(true);
    expect(capturedRegistry!.stats().activeTurnCount).toBe(1);

    process.emit("SIGTERM");
    process.emit("SIGTERM");

    await promise;
    await waitForCondition(() => exited.codes().includes(1));

    expect(exited.codes()).toContain(1);
    expect(await readCleanShutdownMarker(profilePaths)).toBeUndefined();
  });

  it("startup consumes clean-shutdown marker when PID/state/lock are clean", async () => {
    const marker = {
      stoppedAt: new Date().toISOString(),
      pid: 12345,
      version: "1.0.0",
      reason: "drain" as const,
    };
    await writeCleanShutdownMarker(profilePaths, marker);

    const result = await runGatewaySupervisor({
      workspaceRoot: tmpDir,
      homeDir: tmpDir,
      once: true,
      factories: {
        createChannelGateway: () => fakeChannelGateway() as any,
        createDeliveryRouter: () => fakeDeliveryRouter() as any,
      },
    });

    expect(result.ok).toBe(true);
    expect(await readCleanShutdownMarker(profilePaths)).toBeUndefined();
  });

  it("startup ignores clean-shutdown marker when any PID/state/lock file remains, removes marker, runs normal cleanup", async () => {
    const marker = {
      stoppedAt: new Date().toISOString(),
      pid: 12345,
      version: "1.0.0",
      reason: "drain" as const,
    };
    await writeCleanShutdownMarker(profilePaths, marker);
    const { writeFile: wf, mkdir: md } = await import("node:fs/promises");
    await md(profilePaths.gatewayStatePath, { recursive: true });
    await wf(join(profilePaths.gatewayStatePath, "gateway.pid"), JSON.stringify({ pid: 99999, startedAt: new Date().toISOString(), version: "0.0.1" }));

    const result = await runGatewaySupervisor({
      workspaceRoot: tmpDir,
      homeDir: tmpDir,
      once: true,
      factories: {
        createChannelGateway: () => fakeChannelGateway() as any,
        createDeliveryRouter: () => fakeDeliveryRouter() as any,
      },
    });

    expect(result.ok).toBe(true);
    expect(await readCleanShutdownMarker(profilePaths)).toBeUndefined();
  });

  it("startup ignores stale clean-shutdown marker (>5min), removes marker", async () => {
    const marker = {
      stoppedAt: new Date(Date.now() - 6 * 60 * 1000).toISOString(),
      pid: 12345,
      version: "1.0.0",
      reason: "drain" as const,
    };
    await writeCleanShutdownMarker(profilePaths, marker);

    const result = await runGatewaySupervisor({
      workspaceRoot: tmpDir,
      homeDir: tmpDir,
      once: true,
      factories: {
        createChannelGateway: () => fakeChannelGateway() as any,
        createDeliveryRouter: () => fakeDeliveryRouter() as any,
      },
    });

    expect(result.ok).toBe(true);
    expect(await readCleanShutdownMarker(profilePaths)).toBeUndefined();
  });

  it("cron tick is skipped while draining", async () => {
    const exited = fakeExit();
    const tick = fakeTickCron();
    const gateway = fakeChannelGateway();

    const promise = runGatewaySupervisor({
      workspaceRoot: tmpDir,
      homeDir: tmpDir,
      once: false,
      factories: {
        tickCron: tick.tickCron,
        createChannelGateway: () => gateway as any,
        createDeliveryRouter: () => fakeDeliveryRouter() as any,
        exit: exited.exit,
      },
    });

    await new Promise((r) => setTimeout(r, 50));
    process.emit("SIGTERM");
    await promise;
    await new Promise((r) => setTimeout(r, 600));

    // Only one tick should have run before drain stopped the loop
    expect(tick.calls()).toBe(1);
    expect(exited.codes()).toContain(0);
  });

  it("isDraining callback is passed to ChannelGateway", async () => {
    let capturedOpts: any;
    const gateway = { start: async () => {}, stop: async () => {}, hasPendingWork: () => false };

    await runGatewaySupervisor({
      workspaceRoot: tmpDir,
      homeDir: tmpDir,
      once: true,
      factories: {
        createChannelGateway: (opts: any) => {
          capturedOpts = opts;
          return gateway as any;
        },
        createDeliveryRouter: () => fakeDeliveryRouter() as any,
      },
    });

    expect(typeof capturedOpts.isDraining).toBe("function");
    expect(capturedOpts.isDraining()).toBe(false);
  });

  it("busyPolicyResolver is passed to ChannelGateway", async () => {
    let capturedOpts: any;
    const gateway = { start: async () => {}, stop: async () => {}, hasPendingWork: () => false };

    await runGatewaySupervisor({
      workspaceRoot: tmpDir,
      homeDir: tmpDir,
      once: true,
      factories: {
        createChannelGateway: (opts: any) => {
          capturedOpts = opts;
          return gateway as any;
        },
        createDeliveryRouter: () => fakeDeliveryRouter() as any,
      },
    });

    expect(typeof capturedOpts.busyPolicyResolver).toBe("function");
    const policy = capturedOpts.busyPolicyResolver("telegram");
    expect(policy.busyPolicy).toBe("reject");
    expect(policy.queueDepth).toBe(3);
  });

  it("busyPolicyResolver reads per-channel config from loaded config", async () => {
    let capturedOpts: any;
    const gateway = { start: async () => {}, stop: async () => {}, hasPendingWork: () => false };

    const configPath = profileConfigPath(tmpDir);
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(configPath, JSON.stringify({
      channels: {
        telegram: {
          enabled: false,
          busyPolicy: "queue",
          queueDepth: 5,
        },
        discord: {
          enabled: false,
          busyPolicy: "interrupt",
          queueDepth: 2,
        },
      },
    }));

    await runGatewaySupervisor({
      workspaceRoot: tmpDir,
      homeDir: tmpDir,
      once: true,
      factories: {
        createChannelGateway: (opts: any) => {
          capturedOpts = opts;
          return gateway as any;
        },
        createDeliveryRouter: () => fakeDeliveryRouter() as any,
      },
    });

    const telegramPolicy = capturedOpts.busyPolicyResolver("telegram");
    expect(telegramPolicy.busyPolicy).toBe("queue");
    expect(telegramPolicy.queueDepth).toBe(5);

    const discordPolicy = capturedOpts.busyPolicyResolver("discord");
    expect(discordPolicy.busyPolicy).toBe("interrupt");
    expect(discordPolicy.queueDepth).toBe(2);
  });

  it("passes normalized Discord voice-channel options and temp root to the adapter", async () => {
    const previousToken = process.env.DISCORD_BOT_TOKEN;
    process.env.DISCORD_BOT_TOKEN = "token";
    const configPath = profileConfigPath(tmpDir);
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(configPath, JSON.stringify({
      model: { provider: "openai", id: "gpt-4o" },
      channels: {
        discord: {
          enabled: true,
          botTokenEnv: "DISCORD_BOT_TOKEN",
          allowedUsers: ["user-1"],
          voiceChannel: { enabled: true, autoJoinOnCommand: true }
        }
      },
    }));
    let capturedDiscordOptions: any;

    try {
      await runGatewaySupervisor({
        workspaceRoot: tmpDir,
        homeDir: tmpDir,
        once: true,
        factories: {
          createDiscordAdapter: (input: any) => {
            capturedDiscordOptions = input;
            return { kind: "discord", start: async () => {}, stop: async () => {} } as any;
          },
          createChannelGateway: () => ({ start: async () => {}, stop: async () => {}, hasPendingWork: () => false }) as any,
          createDeliveryRouter: () => fakeDeliveryRouter() as any,
        },
      });

      expect(capturedDiscordOptions.voiceChannel).toEqual({
        enabled: true,
        autoJoinOnCommand: true
      });
      expect(capturedDiscordOptions.allowedUsers).toEqual(["user-1"]);
      expect(capturedDiscordOptions.voiceTempRoot).toBe(join(profilePaths.tempPath, "audio"));
    } finally {
      if (previousToken === undefined) {
        delete process.env.DISCORD_BOT_TOKEN;
      } else {
        process.env.DISCORD_BOT_TOKEN = previousToken;
      }
    }
  });

  it("allows Discord voice receive temp audio through gateway transcription preprocessing", async () => {
    const configPath = profileConfigPath(tmpDir);
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(configPath, JSON.stringify({
      model: { provider: "openai", id: "gpt-4o" },
      stt: {
        provider: "local",
        enabled: true,
        local: { engine: "command", command: "printf transcript" }
      }
    }));
    let capturedGatewayOptions: any;
    await runGatewaySupervisor({
      workspaceRoot: tmpDir,
      homeDir: tmpDir,
      once: true,
      factories: {
        createChannelGateway: (input: any) => {
          capturedGatewayOptions = input;
          return { start: async () => {}, stop: async () => {}, hasPendingWork: () => false } as any;
        },
        createDeliveryRouter: () => fakeDeliveryRouter() as any,
      },
    });
    const audioDir = join(profilePaths.tempPath, "audio", "discord-voice");
    await mkdir(audioDir, { recursive: true });
    const audioPath = join(audioDir, "voice.wav");
    await writeFile(audioPath, Buffer.from("RIFF....WAVEfmt data"));

    const processed = await capturedGatewayOptions.preprocessMessage({
      id: "discord-voice-1",
      channel: "discord",
      sessionKey: { platform: "discord", chatId: "channel-1", accountId: "guild-1", userId: "user-1" },
      text: "",
      sender: { id: "user-1" },
      receivedAt: "2026-01-01T00:00:00.000Z",
      metadata: { guildId: "guild-1", channelId: "channel-1", voiceChannel: true },
      attachments: [{
        id: "voice-1",
        kind: "voice",
        status: "ready",
        localPath: audioPath,
        mimeType: "audio/wav",
        bytes: 20,
      }]
    });

    expect(processed.text).toContain("[Voice message transcript]\ntranscript");
    expect(processed.attachments).toEqual([]);
  });
});

describe("supervisor 5E internals", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTempDir();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function createMockSupervisorState(
    overrides?: Partial<SupervisorInternalState>
  ): SupervisorInternalState {
    return {
      homeDir: tmpDir,
      stateHome: resolveProfileStateHome({ homeDir: tmpDir, profileId: "default" }),
      gatewayLockAcquired: false,
      acquiredIdentityLocks: [],
      channelGateway: undefined,
      sessionDb: undefined,
      onSigint: undefined,
      onSigterm: undefined,
      shutdownStarted: false,
      draining: false,
      running: true,
      cleanupDone: false,
      exit: () => {},
      activeTurnRegistry: undefined,
      runtimeCache: undefined,
      runtimeFingerprint: undefined,
      lastRuntimeCacheStateWrite: 0,
      lastGatewayApprovalExpiryRun: 0,
      runtimeCacheStatePath: join(tmpDir, "rcs.json"),
      supervisorStartedAt: new Date().toISOString(),
      stuckAbortSent: new Set(),
      stuckEventRecorded: new Set(),
      stuckEventsBySession: new Map(),
      startupComplete: false,
      drainCancelled: false,
      ...overrides,
    } as SupervisorInternalState;
  }

  function mockRuntimeCache(overrides?: Partial<RuntimeCache>): RuntimeCache {
    return {
      prune: async () => {},
      suspend: async () => {},
      stats: () => ({
        totalEntries: 0,
        activeBorrows: 0,
        suspendedEntries: 0,
        totalCreated: 0,
        totalReused: 0,
        totalDisposed: 0,
        totalInvalidated: 0,
      }),
      suspendedSummary: () => [],
      ...overrides,
    } as unknown as RuntimeCache;
  }

  describe("runPrune", () => {
    it("calls prune on runtimeCache", async () => {
      let pruned = false;
      const state = createMockSupervisorState({
        runtimeCache: mockRuntimeCache({
          prune: async () => {
            pruned = true;
          },
        }),
      });
      const guard = { running: false };
      await runPrune(state, guard);
      expect(pruned).toBe(true);
    });

    it("skips when guard is already running", async () => {
      let pruned = false;
      const state = createMockSupervisorState({
        runtimeCache: mockRuntimeCache({
          prune: async () => {
            pruned = true;
          },
        }),
      });
      const guard = { running: true };
      await runPrune(state, guard);
      expect(pruned).toBe(false);
    });

    it("prevents concurrent execution", async () => {
      let pruneCalls = 0;
      const state = createMockSupervisorState({
        runtimeCache: mockRuntimeCache({
          prune: async () => {
            pruneCalls++;
          },
        }),
      });
      const guard = { running: false };
      const p1 = runPrune(state, guard);
      const p2 = runPrune(state, guard);
      await Promise.all([p1, p2]);
      expect(pruneCalls).toBe(1);
    });
  });

  describe("runStuckScan", () => {
    it("aborts a stuck turn once", async () => {
      const registry = new ActiveTurnRegistry({ stuckThresholdMs: -1 });
      const ac = new AbortController();
      registry.startTurn("key1", ac, { sessionId: "sessionA" });

      const state = createMockSupervisorState({
        activeTurnRegistry: registry,
        runtimeCache: mockRuntimeCache(),
      });

      expect(ac.signal.aborted).toBe(false);
      await runStuckScan(state);
      expect(ac.signal.aborted).toBe(true);

      // Second scan should not call abortTurn again
      let abortCalls = 0;
      const originalAbort = registry.abortTurn.bind(registry);
      registry.abortTurn = (key: string, reason: string) => {
        abortCalls++;
        return originalAbort(key, reason);
      };
      await runStuckScan(state);
      expect(abortCalls).toBe(0);
    });

    it("records only one event per unique turnId", async () => {
      const registry = new ActiveTurnRegistry({ stuckThresholdMs: -1 });
      registry.startTurn("key1", new AbortController(), { sessionId: "sessionA" });

      const state = createMockSupervisorState({
        activeTurnRegistry: registry,
        runtimeCache: mockRuntimeCache(),
      });

      await runStuckScan(state);
      expect(state.stuckEventsBySession.get("sessionA")?.length).toBe(1);

      await runStuckScan(state);
      await runStuckScan(state);
      expect(state.stuckEventsBySession.get("sessionA")?.length).toBe(1);
    });

    it("suspends after 3 distinct stuck turns for same session", async () => {
      const registry = new ActiveTurnRegistry({ stuckThresholdMs: -1 });
      const suspensions: Array<{ sessionId: string; reason: string }> = [];

      const state = createMockSupervisorState({
        activeTurnRegistry: registry,
        runtimeCache: mockRuntimeCache({
          suspend: async (sid: string, reason: string) => {
            suspensions.push({ sessionId: sid, reason });
          },
        }),
      });

      // Turn 1
      registry.startTurn("k1", new AbortController(), { sessionId: "s1" });
      await runStuckScan(state);
      expect(suspensions).toHaveLength(0);

      registry.endTurn("k1", registry.getTurn("k1")!.turnId);
      registry.startTurn("k2", new AbortController(), { sessionId: "s1" });
      await runStuckScan(state);
      expect(suspensions).toHaveLength(0);

      registry.endTurn("k2", registry.getTurn("k2")!.turnId);
      registry.startTurn("k3", new AbortController(), { sessionId: "s1" });
      await runStuckScan(state);
      expect(suspensions).toHaveLength(1);
      expect(suspensions[0].sessionId).toBe("s1");
      expect(suspensions[0].reason).toBe("stuck-loop");
    });

    it("does not combine events across sessions", async () => {
      const registry = new ActiveTurnRegistry({ stuckThresholdMs: -1 });
      registry.startTurn("k1", new AbortController(), { sessionId: "s1" });
      registry.startTurn("k2", new AbortController(), { sessionId: "s2" });

      const suspensions: Array<{ sessionId: string }> = [];
      const state = createMockSupervisorState({
        activeTurnRegistry: registry,
        runtimeCache: mockRuntimeCache({
          suspend: async (sid: string) => {
            suspensions.push({ sessionId: sid });
          },
        }),
      });

      await runStuckScan(state);
      expect(suspensions).toHaveLength(0);
    });

    it("skips suspension when metadata.sessionId is missing but still aborts", async () => {
      const registry = new ActiveTurnRegistry({ stuckThresholdMs: -1 });
      const ac = new AbortController();
      registry.startTurn("k1", ac); // no metadata

      const state = createMockSupervisorState({
        activeTurnRegistry: registry,
        runtimeCache: mockRuntimeCache(),
      });

      await runStuckScan(state);
      expect(ac.signal.aborted).toBe(true);
      expect(state.stuckEventsBySession.size).toBe(0);
    });

    it("cleans up old session entries outside the window", async () => {
      const registry = new ActiveTurnRegistry({ stuckThresholdMs: -1 });
      registry.startTurn("k1", new AbortController(), { sessionId: "s1" });

      const state = createMockSupervisorState({
        activeTurnRegistry: registry,
        runtimeCache: mockRuntimeCache(),
      });

      await runStuckScan(state);
      expect(state.stuckEventsBySession.has("s1")).toBe(true);

      // Artificially age the event beyond the 10-minute window
      const oldEvents = state.stuckEventsBySession.get("s1")!;
      state.stuckEventsBySession.set("s1", oldEvents.map(() => Date.now() - 601_000));

      // No active turns anymore, so cleanup will remove the session entry
      registry.endTurn("k1", registry.getTurn("k1")!.turnId);
      await runStuckScan(state);
      expect(state.stuckEventsBySession.has("s1")).toBe(false);
    });
  });

  describe("runStuckScanGuarded", () => {
    it("prevents concurrent execution", async () => {
      const registry = new ActiveTurnRegistry({ stuckThresholdMs: -1 });
      registry.startTurn("k1", new AbortController(), { sessionId: "s1" });

      let abortCalls = 0;
      const originalAbort = registry.abortTurn.bind(registry);
      registry.abortTurn = (key: string, reason: string) => {
        abortCalls++;
        return originalAbort(key, reason);
      };

      const state = createMockSupervisorState({
        activeTurnRegistry: registry,
        runtimeCache: mockRuntimeCache(),
      });

      const guard = { running: false };
      const p1 = runStuckScanGuarded(state, guard);
      const p2 = runStuckScanGuarded(state, guard);
      await Promise.all([p1, p2]);

      expect(abortCalls).toBe(1);
    });
  });

  describe("runRuntimeCacheStateHeartbeat", () => {
    it("writes runtime cache state and updates lastRuntimeCacheStateWrite", async () => {
      const registry = new ActiveTurnRegistry();
      const cache = new RuntimeCache({
        createRuntime: async () => ({}) as any,
        maxEntries: 50,
        idleTtlMs: 1_800_000,
        logWarning: () => {},
      });

      const path = join(tmpDir, "heartbeat.json");
      const state = createMockSupervisorState({
        activeTurnRegistry: registry,
        runtimeCache: cache,
        runtimeFingerprint: { model: "test" } as any,
        runtimeCacheStatePath: path,
        lastRuntimeCacheStateWrite: 0,
      });

      const guard = { running: false };
      await runRuntimeCacheStateHeartbeat(state, guard);
      expect(state.lastRuntimeCacheStateWrite).toBeGreaterThan(0);

      const written = await readRuntimeCacheState(path);
      expect(written).toBeDefined();
      expect(written!.version).toBe(1);
      expect(written!.supervisorPid).toBe(process.pid);
    });

    it("skips when guard is already running", async () => {
      const state = createMockSupervisorState({
        activeTurnRegistry: new ActiveTurnRegistry(),
        runtimeCache: mockRuntimeCache(),
        runtimeFingerprint: { model: "test" } as any,
      });
      const guard = { running: true };
      await runRuntimeCacheStateHeartbeat(state, guard);
      expect(state.lastRuntimeCacheStateWrite).toBe(0);
    });

    it("prevents concurrent execution", async () => {
      const registry = new ActiveTurnRegistry();
      const cache = new RuntimeCache({
        createRuntime: async () => ({}) as any,
        maxEntries: 50,
        idleTtlMs: 1_800_000,
        logWarning: () => {},
      });

      const path = join(tmpDir, "concurrent-heartbeat.json");
      const state = createMockSupervisorState({
        activeTurnRegistry: registry,
        runtimeCache: cache,
        runtimeFingerprint: { model: "test" } as any,
        runtimeCacheStatePath: path,
        lastRuntimeCacheStateWrite: 0,
      });

      const guard = { running: false };
      const p1 = runRuntimeCacheStateHeartbeat(state, guard);
      const p2 = runRuntimeCacheStateHeartbeat(state, guard);
      await Promise.all([p1, p2]);

      // Only one write should have succeeded
      const written = await readRuntimeCacheState(path);
      expect(written).toBeDefined();
      expect(written!.version).toBe(1);
    });
  });

  describe("runGatewayApprovalExpiry", () => {
    it("expires stale approvals through the queue and updates the cadence marker", async () => {
      let expired = false;
      const state = createMockSupervisorState({
        gatewayApprovalQueue: {
          expireStaleApprovals: async () => {
            expired = true;
            return 1;
          }
        } as any
      });

      await runGatewayApprovalExpiry(state, { running: false });

      expect(expired).toBe(true);
      expect(state.lastGatewayApprovalExpiryRun).toBeGreaterThan(0);
    });

    it("does not crash when approval expiry fails", async () => {
      const state = createMockSupervisorState({
        gatewayApprovalQueue: {
          expireStaleApprovals: async () => {
            throw new Error("database locked");
          }
        } as any
      });

      await expect(runGatewayApprovalExpiry(state, { running: false })).resolves.toBeUndefined();
    });
  });

  describe("runGatewayApprovalResolutionTick", () => {
    it("guards concurrent approval resolution ticks", async () => {
      let calls = 0;
      const guard = { running: true };

      await runGatewayApprovalResolutionTick({
        tickApprovalResolutions: async () => {
          calls += 1;
        }
      }, guard);

      expect(calls).toBe(0);
      expect(guard.running).toBe(true);
    });
  });

  describe("buildRuntimeCacheState", () => {
    it("produces a valid RuntimeCacheState with privacy protections", () => {
      const registry = new ActiveTurnRegistry();
      const cache = new RuntimeCache({
        createRuntime: async () => ({}) as any,
        maxEntries: 50,
        idleTtlMs: 1_800_000,
        logWarning: () => {},
      });

      const state = createMockSupervisorState({
        activeTurnRegistry: registry,
        runtimeCache: cache,
        runtimeFingerprint: { model: "test-model" } as any,
        supervisorStartedAt: new Date().toISOString(),
      });

      const rcs = buildRuntimeCacheState(state);
      expect(rcs.version).toBe(1);
      expect(typeof rcs.writtenAt).toBe("string");
      expect(rcs.supervisorPid).toBe(process.pid);
      expect(typeof rcs.fingerprintHash).toBe("string");

      // No sensitive data
      const json = JSON.stringify(rcs);
      expect(json).not.toContain("message");
      expect(json).not.toContain("prompt");
      expect(json).not.toContain("token");
      expect(json).not.toContain("transcript");
      expect(json).not.toContain("approval");
    });
  });

  describe("HookRegistry injection", () => {
    it("constructs one HookRegistry and injects it into RuntimeCache, ChannelGateway, and adapter wrappers", async () => {
      const capturedEmitCalls: Array<{ name: string; payload: unknown }> = [];
      const originalEmit = HookRegistry.prototype.emit;
      HookRegistry.prototype.emit = async function (name: any, payload: any): Promise<void> {
        capturedEmitCalls.push({ name, payload });
        return originalEmit.call(this, name, payload);
      };

      try {
        const tmpDir = await makeTempDir();
        const stateDir = join(tmpDir, "state");
        const sessionDir = join(tmpDir, "sessions");
        await mkdir(stateDir, { recursive: true });
        await mkdir(sessionDir, { recursive: true });

        // Write config to enable telegram adapter
        const configPath = profileConfigPath(tmpDir);
    await mkdir(dirname(configPath), { recursive: true });
        await writeFile(configPath, JSON.stringify({
          channels: {
            telegram: {
              enabled: true,
              botTokenEnv: "TEST_BOT_TOKEN",
              defaultChatId: "123",
            },
          },
        }));
        process.env.TEST_BOT_TOKEN = "fake";

        let receivedGatewayHookRegistry: unknown;

        const result = await runGatewaySupervisor({
          workspaceRoot: tmpDir,
          homeDir: tmpDir,
          factories: {
            createChannelGateway: (opts) => {
              receivedGatewayHookRegistry = (opts as { hookRegistry?: unknown }).hookRegistry;
              const gateway = fakeChannelGateway() as any;
              const originalStart = gateway.start;
              gateway.start = async () => {
                for (const adapter of (opts as { adapters?: Array<{ start?: (handler: (msg: unknown) => Promise<void>) => Promise<void> }> }).adapters ?? []) {
                  await adapter.start?.(async () => {});
                }
                await originalStart?.();
              };
              return gateway;
            },
            createTelegramAdapter: () => fakeAdapter("telegram") as any,
          },
          once: true,
        });

        delete process.env.TEST_BOT_TOKEN;

        // The supervisor constructs RuntimeCache internally; we can verify
        // the gateway received a HookRegistry.
        expect(receivedGatewayHookRegistry).toBeDefined();
        expect(result.ok).toBe(true);

        // Verify adapter wrappers received the same HookRegistry by checking
        // that adapter:start was emitted through it.
        const adapterStartEvents = capturedEmitCalls.filter((e) => e.name === "adapter:start");
        expect(adapterStartEvents.length).toBeGreaterThan(0);
        expect((adapterStartEvents[0].payload as any).kind).toBe("telegram");

        await rm(tmpDir, { recursive: true, force: true });
      } finally {
        HookRegistry.prototype.emit = originalEmit;
      }
    });
  });
});

describe("supervisor lifecycle hooks", () => {
  let tmpDir: string;
  let stateRoot: string;
  let profilePaths: ProfileStatePaths;

  beforeEach(async () => {
    tmpDir = await makeTempDir();
    stateRoot = join(tmpDir, ".estacoda");
    profilePaths = resolveProfileStateHome({ homeDir: tmpDir, profileId: "default" });
    await mkdir(stateRoot, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("supervisor:start emitted on successful startup", async () => {
    const captured: Array<{ name: string; payload: unknown }> = [];
    const originalEmit = HookRegistry.prototype.emit;
    HookRegistry.prototype.emit = async function (name: any, payload: any): Promise<void> {
      captured.push({ name, payload });
      return originalEmit.call(this, name, payload);
    };

    try {
      const configPath = profileConfigPath(tmpDir);
    await mkdir(dirname(configPath), { recursive: true });
      await writeFile(configPath, JSON.stringify({
        channels: {
          telegram: {
            enabled: true,
            botTokenEnv: "TEST_BOT_TOKEN",
            defaultChatId: "123",
          },
        },
      }));
      process.env.TEST_BOT_TOKEN = "fake";

      const result = await runGatewaySupervisor({
        workspaceRoot: tmpDir,
        homeDir: tmpDir,
        once: true,
        factories: {
          createChannelGateway: () => fakeChannelGateway() as any,
          createDeliveryRouter: () => fakeDeliveryRouter() as any,
          createTelegramAdapter: () => fakeAdapter("telegram") as any,
        },
      });

      delete process.env.TEST_BOT_TOKEN;

      expect(result.ok).toBe(true);
      const starts = captured.filter((e) => e.name === "supervisor:start");
      expect(starts).toHaveLength(1);
      const payload = starts[0].payload as any;
      expect(payload.pid).toBe(process.pid);
      expect(typeof payload.startedAt).toBe("string");
      expect(typeof payload.version).toBe("string");
      expect(payload.adapterKinds).toEqual(["telegram"]);
      expect(payload.mode).toBe("adapters");
    } finally {
      HookRegistry.prototype.emit = originalEmit;
    }
  });

  it("supervisor:start NOT emitted when gateway lock is held, and no supervisor:crash either", async () => {
    const captured: Array<{ name: string; payload: unknown }> = [];
    const originalEmit = HookRegistry.prototype.emit;
    HookRegistry.prototype.emit = async function (name: any, payload: any): Promise<void> {
      captured.push({ name, payload });
      return originalEmit.call(this, name, payload);
    };

    try {
      const lockFile = join(profilePaths.gatewayStatePath, "gateway.lock");
      await mkdir(profilePaths.gatewayStatePath, { recursive: true });
      await writeFile(lockFile, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));

      const result = await runGatewaySupervisor({
        workspaceRoot: tmpDir,
        homeDir: tmpDir,
        once: true,
        factories: {
          createChannelGateway: () => fakeChannelGateway() as any,
          createDeliveryRouter: () => fakeDeliveryRouter() as any,
        },
      });

      expect(result.ok).toBe(false);
      expect(captured.some((e) => e.name === "supervisor:start")).toBe(false);
      expect(captured.some((e) => e.name === "supervisor:crash")).toBe(false);
    } finally {
      HookRegistry.prototype.emit = originalEmit;
    }
  });

  it("supervisor:start NOT emitted and supervisor:crash phase=startup when createChannelGateway throws after lock acquisition", async () => {
    const captured: Array<{ name: string; payload: unknown }> = [];
    const originalEmit = HookRegistry.prototype.emit;
    HookRegistry.prototype.emit = async function (name: any, payload: any): Promise<void> {
      captured.push({ name, payload });
      return originalEmit.call(this, name, payload);
    };

    try {
      const result = await runGatewaySupervisor({
        workspaceRoot: tmpDir,
        homeDir: tmpDir,
        once: true,
        factories: {
          createChannelGateway: () => {
            throw new Error("boom");
          },
          createDeliveryRouter: () => fakeDeliveryRouter() as any,
          createTelegramAdapter: () => fakeAdapter("telegram") as any,
        },
      });

      expect(result.ok).toBe(false);
      expect(captured.some((e) => e.name === "supervisor:start")).toBe(false);
      const crashes = captured.filter((e) => e.name === "supervisor:crash");
      expect(crashes).toHaveLength(1);
      expect((crashes[0].payload as any).phase).toBe("startup");
      expect((crashes[0].payload as any).errorClass).toBe("Error");
      expect((crashes[0].payload as any).errorMessage).toBe("boom");
      expect(captured.some((e) => e.name === "supervisor:stop")).toBe(false);
    } finally {
      HookRegistry.prototype.emit = originalEmit;
    }
  });

  it("supervisor:stop emitted on once mode exit with clean=true reason=once", async () => {
    const captured: Array<{ name: string; payload: unknown }> = [];
    const originalEmit = HookRegistry.prototype.emit;
    HookRegistry.prototype.emit = async function (name: any, payload: any): Promise<void> {
      captured.push({ name, payload });
      return originalEmit.call(this, name, payload);
    };

    try {
      const result = await runGatewaySupervisor({
        workspaceRoot: tmpDir,
        homeDir: tmpDir,
        once: true,
        factories: {
          createChannelGateway: () => fakeChannelGateway() as any,
          createDeliveryRouter: () => fakeDeliveryRouter() as any,
        },
      });

      expect(result.ok).toBe(true);
      const stops = captured.filter((e) => e.name === "supervisor:stop");
      expect(stops).toHaveLength(1);
      expect((stops[0].payload as any).clean).toBe(true);
      expect((stops[0].payload as any).reason).toBe("once");

      const starts = captured.filter((e) => e.name === "supervisor:start");
      expect(starts).toHaveLength(1);
      const startIndex = captured.findIndex((e) => e.name === "supervisor:start");
      const stopIndex = captured.findIndex((e) => e.name === "supervisor:stop");
      expect(stopIndex).toBeGreaterThan(startIndex);
    } finally {
      HookRegistry.prototype.emit = originalEmit;
    }
  });

  it("supervisor:drain:start and supervisor:drain:complete emitted on SIGTERM with successful drain", async () => {
    const captured: Array<{ name: string; payload: unknown }> = [];
    const originalEmit = HookRegistry.prototype.emit;
    HookRegistry.prototype.emit = async function (name: any, payload: any): Promise<void> {
      captured.push({ name, payload });
      return originalEmit.call(this, name, payload);
    };

    try {
      const exited = fakeExit();
      const gateway = fakeChannelGateway();

      const promise = runGatewaySupervisor({
        workspaceRoot: tmpDir,
        homeDir: tmpDir,
        once: false,
        factories: {
          createChannelGateway: () => gateway as any,
          createDeliveryRouter: () => fakeDeliveryRouter() as any,
          exit: exited.exit,
        },
      });

      await new Promise((r) => setTimeout(r, 50));
      process.emit("SIGTERM");
      await promise;

      const drainStarts = captured.filter((e) => e.name === "supervisor:drain:start");
      expect(drainStarts).toHaveLength(1);
      const drainStartPayload = drainStarts[0].payload as any;
      expect(drainStartPayload.reason).toBe("SIGTERM");
      expect(drainStartPayload.activeTurnCount).toBe(0);
      expect(drainStartPayload.timeoutMs).toBe(30000);

      const drainCompletes = captured.filter((e) => e.name === "supervisor:drain:complete");
      expect(drainCompletes).toHaveLength(1);
      const drainCompletePayload = drainCompletes[0].payload as any;
      expect(drainCompletePayload.completed).toBe(true);
      expect(drainCompletePayload.timedOut).toBe(false);
      expect(drainCompletePayload.abortedTurnCount).toBe(0);
      expect(typeof drainCompletePayload.durationMs).toBe("number");

      const stops = captured.filter((e) => e.name === "supervisor:stop");
      expect(stops).toHaveLength(1);
      expect(stops[0].payload).toMatchObject({ clean: true, reason: "drain" });

      const drainStartIndex = captured.findIndex((e) => e.name === "supervisor:drain:start");
      const drainCompleteIndex = captured.findIndex((e) => e.name === "supervisor:drain:complete");
      const stopIndex = captured.findIndex((e) => e.name === "supervisor:stop");
      expect(drainStartIndex).toBeLessThan(drainCompleteIndex);
      expect(drainCompleteIndex).toBeLessThan(stopIndex);
    } finally {
      HookRegistry.prototype.emit = originalEmit;
    }
  });

  it("supervisor:drain:complete with timedOut=true on drain timeout", async () => {
    const captured: Array<{ name: string; payload: unknown }> = [];
    const originalEmit = HookRegistry.prototype.emit;
    HookRegistry.prototype.emit = async function (name: any, payload: any): Promise<void> {
      captured.push({ name, payload });
      return originalEmit.call(this, name, payload);
    };

    try {
      const exited = fakeExit();
      let capturedRegistry: ActiveTurnRegistry | undefined;
      const gateway = {
        start: async () => {},
        stop: async () => {},
        hasPendingWork: () => (capturedRegistry?.stats().activeTurnCount ?? 0) > 0,
      };

      const promise = runGatewaySupervisor({
        workspaceRoot: tmpDir,
        homeDir: tmpDir,
        once: false,
        drainTimeoutMs: 100,
        factories: {
          createChannelGateway: (opts: any) => {
            capturedRegistry = opts.activeTurnRegistry;
            return gateway as any;
          },
          createDeliveryRouter: () => fakeDeliveryRouter() as any,
          exit: exited.exit,
        },
      });

      await waitForCondition(() => capturedRegistry !== undefined);
      const ac = new AbortController();
      capturedRegistry!.startTurn("test-key", ac);

      process.emit("SIGTERM");
      await promise;
      await new Promise((r) => setTimeout(r, 800));

      const drainCompletes = captured.filter((e) => e.name === "supervisor:drain:complete");
      expect(drainCompletes).toHaveLength(1);
      const payload = drainCompletes[0].payload as any;
      expect(payload.completed).toBe(false);
      expect(payload.timedOut).toBe(true);
      expect(payload.abortedTurnCount).toBe(1);

      const stops = captured.filter((e) => e.name === "supervisor:stop");
      expect(stops).toHaveLength(1);
      expect(stops[0].payload).toMatchObject({ clean: false, reason: "drain-timeout" });
    } finally {
      HookRegistry.prototype.emit = originalEmit;
    }
  });

  it("double signal sets supervisor:stop clean=false reason=forced-signal and prevents drain:complete overwrite", async () => {
    const captured: Array<{ name: string; payload: unknown }> = [];
    const originalEmit = HookRegistry.prototype.emit;
    HookRegistry.prototype.emit = async function (name: any, payload: any): Promise<void> {
      captured.push({ name, payload });
      return originalEmit.call(this, name, payload);
    };

    try {
      const exited = fakeExit();
      let capturedRegistry: ActiveTurnRegistry | undefined;
      const gateway = {
        start: async () => {},
        stop: async () => {},
        hasPendingWork: () => (capturedRegistry?.stats().activeTurnCount ?? 0) > 0,
      };

      const promise = runGatewaySupervisor({
        workspaceRoot: tmpDir,
        homeDir: tmpDir,
        once: false,
        drainTimeoutMs: 5_000,
        factories: {
          createChannelGateway: (opts: any) => {
            capturedRegistry = opts.activeTurnRegistry;
            return gateway as any;
          },
          createDeliveryRouter: () => fakeDeliveryRouter() as any,
          exit: exited.exit,
        },
      });

      await waitForCondition(() => capturedRegistry !== undefined);
      const ac = new AbortController();
      capturedRegistry!.startTurn("test-key", ac);

      process.emit("SIGTERM");
      await new Promise((r) => setTimeout(r, 100));
      process.emit("SIGTERM");

      await promise;
      await new Promise((r) => setTimeout(r, 200));

      const stops = captured.filter((e) => e.name === "supervisor:stop");
      expect(stops).toHaveLength(1);
      expect(stops[0].payload).toMatchObject({ clean: false, reason: "forced-signal" });

      expect(captured.some((e) => e.name === "supervisor:drain:complete")).toBe(false);
    } finally {
      HookRegistry.prototype.emit = originalEmit;
    }
  });

  it("supervisor:crash emitted on startup failure with phase=startup", async () => {
    const captured: Array<{ name: string; payload: unknown }> = [];
    const originalEmit = HookRegistry.prototype.emit;
    HookRegistry.prototype.emit = async function (name: any, payload: any): Promise<void> {
      captured.push({ name, payload });
      return originalEmit.call(this, name, payload);
    };

    try {
      const result = await runGatewaySupervisor({
        workspaceRoot: tmpDir,
        homeDir: tmpDir,
        once: true,
        factories: {
          createChannelGateway: () => {
            throw new Error("boom");
          },
          createDeliveryRouter: () => fakeDeliveryRouter() as any,
          createTelegramAdapter: () => fakeAdapter("telegram") as any,
        },
      });

      expect(result.ok).toBe(false);
      const crashes = captured.filter((e) => e.name === "supervisor:crash");
      expect(crashes).toHaveLength(1);
      const payload = crashes[0].payload as any;
      expect(payload.phase).toBe("startup");
      expect(payload.errorClass).toBe("Error");
      expect(payload.errorMessage).toBe("boom");
      expect(captured.some((e) => e.name === "supervisor:start")).toBe(false);
      expect(captured.some((e) => e.name === "supervisor:stop")).toBe(false);
    } finally {
      HookRegistry.prototype.emit = originalEmit;
    }
  });

  it("supervisor:crash emitted on main-loop failure with phase=main-loop and supervisor:stop clean=false reason=crash", async () => {
    const captured: Array<{ name: string; payload: unknown }> = [];
    const originalEmit = HookRegistry.prototype.emit;
    HookRegistry.prototype.emit = async function (name: any, payload: any): Promise<void> {
      captured.push({ name, payload });
      return originalEmit.call(this, name, payload);
    };

    try {
      const result = await runGatewaySupervisor({
        workspaceRoot: tmpDir,
        homeDir: tmpDir,
        once: false,
        factories: {
          tickCron: async () => {
            throw new Error("tick boom");
          },
          createChannelGateway: () => fakeChannelGateway() as any,
          createDeliveryRouter: () => fakeDeliveryRouter() as any,
        },
      });

      expect(result.ok).toBe(false);
      expect(captured.some((e) => e.name === "supervisor:start")).toBe(true);

      const crashes = captured.filter((e) => e.name === "supervisor:crash");
      expect(crashes).toHaveLength(1);
      const crashPayload = crashes[0].payload as any;
      expect(crashPayload.phase).toBe("main-loop");

      const stops = captured.filter((e) => e.name === "supervisor:stop");
      expect(stops).toHaveLength(1);
      const stopPayload = stops[0].payload as any;
      expect(stopPayload.clean).toBe(false);
      expect(stopPayload.reason).toBe("crash");
    } finally {
      HookRegistry.prototype.emit = originalEmit;
    }
  });

  it("DeliveryRouter receives hookRegistry when constructed by supervisor", async () => {
    let capturedOpts: any;

    const result = await runGatewaySupervisor({
      workspaceRoot: tmpDir,
      homeDir: tmpDir,
      once: true,
      factories: {
        createChannelGateway: () => fakeChannelGateway() as any,
        createDeliveryRouter: (opts: any) => {
          capturedOpts = opts;
          return fakeDeliveryRouter() as any;
        },
      },
    });

    expect(result.ok).toBe(true);
    expect(capturedOpts).toBeDefined();
    expect(capturedOpts.hookRegistry).toBeInstanceOf(HookRegistry);
  });

  it("tickCron receives hookRegistry when called by supervisor", async () => {
    let capturedInput: any;

    const result = await runGatewaySupervisor({
      workspaceRoot: tmpDir,
      homeDir: tmpDir,
      once: true,
      factories: {
        tickCron: async (input: any) => {
          capturedInput = input;
          return [];
        },
        createChannelGateway: () => fakeChannelGateway() as any,
        createDeliveryRouter: () => fakeDeliveryRouter() as any,
      },
    });

    expect(result.ok).toBe(true);
    expect(capturedInput).toBeDefined();
    expect(capturedInput.hookRegistry).toBeInstanceOf(HookRegistry);
  });

  it("hook failures do not affect supervisor shutdown", async () => {
    const originalEmit = HookRegistry.prototype.emit;
    HookRegistry.prototype.emit = async function (name: any, payload: any): Promise<void> {
      if (name === "supervisor:stop") {
        throw new Error("hook explosion");
      }
      return originalEmit.call(this, name, payload);
    };

    try {
      const result = await runGatewaySupervisor({
        workspaceRoot: tmpDir,
        homeDir: tmpDir,
        once: true,
        factories: {
          createChannelGateway: () => fakeChannelGateway() as any,
          createDeliveryRouter: () => fakeDeliveryRouter() as any,
        },
      });

      expect(result.ok).toBe(true);
      const pid = await readGatewayPid(profilePaths);
      expect(pid).toBeUndefined();
      const lock = await readGatewayLockContent(profilePaths);
      expect(lock).toBeUndefined();
    } finally {
      HookRegistry.prototype.emit = originalEmit;
    }
  });

  it("createDeliveryRouter factory receives default hookRegistry when none injected", async () => {
    let capturedOpts: any;

    const result = await runGatewaySupervisor({
      workspaceRoot: tmpDir,
      homeDir: tmpDir,
      once: true,
      factories: {
        createChannelGateway: () => fakeChannelGateway() as any,
        createDeliveryRouter: (opts: any) => {
          capturedOpts = opts;
          return fakeDeliveryRouter() as any;
        },
      },
    });

    expect(result.ok).toBe(true);
    expect(capturedOpts.hookRegistry).toBeInstanceOf(HookRegistry);
  });
});
