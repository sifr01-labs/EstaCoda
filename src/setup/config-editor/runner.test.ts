import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { Prompt } from "../../cli/readline-prompt.js";
import type { SelectPromptInput } from "../../cli/interactive-select.js";
import { WorkspaceTrustStore } from "../../security/workspace-trust-store.js";
import type { ProviderId, ProviderApiMode, ProviderAuthMethod } from "../../contracts/provider.js";
import type { FlowEngine } from "../../providers/provider-model-selection-flow.js";
import { createReviewedSetupApplyExecutor } from "../review/apply-executor.js";
import { __decideConfigEditorLoopForTest, runConfigEditor } from "./runner.js";
import {
  promptAuxiliaryModelTask,
  promptBrowserCapability,
  promptChannelCapability,
  promptConfigEditorAction,
  promptConfigEditorPostApplyAction,
  promptConfigEditorReviewApproval,
  promptIncompleteChannelCapabilityAction,
  promptIncompleteTelegramCapabilityAction,
  promptOptionalCapabilityAction,
  promptedBrowserCapabilityMode,
  promptSecurityMode,
  promptSttCapability,
  promptTtsCapability,
  promptVisionCapability,
  promptVoiceCapability,
  promptWebSearchCapability,
  promptWorkflowLearning,
  promptWorkspaceTrustConfirmation,
  setupEditorReviewSelectedAreaLabel,
} from "./prompts.js";
import type { SetupReviewManifest } from "../setup-review-manifest.js";
import type { SetupRouteDecision } from "../setup-router.js";
import { resolveProfileStateHome, writeActiveProfile } from "../../config/profile-home.js";
import { promptInterfaceLanguageAndStyle } from "../interface-preferences.js";
import { isolateLtr } from "../../ui/bidi.js";
import {
  gatewayServiceActivationNotNowGuidance,
  gatewayServiceActivationPromptTitle,
  type GatewayActivationServiceActions,
} from "../gateway-service-activation.js";
import { resolveSetupCopy } from "../setup-copy.js";
import type { SetupApplyMode, SetupDeferredSecretWrite } from "../setup-apply-plan.js";
import type { WhatsAppPairDeviceOptions, WhatsAppSetupDependencies } from "../whatsapp-setup-flow.js";
import * as pythonEnvManager from "../../python-env/manager.js";
import * as capabilityManager from "../../python-env/capability-manager.js";
import { DDGS_CAPABILITY_ID } from "../../python-env/capability-registry.js";

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "estacoda-config-editor-"));
}

function mockManagedPythonEnvironment(homeDir: string): void {
  vi.spyOn(pythonEnvManager, "createManagedEnvironment").mockResolvedValue({
    ok: true,
    pythonBinary: join(homeDir, ".estacoda", "python-env", "bin", "python"),
  });
}

