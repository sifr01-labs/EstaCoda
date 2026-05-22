import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createTelegramPairingCode,
  loadRuntimeConfig,
  setupMcpConfig,
  setupBrowserConfig,
  setupImageGenerationConfig,
  setupProviderConfig,
  setupProfileConfig,
  setupSecurityConfig,
  setupSkillConfig,
  setupTelegramConfig,
  setupUiConfig,
  setupVoiceConfig,
  setupWebConfig,
  setupModelFallbackConfig,
  removeModelFallbackConfig,
  reorderModelFallbackConfig,
  clearModelFallbackConfig,
  type AgentProfileMode,
  type AgentResponseLanguage,
  type BrowserSetupInput,
  type ImageGenerationSetupInput,
  type ImageGenerationProvider,
  type ActivityLabelsLocale,
  type MCPSetupInput,
  type ModelFallbackConfig,
  type ProviderSetupInput,
  type SecuritySetupInput,
  type TelegramSetupInput,
  type TtsProvider,
  type UiFlavor,
  type UiLanguage,
  type VoiceSetupInput,
  type WebSetupInput
} from "../config/runtime-config.js";
import { canRunInteractive, createReadlinePrompt, type Prompt } from "./readline-prompt.js";
import { runFirstRunSetup } from "../onboarding/first-run/runner.js";
import { runConfigEditorSetup } from "../onboarding/config-editor/runner.js";
import { createReviewedSetupApplyExecutor } from "../onboarding/review/apply-executor.js";
import { collectSetupEntryState } from "../onboarding/setup-entry-state.js";
import { collectSetupRoute } from "../onboarding/setup-router.js";
import { renderSetupRouteSummary } from "../onboarding/setup-state-renderer.js";
import { runSetupVerification } from "../onboarding/verification.js";
import type { ToolDefinition } from "../contracts/tool.js";
import type { FetchLike as ProviderFetchLike } from "../providers/openai-compatible-provider.js";
import type { ImageGenerationFetchLike } from "../tools/image-generation-tools.js";
import { verifyImageGeneration, type ImageGenerationVerification } from "../tools/image-generation-verify.js";
import {
  defaultImageApiKeyEnv,
  defaultImageModel,
  IMAGE_MODEL_OPTIONS,
  resolveImageModel
} from "../contracts/image-generation.js";
import type { ModelProfile, ResolvedAuxiliaryRoute, ProviderId } from "../contracts/provider.js";
import { resolveAllAuxiliaryRoutes } from "../providers/auxiliary-model-resolver.js";
import { getAuxiliaryInFlight, getAuxiliaryQueued } from "../providers/auxiliary-executor.js";
import { runCronCommand } from "../cron/cron-command.js";
import { createRuntimeCronRunner, tickCron } from "../cron/cron-runner.js";
import { CronStore } from "../cron/cron-store.js";
import { CronExecutionStore } from "../cron/cron-execution-store.js";
import { SQLiteSessionDB } from "../session/sqlite-session-db.js";
import { createSQLiteSessionDB } from "../session/session-setup.js";
import { resolveStateHome } from "../config/state-home.js";
import { defaultProfileId, normalizeProfileId, readActiveProfile, resolveProfileStateHome } from "../config/profile-home.js";
import { runSessionsCommand } from "./session-commands.js";
import { runHandoffCommand } from "./handoff-commands.js";
import { createFileCronJobLock } from "../cron/cron-lock.js";
import {
  diagnoseProviderConfig,
  diagnoseProviderLive,
  renderProviderDiagnostic,
  renderProviderLiveDiagnostic
} from "../config/provider-diagnostics.js";
import { runGatewaySupervisor } from "../gateway/supervisor.js";
import type { TelegramFetch } from "../channels/telegram-adapter.js";
import type { Runtime } from "../runtime/create-runtime.js";
import { runAcpServer } from "../acp/server.js";
import type { SkillAutonomy } from "../skills/skill-learning.js";
import { storeCapabilitySecret } from "../setup/capability-setup.js";
import { PackRegistry } from "../packs/pack-registry.js";
import { validatePackManifest } from "../packs/pack-validator.js";
import { trace } from "./trace-commands.js";
import { evalCommand } from "./eval-commands.js";
import { proposalCommand } from "./proposal-commands.js";
import { manifestCommand } from "./manifest-commands.js";
import { curatorCommand } from "./curator-commands.js";
import { knowledge } from "./knowledge-commands.js";
import { evolutionCommand } from "./evolution-commands.js";
import { flowCommand } from "./flow-commands.js";
import { packCommand } from "./pack-commands.js";
import { skillsCommand } from "./skill-commands.js";
import { commandRegistry } from "./command-registry.js";
import { promptForApiKey } from "./secret-prompt.js";
import { createProviderModelSelectionFlow } from "../providers/provider-model-selection-flow.js";
import { normalizeModelInput } from "../providers/model-normalization.js";
import { validateResolvedRouteForModelSwitch } from "../providers/provider-metadata.js";
import { readConfig, saveRuntimeConfig } from "../config/runtime-config.js";
import {
  applyRegisterProviderConfig,
  applyRegisterProviderModel,
  applySetPreferredModelRoute
} from "../config/provider-config-mutations.js";
import {
  renderModelList,
  renderModelSearchResults,
  renderProviderList,
  renderRefreshReport,
  renderModelPickerSuccess,
  renderModelPickerCancellation
} from "./model-renderers.js";
import { toModelRow, toProviderRow, toPickerSuccessSummary } from "./model-view-models.js";
import {
  formatSecurityMode,
  formatSkillAutonomy,
  renderSecurityModeOption,
  renderSkillAutonomyOption,
  type Locale
} from "../ui/settings-labels.js";
import {
  runGatewayStatus,
  runGatewayDiagnose,
  runChannelsList,
  runChannelsStatus,
  runChannelsEnable,
  runChannelsDisable,
  runGatewayStop,
  runGatewayRestart,
  runGatewayStartDryRun,
  runGatewayStartBackground,
  runGatewayApprovals,
  runGatewayInstallService,
  runGatewayUninstallService,
} from "./gateway-commands.js";
import {
  renderSettingsOverview,
  renderSkillsSettings,
  renderSecuritySettings,
  renderBrowserSettings,
  renderTelegramSettings,
  renderUiSettings,
} from "./settings-view-models.js";

import { runVersionCommand } from "./version-command.js";
import { runInitCommand } from "./init-command.js";
import { runUpdateCommand } from "./update-command.js";
import { isBackupReady } from "../lifecycle/state-preservation.js";
import type { ModelsDevRegistryOptions } from "../model-catalog/models-dev-registry.js";
import {
  createModelSelectionCatalog,
  type CatalogListOptions
} from "../providers/model-selection-catalog.js";
import { produceModelStatusReport } from "../diagnostics/model-diagnostics.js";
import {
  runModelSetupLocal,
  runModelSetupCustom,
  probeOpenAIModels,
  type OpenAIModelProbe
} from "./model-setup.js";
import { runModelSetupCodex } from "./model-setup-codex.js";
import { profileCommand } from "./profile-commands.js";
import type { ProfileContextGenerator } from "./profile-state.js";

export type CliCommandResult = {
  handled: boolean;
  exitCode: number;
  output: string;
};

export type CliOptions = {
  argv: string[];
  workspaceRoot: string;
  homeDir?: string;
  profileId?: string;
  interactive?: boolean;
  tools?: ToolDefinition[];
  prompt?: Prompt;
  telegramFetch?: TelegramFetch;
  providerFetch?: ProviderFetchLike;
  imageGenerationFetch?: ImageGenerationFetchLike;
  runtime?: Runtime;
  modelsDevOptions?: ModelsDevRegistryOptions;
  profileContextGenerator?: ProfileContextGenerator;
  output?: { write(chunk: string): void };
};

export type ParsedGlobalCliOptions =
  | { ok: true; argv: string[]; profileId?: string }
  | { ok: false; error: string };

export function parseGlobalCliOptions(argv: readonly string[]): ParsedGlobalCliOptions {
  const nextArgv: string[] = [];
  let profileId: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--profile" || arg === "-p") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("-")) {
        return { ok: false, error: `${arg} requires a profile id.` };
      }
      try {
        profileId = normalizeProfileId(value);
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
      i++;
      continue;
    }
    if (arg.startsWith("--profile=")) {
      const value = arg.slice("--profile=".length);
      try {
        profileId = normalizeProfileId(value);
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
      continue;
    }
    nextArgv.push(arg);
  }

  return profileId === undefined
    ? { ok: true, argv: nextArgv }
    : { ok: true, argv: nextArgv, profileId };
}

export async function runCliCommand(options: CliOptions): Promise<CliCommandResult> {
  const parsedGlobalOptions = parseGlobalCliOptions(options.argv);
  if (!parsedGlobalOptions.ok) {
    return {
      handled: true,
      exitCode: 1,
      output: parsedGlobalOptions.error
    };
  }
  options = {
    ...options,
    argv: parsedGlobalOptions.argv,
    profileId: parsedGlobalOptions.profileId ?? options.profileId
  };
  const [command, ...args] = options.argv;

  switch (command) {
    case "setup":
      return setup(options, args);
    case "web":
      return web(options, args);
    case "browser":
      return browser(options, args);
    case "local":
      return local(options, args);
    case "voice":
      return voice(options, args);
    case "image":
      return image(options, args);
    case "security":
      return security(options, args);
    case "cron":
      return cron(options, args);
    case "mcp":
      return mcp(options, args);
    case "acp":
      return acp(options, args);
    case "telegram":
      return telegram(options, args);
    case "gateway":
      return gateway(options, args);
    case "model":
      return model(options, args);
    case "tools":
      return tools(options);
    case "doctor":
      return doctor(options, args);
    case "verify":
      return verify(options);
    case "settings":
      return settings(options, args);
    case "profile":
      return profileCommand(options, args);
    case "trace":
      return trace(options, args);
    case "flow":
      return flowCommand(options, args);
    case "eval":
      return evalCommand(options, args);
    case "proposal":
      return proposalCommand(options, args);
    case "manifest":
      return manifestCommand(options, args);
    case "curator":
      return curatorCommand(options, args);
    case "evolution":
      return evolutionCommand(options, args);
    case "knowledge":
      return knowledge(options, args);
    case "packs":
      return packCommand(options, args);
    case "skills":
      return skillsCommand(options, args);
    case "handoff":
      return handoff(options, args);
    case "session":
    case "sessions":
      return sessions(options, args);
    case "channels":
      return channels(options, args);
    case "init":
      return init(options, args);
    case "update":
      return update(options, args);
    case "version":
      return version();
    case "help":
    case "--help":
    case "-h":
      return {
        handled: true,
        exitCode: 0,
        output: help()
      };
    default:
      return {
        handled: false,
        exitCode: 0,
        output: ""
      };
  }
}

async function setup(options: CliOptions, args: string[]): Promise<CliCommandResult> {
  if (hasFlag(args, "--help", "-h")) {
    return {
      handled: true,
      exitCode: 0,
      output: renderSetupHelp()
    };
  }

  const parsed = parseSetupArgs(args);
  const allowInteractive = options.interactive !== false;

  if (hasFlag(args, "--interactive", "-i") || (allowInteractive && args.length === 0 && (options.prompt !== undefined || canRunInteractive()))) {
    return interactiveSetup(options, {
      advanced: hasFlag(args, "--advanced")
    });
  }

  const advanced = hasFlag(args, "--advanced");
  if (parsed.provider === undefined || parsed.model === undefined) {
    const decision = await collectSetupRoute(options);
    return {
      handled: true,
      exitCode: 0,
      output: renderSetupRouteSummary({ decision, advanced })
    };
  }

  const result = await setupProviderConfig({
    ...options,
    input: parsed as ProviderSetupInput
  });
  const loaded = await loadRuntimeConfig(options);
  const diagnostic = await diagnoseProviderConfig(loaded);

  return {
    handled: true,
    exitCode: 0,
    output: [
      `Configured ${parsed.provider}/${parsed.model}.`,
      `Config: ${result.path}`,
      result.secretPath === undefined ? undefined : `Secret store: ${result.secretPath}`,
      "",
      "Setup check",
      renderProviderDiagnostic(diagnostic),
      diagnostic.status === "ready"
        ? "Ready: run estacoda and send your first prompt."
        : "Next: fix the warnings above, then run estacoda verify."
    ].filter((line) => line !== undefined).join("\n")
  };
}

async function interactiveSetup(options: CliOptions, input: { readonly advanced: boolean }): Promise<CliCommandResult> {
  const prompt = options.prompt ?? createReadlinePrompt();
  try {
    const decision = await collectSetupRoute(options);
    if (decision.kind === "first-run-onboarding") {
      const result = await runFirstRunSetup({
        ...options,
        prompt,
        applyExecutor: createReviewedSetupApplyExecutor({
          workspaceRoot: options.workspaceRoot,
          homeDir: options.homeDir,
          profileId: options.profileId,
        }),
      });

      return {
        handled: true,
        exitCode: result.exitCode,
        output: result.output,
      };
    }

    if (
      decision.kind === "configured-menu" ||
      decision.kind === "configured-degraded-menu" ||
      decision.kind === "repair-first-menu"
    ) {
      const chunks: string[] = [];
      const result = await runConfigEditorSetup({
        ...options,
        prompt,
        applyExecutor: createReviewedSetupApplyExecutor({
          workspaceRoot: options.workspaceRoot,
          homeDir: options.homeDir,
          profileId: options.profileId,
        }),
        output: {
          write: (value) => chunks.push(value),
        },
      });

      return {
        handled: true,
        exitCode: result.exitCode,
        output: chunks.length > 0 ? chunks.join("") : result.output,
      };
    }

    return {
      handled: true,
      exitCode: 0,
      output: renderSetupRouteSummary({ decision, advanced: input.advanced }),
    };
  } finally {
    if (options.prompt === undefined) {
      prompt.close?.();
    }
  }
}

async function verify(options: CliOptions): Promise<CliCommandResult> {
  const result = await runSetupVerification({
    ...options,
    runtime: options.runtime
  });

  const extraLines: string[] = [];
  const extraWarnings: string[] = [];

  // Config syntax validity
  try {
    await loadRuntimeConfig(options);
    extraLines.push("Config syntax: valid");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    extraWarnings.push(`Config syntax error: ${message}`);
  }

  // State directory backup readiness
  const backupReady = await isBackupReady(options.homeDir ?? process.env.HOME ?? "");
  if (backupReady.ok) {
    extraLines.push("State backup: ready");
  } else {
    extraWarnings.push(`State backup not ready: ${backupReady.reason}`);
  }

  // pack registry validation
  const registry = new PackRegistry({ homeDir: options.homeDir ?? process.env.HOME ?? "" });
  const installedPacks = await registry.list();
  if (installedPacks.length === 0) {
    extraLines.push("pack registry: not initialized");
  } else {
    const validationErrors: string[] = [];
    for (const entry of installedPacks) {
      const v = validatePackManifest(entry.manifest);
      if (!v.ok) {
        validationErrors.push(`${entry.manifest.id} — ${v.errors.join(", ")}`);
      }
    }
    if (validationErrors.length > 0) {
      extraWarnings.push(`pack registry errors:\n${validationErrors.map((e) => `  - ${e}`).join("\n")}`);
    } else {
      extraLines.push(`pack registry: valid (${installedPacks.length} installed)`);
    }
  }

  const ok = result.ok && extraWarnings.length === 0;
  const output = [
    result.output,
    extraLines.length > 0 ? extraLines.join("\n") : undefined,
    extraWarnings.length > 0 ? `Warnings:\n${extraWarnings.map((w) => `- ${w}`).join("\n")}` : undefined
  ].filter((line): line is string => line !== undefined).join("\n");

  return {
    handled: true,
    exitCode: ok ? 0 : 1,
    output
  };
}

async function init(options: CliOptions, args: string[]): Promise<CliCommandResult> {
  const homeFlag = valueAfter(args, "--home");
  const result = await runInitCommand({
    homeDir: homeFlag ?? options.homeDir,
    yes: hasFlag(args, "--yes", "-y")
  });

  return {
    handled: true,
    exitCode: result.exitCode,
    output: result.output
  };
}

async function update(options: CliOptions, args: string[]): Promise<CliCommandResult> {
  const result = await runUpdateCommand({
    dryRun: hasFlag(args, "--dry-run") || (!hasFlag(args, "--apply")),
    apply: hasFlag(args, "--apply"),
    homeDir: options.homeDir
  });

  return {
    handled: true,
    exitCode: result.exitCode,
    output: result.output
  };
}

