import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { launchInteractiveSession } from "./interactive-launcher.js";
import { runCliCommand } from "./cli.js";
import { loadRuntimeConfig, setupProviderConfig, setupUiConfig } from "../config/runtime-config.js";
import type { Prompt } from "../onboarding/interactive-onboarding.js";
import type { SelectPromptInput } from "./interactive-select.js";

describe("launchInteractiveSession", () => {
  const originalIsTTY = process.stdin.isTTY;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "estacoda-launch-locale-test-"));
  });

  afterEach(async () => {
    Object.defineProperty(process.stdin, "isTTY", {
      value: originalIsTTY,
      configurable: true
    });
    vi.restoreAllMocks();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("returns error when not in a TTY", async () => {
    Object.defineProperty(process.stdin, "isTTY", {
      value: false,
      configurable: true
    });

    const result = await launchInteractiveSession({ workspaceRoot: process.cwd() });
    expect(result.launched).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("requires a TTY");
  });

  it("keeps launch locale English before first-run language selection when setup is skipped", async () => {
    Object.defineProperty(process.stdin, "isTTY", {
      value: true,
      configurable: true
    });
    const prompt = Object.assign(
      async () => "n",
      { close: () => undefined }
    ) as Prompt;

    const result = await launchInteractiveSession({
      workspaceRoot: join(tempDir, "workspace"),
      homeDir: tempDir,
      prompt
    });

    expect(result.launched).toBe(false);
    expect(result.onboardingTriggered).toBe(false);
    expect(result.locale).toBe("en");
  });

  it("returns Arabic launch locale after first-run onboarding selects Arabic", async () => {
    Object.defineProperty(process.stdin, "isTTY", {
      value: true,
      configurable: true
    });
    const workspaceRoot = join(tempDir, "workspace");
    const prompt = makeOnboardingPrompt({ language: "ar", provider: "local" });

    const result = await launchInteractiveSession({
      workspaceRoot,
      homeDir: tempDir,
      prompt
    });
    const config = await loadRuntimeConfig({ workspaceRoot, homeDir: tempDir });
    const rawConfig = await readFile(join(tempDir, ".estacoda", "config.json"), "utf8");

    expect(result.launched).toBe(true);
    expect(result.onboardingTriggered).toBe(true);
    expect(result.locale).toBe("ar");
    expect(config.ui.language).toBe("ar");
    expect(JSON.parse(rawConfig).ui.language).toBe("ar");
    expect(result.output).toContain("اكتمل الإعداد.");
  });

  it("returns persisted Arabic locale on later normal launches", async () => {
    Object.defineProperty(process.stdin, "isTTY", {
      value: true,
      configurable: true
    });
    const workspaceRoot = join(tempDir, "workspace");
    await mkdir(workspaceRoot, { recursive: true });
    await setupProviderConfig({
      workspaceRoot,
      homeDir: tempDir,
      input: {
        scope: "user",
        provider: "local",
        model: "ollama/auto",
        enableNetwork: false
      }
    });
    await setupUiConfig({
      workspaceRoot,
      homeDir: tempDir,
      input: {
        scope: "user",
        language: "ar"
      }
    });

    const result = await launchInteractiveSession({ workspaceRoot, homeDir: tempDir });

    expect(result.launched).toBe(true);
    expect(result.onboardingTriggered).toBe(false);
    expect(result.locale).toBe("ar");
  });

  it("returns English on later launches after the user explicitly changes UI language back", async () => {
    Object.defineProperty(process.stdin, "isTTY", {
      value: true,
      configurable: true
    });
    const workspaceRoot = join(tempDir, "workspace");
    await mkdir(workspaceRoot, { recursive: true });
    await setupProviderConfig({
      workspaceRoot,
      homeDir: tempDir,
      input: {
        scope: "user",
        provider: "local",
        model: "ollama/auto",
        enableNetwork: false
      }
    });
    await setupUiConfig({
      workspaceRoot,
      homeDir: tempDir,
      input: {
        scope: "user",
        language: "ar"
      }
    });

    const settings = await runCliCommand({
      argv: ["settings", "ui", "--language", "en"],
      workspaceRoot,
      homeDir: tempDir
    });
    const result = await launchInteractiveSession({ workspaceRoot, homeDir: tempDir });

    expect(settings.exitCode).toBe(0);
    expect(settings.output).toContain("UI language: en.");
    expect(result.launched).toBe(true);
    expect(result.locale).toBe("en");
  });
});

type PromptControls = {
  readonly language: "en" | "ar";
  readonly provider: string;
};

function makeOnboardingPrompt(controls: PromptControls): Prompt {
  const prompt = (async () => "") as Prompt;
  prompt.select = async <T>(selection: SelectPromptInput<T>): Promise<T> => {
    if (/interface language/i.test(selection.title)) {
      return selection.options.find((option) =>
        typeof option.value === "object" &&
        option.value !== null &&
        (option.value as { language?: string }).language === controls.language
      )?.value ?? selection.options[0]!.value;
    }
    if (/provider|مزوّد/iu.test(selection.title)) {
      return selection.options.find((option) =>
        typeof option.value === "object" &&
        option.value !== null &&
        Object.values(option.value as Record<string, unknown>).includes(controls.provider)
      )?.value ?? selection.options[0]!.value;
    }
    return selection.options[selection.defaultIndex ?? 0]?.value ?? selection.options[0]!.value;
  };
  prompt.onboardingCard = () => undefined;
  prompt.close = () => undefined;
  return prompt;
}
