import { loadRuntimeConfig } from "../config/runtime-config.js";
import { defaultProfileId, readActiveProfile, resolveGlobalStateHome, resolveProfileStateHome } from "../config/profile-home.js";
import type { ChannelAuthPolicies } from "../contracts/channel.js";
import { getWhatsAppGatewayDiagnostics } from "./whatsapp-diagnostics.js";

export type GatewayRunOptions = {
  workspaceRoot: string;
  homeDir?: string;
  userConfigPath?: string;
  projectConfigPath?: string;
  projectConfigTrust?: "trusted" | "untrusted";
  profileId?: string;
  telegramFetch?: import("./telegram-adapter.js").TelegramFetch;
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
  const profileId = options.profileId ?? readActiveProfile({ homeDir: options.homeDir })?.profileId ?? defaultProfileId();
  const config = await loadRuntimeConfig({
    workspaceRoot: options.workspaceRoot,
    homeDir: options.homeDir,
    profileId
  });
  const telegram = config.channels.telegram;
  const globalPaths = resolveGlobalStateHome({ homeDir: options.homeDir ?? process.env.HOME ?? options.workspaceRoot });
  const profilePaths = resolveProfileStateHome({ homeDir: options.homeDir ?? process.env.HOME ?? options.workspaceRoot, profileId });
  const stateRoot = globalPaths.stateRoot;
  const sessionDbPath = globalPaths.sessionsSqlitePath;
  const mediaRoot = profilePaths.channelMediaPath;
  const approvalStorePath = `${stateRoot}/channel-approvals.json`;
  const sessionContextPath = `${stateRoot}/channel-sessions.json`;
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
    securityLabel: (telegram.allowedUserIds ?? []).length + (telegram.allowedChatIds ?? []).length > 0
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
    configSources: config.sources,
  };
}

export function telegramAuthPolicy(allowedUserIds: string[], allowedChatIds: string[]): ChannelAuthPolicies {
  if (allowedUserIds.length === 0 && allowedChatIds.length === 0) {
    return {
      telegram: {
        allowedUserIds: [],
        allowedChatIds: [],
        deniedMessage: "This EstaCoda Telegram bot is locked. Add your Telegram user ID or chat ID to the allowlist before chatting with it."
      }
    };
  }

  return {
    telegram: {
      allowedUserIds,
      allowedChatIds,
      deniedMessage: "This EstaCoda Telegram bot is not paired with this account. Ask the owner to add your Telegram user ID or chat ID."
    }
  };
}

export { getWhatsAppGatewayDiagnostics };