describe("runConfigEditor", () => {
  let tempDir: string;
  let workspaceRoot: string;

  beforeEach(async () => {
    tempDir = await makeTempDir();
    workspaceRoot = join(tempDir, "workspace");
    await mkdir(workspaceRoot, { recursive: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    delete process.env.PR8_SHELL_ONLY_KEY;
    delete process.env.ESTACODA_TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.DISCORD_BOT_TOKEN;
    delete process.env.BROWSERBASE_API_KEY;
    delete process.env.BROWSERBASE_PROJECT_ID;
    delete process.env.BRAVE_SEARCH_API_KEY;
    await chmod(join(tempDir, ".estacoda"), 0o700).catch(() => undefined);
    await rm(tempDir, { recursive: true, force: true });
  });

  it("renders configured setup sections and exits without mutating config", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    await trustWorkspace(tempDir, workspaceRoot);
    const before = await readFile(profileConfigPath(tempDir), "utf8");
    const output: string[] = [];
    let applyCalled = false;

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt(),
      defaultActionId: "cancel-setup-editor",
      applyExecutor: {
        apply: () => {
          applyCalled = true;
          return { ok: true, appliedOperationIds: [] };
        },
      },
      output: { write: (value) => output.push(value) },
    });

    expect(result.completed).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.initialDecision.kind).toBe("configured-menu");
    expect(result.initialDecision.setupEditorPlanSession?.metadata.mode).toBe("configured");
    expect(result.selectedActionId).toBe("exit");
    expect(result.reviewManifest).toBeUndefined();
    expect(result.applyPlanningResult).toBeUndefined();
    expect(result.applyEndState).toBeUndefined();
    expect(applyCalled).toBe(false);
    expect(output.join("")).toContain("Setup Editor");
    expect(output.join("")).toContain("Available actions:");
    expect(output.join("")).toContain("edit-fallback-model-route");
    expect(output.join("")).toContain("Backup model used if the primary model fails.");
    expect(output.join("")).toContain("edit-auxiliary-model-route");
    expect(output.join("")).toContain("Models used for assessment, compression, recall, and memory.");
    expect(output.join("")).toContain("edit-security-mode");
    expect(output.join("")).toContain("edit-workflow-learning");
    expect(output.join("")).toContain("edit-language - Language");
    expect(output.join("")).toContain("configure-channels");
    expect(output.join("")).toContain("configure-voice");
    expect(output.join("")).toContain("configure-image-generation");
    expect(output.join("")).toContain("configure-browser");
    expect(output.join("")).not.toContain("edit-primary-credential-reference");
    expect(output.join("")).not.toContain("review-optional-capabilities");
    expect(output.join("")).toContain("verify-setup - Setup verification");
    expect(output.join("")).toContain("show-diagnostics - Diagnostics");
    expect(output.join("")).toContain("exit - Exit without changes");
    await expect(readFile(profileConfigPath(tempDir), "utf8")).resolves.toBe(before);
  });

  it("renders setup editor copy with the configured Arabic locale", async () => {
    await writeUserConfig(tempDir, {
      ...localReadyConfig(),
      ui: {
        language: "ar",
        flavor: "arabic-light",
        activityLabels: "ar",
      },
    });
    await trustWorkspace(tempDir, workspaceRoot);
    const output: string[] = [];
    const prompts: Array<{
      title: string;
      body: string;
      labels: string[];
      descriptions: Array<string | undefined>;
      groups: Array<string | undefined>;
      bodyLineStyles: SelectPromptInput<unknown>["bodyLineStyles"];
      columns: SelectPromptInput<unknown>["columns"];
      showColumnHeaders: SelectPromptInput<unknown>["showColumnHeaders"];
      hint: string | undefined;
      values: unknown[];
    }> = [];
    const prompt = fakePrompt();
    prompt.select = async (input) => {
      prompts.push({
        title: input.title,
        body: input.body ?? "",
        labels: input.options.map((option) => option.label),
        descriptions: input.options.map((option) => option.description),
        groups: input.options.map((option) => option.group),
        bodyLineStyles: input.bodyLineStyles,
        columns: input.columns,
        showColumnHeaders: input.showColumnHeaders,
        hint: input.hint,
        values: input.options.map((option) => option.value),
      });
      const exit = input.options.find((option) =>
        typeof option.value === "object" &&
        option.value !== null &&
        "id" in option.value &&
        option.value.id === "exit"
      );
      return exit?.value ?? input.options[0]!.value;
    };

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt,
      applyExecutor: createReviewedSetupApplyExecutor({
        homeDir: tempDir,
        workspaceRoot,
      }),
      output: { write: (value) => output.push(value) },
    });

    expect(result.completed).toBe(true);
    expect(result.selectedActionId).toBe("exit");
    expect(output.join("")).toContain("محرّر الإعدادات");
    expect(output.join("")).toContain("النموذج الأساسي");
    expect(output.join("")).toContain("النموذج الافتراضي الذي يستخدمه الوكيل.");
    expect(output.join("")).toContain("قنوات تحكم عن بُعد مثل");
    expect(output.join("")).toContain(isolateLtr("Telegram"));
    expect(prompts[0]?.title).toBe("محرّر الإعدادات");
    expect(prompts[0]?.body).toBe("اختار اللي تحب تضبطه:");
    expect(prompts[0]?.body).not.toContain("\x1b[");
    expect(prompts[0]?.bodyLineStyles).toEqual([{ emphasis: "strong" }]);
    expect(prompts[0]?.columns).toEqual([
      { key: "name", header: "الاسم" },
      { key: "description", header: "التفاصيل" },
    ]);
    expect(prompts[0]?.showColumnHeaders).toBe(false);
    expect(prompts[0]?.hint).toBe("↑↓ navigate   ENTER select   CTRL+C exit");
    expect(prompts[0]?.labels).toContain("النموذج الأساسي");
    expect(prompts[0]?.descriptions).toContain("النموذج الافتراضي الذي يستخدمه الوكيل.");
    expect(prompts[0]?.labels).toContain("القنوات");
    expect(prompts[0]?.descriptions).toContain(resolveSetupCopy("ar", "setupEditor.actions.configureChannels.description"));
    expect(prompts[0]?.labels).toContain("التحقق من الإعداد");
    expect(prompts[0]?.labels).toContain("التشخيصات");
    expect(prompts[0]?.labels).toContain("الخروج دون تغييرات");
    expect(prompts[0]?.descriptions).toContain("غادر الإعداد دون تعديل التكوين.");
    expect(prompts[0]?.values.map((value) =>
      typeof value === "object" && value !== null && "id" in value ? value.id : undefined
    )).toEqual([
      "edit-primary-model-route",
      "edit-fallback-model-route",
      "edit-auxiliary-model-route",
      "configure-channels",
      "configure-voice",
      "configure-image-generation",
      "configure-web-search",
      "configure-browser",
      "edit-security-mode",
      "edit-workflow-learning",
      "edit-language",
      "verify-setup",
      "show-diagnostics",
      "exit",
    ]);
    const exitActionIndex = prompts[0]?.labels.indexOf("الخروج دون تغييرات") ?? -1;
    expect(prompts[0]?.groups[exitActionIndex]).toBe("navigation");
    expect(prompts[0]?.groups[prompts[0]?.labels.indexOf("التحقق من الإعداد") ?? -1]).toBeUndefined();
    expect(prompts[0]?.groups[prompts[0]?.labels.indexOf("التشخيصات") ?? -1]).toBeUndefined();
  });

  it("opts comparative setup editor selectors into columns without changing selected values", async () => {
    const prompt = fakePrompt({
      values: [
        "configure-channels",
        "whatsapp",
        "brave",
        "compression",
        "tts",
        "openai",
        "",
        "",
        "local",
        "small",
        "fal",
        "",
        "",
        false,
        "disabled",
        "unchanged",
        "skip",
        "unchanged",
      ],
    });
    const selectInputs: SelectPromptInput<unknown>[] = [];
    const baseSelect = prompt.select!;
    prompt.select = async (input) => {
      selectInputs.push(input as SelectPromptInput<unknown>);
      return baseSelect(input);
    };

    const selectedAction = await promptConfigEditorAction(prompt, [
      {
        id: "configure-channels",
        label: "Configure channels",
        description: "Configure remote-control channels.",
        readOnly: false,
        source: "editor",
      },
    ]);
    const channel = await promptChannelCapability(prompt);
    const webSearch = await promptWebSearchCapability(prompt, { ddgsCapabilityStatus: "ready" });
    const auxiliaryTask = await promptAuxiliaryModelTask(prompt);
    const voiceMode = await promptVoiceCapability(prompt);
    const tts = await promptTtsCapability(prompt, {});
    const stt = await promptSttCapability(prompt, {});
    const vision = await promptVisionCapability(prompt, {});
    const browser = await promptBrowserCapability(prompt, {});
    const optionalAction = await promptOptionalCapabilityAction(prompt, {
      id: "voice",
      title: "Voice",
      configured: false,
    });
    const incompleteChannelAction = await promptIncompleteChannelCapabilityAction(prompt, {
      title: "WhatsApp beta",
      bodyKey: "setupEditor.prompt.whatsapp.incomplete.body",
    });
    const incompleteTelegramAction = await promptIncompleteTelegramCapabilityAction(prompt);

    expect(selectedAction?.id).toBe("configure-channels");
    expect(channel).toBe("whatsapp");
    expect(webSearch).toEqual({ provider: "brave", braveApiKeyEnv: "BRAVE_SEARCH_API_KEY" });
    expect(auxiliaryTask).toBe("compression");
    expect(voiceMode).toBe("tts");
    expect(tts.ttsProvider).toBe("openai");
    expect(stt.sttProvider).toBe("local");
    expect(stt.sttModel).toBe("small");
    expect(vision.provider).toBe("fal");
    expect(vision.useGateway).toBe(false);
    expect(browser.backend).toBe("unconfigured");
    expect(optionalAction).toBe("unchanged");
    expect(incompleteChannelAction).toBe("skip");
    expect(incompleteTelegramAction).toBe("unchanged");

    const columnTitles = selectInputs
      .filter((input) => input.columns !== undefined)
      .map((input) => input.title);
    expect(columnTitles).toEqual([
      "Setup editor",
      "Choose channel",
      "Search provider",
      "Choose auxiliary model.",
      "Configure voice",
      "Voice",
      "Voice",
      "Configure STT",
      "Vision and Image Generation",
      "Browser configuration",
      "Voice",
      "WhatsApp beta",
      "Telegram",
    ]);
    expect(selectInputs.find((input) => input.title === "Setup editor")?.bodyLineStyles).toEqual([
      { emphasis: "strong" },
    ]);
    for (const input of selectInputs.filter((item) => item.columns !== undefined)) {
      expect(input.columns).toEqual([
        { key: "name", header: "Name" },
        { key: "description", header: "Details" },
      ]);
      expect(input.showColumnHeaders).toBe(false);
      expect(input.options.every((option) => option.cells === undefined)).toBe(true);
    }
    const webSearchInput = selectInputs.find((input) =>
      input.options.some((option) => option.id === "web-search-none")
    );
    const browserModeInput = selectInputs.find((input) =>
      input.options.some((option) => option.id === "browser-disabled")
    );
    const optionalActionInput = selectInputs.find((input) =>
      input.options.some((option) => option.id === "voice-enable")
    );
    const incompleteChannelInput = selectInputs.find((input) =>
      input.options.some((option) => option.id === "channel-incomplete-retry")
    );
    const incompleteTelegramInput = selectInputs.find((input) =>
      input.options.some((option) => option.id === "telegram-incomplete-retry")
    );
    expect(webSearchInput?.options.find((option) => option.id === "web-search-none")?.group).toBeUndefined();
    expect(browserModeInput?.options.find((option) => option.id === "browser-disabled")?.group).toBeUndefined();
    expect(optionalActionInput?.options.find((option) => option.id === "voice-enable")?.group).toBeUndefined();
    expect(optionalActionInput?.options.find((option) => option.id === "voice-unchanged")?.group).toBe("navigation");
    expect(optionalActionInput?.options.find((option) => option.id === "voice-skip")?.group).toBe("navigation");
    expect(incompleteChannelInput?.options.every((option) => option.group === "navigation")).toBe(true);
    expect(incompleteTelegramInput?.options.every((option) => option.group === "navigation")).toBe(true);
    expect(selectInputs.find((input) =>
      input.title === "Image generation" &&
      input.options.some((option) => option.id === "gateway-no")
    )?.columns).toBeUndefined();
    expect(selectInputs.find((input) =>
      input.title === "Image generation" &&
      input.options.some((option) => option.id === "gateway-no")
    )?.options.find((option) => option.id === "gateway-no")?.group).toBeUndefined();
  });

  it("keeps language and confirmation setup prompts stacked", async () => {
    const prompt = fakePrompt({
      values: [
        "ar",
        false,
        false,
        "exit",
        "ddgs",
        false,
        "local-supervised",
        false,
        "",
        "",
        "",
        "",
        "fal",
        "",
        "",
        true,
      ],
    });
    const selectInputs: SelectPromptInput<unknown>[] = [];
    const baseSelect = prompt.select!;
    prompt.select = async (input) => {
      selectInputs.push(input as SelectPromptInput<unknown>);
      return baseSelect(input);
    };

    const language = await promptInterfaceLanguageAndStyle(prompt);
    const trust = await promptWorkspaceTrustConfirmation(prompt, {
      workspaceRoot,
      trustStorePath: join(tempDir, ".estacoda", "trust.json"),
    });
    const review = await promptConfigEditorReviewApproval(prompt, {
      selectedActionId: "edit-security-mode",
      reviewManifest: minimalManifest(),
    });
    const postApply = await promptConfigEditorPostApplyAction(prompt, {
      state: "ready",
      launchEligible: false,
      limitedModeEligible: false,
    });
    const ddgs = await promptWebSearchCapability(prompt, { ddgsCapabilityStatus: "missing" });
    const browser = await promptBrowserCapability(prompt, {});
    const vision = await promptVisionCapability(prompt, {});

    expect(language.language).toBe("ar");
    expect(trust).toBe(false);
    expect(review).toBe(false);
    expect(postApply).toBe("exit");
    expect(ddgs).toEqual({ provider: "ddgs", ddgsSetupConfirmed: false });
    expect(browser.backend).toBe("local-cdp");
    expect(browser.autoLaunch).toBe(false);
    expect(vision.useGateway).toBe(true);

    const languageInput = selectInputs.find((input) => input.title === "Setup language");
    expect(languageInput?.columns).toBeUndefined();
    expect(languageInput?.hint).toBe("↑↓ navigate   ENTER select   CTRL+C exit");
    expect(languageInput?.options.map((option) => option.label)).toEqual([
      "English",
      "العربية",
    ]);
    expect(languageInput?.options.some((option) => option.group === "navigation")).toBe(false);
    expect(selectInputs.find((input) => input.title === "Workspace trust")?.columns).toBeUndefined();
    expect(selectInputs.find((input) => input.title === "Workspace trust")?.hint).toBe(
      "↑↓ navigate   ENTER select   CTRL+C exit"
    );
    expect(selectInputs.find((input) => input.title === "Finalize configuration")?.columns).toBeUndefined();
    expect(selectInputs.find((input) => input.title === "Setup next action")?.columns).toBeUndefined();
    expect(selectInputs.find((input) => input.title === "DDGS setup")?.columns).toBeUndefined();
    expect(selectInputs.find((input) => input.title === "Local supervised browser")?.columns).toBeUndefined();
    expect(selectInputs.find((input) =>
      input.title === "Image generation" &&
      input.options.some((option) => option.id === "gateway-yes")
    )?.columns).toBeUndefined();
    expect(languageInput?.statusLines).toBeUndefined();
    const trustInput = selectInputs.find((input) => input.title === "Workspace trust");
    const reviewInput = selectInputs.find((input) => input.title === "Finalize configuration");
    const postApplyInput = selectInputs.find((input) => input.title === "Setup next action");
    const autoLaunchInput = selectInputs.find((input) => input.title === "Local supervised browser");
    const gatewayInput = selectInputs.find((input) =>
      input.title === "Image generation" &&
      input.options.some((option) => option.id === "gateway-yes")
    );
    expect(trustInput?.options.find((option) => option.id === "trust")?.group).toBeUndefined();
    expect(trustInput?.options.find((option) => option.id === "cancel")?.group).toBe("navigation");
    expect(reviewInput?.options.find((option) => option.id === "approve")?.group).toBeUndefined();
    expect(reviewInput?.options.find((option) => option.id === "cancel")?.group).toBe("navigation");
    expect(postApplyInput?.options.find((option) => option.id === "exit")?.group).toBe("navigation");
    expect(autoLaunchInput?.options.find((option) => option.id === "browser-auto-launch-no")?.group).toBeUndefined();
    expect(gatewayInput?.options.find((option) => option.id === "gateway-no")?.group).toBeUndefined();
    expect(gatewayInput?.options.find((option) => option.id === "gateway-yes")?.group).toBeUndefined();
  });

  it("shows current language and Back in the setup editor language selector without adding columns", async () => {
    const prompt = fakePrompt();
    const selectInputs = captureSelectInputs(prompt);

    const result = await promptInterfaceLanguageAndStyle(prompt, {
      initialLocale: "ar",
      currentLanguage: "ar",
      currentFlavor: "arabic-light",
      showCurrentState: true,
      allowBack: true,
    });

    const input = selectInputs.find((item) => item.title === resolveSetupCopy("ar", "onboarding.interfaceLanguage.title"));
    expect(result).toEqual({
      kind: "selected",
      selection: {
        language: "ar",
        flavor: "arabic-light",
        activityLabels: "ar",
      },
    });
    expect(input?.columns).toBeUndefined();
    expect(input?.statusLines).toEqual([{ text: "الحالي: العربية", tone: "active", direction: "rtl" }]);
    expect(input?.showCurrentBadge).toBe(false);
    expect(input?.defaultIndex).toBe(1);
    expect(input?.options.find((option) => option.id === "ar")?.current).toBe(true);
    expect(input?.options.find((option) => option.id === "en")?.current).toBe(false);
    expect(input?.options.find((option) => option.id === "back")).toEqual(expect.objectContaining({
      label: "رجوع",
      description: "ارجع إلى الخطوة السابقة.",
      group: "navigation",
    }));
    expect(input?.options.find((option) => option.id === "back")?.current).toBeUndefined();
    expect(input?.options.find((option) => option.id === "back")?.badges).toBeUndefined();
  });

  it("shows current security and Agent Evolution state with current rows", async () => {
    const prompt = fakePrompt();
    const selectInputs = captureSelectInputs(prompt);

    const securityMode = await promptSecurityMode(prompt, "strict");
    const workflowLearning = await promptWorkflowLearning(prompt, "proactive");

    const securityInput = selectInputs.find((input) => input.title === "Security mode");
    const workflowInput = selectInputs.find((input) => input.title === "Agent Evolution");
    expect(securityMode).toBe("strict");
    expect(workflowLearning).toBe("proactive");
    expect(securityInput?.statusLines).toEqual([{ text: "Current: Strict", tone: "active", direction: "ltr" }]);
    expect(securityInput?.showCurrentBadge).toBe(false);
    expect(securityInput?.defaultIndex).toBe(0);
    expect(securityInput?.options.find((option) => option.id === "strict")?.current).toBe(true);
    expect(workflowInput?.statusLines).toEqual([{ text: "Current: Proactive", tone: "active", direction: "ltr" }]);
    expect(workflowInput?.showCurrentBadge).toBe(false);
    expect(workflowInput?.defaultIndex).toBe(2);
    expect(workflowInput?.options.find((option) => option.id === "proactive")?.current).toBe(true);
  });

  it("shows current optional capability state without exposing credential fields", async () => {
    const prompt = fakePrompt();
    const selectInputs = captureSelectInputs(prompt);

    await promptWebSearchCapability(prompt, {
      searchBackend: "brave",
      braveApiKeyEnv: "SHOULD_NOT_APPEAR",
      ddgsCapabilityStatus: "ready",
    });
    await promptTtsCapability(prompt, {
      ttsProvider: "openai",
      ttsModel: "gpt-4o-mini-tts",
      ttsApiKeyEnv: "SHOULD_NOT_APPEAR",
    });
    await promptSttCapability(prompt, {
      sttProvider: "local",
      sttModel: "small",
      sttApiKeyEnv: "SHOULD_NOT_APPEAR",
    });
    await promptVisionCapability(prompt, {
      provider: "byteplus",
      model: "seedream-4",
      apiKeyEnv: "SHOULD_NOT_APPEAR",
      useGateway: true,
    });
    await promptBrowserCapability(prompt, {
      backend: "local-cdp",
      autoLaunch: true,
      supervised: true,
      engine: "cdp",
    });

    const searchInput = selectInputs.find((input) => input.title === "Search provider");
    const voiceInputs = selectInputs.filter((input) => input.title === "Voice");
    const localSttInput = selectInputs.find((input) => input.title === "Configure STT");
    const visionInput = selectInputs.find((input) => input.title === "Vision and Image Generation");
    const browserInput = selectInputs.find((input) => input.title === "Browser configuration");
    const allStatusText = selectInputs.flatMap((input) => input.statusLines ?? []).map((line) => line.text).join("\n");

    expect(searchInput?.statusLines).toEqual([{ text: "Current: Brave Search", tone: "active", direction: "ltr" }]);
    expect(searchInput?.defaultIndex).toBe(0);
    expect(searchInput?.options.find((option) => option.id === "web-search-brave")?.current).toBe(true);
    expect(voiceInputs[0]?.statusLines).toEqual([{ text: "Current: openai/gpt-4o-mini-tts", tone: "active", direction: "ltr" }]);
    expect(voiceInputs[0]?.options.find((option) => option.id === "tts-openai")?.current).toBe(true);
    expect(voiceInputs[1]?.statusLines).toEqual([{ text: "Current: local/small", tone: "active", direction: "ltr" }]);
    expect(voiceInputs[1]?.options.find((option) => option.id === "stt-local")?.current).toBe(true);
    expect(localSttInput?.statusLines).toEqual([{ text: "Current: Small", tone: "active", direction: "ltr" }]);
    expect(localSttInput?.defaultIndex).toBe(1);
    expect(localSttInput?.options.find((option) => option.id === "local-stt-model-small")?.current).toBe(true);
    expect(visionInput?.statusLines).toEqual([{ text: "Current: byteplus/seedream-4", tone: "active", direction: "ltr" }]);
    expect(visionInput?.options.find((option) => option.id === "byteplus")?.current).toBe(true);
    expect(browserInput?.statusLines).toEqual([{ text: "Current: Recommended browser setup", tone: "active", direction: "ltr" }]);
    expect(browserInput?.options.find((option) => option.id === "browser-recommended")?.current).toBe(true);
    expect(selectInputs.every((input) => input.showCurrentBadge === undefined || input.showCurrentBadge === false)).toBe(true);
    expect(allStatusText).not.toContain("SHOULD_NOT_APPEAR");
  });

  it("does not invent a current web search provider when current state is missing", async () => {
    const prompt = fakePrompt();
    const selectInputs = captureSelectInputs(prompt);

    const webSearch = await promptWebSearchCapability(prompt, { ddgsCapabilityStatus: "missing" });

    const searchInput = selectInputs.find((input) => input.title === "Search provider");
    expect(webSearch).toEqual({ provider: "none" });
    expect(searchInput?.defaultIndex).toBe(2);
    expect(searchInput?.statusLines).toBeUndefined();
    expect(searchInput?.showCurrentBadge).toBeUndefined();
    expect(searchInput?.options.some((option) => option.current === true)).toBe(false);
  });

  it("groups DDGS install skip as navigation without grouping web search provider choices", async () => {
    const prompt = fakePrompt({ values: ["ddgs", false] });
    const selectInputs = captureSelectInputs(prompt);

    const webSearch = await promptWebSearchCapability(prompt, { ddgsCapabilityStatus: "missing" });

    const searchInput = selectInputs.find((input) => input.title === "Search provider");
    const installInput = selectInputs.find((input) => input.title === "DDGS setup");
    expect(webSearch).toEqual({ provider: "ddgs", ddgsSetupConfirmed: false });
    expect(searchInput?.options.find((option) => option.id === "web-search-brave")?.group).toBeUndefined();
    expect(searchInput?.options.find((option) => option.id === "web-search-ddgs")?.group).toBeUndefined();
    expect(searchInput?.options.find((option) => option.id === "web-search-none")?.group).toBeUndefined();
    expect(installInput?.options.find((option) => option.id === "web-search-ddgs-install-confirm")?.group)
      .toBeUndefined();
    expect(installInput?.options.find((option) => option.id === "web-search-ddgs-install-skip")?.group)
      .toBe("navigation");
  });

  it("groups every post-apply action as navigation without changing selected action ids", async () => {
    const prompt = fakePrompt({ values: ["repair-again"] });
    const selectInputs = captureSelectInputs(prompt);

    const action = await promptConfigEditorPostApplyAction(prompt, {
      state: "degraded",
      launchEligible: true,
      limitedModeEligible: true,
    });

    const postApplyInput = selectInputs.find((input) => input.title === "Setup next action");
    expect(action).toBe("repair-again");
    expect(postApplyInput?.options.map((option) => option.id)).toEqual([
      "launch",
      "accept-limited-mode",
      "repair-again",
      "exit",
    ]);
    expect(postApplyInput?.options.map((option) => option.value)).toEqual([
      "launch",
      "accept-limited-mode",
      "repair-again",
      "exit",
    ]);
    expect(postApplyInput?.options.every((option) => option.group === "navigation")).toBe(true);
  });

  it("marks DDGS as current when web search state is explicitly DDGS", async () => {
    const prompt = fakePrompt();
    const selectInputs = captureSelectInputs(prompt);

    const webSearch = await promptWebSearchCapability(prompt, {
      searchBackend: "ddgs",
      ddgsCapabilityStatus: "ready",
    });

    const searchInput = selectInputs.find((input) => input.title === "Search provider");
    expect(webSearch).toEqual({ provider: "ddgs", ddgsSetupConfirmed: false });
    expect(searchInput?.defaultIndex).toBe(1);
    expect(searchInput?.statusLines).toEqual([{ text: "Current: DuckDuckGo / DDGS", tone: "active", direction: "ltr" }]);
    expect(searchInput?.showCurrentBadge).toBe(false);
    expect(searchInput?.options.find((option) => option.id === "web-search-ddgs")?.current).toBe(true);
    expect(searchInput?.options.find((option) => option.id === "web-search-none")?.current).toBe(false);
  });

  it("prepares the read-only verification route without applying changes", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    await trustWorkspace(tempDir, workspaceRoot);

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt(),
      defaultActionId: "run-readonly-verification",
    });

    expect(result.completed).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.selectedActionId).toBe("verify-setup");
    expect(result.finalDecision?.kind).toBe("verify-readonly");
    expect(result.finalDecision?.setupEditorPlanSession).toBeUndefined();
    expect(result.output).toContain("Setup verification prepared");
  });

  it("shows diagnostics for configured states without requiring a repair route action", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    await trustWorkspace(tempDir, workspaceRoot);

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt(),
      defaultActionId: "show-diagnostics",
    });

    expect(result.completed).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.initialDecision.kind).toBe("configured-menu");
    expect(result.selectedActionId).toBe("show-diagnostics");
    expect(result.output).toContain("Setup diagnostics");
    expect(result.output).toContain("State: configured-ready");
  });

  it("rejects unsupported route actions in the guided editor", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    await trustWorkspace(tempDir, workspaceRoot);

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt(),
      defaultActionId: "review-edit-config",
    });

    expect(result.completed).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.selectedActionId).toBe("review-edit-config");
    expect(result.output).toContain("not available in the setup editor");
    expect(result.reviewManifest).toBeUndefined();
    expect(result.applyPlanningResult).toBeUndefined();
    expect(result.applyEndState).toBeUndefined();
  });

  it("applies reviewed security mode changes while preserving unrelated config", async () => {
    await writeUserConfig(tempDir, {
      ...localReadyConfig(),
      security: {
        approvalMode: "adaptive",
        assessor: {
          enabled: true,
        },
      },
    });
    await trustWorkspace(tempDir, workspaceRoot);
    const reviewPrompts: Array<{ title: string; body?: string; labels: string[]; descriptions: Array<string | undefined> }> = [];
    const prompt = fakePrompt({ values: ["strict"] });
    const baseSelect = prompt.select!;
    prompt.select = async (input) => {
      if (input.title === "Finalize configuration") {
        reviewPrompts.push({
          title: input.title,
          body: input.body,
          labels: input.options.map((option) => option.label),
          descriptions: input.options.map((option) => option.description),
        });
      }
      return baseSelect(input);
    };

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt,
      defaultActionId: "edit-security-mode",
      applyExecutor: createReviewedSetupApplyExecutor({
        homeDir: tempDir,
        workspaceRoot,
      }),
    });

    const config = JSON.parse(await readFile(profileConfigPath(tempDir), "utf8")) as {
      model?: unknown;
      providers?: unknown;
      security?: { approvalMode?: string; assessor?: { enabled?: boolean } };
    };

    expect(result.completed).toBe(true);
    expect(result.selectedActionId).toBe("edit-security-mode");
    expect(result.reviewManifest?.sections["security-mode"].length).toBe(1);
    expect(result.reviewManifest?.sections["verification-checks"].length).toBe(1);
    expect(result.applyPlanningResult?.kind).toBe("apply-plan-ready");
    expect(reviewPrompts).toEqual([expect.objectContaining({
      title: "Finalize configuration",
      body: expect.stringContaining("Selected area: Security"),
      labels: ["Confirm", "Cancel"],
      descriptions: ["Update your EstaCoda configuration", "Keep your existing configuration unchanged."],
    })]);
    expect(config.security?.approvalMode).toBe("strict");
    expect(config.security?.assessor?.enabled).toBe(true);
    expect(config.model).toEqual((localReadyConfig() as { model: unknown }).model);
    expect(config.providers).toEqual((localReadyConfig() as { providers: unknown }).providers);
  });

  it("passes strict mode to setup editor apply execution", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    await trustWorkspace(tempDir, workspaceRoot);
    let observedMode: SetupApplyMode | undefined;

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({ values: ["strict"] }),
      defaultActionId: "edit-security-mode",
      applyExecutor: {
        apply: (_plan, context) => {
          observedMode = context?.mode;
          return {
            ok: true,
            appliedOperationIds: [],
          };
        },
      },
    });

    expect(result.completed).toBe(true);
    expect(result.selectedActionId).toBe("edit-security-mode");
    expect(result.applyEndState?.kind).toBe("saved-not-launched");
    expect(observedMode).toBe("strict");
  });

  it("writes active profile config without prompting for profile awareness", async () => {
    await writeUserConfig(tempDir, localReadyConfig("default-local"), "default");
    await writeUserConfig(tempDir, {
      ...localReadyConfig("work-local"),
      security: { approvalMode: "adaptive" },
    }, "work");
    writeActiveProfile("work", { homeDir: tempDir });
    await trustWorkspace(tempDir, workspaceRoot);

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({ values: ["strict"] }),
      defaultActionId: "edit-security-mode",
      applyExecutor: createReviewedSetupApplyExecutor({
        homeDir: tempDir,
        workspaceRoot,
      }),
    });

    const defaultConfig = JSON.parse(await readFile(profileConfigPath(tempDir, "default"), "utf8")) as {
      model?: { id?: string };
      security?: { approvalMode?: string };
    };
    const workConfig = JSON.parse(await readFile(profileConfigPath(tempDir, "work"), "utf8")) as {
      model?: { id?: string };
      security?: { approvalMode?: string };
    };

    expect(result.completed).toBe(true);
    expect(result.output).not.toMatch(/\bprofiles?\b/iu);
    expect(defaultConfig.model?.id).toBe("default-local");
    expect(defaultConfig.security?.approvalMode).toBeUndefined();
    expect(workConfig.model?.id).toBe("work-local");
    expect(workConfig.security?.approvalMode).toBe("strict");
  });


  it("applies reviewed Agent Evolution changes while preserving unrelated skill config", async () => {
    await writeUserConfig(tempDir, {
      ...localReadyConfig(),
      skills: {
        autonomy: "suggest",
        externalDirs: ["/tmp/estacoda-skills"],
      },
    });
    await trustWorkspace(tempDir, workspaceRoot);

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({ values: ["autonomous"] }),
      defaultActionId: "edit-workflow-learning",
      applyExecutor: createReviewedSetupApplyExecutor({
        homeDir: tempDir,
        workspaceRoot,
      }),
    });

    const config = JSON.parse(await readFile(profileConfigPath(tempDir), "utf8")) as {
      skills?: { autonomy?: string; externalDirs?: string[] };
    };

    expect(result.completed).toBe(true);
    expect(result.selectedActionId).toBe("edit-workflow-learning");
    expect(result.reviewManifest?.sections["workflow-learning"].length).toBe(1);
    expect(result.applyPlanningResult?.kind).toBe("apply-plan-ready");
    expect(config.skills?.autonomy).toBe("autonomous");
    expect(config.skills?.externalDirs).toEqual(["/tmp/estacoda-skills"]);
  });

  it("applies reviewed language changes through shared interface preference prompts", async () => {
    await writeUserConfig(tempDir, {
      ...localReadyConfig(),
      ui: {
        language: "en",
        flavor: "standard",
        activityLabels: "en",
      },
      security: {
        approvalMode: "adaptive",
      },
    });
    await trustWorkspace(tempDir, workspaceRoot);
    const prompts: Array<{ title: string; labels: string[]; descriptions: Array<string | undefined>; groups: Array<string | undefined> }> = [];
    const prompt = fakePrompt({ values: ["ar"] });
    const baseSelect = prompt.select!;
    prompt.select = async (input) => {
      prompts.push({
        title: input.title,
        labels: input.options.map((option) => option.label),
        descriptions: input.options.map((option) => option.description),
        groups: input.options.map((option) => option.group),
      });
      return baseSelect(input);
    };

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt,
      defaultActionId: "edit-language",
      applyExecutor: createReviewedSetupApplyExecutor({
        homeDir: tempDir,
        workspaceRoot,
      }),
    });
    const config = JSON.parse(await readFile(profileConfigPath(tempDir), "utf8")) as {
      ui?: { language?: string; flavor?: string; activityLabels?: string };
      security?: { approvalMode?: string };
      model?: unknown;
    };
    const uiLine = result.reviewManifest?.sections["files-to-write-update"]
      .find((line) => line.review.summaryKey === "setupDrafts.uiPreferences.summary");

    expect(result.completed).toBe(true);
    expect(result.selectedActionId).toBe("edit-language");
    expect(prompts[0]?.title).toBe("Setup language");
    expect(prompts[0]?.labels).toEqual(["English", "العربية", "Back"]);
    expect(prompts[0]?.descriptions[2]).toBe("Return to the previous step.");
    expect(prompts[0]?.groups[2]).toBe("navigation");
    expect(prompts.map((prompt) => prompt.title)).not.toContain("أسلوب الواجهة");
    expect(uiLine?.review.values).toEqual(expect.objectContaining({
      language: "ar",
      flavor: "arabic-light",
      activityLabels: "ar",
    }));
    expect(config.ui).toEqual({
      language: "ar",
      flavor: "arabic-light",
      activityLabels: "ar",
    });
    expect(config.security?.approvalMode).toBe("adaptive");
    expect(config.model).toEqual((localReadyConfig() as { model: unknown }).model);
  });

  it("returns from setup editor language Back to the action menu without applying changes", async () => {
    const initialConfig = {
      ...localReadyConfig(),
      ui: {
        language: "en",
        flavor: "standard",
        activityLabels: "en",
      },
    };
    await writeUserConfig(tempDir, initialConfig);
    await trustWorkspace(tempDir, workspaceRoot);
    const promptTitles: string[] = [];
    const prompt = fakePrompt({ values: ["Back", "exit"] });
    const baseSelect = prompt.select!;
    prompt.select = async (input) => {
      promptTitles.push(input.title);
      return baseSelect(input);
    };
    const apply = vi.fn();

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt,
      defaultActionId: "edit-language",
      applyExecutor: { apply },
    });

    const config = JSON.parse(await readFile(profileConfigPath(tempDir), "utf8")) as {
      ui?: { language?: string; flavor?: string; activityLabels?: string };
    };

    expect(result.completed).toBe(true);
    expect(result.selectedActionId).toBe("exit");
    expect(result.reviewManifest).toBeUndefined();
    expect(result.applyPlanningResult).toBeUndefined();
    expect(apply).not.toHaveBeenCalled();
    expect(config.ui).toEqual(initialConfig.ui);
    expect(promptTitles).toEqual(["Setup language", "Setup editor"]);
  });

  it("returns from first-level setup editor choices to the action menu without drafting", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    await trustWorkspace(tempDir, workspaceRoot);
    const cases = [
      {
        actionId: "edit-security-mode" as const,
        expectedFirstTitle: "Security mode",
      },
      {
        actionId: "edit-workflow-learning" as const,
        expectedFirstTitle: "Agent Evolution",
      },
      {
        actionId: "configure-channels" as const,
        expectedFirstTitle: "Choose channel",
      },
      {
        actionId: "edit-auxiliary-model-route" as const,
        expectedFirstTitle: "Choose auxiliary model.",
      },
    ];

    for (const { actionId, expectedFirstTitle } of cases) {
      const promptTitles: string[] = [];
      const prompt = fakePrompt({ values: ["Back", "exit"] });
      const baseSelect = prompt.select!;
      prompt.select = async (input) => {
        promptTitles.push(input.title);
        return baseSelect(input);
      };
      const apply = vi.fn();

      const result = await runConfigEditor({
        homeDir: tempDir,
        workspaceRoot,
        prompt,
        defaultActionId: actionId,
        applyExecutor: { apply },
      });

      expect(result.completed).toBe(true);
      expect(result.selectedActionId).toBe("exit");
      expect(result.reviewManifest).toBeUndefined();
      expect(result.applyPlanningResult).toBeUndefined();
      expect(apply).not.toHaveBeenCalled();
      expect(promptTitles).toEqual([expectedFirstTitle, "Setup editor"]);
    }
  });

  it("returns from channel optional action Back to the channel selector", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    await trustWorkspace(tempDir, workspaceRoot);
    const promptTitles: string[] = [];
    const prompt = fakePrompt({ values: ["Telegram", "Back", "Back", "exit"] });
    const baseSelect = prompt.select!;
    prompt.select = async (input) => {
      promptTitles.push(input.title);
      return baseSelect(input);
    };
    const apply = vi.fn();

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt,
      defaultActionId: "configure-channels",
      applyExecutor: { apply },
    });

    expect(result.completed).toBe(true);
    expect(result.selectedActionId).toBe("exit");
    expect(result.reviewManifest).toBeUndefined();
    expect(apply).not.toHaveBeenCalled();
    expect(promptTitles).toEqual(["Choose channel", "Telegram/channels", "Choose channel", "Setup editor"]);
  });

  it("returns from browser mode Back to the optional action card", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    await trustWorkspace(tempDir, workspaceRoot);
    const promptTitles: string[] = [];
    const prompt = fakePrompt({ values: ["Configure", "Back", "Back", "exit"] });
    const baseSelect = prompt.select!;
    prompt.select = async (input) => {
      promptTitles.push(input.title);
      return baseSelect(input);
    };
    const apply = vi.fn();

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt,
      defaultActionId: "configure-browser",
      applyExecutor: { apply },
    });

    expect(result.completed).toBe(true);
    expect(result.selectedActionId).toBe("exit");
    expect(result.reviewManifest).toBeUndefined();
    expect(apply).not.toHaveBeenCalled();
    expect(promptTitles).toEqual(["Browser", "Browser configuration", "Browser", "Setup editor"]);
  });

  it("returns from web search provider Back to the action menu without drafting", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    await trustWorkspace(tempDir, workspaceRoot);
    const before = await readFile(profileConfigPath(tempDir), "utf8");
    const selectInputs: SelectPromptInput<unknown>[] = [];
    const prompt = fakePrompt({ values: ["Configure", "Back", "exit"] });
    const baseSelect = prompt.select!;
    prompt.select = async (input) => {
      selectInputs.push(input as SelectPromptInput<unknown>);
      return baseSelect(input);
    };
    const apply = vi.fn();

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt,
      defaultActionId: "configure-web-search",
      applyExecutor: { apply },
    });

    const searchProviderInput = selectInputs.find((input) => input.title === "Search provider");
    expect(result.completed).toBe(true);
    expect(result.selectedActionId).toBe("exit");
    expect(result.reviewManifest).toBeUndefined();
    expect(result.applyPlanningResult).toBeUndefined();
    expect(apply).not.toHaveBeenCalled();
    await expect(readFile(profileConfigPath(tempDir), "utf8")).resolves.toBe(before);
    expect(searchProviderInput?.options.find((option) => option.label === "Back")?.group).toBe("navigation");
    expect(selectInputs.map((input) => input.title)).toEqual(["Search", "Search provider", "Setup editor"]);
  });

  it("returns from DDGS install Back to the web search provider card without drafting", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    await trustWorkspace(tempDir, workspaceRoot);
    vi.spyOn(capabilityManager, "checkManagedPythonCapabilityStatus").mockResolvedValue({
      ok: false,
      capabilityId: DDGS_CAPABILITY_ID,
      reason: "install_required",
      message: "Managed Python capability environment has not been installed.",
    });
    const before = await readFile(profileConfigPath(tempDir), "utf8");
    const selectInputs: SelectPromptInput<unknown>[] = [];
    const prompt = fakePrompt({ values: ["Configure", "ddgs", "Back", "Back", "exit"] });
    const baseSelect = prompt.select!;
    prompt.select = async (input) => {
      selectInputs.push(input as SelectPromptInput<unknown>);
      return baseSelect(input);
    };
    const apply = vi.fn();

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt,
      defaultActionId: "configure-web-search",
      applyExecutor: { apply },
    });

    const ddgsInstallInput = selectInputs.find((input) => input.title === "DDGS setup");
    expect(result.completed).toBe(true);
    expect(result.selectedActionId).toBe("exit");
    expect(result.reviewManifest).toBeUndefined();
    expect(result.applyPlanningResult).toBeUndefined();
    expect(apply).not.toHaveBeenCalled();
    await expect(readFile(profileConfigPath(tempDir), "utf8")).resolves.toBe(before);
    expect(ddgsInstallInput?.options.find((option) => option.label === "Back")?.group).toBe("navigation");
    expect(selectInputs.map((input) => input.title)).toEqual([
      "Search",
      "Search provider",
      "DDGS setup",
      "Search provider",
      "Setup editor",
    ]);
  });

  it("returns from image generation provider Back to the action menu without drafting", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    await trustWorkspace(tempDir, workspaceRoot);
    const before = await readFile(profileConfigPath(tempDir), "utf8");
    const selectInputs: SelectPromptInput<unknown>[] = [];
    const prompt = fakePrompt({ values: ["Configure", "Back", "exit"] });
    const baseSelect = prompt.select!;
    prompt.select = async (input) => {
      selectInputs.push(input as SelectPromptInput<unknown>);
      return baseSelect(input);
    };
    const apply = vi.fn();

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt,
      defaultActionId: "configure-image-generation",
      applyExecutor: { apply },
    });

    const imageProviderInput = selectInputs.find((input) => input.title === "Vision and Image Generation");
    expect(result.completed).toBe(true);
    expect(result.selectedActionId).toBe("exit");
    expect(result.reviewManifest).toBeUndefined();
    expect(result.applyPlanningResult).toBeUndefined();
    expect(apply).not.toHaveBeenCalled();
    await expect(readFile(profileConfigPath(tempDir), "utf8")).resolves.toBe(before);
    expect(imageProviderInput?.options.find((option) => option.label === "Back")?.group).toBe("navigation");
    expect(selectInputs.map((input) => input.title)).toEqual([
      "Vision and image generation",
      "Vision and Image Generation",
      "Setup editor",
    ]);
  });

  it("returns from local STT model Back to STT provider and then voice mode", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    await trustWorkspace(tempDir, workspaceRoot);
    const promptTitles: string[] = [];
    const prompt = fakePrompt({
      values: [
        "Set Speech to Text (STT) Provider",
        "Configure",
        "Local (via faster-whisper)",
        "Back",
        "Back",
        "Back",
        "exit",
      ],
    });
    const baseSelect = prompt.select!;
    prompt.select = async (input) => {
      promptTitles.push(input.title);
      return baseSelect(input);
    };
    const apply = vi.fn();

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt,
      defaultActionId: "configure-voice",
      applyExecutor: { apply },
    });

    expect(result.completed).toBe(true);
    expect(result.selectedActionId).toBe("exit");
    expect(result.reviewManifest).toBeUndefined();
    expect(apply).not.toHaveBeenCalled();
    expect(promptTitles).toEqual([
      "Configure voice",
      "Voice",
      "Voice",
      "Configure STT",
      "Voice",
      "Configure voice",
      "Setup editor",
    ]);
  });

  it("resets Arabic activity labels when changing language back to English", async () => {
    await writeUserConfig(tempDir, {
      ...localReadyConfig(),
      ui: {
        language: "ar",
        flavor: "arabic-light",
        activityLabels: "ar",
      },
    });
    await trustWorkspace(tempDir, workspaceRoot);

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({ values: ["en"] }),
      defaultActionId: "edit-language",
      applyExecutor: createReviewedSetupApplyExecutor({
        homeDir: tempDir,
        workspaceRoot,
      }),
    });
    const config = JSON.parse(await readFile(profileConfigPath(tempDir), "utf8")) as {
      ui?: { language?: string; flavor?: string; activityLabels?: string };
    };
    const uiLine = result.reviewManifest?.sections["files-to-write-update"]
      .find((line) => line.review.summaryKey === "setupDrafts.uiPreferences.summary");

    expect(result.completed).toBe(true);
    expect(uiLine?.review.values).toEqual(expect.objectContaining({
      language: "en",
      flavor: "standard",
      activityLabels: "en",
    }));
    expect(config.ui).toEqual({
      language: "en",
      flavor: "standard",
      activityLabels: "en",
    });
  });

  it("applies and verifies without showing the setup editor launch prompt", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    await trustWorkspace(tempDir, workspaceRoot);
    const promptTitles: string[] = [];
    const prompt = fakePrompt({ values: ["strict", true] });
    const baseSelect = prompt.select!;
    prompt.select = async (input) => {
      promptTitles.push(input.title);
      return baseSelect(input);
    };

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt,
      defaultActionId: "edit-security-mode",
      applyExecutor: createReviewedSetupApplyExecutor({
        homeDir: tempDir,
        workspaceRoot,
        collectVerification: () => readyVerification(profileConfigPath(tempDir)),
      }),
    });

    expect(result.completed).toBe(true);
    expect(result.selectedActionId).toBe("edit-security-mode");
    expect(result.nextActionId).toBeUndefined();
    expect(result.postApplyRouteDecision?.kind).toBe("configured-menu");
    expect(result.applyEndState?.kind).toBe("verified-ready");
    expect(result.output).toContain("Verification passed. Setup is ready.");
    expect(result.output).not.toContain("Launch handoff accepted");
    expect(promptTitles).not.toContain("Setup next action");
    expect(result.output).not.toContain("Selected: Launch EstaCoda");
  });

  it("returns degraded setup output without limited-mode launch handoff", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    await trustWorkspace(tempDir, workspaceRoot);
    const promptTitles: string[] = [];
    const prompt = fakePrompt({ values: ["proactive", true] });
    const baseSelect = prompt.select!;
    prompt.select = async (input) => {
      promptTitles.push(input.title);
      return baseSelect(input);
    };

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt,
      defaultActionId: "edit-workflow-learning",
      applyExecutor: createReviewedSetupApplyExecutor({
        homeDir: tempDir,
        workspaceRoot,
        collectVerification: () => degradedVerification(profileConfigPath(tempDir)),
      }),
    });

    expect(result.completed).toBe(true);
    expect(result.nextActionId).toBeUndefined();
    expect(result.postApplyRouteDecision).toBeDefined();
    expect(result.applyEndState?.kind).toBe("verified-degraded");
    expect(result.output).toContain("Verification completed with warnings");
    expect(result.output).toContain("Verification warnings:");
    expect(result.output).toContain("Network inference is disabled for the selected hosted provider.");
    expect(result.output).toContain("Configured model context window is below 64K tokens.");
    expect(result.output).not.toContain("Limited mode accepted for launch");
    expect(promptTitles).not.toContain("Setup next action");
  });

  it("does not expose launch after blocked verification", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    await trustWorkspace(tempDir, workspaceRoot);
    const postApplyOptionLabels: string[][] = [];
    const prompt = fakePrompt({ values: ["strict", true] });
    const baseSelect = prompt.select!;
    prompt.select = async (input) => {
      if (input.title === "Setup next action") {
        postApplyOptionLabels.push(input.options.map((option) => option.label));
      }
      return baseSelect(input);
    };

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt,
      defaultActionId: "edit-security-mode",
      applyExecutor: createReviewedSetupApplyExecutor({
        homeDir: tempDir,
        workspaceRoot,
        collectVerification: () => blockedVerification(profileConfigPath(tempDir)),
      }),
    });

    expect(result.completed).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.nextActionId).toBeUndefined();
    expect(result.applyEndState?.kind).toBe("blocked");
    expect(postApplyOptionLabels).toEqual([]);
    expect(result.output).toContain("Verification blocked");
    expect(result.output).not.toContain("Exited after setup apply without launching");
  });

  it("does not expose launch when post-apply verification cannot run", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    await trustWorkspace(tempDir, workspaceRoot);
    const postApplyOptionLabels: string[][] = [];
    const prompt = fakePrompt({ values: ["strict", true] });
    const baseSelect = prompt.select!;
    prompt.select = async (input) => {
      if (input.title === "Setup next action") {
        postApplyOptionLabels.push(input.options.map((option) => option.label));
      }
      return baseSelect(input);
    };

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt,
      defaultActionId: "edit-security-mode",
      applyExecutor: {
        apply: () => ({ ok: true, appliedOperationIds: [] }),
      },
    });

    expect(result.completed).toBe(true);
    expect(result.nextActionId).toBeUndefined();
    expect(result.applyEndState?.kind).toBe("saved-not-launched");
    expect(postApplyOptionLabels).toEqual([]);
    expect(result.output).toContain("Setup prepared without launch handoff");
    expect(result.output).not.toContain("Exited after setup apply without launching");
  });

  it("does not expose launch when the fresh post-apply route is still unsafe", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    const postApplyOptionLabels: string[][] = [];
    const prompt = fakePrompt({ values: [true, true] });
    const baseSelect = prompt.select!;
    prompt.select = async (input) => {
      if (input.title === "Setup next action") {
        postApplyOptionLabels.push(input.options.map((option) => option.label));
      }
      return baseSelect(input);
    };

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt,
      defaultActionId: "trust-workspace",
      applyExecutor: {
        apply: () => ({ ok: true, appliedOperationIds: [] }),
        verify: () => readyVerification(profileConfigPath(tempDir)),
      },
    });

    expect(result.completed).toBe(true);
    expect(result.initialDecision.state.kind).toBe("untrusted-workspace");
    expect(result.postApplyRouteDecision?.state.kind).toBe("untrusted-workspace");
    expect(result.nextActionId).toBeUndefined();
    expect(result.applyEndState?.kind).toBe("verified-ready");
    expect(postApplyOptionLabels).toEqual([]);
  });

  it("does not re-enter setup editor after existing-user apply", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    await trustWorkspace(tempDir, workspaceRoot);
    const output: string[] = [];

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({ values: ["proactive", true] }),
      defaultActionId: "edit-workflow-learning",
      applyExecutor: createReviewedSetupApplyExecutor({
        homeDir: tempDir,
        workspaceRoot,
        collectVerification: () => degradedVerification(profileConfigPath(tempDir)),
      }),
      output: { write: (value) => output.push(value) },
    });

    expect(result.completed).toBe(true);
    expect(result.selectedActionId).toBe("edit-workflow-learning");
    expect(result.reviewManifest).toBeDefined();
    expect(output.join("").match(/Setup Editor/g)).toHaveLength(1);
    expect(output.join("")).not.toContain("Repair again selected. Re-entering setup editor.");
  });

  it("applies guided provider route repair through the shared flow and reviewed executor", async () => {
    await writeUserConfig(tempDir, {
      ...localReadyConfig(),
      security: {
        approvalMode: "adaptive",
        assessor: { enabled: true },
      },
    });
    await trustWorkspace(tempDir, workspaceRoot);

    const prompt = fakePrompt({ values: ["OpenAI", "gpt-5.5", true], secret: "sk-pr8-provider-route" });
    const routePrompts: SelectPromptInput<unknown>[] = [];
    const baseSelect = prompt.select!;
    prompt.select = async (input) => {
      if (input.title === "Primary provider" || input.title === "Primary model") {
        routePrompts.push(input as SelectPromptInput<unknown>);
      }
      return baseSelect(input);
    };

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt,
      defaultActionId: "edit-primary-model-route",
      flowEngine: flowEngine({ credentialAction: "collect", envVarName: "PR8_OPENAI_KEY" }),
      applyExecutor: createReviewedSetupApplyExecutor({
        homeDir: tempDir,
        workspaceRoot,
        collectVerification: () => readyVerification(profileConfigPath(tempDir)),
      }),
    });
    const rawConfig = await readFile(profileConfigPath(tempDir), "utf8");
    const config = JSON.parse(rawConfig) as {
      model?: { provider?: string; id?: string; contextWindowTokens?: number; apiMode?: string; authMethod?: string };
      providers?: Record<string, { apiKeyEnv?: string; baseUrl?: string; models?: string[]; apiMode?: string; authMethod?: string }>;
      security?: { approvalMode?: string; assessor?: { enabled?: boolean } };
    };
    const envFile = await readFile(profileEnvPath(tempDir), "utf8");

    expect(result.completed).toBe(true);
    expect(result.selectedActionId).toBe("edit-primary-model-route");
    expect(result.reviewManifest?.sections["provider-model-network"]).toHaveLength(1);
    expect(result.reviewManifest?.sections["secret-refs-to-store"]).toHaveLength(1);
    expect(result.reviewManifest?.sections["files-to-write-update"][0]?.target).toEqual(expect.objectContaining({
      kind: "config-scope",
      scope: ["provider.route"],
    }));
    expect(config.model).toEqual({ provider: "openai", id: "gpt-5.5", contextWindowTokens: 128000 });
    expect(config.providers?.openai).toEqual(expect.objectContaining({
      apiKeyEnv: "PR8_OPENAI_KEY",
    }));
    expect(config.providers?.openai?.baseUrl).toBeUndefined();
    expect(config.providers?.openai).not.toHaveProperty("baseUrl");
    expect(config.providers?.openai?.models).toContain("gpt-5.5");
    expect(config.model?.apiMode).toBeUndefined();
    expect(config.model?.authMethod).toBeUndefined();
    expect(config.providers?.openai?.apiMode).toBeUndefined();
    expect(config.providers?.openai?.authMethod).toBeUndefined();
    expect(config.security?.assessor?.enabled).toBe(true);
    expect(routePrompts.map((input) => input.title)).toEqual(["Primary provider", "Primary model"]);
    expect(routePrompts[0]?.columns).toEqual([
      { key: "name", header: "Name" },
      { key: "details", header: "Details" },
    ]);
    expect(routePrompts[0]?.options.map((option) => option.id)).toContain("back");
    expect(routePrompts[0]?.options.map((option) => option.id)).toContain("cancel");
    expect(routePrompts[1]?.options.map((option) => option.id)).toContain("back");
    expect(routePrompts[1]?.options.map((option) => option.id)).toContain("cancel");
    expect(routePrompts[0]?.technicalLines).toBeUndefined();
    expect(routePrompts[0]?.statusLines).toEqual([
      { text: "Current: local/local-test-model", tone: "active", direction: "ltr" },
    ]);
    expect(routePrompts[0]?.showCurrentBadge).toBe(false);
    expect(routePrompts[0]?.options.find((option) => option.id === "openai")?.cells?.details).toBe("Hosted OpenAI models.");
    expect(routePrompts[1]?.showCurrentBadge).toBe(false);
    expect(routePrompts[1]?.options.find((option) => option.id === "gpt-5.5")?.cells?.details).toContain("Tools | Vision | Reasoning");
    expect(envFile).toContain("PR8_OPENAI_KEY=");
    expect(rawConfig).not.toContain("sk-pr8-provider-route");
    expect(JSON.stringify(result)).not.toContain("sk-pr8-provider-route");
  });

  it("returns to setup actions when provider-card Back is selected", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    await trustWorkspace(tempDir, workspaceRoot);

    const prompt = fakePrompt({ values: ["Back", "exit"] });
    const selectTitles: string[] = [];
    const baseSelect = prompt.select!;
    prompt.select = async (input) => {
      selectTitles.push(input.title);
      return baseSelect(input);
    };

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt,
      defaultActionId: "edit-primary-model-route",
      flowEngine: flowEngine({ credentialAction: "collect", envVarName: "PR8_OPENAI_KEY" }),
    });

    expect(result.completed).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.selectedActionId).toBe("exit");
    expect(selectTitles).toEqual(["Primary provider", "Setup editor"]);
    await expect(readFile(profileConfigPath(tempDir), "utf8")).resolves.toContain("\"provider\": \"local\"");
  });

  it("keeps repair-again re-entry available after provider-card Back returns to menu", () => {
    const repairAgainDecision = {
      kind: "configured-menu",
      title: "Setup editor",
      summary: "Ready",
      state: { kind: "configured-ready" },
      actions: [],
      warnings: [],
      blockers: [],
      readOnly: true,
    } as unknown as SetupRouteDecision;
    const initialLoopState = {
      repairAgainReentered: false,
      menuBackReentryCount: 0,
    };
    const afterBack = __decideConfigEditorLoopForTest({
      result: {
        completed: false,
        exitCode: 0,
        output: "",
        initialDecision: repairAgainDecision,
        selectedActionId: "edit-primary-model-route",
        menuBackRequested: true,
      },
      ...initialLoopState,
    });

    expect(afterBack).toEqual({
      kind: "menu-back",
      state: {
        repairAgainReentered: false,
        menuBackReentryCount: 1,
      },
    });
    if (afterBack.kind !== "menu-back") {
      throw new Error("Expected provider-card Back to request setup menu re-entry.");
    }
    expect(__decideConfigEditorLoopForTest({
      result: {
        completed: true,
        exitCode: 0,
        output: "",
        initialDecision: repairAgainDecision,
        selectedActionId: "edit-security-mode",
        nextActionId: "repair-again",
        repairAgainDecision,
      },
      repairAgainReentered: afterBack.state.repairAgainReentered,
      menuBackReentryCount: afterBack.state.menuBackReentryCount,
    })).toEqual({
      kind: "repair-again",
      state: {
        repairAgainReentered: true,
        menuBackReentryCount: 1,
      },
      initialDecision: repairAgainDecision,
    });
  });

  it("returns from model-card Back to provider selection before final setup route selection", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    await trustWorkspace(tempDir, workspaceRoot);

    const prompt = fakePrompt({ values: ["OpenAI", "Back", "OpenAI", "gpt-5.5", true], secret: "sk-pr8-provider-route" });
    const routePrompts: SelectPromptInput<unknown>[] = [];
    const baseSelect = prompt.select!;
    prompt.select = async (input) => {
      if (input.title === "Primary provider" || input.title === "Primary model") {
        routePrompts.push(input as SelectPromptInput<unknown>);
      }
      return baseSelect(input);
    };

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt,
      defaultActionId: "edit-primary-model-route",
      flowEngine: flowEngine({ credentialAction: "collect", envVarName: "PR8_OPENAI_KEY" }),
      applyExecutor: createReviewedSetupApplyExecutor({
        homeDir: tempDir,
        workspaceRoot,
        collectVerification: () => readyVerification(profileConfigPath(tempDir)),
      }),
    });

    expect(result.completed).toBe(true);
    expect(result.selectedActionId).toBe("edit-primary-model-route");
    expect(routePrompts.map((input) => input.title)).toEqual([
      "Primary provider",
      "Primary model",
      "Primary provider",
      "Primary model",
    ]);
    const rawConfig = await readFile(profileConfigPath(tempDir), "utf8");
    expect(rawConfig).toContain("\"provider\": \"openai\"");
  });

  it("prompts to reuse a saved profile credential and keeps the existing key without raw key prompt", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    await mkdir(dirname(profileEnvPath(tempDir)), { recursive: true });
    await writeFile(profileEnvPath(tempDir), 'PR8_REUSE_KEY="saved-reuse-secret"\n', "utf8");
    await chmod(profileEnvPath(tempDir), 0o600);
    await trustWorkspace(tempDir, workspaceRoot);
    const prompt = trackingPrompt({
      values: ["OpenAI", "gpt-5.5", "existing", true],
      secret: "sk-should-not-be-read",
    });
    const reuseChoiceLabels: string[][] = [];
    const baseSelect = prompt.select!;
    prompt.select = async (input) => {
      if (input.title === "Saved provider API key") {
        reuseChoiceLabels.push(input.options.map((option) => option.label));
      }
      return baseSelect(input);
    };

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt,
      defaultActionId: "edit-primary-model-route",
      flowEngine: flowEngine({ credentialAction: "reuse", envVarName: "PR8_REUSE_KEY" }),
      applyExecutor: createReviewedSetupApplyExecutor({
        homeDir: tempDir,
        workspaceRoot,
        collectVerification: () => readyVerification(profileConfigPath(tempDir)),
      }),
    });
    const envFile = await readFile(profileEnvPath(tempDir), "utf8");

    expect(result.completed).toBe(true);
    expect(reuseChoiceLabels).toEqual([["Use existing saved API key.", "Enter a new API key."]]);
    expect(prompt.secretPromptCount()).toBe(0);
    expect(envFile).toContain("saved-reuse-secret");
    expect(envFile).not.toContain("sk-should-not-be-read");
    expect(result.reviewManifest?.sections["secret-refs-to-store"][0]?.sourceDraftIds).toEqual([
      "setup-editor.credentials.store-provider-credential-reference",
    ]);
    expect(JSON.stringify(result)).not.toContain("saved-reuse-secret");
    expect(JSON.stringify(result.reviewManifest)).not.toContain("saved-reuse-secret");
  });

  it("adds a fallback route directly when no fallbacks exist", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    await trustWorkspace(tempDir, workspaceRoot);
    const prompt = trackingPrompt({
      values: ["OpenAI", "gpt-5.5", true],
      secret: "sk-fallback-add-secret",
    });
    const promptTitles: string[] = [];
    const baseSelect = prompt.select!;
    prompt.select = async (input) => {
      if (input.title === "Fallback models" || input.title === "Fallback provider" || input.title === "Fallback model") {
        promptTitles.push(input.title);
      }
      return baseSelect(input);
    };

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt,
      defaultActionId: "edit-fallback-model-route",
      flowEngine: flowEngine({ credentialAction: "collect", envVarName: "PR8_FALLBACK_KEY" }),
      applyExecutor: createReviewedSetupApplyExecutor({
        homeDir: tempDir,
        workspaceRoot,
        collectVerification: () => readyVerification(profileConfigPath(tempDir)),
      }),
    });
    const rawConfig = await readFile(profileConfigPath(tempDir), "utf8");
    const config = JSON.parse(rawConfig) as {
      model?: { provider?: string; id?: string; fallbacks?: Array<{ provider?: string; id?: string; apiKeyEnv?: string }> };
    };

    expect(result.completed).toBe(true);
    expect(result.selectedActionId).toBe("edit-fallback-model-route");
    expect(promptTitles).toEqual(["Fallback provider", "Fallback model"]);
    expect(result.reviewManifest?.sections["provider-model-network"][0]?.review.values).toEqual(expect.objectContaining({
      fallbackOperation: "add",
      provider: "openai",
      model: "gpt-5.5",
      apiKeyEnv: "PR8_FALLBACK_KEY",
    }));
    expect(result.reviewManifest?.sections["files-to-write-update"][0]?.target).toEqual(expect.objectContaining({
      kind: "config-scope",
      scope: ["model.fallbacks"],
    }));
    expect(result.reviewManifest?.sections["secret-refs-to-store"][0]?.sourceDraftIds).toEqual([
      "setup-editor.credentials.store-provider-credential-reference",
    ]);
    expect(config.model?.provider).toBe("local");
    expect(config.model?.id).toBe("local-test-model");
    expect(config.model?.fallbacks).toEqual([
      expect.objectContaining({ provider: "openai", id: "gpt-5.5", apiKeyEnv: "PR8_FALLBACK_KEY" }),
    ]);
    expect(rawConfig).not.toContain("sk-fallback-add-secret");
    expect(JSON.stringify(result)).not.toContain("sk-fallback-add-secret");
  });

  it("prompts to edit existing fallbacks or add another route", async () => {
    await writeUserConfig(tempDir, {
      ...localReadyConfig(),
      model: {
        provider: "local",
        id: "local-test-model",
        fallbacks: [
          { provider: "openai", id: "gpt-5.5" },
          { provider: "kimi", id: "kimi-k2" },
        ],
      },
    });
    await trustWorkspace(tempDir, workspaceRoot);
    const prompt = fakePrompt({ values: ["fallback-add", "Anthropic", "claude-sonnet-4-5", true] });
    const promptTitles: string[] = [];
    const fallbackChoiceLabels: string[][] = [];
    const baseSelect = prompt.select!;
    prompt.select = async (input) => {
      if (input.title === "Fallback models" || input.title === "Fallback provider" || input.title === "Fallback model") {
        promptTitles.push(input.title);
      }
      if (input.title === "Fallback models") {
        fallbackChoiceLabels.push(input.options.map((option) => option.label));
      }
      return baseSelect(input);
    };

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt,
      defaultActionId: "edit-fallback-model-route",
      flowEngine: flowEngine({ credentialAction: "none", providers: ["anthropic"] }),
      applyExecutor: createReviewedSetupApplyExecutor({
        homeDir: tempDir,
        workspaceRoot,
      }),
    });

    expect(result.completed).toBe(true);
    expect(promptTitles).toEqual(["Fallback models", "Fallback provider", "Fallback model"]);
    expect(fallbackChoiceLabels).toEqual([[
      "Edit fallback 1: openai/gpt-5.5",
      "Edit fallback 2: kimi/kimi-k2",
      "Add another fallback model",
      "Back",
    ]]);
    expect(result.reviewManifest?.sections["provider-model-network"][0]?.review.values).toEqual(expect.objectContaining({
      fallbackOperation: "add",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
    }));
  });

  it("replaces a selected fallback route while preserving surrounding fallbacks", async () => {
    await writeUserConfig(tempDir, {
      ...localReadyConfig(),
      model: {
        provider: "local",
        id: "local-test-model",
        fallbacks: [
          { provider: "openai", id: "gpt-5.5" },
          { provider: "kimi", id: "kimi-k2" },
        ],
      },
      providers: {
        ...(localReadyConfig().providers as Record<string, unknown>),
        openai: { kind: "openai-compatible", baseUrl: "https://api.openai.com/v1", models: ["gpt-5.5"], enableNetwork: true },
        kimi: { kind: "openai-compatible", baseUrl: "https://api.moonshot.ai/v1", models: ["kimi-k2"], enableNetwork: true },
      },
    });
    await trustWorkspace(tempDir, workspaceRoot);

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({ values: ["fallback-1", "Anthropic", "claude-sonnet-4-5", true] }),
      defaultActionId: "edit-fallback-model-route",
      flowEngine: flowEngine({ credentialAction: "none", providers: ["anthropic"] }),
      applyExecutor: createReviewedSetupApplyExecutor({
        homeDir: tempDir,
        workspaceRoot,
      }),
    });
    const config = JSON.parse(await readFile(profileConfigPath(tempDir), "utf8")) as {
      model?: { provider?: string; id?: string; fallbacks?: Array<{ provider?: string; id?: string }> };
      providers?: Record<string, unknown>;
    };

    expect(result.completed).toBe(true);
    expect(result.reviewManifest?.sections["provider-model-network"][0]?.review.summaryKey).toBe("setupDrafts.fallbackModelRoute.replace.summary");
    expect(result.reviewManifest?.sections["provider-model-network"][0]?.review.values).toEqual(expect.objectContaining({
      fallbackOperation: "replace",
      fallbackIndex: 1,
      previousProvider: "kimi",
      previousModel: "kimi-k2",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
    }));
    expect(config.model?.provider).toBe("local");
    expect(config.model?.id).toBe("local-test-model");
    expect(config.model?.fallbacks).toEqual([
      expect.objectContaining({ provider: "openai", id: "gpt-5.5" }),
      expect.objectContaining({ provider: "anthropic", id: "claude-sonnet-4-5" }),
    ]);
    expect(config.providers?.kimi).toBeDefined();
  });

  it("selects an auxiliary task and applies a reviewed auxiliary route", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    await trustWorkspace(tempDir, workspaceRoot);
    const prompt = trackingPrompt({
      values: ["compression", "OpenAI", "gpt-5.5", true],
      secret: "sk-auxiliary-compression-secret",
    });
    const taskOptions: Array<{ labels: string[]; values: unknown[] }> = [];
    const promptTitles: string[] = [];
    const baseSelect = prompt.select!;
    prompt.select = async (input) => {
      if (input.title === "Choose auxiliary model." || input.title === "Auxiliary provider" || input.title === "Auxiliary model") {
        promptTitles.push(input.title);
      }
      if (input.title === "Choose auxiliary model.") {
        taskOptions.push({
          labels: input.options.map((option) => option.label),
          values: input.options.map((option) => option.value),
        });
      }
      return baseSelect(input);
    };

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt,
      defaultActionId: "edit-auxiliary-model-route",
      flowEngine: flowEngine({ credentialAction: "collect", envVarName: "PR8_AUX_KEY" }),
      applyExecutor: createReviewedSetupApplyExecutor({
        homeDir: tempDir,
        workspaceRoot,
      }),
    });
    const rawConfig = await readFile(profileConfigPath(tempDir), "utf8");
    const config = JSON.parse(rawConfig) as {
      model?: { provider?: string; id?: string; fallbacks?: unknown };
      auxiliaryModels?: {
        compression?: { provider?: string; id?: string; apiKeyEnv?: string; enabled?: boolean };
      };
    };

    expect(result.completed).toBe(true);
    expect(result.selectedActionId).toBe("edit-auxiliary-model-route");
    expect(promptTitles).toEqual(["Choose auxiliary model.", "Auxiliary provider", "Auxiliary model"]);
    expect(taskOptions[0]?.labels).toEqual(["Assessor", "Compression", "Session search", "Memory compaction", "Profile context", "Back"]);
    expect(taskOptions[0]?.values.slice(0, 5)).toEqual([
      "assessor",
      "compression",
      "session_search",
      "memory_compaction",
      "profile_context",
    ]);
    expect(typeof taskOptions[0]?.values[5]).toBe("symbol");
    expect(result.reviewManifest?.sections["provider-model-network"][0]?.review).toEqual(expect.objectContaining({
      summaryKey: "setupDrafts.auxiliaryModelRoute.summary",
      values: expect.objectContaining({
        auxiliaryTask: "compression",
        provider: "openai",
        model: "gpt-5.5",
        apiKeyEnv: "PR8_AUX_KEY",
      }),
    }));
    expect(result.reviewManifest?.sections["files-to-write-update"][0]?.target).toEqual(expect.objectContaining({
      kind: "config-scope",
      scope: ["auxiliaryModels.*"],
    }));
    expect(result.reviewManifest?.sections["secret-refs-to-store"][0]?.sourceDraftIds).toEqual([
      "setup-editor.credentials.store-provider-credential-reference",
    ]);
    expect(config.model).toEqual({ provider: "local", id: "local-test-model" });
    expect(config.auxiliaryModels?.compression).toEqual(expect.objectContaining({
      provider: "openai",
      id: "gpt-5.5",
      apiKeyEnv: "PR8_AUX_KEY",
      enabled: true,
    }));
    expect(rawConfig).not.toContain("sk-auxiliary-compression-secret");
    expect(JSON.stringify(result)).not.toContain("sk-auxiliary-compression-secret");
    expect(JSON.stringify(result.reviewManifest)).not.toContain("sk-auxiliary-compression-secret");
  });

  it("does not change assessor route when auxiliary review is cancelled", async () => {
    await writeUserConfig(tempDir, {
      ...localReadyConfig(),
      auxiliaryModels: {
        assessor: { provider: "auto", enabled: true },
      },
    });
    await trustWorkspace(tempDir, workspaceRoot);

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({
        values: ["assessor", "OpenAI", "gpt-5.5", false],
        secret: "sk-assessor-cancelled-secret",
      }),
      defaultActionId: "edit-auxiliary-model-route",
      flowEngine: flowEngine({ credentialAction: "collect", envVarName: "PR8_ASSESSOR_KEY" }),
      applyExecutor: createReviewedSetupApplyExecutor({
        homeDir: tempDir,
        workspaceRoot,
      }),
    });
    const rawConfig = await readFile(profileConfigPath(tempDir), "utf8");
    const config = JSON.parse(rawConfig) as {
      auxiliaryModels?: { assessor?: { provider?: string; id?: string; enabled?: boolean } };
    };

    expect(result.completed).toBe(false);
    expect(result.applyPlanningResult?.kind).toBe("cancelled");
    expect(config.auxiliaryModels?.assessor).toEqual({ provider: "auto", enabled: true });
    await expect(readFile(profileEnvPath(tempDir), "utf8")).rejects.toThrow();
    expect(rawConfig).not.toContain("sk-assessor-cancelled-secret");
    expect(JSON.stringify(result)).not.toContain("sk-assessor-cancelled-secret");
  });

  it("replaces a saved profile credential only after reviewed approval when the user enters a new key", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    await mkdir(dirname(profileEnvPath(tempDir)), { recursive: true });
    await writeFile(profileEnvPath(tempDir), 'PR8_REPLACE_KEY="old-reuse-secret"\n', "utf8");
    await chmod(profileEnvPath(tempDir), 0o600);
    await trustWorkspace(tempDir, workspaceRoot);

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({
        values: ["OpenAI", "gpt-5.5", "new", true],
        secret: "sk-pr8-replacement-secret",
      }),
      defaultActionId: "edit-primary-model-route",
      flowEngine: flowEngine({ credentialAction: "reuse", envVarName: "PR8_REPLACE_KEY" }),
      applyExecutor: createReviewedSetupApplyExecutor({
        homeDir: tempDir,
        workspaceRoot,
        collectVerification: () => readyVerification(profileConfigPath(tempDir)),
      }),
    });
    const envFile = await readFile(profileEnvPath(tempDir), "utf8");

    expect(result.completed).toBe(true);
    expect(result.applyPlanningResult?.kind).toBe("apply-plan-ready");
    expect(envFile).toContain('PR8_REPLACE_KEY="sk-pr8-replacement-secret"');
    expect(envFile).not.toContain("old-reuse-secret");
    expect(result.reviewManifest?.sections["secret-refs-to-store"][0]?.sourceDraftIds).toEqual([
      "setup-editor.credentials.store-provider-credential-reference",
    ]);
    expect(result.output).not.toContain("sk-pr8-replacement-secret");
    expect(JSON.stringify(result)).not.toContain("sk-pr8-replacement-secret");
    expect(JSON.stringify(result.reviewManifest)).not.toContain("sk-pr8-replacement-secret");
    expect(JSON.stringify(result.applyPlanningResult)).not.toContain("sk-pr8-replacement-secret");
  });

  it("returns a diagnostic when replacing a saved credential with an empty key", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    await mkdir(dirname(profileEnvPath(tempDir)), { recursive: true });
    await writeFile(profileEnvPath(tempDir), 'PR8_EMPTY_REUSE_KEY="old-reuse-secret"\n', "utf8");
    await chmod(profileEnvPath(tempDir), 0o600);
    await trustWorkspace(tempDir, workspaceRoot);

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({ values: ["OpenAI", "gpt-5.5", "new"], secret: "" }),
      defaultActionId: "edit-primary-model-route",
      flowEngine: flowEngine({ credentialAction: "reuse", envVarName: "PR8_EMPTY_REUSE_KEY" }),
      applyExecutor: {
        apply: () => {
          throw new Error("apply should not run for empty replacement credential");
        },
      },
    });
    const envFile = await readFile(profileEnvPath(tempDir), "utf8");

    expect(result.completed).toBe(false);
    expect(result.reviewManifest).toBeUndefined();
    expect(result.applyPlanningResult).toBeUndefined();
    expect(result.output).toContain("No API key was entered for PR8_EMPTY_REUSE_KEY");
    expect(envFile).toContain("old-reuse-secret");
  });

  it("does not show the saved-key prompt when only shell env has the credential", async () => {
    process.env.PR8_SHELL_ONLY_KEY = "sk-shell-only-secret";
    await writeUserConfig(tempDir, localReadyConfig());
    await trustWorkspace(tempDir, workspaceRoot);
    const prompt = trackingPrompt({ values: ["OpenAI", "gpt-5.5", true] });
    const reuseChoiceLabels: string[][] = [];
    const baseSelect = prompt.select!;
    prompt.select = async (input) => {
      if (input.title === "Saved provider API key") {
        reuseChoiceLabels.push(input.options.map((option) => option.label));
      }
      return baseSelect(input);
    };

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt,
      defaultActionId: "edit-primary-model-route",
      flowEngine: flowEngine({ credentialAction: "reuse", envVarName: "PR8_SHELL_ONLY_KEY" }),
      applyExecutor: createReviewedSetupApplyExecutor({
        homeDir: tempDir,
        workspaceRoot,
      }),
    });

    expect(result.completed).toBe(true);
    expect(reuseChoiceLabels).toEqual([]);
    expect(prompt.secretPromptCount()).toBe(0);
    await expect(readFile(profileEnvPath(tempDir), "utf8")).rejects.toThrow();
    expect(JSON.stringify(result)).not.toContain("sk-shell-only-secret");
  });

  it("cancels guided credential repair without writing config or .env", async () => {
    delete process.env.PR8_CANCELLED_KEY;
    await writeUserConfig(tempDir, hostedMissingCredentialConfig("PR8_CANCELLED_KEY"));
    await trustWorkspace(tempDir, workspaceRoot);
    const before = await readFile(profileConfigPath(tempDir), "utf8");

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({ values: [false], secret: "sk-pr8-cancelled" }),
      defaultActionId: "repair-missing-credential",
      flowEngine: flowEngine({ credentialAction: "collect", envVarName: "PR8_CANCELLED_KEY" }),
      applyExecutor: createReviewedSetupApplyExecutor({
        homeDir: tempDir,
        workspaceRoot,
      }),
    });

    expect(result.completed).toBe(false);
    expect(result.applyPlanningResult?.kind).toBe("cancelled");
    await expect(readFile(profileConfigPath(tempDir), "utf8")).resolves.toBe(before);
    await expect(readFile(profileEnvPath(tempDir), "utf8")).rejects.toThrow();
    expect(JSON.stringify(result)).not.toContain("sk-pr8-cancelled");
    expect(JSON.stringify(result.reviewManifest)).not.toContain("sk-pr8-cancelled");
    expect(JSON.stringify(result.applyPlanningResult)).not.toContain("sk-pr8-cancelled");
  });

  it("repairs the active OpenAI credential ref without mutating other available providers", async () => {
    delete process.env.PR8_REPAIRED_KEY;
    await writeUserConfig(tempDir, {
      ...hostedMissingCredentialConfig("PR8_REPAIRED_KEY"),
      providers: {
        openai: {
          kind: "openai-compatible",
          baseUrl: "https://api.openai.com/v1",
          apiKeyEnv: "PR8_REPAIRED_KEY",
          models: ["gpt-5.5"],
          enableNetwork: true,
        },
        anthropic: {
          kind: "openai-compatible",
          baseUrl: "https://api.anthropic.com/v1",
          apiKeyEnv: "ANTHROPIC_API_KEY",
          models: ["claude-sonnet-4-5"],
          enableNetwork: true,
        },
      },
    });
    await trustWorkspace(tempDir, workspaceRoot);

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({ values: [true], secret: "sk-pr8-repaired" }),
      defaultActionId: "repair-missing-credential",
      flowEngine: flowEngine({
        credentialAction: "collect",
        envVarName: "PR8_REPAIRED_KEY",
        providers: ["anthropic", "openai"],
      }),
      applyExecutor: createReviewedSetupApplyExecutor({
        homeDir: tempDir,
        workspaceRoot,
        collectVerification: () => readyVerification(profileConfigPath(tempDir)),
      }),
    });
    const rawConfig = await readFile(profileConfigPath(tempDir), "utf8");
    const config = JSON.parse(rawConfig) as {
      model?: { provider?: string; id?: string };
      providers?: Record<string, { apiKeyEnv?: string; models?: string[] }>;
    };
    const envFile = await readFile(profileEnvPath(tempDir), "utf8");

    expect(result.completed).toBe(true);
    expect(result.selectedActionId).toBe("repair-missing-credential");
    expect(result.reviewManifest?.sections["provider-model-network"]).toHaveLength(0);
    expect(result.reviewManifest?.sections["secret-refs-to-store"]).toHaveLength(1);
    expect(result.reviewManifest?.sections["files-to-write-update"][0]?.target).toEqual(expect.objectContaining({
      kind: "config-scope",
      scope: ["provider.credentialReference"],
    }));
    expect(config.model).toEqual({ provider: "openai", id: "gpt-5.5" });
    expect(config.providers?.openai?.apiKeyEnv).toBe("PR8_REPAIRED_KEY");
    expect(config.providers?.anthropic?.apiKeyEnv).toBe("ANTHROPIC_API_KEY");
    expect(config.providers?.anthropic?.models).toEqual(["claude-sonnet-4-5"]);
    expect(envFile).toContain("PR8_REPAIRED_KEY=");
    expect(rawConfig).not.toContain("sk-pr8-repaired");
    expect(JSON.stringify(result)).not.toContain("sk-pr8-repaired");
    expect(JSON.stringify(result.reviewManifest)).not.toContain("sk-pr8-repaired");
    expect(JSON.stringify(result.applyPlanningResult)).not.toContain("sk-pr8-repaired");
  });

  it("returns diagnostics and writes nothing when active credential route is unavailable", async () => {
    delete process.env.PR8_UNAVAILABLE_KEY;
    await writeUserConfig(tempDir, hostedMissingCredentialConfig("PR8_UNAVAILABLE_KEY"));
    await trustWorkspace(tempDir, workspaceRoot);
    const before = await readFile(profileConfigPath(tempDir), "utf8");

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({ values: [true], secret: "sk-pr8-unavailable" }),
      defaultActionId: "repair-missing-credential",
      flowEngine: flowEngine({
        credentialAction: "collect",
        envVarName: "PR8_UNAVAILABLE_KEY",
        providers: ["anthropic"],
      }),
      applyExecutor: {
        apply: () => {
          throw new Error("apply should not run for unavailable active route");
        },
      },
    });

    expect(result.completed).toBe(false);
    expect(result.reviewManifest).toBeUndefined();
    expect(result.applyPlanningResult).toBeUndefined();
    expect(result.output).toContain("Use provider/model repair");
    await expect(readFile(profileConfigPath(tempDir), "utf8")).resolves.toBe(before);
    await expect(readFile(profileEnvPath(tempDir), "utf8")).rejects.toThrow();
    expect(JSON.stringify(result)).not.toContain("sk-pr8-unavailable");
  });

  it("treats shared-flow diagnostics as non-mutating editor output", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    await trustWorkspace(tempDir, workspaceRoot);
    const before = await readFile(profileConfigPath(tempDir), "utf8");

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({ values: ["OpenAI", "gpt-5.5"] }),
      defaultActionId: "edit-primary-model-route",
      flowEngine: flowEngine({ diagnostic: "Provider OpenAI is not runnable." }),
      applyExecutor: {
        apply: () => {
          throw new Error("apply should not run for diagnostics");
        },
      },
    });

    expect(result.completed).toBe(false);
    expect(result.output).toContain("Provider/model selection failed: Provider OpenAI is not runnable.");
    expect(result.reviewManifest).toBeUndefined();
    await expect(readFile(profileConfigPath(tempDir), "utf8")).resolves.toBe(before);
  });

  it("grants workspace trust only after explicit confirmation and reviewed approval", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    const trustStorePath = join(tempDir, ".estacoda", "trust.json");
    const store = new WorkspaceTrustStore({ path: trustStorePath });

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      trustStorePath,
      prompt: fakePrompt({ values: [true, true] }),
      defaultActionId: "trust-workspace",
      applyExecutor: createReviewedSetupApplyExecutor({
        homeDir: tempDir,
        workspaceRoot,
        trustStorePath,
      }),
    });

    expect(result.completed).toBe(true);
    expect(result.initialDecision.state.kind).toBe("untrusted-workspace");
    expect(result.selectedActionId).toBe("repair-workspace-trust");
    expect(result.reviewManifest?.sections["workspace-trust-grants"].length).toBe(1);
    expect(result.applyPlanningResult?.kind).toBe("apply-plan-ready");
    await expect(store.isTrusted(workspaceRoot)).resolves.toBe(true);
  });

  it("does not grant workspace trust when explicit confirmation is declined", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    const trustStorePath = join(tempDir, ".estacoda", "trust.json");
    const store = new WorkspaceTrustStore({ path: trustStorePath });
    let applyCalled = false;

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      trustStorePath,
      prompt: fakePrompt({ values: [false] }),
      defaultActionId: "trust-workspace",
      applyExecutor: {
        apply: () => {
          applyCalled = true;
          return { ok: true, appliedOperationIds: [] };
        },
      },
    });

    expect(result.completed).toBe(true);
    expect(result.output).toContain("Workspace trust was not changed");
    expect(result.reviewManifest).toBeUndefined();
    expect(applyCalled).toBe(false);
    await expect(store.isTrusted(workspaceRoot)).resolves.toBe(false);
  });

  it("leaves optional capabilities unchanged without drafting or applying changes", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    await trustWorkspace(tempDir, workspaceRoot);
    const before = await readFile(profileConfigPath(tempDir), "utf8");
    let applyCalled = false;

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({ values: ["telegram", "unchanged"] }),
      defaultActionId: "configure-channels",
      applyExecutor: {
        apply: () => {
          applyCalled = true;
          return { ok: true, appliedOperationIds: [] };
        },
      },
    });

    expect(result.completed).toBe(true);
    expect(result.selectedActionId).toBe("configure-channels");
    expect(result.output).toContain("Telegram/channels left unchanged");
    expect(result.reviewManifest).toBeUndefined();
    expect(result.applyPlanningResult).toBeUndefined();
    expect(applyCalled).toBe(false);
    await expect(readFile(profileConfigPath(tempDir), "utf8")).resolves.toBe(before);
  });

  it("orders optional capability actions with configure first and hides skip when already configured", async () => {
    await writeUserConfig(tempDir, {
      ...localReadyConfig(),
      channels: {
        telegram: {
          enabled: true,
          botTokenEnv: "TELEGRAM_BOT_TOKEN",
          allowedUserIds: ["42"],
        },
      },
    });
    await trustWorkspace(tempDir, workspaceRoot);
    const optionLabels: string[][] = [];
    const defaultLabels: string[] = [];

    const prompt = fakePrompt({ values: ["telegram", "unchanged"] });
    const baseSelect = prompt.select!;
    prompt.select = async (input) => {
      optionLabels.push(input.options.map((option) => option.label));
      defaultLabels.push(input.options[input.defaultIndex ?? 0]?.label ?? "");
      return baseSelect(input);
    };

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt,
      defaultActionId: "configure-channels",
    });

    expect(result.completed).toBe(true);
    expect(optionLabels[0]).toEqual(["Telegram", "WhatsApp beta", "Discord beta", "Back"]);
    expect(optionLabels[1]).toEqual(["Configure", "Leave unchanged", "Back"]);
    expect(defaultLabels[1]).toBe("Configure");
    expect(optionLabels).toHaveLength(2);
    expect(result.reviewManifest).toBeUndefined();
  });

  it("uses configure-first optional action ordering for unconfigured capabilities", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    await trustWorkspace(tempDir, workspaceRoot);
    const actions = [
      { actionId: "configure-channels" as const, values: ["telegram", "unchanged"] },
      { actionId: "configure-voice" as const, values: ["stt", "unchanged"] },
      { actionId: "configure-image-generation" as const, values: ["unchanged"] },
      { actionId: "configure-web-search" as const, values: ["unchanged"] },
      { actionId: "configure-browser" as const, values: ["unchanged"] },
    ];

    for (const { actionId, values } of actions) {
      const optionLabels: string[][] = [];
      const defaultLabels: string[] = [];
      const prompt = fakePrompt({ values });
      const baseSelect = prompt.select!;
      prompt.select = async (input) => {
        optionLabels.push(input.options.map((option) => option.label));
        defaultLabels.push(input.options[input.defaultIndex ?? 0]?.label ?? "");
        return baseSelect(input);
      };

      const result = await runConfigEditor({
        homeDir: tempDir,
        workspaceRoot,
        prompt,
        defaultActionId: actionId,
      });

      expect(result.completed).toBe(true);
      expect(optionLabels.at(-1)).toEqual(["Configure", "Leave unchanged", "Skip", "Back"]);
      expect(defaultLabels.at(-1)).toBe("Configure");
      expect(result.reviewManifest).toBeUndefined();
    }
  });

  it("lets incomplete Telegram optional capability setup skip instead of drafting blockers", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    await trustWorkspace(tempDir, workspaceRoot);
    const before = await readFile(profileConfigPath(tempDir), "utf8");

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({
        values: ["telegram", "enable", "", "", "skip", true],
      }),
      defaultActionId: "configure-channels",
    });

    expect(result.completed).toBe(true);
    expect(result.reviewManifest?.sections.blockers).toHaveLength(0);
    expect(result.reviewManifest?.sections["remote-control-surfaces"]).toHaveLength(0);
    expect(result.applyPlanningResult?.kind).toBe("apply-plan-ready");
    expect(JSON.stringify(result)).not.toContain("123456:");
    await expect(readFile(profileConfigPath(tempDir), "utf8")).resolves.toBe(before);
  });

  it("lets incomplete Telegram optional capability setup retry before drafting", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    await trustWorkspace(tempDir, workspaceRoot);

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({
        values: [
          "telegram",
          "enable",
          "",
          "",
          "retry",
          "42",
          "",
          true,
        ],
      }),
      defaultActionId: "configure-channels",
    });

    expect(result.completed).toBe(true);
    expect(result.reviewManifest?.sections.blockers).toHaveLength(0);
    expect(result.reviewManifest?.sections["remote-control-surfaces"]).toHaveLength(1);
    expect(result.reviewManifest?.sections["remote-control-surfaces"][0]?.review.values.allowedUserIds).toEqual(["42"]);
    expect(result.applyPlanningResult?.kind).toBe("apply-plan-ready");
  });

  it("applies reviewed Telegram optional capability with env ref and allowlisted identities", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    await trustWorkspace(tempDir, workspaceRoot);
    const seenQuestions: string[] = [];
    const seenCards: Array<{ title: string; bodyLines: readonly string[] }> = [];
    const reviewPrompts: Array<{ title: string; body?: string; labels: string[]; descriptions: Array<string | undefined> }> = [];
    const output: string[] = [];
    const basePrompt = fakePrompt({
      values: ["telegram", "enable", "42", "-100", true],
      secret: "123456:stored-telegram-token",
    });
    const prompt = (async (question: string, options?: { secret?: boolean }) => {
      seenQuestions.push(question);
      return basePrompt(question, options);
    }) as Prompt;
    prompt.select = async (input) => {
      if (input.title === "Finalize configuration") {
        reviewPrompts.push({
          title: input.title,
          body: input.body,
          labels: input.options.map((option) => option.label),
          descriptions: input.options.map((option) => option.description),
        });
      }
      return basePrompt.select!(input);
    };
    prompt.onboardingCard = (input) => {
      seenCards.push({ title: input.title, bodyLines: input.bodyLines });
    };
    prompt.close = basePrompt.close;

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt,
      defaultActionId: "configure-channels",
      applyExecutor: createReviewedSetupApplyExecutor({
        homeDir: tempDir,
        workspaceRoot,
      }),
      output: { write: (value) => output.push(value) },
    });
    const rawConfig = await readFile(profileConfigPath(tempDir), "utf8");
    const envFile = await readFile(profileEnvPath(tempDir), "utf8");
    const config = JSON.parse(rawConfig) as {
      channels?: { telegram?: { enabled?: boolean; botTokenEnv?: string; allowedUserIds?: string[]; allowedChatIds?: string[] } };
    };

    expect(result.completed).toBe(true);
    expect(result.selectedActionId).toBe("configure-channels");
    expect(seenQuestions.some((question) => question.includes("Env var name to store Telegram bot token under"))).toBe(false);
    expect(seenQuestions).toContain("Telegram bot API token: ");
    expect(seenQuestions).toContain("Allowed Telegram user ID(s): ");
    expect(seenQuestions).toContain("Allowed Telegram group chat ID(s): ");
    expect(seenCards.map((card) => card.title)).toEqual(["Configure Telegram", "Configure Telegram", "Configure Telegram"]);
    expect(seenCards[0]?.bodyLines).toContain("Connect Telegram bot");
    expect(seenCards[0]?.bodyLines.join("\n")).toContain("Open Telegram and search for the official @BotFather account.");
    expect(seenCards[1]?.bodyLines).toContain("Authorize Telegram users");
    expect(seenCards[1]?.bodyLines.join("\n")).toContain("Open Telegram and search for @userinfobot.");
    expect(seenCards[2]?.bodyLines).toContain("Authorize Telegram group chats");
    expect(seenCards[2]?.bodyLines.join("\n")).toContain("Add @getidsbot or @chatIDrobot to the same group chat.");
    expect(reviewPrompts).toEqual([expect.objectContaining({
      title: "Finalize configuration",
      body: expect.stringContaining("Selected area: Channels · Telegram"),
      labels: ["Confirm", "Cancel"],
      descriptions: ["Update your EstaCoda configuration", "Keep your existing configuration unchanged."],
    })]);
    expect(result.reviewManifest?.sections["enabled-optional-capabilities"]).toHaveLength(1);
    expect(result.reviewManifest?.sections["remote-control-surfaces"]).toHaveLength(1);
    expect(result.output).not.toContain("Review manifest.");
    expect(result.output).not.toContain("Configuration write.");
    expect(result.output).not.toContain("Enabled optional capabilities.");
    expect(result.output).not.toContain("Remote-control surfaces and allowed identities.");
    expect(output.join("")).not.toContain("Review manifest.");
    expect(output.join("")).not.toContain("Configuration write.");
    expect(output.join("")).not.toContain("Enabled optional capabilities.");
    expect(output.join("")).not.toContain("Remote-control surfaces and allowed identities.");
    expect(result.reviewManifest?.sections["enabled-optional-capabilities"].map((line) => line.sourceDraftIds[0])).toEqual([
      "setup-module.telegram.capability",
    ]);
    expect(result.reviewManifest?.sections["remote-control-surfaces"][0]?.review.values.remoteControlIdentityConstraint).toBe("allowed-user-or-chat-id");
    expect(config.channels?.telegram).toEqual(expect.objectContaining({
      enabled: true,
      botTokenEnv: "ESTACODA_TELEGRAM_BOT_TOKEN",
      allowedUserIds: ["42"],
      allowedChatIds: ["-100"],
    }));
    expect(rawConfig).not.toContain("123456:");
    expect(envFile).toContain('ESTACODA_TELEGRAM_BOT_TOKEN="123456:stored-telegram-token"');
    expect(JSON.stringify(result)).not.toContain("123456:");
  });

  it("prompts after reviewed Telegram channel apply before the post-apply handoff and starts the service", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    await trustWorkspace(tempDir, workspaceRoot);
    const actions = gatewayServiceActions();
    const promptTitles: string[] = [];
    const prompt = fakePrompt({
      values: [
        "telegram",
        "enable",
        "42",
        "-100",
        true,
        "Yes",
      ],
      secret: "123456:stored-telegram-token",
    });
    const baseSelect = prompt.select!;
    prompt.select = async (input) => {
      promptTitles.push(input.title);
      return baseSelect(input);
    };

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt,
      defaultActionId: "configure-channels",
      applyExecutor: createReviewedSetupApplyExecutor({
        homeDir: tempDir,
        workspaceRoot,
      }),
      gatewayServiceActivation: { serviceActions: actions },
    });

    expect(result.gatewayServiceActivationResult).toEqual(expect.objectContaining({
      kind: "started",
      installed: true,
    }));
    expect(actions.install).toHaveBeenCalledTimes(1);
    expect(actions.start).toHaveBeenCalledTimes(1);
    expect(promptTitles.indexOf(gatewayServiceActivationPromptTitle)).toBeGreaterThan(-1);
    expect(promptTitles).not.toContain(resolveSetupCopy("en", "setupEditor.prompt.postApply.title"));
    expect(result.output).toContain("Gateway service installed and started for configured Telegram channel.");
    expect(JSON.stringify(result)).not.toContain("123456:stored-telegram-token");
  });

  it("does not install or start when the config-editor gateway prompt is declined", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    await trustWorkspace(tempDir, workspaceRoot);
    const actions = gatewayServiceActions();
    const selectInputs: Record<string, SelectPromptInput<unknown>> = {};
    const prompt = fakePrompt({
      values: [
        "telegram",
        "enable",
        "42",
        "-100",
        true,
        "Not now",
      ],
      secret: "123456:stored-telegram-token",
    });
    const baseSelect = prompt.select!;
    prompt.select = async (input) => {
      selectInputs[input.title] = input as SelectPromptInput<unknown>;
      return baseSelect(input);
    };

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt,
      defaultActionId: "configure-channels",
      applyExecutor: createReviewedSetupApplyExecutor({
        homeDir: tempDir,
        workspaceRoot,
      }),
      gatewayServiceActivation: { serviceActions: actions },
    });

    expect(result.gatewayServiceActivationResult).toEqual(expect.objectContaining({
      kind: "declined",
      output: gatewayServiceActivationNotNowGuidance,
    }));
    expect(actions.install).not.toHaveBeenCalled();
    expect(actions.start).not.toHaveBeenCalled();
    expect(result.output).toContain(gatewayServiceActivationNotNowGuidance);
    expect(selectInputs[gatewayServiceActivationPromptTitle]?.options.find((option) => option.id === "yes")?.group)
      .toBeUndefined();
    expect(selectInputs[gatewayServiceActivationPromptTitle]?.options.find((option) => option.id === "not-now")?.group)
      .toBe("navigation");
  });

  it("does not offer gateway activation when a ready channel already existed before setup editor apply", async () => {
    await writeUserConfig(tempDir, {
      ...localReadyConfig(),
      channels: {
        telegram: {
          enabled: true,
          botTokenEnv: "ESTACODA_TELEGRAM_BOT_TOKEN",
          allowedUserIds: ["42"],
        },
      },
    });
    process.env.ESTACODA_TELEGRAM_BOT_TOKEN = "existing-telegram-token";
    await trustWorkspace(tempDir, workspaceRoot);
    const actions = gatewayServiceActions();
    const promptTitles: string[] = [];
    const prompt = fakePrompt({
      values: ["telegram", "enable", "42", "-100", true],
    });
    const baseSelect = prompt.select!;
    prompt.select = async (input) => {
      promptTitles.push(input.title);
      return baseSelect(input);
    };

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt,
      defaultActionId: "configure-channels",
      applyExecutor: createReviewedSetupApplyExecutor({
        homeDir: tempDir,
        workspaceRoot,
      }),
      gatewayServiceActivation: { serviceActions: actions },
    });

    expect(result.gatewayServiceActivationResult).toEqual({
      kind: "not-offered",
      reason: "ready-channel-already-configured",
    });
    expect(promptTitles).not.toContain(gatewayServiceActivationPromptTitle);
    expect(actions.install).not.toHaveBeenCalled();
    expect(actions.start).not.toHaveBeenCalled();
  });

  it("does not offer gateway activation when the managed service is already installed", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    await trustWorkspace(tempDir, workspaceRoot);
    const actions = gatewayServiceActions({ installedBefore: true });
    const promptTitles: string[] = [];
    const prompt = fakePrompt({
      values: ["telegram", "enable", "42", "-100", true],
      secret: "123456:stored-telegram-token",
    });
    const baseSelect = prompt.select!;
    prompt.select = async (input) => {
      promptTitles.push(input.title);
      return baseSelect(input);
    };

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt,
      defaultActionId: "configure-channels",
      applyExecutor: createReviewedSetupApplyExecutor({
        homeDir: tempDir,
        workspaceRoot,
      }),
      gatewayServiceActivation: { serviceActions: actions },
    });

    expect(result.gatewayServiceActivationResult).toEqual({
      kind: "not-offered",
      reason: "gateway-service-already-installed",
    });
    expect(promptTitles).not.toContain(gatewayServiceActivationPromptTitle);
    expect(actions.install).not.toHaveBeenCalled();
    expect(actions.start).not.toHaveBeenCalled();
  });

  it("applies reviewed Discord beta channel with env ref and fail-closed allowlist", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    await trustWorkspace(tempDir, workspaceRoot);

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({
        values: ["discord", "enable", "DISCORD_BOT_TOKEN", "user-42", "guild-7", "channel-9", true],
        secret: "discord-token-value",
      }),
      defaultActionId: "configure-channels",
      applyExecutor: createReviewedSetupApplyExecutor({
        homeDir: tempDir,
        workspaceRoot,
      }),
    });
    const rawConfig = await readFile(profileConfigPath(tempDir), "utf8");
    const envFile = await readFile(profileEnvPath(tempDir), "utf8");
    const config = JSON.parse(rawConfig) as {
      channels?: {
        discord?: {
          enabled?: boolean;
          botTokenEnv?: string;
          allowedUsers?: string[];
          allowedGuilds?: string[];
          allowedChannels?: string[];
        };
      };
    };

    expect(result.completed).toBe(true);
    expect(result.selectedActionId).toBe("configure-channels");
    expect(result.reviewManifest?.sections["enabled-optional-capabilities"].map((line) => line.sourceDraftIds[0])).toEqual([
      "setup-module.discord.capability",
    ]);
    expect(result.reviewManifest?.sections["remote-control-surfaces"]).toHaveLength(1);
    expect(result.reviewManifest?.sections["remote-control-surfaces"][0]?.review.values.remoteControlIdentityConstraint).toBe("allowed-discord-user-or-channel");
    expect(config.channels?.discord).toEqual(expect.objectContaining({
      enabled: true,
      botTokenEnv: "DISCORD_BOT_TOKEN",
      allowedUsers: ["user-42"],
      allowedGuilds: ["guild-7"],
      allowedChannels: ["channel-9"],
    }));
    expect(rawConfig).not.toContain("discord-token-value");
    expect(envFile).toContain('DISCORD_BOT_TOKEN="discord-token-value"');
    expect(JSON.stringify(result)).not.toContain("discord-token-value");
  });

  it("does not draft Discord beta channel enablement without allowed users or channels", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    await trustWorkspace(tempDir, workspaceRoot);
    const before = await readFile(profileConfigPath(tempDir), "utf8");

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({
        values: ["discord", "enable", "DISCORD_BOT_TOKEN", "", "", "", "skip", true],
        secret: "discord-token-value",
      }),
      defaultActionId: "configure-channels",
    });

    expect(result.completed).toBe(true);
    expect(result.reviewManifest?.sections["remote-control-surfaces"]).toHaveLength(0);
    expect(JSON.stringify(result)).not.toContain("discord-token-value");
    await expect(readFile(profileConfigPath(tempDir), "utf8")).resolves.toBe(before);
  });

  it("runs the shared WhatsApp QR setup flow and writes config after successful pairing", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    await trustWorkspace(tempDir, workspaceRoot);
    const deps = whatsappDepsWithInstalledBridge({ pairDevice: successfulWhatsAppPairDevice("QR\n") });
    const output: string[] = [];

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({
        values: ["whatsapp", "1", "971501234567"],
      }),
      defaultActionId: "configure-channels",
      whatsappSetupDependencies: deps,
      output: { write: (value) => output.push(value) },
    });
    const rawConfig = await readFile(profileConfigPath(tempDir), "utf8");
    const config = JSON.parse(rawConfig) as {
      channels?: {
        whatsapp?: {
          enabled?: boolean;
          experimental?: boolean;
          authDir?: string;
          allowedUsers?: string[];
          mode?: string;
          dmPolicy?: string;
          pairingMode?: string;
        };
      };
    };

    expect(result.completed).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.selectedActionId).toBe("configure-channels");
    expect(result.output).toContain("QR");
    expect(output.join("")).toContain("QR");
    expect(result.output).toContain("✓ Allowed senders: 971501234567");
    expect(result.output).not.toContain("allowed users");
    expect(deps.pairDevice).toHaveBeenCalledOnce();
    expect(config.channels?.whatsapp).toEqual(expect.objectContaining({
      enabled: true,
      experimental: true,
      allowedUsers: ["971501234567"],
      mode: "bot",
      dmPolicy: "allowlist",
      pairingMode: "qr",
    }));
    expect(config.channels?.whatsapp?.authDir).toContain("/gateway/whatsapp-auth");
  });

  it("keeps WhatsApp setup config unchanged when bridge dependency install is declined", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    await trustWorkspace(tempDir, workspaceRoot);
    const before = await readFile(profileConfigPath(tempDir), "utf8");
    const deps = whatsappDepsWithMissingBridge();

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({
        values: ["whatsapp", "n"],
      }),
      defaultActionId: "configure-channels",
      whatsappSetupDependencies: deps,
    });

    expect(result.completed).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("Config was not changed");
    expect(deps.installDependencies).not.toHaveBeenCalled();
    await expect(readFile(profileConfigPath(tempDir), "utf8")).resolves.toBe(before);
  });

  it("keeps WhatsApp setup config unchanged when bridge dependency install fails", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    await trustWorkspace(tempDir, workspaceRoot);
    const before = await readFile(profileConfigPath(tempDir), "utf8");
    const deps = whatsappDepsWithMissingBridge({ installError: new Error("offline") });

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({
        values: ["whatsapp", "y"],
      }),
      defaultActionId: "configure-channels",
      whatsappSetupDependencies: deps,
    });

    expect(result.completed).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("offline");
    await expect(readFile(profileConfigPath(tempDir), "utf8")).resolves.toBe(before);
  });

  it("keeps WhatsApp setup config unchanged when QR pairing times out", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    await trustWorkspace(tempDir, workspaceRoot);
    const before = await readFile(profileConfigPath(tempDir), "utf8");

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({
        values: ["whatsapp", "1", "971501234567"],
      }),
      defaultActionId: "configure-channels",
      whatsappSetupDependencies: whatsappDepsWithInstalledBridge({
        pairDevice: vi.fn(async () => ({ ok: false as const, reason: "timeout" as const })),
      }),
    });

    expect(result.completed).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("Pairing timed out");
    await expect(readFile(profileConfigPath(tempDir), "utf8")).resolves.toBe(before);
  });

  it("keeps WhatsApp setup config unchanged when QR pairing fails", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    await trustWorkspace(tempDir, workspaceRoot);
    const before = await readFile(profileConfigPath(tempDir), "utf8");

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({
        values: ["whatsapp", "2", "971501234567"],
      }),
      defaultActionId: "configure-channels",
      whatsappSetupDependencies: whatsappDepsWithInstalledBridge({
        pairDevice: vi.fn(async () => ({ ok: false as const, reason: "failed" as const, message: "socket closed" })),
      }),
    });

    expect(result.completed).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("socket closed");
    await expect(readFile(profileConfigPath(tempDir), "utf8")).resolves.toBe(before);
  });

  it("keeps a blank WhatsApp allowlist in pairing-pending mode without opening access", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    await trustWorkspace(tempDir, workspaceRoot);

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({
        values: ["whatsapp", "2", ""],
      }),
      defaultActionId: "configure-channels",
      whatsappSetupDependencies: whatsappDepsWithInstalledBridge({ pairDevice: successfulWhatsAppPairDevice() }),
    });
    const config = JSON.parse(await readFile(profileConfigPath(tempDir), "utf8")) as {
      channels?: { whatsapp?: { allowedUsers?: string[]; dmPolicy?: string } };
    };

    expect(result.completed).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("pairing-pending");
    expect(config.channels?.whatsapp?.allowedUsers).toEqual([]);
    expect(config.channels?.whatsapp?.dmPolicy).toBe("pairing");
    expect(JSON.stringify(config.channels?.whatsapp)).not.toContain("open");
  });

  it("offers gateway activation after reviewed Discord and WhatsApp channel setup when each is ready", async () => {
    for (const scenario of [
      {
        channel: "discord",
        values: ["discord", "enable", "DISCORD_BOT_TOKEN", "user-42", "", "channel-9", true, "Not now", "exit"],
        secret: "discord-token-value",
        expected: "Discord",
      },
      {
        channel: "whatsapp",
        values: ["whatsapp", "1", "971501234567", "Not now"],
        secret: undefined,
        expected: "WhatsApp",
      },
    ] as const) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = await makeTempDir();
      workspaceRoot = join(tempDir, "workspace");
      await mkdir(workspaceRoot, { recursive: true });
      await writeUserConfig(tempDir, localReadyConfig());
      await trustWorkspace(tempDir, workspaceRoot);
      const promptTitles: string[] = [];
      const prompt = fakePrompt({
        values: scenario.values,
        secret: scenario.secret,
      });
      const baseSelect = prompt.select!;
      prompt.select = async (input) => {
        promptTitles.push(input.title);
        return baseSelect(input);
      };
      const actions = gatewayServiceActions();

      const result = await runConfigEditor({
        homeDir: tempDir,
        workspaceRoot,
        prompt,
        defaultActionId: "configure-channels",
        applyExecutor: createReviewedSetupApplyExecutor({
          homeDir: tempDir,
          workspaceRoot,
        }),
        whatsappSetupDependencies: scenario.channel === "whatsapp"
          ? whatsappDepsWithInstalledBridge({ pairDevice: successfulWhatsAppPairDevice() })
          : undefined,
        gatewayServiceActivation: { serviceActions: actions },
      });

      expect(result.gatewayServiceActivationResult).toEqual(expect.objectContaining({
        kind: "declined",
        channels: [expect.objectContaining({ label: scenario.expected })],
      }));
      expect(promptTitles).toContain(gatewayServiceActivationPromptTitle);
      expect(actions.install).not.toHaveBeenCalled();
      expect(actions.start).not.toHaveBeenCalled();
      expect(JSON.stringify(result)).not.toContain("discord-token-value");
      expect(scenario.channel).toMatch(/discord|whatsapp/u);
    }
  });

  it("does not use the old reviewed WhatsApp draft path for normal Setup Editor setup", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    await trustWorkspace(tempDir, workspaceRoot);

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({
        values: ["whatsapp", "1", "971501234567"],
      }),
      defaultActionId: "configure-channels",
      applyExecutor: {
        apply: () => {
          throw new Error("reviewed WhatsApp draft path should not be used");
        },
      },
      whatsappSetupDependencies: whatsappDepsWithInstalledBridge({ pairDevice: successfulWhatsAppPairDevice() }),
    });

    expect(result.completed).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  it("does not offer gateway activation for non-channel config-editor changes", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    await trustWorkspace(tempDir, workspaceRoot);
    const actions = gatewayServiceActions();
    const promptTitles: string[] = [];
    const prompt = fakePrompt({ values: ["strict", true, "exit"] });
    const baseSelect = prompt.select!;
    prompt.select = async (input) => {
      promptTitles.push(input.title);
      return baseSelect(input);
    };

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt,
      defaultActionId: "edit-security-mode",
      applyExecutor: createReviewedSetupApplyExecutor({
        homeDir: tempDir,
        workspaceRoot,
      }),
      gatewayServiceActivation: { serviceActions: actions },
    });

    expect(result.gatewayServiceActivationResult?.kind).toBe("not-offered");
    expect(promptTitles).not.toContain(gatewayServiceActivationPromptTitle);
    expect(actions.install).not.toHaveBeenCalled();
    expect(actions.start).not.toHaveBeenCalled();
  });

  it("does not offer gateway activation for provider, voice, or browser-only changes", async () => {
    for (const scenario of [
      {
        actionId: "edit-primary-model-route" as const,
        values: ["OpenAI", "gpt-5.5", true],
        secret: "sk-provider-only-secret",
        flowEngine: flowEngine({ credentialAction: "collect", envVarName: "PR8_PROVIDER_ONLY_KEY" }),
      },
      {
        actionId: "configure-voice" as const,
        values: ["stt", "enable", "openai", "gpt-4o-mini-transcribe", "VOICE_STT_KEY", true],
      },
      {
        actionId: "configure-browser" as const,
        values: ["enable", "existing-cdp", "http://127.0.0.1:9222", true],
      },
    ]) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = await makeTempDir();
      workspaceRoot = join(tempDir, "workspace");
      await mkdir(workspaceRoot, { recursive: true });
      await writeUserConfig(tempDir, localReadyConfig());
      await trustWorkspace(tempDir, workspaceRoot);
      const actions = gatewayServiceActions();
      const promptTitles: string[] = [];
      const prompt = fakePrompt({
        values: scenario.values,
        secret: scenario.secret,
      });
      const baseSelect = prompt.select!;
      prompt.select = async (input) => {
        promptTitles.push(input.title);
        return baseSelect(input);
      };

      const result = await runConfigEditor({
        homeDir: tempDir,
        workspaceRoot,
        prompt,
        defaultActionId: scenario.actionId,
        ...(scenario.flowEngine === undefined ? {} : { flowEngine: scenario.flowEngine }),
        applyExecutor: createReviewedSetupApplyExecutor({
          homeDir: tempDir,
          workspaceRoot,
          collectVerification: () => readyVerification(profileConfigPath(tempDir)),
        }),
        gatewayServiceActivation: { serviceActions: actions },
      });

      expect(result.gatewayServiceActivationResult?.kind).toBe("not-offered");
      expect(promptTitles).not.toContain(gatewayServiceActivationPromptTitle);
      expect(actions.install).not.toHaveBeenCalled();
      expect(actions.start).not.toHaveBeenCalled();
      expect(JSON.stringify(result)).not.toContain("sk-provider-only-secret");
    }
  });

  it("does not offer gateway activation when channel review is cancelled", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    await trustWorkspace(tempDir, workspaceRoot);
    const actions = gatewayServiceActions();
    const promptTitles: string[] = [];
  const prompt = fakePrompt({
      values: ["telegram", "enable", "42", "-100", false],
      secret: "123456:stored-telegram-token",
    });
    const baseSelect = prompt.select!;
    prompt.select = async (input) => {
      promptTitles.push(input.title);
      return baseSelect(input);
    };

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt,
      defaultActionId: "configure-channels",
      applyExecutor: createReviewedSetupApplyExecutor({
        homeDir: tempDir,
        workspaceRoot,
      }),
      gatewayServiceActivation: { serviceActions: actions },
    });

    expect(result.applyPlanningResult?.kind).toBe("cancelled");
    expect(result.gatewayServiceActivationResult).toBeUndefined();
    expect(promptTitles).not.toContain(gatewayServiceActivationPromptTitle);
    expect(actions.install).not.toHaveBeenCalled();
    expect(actions.start).not.toHaveBeenCalled();
  });

  it("does not offer gateway activation when channel apply fails", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    await trustWorkspace(tempDir, workspaceRoot);
    const actions = gatewayServiceActions();
    const promptTitles: string[] = [];
  const prompt = fakePrompt({
      values: ["telegram", "enable", "42", "-100", true],
      secret: "123456:stored-telegram-token",
    });
    const baseSelect = prompt.select!;
    prompt.select = async (input) => {
      promptTitles.push(input.title);
      return baseSelect(input);
    };

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt,
      defaultActionId: "configure-channels",
      applyExecutor: {
        apply: () => ({ ok: false, appliedOperationIds: [], error: "intentional apply failure" }),
      },
      gatewayServiceActivation: { serviceActions: actions },
    });

    expect(result.applyEndState?.kind).toBe("blocked");
    expect(result.gatewayServiceActivationResult?.kind).toBe("not-offered");
    expect(promptTitles).not.toContain(gatewayServiceActivationPromptTitle);
    expect(actions.install).not.toHaveBeenCalled();
    expect(actions.start).not.toHaveBeenCalled();
  });

  it("uses the config-editor post-apply handoff gate before offering gateway activation", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    await trustWorkspace(tempDir, workspaceRoot);
    const actions = gatewayServiceActions();
    const promptTitles: string[] = [];
  const prompt = fakePrompt({
      values: ["telegram", "enable", "42", "-100", true, "exit"],
      secret: "123456:stored-telegram-token",
    });
    const baseSelect = prompt.select!;
    prompt.select = async (input) => {
      promptTitles.push(input.title);
      return baseSelect(input);
    };

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt,
      defaultActionId: "configure-channels",
      applyExecutor: createReviewedSetupApplyExecutor({
        homeDir: tempDir,
        workspaceRoot,
        collectVerification: () => ({
          stateWritable: false,
          envFilePresent: false,
          envFileSecure: true,
          workspaceTrusted: true,
          securityModeLabel: "Adaptive",
          securityModeValue: "adaptive",
          skillAutonomyLabel: "Suggest",
          skillAutonomyValue: "suggest",
          providerDiagnostic: {
            status: "ready",
            lines: ["Provider status: ready"],
            warnings: [],
          },
          toolStatus: "skipped",
          configSources: [],
          warnings: ["state is not writable"],
          issueCodes: ["state-not-writable"],
        }),
      }),
      gatewayServiceActivation: { serviceActions: actions },
    });

    expect(result.gatewayServiceActivationResult?.kind).toBe("not-offered");
    expect(promptTitles).not.toContain(gatewayServiceActivationPromptTitle);
    expect(actions.install).not.toHaveBeenCalled();
    expect(actions.start).not.toHaveBeenCalled();
  });

  it("configures TTS voice without drafting STT or other optional capabilities", async () => {
    await writeUserConfig(tempDir, {
      ...localReadyConfig(),
      stt: {
        provider: "local",
        local: {
          engine: "command",
          command: "existing-stt-command",
        },
      },
    });
    await trustWorkspace(tempDir, workspaceRoot);

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({
        values: [
          "tts",
          "enable",
          "openai",
          "gpt-4o-mini-tts",
          "VOICE_TTS_KEY",
          true,
        ],
      }),
      defaultActionId: "configure-voice",
      applyExecutor: createReviewedSetupApplyExecutor({
        homeDir: tempDir,
        workspaceRoot,
      }),
    });
    const rawConfig = await readFile(profileConfigPath(tempDir), "utf8");
    const config = JSON.parse(rawConfig) as {
      channels?: unknown;
      tts?: { provider?: string; openai?: { model?: string; apiKeyEnv?: string } };
      stt?: { provider?: string; openai?: { model?: string; apiKeyEnv?: string } };
      imageGen?: unknown;
      browser?: unknown;
    };

    expect(result.completed).toBe(true);
    expect(result.selectedActionId).toBe("configure-voice");
    expect(result.reviewManifest?.sections["enabled-optional-capabilities"][0]?.review.values).toMatchObject({
      ttsProvider: "openai",
      ttsModel: "gpt-4o-mini-tts",
      ttsApiKeyEnv: "VOICE_TTS_KEY",
      secretValuesIncluded: false,
    });
    expect(result.reviewManifest?.sections["enabled-optional-capabilities"][0]?.review.values).not.toHaveProperty("sttProvider");
    expect(result.reviewManifest?.sections["enabled-optional-capabilities"].map((line) => line.sourceDraftIds[0])).toEqual([
      "setup-module.voice.capability",
    ]);
    expect(config.tts?.provider).toBe("openai");
    expect(config.tts?.openai?.apiKeyEnv).toBe("VOICE_TTS_KEY");
    expect(config.stt).toEqual({
      provider: "local",
      local: {
        engine: "command",
        command: "existing-stt-command",
      },
    });
    expect(config.channels).toBeUndefined();
    expect(config.imageGen).toBeUndefined();
    expect(config.browser).toBeUndefined();
    expect(rawConfig).not.toContain("sk-");
    expect(JSON.stringify(result)).not.toContain("sk-");
  });

  it("configures STT voice without drafting or writing TTS", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    await trustWorkspace(tempDir, workspaceRoot);

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({
        values: [
          "stt",
          "enable",
          "openai",
          "gpt-4o-mini-transcribe",
          "VOICE_STT_KEY",
          true,
        ],
      }),
      defaultActionId: "configure-voice",
      applyExecutor: createReviewedSetupApplyExecutor({
        homeDir: tempDir,
        workspaceRoot,
      }),
    });
    const rawConfig = await readFile(profileConfigPath(tempDir), "utf8");
    const config = JSON.parse(rawConfig) as {
      tts?: unknown;
      stt?: { provider?: string; openai?: { model?: string; apiKeyEnv?: string } };
    };

    expect(result.completed).toBe(true);
    expect(result.selectedActionId).toBe("configure-voice");
    expect(result.reviewManifest?.sections["enabled-optional-capabilities"][0]?.review.values).toMatchObject({
      sttProvider: "openai",
      sttModel: "gpt-4o-mini-transcribe",
      sttApiKeyEnv: "VOICE_STT_KEY",
      secretValuesIncluded: false,
    });
    expect(result.reviewManifest?.sections["enabled-optional-capabilities"][0]?.review.values).not.toHaveProperty("ttsProvider");
    expect(config.tts).toBeUndefined();
    expect(config.stt?.provider).toBe("openai");
    expect(config.stt?.openai?.apiKeyEnv).toBe("VOICE_STT_KEY");
    expect(rawConfig).not.toContain("sk-");
    expect(JSON.stringify(result)).not.toContain("sk-");
  });

  it("configures local faster-whisper STT with prompt-card model choices", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    await trustWorkspace(tempDir, workspaceRoot);
    mockManagedPythonEnvironment(tempDir);
    const selectCalls: Array<{
      title: string;
      body: string;
      labels: string[];
      descriptions: Array<string | undefined>;
      values: unknown[];
    }> = [];
    const prompt = fakePrompt({
      values: [
        "stt",
        "enable",
        "local",
        "base",
        true,
      ],
    });
    const baseSelect = prompt.select!;
    prompt.select = async (input) => {
      selectCalls.push({
        title: input.title,
        body: input.body ?? "",
        labels: input.options.map((option) => option.label),
        descriptions: input.options.map((option) => option.description),
        values: input.options.map((option) => option.value),
      });
      return baseSelect(input);
    };

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt,
      defaultActionId: "configure-voice",
      applyExecutor: createReviewedSetupApplyExecutor({
        homeDir: tempDir,
        workspaceRoot,
      }),
    });
    const rawConfig = await readFile(profileConfigPath(tempDir), "utf8");
    const config = JSON.parse(rawConfig) as {
      tts?: unknown;
      stt?: {
        provider?: string;
        local?: {
          model?: string;
          engine?: string;
          fasterWhisper?: {
            enabled?: boolean;
            model?: string;
            allowModelDownload?: boolean;
          };
        };
      };
    };
    const sttProviderPrompt = selectCalls.find((call) => call.body.includes("STT provider"));
    const localModelPrompt = selectCalls.find((call) => call.body.includes("Pick the faster-whisper STT model"));

    expect(result.completed).toBe(true);
    expect(result.selectedActionId).toBe("configure-voice");
    expect(result.reviewManifest?.sections["enabled-optional-capabilities"][0]?.review.values).toMatchObject({
      sttProvider: "local",
      sttModel: "base",
      secretValuesIncluded: false,
    });
    expect(result.reviewManifest?.sections["enabled-optional-capabilities"][0]?.review.values).not.toHaveProperty("ttsProvider");
    expect(config.tts).toBeUndefined();
    expect(config.stt).toEqual({
      provider: "local",
      local: {
        model: "base",
        engine: "faster-whisper",
        fasterWhisper: {
          enabled: true,
          model: "base",
          allowModelDownload: true,
        },
      },
    });
    expect(sttProviderPrompt?.labels).toContain("Local (via faster-whisper)");
    expect(sttProviderPrompt?.values).toContain("local");
    expect(localModelPrompt?.title).toBe("Configure STT");
    expect(localModelPrompt?.labels).toEqual([
      "Base (recommended for everyday use)",
      "Small",
      "Medium",
      "Back",
    ]);
    expect(localModelPrompt?.descriptions).toEqual([
      "Balanced speed and accuracy for most voice notes.",
      "Better accuracy than Base, with higher CPU and memory use.",
      "Higher accuracy for difficult audio, but slower and heavier.",
      "Return to the previous step.",
    ]);
    expect(localModelPrompt?.values.slice(0, 3)).toEqual(["base", "small", "medium"]);
    expect(typeof localModelPrompt?.values[3]).toBe("symbol");
    expect(rawConfig).not.toContain("sk-");
    expect(JSON.stringify(result)).not.toContain("sk-");
  });

  for (const model of ["small", "medium"] as const) {
    it(`configures local faster-whisper STT model ${model}`, async () => {
      await writeUserConfig(tempDir, localReadyConfig());
      await trustWorkspace(tempDir, workspaceRoot);
      mockManagedPythonEnvironment(tempDir);

      const result = await runConfigEditor({
        homeDir: tempDir,
        workspaceRoot,
        prompt: fakePrompt({
          values: [
            "stt",
            "enable",
            "local",
            model,
            true,
          ],
        }),
        defaultActionId: "configure-voice",
        applyExecutor: createReviewedSetupApplyExecutor({
          homeDir: tempDir,
          workspaceRoot,
        }),
      });
      const rawConfig = await readFile(profileConfigPath(tempDir), "utf8");
      const config = JSON.parse(rawConfig) as {
        stt?: {
          provider?: string;
          local?: {
            model?: string;
            engine?: string;
            fasterWhisper?: { enabled?: boolean; model?: string; allowModelDownload?: boolean };
          };
        };
      };

      expect(result.completed).toBe(true);
      expect(config.stt).toEqual({
        provider: "local",
        local: {
          model,
          engine: "faster-whisper",
          fasterWhisper: {
            enabled: true,
            model,
            allowModelDownload: true,
          },
        },
      });
    });
  }

  it("configures image generation without drafting other optional capabilities", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    await trustWorkspace(tempDir, workspaceRoot);

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({
        values: [
          "enable",
          "fal",
          "fal-ai/imagen4/preview",
          "FAL_KEY",
          false,
          true,
        ],
      }),
      defaultActionId: "configure-image-generation",
      applyExecutor: createReviewedSetupApplyExecutor({
        homeDir: tempDir,
        workspaceRoot,
      }),
    });
    const rawConfig = await readFile(profileConfigPath(tempDir), "utf8");
    const config = JSON.parse(rawConfig) as {
      channels?: unknown;
      tts?: unknown;
      stt?: unknown;
      imageGen?: { provider?: string; model?: string; fal?: { apiKeyEnv?: string } };
      browser?: unknown;
    };

    expect(result.completed).toBe(true);
    expect(result.selectedActionId).toBe("configure-image-generation");
    expect(result.reviewManifest?.sections["enabled-optional-capabilities"].map((line) => line.sourceDraftIds[0])).toEqual([
      "setup-module.vision.capability",
    ]);
    expect(config.imageGen?.provider).toBe("fal");
    expect(config.imageGen?.fal?.apiKeyEnv).toBe("FAL_KEY");
    expect(config.channels).toBeUndefined();
    expect(config.tts).toBeUndefined();
    expect(config.stt).toBeUndefined();
    expect(config.browser).toBeUndefined();
    expect(rawConfig).not.toContain("sk-");
    expect(JSON.stringify(result)).not.toContain("sk-");
  });

  it("browser mode picker includes recommended first and the existing browser modes", async () => {
    const seenOptions: string[] = [];
    const prompt = fakePrompt({ values: ["disabled"] });
    const baseSelect = prompt.select!;
    prompt.select = async (input) => {
      if (input.title === "Browser configuration") {
        seenOptions.push(...input.options.map((option) => option.label));
      }
      return baseSelect(input);
    };

    const values = await promptBrowserCapability(prompt, {});

    expect(values.backend).toBe("unconfigured");
    expect(seenOptions).toEqual([
      "Recommended browser setup",
      "Local supervised browser",
      "Existing CDP browser",
      "Browserbase cloud browser",
      "Disable browser tools",
    ]);
  });

  it("maps recommended browser setup to local supervised CDP without follow-up prompts", async () => {
    const selectedTitles: string[] = [];
    const textPrompts: string[] = [];
    const basePrompt = fakePrompt({ values: ["recommended"] });
    const prompt = (async (question: string, options?: { secret?: boolean }) => {
      textPrompts.push(question);
      return basePrompt(question, options);
    }) as Prompt;
    prompt.select = async (input) => {
      selectedTitles.push(input.title);
      return basePrompt.select!(input);
    };
    prompt.onboardingCard = basePrompt.onboardingCard;
    prompt.close = basePrompt.close;

    const values = await promptBrowserCapability(prompt, {});

    expect(values).toEqual({
      backend: "local-cdp",
      autoLaunch: true,
      supervised: true,
      engine: "cdp",
      launchArgs: [],
      chromeFlags: [],
      hybridRouting: false,
    });
    expect(promptedBrowserCapabilityMode(values)).toBe("local-supervised");
    expect(selectedTitles).toEqual(["Browser configuration"]);
    expect(textPrompts).toEqual([]);
  });

  it("maps local supervised browser mode to flat browser config fields", async () => {
    const values = await promptBrowserCapability(fakePrompt({
      values: [
        "local-supervised",
        true,
        "",
        "/usr/bin/chromium",
        "--headless=new",
        "--no-first-run, --disable-gpu",
      ],
    }), {});

    expect(values).toEqual({
      backend: "local-cdp",
      cdpUrl: undefined,
      launchExecutable: "/usr/bin/chromium",
      launchArgs: ["--headless=new"],
      chromeFlags: ["--no-first-run", "--disable-gpu"],
      launchCommand: undefined,
      autoLaunch: true,
      supervised: true,
    });
  });

  it("maps existing CDP browser mode to flat browser config fields", async () => {
    const values = await promptBrowserCapability(fakePrompt({
      values: ["existing-cdp", "http://127.0.0.1:9222"],
    }), {});

    expect(values).toEqual({
      backend: "local-cdp",
      cdpUrl: "http://127.0.0.1:9222",
      launchArgs: [],
      chromeFlags: [],
      launchCommand: undefined,
      autoLaunch: false,
      supervised: true,
    });
  });

  it("maps Browserbase browser mode to flat browser config fields", async () => {
    const values = await promptBrowserCapability(fakePrompt({
      values: ["browserbase"],
    }), {});

    expect(values).toEqual({
      backend: "browserbase",
      cloudProvider: "browserbase",
      launchArgs: [],
      chromeFlags: [],
      autoLaunch: false,
      supervised: false,
      hybridRouting: true,
      cloudFallback: true,
      cloudSpendApproved: false,
    });
  });

  it("maps disabled browser mode to unconfigured backend", async () => {
    const values = await promptBrowserCapability(fakePrompt({
      values: ["disabled"],
    }), {});

    expect(values).toEqual({
      backend: "unconfigured",
      launchArgs: [],
      chromeFlags: [],
      autoLaunch: false,
      supervised: false,
    });
  });

  it("configures existing CDP browser without drafting other optional capabilities or auto-launching", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    await trustWorkspace(tempDir, workspaceRoot);

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({
        values: [
          "enable",
          "existing-cdp",
          "http://127.0.0.1:1",
          true,
        ],
      }),
      defaultActionId: "configure-browser",
      applyExecutor: createReviewedSetupApplyExecutor({
        homeDir: tempDir,
        workspaceRoot,
      }),
    });
    const rawConfig = await readFile(profileConfigPath(tempDir), "utf8");
    const config = JSON.parse(rawConfig) as {
      channels?: unknown;
      tts?: unknown;
      stt?: unknown;
      imageGen?: unknown;
      browser?: {
        backend?: string;
        cdpUrl?: string;
        launchExecutable?: string;
        launchArgs?: string[];
        chromeFlags?: string[];
        launchCommand?: string;
        autoLaunch?: boolean;
        supervised?: boolean;
      };
    };
    const browserLine = result.reviewManifest?.sections["enabled-optional-capabilities"]
      .find((line) => line.sourceDraftIds.includes("setup-module.browser.capability"));

    expect(result.completed).toBe(true);
    expect(result.selectedActionId).toBe("configure-browser");
    expect(result.reviewManifest?.sections["enabled-optional-capabilities"].map((line) => line.sourceDraftIds[0])).toEqual([
      "setup-module.browser.capability",
    ]);
    expect(browserLine?.review.values.autoLaunchRequested).toBe(false);
    expect(browserLine?.review.values.autoLaunchWillRunNow).toBe(false);
    expect(config.browser).toEqual({
      backend: "local-cdp",
      cdpUrl: "http://127.0.0.1:1",
      autoLaunch: false,
      supervised: true,
    });
    expect(config.channels).toBeUndefined();
    expect(config.tts).toBeUndefined();
    expect(config.stt).toBeUndefined();
    expect(config.imageGen).toBeUndefined();
    expect(rawConfig).not.toContain("sk-");
    expect(JSON.stringify(result)).not.toContain("sk-");
  });

  it("blocks existing CDP browser setup when the CDP URL is missing", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    await trustWorkspace(tempDir, workspaceRoot);
    let applyCalled = false;

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({
        values: ["enable", "existing-cdp", ""],
      }),
      defaultActionId: "configure-browser",
      applyExecutor: {
        apply: () => {
          applyCalled = true;
          return { ok: true, appliedOperationIds: [] };
        },
      },
    });

    expect(result.completed).toBe(false);
    expect(result.applyPlanningResult?.kind).toBe("blocked");
    expect(JSON.stringify(result.reviewManifest?.blockers)).toContain("Existing CDP browser requires a CDP URL.");
    expect(applyCalled).toBe(false);
  });

  it("blocks existing CDP browser setup when the CDP URL is non-local", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    await trustWorkspace(tempDir, workspaceRoot);

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({
        values: ["enable", "existing-cdp", "http://example.com:9222"],
      }),
      defaultActionId: "configure-browser",
      applyExecutor: {
        apply: () => ({ ok: true, appliedOperationIds: [] }),
      },
    });

    expect(result.completed).toBe(false);
    expect(result.applyPlanningResult?.kind).toBe("blocked");
    expect(JSON.stringify(result.reviewManifest?.blockers)).toContain(
      "Existing CDP browser requires a local CDP URL: localhost, 127.0.0.1, or ::1."
    );
  });

  it("blocks local supervised browser setup without auto-launch or CDP URL", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    await trustWorkspace(tempDir, workspaceRoot);

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({
        values: ["enable", "local-supervised", false, "", "", "", ""],
      }),
      defaultActionId: "configure-browser",
      applyExecutor: {
        apply: () => ({ ok: true, appliedOperationIds: [] }),
      },
    });

    expect(result.completed).toBe(false);
    expect(result.applyPlanningResult?.kind).toBe("blocked");
    expect(JSON.stringify(result.reviewManifest?.blockers)).toContain(
      "Local supervised browser requires auto-launch or a local CDP URL."
    );
  });

  it("configures Browserbase credentials through reviewed deferred secret writes", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    await trustWorkspace(tempDir, workspaceRoot);

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({
        values: ["enable", "browserbase", true],
        secret: ["bb-api-secret", "bb-project-secret"],
      }),
      defaultActionId: "configure-browser",
      applyExecutor: createReviewedSetupApplyExecutor({
        homeDir: tempDir,
        workspaceRoot,
      }),
    });
    const envFile = await readFile(profileEnvPath(tempDir), "utf8");
    const browserCredentialLine = result.reviewManifest?.sections["secret-refs-to-store"]
      .find((line) => line.sourceDraftIds.includes("setup-module.browser.browserbase-credentials"));

    expect(result.completed).toBe(true);
    expect(result.selectedActionId).toBe("configure-browser");
    expect(browserCredentialLine?.review.values).toMatchObject({
      credentialSurface: "browserbase",
      envVars: ["BROWSERBASE_API_KEY", "BROWSERBASE_PROJECT_ID"],
      credentialValuesIncluded: false,
    });
    expect(envFile).toContain('BROWSERBASE_API_KEY="bb-api-secret"');
    expect(envFile).toContain('BROWSERBASE_PROJECT_ID="bb-project-secret"');
    expect(JSON.stringify(result.reviewManifest)).not.toContain("bb-api-secret");
    expect(JSON.stringify(result.reviewManifest)).not.toContain("bb-project-secret");
    expect(JSON.stringify(result)).not.toContain("bb-api-secret");
    expect(JSON.stringify(result)).not.toContain("bb-project-secret");
  });

  it("reuses existing Browserbase environment secrets without deferred writes", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    await trustWorkspace(tempDir, workspaceRoot);
    process.env.BROWSERBASE_API_KEY = "env-browserbase-api";
    process.env.BROWSERBASE_PROJECT_ID = "env-browserbase-project";

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({
        values: ["enable", "browserbase", true],
        secret: "should-not-be-read",
      }),
      defaultActionId: "configure-browser",
      applyExecutor: createReviewedSetupApplyExecutor({
        homeDir: tempDir,
        workspaceRoot,
      }),
    });
    const browserCredentialLine = result.reviewManifest?.sections["secret-refs-to-store"]
      .find((line) => line.sourceDraftIds.includes("setup-module.browser.browserbase-credentials"));

    expect(result.completed).toBe(true);
    expect(browserCredentialLine?.review.values.envVars).toEqual(["BROWSERBASE_API_KEY", "BROWSERBASE_PROJECT_ID"]);
    await expect(readFile(profileEnvPath(tempDir), "utf8")).rejects.toThrow();
    expect(JSON.stringify(result)).not.toContain("env-browserbase-api");
    expect(JSON.stringify(result)).not.toContain("env-browserbase-project");
    expect(JSON.stringify(result)).not.toContain("should-not-be-read");
  });

  it("blocks Browserbase setup when credentials are skipped without an existing source", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    await trustWorkspace(tempDir, workspaceRoot);
    let applyCalled = false;

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({
        values: ["enable", "browserbase", true],
        secret: ["", ""],
      }),
      defaultActionId: "configure-browser",
      applyExecutor: {
        apply: () => {
          applyCalled = true;
          return { ok: true, appliedOperationIds: [] };
        },
      },
    });

    expect(result.completed).toBe(false);
    expect(result.applyPlanningResult?.kind).toBe("blocked");
    const blockerText = JSON.stringify(result.reviewManifest?.blockers);
    expect(result.reviewManifest?.sections["secret-refs-to-store"]).toEqual([]);
    expect(blockerText).toContain("BROWSERBASE_API_KEY");
    expect(blockerText).toContain("BROWSERBASE_PROJECT_ID");
    expect(applyCalled).toBe(false);
  });

  it("configures Brave Search credentials through reviewed deferred secret writes", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    await trustWorkspace(tempDir, workspaceRoot);

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({
        values: ["enable", "brave", true],
        secret: "brave-secret",
      }),
      defaultActionId: "configure-web-search",
      applyExecutor: createReviewedSetupApplyExecutor({
        homeDir: tempDir,
        workspaceRoot,
      }),
    });
    const envFile = await readFile(profileEnvPath(tempDir), "utf8");
    const config = JSON.parse(await readFile(profileConfigPath(tempDir), "utf8")) as {
      web?: { searchBackend?: string; brave?: { apiKeyEnv?: string; apiKey?: string } };
    };
    const braveCredentialLine = result.reviewManifest?.sections["secret-refs-to-store"]
      .find((line) => line.sourceDraftIds.includes("setup-module.web-search.brave-credential"));

    expect(result.completed).toBe(true);
    expect(result.selectedActionId).toBe("configure-web-search");
    expect(config.web).toEqual({
      enableNetwork: true,
      searchBackend: "brave",
      brave: {
        apiKeyEnv: "BRAVE_SEARCH_API_KEY",
      },
    });
    expect(config.web?.brave?.apiKey).toBeUndefined();
    expect(braveCredentialLine?.review.values).toMatchObject({
      credentialSurface: "web-search-brave",
      envVars: ["BRAVE_SEARCH_API_KEY"],
      credentialValuesIncluded: false,
    });
    expect(envFile).toContain('BRAVE_SEARCH_API_KEY="brave-secret"');
    expect(JSON.stringify(result)).not.toContain("brave-secret");
  });

  it("configures DDGS Search when the managed capability is ready", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    await trustWorkspace(tempDir, workspaceRoot);
    vi.spyOn(capabilityManager, "checkManagedPythonCapabilityStatus").mockResolvedValue(readyDdgsStatus(tempDir));
    const installSpy = vi.spyOn(capabilityManager, "installManagedPythonCapabilityEnvironment").mockResolvedValue(readyDdgsInstallResult(tempDir));

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({
        values: ["enable", "ddgs", true],
      }),
      defaultActionId: "configure-web-search",
      applyExecutor: createReviewedSetupApplyExecutor({
        homeDir: tempDir,
        workspaceRoot,
      }),
    });
    const config = JSON.parse(await readFile(profileConfigPath(tempDir), "utf8")) as {
      web?: { searchBackend?: string };
    };

    expect(result.completed).toBe(true);
    expect(result.selectedActionId).toBe("configure-web-search");
    expect(config.web?.searchBackend).toBe("ddgs");
    expect(installSpy).not.toHaveBeenCalled();
  });

  it("plans reviewed DDGS managed capability setup only after explicit confirmation", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    await trustWorkspace(tempDir, workspaceRoot);
    vi.spyOn(capabilityManager, "checkManagedPythonCapabilityStatus").mockResolvedValue({
      ok: false,
      capabilityId: DDGS_CAPABILITY_ID,
      reason: "install_required",
      message: "Managed Python capability environment has not been installed.",
    });
    const installSpy = vi.spyOn(capabilityManager, "installManagedPythonCapabilityEnvironment").mockResolvedValue(readyDdgsInstallResult(tempDir));

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({
        values: ["enable", "ddgs", true, true],
      }),
      defaultActionId: "configure-web-search",
      applyExecutor: createReviewedSetupApplyExecutor({
        homeDir: tempDir,
        workspaceRoot,
      }),
    });
    const config = JSON.parse(await readFile(profileConfigPath(tempDir), "utf8")) as {
      web?: { searchBackend?: string };
    };

    expect(result.completed).toBe(true);
    expect(config.web?.searchBackend).toBe("ddgs");
    expect(installSpy).toHaveBeenCalledWith({
      stateRoot: expect.stringContaining(".estacoda"),
      capabilityId: DDGS_CAPABILITY_ID,
    });
    expect(JSON.stringify(result.reviewManifest)).toContain(DDGS_CAPABILITY_ID);
    expect(JSON.stringify(result.reviewManifest)).not.toContain("ddgs==9.14.4");
  });

  it("renders broken config as a repair-first diagnostic surface", async () => {
    await mkdir(dirname(profileConfigPath(tempDir)), { recursive: true });
    await writeFile(profileConfigPath(tempDir), "{not-json", "utf8");
    const output: string[] = [];
    const selectInputs: SelectPromptInput<unknown>[] = [];
    const prompt = fakePrompt({ values: ["show-diagnostics"] });
    const baseSelect = prompt.select!;
    prompt.select = async (input) => {
      selectInputs.push(input as SelectPromptInput<unknown>);
      return baseSelect(input);
    };

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt,
      output: { write: (value) => output.push(value) },
    });

    expect(result.completed).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.initialDecision.kind).toBe("repair-first-menu");
    expect(result.initialDecision.state.kind).toBe("broken-config");
    expect(result.initialDecision.setupEditorPlanSession?.metadata.mode).toBe("repair-first");
    expect(output.join("")).toContain("Setup Editor");
    expect(output.join("")).toContain("Available actions:");
    expect(output.join("")).not.toContain("محرّر الإعدادات");
    expect(result.output).toContain("Setup diagnostics");
    expect(result.output).toContain("State: broken-config");
    expect(result.output).toContain(profileConfigPath(tempDir));
    expect(result.output).toContain("Error:");
    expect(result.output).toContain("Normal config edits are blocked until the config file can be parsed.");
    expect(result.output).toContain("Only diagnostics, verification, and exit are available");
    expect(output.join("")).toContain("verify-setup - Setup verification");
    expect(output.join("")).toContain("show-diagnostics - Diagnostics");
    expect(output.join("")).toContain("exit - Exit without changes");
    expect(output.join("")).not.toContain("edit-primary-model-route");
    expect(output.join("")).not.toContain("edit-security-mode");
    expect(output.join("")).not.toContain("repair-state-directory");
    const menuInput = selectInputs[0];
    expect(menuInput?.options.map((option) =>
      typeof option.value === "object" && option.value !== null && "id" in option.value ? option.value.id : option.id
    )).toEqual(["verify-setup", "show-diagnostics", "exit"]);
    expect(menuInput?.options.find((option) => option.id === "verify-setup")?.group).toBeUndefined();
    expect(menuInput?.options.find((option) => option.id === "show-diagnostics")?.group).toBeUndefined();
    expect(menuInput?.options.find((option) => option.id === "exit")?.group).toBe("navigation");
  });

  it("renders state-not-writable as a repair-first diagnostic surface", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    await trustWorkspace(tempDir, workspaceRoot);
    await chmod(join(tempDir, ".estacoda"), 0o500);

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt(),
      defaultActionId: "show-diagnostics",
    });

    expect(result.completed).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.initialDecision.kind).toBe("repair-first-menu");
    expect(result.initialDecision.state.kind).toBe("state-not-writable");
    expect(result.initialDecision.setupEditorPlanSession?.metadata.mode).toBe("repair-first");
    expect(result.output).toContain("State: state-not-writable");
    expect(result.output).toContain(profileConfigPath(tempDir));
    expect(result.output).toContain("not writable");
    expect(result.output).toContain("write permission");
    expect(result.output).toContain("Restore write permission");
    expect(result.output).toContain("read-only verification again");
    expect(result.output).toContain("Normal writes are blocked until the state/config path is writable.");
    expect(result.output).toContain("Only diagnostics, verification, and exit are available");
    expect(result.output).not.toContain("Config cannot be edited normally until it can be parsed safely");
    expect(result.output).not.toContain("parse safety");
    expect(result.output).not.toContain("config parse failure");
    expect(result.initialDecision.setupEditorPlanSession?.plan.safeForNormalConfigEditing).toBe(false);
    expect(result.initialDecision.setupEditorPlanSession?.plan.actions.some((action) => action.patch !== undefined)).toBe(false);
  });
});