async function version(): Promise<CliCommandResult> {
  const result = await runVersionCommand();
  return {
    handled: true,
    exitCode: result.exitCode,
    output: result.output
  };
}

async function settings(options: CliOptions, args: string[]): Promise<CliCommandResult> {
  const config = await loadRuntimeConfig(options);
  const category = args[0];

  if (category === "profile" && (args.includes("--mode") || args.includes("--response-language"))) {
    const result = await setupProfileConfig({
      ...options,
      input: {
        mode: parseProfileMode(valueAfter(args, "--mode"), true),
        responseLanguage: parseResponseLanguage(valueAfter(args, "--response-language"), true)
      }
    });
    return {
      handled: true,
      exitCode: 0,
      output: [
        `Profile: ${result.config.profile?.mode ?? config.profile.mode}.`,
        `Response language: ${result.config.profile?.responseLanguage ?? config.profile.responseLanguage}.`,
        `Config: ${result.path}`
      ].join("\n")
    };
  }

  if (category === "ui" && (args.includes("--language") || args.includes("--flavor") || args.includes("--activity-labels"))) {
    const result = await setupUiConfig({
      ...options,
      input: {
        language: parseUiLanguage(valueAfter(args, "--language"), true),
        flavor: parseUiFlavor(valueAfter(args, "--flavor"), true),
        activityLabels: parseActivityLabels(valueAfter(args, "--activity-labels"), true)
      }
    });
    return {
      handled: true,
      exitCode: 0,
      output: [
        `UI language: ${result.config.ui?.language ?? config.ui.language}.`,
        `UI flavor: ${result.config.ui?.flavor ?? config.ui.flavor}.`,
        `Activity labels: ${result.config.ui?.activityLabels ?? config.ui.activityLabels}.`,
        `Config: ${result.path}`
      ].join("\n")
    };
  }

  if (category === "skills" && args.includes("--autonomy")) {
    const parsed = parseSkillAutonomyArg(valueAfter(args, "--autonomy"));
    const result = await setupSkillConfig({
      ...options,
      input: { autonomy: parsed }
    });
    return {
      handled: true,
      exitCode: 0,
      output: [
        `Workflow learning: ${result.config.skills?.autonomy ?? parsed}.`,
        `Config: ${result.path}`
      ].join("\n")
    };
  }

  if (category === "skills") {
    const locale = localeForConfig(config);
    return {
      handled: true,
      exitCode: 0,
      output: renderSkillsSettings(config, locale)
    };
  }

  if (category === "security") {
    const locale = localeForConfig(config);
    return {
      handled: true,
      exitCode: 0,
      output: renderSecuritySettings(config, locale)
    };
  }

  if (category === "browser") {
    return {
      handled: true,
      exitCode: 0,
      output: renderBrowserSettings(config.browser, config.web)
    };
  }

  if (category === "voice") {
    return {
      handled: true,
      exitCode: 0,
      output: renderVoiceStatus(config)
    };
  }

  if (category === "image") {
    return {
      handled: true,
      exitCode: 0,
      output: renderImageStatus(config)
    };
  }

  if (category === "telegram") {
    return {
      handled: true,
      exitCode: 0,
      output: renderTelegramSettings(config.channels.telegram)
    };
  }

  if (category === "provider") {
    const diagnostic = await diagnoseProviderConfig(config);
    return {
      handled: true,
      exitCode: 0,
      output: [
        "EstaCoda settings: provider",
        `Model: ${config.model.provider}/${config.model.id}`,
        renderProviderDiagnostic(diagnostic),
        diagnostic.status === "ready"
          ? "Next: run estacoda, or estacoda verify for a full readiness check."
          : "Change with: estacoda setup --advanced --provider <provider> --model <model>"
      ].join("\n")
    };
  }

  if (category === "profile") {
    return {
      handled: true,
      exitCode: 0,
      output: renderProfileStatus(config.profile.mode, config.profile.responseLanguage)
    };
  }

  if (category === "ui") {
    return {
      handled: true,
      exitCode: 0,
      output: renderUiSettings(config.ui)
    };
  }

  return {
    handled: true,
    exitCode: 0,
    output: renderSettingsOverview(config)
  };
}

function formatProviderModel(provider: string, model: string): string {
  return model.startsWith(`${provider}/`) ? model : `${provider}/${model}`;
}

function selectedProfileId(options: { homeDir?: string; profileId?: string }): string {
  return options.profileId ?? readActiveProfile({ homeDir: options.homeDir }).profileId ?? defaultProfileId();
}

async function model(options: CliOptions, args: string[]): Promise<CliCommandResult> {
  if (hasFlag(args, "--help", "-h")) {
    return {
      handled: true,
      exitCode: 0,
      output: renderModelHelp(args)
    };
  }

  const config = await loadRuntimeConfig(options);

  if (args[0] === "status") {
    return {
      handled: true,
      exitCode: 0,
      output: renderModelStatus(config, options)
    };
  }

  if (args[0] === "list") {
    const flags = parseCatalogListFlags(args.slice(1));
    const catalog = await createModelSelectionCatalog({
      config: config.config,
      providerRegistry: config.providerRegistry,
      homeDir: options.homeDir,
      modelsDevOptions: options.modelsDevOptions,
      allowNetwork: flags.live
    });
    const { live: _liveList, ...listOpts } = flags;
    const models = await catalog.listModels(listOpts);
    const rows = models.map(toModelRow);
    return {
      handled: true,
      exitCode: 0,
      output: renderModelList(rows, { verbose: true })
    };
  }

  if (args[0] === "search" && args[1] !== undefined) {
    const query = args[1];
    const flags = parseCatalogListFlags(args.slice(2));
    const catalog = await createModelSelectionCatalog({
      config: config.config,
      providerRegistry: config.providerRegistry,
      homeDir: options.homeDir,
      modelsDevOptions: options.modelsDevOptions,
      allowNetwork: flags.live
    });
    const { live: _liveSearch, ...searchOpts } = flags;
    const models = await catalog.searchModels(query, searchOpts);
    const rows = models.map(toModelRow);
    return {
      handled: true,
      exitCode: 0,
      output: renderModelSearchResults(query, rows)
    };
  }

  if (args[0] === "providers") {
    const catalog = await createModelSelectionCatalog({
      config: config.config,
      providerRegistry: config.providerRegistry,
      homeDir: options.homeDir,
      modelsDevOptions: options.modelsDevOptions
    });
    const providers = await catalog.listProviders();
    const rows = providers.map(toProviderRow);
    return {
      handled: true,
      exitCode: 0,
      output: renderProviderList(rows)
    };
  }

  if (args[0] === "refresh") {
    const catalog = await createModelSelectionCatalog({
      config: config.config,
      providerRegistry: config.providerRegistry,
      homeDir: options.homeDir,
      modelsDevOptions: options.modelsDevOptions
    });
    const report = await catalog.refresh();
    return {
      handled: true,
      exitCode: 0,
      output: renderRefreshReport(report)
    };
  }

  if (args[0] === "setup") {
    if (args[1] === "local") {
      return runModelSetupLocal(options, args.slice(2));
    }
    if (args[1] === "custom") {
      return runModelSetupCustom(options, args.slice(2));
    }
    if (args[1] === "codex") {
      return runModelSetupCodex({
        homeDir: options.homeDir,
        profileId: options.profileId,
        workspaceRoot: options.workspaceRoot,
        prompt: options.prompt,
        fetchLike: options.providerFetch,
        output: options.output
      });
    }
    return {
      handled: true,
      exitCode: 0,
      output: [
        "Model setup commands:",
        "  estacoda model setup local [--base-url <url>] [--model <id>] [--context-window <n>]",
        "  estacoda model setup custom --base-url <url> [--provider-id <id>] [--model <id>] [--api-key-env <env>] [--context-window <n>]",
        "  estacoda model setup codex"
      ].join("\n")
    };
  }

  if (args[0] === "diagnose") {
    const report = await produceModelStatusReport(config);
    const lines: string[] = ["EstaCoda model diagnose", ""];

    const primary = report.primary;
    lines.push(`Primary: ${primary.route.provider}/${primary.route.id}`);
    const primaryStatus = !primary.executable ? "blocked" : primary.credentialReady && primary.endpointReady ? "ready" : "warning";
    lines.push(`  Status: ${primaryStatus}`);
    if (primary.errors.length > 0) {
      for (const error of primary.errors) lines.push(`  Error: ${error}`);
    }
    if (primary.warnings.length > 0) {
      for (const warning of primary.warnings) lines.push(`  Warning: ${warning}`);
    }

    if (report.fallbacks.length > 0) {
      lines.push("");
      lines.push("Fallback routes:");
      for (let i = 0; i < report.fallbacks.length; i++) {
        const fb = report.fallbacks[i];
        lines.push(`  ${i + 1}. ${fb.route.provider}/${fb.route.id} (${fb.executable ? "executable" : "catalog-only"})`);
        if (fb.warnings.length > 0) {
          for (const warning of fb.warnings) lines.push(`    Warning: ${warning}`);
        }
      }
    } else {
      lines.push("");
      lines.push("Fallback chain: none configured");
    }

    if (Object.keys(report.auxiliary).length > 0) {
      lines.push("");
      lines.push("Auxiliary models:");
      for (const aux of report.auxiliaryRoutes) {
        lines.push(`  ${aux.route.task}: ${aux.diagnostic.route.provider}/${aux.diagnostic.route.id} (${aux.diagnostic.executable ? "executable" : "catalog-only"})`);
        lines.push(`    Source: ${aux.route.source}`);
        lines.push(`    Timeout: ${formatOptionalNumber(aux.route.timeoutMs, "ms")}`);
        lines.push(`    Max concurrency: ${formatOptionalNumber(aux.route.maxConcurrency)}`);
        lines.push(`    Scope: ${aux.scope}`);
        lines.push(`    In flight: ${aux.inFlight}`);
        lines.push(`    Queued: ${aux.queued}`);
        if (aux.diagnostic.warnings.length > 0) {
          for (const warning of aux.diagnostic.warnings) lines.push(`    Warning: ${warning}`);
        }
      }
    }

    if (report.warnings.length > 0) {
      lines.push("");
      lines.push("Warnings:");
      for (const warning of report.warnings) lines.push(`  - ${warning}`);
    }

    return {
      handled: true,
      exitCode: report.overallReady ? 0 : 1,
      output: lines.join("\n")
    };
  }

  if (args[0] === "auxiliary") {
    if (args[1] === "status") {
      const auxiliaryRoutes = await resolveAllAuxiliaryRoutes(config.auxiliaryModels, {
        mainRoute: config.primaryModelRoute,
        providerRegistry: config.providerRegistry
      });
      return {
        handled: true,
        exitCode: 0,
        output: renderAuxiliaryStatus(auxiliaryRoutes)
      };
    }
    return {
      handled: true,
      exitCode: 0,
      output: [
        "Auxiliary model commands:",
        "  estacoda model auxiliary status"
      ].join("\n")
    };
  }

  if (args[0] === "fallback") {
    return modelFallback(options, args.slice(1), config);
  }

  if (args[0] === "set") {
    /**
     * Deprecated/rejected compatibility path.
     *
     * Persistent model switching is handled by bare `estacoda model`.
     * Session-scoped switching belongs to the later `/model` session override work.
     *
     * Do not implement new switching behavior here.
     */
    return {
      handled: true,
      exitCode: 1,
      output: [
        "`estacoda model set` is deprecated and disabled.",
        "",
        "This command previously rewrote provider setup while switching models.",
        "Use `estacoda model setup local` or `estacoda model setup custom` to configure a model endpoint."
      ].join("\n")
    };
  }

  const KNOWN_SUBCOMMANDS = new Set(["status", "list", "search", "providers", "refresh", "setup", "diagnose", "auxiliary", "fallback", "set"]);
  if (args[0] !== undefined && !KNOWN_SUBCOMMANDS.has(args[0])) {
    return runModelAliasCommand(options, config, args[0]);
  }

  return runBareModelPickerOrOverview(options, config);
}

async function runModelAliasCommand(
  options: CliOptions,
  config: Awaited<ReturnType<typeof loadRuntimeConfig>>,
  aliasInput: string
): Promise<CliCommandResult> {
  const catalog = await createModelSelectionCatalog({
    config: config.config,
    providerRegistry: config.providerRegistry,
    homeDir: options.homeDir,
    modelsDevOptions: options.modelsDevOptions
  });

  const normalized = await normalizeModelInput(aliasInput, {
    config: config.config,
    catalog
  });

  if (normalized.kind === "unknown") {
    return { handled: true, exitCode: 1, output: normalized.reason };
  }

  if (normalized.kind === "ambiguous") {
    return {
      handled: true,
      exitCode: 1,
      output: `${normalized.reason}\nCandidates:\n${normalized.candidates.map((c) => `  ${c.provider}/${c.model}`).join("\n")}`
    };
  }

  const gate = validateResolvedRouteForModelSwitch(normalized.route);
  if (!gate.ok) {
    const aliasNote = normalized.resolvedViaAlias
      ? `Alias '${normalized.resolvedViaAlias}' resolves to ${normalized.route.provider}/${normalized.route.id}, but ${gate.reason}`
      : gate.reason;
    return { handled: true, exitCode: 1, output: aliasNote };
  }

  // Reuse the existing flow resolution + credential + config path.
  // Pre-seed any alias-specific provider metadata so the flow sees the baseUrl.
  let seededConfig = config.config;
  if (normalized.route.baseUrl || normalized.route.apiKeyEnv) {
    seededConfig = applyRegisterProviderConfig(seededConfig, {
      provider: normalized.route.provider,
      baseUrl: normalized.route.baseUrl,
      apiKeyEnv: normalized.route.apiKeyEnv,
      apiMode: normalized.route.apiMode
    });
    seededConfig = applyRegisterProviderModel(seededConfig, {
      provider: normalized.route.provider,
      models: [normalized.route.id]
    });
  }

  const flow = await createProviderModelSelectionFlow({
    config: seededConfig,
    providerRegistry: config.providerRegistry,
    homeDir: options.homeDir,
    modelsDevOptions: options.modelsDevOptions,
    allowNetwork: false,
    mode: "setup"
  });

  const resolution = await flow.resolveSelection(
    normalized.route.provider,
    normalized.route.id
  );

  if (resolution.kind === "diagnostic") {
    return { handled: true, exitCode: 1, output: `Selection failed: ${resolution.reason}` };
  }

  // Attach alias metadata for rendering
  const selectionResult: typeof resolution = {
    ...resolution,
    resolvedViaAlias: normalized.resolvedViaAlias
  };

  return persistModelSelection(options, config, selectionResult);
}

async function persistModelSelection(
  options: CliOptions,
  config: Awaited<ReturnType<typeof loadRuntimeConfig>>,
  resolution: import("../providers/provider-model-selection-flow.js").ProviderModelSelectionResult
): Promise<CliCommandResult> {
  // ── Credential handling ──
  let envVarName: string | undefined;
  let credentialStored = false;
  let credentialSkipped = false;

  switch (resolution.credentialAction.kind) {
    case "none": {
      break;
    }
    case "reuse": {
      const ref = resolution.credentialAction.reference;
      if (!ref.startsWith("env:")) {
        return {
          handled: true,
          exitCode: 1,
          output: `Invalid credential reference: ${ref}`
        };
      }
      envVarName = ref.slice(4);
      break;
    }
    case "collect": {
      envVarName = resolution.credentialAction.envVarName;
      if (options.prompt === undefined) {
        return {
          handled: true,
          exitCode: 1,
          output: `Credential required for ${resolution.provider}. Set ${envVarName} or rerun interactive estacoda model.`
        };
      }
      const promptResult = await promptForApiKey({
        prompt: options.prompt,
        providerId: resolution.provider,
        envVarName,
        homeDir: options.homeDir,
        profileId: options.profileId,
        question: `Enter API key for ${resolution.provider} [${envVarName}]: `
      });

      if (promptResult.kind === "stored") {
        credentialStored = true;
      } else {
        credentialSkipped = true;
      }
      break;
    }
  }

  // ── Config mutation (pure, in-memory) ──
  let mutated = applyRegisterProviderConfig(config.config, {
    provider: resolution.provider,
    baseUrl: resolution.baseUrl,
    apiKeyEnv: envVarName,
    apiMode: resolution.apiMode
  });

  mutated = applyRegisterProviderModel(mutated, {
    provider: resolution.provider,
    models: [resolution.model]
  });

  mutated = applySetPreferredModelRoute(mutated, {
    provider: resolution.provider,
    model: resolution.model,
    baseUrl: resolution.baseUrl,
    apiKeyEnv: envVarName,
    contextWindowTokens: resolution.profile.contextWindowTokens
  });

  // ── Persist config ──
  const profileId = selectedProfileId(options);
  const targetPath = resolveProfileStateHome({ homeDir: options.homeDir, profileId }).configPath;
  try {
    await saveRuntimeConfig(targetPath, mutated);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      handled: true,
      exitCode: 1,
      output: credentialStored
        ? `Credential stored, but config save failed: ${message}`
        : `Config save failed: ${message}`
    };
  }

  // ── Render success ──
  const summary = toPickerSuccessSummary(resolution, targetPath, {
    credentialStored,
    credentialSkipped,
    envVarName
  });

  return {
    handled: true,
    exitCode: 0,
    output: renderModelPickerSuccess(summary)
  };
}

