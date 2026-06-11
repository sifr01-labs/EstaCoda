import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCliCommand } from "./cli.js";
import type { Prompt } from "./readline-prompt.js";

const readlineMock = vi.hoisted(() => ({
  prompt: vi.fn(),
  close: vi.fn(),
  createReadlinePrompt: vi.fn(),
}));

vi.mock("./readline-prompt.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./readline-prompt.js")>();
  return {
    ...actual,
    createReadlinePrompt: readlineMock.createReadlinePrompt,
  };
});

describe("runCliCommand WhatsApp dispatch", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "estacoda-cli-whatsapp-"));
    readlineMock.prompt.mockReset();
    readlineMock.close.mockReset();
    readlineMock.createReadlinePrompt.mockReset();
    readlineMock.createReadlinePrompt.mockReturnValue(Object.assign(readlineMock.prompt, {
      close: readlineMock.close
    }));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("dispatches estacoda whatsapp to the single setup wizard", async () => {
    const result = await runCliCommand({
      argv: ["whatsapp"],
      workspaceRoot: tempDir,
      homeDir: tempDir,
      prompt: fakePrompt(["cancel"]),
      whatsappWizardDependencies: {
        getDependencyStatus: async () => ({
          bridgeDir: "/tmp/bridge",
          packagePresent: true,
          lockfilePresent: true,
          entrypointPresent: true,
          nodeModulesPresent: true,
          missing: [],
        }),
        installDependencies: vi.fn(),
        pairDevice: vi.fn(),
      },
    });

    expect(result.handled).toBe(true);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("⌘ WhatsApp Setup");
  });

  it("creates and closes a prompt for estacoda whatsapp when none is injected", async () => {
    readlineMock.prompt.mockResolvedValue("n");

    const result = await runCliCommand({
      argv: ["whatsapp"],
      workspaceRoot: tempDir,
      homeDir: tempDir,
      whatsappWizardDependencies: {
        getDependencyStatus: async () => ({
          bridgeDir: "/tmp/bridge",
          packagePresent: true,
          lockfilePresent: true,
          entrypointPresent: true,
          nodeModulesPresent: false,
          missing: ["node_modules"],
        }),
        installDependencies: vi.fn(),
        pairDevice: vi.fn(),
      },
    });

    expect(result.handled).toBe(true);
    expect(result.exitCode).toBe(1);
    expect(readlineMock.createReadlinePrompt).toHaveBeenCalledOnce();
    expect(readlineMock.prompt).toHaveBeenCalledWith(expect.stringContaining("npm ci"));
    expect(readlineMock.close).toHaveBeenCalledOnce();
  });

  it("does not close an injected WhatsApp prompt", async () => {
    const close = vi.fn();
    const prompt = Object.assign(fakePrompt(["cancel"]), { close });

    const result = await runCliCommand({
      argv: ["whatsapp"],
      workspaceRoot: tempDir,
      homeDir: tempDir,
      prompt,
      whatsappWizardDependencies: {
        getDependencyStatus: async () => ({
          bridgeDir: "/tmp/bridge",
          packagePresent: true,
          lockfilePresent: true,
          entrypointPresent: true,
          nodeModulesPresent: true,
          missing: [],
        }),
        installDependencies: vi.fn(),
        pairDevice: vi.fn(),
      },
    });

    expect(result.handled).toBe(true);
    expect(result.exitCode).toBe(1);
    expect(close).not.toHaveBeenCalled();
  });

  it("does not expose WhatsApp subcommands", async () => {
    const result = await runCliCommand({
      argv: ["whatsapp", "status"],
      workspaceRoot: tempDir,
      homeDir: tempDir,
    });

    expect(result.handled).toBe(true);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("single command");
  });
});

function fakePrompt(answers: string[]): Prompt {
  const prompt = vi.fn(async () => answers.shift() ?? "");
  return prompt as unknown as Prompt;
}
