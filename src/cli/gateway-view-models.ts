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
import type { AdapterCapability } from "../contracts/channel.js";
import type { LoadedRuntimeConfig } from "../config/runtime-config.js";
import type { TelegramGatewayDiagnostics } from "../channels/gateway-runner.js";
import type { WhatsAppGatewayDiagnostics } from "../channels/whatsapp-diagnostics.js";
import type { DeliveryErrorRecord } from "../channels/delivery-router.js";
import type { PersistedRuntimeState, AdapterRuntimeState } from "../gateway/adapter-runtime-state.js";
import type { RuntimeCacheState } from "../gateway/runtime-cache-state.js";
import {
  buildCommandResultViewModel,
  buildKeyValueBlockViewModel,
  buildListViewModel,
  buildPlainFallbackViewModel,
  buildTableViewModel,
  buildWarningErrorViewModel,
  kv,
  listItem,
} from "../ui/view-models/builders.js";

// ─────────────────────────────────────────────────────────────
// Gateway Status
// ─────────────────────────────────────────────────────────────

export type SupervisorSnapshot = {
  readonly pid?: number;
  readonly lifecycle?: string;
  readonly startedAt?: string;
  readonly version?: string;
  readonly profileId?: string;
};

export type IdentityLockStatus = {
  readonly kind: string;
  readonly state: "locked" | "unlocked" | "stale" | "n/a";
  readonly pid?: number;
};

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
  readonly approvalPolicy: string;
  readonly missingConfig: readonly { readonly channel: string; readonly item: string }[];
  readonly supervisor?: SupervisorSnapshot;
  readonly identityLocks: readonly IdentityLockStatus[];
  readonly runtimeState?: PersistedRuntimeState;
  readonly runtimeCacheState?: RuntimeCacheState;
};

