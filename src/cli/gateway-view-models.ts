// v0.95 Gateway / Channel ViewModel Builders
// Pure factory functions. No formatting, ANSI, terminal-width, or rendering logic.

import type {
  CommandResultViewModel,
  KeyValueEntry,
  ListItem,
  PlainFallbackViewModel,
  ViewModel,
  WarningErrorViewModel,
} from "../contracts/view-model.js";
import type { LoadedRuntimeConfig } from "../config/runtime-config.js";
import type { TelegramGatewayDiagnostics } from "../channels/gateway-runner.js";
import type { WhatsAppGatewayDiagnostics } from "../channels/whatsapp-diagnostics.js";
import type { DeliveryErrorRecord } from "../channels/delivery-router.js";
import {
  buildCommandResultViewModel,
  buildKeyValueBlockViewModel,
  buildListViewModel,
  buildPlainFallbackViewModel,
  buildWarningErrorViewModel,
  kv,
  listItem,
} from "../ui/view-models/builders.js";

// ─────────────────────────────────────────────────────────────
// Gateway Status
// ─────────────────────────────────────────────────────────────

export type GatewayStatusData = {
  readonly channels: LoadedRuntimeConfig["channels"];
  readonly cronJobs: readonly { readonly status: string; readonly name: string; readonly nextRunAt?: string }[];
  readonly recentCronFailures: readonly {
    readonly jobId: string;
    readonly status: string;
    readonly startedAt: string;
    readonly failureMessage?: string;
  }[];
  readonly recentDeliveryErrors: readonly DeliveryErrorRecord[];
  readonly surfacePointers: readonly {
    readonly surfaceType: string;
    readonly surfaceId: string;
    readonly record: {
      readonly sessionId: string;
      readonly attachedAt: string;
      readonly homeDelivery?: string;
    };
  }[];
  readonly approvalCount: number;
  readonly missingConfig: readonly { readonly channel: string; readonly item: string }[];
};

export function buildGatewayStatusViewModel(data: GatewayStatusData): CommandResultViewModel {
  const activeCronJobs = data.cronJobs.filter((j) => j.status === "active");
  const nextDue = activeCronJobs
    .filter((j) => j.nextRunAt !== undefined)
    .sort((a, b) => new Date(a.nextRunAt!).getTime() - new Date(b.nextRunAt!).getTime())[0];

  const blocks: ViewModel[] = [
    buildKeyValueBlockViewModel({
      title: "Process",
      entries: [kv("Status", "CLI view (no live gateway process in this shell)")],
    }),
    buildChannelsOverviewBlock(data.channels),
    buildDeliveryPlatformsBlock(data.channels),
    buildSurfacePointersBlock(data.surfacePointers),
    buildKeyValueBlockViewModel({
      title: "Pending approvals",
      entries: [kv("Total grants", data.approvalCount)],
    }),
    buildKeyValueBlockViewModel({
      title: "Cron",
      entries: [
        kv("Jobs", `${data.cronJobs.length} total, ${activeCronJobs.length} active`),
        kv("Next due", nextDue === undefined ? "none" : `${nextDue.name} at ${nextDue.nextRunAt}`),
      ],
    }),
    buildCronFailuresBlock(data.recentCronFailures),
    buildDeliveryErrorsBlock(data.recentDeliveryErrors),
    buildMissingConfigBlock(data.missingConfig),
  ];

  return buildCommandResultViewModel({
    ok: true,
    title: "EstaCoda gateway status",
    blocks,
  });
}

function buildChannelsOverviewBlock(channels: LoadedRuntimeConfig["channels"]): ViewModel {
  return buildKeyValueBlockViewModel({
    title: "Channels",
    entries: [
      channelKv("Telegram", channels.telegram),
      channelKv("Discord", channels.discord),
      channelKv("Email", channels.email),
      channelKv("WhatsApp", channels.whatsapp),
    ],
  });
}

function channelKv(name: string, channel: LoadedRuntimeConfig["channels"]["telegram"]): KeyValueEntry {
  const status = channel.ready ? "ready" : channel.enabled ? "configured, missing credentials" : "disabled";
  const missing = channel.missing !== undefined && channel.missing.length > 0 ? ` (missing: ${channel.missing.join(", ")})` : "";
  return kv(name, `${status}${missing}`);
}

