import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCliCommand } from "./cli.js";
import type { Prompt } from "./readline-prompt.js";
import { CronStore } from "../cron/cron-store.js";
import { InMemorySessionDB } from "../session/in-memory-session-db.js";
import type { Runtime } from "../runtime/create-runtime.js";
import { resolveProfileStateHome } from "../config/profile-home.js";

const readlineMock = vi.hoisted(() => ({
  prompt: vi.fn(),
  close: vi.fn(),
  createReadlinePrompt: vi.fn(),
}));

const updateCommandMock = vi.hoisted(() => ({
  runUpdateCommand: vi.fn(),
}));

vi.mock("./readline-prompt.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./readline-prompt.js")>();
  return {
    ...actual,
    createReadlinePrompt: readlineMock.createReadlinePrompt,
  };
});

vi.mock("./update-command.js", () => ({
  runUpdateCommand: updateCommandMock.runUpdateCommand,
}));

describe("runCliCommand update dispatch", () => {
  beforeEach(() => {
    updateCommandMock.runUpdateCommand.mockReset();
    updateCommandMock.runUpdateCommand.mockResolvedValue({
      exitCode: 0,
      output: "update ok"
    });
  });

  it("passes default gateway restart mode to estacoda update", async () => {
    const result = await runCliCommand({
      argv: ["update"],
      workspaceRoot: "/tmp/workspace",
      homeDir: "/tmp/home",
    });

    expect(result.handled).toBe(true);
    expect(result.output).toBe("update ok");
    expect(updateCommandMock.runUpdateCommand).toHaveBeenCalledWith(expect.objectContaining({
      dryRun: false,
      apply: true,
      explicitApply: false,
      gatewayMode: false,
      gatewayRestart: "auto",
    }));
  });

  it("passes explicit gateway restart mode to estacoda update --gateway", async () => {
    await runCliCommand({
      argv: ["update", "--gateway"],
      workspaceRoot: "/tmp/workspace",
      homeDir: "/tmp/home",
    });

    expect(updateCommandMock.runUpdateCommand).toHaveBeenCalledWith(expect.objectContaining({
      gatewayMode: true,
      gatewayRestart: "always",
    }));
  });

  it("lets --no-restart-gateway override estacoda update --gateway", async () => {
    await runCliCommand({
      argv: ["update", "--apply", "--gateway", "--no-restart-gateway"],
      workspaceRoot: "/tmp/workspace",
      homeDir: "/tmp/home",
    });

    expect(updateCommandMock.runUpdateCommand).toHaveBeenCalledWith(expect.objectContaining({
      apply: true,
      explicitApply: true,
      gatewayMode: true,
      gatewayRestart: "never",
    }));
  });
});

describe("runCliCommand cron dispatch", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "estacoda-cli-cron-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("creates an isolated runtime for top-level estacoda cron tick", async () => {
    const store = new CronStore({ homeDir: tempDir });
    const job = await store.create({
      name: "CLI tick baseline",
      schedule: "* * * * *",
      prompt: "run me"
    });
    await store.requestRun(job.id);
    const interactiveHandle = vi.fn(async () => ({ text: "interactive runtime should not run" }));
    const cronHandle = vi.fn(async () => ({ text: "cron isolated runtime" }));
    const cronDispose = vi.fn(async () => undefined);
    const runtime = {
      handle: interactiveHandle,
      dispose: vi.fn(async () => undefined),
      sessionDb: new InMemorySessionDB(),
      sessionId: "interactive-runtime",
      trajectoryId: "interactive-trajectory"
    } as unknown as Runtime;
    const cronRuntimeFactory = vi.fn(async (runtimeOptions) => ({
      handle: cronHandle,
      dispose: cronDispose,
      sessionDb: runtimeOptions.sessionDb ?? new InMemorySessionDB(),
      sessionId: runtimeOptions.sessionId,
      trajectoryId: "cron-trajectory"
    }) as unknown as Runtime);

    const result = await runCliCommand({
      argv: ["cron", "tick"],
      workspaceRoot: tempDir,
      homeDir: tempDir,
      runtime,
      cronRuntimeFactory
    });

    expect(result.handled).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("Cron tick complete. Ran 1 job(s).");
    expect(interactiveHandle).not.toHaveBeenCalled();
    expect(cronHandle).toHaveBeenCalledTimes(1);
    expect(cronDispose).toHaveBeenCalledTimes(1);
    expect(cronRuntimeFactory).toHaveBeenCalledTimes(1);
    const runtimeOptions = cronRuntimeFactory.mock.calls[0]?.[0];
    expect(runtimeOptions).toEqual(expect.objectContaining({
      disableCronTools: true,
      sessionId: expect.stringMatching(/^cron-/u)
    }));
    expect(runtimeOptions?.disabledToolsets).toEqual(["cron", "messaging", "clarify"]);
    expect(runtimeOptions?.sessionDb).toBe(runtime.sessionDb);
  });

  it("runs read-only cron list without loading runtime config", async () => {
    const profilePaths = resolveProfileStateHome({ homeDir: tempDir, profileId: "broken" });
    await mkdir(profilePaths.configPath, { recursive: true });

    const result = await runCliCommand({
      argv: ["cron", "list"],
      workspaceRoot: tempDir,
      homeDir: tempDir,
      profileId: "broken"
    });

    expect(result.handled).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("No cron jobs configured");
  });
});

describe("runCliCommand model setup codex dispatch", () => {
  let tempDir: string;
  let originalStdinIsTty: boolean | undefined;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "estacoda-cli-codex-"));
    originalStdinIsTty = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: true,
    });
    readlineMock.prompt.mockReset();
    readlineMock.close.mockReset();
    readlineMock.createReadlinePrompt.mockReset();
    readlineMock.createReadlinePrompt.mockReturnValue(Object.assign(readlineMock.prompt, {
      close: readlineMock.close,
    }));
  });

  afterEach(async () => {
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: originalStdinIsTty,
    });
    await rm(tempDir, { recursive: true, force: true });
  });

  it("creates an interactive prompt for direct Codex setup instead of silently cancelling", async () => {
    readlineMock.prompt.mockResolvedValue("2");

    const result = await runCliCommand({
      argv: ["model", "setup", "codex"],
      workspaceRoot: tempDir,
      homeDir: tempDir,
    });

    expect(result.handled).toBe(true);
    expect(result.output).toBe("Cancelled. No changes were made.");
    expect(readlineMock.createReadlinePrompt).toHaveBeenCalledOnce();
    expect(readlineMock.prompt).toHaveBeenCalledWith(expect.stringContaining("Codex requires OAuth authentication."));
    expect(readlineMock.close).toHaveBeenCalledOnce();
  });
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
