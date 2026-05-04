import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { consumeTelegramPairingCode, loadRuntimeConfig } from "../config/runtime-config.js";
import type { ChannelAuthPolicy } from "../contracts/channel.js";
import { createRuntimeCronRunner, tickCron } from "../cron/cron-runner.js";
import { CronStore } from "../cron/cron-store.js";
import { CronExecutionStore } from "../cron/cron-execution-store.js";
import { createFileCronJobLock } from "../cron/cron-lock.js";
import { ProviderExecutor } from "../providers/provider-executor.js";
import { createRuntime } from "../runtime/create-runtime.js";
import { SQLiteSessionDB } from "../session/sqlite-session-db.js";
import { kemetBlueTheme } from "../theme/kemet-blue.js";
import { ChannelApprovalStore } from "./channel-approval-store.js";
import { ChannelGateway, telegramGatewayCommands } from "./channel-gateway.js";
import { PersistentChannelSessionStore } from "./channel-session-store.js";
import { DeliveryRouter } from "./delivery-router.js";
import { FileHandoffStore } from "./handoff-store.js";
import { FileSurfacePointerStore } from "./surface-pointer-store.js";
import { TelegramAdapter, type TelegramFetch } from "./telegram-adapter.js";
import { injectVoiceTranscripts } from "./voice-transcription.js";

export type GatewayRunOptions = {
  workspaceRoot: string;
  homeDir?: string;
  userConfigPath?: string;
  projectConfigPath?: string;
  telegramFetch?: TelegramFetch;
  once?: boolean;
};

export type GatewayRunResult = {
  ok: boolean;
  output: string;
  polls: number;
  processed: number;
};

export type TelegramGatewayDiagnostics = {
  adapter: "telegram";
  enabled: boolean;
  ready: boolean;
  statusLabel: string;
  modelRoute: string;
  contextWindowTokens: number;
  securityLabel: string;
  allowedUserIds: string[];
  allowedChatIds: string[];
  groupSessionsPerUser: boolean;
  threadSessionsPerUser: boolean;
  sessionResetPolicy: "none" | "idle" | "daily" | "both";
  sessionIdleResetMinutes?: number;
  botTokenEnv?: string;
  botTokenPresent: boolean;
  defaultChatId?: string;
  pollTimeoutSeconds?: number;
  maxAttachmentBytes?: number;
  missing: string[];
  pairingCode?: string;
  pairingExpiresAt?: string;
  processMode: string;
  logsLocation: string;
  stateRoot: string;
  sessionDbPath: string;
  mediaRoot: string;
  approvalStorePath: string;
  sessionContextPath: string;
  configSources: string[];
};

export async function getTelegramGatewayDiagnostics(options: GatewayRunOptions): Promise<TelegramGatewayDiagnostics> {
  const config = await loadRuntimeConfig(options);
  const telegram = config.channels.telegram;
  const stateRoot = join(options.homeDir ?? process.env.HOME ?? options.workspaceRoot, ".estacoda");
  const sessionDbPath = join(stateRoot, "sessions.sqlite");
  const mediaRoot = join(stateRoot, "channel-media");
  const approvalStorePath = join(stateRoot, "channel-approvals.json");
  const sessionContextPath = join(stateRoot, "channel-sessions.json");
  const authPolicy = telegramAuthPolicy(telegram.allowedUserIds ?? [], telegram.allowedChatIds ?? []);
  const botTokenEnv = telegram.botTokenEnv;
  const botTokenPresent = botTokenEnv !== undefined && process.env[botTokenEnv] !== undefined;

  return {
    adapter: "telegram",
    enabled: telegram.enabled === true,
    ready: telegram.ready,
    statusLabel: telegram.ready ? "ready" : telegram.enabled ? "configured, missing credentials" : "disabled",
    modelRoute: `${config.model.provider}/${config.model.id}`,
    contextWindowTokens: config.model.contextWindowTokens,
    securityLabel: authPolicy.mode === "allow-all"
      ? "allow-all"
      : (telegram.allowedUserIds ?? []).length + (telegram.allowedChatIds ?? []).length > 0
        ? "allowlist"
        : "locked until allowlist or pairing is configured",
    allowedUserIds: telegram.allowedUserIds ?? [],
    allowedChatIds: telegram.allowedChatIds ?? [],
    groupSessionsPerUser: telegram.groupSessionsPerUser ?? true,
    threadSessionsPerUser: telegram.threadSessionsPerUser ?? false,
    sessionResetPolicy: telegram.sessionResetPolicy ?? "none",
    sessionIdleResetMinutes: telegram.sessionIdleResetMinutes,
    botTokenEnv,
    botTokenPresent,
    defaultChatId: telegram.defaultChatId,
    pollTimeoutSeconds: telegram.pollTimeoutSeconds,
    maxAttachmentBytes: telegram.maxAttachmentBytes,
    missing: telegram.missing ?? [],
    pairingCode: telegram.pairing?.code,
    pairingExpiresAt: telegram.pairing?.expiresAt,
    processMode: "foreground process (status checks readiness, not live process liveness)",
    logsLocation: "stdout/stderr of the running gateway process",
    stateRoot,
    sessionDbPath,
    mediaRoot,
    approvalStorePath,
    sessionContextPath,
    configSources: config.sources
  };
}

