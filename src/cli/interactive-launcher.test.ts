import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
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
    expect(result.kind).toBe("exit");
    expect(result.launched).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("requires a TTY");
  });

  it("routes first-run state directly to onboarding without consuming a prompt", async () => {
    Object.defineProperty(process.stdin, "isTTY", {
      value: true,
      configurable: true
    });
    const prompt = confirmationPrompt("n");

    const result = await launchInteractiveSession({
      workspaceRoot: join(tempDir, "workspace"),
      homeDir: tempDir,
      prompt
    });

    expect(result.kind).toBe("run-setup");
    if (result.kind !== "run-setup") throw new Error("Expected setup routing");
    expect(result.setupMode).toBe("onboarding");
    expect(result.locale).toBe("en");
    expect(prompt).not.toHaveBeenCalled();
  });

  it("routes a fresh home to onboarding without an intermediate setup confirmation", async () => {
    Object.defineProperty(process.stdin, "isTTY", {
      value: true,
      configurable: true
    });
    const workspaceRoot = join(tempDir, "workspace");
    await mkdir(workspaceRoot, { recursive: true });

    const prompt = confirmationPrompt("y");
    const result = await launchInteractiveSession({
      workspaceRoot,
      homeDir: tempDir,
      prompt
    });

    expect(result.kind).toBe("run-setup");
    if (result.kind !== "run-setup") throw new Error("Expected setup routing");
    expect(result.setupMode).toBe("onboarding");
    expect(result.exitCode).toBe(0);
    expect(result.locale).toBe("en");
    expect(result.output).toBe("");
    expect(prompt).not.toHaveBeenCalled();
  });

  it("offers degraded users limited launch, repair, and exit through the shared selector", async () => {
    Object.defineProperty(process.stdin, "isTTY", {
      value: true,
      configurable: true
    });
    const prompt = selectionPrompt("repair");
    interactivePromptMock.createInteractivePrompt.mockReturnValue(prompt);

    const result = await launchInteractiveSession({
      workspaceRoot: join(tempDir, "workspace"),
      homeDir: tempDir,
      collectSetupRoute: async () => setupRouteDecision("configured-degraded", "Setup has warnings."),
      loadRuntimeConfig: async () => ({ ui: { language: "en" } }) as any
    });

    expect(interactivePromptMock.createInteractivePrompt).toHaveBeenCalledOnce();
    expect(result.kind).toBe("run-setup");
    if (result.kind !== "run-setup") throw new Error("Expected repair routing");
    expect(result.setupMode).toBe("repair");
    expect(prompt.select).toHaveBeenCalledWith(expect.objectContaining({
      options: [
        expect.objectContaining({ id: "continue-limited", value: "limited" }),
        expect.objectContaining({ id: "repair-setup", value: "repair" }),
        expect.objectContaining({ id: "exit", value: "exit" }),
      ],
    }));
  });

  it("does not create a launch prompt for incomplete setup", async () => {
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

    expect(interactivePromptMock.createInteractivePrompt).not.toHaveBeenCalled();
    expect(result.kind).toBe("run-setup");
    if (result.kind !== "run-setup") throw new Error("Expected setup routing");
    expect(result.setupMode).toBe("onboarding");
    expect(result.output).toBe("");
  });

  it("launches configured-degraded setup only after explicit limited-mode acceptance", async () => {
    Object.defineProperty(process.stdin, "isTTY", {
      value: true,
      configurable: true
    });
    const prompt = selectionPrompt("limited");

    const result = await launchInteractiveSession({
      workspaceRoot: join(tempDir, "workspace"),
      homeDir: tempDir,
      prompt,
      collectSetupRoute: async () => setupRouteDecision("configured-degraded", "Setup has warnings."),
      loadRuntimeConfig: async () => ({ ui: { language: "en" } }) as any
    });

    expect(interactivePromptMock.createInteractivePrompt).not.toHaveBeenCalled();
    expect(result.kind).toBe("launch");
  });

  it("lets configured-degraded users exit without launching or opening repair", async () => {
    Object.defineProperty(process.stdin, "isTTY", {
      value: true,
      configurable: true
    });
    const prompt = selectionPrompt("exit");

    const result = await launchInteractiveSession({
      workspaceRoot: join(tempDir, "workspace"),
      homeDir: tempDir,
      prompt,
      collectSetupRoute: async () => setupRouteDecision("configured-degraded", "Setup has warnings."),
      loadRuntimeConfig: async () => ({ ui: { language: "en" } }) as any
    });

    expect(result.kind).toBe("exit");
    expect(result.exitCode).toBe(0);
    expect(result.output).toBe("Leave setup without launching.");
  });

  it("routes broken config to repair instead of throwing during launch locale loading", async () => {
    Object.defineProperty(process.stdin, "isTTY", {
      value: true,
      configurable: true
    });
    const workspaceRoot = join(tempDir, "workspace");
    await mkdir(workspaceRoot, { recursive: true });

    const result = await launchInteractiveSession({
      workspaceRoot,
      homeDir: tempDir,
      collectSetupRoute: async () => setupRouteDecision("broken-config", "Config is broken."),
      loadRuntimeConfig: async () => { throw new Error("broken config"); }
    });

    expect(result.kind).toBe("run-setup");
    if (result.kind !== "run-setup") throw new Error("Expected setup routing");
    expect(result.setupMode).toBe("repair");
    expect(result.locale).toBe("en");
    expect(result.output).toBe("");
  });

  it("returns state diagnostics with a nonzero exit when state is not writable", async () => {
    Object.defineProperty(process.stdin, "isTTY", {
      value: true,
      configurable: true
    });

    const result = await launchInteractiveSession({
      workspaceRoot: join(tempDir, "workspace"),
      homeDir: tempDir,
      collectSetupRoute: async () => ({
        ...setupRouteDecision("state-not-writable", "State cannot be written."),
        blockers: ["State path is read-only."],
      }),
      loadRuntimeConfig: async () => ({ ui: { language: "en" } }) as any
    });

    expect(result.kind).toBe("exit");
    expect(result.launched).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("State directory is not writable.");
    expect(result.output).toContain("State path is read-only.");
    expect(result.output).toContain("estacoda doctor");
    expect(interactivePromptMock.createInteractivePrompt).not.toHaveBeenCalled();
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

    const prompt = selectionPrompt("limited");
    const result = await launchInteractiveSession({ workspaceRoot, homeDir: tempDir, prompt });

    expect(result.kind).toBe("launch");
    expect(result.locale).toBe("ar");
    expect(prompt.select).toHaveBeenCalledWith(expect.objectContaining({
      title: expect.stringMatching(/تم إعداد.*تحذيرات/u),
      body: expect.stringContaining("الإعداد قابل للاستخدام مع تحذيرات"),
      options: expect.arrayContaining([
        expect.objectContaining({ id: "repair-setup", label: "أصلح الإعداد" }),
      ]),
    }));
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
    const result = await launchInteractiveSession({ workspaceRoot, homeDir: tempDir, prompt: selectionPrompt("limited") });

    expect(settings.exitCode).toBe(0);
    expect(settings.output).toContain("UI language: en.");
    expect(result.kind).toBe("launch");
    expect(result.locale).toBe("en");
  });

  it("routes a configured provider in an untrusted workspace to repair", async () => {
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

    expect(result.kind).toBe("run-setup");
    if (result.kind !== "run-setup") throw new Error("Expected setup routing");
    expect(result.setupMode).toBe("repair");
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
      prompt: selectionPrompt("limited")
    });

    expect(beforeTrust.kind).toBe("run-setup");
    expect(afterTrust.kind).toBe("launch");
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
    vi.fn(async () => answer),
    { close: () => undefined }
  ) as Prompt;
}

function selectionPrompt(answer: "limited" | "repair" | "exit"): Prompt {
  const prompt = confirmationPrompt("");
  prompt.select = vi.fn(async () => answer) as Prompt["select"];
  return prompt;
}

function setupRouteDecision(stateKind: string, summary: string): any {
  return {
    kind: stateKind === "new-user"
      ? "first-run-onboarding"
      : stateKind === "configured-degraded"
        ? "configured-degraded-menu"
        : stateKind === "configured-ready" || stateKind === "untrusted-workspace"
          ? "configured-menu"
          : "repair-first-menu",
    title: "Setup",
    summary,
    state: { kind: stateKind },
    actions: [],
    warnings: [],
    blockers: [],
    readOnly: false
  };
}