describe("setupEditorReviewSelectedAreaLabel", () => {
  it("preserves existing English selected area labels", () => {
    expect(setupEditorReviewSelectedAreaLabel("configure-channels", minimalManifest(["channels.telegram"]))).toBe("Channels · Telegram");
    expect(setupEditorReviewSelectedAreaLabel("edit-security-mode", minimalManifest())).toBe("Security");
  });

  it("localizes Arabic selected area labels while isolating technical channel names", () => {
    expect(setupEditorReviewSelectedAreaLabel("configure-channels", minimalManifest(["channels.telegram"]), "ar")).toBe(
      `القنوات · ${isolateLtr("Telegram")}`
    );
    expect(setupEditorReviewSelectedAreaLabel("edit-primary-model-route", minimalManifest(), "ar")).toBe("النموذج · الأساسي");
    expect(setupEditorReviewSelectedAreaLabel("edit-security-mode", minimalManifest(), "ar")).toBe("الأمان");
  });
});

function minimalManifest(sourceBundleIds: readonly string[] = []): SetupReviewManifest {
  return {
    kind: "setup-review-manifest",
    sourceBundleIds,
    lines: [],
    sections: {
      "files-to-write-update": [],
      "secret-refs-to-store": [],
      "workspace-trust-grants": [],
      "provider-model-network": [],
      "enabled-optional-capabilities": [],
      "remote-control-surfaces": [],
      "security-mode": [],
      "workflow-learning": [],
      "verification-checks": [],
      "launch-handoff": [],
      blockers: [],
      warnings: [],
    },
    blockers: [],
    warnings: [],
    safeToReviewForApply: true,
    suppressedNormalWrites: [],
    metadata: {
      bundleCount: sourceBundleIds.length,
      lineCount: 0,
      blockerCount: 0,
      warningCount: 0,
      readOnlyCount: 0,
    },
  };
}