async function runBareModelPickerOrOverview(
  options: CliOptions,
  config: Awaited<ReturnType<typeof loadRuntimeConfig>>
): Promise<CliCommandResult> {
  const allowInteractive = options.interactive !== false;
  const hasPrompt = options.prompt !== undefined;
  const isTty = canRunInteractive();

  if (!allowInteractive || (!isTty && !hasPrompt)) {
    return {
      handled: true,
      exitCode: 0,
      output: renderModelOverview(config)
    };
  }

  return runBareModelPicker(options, config);
}

async function runBareModelPicker(
  options: CliOptions,
  config: Awaited<ReturnType<typeof loadRuntimeConfig>>
): Promise<CliCommandResult> {
  // Use "setup" mode so the picker behaves as a configuration surface:
  // it shows configurable runnable providers even when credentials are missing,
  // and allows credential collection inline. This is NOT onboarding setup;
  // it is a terminal configuration picker that reuses setup-mode filtering.
  const flow = await createProviderModelSelectionFlow({
    config: config.config,
    providerRegistry: config.providerRegistry,
    homeDir: options.homeDir,
    modelsDevOptions: options.modelsDevOptions,
    allowNetwork: false,
    mode: "setup"
  });

  const prompt = options.prompt!;

  // ── Provider selection ──
  const providerCandidates = await flow.listProviderCandidates();
  if (providerCandidates.length === 0) {
    return {
      handled: true,
      exitCode: 1,
      output: "No configurable providers available."
    };
  }

  const providerOptions = providerCandidates.map((p) => ({
    value: p.id,
    label: p.displayName,
    description: `${p.modelsCount} model(s)`
  }));
  providerOptions.push({
    value: "__cancel__",
    label: "Cancel",
    description: "Exit without changing model"
  });

  const selectedProviderId = await prompt.select!({
    title: "Select a provider:",
    options: providerOptions,
    fallbackPrompt: "Choose: "
  });
  if (selectedProviderId === "__cancel__") {
    return { handled: true, exitCode: 0, output: renderModelPickerCancellation() };
  }

  // ── Model selection ──
  const modelCandidates = await flow.listModelCandidates(selectedProviderId);
  if (modelCandidates.length === 0) {
    return {
      handled: true,
      exitCode: 1,
      output: `No models available for provider ${selectedProviderId}.`
    };
  }

  const modelOptions = modelCandidates.map((m) => {
    const badges: string[] = [];
    if (m.supportsVision) badges.push("vision");
    if (m.profile.supportsTools) badges.push("tools");
    if (m.profile.supportsReasoning) badges.push("reasoning");
    return {
      value: m.id,
      label: m.id,
      description: badges.join(", ") || undefined
    };
  });
  modelOptions.push({
    value: "__back__",
    label: "Back",
    description: "Return to provider list"
  });
  modelOptions.push({
    value: "__cancel__",
    label: "Cancel",
    description: "Exit without changing model"
  });

  const selectedModelId = await prompt.select!({
    title: "Select a model:",
    options: modelOptions,
    fallbackPrompt: "Choose: "
  });
  if (selectedModelId === "__cancel__") {
    return { handled: true, exitCode: 0, output: renderModelPickerCancellation() };
  }
  if (selectedModelId === "__back__") {
    // Re-run provider selection. In a real TUI this would loop; for the CLI
    // we simply recurse back to the provider step by calling the picker again.
    return runBareModelPicker(options, config);
  }

  // ── Resolve selection ──
  const resolution = await flow.resolveSelection(selectedProviderId, selectedModelId);
  if (resolution.kind === "diagnostic") {
    return { handled: true, exitCode: 1, output: `Selection failed: ${resolution.reason}` };
  }

  // ── Credential handling ──
  let envVarName: string | undefined;
  let credentialStored = false;
  let credentialSkipped = false;

  switch (resolution.credentialAction.kind) {
    case "none": {
      // Local provider: no credential needed
      break;
    }
    case "reuse": {
      const ref = resolution.credentialAction.reference;
      if (!ref.startsWith("env:")) {
        return {
          handled: true,
          exitCode: 1,
          output: `Invalid credential reference: ${ref}`
        };
      }
      envVarName = ref.slice(4);
      break;
    }
    case "collect": {
      envVarName = resolution.credentialAction.envVarName;
      const promptResult = await promptForApiKey({
        prompt,
        providerId: resolution.provider,
        envVarName,
        homeDir: options.homeDir,
        profileId: options.profileId,
        question: `Enter API key for ${resolution.provider} [${envVarName}]: `
      });

      if (promptResult.kind === "stored") {
        credentialStored = true;
      } else {
        credentialSkipped = true;
      }
      break;
    }
  }

  // ── Config mutation (pure, in-memory) ──
  let mutated = applyRegisterProviderConfig(config.config, {
    provider: resolution.provider,
    baseUrl: resolution.baseUrl,
    apiKeyEnv: envVarName
  });

  mutated = applyRegisterProviderModel(mutated, {
    provider: resolution.provider,
    models: [resolution.model]
  });

  mutated = applySetPreferredModelRoute(mutated, {
    provider: resolution.provider,
    model: resolution.model,
    baseUrl: resolution.baseUrl,
    apiKeyEnv: envVarName,
    contextWindowTokens: resolution.profile.contextWindowTokens
  });

  // ── Persist config ──
  const profileId = selectedProfileId(options);
  const targetPath = resolveProfileStateHome({ homeDir: options.homeDir, profileId }).configPath;
  try {
    await saveRuntimeConfig(targetPath, mutated);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      handled: true,
      exitCode: 1,
      output: credentialStored
        ? `Credential stored, but config save failed: ${message}`
        : `Config save failed: ${message}`
    };
  }

  // ── Render success ──
  const summary = toPickerSuccessSummary(resolution, targetPath, {
    credentialStored,
    credentialSkipped,
    envVarName
  });

  return {
    handled: true,
    exitCode: 0,
    output: renderModelPickerSuccess(summary)
  };
}

function renderModelOverview(config: Awaited<ReturnType<typeof loadRuntimeConfig>>): string {
  const diagnosticLines: string[] = [];
  const route = config.primaryModelRoute;
  const status = route.provider === "unconfigured" || route.id === "unconfigured" ? "not configured" : "ready";

  diagnosticLines.push(`Primary: ${route.provider}/${route.id}`);
  diagnosticLines.push(`Status: ${status}`);

  if (config.modelFallbackRoutes.length > 0) {
    diagnosticLines.push("");
    diagnosticLines.push("Fallbacks:");
    for (let i = 0; i < config.modelFallbackRoutes.length; i++) {
      const fb = config.modelFallbackRoutes[i];
      diagnosticLines.push(`${i + 1}. ${fb.provider}/${fb.id}`);
    }
  } else {
    diagnosticLines.push("Fallbacks: none");
  }

  diagnosticLines.push("");
  diagnosticLines.push("Commands:");
  diagnosticLines.push("  estacoda model status");
  diagnosticLines.push("  estacoda model diagnose");
  diagnosticLines.push("  estacoda model setup local [--base-url <url>] [--model <id>] [--context-window <n>]");
  diagnosticLines.push("  estacoda model setup custom --base-url <url> [--provider-id <id>] [--model <id>] [--api-key-env <env>] [--context-window <n>]");
  diagnosticLines.push("  estacoda model setup codex");
  diagnosticLines.push("  estacoda model set <provider>/<model> (deprecated; disabled)");
  diagnosticLines.push("  estacoda model auxiliary status");
  diagnosticLines.push("  estacoda model fallback status");
  diagnosticLines.push("  estacoda model fallback add <provider>/<model>");
  diagnosticLines.push("  estacoda model fallback remove <provider>/<model>");
  diagnosticLines.push("  estacoda model fallback reorder <provider>/<model> ...");
  diagnosticLines.push("  estacoda model fallback clear");

  return diagnosticLines.join("\n");
}

function renderSetupHelp(): string {
  return [
    "EstaCoda setup",
    "",
    "Usage:",
    "  estacoda setup [--interactive] [--advanced]",
    "  estacoda setup --provider <id> --model <id> [--base-url <url>] [--api-key-env <env>] [--offline|--online]",
    "",
    "Open reviewed setup, repair, and onboarding.",
    "",
    "Options:",
    "  --interactive, -i  Open the reviewed setup flow",
    "  --advanced        Show advanced setup choices where available",
    "  --provider <id>   Configure a provider directly",
    "  --model <id>      Configure a model directly",
    "  --help, -h        Show this help"
  ].join("\n");
}

function renderModelHelp(args: string[]): string {
  if (args[0] === "setup") {
    return renderModelSetupHelp(args.slice(1));
  }

  return [
    "EstaCoda model",
    "",
    "Usage:",
    "  estacoda model",
    "  estacoda model status",
    "  estacoda model diagnose",
    "  estacoda model list [--provider <id>] [--configured] [--live]",
    "  estacoda model search <query> [--provider <id>] [--configured] [--live]",
    "  estacoda model providers",
    "  estacoda model refresh",
    "  estacoda model setup <local|custom|codex>",
    "  estacoda model auxiliary status",
    "  estacoda model fallback <status|add|remove|reorder|clear>",
    "",
    "Bare `estacoda model` opens the picker interactively or prints an overview noninteractively.",
    "`estacoda model set` is deprecated and disabled.",
    "Fallback routes are configured through `estacoda model fallback ...`."
  ].join("\n");
}

function renderModelSetupHelp(args: string[]): string {
  const subcommand = args[0];

  if (subcommand === "local") {
    return [
      "EstaCoda local model setup",
      "",
      "Usage:",
      "  estacoda model setup local [--base-url <url>] [--model <id>] [--context-window <n>]",
      "",
      "Configures a local OpenAI-compatible endpoint such as Ollama or llama.cpp.",
      "",
      "Options:",
      "  --base-url <url>       Endpoint URL (default: http://localhost:11434/v1)",
      "  --model <id>           Model id to save without interactive discovery selection",
      "  --context-window <n>   Context window token count"
    ].join("\n");
  }

  if (subcommand === "custom") {
    return [
      "EstaCoda custom model setup",
      "",
      "Usage:",
      "  estacoda model setup custom --base-url <url> [--provider-id <id>] [--model <id>] [--api-key-env <env>] [--context-window <n>]",
      "",
      "Configures a custom OpenAI-compatible endpoint.",
      "",
      "Options:",
      "  --base-url <url>       Endpoint URL",
      "  --provider-id <id>     Provider id to save",
      "  --model <id>           Model id to save",
      "  --api-key-env <env>    Environment variable containing the API key",
      "  --context-window <n>   Context window token count"
    ].join("\n");
  }

  if (subcommand === "codex") {
    return [
      "EstaCoda Codex model setup",
      "",
      "Usage:",
      "  estacoda model setup codex",
      "",
      "Configures the Codex provider route.",
      "Codex setup uses OAuth device-code authentication.",
      "No OAuth session starts when this help is shown."
    ].join("\n");
  }

  return [
    "EstaCoda model setup",
    "",
    "Usage:",
    "  estacoda model setup local [--base-url <url>] [--model <id>] [--context-window <n>]",
    "  estacoda model setup custom --base-url <url> [--provider-id <id>] [--model <id>] [--api-key-env <env>] [--context-window <n>]",
    "  estacoda model setup codex",
    "",
    "Codex setup uses OAuth device-code authentication."
  ].join("\n");
}

function renderModelStatus(config: Awaited<ReturnType<typeof loadRuntimeConfig>>, options: CliOptions): string {
  const route = config.primaryModelRoute;
  const profileId = selectedProfileId(options);
  const profilePaths = resolveProfileStateHome({ homeDir: options.homeDir, profileId });
  const lines: string[] = [
    `Profile: ${profileId}`,
    `Config: ${profilePaths.configPath}`,
    `Primary: ${route.provider}/${route.id}`,
    `Context window: ${formatCount(config.model.contextWindowTokens)} tokens`,
    `Tools: ${config.model.supportsTools ? "yes" : "no"}`,
    `Vision: ${config.model.supportsVision ? "yes" : "no"}`,
    `Structured output: ${config.model.supportsStructuredOutput ? "yes" : "no"}`,
    `Provider network: ${formatProviderNetworkStatus(config, route.provider)}`,
    `Web extraction: ${config.web.enableNetwork ? "enabled" : "disabled"}`
  ];

  if (route.baseUrl !== undefined) {
    lines.push(`Endpoint: ${route.baseUrl}`);
  }
  if (route.apiKeyEnv !== undefined) {
    lines.push(`Credential: ${process.env[route.apiKeyEnv] === undefined ? `missing ${route.apiKeyEnv}` : "ready"}`);
  }

  if (config.modelFallbackRoutes.length > 0) {
    lines.push("");
    lines.push("Fallbacks:");
    for (let i = 0; i < config.modelFallbackRoutes.length; i++) {
      const fb = config.modelFallbackRoutes[i];
      const credentialStatus = fb.apiKeyEnv !== undefined
        ? (process.env[fb.apiKeyEnv] === undefined ? `missing ${fb.apiKeyEnv}` : "ready")
        : "none required";
      lines.push(`  ${i + 1}. ${fb.provider}/${fb.id} (${credentialStatus})`);
    }
  } else {
    lines.push("Fallbacks: none");
  }

  return lines.join("\n");
}

function formatProviderNetworkStatus(
  config: Awaited<ReturnType<typeof loadRuntimeConfig>>,
  provider: string
): "enabled" | "disabled" | "not applicable" | "unknown" {
  if (provider === "unconfigured" || provider === "local") {
    return "not applicable";
  }

  const providerConfig = config.config.providers?.[provider];
  if (providerConfig === undefined) {
    return "unknown";
  }

  if (providerConfig.kind === "catalog") {
    return "not applicable";
  }

  return providerConfig.enableNetwork === true ? "enabled" : "disabled";
}

function renderAuxiliaryStatus(routes: ResolvedAuxiliaryRoute[]): string {
  const lines: string[] = ["Auxiliary model status:"];
  for (const route of routes) {
    const status = route.route === undefined
      ? "unavailable"
      : `${route.route.provider}/${route.route.id}`;
    const readiness = route.route === undefined
      ? "unavailable"
      : "ready";
    const scope = "global";
    lines.push(`  ${route.task}: ${status} [${readiness}]`);
    lines.push(`    Source: ${route.source}`);
    lines.push(`    Timeout: ${formatOptionalNumber(route.timeoutMs, "ms")}`);
    lines.push(`    Max concurrency: ${formatOptionalNumber(route.maxConcurrency)}`);
    lines.push(`    Scope: ${scope}`);
    lines.push(`    In flight: ${getAuxiliaryInFlight(route.task)}`);
    lines.push(`    Queued: ${getAuxiliaryQueued(route.task)}`);
  }
  return lines.join("\n");
}

function formatOptionalNumber(value: number | undefined, suffix = ""): string {
  return value === undefined ? "unset" : `${value}${suffix}`;
}

