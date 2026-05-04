import { join } from "node:path";
import { access, constants } from "node:fs/promises";
import { Database } from "bun:sqlite";
import { loadRuntimeConfig } from "../config/runtime-config.js";
import { getTelegramGatewayDiagnostics } from "../channels/gateway-runner.js";
import { getWhatsAppGatewayDiagnostics } from "../channels/whatsapp-diagnostics.js";
import { CronStore } from "../cron/cron-store.js";
import { CronExecutionStore } from "../cron/cron-execution-store.js";
import { ChannelApprovalStore } from "../channels/channel-approval-store.js";
import { FileSurfacePointerStore } from "../channels/surface-pointer-store.js";
import { DeliveryRouter } from "../channels/delivery-router.js";
import type { LoadedRuntimeConfig } from "../config/runtime-config.js";

export type GatewayCommandOptions = {
  homeDir?: string;
  workspaceRoot: string;
  userConfigPath?: string;
  projectConfigPath?: string;
};

export async function runGatewayStatus(options: GatewayCommandOptions): Promise<{ ok: boolean; output: string }> {
  const config = await loadRuntimeConfig(options);
  const homeDir = options.homeDir ?? process.env.HOME ?? ".estacoda";
  const stateRoot = join(homeDir, ".estacoda");

  const cronStore = new CronStore({ homeDir });
  const cronJobs = await cronStore.list();
  const activeCronJobs = cronJobs.filter((j) => j.status === "active");
  const nextDue = activeCronJobs
    .filter((j) => j.nextRunAt !== undefined)
    .sort((a, b) => new Date(a.nextRunAt!).getTime() - new Date(b.nextRunAt!).getTime())[0];

  let executionStore: CronExecutionStore | undefined;
  try {
    const dbPath = join(stateRoot, "sessions.sqlite");
    const db = new Database(dbPath);
    executionStore = new CronExecutionStore(db);
  } catch { /* ignore */ }

  let recentCronFailures: Awaited<ReturnType<CronExecutionStore["recentFailures"]>> = [];
  if (executionStore !== undefined) {
    try {
      recentCronFailures = await executionStore.recentFailures(5);
    } catch { /* table may not exist */ }
  }

  const deliveryRouter = new DeliveryRouter({ homeDir });
  const recentDeliveryErrors = await deliveryRouter.getRecentErrors(5);

  const surfacePointerStore = new FileSurfacePointerStore({ path: join(stateRoot, "surface-pointers.json") });
  const surfacePointers = await surfacePointerStore.listPointers();

  const approvalStore = new ChannelApprovalStore({ path: join(stateRoot, "channel-approvals.json") });
  const allApprovals = await approvalStore.listAll();

  const lines = [
    "EstaCoda gateway status",
    "",
    "Process",
    "  Status: CLI view (no live gateway process in this shell)",
    "",
    "Channels",
    channelLine("Telegram", config.channels.telegram),
    channelLine("Discord", config.channels.discord),
    channelLine("Email", config.channels.email),
    channelLine("WhatsApp", config.channels.whatsapp),
    "",
    "DeliveryRouter platforms",
    ...deliveryPlatforms(config),
    "",
    "Surface pointers",
    ...renderSurfacePointers(surfacePointers),
    "",
    "Pending approvals",
    `  Total grants: ${allApprovals.length}`,
    "",
    "Cron",
    `  Jobs: ${cronJobs.length} total, ${activeCronJobs.length} active`,
    nextDue === undefined ? "  Next due: none" : `  Next due: ${nextDue.name} at ${nextDue.nextRunAt}`,
    "",
    "Recent cron failures (last 5)",
    ...renderCronFailures(recentCronFailures),
    "",
    "Recent delivery errors (last 5)",
    ...renderDeliveryErrors(recentDeliveryErrors),
    "",
    "Missing config",
    ...renderMissing(config)
  ];

  return { ok: true, output: lines.join("\n") };
}

