import { resolveHomeDir, resolveOsHomeDir } from "../config/home-dir.js";
import { defaultProfileId, readActiveProfile } from "../config/profile-home.js";
import { loadRuntimeConfig, type LoadedRuntimeConfig } from "../config/runtime-config.js";
import type { Prompt } from "../cli/readline-prompt.js";
import {
  installService,
  probeServiceState,
  startService,
  type ServiceManagerState,
} from "../gateway/service-manager.js";
import { promptSetupChoice, setupPromptContext } from "./setup-prompts.js";
import type { SetupCopyLocale } from "./setup-copy.js";
import type { SetupReviewManifest } from "./setup-review-manifest.js";

type GatewayActivationChannelId = "telegram" | "discord" | "whatsapp";

type GatewayActivationChannel = {
  readonly id: GatewayActivationChannelId;
  readonly label: "Telegram" | "Discord" | "WhatsApp";
};

export type GatewayActivationServiceActions = {
  readonly probe: typeof probeServiceState;
  readonly install: typeof installService;
  readonly start: typeof startService;
};

export type GatewayServiceActivationResult =
  | {
      readonly kind: "not-offered";
      readonly reason: "readiness-gate-blocked" | "no-ready-new-channel";
    }
  | {
      readonly kind: "declined";
      readonly channels: readonly GatewayActivationChannel[];
      readonly output: string;
    }
  | {
      readonly kind: "started";
      readonly channels: readonly GatewayActivationChannel[];
      readonly installed: boolean;
      readonly output: string;
    }
  | {
      readonly kind: "failed";
      readonly channels: readonly GatewayActivationChannel[];
      readonly phase: "install" | "start";
      readonly output: string;
    };

export type GatewayServiceActivationOptions = {
  readonly prompt: Prompt;
  readonly locale: SetupCopyLocale;
  readonly homeDir?: string;
  readonly workspaceRoot: string;
  readonly profileId?: string;
  readonly reviewManifest: SetupReviewManifest;
  readonly readinessGate: boolean;
  readonly serviceActions?: GatewayActivationServiceActions;
};

const CHANNELS: readonly GatewayActivationChannel[] = [
  { id: "telegram", label: "Telegram" },
  { id: "discord", label: "Discord" },
  { id: "whatsapp", label: "WhatsApp" },
];

export const gatewayServiceActivationPromptTitle =
  "Would you like to install and start the EstaCoda gateway service now?";

export const gatewayServiceActivationNotNowGuidance =
  "Run estacoda gateway install then estacoda gateway start when you are ready.";

const defaultServiceActions: GatewayActivationServiceActions = {
  probe: probeServiceState,
  install: installService,
  start: startService,
};

export async function maybeOfferGatewayStartAfterChannelSetup(
  options: GatewayServiceActivationOptions
): Promise<GatewayServiceActivationResult> {
  if (!options.readinessGate) {
    return { kind: "not-offered", reason: "readiness-gate-blocked" };
  }

  const loaded = await loadRuntimeConfig(options);
  const channels = readyNewlyConfiguredChannels(options.reviewManifest, loaded);
  if (channels.length === 0) {
    return { kind: "not-offered", reason: "no-ready-new-channel" };
  }

  const channelList = formatChannelList(channels);
  const accepted = await promptSetupChoice(setupPromptContext(options.prompt, options.locale), {
    title: gatewayServiceActivationPromptTitle,
    message: [
      gatewayServiceActivationPromptTitle,
      `This will enable your configured ${channelList} ${channels.length === 1 ? "channel" : "channels"}.`,
      "",
    ].join("\n"),
    choices: [
      {
        id: "yes",
        label: "Yes",
        value: true,
      },
      {
        id: "not-now",
        label: "Not now",
        description: gatewayServiceActivationNotNowGuidance,
        value: false,
      },
    ],
    defaultValue: false,
  });

  if (!accepted) {
    return {
      kind: "declined",
      channels,
      output: gatewayServiceActivationNotNowGuidance,
    };
  }

  return installAndStartGatewayService(options, channels);
}