function buildDeliveryPlatformsBlock(channels: LoadedRuntimeConfig["channels"]): ViewModel {
  const platforms: string[] = [];
  if (channels.telegram.enabled) platforms.push("telegram");
  if (channels.discord.enabled) platforms.push("discord");
  if (channels.email.enabled) platforms.push("email");
  if (channels.whatsapp.enabled && channels.whatsapp.experimental) platforms.push("whatsapp");

  if (platforms.length === 0) {
    return buildListViewModel({ title: "DeliveryRouter platforms", items: [listItem("none configured")], emptyMessage: "none configured" });
  }
  return buildListViewModel({
    title: "DeliveryRouter platforms",
    items: platforms.map((p) => listItem(p)),
  });
}

function buildSurfacePointersBlock(
  pointers: GatewayStatusData["surfacePointers"]
): ViewModel {
  if (pointers.length === 0) {
    return buildListViewModel({ title: "Surface pointers", items: [listItem("none")], emptyMessage: "none" });
  }
  return buildListViewModel({
    title: "Surface pointers",
    items: pointers.map((p) => {
      const home = p.record.homeDelivery !== undefined ? ` home=${p.record.homeDelivery}` : "";
      return listItem(`${p.surfaceType}:${p.surfaceId} → ${p.record.sessionId} (since ${p.record.attachedAt})${home}`);
    }),
  });
}

function buildCronFailuresBlock(
  failures: GatewayStatusData["recentCronFailures"]
): ViewModel {
  if (failures.length === 0) {
    return buildListViewModel({ title: "Recent cron failures (last 5)", items: [listItem("none")], emptyMessage: "none" });
  }
  return buildListViewModel({
    title: "Recent cron failures (last 5)",
    items: failures.map((f) => {
      const msg = f.failureMessage !== undefined ? ` — ${f.failureMessage}` : "";
      return listItem(`${f.jobId} [${f.status}] ${f.startedAt}${msg}`);
    }),
  });
}

function buildDeliveryErrorsBlock(
  errors: GatewayStatusData["recentDeliveryErrors"]
): ViewModel {
  if (errors.length === 0) {
    return buildListViewModel({ title: "Recent delivery errors (last 5)", items: [listItem("none")], emptyMessage: "none" });
  }
  return buildListViewModel({
    title: "Recent delivery errors (last 5)",
    items: errors.map((e) => listItem(`${e.timestamp} ${e.target}: ${e.error}`)),
  });
}

function buildMissingConfigBlock(
  missing: GatewayStatusData["missingConfig"]
): ViewModel {
  if (missing.length === 0) {
    return buildListViewModel({ title: "Missing config", items: [listItem("none")], emptyMessage: "none" });
  }
  return buildListViewModel({
    title: "Missing config",
    items: missing.map((m) => listItem(`${m.channel}: ${m.item}`)),
  });
}

// ─────────────────────────────────────────────────────────────
// Gateway Diagnose
// ─────────────────────────────────────────────────────────────

export type GatewayDiagnoseData = {
  readonly telegram: TelegramGatewayDiagnostics;
  readonly discord: LoadedRuntimeConfig["channels"]["discord"];
  readonly email: LoadedRuntimeConfig["channels"]["email"];
  readonly whatsapp: WhatsAppGatewayDiagnostics;
  readonly whatsappExperimental: boolean;
  readonly cronJobs: readonly { readonly status: string }[];
  readonly jobsFileReadable: boolean;
  readonly outputDirWritable: boolean;
  readonly lockDirWritable: boolean;
};

