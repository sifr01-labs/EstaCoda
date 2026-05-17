import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { join, dirname } from "node:path";
import { access, constants, readFile, writeFile, mkdir, rm, rename, stat, readdir } from "node:fs/promises";
import { loadRuntimeConfig } from "../config/runtime-config.js";
import { defaultProfileId, readActiveProfile, resolveGlobalStateHome, resolveProfileStateHome, type ProfileStatePaths } from "../config/profile-home.js";
import { getTelegramGatewayDiagnostics } from "../channels/gateway-runner.js";
import { getWhatsAppGatewayDiagnostics } from "../channels/whatsapp-diagnostics.js";
import { CronStore } from "../cron/cron-store.js";
import { CronExecutionStore } from "../cron/cron-execution-store.js";
import { openDefaultSQLiteDatabase } from "../storage/factory.js";
import { ChannelApprovalStore } from "../channels/channel-approval-store.js";
import { FileSurfacePointerStore } from "../channels/surface-pointer-store.js";
import { DeliveryRouter } from "../channels/delivery-router.js";
import { AdapterRegistry } from "../channels/adapter-registry.js";
import { renderPlain } from "../ui/renderers/plain-renderer.js";
import type { ViewModel } from "../contracts/view-model.js";
import type { LoadedRuntimeConfig } from "../config/runtime-config.js";
import {
  buildGatewayStatusViewModel,
  buildGatewayDiagnoseViewModel,
  buildChannelsListViewModel,
  buildChannelsStatusViewModel,
} from "./gateway-view-models.js";
import type {
  GatewayStatusData,
  GatewayDiagnoseData,
  ChannelsStatusData,
} from "./gateway-view-models.js";
import type { TelegramGatewayDiagnostics } from "../channels/gateway-runner.js";
import type { WhatsAppGatewayDiagnostics } from "../channels/whatsapp-diagnostics.js";
import { readGatewayPid, isStalePid } from "../gateway/pid-file.js";
import { readGatewayState } from "../gateway/supervisor-state.js";
import { inspectGatewayLockState, isStaleLock, type GatewayLockInspection } from "../gateway/gateway-lock.js";
import {
  stopGateway,
  signalGateway,
} from "../gateway/supervisor-lifecycle.js";
import { listAdapterIdentityLocks } from "../gateway/identity-lock.js";
import {
  deriveTelegramIdentityHash,
  deriveDiscordIdentityHash,
  deriveEmailIdentityHash,
  deriveWhatsAppIdentityHash,
  resolveTelegramIdentityMaterial,
  resolveDiscordIdentityMaterial,
  resolveEmailIdentityMaterial,
  resolveWhatsAppIdentityMaterial,
} from "../channels/adapter-identity.js";
import type { IdentityLockStatus } from "./gateway-view-models.js";
import { readAdapterRuntimeState, isRuntimeStateFresh, isRuntimeStatePidMatch, RUNTIME_STATE_FILE } from "../gateway/adapter-runtime-state.js";
import type { PersistedRuntimeState } from "../gateway/adapter-runtime-state.js";
import {
  runtimeCacheStatePath,
  readRuntimeCacheState,
  isRuntimeCacheStateFresh,
  isRuntimeCacheStatePidMatch,
  type RuntimeCacheState,
} from "../gateway/runtime-cache-state.js";

export type GatewayCommandOptions = {
  homeDir?: string;
  workspaceRoot: string;
  profileId?: string;
};

export type GatewayRenderer = (viewModel: ViewModel) => string;

type SelectedGatewayProfile = {
  homeDir: string;
  profileId: string;
  paths: ProfileStatePaths;
};

function cronStoreFor(paths: ProfileStatePaths): CronStore {
  return new CronStore({
    path: join(paths.cronPath, "jobs.json"),
    outputRoot: join(paths.cronPath, "output"),
  });
}

function deliveryRouterFor(homeDir: string, paths: ProfileStatePaths): DeliveryRouter {
  return new DeliveryRouter({
    homeDir,
    deliveryRoot: join(paths.gatewayStatePath, "delivery"),
    deliveryErrorLogPath: join(paths.gatewayStatePath, "logs", "delivery-errors.jsonl"),
  });
}