export async function runTelegramGateway(options: GatewayRunOptions): Promise<GatewayRunResult> {
  const config = await loadRuntimeConfig(options);
  const telegram = config.channels.telegram;
  const diagnostics = await getTelegramGatewayDiagnostics(options);

  if (telegram.enabled !== true) {
    return {
      ok: false,
      output: [
        "EstaCoda Telegram gateway",
        `Status: ${diagnostics.statusLabel}`,
        `Adapter: ${diagnostics.adapter}`,
        `Model route: ${diagnostics.modelRoute}`,
        `Security: ${diagnostics.securityLabel}`,
        "",
        "Startup blocked",
        "Telegram gateway is disabled.",
        "Next: run estacoda telegram configure first."
      ].join("\n"),
      polls: 0,
      processed: 0
    };
  }

  const botTokenEnv = telegram.botTokenEnv;
  const botToken = botTokenEnv === undefined ? undefined : process.env[botTokenEnv];

  if (botTokenEnv === undefined || botToken === undefined) {
    return {
      ok: false,
      output: [
        "EstaCoda Telegram gateway",
        `Status: ${diagnostics.statusLabel}`,
        `Adapter: ${diagnostics.adapter}`,
        `Model route: ${diagnostics.modelRoute}`,
        `Security: ${diagnostics.securityLabel}`,
        `Bot token env: ${botTokenEnv ?? "unset"}`,
        `Bot token present: ${diagnostics.botTokenPresent ? "yes" : "no"}`,
        `State root: ${diagnostics.stateRoot}`,
        `Session DB: ${diagnostics.sessionDbPath}`,
        `Channel media: ${diagnostics.mediaRoot}`,
        `Approval store: ${diagnostics.approvalStorePath}`,
        `Session context: ${diagnostics.sessionContextPath}`,
        `Logs: ${diagnostics.logsLocation}`,
        "",
        "Startup blocked",
        "Telegram gateway is missing its bot token.",
        botTokenEnv === undefined ? "Missing: bot token env name" : `Missing: ${botTokenEnv}`,
        "Next: run estacoda telegram configure --bot-token-env ESTACODA_TELEGRAM_BOT_TOKEN, then export the token."
      ].join("\n"),
      polls: 0,
      processed: 0
    };
  }

  const authPolicy = telegramAuthPolicy(telegram.allowedUserIds ?? [], telegram.allowedChatIds ?? []);
  const sessionDbPath = diagnostics.sessionDbPath;
  const mediaRoot = diagnostics.mediaRoot;
  const approvalStorePath = diagnostics.approvalStorePath;
  const sessionContextPath = diagnostics.sessionContextPath;
  const cronStore = new CronStore({ homeDir: options.homeDir });
  await mkdir(dirname(sessionDbPath), { recursive: true });
  const sessionDb = new SQLiteSessionDB({ path: sessionDbPath });
  const cronExecutionStore = new CronExecutionStore(sessionDb.db);
  const cronJobLock = createFileCronJobLock({
    lockDir: join(diagnostics.stateRoot, "cron", "locks"),
    staleTimeoutMs: 600_000
  });
  const approvalStore = new ChannelApprovalStore({ path: approvalStorePath });
  const sessionPolicy = {
    groupSessionsPerUser: telegram.groupSessionsPerUser ?? true,
    threadSessionsPerUser: telegram.threadSessionsPerUser ?? false,
    resetPolicy: telegram.sessionResetPolicy ?? "none",
    idleResetMinutes: telegram.sessionIdleResetMinutes,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone
  };
  const handoffStore = new FileHandoffStore({ path: join(diagnostics.stateRoot, "handoff-codes.json") });
  const surfacePointerStore = new FileSurfacePointerStore({ path: join(diagnostics.stateRoot, "surface-pointers.json") });
  const adapter = new TelegramAdapter({
    botToken,
    defaultChatId: telegram.defaultChatId,
    pollTimeoutSeconds: telegram.pollTimeoutSeconds,
    maxAttachmentBytes: telegram.maxAttachmentBytes,
    mediaRoot,
    activityLabelsLocale: config.ui.activityLabels,
    fetch: options.telegramFetch
  });
  const router = new DeliveryRouter({ homeDir: options.homeDir });
  router.registerAdapter(adapter);

  const gateway = new ChannelGateway({
    adapters: [adapter],
    securityMode: config.security.approvalMode,
    securityAssessor: {
      ...config.security.assessor,
      providerExecutor: new ProviderExecutor({
        registry: config.providerRegistry,
        credentialPools: config.credentialPools
      })
    },
    sessionStore: new PersistentChannelSessionStore({ path: sessionContextPath, policy: sessionPolicy, surfacePointerStore }),
    approvalStore,
    authPolicy,
    trustedWorkspace: true,
    sessionPolicy,
    handoffStore,
    surfacePointerStore,
    preprocessMessage: async (message) => {
      const latestConfig = await loadRuntimeConfig(options);
      return injectVoiceTranscripts(message, {
        stt: latestConfig.stt
      });
    },
    pair: async (message) => {
      const result = await consumeTelegramPairingCode({
        workspaceRoot: options.workspaceRoot,
        homeDir: options.homeDir,
        userConfigPath: options.userConfigPath,
        projectConfigPath: options.projectConfigPath,
        code: message.text,
        userId: message.sender.id,
        chatId: message.sessionKey.chatId
      });

      if (!result.paired) {
        return undefined;
      }

      return "Telegram paired. This chat can now talk to EstaCoda.";
    },
    onStopRequested: async () => {
      await adapter.stop();
    },
    runtimeForSession: async ({ sessionId, securityPolicy }) => {
      const latestConfig = await loadRuntimeConfig(options);
      return createRuntime({
        theme: kemetBlueTheme,
        model: latestConfig.model,
        workspaceRoot: options.workspaceRoot,
        homeDir: options.homeDir,
        userConfigPath: options.userConfigPath,
        projectConfigPath: options.projectConfigPath,
        sessionId,
        profileId: "default",
        sessionDb,
        externalSkillRoots: latestConfig.skills.externalDirs,
        skillAutonomy: latestConfig.skills.autonomy,
        skillConfig: latestConfig.skills.config,
        ui: latestConfig.ui,
        agentProfile: latestConfig.profile,
        providerRegistry: latestConfig.providerRegistry,
        credentialPools: latestConfig.credentialPools,
        auxiliaryProviders: latestConfig.auxiliaryProviders,
        mcpServers: latestConfig.mcp.servers,
        securityPolicy,
        browser: latestConfig.browser,
        imageGen: latestConfig.imageGen,
        tts: latestConfig.tts,
        stt: latestConfig.stt,
        telegramReady: latestConfig.channels.telegram.ready,
        enableWebNetwork: latestConfig.web.enableNetwork,
        webMaxContentChars: latestConfig.web.maxContentChars
      });
    }
  });
  let polls = 0;
  let processed = 0;
  let commandsSynced = false;
  let failure: unknown;

  try {
    await gateway.start();
    await adapter.setCommands(telegramGatewayCommands());
    commandsSynced = true;

    do {
      await tickCron({
        store: cronStore,
        executionStore: cronExecutionStore,
        jobLock: cronJobLock,
        runner: createRuntimeCronRunner({
          deliver: async (job, content) => {
            const originKey = job.origin?.channel === "telegram" && job.origin.chatId !== undefined
              ? {
                  platform: "telegram" as const,
                  chatId: job.origin.chatId,
                  userId: job.origin.userId,
                  threadId: job.origin.threadId
                }
              : undefined;

            const fallbackSessionKey = originKey ?? {
              platform: "telegram" as const,
              chatId: job.origin?.chatId ?? "cron"
            };
            const target = job.delivery ?? "local";
            const targets = router.parseTarget(target, fallbackSessionKey);
            const results = await router.deliverText(targets, content);
            return {
              success: Array.from(results.values()).some((r) => r.success),
              perTarget: results
            };
          },
          disposeRuntime: true,
          workspaceRoot: options.workspaceRoot,
          runtimeFactory: async (job) => {
            const latestConfig = await loadRuntimeConfig(options);
            return createRuntime({
              theme: kemetBlueTheme,
              model: latestConfig.model,
              workspaceRoot: options.workspaceRoot,
              homeDir: options.homeDir,
              userConfigPath: options.userConfigPath,
              projectConfigPath: options.projectConfigPath,
              sessionId: `cron-${job.id}-${randomUUID()}`,
              profileId: "default",
              sessionDb,
              externalSkillRoots: latestConfig.skills.externalDirs,
              skillAutonomy: latestConfig.skills.autonomy,
              skillConfig: latestConfig.skills.config,
              ui: latestConfig.ui,
              agentProfile: latestConfig.profile,
              providerRegistry: latestConfig.providerRegistry,
              credentialPools: latestConfig.credentialPools,
              auxiliaryProviders: latestConfig.auxiliaryProviders,
              mcpServers: latestConfig.mcp.servers,
              imageGen: latestConfig.imageGen,
              tts: latestConfig.tts,
              stt: latestConfig.stt,
              securityMode: latestConfig.security.approvalMode,
              securityAssessor: {
                ...latestConfig.security.assessor,
                providerExecutor: new ProviderExecutor({
                  registry: latestConfig.providerRegistry,
                  credentialPools: latestConfig.credentialPools
                })
              },
              browser: latestConfig.browser,
              telegramReady: latestConfig.channels.telegram.ready,
              enableWebNetwork: latestConfig.web.enableNetwork,
              webMaxContentChars: latestConfig.web.maxContentChars,
              disableCronTools: true,
              // Cron recursion guard: disable toolsets that could trigger nested
              // scheduling or outbound messaging. "cron" disables the cronjob tool.
              // "messaging" and "clarify" toolsets are guarded here for future
              // compatibility; they do not exist in EstaCoda yet (Phase 4 work).
              disabledToolsets: ["cron", "messaging", "clarify"]
            });
          }
        })
      });
      processed += await adapter.pollOnce();
      polls += 1;
    } while (options.once !== true && adapter.running);
  } catch (error) {
    failure = error;
  } finally {
    await gateway.stop();
    sessionDb.close();
  }

  if (failure !== undefined) {
    const message = failure instanceof Error ? failure.message : String(failure);
    return {
      ok: false,
      output: [
        "EstaCoda Telegram gateway",
        `Status: startup failed`,
        `Mode: ${options.once === true ? "one-shot" : "continuous"}`,
        `Adapter: ${diagnostics.adapter}`,
        `Model route: ${diagnostics.modelRoute}`,
        `Security: ${diagnostics.securityLabel}`,
        `Bot token env: ${diagnostics.botTokenEnv ?? "unset"}`,
        `Bot token present: ${diagnostics.botTokenPresent ? "yes" : "no"}`,
        `Commands synced: ${commandsSynced ? "yes" : "no"}`,
        `State root: ${diagnostics.stateRoot}`,
        `Session DB: ${diagnostics.sessionDbPath}`,
        `Channel media: ${diagnostics.mediaRoot}`,
        `Approval store: ${diagnostics.approvalStorePath}`,
        `Session context: ${diagnostics.sessionContextPath}`,
        `Logs: ${diagnostics.logsLocation}`,
        "",
        `Failure: ${message}`
      ].join("\n"),
      polls,
      processed
    };
  }

  return {
    ok: true,
    output: [
      "EstaCoda Telegram gateway",
      `Status: ${options.once === true ? "one-shot completed" : "stopped"}`,
      `Mode: ${options.once === true ? "one-shot" : "continuous"}`,
      `Adapter: ${diagnostics.adapter}`,
      `Model route: ${diagnostics.modelRoute}`,
      `Context window: ${diagnostics.contextWindowTokens} tokens`,
      `Security: ${diagnostics.securityLabel}`,
      `Allowed users: ${renderIdList(diagnostics.allowedUserIds)}`,
      `Allowed chats: ${renderIdList(diagnostics.allowedChatIds)}`,
      `Group sessions per user: ${diagnostics.groupSessionsPerUser ? "yes" : "no"}`,
      `Thread sessions per user: ${diagnostics.threadSessionsPerUser ? "yes" : "no"}`,
      `Session reset policy: ${diagnostics.sessionResetPolicy}`,
      diagnostics.sessionIdleResetMinutes === undefined ? undefined : `Session idle reset: ${diagnostics.sessionIdleResetMinutes} min`,
      `Bot token env: ${diagnostics.botTokenEnv ?? "unset"}`,
      `Bot token present: ${diagnostics.botTokenPresent ? "yes" : "no"}`,
      diagnostics.defaultChatId === undefined ? undefined : `Default chat: ${diagnostics.defaultChatId}`,
      diagnostics.pollTimeoutSeconds === undefined ? undefined : `Poll timeout: ${diagnostics.pollTimeoutSeconds}s`,
      diagnostics.maxAttachmentBytes === undefined ? undefined : `Max attachment size: ${formatBytes(diagnostics.maxAttachmentBytes)}`,
      diagnostics.pairingExpiresAt === undefined ? undefined : `Pairing code active until: ${diagnostics.pairingExpiresAt}`,
      `Commands synced: ${commandsSynced ? "yes" : "no"}`,
      `Process model: ${diagnostics.processMode}`,
      `Logs: ${diagnostics.logsLocation}`,
      `State root: ${diagnostics.stateRoot}`,
      `Session DB: ${diagnostics.sessionDbPath}`,
      `Channel media: ${diagnostics.mediaRoot}`,
      `Approval store: ${diagnostics.approvalStorePath}`,
      `Session context: ${diagnostics.sessionContextPath}`,
      `Config sources: ${diagnostics.configSources.join(", ") || "none"}`,
      "",
      `Polls: ${polls}`,
      `Messages processed: ${processed}`,
      authPolicy.mode === "allow-all" ? "Gateway security mode: allow-all" : "Gateway security mode: allowlist"
    ].filter((line) => line !== undefined).join("\n"),
    polls,
    processed
  };
}

export function telegramAuthPolicy(allowedUserIds: string[], allowedChatIds: string[]): ChannelAuthPolicy {
  if (allowedUserIds.length === 0 && allowedChatIds.length === 0) {
    return {
      mode: "allowlist",
      allowedUserIds: [],
      allowedChatIds: [],
      deniedMessage: "This EstaCoda Telegram bot is locked. Add your Telegram user ID or chat ID to the allowlist before chatting with it."
    };
  }

  return {
    mode: "allowlist",
    allowedUserIds,
    allowedChatIds,
    deniedMessage: "This EstaCoda Telegram bot is not paired with this account. Ask the owner to add your Telegram user ID or chat ID."
  };
}

function renderIdList(ids: string[]): string {
  return ids.length === 0 ? "none" : ids.join(", ");
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return `${value} B`;
  }

  if (value >= 1024 * 1024) {
    const mb = value / (1024 * 1024);
    return `${Number.isInteger(mb) ? mb.toFixed(0) : mb.toFixed(1)} MB`;
  }

  if (value >= 1024) {
    const kb = value / 1024;
    return `${Number.isInteger(kb) ? kb.toFixed(0) : kb.toFixed(1)} KB`;
  }

  return `${value} B`;
}