async function modelFallback(
  options: CliOptions,
  args: string[],
  config: Awaited<ReturnType<typeof loadRuntimeConfig>>
): Promise<CliCommandResult> {
  const subcommand = args[0];

  if (subcommand === "status") {
    return {
      handled: true,
      exitCode: 0,
      output: renderFallbackStatus(config)
    };
  }

  if (subcommand === "add" && args[1] !== undefined) {
    const parsed = parseFallbackRoute(args[1]);
    if (parsed === undefined) {
      return {
        handled: true,
        exitCode: 1,
        output: [
          `Error: expected <provider>/<model>, got "${args[1]}"`,
          "",
          "Usage:",
          "  estacoda model fallback add <provider>/<model> [--base-url <url>] [--api-key-env <env>]"
        ].join("\n")
      };
    }

    const baseUrl = valueAfter(args, "--base-url");
    const apiKeyEnv = valueAfter(args, "--api-key-env");

    const fallback: ModelFallbackConfig = {
      provider: parsed.provider,
      id: parsed.id,
      ...(baseUrl !== undefined ? { baseUrl } : {}),
      ...(apiKeyEnv !== undefined ? { apiKeyEnv } : {})
    };

    const existing = config.config.model?.fallbacks ?? [];
    const result = await setupModelFallbackConfig({
      ...options,
      input: {
        fallbacks: [...existing, fallback]
      }
    });

    return {
      handled: true,
      exitCode: 0,
      output: [
        `Added fallback ${parsed.provider}/${parsed.id}.`,
        `Config: ${result.path}`
      ].join("\n")
    };
  }

  if (subcommand === "remove" && args[1] !== undefined) {
    const parsed = parseFallbackRoute(args[1]);
    if (parsed === undefined) {
      return {
        handled: true,
        exitCode: 1,
        output: [
          `Error: expected <provider>/<model>, got "${args[1]}"`,
          "",
          "Usage:",
          "  estacoda model fallback remove <provider>/<model> [--base-url <url>]"
        ].join("\n")
      };
    }

    const baseUrl = valueAfter(args, "--base-url");

    const result = await removeModelFallbackConfig({
      ...options,
      input: {
        provider: parsed.provider,
        id: parsed.id,
        ...(baseUrl !== undefined ? { baseUrl } : {})
      }
    });

    return {
      handled: true,
      exitCode: 0,
      output: [
        `Removed fallback ${parsed.provider}/${parsed.id}.`,
        `Config: ${result.path}`
      ].join("\n")
    };
  }

  if (subcommand === "reorder") {
    const order = args.slice(1).map((arg) => parseFallbackRoute(arg)).filter((r): r is { provider: string; id: string; baseUrl?: string } => r !== undefined);
    if (order.length === 0) {
      return {
        handled: true,
        exitCode: 1,
        output: [
          "Error: reorder requires at least one fallback route.",
          "",
          "Usage:",
          "  estacoda model fallback reorder <provider1>/<model1> <provider2>/<model2> ..."
        ].join("\n")
      };
    }

    const result = await reorderModelFallbackConfig({
      ...options,
      input: {
        order: order.map((o) => ({ provider: o.provider, id: o.id, ...(o.baseUrl !== undefined ? { baseUrl: o.baseUrl } : {}) }))
      }
    });

    return {
      handled: true,
      exitCode: 0,
      output: [
        "Reordered fallback chain.",
        `Config: ${result.path}`
      ].join("\n")
    };
  }

  if (subcommand === "clear") {
    if (!hasFlag(args, "--yes")) {
      return {
        handled: true,
        exitCode: 1,
        output: [
          "This will remove all configured fallback routes.",
          "Run with --yes to confirm.",
          "",
          "Usage:",
          "  estacoda model fallback clear --yes"
        ].join("\n")
      };
    }

    const result = await clearModelFallbackConfig({
      ...options
      });

    return {
      handled: true,
      exitCode: 0,
      output: [
        "Cleared all fallback routes.",
        `Config: ${result.path}`
      ].join("\n")
    };
  }

  return {
    handled: true,
    exitCode: 0,
    output: [
      "EstaCoda model fallback",
      "  estacoda model fallback status",
      "  estacoda model fallback add <provider>/<model> [--base-url <url>] [--api-key-env <env>]",
      "  estacoda model fallback remove <provider>/<model> [--base-url <url>]",
      "  estacoda model fallback reorder <provider>/<model> ...",
      "  estacoda model fallback clear --yes"
    ].join("\n")
  };
}