export async function runGatewayDiagnose(options: GatewayCommandOptions): Promise<{ ok: boolean; output: string }> {
  const config = await loadRuntimeConfig(options);
  const homeDir = options.homeDir ?? process.env.HOME ?? ".estacoda";
  const stateRoot = join(homeDir, ".estacoda");

  const lines = [
    "EstaCoda gateway diagnose",
    ""
  ];

  let allOk = true;

  // Telegram
  const tgDiag = await getTelegramGatewayDiagnostics(options);
  lines.push("Telegram", `  Enabled: ${tgDiag.enabled ? "yes" : "no"}`);
  if (tgDiag.enabled) {
    lines.push(`  Ready: ${tgDiag.ready ? "yes" : "no"}`);
    lines.push(`  Token present: ${tgDiag.botTokenPresent ? "yes" : "no"}`);
    if (!tgDiag.botTokenPresent) {
      lines.push(`  Warning: missing env ${tgDiag.botTokenEnv ?? "(unset)"}`);
      allOk = false;
    }
    if (tgDiag.allowedUserIds.length === 0 && tgDiag.allowedChatIds.length === 0) {
      lines.push("  Warning: no allowed users or chats configured");
      allOk = false;
    }
  }
  lines.push("");

  // Discord
  const discord = config.channels.discord;
  lines.push("Discord", `  Enabled: ${discord.enabled ? "yes" : "no"}`);
  if (discord.enabled) {
    const tokenPresent = discord.botTokenEnv !== undefined && process.env[discord.botTokenEnv] !== undefined;
    lines.push(`  Token present: ${tokenPresent ? "yes" : "no"}`);
    if (!tokenPresent) {
      lines.push(`  Warning: missing env ${discord.botTokenEnv ?? "(unset)"}`);
      allOk = false;
    }
  }
  lines.push("");

  // Email
  const email = config.channels.email;
  lines.push("Email", `  Enabled: ${email.enabled ? "yes" : "no"}`);
  if (email.enabled) {
    const passwordPresent = email.passwordEnv !== undefined && process.env[email.passwordEnv] !== undefined;
    lines.push(`  IMAP host: ${email.imapHost ?? "(unset)"}`);
    lines.push(`  SMTP host: ${email.smtpHost ?? "(unset)"}`);
    lines.push(`  Username: ${email.username ?? "(unset)"}`);
    lines.push(`  Password present: ${passwordPresent ? "yes" : "no"}`);
    if (!passwordPresent) {
      lines.push(`  Warning: missing env ${email.passwordEnv ?? "(unset)"}`);
      allOk = false;
    }
    lines.push(`  Home address: ${email.homeAddress ?? "(unset)"}`);
    lines.push(`  Own address: ${email.ownAddress ?? "(unset)"}`);
    if (email.ownAddress === undefined) {
      lines.push("  Warning: ownAddress not configured");
      allOk = false;
    }
  }
  lines.push("");

  // WhatsApp
  const waDiag = await getWhatsAppGatewayDiagnostics({ homeDir });
  lines.push("WhatsApp", `  Enabled: ${waDiag.enabled ? "yes" : "no"}`);
  lines.push(`  Experimental gate: ${config.channels.whatsapp.experimental ? "open" : "closed"}`);
  if (config.channels.whatsapp.experimental) {
    lines.push(`  Baileys available: ${waDiag.baileysAvailable ? "yes" : "no"}`);
    lines.push(`  Auth dir writable: ${waDiag.authDirWritable ? "yes" : "no"}`);
    if (!waDiag.baileysAvailable) {
      lines.push("  Warning: @whiskeysockets/baileys not installed");
      allOk = false;
    }
  }
  lines.push("");

  // Cron
  const cronStore = new CronStore({ homeDir });
  const cronJobs = await cronStore.list();
  const jobsFileReadable = await isReadable(cronStore.path);
  const outputDirWritable = await isWritable(join(stateRoot, "cron", "output"));
  const lockDirWritable = await isWritable(join(stateRoot, "cron", "locks"));
  lines.push("Cron");
  lines.push(`  Jobs: ${cronJobs.length}`);
  lines.push(`  Jobs file readable: ${jobsFileReadable ? "yes" : "no"}`);
  lines.push(`  Output dir writable: ${outputDirWritable ? "yes" : "no"}`);
  lines.push(`  Lock dir writable: ${lockDirWritable ? "yes" : "no"}`);
  if (!jobsFileReadable) {
    lines.push("  Warning: jobs file not readable");
    allOk = false;
  }
  if (!outputDirWritable) {
    lines.push("  Warning: output directory not writable");
    allOk = false;
  }
  if (!lockDirWritable) {
    lines.push("  Warning: lock directory not writable");
    allOk = false;
  }

  return { ok: allOk, output: lines.join("\n") };
}

export async function runChannelsList(options: GatewayCommandOptions): Promise<{ ok: boolean; output: string }> {
  const config = await loadRuntimeConfig(options);

  const lines = [
    "EstaCoda channels",
    "",
    compactChannelLine("telegram", config.channels.telegram),
    compactChannelLine("discord", config.channels.discord),
    compactChannelLine("email", config.channels.email),
    compactChannelLine("whatsapp", config.channels.whatsapp),
  ];

  return { ok: true, output: lines.join("\n") };
}