async function discoverRunningGatewayProfile(homeDir: string): Promise<string | undefined> {
  const profilesRoot = join(homeDir, ".estacoda", "profiles");
  let entries: string[] = [];
  try {
    entries = (await readdir(profilesRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    entries = [];
  }
  const candidates = Array.from(new Set([
    readActiveProfile({ homeDir }).profileId ?? defaultProfileId(),
    defaultProfileId(),
    ...entries,
  ]));

  for (const profileId of candidates) {
    const paths = resolveProfileStateHome({ homeDir, profileId });
    const pidContent = await readGatewayPid(paths);
    if (pidContent !== undefined && !(await isStalePid(paths))) {
      return pidContent.profileId ?? profileId;
    }
    const state = await readGatewayState(paths);
    if (state !== undefined) {
      return state.profileId ?? profileId;
    }
  }
  return undefined;
}

async function resolveGatewayProfile(
  options: GatewayCommandOptions,
  behavior: { preferRunning?: boolean } = {}
): Promise<SelectedGatewayProfile> {
  const homeDir = options.homeDir ?? process.env.HOME ?? ".estacoda";
  const profileId = options.profileId
    ?? (behavior.preferRunning ? await discoverRunningGatewayProfile(homeDir) : undefined)
    ?? readActiveProfile({ homeDir }).profileId
    ?? defaultProfileId();
  return {
    homeDir,
    profileId,
    paths: resolveProfileStateHome({ homeDir, profileId }),
  };
}

// ─────────────────────────────────────────────────────────────
// Gateway Status
// ─────────────────────────────────────────────────────────────

export async function runGatewayStatus(
  options: GatewayCommandOptions,
  renderer: GatewayRenderer = renderPlain
): Promise<{ ok: boolean; output: string }> {
  const selected = await resolveGatewayProfile(options, { preferRunning: true });
  const config = await loadRuntimeConfig({ ...options, profileId: selected.profileId });
  const homeDir = selected.homeDir;
  const globalPaths = resolveGlobalStateHome({ homeDir });

  const cronStore = cronStoreFor(selected.paths);
  const cronJobs = await cronStore.list();

  let executionStore: CronExecutionStore | undefined;
  let executionDb: { close(): void } | undefined;
  try {
    const db = openDefaultSQLiteDatabase({ path: globalPaths.sessionsSqlitePath });
    executionDb = db;
    executionStore = new CronExecutionStore({ db });
  } catch { /* ignore */ }

  let recentCronFailures: Awaited<ReturnType<CronExecutionStore["recentFailures"]>> = [];
  if (executionStore !== undefined) {
    try {
      recentCronFailures = await executionStore.recentFailures(5);
    } catch { /* table may not exist */ }
  }
  try { executionDb?.close(); } catch { /* ignore */ }

  const deliveryRouter = deliveryRouterFor(homeDir, selected.paths);
  const recentDeliveryErrors = await deliveryRouter.getRecentErrors(5);

  const surfacePointerStore = new FileSurfacePointerStore({ path: join(selected.paths.gatewayStatePath, "surface-pointers.json") });
  const surfacePointers = await surfacePointerStore.listPointers();

  const approvalStore = new ChannelApprovalStore({ path: join(selected.paths.gatewayStatePath, "channel-approvals.json") });
  const allApprovals = await approvalStore.listAll();

  const missingConfig: { channel: string; item: string }[] = [];
  if (config.channels.telegram.missing !== undefined) {
    missingConfig.push(...config.channels.telegram.missing.map((m) => ({ channel: "telegram", item: m })));
  }
  if (config.channels.discord.missing !== undefined) {
    missingConfig.push(...config.channels.discord.missing.map((m) => ({ channel: "discord", item: m })));
  }
  if (config.channels.email.missing !== undefined) {
    missingConfig.push(...config.channels.email.missing.map((m) => ({ channel: "email", item: m })));
  }
  if (config.channels.whatsapp.missing !== undefined) {
    missingConfig.push(...config.channels.whatsapp.missing.map((m) => ({ channel: "whatsapp", item: m })));
  }

  const state = await readGatewayState(selected.paths);
  const pidContent = await readGatewayPid(selected.paths);

  const identityLocks = await buildIdentityLockStatuses(selected.paths, config.channels);

  const runtimeState = await readAdapterRuntimeState(selected.paths);
  const supervisorLive = pidContent !== undefined && !(await isStalePid(selected.paths));
  const runtimeStateValid = runtimeState !== undefined
    && isRuntimeStateFresh(runtimeState)
    && isRuntimeStatePidMatch(runtimeState, pidContent?.pid ?? -1)
    && supervisorLive;

  // Trust model: only show runtime-cache-state in status when trustworthy
  const rawRuntimeCacheState = await readRuntimeCacheState(runtimeCacheStatePath(selected.paths));
  const runtimeCacheStateTrustworthy = rawRuntimeCacheState !== undefined
    && isRuntimeCacheStateFresh(rawRuntimeCacheState)
    && isRuntimeCacheStatePidMatch(rawRuntimeCacheState, pidContent?.pid ?? -1)
    && supervisorLive;

  const data: GatewayStatusData = {
    channels: config.channels,
    cronJobs: cronJobs.map((j) => ({ status: j.status, name: j.name, nextRunAt: j.nextRunAt })),
    recentCronFailures,
    recentDeliveryErrors,
    surfacePointers,
    approvalCount: allApprovals.length,
    approvalPolicy: config.security.approvalMode,
    missingConfig,
    supervisor:
      state !== undefined
        ? {
            pid: pidContent?.pid ?? state.pid,
            lifecycle: state.lifecycle,
            startedAt: state.startedAt,
            version: state.version,
            profileId: state.profileId ?? selected.profileId,
          }
        : pidContent !== undefined
          ? {
              pid: pidContent.pid,
              startedAt: pidContent.startedAt,
              version: pidContent.version,
              profileId: pidContent.profileId ?? selected.profileId,
            }
          : undefined,
    identityLocks,
    runtimeState: runtimeStateValid ? runtimeState : undefined,
    runtimeCacheState: runtimeCacheStateTrustworthy ? rawRuntimeCacheState : undefined,
  };

  const viewModel = buildGatewayStatusViewModel(data);
  return { ok: true, output: renderer(viewModel) };
}

// ─────────────────────────────────────────────────────────────
// Gateway Diagnose
// ─────────────────────────────────────────────────────────────

export async function runGatewayDiagnose(
  options: GatewayCommandOptions,
  renderer: GatewayRenderer = renderPlain
): Promise<{ ok: boolean; output: string }> {
  const selected = await resolveGatewayProfile(options, { preferRunning: true });
  const config = await loadRuntimeConfig({ ...options, profileId: selected.profileId });
  const homeDir = selected.homeDir;

  const tgDiag = await getTelegramGatewayDiagnostics({ ...options, profileId: selected.profileId });
  const waDiag = await getWhatsAppGatewayDiagnostics({ homeDir, gatewayStatePath: selected.paths.gatewayStatePath });

  const cronStore = cronStoreFor(selected.paths);
  const cronJobs = await cronStore.list();
  const jobsFileReadable = await isReadable(cronStore.path);
  const outputDirWritable = await isWritable(join(selected.paths.cronPath, "output"));
  const lockDirWritable = await isWritable(join(selected.paths.cronPath, "locks"));

  const runtimeState = await readAdapterRuntimeState(selected.paths);
  const pidContent = await readGatewayPid(selected.paths);
  const supervisorLive = pidContent !== undefined && !(await isStalePid(selected.paths));
  const runtimeStateNote = runtimeState === undefined
    ? undefined
    : !isRuntimeStateFresh(runtimeState)
      ? "stale"
      : !isRuntimeStatePidMatch(runtimeState, pidContent?.pid ?? -1)
        ? "pid-mismatch"
        : !supervisorLive
          ? "supervisor-not-live"
          : undefined;

  // Diagnose always reads runtime-cache-state; may display with warnings
  const rawRuntimeCacheState = await readRuntimeCacheState(runtimeCacheStatePath(selected.paths));
  const runtimeCacheStateNote = rawRuntimeCacheState === undefined
    ? undefined
    : !isRuntimeCacheStateFresh(rawRuntimeCacheState)
      ? "stale"
      : !isRuntimeCacheStatePidMatch(rawRuntimeCacheState, pidContent?.pid ?? -1)
        ? "pid-mismatch"
        : !supervisorLive
          ? "supervisor-not-live"
          : undefined;

  const deliveryRouter = deliveryRouterFor(homeDir, selected.paths);
  const recentDeliveryErrors = await deliveryRouter.getRecentErrors(5);

  const approvalStore = new ChannelApprovalStore({ path: join(selected.paths.gatewayStatePath, "channel-approvals.json") });
  const allApprovals = await approvalStore.listAll();

  const data: GatewayDiagnoseData = {
    telegram: tgDiag,
    discord: config.channels.discord,
    email: config.channels.email,
    whatsapp: waDiag,
    whatsappExperimental: config.channels.whatsapp.experimental ?? false,
    cronJobs: cronJobs.map((j) => ({ status: j.status })),
    jobsFileReadable,
    outputDirWritable,
    lockDirWritable,
    supervisor: {
      pidHealthy: !(await isStalePid(selected.paths)),
      lockHealthy: !(await isStaleLock(selected.paths)),
    },
    identityLockHealth: await buildIdentityLockHealth(selected.paths, config.channels),
    runtimeState: runtimeState ?? undefined,
    runtimeStateNote,
    runtimeCacheState: rawRuntimeCacheState ?? undefined,
    runtimeCacheStateNote,
    approvalCount: allApprovals.length,
    recentDeliveryErrors,
    channels: config.channels,
  };

  const viewModel = buildGatewayDiagnoseViewModel(data);
  return { ok: viewModel.ok, output: renderer(viewModel) };
}

// ─────────────────────────────────────────────────────────────
// Gateway Start Dry Run
// ─────────────────────────────────────────────────────────────

export async function runGatewayStartDryRun(
  options: GatewayCommandOptions
): Promise<{ ok: boolean; output: string }> {
  const selected = await resolveGatewayProfile(options);
  const config = await loadRuntimeConfig({ ...options, profileId: selected.profileId });
  const registry = new AdapterRegistry(config.channels);
  const configured = registry.configured();
  const enabled = registry.enabled();
  const identityReadiness = inspectAdapterIdentityReadiness(config.channels);
  const lock = await inspectGatewayLockState(selected.paths);
  const cronOutputWritable = await isWritable(join(selected.paths.cronPath, "output"));
  const cronLocksWritable = await isWritable(join(selected.paths.cronPath, "locks"));
  const logsWritable = await isWritable(selected.paths.logsPath);

  const stateDirsReady = cronOutputWritable && cronLocksWritable && logsWritable;
  const lockSummary = summarizeGatewayLockInspection(lock);
  const adapters = enabled.length > 0
    ? enabled.map((cap) => cap.kind).join(", ")
    : "none";
  const mode = enabled.length > 0 ? "adapters" : "cron-only";
  const warnings: string[] = [];

  if (enabled.length > configured.length) {
    const misconfigured = registry.misconfigured();
    for (const cap of misconfigured) {
      warnings.push(`${cap.kind}: missing ${cap.missingConfig?.join(", ") ?? "configuration"}`);
    }
  }
  for (const error of identityReadiness.errors) {
    warnings.push(error);
  }
  if (!stateDirsReady) {
    warnings.push("State dirs: run estacoda init to create cron output, cron locks, and logs directories");
  }
  if (lockSummary.severity !== "ok") {
    warnings.push(`Gateway lock: ${lockSummary.detail}`);
  }

  return {
    ok: lockSummary.severity === "ok" && identityReadiness.errors.length === 0,
    output: [
      `Adapters: ${adapters}`,
      `Mode: ${mode}`,
      "Config: valid",
      `Adapter identities: ${identityReadiness.valid.length > 0 ? `${identityReadiness.valid.join(", ")} locally valid` : "none"}`,
      `State dirs: ${stateDirsReady ? "ready" : "not initialized"}`,
      `Gateway lock: ${lockSummary.label}`,
      ...warnings.map((warning) => `Warning: ${warning}`),
    ].join("\n"),
  };
}

// ─────────────────────────────────────────────────────────────
// Gateway Start Background
// ─────────────────────────────────────────────────────────────

export async function runGatewayStartBackground(
  options: GatewayCommandOptions
): Promise<{ ok: boolean; output: string }> {
  const selected = await resolveGatewayProfile(options);
  const logPath = join(selected.paths.logsPath, "gateway.log");
  await mkdir(selected.paths.logsPath, { recursive: true });

  let logFd: number | undefined;
  try {
    logFd = openSync(logPath, "a", 0o600);
    const child = spawn(process.execPath, resolveBackgroundGatewayStartArgs(selected.profileId), {
      cwd: options.workspaceRoot,
      detached: true,
      env: {
        ...process.env,
        HOME: selected.homeDir,
      },
      stdio: ["ignore", logFd, logFd],
    });

    child.unref();

    return {
      ok: true,
      output: [
        `Gateway started (PID ${child.pid ?? "unknown"})`,
        `Logs: ${logPath}`,
      ].join("\n"),
    };
  } catch (error) {
    return {
      ok: false,
      output: `Failed to start gateway in background: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    if (logFd !== undefined) {
      closeSync(logFd);
    }
  }
}

// ───────────────────────────────────────────────────────────
// Gateway Stop
// ───────────────────────────────────────────────────────────

export async function runGatewayStop(
  options: GatewayCommandOptions & { force?: boolean }
): Promise<{ ok: boolean; output: string }> {
  const selected = await resolveGatewayProfile(options, { preferRunning: true });
  const result = await stopGateway(selected.paths, { force: options.force });

  if (result.ok) {
    if (result.action === "was_not_running") {
      if (result.liveLock) {
        return { ok: true, output: "Gateway is not running (live operation lock exists)" };
      }
      if (result.pid !== undefined) {
        return {
          ok: true,
          output: `Gateway was not running (cleaned up stale state for PID ${result.pid})`,
        };
      }
      return { ok: true, output: "Gateway is not running" };
    }

    // action === "stopped"
    if (result.forced) {
      return {
        ok: true,
        output: `Gateway stopped (forced, PID ${result.pid})`,
      };
    }
    return { ok: true, output: `Gateway stopped (PID ${result.pid})` };
  }

  return { ok: false, output: result.error };
}

// ───────────────────────────────────────────────────────────
// Gateway Restart
// ───────────────────────────────────────────────────────────

export async function runGatewayRestart(
  options: GatewayCommandOptions & { graceful?: boolean }
): Promise<{ ok: boolean; output: string }> {
  const selected = await resolveGatewayProfile(options, { preferRunning: true });

  // Stop existing gateway (always graceful — plain restart should not force-kill)
  const stopResult = await stopGateway(selected.paths, { force: false });

  let stopOutput: string;
  if (stopResult.ok) {
    if (stopResult.action === "was_not_running") {
      stopOutput = "Gateway was not running";
    } else if (stopResult.forced) {
      stopOutput = `Gateway stopped (forced, PID ${stopResult.pid})`;
    } else {
      stopOutput = `Gateway stopped (PID ${stopResult.pid})`;
    }
  } else {
    return { ok: false, output: `Failed to stop gateway: ${stopResult.error}` };
  }

  const startResult = await runGatewayStartBackground(options);

  return {
    ok: startResult.ok,
    output: [stopOutput, startResult.output].filter(Boolean).join("\n"),
  };
}

// ───────────────────────────────────────────────────────────
// Channels List
// ───────────────────────────────────────────────────────────

export async function runChannelsList(
  options: GatewayCommandOptions,
  renderer: GatewayRenderer = renderPlain
): Promise<{ ok: boolean; output: string }> {
  const config = await loadRuntimeConfig(options);
  const registry = new AdapterRegistry(config.channels);

  const viewModel = buildChannelsListViewModel({ channels: config.channels, capabilities: registry.all() });
  return { ok: true, output: renderer(viewModel) };
}

// ─────────────────────────────────────────────────────────────
// Channels Status
// ─────────────────────────────────────────────────────────────

async function detectRuntimeStatePresence(stateHome: ProfileStatePaths): Promise<"missing" | "unreadable" | "present"> {
  const path = join(stateHome.gatewayStatePath, RUNTIME_STATE_FILE);
  try {
    await stat(path);
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String((error as { code?: unknown }).code) : "";
    if (code === "ENOENT") return "missing";
    return "unreadable";
  }

  const state = await readAdapterRuntimeState(stateHome);
  return state === undefined ? "unreadable" : "present";
}

type ChannelRuntimeStatus = {
  readonly runtimeStateNote?: string;
  readonly runtimeState?: PersistedRuntimeState;
};

async function buildChannelRuntimeStatus(stateHome: ProfileStatePaths): Promise<ChannelRuntimeStatus> {
  const pidRecord = await readGatewayPid(stateHome);
  if (pidRecord === undefined || await isStalePid(stateHome)) {
    return { runtimeStateNote: "unavailable (supervisor not running)" };
  }

  const presence = await detectRuntimeStatePresence(stateHome);
  if (presence === "missing") {
    return { runtimeStateNote: "unavailable (adapter runtime state not found)" };
  }
  if (presence === "unreadable") {
    return { runtimeStateNote: "unavailable (adapter runtime state unreadable)" };
  }

  const runtimeState = await readAdapterRuntimeState(stateHome);
  if (runtimeState === undefined) {
    return { runtimeStateNote: "unavailable (adapter runtime state unreadable)" };
  }
  if (!isRuntimeStateFresh(runtimeState)) {
    return { runtimeStateNote: "stale (last update >5min ago)" };
  }
  if (!isRuntimeStatePidMatch(runtimeState, pidRecord.pid)) {
    return { runtimeStateNote: "stale (supervisor restarted since last update)" };
  }

  return { runtimeState };
}

function selectIdentityLockStatus(
  locks: Awaited<ReturnType<typeof listAdapterIdentityLocks>>,
  kind: string
): IdentityLockStatus | undefined {
  const lock = locks.find((l) => l.kind === kind);
  if (lock === undefined) return undefined;
  return { kind: lock.kind, state: lock.stale ? "stale" : "locked", pid: lock.pid };
}

function runtimeFieldsForChannel(
  kind: "telegram" | "discord" | "email" | "whatsapp",
  runtimeStatus: ChannelRuntimeStatus,
  locks: Awaited<ReturnType<typeof listAdapterIdentityLocks>>,
  channel: { busyPolicy?: string; queueDepth?: number }
): Pick<NonNullable<ChannelsStatusData[typeof kind]>, "runtimeStateNote" | "adapterRuntime" | "identityLock" | "busyPolicy" | "queueDepth"> {
  return {
    runtimeStateNote: runtimeStatus.runtimeStateNote,
    adapterRuntime: runtimeStatus.runtimeState?.adapters.find((a) => a.kind === kind),
    identityLock: selectIdentityLockStatus(locks, kind),
    busyPolicy: channel.busyPolicy ?? "reject",
    queueDepth: channel.queueDepth ?? 3,
  };
}

export async function runChannelsStatus(
  options: GatewayCommandOptions & { channel?: string },
  renderer: GatewayRenderer = renderPlain
): Promise<{ ok: boolean; output: string }> {
  const selected = await resolveGatewayProfile(options, { preferRunning: true });
  const config = await loadRuntimeConfig({ ...options, profileId: selected.profileId });

  const surfacePointerStore = new FileSurfacePointerStore({ path: join(selected.paths.gatewayStatePath, "surface-pointers.json") });
  const surfacePointers = await surfacePointerStore.listPointers();

  const registry = new AdapterRegistry(config.channels);
  const runtimeStatus = await buildChannelRuntimeStatus(selected.paths);
  const identityLocks = await listAdapterIdentityLocks(selected.paths);

  const channel = options.channel?.toLowerCase();

  if (channel === undefined || channel === "telegram") {
    const tgDiag = await getTelegramGatewayDiagnostics({ ...options, profileId: selected.profileId });
    const tgPointers = surfacePointers.filter((p) => p.surfaceType === "telegram");

    const data: ChannelsStatusData = {
      channel: "telegram",
      telegram: {
        diag: tgDiag,
        pointers: tgPointers,
        capability: registry.get("telegram")!,
        ...runtimeFieldsForChannel("telegram", runtimeStatus, identityLocks, config.channels.telegram),
      },
    };
    const viewModel = buildChannelsStatusViewModel(data);
    return { ok: viewModel.kind !== "plainFallback", output: renderer(viewModel) };
  }

  if (channel === "discord") {
    const dcPointers = surfacePointers.filter((p) => p.surfaceType === "discord");

    const data: ChannelsStatusData = {
      channel: "discord",
      discord: {
        config: config.channels.discord,
        pointers: dcPointers,
        capability: registry.get("discord")!,
        ...runtimeFieldsForChannel("discord", runtimeStatus, identityLocks, config.channels.discord),
      },
    };
    const viewModel = buildChannelsStatusViewModel(data);
    return { ok: true, output: renderer(viewModel) };
  }

  if (channel === "email") {
    const emPointers = surfacePointers.filter((p) => p.surfaceType === "email");

    const data: ChannelsStatusData = {
      channel: "email",
      email: {
        config: config.channels.email,
        pointers: emPointers,
        capability: registry.get("email")!,
        ...runtimeFieldsForChannel("email", runtimeStatus, identityLocks, config.channels.email),
      },
    };
    const viewModel = buildChannelsStatusViewModel(data);
    return { ok: true, output: renderer(viewModel) };
  }

  if (channel === "whatsapp") {
    const waDiag = await getWhatsAppGatewayDiagnostics({ homeDir: selected.homeDir, gatewayStatePath: selected.paths.gatewayStatePath });
    const waPointers = surfacePointers.filter((p) => p.surfaceType === "whatsapp");

    const data: ChannelsStatusData = {
      channel: "whatsapp",
      whatsapp: {
        diag: waDiag,
        config: config.channels.whatsapp,
        pointers: waPointers,
        capability: registry.get("whatsapp")!,
        ...runtimeFieldsForChannel("whatsapp", runtimeStatus, identityLocks, config.channels.whatsapp),
      },
    };
    const viewModel = buildChannelsStatusViewModel(data);
    return { ok: true, output: renderer(viewModel) };
  }

  const viewModel = buildChannelsStatusViewModel({ channel: options.channel ?? "unknown" });
  return { ok: false, output: renderer(viewModel) };
}

// ─────────────────────────────────────────────────────────────
// Identity Lock Helpers
// ─────────────────────────────────────────────────────────────

async function buildIdentityLockStatuses(
  stateHome: ProfileStatePaths,
  _channels: LoadedRuntimeConfig["channels"]
): Promise<IdentityLockStatus[]> {
  const locks = await listAdapterIdentityLocks(stateHome);
  const staleLocks = locks.filter((l) => l.stale);

  // Deduplicate by kind; status only surfaces actionable problems
  const seen = new Set<string>();
  const results: IdentityLockStatus[] = [];
  for (const lock of staleLocks) {
    if (!seen.has(lock.kind)) {
      seen.add(lock.kind);
      results.push({ kind: lock.kind, state: "stale", pid: lock.pid });
    }
  }
  return results;
}

async function buildIdentityLockHealth(
  stateHome: ProfileStatePaths,
  channels: LoadedRuntimeConfig["channels"]
): Promise<{
  staleLocks: { kind: string; pid: number }[];
  duplicateHashes: string[];
  missingLocks: string[];
}> {
  const [tgHash, dcHash, emHash, waHash] = await Promise.all([
    deriveTelegramIdentityHash(stateHome, channels.telegram),
    deriveDiscordIdentityHash(stateHome, channels.discord),
    deriveEmailIdentityHash(stateHome, channels.email),
    deriveWhatsAppIdentityHash(stateHome, channels.whatsapp),
  ]);

  const locks = await listAdapterIdentityLocks(stateHome);

  const staleLocks = locks
    .filter((l) => l.stale)
    .map((l) => ({ kind: l.kind, pid: l.pid }));

  const seenHashes = new Set<string>();
  const duplicateHashes: string[] = [];
  for (const lock of locks) {
    if (seenHashes.has(lock.identityHash)) {
      duplicateHashes.push(`${lock.kind}:${lock.identityHash.slice(0, 8)}...`);
    }
    seenHashes.add(lock.identityHash);
  }

  const missingLocks: string[] = [];
  const kindToHash = new Map<string, string | undefined>([
    ["telegram", tgHash],
    ["discord", dcHash],
    ["email", emHash],
    ["whatsapp", waHash],
  ]);
  for (const kind of ["telegram", "discord", "email", "whatsapp"] as const) {
    const hash = kindToHash.get(kind);
    if (hash === undefined) continue;
    const hasLock = locks.some((l) => l.kind === kind && l.identityHash === hash);
    if (!hasLock) {
      missingLocks.push(kind);
    }
  }

  return { staleLocks, duplicateHashes, missingLocks };
}

// ─────────────────────────────────────────────────────────────
// Channels Enable / Disable
// ─────────────────────────────────────────────────────────────

const VALID_CHANNELS = new Set(["telegram", "discord", "email", "whatsapp"]);

const DISPLAY_NAMES: Record<string, string> = {
  telegram: "Telegram",
  discord: "Discord",
  email: "Email",
  whatsapp: "WhatsApp",
};

function normalizeChannel(channel: string | undefined): string | undefined {
  if (channel === undefined || channel.trim() === "") return undefined;
  return channel.toLowerCase().trim();
}

function validateChannel(
  channel: string | undefined,
  command: "enable" | "disable"
): { ok: true; normalized: string; display: string } | { ok: false; output: string } {
  const normalized = normalizeChannel(channel);
  if (normalized === undefined) {
    return { ok: false, output: `Usage: estacoda channels ${command} <channel>` };
  }
  if (!VALID_CHANNELS.has(normalized)) {
    return { ok: false, output: `Unknown channel: ${channel}. Supported: telegram, discord, email, whatsapp.` };
  }
  return { ok: true, normalized, display: DISPLAY_NAMES[normalized] };
}

function resolveUserConfigPath(options: GatewayCommandOptions): string {
  const profileId = options.profileId ?? readActiveProfile({ homeDir: options.homeDir }).profileId ?? defaultProfileId();
  return resolveProfileStateHome({ homeDir: options.homeDir, profileId }).configPath;
}

async function readUserConfigRaw(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const text = await readFile(path, "utf8");
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("Config file must contain a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function atomicWriteUserConfig(targetPath: string, config: Record<string, unknown>): Promise<void> {
  const dir = dirname(targetPath);
  await mkdir(dir, { recursive: true });
  const tempPath = join(dir, `config.json.tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`);
  try {
    await writeFile(tempPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    await rename(tempPath, targetPath);
  } catch (error) {
    try { await rm(tempPath, { force: true }); } catch { /* ignore */ }
    throw error;
  }
}

export async function runChannelsEnable(
  options: GatewayCommandOptions & { channel?: string }
): Promise<{ ok: boolean; output: string }> {
  const validation = validateChannel(options.channel, "enable");
  if (!validation.ok) {
    return { ok: false, output: validation.output };
  }

  const targetPath = resolveUserConfigPath(options);
  let raw: Record<string, unknown> | undefined;
  try {
    raw = await readUserConfigRaw(targetPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, output: `Config file could not be parsed: ${message}. No changes were made.` };
  }

  const channel = validation.normalized;
  const display = validation.display;

  const currentChannel = (raw?.channels as Record<string, unknown> | undefined)?.[channel] as Record<string, unknown> | undefined;
  if (currentChannel?.enabled === true) {
    return { ok: true, output: `${display} is already enabled` };
  }

  const updatedChannel = { ...(currentChannel ?? {}), enabled: true };
  const updated: Record<string, unknown> = {
    ...raw,
    channels: {
      ...(raw?.channels as Record<string, unknown> | undefined),
      [channel]: updatedChannel,
    },
  };

  await atomicWriteUserConfig(targetPath, updated);
  return { ok: true, output: `${display} enabled` };
}

export async function runChannelsDisable(
  options: GatewayCommandOptions & { channel?: string }
): Promise<{ ok: boolean; output: string }> {
  const validation = validateChannel(options.channel, "disable");
  if (!validation.ok) {
    return { ok: false, output: validation.output };
  }

  const targetPath = resolveUserConfigPath(options);
  let raw: Record<string, unknown> | undefined;
  try {
    raw = await readUserConfigRaw(targetPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, output: `Config file could not be parsed: ${message}. No changes were made.` };
  }

  if (raw === undefined) {
    return { ok: true, output: `${validation.display} is already disabled` };
  }

  const channel = validation.normalized;
  const display = validation.display;

  const currentChannel = (raw.channels as Record<string, unknown> | undefined)?.[channel] as Record<string, unknown> | undefined;
  if (currentChannel?.enabled === false || currentChannel?.enabled === undefined) {
    return { ok: true, output: `${display} is already disabled` };
  }

  const updatedChannel = { ...currentChannel, enabled: false };
  const updated: Record<string, unknown> = {
    ...raw,
    channels: {
      ...(raw.channels as Record<string, unknown> | undefined),
      [channel]: updatedChannel,
    },
  };

  await atomicWriteUserConfig(targetPath, updated);
  return { ok: true, output: `${display} disabled` };
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function summarizeGatewayLockInspection(lock: GatewayLockInspection): { severity: "ok" | "error"; label: string; detail?: string } {
  switch (lock.state) {
    case "missing":
      return { severity: "ok", label: "no active owner detected" };
    case "active":
      return { severity: "error", label: `active owner detected (PID ${lock.pid})`, detail: `active owner detected (PID ${lock.pid})` };
    case "stale":
      return { severity: "error", label: `stale lock suspected (PID ${lock.pid})`, detail: `stale lock suspected (${lock.reason}, PID ${lock.pid})` };
    case "malformed":
      return { severity: "error", label: "malformed lock file", detail: `malformed lock file (${lock.error})` };
    case "inaccessible":
      return { severity: "error", label: "lock path inaccessible", detail: `lock path inaccessible (${lock.error})` };
    default:
      return { severity: "error", label: "unknown lock state", detail: "unknown lock state" };
  }
}

function inspectAdapterIdentityReadiness(channels: LoadedRuntimeConfig["channels"]): { valid: string[]; errors: string[] } {
  const valid: string[] = [];
  const errors: string[] = [];

  const checks = [
    { kind: "telegram", enabled: channels.telegram.enabled === true, material: resolveTelegramIdentityMaterial(channels.telegram) },
    { kind: "discord", enabled: channels.discord.enabled === true, material: resolveDiscordIdentityMaterial(channels.discord) },
    { kind: "email", enabled: channels.email.enabled === true, material: resolveEmailIdentityMaterial(channels.email) },
    { kind: "whatsapp", enabled: channels.whatsapp.enabled === true, material: resolveWhatsAppIdentityMaterial(channels.whatsapp) },
  ];

  for (const check of checks) {
    if (!check.enabled) continue;
    if (check.material === undefined) {
      errors.push(`${check.kind}: configured but no derivable identity. Check local identity settings.`);
    } else {
      valid.push(check.kind);
    }
  }

  return { valid, errors };
}

function resolveBackgroundGatewayStartArgs(profileId?: string): string[] {
  const entrypoint = process.argv[1];
  return [
    ...process.execArgv,
    ...(entrypoint === undefined ? [] : [entrypoint]),
    "gateway",
    "start",
    ...(profileId === undefined ? [] : ["--profile", profileId]),
  ];
}

async function isReadable(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function isWritable(path: string): Promise<boolean> {
  try {
    await access(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}