export function buildGatewayDiagnoseViewModel(data: GatewayDiagnoseData): CommandResultViewModel {
  const warnings: WarningErrorViewModel[] = [];
  const blocks: ViewModel[] = [];

  // Telegram
  const tgEntries: KeyValueEntry[] = [
    kv("Enabled", data.telegram.enabled ? "yes" : "no"),
  ];
  if (data.telegram.enabled) {
    tgEntries.push(kv("Ready", data.telegram.ready ? "yes" : "no"));
    tgEntries.push(kv("Token present", data.telegram.botTokenPresent ? "yes" : "no"));
    if (!data.telegram.botTokenPresent) {
      const env = data.telegram.botTokenEnv ?? "(unset)";
      tgEntries.push(kv("Token env", env, "warn"));
      warnings.push(buildWarningErrorViewModel({
        severity: "warn",
        title: "Telegram",
        message: `missing env ${env}`,
      }));
    }
    if (data.telegram.allowedUserIds.length === 0 && data.telegram.allowedChatIds.length === 0) {
      tgEntries.push(kv("Security", "no allowed users or chats configured", "warn"));
      warnings.push(buildWarningErrorViewModel({
        severity: "warn",
        title: "Telegram",
        message: "no allowed users or chats configured",
      }));
    }
  }
  blocks.push(buildKeyValueBlockViewModel({ title: "Telegram", entries: tgEntries }));

  // Discord
  const dcEntries: KeyValueEntry[] = [kv("Enabled", data.discord.enabled ? "yes" : "no")];
  if (data.discord.enabled) {
    const tokenPresent = data.discord.botTokenEnv !== undefined && process.env[data.discord.botTokenEnv] !== undefined;
    dcEntries.push(kv("Token present", tokenPresent ? "yes" : "no"));
    if (!tokenPresent) {
      const env = data.discord.botTokenEnv ?? "(unset)";
      dcEntries.push(kv("Token env", env, "warn"));
      warnings.push(buildWarningErrorViewModel({
        severity: "warn",
        title: "Discord",
        message: `missing env ${env}`,
      }));
    }
  }
  blocks.push(buildKeyValueBlockViewModel({ title: "Discord", entries: dcEntries }));

  // Email
  const emEntries: KeyValueEntry[] = [kv("Enabled", data.email.enabled ? "yes" : "no")];
  if (data.email.enabled) {
    const passwordPresent = data.email.passwordEnv !== undefined && process.env[data.email.passwordEnv] !== undefined;
    emEntries.push(kv("IMAP host", data.email.imapHost ?? "(unset)"));
    emEntries.push(kv("SMTP host", data.email.smtpHost ?? "(unset)"));
    emEntries.push(kv("Username", data.email.username ?? "(unset)"));
    emEntries.push(kv("Password present", passwordPresent ? "yes" : "no"));
    if (!passwordPresent) {
      const env = data.email.passwordEnv ?? "(unset)";
      emEntries.push(kv("Password env", env, "warn"));
      warnings.push(buildWarningErrorViewModel({
        severity: "warn",
        title: "Email",
        message: `missing env ${env}`,
      }));
    }
    emEntries.push(kv("Home address", data.email.homeAddress ?? "(unset)"));
    emEntries.push(kv("Own address", data.email.ownAddress ?? "(unset)"));
    if (data.email.ownAddress === undefined) {
      emEntries.push(kv("Own address", "not configured", "warn"));
      warnings.push(buildWarningErrorViewModel({
        severity: "warn",
        title: "Email",
        message: "ownAddress not configured",
      }));
    }
  }
  blocks.push(buildKeyValueBlockViewModel({ title: "Email", entries: emEntries }));

  // WhatsApp
  const waEntries: KeyValueEntry[] = [
    kv("Enabled", data.whatsapp.enabled ? "yes" : "no"),
    kv("Experimental gate", data.whatsappExperimental ? "open" : "closed"),
  ];
  if (data.whatsappExperimental) {
    waEntries.push(kv("Baileys available", data.whatsapp.baileysAvailable ? "yes" : "no"));
    waEntries.push(kv("Auth dir writable", data.whatsapp.authDirWritable ? "yes" : "no"));
    if (!data.whatsapp.baileysAvailable) {
      waEntries.push(kv("Baileys", "not installed", "warn"));
      warnings.push(buildWarningErrorViewModel({
        severity: "warn",
        title: "WhatsApp",
        message: "@whiskeysockets/baileys not installed",
      }));
    }
  }
  blocks.push(buildKeyValueBlockViewModel({ title: "WhatsApp", entries: waEntries }));

  // Cron
  const cronEntries: KeyValueEntry[] = [
    kv("Jobs", data.cronJobs.length),
    kv("Jobs file readable", data.jobsFileReadable ? "yes" : "no"),
    kv("Output dir writable", data.outputDirWritable ? "yes" : "no"),
    kv("Lock dir writable", data.lockDirWritable ? "yes" : "no"),
  ];
  if (!data.jobsFileReadable) {
    cronEntries.push(kv("Jobs file", "not readable", "warn"));
    warnings.push(buildWarningErrorViewModel({
      severity: "warn",
      title: "Cron",
      message: "jobs file not readable",
    }));
  }
  if (!data.outputDirWritable) {
    cronEntries.push(kv("Output dir", "not writable", "warn"));
    warnings.push(buildWarningErrorViewModel({
      severity: "warn",
      title: "Cron",
      message: "output directory not writable",
    }));
  }
  if (!data.lockDirWritable) {
    cronEntries.push(kv("Lock dir", "not writable", "warn"));
    warnings.push(buildWarningErrorViewModel({
      severity: "warn",
      title: "Cron",
      message: "lock directory not writable",
    }));
  }
  blocks.push(buildKeyValueBlockViewModel({ title: "Cron", entries: cronEntries }));

  return buildCommandResultViewModel({
    ok: warnings.length === 0,
    title: "EstaCoda gateway diagnose",
    blocks: [...blocks, ...warnings],
  });
}

