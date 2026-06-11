import { appendFile, mkdir, unlink } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { resolveHomeDir } from "../config/home-dir.js";
import { addWhatsAppAllowedUser, loadRuntimeConfig, consumeTelegramPairingCode } from "../config/runtime-config.js";
import { defaultProfileId, readActiveProfile, resolveProfileStateHome } from "../config/profile-home.js";
import type { ProfileStatePaths } from "../config/profile-home.js";
import { WorkspaceTrustStore } from "../security/workspace-trust-store.js";
import { WorkspaceApprovalController } from "../security/workspace-approval-controller.js";
import type { SecurityAssessorRuntimeConfig } from "../security/security-policy-factory.js";
import type { LoadedRuntimeConfig, ChannelBusyPolicy } from "../config/runtime-config.js";
import type { ChannelAdapter, ChannelAuthPolicies, ChannelKind, ChannelMessage } from "../contracts/channel.js";
import type { ResolvedModelRoute } from "../contracts/provider.js";
import type { SecurityPolicy } from "../contracts/security.js";
import { createRuntimeCronRunner, tickCron } from "../cron/cron-runner.js";
import { CronStore } from "../cron/cron-store.js";
import { CronExecutionStore } from "../cron/cron-execution-store.js";
import { createFileCronJobLock } from "../cron/cron-lock.js";
import { ProviderExecutor } from "../providers/provider-executor.js";
import { resolveAuxiliaryModelRoute } from "../providers/auxiliary-model-resolver.js";
import { resolveEffectiveSessionModelOverride } from "../providers/model-switch-resolver.js";
import { SessionCompressionService } from "../prompt/session-compression-service.js";
import { createRuntime, type Runtime, type RuntimeOptions } from "../runtime/create-runtime.js";
import { RuntimeCache } from "../runtime/runtime-cache.js";
import { computeRuntimeFingerprint, stableJsonHash, type RuntimeFingerprint } from "../runtime/runtime-fingerprint.js";
import { SQLiteSessionDB } from "../session/sqlite-session-db.js";
import { createSQLiteSessionDB } from "../session/session-setup.js";
import { resolveTokens } from "../theme/token-resolver.js";
import { ChannelApprovalStore } from "../channels/channel-approval-store.js";
import { ChannelGateway, telegramGatewayCommands } from "../channels/channel-gateway.js";
import { PersistentChannelSessionStore } from "../channels/channel-session-store.js";
import { DeliveryRouter } from "../channels/delivery-router.js";
import { GATEWAY_HYGIENE_THRESHOLD, SessionHygieneService } from "../channels/session-hygiene-service.js";
import { FileHandoffStore } from "../channels/handoff-store.js";
import { FileSurfacePointerStore } from "../channels/surface-pointer-store.js";
import { TelegramAdapter, type TelegramFetch } from "../channels/telegram-adapter.js";
import { DiscordAdapter } from "../channels/discord-adapter.js";
import { EmailAdapter } from "../channels/email-adapter.js";
import { WhatsAppAdapter } from "../channels/whatsapp-adapter.js";
import { consumeWhatsAppUserAuthCode, defaultWhatsAppUserAuthStorePath } from "../channels/whatsapp-pairing-store.js";
import { defaultWhatsAppAliasStorePath, normalizeWhatsAppAllowlist, normalizeWhatsAppGroupAllowlist } from "../channels/whatsapp-identity.js";
import { AdapterRegistry } from "../channels/adapter-registry.js";
import {
  deriveTelegramIdentityHash,
  deriveDiscordIdentityHash,
  deriveEmailIdentityHash,
  deriveWhatsAppIdentityHash,
} from "../channels/adapter-identity.js";
import { injectVoiceTranscripts, type VoiceTranscriptionAuditEvent } from "../channels/voice-transcription.js";
import { ManagedFasterWhisperWorker } from "../python-env/managed-faster-whisper-worker.js";
import { isFasterWhisperConfig } from "../tools/stt-providers.js";
import { acquireGatewayLock, releaseGatewayLock } from "./gateway-lock.js";
import { writeGatewayPid, removeGatewayPid } from "./pid-file.js";
import { writeGatewayState, removeGatewayState } from "./supervisor-state.js";
import { cleanupStaleGatewayState } from "./supervisor-state.js";
import {
  acquireAdapterIdentityLock,
  releaseAdapterIdentityLock,
} from "./identity-lock.js";
import { getPackageVersion } from "../cli/version-command.js";
import type { GatewayRunOptions, GatewayRunResult } from "../channels/gateway-runner.js";
import { AdapterResilienceSupervisor } from "./adapter-resilience.js";
import { writeAdapterRuntimeState, RUNTIME_STATE_HEARTBEAT_MS } from "./adapter-runtime-state.js";
import {
  runtimeCacheStatePath,
  writeRuntimeCacheState,
  type RuntimeCacheState,
} from "./runtime-cache-state.js";
import { ActiveTurnRegistry } from "./active-turn-registry.js";
import { GatewayApprovalQueue } from "./approval-queue.js";
import { VoiceStateManager } from "./voice-state.js";
import {
  HookRegistry,
  type GatewayHookEventName,
  type GatewayHookPayloadByName,
  sanitizeHookError,
} from "./hook-registry.js";
import {
  writeCleanShutdownMarker,
  readCleanShutdownMarker,
  removeCleanShutdownMarker,
  isCleanShutdownTrustworthy,
} from "./supervisor-lifecycle.js";

export type { GatewayRunOptions, GatewayRunResult };

export type SupervisorFactories = {
  createTelegramAdapter?(input: ConstructorParameters<typeof TelegramAdapter>[0]): ChannelAdapter;
  createDiscordAdapter?(input: ConstructorParameters<typeof DiscordAdapter>[0]): ChannelAdapter;
  createEmailAdapter?(input: ConstructorParameters<typeof EmailAdapter>[0]): ChannelAdapter;
  createWhatsAppAdapter?(input: ConstructorParameters<typeof WhatsAppAdapter>[0]): ChannelAdapter;
  createChannelGateway?(input: ConstructorParameters<typeof ChannelGateway>[0]): ChannelGateway;
  createDeliveryRouter?(input: ConstructorParameters<typeof DeliveryRouter>[0]): DeliveryRouter;
  tickCron?(input: Parameters<typeof tickCron>[0]): ReturnType<typeof tickCron>;
  sleep?(ms: number): Promise<void>;
  exit?(code: number): void;
};

export type GatewaySupervisorOptions = GatewayRunOptions & {
  once?: boolean;
  factories?: SupervisorFactories;
  drainTimeoutMs?: number;
};

export function buildGatewayCronRuntimeOptions(input: {
  latestConfig: LoadedRuntimeConfig;
  workspaceRoot: string;
  homeDir: string;
  profileId: string;
  sessionDb: SQLiteSessionDB;
  sessionId: string;
}): RuntimeOptions {
  const { latestConfig } = input;
  return {
    tokens: resolveTokens("standard", "dark", "kemetBlue"),
    model: latestConfig.model,
    primaryModelRoute: latestConfig.primaryModelRoute,
    modelFallbackRoutes: latestConfig.modelFallbackRoutes,
    workspaceRoot: input.workspaceRoot,
    homeDir: input.homeDir,
    sessionId: input.sessionId,
    profileId: input.profileId,
    sessionDb: input.sessionDb,
    externalSkillRoots: latestConfig.skills.externalDirs,
    skillAutonomy: latestConfig.skills.autonomy,
    skillConfig: latestConfig.skills.config,
    ui: latestConfig.ui,
    agentProfile: latestConfig.profile,
    providerRegistry: latestConfig.providerRegistry,
    providerConfigs: latestConfig.config.providers,
    auxiliaryModels: latestConfig.auxiliaryModels,
    compression: latestConfig.compression,
    externalMemory: latestConfig.externalMemory,
    mcpServers: latestConfig.mcp.servers,
    imageGen: latestConfig.imageGen,
    tts: latestConfig.tts,
    stt: latestConfig.stt,
    securityMode: latestConfig.security.approvalMode,
    securityAssessor: {
      ...latestConfig.security.assessor,
      providerExecutor: new ProviderExecutor({
        registry: latestConfig.providerRegistry,
      }),
    },
    browser: latestConfig.browser,
    telegramReady: latestConfig.channels.telegram.ready,
    enableWebNetwork: latestConfig.web.enableNetwork,
    webMaxContentChars: latestConfig.web.maxContentChars,
    webConfig: {
      backend: latestConfig.web.backend,
      searchBackend: latestConfig.web.searchBackend,
      extractBackend: latestConfig.web.extractBackend,
      crawlBackend: latestConfig.web.crawlBackend
    },
    securityConfig: {
      allowPrivateUrls: latestConfig.security.allowPrivateUrls,
      websiteBlocklist: latestConfig.security.websiteBlocklist
    },
    disableCronTools: true,
    disabledToolsets: ["cron", "messaging", "clarify"],
  };
}