function fakePrompt(options: { readonly values?: readonly unknown[]; readonly secret?: string | readonly string[] } = {}): Prompt {
  const values = [...(options.values ?? [])];
  const secretValues = Array.isArray(options.secret) ? [...options.secret] : undefined;
  const prompt = (async (_question: string, promptOptions?: { secret?: boolean }) => {
    if (promptOptions?.secret === true) return secretValues?.shift() ?? (typeof options.secret === "string" ? options.secret : "");
    const next = values.shift();
    return next === undefined ? "" : String(next);
  }) as Prompt;
  prompt.select = async (input) => {
    const next = values.shift();
    if (next !== undefined) {
      const match = input.options.find((option) =>
        Object.is(option.value, next) ||
        option.label === next ||
        (typeof option.value === "object" && option.value !== null && "id" in option.value && option.value.id === next)
      );
      if (match !== undefined) return match.value;
    }
    return input.options[input.defaultIndex ?? 0]?.value ?? input.options[0]!.value;
  };
  prompt.onboardingCard = () => undefined;
  prompt.close = () => undefined;
  return prompt;
}

function captureSelectInputs(prompt: Prompt): SelectPromptInput<unknown>[] {
  const selectInputs: SelectPromptInput<unknown>[] = [];
  const baseSelect = prompt.select!;
  prompt.select = async (input) => {
    selectInputs.push(input as SelectPromptInput<unknown>);
    return baseSelect(input);
  };
  return selectInputs;
}