export async function runChannelsStatus(
  options: GatewayCommandOptions & { channel?: string }
): Promise<{ ok: boolean; output: string }> {
  const config = await loadRuntimeConfig(options);
  const homeDir = options.homeDir ?? process.env.HOME ?? ".estacoda";
  const stateRoot = join(homeDir, ".estacoda");

  const surfacePointerStore = new FileSurfacePointerStore({ path: join(stateRoot, "surface-pointers.json") });
  const surfacePointers = await surfacePointerStore.listPointers();

  const channel = options.channel?.toLowerCase();

  if (channel === undefined || channel === "telegram") {
    const tgDiag = await getTelegramGatewayDiagnostics(options);
    const tgPointers = surfacePointers.filter((p) => p.surfaceType === "telegram");

    const lines = [
      "Telegram channel status",
      `  Enabled: ${tgDiag.enabled ? "yes" : "no"}`,
      `  Ready: ${tgDiag.ready ? "yes" : "no"}`,
      `  Status: ${tgDiag.statusLabel}`,
      `  Token env: ${tgDiag.botTokenEnv ?? "(unset)"}`,
      `  Token present: ${tgDiag.botTokenPresent ? "yes" : "no"}`,
      `  Default chat: ${tgDiag.defaultChatId ?? "(unset)"}`,
      `  Security: ${tgDiag.securityLabel}`,
      `  Allowed users: ${tgDiag.allowedUserIds.join(", ") || "none"}`,
      `  Allowed chats: ${tgDiag.allowedChatIds.join(", ") || "none"}`,
      `  Group sessions per user: ${tgDiag.groupSessionsPerUser ? "yes" : "no"}`,
      `  Thread sessions per user: ${tgDiag.threadSessionsPerUser ? "yes" : "no"}`,
      `  Session reset policy: ${tgDiag.sessionResetPolicy}`,
      tgDiag.sessionIdleResetMinutes === undefined ? undefined : `  Session idle reset: ${tgDiag.sessionIdleResetMinutes} min`,
      "",
      "  Surface pointers",
      ...tgPointers.map((p) => `    ${p.surfaceId} → ${p.record.sessionId} (since ${p.record.attachedAt})`),
      tgPointers.length === 0 ? "    none" : undefined,
    ].filter((line) => line !== undefined);

    return { ok: true, output: lines.join("\n") };
  }

  if (channel === "discord") {
    const discord = config.channels.discord;
    const dcPointers = surfacePointers.filter((p) => p.surfaceType === "discord");
    const tokenPresent = discord.botTokenEnv !== undefined && process.env[discord.botTokenEnv] !== undefined;

    const lines = [
      "Discord channel status",
      `  Enabled: ${discord.enabled ? "yes" : "no"}`,
      `  Ready: ${discord.ready ? "yes" : "no"}`,
      `  Token env: ${discord.botTokenEnv ?? "(unset)"}`,
      `  Token present: ${tokenPresent ? "yes" : "no"}`,
      `  Allowed users: ${(discord.allowedUsers ?? []).join(", ") || "none"}`,
      `  Allowed guilds: ${(discord.allowedGuilds ?? []).join(", ") || "none"}`,
      `  Allowed channels: ${(discord.allowedChannels ?? []).join(", ") || "none"}`,
      "",
      "  Surface pointers",
      ...dcPointers.map((p) => `    ${p.surfaceId} → ${p.record.sessionId} (since ${p.record.attachedAt})`),
      dcPointers.length === 0 ? "    none" : undefined,
    ].filter((line) => line !== undefined);

    return { ok: true, output: lines.join("\n") };
  }

  if (channel === "email") {
    const email = config.channels.email;
    const emPointers = surfacePointers.filter((p) => p.surfaceType === "email");
    const passwordPresent = email.passwordEnv !== undefined && process.env[email.passwordEnv] !== undefined;

    const lines = [
      "Email channel status",
      `  Enabled: ${email.enabled ? "yes" : "no"}`,
      `  Ready: ${email.ready ? "yes" : "no"}`,
      `  IMAP: ${email.imapHost ?? "(unset)"}:${email.imapPort ?? "(default)"}`,
      `  SMTP: ${email.smtpHost ?? "(unset)"}:${email.smtpPort ?? "(default)"}`,
      `  Username: ${email.username ?? "(unset)"}`,
      `  Password present: ${passwordPresent ? "yes" : "no"}`,
      `  Own address: ${email.ownAddress ?? "(unset)"}`,
      `  Home address: ${email.homeAddress ?? "(unset)"}`,
      `  Allowed senders: ${(email.allowedSenders ?? []).join(", ") || "none"}`,
      `  Allow all users: ${email.allowAllUsers ? "yes" : "no"}`,
      "",
      "  Surface pointers",
      ...emPointers.map((p) => `    ${p.surfaceId} → ${p.record.sessionId} (since ${p.record.attachedAt})`),
      emPointers.length === 0 ? "    none" : undefined,
    ].filter((line) => line !== undefined);

    return { ok: true, output: lines.join("\n") };
  }

  if (channel === "whatsapp") {
    const waDiag = await getWhatsAppGatewayDiagnostics({ homeDir });
    const wa = config.channels.whatsapp;
    const waPointers = surfacePointers.filter((p) => p.surfaceType === "whatsapp");

    const lines = [
      "WhatsApp channel status",
      `  Enabled: ${wa.enabled ? "yes" : "no"}`,
      `  Experimental gate: ${wa.experimental ? "open" : "closed"}`,
      `  Ready: ${waDiag.ready ? "yes" : "no"}`,
      `  Status: ${waDiag.statusLabel}`,
      `  Baileys available: ${waDiag.baileysAvailable ? "yes" : "no"}`,
      `  Auth dir: ${waDiag.authDir}`,
      `  Auth dir writable: ${waDiag.authDirWritable ? "yes" : "no"}`,
      `  Allowed users: ${(wa.allowedUsers ?? []).join(", ") || "none"}`,
      `  Pairing mode: ${wa.pairingMode ?? "qr"}`,
      "",
      "  Surface pointers",
      ...waPointers.map((p) => `    ${p.surfaceId} → ${p.record.sessionId} (since ${p.record.attachedAt})`),
      waPointers.length === 0 ? "    none" : undefined,
    ].filter((line) => line !== undefined);

    return { ok: true, output: lines.join("\n") };
  }

  return {
    ok: false,
    output: `Unknown channel: ${options.channel}. Supported: telegram, discord, email, whatsapp.`
  };
}

