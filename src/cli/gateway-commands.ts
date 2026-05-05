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

export type GatewayCommandOptions = {
  homeDir?: string;
  workspaceRoot: string;
  userConfigPath?: string;
  projectConfigPath?: string;
};

export type GatewayRenderer = (viewModel: ViewModel) => string;

// ─────────────────────────────────────────────────────────────
// Gateway Status
// ─────────────────────────────────────────────────────────────

export async function runGatewayStatus(
  options: GatewayCommandOptions,
  renderer: GatewayRenderer = renderPlain
): Promise<{ ok: boolean; output: string }> {
  const config = await loadRuntimeConfig(options);
  const homeDir = options.homeDir ?? process.env.HOME ?? ".estacoda";
  const stateRoot = join(homeDir, ".estacoda");

  const cronStore = new CronStore({ homeDir });
  const cronJobs = await cronStore.list();

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

  const data: GatewayStatusData = {
    channels: config.channels,
    cronJobs: cronJobs.map((j) => ({ status: j.status, name: j.name, nextRunAt: j.nextRunAt })),
    recentCronFailures,
    recentDeliveryErrors,
    surfacePointers,
    approvalCount: allApprovals.length,
    missingConfig,
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
  const config = await loadRuntimeConfig(options);
  const homeDir = options.homeDir ?? process.env.HOME ?? ".estacoda";
  const stateRoot = join(homeDir, ".estacoda");

  const tgDiag = await getTelegramGatewayDiagnostics(options);
  const waDiag = await getWhatsAppGatewayDiagnostics({ homeDir });

  const cronStore = new CronStore({ homeDir });
  const cronJobs = await cronStore.list();
  const jobsFileReadable = await isReadable(cronStore.path);
  const outputDirWritable = await isWritable(join(stateRoot, "cron", "output"));
  const lockDirWritable = await isWritable(join(stateRoot, "cron", "locks"));

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
  };

  const viewModel = buildGatewayDiagnoseViewModel(data);
  return { ok: viewModel.ok, output: renderer(viewModel) };
}

// ─────────────────────────────────────────────────────────────
// Channels List
// ─────────────────────────────────────────────────────────────

export async function runChannelsList(
  options: GatewayCommandOptions,
  renderer: GatewayRenderer = renderPlain
): Promise<{ ok: boolean; output: string }> {
  const config = await loadRuntimeConfig(options);

  const viewModel = buildChannelsListViewModel({ channels: config.channels });
  return { ok: true, output: renderer(viewModel) };
}

// ─────────────────────────────────────────────────────────────
// Channels Status
// ─────────────────────────────────────────────────────────────

export async function runChannelsStatus(
  options: GatewayCommandOptions & { channel?: string },
  renderer: GatewayRenderer = renderPlain
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

    const data: ChannelsStatusData = {
      channel: "telegram",
      telegram: { diag: tgDiag, pointers: tgPointers },
    };
    const viewModel = buildChannelsStatusViewModel(data);
    return { ok: viewModel.kind !== "plainFallback", output: renderer(viewModel) };
  }

  if (channel === "discord") {
    const dcPointers = surfacePointers.filter((p) => p.surfaceType === "discord");

    const data: ChannelsStatusData = {
      channel: "discord",
      discord: { config: config.channels.discord, pointers: dcPointers },
    };
    const viewModel = buildChannelsStatusViewModel(data);
    return { ok: true, output: renderer(viewModel) };
  }

  if (channel === "email") {
    const emPointers = surfacePointers.filter((p) => p.surfaceType === "email");

    const data: ChannelsStatusData = {
      channel: "email",
      email: { config: config.channels.email, pointers: emPointers },
    };
    const viewModel = buildChannelsStatusViewModel(data);
    return { ok: true, output: renderer(viewModel) };
  }

  if (channel === "whatsapp") {
    const waDiag = await getWhatsAppGatewayDiagnostics({ homeDir });
    const waPointers = surfacePointers.filter((p) => p.surfaceType === "whatsapp");

    const data: ChannelsStatusData = {
      channel: "whatsapp",
      whatsapp: { diag: waDiag, config: config.channels.whatsapp, pointers: waPointers },
    };
    const viewModel = buildChannelsStatusViewModel(data);
    return { ok: true, output: renderer(viewModel) };
  }

  const viewModel = buildChannelsStatusViewModel({ channel: options.channel ?? "unknown" });
  return { ok: false, output: renderer(viewModel) };
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

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