function readyDdgsStatus(homeDir: string): Awaited<ReturnType<typeof capabilityManager.checkManagedPythonCapabilityStatus>> {
  const stateRoot = join(homeDir, ".estacoda");
  const envPath = join(stateRoot, "python-capabilities", DDGS_CAPABILITY_ID);
  const pythonPath = join(envPath, "bin", "python");
  return {
    ok: true,
    status: "verified",
    capabilityId: DDGS_CAPABILITY_ID,
    version: "9.14.4",
    specHash: "hash",
    installedGroups: [],
    installedPackages: ["ddgs==9.14.4"],
    pythonPath,
    envPath,
    manifest: {
      id: DDGS_CAPABILITY_ID,
      version: "9.14.4",
      specHash: "hash",
      installedPackages: ["ddgs==9.14.4"],
      installedGroups: [],
      pythonPath,
      envPath,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      verifiedAt: "2026-01-01T00:00:00.000Z",
      status: "verified",
    },
  };
}

function readyDdgsInstallResult(homeDir: string): Awaited<ReturnType<typeof capabilityManager.installManagedPythonCapabilityEnvironment>> {
  const status = readyDdgsStatus(homeDir);
  if (!status.ok) throw new Error("expected ready status");
  return {
    ok: true,
    capabilityId: status.capabilityId,
    version: status.version,
    specHash: status.specHash,
    installedGroups: status.installedGroups,
    installedPackages: status.installedPackages,
    pythonPath: status.pythonPath,
    envPath: status.envPath,
    manifest: status.manifest,
  };
}