// ─────────────────────────────────────────────────────────────
// Channels List
// ─────────────────────────────────────────────────────────────

export type ChannelsListData = {
  readonly channels: LoadedRuntimeConfig["channels"];
};

export function buildChannelsListViewModel(data: ChannelsListData): CommandResultViewModel {
  return buildCommandResultViewModel({
    ok: true,
    title: "EstaCoda channels",
    blocks: [
      buildListViewModel({
        items: [
          compactChannelItem("telegram", data.channels.telegram),
          compactChannelItem("discord", data.channels.discord),
          compactChannelItem("email", data.channels.email),
          compactChannelItem("whatsapp", data.channels.whatsapp),
        ],
      }),
    ],
  });
}

function compactChannelItem(name: string, channel: LoadedRuntimeConfig["channels"]["telegram"]): ListItem {
  const status = channel.ready ? "ready" : channel.enabled ? "not ready" : "disabled";
  return listItem(name.padEnd(10), status);
}

// ─────────────────────────────────────────────────────────────
// Channels Status
// ─────────────────────────────────────────────────────────────

export type ChannelsStatusData = {
  readonly channel: string;
  readonly telegram?: {
    readonly diag: TelegramGatewayDiagnostics;
    readonly pointers: GatewayStatusData["surfacePointers"];
  };
  readonly discord?: {
    readonly config: LoadedRuntimeConfig["channels"]["discord"];
    readonly pointers: GatewayStatusData["surfacePointers"];
  };
  readonly email?: {
    readonly config: LoadedRuntimeConfig["channels"]["email"];
    readonly pointers: GatewayStatusData["surfacePointers"];
  };
  readonly whatsapp?: {
    readonly diag: WhatsAppGatewayDiagnostics;
    readonly config: LoadedRuntimeConfig["channels"]["whatsapp"];
    readonly pointers: GatewayStatusData["surfacePointers"];
  };
};

