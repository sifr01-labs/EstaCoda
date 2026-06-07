import type { LoadedRuntimeConfig } from "../config/runtime-config.js";
import {
  buildKeyValueBlockViewModel,
  buildListViewModel,
  buildCommandResultViewModel,
  kv,
  listItem,
} from "../ui/view-models/builders.js";
import { renderPlain } from "../ui/renderers/plain-renderer.js";
import type { ViewModel } from "../contracts/view-model.js";
import type { Locale } from "../ui/settings-labels.js";
import { formatSkillAutonomy, formatSecurityMode } from "../ui/settings-labels.js";
import { isFasterWhisperConfig } from "../tools/stt-providers.js";

// ──────────────────────────────────────
type SettingsViewModelResult = { viewModel: ViewModel; render: () => string };
type SttConfig = LoadedRuntimeConfig["stt"];

function result(viewModel: ViewModel): SettingsViewModelResult {
  return { viewModel, render: () => renderPlain(viewModel) };
}

function formatSettingsStt(stt: SttConfig): string {
  if (stt.provider === "local") {
    const model = isFasterWhisperConfig(stt)
      ? stt.local?.fasterWhisper?.model ?? stt.local?.model ?? "base"
      : stt.local?.model ?? "base";
    return isFasterWhisperConfig(stt)
      ? `local faster-whisper, model ${model}`
      : `local command, model ${model}`;
  }
  return stt.provider;
}

function formatSettingsSttPython(stt: SttConfig): string | undefined {
  if (stt.provider !== "local" || !isFasterWhisperConfig(stt)) {
    return undefined;
  }
  const pythonBinary = stt.local?.pythonBinary;
  return pythonBinary === undefined || pythonBinary.length === 0
    ? "managed: EstaCoda Python environment"
    : `custom: ${pythonBinary}`;
}

// ──────────────────────────────────────
// Settings overview (no category)
// ──────────────────────────────────────

export function buildSettingsOverviewViewModel(config: LoadedRuntimeConfig): ViewModel {
  const sttPython = formatSettingsSttPython(config.stt);
  return buildCommandResultViewModel({
    ok: true,
    title: "EstaCoda settings",
    blocks: [
      buildKeyValueBlockViewModel({
        entries: [
          kv("Provider", `${config.model.provider}/${config.model.id}`),
          kv("Security", config.security.approvalMode),
          kv("Profile", `${config.profile.mode} (${config.profile.responseLanguage})`),
          kv("UI", `${config.ui.language} / ${config.ui.flavor} / labels:${config.ui.activityLabels}`),
          kv("Agent Evolution", config.skills.autonomy),
          kv("Voice", `TTS ${config.tts.provider}, STT ${formatSettingsStt(config.stt)}, auto-TTS ${config.voice.autoTts ? "on" : "off"}, CLI mode via estacoda voice mode`),
          ...(sttPython === undefined ? [] : [kv("Voice STT Python", sttPython)]),
          kv("Web extraction", config.web.enableNetwork ? "enabled" : "disabled"),
          kv("Browser backend", config.browser.backend),
          kv("MCP servers", Object.keys(config.mcp.servers).length),
          kv("Config sources", config.sources.join(", ") || "none"),
        ],
      }),
      buildListViewModel({
        title: "Categories",
        items: [
          listItem("estacoda settings provider"),
          listItem("estacoda settings security"),
          listItem("estacoda settings profile"),
          listItem("estacoda settings ui"),
          listItem("estacoda settings skills"),
          listItem("estacoda settings browser"),
          listItem("estacoda settings voice"),
          listItem("estacoda settings image"),
          listItem("estacoda settings telegram"),
        ],
      }),
      buildListViewModel({
        title: "Common changes",
        items: [
          listItem("estacoda setup --advanced --provider <provider> --model <model>"),
          listItem("estacoda local setup --base-url http://localhost:11434/v1 --model <model>"),
          listItem("estacoda voice setup --tts-provider openai --stt-provider local"),
          listItem("estacoda voice mode on"),
          listItem("estacoda image setup --provider fal --api-key-env FAL_KEY"),
          listItem("estacoda security setup --mode adaptive"),
          listItem("estacoda settings skills --autonomy suggest"),
          listItem("estacoda verify"),
        ],
      }),
    ],
  });
}

export function renderSettingsOverview(config: LoadedRuntimeConfig): string {
  return renderPlain(buildSettingsOverviewViewModel(config));
}

// ──────────────────────────────────────
// Skills settings
// ──────────────────────────────────────

export function buildSkillsSettingsViewModel(
  config: LoadedRuntimeConfig,
  locale: Locale
): ViewModel {
  const current = formatSkillAutonomy(config.skills.autonomy, locale);
  return buildKeyValueBlockViewModel({
    title: "EstaCoda settings: Agent Evolution",
    entries: [
      kv("Mode", `${current.label} (${current.value})`),
      kv("Description", current.description),
      kv("External dirs", config.skills.externalDirs.join(", ") || "none"),
      kv("Change with", "estacoda settings skills --autonomy none|suggest|proactive|autonomous"),
    ],
  });
}

