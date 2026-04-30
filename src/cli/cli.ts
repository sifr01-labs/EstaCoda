import { mkdir, rm, writeFile } from "node:fs/promises";
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
  type AgentProfileMode,
  type AgentResponseLanguage,
  type BrowserSetupInput,
  type ImageGenerationSetupInput,
  type ImageGenerationProvider,
  type ActivityLabelsLocale,
  type MCPSetupInput,
  type ProviderSetupInput,
  type SecuritySetupInput,
  type TelegramSetupInput,
  type TtsProvider,
  type UiFlavor,
  type UiLanguage,
  type VoiceSetupInput,
  type WebSetupInput
} from "../config/runtime-config.js";
import { canRunInteractive, createReadlinePrompt, runInteractiveOnboarding, type Prompt } from "../onboarding/interactive-onboarding.js";
import { getOnboardingStatus } from "../onboarding/onboarding-flow.js";
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
import type { ModelProfile } from "../contracts/provider.js";
import { runCronCommand } from "../cron/cron-command.js";
import { createRuntimeCronRunner, tickCron } from "../cron/cron-runner.js";
import { CronStore } from "../cron/cron-store.js";
import {
  diagnoseProviderConfig,
  diagnoseProviderLive,
  renderProviderDiagnostic,
  renderProviderLiveDiagnostic
} from "../config/provider-diagnostics.js";
import { getTelegramGatewayDiagnostics, runTelegramGateway } from "../channels/gateway-runner.js";
import type { TelegramFetch } from "../channels/telegram-adapter.js";
import type { Runtime } from "../runtime/create-runtime.js";
import { runAcpServer } from "../acp/server.js";
import type { SkillAutonomy } from "../skills/skill-learning.js";
import { storeCapabilitySecret } from "../capabilities/capability-setup.js";
import {
  formatSecurityMode,
  formatSkillAutonomy,
  renderSecurityModeOption,
  renderSkillAutonomyOption,
  type Locale
} from "../ui/settings-labels.js";

export type CliCommandResult = {
  handled: boolean;
  exitCode: number;
  output: string;
};

export type CliOptions = {
  argv: string[];
  workspaceRoot: string;
  homeDir?: string;
  interactive?: boolean;
  userConfigPath?: string;
  projectConfigPath?: string;
  tools?: ToolDefinition[];
  prompt?: Prompt;
  telegramFetch?: TelegramFetch;
  providerFetch?: ProviderFetchLike;
  imageGenerationFetch?: ImageGenerationFetchLike;
  runtime?: Runtime;
};