async function buildGatewaySecurityAssessorConfig(
  config: LoadedRuntimeConfig
): Promise<SecurityAssessorRuntimeConfig> {
  const mainRoute: ResolvedModelRoute = config.primaryModelRoute ?? {
    provider: config.model.provider,
    id: config.model.id,
    profile: config.model
  };
  if (config.security.assessor.enabled !== true) {
    return {
      ...config.security.assessor,
      mainRoute,
      providerExecutor: new ProviderExecutor({
        registry: config.providerRegistry,
      }),
    };
  }

  const providerModels = await config.providerRegistry.listModels();
  const assessorRoute = config.model.provider === "unconfigured"
    ? undefined
    : resolveAuxiliaryModelRoute("assessor", config.auxiliaryModels, {
      mainRoute,
      providerRegistry: config.providerRegistry,
      providerModels
    });

  return {
    ...config.security.assessor,
    provider: config.security.assessor.provider ?? assessorRoute?.route?.provider,
    model: config.security.assessor.model ?? assessorRoute?.route?.id,
    auxiliaryRoute: assessorRoute,
    mainRoute,
    providerExecutor: new ProviderExecutor({
      registry: config.providerRegistry,
    }),
  };
}

type AcquiredIdentityLock = {
  kind: ChannelKind;
  hash: string;
};

export type SupervisorInternalState = {
  homeDir: string;
  stateHome: ProfileStatePaths;
  gatewayLockAcquired: boolean;
  acquiredIdentityLocks: AcquiredIdentityLock[];
  channelGateway: ChannelGateway | undefined;
  sessionDb: SQLiteSessionDB | undefined;
  onSigint: (() => void) | undefined;
  onSigterm: (() => void) | undefined;
  shutdownStarted: boolean;
  draining: boolean;
  running: boolean;
  cleanupDone: boolean;
  exit: (code: number) => void;
  activeTurnRegistry?: ActiveTurnRegistry;
  gatewayApprovalQueue?: GatewayApprovalQueue;
  runtimeCache?: RuntimeCache;
  runtimeFingerprint?: RuntimeFingerprint;
  pruneTimer?: ReturnType<typeof setInterval>;
  stuckScanTimer?: ReturnType<typeof setInterval>;
  lastRuntimeCacheStateWrite: number;
  lastGatewayApprovalExpiryRun: number;
  runtimeCacheStatePath: string;
  supervisorStartedAt: string;
  stuckAbortSent: Set<string>;
  stuckEventRecorded: Set<string>;
  stuckEventsBySession: Map<string, number[]>;
  startupComplete: boolean;
  shutdownClean?: boolean;
  shutdownReason?: string;
  drainCancelled: boolean;
  signalExit?: Promise<void>;
  hookRegistry?: HookRegistry;
  gatewayLocalWhisper?: ManagedFasterWhisperWorker;
  gatewayLocalWhisperConfigKey?: string;
};

function logInfo(message: string): void {
  console.log(message);
}

function logWarning(message: string): void {
  console.warn(message);
}

function logDebug(message: string): void {
  console.debug(message);
}

function emitSupervisorHook<N extends GatewayHookEventName>(
  hookRegistry: HookRegistry | undefined,
  name: N,
  payload: GatewayHookPayloadByName[N],
): void {
  try {
    const p = hookRegistry?.emit(name, payload);
    if (p) {
      p.catch(() => {});
    }
  } catch {
    // HookRegistry.emit threw synchronously — ignore
  }
}

export function createVoiceTranscriptionAudit(input: {
  profilePaths: ProfileStatePaths;
  hookRegistry?: HookRegistry;
  logWarning?: (message: string) => void;
}): (event: VoiceTranscriptionAuditEvent) => Promise<void> {
  return async (event) => {
    const payload = {
      outcome: event.outcome,
      provider: event.provider,
      reason: event.reason,
      attachment: event.attachment
    };
    emitSupervisorHook(input.hookRegistry, "gateway:stt:preprocess", payload);
    const logPath = join(input.profilePaths.gatewayStatePath, "logs", "voice-stt-preprocess.jsonl");
    await mkdir(dirname(logPath), { recursive: true });
    await appendFile(logPath, `${JSON.stringify(event)}\n`, "utf8");
    if (event.outcome === "deny" || event.outcome === "fail") {
      input.logWarning?.(`[voice-stt-preprocess] ${event.outcome}: ${event.reason ?? "unknown"} attachment=${event.attachment.id} pathHash=${event.attachment.pathHash ?? "none"}`);
    }
  };
}