async function installAndStartGatewayService(
  options: GatewayServiceActivationOptions,
  channels: readonly GatewayActivationChannel[]
): Promise<GatewayServiceActivationResult> {
  const actions = options.serviceActions ?? defaultServiceActions;
  const stateHomeDir = resolveHomeDir(options.homeDir);
  const serviceUserHomeDir = resolveOsHomeDir();
  const profileId = options.profileId ?? readActiveProfile({ homeDir: stateHomeDir }).profileId ?? defaultProfileId();

  const existing = await actions.probe({
    serviceUserHomeDir,
    profileId,
  });
  if (existing.installed) {
    const start = await actions.start({
      serviceUserHomeDir,
      profileId,
    });
    if (!start.ok) {
      return {
        kind: "failed",
        channels,
        phase: "start",
        output: `Gateway service start failed: ${start.error}`,
      };
    }
    return {
      kind: "started",
      channels,
      installed: false,
      output: `Gateway service started for configured ${formatChannelList(channels)} ${channels.length === 1 ? "channel" : "channels"}.`,
    };
  }

  const install = await actions.install({
    stateHomeDir,
    serviceUserHomeDir,
    workspaceRoot: options.workspaceRoot,
    profileId,
  });
  if (!install.ok) {
    return {
      kind: "failed",
      channels,
      phase: "install",
      output: `Gateway service install failed: ${install.error}`,
    };
  }

  const postInstall = await actions.probe({
    serviceUserHomeDir,
    profileId,
  });
  if (serviceNeedsStart(postInstall)) {
    const start = await actions.start({
      serviceUserHomeDir,
      profileId,
    });
    if (!start.ok) {
      return {
        kind: "failed",
        channels,
        phase: "start",
        output: `Gateway service start failed: ${start.error}`,
      };
    }
  }

  return {
    kind: "started",
    channels,
    installed: true,
    output: `Gateway service installed and started for configured ${formatChannelList(channels)} ${channels.length === 1 ? "channel" : "channels"}.`,
  };
}

function readyNewlyConfiguredChannels(
  reviewManifest: SetupReviewManifest,
  loaded: LoadedRuntimeConfig
): readonly GatewayActivationChannel[] {
  return CHANNELS.filter((channel) =>
    reviewManifestHasChannelSetup(reviewManifest, channel.id) &&
    runtimeChannelIsReady(loaded, channel.id)
  );
}

function reviewManifestHasChannelSetup(
  reviewManifest: SetupReviewManifest,
  channelId: GatewayActivationChannelId
): boolean {
  return reviewManifest.sections["remote-control-surfaces"].some((line) =>
    line.blockers.length === 0 &&
    (
      line.sourceDraftIds.some((sourceDraftId) => sourceDraftId === `setup-module.${channelId}.capability`) ||
      line.copyKey === `setupModules.${channelId}.review`
    )
  );
}

function runtimeChannelIsReady(
  loaded: LoadedRuntimeConfig,
  channelId: GatewayActivationChannelId
): boolean {
  switch (channelId) {
    case "telegram": {
      const telegram = loaded.channels.telegram;
      return telegram.ready === true &&
        (telegram.allowedUserIds?.length ?? 0) + (telegram.allowedChatIds?.length ?? 0) > 0 &&
        envReferenceIsPresent(telegram.botTokenEnv);
    }
    case "discord": {
      const discord = loaded.channels.discord;
      return discord.ready === true &&
        (discord.allowedUsers?.length ?? 0) + (discord.allowedChannels?.length ?? 0) > 0 &&
        envReferenceIsPresent(discord.botTokenEnv);
    }
    case "whatsapp": {
      const whatsapp = loaded.channels.whatsapp;
      return whatsapp.ready === true &&
        whatsapp.experimental === true &&
        whatsapp.authDir !== undefined &&
        (whatsapp.allowedUsers?.length ?? 0) > 0;
    }
  }
}

function envReferenceIsPresent(envVarName: string | undefined): boolean {
  return envVarName !== undefined && process.env[envVarName] !== undefined;
}

function serviceNeedsStart(state: ServiceManagerState): boolean {
  return !state.installed || state.activeState !== "active";
}

function formatChannelList(channels: readonly GatewayActivationChannel[]): string {
  const labels = channels.map((channel) => channel.label);
  if (labels.length <= 2) return labels.join(" and ");
  return `${labels.slice(0, -1).join(", ")}, and ${labels[labels.length - 1]}`;
}
