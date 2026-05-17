import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { launchInteractiveSession } from "./interactive-launcher.js";
import { runCliCommand } from "./cli.js";
import { setupProviderConfig, setupUiConfig } from "../config/runtime-config.js";
import { WorkspaceTrustStore } from "../security/workspace-trust-store.js";
import type { Prompt } from "./readline-prompt.js";

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