export function buildGatewayStatusViewModel(data: GatewayStatusData): CommandResultViewModel {
  const activeCronJobs = data.cronJobs.filter((j) => j.status === "active");
  const nextDue = activeCronJobs
    .filter((j) => j.nextRunAt !== undefined)
    .sort((a, b) => new Date(a.nextRunAt!).getTime() - new Date(b.nextRunAt!).getTime())[0];

  const identityLocksBlock = buildIdentityLocksBlock(data.identityLocks);
  const adapterRuntimeBlock = buildAdapterRuntimeBlock(data.runtimeState);
  const runtimeCacheBlock = buildRuntimeCacheBlock(data.runtimeCacheState);
  const activeTurnsBlock = buildActiveTurnsBlock(data.runtimeCacheState);
  const suspendedSessionsBlock = buildSuspendedSessionsBlock(data.runtimeCacheState);
  const stuckTurnHistoryBlock = buildStuckTurnHistoryBlock(data.runtimeCacheState);
  const blocks: ViewModel[] = [
    buildSupervisorBlock(data.supervisor),
    ...(adapterRuntimeBlock ? [adapterRuntimeBlock] : []),
    ...(runtimeCacheBlock ? [runtimeCacheBlock] : []),
    ...(activeTurnsBlock ? [activeTurnsBlock] : []),
    ...(suspendedSessionsBlock ? [suspendedSessionsBlock] : []),
    ...(stuckTurnHistoryBlock ? [stuckTurnHistoryBlock] : []),
    ...(identityLocksBlock ? [identityLocksBlock] : []),
    buildKeyValueBlockViewModel({
      title: "Process",
      entries: [kv("Status", "CLI view (no live gateway process in this shell)")],
    }),
    buildChannelsOverviewBlock(data.channels),
    buildDeliveryBlock(data.channels, data.recentDeliveryErrors),
    buildSurfacePointersBlock(data.surfacePointers),
    buildKeyValueBlockViewModel({
      title: "Approvals",
      entries: [
        kv("Policy", data.approvalPolicy),
        kv("Granted", data.approvalCount),
      ],
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

function buildSupervisorBlock(supervisor: GatewayStatusData["supervisor"]): ViewModel {
  if (supervisor === undefined || supervisor.pid === undefined) {
    return buildKeyValueBlockViewModel({
      title: "Supervisor",
      entries: [
        kv("PID", "none"),
        kv("State", "stopped"),
      ],
    });
  }

  const entries: KeyValueEntry[] = [
    kv("PID", supervisor.pid),
    kv("State", supervisor.lifecycle ?? "unknown"),
  ];

  if (supervisor.profileId !== undefined) {
    entries.push(kv("Profile", supervisor.profileId));
  }

  if (supervisor.startedAt !== undefined) {
    const started = new Date(supervisor.startedAt);
    const now = new Date();
    const uptimeMs = now.getTime() - started.getTime();
    const uptimeMin = Math.floor(uptimeMs / 60_000);
    const uptimeStr = uptimeMin < 1 ? "<1m" : `${uptimeMin}m`;
    entries.push(kv("Uptime", uptimeStr));
  }

  if (supervisor.version !== undefined) {
    entries.push(kv("Version", supervisor.version));
  }

  return buildKeyValueBlockViewModel({
    title: "Supervisor",
    entries,
  });
}

function buildIdentityLocksBlock(locks: readonly IdentityLockStatus[]): ViewModel | undefined {
  const problemLocks = locks.filter((l) => l.state === "stale");
  if (problemLocks.length === 0) return undefined;

  const entries: KeyValueEntry[] = problemLocks.map((l) =>
    kv(l.kind, l.pid === -1 ? "corrupt" : `stale (pid ${l.pid}, dead)`)
  );
  return buildKeyValueBlockViewModel({
    title: "Identity Locks",
    entries,
  });
}

function buildAdapterRuntimeBlock(runtimeState: PersistedRuntimeState | undefined): ViewModel | undefined {
  if (runtimeState === undefined) return undefined;
  if (runtimeState.adapters.length === 0) return undefined;

  const entries: KeyValueEntry[] = runtimeState.adapters.map((a) => {
    const stateLabel = a.state;
    const retryLabel = a.retry !== undefined
      ? ` (retry ${a.retry.attempt}/${a.retry.maxAttempts} at ${a.retry.nextRetryAt})`
      : "";
    const errorLabel = a.lastError !== undefined
      ? ` — ${a.lastError.message} (x${a.lastError.count})`
      : "";
    const pollsLabel = `polls=${a.pollsTotal} processed=${a.pollMessagesProcessed} failed=${a.pollsFailed}`;
    return kv(a.kind, `${stateLabel}${retryLabel}${errorLabel} | ${pollsLabel}`);
  });

  return buildKeyValueBlockViewModel({
    title: "Adapter Runtime",
    entries,
  });
}

function lockStateLabel(lock: IdentityLockStatus | undefined): string {
  if (lock === undefined) return "n/a";
  if (lock.state === "locked") return `locked (pid ${lock.pid})`;
  if (lock.state === "stale") return `stale (pid ${lock.pid}, dead)`;
  return lock.state;
}

function channelKv(name: string, channel: LoadedRuntimeConfig["channels"]["telegram"]): KeyValueEntry {
  const status = channel.ready ? "ready" : channel.enabled ? "configured, missing credentials" : "disabled";
  const missing = channel.missing !== undefined && channel.missing.length > 0 ? ` (missing: ${channel.missing.join(", ")})` : "";
  const busySuffix = channel.enabled ? ` (${channel.busyPolicy ?? "reject"}, depth ${channel.queueDepth ?? 3})` : "";
  return kv(name, `${status}${missing}${busySuffix}`);
}

function buildDeliveryBlock(channels: LoadedRuntimeConfig["channels"], recentDeliveryErrors: readonly DeliveryErrorRecord[]): ViewModel {
  const platforms: string[] = [];
  if (channels.telegram.enabled) platforms.push("telegram");
  if (channels.discord.enabled) platforms.push("discord");
  if (channels.email.enabled) platforms.push("email");
  if (channels.whatsapp.enabled && channels.whatsapp.experimental) platforms.push("whatsapp");

  return buildKeyValueBlockViewModel({
    title: "Delivery",
    entries: [
      kv("Enabled platforms", platforms.length === 0 ? "none" : platforms.join(", ")),
      kv("Recent errors", `${recentDeliveryErrors.length} (last 5 records)`),
    ],
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

export type SupervisorHealth = {
  readonly pidHealthy: boolean;
  readonly lockHealthy: boolean;
};

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
  readonly supervisor?: SupervisorHealth;
  readonly identityLockHealth?: {
    readonly staleLocks: readonly { readonly kind: string; readonly pid: number }[];
    readonly duplicateHashes: readonly string[];
    readonly missingLocks: readonly string[];
  };
  readonly runtimeState?: PersistedRuntimeState;
  readonly runtimeStateNote?: "stale" | "pid-mismatch" | "supervisor-not-live";
  readonly runtimeCacheState?: RuntimeCacheState;
  readonly runtimeCacheStateNote?: "stale" | "pid-mismatch" | "supervisor-not-live";
  readonly approvalCount: number;
  readonly recentDeliveryErrors: readonly DeliveryErrorRecord[];
  readonly channels: LoadedRuntimeConfig["channels"];
};

export function buildGatewayDiagnoseViewModel(data: GatewayDiagnoseData): CommandResultViewModel {
  const warnings: WarningErrorViewModel[] = [];
  const blocks: ViewModel[] = [];

  // Supervisor
  const svEntries: KeyValueEntry[] = [];
  if (data.supervisor !== undefined) {
    svEntries.push(kv("PID healthy", data.supervisor.pidHealthy ? "yes" : "no"));
    svEntries.push(kv("Lock healthy", data.supervisor.lockHealthy ? "yes" : "no"));
    if (!data.supervisor.pidHealthy) {
      warnings.push(buildWarningErrorViewModel({
        severity: "warn",
        title: "Supervisor",
        message: "stale PID file detected",
      }));
    }
    if (!data.supervisor.lockHealthy) {
      warnings.push(buildWarningErrorViewModel({
        severity: "warn",
        title: "Supervisor",
        message: "stale lock file detected",
      }));
    }
  } else {
    svEntries.push(kv("PID healthy", "yes"));
    svEntries.push(kv("Lock healthy", "yes"));
  }
  blocks.push(buildKeyValueBlockViewModel({ title: "Supervisor", entries: svEntries }));

  // Runtime state notes
  if (data.runtimeStateNote !== undefined) {
    const noteMessages: Record<string, string> = {
      stale: "runtime state is stale (supervisor may have crashed)",
      "pid-mismatch": "runtime state PID does not match current supervisor PID",
      "supervisor-not-live": "runtime state exists but supervisor is not live",
    };
    warnings.push(buildWarningErrorViewModel({
      severity: "warn",
      title: "Adapter Runtime",
      message: noteMessages[data.runtimeStateNote] ?? `runtime state note: ${data.runtimeStateNote}`,
    }));
  }

  // Runtime cache state notes
  if (data.runtimeCacheStateNote !== undefined) {
    const cacheNoteMessages: Record<string, string> = {
      stale: "runtime-cache-state is stale (supervisor may have crashed)",
      "pid-mismatch": "runtime-cache-state PID does not match current supervisor PID",
      "supervisor-not-live": "runtime-cache-state exists but supervisor is not live",
    };
    warnings.push(buildWarningErrorViewModel({
      severity: "warn",
      title: "Runtime Cache",
      message: cacheNoteMessages[data.runtimeCacheStateNote] ?? `runtime-cache-state note: ${data.runtimeCacheStateNote}`,
    }));
  }

  // Runtime cache blocks in diagnose (even when stale)
  if (data.runtimeCacheState !== undefined) {
    const cacheBlock = buildRuntimeCacheBlock(data.runtimeCacheState);
    const turnsBlock = buildActiveTurnsBlock(data.runtimeCacheState);
    const suspendedBlock = buildSuspendedSessionsBlock(data.runtimeCacheState);
    const stuckBlock = buildStuckTurnHistoryBlock(data.runtimeCacheState);
    if (cacheBlock) blocks.push(cacheBlock);
    if (turnsBlock) blocks.push(turnsBlock);
    if (suspendedBlock) {
      blocks.push(suspendedBlock);
      warnings.push(buildWarningErrorViewModel({
        severity: "warn",
        title: "Runtime Cache",
        message: `${data.runtimeCacheState.suspendedSummary.length} suspended session(s) present`,
      }));
    }
    if (stuckBlock) {
      blocks.push(stuckBlock);
      warnings.push(buildWarningErrorViewModel({
        severity: "warn",
        title: "Runtime Cache",
        message: `${data.runtimeCacheState.stuckTurnHistory.length} stuck turn(s) in history`,
      }));
    }
  }

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

  // Identity Locks
  const ilh = data.identityLockHealth;
  if (ilh !== undefined) {
    const hasProblems = ilh.staleLocks.length > 0 || ilh.duplicateHashes.length > 0 || ilh.missingLocks.length > 0;
    if (hasProblems) {
      const ilEntries: KeyValueEntry[] = [
        kv("Note", "primitives only \u2014 not yet enforced at supervisor start"),
      ];
      if (ilh.staleLocks.length > 0) {
        ilEntries.push(kv("Stale locks", ilh.staleLocks.map((l) => `${l.kind} (${l.pid === -1 ? "corrupt" : `pid ${l.pid}`})`).join(", "), "warn"));
        for (const stale of ilh.staleLocks) {
          const desc = stale.pid === -1 ? "corrupt lock" : "stale lock";
          const detail = stale.pid === -1 ? "" : ` (pid ${stale.pid})`;
          warnings.push(buildWarningErrorViewModel({
            severity: "warn",
            title: "Identity Lock",
            message: `${desc} for ${stale.kind}${detail}`,
          }));
        }
      }
      if (ilh.duplicateHashes.length > 0) {
        ilEntries.push(kv("Duplicate hashes", ilh.duplicateHashes.join(", "), "warn"));
        for (const dup of ilh.duplicateHashes) {
          warnings.push(buildWarningErrorViewModel({
            severity: "warn",
            title: "Identity Lock",
            message: `duplicate hash detected: ${dup}`,
          }));
        }
      }
      if (ilh.missingLocks.length > 0) {
        ilEntries.push(kv("Not yet acquired", ilh.missingLocks.join(", ")));
      }
      blocks.push(buildKeyValueBlockViewModel({ title: "Identity Locks", entries: ilEntries }));
    }
  }

  // Delivery health check
  if (data.recentDeliveryErrors.length >= 3) {
    warnings.push(buildWarningErrorViewModel({
      severity: "warn",
      title: "Delivery",
      message: `${data.recentDeliveryErrors.length} recent delivery errors (last 5 records)`,
    }));
  }

  // Approvals accumulation info
  if (data.approvalCount >= 20) {
    warnings.push(buildWarningErrorViewModel({
      severity: "info",
      title: "Approvals",
      message: `${data.approvalCount} granted approvals accumulated`,
    }));
  }

  // Busy policy note
  const channelEntries: [string, LoadedRuntimeConfig["channels"]["telegram"]][] = [
    ["telegram", data.channels.telegram],
    ["discord", data.channels.discord],
    ["email", data.channels.email],
    ["whatsapp", data.channels.whatsapp],
  ];
  for (const [name, channel] of channelEntries) {
    if (channel.enabled && (channel.queueDepth ?? 3) > 5) {
      warnings.push(buildWarningErrorViewModel({
        severity: "info",
        title: "Channels",
        message: `${name} queue depth is ${channel.queueDepth ?? 3} (potential memory pressure)`,
      }));
    }
  }

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
  readonly capabilities: readonly AdapterCapability[];
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
      buildCapabilitiesTable(data.capabilities),
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
    readonly capability: AdapterCapability;
    readonly runtimeStateNote?: string;
    readonly adapterRuntime?: AdapterRuntimeState;
    readonly identityLock?: IdentityLockStatus;
    readonly busyPolicy: string;
    readonly queueDepth: number;
  };
  readonly discord?: {
    readonly config: LoadedRuntimeConfig["channels"]["discord"];
    readonly pointers: GatewayStatusData["surfacePointers"];
    readonly capability: AdapterCapability;
    readonly runtimeStateNote?: string;
    readonly adapterRuntime?: AdapterRuntimeState;
    readonly identityLock?: IdentityLockStatus;
    readonly busyPolicy: string;
    readonly queueDepth: number;
  };
  readonly email?: {
    readonly config: LoadedRuntimeConfig["channels"]["email"];
    readonly pointers: GatewayStatusData["surfacePointers"];
    readonly capability: AdapterCapability;
    readonly runtimeStateNote?: string;
    readonly adapterRuntime?: AdapterRuntimeState;
    readonly identityLock?: IdentityLockStatus;
    readonly busyPolicy: string;
    readonly queueDepth: number;
  };
  readonly whatsapp?: {
    readonly diag: WhatsAppGatewayDiagnostics;
    readonly config: LoadedRuntimeConfig["channels"]["whatsapp"];
    readonly pointers: GatewayStatusData["surfacePointers"];
    readonly capability: AdapterCapability;
    readonly runtimeStateNote?: string;
    readonly adapterRuntime?: AdapterRuntimeState;
    readonly identityLock?: IdentityLockStatus;
    readonly busyPolicy: string;
    readonly queueDepth: number;
  };
};

function channelLockLabel(lock: IdentityLockStatus | undefined): string {
  if (lock === undefined) return "unlocked";
  if (lock.state === "locked") return `locked (pid ${lock.pid})`;
  if (lock.state === "stale" && lock.pid === -1) return "corrupt";
  if (lock.state === "stale") return `stale (pid ${lock.pid}, dead)`;
  return lock.state;
}

function buildChannelRuntimeEntries(
  runtimeStateNote: string | undefined,
  adapterRuntime: AdapterRuntimeState | undefined
): KeyValueEntry[] {
  if (runtimeStateNote !== undefined) {
    return [kv("Runtime state", runtimeStateNote)];
  }
  if (adapterRuntime === undefined) {
    return [kv("Adapter", "not registered in runtime state")];
  }
  const entries: KeyValueEntry[] = [kv("State", adapterRuntime.state)];
  if (adapterRuntime.pendingOperation !== undefined) {
    entries.push(kv("Pending", adapterRuntime.pendingOperation));
  }
  if (adapterRuntime.lastError !== undefined) {
    entries.push(kv("Last error", `${adapterRuntime.lastError.message} (x${adapterRuntime.lastError.count})`));
  }
  if (adapterRuntime.retry !== undefined) {
    entries.push(kv("Retry", `${adapterRuntime.retry.attempt}/${adapterRuntime.retry.maxAttempts} at ${adapterRuntime.retry.nextRetryAt}`));
  }
  entries.push(kv("Polls", String(adapterRuntime.pollsTotal)));
  entries.push(kv("Processed", String(adapterRuntime.pollMessagesProcessed)));
  entries.push(kv("Failed", String(adapterRuntime.pollsFailed)));
  if (adapterRuntime.startedAt !== undefined) {
    entries.push(kv("Started", adapterRuntime.startedAt));
  }
  return entries;
}

export function buildChannelsStatusViewModel(data: ChannelsStatusData): CommandResultViewModel | PlainFallbackViewModel {
  if (data.channel === "telegram" && data.telegram !== undefined) {
    const { diag, pointers, capability, runtimeStateNote, adapterRuntime, identityLock, busyPolicy, queueDepth } = data.telegram;
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
      kv("Busy policy", busyPolicy),
      kv("Queue depth", String(queueDepth)),
      kv("Identity lock", channelLockLabel(identityLock)),
      ...buildChannelRuntimeEntries(runtimeStateNote, adapterRuntime),
    ];
    if (diag.sessionIdleResetMinutes !== undefined) {
      entries.push(kv("Session idle reset", `${diag.sessionIdleResetMinutes} min`));
    }
    return buildCommandResultViewModel({
      ok: true,
      title: "Telegram channel status",
      blocks: [
        buildKeyValueBlockViewModel({ entries }),
        buildCapabilitiesBlock(capability),
        buildSurfacePointersBlock(pointers),
      ],
    });
  }

  if (data.channel === "discord" && data.discord !== undefined) {
    const { config, pointers, capability, runtimeStateNote, adapterRuntime, identityLock, busyPolicy, queueDepth } = data.discord;
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
            kv("Busy policy", busyPolicy),
            kv("Queue depth", String(queueDepth)),
            kv("Identity lock", channelLockLabel(identityLock)),
            ...buildChannelRuntimeEntries(runtimeStateNote, adapterRuntime),
          ],
        }),
        buildCapabilitiesBlock(capability),
        buildSurfacePointersBlock(pointers),
      ],
    });
  }

  if (data.channel === "email" && data.email !== undefined) {
    const { config, pointers, capability, runtimeStateNote, adapterRuntime, identityLock, busyPolicy, queueDepth } = data.email;
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
            kv("Busy policy", busyPolicy),
            kv("Queue depth", String(queueDepth)),
            kv("Identity lock", channelLockLabel(identityLock)),
            ...buildChannelRuntimeEntries(runtimeStateNote, adapterRuntime),
          ],
        }),
        buildCapabilitiesBlock(capability),
        buildSurfacePointersBlock(pointers),
      ],
    });
  }

  if (data.channel === "whatsapp" && data.whatsapp !== undefined) {
    const { diag, config, pointers, capability, runtimeStateNote, adapterRuntime, identityLock, busyPolicy, queueDepth } = data.whatsapp;
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
            kv("Busy policy", busyPolicy),
            kv("Queue depth", String(queueDepth)),
            kv("Identity lock", channelLockLabel(identityLock)),
            ...buildChannelRuntimeEntries(runtimeStateNote, adapterRuntime),
          ],
        }),
        buildCapabilitiesBlock(capability),
        buildSurfacePointersBlock(pointers),
      ],
    });
  }

  return buildPlainFallbackViewModel({
    lines: [`Unknown channel: ${data.channel}. Supported: telegram, discord, email, whatsapp.`],
  });
}