export function renderSkillsSettings(config: LoadedRuntimeConfig, locale: Locale): string {
  return renderPlain(buildSkillsSettingsViewModel(config, locale));
}

// ──────────────────────────────────────
// Security settings
// ──────────────────────────────────────

export function buildSecuritySettingsViewModel(
  config: LoadedRuntimeConfig,
  locale: Locale
): ViewModel {
  const current = formatSecurityMode(config.security.approvalMode, locale);
  return buildKeyValueBlockViewModel({
    title: "EstaCoda settings: security",
    entries: [
      kv("Approval mode", `${current.label} (${current.value})`),
      kv("Description", current.description),
      kv("Assessor", config.security.assessor.enabled ? "enabled" : "disabled"),
      kv("Change with", "estacoda security setup --mode strict|adaptive|open"),
    ],
  });
}

export function renderSecuritySettings(config: LoadedRuntimeConfig, locale: Locale): string {
  return renderPlain(buildSecuritySettingsViewModel(config, locale));
}

// ──────────────────────────────────────
// Browser settings
// ──────────────────────────────────────
type BrowserConfig = LoadedRuntimeConfig["browser"];
type WebConfig = LoadedRuntimeConfig["web"];

export function buildBrowserSettingsViewModel(
  browser: BrowserConfig,
  web: WebConfig
): ViewModel {
  const entries = [
    kv("Backend", browser.backend),
    kv("Supervised mode", browser.supervised ? "enabled" : "disabled"),
    kv("Auto-launch", browser.autoLaunch ? "enabled" : "disabled"),
    ...(browser.cdpUrl !== undefined ? [kv("CDP URL", browser.cdpUrl)] : []),
    ...(browser.launchExecutable !== undefined ? [kv("Launch executable", browser.launchExecutable)] : []),
    ...(browser.launchArgs !== undefined ? [kv("Launch args", String(browser.launchArgs.length))] : []),
    ...(browser.chromeFlags !== undefined ? [kv("Chrome flags", String(browser.chromeFlags.length))] : []),
    ...(browser.launchCommand !== undefined ? [kv("Deprecated launch command", "configured")] : []),
    kv("Hybrid routing", browser.hybridRouting ? "enabled" : "disabled"),
    kv("Web extraction", web.enableNetwork ? "enabled" : "disabled"),
    kv("Change with", "estacoda browser setup --backend local-cdp --cdp-url http://127.0.0.1:9222 --launch-executable /path/to/chrome --launch-arg --headless=new --chrome-flag --no-first-run"),
    kv("Cloud routing", "estacoda browser setup --backend browserbase --cloud-provider browserbase --hybrid-routing"),
  ];
  return buildKeyValueBlockViewModel({
    title: "EstaCoda settings: browser",
    entries,
  });
}

export function renderBrowserSettings(browser: BrowserConfig, web: WebConfig): string {
  return renderPlain(buildBrowserSettingsViewModel(browser, web));
}

// ──────────────────────────────────────
// Telegram settings
// ──────────────────────────────────────
type TelegramConfig = LoadedRuntimeConfig["channels"]["telegram"];

export function buildTelegramSettingsViewModel(telegram: TelegramConfig): ViewModel {
  const entries = [
    kv(
      "Status",
      telegram.ready
        ? "ready"
        : telegram.enabled
          ? "configured, missing credentials"
          : "disabled"
    ),
    ...(telegram.botTokenEnv !== undefined
      ? [kv("Bot token env", telegram.botTokenEnv)]
      : []),
    kv("Allowed users", (telegram.allowedUserIds ?? []).join(", ") || "none"),
    kv("Allowed chats", (telegram.allowedChatIds ?? []).join(", ") || "none"),
    kv(
      "Next",
      telegram.ready
        ? "start the gateway with estacoda gateway run."
        : "Change with: estacoda telegram setup"
    ),
  ];
  return buildKeyValueBlockViewModel({
    title: "EstaCoda settings: telegram",
    entries,
  });
}

export function renderTelegramSettings(telegram: TelegramConfig): string {
  return renderPlain(buildTelegramSettingsViewModel(telegram));
}

// ──────────────────────────────────────
// UI settings
// ──────────────────────────────────────
type UiConfig = LoadedRuntimeConfig["ui"];

export function buildUiSettingsViewModel(ui: UiConfig): ViewModel {
  return buildKeyValueBlockViewModel({
    title: "EstaCoda settings: ui",
    entries: [
      kv("Language", ui.language),
      kv("Flavor", ui.flavor),
      kv("Activity labels", ui.activityLabels),
      kv("Response progress", ui.showResponseProgress ? "shown" : "hidden"),
      kv("Change with", "estacoda settings ui --language ar --flavor arabic-light --activity-labels ar"),
    ],
  });
}

export function renderUiSettings(ui: UiConfig): string {
  return renderPlain(buildUiSettingsViewModel(ui));
}
