import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { consumeTelegramPairingCode, loadRuntimeConfig } from "../config/runtime-config.js";
import type { ChannelAuthPolicy } from "../contracts/channel.js";
import { createRuntime } from "../runtime/create-runtime.js";
import { SQLiteSessionDB } from "../session/sqlite-session-db.js";
import { kemetBlueTheme } from "../theme/kemet-blue.js";
import { ChannelApprovalStore } from "./channel-approval-store.js";
import { ChannelGateway, InMemoryChannelSessionStore, telegramGatewayCommands } from "./channel-gateway.js";
import { TelegramAdapter, type TelegramFetch } from "./telegram-adapter.js";

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

export async function runTelegramGateway(options: GatewayRunOptions): Promise<GatewayRunResult> {
  const config = await loadRuntimeConfig(options);
  const telegram = config.channels.telegram;

  if (telegram.enabled !== true) {
    return {
      ok: false,
      output: "Telegram gateway is disabled. Run estacoda telegram configure first.",
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
        "Telegram gateway is missing its bot token.",
        botTokenEnv === undefined ? "Missing: bot token env name" : `Missing: ${botTokenEnv}`,
        "Run estacoda telegram configure --bot-token-env ESTACODA_TELEGRAM_BOT_TOKEN, then export the token."
      ].join("\n"),
      polls: 0,
      processed: 0
    };
  }

  const authPolicy = telegramAuthPolicy(telegram.allowedUserIds ?? [], telegram.allowedChatIds ?? []);
  const sessionDbPath = join(options.homeDir ?? process.env.HOME ?? options.workspaceRoot, ".estacoda", "sessions.sqlite");
  const mediaRoot = join(options.homeDir ?? process.env.HOME ?? options.workspaceRoot, ".estacoda", "channel-media");
  const approvalStorePath = join(options.homeDir ?? process.env.HOME ?? options.workspaceRoot, ".estacoda", "channel-approvals.json");
  await mkdir(dirname(sessionDbPath), { recursive: true });
  const sessionDb = new SQLiteSessionDB({ path: sessionDbPath });
  const approvalStore = new ChannelApprovalStore({ path: approvalStorePath });
  const adapter = new TelegramAdapter({
    botToken,
    defaultChatId: telegram.defaultChatId,
    pollTimeoutSeconds: telegram.pollTimeoutSeconds,
    maxAttachmentBytes: telegram.maxAttachmentBytes,
    mediaRoot,
    fetch: options.telegramFetch
  });
  const gateway = new ChannelGateway({
    adapters: [adapter],
    sessionStore: new InMemoryChannelSessionStore(),
    approvalStore,
    authPolicy,
    trustedWorkspace: true,
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
    runtimeForSession: async ({ sessionId, securityPolicy }) => createRuntime({
      theme: kemetBlueTheme,
      model: config.model,
      workspaceRoot: options.workspaceRoot,
      homeDir: options.homeDir,
      userConfigPath: options.userConfigPath,
      projectConfigPath: options.projectConfigPath,
      sessionId,
      profileId: "default",
      sessionDb,
      externalSkillRoots: config.skills.externalDirs,
      skillConfig: config.skills.config,
      providerRegistry: config.providerRegistry,
      credentialPools: config.credentialPools,
      auxiliaryProviders: config.auxiliaryProviders,
      securityPolicy,
      browser: config.browser,
      telegramReady: config.channels.telegram.ready,
      enableWebNetwork: config.web.enableNetwork,
      webMaxContentChars: config.web.maxContentChars
    })
  });
  let polls = 0;
  let processed = 0;

  await gateway.start();
  await adapter.setCommands(telegramGatewayCommands());

  try {
    do {
      processed += await adapter.pollOnce();
      polls += 1;
    } while (options.once !== true && adapter.running);
  } finally {
    await gateway.stop();
    sessionDb.close();
  }

  return {
    ok: true,
    output: [
      "Telegram gateway stopped.",
      `Polls: ${polls}`,
      `Messages processed: ${processed}`,
      authPolicy.mode === "allow-all" ? "Security: allow-all" : "Security: allowlist"
    ].join("\n"),
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
