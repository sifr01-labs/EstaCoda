import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readConfig } from "../config/runtime-config.js";
import { resolveProfileStateHome } from "../config/profile-home.js";
import { WhatsAppBridgeRuntimeError } from "../channels/whatsapp-bridge-errors.js";
import { isolateLtr } from "../ui/bidi.js";
import {
  runWhatsAppWizard,
  type WhatsAppPairDeviceOptions,
  type WhatsAppWizardDependencies,
} from "./whatsapp-wizard.js";
import type { Prompt } from "./prompt-contract.js";

describe("runWhatsAppWizard", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "estacoda-whatsapp-wizard-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("declines bridge dependency install without mutating config", async () => {
    const prompt = fakePrompt(["n"]);
    const deps = depsWithMissingBridge();

    const result = await runWhatsAppWizard({
      workspaceRoot: tempDir,
      homeDir: tempDir,
      prompt,
      dependencies: deps,
    });

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Config was not changed");
    expect(deps.installDependencies).not.toHaveBeenCalled();
    expect(await configLoaded(tempDir)).toBe(false);
    expect(prompt).toHaveBeenCalledWith(expect.stringContaining("npm ci"));
  });

  it("leaves config unchanged when explicit dependency install fails", async () => {
    const deps = depsWithMissingBridge({
      installError: new WhatsAppBridgeRuntimeError({
        code: "whatsapp_bridge_install_timeout",
        message: "WhatsApp bridge dependency installation timed out.",
      }),
    });

    const result = await runWhatsAppWizard({
      workspaceRoot: tempDir,
      homeDir: tempDir,
      prompt: fakePrompt(["y"]),
      dependencies: deps,
    });

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("timed out");
    expect(await configLoaded(tempDir)).toBe(false);
  });

  it("cancels before QR pairing without mutating config", async () => {
    const deps = depsWithInstalledBridge();

    const result = await runWhatsAppWizard({
      workspaceRoot: tempDir,
      homeDir: tempDir,
      prompt: fakePrompt(["cancel"]),
      dependencies: deps,
    });

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Choose 1 for a dedicated WhatsApp number");
    expect(deps.pairDevice).not.toHaveBeenCalled();
    expect(await configLoaded(tempDir)).toBe(false);
  });

  it("times out QR pairing, stops before config write, and renders the timeout copy", async () => {
    const deps = depsWithInstalledBridge({
      pairDevice: vi.fn(async () => ({ ok: false as const, reason: "timeout" as const })),
    });

    const result = await runWhatsAppWizard({
      workspaceRoot: tempDir,
      homeDir: tempDir,
      prompt: fakePrompt(["1", "971501234567"]),
      dependencies: deps,
    });

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Pairing timed out - run estacoda whatsapp to try again.");
    expect(result.output).toContain("⌘ WhatsApp Setup");
    expect(await configLoaded(tempDir)).toBe(false);
  });

  it("streams pairing instructions before foreground bridge QR output", async () => {
    const writes: string[] = [];
    const deps = depsWithInstalledBridge({
      pairDevice: vi.fn(async (options) => {
        options.output.write("[QR]\n");
        return { ok: false as const, reason: "timeout" as const };
      }),
    });

    const result = await runWhatsAppWizard({
      workspaceRoot: tempDir,
      homeDir: tempDir,
      prompt: fakePrompt(["1", "971501234567"]),
      output: { write: (chunk) => writes.push(chunk) },
      dependencies: deps,
    });
    const streamed = writes.join("");

    expect(result.exitCode).toBe(1);
    expect(streamed.startsWith("⌘ WhatsApp Setup\n")).toBe(true);
    expect(streamed).toContain("WhatsApp pairing");
    expect(streamed).toContain("Scan this code with WhatsApp on your phone:");
    expect(streamed.indexOf("✓ Mode: dedicated WhatsApp number")).toBeLessThan(streamed.indexOf("Dedicated number setup"));
    expect(streamed.indexOf("✓ Allowed senders: 971501234567")).toBeLessThan(streamed.indexOf("Dedicated number setup"));
    expect(streamed.indexOf("✓ WhatsApp bridge dependencies ready")).toBeLessThan(streamed.indexOf("Dedicated number setup"));
    expect(streamed.indexOf("Scan this code with WhatsApp on your phone:")).toBeLessThan(streamed.indexOf("[QR]"));
    expect(result.output).toContain("Pairing timed out - run estacoda whatsapp to try again.");
    expect(await configLoaded(tempDir)).toBe(false);
  });

  it("fails QR pairing without writing config", async () => {
    const deps = depsWithInstalledBridge({
      pairDevice: vi.fn(async () => ({ ok: false as const, reason: "failed" as const, message: "socket closed" })),
    });

    const result = await runWhatsAppWizard({
      workspaceRoot: tempDir,
      homeDir: tempDir,
      prompt: fakePrompt(["1", "971501234567"]),
      dependencies: deps,
    });

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("WhatsApp QR pairing failed: socket closed");
    expect(await configLoaded(tempDir)).toBe(false);
  });

  it("writes WhatsApp config only after successful QR pairing with an allowlist", async () => {
    const deps = depsWithInstalledBridge({ pairDevice: successfulPairDevice("QR CODE\n") });

    const result = await runWhatsAppWizard({
      workspaceRoot: tempDir,
      homeDir: tempDir,
      prompt: fakePrompt(["1", "971501234567, abc123@lid"]),
      dependencies: deps,
    });

    const config = await readConfig(resolveProfileStateHome({ homeDir: tempDir, profileId: "default" }).configPath);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("QR CODE");
    expect(JSON.stringify(config.config)).not.toContain("QR CODE");
    expect(config.config.channels?.whatsapp).toMatchObject({
      enabled: true,
      experimental: true,
      mode: "bot",
      dmPolicy: "allowlist",
      pairingMode: "qr",
      allowedUsers: ["971501234567", "abc123@lid"],
    });
    expect(result.output).toContain("✓ Mode: dedicated WhatsApp number");
    expect(result.output).toContain("✓ Allowed senders: 971501234567, abc123@lid");
    expect(result.output).toContain("✓ WhatsApp bridge dependencies ready");
    expect(result.output).toContain("✓ WhatsApp linked");
    expect(result.output).toContain("✓ Session saved");
    expect(result.output).toContain("✓ Incoming messages restricted to: 971501234567, abc123@lid");
    expect(result.output).toContain("WhatsApp is ready.");
  });

  it.each([
    ["1", "bot"],
    ["bot", "bot"],
    ["dedicated", "bot"],
    ["2", "self-chat"],
    ["self", "self-chat"],
    ["self-chat", "self-chat"],
    ["personal", "self-chat"],
  ])("maps mode input %s to internal mode %s", async (answer, expectedMode) => {
    const deps = depsWithInstalledBridge({ pairDevice: successfulPairDevice() });

    const result = await runWhatsAppWizard({
      workspaceRoot: tempDir,
      homeDir: tempDir,
      prompt: fakePrompt([answer, "971501234567"]),
      dependencies: deps,
    });

    const config = await readConfig(resolveProfileStateHome({ homeDir: tempDir, profileId: "default" }).configPath);
    expect(result.exitCode).toBe(0);
    expect(config.config.channels?.whatsapp?.mode).toBe(expectedMode);
  });

  it("strips stale pairing-code and unknown WhatsApp config keys after successful QR setup", async () => {
    const paths = resolveProfileStateHome({ homeDir: tempDir, profileId: "default" });
    const authDir = join(paths.gatewayStatePath, "whatsapp-auth");
    await mkdir(authDir, { recursive: true });
    await writeFile(join(authDir, "creds.json"), "{}\n", "utf8");
    await mkdir(dirname(paths.configPath), { recursive: true });
    await writeFile(paths.configPath, JSON.stringify({
      channels: {
        whatsapp: {
          enabled: true,
          experimental: true,
          authDir,
          allowedUsers: ["old-user"],
          pairingMode: "qr",
          pairingCodePhoneNumber: "+15551234567",
          oldPairingCode: "123456",
          unknownKey: "stale",
        },
      },
    }), "utf8");

    const result = await runWhatsAppWizard({
      workspaceRoot: tempDir,
      homeDir: tempDir,
      prompt: fakePrompt(["dedicated", "971501234567"]),
      dependencies: depsWithInstalledBridge({ pairDevice: successfulPairDevice() }),
    });

    const config = await readConfig(paths.configPath);
    const whatsapp = config.config.channels?.whatsapp as Record<string, unknown>;
    expect(result.exitCode).toBe(0);
    expect(whatsapp).toEqual({
      enabled: true,
      experimental: true,
      authDir,
      allowedUsers: ["971501234567"],
      allowedGroups: [],
      mode: "bot",
      dmPolicy: "allowlist",
      groupPolicy: "disabled",
      mentionPatterns: [],
      freeResponseChats: [],
      replyPrefix: "EstaCoda: ",
      pairingMode: "qr",
    });
    expect(whatsapp).not.toHaveProperty("pairingCodePhoneNumber");
    expect(whatsapp).not.toHaveProperty("oldPairingCode");
    expect(whatsapp).not.toHaveProperty("unknownKey");
  });

  it("stores pairing-pending authorization when QR succeeds without allowed users", async () => {
    const deps = depsWithInstalledBridge({ pairDevice: successfulPairDevice() });

    const result = await runWhatsAppWizard({
      workspaceRoot: tempDir,
      homeDir: tempDir,
      prompt: fakePrompt(["2", ""]),
      dependencies: deps,
    });

    const config = await readConfig(resolveProfileStateHome({ homeDir: tempDir, profileId: "default" }).configPath);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("pairing-pending");
    expect(result.output).toContain("No allowed senders were added.");
    expect(result.output).not.toContain("allow anyone");
    expect(config.config.channels?.whatsapp).toMatchObject({
      enabled: true,
      experimental: true,
      mode: "self-chat",
      dmPolicy: "pairing",
      allowedUsers: [],
    });
  });

  it("re-pair clears only the profile-local WhatsApp auth directory", async () => {
    const paths = resolveProfileStateHome({ homeDir: tempDir, profileId: "default" });
    const authDir = join(paths.gatewayStatePath, "whatsapp-auth");
    const sibling = join(paths.gatewayStatePath, "keep.txt");
    await mkdir(authDir, { recursive: true });
    await writeFile(join(authDir, "old.txt"), "old", "utf8");
    await writeFile(sibling, "keep", "utf8");
    await mkdir(dirname(paths.configPath), { recursive: true });
    await writeFile(paths.configPath, JSON.stringify({
      channels: {
        whatsapp: {
          enabled: true,
          experimental: true,
          authDir,
          allowedUsers: ["971501234567"],
        },
      },
    }), "utf8");

    const deps = depsWithInstalledBridge({ pairDevice: successfulPairDevice() });
    const result = await runWhatsAppWizard({
      workspaceRoot: tempDir,
      homeDir: tempDir,
      prompt: fakePrompt(["y", "1", "971501234567"]),
      dependencies: deps,
    });

    expect(result.exitCode).toBe(0);
    await expect(readFile(join(authDir, "old.txt"), "utf8")).rejects.toThrow();
    await expect(readFile(sibling, "utf8")).resolves.toBe("keep");
  });

  it("rejects re-pair reset when authDir is the gateway state root", async () => {
    const paths = resolveProfileStateHome({ homeDir: tempDir, profileId: "default" });
    const keepFile = join(paths.gatewayStatePath, "keep.txt");
    await mkdir(paths.gatewayStatePath, { recursive: true });
    await writeFile(keepFile, "keep", "utf8");
    await writeWhatsAppConfig(paths.configPath, paths.gatewayStatePath);
    const deps = depsWithInstalledBridge();

    await expect(runWhatsAppWizard({
      workspaceRoot: tempDir,
      homeDir: tempDir,
      prompt: fakePrompt(["y"]),
      dependencies: deps,
    })).rejects.toThrow("Refusing to clear anything except");

    expect(deps.pairDevice).not.toHaveBeenCalled();
    await expect(readFile(keepFile, "utf8")).resolves.toBe("keep");
  });

  it("rejects re-pair reset for sibling profile-local directories", async () => {
    const paths = resolveProfileStateHome({ homeDir: tempDir, profileId: "default" });
    const siblingAuthDir = join(paths.gatewayStatePath, "not-whatsapp-auth");
    const keepFile = join(siblingAuthDir, "keep.txt");
    await mkdir(siblingAuthDir, { recursive: true });
    await writeFile(keepFile, "keep", "utf8");
    await writeWhatsAppConfig(paths.configPath, siblingAuthDir);
    const deps = depsWithInstalledBridge();

    await expect(runWhatsAppWizard({
      workspaceRoot: tempDir,
      homeDir: tempDir,
      prompt: fakePrompt(["y"]),
      dependencies: deps,
    })).rejects.toThrow("Refusing to clear anything except");

    expect(deps.pairDevice).not.toHaveBeenCalled();
    await expect(readFile(keepFile, "utf8")).resolves.toBe("keep");
  });

  it("rejects re-pair reset for paths outside the profile state root", async () => {
    const paths = resolveProfileStateHome({ homeDir: tempDir, profileId: "default" });
    const outsideAuthDir = join(tempDir, "outside-whatsapp-auth");
    const keepFile = join(outsideAuthDir, "keep.txt");
    await mkdir(outsideAuthDir, { recursive: true });
    await writeFile(keepFile, "keep", "utf8");
    await writeWhatsAppConfig(paths.configPath, outsideAuthDir);
    const deps = depsWithInstalledBridge();

    await expect(runWhatsAppWizard({
      workspaceRoot: tempDir,
      homeDir: tempDir,
      prompt: fakePrompt(["y"]),
      dependencies: deps,
    })).rejects.toThrow("Refusing to clear anything except");

    expect(deps.pairDevice).not.toHaveBeenCalled();
    await expect(readFile(keepFile, "utf8")).resolves.toBe("keep");
  });

  it("renders Arabic wizard copy while preserving technical tokens", async () => {
    const paths = resolveProfileStateHome({ homeDir: tempDir, profileId: "default" });
    await mkdir(dirname(paths.configPath), { recursive: true });
    await writeFile(paths.configPath, JSON.stringify({ ui: { language: "ar" } }), "utf8");

    const result = await runWhatsAppWizard({
      workspaceRoot: tempDir,
      homeDir: tempDir,
      prompt: fakePrompt(["1", "0507773879"]),
      dependencies: depsWithInstalledBridge({ pairDevice: successfulPairDevice() }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain(isolateLtr("WhatsApp"));
    expect(result.output).toContain(isolateLtr("WhatsApp Business"));
    expect(result.output).toContain("المرسلون المسموحون");
    expect(result.output).toContain("تم حفظ الجلسة");
  });

  it("uses setup-copy allowlist wording without advertising open access", async () => {
    const prompt = fakePrompt(["1", ""]);
    const result = await runWhatsAppWizard({
      workspaceRoot: tempDir,
      homeDir: tempDir,
      prompt,
      dependencies: depsWithInstalledBridge({ pairDevice: successfulPairDevice() }),
    });

    expect(result.exitCode).toBe(0);
    const promptText = JSON.stringify((prompt as unknown as { mock: { calls: unknown[][] } }).mock.calls);
    expect(result.output).toContain("⌘ WhatsApp Setup");
    expect(promptText).toContain("Who can message this agent?");
    expect(promptText).toContain("international format");
    expect(promptText).not.toContain("*");
  });
});

function fakePrompt(answers: string[]): Prompt {
  const prompt = vi.fn(async () => answers.shift() ?? "");
  return prompt as unknown as Prompt;
}

function depsWithMissingBridge(options: { installError?: unknown } = {}): WhatsAppWizardDependencies & {
  installDependencies: ReturnType<typeof vi.fn>;
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
    pairDevice: vi.fn(),
  };
}

function depsWithInstalledBridge(options: {
  pairDevice?: WhatsAppWizardDependencies["pairDevice"];
} = {}): WhatsAppWizardDependencies & { pairDevice: ReturnType<typeof vi.fn> } {
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
    pairDevice: vi.fn(options.pairDevice ?? successfulPairDevice()),
  };
}

function successfulPairDevice(qr = ""): (options: WhatsAppPairDeviceOptions) => Promise<{ ok: true }> {
  return async (options) => {
    if (qr.length > 0) options.output.write(qr);
    await mkdir(options.authDir, { recursive: true });
    await writeFile(join(options.authDir, "creds.json"), "{}\n", "utf8");
    return { ok: true };
  };
}

async function configLoaded(homeDir: string): Promise<boolean> {
  return (await readConfig(resolveProfileStateHome({ homeDir, profileId: "default" }).configPath)).loaded;
}

async function writeWhatsAppConfig(configPath: string, authDir: string): Promise<void> {
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, JSON.stringify({
    channels: {
      whatsapp: {
        enabled: true,
        experimental: true,
        authDir,
        allowedUsers: ["971501234567"],
      },
    },
  }), "utf8");
}
