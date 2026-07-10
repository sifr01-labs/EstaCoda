import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { PassThrough, Writable } from "node:stream";
import type { Prompt, PromptOptions } from "../../cli/prompt-contract.js";
import type { SelectPromptInput } from "../../cli/interactive-select.js";
import { WorkspaceTrustStore } from "../../security/workspace-trust-store.js";
import type { ProviderId, ProviderApiMode, ProviderAuthMethod } from "../../contracts/provider.js";
import type { FlowEngine } from "../../providers/provider-model-selection-flow.js";
import { createReviewedSetupApplyExecutor } from "../review/apply-executor.js";
import { __decideConfigEditorLoopForTest, __reviewAndApplyResolvedRouteForTest, runConfigEditor } from "./runner.js";
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
import type { SetupEditorActionDraft } from "../setup-editor-actions.js";
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
    delete process.env.VOICE_TOOLS_OPENAI_KEY;
    delete process.env.OPENAI_API_KEY;
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
    expect(output.join("")).toContain("run-doctor - EstaCoda Doctor");
    expect(output.join("")).not.toContain("verify-setup - Setup verification");
    expect(output.join("")).not.toContain("show-diagnostics - Diagnostics");
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
      tableDirection: SelectPromptInput<unknown>["tableDirection"];
      tableWidth: SelectPromptInput<unknown>["tableWidth"];
      tableMaxWidth: SelectPromptInput<unknown>["tableMaxWidth"];
      tableAlign: SelectPromptInput<unknown>["tableAlign"];
      showColumnHeaders: SelectPromptInput<unknown>["showColumnHeaders"];
      statusLines: SelectPromptInput<unknown>["statusLines"];
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
        tableDirection: input.tableDirection,
        tableWidth: input.tableWidth,
        tableMaxWidth: input.tableMaxWidth,
        tableAlign: input.tableAlign,
        showColumnHeaders: input.showColumnHeaders,
        statusLines: input.statusLines,
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
      { key: "description", header: "التفاصيل", align: "left" },
      { key: "name", header: "الاسم", align: "right" },
    ]);
    expect(prompts[0]?.tableDirection).toBe("rtl");
    expect(prompts[0]?.tableWidth).toBe("content");
    expect(prompts[0]?.tableMaxWidth).toBe(88);
    expect(prompts[0]?.tableAlign).toBe("right");
    expect(prompts[0]?.showColumnHeaders).toBe(false);
    expect(prompts[0]?.statusLines).toBeUndefined();
    expect(prompts[0]?.hint).toBe("↑↓ navigate   ENTER select   CTRL+C exit");
    expect(prompts[0]?.labels).toContain("النموذج الأساسي");
    expect(prompts[0]?.descriptions).toContain("النموذج الافتراضي الذي يستخدمه الوكيل.");
    expect(prompts[0]?.labels).toContain("القنوات");
    expect(prompts[0]?.descriptions).toContain(resolveSetupCopy("ar", "setupEditor.actions.configureChannels.description"));
    expect(prompts[0]?.labels).toContain(resolveSetupCopy("ar", "setupEditor.actions.runDoctor"));
    expect(prompts[0]?.descriptions).toContain("افحص حالة الإعداد واعرض الإصلاحات المطلوبة.");
    expect(prompts[0]?.labels).not.toContain("التحقق من الإعداد");
    expect(prompts[0]?.labels).not.toContain("التشخيصات");
    expect(prompts[0]?.labels).toContain("الخروج دون تغييرات");
    expect(prompts[0]?.descriptions).toContain("غادر الإعداد دون تعديل التكوين.");
    expect(prompts[0]?.labels).not.toContain("مزوّد مخصص متوافق مع OpenAI");
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
      "run-doctor",
      "exit",
    ]);
    const exitActionIndex = prompts[0]?.labels.indexOf("الخروج دون تغييرات") ?? -1;
    expect(prompts[0]?.groups[exitActionIndex]).toBe("navigation");
    expect(prompts[0]?.labels).toContain(resolveSetupCopy("ar", "setupEditor.actions.runDoctor"));
    expect(prompts[0]?.descriptions).toContain("افحص حالة الإعداد واعرض الإصلاحات المطلوبة.");
    expect(prompts[0]?.labels).not.toContain("التحقق من الإعداد");
    expect(prompts[0]?.labels).not.toContain("التشخيصات");
    expect(prompts[0]?.groups[prompts[0]?.labels.indexOf(resolveSetupCopy("ar", "setupEditor.actions.runDoctor")) ?? -1]).toBeUndefined();
  });

  it("routes setup editor action selection through setup console when provided", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    await trustWorkspace(tempDir, workspaceRoot);
    const output: string[] = [];
    const input = createTtyInput();
    const setupOutput = createTtyOutput();
    const prompt = fakePrompt();
    const select = vi.fn(async () => {
      throw new Error("base prompt select should not run for setup console action selection");
    });
    prompt.select = select;

    const pending = runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt,
      setupConsole: { input, output: setupOutput },
      applyExecutor: createReviewedSetupApplyExecutor({
        homeDir: tempDir,
        workspaceRoot,
      }),
      renderInitialOverview: false,
      output: { write: (value) => output.push(value) },
    });
    await Promise.resolve();
    input.write("\x1b[F\r");
    const result = await pending;
    const liveText = stripAnsi(setupOutput.text());

    expect(result.completed).toBe(true);
    expect(result.selectedActionId).toBe("exit");
    expect(select).not.toHaveBeenCalled();
    expect(liveText).toContain("Setup Editor");
    expect(liveText).not.toContain("No changes applied");
    expect(liveText).not.toContain("Workspace: trusted");
    expect(liveText).not.toContain("Profile: default");
    expect(liveText).not.toContain("Current: local/local-test-model");
    expect(liveText).toContain("Exit without changes");
    expect(liveText).not.toContain("Selected:");
    expect(setupOutput.text()).not.toMatch(/\x1b\[3J|\x1b\[2J|\x1b\[H|\x1b\[\d+;\d+H/u);
    expect(output.join("")).toContain("Exited setup editor without applying changes.");
  });

  it("routes provider Back through setup console and returns to the setup menu in place", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    await trustWorkspace(tempDir, workspaceRoot);
    const output: string[] = [];
    const input = createTtyInput();
    const setupOutput = createTtyOutput();
    const prompt = fakePrompt();
    const select = vi.fn(async () => {
      throw new Error("base prompt select should not run for setup console route cards");
    });
    prompt.select = select;

    const pending = runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt,
      setupConsole: { input, output: setupOutput },
      defaultActionId: "edit-primary-model-route",
      flowEngine: flowEngine({ credentialAction: "collect", envVarName: "PR8_OPENAI_KEY" }),
      output: { write: (value) => output.push(value) },
    });
    await Promise.resolve();
    input.write("\x1b[F\x1b[A\r");
    await vi.waitFor(() => {
      expect(stripAnsi(setupOutput.text())).toContain("Setup Editor");
    });
    input.write("\x1b[F\r");

    const result = await pending;
    const liveText = stripAnsi(setupOutput.text());

    expect(result.completed).toBe(true);
    expect(result.selectedActionId).toBe("exit");
    expect(select).not.toHaveBeenCalled();
    expect(liveText).toContain("Primary Provider");
    expect(liveText).toContain("Back");
    expect(liveText).toContain("Setup Editor");
    expect(liveText).toContain("Exit without changes");
    expect(liveText).not.toContain("Selected:");
    expect(setupOutput.text()).not.toMatch(/\x1b\[3J|\x1b\[2J|\x1b\[H|\x1b\[\d+;\d+H/u);
    await expect(readFile(profileConfigPath(tempDir), "utf8")).resolves.toContain("\"provider\": \"local\"");
  });

  it("routes review confirmation cards through setup console without columns", async () => {
    await writeUserConfig(tempDir, {
      ...localReadyConfig(),
      security: { approvalMode: "adaptive" },
    });
    await trustWorkspace(tempDir, workspaceRoot);
    const output: string[] = [];
    const input = createTtyInput();
    const setupOutput = createTtyOutput();
    const prompt = fakePrompt();
    const select = vi.fn(async () => {
      throw new Error("base prompt select should not run for setup console review cards");
    });
    prompt.select = select;

    const pending = runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt,
      setupConsole: { input, output: setupOutput },
      defaultActionId: "edit-security-mode",
      applyExecutor: createReviewedSetupApplyExecutor({
        homeDir: tempDir,
        workspaceRoot,
      }),
      output: { write: (value) => output.push(value) },
    });
    await vi.waitFor(() => {
      expect(stripAnsi(setupOutput.text())).toContain("Security Mode");
    });
    input.write("\x1b[H\r");
    await vi.waitFor(() => {
      expect(stripAnsi(setupOutput.text())).toContain("Finalize Configuration");
    });
    input.write("\r");

    const result = await pending;
    const liveText = stripAnsi(setupOutput.text());
    const config = JSON.parse(await readFile(profileConfigPath(tempDir), "utf8")) as {
      security?: { approvalMode?: string };
    };

    expect(result.completed).toBe(true);
    expect(result.selectedActionId).toBe("edit-security-mode");
    expect(select).not.toHaveBeenCalled();
    expect(liveText).toContain("Security Mode");
    expect(liveText).toContain("Finalize Configuration");
    expect(liveText).toContain("Pending changes: Security");
    expect(liveText).toContain("Confirm");
    expect(liveText).not.toContain("Selected:");
    expect(setupOutput.text()).not.toMatch(/\x1b\[3J|\x1b\[2J|\x1b\[H|\x1b\[\d+;\d+H/u);
    expect(config.security?.approvalMode).toBe("strict");
  });

  it("routes the legacy read-only verification alias to Doctor", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    await trustWorkspace(tempDir, workspaceRoot);
    const output: string[] = [];
    const input = createTtyInput();
    const setupOutput = createTtyOutput();

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt(),
      setupConsole: { input, output: setupOutput },
      defaultActionId: "run-readonly-verification",
      renderInitialOverview: false,
      output: { write: (value) => output.push(value) },
    });
    const liveText = stripAnsi(setupOutput.text());

    expect(result.completed).toBe(true);
    expect(result.selectedActionId).toBe("run-doctor");
    expect(result.finalDecision).toBeUndefined();
    expect(result.setupConsoleRenderedOutput).toBeUndefined();
    expect(result.output).toContain("EstaCoda Doctor");
    expect(result.output).toContain("System health inspection");
    expect(output.join("")).toContain("EstaCoda Doctor");
    expect(liveText).not.toContain("EstaCoda Verify");
    expect(liveText).not.toContain("Selected:");
    expect(setupOutput.text()).not.toMatch(/\x1b\[3J|\x1b\[2J|\x1b\[H|\x1b\[\d+;\d+H/u);
  });

  it("runs doctor from the setup editor", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    await trustWorkspace(tempDir, workspaceRoot);
    const output: string[] = [];

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt(),
      defaultActionId: "run-doctor",
      renderInitialOverview: false,
      output: { write: (value) => output.push(value) },
    });

    expect(result.completed).toBe(true);
    expect(result.selectedActionId).toBe("run-doctor");
    expect(result.setupConsoleRenderedOutput).toBeUndefined();
    expect(result.output).toContain("EstaCoda Doctor");
    expect(result.output).toContain("System health inspection");
    expect(output.join("")).toContain("EstaCoda Doctor");
    expect(output.join("")).toContain("System health inspection");
  });

  it("routes setup credential entry through masked setup console secret panel", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    await trustWorkspace(tempDir, workspaceRoot);
    const output: string[] = [];
    const input = createTtyInput();
    const setupOutput = createTtyOutput();
    const rawSecret = "sk-live-setup-console-secret";
    const select = vi.fn(async () => {
      throw new Error("base prompt select should not run for setup console credential flow");
    });
    const prompt = Object.assign(
      async (_question: string, promptOptions?: { secret?: boolean }) => {
        if (promptOptions?.secret === true) {
          throw new Error("base secret prompt should not run for setup console credential flow");
        }
        return "";
      },
      {
        uiContext: { locale: "en" as const, direction: "ltr" as const },
        select,
      }
    ) as Prompt;

    const pending = runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt,
      setupConsole: { input, output: setupOutput },
      defaultActionId: "edit-primary-model-route",
      flowEngine: flowEngine({ credentialAction: "collect", envVarName: "PR8_CONSOLE_KEY" }),
      applyExecutor: createReviewedSetupApplyExecutor({
        homeDir: tempDir,
        workspaceRoot,
      }),
      output: { write: (value) => output.push(value) },
    });

    await vi.waitFor(() => {
      expect(stripAnsi(setupOutput.text())).toContain("Primary Provider");
    });
    input.write("\r");
    await vi.waitFor(() => {
      expect(stripAnsi(setupOutput.text())).toContain("OpenAI Setup");
    });
    input.write("\r");
    await vi.waitFor(() => {
      expect(stripAnsi(setupOutput.text())).toContain("Primary Model");
    });
    input.write("\r");
    await vi.waitFor(() => {
      expect(stripAnsi(setupOutput.text())).toContain("API Key");
    });
    input.write(`${rawSecret}\r`);
    await vi.waitFor(() => {
      expect(stripAnsi(setupOutput.text())).toContain("Finalize Configuration");
    });
    input.write("\r");

    const result = await pending;
    const liveText = stripAnsi(setupOutput.text());
    const envFile = await readFile(profileEnvPath(tempDir), "utf8");

    expect(result.completed).toBe(true);
    expect(result.selectedActionId).toBe("edit-primary-model-route");
    expect(select).not.toHaveBeenCalled();
    expect(envFile).toContain(`PR8_CONSOLE_KEY="${rawSecret}"`);
    expect(liveText).toContain("API Key");
    expect(liveText).toContain("••••••••");
    expect(liveText).not.toContain(rawSecret);
    expect(output.join("")).not.toContain(rawSecret);
    expect(JSON.stringify(result)).not.toContain(rawSecret);
    expect(setupOutput.text()).not.toMatch(/\x1b\[3J|\x1b\[2J|\x1b\[H|\x1b\[\d+;\d+H/u);
  });

  it("does not persist typed setup-console secret text when secret entry is cancelled", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    await trustWorkspace(tempDir, workspaceRoot);
    const output: string[] = [];
    const input = createTtyInput();
    const setupOutput = createTtyOutput();
    const cancelledSecret = "sk-cancelled-console-secret";
    const prompt = Object.assign(
      async (_question: string, promptOptions?: { secret?: boolean }) => {
        if (promptOptions?.secret === true) {
          throw new Error("base secret prompt should not run for setup console credential flow");
        }
        return "";
      },
      {
        uiContext: { locale: "en" as const, direction: "ltr" as const },
        select: vi.fn(async () => {
          throw new Error("base prompt select should not run for setup console credential flow");
        }),
      }
    ) as Prompt;

    const pending = runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt,
      setupConsole: { input, output: setupOutput },
      defaultActionId: "edit-primary-model-route",
      flowEngine: flowEngine({ credentialAction: "collect", envVarName: "PR8_CANCELLED_CONSOLE_KEY" }),
      applyExecutor: createReviewedSetupApplyExecutor({
        homeDir: tempDir,
        workspaceRoot,
        collectVerification: () => readyVerification(profileConfigPath(tempDir)),
      }),
      output: { write: (value) => output.push(value) },
    });

    await vi.waitFor(() => {
      expect(stripAnsi(setupOutput.text())).toContain("Primary Provider");
    });
    input.write("\r");
    await vi.waitFor(() => {
      expect(stripAnsi(setupOutput.text())).toContain("OpenAI Setup");
    });
    input.write("\r");
    await vi.waitFor(() => {
      expect(stripAnsi(setupOutput.text())).toContain("Primary Model");
    });
    input.write("\r");
    await vi.waitFor(() => {
      expect(stripAnsi(setupOutput.text())).toContain("API Key");
    });
    input.write(`${cancelledSecret}\x1b`);
    await vi.waitFor(() => {
      expect(stripAnsi(setupOutput.text())).toContain("Finalize Configuration");
    });
    input.write("\r");

    const result = await pending;
    const liveText = stripAnsi(setupOutput.text());
    const envFile = await readFile(profileEnvPath(tempDir), "utf8").catch(() => "");

    expect(result.completed).toBe(true);
    expect(result.selectedActionId).toBe("edit-primary-model-route");
    expect(envFile).not.toContain(cancelledSecret);
    expect(envFile).not.toContain("PR8_CANCELLED_CONSOLE_KEY");
    expect(liveText).not.toContain(cancelledSecret);
    expect(output.join("")).not.toContain(cancelledSecret);
    expect(JSON.stringify(result)).not.toContain(cancelledSecret);
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
        "local",
        "fal",
        "fal-ai/flux-2/klein/9b",
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
      "Vision and Image Generation",
      "Image model",
      "Browser",
      "Voice",
      "WhatsApp beta",
      "Telegram",
    ]);
    expect(selectInputs.find((input) => input.title === "Setup editor")?.bodyLineStyles).toEqual([
      { emphasis: "strong" },
    ]);
    for (const input of selectInputs.filter((item) => item.columns !== undefined)) {
      expect(input.columns).toEqual([
        { key: "name", header: "Name", align: "left" },
        { key: "description", header: "Details", align: "left" },
      ]);
      expect(input.tableDirection).toBe("ltr");
      expect(input.tableWidth).toBe("full");
      expect(input.tableMaxWidth).toBeUndefined();
      expect(input.tableAlign).toBeUndefined();
      expect(input.showColumnHeaders).toBe(false);
      expect(input.options.every((option) => option.cells === undefined)).toBe(true);
    }
    const webSearchInput = selectInputs.find((input) =>
      input.options.some((option) => option.id === "web-search-none")
    );
    const browserModeInput = selectInputs.find((input) =>
      input.options.some((option) => option.id === "browser-disabled")
    );
    const imageProviderInput = selectInputs.find((input) =>
      input.options.some((option) => option.id === "byteplus")
    );
    const imageModelInput = selectInputs.find((input) =>
      input.options.some((option) => option.id === "image-model-fal-ai/flux-2/klein/9b")
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
    expect(imageProviderInput?.body).toBe("Pick the provider to use for image generation and image editing, when supported. This is separate from the primary chat model.");
    expect(imageProviderInput?.options.find((option) => option.id === "fal")?.label).toBe("fal.ai");
    expect(imageProviderInput?.options.find((option) => option.id === "fal")?.description).toBe(
      "Access a variety of image generation and editing models through fal.ai."
    );
    expect(imageProviderInput?.options.find((option) => option.id === "byteplus")?.label).toBe("BytePlus / ModelArk");
    expect(imageProviderInput?.options.find((option) => option.id === "byteplus")?.description).toBe(
      "Use BytePlus Seedream image models. Requires an Ark API key."
    );
    expect(imageProviderInput?.options.find((option) => option.id === "openai")?.label).toBe("OpenAI");
    expect(imageProviderInput?.options.find((option) => option.id === "openai")?.description).toBe(
      "Use OpenAI GPT Image models. Requires an OpenAI API key."
    );
    expect(imageModelInput?.body).toBe("Choose the fal.ai image model for generation and editing, when supported.");
    expect(imageModelInput?.options.find((option) => option.id === "image-model-fal-ai/flux-2/klein/9b")?.description).toBe(
      "Fast default FAL model with crisp text rendering."
    );
    expect(optionalActionInput?.options.find((option) => option.id === "voice-enable")?.group).toBeUndefined();
    expect(optionalActionInput?.options.find((option) => option.id === "voice-unchanged")?.group).toBe("navigation");
    expect(optionalActionInput?.options.find((option) => option.id === "voice-skip")?.group).toBe("navigation");
    expect(incompleteChannelInput?.options.every((option) => option.group === "navigation")).toBe(true);
    expect(incompleteTelegramInput?.options.every((option) => option.group === "navigation")).toBe(true);
    expect(selectInputs.some((input) =>
      input.title === "Image generation" &&
      input.options.some((option) => option.id === "gateway-no" || option.id === "gateway-yes")
    )).toBe(false);
  });

  it("shows Telegram remote-control guidance on the optional capability action card", async () => {
    const prompt = fakePrompt({ values: ["unchanged"] });
    const selectInputs = captureSelectInputs(prompt);

    const optionalAction = await promptOptionalCapabilityAction(prompt, {
      id: "telegram",
      title: "Telegram/channels",
      configured: false,
    });

    expect(optionalAction).toBe("unchanged");
    expect(selectInputs[0]?.title).toBe("Telegram/channels");
    expect(selectInputs[0]?.body).toContain("Telegram gives EstaCoda a remote command channel.");
    expect(selectInputs[0]?.body).toContain("restrict access to the users or chats you actually trust");
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
    expect(vision.useGateway).toBe(false);

    const languageInput = selectInputs.find((input) => input.title === "Setup language");
    expect(languageInput?.columns).toBeUndefined();
    expect(languageInput?.hint).toBe("↑↓ navigate   ENTER select   CTRL+C exit");
    expect(languageInput?.options.map((option) => option.label)).toEqual([
      "English",
      "العربية",
    ]);
    expect(languageInput?.options.map((option) => option.description)).toEqual([
      undefined,
      undefined,
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
    expect(selectInputs.some((input) =>
      input.title === "Image generation" &&
      input.options.some((option) => option.id === "gateway-no" || option.id === "gateway-yes")
    )).toBe(false);
    expect(languageInput?.statusLines).toBeUndefined();
    const trustInput = selectInputs.find((input) => input.title === "Workspace trust");
    const reviewInput = selectInputs.find((input) => input.title === "Finalize configuration");
    const postApplyInput = selectInputs.find((input) => input.title === "Setup next action");
    const autoLaunchInput = selectInputs.find((input) => input.title === "Local supervised browser");
    expect(trustInput?.options.find((option) => option.id === "trust")?.group).toBeUndefined();
    expect(trustInput?.options.find((option) => option.id === "cancel")?.group).toBe("navigation");
    expect(reviewInput?.options.find((option) => option.id === "approve")?.group).toBeUndefined();
    expect(reviewInput?.options.find((option) => option.id === "cancel")?.group).toBe("navigation");
    expect(reviewInput?.statusLines).toEqual([
      { text: "Pending changes: Security", tone: "warning", direction: "ltr" },
    ]);
    expect(postApplyInput?.options.find((option) => option.id === "exit")?.group).toBe("navigation");
    expect(autoLaunchInput?.options.find((option) => option.id === "browser-auto-launch-no")?.group).toBeUndefined();
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
    expect(securityInput?.columns).toEqual([
      { key: "name", header: "Name", align: "left" },
      { key: "description", header: "Details", align: "left" },
    ]);
    expect(securityInput?.showCurrentBadge).toBe(false);
    expect(securityInput?.defaultIndex).toBe(0);
    expect(securityInput?.options.find((option) => option.id === "strict")?.current).toBe(true);
    expect(workflowInput?.statusLines).toEqual([{ text: "Current: Proactive", tone: "active", direction: "ltr" }]);
    expect(workflowInput?.columns).toEqual([
      { key: "name", header: "Name", align: "left" },
      { key: "description", header: "Details", align: "left" },
    ]);
    expect(workflowInput?.showCurrentBadge).toBe(false);
    expect(workflowInput?.options.map((option) => option.id)).toEqual([
      "suggest",
      "proactive",
      "autonomous",
      "none",
    ]);
    expect(workflowInput?.defaultIndex).toBe(1);
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
    });
    await promptSttCapability(prompt, {
      sttProvider: "local",
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
    const visionInput = selectInputs.find((input) => input.title === "Vision and Image Generation");
    const browserInput = selectInputs.find((input) => input.title === "Browser");
    const allStatusText = selectInputs.flatMap((input) => input.statusLines ?? []).map((line) => line.text).join("\n");

    expect(searchInput?.statusLines).toEqual([{ text: "Current: Brave Search", tone: "active", direction: "ltr" }]);
    expect(searchInput?.defaultIndex).toBe(0);
    expect(searchInput?.options.find((option) => option.id === "web-search-brave")?.current).toBe(true);
    expect(voiceInputs[0]?.statusLines).toEqual([{ text: "Current: openai", tone: "active", direction: "ltr" }]);
    expect(voiceInputs[0]?.options.find((option) => option.id === "tts-openai")?.current).toBe(true);
    expect(voiceInputs[1]?.statusLines).toEqual([{ text: "Current: local", tone: "active", direction: "ltr" }]);
    expect(voiceInputs[1]?.options.find((option) => option.id === "stt-local")?.current).toBe(true);
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

  it("uses compact right-aligned Arabic setup table layout for web search provider choices", async () => {
    const prompt = fakePrompt();
    const selectInputs = captureSelectInputs(prompt);

    const webSearch = await promptWebSearchCapability(prompt, { ddgsCapabilityStatus: "missing" }, "ar");

    const searchInput = selectInputs.find((input) =>
      input.options.some((option) => option.id === "web-search-none")
    );
    expect(webSearch).toEqual({ provider: "none" });
    expect(searchInput?.columns).toEqual([
      { key: "description", header: "التفاصيل", align: "left" },
      { key: "name", header: "الاسم", align: "right" },
    ]);
    expect(searchInput?.tableDirection).toBe("rtl");
    expect(searchInput?.tableWidth).toBe("content");
    expect(searchInput?.tableMaxWidth).toBe(88);
    expect(searchInput?.tableAlign).toBe("right");
    expect(searchInput?.showColumnHeaders).toBe(false);
    expect(searchInput?.hint).toBe("↑↓ navigate   ENTER select   CTRL+C exit");
    expect(searchInput?.options.find((option) => option.id === "web-search-none")?.group).toBeUndefined();
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

  it("routes direct read-only verification selections to Doctor", async () => {
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
    expect(result.selectedActionId).toBe("run-doctor");
    expect(result.finalDecision).toBeUndefined();
    expect(result.output).toContain("EstaCoda Doctor");
    expect(result.output).toContain("System health inspection");
  });

  it("runs doctor for configured states without requiring a repair route action", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    await trustWorkspace(tempDir, workspaceRoot);

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt(),
      defaultActionId: "run-doctor",
    });

    expect(result.completed).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.initialDecision.kind).toBe("configured-menu");
    expect(result.selectedActionId).toBe("run-doctor");
    expect(result.output).toContain("EstaCoda Doctor");
    expect(result.output).toContain("System health inspection");
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
        collectVerification: () => readyVerification(profileConfigPath(tempDir)),
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
        collectVerification: () => readyVerification(profileConfigPath(tempDir)),
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

  it("returns from browser mode Back to the setup editor without an optional action card", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
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
      defaultActionId: "configure-browser",
      applyExecutor: { apply },
    });

    expect(result.completed).toBe(true);
    expect(result.selectedActionId).toBe("exit");
    expect(result.reviewManifest).toBeUndefined();
    expect(apply).not.toHaveBeenCalled();
    expect(promptTitles).toEqual(["Browser", "Setup editor"]);
  });

  it("returns from web search provider Back to the setup editor without drafting", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    await trustWorkspace(tempDir, workspaceRoot);
    const before = await readFile(profileConfigPath(tempDir), "utf8");
    const selectInputs: SelectPromptInput<unknown>[] = [];
    const prompt = fakePrompt({ values: ["Back", "exit"] });
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
    expect(selectInputs.map((input) => input.title)).toEqual(["Search provider", "Setup editor"]);
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
    const prompt = fakePrompt({ values: ["ddgs", "Back", "Back", "exit"] });
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
    const prompt = fakePrompt({ values: ["Back", "exit"] });
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
      "Vision and Image Generation",
      "Setup editor",
    ]);
  });

  it("returns from image generation model Back to provider selection", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    await trustWorkspace(tempDir, workspaceRoot);
    const before = await readFile(profileConfigPath(tempDir), "utf8");
    const selectInputs: SelectPromptInput<unknown>[] = [];
    const prompt = fakePrompt({ values: ["fal", "Back", "Back", "exit"] });
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

    expect(result.completed).toBe(true);
    expect(result.selectedActionId).toBe("exit");
    expect(result.reviewManifest).toBeUndefined();
    expect(apply).not.toHaveBeenCalled();
    await expect(readFile(profileConfigPath(tempDir), "utf8")).resolves.toBe(before);
    expect(selectInputs.map((input) => input.title)).toEqual([
      "Vision and Image Generation",
      "Image model",
      "Vision and Image Generation",
      "Setup editor",
    ]);
  });

  it("returns from STT provider Back to voice mode", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    await trustWorkspace(tempDir, workspaceRoot);
    const promptTitles: string[] = [];
    const prompt = fakePrompt({
      values: [
        "Speech to Text (STT)",
        "Configure",
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

    const prompt = fakePrompt({ values: ["OpenAI", "OpenAI Models", "gpt-5.5", true], secret: "sk-pr8-provider-route" });
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
    expect(routePrompts[0]?.options.find((option) => option.id === "openai")?.cells?.details).toBe("Frontier models for high-quality primary reasoning. Direct API.");
    expect(routePrompts[1]?.showCurrentBadge).toBe(false);
    expect(routePrompts[1]?.options.find((option) => option.id === "gpt-5.5")?.cells?.details).toContain("Tools | Vision | Reasoning");
    expect(envFile).toContain("PR8_OPENAI_KEY=");
    expect(rawConfig).not.toContain("sk-pr8-provider-route");
    expect(JSON.stringify(result)).not.toContain("sk-pr8-provider-route");
  });

  it("applies Codex OAuth primary route through the OpenAI sub-choice without API-key collection", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    await trustWorkspace(tempDir, workspaceRoot);

    const prompt = fakePrompt({ values: ["OpenAI", "Codex", true] });
    const selectInputs: SelectPromptInput<unknown>[] = [];
    const baseSelect = prompt.select!;
    prompt.select = async (input) => {
      if (input.title === "Primary provider" || input.title === "OpenAI setup") {
        selectInputs.push(input as SelectPromptInput<unknown>);
      }
      return baseSelect(input);
    };

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt,
      defaultActionId: "edit-primary-model-route",
      flowEngine: flowEngine({
        credentialAction: "oauth",
        oauthStatus: "ready",
        providers: ["openai", "codex"],
      }),
      applyExecutor: createReviewedSetupApplyExecutor({
        homeDir: tempDir,
        workspaceRoot,
        collectVerification: () => readyVerification(profileConfigPath(tempDir)),
      }),
    });
    const rawConfig = await readFile(profileConfigPath(tempDir), "utf8");
    const config = JSON.parse(rawConfig) as {
      model?: { provider?: string; id?: string; contextWindowTokens?: number };
      providers?: Record<string, { apiKeyEnv?: string; authMethod?: string; apiMode?: string; baseUrl?: string }>;
    };

    expect(result.completed).toBe(true);
    expect(result.selectedActionId).toBe("edit-primary-model-route");
    expect(selectInputs.map((input) => input.title)).toEqual(["Primary provider", "OpenAI setup"]);
    expect(selectInputs[0]?.options.map((option) => option.id)).not.toContain("codex");
    expect(selectInputs[1]?.options.map((option) => option.id)).toEqual(
      expect.arrayContaining(["openai-api-key", "codex-oauth"])
    );
    expect(result.reviewManifest?.sections["provider-model-network"][0]?.review.values).toEqual(expect.objectContaining({
      provider: "codex",
      model: "gpt-5.5",
      authMethod: "oauth_device_pkce",
      oauthCredentialStatus: "ready",
    }));
    expect(result.reviewManifest?.sections["secret-refs-to-store"][0]?.review.values).toEqual(expect.objectContaining({
      provider: "codex",
      credentialSurface: "oauth",
      authMethod: "oauth_device_pkce",
      oauthCredentialStatus: "ready",
    }));
    expect(config.model).toEqual({ provider: "codex", id: "gpt-5.5", contextWindowTokens: 128000 });
    expect(config.providers?.codex).toEqual(expect.objectContaining({
      apiMode: "custom_openai_compatible",
      authMethod: "oauth_device_pkce",
    }));
    expect(config.providers?.codex?.apiKeyEnv).toBeUndefined();
    expect(rawConfig).not.toContain("accessToken");
  });

  it("runs missing Codex OAuth through a live setup-editor device-code notice before reviewed apply", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    await trustWorkspace(tempDir, workspaceRoot);

    const prompt = trackingPrompt({ values: ["OpenAI", "Codex", "signin", true] });
    const selectInputs = captureSelectInputs(prompt);
    const cards: Array<Parameters<NonNullable<Prompt["onboardingCard"]>>[0]> = [];
    prompt.onboardingCard = (input) => {
      cards.push(input);
    };
    const calls: Array<{ readonly url: string; readonly body: string }> = [];
    const providerFetch = async (url: string, init: {
      readonly method: string;
      readonly headers: Record<string, string>;
      readonly body: string;
    }) => {
      calls.push({ url, body: init.body });
      if (url.endsWith("/api/accounts/deviceauth/usercode")) {
        return fetchResponse({
          user_code: "LIVE-CODE",
          device_auth_id: "device-auth-secret",
          interval: "0",
          expires_at: new Date(Date.now() + 900_000).toISOString(),
        });
      }
      if (url.endsWith("/api/accounts/deviceauth/token")) {
        return fetchResponse({
          authorization_code: "authorization-code-secret",
          code_verifier: "code-verifier-secret",
        });
      }
      if (url.endsWith("/oauth/token")) {
        return fetchResponse({
          access_token: "access-token-secret",
          refresh_token: "refresh-token-secret",
          expires_in: 3600,
          scope: "openid profile",
        });
      }
      return fetchResponse({ error: "unexpected" }, { ok: false, status: 404, statusText: "Not Found" });
    };

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt,
      defaultActionId: "edit-primary-model-route",
      flowEngine: flowEngine({
        credentialAction: "oauth",
        oauthStatus: "required",
        providers: ["openai", "codex"],
      }),
      providerFetch,
      applyExecutor: createReviewedSetupApplyExecutor({
        homeDir: tempDir,
        workspaceRoot,
        collectVerification: () => readyVerification(profileConfigPath(tempDir)),
      }),
    });
    const rawConfig = await readFile(profileConfigPath(tempDir), "utf8");
    const rawAuth = await readFile(profileAuthPath(tempDir), "utf8");
    const config = JSON.parse(rawConfig) as {
      model?: { provider?: string; id?: string };
      providers?: Record<string, { apiKeyEnv?: string; authMethod?: string; apiMode?: string }>;
    };

    expect(result.completed).toBe(true);
    expect(prompt.secretPromptCount()).toBe(0);
    expect(selectInputs.map((input) => input.title)).toEqual([
      "Primary provider",
      "OpenAI setup",
      "Codex OAuth",
      "Finalize configuration",
    ]);
    expect(selectInputs[2]?.options.map((option) => option.id)).toEqual([
      "codex-oauth-signin",
      "codex-oauth-cancel",
    ]);
    expect(cards.map((card) => card.title)).toEqual([
      "Codex OAuth",
      "Codex OAuth device authorization",
    ]);
    expect(cards[0]?.bodyLines).toContain("Requesting a Codex OAuth device code...");
    expect(cards[1]?.bodyLines).toContain("Open: https://auth.openai.com/codex/device");
    expect(cards[1]?.bodyLines).toContain("Code: LIVE-CODE");
    expect(config.model).toEqual(expect.objectContaining({ provider: "codex", id: "gpt-5.5" }));
    expect(config.providers?.codex).toEqual(expect.objectContaining({
      authMethod: "oauth_device_pkce",
    }));
    expect(config.providers?.codex?.apiKeyEnv).toBeUndefined();
    expect(rawAuth).toContain("access-token-secret");
    expect(result.reviewManifest?.sections["provider-model-network"][0]?.review.values).toEqual(expect.objectContaining({
      provider: "codex",
      model: "gpt-5.5",
      authMethod: "oauth_device_pkce",
      oauthCredentialStatus: "pending",
    }));
    expect(result.reviewManifest?.sections["secret-refs-to-store"][0]?.review.values).toEqual(expect.objectContaining({
      provider: "codex",
      credentialSurface: "oauth",
      authMethod: "oauth_device_pkce",
      oauthCredentialStatus: "pending",
    }));
    expect(calls.map((call) => call.url)).toEqual([
      "https://auth.openai.com/api/accounts/deviceauth/usercode",
      "https://auth.openai.com/api/accounts/deviceauth/token",
      "https://auth.openai.com/oauth/token",
    ]);
    const serializedResult = JSON.stringify(result);
    expect(serializedResult).not.toContain("access-token-secret");
    expect(serializedResult).not.toContain("refresh-token-secret");
    expect(serializedResult).not.toContain("authorization-code-secret");
    expect(serializedResult).not.toContain("code-verifier-secret");
    expect(serializedResult).not.toContain("device-auth-secret");
    expect(rawConfig).not.toContain("access-token-secret");
    expect(rawConfig).not.toContain("refresh-token-secret");
  });

  it("does not start Codex OAuth or draft changes when setup-editor Codex sign-in is cancelled", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    await trustWorkspace(tempDir, workspaceRoot);

    const prompt = trackingPrompt({ values: ["OpenAI", "Codex", "cancel"] });
    const selectInputs = captureSelectInputs(prompt);
    const providerFetch = vi.fn();

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt,
      defaultActionId: "edit-primary-model-route",
      flowEngine: flowEngine({
        credentialAction: "oauth",
        oauthStatus: "required",
        providers: ["openai", "codex"],
      }),
      providerFetch,
      applyExecutor: createReviewedSetupApplyExecutor({
        homeDir: tempDir,
        workspaceRoot,
      }),
    });
    const rawConfig = await readFile(profileConfigPath(tempDir), "utf8");

    expect(result.completed).toBe(false);
    expect(result.output).toContain("Codex OAuth authentication was cancelled. No changes were drafted.");
    expect(prompt.secretPromptCount()).toBe(0);
    expect(providerFetch).not.toHaveBeenCalled();
    expect(selectInputs.map((input) => input.title)).toEqual([
      "Primary provider",
      "OpenAI setup",
      "Codex OAuth",
    ]);
    expect(JSON.parse(rawConfig)).toEqual(localReadyConfig());
    await expect(readFile(profileAuthPath(tempDir), "utf8")).rejects.toThrow();
  });

  it("discovers local endpoint models before review when configuring the primary route", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    await trustWorkspace(tempDir, workspaceRoot);
    const basePrompt = fakePrompt({
      values: [
        "Local",
        "",
        "Check endpoint",
        "local-test-model",
        "",
        "No API key",
        "Skip test",
        "Review changes",
        true,
      ],
    });
    const questions: string[] = [];
    const prompt = ((question: string, options?: { secret?: boolean }) => {
      questions.push(question);
      return basePrompt(question, options);
    }) as Prompt;
    prompt.select = basePrompt.select;
    prompt.onboardingCard = basePrompt.onboardingCard;
    prompt.close = basePrompt.close;
    const selectInputs = captureSelectInputs(prompt);

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt,
      defaultActionId: "edit-primary-model-route",
      flowEngine: flowEngine({ credentialAction: "endpoint", envVarName: "OPENAI_COMPATIBLE_API_KEY", providers: ["local"] }),
      providerFetch: async (url) => {
        if (url.endsWith("/models")) {
          return fetchResponse({ data: [{ id: "local-test-model" }] });
        }
        return fetchResponse({});
      },
      applyExecutor: createReviewedSetupApplyExecutor({
        homeDir: tempDir,
        workspaceRoot,
      }),
    });
    const rawConfig = await readFile(profileConfigPath(tempDir), "utf8");
    const config = JSON.parse(rawConfig) as {
      providers?: Record<string, { baseUrl?: string; apiKeyEnv?: string }>;
    };

    expect(result.completed).toBe(true);
    const introInput = selectInputs.find((input) => input.title === "Local / Custom Endpoint");
    expect(introInput?.body).toContain("EstaCoda will:");
    expect(introInput?.body).toContain("1. Choose or confirm the endpoint URL");
    expect(introInput?.statusLines).toEqual([
      { text: "Current: local/local-test-model", tone: "active", direction: "ltr" },
      { text: "Endpoint: http://localhost:11434/v1", tone: "active", direction: "ltr" },
    ]);
    expect(introInput?.options.find((option) => option.label === "Continue")?.description).toBe("Continue with this endpoint.");
    const changeEndpointModelOption = selectInputs
      .flatMap((input) => input.options)
      .find((option) => option.id === "change-endpoint");
    expect(changeEndpointModelOption?.description).toBe("Enter a different endpoint URL.");
    expect(questions).toEqual([
      "Context window tokens [infer]: ",
    ]);
    expect(result.reviewManifest?.sections["provider-model-network"][0]?.review.values).toEqual(expect.objectContaining({
      provider: "local",
      model: "local-test-model",
      baseUrl: "http://localhost:11434/v1",
      modelSource: "discovered",
      modelListStatus: "passed",
      chatCompletionStatus: "skipped",
    }));
    expect(result.reviewManifest?.sections["provider-model-network"][0]?.review.summaryKey).toBe("setupDrafts.providerModelEndpointRoute.summary");
    expect(result.reviewManifest?.sections["secret-refs-to-store"]).toHaveLength(0);
    expect(config.providers?.local?.baseUrl).toBeUndefined();
    expect(config.providers?.local?.apiKeyEnv).toBeUndefined();
    await expect(readFile(profileEnvPath(tempDir), "utf8")).rejects.toThrow();
  });

  it("adds a named custom OpenAI-compatible provider through endpoint-first setup", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    await trustWorkspace(tempDir, workspaceRoot);
    const basePrompt = fakePrompt({
      values: [
        "enterprise-gateway",
        "Change endpoint",
        "https://gateway.example.com/v1",
        "Continue manually",
        "enterprise-model",
        "",
        "Use API key from environment",
        "ENTERPRISE_GATEWAY_API_KEY",
        "Skip test",
        "Review changes",
        true,
      ],
    });
    const questions: string[] = [];
    const prompt = ((question: string, options?: { secret?: boolean }) => {
      questions.push(question);
      return basePrompt(question, options);
    }) as Prompt;
    prompt.select = basePrompt.select;
    prompt.onboardingCard = basePrompt.onboardingCard;
    prompt.close = basePrompt.close;

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt,
      defaultActionId: "add-custom-provider-route",
      applyExecutor: createReviewedSetupApplyExecutor({
        homeDir: tempDir,
        workspaceRoot,
        collectVerification: () => readyVerification(profileConfigPath(tempDir)),
      }),
    });
    const rawConfig = await readFile(profileConfigPath(tempDir), "utf8");
    const config = JSON.parse(rawConfig) as {
      model?: { provider?: string; id?: string };
      providers?: Record<string, { kind?: string; baseUrl?: string; apiKeyEnv?: string; enableNetwork?: boolean }>;
    };

    expect(result.completed).toBe(true);
    expect(result.selectedActionId).toBe("add-custom-provider-route");
    expect(questions).toEqual([
      "Provider ID: ",
      "Endpoint URL [http://localhost:11434/v1] - press ENTER to keep it:",
      "Model ID: ",
      "Context window tokens [infer]: ",
      "Environment variable [OPENAI_COMPATIBLE_API_KEY]:",
    ]);
    expect(result.reviewManifest?.sections["provider-model-network"][0]?.review.values).toEqual(expect.objectContaining({
      provider: "enterprise-gateway",
      model: "enterprise-model",
      baseUrl: "https://gateway.example.com/v1",
      modelSource: "manual",
      modelListStatus: "notTested",
      chatCompletionStatus: "skipped",
      authMethod: "api_key",
    }));
    expect(result.reviewManifest?.sections["secret-refs-to-store"][0]?.review.values).toEqual(expect.objectContaining({
      provider: "enterprise-gateway",
      envVars: ["ENTERPRISE_GATEWAY_API_KEY"],
      credentialValuesIncluded: false,
    }));
    expect(config.model).toEqual({ provider: "enterprise-gateway", id: "enterprise-model" });
    expect(config.providers?.["enterprise-gateway"]).toEqual(expect.objectContaining({
      kind: "openai-compatible",
      baseUrl: "https://gateway.example.com/v1",
      apiKeyEnv: "ENTERPRISE_GATEWAY_API_KEY",
      enableNetwork: true,
    }));
    await expect(readFile(profileEnvPath(tempDir), "utf8")).rejects.toThrow();
    expect(rawConfig).not.toContain("sk-");
    expect(JSON.stringify(result)).not.toContain("sk-");
  });

  it("edits an existing custom provider when the custom provider ID conflicts", async () => {
    const baseConfig = localReadyConfig();
    await writeUserConfig(tempDir, {
      ...baseConfig,
      providers: {
        ...(baseConfig.providers as Record<string, unknown>),
        "enterprise-gateway": {
          kind: "openai-compatible",
          baseUrl: "https://gateway.example.com/v1",
          apiKeyEnv: "ENTERPRISE_GATEWAY_API_KEY",
          models: ["old-enterprise-model"],
          enableNetwork: true,
        },
      },
    });
    await trustWorkspace(tempDir, workspaceRoot);
    const prompt = fakePrompt({
      values: [
        "enterprise-gateway",
        "Edit existing provider",
        "",
        "Continue manually",
        "new-enterprise-model",
        "",
        "Use API key from environment",
        "",
        "Skip test",
        "Review changes",
        true,
      ],
    });
    const selectInputs = captureSelectInputs(prompt);

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt,
      defaultActionId: "add-custom-provider-route",
      applyExecutor: createReviewedSetupApplyExecutor({
        homeDir: tempDir,
        workspaceRoot,
        collectVerification: () => readyVerification(profileConfigPath(tempDir)),
      }),
    });
    const rawConfig = await readFile(profileConfigPath(tempDir), "utf8");
    const config = JSON.parse(rawConfig) as {
      model?: { provider?: string; id?: string };
      providers?: Record<string, { baseUrl?: string; apiKeyEnv?: string; models?: string[] }>;
    };

    expect(result.completed).toBe(true);
    expect(selectInputs.some((input) =>
      input.title === "Custom OpenAI-Compatible Provider" &&
      input.options.some((option) => option.label === "Edit existing provider") &&
      input.options.some((option) => option.label === "Use different provider ID")
    )).toBe(true);
    expect(result.reviewManifest?.sections["provider-model-network"][0]?.review.values).toEqual(expect.objectContaining({
      provider: "enterprise-gateway",
      model: "new-enterprise-model",
      baseUrl: "https://gateway.example.com/v1",
      authMethod: "api_key",
      modelSource: "manual",
    }));
    expect(config.model).toEqual({ provider: "enterprise-gateway", id: "new-enterprise-model" });
    expect(config.providers?.["enterprise-gateway"]?.baseUrl).toBe("https://gateway.example.com/v1");
    expect(config.providers?.["enterprise-gateway"]?.apiKeyEnv).toBe("ENTERPRISE_GATEWAY_API_KEY");
    expect(config.providers?.["enterprise-gateway"]?.models).toEqual(expect.arrayContaining([
      "old-enterprise-model",
      "new-enterprise-model",
    ]));
  });

  it("retries invalid local endpoint URLs before review and writes no secret for a blank API key", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    await trustWorkspace(tempDir, workspaceRoot);
    const basePrompt = fakePrompt({
      values: [
        "Local",
        "Change endpoint",
        "not a url",
        "http://127.0.0.1:9999/v1",
        "Continue manually",
        "manual-local-model",
        "",
        "No API key",
        "Skip test",
        "Review changes",
        true,
      ],
    });
    const questions: string[] = [];
    const cards: string[][] = [];
    const prompt = ((question: string, options?: { secret?: boolean }) => {
      questions.push(question);
      return basePrompt(question, options);
    }) as Prompt;
    prompt.select = basePrompt.select;
    prompt.onboardingCard = (input) => {
      cards.push([...input.bodyLines]);
    };
    prompt.close = basePrompt.close;

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt,
      defaultActionId: "edit-primary-model-route",
      flowEngine: flowEngine({ credentialAction: "endpoint", providers: ["local"] }),
      applyExecutor: createReviewedSetupApplyExecutor({
        homeDir: tempDir,
        workspaceRoot,
      }),
    });
    const rawConfig = await readFile(profileConfigPath(tempDir), "utf8");
    const config = JSON.parse(rawConfig) as {
      providers?: Record<string, { baseUrl?: string; apiKeyEnv?: string }>;
    };

    expect(result.completed).toBe(true);
    expect(questions[0]).toBe("Endpoint URL [http://localhost:11434/v1] - press ENTER to keep it:");
    expect(questions[1]).toBe("Endpoint URL [http://localhost:11434/v1] - press ENTER to keep it:");
    expect(cards.flat()).toContain("Invalid endpoint URL. Enter an absolute URL such as http://localhost:11434/v1.");
    expect(result.reviewManifest?.sections["provider-model-network"][0]?.review.values).toEqual(expect.objectContaining({
      model: "manual-local-model",
      modelSource: "manual",
      modelListStatus: "notTested",
      chatCompletionStatus: "skipped",
    }));
    expect(config.providers?.local?.baseUrl).toBe("http://127.0.0.1:9999/v1");
    expect(config.providers?.local?.apiKeyEnv).toBeUndefined();
    await expect(readFile(profileEnvPath(tempDir), "utf8")).rejects.toThrow();
  });

  it("defers exactly one optional local endpoint API key write after review", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    await trustWorkspace(tempDir, workspaceRoot);
    const reviewedExecutor = createReviewedSetupApplyExecutor({
      homeDir: tempDir,
      workspaceRoot,
    });
    const deferredWrites: SetupDeferredSecretWrite[][] = [];

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({
        values: [
          "Local",
          "Change endpoint",
          "https://private.local/v1",
          "Continue manually",
          "private-local-model",
          "",
          "Enter API key now",
          "",
          "Skip test",
          "Review changes",
          true,
        ],
        secret: "sk-local-endpoint",
      }),
      defaultActionId: "edit-primary-model-route",
      flowEngine: flowEngine({ credentialAction: "endpoint", envVarName: "OPENAI_COMPATIBLE_API_KEY", providers: ["local"] }),
      applyExecutor: {
        ...reviewedExecutor,
        applyDeferredSecrets: async (plan, writes) => {
          deferredWrites.push([...writes]);
          return reviewedExecutor.applyDeferredSecrets!(plan, writes);
        },
      },
    });
    const rawConfig = await readFile(profileConfigPath(tempDir), "utf8");
    const config = JSON.parse(rawConfig) as {
      providers?: Record<string, { baseUrl?: string; apiKeyEnv?: string }>;
    };
    const envFile = await readFile(profileEnvPath(tempDir), "utf8");

    expect(result.completed).toBe(true);
    expect(deferredWrites).toEqual([[{ envVarName: "OPENAI_COMPATIBLE_API_KEY", value: "sk-local-endpoint" }]]);
    expect(result.reviewManifest?.sections["provider-model-network"][0]?.review.values).toEqual(expect.objectContaining({
      baseUrl: "https://private.local/v1",
      model: "private-local-model",
      modelSource: "manual",
      modelListStatus: "notTested",
      chatCompletionStatus: "skipped",
    }));
    expect(result.reviewManifest?.sections["secret-refs-to-store"]).toHaveLength(1);
    expect(config.providers?.local?.baseUrl).toBe("https://private.local/v1");
    expect(config.providers?.local?.apiKeyEnv).toBe("OPENAI_COMPATIBLE_API_KEY");
    expect(envFile).toContain("OPENAI_COMPATIBLE_API_KEY=");
    expect(rawConfig).not.toContain("sk-local-endpoint");
    expect(JSON.stringify(result)).not.toContain("sk-local-endpoint");
  });

  it("stores local endpoint env-var auth without writing a new secret", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    await trustWorkspace(tempDir, workspaceRoot);
    const previousKey = process.env.CUSTOM_LOCAL_KEY;
    process.env.CUSTOM_LOCAL_KEY = "sk-existing-env";
    try {
      const result = await runConfigEditor({
        homeDir: tempDir,
        workspaceRoot,
        prompt: fakePrompt({
          values: [
            "Local",
            "Change endpoint",
            "https://private.local/v1",
            "Continue manually",
            "env-local-model",
            "",
            "Use API key from environment",
            "CUSTOM_LOCAL_KEY",
            "Skip test",
            "Review changes",
            true,
          ],
        }),
        defaultActionId: "edit-primary-model-route",
        flowEngine: flowEngine({ credentialAction: "endpoint", envVarName: "OPENAI_COMPATIBLE_API_KEY", providers: ["local"] }),
        applyExecutor: createReviewedSetupApplyExecutor({
          homeDir: tempDir,
          workspaceRoot,
        }),
      });
      const rawConfig = await readFile(profileConfigPath(tempDir), "utf8");
      const config = JSON.parse(rawConfig) as {
        providers?: Record<string, { baseUrl?: string; apiKeyEnv?: string }>;
      };

      expect(result.completed).toBe(true);
      expect(result.reviewManifest?.sections["provider-model-network"][0]?.review.values).toEqual(expect.objectContaining({
        baseUrl: "https://private.local/v1",
        model: "env-local-model",
        modelSource: "manual",
        modelListStatus: "notTested",
        chatCompletionStatus: "skipped",
      }));
      expect(result.reviewManifest?.sections["secret-refs-to-store"][0]?.review.values.envVars).toEqual(["CUSTOM_LOCAL_KEY"]);
      expect(config.providers?.local?.baseUrl).toBe("https://private.local/v1");
      expect(config.providers?.local?.apiKeyEnv).toBe("CUSTOM_LOCAL_KEY");
      await expect(readFile(profileEnvPath(tempDir), "utf8")).rejects.toThrow();
      expect(JSON.stringify(result)).not.toContain("sk-existing-env");
    } finally {
      if (previousKey === undefined) {
        delete process.env.CUSTOM_LOCAL_KEY;
      } else {
        process.env.CUSTOM_LOCAL_KEY = previousKey;
      }
    }
  });

  it("routes credential-only endpoint repair through provider-route review without a credential-only endpoint apply", async () => {
    delete process.env.OPENAI_COMPATIBLE_API_KEY;
    await writeUserConfig(tempDir, {
      ...localReadyConfig(),
      providers: {
        local: {
          kind: "openai-compatible",
          baseUrl: "http://localhost:11434/v1",
          apiKeyEnv: "OPENAI_COMPATIBLE_API_KEY",
          models: ["local-test-model"],
          enableNetwork: true,
        },
      },
    });
    await trustWorkspace(tempDir, workspaceRoot);
    const editorAction: SetupEditorActionDraft = {
      kind: "setup-editor-action-draft",
      id: "repair-missing-credential",
      copyKey: "setupEditor.actions.repairMissingCredential",
      sectionId: "credentials",
      effect: "draft-config-patch",
      readOnly: false,
      mutatesConfig: false,
      requiresExplicitApply: true,
      preservesUnrelatedConfig: true,
      patch: {
        kind: "scoped-config-patch-intent",
        fields: ["provider.credentialReference"],
        preserveUnrelatedConfig: true,
      },
      credentialRefs: [{ kind: "env", name: "OPENAI_COMPATIBLE_API_KEY", value: "not-included" }],
    };
    const session: NonNullable<SetupRouteDecision["setupEditorPlanSession"]> = {
      kind: "guided-setup-editor-session",
      plan: {
        kind: "guided-setup-editor-plan",
        name: "Guided Setup Editor Architecture",
        mode: "repair-first",
        sourceState: "missing-secret",
        preservesUnrelatedConfig: true,
        configSummary: {},
        sections: [],
        actions: [editorAction],
        blockers: [],
        warnings: [],
        safeForNormalConfigEditing: true,
      } as unknown as NonNullable<SetupRouteDecision["setupEditorPlanSession"]>["plan"],
      activeSections: [],
      metadata: {
        source: "setup-router",
        planKind: "guided-setup-editor-plan",
        mode: "repair-first",
        sourceState: "missing-secret",
        sectionCount: 0,
        actionCount: 1,
      },
    };
    const initialDecision = {
      kind: "repair-first-menu",
      title: "Setup editor",
      summary: "Repair",
      state: {
        kind: "missing-secret",
        model: { provider: "local", id: "local-test-model" },
      },
      actions: [],
      warnings: [],
      blockers: [],
      readOnly: false,
      setupEditorPlanSession: session,
    } as unknown as SetupRouteDecision;
    const resolution = await flowEngine({ credentialAction: "endpoint", providers: ["local"] }).resolveSelection("local", "local-test-model");
    if (resolution.kind !== "selected") {
      throw new Error("Expected local endpoint selection to resolve.");
    }

    const result = await __reviewAndApplyResolvedRouteForTest({
      options: {
        homeDir: tempDir,
        workspaceRoot,
        prompt: fakePrompt({ values: ["https://private.local/v1", true] }),
        applyExecutor: createReviewedSetupApplyExecutor({
          homeDir: tempDir,
          workspaceRoot,
        }),
      },
      initialDecision,
      session,
      editorAction,
      resolution,
      behavior: { credentialOnly: true },
    });
    const rawConfig = await readFile(profileConfigPath(tempDir), "utf8");
    const config = JSON.parse(rawConfig) as {
      providers?: Record<string, { baseUrl?: string; apiKeyEnv?: string }>;
    };

    expect(result.completed).toBe(true);
    expect(result.selectedActionId).toBe("repair-missing-credential");
    expect(result.reviewManifest?.sections["provider-model-network"]).toHaveLength(1);
    expect(result.reviewManifest?.sections["provider-model-network"][0]?.review.values.baseUrl).toBe("https://private.local/v1");
    expect(result.reviewManifest?.sections["files-to-write-update"][0]?.target).toEqual(expect.objectContaining({
      kind: "config-scope",
      scope: ["model.provider", "model.id", "provider.route"],
    }));
    expect(result.reviewManifest?.sections["secret-refs-to-store"]).toHaveLength(0);
    expect(JSON.stringify(result.reviewManifest)).not.toContain("setupDrafts.credentialReference.summary");
    expect(result.reviewManifest?.sections["provider-model-network"][0]?.review.values.apiKeyEnv).toBeUndefined();
    expect(config.providers?.local?.baseUrl).toBe("https://private.local/v1");
    expect(config.providers?.local?.apiKeyEnv).toBe("OPENAI_COMPATIBLE_API_KEY");
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

    const prompt = fakePrompt({ values: ["OpenAI", "OpenAI Models", "Back", "OpenAI", "OpenAI Models", "gpt-5.5", true], secret: "sk-pr8-provider-route" });
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
      values: ["OpenAI", "OpenAI Models", "gpt-5.5", "existing", true],
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
      values: ["OpenAI", "OpenAI Models", "gpt-5.5", true],
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

  it("runs endpoint-first setup when adding a local custom fallback route", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    await trustWorkspace(tempDir, workspaceRoot);
    const prompt = fakePrompt({
      values: [
        "Local",
        "",
        "Check endpoint",
        "fallback-local-model",
        "",
        "No API key",
        "Skip test",
        "Review changes",
        true,
      ],
    });
    const selectInputs = captureSelectInputs(prompt);

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt,
      defaultActionId: "edit-fallback-model-route",
      flowEngine: flowEngine({ credentialAction: "endpoint", envVarName: "OPENAI_COMPATIBLE_API_KEY", providers: ["local"] }),
      providerFetch: async (url) => {
        if (url.endsWith("/models")) {
          return fetchResponse({ data: [{ id: "fallback-local-model" }] });
        }
        return fetchResponse({});
      },
      applyExecutor: createReviewedSetupApplyExecutor({
        homeDir: tempDir,
        workspaceRoot,
      }),
    });
    const config = JSON.parse(await readFile(profileConfigPath(tempDir), "utf8")) as {
      model?: { fallbacks?: Array<{ provider?: string; id?: string; baseUrl?: string }> };
    };

    expect(result.completed).toBe(true);
    expect(selectInputs.map((input) => input.title)).toContain("Local / Custom Endpoint");
    expect(selectInputs.map((input) => input.title)).not.toContain("Fallback model");
    expect(result.reviewManifest?.sections["provider-model-network"][0]?.review.summaryKey).toBe("setupDrafts.fallbackModelRoute.add.summary");
    expect(result.reviewManifest?.sections["provider-model-network"][0]?.review.values).toEqual(expect.objectContaining({
      fallbackOperation: "add",
      provider: "local",
      model: "fallback-local-model",
      baseUrl: "http://localhost:11434/v1",
      modelSource: "discovered",
      modelListStatus: "passed",
      chatCompletionStatus: "skipped",
    }));
    expect(config.model?.fallbacks).toEqual([
      expect.objectContaining({
        provider: "local",
        id: "fallback-local-model",
        baseUrl: "http://localhost:11434/v1",
      }),
    ]);
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

  it("runs endpoint-first setup when selecting a local custom auxiliary route", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    await trustWorkspace(tempDir, workspaceRoot);
    const prompt = fakePrompt({
      values: [
        "compression",
        "Local",
        "",
        "Check endpoint",
        "aux-local-model",
        "",
        "No API key",
        "Skip test",
        "Review changes",
        true,
      ],
    });
    const selectInputs = captureSelectInputs(prompt);

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt,
      defaultActionId: "edit-auxiliary-model-route",
      flowEngine: flowEngine({ credentialAction: "endpoint", envVarName: "OPENAI_COMPATIBLE_API_KEY", providers: ["local"] }),
      providerFetch: async (url) => {
        if (url.endsWith("/models")) {
          return fetchResponse({ data: [{ id: "aux-local-model" }] });
        }
        return fetchResponse({});
      },
      applyExecutor: createReviewedSetupApplyExecutor({
        homeDir: tempDir,
        workspaceRoot,
      }),
    });
    const config = JSON.parse(await readFile(profileConfigPath(tempDir), "utf8")) as {
      auxiliaryModels?: {
        compression?: { provider?: string; id?: string; baseUrl?: string; enabled?: boolean };
      };
    };

    expect(result.completed).toBe(true);
    expect(selectInputs.map((input) => input.title)).toContain("Local / Custom Endpoint");
    expect(selectInputs.map((input) => input.title)).not.toContain("Auxiliary model");
    expect(result.reviewManifest?.sections["provider-model-network"][0]?.review.summaryKey).toBe("setupDrafts.auxiliaryModelRoute.summary");
    expect(result.reviewManifest?.sections["provider-model-network"][0]?.review.values).toEqual(expect.objectContaining({
      auxiliaryTask: "compression",
      provider: "local",
      model: "aux-local-model",
      baseUrl: "http://localhost:11434/v1",
      modelSource: "discovered",
      modelListStatus: "passed",
      chatCompletionStatus: "skipped",
    }));
    expect(config.auxiliaryModels?.compression).toEqual(expect.objectContaining({
      provider: "local",
      id: "aux-local-model",
      baseUrl: "http://localhost:11434/v1",
      enabled: true,
    }));
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
        values: ["OpenAI", "OpenAI Models", "gpt-5.5", "new", true],
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
      prompt: fakePrompt({ values: ["OpenAI", "OpenAI Models", "gpt-5.5", "new"], secret: "" }),
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
    const prompt = trackingPrompt({ values: ["OpenAI", "OpenAI Models", "gpt-5.5", true] });
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
      prompt: fakePrompt({ values: ["OpenAI", "OpenAI Models", "gpt-5.5"] }),
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

  it("uses configure-first optional action ordering for channel and voice capabilities", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    await trustWorkspace(tempDir, workspaceRoot);
    const actions = [
      { actionId: "configure-channels" as const, values: ["telegram", "unchanged"] },
      { actionId: "configure-voice" as const, values: ["stt", "unchanged"] },
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

    const imageOptionLabels: string[][] = [];
    const imagePrompt = fakePrompt({ values: ["Back", "exit"] });
    const baseImageSelect = imagePrompt.select!;
    imagePrompt.select = async (input) => {
      imageOptionLabels.push(input.options.map((option) => option.label));
      return baseImageSelect(input);
    };

    const imageResult = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt: imagePrompt,
      defaultActionId: "configure-image-generation",
    });

    expect(imageResult.completed).toBe(true);
    expect(imageOptionLabels[0]).toEqual(["fal.ai", "BytePlus / ModelArk", "OpenAI", "Back"]);
    expect(imageOptionLabels.some((labels) => labels.includes("Configure"))).toBe(false);
    expect(imageResult.reviewManifest).toBeUndefined();
  });

  it("opens Search and Browser directly without the optional action card", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    await trustWorkspace(tempDir, workspaceRoot);

    for (const actionId of ["configure-web-search", "configure-browser"] as const) {
      const selectInputs: SelectPromptInput<unknown>[] = [];
      const prompt = fakePrompt({ values: ["Back", "exit"] });
      const baseSelect = prompt.select!;
      prompt.select = async (input) => {
        selectInputs.push(input as SelectPromptInput<unknown>);
        return baseSelect(input);
      };

      const result = await runConfigEditor({
        homeDir: tempDir,
        workspaceRoot,
        prompt,
        defaultActionId: actionId,
      });

      expect(result.completed).toBe(true);
      expect(result.reviewManifest).toBeUndefined();
      expect(selectInputs[0]?.options.map((option) => option.label)).not.toContain("Configure");
      expect(selectInputs.map((input) => input.title)).toEqual([
        actionId === "configure-web-search" ? "Search provider" : "Browser",
        "Setup editor",
      ]);
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
    const seenDescriptions: Array<string | undefined> = [];
    const seenInputTitles: Array<string | undefined> = [];
    const seenCards: Array<{ title: string; bodyLines: readonly string[] }> = [];
    const reviewPrompts: Array<{ title: string; body?: string; labels: string[]; descriptions: Array<string | undefined> }> = [];
    const output: string[] = [];
    const basePrompt = fakePrompt({
      values: ["telegram", "enable", "42", "-100", true],
      secret: "123456:stored-telegram-token",
    });
    const prompt = (async (question: string, options?: PromptOptions) => {
      seenQuestions.push(question);
      seenDescriptions.push(options?.description);
      seenInputTitles.push(options?.title);
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
    expect(seenInputTitles.filter((title) => title === "Telegram Setup")).toHaveLength(3);
    expect(seenDescriptions.join("\n")).toContain("Connect Telegram bot");
    expect(seenDescriptions.join("\n")).toContain("Open Telegram and search for the official @BotFather account.");
    expect(seenDescriptions.join("\n")).toContain("Authorize Telegram users");
    expect(seenDescriptions.join("\n")).toContain("Open Telegram and search for @userinfobot.");
    expect(seenDescriptions.join("\n")).toContain("Authorize Telegram group chats");
    expect(seenDescriptions.join("\n")).toContain("Add @getidsbot or @chatIDrobot to the same group chat.");
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
    const prompt = fakePrompt({
      values: ["whatsapp", "1", "971501234567"],
    });
    const selectInputs = captureSelectInputs(prompt);

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt,
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
    expect(output.join("")).toContain("Starting WhatsApp QR pairing");
    expect(result.output).toContain("✓ Allowed senders: 971501234567");
    expect(result.output).not.toContain("allowed users");
    expect(selectInputs.find((input) => input.title === "WhatsApp channel mode")?.columns).toEqual([
      { key: "name", header: "Option" },
      { key: "description", header: "Description" },
    ]);
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
        values: ["OpenAI", "OpenAI Models", "gpt-5.5", true],
        secret: "sk-provider-only-secret",
        flowEngine: flowEngine({ credentialAction: "collect", envVarName: "PR8_PROVIDER_ONLY_KEY" }),
      },
      {
        actionId: "configure-voice" as const,
        values: ["stt", "enable", "openai", true],
        secret: "voice-stt-secret",
      },
      {
        actionId: "configure-browser" as const,
        values: ["existing-cdp", "http://127.0.0.1:9222", true],
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
        provider: "openai",
        openai: {
          apiKeyEnv: "VOICE_TOOLS_OPENAI_KEY",
        },
      },
    });
    await trustWorkspace(tempDir, workspaceRoot);
    const selectCalls: Array<{
      title: string;
      body: string;
      columns?: unknown;
      labels: string[];
      descriptions: Array<string | undefined>;
      values: unknown[];
    }> = [];
    const prompt = fakePrompt({
      values: [
        "tts",
        "enable",
        "openai",
        true,
        "exit",
      ],
      secret: "voice-tts-secret",
    });
    const baseSelect = prompt.select!;
    prompt.select = async (input) => {
      selectCalls.push({
        title: input.title,
        body: input.body ?? "",
        columns: input.columns,
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
      channels?: unknown;
      tts?: { provider?: string; openai?: { model?: string; apiKeyEnv?: string } };
      stt?: { provider?: string; openai?: { model?: string; apiKeyEnv?: string } };
      imageGen?: unknown;
      browser?: unknown;
    };
    const ttsProviderPrompt = selectCalls.find((call) => call.body.includes("Choose your TTS provider:"));
    const voiceCredentialLine = result.reviewManifest?.sections["secret-refs-to-store"]
      .find((line) => line.sourceDraftIds.includes("setup-module.voice.voice-tts-credential"));

    expect(result.completed).toBe(true);
    expect(result.selectedActionId).toBe("configure-voice");
    expect(result.reviewManifest?.sections["enabled-optional-capabilities"][0]?.review.values).toMatchObject({
      ttsProvider: "openai",
      ttsApiKeyEnv: "VOICE_TOOLS_OPENAI_KEY",
      secretValuesIncluded: false,
    });
    expect(result.reviewManifest?.sections["enabled-optional-capabilities"][0]?.review.values).not.toHaveProperty("sttProvider");
    expect(result.reviewManifest?.sections["enabled-optional-capabilities"].map((line) => line.sourceDraftIds[0])).toEqual([
      "setup-module.voice.capability",
    ]);
    expect(voiceCredentialLine?.review.values).toMatchObject({
      credentialSurface: "voice-tts",
      envVars: ["VOICE_TOOLS_OPENAI_KEY"],
      credentialValuesIncluded: false,
    });
    expect(config.tts?.provider).toBe("openai");
    expect(config.tts?.openai?.apiKeyEnv).toBe("VOICE_TOOLS_OPENAI_KEY");
    expect(config.stt).toEqual({
      provider: "openai",
      openai: {
        apiKeyEnv: "VOICE_TOOLS_OPENAI_KEY",
      },
    });
    expect(config.channels).toBeUndefined();
    expect(config.imageGen).toBeUndefined();
    expect(config.browser).toBeUndefined();
    expect(ttsProviderPrompt?.body).toBe("Choose your TTS provider:");
    expect(ttsProviderPrompt?.columns).toEqual([
      { key: "name", header: "Name", align: "left" },
      { key: "description", header: "Details", align: "left" },
    ]);
    expect(ttsProviderPrompt?.labels).toEqual([
      "Edge",
      "ElevenLabs",
      "OpenAI",
      "Minimax",
      "Mistral",
      "Gemini",
      "Xai",
      "Neutts",
      "Kittentts",
      "Back",
    ]);
    expect(ttsProviderPrompt?.descriptions).toEqual([
      "Managed Python edge-tts via Microsoft Edge speech service. No API key required. Recommended.",
      "ElevenLabs voice synthesis. Requires API key.",
      "OpenAI speech models. Requires API key.",
      "Minimax speech synthesis. Requires API key.",
      "Mistral Voxtral TTS. Not enabled yet.",
      "Gemini speech synthesis. Requires API key.",
      "xAI speech synthesis. Requires API key.",
      "Local NeuTTS. No API key required. Not enabled yet.",
      "Local KittenTTS. No API key required. Not enabled yet.",
      "Return to the previous step.",
    ]);
    expect(ttsProviderPrompt?.values.slice(0, 9)).toEqual([
      "edge",
      "elevenlabs",
      "openai",
      "minimax",
      "mistral",
      "gemini",
      "xai",
      "neutts",
      "kittentts",
    ]);
    expect(rawConfig).not.toContain("sk-");
    expect(JSON.stringify(result)).not.toContain("sk-");
    await expect(readFile(profileEnvPath(tempDir), "utf8")).resolves.toContain("VOICE_TOOLS_OPENAI_KEY");
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
          true,
        ],
        secret: "voice-stt-secret",
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
      sttApiKeyEnv: "VOICE_TOOLS_OPENAI_KEY",
      secretValuesIncluded: false,
    });
    expect(result.reviewManifest?.sections["enabled-optional-capabilities"][0]?.review.values).not.toHaveProperty("ttsProvider");
    expect(config.tts).toBeUndefined();
    expect(config.stt?.provider).toBe("openai");
    expect(config.stt?.openai?.apiKeyEnv).toBe("VOICE_TOOLS_OPENAI_KEY");
    expect(rawConfig).not.toContain("sk-");
    expect(JSON.stringify(result)).not.toContain("sk-");
    await expect(readFile(profileEnvPath(tempDir), "utf8")).resolves.toContain("VOICE_TOOLS_OPENAI_KEY");
  });

  it("configures local faster-whisper STT with runtime default model", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    await trustWorkspace(tempDir, workspaceRoot);
    mockManagedPythonEnvironment(tempDir);
    const selectCalls: Array<{
      title: string;
      body: string;
      columns?: unknown;
      labels: string[];
      descriptions: Array<string | undefined>;
      values: unknown[];
    }> = [];
    const prompt = fakePrompt({
      values: [
        "stt",
        "enable",
        "local",
        true,
      ],
    });
    const baseSelect = prompt.select!;
    prompt.select = async (input) => {
      selectCalls.push({
        title: input.title,
        body: input.body ?? "",
        columns: input.columns,
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
    const sttProviderPrompt = selectCalls.find((call) => call.body.includes("Choose your STT provider:"));
    const localModelPrompt = selectCalls.find((call) => call.body.includes("Pick the faster-whisper STT model"));

    expect(result.completed).toBe(true);
    expect(result.selectedActionId).toBe("configure-voice");
    expect(result.reviewManifest?.sections["enabled-optional-capabilities"][0]?.review.values).toMatchObject({
      sttProvider: "local",
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
    expect(sttProviderPrompt?.body).toBe("Choose your STT provider:");
    expect(sttProviderPrompt?.columns).toEqual([
      { key: "name", header: "Name", align: "left" },
      { key: "description", header: "Details", align: "left" },
    ]);
    expect(sttProviderPrompt?.descriptions).toEqual([
      "Managed via faster-whisper in EstaCoda's Python environment. No API key required. Recommended.",
      "Groq-hosted Whisper transcription. Requires API key.",
      "OpenAI transcription models. Requires API key.",
      "Mistral Voxtral transcription. Requires API key.",
      "xAI transcription. Requires API key.",
      "Return to the previous step.",
    ]);
    expect(localModelPrompt).toBeUndefined();
    expect(rawConfig).not.toContain("sk-");
    expect(JSON.stringify(result)).not.toContain("sk-");
  });

  it("configures image generation without drafting other optional capabilities", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    await trustWorkspace(tempDir, workspaceRoot);

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({
        values: [
          "fal",
          "fal-ai/flux-2/klein/9b",
        ],
        secret: "sk-image-secret",
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
    expect(config.imageGen?.model).toBe("fal-ai/flux-2/klein/9b");
    expect(config.imageGen?.fal?.apiKeyEnv).toBe("FAL_KEY");
    expect(rawConfig).not.toContain("sk-image-secret");
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
      if (input.title === "Browser") {
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
    expect(selectedTitles).toEqual(["Browser"]);
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
        values: ["existing-cdp", ""],
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
        values: ["existing-cdp", "http://example.com:9222"],
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
        values: ["local-supervised", false, "", "", "", ""],
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
        values: ["browserbase", true],
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
        values: ["browserbase", true],
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
        values: ["browserbase", true],
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
        values: ["brave", true],
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
        values: ["ddgs", true],
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
        values: ["ddgs", true, true],
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
    const prompt = fakePrompt({ values: ["run-doctor"] });
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
    expect(result.output).toContain("EstaCoda Doctor");
    expect(result.output).toContain("System health inspection");
    expect(result.output).toContain("Config syntax error");
    expect(result.output).toContain("Expected property name");
    expect(output.join("")).toContain("run-doctor - EstaCoda Doctor");
    expect(output.join("")).not.toContain("verify-setup - Setup verification");
    expect(output.join("")).not.toContain("show-diagnostics - Diagnostics");
    expect(output.join("")).toContain("exit - Exit without changes");
    expect(output.join("")).not.toContain("edit-primary-model-route");
    expect(output.join("")).not.toContain("edit-security-mode");
    expect(output.join("")).not.toContain("repair-state-directory");
    const menuInput = selectInputs[0];
    expect(menuInput?.options.map((option) =>
      typeof option.value === "object" && option.value !== null && "id" in option.value ? option.value.id : option.id
    )).toEqual(["run-doctor", "exit"]);
    expect(menuInput?.options.find((option) => option.id === "run-doctor")?.group).toBeUndefined();
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
      defaultActionId: "run-doctor",
    });

    expect(result.completed).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.initialDecision.kind).toBe("repair-first-menu");
    expect(result.initialDecision.state.kind).toBe("state-not-writable");
    expect(result.initialDecision.setupEditorPlanSession?.metadata.mode).toBe("repair-first");
    expect(result.output).toContain("EstaCoda Doctor");
    expect(result.output).toContain("System health inspection");
    expect(result.output).toContain("not writable");
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

function createTtyInput(): PassThrough & {
  isTTY: boolean;
  isRaw: boolean;
  setRawMode(mode: boolean): void;
} {
  const input = new PassThrough() as PassThrough & {
    isTTY: boolean;
    isRaw: boolean;
    setRawMode(mode: boolean): void;
  };
  input.isTTY = true;
  input.isRaw = false;
  input.setRawMode = (mode: boolean) => {
    input.isRaw = mode;
  };
  return input;
}

function createTtyOutput(): Writable & {
  readonly columns: number;
  readonly rows: number;
  readonly isTTY: boolean;
  text(): string;
} {
  const writes: string[] = [];
  return new class extends Writable {
    readonly columns = 88;
    readonly rows = 24;
    readonly isTTY = true;

    _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
      writes.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
      callback();
    }

    text(): string {
      return writes.join("");
    }
  }();
}

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/gu, "");
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

function profileAuthPath(homeDir: string, profileId = "default"): string {
  return resolveProfileStateHome({ homeDir, profileId }).authJsonPath;
}

function fetchResponse(
  json: unknown,
  options: { readonly ok?: boolean; readonly status?: number; readonly statusText?: string } = {}
): {
  readonly ok: boolean;
  readonly status: number;
  readonly statusText: string;
  readonly json: () => Promise<unknown>;
  readonly text: () => Promise<string>;
} {
  return {
    ok: options.ok ?? true,
    status: options.status ?? 200,
    statusText: options.statusText ?? "OK",
    json: async () => json,
    text: async () => JSON.stringify(json),
  };
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
  readonly credentialAction?: "none" | "reuse" | "collect" | "endpoint" | "oauth";
  readonly envVarName?: string;
  readonly oauthStatus?: "ready" | "required" | "expired";
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
      const isOAuth = action === "oauth" || providerId === "codex";
      return {
        kind: "selected" as const,
        provider: providerId,
        model: modelId,
        baseUrl: baseUrlForProvider(providerId),
        apiMode: "custom_openai_compatible" as ProviderApiMode,
        authMethod: (isOAuth ? "oauth_device_pkce" : "api_key") as ProviderAuthMethod,
        credentialAction: isOAuth
          ? {
              kind: "oauth" as const,
              providerId,
              authMethod: "oauth_device_pkce" as ProviderAuthMethod,
              status: options.oauthStatus ?? "ready",
            }
          : action === "none"
          ? { kind: "none" as const }
          : action === "reuse"
            ? { kind: "reuse" as const, reference: `env:${envVarName}` as `env:${string}` }
            : action === "endpoint"
              ? { kind: "endpoint" as const, baseUrl: baseUrlForProvider(providerId), apiKeyEnv: envVarName }
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
  if (providerId === "local") return "Local";
  if (providerId === "codex") return "Codex";
  return providerId === "anthropic" ? "Anthropic" : providerId === "kimi" ? "Kimi" : "OpenAI";
}

function baseUrlForProvider(providerId: ProviderId): string {
  if (providerId === "local") return "http://localhost:11434/v1";
  if (providerId === "codex") return "https://chatgpt.com/backend-api/codex";
  if (providerId === "anthropic") return "https://api.anthropic.com/v1";
  if (providerId === "kimi") return "https://api.moonshot.ai/v1";
  return "https://api.openai.com/v1";
}

function modelCandidateForProvider(providerId: ProviderId) {
  const id = providerId === "codex"
    ? "gpt-5.5"
    : providerId === "anthropic"
    ? "claude-sonnet-4-5"
    : providerId === "kimi"
      ? "kimi-k2"
      : providerId === "local"
        ? "local-test-model"
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