export function buildChannelsStatusViewModel(data: ChannelsStatusData): CommandResultViewModel | PlainFallbackViewModel {
  if (data.channel === "telegram" && data.telegram !== undefined) {
    const { diag, pointers } = data.telegram;
    const entries: KeyValueEntry[] = [
      kv("Enabled", diag.enabled ? "yes" : "no"),
      kv("Ready", diag.ready ? "yes" : "no"),
      kv("Status", diag.statusLabel),
      kv("Token env", diag.botTokenEnv ?? "(unset)"),
      kv("Token present", diag.botTokenPresent ? "yes" : "no"),
      kv("Default chat", diag.defaultChatId ?? "(unset)"),
      kv("Security", diag.securityLabel),
      kv("Allowed users", diag.allowedUserIds.join(", ") || "none"),
      kv("Allowed chats", diag.allowedChatIds.join(", ") || "none"),
      kv("Group sessions per user", diag.groupSessionsPerUser ? "yes" : "no"),
      kv("Thread sessions per user", diag.threadSessionsPerUser ? "yes" : "no"),
      kv("Session reset policy", diag.sessionResetPolicy),
    ];
    if (diag.sessionIdleResetMinutes !== undefined) {
      entries.push(kv("Session idle reset", `${diag.sessionIdleResetMinutes} min`));
    }
    return buildCommandResultViewModel({
      ok: true,
      title: "Telegram channel status",
      blocks: [
        buildKeyValueBlockViewModel({ entries }),
        buildSurfacePointersBlock(pointers),
      ],
    });
  }

  if (data.channel === "discord" && data.discord !== undefined) {
    const { config, pointers } = data.discord;
    const tokenPresent = config.botTokenEnv !== undefined && process.env[config.botTokenEnv] !== undefined;
    return buildCommandResultViewModel({
      ok: true,
      title: "Discord channel status",
      blocks: [
        buildKeyValueBlockViewModel({
          entries: [
            kv("Enabled", config.enabled ? "yes" : "no"),
            kv("Ready", config.ready ? "yes" : "no"),
            kv("Token env", config.botTokenEnv ?? "(unset)"),
            kv("Token present", tokenPresent ? "yes" : "no"),
            kv("Allowed users", (config.allowedUsers ?? []).join(", ") || "none"),
            kv("Allowed guilds", (config.allowedGuilds ?? []).join(", ") || "none"),
            kv("Allowed channels", (config.allowedChannels ?? []).join(", ") || "none"),
          ],
        }),
        buildSurfacePointersBlock(pointers),
      ],
    });
  }

  if (data.channel === "email" && data.email !== undefined) {
    const { config, pointers } = data.email;
    const passwordPresent = config.passwordEnv !== undefined && process.env[config.passwordEnv] !== undefined;
    return buildCommandResultViewModel({
      ok: true,
      title: "Email channel status",
      blocks: [
        buildKeyValueBlockViewModel({
          entries: [
            kv("Enabled", config.enabled ? "yes" : "no"),
            kv("Ready", config.ready ? "yes" : "no"),
            kv("IMAP", `${config.imapHost ?? "(unset)"}:${config.imapPort ?? "(default)"}`),
            kv("SMTP", `${config.smtpHost ?? "(unset)"}:${config.smtpPort ?? "(default)"}`),
            kv("Username", config.username ?? "(unset)"),
            kv("Password present", passwordPresent ? "yes" : "no"),
            kv("Own address", config.ownAddress ?? "(unset)"),
            kv("Home address", config.homeAddress ?? "(unset)"),
            kv("Allowed senders", (config.allowedSenders ?? []).join(", ") || "none"),
            kv("Allow all users", config.allowAllUsers ? "yes" : "no"),
          ],
        }),
        buildSurfacePointersBlock(pointers),
      ],
    });
  }

  if (data.channel === "whatsapp" && data.whatsapp !== undefined) {
    const { diag, config, pointers } = data.whatsapp;
    return buildCommandResultViewModel({
      ok: true,
      title: "WhatsApp channel status",
      blocks: [
        buildKeyValueBlockViewModel({
          entries: [
            kv("Enabled", config.enabled ? "yes" : "no"),
            kv("Experimental gate", config.experimental ? "open" : "closed"),
            kv("Ready", diag.ready ? "yes" : "no"),
            kv("Status", diag.statusLabel),
            kv("Baileys available", diag.baileysAvailable ? "yes" : "no"),
            kv("Auth dir", diag.authDir),
            kv("Auth dir writable", diag.authDirWritable ? "yes" : "no"),
            kv("Allowed users", (config.allowedUsers ?? []).join(", ") || "none"),
            kv("Pairing mode", config.pairingMode ?? "qr"),
          ],
        }),
        buildSurfacePointersBlock(pointers),
      ],
    });
  }

  return buildPlainFallbackViewModel({
    lines: [`Unknown channel: ${data.channel}. Supported: telegram, discord, email, whatsapp.`],
  });
}