function whatsappDepsWithMissingBridge(options: { readonly installError?: unknown } = {}): WhatsAppSetupDependencies & {
  readonly installDependencies: ReturnType<typeof vi.fn>;
  readonly pairDevice: ReturnType<typeof vi.fn>;
} {
  return {
    getDependencyStatus: async () => ({
      bridgeDir: "/tmp/bridge",
      packagePresent: true,
      lockfilePresent: true,
      entrypointPresent: true,
      nodeModulesPresent: false,
      missing: ["node_modules"],
    }),
    installDependencies: vi.fn(async () => {
      if (options.installError !== undefined) throw options.installError;
    }),
    pairDevice: vi.fn<NonNullable<WhatsAppSetupDependencies["pairDevice"]>>(),
  };
}

function whatsappDepsWithInstalledBridge(options: {
  readonly pairDevice?: WhatsAppSetupDependencies["pairDevice"];
} = {}): WhatsAppSetupDependencies & { readonly pairDevice: ReturnType<typeof vi.fn> } {
  return {
    getDependencyStatus: async () => ({
      bridgeDir: "/tmp/bridge",
      packagePresent: true,
      lockfilePresent: true,
      entrypointPresent: true,
      nodeModulesPresent: true,
      missing: [],
    }),
    installDependencies: vi.fn(),
    pairDevice: vi.fn<NonNullable<WhatsAppSetupDependencies["pairDevice"]>>(options.pairDevice ?? successfulWhatsAppPairDevice()),
  };
}