// ─────────────────────────────────────────────────────────────
// Capability Helpers
// ─────────────────────────────────────────────────────────────

function buildCapabilitiesBlock(capability: AdapterCapability): ViewModel {
  const entries: KeyValueEntry[] = [
    kv("Enabled", capability.enabled ? "yes" : "no"),
    kv("Configured", capability.configured ? "yes" : "no"),
    kv("Missing config", capability.missingConfig?.join(", ") ?? "none"),
    kv("Inbound mode", capability.inboundMode),
    kv("Outbound mode", capability.outboundMode),
    kv("Supports attachments", capability.supportsAttachments ? "yes" : "no"),
    kv("Supports threads", capability.supportsThreads ? "yes" : "no"),
    kv("Supports approvals", capability.supportsApprovals ? "yes" : "no"),
    kv("Supports progress streaming", capability.supportsProgressStreaming ? "yes" : "no"),
    kv("Experimental", capability.experimental ? "yes" : "no"),
    kv("Implementation status", capability.implementationStatus),
  ];
  return buildKeyValueBlockViewModel({ title: "Capabilities", entries });
}

function buildCapabilitiesTable(capabilities: readonly AdapterCapability[]): ViewModel {
  return buildTableViewModel({
    title: "Capabilities",
    columns: [
      { key: "kind", header: "Channel" },
      { key: "enabled", header: "Enabled" },
      { key: "configured", header: "Configured" },
      { key: "inboundMode", header: "Inbound" },
      { key: "outboundMode", header: "Outbound" },
      { key: "supportsAttachments", header: "Attachments" },
      { key: "supportsThreads", header: "Threads" },
      { key: "experimental", header: "Experimental" },
      { key: "implementationStatus", header: "Status" },
    ],
    rows: capabilities.map((c) => ({
      kind: c.kind,
      enabled: c.enabled ? "yes" : "no",
      configured: c.configured ? "yes" : "no",
      inboundMode: c.inboundMode,
      outboundMode: c.outboundMode,
      supportsAttachments: c.supportsAttachments ? "yes" : "no",
      supportsThreads: c.supportsThreads ? "yes" : "no",
      experimental: c.experimental ? "yes" : "no",
      implementationStatus: c.implementationStatus,
    })),
  });
}