function renderFallbackStatus(config: Awaited<ReturnType<typeof loadRuntimeConfig>>): string {
  const fbRoutes = config.modelFallbackRoutes;
  if (fbRoutes.length === 0) {
    return [
      "Fallback status: empty",
      "",
      "No fallback routes are configured.",
      "Add one with: estacoda model fallback add <provider>/<model>"
    ].join("\n");
  }

  const lines: string[] = ["Fallback status: configured", ""];
  for (let i = 0; i < fbRoutes.length; i++) {
    const fb = fbRoutes[i];
    lines.push(`${i + 1}. ${fb.provider}/${fb.id}`);
    if (fb.baseUrl !== undefined) {
      lines.push(`   Endpoint: ${fb.baseUrl}`);
    }
    if (fb.apiKeyEnv !== undefined) {
      const ready = process.env[fb.apiKeyEnv] !== undefined;
      lines.push(`   Credential: ${ready ? "ready" : `missing ${fb.apiKeyEnv}`}`);
    }
    lines.push(`   Context window: ${formatCount(fb.profile.contextWindowTokens)} tokens`);
    lines.push(`   Tools: ${fb.profile.supportsTools ? "yes" : "no"}`);
    lines.push(`   Vision: ${fb.profile.supportsVision ? "yes" : "no"}`);
    lines.push(`   Structured output: ${fb.profile.supportsStructuredOutput ? "yes" : "no"}`);
    const providerConfig = config.config.providers?.[fb.provider];
    if (providerConfig !== undefined) {
      lines.push(`   Network: ${providerConfig.enableNetwork === true ? "enabled" : "disabled"}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function parseFallbackRoute(value: string): { provider: string; id: string; baseUrl?: string } | undefined {
  const slashIndex = value.indexOf("/");
  if (slashIndex === -1) {
    return undefined;
  }
  const provider = value.slice(0, slashIndex);
  const id = value.slice(slashIndex + 1);
  if (provider.length === 0 || id.length === 0) {
    return undefined;
  }
  return { provider, id };
}

function formatCount(value: number): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M`;
  }
  if (value >= 1_000) {
    return `${Math.round(value / 1_000)}K`;
  }
  return String(value);
}

async function tools(options: CliOptions): Promise<CliCommandResult> {
  const tools = options.tools ?? [];
  const grouped = new Map<string, string[]>();

  for (const tool of tools) {
    for (const toolset of tool.toolsets) {
      grouped.set(toolset, [...(grouped.get(toolset) ?? []), tool.name]);
    }
  }

  return {
    handled: true,
    exitCode: 0,
    output: [
      `Tools: ${tools.length}`,
      ...[...grouped.entries()].map(([toolset, names]) => `${toolset}: ${names.join(", ")}`)
    ].join("\n")
  };
}

async function doctor(options: CliOptions, args: string[] = []): Promise<CliCommandResult> {
  const setupState = await collectSetupEntryState(options);
  let config: Awaited<ReturnType<typeof loadRuntimeConfig>> | undefined;
  let configSyntaxError: string | undefined;
  const activeProfileId = readActiveProfile({ homeDir: options.homeDir }).profileId ?? defaultProfileId();
  const selectedProfile = selectedProfileId(options);
  const selectedProfilePaths = resolveProfileStateHome({ homeDir: options.homeDir, profileId: selectedProfile });
  const activeProfilePaths = resolveProfileStateHome({ homeDir: options.homeDir, profileId: activeProfileId });
  const stateHome = resolveStateHome({ homeDir: options.homeDir });

  try {
    config = await loadRuntimeConfig(options);
  } catch (error) {
    configSyntaxError = error instanceof Error ? error.message : String(error);
  }

  const providerDiagnostic = config === undefined
    ? setupState.setupVerification.providerDiagnostic
    : await diagnoseProviderConfig(config);
  const liveProviderDiagnostic = config !== undefined && hasFlag(args, "--live")
    ? await diagnoseProviderLive(config)
    : undefined;
  const liveToolDiagnostic = hasFlag(args, "--live-tools", "--live-tool")
    ? await diagnoseLiveToolCall({
        runtime: options.runtime,
        workspaceRoot: options.workspaceRoot
      })
    : undefined;
  const warnings: string[] = [];
  const notes: string[] = [];

  if (!await pathExists(activeProfilePaths.profileRoot)) {
    warnings.push(`Active profile is missing: ${activeProfileId}`);
  }
  if (!await pathExists(selectedProfilePaths.configPath)) {
    warnings.push(`Selected profile config is missing: ${selectedProfilePaths.configPath}`);
  }
  if (!await trustStoreHealthy(stateHome.trustJsonPath)) {
    warnings.push(`Global trust store is not valid JSON: ${stateHome.trustJsonPath}`);
  }

  if (config !== undefined && config.model.contextWindowTokens > 0 && config.model.contextWindowTokens < 64_000) {
    warnings.push("Configured model context window is below 64K tokens.");
  }

  if (setupState.kind !== "configured-ready" && setupState.kind !== "configured-degraded") {
    warnings.push(...setupState.blockers);
  }

  warnings.push(...providerDiagnostic.warnings);
  warnings.push(...(liveProviderDiagnostic?.warnings ?? []));
  warnings.push(...(liveToolDiagnostic?.warnings ?? []));

  if (configSyntaxError !== undefined) {
    warnings.push(`Config syntax error: ${configSyntaxError}`);
  }

  if (config !== undefined) {
    const missingProfileEnv = collectMissingProfileEnv(config);
    if (missingProfileEnv.length > 0) {
      warnings.push(`Selected profile .env is missing required values: ${missingProfileEnv.join(", ")}`);
    }
  }

  // State directory backup integrity
  const backupReady = await isBackupReady(options.homeDir ?? process.env.HOME ?? "");
  if (!backupReady.ok) {
    warnings.push(`State backup not ready: ${backupReady.reason}`);
  }

  // pack registry health
  const spRegistry = new PackRegistry({ homeDir: options.homeDir ?? process.env.HOME ?? "" });
  const spEntries = await spRegistry.list();
  if (spEntries.length === 0) {
    notes.push("pack registry: no packs installed");
  } else {
    notes.push(`pack registry: ${spEntries.length} installed`);
    const spErrors = await spRegistry.getErrors();
    const errorCount = spErrors.length;
    const disabledCount = spEntries.filter((e) => e.status === "disabled").length;
    if (errorCount > 0) {
      warnings.push(`${errorCount} pack(s) have status error`);
    }
    if (disabledCount > 0) {
      notes.push(`${disabledCount} pack(s) disabled`);
    }
  }

  return {
    handled: true,
    exitCode: warnings.length === 0 &&
      liveProviderDiagnostic?.status !== "blocked" &&
      liveToolDiagnostic?.status !== "blocked"
      ? 0
      : 1,
    output: [
      "EstaCoda doctor",
      `Profile: ${selectedProfile}`,
      `Profile config: ${selectedProfilePaths.configPath}`,
      `Profile secrets: ${selectedProfilePaths.envPath}`,
      `Global trust: ${stateHome.trustJsonPath}`,
      `Model: ${config === undefined ? "unknown/unknown" : `${config.model.provider}/${config.model.id}`}`,
      `Web extraction: ${config === undefined ? "unknown" : config.web.enableNetwork ? "enabled" : "disabled"}`,
      `Browser backend: ${config?.browser.backend ?? "unknown"}`,
      `Config sources: ${(config?.sources ?? setupState.configSources).join(", ") || "none"}`,
      "",
      renderProviderDiagnostic(providerDiagnostic),
      liveProviderDiagnostic === undefined ? undefined : "",
      liveProviderDiagnostic === undefined ? undefined : renderProviderLiveDiagnostic(liveProviderDiagnostic),
      liveToolDiagnostic === undefined ? undefined : "",
      liveToolDiagnostic === undefined ? undefined : renderLiveToolDiagnostic(liveToolDiagnostic),
      "",
      warnings.length === 0 ? "Status: ready" : `Warnings:\n${warnings.map((warning) => `- ${warning}`).join("\n")}`,
      notes.length === 0 ? undefined : `\nNotes:\n${notes.map((note) => `- ${note}`).join("\n")}`
    ].filter((line) => line !== undefined).join("\n")
  };
}

type LiveToolDiagnostic = {
  status: "ready" | "blocked";
  lines: string[];
  warnings: string[];
};

async function diagnoseLiveToolCall(input: {
  runtime: Runtime | undefined;
  workspaceRoot: string;
}): Promise<LiveToolDiagnostic> {
  if (input.runtime === undefined) {
    return {
      status: "blocked",
      lines: ["Live tool check: skipped"],
      warnings: ["Runtime was not provided to the doctor command."]
    };
  }

  const doctorDir = join(input.workspaceRoot, ".estacoda", "doctor");
  const probePath = join(doctorDir, "live-tool-smoke.ts");
  const relativeProbePath = ".estacoda/doctor/live-tool-smoke.ts";
  const expectedName = "estacodaDoctorToolSmoke";
  const expectedValue = "live-tool-ok";

  await mkdir(doctorDir, { recursive: true });
  await writeFile(probePath, `export const ${expectedName} = '${expectedValue}';\n`, "utf8");

  try {
    const response = await input.runtime.handle({
      text: `Use the file.read tool to read ${relativeProbePath}, then tell me the exported constant name and value.`,
      channel: "cli",
      trustedWorkspace: true
    });
    const fileRead = response.toolExecutions.find((execution) => execution.tool.name === "file.read");
    const usedProviderToolCall = response.providerExecution?.toolCalls.some((toolCall) =>
      toolCall.name === "file_read" || toolCall.name === "file.read"
    ) === true;
    const finalAnswerIncludedProbe = response.text.includes(expectedName) && response.text.includes(expectedValue);
    const warnings: string[] = [];

    if (response.providerExecution?.ok !== true) {
      warnings.push("Provider did not complete successfully during the live tool check.");
    }

    if (!usedProviderToolCall) {
      warnings.push("Provider did not request the file_read tool.");
    }

    if (fileRead?.result?.ok !== true) {
      warnings.push("file.read did not execute successfully during the live tool check.");
    }

    if (!finalAnswerIncludedProbe) {
      warnings.push("Final provider answer did not include the probe constant name and value.");
    }

    return {
      status: warnings.length === 0 ? "ready" : "blocked",
      lines: [
        `Live tool check: ${warnings.length === 0 ? "ready" : "blocked"}`,
        `Probe file: ${relativeProbePath}`,
        `Provider: ${response.providerExecution?.response?.provider ?? "unknown"}/${response.providerExecution?.response?.model ?? "unknown"}`,
        `Provider requested file_read: ${usedProviderToolCall ? "yes" : "no"}`,
        `file.read executed: ${fileRead?.result?.ok === true ? "yes" : "no"}`,
        `Final answer used tool result: ${finalAnswerIncludedProbe ? "yes" : "no"}`
      ],
      warnings
    };
  } finally {
    await rm(probePath, { force: true });
  }
}

function renderLiveToolDiagnostic(diagnostic: LiveToolDiagnostic): string {
  return [
    ...diagnostic.lines,
    diagnostic.warnings.length === 0
      ? "Live tool status: ready"
      : `Live tool warnings:\n${diagnostic.warnings.map((warning) => `- ${warning}`).join("\n")}`
  ].join("\n");
}

function collectMissingProfileEnv(config: Awaited<ReturnType<typeof loadRuntimeConfig>>): string[] {
  const envVars = new Set<string>();
  if (config.primaryModelRoute.apiKeyEnv !== undefined) {
    envVars.add(config.primaryModelRoute.apiKeyEnv);
  }
  for (const route of config.modelFallbackRoutes) {
    if (route.apiKeyEnv !== undefined) {
      envVars.add(route.apiKeyEnv);
    }
  }
  for (const missing of config.channels.telegram.missing ?? []) {
    envVars.add(missing);
  }
  return [...envVars].filter((envVar) => process.env[envVar] === undefined).sort();
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function trustStoreHealthy(path: string): Promise<boolean> {
  try {
    JSON.parse(await readFile(path, "utf8"));
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return true;
    }
    return false;
  }
}

async function browser(options: CliOptions, args: string[]): Promise<CliCommandResult> {
  const [subcommand] = args;

  if (subcommand !== "status" && subcommand !== "configure" && subcommand !== "setup" && subcommand !== "disable" && subcommand !== "test") {
    return {
      handled: true,
      exitCode: 0,
      output: [
        "EstaCoda browser backend",
        "  estacoda browser status",
        "  estacoda browser setup --backend local-cdp --cdp-url http://127.0.0.1:9222",
        "  estacoda browser setup --backend browserbase --cloud-provider browserbase",
        "  estacoda browser test",
        "  estacoda browser disable"
      ].join("\n")
    };
  }

  if (subcommand === "status" || subcommand === "test") {
    const config = await loadRuntimeConfig(options);
    return {
      handled: true,
      exitCode: subcommand === "test" && config.browser.backend === "unconfigured" ? 1 : 0,
      output: [
        subcommand === "test" ? "EstaCoda browser test" : undefined,
        `Browser backend: ${config.browser.backend}`,
        config.browser.cloudProvider === undefined ? undefined : `Cloud provider: ${config.browser.cloudProvider}`,
        config.browser.cdpUrl === undefined ? undefined : `CDP URL: ${config.browser.cdpUrl}`,
        config.browser.launchCommand === undefined ? undefined : `Launch command: ${config.browser.launchCommand}`,
        `Auto-launch: ${config.browser.autoLaunch ? "enabled" : "disabled"}`,
        `Config sources: ${config.sources.join(", ") || "none"}`,
        subcommand === "test"
          ? config.browser.backend === "unconfigured"
            ? "Status: browser is not configured. Run estacoda browser setup."
            : "Status: configured. Live navigation is verified through browser tools during runtime."
          : undefined
      ].filter((line) => line !== undefined).join("\n")
    };
  }

  const parsed = subcommand === "disable"
    ? { backend: "unconfigured" as const }
    : parseBrowserArgs(args.slice(1));
  const result = await setupBrowserConfig({
    ...options,
    input: parsed
  });

  return {
    handled: true,
    exitCode: 0,
    output: [
      `Browser backend: ${result.config.browser?.backend ?? "unconfigured"}.`,
      result.config.browser?.cloudProvider === undefined ? undefined : `Cloud provider: ${result.config.browser.cloudProvider}`,
      result.config.browser?.cdpUrl === undefined ? undefined : `CDP URL: ${result.config.browser.cdpUrl}`,
      result.config.browser?.launchCommand === undefined ? undefined : `Launch command: ${result.config.browser.launchCommand}`,
      `Auto-launch: ${result.config.browser?.autoLaunch === true ? "enabled" : "disabled"}`,
      `Config: ${result.path}`
    ].filter((line) => line !== undefined).join("\n")
  };
}

async function local(options: CliOptions, args: string[]): Promise<CliCommandResult> {
  const [subcommand] = args;

  if (subcommand !== "setup" && subcommand !== "status" && subcommand !== "test") {
    return {
      handled: true,
      exitCode: 0,
      output: [
        "EstaCoda local models",
        "Hermes-aligned path: local Ollama and custom local servers use an OpenAI-compatible endpoint.",
        "  estacoda local setup",
        "  estacoda local setup --base-url http://localhost:11434/v1 --model qwen2.5-coder:32b",
        "  estacoda local status",
        "  estacoda local test",
        "",
        "Notes:",
        "  Default Ollama URL: http://localhost:11434/v1",
        "  API key: not required for local Ollama",
        "  Recommended context: at least 64K tokens for long agent workflows"
      ].join("\n")
    };
  }

  if (subcommand === "setup") {
    return runModelSetupLocal(options, args.slice(1));
  }

  const config = await loadRuntimeConfig(options);
  const providerConfig = config.config.providers?.local;
  const baseUrl = providerConfig?.baseUrl ?? "http://localhost:11434/v1";
  const localModels = await config.providerRegistry.listModels();
  const selectedProfile = localModels.find((model) => model.provider === "local" && model.id === config.model.id);
  const discovery = await probeOpenAIModels(baseUrl, options.providerFetch);
  const configuredForLocal = config.model.provider === "local";

  return {
    handled: true,
    exitCode: subcommand === "test" && (!configuredForLocal || !discovery.ok) ? 1 : 0,
    output: [
      subcommand === "test" ? "EstaCoda local model test" : "EstaCoda local model status",
      `Configured route: ${config.model.provider}/${config.model.id}`,
      `Local endpoint: ${baseUrl}`,
      `API key: ${providerConfig?.apiKeyEnv === undefined ? "none" : providerConfig.apiKeyEnv}`,
      `Configured for local: ${configuredForLocal ? "yes" : "no"}`,
      renderLocalDiscovery(discovery),
      renderLocalContextGuidance(selectedProfile),
      subcommand === "test"
        ? discovery.ok && configuredForLocal
          ? "Status: ready"
          : "Status: local model path is not ready. Run estacoda local setup after starting the server."
        : "Change with: estacoda local setup --base-url http://localhost:11434/v1 --model <model>"
    ].join("\n")
  };
}

async function voice(options: CliOptions, args: string[]): Promise<CliCommandResult> {
  const [subcommand] = args;

  if (subcommand !== "status" && subcommand !== "setup") {
    return {
      handled: true,
      exitCode: 0,
      output: [
        "EstaCoda voice",
        "Hermes-aligned voice stack: TTS output plus STT transcription.",
        "  estacoda voice status",
        "  estacoda voice setup --tts-provider edge --tts-voice en-US-AriaNeural",
        "  estacoda voice setup --tts-provider openai --tts-model gpt-4o-mini-tts --tts-voice alloy --tts-api-key-env VOICE_TOOLS_OPENAI_KEY",
        "  estacoda voice setup --stt-provider local --stt-model base",
        "",
        "Defaults:",
        "  TTS: edge, no API key",
        "  STT: local Whisper, model base",
        "  CLI audio target: selected profile audio-cache/ for generated speech and transcripts"
      ].join("\n")
    };
  }

  if (subcommand === "setup") {
    const parsed = parseVoiceArgs(args.slice(1));
    const result = await setupVoiceConfig({
      ...options,
      input: parsed
    });
    const loaded = await loadRuntimeConfig(options);

    return {
      handled: true,
      exitCode: 0,
      output: [
        "Configured EstaCoda voice.",
        renderVoiceStatus(loaded),
        `Config: ${result.path}`,
        result.secretPaths.length === 0 ? undefined : `Secret store: ${result.secretPaths.join(", ")}`,
        "Next: voice.speak and voice.transcribe will use this config in runtime sessions."
      ].filter((line) => line !== undefined).join("\n")
    };
  }

  const config = await loadRuntimeConfig(options);
  return {
    handled: true,
    exitCode: 0,
    output: renderVoiceStatus(config)
  };
}

async function image(options: CliOptions, args: string[]): Promise<CliCommandResult> {
  const [subcommand] = args;

  if (subcommand !== "status" && subcommand !== "setup" && subcommand !== "verify" && subcommand !== "models") {
    return {
      handled: true,
      exitCode: 0,
      output: [
        "EstaCoda image generation",
        "Hermes-aligned text-to-image stack. In normal use, describe the image and EstaCoda will call image.generate automatically.",
        "  estacoda image status",
        "  estacoda image models --provider byteplus",
        "  estacoda image verify",
        "  estacoda image setup --provider fal --model fal-ai/flux-2/klein/9b --api-key-env FAL_KEY",
        "  estacoda image setup --provider byteplus --model-version seedream-5 --api-key-env BYTEPLUS_ARK_API_KEY",
        "  estacoda image setup --provider fal --api-key <key>",
        "",
        "Defaults:",
        "  Provider: fal",
        "  Model: fal-ai/flux-2/klein/9b",
        "  Cache: selected profile image-cache/"
      ].join("\n")
    };
  }

  if (subcommand === "models") {
    const parsed = parseImageArgs(args.slice(1));
    return {
      handled: true,
      exitCode: 0,
      output: renderImageModels(parsed.provider)
    };
  }

  if (subcommand === "verify") {
    const config = await loadRuntimeConfig(options);
    const profileId = selectedProfileId(options);
    const profilePaths = resolveProfileStateHome({ homeDir: options.homeDir, profileId });
    const verification = await verifyImageGeneration({
      imageGen: config.imageGen,
      telegramReady: config.channels.telegram.ready,
      homeDir: options.homeDir,
      imageCachePath: profilePaths.imageCachePath,
      workspaceRoot: options.workspaceRoot,
      fetch: options.imageGenerationFetch,
      checkProvider: !hasFlag(args, "--skip-provider-check")
    });
    return {
      handled: true,
      exitCode: verification.ok ? 0 : 1,
      output: renderImageVerification(verification)
    };
  }

  if (subcommand === "setup") {
    const parsed = parseImageArgs(args.slice(1));
    let secretPath: string | undefined;
    if (parsed.apiKey !== undefined && parsed.apiKey.trim().length > 0) {
      const envName = parsed.apiKeyEnv ?? defaultImageApiKeyEnv(parsed.provider ?? "fal");
      secretPath = (await storeCapabilitySecret({
        homeDir: options.homeDir,
        envName,
        secret: parsed.apiKey
      })).secretPath;
      parsed.apiKeyEnv = envName;
      delete parsed.apiKey;
    }

    const result = await setupImageGenerationConfig({
      ...options,
      input: parsed
    });
    const loaded = await loadRuntimeConfig(options);

    return {
      handled: true,
      exitCode: 0,
      output: [
        "Configured EstaCoda image generation.",
        renderImageStatus(loaded),
        `Config: ${result.path}`,
        secretPath === undefined ? undefined : `Secret store: ${secretPath}`,
        "Next: ask EstaCoda to generate an image; the agent will use image.generate and return the artifact."
      ].filter((line) => line !== undefined).join("\n")
    };
  }

  const config = await loadRuntimeConfig(options);
  return {
    handled: true,
    exitCode: 0,
    output: renderImageStatus(config)
  };
}

function renderImageVerification(verification: ImageGenerationVerification): string {
  return [
    "EstaCoda image verification",
    `Status: ${verification.ok ? "ready" : "setup needed"}`,
    `Provider: ${verification.provider}`,
    `Model: ${verification.model}`,
    `API key env: ${verification.apiKeyEnv}`,
    `API key present: ${verification.apiKeyPresent ? "yes" : "no"}`,
    `Provider check: ${verification.check}`,
    `Message: ${verification.message}`,
    `Cache: ${verification.cachePath}`,
    `Telegram delivery: ${verification.telegramDelivery === "ready" ? "ready (sendPhoto)" : "not configured"}`,
    verification.ok
      ? "Next: ask EstaCoda to generate an image."
      : `Next: run estacoda image setup --provider ${verification.provider} --model ${verification.model} --api-key-env ${verification.apiKeyEnv}`,
    verification.ok || verification.provider !== "byteplus"
      ? undefined
      : "Tip: BytePlus model access is version-specific. Run estacoda image models --provider byteplus to choose an enabled Seedream version."
  ].filter((line) => line !== undefined).join("\n");
}

function renderImageModels(provider?: ImageGenerationProvider): string {
  const providers: readonly ImageGenerationProvider[] = provider === undefined ? ["fal", "byteplus"] : [provider];
  const lines = ["EstaCoda image model options"];
  for (const current of providers) {
    lines.push("", `${current}:`);
    for (const option of IMAGE_MODEL_OPTIONS[current]) {
      const defaultMarker = option.id === defaultImageModel(current) ? " (default)" : "";
      lines.push(`  ${option.id}${defaultMarker}`);
      lines.push(`    ${option.label}: ${option.description}`);
      lines.push(`    aliases: ${option.aliases.join(", ")}`);
    }
  }
  lines.push("", "Use --model for an exact provider model id, or --model-version for an alias such as seedream-5.");
  return lines.join("\n");
}

function renderImageStatus(config: Awaited<ReturnType<typeof loadRuntimeConfig>>): string {
  const key = imageApiKeyEnv(config.imageGen.provider, config);
  const extra = config.imageGen.provider === "byteplus"
    ? "Model note: BytePlus Seedream access is version-specific; run estacoda image models --provider byteplus if this model is not enabled."
    : undefined;
  return [
    "EstaCoda image generation",
    `Provider: ${config.imageGen.provider}`,
    `Model: ${config.imageGen.model}`,
    extra,
    `Gateway: ${config.imageGen.useGateway ? "yes" : "no"}`,
    `API key: ${key}`,
    "Cache: selected profile image-cache/",
    "Agent tool: image.generate",
    "Telegram delivery: generated images upload as photos when available."
  ].filter((line) => line !== undefined).join("\n");
}

function imageApiKeyEnv(provider: ImageGenerationProvider, config: Awaited<ReturnType<typeof loadRuntimeConfig>>): string {
  return provider === "byteplus"
    ? config.imageGen.byteplus?.apiKeyEnv ?? defaultImageApiKeyEnv("byteplus")
    : config.imageGen.fal?.apiKeyEnv ?? defaultImageApiKeyEnv("fal");
}

function renderVoiceStatus(config: Awaited<ReturnType<typeof loadRuntimeConfig>>): string {
  const ttsKey = ttsApiKeyEnv(config.tts.provider, config);
  const sttKey = sttApiKeyEnv(config.stt.provider, config);

  return [
    "EstaCoda voice",
    `TTS provider: ${config.tts.provider}`,
    `TTS model: ${ttsModel(config.tts.provider, config)}`,
    `TTS voice: ${ttsVoice(config.tts.provider, config)}`,
    `TTS speed: ${config.tts.speed}`,
    `TTS API key: ${ttsKey === undefined ? "none" : ttsKey}`,
    `STT provider: ${config.stt.provider}`,
    `STT model: ${sttModel(config.stt.provider, config)}`,
    `STT command: ${config.stt.local?.command ?? "auto"}`,
    `STT API key: ${sttKey === undefined ? "none" : sttKey}`,
    "Platform delivery: CLI audio cache, Telegram voice bubble when Opus/OGG conversion is available; otherwise audio file fallback.",
    "Change with: estacoda voice setup --tts-provider edge|openai|elevenlabs|minimax|mistral|gemini|xai|neutts|kittentts --stt-provider local|groq|openai|mistral"
  ].join("\n");
}

function ttsModel(provider: TtsProvider, config: Awaited<ReturnType<typeof loadRuntimeConfig>>): string {
  switch (provider) {
    case "edge":
      return "edge-tts";
    case "elevenlabs":
      return config.tts.elevenlabs?.modelId ?? "eleven_multilingual_v2";
    case "openai":
      return config.tts.openai?.model ?? "gpt-4o-mini-tts";
    case "minimax":
      return config.tts.minimax?.model ?? "speech-2.8-hd";
    case "mistral":
      return config.tts.mistral?.model ?? "voxtral-mini-tts-2603";
    case "gemini":
      return config.tts.gemini?.model ?? "gemini-2.5-flash-preview-tts";
    case "xai":
      return "xai-tts";
    case "neutts":
      return config.tts.neutts?.model ?? "neuphonic/neutts-air-q4-gguf";
    case "kittentts":
      return config.tts.kittentts?.model ?? "KittenML/kitten-tts-nano-0.8-int8";
  }
}

function ttsVoice(provider: TtsProvider, config: Awaited<ReturnType<typeof loadRuntimeConfig>>): string {
  switch (provider) {
    case "edge":
      return config.tts.edge?.voice ?? "en-US-AriaNeural";
    case "elevenlabs":
      return config.tts.elevenlabs?.voiceId ?? "pNInz6obpgDQGcFmaJgB";
    case "openai":
      return config.tts.openai?.voice ?? "alloy";
    case "minimax":
      return config.tts.minimax?.voiceId ?? "English_Graceful_Lady";
    case "mistral":
      return config.tts.mistral?.voiceId ?? "c69964a6-ab8b-4f8a-9465-ec0925096ec8";
    case "gemini":
      return config.tts.gemini?.voice ?? "Kore";
    case "xai":
      return config.tts.xai?.voiceId ?? "eve";
    case "neutts":
      return config.tts.neutts?.refAudio === undefined || config.tts.neutts.refAudio.length === 0 ? "reference-audio-unset" : "reference-audio";
    case "kittentts":
      return config.tts.kittentts?.voice ?? "Jasper";
  }
}

function ttsApiKeyEnv(provider: TtsProvider, config: Awaited<ReturnType<typeof loadRuntimeConfig>>): string | undefined {
  switch (provider) {
    case "edge":
    case "neutts":
    case "kittentts":
      return undefined;
    case "elevenlabs":
      return "ELEVENLABS_API_KEY";
    case "openai":
      return config.tts.openai?.apiKeyEnv ?? "VOICE_TOOLS_OPENAI_KEY";
    case "minimax":
      return config.tts.minimax?.apiKeyEnv ?? "MINIMAX_API_KEY";
    case "mistral":
      return config.tts.mistral?.apiKeyEnv ?? "MISTRAL_API_KEY";
    case "gemini":
      return config.tts.gemini?.apiKeyEnv ?? "GEMINI_API_KEY";
    case "xai":
      return config.tts.xai?.apiKeyEnv ?? "XAI_API_KEY";
  }
}

function sttModel(provider: Awaited<ReturnType<typeof loadRuntimeConfig>>["stt"]["provider"], config: Awaited<ReturnType<typeof loadRuntimeConfig>>): string {
  switch (provider) {
    case "local":
      return config.stt.local?.model ?? "base";
    case "groq":
      return config.stt.groq?.model ?? "whisper-large-v3";
    case "openai":
      return config.stt.openai?.model ?? "whisper-1";
    case "mistral":
      return config.stt.mistral?.model ?? "voxtral-mini-latest";
  }
}

function sttApiKeyEnv(provider: Awaited<ReturnType<typeof loadRuntimeConfig>>["stt"]["provider"], config: Awaited<ReturnType<typeof loadRuntimeConfig>>): string | undefined {
  switch (provider) {
    case "local":
      return undefined;
    case "groq":
      return config.stt.groq?.apiKeyEnv ?? "GROQ_API_KEY";
    case "openai":
      return config.stt.openai?.apiKeyEnv ?? "VOICE_TOOLS_OPENAI_KEY";
    case "mistral":
      return config.stt.mistral?.apiKeyEnv ?? "MISTRAL_API_KEY";
  }
}

async function web(options: CliOptions, args: string[]): Promise<CliCommandResult> {
  const [subcommand] = args;

  if (subcommand !== "enable" && subcommand !== "disable" && subcommand !== "status") {
    return {
      handled: true,
      exitCode: 0,
      output: [
        "EstaCoda web extraction",
        "  estacoda web status",
        "  estacoda web enable",
        "  estacoda web disable"
      ].join("\n")
    };
  }

  if (subcommand === "status") {
    const config = await loadRuntimeConfig(options);
    return {
      handled: true,
      exitCode: 0,
      output: [
        `Web extraction: ${config.web.enableNetwork ? "enabled" : "disabled"}`,
        config.web.maxContentChars === undefined ? undefined : `Max content chars: ${config.web.maxContentChars}`,
        `Config sources: ${config.sources.join(", ") || "none"}`
      ].filter((line) => line !== undefined).join("\n")
    };
  }

  const parsed = parseWebArgs(args.slice(1));
  const result = await setupWebConfig({
    ...options,
    input: {
      ...parsed,
      enableNetwork: subcommand === "enable"
    }
  });

  return {
    handled: true,
    exitCode: 0,
    output: [
      `Web extraction ${subcommand === "enable" ? "enabled" : "disabled"}.`,
      `Config: ${result.path}`,
      result.config.web?.maxContentChars === undefined ? undefined : `Max content chars: ${result.config.web.maxContentChars}`
    ].filter((line) => line !== undefined).join("\n")
  };
}

async function security(options: CliOptions, args: string[]): Promise<CliCommandResult> {
  const [subcommand, ...rest] = args;

  if (subcommand !== "status" && subcommand !== "setup") {
    const config = await loadRuntimeConfig(options);
    const locale = localeForConfig(config);
    return {
      handled: true,
      exitCode: 0,
      output: [
        "EstaCoda security",
        "  estacoda security status",
        "Modes:",
        renderSecurityModeOption(1, "strict", locale),
        renderSecurityModeOption(2, "adaptive", locale),
        renderSecurityModeOption(3, "open", locale),
        "  estacoda security setup --mode adaptive",
        "  estacoda security setup --assessor-enabled --assessor-provider kimi --assessor-model kimi-k2.5"
      ].join("\n")
    };
  }

  if (subcommand === "status") {
    const config = await loadRuntimeConfig(options);
    const mode = formatSecurityMode(config.security.approvalMode, localeForConfig(config));
    return {
      handled: true,
      exitCode: 0,
      output: [
        "EstaCoda security",
        `Approval mode: ${mode.label} (${mode.value})`,
        `Description: ${mode.description}`,
        `Assessor: ${config.security.assessor.enabled ? "enabled" : "disabled"}`,
        config.security.assessor.provider === undefined ? undefined : `Assessor provider: ${config.security.assessor.provider}`,
        config.security.assessor.model === undefined ? undefined : `Assessor model: ${config.security.assessor.model}`,
        `Assessor timeout ms: ${config.security.assessor.timeoutMs}`,
        `Config sources: ${config.sources.join(", ") || "none"}`
      ].filter((line) => line !== undefined).join("\n")
    };
  }

  if (subcommand === "setup") {
    let parsed: SecuritySetupInput;
    try {
      parsed = parseSecuritySetupArgs(rest);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        handled: true,
        exitCode: 1,
        output: [
          `Error: ${message}`,
          "",
          "Usage:",
          "  estacoda security setup --mode strict|adaptive|open",
          "  estacoda security setup --assessor-enabled --assessor-provider <provider> --assessor-model <model>",
          "  estacoda security setup --assessor-disabled"
        ].join("\n")
      };
    }
    const result = await setupSecurityConfig({
      ...options,
      input: parsed
    });
    const loaded = await loadRuntimeConfig(options);
    const mode = formatSecurityMode(loaded.security.approvalMode, localeForConfig(loaded));

    return {
      handled: true,
      exitCode: 0,
      output: [
        `Approval mode: ${mode.label} (${mode.value}).`,
        `Description: ${mode.description}`,
        `Assessor: ${result.config.security?.assessor?.enabled === true ? "enabled" : "disabled"}.`,
        `Config: ${result.path}`
      ].join("\n")
    };
  }

  return {
    handled: true,
    exitCode: 1,
    output: "Unknown security subcommand. Use `estacoda security status` or `estacoda security setup`."
  };
}

async function cron(options: CliOptions, args: string[]): Promise<CliCommandResult> {
  const store = new CronStore({ homeDir: options.homeDir });
  const executionStoreHandle = await tryCreateExecutionStore(options);
  const executionStore = executionStoreHandle?.store;
  try {
    const result = await runCronCommand({
      args,
      store,
      executionStore: executionStore ?? undefined,
      tick: options.runtime === undefined
        ? undefined
        : async () => {
          const stateHome = resolveStateHome({ homeDir: options.homeDir });
          const lockDir = join(stateHome.stateRoot, "cron", "locks");
          const results = await tickCron({
            store,
            runner: createRuntimeCronRunner({
              runtimeFactory: async () => options.runtime!,
              wrapResponse: true,
              disposeRuntime: false,
              workspaceRoot: options.workspaceRoot
            }),
            executionStore: executionStore ?? undefined,
            jobLock: createFileCronJobLock({ lockDir }),
            now: new Date()
          });
          return results.length === 0
            ? "Cron tick complete. No due jobs."
            : [
                `Cron tick complete. Ran ${results.length} job(s).`,
                ...results.map((entry) => `${entry.job.id}: ${entry.ok ? "succeeded" : "failed"}`)
              ].join("\n");
        }
    });

    return {
      handled: true,
      exitCode: result.ok ? 0 : 1,
      output: result.output
    };
  } finally {
    executionStoreHandle?.close();
  }
}

async function tryCreateExecutionStore(options: CliOptions): Promise<{ store: CronExecutionStore; close: () => void } | undefined> {
  try {
    if (options.runtime?.sessionDb instanceof SQLiteSessionDB) {
      return {
        store: new CronExecutionStore({ db: options.runtime.sessionDb.db }),
        close: () => undefined
      };
    }

    const stateHome = resolveStateHome({ homeDir: options.homeDir });
    const db = await createSQLiteSessionDB({ path: stateHome.sessionsSqlitePath });
    return {
      store: new CronExecutionStore({ db: db.db }),
      close: () => db.close()
    };
  } catch {
    return undefined;
  }
}

async function telegram(options: CliOptions, args: string[]): Promise<CliCommandResult> {
  const [subcommand, ...rest] = args;

  if (
    subcommand !== "status" &&
    subcommand !== "setup" &&
    subcommand !== "configure" &&
    subcommand !== "disable" &&
    subcommand !== "pair" &&
    subcommand !== "allow-user" &&
    subcommand !== "remove-user" &&
    subcommand !== "allow-chat" &&
    subcommand !== "remove-chat" &&
    subcommand !== "set-default-chat" &&
    subcommand !== "sync-commands" &&
    subcommand !== "test"
  ) {
    return {
      handled: true,
      exitCode: 0,
      output: [
        "EstaCoda Telegram channel",
        "  estacoda telegram status",
        "  estacoda telegram setup",
        "  estacoda telegram allow-user <id>",
        "  estacoda telegram allow-chat <id>",
        "  estacoda telegram set-default-chat <id>",
        "  estacoda telegram pair",
        "  estacoda telegram sync-commands",
        "  estacoda telegram test --chat-id <chat>",
        "  estacoda telegram disable"
      ].join("\n")
    };
  }

  if (subcommand === "status") {
    const config = await loadRuntimeConfig(options);
    const telegram = config.channels.telegram;

    return {
      handled: true,
      exitCode: telegram.ready ? 0 : 1,
      output: [
        "Telegram channel",
        `Status: ${telegram.ready ? "ready" : telegram.enabled ? "configured, missing credentials" : "disabled"}`,
        `Enabled: ${telegram.enabled === true ? "yes" : "no"}`,
        telegram.botTokenEnv === undefined ? undefined : `Bot token env: ${telegram.botTokenEnv}`,
        telegram.defaultChatId === undefined ? undefined : `Default chat: ${telegram.defaultChatId}`,
        `Allowed users: ${(telegram.allowedUserIds ?? []).join(", ") || "none"}`,
        `Allowed chats: ${(telegram.allowedChatIds ?? []).join(", ") || "none"}`,
        telegram.missing === undefined ? undefined : `Missing: ${telegram.missing.join(", ")}`,
        `Config sources: ${config.sources.join(", ") || "none"}`
      ].filter((line) => line !== undefined).join("\n")
    };
  }

  if (subcommand === "pair") {
    const parsed = parseTelegramPairArgs(rest);
    const result = await createTelegramPairingCode({
      ...options,
      input: parsed
    });

    return {
      handled: true,
      exitCode: 0,
      output: [
        "Telegram pairing code created.",
        `Code: ${result.code}`,
        `Expires: ${result.expiresAt}`,
        `Config: ${result.path}`,
        "",
        "Send this code to your Telegram bot from the chat you want to pair.",
        "Then start the gateway with: estacoda gateway start"
      ].join("\n")
    };
  }

  if (subcommand === "setup") {
    return telegramSetup(options);
  }

  if (subcommand === "allow-user" || subcommand === "remove-user" || subcommand === "allow-chat" || subcommand === "remove-chat" || subcommand === "set-default-chat") {
    return telegramManage(options, subcommand, rest);
  }

  if (subcommand === "sync-commands") {
    return telegramSyncCommands(options);
  }

  if (subcommand === "test") {
    return telegramTest(options, rest);
  }

  const parsed = subcommand === "disable"
    ? { enabled: false } satisfies TelegramSetupInput
    : parseTelegramArgs(rest);
  const result = await setupTelegramConfig({ ...options, input: parsed });

  return {
    handled: true,
    exitCode: 0,
    output: [
      `Telegram channel ${parsed.enabled === false ? "disabled" : "configured"}.`,
      `Config: ${result.path}`,
      result.config.channels?.telegram?.botTokenEnv === undefined ? undefined : `Bot token env: ${result.config.channels.telegram.botTokenEnv}`,
      result.secretPath === undefined ? undefined : `Secret store: ${result.secretPath}`,
      result.config.channels?.telegram?.defaultChatId === undefined ? undefined : `Default chat: ${result.config.channels.telegram.defaultChatId}`,
      parsed.enabled === false ? undefined : "Next: run estacoda telegram status, then start the gateway when channel runtime is enabled."
    ].filter((line) => line !== undefined).join("\n")
  };
}

async function telegramSetup(options: CliOptions): Promise<CliCommandResult> {
  const prompt = options.prompt ?? createReadlinePrompt();
  const closePrompt = options.prompt === undefined;

  try {
    const token = await prompt([
      "Telegram guided setup",
      "Telegram bots must be explicitly allowed before they can control EstaCoda.",
      "Create a bot with @BotFather.",
      "Paste Telegram bot token to store in ~/.estacoda/.env, or leave blank to use an existing environment variable.",
      "Paste Telegram bot token: "
    ].join("\n"), { secret: true });
    const tokenEnvRaw = await prompt("Bot token environment variable [ESTACODA_TELEGRAM_BOT_TOKEN]: ");
    const tokenEnv = tokenEnvRaw.trim().length === 0 ? "ESTACODA_TELEGRAM_BOT_TOKEN" : tokenEnvRaw.trim();
    const allowUser = await prompt("Allowed Telegram user ID (optional): ");
    const allowChat = await prompt("Allowed group/chat ID (optional): ");
    const defaultChat = await prompt("Default chat ID for tests/notifications (optional): ");
    const pollTimeoutRaw = await prompt("Poll timeout seconds [25]: ");
    const pollTimeoutSeconds = Number.parseInt(pollTimeoutRaw.trim(), 10);

    const result = await setupTelegramConfig({
      ...options,
      input: {
        enabled: true,
        botTokenEnv: tokenEnv,
        botToken: token.trim().length === 0 ? undefined : token.trim(),
        allowedUserIds: allowUser.trim().length === 0 ? undefined : [allowUser.trim()],
        allowedChatIds: allowChat.trim().length === 0 ? undefined : [allowChat.trim()],
        defaultChatId: defaultChat.trim().length === 0 ? undefined : defaultChat.trim(),
        pollTimeoutSeconds: Number.isFinite(pollTimeoutSeconds) ? pollTimeoutSeconds : undefined
      }
    });
    const verify = await telegramVerifyToken({
      token: process.env[tokenEnv],
      fetch: options.telegramFetch
    });

    return {
      handled: true,
      exitCode: verify.ok || process.env[tokenEnv] === undefined ? 0 : 1,
      output: [
        "Telegram setup complete.",
        `Config: ${result.path}`,
        `Bot token env: ${tokenEnv}`,
        result.secretPath === undefined ? undefined : `Secret store: ${result.secretPath}`,
        result.config.channels?.telegram?.defaultChatId === undefined ? undefined : `Default chat: ${result.config.channels.telegram.defaultChatId}`,
        `Allowed users: ${(result.config.channels?.telegram?.allowedUserIds ?? []).join(", ") || "none"}`,
        `Allowed chats: ${(result.config.channels?.telegram?.allowedChatIds ?? []).join(", ") || "none"}`,
        `Token check: ${verify.message}`,
        "",
        "Next:",
        "  estacoda telegram status",
        "  estacoda telegram sync-commands",
        "  estacoda gateway start"
      ].filter((line) => line !== undefined).join("\n")
    };
  } finally {
    if (closePrompt) {
      prompt.close?.();
    }
  }
}

async function telegramManage(options: CliOptions, subcommand: string, args: string[]): Promise<CliCommandResult> {
  const value = args[0];
  if (value === undefined || value.trim().length === 0) {
    return {
      handled: true,
      exitCode: 1,
      output: `Usage: estacoda telegram ${subcommand} <id>`
    };
  }

  const config = await loadRuntimeConfig(options);
  const telegram = config.channels.telegram;
  const users = telegram.allowedUserIds ?? [];
  const chats = telegram.allowedChatIds ?? [];
  const input: TelegramSetupInput = {
    enabled: telegram.enabled ?? true,
    botTokenEnv: telegram.botTokenEnv,
    defaultChatId: subcommand === "set-default-chat" ? value : telegram.defaultChatId,
    allowedUserIds: subcommand === "allow-user"
      ? uniqueStrings([...users, value])
      : subcommand === "remove-user"
        ? users.filter((entry) => entry !== value)
        : users,
    allowedChatIds: subcommand === "allow-chat"
      ? uniqueStrings([...chats, value])
      : subcommand === "remove-chat"
        ? chats.filter((entry) => entry !== value)
        : chats,
    pollTimeoutSeconds: telegram.pollTimeoutSeconds
  };
  const result = await setupTelegramConfig({ ...options, input });

  return {
    handled: true,
    exitCode: 0,
    output: [
      "Telegram channel updated.",
      `Config: ${result.path}`,
      `Default chat: ${result.config.channels?.telegram?.defaultChatId ?? "none"}`,
      `Allowed users: ${(result.config.channels?.telegram?.allowedUserIds ?? []).join(", ") || "none"}`,
      `Allowed chats: ${(result.config.channels?.telegram?.allowedChatIds ?? []).join(", ") || "none"}`
    ].join("\n")
  };
}

async function telegramSyncCommands(options: CliOptions): Promise<CliCommandResult> {
  const config = await loadRuntimeConfig(options);
  const envName = config.channels.telegram.botTokenEnv;
  const token = envName === undefined ? undefined : process.env[envName];
  if (token === undefined) {
    return {
      handled: true,
      exitCode: 1,
      output: `Telegram token missing. Configure with: estacoda telegram setup`
    };
  }

  const result = await callTelegramApi({
    token,
    method: "setMyCommands",
    fetch: options.telegramFetch,
    body: {
      commands: [
        { command: "start", description: "Start EstaCoda" },
        { command: "help", description: "Show available commands" },
        { command: "status", description: "Show gateway status" },
        { command: "reset", description: "Reset this chat session" }
      ]
    }
  });

  return {
    handled: true,
    exitCode: result.ok ? 0 : 1,
    output: result.ok ? "Telegram commands synced." : `Telegram command sync failed: ${result.message}`
  };
}

async function telegramTest(options: CliOptions, args: string[]): Promise<CliCommandResult> {
  const config = await loadRuntimeConfig(options);
  const envName = config.channels.telegram.botTokenEnv;
  const token = envName === undefined ? undefined : process.env[envName];
  const chatId = valueAfter(args, "--chat-id") ?? config.channels.telegram.defaultChatId;

  if (token === undefined) {
    return {
      handled: true,
      exitCode: 1,
      output: "Telegram token missing. Configure with: estacoda telegram setup"
    };
  }
  if (chatId === undefined) {
    return {
      handled: true,
      exitCode: 1,
      output: "Telegram test needs a chat. Use --chat-id <id> or estacoda telegram set-default-chat <id>."
    };
  }

  const result = await callTelegramApi({
    token,
    method: "sendMessage",
    fetch: options.telegramFetch,
    body: {
      chat_id: chatId,
      text: "EstaCoda Telegram test message.",
      disable_web_page_preview: true
    }
  });

  return {
    handled: true,
    exitCode: result.ok ? 0 : 1,
    output: result.ok ? `Telegram test message sent to ${chatId}.` : `Telegram test failed: ${result.message}`
  };
}

async function mcp(options: CliOptions, args: string[]): Promise<CliCommandResult> {
  const [subcommand] = args;

  if (subcommand !== "status" && subcommand !== "setup" && subcommand !== "reload") {
    return {
      handled: true,
      exitCode: 0,
      output: [
        "EstaCoda MCP",
        "  estacoda mcp status",
        "  estacoda mcp reload",
        "  estacoda mcp setup --name docs --command npx --args @modelcontextprotocol/server-filesystem,/path",
        "  estacoda mcp setup --name docs --command uvx --args mcp-server-fetch",
        "  estacoda mcp setup --name remote --transport http --url http://127.0.0.1:3000/mcp --server-trust read-only-network"
      ].join("\n")
    };
  }

  if (subcommand === "status") {
    const config = await loadRuntimeConfig(options);
    const snapshots = options.runtime?.inspectMcpServers() ?? [];
    const lines = Object.entries(config.mcp.servers);
    return {
      handled: true,
      exitCode: 0,
      output: lines.length === 0
        ? [
            "EstaCoda MCP",
            "No MCP servers configured.",
            `Config sources: ${config.sources.join(", ") || "none"}`
          ].join("\n")
        : [
            "EstaCoda MCP",
            ...lines.map(([name, server]) => {
              const snapshot = snapshots.find((entry) => entry.name === name);
              const status = snapshot === undefined
                ? (server.enabled === false ? "disabled" : "configured")
                : snapshot.available
                  ? "ready"
                  : `unavailable (${snapshot.error})`;
              return [
                `${name}`,
                `  status: ${status}`,
                `  transport: ${server.transport ?? "stdio"}`,
                `  trust: ${server.trust ?? "conservative"}`,
                server.command === undefined ? undefined : `  command: ${server.command}`,
                server.url === undefined ? undefined : `  url: ${server.url}`,
                server.args === undefined ? undefined : `  args: ${server.args.join(" ") || "(none)"}`,
                server.cwd === undefined ? undefined : `  cwd: ${server.cwd}`,
                snapshot === undefined ? undefined : `  discovered tools: ${snapshot.toolCount}, resources: ${snapshot.resourceCount}, prompts: ${snapshot.promptCount}`,
                snapshot === undefined || snapshot.tools.length === 0 ? undefined : `  registered: ${snapshot.tools.join(", ")}`
              ].filter((line) => line !== undefined).join("\n");
            }),
            `Config sources: ${config.sources.join(", ") || "none"}`
          ].join("\n")
    };
  }

  if (subcommand === "reload") {
    const config = await loadRuntimeConfig(options);
    const servers = Object.keys(config.mcp.servers);

    return {
      handled: true,
      exitCode: 0,
      output: servers.length === 0
        ? [
            "EstaCoda MCP",
            "Reloaded MCP configuration.",
            "No MCP servers are configured."
          ].join("\n")
        : [
            "EstaCoda MCP",
            "Reloaded MCP configuration.",
            `Configured servers: ${servers.join(", ")}`,
            "Interactive sessions should use /reload-mcp to refresh their live MCP tool snapshot."
          ].join("\n")
    };
  }

  const parsed = parseMcpArgs(args.slice(1));
  if (parsed.name === undefined || parsed.name.length === 0) {
    return {
      handled: true,
      exitCode: 1,
      output: "Usage: estacoda mcp setup --name <server> --command <cmd> [--args a,b,c]"
    };
  }
  const result = await setupMcpConfig({
    ...options,
    input: parsed as MCPSetupInput
  });
  return {
    handled: true,
    exitCode: 0,
    output: [
      `Configured MCP server ${parsed.name}.`,
      `Config: ${result.path}`,
      `Transport: ${parsed.transport ?? "stdio"}`,
      `Trust: ${parsed.trust ?? "conservative"}`,
      parsed.command === undefined ? undefined : `Command: ${parsed.command}`,
      parsed.url === undefined ? undefined : `URL: ${parsed.url}`,
      parsed.args === undefined ? undefined : `Args: ${parsed.args.join(" ") || "(none)"}`,
      parsed.cwd === undefined ? undefined : `CWD: ${parsed.cwd}`,
      "Next: run estacoda mcp status, estacoda mcp reload, or /reload-mcp in an interactive session."
    ].filter((line) => line !== undefined).join("\n")
  };
}

async function gateway(options: CliOptions, args: string[]): Promise<CliCommandResult> {
  const [subcommand, ...rest] = args;
  const installAliases = new Set(["install", "install-service"]);
  const uninstallAliases = new Set(["uninstall", "uninstall-service"]);

  if (subcommand === "status") {
    const result = await runGatewayStatus({ ...options, profileId: parseGatewayProfileFlag(rest) ?? options.profileId });
    return { handled: true, exitCode: result.ok ? 0 : 1, output: result.output };
  }

  if (subcommand !== undefined && installAliases.has(subcommand)) {
    const result = await runGatewayInstallService({
      ...options,
      profileId: parseGatewayProfileFlag(rest) ?? options.profileId,
      system: hasFlag(rest, "--system"),
      runAsUser: valueAfter(rest, "--run-as-user"),
      serviceHomeDir: valueAfter(rest, "--home"),
      force: hasFlag(rest, "--force"),
    });
    return { handled: true, exitCode: result.ok ? 0 : 1, output: result.output };
  }

  if (subcommand !== undefined && uninstallAliases.has(subcommand)) {
    const result = await runGatewayUninstallService({
      ...options,
      profileId: parseGatewayProfileFlag(rest) ?? options.profileId,
      system: hasFlag(rest, "--system"),
    });
    return { handled: true, exitCode: result.ok ? 0 : 1, output: result.output };
  }

  if (subcommand === "diagnose") {
    const result = await runGatewayDiagnose({ ...options, profileId: parseGatewayProfileFlag(rest) ?? options.profileId });
    return { handled: true, exitCode: result.ok ? 0 : 1, output: result.output };
  }

  if (subcommand === "approvals") {
    const result = await runGatewayApprovals({ ...options, profileId: parseGatewayProfileFlag(rest) ?? options.profileId }, rest);
    return { handled: true, exitCode: result.ok ? 0 : 1, output: result.output };
  }

  if (subcommand === "stop") {
    const profileId = parseGatewayProfileFlag(rest) ?? options.profileId;
    const result = await runGatewayStop({
      ...options,
      profileId,
      system: hasFlag(rest, "--system"),
      force: hasFlag(rest, "--force")
    });
    return { handled: true, exitCode: result.ok ? 0 : 1, output: result.output };
  }

  if (subcommand === "restart") {
    const profileId = parseGatewayProfileFlag(rest) ?? options.profileId;
    const result = await runGatewayRestart({
      ...options,
      profileId,
      system: hasFlag(rest, "--system"),
      graceful: hasFlag(rest, "--graceful"),
    });
    return { handled: true, exitCode: result.ok ? 0 : 1, output: result.output };
  }

  if (subcommand === "start") {
    const profileId = parseGatewayProfileFlag(rest) ?? options.profileId;
    const deprecatedFlags = ["--telegram", "--discord", "--email", "--whatsapp"];
    const foundDeprecated = deprecatedFlags.find((f) => hasFlag(rest, f));
    if (foundDeprecated !== undefined) {
      return {
        handled: true,
        exitCode: 1,
        output: [
          `Error: ${foundDeprecated} is deprecated.`,
          "",
          "The gateway now starts all enabled adapters automatically.",
          "",
          "To configure adapters:",
          "  estacoda channels enable telegram",
          "  estacoda channels list",
          "",
          "To start the gateway:",
          "  estacoda gateway start",
        ].join("\n"),
      };
    }

    if (hasFlag(rest, "--dry-run")) {
      const result = await runGatewayStartDryRun({ ...options, profileId });
      return {
        handled: true,
        exitCode: result.ok ? 0 : 1,
        output: result.output,
      };
    }

    if (hasFlag(rest, "--background")) {
      const result = await runGatewayStartBackground({ ...options, profileId });
      return {
        handled: true,
        exitCode: result.ok ? 0 : 1,
        output: result.output,
      };
    }

    const result = await runGatewaySupervisor({
      ...options,
      profileId,
      once: hasFlag(rest, "--once"),
      telegramFetch: options.telegramFetch,
    });

    return {
      handled: true,
      exitCode: result.ok ? 0 : 1,
      output: result.output,
    };
  }

  return {
    handled: true,
    exitCode: 0,
    output: [
      "EstaCoda gateway",
      "  estacoda gateway status",
      "  estacoda gateway diagnose",
      "  estacoda gateway approvals [list|approve|deny]",
      "  estacoda gateway install",
      "  estacoda gateway install --system --run-as-user <user>",
      "  estacoda gateway install --system --run-as-user <user> --home <absolute-dir>",
      "  estacoda gateway install --force",
      "  estacoda gateway install --profile <id>",
      "  estacoda gateway uninstall",
      "  estacoda gateway uninstall --system",
      "  estacoda gateway stop",
      "  estacoda gateway stop --force",
      "  estacoda gateway stop --system",
      "  estacoda gateway restart",
      "  estacoda gateway restart --system",
      "  estacoda gateway restart --graceful",
      "  estacoda gateway start",
      "  estacoda gateway start --dry-run",
      "  estacoda gateway start --background",
      "  estacoda gateway start --once",
      "  estacoda gateway start --profile <id>",
    ].join("\n"),
  };
}

async function acp(options: CliOptions, args: string[]): Promise<CliCommandResult> {
  const [subcommand] = args;

  if (subcommand === undefined || subcommand === "serve") {
    await runAcpServer({
      workspaceRoot: options.workspaceRoot,
      homeDir: options.homeDir
    });
    return {
      handled: true,
      exitCode: 0,
      output: ""
    };
  }

  if (subcommand === "manifest") {
    return {
      handled: true,
      exitCode: 0,
      output: join(options.workspaceRoot, "acp_registry", "agent.json")
    };
  }

  return {
    handled: true,
    exitCode: 1,
    output: "Usage: estacoda acp [serve|manifest]"
  };
}

async function telegramVerifyToken(input: {
  token: string | undefined;
  fetch?: TelegramFetch;
}): Promise<{ ok: boolean; message: string }> {
  if (input.token === undefined || input.token.length === 0) {
    return {
      ok: false,
      message: "skipped; token not available in this shell"
    };
  }

  const result = await callTelegramApi({
    token: input.token,
    method: "getMe",
    fetch: input.fetch,
    body: {}
  });

  return {
    ok: result.ok,
    message: result.ok ? "ready" : result.message
  };
}

async function callTelegramApi(input: {
  token: string;
  method: string;
  body: Record<string, unknown>;
  fetch?: TelegramFetch;
}): Promise<{ ok: boolean; message: string }> {
  const fetcher = input.fetch ?? fetch;
  try {
    const response = await fetcher(`https://api.telegram.org/bot${input.token}/${input.method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input.body)
    });
    const json = await response.json() as { ok?: boolean; description?: string };

    if (response.ok && json.ok === true) {
      return { ok: true, message: "ready" };
    }

    return {
      ok: false,
      message: json.description ?? response.statusText ?? `HTTP ${response.status}`
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "unknown Telegram API error"
    };
  }
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}

function parseVoiceArgs(args: string[]): VoiceSetupInput {
  const parsed: VoiceSetupInput = {};

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    const next = args[index + 1];

    if (arg === "--tts-provider") {
      parsed.ttsProvider = parseTtsProvider(next);
      index += 1;
    } else if (arg === "--tts-speed") {
      parsed.ttsSpeed = next === undefined ? undefined : Number(next);
      index += 1;
    } else if (arg === "--tts-voice") {
      parsed.ttsVoice = next;
      index += 1;
    } else if (arg === "--tts-model") {
      parsed.ttsModel = next;
      index += 1;
    } else if (arg === "--tts-api-key-env") {
      parsed.ttsApiKeyEnv = next;
      index += 1;
    } else if (arg === "--tts-api-key") {
      parsed.ttsApiKey = next;
      index += 1;
    } else if (arg === "--stt-provider") {
      parsed.sttProvider = parseSttProvider(next);
      index += 1;
    } else if (arg === "--stt-model") {
      parsed.sttModel = next;
      index += 1;
    } else if (arg === "--stt-command") {
      parsed.sttCommand = next;
      index += 1;
    } else if (arg === "--stt-api-key-env") {
      parsed.sttApiKeyEnv = next;
      index += 1;
    } else if (arg === "--stt-api-key") {
      parsed.sttApiKey = next;
      index += 1;
    }
  }

  if (parsed.ttsSpeed !== undefined && !Number.isFinite(parsed.ttsSpeed)) {
    throw new Error("Expected --tts-speed to be a number");
  }

  return parsed;
}

function parseImageArgs(args: string[]): ImageGenerationSetupInput {
  const parsed: ImageGenerationSetupInput = {};

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    const next = args[index + 1];

    if (arg === "--provider") {
      parsed.provider = parseImageProvider(next);
      index += 1;
    } else if (arg === "--model") {
      parsed.model = next;
      index += 1;
    } else if (arg === "--model-version") {
      const provider = parsed.provider ?? "byteplus";
      parsed.provider = provider;
      parsed.modelVersion = next;
      parsed.model = resolveImageModel(provider, next);
      index += 1;
    } else if (arg === "--api-key-env") {
      parsed.apiKeyEnv = next;
      index += 1;
    } else if (arg === "--api-key") {
      parsed.apiKey = next;
      index += 1;
    } else if (arg === "--base-url") {
      parsed.baseUrl = next;
      index += 1;
    } else if (arg === "--gateway") {
      parsed.useGateway = true;
    } else if (arg === "--direct") {
      parsed.useGateway = false;
    }
  }

  return parsed;
}

function parseImageProvider(value: string | undefined): ImageGenerationProvider {
  if (value === "fal" || value === "byteplus") {
    return value;
  }
  throw new Error("Expected --provider fal or byteplus");
}

function parseTtsProvider(value: string | undefined): VoiceSetupInput["ttsProvider"] {
  if (
    value === "edge" ||
    value === "elevenlabs" ||
    value === "openai" ||
    value === "minimax" ||
    value === "mistral" ||
    value === "gemini" ||
    value === "xai" ||
    value === "neutts" ||
    value === "kittentts"
  ) {
    return value;
  }
  throw new Error("Expected --tts-provider edge, elevenlabs, openai, minimax, mistral, gemini, xai, neutts, or kittentts");
}

function parseSttProvider(value: string | undefined): VoiceSetupInput["sttProvider"] {
  if (value === "local" || value === "groq" || value === "openai" || value === "mistral") {
    return value;
  }
  throw new Error("Expected --stt-provider local, groq, openai, or mistral");
}

function renderLocalDiscovery(discovery: OpenAIModelProbe): string {
  return [
    `Endpoint check: ${discovery.ok ? "ready" : "blocked"} (${discovery.message})`,
    `Discovered models: ${discovery.models.length === 0 ? "none" : discovery.models.join(", ")}`
  ].join("\n");
}

function renderLocalContextGuidance(model: ModelProfile | undefined): string {
  if (model === undefined) {
    return "Context guidance: set local models to at least 64K tokens when possible; Hermes recommends this for long agent workflows.";
  }

  return model.contextWindowTokens >= 64_000
    ? `Context guidance: ${model.contextWindowTokens} tokens looks suitable for long agent workflows.`
    : `Context guidance: ${model.contextWindowTokens} tokens is below Hermes' 64K recommendation; increase Ollama/llama.cpp context if possible.`;
}

function parseSetupArgs(args: string[]): Partial<ProviderSetupInput> {
  const parsed: Partial<ProviderSetupInput> = {};

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    const next = args[index + 1];

    if (arg === "--provider") {
      parsed.provider = next;
      index += 1;
    } else if (arg === "--model") {
      parsed.model = next;
      index += 1;
    } else if (arg === "--base-url") {
      parsed.baseUrl = next;
      index += 1;
    } else if (arg === "--api-key-env") {
      parsed.apiKeyEnv = next;
      index += 1;
    } else if (arg === "--api-key") {
      parsed.apiKey = next;
      index += 1;
    } else if (arg === "--offline") {
      parsed.enableNetwork = false;
    }
  }

  return parsed;
}

function parseWebArgs(args: string[]): Partial<WebSetupInput> {
  const parsed: Partial<WebSetupInput> = {};

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    const next = args[index + 1];

    if (arg === "--max-content-chars") {
      parsed.maxContentChars = Number.parseInt(next ?? "", 10);
      index += 1;
    }
  }

  if (Number.isNaN(parsed.maxContentChars)) {
    parsed.maxContentChars = undefined;
  }

  return parsed;
}

function parseBrowserArgs(args: string[]): Partial<BrowserSetupInput> {
  const parsed: Partial<BrowserSetupInput> = {
    backend: "local-cdp"
  };

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    const next = args[index + 1];

    if (arg === "--backend") {
      parsed.backend = next as BrowserSetupInput["backend"];
      index += 1;
    } else if (arg === "--cloud-provider") {
      parsed.cloudProvider = next as BrowserSetupInput["cloudProvider"];
      index += 1;
    } else if (arg === "--cdp-url") {
      parsed.cdpUrl = next;
      index += 1;
    } else if (arg === "--launch-command") {
      parsed.launchCommand = next;
      index += 1;
    } else if (arg === "--auto-launch") {
      parsed.autoLaunch = true;
    }
  }

  return parsed;
}