export async function runCliCommand(options: CliOptions): Promise<CliCommandResult> {
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
      return model(options);
    case "tools":
      return tools(options);
    case "doctor":
      return doctor(options, args);
    case "verify":
      return verify(options);
    case "settings":
      return settings(options, args);
    case "profile":
      return profile(options, args);
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
  const parsed = parseSetupArgs(args);
  const allowInteractive = options.interactive !== false;

  if (hasFlag(args, "--interactive", "-i") || (allowInteractive && args.length === 0 && (options.prompt !== undefined || canRunInteractive()))) {
    const result = await runInteractiveOnboarding({
      ...options,
      prompt: options.prompt
    });

    return {
      handled: true,
      exitCode: result.exitCode,
      output: result.output
    };
  }

  const advanced = hasFlag(args, "--advanced");
  if (parsed.provider === undefined || parsed.model === undefined) {
    const onboarding = await getOnboardingStatus(options);
    return {
      handled: true,
      exitCode: 0,
      output: [
        advanced ? "EstaCoda advanced setup" : "EstaCoda setup",
        onboarding.reason,
        "",
        "Recommended path:",
        "  estacoda setup",
        "",
        "Advanced path:",
        "  estacoda setup --advanced --provider deepseek --model deepseek-chat --api-key-env DEEPSEEK_API_KEY",
        "",
        "Direct provider example:",
        "  estacoda setup --provider deepseek --model deepseek-chat --api-key-env DEEPSEEK_API_KEY",
        "",
        "Provider options:",
        ...onboarding.steps.flatMap((step) =>
          step.id === "provider"
            ? step.options.map((option) => `  ${formatProviderModel(option.provider, option.model)} - ${option.label}`)
            : []
        ),
        "",
        "After setup:",
        "  estacoda verify",
        "  estacoda"
      ].join("\n")
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

async function verify(options: CliOptions): Promise<CliCommandResult> {
  const result = await runSetupVerification({
    ...options,
    runtime: options.runtime
  });

  return {
    handled: true,
    exitCode: result.ok ? 0 : 1,
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
    const current = formatSkillAutonomy(config.skills.autonomy, locale);
    return {
      handled: true,
      exitCode: 0,
      output: [
        "EstaCoda settings: workflow learning",
        `Mode: ${current.label} (${current.value})`,
        `Description: ${current.description}`,
        `External dirs: ${config.skills.externalDirs.join(", ") || "none"}`,
        "Change with: estacoda settings skills --autonomy none|suggest|proactive|autonomous"
      ].join("\n")
    };
  }

  if (category === "security") {
    const locale = localeForConfig(config);
    const current = formatSecurityMode(config.security.approvalMode, locale);
    return {
      handled: true,
      exitCode: 0,
      output: [
        "EstaCoda settings: security",
        `Approval mode: ${current.label} (${current.value})`,
        `Description: ${current.description}`,
        `Assessor: ${config.security.assessor.enabled ? "enabled" : "disabled"}`,
        "Change with: estacoda security setup --mode strict|adaptive|open"
      ].join("\n")
    };
  }

  if (category === "browser") {
    return {
      handled: true,
      exitCode: 0,
      output: [
        "EstaCoda settings: browser",
        `Backend: ${config.browser.backend}`,
        config.browser.cdpUrl === undefined ? undefined : `CDP URL: ${config.browser.cdpUrl}`,
        `Web extraction: ${config.web.enableNetwork ? "enabled" : "disabled"}`,
        "Change with: estacoda browser setup --backend local-cdp --cdp-url http://127.0.0.1:9222"
      ].filter((line) => line !== undefined).join("\n")
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
      output: [
        "EstaCoda settings: telegram",
        `Status: ${config.channels.telegram.ready ? "ready" : config.channels.telegram.enabled ? "configured, missing credentials" : "disabled"}`,
        config.channels.telegram.botTokenEnv === undefined ? undefined : `Bot token env: ${config.channels.telegram.botTokenEnv}`,
        `Allowed users: ${(config.channels.telegram.allowedUserIds ?? []).join(", ") || "none"}`,
        `Allowed chats: ${(config.channels.telegram.allowedChatIds ?? []).join(", ") || "none"}`,
        config.channels.telegram.ready
          ? "Next: start the gateway with estacoda gateway run."
          : "Change with: estacoda telegram setup"
      ].filter((line) => line !== undefined).join("\n")
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
      output: [
        "EstaCoda settings: ui",
        `Language: ${config.ui.language}`,
        `Flavor: ${config.ui.flavor}`,
        `Activity labels: ${config.ui.activityLabels}`,
        "Change with: estacoda settings ui --language ar --flavor arabic-light --activity-labels ar"
      ].join("\n")
    };
  }

  return {
    handled: true,
    exitCode: 0,
    output: [
      "EstaCoda settings",
      `Provider: ${config.model.provider}/${config.model.id}`,
      `Security: ${config.security.approvalMode}`,
      `Profile: ${config.profile.mode} (${config.profile.responseLanguage})`,
      `UI: ${config.ui.language} / ${config.ui.flavor} / labels:${config.ui.activityLabels}`,
      `Workflow learning: ${config.skills.autonomy}`,
      `Voice: TTS ${config.tts.provider}, STT ${config.stt.provider}`,
      `Web extraction: ${config.web.enableNetwork ? "enabled" : "disabled"}`,
      `Browser backend: ${config.browser.backend}`,
      `MCP servers: ${Object.keys(config.mcp.servers).length}`,
      `Config sources: ${config.sources.join(", ") || "none"}`,
      "",
      "Categories:",
      "  estacoda settings provider",
      "  estacoda settings security",
      "  estacoda settings profile",
      "  estacoda settings ui",
      "  estacoda settings skills",
      "  estacoda settings browser",
      "  estacoda settings voice",
      "  estacoda settings image",
      "  estacoda settings telegram",
      "",
      "Common changes:",
      "  estacoda setup --advanced --provider <provider> --model <model>",
      "  estacoda local setup --base-url http://localhost:11434/v1 --model <model>",
      "  estacoda voice setup --tts-provider edge --stt-provider local",
      "  estacoda image setup --provider fal --api-key-env FAL_KEY",
      "  estacoda security setup --mode adaptive",
      "  estacoda settings skills --autonomy suggest",
      "  estacoda verify"
    ].join("\n")
  };
}

function formatProviderModel(provider: string, model: string): string {
  return model.startsWith(`${provider}/`) ? model : `${provider}/${model}`;
}

async function profile(options: CliOptions, args: string[]): Promise<CliCommandResult> {
  const [subcommand, value] = args;

  if (subcommand === "set") {
    const mode = parseProfileMode(value, false);
    const result = await setupProfileConfig({
      ...options,
      input: { mode }
    });
    return {
      handled: true,
      exitCode: 0,
      output: [
        `Profile: ${result.config.profile?.mode ?? mode}.`,
        `Config: ${result.path}`
      ].join("\n")
    };
  }

  if (subcommand === "language") {
    const responseLanguage = parseResponseLanguage(value, false);
    const result = await setupProfileConfig({
      ...options,
      input: { responseLanguage }
    });
    return {
      handled: true,
      exitCode: 0,
      output: [
        `Response language: ${result.config.profile?.responseLanguage ?? responseLanguage}.`,
        `Config: ${result.path}`
      ].join("\n")
    };
  }

  const config = await loadRuntimeConfig(options);
  return {
    handled: true,
    exitCode: 0,
    output: [
      renderProfileStatus(config.profile.mode, config.profile.responseLanguage),
      "",
      "Commands:",
      "  estacoda profile set focused",
      "  estacoda profile set operator",
      "  estacoda profile set builder",
      "  estacoda profile set research",
      "  estacoda profile language match-user"
    ].join("\n")
  };
}

async function model(options: CliOptions): Promise<CliCommandResult> {
  const config = await loadRuntimeConfig(options);
  const diagnostic = await diagnoseProviderConfig(config);

  return {
    handled: true,
    exitCode: 0,
    output: [
      `Current model: ${config.model.provider}/${config.model.id}`,
      `Context window: ${config.model.contextWindowTokens} tokens`,
      `Tools: ${config.model.supportsTools ? "yes" : "no"}`,
      `Vision: ${config.model.supportsVision ? "yes" : "no"}`,
      `Structured output: ${config.model.supportsStructuredOutput ? "yes" : "no"}`,
      `Web extraction: ${config.web.enableNetwork ? "enabled" : "disabled"}`,
      `Browser backend: ${config.browser.backend}`,
      `Config sources: ${config.sources.join(", ") || "none"}`,
      "",
      renderProviderDiagnostic(diagnostic)
    ].join("\n")
  };
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
  const config = await loadRuntimeConfig(options);
  const onboarding = await getOnboardingStatus(options);
  const providerDiagnostic = await diagnoseProviderConfig(config);
  const liveProviderDiagnostic = hasFlag(args, "--live")
    ? await diagnoseProviderLive(config)
    : undefined;
  const liveToolDiagnostic = hasFlag(args, "--live-tools", "--live-tool")
    ? await diagnoseLiveToolCall({
        runtime: options.runtime,
        workspaceRoot: options.workspaceRoot
      })
    : undefined;
  const warnings = [];

  if (config.model.contextWindowTokens > 0 && config.model.contextWindowTokens < 64_000) {
    warnings.push("Configured model context window is below 64K tokens.");
  }

  if (onboarding.needed) {
    warnings.push("Provider setup is incomplete.");
  }

  warnings.push(...providerDiagnostic.warnings);
  warnings.push(...(liveProviderDiagnostic?.warnings ?? []));
  warnings.push(...(liveToolDiagnostic?.warnings ?? []));

  return {
    handled: true,
    exitCode: warnings.length === 0 &&
      liveProviderDiagnostic?.status !== "blocked" &&
      liveToolDiagnostic?.status !== "blocked"
      ? 0
      : 1,
    output: [
      "EstaCoda doctor",
      `Model: ${config.model.provider}/${config.model.id}`,
      `Web extraction: ${config.web.enableNetwork ? "enabled" : "disabled"}`,
      `Browser backend: ${config.browser.backend}`,
      `Config sources: ${config.sources.join(", ") || "none"}`,
      `Credential pools: ${config.credentialPools.snapshots().map((snapshot) => `${snapshot.provider}:${snapshot.entries.length}`).join(", ") || "none"}`,
      "",
      renderProviderDiagnostic(providerDiagnostic),
      liveProviderDiagnostic === undefined ? undefined : "",
      liveProviderDiagnostic === undefined ? undefined : renderProviderLiveDiagnostic(liveProviderDiagnostic),
      liveToolDiagnostic === undefined ? undefined : "",
      liveToolDiagnostic === undefined ? undefined : renderLiveToolDiagnostic(liveToolDiagnostic),
      "",
      warnings.length === 0 ? "Status: ready" : `Warnings:\n${warnings.map((warning) => `- ${warning}`).join("\n")}`
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
    const parsed = parseLocalArgs(args.slice(1));
    const baseUrl = parsed.baseUrl ?? "http://localhost:11434/v1";
    const discovery = await probeLocalModels(baseUrl, options.providerFetch);
    const selectedModel = parsed.model ?? (discovery.models.length === 1 ? discovery.models[0] : "ollama/auto");
    const result = await setupProviderConfig({
      ...options,
      input: {
        provider: "local",
        model: selectedModel,
        baseUrl,
        enableNetwork: true,
        scope: parsed.scope
      }
    });
    const loaded = await loadRuntimeConfig(options);
    const selectedProfile = loaded.providerRegistry
      .listModels()
      .then((models) => models.find((model) => model.provider === "local" && model.id === selectedModel));
    const profile = await selectedProfile;

    return {
      handled: true,
      exitCode: discovery.ok || parsed.model !== undefined ? 0 : 1,
      output: [
        "Configured local OpenAI-compatible provider.",
        `Base URL: ${baseUrl}`,
        `Model: ${selectedModel}`,
        "API key: none",
        `Config: ${result.path}`,
        "",
        renderLocalDiscovery(discovery),
        renderLocalContextGuidance(profile),
        discovery.ok
          ? "Next: run estacoda local test, then estacoda."
          : "Next: start Ollama or your local OpenAI-compatible server, then run estacoda local test."
      ].join("\n")
    };
  }

  const config = await loadRuntimeConfig(options);
  const providerConfig = config.config.providers?.local;
  const baseUrl = providerConfig?.baseUrl ?? "http://localhost:11434/v1";
  const localModels = await config.providerRegistry.listModels();
  const selectedProfile = localModels.find((model) => model.provider === "local" && model.id === config.model.id);
  const discovery = await probeLocalModels(baseUrl, options.providerFetch);
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
        "  CLI audio target: ~/.estacoda/audio-cache/ for generated speech and transcripts"
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
        "  Cache: ~/.estacoda/image-cache/"
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
    const verification = await verifyImageGeneration({
      imageGen: config.imageGen,
      telegramReady: config.channels.telegram.ready,
      homeDir: options.homeDir,
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
    `Cache: ~/.estacoda/image-cache/`,
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

  const parsed = parseSecuritySetupArgs(rest);
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

async function cron(options: CliOptions, args: string[]): Promise<CliCommandResult> {
  const store = new CronStore({ homeDir: options.homeDir });
  const result = await runCronCommand({
    args,
    store,
    tick: options.runtime === undefined
      ? undefined
      : async () => {
        const results = await tickCron({
          store,
          runner: createRuntimeCronRunner({
            runtimeFactory: async () => options.runtime!,
            wrapResponse: true,
            disposeRuntime: false,
            workspaceRoot: options.workspaceRoot
          })
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
        "Then start the gateway with: estacoda gateway start --telegram"
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
        "  estacoda gateway start --telegram"
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
        "  estacoda mcp setup --name remote --transport http --url http://127.0.0.1:3000/mcp --trust read-only-network"
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

  if (subcommand !== "start" && subcommand !== "status") {
    return {
      handled: true,
      exitCode: 0,
      output: [
        "EstaCoda gateway",
        "  estacoda gateway status",
        "  estacoda gateway start --telegram",
        "  estacoda gateway start --telegram --once"
      ].join("\n")
    };
  }

  if (subcommand === "status") {
    const diagnostics = await getTelegramGatewayDiagnostics(options);

    return {
      handled: true,
      exitCode: diagnostics.ready ? 0 : 1,
      output: [
        "EstaCoda gateway status",
        `Gateway process: ${diagnostics.processMode}`,
        `Active adapters: ${diagnostics.enabled ? diagnostics.adapter : "none"}`,
        `Telegram: ${diagnostics.statusLabel}`,
        `Model route: ${diagnostics.modelRoute}`,
        `Context window: ${diagnostics.contextWindowTokens} tokens`,
        `Telegram security: ${diagnostics.securityLabel}`,
        `Allowed users: ${diagnostics.allowedUserIds.join(", ") || "none"}`,
        `Allowed chats: ${diagnostics.allowedChatIds.join(", ") || "none"}`,
        `Group sessions per user: ${diagnostics.groupSessionsPerUser ? "yes" : "no"}`,
        `Thread sessions per user: ${diagnostics.threadSessionsPerUser ? "yes" : "no"}`,
        `Session reset policy: ${diagnostics.sessionResetPolicy}`,
        diagnostics.sessionIdleResetMinutes === undefined ? undefined : `Session idle reset: ${diagnostics.sessionIdleResetMinutes} min`,
        diagnostics.botTokenEnv === undefined ? undefined : `Telegram token env: ${diagnostics.botTokenEnv}`,
        `Telegram token present: ${diagnostics.botTokenPresent ? "yes" : "no"}`,
        diagnostics.defaultChatId === undefined ? undefined : `Default chat: ${diagnostics.defaultChatId}`,
        diagnostics.pollTimeoutSeconds === undefined ? undefined : `Poll timeout: ${diagnostics.pollTimeoutSeconds}s`,
        diagnostics.maxAttachmentBytes === undefined ? undefined : `Max attachment size: ${diagnostics.maxAttachmentBytes} bytes`,
        diagnostics.pairingExpiresAt === undefined ? undefined : `Pairing code active until: ${diagnostics.pairingExpiresAt}`,
        `Session DB: ${diagnostics.sessionDbPath}`,
        `Channel media: ${diagnostics.mediaRoot}`,
        `Approval store: ${diagnostics.approvalStorePath}`,
        `Session context: ${diagnostics.sessionContextPath}`,
        `Logs: ${diagnostics.logsLocation}`,
        `Config sources: ${diagnostics.configSources.join(", ") || "none"}`,
        diagnostics.missing.length === 0 ? undefined : `Missing: ${diagnostics.missing.join(", ")}`
      ].filter((line) => line !== undefined).join("\n")
    };
  }

  if (!hasFlag(rest, "--telegram")) {
    return {
      handled: true,
      exitCode: 1,
      output: "Choose a channel: estacoda gateway start --telegram"
    };
  }

  const result = await runTelegramGateway({
    ...options,
    once: hasFlag(rest, "--once"),
    telegramFetch: options.telegramFetch
  });

  return {
    handled: true,
    exitCode: result.ok ? 0 : 1,
    output: result.output
  };
}

async function acp(options: CliOptions, args: string[]): Promise<CliCommandResult> {
  const [subcommand] = args;

  if (subcommand === undefined || subcommand === "serve") {
    await runAcpServer({
      workspaceRoot: options.workspaceRoot,
      homeDir: options.homeDir,
      userConfigPath: options.userConfigPath,
      projectConfigPath: options.projectConfigPath
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
    } else if (arg === "--project") {
      parsed.scope = "project";
    } else if (arg === "--user") {
      parsed.scope = "user";
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
    } else if (arg === "--project") {
      parsed.scope = "project";
    } else if (arg === "--user") {
      parsed.scope = "user";
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

type LocalSetupArgs = {
  baseUrl?: string;
  model?: string;
  scope?: "user" | "project";
};

type LocalModelProbe = {
  ok: boolean;
  baseUrl: string;
  models: string[];
  message: string;
};

function parseLocalArgs(args: string[]): LocalSetupArgs {
  const parsed: LocalSetupArgs = {};

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    const next = args[index + 1];

    if (arg === "--base-url") {
      parsed.baseUrl = next;
      index += 1;
    } else if (arg === "--model") {
      parsed.model = next;
      index += 1;
    } else if (arg === "--project") {
      parsed.scope = "project";
    } else if (arg === "--user") {
      parsed.scope = "user";
    }
  }

  return parsed;
}

async function probeLocalModels(baseUrl: string, fetchLike?: ProviderFetchLike): Promise<LocalModelProbe> {
  const normalizedBaseUrl = baseUrl.replace(/\/$/, "");
  const url = `${normalizedBaseUrl}/models`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3_000);

  try {
    const response = fetchLike === undefined
      ? await globalThis.fetch(url, {
          method: "GET",
          headers: {},
          signal: controller.signal
        })
      : await fetchLike(url, {
          method: "GET",
          headers: {},
          body: "",
          signal: controller.signal
        });
    const json = await response.json();
    const models = extractLocalModelIds(json);

    if (!response.ok) {
      return {
        ok: false,
        baseUrl: normalizedBaseUrl,
        models,
        message: response.statusText || `HTTP ${response.status}`
      };
    }

    return {
      ok: true,
      baseUrl: normalizedBaseUrl,
      models,
      message: models.length === 0
        ? "endpoint responded, but no models were listed"
        : `endpoint ready; ${models.length} model(s) visible`
    };
  } catch (error) {
    return {
      ok: false,
      baseUrl: normalizedBaseUrl,
      models: [],
      message: error instanceof Error ? error.message : "local endpoint did not respond"
    };
  } finally {
    clearTimeout(timeout);
  }
}

function extractLocalModelIds(value: unknown): string[] {
  if (typeof value !== "object" || value === null) {
    return [];
  }
  const record = value as {
    data?: Array<{ id?: unknown }>;
    models?: Array<{ name?: unknown; model?: unknown; id?: unknown }>;
  };

  if (Array.isArray(record.data)) {
    return uniqueStrings(record.data.map((entry) => typeof entry.id === "string" ? entry.id : ""));
  }

  if (Array.isArray(record.models)) {
    return uniqueStrings(record.models.map((entry) => {
      if (typeof entry.id === "string") return entry.id;
      if (typeof entry.model === "string") return entry.model;
      if (typeof entry.name === "string") return entry.name;
      return "";
    }));
  }

  return [];
}

function renderLocalDiscovery(discovery: LocalModelProbe): string {
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
    } else if (arg === "--project") {
      parsed.scope = "project";
    } else if (arg === "--user") {
      parsed.scope = "user";
    } else if (arg === "--offline") {
      parsed.enableNetwork = false;
    } else if (arg === "--strategy") {
      parsed.credentialPoolStrategy = next as ProviderSetupInput["credentialPoolStrategy"];
      index += 1;
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
    } else if (arg === "--project") {
      parsed.scope = "project";
    } else if (arg === "--user") {
      parsed.scope = "user";
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
    } else if (arg === "--cdp-url") {
      parsed.cdpUrl = next;
      index += 1;
    } else if (arg === "--launch-command") {
      parsed.launchCommand = next;
      index += 1;
    } else if (arg === "--auto-launch") {
      parsed.autoLaunch = true;
    } else if (arg === "--project") {
      parsed.scope = "project";
    } else if (arg === "--user") {
      parsed.scope = "user";
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
    } else if (arg === "--project") {
      parsed.scope = "project";
    } else if (arg === "--user") {
      parsed.scope = "user";
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
  scope?: "user" | "project";
} {
  const parsed: {
    code?: string;
    ttlMinutes?: number;
    scope?: "user" | "project";
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
    } else if (arg === "--project") {
      parsed.scope = "project";
    } else if (arg === "--user") {
      parsed.scope = "user";
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
    } else if (arg === "--trust") {
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
    } else if (arg === "--project") {
      parsed.scope = "project";
    } else if (arg === "--user") {
      parsed.scope = "user";
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
    } else if (arg === "--assessor-provider") {
      parsed.assessorProvider = next as SecuritySetupInput["assessorProvider"] | undefined;
      index += 1;
    } else if (arg === "--assessor-model") {
      parsed.assessorModel = next;
      index += 1;
    } else if (arg === "--assessor-timeout-ms") {
      parsed.assessorTimeoutMs = next === undefined ? undefined : Number(next);
      index += 1;
    } else if (arg === "--project") {
      parsed.scope = "project";
    } else if (arg === "--user") {
      parsed.scope = "user";
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

function help(): string {
  return [
    "EstaCoda commands",
    "  estacoda setup   Run the guided setup wizard",
    "  estacoda setup --advanced --provider deepseek --model deepseek-chat",
    "  estacoda verify  Check setup readiness",
    "  estacoda settings View setup categories",
    "  estacoda profile View or set agent profile",
    "  estacoda web     Configure web extraction",
    "  estacoda browser Configure browser backend",
    "  estacoda local   Configure local Ollama/OpenAI-compatible models",
    "  estacoda voice   Configure TTS/STT voice tools",
    "  estacoda security View or configure approval mode",
    "  estacoda cron    Manage scheduled tasks",
    "  estacoda mcp     Configure MCP servers",
    "  estacoda acp     Start the ACP stdio server",
    "  estacoda telegram Configure Telegram channel",
    "  estacoda telegram pair Pair a Telegram chat",
    "  estacoda gateway Start channel gateway",
    "  estacoda model   Show current model",
    "  estacoda tools   Show available tools by toolset",
    "  estacoda doctor  Check setup health",
    "  estacoda doctor --live  Make a tiny live provider call",
    "  estacoda doctor --live-tools  Verify live provider tool-calling"
  ].join("\n");
}
