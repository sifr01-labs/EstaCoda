import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { launchInteractiveSession } from "./interactive-launcher.js";
import { runCliCommand } from "./cli.js";
import { setupProviderConfig, setupUiConfig } from "../config/runtime-config.js";
import { WorkspaceTrustStore } from "../security/workspace-trust-store.js";
import type { Prompt } from "./prompt-contract.js";

const interactivePromptMock = vi.hoisted(() => ({
  createInteractivePrompt: vi.fn()
}));

vi.mock("./create-interactive-prompt.js", () => ({
  createInteractivePrompt: interactivePromptMock.createInteractivePrompt
}));

describe("launchInteractiveSession", () => {
  const originalIsTTY = process.stdin.isTTY;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "estacoda-launch-locale-test-"));
    interactivePromptMock.createInteractivePrompt.mockReset();
    interactivePromptMock.createInteractivePrompt.mockReturnValue(confirmationPrompt("y"));
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

  it("offers canonical setup command instead of running setup from bare launch", async () => {
    Object.defineProperty(process.stdin, "isTTY", {
      value: true,
      configurable: true
    });
    const workspaceRoot = join(tempDir, "workspace");
    await mkdir(workspaceRoot, { recursive: true });

    const result = await launchInteractiveSession({
      workspaceRoot,
      homeDir: tempDir,
      prompt: confirmationPrompt("y")
    });

    expect(result.launched).toBe(false);
    expect(result.onboardingTriggered).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.locale).toBe("en");
    expect(result.output).toContain("estacoda setup --interactive");
  });

  it("uses the Papyrus-capable prompt factory for degraded launch confirmation", async () => {
    Object.defineProperty(process.stdin, "isTTY", {
      value: true,
      configurable: true
    });
    const prompt = confirmationPrompt("n");
    interactivePromptMock.createInteractivePrompt.mockReturnValue(prompt);

    const result = await launchInteractiveSession({
      workspaceRoot: join(tempDir, "workspace"),
      homeDir: tempDir,
      collectSetupRoute: async () => setupRouteDecision("configured-degraded", "Setup has warnings."),
      loadRuntimeConfig: async () => ({ ui: { language: "en" } }) as any
    });

    expect(interactivePromptMock.createInteractivePrompt).toHaveBeenCalledOnce();
    expect(result.launched).toBe(false);
    expect(result.output).toContain("Launch skipped");
  });

  it("uses the Papyrus-capable prompt factory for incomplete setup launch prompts", async () => {
    Object.defineProperty(process.stdin, "isTTY", {
      value: true,
      configurable: true
    });

    const result = await launchInteractiveSession({
      workspaceRoot: join(tempDir, "workspace"),
      homeDir: tempDir,
      collectSetupRoute: async () => setupRouteDecision("new-user", "Setup is missing."),
      loadRuntimeConfig: async () => ({ ui: { language: "en" } }) as any
    });

    expect(interactivePromptMock.createInteractivePrompt).toHaveBeenCalledOnce();
    expect(result.launched).toBe(false);
    expect(result.output).toContain("estacoda setup --interactive");
  });

  it("preserves injected launch prompts without creating a factory prompt", async () => {
    Object.defineProperty(process.stdin, "isTTY", {
      value: true,
      configurable: true
    });
    const prompt = confirmationPrompt("n");

    const result = await launchInteractiveSession({
      workspaceRoot: join(tempDir, "workspace"),
      homeDir: tempDir,
      prompt,
      collectSetupRoute: async () => setupRouteDecision("configured-degraded", "Setup has warnings."),
      loadRuntimeConfig: async () => ({ ui: { language: "en" } }) as any
    });

    expect(interactivePromptMock.createInteractivePrompt).not.toHaveBeenCalled();
    expect(result.launched).toBe(false);
    expect(result.output).toContain("Launch skipped");
  });

  it("routes broken config to setup instead of throwing during launch locale loading", async () => {
    Object.defineProperty(process.stdin, "isTTY", {
      value: true,
      configurable: true
    });
    const workspaceRoot = join(tempDir, "workspace");
    await mkdir(join(tempDir, ".estacoda"), { recursive: true });
    await mkdir(workspaceRoot, { recursive: true });
    await writeFile(join(tempDir, ".estacoda", "config.json"), "{not-json", "utf8");

    const result = await launchInteractiveSession({
      workspaceRoot,
      homeDir: tempDir,
      prompt: confirmationPrompt("y")
    });

    expect(result.launched).toBe(false);
    expect(result.onboardingTriggered).toBe(false);
    expect(result.locale).toBe("en");
    expect(result.output).toContain("estacoda setup --interactive");
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
        provider: "local",
        model: "ollama/auto",
        enableNetwork: false
      }
    });
    await setupUiConfig({
      workspaceRoot,
      homeDir: tempDir,
      input: {
        language: "ar"
      }
    });
    await trustWorkspace(workspaceRoot, tempDir);

    const result = await launchInteractiveSession({ workspaceRoot, homeDir: tempDir, prompt: confirmationPrompt("y") });

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
        provider: "local",
        model: "ollama/auto",
        enableNetwork: false
      }
    });
    await setupUiConfig({
      workspaceRoot,
      homeDir: tempDir,
      input: {
        language: "ar"
      }
    });
    await trustWorkspace(workspaceRoot, tempDir);

    const settings = await runCliCommand({
      argv: ["settings", "ui", "--language", "en"],
      workspaceRoot,
      homeDir: tempDir
    });
    const result = await launchInteractiveSession({ workspaceRoot, homeDir: tempDir, prompt: confirmationPrompt("y") });

    expect(settings.exitCode).toBe(0);
    expect(settings.output).toContain("UI language: en.");
    expect(result.launched).toBe(true);
    expect(result.locale).toBe("en");
  });

  it("does not launch a configured provider in an untrusted workspace", async () => {
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
        provider: "local",
        model: "ollama/auto",
        enableNetwork: false
      }
    });

    const result = await launchInteractiveSession({ workspaceRoot, homeDir: tempDir });

    expect(result.launched).toBe(false);
    expect(result.onboardingTriggered).toBe(false);
    expect(result.output).toContain("Workspace trust is required");
  });

  it("reloads config and trust state at launch time", async () => {
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
        provider: "local",
        model: "ollama/auto",
        enableNetwork: false
      }
    });

    const beforeTrust = await launchInteractiveSession({ workspaceRoot, homeDir: tempDir });
    await setupUiConfig({
      workspaceRoot,
      homeDir: tempDir,
      input: {
        language: "ar"
      }
    });
    await trustWorkspace(workspaceRoot, tempDir);
    const afterTrust = await launchInteractiveSession({
      workspaceRoot,
      homeDir: tempDir,
      prompt: confirmationPrompt("y")
    });

    expect(beforeTrust.launched).toBe(false);
    expect(beforeTrust.output).toContain("Workspace trust is required");
    expect(afterTrust.launched).toBe(true);
    expect(afterTrust.exitCode).toBe(0);
    expect(afterTrust.locale).toBe("ar");
  });
});

async function trustWorkspace(workspaceRoot: string, homeDir: string): Promise<void> {
  await new WorkspaceTrustStore({ path: join(homeDir, ".estacoda", "trust.json") }).grant(workspaceRoot, {
    label: "test"
  });
}

function confirmationPrompt(answer: string): Prompt {
  return Object.assign(
    async () => answer,
    { close: () => undefined }
  ) as Prompt;
}

function setupRouteDecision(stateKind: string, summary: string): any {
  return {
    kind: stateKind === "configured-degraded" ? "configured-degraded-menu" : "first-run-onboarding",
    title: "Setup",
    summary,
    state: { kind: stateKind },
    actions: [],
    warnings: [],
    blockers: [],
    readOnly: false
  };
}