function parseTelegramArgs(args: string[]): TelegramSetupInput {
  const parsed: TelegramSetupInput = {
    enabled: true
  };

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    const next = args[index + 1];

    if (arg === "--bot-token-env") {
      parsed.botTokenEnv = next;
      index += 1;
    } else if (arg === "--bot-token") {
      parsed.botToken = next;
      index += 1;
    } else if (arg === "--default-chat-id") {
      parsed.defaultChatId = next;
      index += 1;
    } else if (arg === "--allow-user") {
      parsed.allowedUserIds = [...(parsed.allowedUserIds ?? []), next ?? ""].filter(Boolean);
      index += 1;
    } else if (arg === "--allow-chat") {
      parsed.allowedChatIds = [...(parsed.allowedChatIds ?? []), next ?? ""].filter(Boolean);
      index += 1;
    } else if (arg === "--poll-timeout-seconds") {
      parsed.pollTimeoutSeconds = Number.parseInt(next ?? "", 10);
      index += 1;
    }
  }

  if (Number.isNaN(parsed.pollTimeoutSeconds)) {
    parsed.pollTimeoutSeconds = undefined;
  }

  return parsed;
}

function parseTelegramPairArgs(args: string[]): {
  code?: string;
  ttlMinutes?: number;
} {
  const parsed: {
    code?: string;
    ttlMinutes?: number;
  } = {};

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    const next = args[index + 1];

    if (arg === "--code") {
      parsed.code = next;
      index += 1;
    } else if (arg === "--ttl-minutes") {
      parsed.ttlMinutes = Number.parseInt(next ?? "", 10);
      index += 1;
    }
  }

  if (Number.isNaN(parsed.ttlMinutes)) {
    parsed.ttlMinutes = undefined;
  }

  return parsed;
}