function successfulWhatsAppPairDevice(qr = ""): (options: WhatsAppPairDeviceOptions) => Promise<{ ok: true }> {
  return async (options) => {
    if (qr.length > 0) options.output.write(qr);
    await mkdir(options.authDir, { recursive: true });
    await writeFile(join(options.authDir, "creds.json"), "{}\n", "utf8");
    return { ok: true };
  };
}

function trackingPrompt(options: { readonly values?: readonly unknown[]; readonly secret?: string } = {}): Prompt & {
  readonly secretPromptCount: () => number;
} {
  const base = fakePrompt(options);
  let secretPromptCount = 0;
  const prompt = (async (question: string, promptOptions?: { secret?: boolean }) => {
    if (promptOptions?.secret === true) {
      secretPromptCount += 1;
    }
    return base(question, promptOptions);
  }) as Prompt & { readonly secretPromptCount: () => number };
  prompt.select = base.select;
  prompt.onboardingCard = base.onboardingCard;
  prompt.close = base.close;
  Object.defineProperty(prompt, "secretPromptCount", {
    value: () => secretPromptCount,
  });
  return prompt;
}

function gatewayServiceActions(input: {
  readonly installedBefore?: boolean;
  readonly activeAfterInstall?: boolean;
} = {}): GatewayActivationServiceActions {
  const probe = vi.fn<GatewayActivationServiceActions["probe"]>();
  probe.mockResolvedValueOnce({
    kind: "systemd-user",
    installed: input.installedBefore === true,
    activeState: input.installedBefore === true ? "inactive" : undefined,
    profileId: "default",
  });
  probe.mockResolvedValue({
    kind: "systemd-user",
    installed: true,
    activeState: input.activeAfterInstall === true ? "active" : "inactive",
    profileId: "default",
  });
  return {
    probe,
    install: vi.fn<GatewayActivationServiceActions["install"]>().mockResolvedValue({
      ok: true,
      mode: "source",
    }),
    start: vi.fn<GatewayActivationServiceActions["start"]>().mockResolvedValue({
      ok: true,
    }),
  };
}