export function gatewayFasterWhisperWorkerConfigKey(
  stt: LoadedRuntimeConfig["stt"],
  fasterWhisperDefaultHfHome: string
): string {
  return JSON.stringify({
    engine: stt.local?.engine,
    pythonBinary: stt.local?.pythonBinary,
    hfHome: stt.local?.fasterWhisper?.hfHome ?? fasterWhisperDefaultHfHome,
    queueDepth: stt.local?.fasterWhisper?.queueDepth,
    timeoutMs: stt.local?.fasterWhisper?.timeoutMs
  });
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function createInitialState(
  homeDir: string,
  stateHome: ProfileStatePaths,
  exitFn: (code: number) => void,
  supervisorStartedAt: string
): SupervisorInternalState {
  return {
    homeDir,
    stateHome,
    gatewayLockAcquired: false,
    acquiredIdentityLocks: [],
    channelGateway: undefined,
    sessionDb: undefined,
    onSigint: undefined,
    onSigterm: undefined,
    shutdownStarted: false,
    draining: false,
    running: true,
    exit: exitFn,
    activeTurnRegistry: undefined,
    gatewayApprovalQueue: undefined,
    runtimeCache: undefined,
    runtimeFingerprint: undefined,
    pruneTimer: undefined,
    stuckScanTimer: undefined,
    lastRuntimeCacheStateWrite: 0,
    lastGatewayApprovalExpiryRun: 0,
    runtimeCacheStatePath: runtimeCacheStatePath(stateHome),
    supervisorStartedAt,
    stuckAbortSent: new Set(),
    stuckEventRecorded: new Set(),
    stuckEventsBySession: new Map(),
    cleanupDone: false,
    startupComplete: false,
    drainCancelled: false,
    signalExit: undefined,
  };
}

async function cleanupSupervisorStartupResources(state: SupervisorInternalState): Promise<void> {
  if (state.cleanupDone) return;
  state.cleanupDone = true;

  // Emit supervisor:stop only when startup completed
  if (state.startupComplete) {
    emitSupervisorHook(state.hookRegistry, "supervisor:stop", {
      pid: process.pid,
      clean: state.shutdownClean ?? false,
      reason: state.shutdownReason ?? "unknown",
    });
  }

  // 1. Clear timers
  if (state.pruneTimer !== undefined) {
    clearInterval(state.pruneTimer);
    state.pruneTimer = undefined;
  }
  if (state.stuckScanTimer !== undefined) {
    clearInterval(state.stuckScanTimer);
    state.stuckScanTimer = undefined;
  }

  // 2. Stop ChannelGateway if it was started
  if (state.channelGateway !== undefined) {
    try { await state.channelGateway.stop(); } catch { /* ignore */ }
  }

  // 3. Final runtime-cache-state write (best-effort)
  if (state.runtimeCache !== undefined && state.runtimeFingerprint !== undefined && state.activeTurnRegistry !== undefined) {
    try {
      const stateObject = buildRuntimeCacheState(state);
      await writeRuntimeCacheState(state.runtimeCacheStatePath, stateObject);
    } catch (err) {
      logWarning(`Final runtime-cache-state write failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 4. Dispose cached runtimes
  if (state.runtimeCache !== undefined) {
    try { await state.runtimeCache.disposeAll(); } catch { /* ignore */ }
    state.runtimeCache = undefined;
  }

  // 4a. Dispose gateway-owned voice preprocessing worker
  if (state.gatewayLocalWhisper !== undefined) {
    try { await state.gatewayLocalWhisper.dispose(); } catch { /* ignore */ }
    state.gatewayLocalWhisper = undefined;
    state.gatewayLocalWhisperConfigKey = undefined;
  }

  // 5. Close session DB if opened
  if (state.sessionDb !== undefined) {
    try { state.sessionDb.close(); } catch { /* ignore */ }
  }

  // 6. Release identity locks in reverse acquisition order
  for (let i = state.acquiredIdentityLocks.length - 1; i >= 0; i--) {
    const { kind, hash } = state.acquiredIdentityLocks[i];
    try {
      const result = await releaseAdapterIdentityLock(state.stateHome, kind, hash, process.pid);
      if (!result.released && result.reason === "not_owner") {
        logWarning(`Cannot release ${kind} identity lock: not owner`);
      }
    } catch { /* ignore */ }
  }

  // 7. Remove PID, state, and adapter runtime state files (runtime-cache-state.json is KEPT)
  try { await removeGatewayPid(state.stateHome); } catch { /* ignore */ }
  try { await removeGatewayState(state.stateHome); } catch { /* ignore */ }
  try {
    const adapterRuntimeStatePath = join(state.stateHome.gatewayStatePath, "adapter-runtime-state.json");
    await unlink(adapterRuntimeStatePath);
  } catch { /* ignore */ }

  // 8. Release gateway lock ONLY if we acquired it
  if (state.gatewayLockAcquired) {
    try { await releaseGatewayLock(state.stateHome); } catch { /* ignore */ }
  }

  // 9. Remove signal handlers so they do not accumulate across tests or invocations
  if (state.onSigint !== undefined) {
    try { process.off("SIGINT", state.onSigint); } catch { /* ignore */ }
  }
  if (state.onSigterm !== undefined) {
    try { process.off("SIGTERM", state.onSigterm); } catch { /* ignore */ }
  }
}

export async function runGatewaySupervisor(options: GatewaySupervisorOptions): Promise<GatewayRunResult> {
  const startedAt = new Date().toISOString();
  const homeDir = resolveHomeDir(options.homeDir);
  const profileId = options.profileId ?? readActiveProfile({ homeDir })?.profileId ?? defaultProfileId();
  const profilePaths = resolveProfileStateHome({ homeDir, profileId });
  const globalStateRoot = join(homeDir, ".estacoda");
  const fasterWhisperDefaultHfHome = join(globalStateRoot, "cache", "huggingface");
  const trustStorePath = join(homeDir, ".estacoda", "trust.json");

  const loadConfig = () => loadRuntimeConfig({
    workspaceRoot: options.workspaceRoot,
    homeDir,
    profileId
  });

  const config = await loadConfig();
  const version = await getPackageVersion();
  const runtimeTokens = resolveTokens("standard", "dark", "kemetBlue");

  const runtimeFingerprint = computeRuntimeFingerprint(config, {
    profileId,
    workspaceRoot: options.workspaceRoot,
    homeDir,
    localSkillsRoot: profilePaths.skillsPath,
    trustStorePath,
    disabledToolsets: [],
    disableCronTools: false,
    approvalControllerPresent: false,
    explicitSecurityPolicyPresent: true,
    currentPlatform: process.platform,
    tokens: runtimeTokens,
  });

  const state = createInitialState(homeDir, profilePaths, options.factories?.exit ?? ((code: number) => process.exit(code)), startedAt);

  // 1. Clean-shutdown marker consumption (before stale cleanup)
  const cleanMarker = await readCleanShutdownMarker(profilePaths);
  if (cleanMarker !== undefined) {
    const trustworthy = await isCleanShutdownTrustworthy(profilePaths, cleanMarker);
    if (trustworthy) {
      logInfo(`Previous shutdown was clean (drain at ${cleanMarker.stoppedAt})`);
      await removeCleanShutdownMarker(profilePaths);
    } else {
      logInfo("Ignoring suspicious clean-shutdown marker (remaining PID/state/lock evidence)");
      await removeCleanShutdownMarker(profilePaths);
      const staleCleanup = await cleanupStaleGatewayState(profilePaths);
      if (staleCleanup.cleaned && staleCleanup.reason !== undefined) {
        logInfo(`Cleaned up stale state: ${staleCleanup.reason}`);
      }
    }
  } else {
    // 1a. Stale state cleanup (normal path when no marker)
    const staleCleanup = await cleanupStaleGatewayState(profilePaths);
    if (staleCleanup.cleaned && staleCleanup.reason !== undefined) {
      logInfo(`Cleaned up stale state: ${staleCleanup.reason}`);
    }
  }

  // 2. Gateway lock acquisition
  const lockResult = await acquireGatewayLock(profilePaths);
  if (!lockResult.acquired) {
    return {
      ok: false,
      output: "Gateway already running (lock held)",
      polls: 0,
      processed: 0,
    };
  }
  state.gatewayLockAcquired = true;

  // 3. PID / state write
  await writeGatewayPid(profilePaths, { pid: process.pid, startedAt, version, profileId });
  await writeGatewayState(profilePaths, { lifecycle: "running", startedAt, pid: process.pid, version, profileId });

  // 4. Signal handlers (installed EARLY)
  const shutdown = (signalName?: string) => {
    if (state.shutdownStarted) {
      if (state.drainCancelled) {
        logWarning("Forced exit already in progress");
        return;
      }
      logWarning("Forced exit on second signal");
      state.drainCancelled = true;
      state.shutdownClean = false;
      state.shutdownReason = "forced-signal";
      state.running = false;
      state.signalExit = cleanupSupervisorStartupResources(state).then(() => {
        state.exit(1);
      });
      return;
    }
    state.shutdownStarted = true;
    state.draining = true;
    logInfo(`Shutting down${signalName ? ` (${signalName})` : ""}...`);

    state.signalExit = (async () => {
      await writeGatewayState(profilePaths, { lifecycle: "draining", startedAt, pid: process.pid, version, profileId });
      logInfo("Draining, waiting for active turns...");

      emitSupervisorHook(state.hookRegistry, "supervisor:drain:start", {
        pid: process.pid,
        reason: signalName ?? "unknown",
        activeTurnCount: state.activeTurnRegistry?.stats().activeTurnCount ?? 0,
        timeoutMs: options.drainTimeoutMs ?? 30_000,
      });

      const drainStartMs = Date.now();
      const drainTimeoutMs = options.drainTimeoutMs ?? 30_000;
      const pollIntervalMs = 500;
      const deadline = Date.now() + drainTimeoutMs;
      let drained = false;

      while (Date.now() < deadline) {
        const hasPending = state.channelGateway?.hasPendingWork() ?? false;
        if (!hasPending) {
          drained = true;
          break;
        }
        await sleep(pollIntervalMs);
      }

      let abortedTurnCount = 0;
      if (drained) {
        logInfo("Drain complete");
        await writeCleanShutdownMarker(profilePaths, {
          stoppedAt: new Date().toISOString(),
          pid: process.pid,
          version,
          reason: "drain",
        });
        state.shutdownClean = true;
        state.shutdownReason = "drain";
      } else {
        logWarning("Drain timeout, aborting remaining turns");
        abortedTurnCount = state.activeTurnRegistry?.abortAllTurns("drain-timeout") ?? 0;
        logWarning(`Aborted ${abortedTurnCount} turn(s)`);
        // Brief grace for aborts to propagate before cleanup
        await sleep(500);
        state.shutdownClean = false;
        state.shutdownReason = "drain-timeout";
      }

      if (state.drainCancelled || state.cleanupDone) {
        return;
      }

      emitSupervisorHook(state.hookRegistry, "supervisor:drain:complete", {
        pid: process.pid,
        completed: drained,
        timedOut: !drained,
        abortedTurnCount,
        durationMs: Date.now() - drainStartMs,
      });

      state.running = false;
      await cleanupSupervisorStartupResources(state);
      state.exit(0);
    })();
  };

  state.onSigint = () => shutdown("SIGINT");
  state.onSigterm = () => shutdown("SIGTERM");
  process.on("SIGINT", state.onSigint);
  process.on("SIGTERM", state.onSigterm);

  const createGatewayRuntime = async (
    latestConfig: LoadedRuntimeConfig,
    db: SQLiteSessionDB,
    hd: string,
    tsp: string,
    input: {
      sessionId: string;
      securityPolicy: SecurityPolicy;
      metadata?: Record<string, unknown>;
    }
  ): Promise<Runtime> => {
    let effectiveModel = latestConfig.model;
    let effectivePrimaryRoute = latestConfig.primaryModelRoute;

    const storedOverride = await db.getSessionModelOverride(input.sessionId).catch(() => undefined);
    const effectiveOverride = await resolveEffectiveSessionModelOverride(storedOverride, {
      config: latestConfig.config,
      providerRegistry: latestConfig.providerRegistry,
      homeDir: hd
    });
    if (effectiveOverride?.ok === true) {
      effectiveModel = effectiveOverride.route.profile;
      effectivePrimaryRoute = effectiveOverride.route;
    } else if (effectiveOverride?.ok === false) {
      logWarning(`Gateway session model override ignored for ${input.sessionId}: ${effectiveOverride.message}`);
    }

    return createRuntime({
      tokens: runtimeTokens,
      model: effectiveModel,
      primaryModelRoute: effectivePrimaryRoute,
      modelFallbackRoutes: latestConfig.modelFallbackRoutes,
      workspaceRoot: options.workspaceRoot,
      homeDir: hd,
      sessionId: input.sessionId,
      profileId,
      sessionDb: db,
      closeSessionDbOnDispose: false,
      sessionMetadata: input.metadata,
      externalSkillRoots: latestConfig.skills.externalDirs,
      skillAutonomy: latestConfig.skills.autonomy,
      skillConfig: latestConfig.skills.config,
      ui: latestConfig.ui,
      agentProfile: latestConfig.profile,
      providerRegistry: latestConfig.providerRegistry,
      providerConfigs: latestConfig.config.providers,
      auxiliaryModels: latestConfig.auxiliaryModels,
      compression: latestConfig.compression,
      externalMemory: latestConfig.externalMemory,
      mcpServers: latestConfig.mcp.servers,
      securityPolicy: input.securityPolicy,
      browser: latestConfig.browser,
      imageGen: latestConfig.imageGen,
      tts: latestConfig.tts,
      stt: latestConfig.stt,
      telegramReady: latestConfig.channels.telegram.ready,
      enableWebNetwork: latestConfig.web.enableNetwork,
      webMaxContentChars: latestConfig.web.maxContentChars,
      webConfig: {
        backend: latestConfig.web.backend,
        searchBackend: latestConfig.web.searchBackend,
        extractBackend: latestConfig.web.extractBackend,
        crawlBackend: latestConfig.web.crawlBackend
      },
      securityConfig: {
        allowPrivateUrls: latestConfig.security.allowPrivateUrls,
        websiteBlocklist: latestConfig.security.websiteBlocklist
      },
      trustStorePath: tsp,
    });
  };

  try {
    // 5. Adapter capability scan
    const registry = new AdapterRegistry(config.channels);
    const configured = registry.configured();

    if (configured.length === 0) {
      logInfo("Adapters: none");
      logInfo("Mode: cron-only");
    }

    // 6. Identity derivation + lock acquisition per adapter
    for (const cap of configured) {
      let hash: string | undefined;
      switch (cap.kind) {
        case "telegram":
          hash = await deriveTelegramIdentityHash(profilePaths, config.channels.telegram);
          break;
        case "discord":
          hash = await deriveDiscordIdentityHash(profilePaths, config.channels.discord);
          break;
        case "email":
          hash = await deriveEmailIdentityHash(profilePaths, config.channels.email);
          break;
        case "whatsapp":
          hash = await deriveWhatsAppIdentityHash(profilePaths, config.channels.whatsapp);
          break;
        default:
          break;
      }

      if (hash === undefined) {
        await cleanupSupervisorStartupResources(state);
        return {
          ok: false,
          output: `${cap.kind}: configured but no derivable identity. Check config.`,
          polls: 0,
          processed: 0,
        };
      }

      const identityResult = await acquireAdapterIdentityLock(profilePaths, cap.kind, hash);
      if (!identityResult.acquired) {
        await cleanupSupervisorStartupResources(state);
        return {
          ok: false,
          output: `${cap.kind} identity already locked by PID ${identityResult.holderPid ?? "unknown"}`,
          polls: 0,
          processed: 0,
        };
      }

      state.acquiredIdentityLocks.push({ kind: cap.kind, hash });
    }

    // 7. Shared infrastructure
    const sessionDbPath = join(globalStateRoot, "sessions.sqlite");
    const mediaRoot = profilePaths.channelMediaPath;
    const approvalStorePath = join(profilePaths.gatewayStatePath, "channel-approvals.json");
    const sessionContextPath = join(profilePaths.gatewayStatePath, "channel-sessions.json");
    await mkdir(dirname(sessionDbPath), { recursive: true });
    const sessionDb = await createSQLiteSessionDB({ path: sessionDbPath });
    state.sessionDb = sessionDb;
    const gatewayApprovalQueue = new GatewayApprovalQueue({
      db: sessionDb.db,
      controller: new WorkspaceApprovalController()
    });
    state.gatewayApprovalQueue = gatewayApprovalQueue;

    const activeTurnRegistry = new ActiveTurnRegistry({
      stuckThresholdMs: 300_000,
      maxStuckChecks: 3,
      busyAckCooldownMs: 30_000,
      historySize: 50,
    });
    state.activeTurnRegistry = activeTurnRegistry;

    const hookRegistry = new HookRegistry({ logWarning });
    state.hookRegistry = hookRegistry;

    const runtimeCache = new RuntimeCache({
      createRuntime: (input) =>
        createGatewayRuntime(config, sessionDb, homeDir, trustStorePath, input),
      maxEntries: 50,
      idleTtlMs: 1_800_000,
      logWarning,
      hookRegistry,
    });
    state.runtimeCache = runtimeCache;
    state.runtimeFingerprint = runtimeFingerprint;
    const mainRoute: ResolvedModelRoute = config.primaryModelRoute ?? {
      provider: config.model.provider,
      id: config.model.id,
      profile: config.model
    };
    const hygieneEnabled = config.compression.enabled === true;
    const providerModels = !hygieneEnabled || config.model.provider === "unconfigured"
      ? []
      : await config.providerRegistry.listModels();
    const compressionRoute = !hygieneEnabled || config.model.provider === "unconfigured"
      ? undefined
      : resolveAuxiliaryModelRoute("compression", config.auxiliaryModels, {
        mainRoute,
        providerRegistry: config.providerRegistry,
        providerModels
      });
    const hygieneContextWindowTokens = config.compression.summaryModelContextLength ?? config.model.contextWindowTokens ?? 128_000;
    const sessionHygieneService = new SessionHygieneService({
      sessionDb,
      profileId,
      compressionConfig: config.compression,
      contextWindowTokens: hygieneContextWindowTokens,
      compressionService: new SessionCompressionService({
        sessionDb,
        config: {
          ...config.compression,
          threshold: GATEWAY_HYGIENE_THRESHOLD,
          summaryModelContextLength: hygieneContextWindowTokens
        },
        route: compressionRoute,
        mainRoute,
        providerExecutor: new ProviderExecutor({
          registry: config.providerRegistry
        })
      }),
      logWarning
    });

    const cronStore = new CronStore({
      path: join(profilePaths.cronPath, "jobs.json"),
      outputRoot: join(profilePaths.cronPath, "output"),
    });
    const cronExecutionStore = new CronExecutionStore({ db: sessionDb.db });
    const cronJobLock = createFileCronJobLock({
      lockDir: join(profilePaths.cronPath, "locks"),
      staleTimeoutMs: 600_000,
    });

    const approvalStore = new ChannelApprovalStore({ path: approvalStorePath });
    const handoffStore = new FileHandoffStore({ path: join(profilePaths.gatewayStatePath, "handoff-codes.json") });
    const surfacePointerStore = new FileSurfacePointerStore({ path: join(profilePaths.gatewayStatePath, "surface-pointers.json") });
    const voiceStateManager = new VoiceStateManager({ path: join(profilePaths.gatewayStatePath, "voice-mode.json") });

    // 8. Adapter instantiation
    const adapters: ChannelAdapter[] = [];
    const router = options.factories?.createDeliveryRouter
      ? options.factories.createDeliveryRouter({
          homeDir,
          deliveryRoot: join(profilePaths.gatewayStatePath, "delivery"),
          deliveryErrorLogPath: join(profilePaths.gatewayStatePath, "logs", "delivery-errors.jsonl"),
          hookRegistry,
        })
      : new DeliveryRouter({
          homeDir,
          deliveryRoot: join(profilePaths.gatewayStatePath, "delivery"),
          deliveryErrorLogPath: join(profilePaths.gatewayStatePath, "logs", "delivery-errors.jsonl"),
          hookRegistry,
        });

    for (const cap of configured) {
      let adapter: ChannelAdapter;
      switch (cap.kind) {
        case "telegram": {
          const telegram = config.channels.telegram;
          const botTokenEnv = telegram.botTokenEnv;
          const botToken = botTokenEnv === undefined ? undefined : process.env[botTokenEnv];
          adapter = options.factories?.createTelegramAdapter
            ? options.factories.createTelegramAdapter({
                botToken: botToken!,
                defaultChatId: telegram.defaultChatId,
                pollTimeoutSeconds: telegram.pollTimeoutSeconds,
                maxAttachmentBytes: telegram.maxAttachmentBytes,
                mediaRoot,
                voiceTempRoot: join(profilePaths.tempPath, "audio", "telegram"),
                activityLabelsLocale: config.ui.activityLabels,
                fetch: options.telegramFetch,
              })
            : new TelegramAdapter({
                botToken: botToken!,
                defaultChatId: telegram.defaultChatId,
                pollTimeoutSeconds: telegram.pollTimeoutSeconds,
                maxAttachmentBytes: telegram.maxAttachmentBytes,
                mediaRoot,
                voiceTempRoot: join(profilePaths.tempPath, "audio", "telegram"),
                activityLabelsLocale: config.ui.activityLabels,
                fetch: options.telegramFetch,
              });
          router.registerAdapter(adapter);
          adapters.push(adapter);
          break;
        }
        case "discord": {
          const discord = config.channels.discord;
          const botTokenEnv = discord.botTokenEnv;
          const botToken = botTokenEnv === undefined ? undefined : process.env[botTokenEnv];
          adapter = options.factories?.createDiscordAdapter
            ? options.factories.createDiscordAdapter({
                botToken: botToken!,
                allowedUsers: discord.allowedUsers,
                allowedGuilds: discord.allowedGuilds,
                allowedChannels: discord.allowedChannels,
                freeResponseChannels: discord.freeResponseChannels,
                mediaRoot,
                voiceChannel: discord.voiceChannel,
                voiceTempRoot: join(profilePaths.tempPath, "audio"),
              })
            : new DiscordAdapter({
                botToken: botToken!,
                allowedUsers: discord.allowedUsers,
                allowedGuilds: discord.allowedGuilds,
                allowedChannels: discord.allowedChannels,
                freeResponseChannels: discord.freeResponseChannels,
                mediaRoot,
                voiceChannel: discord.voiceChannel,
                voiceTempRoot: join(profilePaths.tempPath, "audio"),
              });
          router.registerAdapter(adapter);
          adapters.push(adapter);
          break;
        }
        case "email": {
          const email = config.channels.email;
          const password = email.passwordEnv ? process.env[email.passwordEnv] : undefined;
          adapter = options.factories?.createEmailAdapter
            ? options.factories.createEmailAdapter({
                imapHost: email.imapHost ?? "imap.gmail.com",
                imapPort: email.imapPort ?? 993,
                smtpHost: email.smtpHost ?? "smtp.gmail.com",
                smtpPort: email.smtpPort ?? 465,
                username: email.username!,
                password: password!,
                ownAddress: email.ownAddress ?? email.username!,
                homeAddress: email.homeAddress,
                allowedSenders: email.allowedSenders,
                allowAllUsers: email.allowAllUsers,
                pollIntervalSeconds: email.pollIntervalSeconds ?? 60,
                mediaRoot,
                markAllSeenOnConnect: true,
              })
            : new EmailAdapter({
                imapHost: email.imapHost ?? "imap.gmail.com",
                imapPort: email.imapPort ?? 993,
                smtpHost: email.smtpHost ?? "smtp.gmail.com",
                smtpPort: email.smtpPort ?? 465,
                username: email.username!,
                password: password!,
                ownAddress: email.ownAddress ?? email.username!,
                homeAddress: email.homeAddress,
                allowedSenders: email.allowedSenders,
                allowAllUsers: email.allowAllUsers,
                pollIntervalSeconds: email.pollIntervalSeconds ?? 60,
                mediaRoot,
                markAllSeenOnConnect: true,
              });
          router.registerAdapter(adapter);
          adapters.push(adapter);
          break;
        }
        case "whatsapp": {
          const whatsapp = config.channels.whatsapp;
          const authDir = whatsapp.authDir ?? join(profilePaths.gatewayStatePath, "whatsapp-auth");
          const bridgeStatePath = join(authDir, "bridge-state.json");
          const bridgeLogPath = join(profilePaths.logsPath, "whatsapp-bridge.log");
          const bridgeInstallLogPath = join(profilePaths.logsPath, "whatsapp-bridge-install.log");
          const bridgePidPath = join(authDir, "bridge.pid");
          const bridgeLockPath = join(authDir, "whatsapp-session.lock");
          adapter = options.factories?.createWhatsAppAdapter
            ? options.factories.createWhatsAppAdapter({
                authDir,
                allowedUsers: whatsapp.allowedUsers,
                experimental: whatsapp.experimental,
                aliasStorePath: defaultWhatsAppAliasStorePath({ homeDir, profileId }),
                mode: whatsapp.mode,
                replyPrefix: whatsapp.replyPrefix,
                bridgeStatePath,
                bridgeLogPath,
                bridgeInstallLogPath,
                bridgePidPath,
                bridgeLockPath,
                mediaRoot,
                voiceTempRoot: join(profilePaths.tempPath, "audio", "whatsapp"),
                allowedMediaRoots: [
                  options.workspaceRoot,
                  profilePaths.channelMediaPath,
                  profilePaths.audioCachePath,
                  profilePaths.imageCachePath,
                  profilePaths.tempPath,
                ],
              })
            : new WhatsAppAdapter({
                authDir,
                allowedUsers: whatsapp.allowedUsers,
                experimental: whatsapp.experimental,
                aliasStorePath: defaultWhatsAppAliasStorePath({ homeDir, profileId }),
                mode: whatsapp.mode,
                replyPrefix: whatsapp.replyPrefix,
                bridgeStatePath,
                bridgeLogPath,
                bridgeInstallLogPath,
                bridgePidPath,
                bridgeLockPath,
                mediaRoot,
                voiceTempRoot: join(profilePaths.tempPath, "audio", "whatsapp"),
                allowedMediaRoots: [
                  options.workspaceRoot,
                  profilePaths.channelMediaPath,
                  profilePaths.audioCachePath,
                  profilePaths.imageCachePath,
                  profilePaths.tempPath,
                ],
              });
          router.registerAdapter(adapter);
          adapters.push(adapter);
          break;
        }
        default:
          break;
      }
    }

    // 9. Call setCommands on raw Telegram adapters before wrapping
    for (const adapter of adapters) {
      if (adapter.kind === "telegram") {
        try {
          await (adapter as TelegramAdapter).setCommands(telegramGatewayCommands());
        } catch (err) {
          logWarning(`Telegram setCommands failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    // 10. Wrap adapters in resilience supervisors
    let lastRuntimeStateWrite = Date.now();
    const wrappers = adapters.map((adapter) => {
      return new AdapterResilienceSupervisor(adapter, undefined, () => {
        writeAdapterRuntimeState(profilePaths, {
          supervisorPid: process.pid,
          supervisorStartedAt: startedAt,
          updatedAt: new Date().toISOString(),
          adapters: wrappers.map((w) => w.getState()),
        }).catch(() => {});
      }, hookRegistry);
    });

    async function writeRuntimeState(): Promise<void> {
      lastRuntimeStateWrite = Date.now();
      await writeAdapterRuntimeState(profilePaths, {
        supervisorPid: process.pid,
        supervisorStartedAt: startedAt,
        updatedAt: new Date().toISOString(),
        adapters: wrappers.map((w) => w.getState()),
      });
    }

    // 11. Load workspace trust and build per-channel auth policies
    const telegram = config.channels.telegram;
    const discord = config.channels.discord;
    const email = config.channels.email;
    const whatsapp = config.channels.whatsapp;

    const trustStore = new WorkspaceTrustStore({ path: trustStorePath });
    const workspaceTrusted = await trustStore.isTrusted(options.workspaceRoot);

    const authPolicies: ChannelAuthPolicies = {};
    if (telegram.enabled === true) {
      authPolicies.telegram = {
        allowedUserIds: telegram.allowedUserIds ?? [],
        allowedChatIds: telegram.allowedChatIds ?? [],
        deniedMessage: (telegram.allowedUserIds ?? []).length + (telegram.allowedChatIds ?? []).length > 0
          ? "This EstaCoda Telegram bot is not paired with this account. Ask the owner to add your Telegram user ID or chat ID."
          : "This EstaCoda Telegram bot is locked. Add your Telegram user ID or chat ID to the allowlist before chatting with it."
      };
    }
    if (discord.enabled === true) {
      authPolicies.discord = {
        allowedUserIds: discord.allowedUsers ?? [],
        allowedGuildIds: discord.allowedGuilds ?? [],
        deniedMessage: (discord.allowedUsers ?? []).length + (discord.allowedGuilds ?? []).length > 0
          ? "This EstaCoda Discord gateway is not paired with this account. Ask the owner to add your Discord user ID or guild ID."
          : "This EstaCoda Discord gateway is locked. Add your Discord user ID or guild ID to the allowlist before chatting with it."
      };
    }
    if (email.enabled === true) {
      authPolicies.email = {
        allowedSenders: email.allowedSenders ?? [],
        deniedMessage: (email.allowedSenders ?? []).length > 0
          ? "This EstaCoda email gateway is not paired with this account. Ask the owner to add your sender address."
          : "This EstaCoda email gateway is locked. Add your sender address to the allowlist before emailing it."
      };
    }
    if (whatsapp.enabled === true) {
      authPolicies.whatsapp = {
        allowedNumbers: normalizeWhatsAppAllowlist(whatsapp.allowedUsers),
        allowedGroups: normalizeWhatsAppGroupAllowlist(whatsapp.allowedGroups),
        dmPolicy: whatsapp.dmPolicy ?? "allowlist",
        groupPolicy: whatsapp.groupPolicy ?? "disabled",
        requireMention: whatsapp.requireMention,
        mentionPatterns: whatsapp.mentionPatterns,
        freeResponseChats: normalizeWhatsAppGroupAllowlist(whatsapp.freeResponseChats),
        deniedMessage: (whatsapp.allowedUsers ?? []).length > 0
          ? "This EstaCoda WhatsApp gateway is not paired with this account. Ask the owner to add your phone number."
          : "This EstaCoda WhatsApp gateway is locked. Add your phone number to the allowlist before messaging it."
      };
    }

    const sessionPolicy = {
      groupSessionsPerUser: telegram.groupSessionsPerUser ?? true,
      threadSessionsPerUser: telegram.threadSessionsPerUser ?? false,
      resetPolicy: telegram.sessionResetPolicy ?? "none",
      idleResetMinutes: telegram.sessionIdleResetMinutes,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    };
    const gatewaySecurityAssessor = await buildGatewaySecurityAssessorConfig(config);
    const voiceAudit = createVoiceTranscriptionAudit({ profilePaths, hookRegistry, logWarning });
    const gatewayLocalWhisperFor = async (stt: LoadedRuntimeConfig["stt"]) => {
      if (!isFasterWhisperConfig(stt)) {
        if (state.gatewayLocalWhisper !== undefined) {
          await state.gatewayLocalWhisper.dispose();
          state.gatewayLocalWhisper = undefined;
          state.gatewayLocalWhisperConfigKey = undefined;
        }
        return undefined;
      }

      const configKey = gatewayFasterWhisperWorkerConfigKey(stt, fasterWhisperDefaultHfHome);
      if (state.gatewayLocalWhisper === undefined || state.gatewayLocalWhisperConfigKey !== configKey) {
        await state.gatewayLocalWhisper?.dispose();
        state.gatewayLocalWhisper = new ManagedFasterWhisperWorker({
          stateRoot: globalStateRoot,
          stt,
          defaultHfHome: fasterWhisperDefaultHfHome
        });
        state.gatewayLocalWhisperConfigKey = configKey;
      }
      return state.gatewayLocalWhisper;
    };
    const pairChannelMessage = async (message: ChannelMessage): Promise<string | undefined> => {
      if (message.channel === "telegram") {
        const result = await consumeTelegramPairingCode({
          workspaceRoot: options.workspaceRoot,
          homeDir,
          code: message.text,
          userId: message.sender.id,
          chatId: message.sessionKey.chatId,
        });
        if (!result.paired) return undefined;
        return "Telegram paired. This chat can now talk to EstaCoda.";
      }

      if (message.channel === "whatsapp") {
        const result = await consumeWhatsAppUserAuthCode({
          storePath: defaultWhatsAppUserAuthStorePath({ homeDir, profileId }),
          senderId: message.sender.id,
          code: message.text
        });
        if (!result.paired) return undefined;
        await addWhatsAppAllowedUser({
          workspaceRoot: options.workspaceRoot,
          homeDir,
          profileId,
          userId: result.normalizedSenderId
        });
        return "WhatsApp paired. This account can now talk to EstaCoda.";
      }

      return undefined;
    };

    const gateway = options.factories?.createChannelGateway
      ? options.factories.createChannelGateway({
          adapters: wrappers,
          deliveryRouter: router,
          sessionStore: new PersistentChannelSessionStore({ path: sessionContextPath, policy: sessionPolicy, surfacePointerStore }),
          approvalStore,
          authPolicy: authPolicies,
          trustedWorkspace: workspaceTrusted,
          sessionPolicy,
          handoffStore,
          surfacePointerStore,
          preprocessMessage: async (message) => {
            const latestConfig = await loadConfig();
            return injectVoiceTranscripts(message, {
              stt: latestConfig.stt,
              allowedRoots: [profilePaths.channelMediaPath, profilePaths.audioCachePath, join(profilePaths.tempPath, "audio")],
              fasterWhisperDefaultHfHome,
              localWhisper: await gatewayLocalWhisperFor(latestConfig.stt),
              voiceStateManager,
              audit: voiceAudit
            });
          },
          pair: pairChannelMessage,
          securityMode: config.security.approvalMode,
          securityAssessor: gatewaySecurityAssessor,
          activeTurnRegistry,
          runtimeCache,
          runtimeFingerprint,
          isDraining: () => state.draining,
          busyPolicyResolver: (channelKind) => {
            const channelConfig = config.channels[channelKind as keyof typeof config.channels] as
              | { busyPolicy?: ChannelBusyPolicy; queueDepth?: number }
              | undefined;
            return {
              busyPolicy: channelConfig?.busyPolicy ?? "reject",
              queueDepth: channelConfig?.queueDepth ?? 3,
            };
          },
          runtimeForSession: async ({ sessionId, securityPolicy, metadata }) => {
            const latestConfig = await loadConfig();
            return createGatewayRuntime(latestConfig, sessionDb, homeDir, trustStorePath, {
              sessionId,
              securityPolicy,
              metadata,
            });
          },
          modelSwitchContext: async () => {
            const latestConfig = await loadConfig();
            return {
              config: latestConfig.config,
              providerRegistry: latestConfig.providerRegistry,
              homeDir
            };
          },
          sessionHygieneService,
          hookRegistry,
          logWarning,
          profileId,
          approvalQueue: gatewayApprovalQueue,
          voiceStateManager,
          voiceAutoTtsDefault: config.voice.autoTts,
          autoTtsConfig: async () => {
            const latestConfig = await loadConfig();
            return { tts: latestConfig.tts, voice: latestConfig.voice };
          },
          autoTtsTempRoot: join(profilePaths.tempPath, "audio"),
        })
      : new ChannelGateway({
          adapters: wrappers,
          deliveryRouter: router,
          sessionStore: new PersistentChannelSessionStore({ path: sessionContextPath, policy: sessionPolicy, surfacePointerStore }),
          approvalStore,
          authPolicy: authPolicies,
          trustedWorkspace: workspaceTrusted,
          sessionPolicy,
          handoffStore,
          surfacePointerStore,
          preprocessMessage: async (message) => {
            const latestConfig = await loadConfig();
            return injectVoiceTranscripts(message, {
              stt: latestConfig.stt,
              allowedRoots: [profilePaths.channelMediaPath, profilePaths.audioCachePath, join(profilePaths.tempPath, "audio")],
              fasterWhisperDefaultHfHome,
              localWhisper: await gatewayLocalWhisperFor(latestConfig.stt),
              voiceStateManager,
              audit: voiceAudit
            });
          },
          pair: pairChannelMessage,
          securityMode: config.security.approvalMode,
          securityAssessor: gatewaySecurityAssessor,
          activeTurnRegistry,
          runtimeCache,
          runtimeFingerprint,
          isDraining: () => state.draining,
          busyPolicyResolver: (channelKind) => {
            const channelConfig = config.channels[channelKind as keyof typeof config.channels] as
              | { busyPolicy?: ChannelBusyPolicy; queueDepth?: number }
              | undefined;
            return {
              busyPolicy: channelConfig?.busyPolicy ?? "reject",
              queueDepth: channelConfig?.queueDepth ?? 3,
            };
          },
          runtimeForSession: async ({ sessionId, securityPolicy, metadata }) => {
            const latestConfig = await loadConfig();
            return createGatewayRuntime(latestConfig, sessionDb, homeDir, trustStorePath, {
              sessionId,
              securityPolicy,
              metadata,
            });
          },
          modelSwitchContext: async () => {
            const latestConfig = await loadConfig();
            return {
              config: latestConfig.config,
              providerRegistry: latestConfig.providerRegistry,
              homeDir
            };
          },
          sessionHygieneService,
          hookRegistry,
          logWarning,
          profileId,
          approvalQueue: gatewayApprovalQueue,
          voiceStateManager,
          voiceAutoTtsDefault: config.voice.autoTts,
          autoTtsConfig: async () => {
            const latestConfig = await loadConfig();
            return { tts: latestConfig.tts, voice: latestConfig.voice };
          },
          autoTtsTempRoot: join(profilePaths.tempPath, "audio"),
        });

    state.channelGateway = gateway;

    // 12. Start adapters through ChannelGateway (wrappers swallow errors)
    await gateway.start();
    state.startupComplete = true;

    if (configured.length > 0) {
      logInfo(`Started ${configured.length} adapter(s): ${configured.map((c) => c.kind).join(", ")}`);
    }

    emitSupervisorHook(state.hookRegistry, "supervisor:start", {
      pid: process.pid,
      startedAt,
      version,
      adapterKinds: configured.map((c) => c.kind),
      mode: configured.length === 0 ? "cron-only" : "adapters",
    });

    // 12a. Start background timers
    const PRUNE_INTERVAL_MS = 60_000;
    const STUCK_SCAN_INTERVAL_MS = 60_000;
    const RUNTIME_CACHE_STATE_HEARTBEAT_MS = 60_000;

    const pruneGuard = { running: false };
    state.pruneTimer = setInterval(() => {
      runPrune(state, pruneGuard).catch((err) => {
        logWarning(`Prune timer error: ${err instanceof Error ? err.message : String(err)}`);
      });
    }, PRUNE_INTERVAL_MS);

    const stuckScanGuard = { running: false };
    state.stuckScanTimer = setInterval(() => {
      runStuckScanGuarded(state, stuckScanGuard).catch((err) => {
        logWarning(`Stuck scan timer error: ${err instanceof Error ? err.message : String(err)}`);
      });
    }, STUCK_SCAN_INTERVAL_MS);

    const runtimeCacheStateWriteGuard = { running: false };
    const gatewayApprovalExpiryGuard = { running: false };
    const gatewayApprovalResolutionGuard = { running: false };

    // 13. Main loop
    let polls = 0;
    let processed = 0;
    const pollIntervalMs = 1000;
    const doSleep = options.factories?.sleep ?? sleep;
    const doTickCron = options.factories?.tickCron ?? tickCron;

    do {
      if (!state.draining) {
        await doTickCron({
          store: cronStore,
          executionStore: cronExecutionStore,
          jobLock: cronJobLock,
          hookRegistry,
          runner: createRuntimeCronRunner({
          deliver: async (job, content) => {
            const originKey = job.origin?.channel === "telegram" && job.origin.chatId !== undefined
              ? {
                  platform: "telegram" as const,
                  chatId: job.origin.chatId,
                  userId: job.origin.userId,
                  threadId: job.origin.threadId,
                }
              : undefined;
            const fallbackSessionKey = originKey ?? {
              platform: "telegram" as const,
              chatId: job.origin?.chatId ?? "cron",
            };
            const target = job.delivery ?? "local";
            const targets = router.parseTarget(target, fallbackSessionKey);
            const results = await router.deliverText(targets, content);
            return {
              success: Array.from(results.values()).some((r) => r.success),
              perTarget: results,
            };
          },
          disposeRuntime: true,
          workspaceRoot: options.workspaceRoot,
          runtimeFactory: async (job) => {
            const latestConfig = await loadConfig();
            return createRuntime(buildGatewayCronRuntimeOptions({
              latestConfig,
              workspaceRoot: options.workspaceRoot,
              homeDir,
              profileId,
              sessionDb,
              sessionId: `cron-${job.id}-${randomUUID()}`,
            }));
          },
        }),
      });
      }

      if (shouldRunSupervisorTicks(state)) {
        for (const wrapper of wrappers) {
          await wrapper.tick();
        }
      }

      await runGatewayApprovalResolutionTick(gateway, gatewayApprovalResolutionGuard, state);

      if (shouldRunSupervisorTicks(state)) {
        for (const wrapper of wrappers) {
          try {
            const count = await wrapper.poll();
            processed += count;
          } catch (err) {
            logWarning(`Adapter ${wrapper.kind} poll error: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }

      const now = Date.now();
      if (now - lastRuntimeStateWrite >= RUNTIME_STATE_HEARTBEAT_MS) {
        await writeRuntimeState();
      }

      if (now - state.lastRuntimeCacheStateWrite >= RUNTIME_CACHE_STATE_HEARTBEAT_MS) {
        await runRuntimeCacheStateHeartbeat(state, runtimeCacheStateWriteGuard);
      }

      if (now - state.lastGatewayApprovalExpiryRun >= RUNTIME_CACHE_STATE_HEARTBEAT_MS) {
        await runGatewayApprovalExpiry(state, gatewayApprovalExpiryGuard);
      }

      polls += 1;

      if (options.once === true) {
        state.running = false;
        break;
      }

      if (state.running) {
        await doSleep(pollIntervalMs);
      }
    } while (state.running);

    if (state.signalExit !== undefined) {
      await state.signalExit;
      return {
        ok: state.drainCancelled !== true,
        output: state.drainCancelled === true ? "Gateway forced exit" : "Gateway stopped after signal",
        polls,
        processed,
      };
    }

    state.shutdownClean = true;
    state.shutdownReason = "once";

    // Write final runtime state before shutdown
    await writeRuntimeState();

    // 14. Shutdown
    await cleanupSupervisorStartupResources(state);

    return {
      ok: true,
      output: `Gateway stopped\nMessages processed: ${processed}`,
      polls,
      processed,
    };
  } catch (error) {
    const { errorClass, errorMessage } = sanitizeHookError(error);
    const phase = state.startupComplete ? "main-loop" : "startup";
    emitSupervisorHook(state.hookRegistry, "supervisor:crash", {
      pid: process.pid,
      phase,
      errorClass,
      errorMessage,
    });

    if (state.startupComplete) {
      state.shutdownClean = false;
      state.shutdownReason = "crash";
    }

    const message = error instanceof Error ? error.message : String(error);
    await cleanupSupervisorStartupResources(state);
    return {
      ok: false,
      output: `Startup failed: ${message}`,
      polls: 0,
      processed: 0,
    };
  }
}

const STUCK_EVENT_WINDOW_MS = 600_000;
const STUCK_EVENTS_BEFORE_SUSPEND = 3;

export async function runPrune(state: SupervisorInternalState, guard: { running: boolean }): Promise<void> {
  if (!shouldRunSupervisorTicks(state)) return;
  if (guard.running) {
    logDebug("Prune skipped: previous run still active");
    return;
  }
  guard.running = true;
  try {
    await state.runtimeCache!.prune();
  } catch (err) {
    logWarning(`Runtime cache prune error: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    guard.running = false;
  }
}

export async function runStuckScanGuarded(state: SupervisorInternalState, guard: { running: boolean }): Promise<void> {
  if (!shouldRunSupervisorTicks(state)) return;
  if (guard.running) {
    logDebug("Stuck scan skipped: previous run still active");
    return;
  }
  guard.running = true;
  try {
    await runStuckScan(state);
  } catch (err) {
    logWarning(`Stuck scan error: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    guard.running = false;
  }
}

export async function runStuckScan(state: SupervisorInternalState): Promise<void> {
  if (!shouldRunSupervisorTicks(state)) return;
  if (state.activeTurnRegistry === undefined || state.runtimeCache === undefined) return;

  const now = Date.now();
  const stuck = state.activeTurnRegistry.listStuckTurns();

  for (const turn of stuck) {
    // 1. One abort per stuck turn
    if (!state.stuckAbortSent.has(turn.turnId)) {
      state.activeTurnRegistry.abortTurn(turn.key, "stuck-loop");
      state.stuckAbortSent.add(turn.turnId);
    }

    // 2. Record stuck event only once per unique turnId
    const sessionId = turn.metadata?.sessionId as string | undefined;
    if (sessionId !== undefined && !state.stuckEventRecorded.has(turn.turnId)) {
      state.stuckEventRecorded.add(turn.turnId);
      const events = state.stuckEventsBySession.get(sessionId) ?? [];
      const pruned = events.filter((t) => now - t < STUCK_EVENT_WINDOW_MS);
      pruned.push(now);
      state.stuckEventsBySession.set(sessionId, pruned);

      // 3. Suspend if threshold reached
      if (pruned.length >= STUCK_EVENTS_BEFORE_SUSPEND) {
        state.runtimeCache.suspend(sessionId, "stuck-loop").catch((err) => {
          logWarning(`Suspend failed for ${sessionId}: ${err instanceof Error ? err.message : String(err)}`);
        });
      }
    }
  }

  // 4. Cleanup old session entries
  for (const [sessionId, events] of state.stuckEventsBySession) {
    const pruned = events.filter((t) => now - t < STUCK_EVENT_WINDOW_MS);
    if (pruned.length === 0) {
      state.stuckEventsBySession.delete(sessionId);
    } else {
      state.stuckEventsBySession.set(sessionId, pruned);
    }
  }

  // 5. Cleanup old abort-sent / event-recorded entries for ended turns
  const activeTurnIds = new Set(stuck.map((t) => t.turnId));
  for (const turnId of Array.from(state.stuckAbortSent)) {
    if (!activeTurnIds.has(turnId)) {
      state.stuckAbortSent.delete(turnId);
      state.stuckEventRecorded.delete(turnId);
    }
  }
}

export async function runRuntimeCacheStateHeartbeat(state: SupervisorInternalState, guard: { running: boolean }): Promise<void> {
  if (!shouldRunSupervisorTicks(state)) return;
  if (guard.running) {
    logDebug("Runtime cache state write skipped: previous write still active");
    return;
  }
  guard.running = true;
  try {
    const stateObject = buildRuntimeCacheState(state);
    await writeRuntimeCacheState(state.runtimeCacheStatePath, stateObject);
    state.lastRuntimeCacheStateWrite = Date.now();
  } catch (err) {
    logWarning(`Runtime cache state write error: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    guard.running = false;
  }
}

export async function runGatewayApprovalExpiry(state: SupervisorInternalState, guard: { running: boolean }): Promise<void> {
  if (!shouldRunSupervisorTicks(state)) return;
  if (guard.running) {
    logDebug("Gateway approval expiry skipped: previous run still active");
    return;
  }
  guard.running = true;
  try {
    await state.gatewayApprovalQueue?.expireStaleApprovals();
    state.lastGatewayApprovalExpiryRun = Date.now();
  } catch (err) {
    logWarning(`Gateway approval expiry error: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    guard.running = false;
  }
}

export async function runGatewayApprovalResolutionTick(
  gateway: { tickApprovalResolutions?: () => Promise<void> },
  guard: { running: boolean },
  state?: SupervisorInternalState
): Promise<void> {
  if (state !== undefined && !shouldRunSupervisorTicks(state)) return;
  if (guard.running) {
    logDebug("Gateway approval resolution tick skipped: previous run still active");
    return;
  }
  if (typeof gateway.tickApprovalResolutions !== "function") {
    return;
  }
  guard.running = true;
  try {
    await gateway.tickApprovalResolutions();
  } catch (err) {
    logWarning(`Gateway approval resolution tick error: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    guard.running = false;
  }
}

function shouldRunSupervisorTicks(state: SupervisorInternalState): boolean {
  return state.running && !state.draining && !state.cleanupDone;
}

export function buildRuntimeCacheState(state: SupervisorInternalState): RuntimeCacheState {
  const now = new Date();
  const cacheStats = state.runtimeCache!.stats();
  const suspendedSummary = state.runtimeCache!.suspendedSummary();
  const registryStats = state.activeTurnRegistry!.stats();
  const stuckHistory = state.activeTurnRegistry!.stuckTurnHistory();

  const MAX_SUSPENDED = 100;
  const MAX_HISTORY = 100;

  return {
    version: 1,
    writtenAt: now.toISOString(),
    supervisorPid: process.pid,
    supervisorStartedAt: state.supervisorStartedAt,
    cacheStats: {
      totalEntries: cacheStats.totalEntries,
      activeBorrows: cacheStats.activeBorrows,
      suspendedEntries: cacheStats.suspendedEntries,
      totalCreated: cacheStats.totalCreated,
      totalReused: cacheStats.totalReused,
      totalDisposed: cacheStats.totalDisposed,
      totalInvalidated: cacheStats.totalInvalidated,
    },
    suspendedSummary: suspendedSummary.slice(0, MAX_SUSPENDED).map((e) => ({
      sessionId: e.sessionId,
      reason: e.reason,
      suspendedAt: e.suspendedAt,
    })),
    registryStats: {
      activeTurnCount: registryStats.activeTurnCount,
      totalStarted: registryStats.totalStarted,
      totalEnded: registryStats.totalEnded,
      totalAborted: registryStats.totalAborted,
      stuckTurnCount: registryStats.stuckTurnCount,
      repeatStuckCount: registryStats.repeatStuckCount,
    },
    stuckTurnHistory: stuckHistory.slice(-MAX_HISTORY).map((h) => ({
      turnId: h.turnId,
      keyHash: createHash("sha256").update(h.key).digest("hex").slice(0, 16),
      startedAt: new Date(h.startedAt).toISOString(),
      endedAt: new Date(h.endedAt).toISOString(),
      durationMs: h.durationMs,
      wasAborted: h.wasAborted,
    })),
    fingerprintHash: stableJsonHash(state.runtimeFingerprint!),
  };
}