function parseMcpArgs(args: string[]): Partial<MCPSetupInput> {
  const parsed: Partial<MCPSetupInput> = {
    enabled: true,
    transport: "stdio"
  };

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    const next = args[index + 1];

    if (arg === "--name") {
      parsed.name = next;
      index += 1;
    } else if (arg === "--command") {
      parsed.command = next;
      index += 1;
    } else if (arg === "--args") {
      parsed.args = (next ?? "").split(",").map((value) => value.trim()).filter((value) => value.length > 0);
      index += 1;
    } else if (arg === "--cwd") {
      parsed.cwd = next;
      index += 1;
    } else if (arg === "--transport") {
      parsed.transport = next as MCPSetupInput["transport"];
      index += 1;
    } else if (arg === "--url") {
      parsed.url = next;
      index += 1;
    } else if (arg === "--server-trust") {
      parsed.trust = next as MCPSetupInput["trust"];
      index += 1;
    } else if (arg === "--env") {
      parsed.env = parseKeyValueList(next ?? "");
      index += 1;
    } else if (arg === "--header" || arg === "--headers") {
      parsed.headers = parseKeyValueList(next ?? "");
      index += 1;
    } else if (arg === "--tool-risk-class") {
      parsed.toolRiskClass = next as MCPSetupInput["toolRiskClass"];
      index += 1;
    } else if (arg === "--resource-read-risk-class") {
      parsed.resourceReadRiskClass = next as MCPSetupInput["resourceReadRiskClass"];
      index += 1;
    } else if (arg === "--prompt-get-risk-class") {
      parsed.promptGetRiskClass = next as MCPSetupInput["promptGetRiskClass"];
      index += 1;
    } else if (arg === "--include-tools") {
      parsed.includeTools = (next ?? "").split(",").map((value) => value.trim()).filter((value) => value.length > 0);
      index += 1;
    } else if (arg === "--exclude-tools") {
      parsed.excludeTools = (next ?? "").split(",").map((value) => value.trim()).filter((value) => value.length > 0);
      index += 1;
    } else if (arg === "--tool-prefix") {
      parsed.toolPrefix = next ?? true;
      index += 1;
    } else if (arg === "--no-prefix") {
      parsed.toolPrefix = false;
    } else if (arg === "--resources") {
      parsed.exposeResources = true;
    } else if (arg === "--prompts") {
      parsed.exposePrompts = true;
    } else if (arg === "--disabled") {
      parsed.enabled = false;
    } else if (arg === "--timeout-ms") {
      parsed.timeoutMs = Number.parseInt(next ?? "", 10);
      index += 1;
    } else if (arg === "--connect-timeout-ms") {
      parsed.connectTimeoutMs = Number.parseInt(next ?? "", 10);
      index += 1;
    }
  }

  if (Number.isNaN(parsed.timeoutMs)) {
    parsed.timeoutMs = undefined;
  }
  if (Number.isNaN(parsed.connectTimeoutMs)) {
    parsed.connectTimeoutMs = undefined;
  }

  return parsed;
}