function channelLine(
  name: string,
  channel: LoadedRuntimeConfig["channels"]["telegram"]
): string {
  const status = channel.ready ? "ready" : channel.enabled ? "configured, missing credentials" : "disabled";
  const missing = channel.missing !== undefined && channel.missing.length > 0 ? ` (missing: ${channel.missing.join(", ")})` : "";
  return `  ${name}: ${status}${missing}`;
}

function compactChannelLine(
  name: string,
  channel: LoadedRuntimeConfig["channels"]["telegram"]
): string {
  const status = channel.ready ? "ready" : channel.enabled ? "not ready" : "disabled";
  return `  ${name.padEnd(10)} ${status}`;
}

function deliveryPlatforms(config: LoadedRuntimeConfig): string[] {
  const platforms: string[] = [];
  if (config.channels.telegram.enabled) platforms.push("telegram");
  if (config.channels.discord.enabled) platforms.push("discord");
  if (config.channels.email.enabled) platforms.push("email");
  if (config.channels.whatsapp.enabled && config.channels.whatsapp.experimental) platforms.push("whatsapp");
  if (platforms.length === 0) return ["  none configured"];
  return platforms.map((p) => `  ${p}`);
}

function renderSurfacePointers(
  pointers: Awaited<ReturnType<FileSurfacePointerStore["listPointers"]>>
): string[] {
  if (pointers.length === 0) return ["  none"];
  return pointers.map((p) => {
    const home = p.record.homeDelivery !== undefined ? ` home=${p.record.homeDelivery}` : "";
    return `  ${p.surfaceType}:${p.surfaceId} → ${p.record.sessionId} (since ${p.record.attachedAt})${home}`;
  });
}

function renderCronFailures(
  failures: Awaited<ReturnType<CronExecutionStore["recentFailures"]>>
): string[] {
  if (failures.length === 0) return ["  none"];
  return failures.map((f) => {
    const msg = f.failureMessage !== undefined ? ` — ${f.failureMessage}` : "";
    return `  ${f.jobId} [${f.status}] ${f.startedAt}${msg}`;
  });
}

function renderDeliveryErrors(
  errors: Awaited<ReturnType<DeliveryRouter["getRecentErrors"]>>
): string[] {
  if (errors.length === 0) return ["  none"];
  return errors.map((e) => `  ${e.timestamp} ${e.target}: ${e.error}`);
}

function renderMissing(config: LoadedRuntimeConfig): string[] {
  const missing: string[] = [];
  if (config.channels.telegram.missing !== undefined) missing.push(...config.channels.telegram.missing.map((m) => `  telegram: ${m}`));
  if (config.channels.discord.missing !== undefined) missing.push(...config.channels.discord.missing.map((m) => `  discord: ${m}`));
  if (config.channels.email.missing !== undefined) missing.push(...config.channels.email.missing.map((m) => `  email: ${m}`));
  if (config.channels.whatsapp.missing !== undefined) missing.push(...config.channels.whatsapp.missing.map((m) => `  whatsapp: ${m}`));
  if (missing.length === 0) return ["  none"];
  return missing;
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