async function writeUserConfig(homeDir: string, config: unknown, profileId = "default"): Promise<void> {
  const configPath = profileConfigPath(homeDir, profileId);
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function profileConfigPath(homeDir: string, profileId = "default"): string {
  return resolveProfileStateHome({ homeDir, profileId }).configPath;
}

function profileEnvPath(homeDir: string, profileId = "default"): string {
  return resolveProfileStateHome({ homeDir, profileId }).envPath;
}

async function trustWorkspace(homeDir: string, workspaceRoot: string): Promise<void> {
  await new WorkspaceTrustStore({
    path: join(homeDir, ".estacoda", "trust.json"),
  }).grant(workspaceRoot, { label: "test" });
}

function localReadyConfig(modelId = "local-test-model"): Record<string, unknown> {
  return {
    model: {
      provider: "local",
      id: modelId,
    },
    providers: {
      local: {
        kind: "openai-compatible",
        baseUrl: "http://localhost:11434/v1",
        models: [modelId],
        enableNetwork: true,
      },
    },
  };
}

function hostedMissingCredentialConfig(envVarName: string): Record<string, unknown> {
  return {
    model: {
      provider: "openai",
      id: "gpt-5.5",
    },
    providers: {
      openai: {
        kind: "openai-compatible",
        baseUrl: "https://api.openai.com/v1",
        apiKeyEnv: envVarName,
        models: ["gpt-5.5"],
        enableNetwork: true,
      },
    },
  };
}

function readyVerification(configPath: string) {
  return {
    stateWritable: true,
    envFilePresent: true,
    envFileSecure: true,
    workspaceTrusted: true,
    securityModeLabel: "Adaptive",
    securityModeValue: "adaptive",
    skillAutonomyLabel: "Suggest",
    skillAutonomyValue: "suggest",
    providerDiagnostic: {
      status: "ready" as const,
      lines: ["Provider status: ready"],
      warnings: [],
    },
    toolStatus: "skipped" as const,
    configSources: [configPath],
    warnings: [],
    issueCodes: [],
  };
}

function degradedVerification(configPath: string) {
  return {
    ...readyVerification(configPath),
    providerDiagnostic: {
      status: "warning" as const,
      lines: ["Provider status: warning"],
      warnings: ["Configured model context window is below 64K tokens."],
    },
    warnings: ["Network inference is disabled for the selected hosted provider."],
    issueCodes: ["network-disabled"],
  };
}

function blockedVerification(configPath: string) {
  return {
    ...readyVerification(configPath),
    providerDiagnostic: {
      status: "blocked" as const,
      lines: ["Provider status: blocked"],
      warnings: ["Missing API key for OPENAI_API_KEY."],
    },
    warnings: ["Missing API key for OPENAI_API_KEY."],
    issueCodes: ["missing-api-key"],
  };
}

function flowEngine(options: {
  readonly credentialAction?: "none" | "reuse" | "collect";
  readonly envVarName?: string;
  readonly diagnostic?: string;
  readonly providers?: readonly ProviderId[];
} = {}): FlowEngine {
  const envVarName = options.envVarName ?? "OPENAI_API_KEY";
  const providers = options.providers ?? (["openai"] as const);
  return {
    listProviderCandidates: async () => providers.map((providerId) => ({
      id: providerId,
      displayName: displayNameForProvider(providerId),
      catalogOnly: false,
      configurable: true,
      runnable: true,
      modelsCount: 1,
      credentialReady: options.credentialAction === "reuse",
      baseUrl: baseUrlForProvider(providerId),
    })),
    listModelCandidates: async (providerId) => [modelCandidateForProvider(providerId)],
    resolveSelection: async (providerId, modelId) => {
      if (options.diagnostic !== undefined) {
        return {
          kind: "diagnostic" as const,
          provider: providerId,
          model: modelId,
          reason: options.diagnostic,
        };
      }
      const action = options.credentialAction ?? "collect";
      return {
        kind: "selected" as const,
        provider: providerId,
        model: modelId,
        baseUrl: baseUrlForProvider(providerId),
        apiMode: "custom_openai_compatible" as ProviderApiMode,
        authMethod: "api_key" as ProviderAuthMethod,
        credentialAction: action === "none"
          ? { kind: "none" as const }
          : action === "reuse"
            ? { kind: "reuse" as const, reference: `env:${envVarName}` as `env:${string}` }
            : { kind: "collect" as const, envVarName },
        profile: {
          id: modelId,
          provider: providerId,
          contextWindowTokens: 128000,
          supportsTools: true,
          supportsVision: true,
          supportsReasoning: true,
          supportsStructuredOutput: true,
          status: "stable",
        },
      };
    },
  };
}

function displayNameForProvider(providerId: ProviderId): string {
  return providerId === "anthropic" ? "Anthropic" : providerId === "kimi" ? "Kimi" : "OpenAI";
}

function baseUrlForProvider(providerId: ProviderId): string {
  if (providerId === "anthropic") return "https://api.anthropic.com/v1";
  if (providerId === "kimi") return "https://api.moonshot.ai/v1";
  return "https://api.openai.com/v1";
}

function modelCandidateForProvider(providerId: ProviderId) {
  const id = providerId === "anthropic"
    ? "claude-sonnet-4-5"
    : providerId === "kimi"
      ? "kimi-k2"
      : "gpt-5.5";
  return {
    id,
    provider: providerId,
    configured: true,
    executable: true,
    catalogOnly: false,
    supportsVision: true,
    lifecycle: "available" as const,
    usageClass: "primary-chat" as const,
    profile: {
      id,
      provider: providerId,
      contextWindowTokens: 128000,
      supportsTools: true,
      supportsVision: true,
      supportsReasoning: true,
      supportsStructuredOutput: true,
      status: "stable" as const,
    },
  };
}