function hasFlag(args: string[], ...flags: string[]): boolean {
  return args.some((arg) => flags.includes(arg));
}

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
}

function parseGatewayProfileFlag(args: string[]): string | undefined {
  const raw = valueAfter(args, "--profile");
  return raw === undefined ? undefined : normalizeProfileId(raw);
}

function parseSkillAutonomyArg(value: string | undefined): SkillAutonomy {
  if (value === "none" || value === "suggest" || value === "proactive" || value === "autonomous") {
    return value;
  }
  throw new Error("Expected --autonomy none, suggest, proactive, or autonomous");
}

function parseKeyValueList(value: string): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const pair of value.split(",")) {
    const trimmed = pair.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const separator = trimmed.indexOf("=");
    if (separator <= 0) {
      throw new Error("Expected key=value pairs separated by commas");
    }
    const key = trimmed.slice(0, separator).trim();
    const entryValue = trimmed.slice(separator + 1).trim();
    if (key.length === 0) {
      throw new Error("Expected key=value pairs separated by commas");
    }
    parsed[key] = entryValue;
  }
  return parsed;
}

function localeForConfig(config: { ui: { language: string } }): Locale {
  return config.ui.language === "ar" ? "ar" : "en";
}

function parseProfileMode(value: string | undefined, optional: true): AgentProfileMode | undefined;
function parseProfileMode(value: string | undefined, optional?: false): AgentProfileMode;
function parseProfileMode(value: string | undefined, optional = false): AgentProfileMode | undefined {
  if (value === "focused" || value === "operator" || value === "builder" || value === "research") {
    return value;
  }
  if (optional && value === undefined) {
    return undefined;
  }
  throw new Error("Expected profile focused, operator, builder, or research");
}

function parseResponseLanguage(value: string | undefined, optional: true): AgentResponseLanguage | undefined;
function parseResponseLanguage(value: string | undefined, optional?: false): AgentResponseLanguage;
function parseResponseLanguage(value: string | undefined, optional = false): AgentResponseLanguage | undefined {
  if (value === "en" || value === "ar" || value === "match-user") {
    return value;
  }
  if (optional && value === undefined) {
    return undefined;
  }
  throw new Error("Expected response language en, ar, or match-user");
}

function parseUiLanguage(value: string | undefined, optional: true): UiLanguage | undefined;
function parseUiLanguage(value: string | undefined, optional?: false): UiLanguage;
function parseUiLanguage(value: string | undefined, optional = false): UiLanguage | undefined {
  if (value === "en" || value === "ar") {
    return value;
  }
  if (optional && value === undefined) {
    return undefined;
  }
  throw new Error("Expected UI language en or ar");
}

function parseUiFlavor(value: string | undefined, optional: true): UiFlavor | undefined;
function parseUiFlavor(value: string | undefined, optional?: false): UiFlavor;
function parseUiFlavor(value: string | undefined, optional = false): UiFlavor | undefined {
  if (value === "standard" || value === "arabic-light" || value === "kemet-full") {
    return value;
  }
  if (optional && value === undefined) {
    return undefined;
  }
  throw new Error("Expected UI flavor standard, arabic-light, or kemet-full");
}

function parseActivityLabels(value: string | undefined, optional: true): ActivityLabelsLocale | undefined;
function parseActivityLabels(value: string | undefined, optional?: false): ActivityLabelsLocale;
function parseActivityLabels(value: string | undefined, optional = false): ActivityLabelsLocale | undefined {
  if (value === "en" || value === "ar") {
    return value;
  }
  if (optional && value === undefined) {
    return undefined;
  }
  throw new Error("Expected activity labels en or ar");
}

function renderProfileStatus(mode: AgentProfileMode, responseLanguage: AgentResponseLanguage): string {
  return [
    "EstaCoda profile",
    `Mode: ${mode}`,
    `Response language: ${responseLanguage}`,
    "",
    "Profiles:",
    "  focused  - Concise, direct, minimal status chatter.",
    "  operator - Clear execution status for daily operations.",
    "  builder  - Explains implementation choices and tradeoffs.",
    "  research - Deeper analysis for planning and investigation.",
    "",
    "Arabic labels:",
    "  مركّز / مشغّل / بنّاء / باحث"
  ].join("\n");
}

function parseSecuritySetupArgs(args: string[]): SecuritySetupInput {
  const parsed: SecuritySetupInput = {};

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    const next = args[index + 1];

    if (arg === "--mode") {
      parsed.mode = next as SecuritySetupInput["mode"] | undefined;
      index += 1;
    } else if (arg === "--assessor-enabled") {
      parsed.assessorEnabled = true;
    } else if (arg === "--no-assessor") {
      parsed.assessorEnabled = false;
    } else if (arg === "--assessor-disabled") {
      parsed.assessorEnabled = false;
    } else if (arg === "--assessor-provider") {
      parsed.assessorProvider = next as SecuritySetupInput["assessorProvider"] | undefined;
      index += 1;
    } else if (arg === "--assessor-model") {
      parsed.assessorModel = next;
      index += 1;
    } else if (arg === "--assessor-timeout-ms") {
      parsed.assessorTimeoutMs = next === undefined ? undefined : Number(next);
      index += 1;
    }
  }

  if (
    parsed.mode !== undefined &&
    parsed.mode !== "strict" &&
    parsed.mode !== "adaptive" &&
    parsed.mode !== "open" &&
    parsed.mode !== "manual" &&
    parsed.mode !== "smart" &&
    parsed.mode !== "off"
  ) {
    throw new Error("Expected --mode strict, adaptive, or open");
  }
  if (parsed.assessorTimeoutMs !== undefined && !Number.isFinite(parsed.assessorTimeoutMs)) {
    throw new Error("Expected --assessor-timeout-ms to be a number");
  }

  return parsed;
}

async function handoff(options: CliOptions, args: string[]): Promise<CliCommandResult> {
  const result = await runHandoffCommand({
    args,
    homeDir: options.homeDir ?? process.env.HOME ?? ".estacoda",
    runtime: options.runtime,
  });
  return { handled: true, exitCode: result.ok ? 0 : 1, output: result.output };
}

async function sessions(options: CliOptions, args: string[]): Promise<CliCommandResult> {
  const result = await runSessionsCommand({
    args,
    homeDir: options.homeDir ?? process.env.HOME ?? ".estacoda",
    workspaceRoot: options.workspaceRoot,
    providerFetch: options.providerFetch,
    modelsDevOptions: options.modelsDevOptions,
    runtime: options.runtime,
  });
  return { handled: true, exitCode: result.ok ? 0 : 1, output: result.output };
}

async function channels(options: CliOptions, args: string[]): Promise<CliCommandResult> {
  const [subcommand, ...rest] = args;

  if (subcommand === "list" || subcommand === undefined) {
    const result = await runChannelsList(options);
    return { handled: true, exitCode: result.ok ? 0 : 1, output: result.output };
  }

  if (subcommand === "status") {
    const result = await runChannelsStatus({ ...options, channel: rest[0] });
    return { handled: true, exitCode: result.ok ? 0 : 1, output: result.output };
  }

  if (subcommand === "enable") {
    if (rest.length !== 1) {
      return {
        handled: true,
        exitCode: 1,
        output: "Usage: estacoda channels enable <channel>",
      };
    }
    const result = await runChannelsEnable({ ...options, channel: rest[0] });
    return { handled: true, exitCode: result.ok ? 0 : 1, output: result.output };
  }

  if (subcommand === "disable") {
    if (rest.length !== 1) {
      return {
        handled: true,
        exitCode: 1,
        output: "Usage: estacoda channels disable <channel>",
      };
    }
    const result = await runChannelsDisable({ ...options, channel: rest[0] });
    return { handled: true, exitCode: result.ok ? 0 : 1, output: result.output };
  }

  return {
    handled: true,
    exitCode: 0,
    output: [
      "EstaCoda channels",
      "  estacoda channels list               List configured channels",
      "  estacoda channels status [channel]   Show channel status",
      "  estacoda channels enable <channel>   Enable a channel",
      "  estacoda channels disable <channel>  Disable a channel",
    ].join("\n")
  };
}

function help(): string {
  const commands = commandRegistry.list({ scope: "cli" });
  const maxWidth = Math.max(...commands.map((c) => c.name.length), 8);
  return [
    "EstaCoda commands",
    ...commands.map(
      (cmd) => `  estacoda ${cmd.name.padEnd(maxWidth)}  ${cmd.description}`
    ),
  ].join("\n");
}

function parseCatalogListFlags(rawArgs: string[]): { live?: boolean } & CatalogListOptions {
  const flags: { live?: boolean } & CatalogListOptions = {};
  let i = 0;
  while (i < rawArgs.length) {
    const arg = rawArgs[i];
    if (arg === "--live") flags.live = true;
    else if (arg === "--provider") {
      i++;
      if (i < rawArgs.length) flags.provider = rawArgs[i] as ProviderId;
    } else if (arg.startsWith("--provider=")) {
      flags.provider = arg.slice("--provider=".length) as ProviderId;
    } else if (arg === "--tools") flags.requireTools = true;
    else if (arg === "--vision") flags.requireVision = true;
    else if (arg === "--structured") flags.requireStructuredOutput = true;
    else if (arg === "--reasoning") flags.requireReasoning = true;
    else if (arg === "--configured") flags.configuredOnly = true;
    else if (arg === "--include-beta") flags.includeBeta = true;
    else if (arg === "--include-deprecated") flags.includeDeprecated = true;
    else if (arg === "--include-non-chat") flags.includeNonChat = true;
    else if (arg === "--executable-only") flags.executableOnly = true;
    i++;
  }
  return flags;
}