// ─────────────────────────────────────────────────────────────────
// Runtime Cache Blocks
// ─────────────────────────────────────────────────────────────────

function buildRuntimeCacheBlock(state: RuntimeCacheState | undefined): ViewModel | undefined {
  if (state === undefined) return undefined;
  const s = state.cacheStats;
  return buildKeyValueBlockViewModel({
    title: "Runtime Cache",
    entries: [
      kv("Entries", s.totalEntries),
      kv("Active borrows", s.activeBorrows),
      kv("Suspended", s.suspendedEntries),
      kv("Created", s.totalCreated),
      kv("Reused", s.totalReused),
      kv("Disposed", s.totalDisposed),
      kv("Invalidated", s.totalInvalidated),
    ],
  });
}

function buildActiveTurnsBlock(state: RuntimeCacheState | undefined): ViewModel | undefined {
  if (state === undefined) return undefined;
  const s = state.registryStats;
  return buildKeyValueBlockViewModel({
    title: "Active Turns",
    entries: [
      kv("Active turns", s.activeTurnCount),
      kv("Started", s.totalStarted),
      kv("Ended", s.totalEnded),
      kv("Aborted", s.totalAborted),
      kv("Stuck turns", s.stuckTurnCount),
      kv("Repeat stuck", s.repeatStuckCount),
    ],
  });
}

function buildSuspendedSessionsBlock(state: RuntimeCacheState | undefined): ViewModel | undefined {
  if (state === undefined) return undefined;
  if (state.suspendedSummary.length === 0) return undefined;
  return buildListViewModel({
    title: "Suspended Sessions",
    items: state.suspendedSummary.map((e) =>
      listItem(`${e.sessionId} — ${e.reason} at ${e.suspendedAt}`)
    ),
  });
}

function buildStuckTurnHistoryBlock(state: RuntimeCacheState | undefined): ViewModel | undefined {
  if (state === undefined) return undefined;
  if (state.stuckTurnHistory.length === 0) return undefined;
  return buildListViewModel({
    title: "Stuck Turn History",
    items: state.stuckTurnHistory.map((t) => {
      const abortLabel = t.wasAborted ? " (aborted)" : "";
      return listItem(`${t.turnId} — ${t.durationMs}ms${abortLabel}`);
    }),
  });
}
