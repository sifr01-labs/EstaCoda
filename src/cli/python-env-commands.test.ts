import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCliCommand } from "./cli.js";
import type { Prompt } from "./prompt-contract.js";
import {
  DDGS_CAPABILITY_ID,
  registerPythonCapabilitySpecForTest,
  resetPythonCapabilityRegistryForTest
} from "../python-env/capability-registry.js";
import { resolveGlobalStateHome } from "../config/profile-home.js";
import { resolveManagedPythonCapabilityPaths } from "../python-env/capability-paths.js";
import type { ManagedPythonCapabilityEnvManifest } from "../python-env/manifest.js";

const capabilityManagerMock = vi.hoisted(() => ({
  checkManagedPythonCapabilityStatus: vi.fn(),
  installManagedPythonCapabilityEnvironment: vi.fn(),
  verifyManagedPythonCapabilityEnvironment: vi.fn()
}));

const interactivePromptMock = vi.hoisted(() => ({
  prompt: vi.fn(),
  close: vi.fn(),
  createInteractivePrompt: vi.fn()
}));

vi.mock("../python-env/capability-manager.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../python-env/capability-manager.js")>();
  return {
    ...actual,
    checkManagedPythonCapabilityStatus: capabilityManagerMock.checkManagedPythonCapabilityStatus,
    installManagedPythonCapabilityEnvironment: capabilityManagerMock.installManagedPythonCapabilityEnvironment,
    verifyManagedPythonCapabilityEnvironment: capabilityManagerMock.verifyManagedPythonCapabilityEnvironment
  };
});

vi.mock("./create-interactive-prompt.js", () => ({
  createInteractivePrompt: interactivePromptMock.createInteractivePrompt
}));

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "estacoda-python-env-cli-test-"));
}

function registerFakeCapability(): void {
  registerPythonCapabilitySpecForTest({
    id: "fake-capability",
    version: "0.1.0",
    packages: ["demo-package==1.2.3"],
    verifyImports: ["json"],
    optionalGroups: {
      extra: {
        packages: ["demo-extra==2.0.0"],
        verifyImports: ["email"]
      },
      reports: {
        packages: ["demo-reports==3.0.0"],
        verifyImports: ["csv"]
      }
    }
  });
}

function manifest(homeDir: string, overrides: Partial<ManagedPythonCapabilityEnvManifest> = {}): ManagedPythonCapabilityEnvManifest {
  const stateRoot = resolveGlobalStateHome({ homeDir }).stateRoot;
  const paths = resolveManagedPythonCapabilityPaths({ stateRoot, capabilityId: "fake-capability" });
  return {
    id: "fake-capability",
    version: "0.1.0",
    specHash: "hash-current",
    installedPackages: ["demo-package==1.2.3"],
    installedGroups: [],
    pythonPath: paths.pythonPath,
    envPath: paths.envPath,
    createdAt: "2026-06-13T00:00:00.000Z",
    updatedAt: "2026-06-13T00:00:00.000Z",
    status: "verified",
    ...overrides
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

describe("python-env CLI commands", () => {
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await makeTempDir();
    resetPythonCapabilityRegistryForTest();
    registerFakeCapability();
    capabilityManagerMock.checkManagedPythonCapabilityStatus.mockReset();
    capabilityManagerMock.installManagedPythonCapabilityEnvironment.mockReset();
    capabilityManagerMock.verifyManagedPythonCapabilityEnvironment.mockReset();
    interactivePromptMock.prompt.mockReset();
    interactivePromptMock.close.mockReset();
    interactivePromptMock.createInteractivePrompt.mockReset();
    interactivePromptMock.createInteractivePrompt.mockReturnValue(Object.assign(interactivePromptMock.prompt, {
      close: interactivePromptMock.close
    }));
    capabilityManagerMock.checkManagedPythonCapabilityStatus.mockImplementation(async ({ capabilityId }: { capabilityId: string }) => ({
      ok: false,
      capabilityId,
      reason: "install_required",
      message: "Managed Python capability environment has not been installed."
    }));
  });

  afterEach(async () => {
    resetPythonCapabilityRegistryForTest();
    await rm(homeDir, { recursive: true, force: true });
  });

  it("routes python-env help through the top-level CLI", async () => {
    const result = await runCliCommand({
      argv: ["python-env", "--help"],
      workspaceRoot: homeDir,
      homeDir
    });

    expect(result.handled).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("estacoda python-env list");
    expect(result.output).toContain("estacoda python-env reset <id> [--yes]");
  });

  it("lists registered capabilities without installing", async () => {
    const result = await runCliCommand({
      argv: ["python-env", "list"],
      workspaceRoot: homeDir,
      homeDir
    });

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("fake-capability");
    expect(result.output).toContain("missing");
    expect(capabilityManagerMock.installManagedPythonCapabilityEnvironment).not.toHaveBeenCalled();
    expect(capabilityManagerMock.verifyManagedPythonCapabilityEnvironment).not.toHaveBeenCalled();
  });

  it("reports missing status without installing", async () => {
    const stateRoot = resolveGlobalStateHome({ homeDir }).stateRoot;
    const paths = resolveManagedPythonCapabilityPaths({ stateRoot, capabilityId: "fake-capability" });

    const result = await runCliCommand({
      argv: ["python-env", "status", "fake-capability"],
      workspaceRoot: homeDir,
      homeDir
    });

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("State: missing");
    expect(result.output).toContain(`Env path: ${paths.envPath}`);
    expect(result.output).toContain("Manifest: missing");
    expect(result.output).toContain("Repair hint: estacoda python-env setup fake-capability --yes");
    expect(capabilityManagerMock.installManagedPythonCapabilityEnvironment).not.toHaveBeenCalled();
  });

  it("preserves a selected group in status repair hints", async () => {
    const result = await runCliCommand({
      argv: ["python-env", "status", "fake-capability", "--group", "extra"],
      workspaceRoot: homeDir,
      homeDir
    });

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("Selected groups: extra");
    expect(result.output).toContain("Repair hint: estacoda python-env setup fake-capability --group extra --yes");
    expect(capabilityManagerMock.installManagedPythonCapabilityEnvironment).not.toHaveBeenCalled();
  });

  it("preserves selected groups in status repair hints", async () => {
    capabilityManagerMock.checkManagedPythonCapabilityStatus.mockResolvedValue({
      ok: false,
      capabilityId: "fake-capability",
      reason: "upgrade_required",
      message: "Managed Python capability environment needs an upgrade."
    });

    const result = await runCliCommand({
      argv: ["python-env", "status", "fake-capability", "--groups", "reports,extra"],
      workspaceRoot: homeDir,
      homeDir
    });

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("Selected groups: extra, reports");
    expect(result.output).toContain("Repair hint: estacoda python-env upgrade fake-capability --group extra --group reports --yes");
    expect(capabilityManagerMock.installManagedPythonCapabilityEnvironment).not.toHaveBeenCalled();
  });

  it("runs setup only after explicit approval for package installation", async () => {
    capabilityManagerMock.installManagedPythonCapabilityEnvironment.mockResolvedValue({
      ok: true,
      capabilityId: "fake-capability",
      version: "0.1.0",
      specHash: "hash-current",
      installedGroups: ["extra"],
      installedPackages: ["demo-package==1.2.3", "demo-extra==2.0.0"],
      pythonPath: "/state/python-envs/fake-capability/bin/python",
      envPath: "/state/python-envs/fake-capability",
      manifest: manifest(homeDir, { installedGroups: ["extra"] })
    });

    const denied = await runCliCommand({
      argv: ["python-env", "setup", "fake-capability", "--group", "extra"],
      workspaceRoot: homeDir,
      homeDir
    });

    expect(denied.exitCode).toBe(1);
    expect(denied.output).toContain("--yes");
    expect(capabilityManagerMock.installManagedPythonCapabilityEnvironment).not.toHaveBeenCalled();

    const approved = await runCliCommand({
      argv: ["python-env", "setup", "fake-capability", "--group", "extra", "--yes"],
      workspaceRoot: homeDir,
      homeDir
    });

    expect(approved.exitCode).toBe(0);
    expect(approved.output).toContain("setup complete");
    expect(capabilityManagerMock.installManagedPythonCapabilityEnvironment).toHaveBeenCalledWith(expect.objectContaining({
      stateRoot: resolveGlobalStateHome({ homeDir }).stateRoot,
      capabilityId: "fake-capability",
      groups: ["extra"]
    }));
  });

  it("routes owned setup confirmations through the interactive prompt factory", async () => {
    const originalStdinIsTty = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: true
    });
    interactivePromptMock.prompt.mockResolvedValue("yes");
    capabilityManagerMock.installManagedPythonCapabilityEnvironment.mockResolvedValue({
      ok: true,
      capabilityId: "fake-capability",
      version: "0.1.0",
      specHash: "hash-current",
      installedGroups: [],
      installedPackages: ["demo-package==1.2.3"],
      pythonPath: "/state/python-envs/fake-capability/bin/python",
      envPath: "/state/python-envs/fake-capability",
      manifest: manifest(homeDir)
    });

    try {
      const result = await runCliCommand({
        argv: ["python-env", "setup", "fake-capability"],
        workspaceRoot: homeDir,
        homeDir
      });

      expect(result.exitCode).toBe(0);
      expect(interactivePromptMock.createInteractivePrompt).toHaveBeenCalledOnce();
      expect(interactivePromptMock.prompt).toHaveBeenCalledWith("Install pinned Python packages for 'fake-capability'? [y/N] ");
      expect(interactivePromptMock.close).toHaveBeenCalledOnce();
    } finally {
      Object.defineProperty(process.stdin, "isTTY", {
        configurable: true,
        value: originalStdinIsTty
      });
    }
  });

  it("keeps injected setup prompts on the explicit prompt path", async () => {
    const prompt = Object.assign(fakePrompt(["yes"]), { close: vi.fn() });
    capabilityManagerMock.installManagedPythonCapabilityEnvironment.mockResolvedValue({
      ok: true,
      capabilityId: "fake-capability",
      version: "0.1.0",
      specHash: "hash-current",
      installedGroups: [],
      installedPackages: ["demo-package==1.2.3"],
      pythonPath: "/state/python-envs/fake-capability/bin/python",
      envPath: "/state/python-envs/fake-capability",
      manifest: manifest(homeDir)
    });

    const result = await runCliCommand({
      argv: ["python-env", "setup", "fake-capability"],
      workspaceRoot: homeDir,
      homeDir,
      prompt
    });

    expect(result.exitCode).toBe(0);
    expect(interactivePromptMock.createInteractivePrompt).not.toHaveBeenCalled();
    expect(prompt.close).not.toHaveBeenCalled();
  });

  it("runs verify without installing packages", async () => {
    capabilityManagerMock.verifyManagedPythonCapabilityEnvironment.mockResolvedValue({
      ok: true,
      capabilityId: "fake-capability",
      version: "0.1.0",
      specHash: "hash-current",
      installedGroups: [],
      installedPackages: ["demo-package==1.2.3"],
      pythonPath: "/state/python-envs/fake-capability/bin/python",
      envPath: "/state/python-envs/fake-capability",
      manifest: manifest(homeDir)
    });

    const result = await runCliCommand({
      argv: ["python-env", "verify", "fake-capability"],
      workspaceRoot: homeDir,
      homeDir
    });

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("verify complete");
    expect(capabilityManagerMock.verifyManagedPythonCapabilityEnvironment).toHaveBeenCalledTimes(1);
    expect(capabilityManagerMock.installManagedPythonCapabilityEnvironment).not.toHaveBeenCalled();
  });

  it("accepts DDGS status setup and verify through the registered capability list", async () => {
    const stateRoot = resolveGlobalStateHome({ homeDir }).stateRoot;
    const paths = resolveManagedPythonCapabilityPaths({ stateRoot, capabilityId: DDGS_CAPABILITY_ID });
    capabilityManagerMock.installManagedPythonCapabilityEnvironment.mockResolvedValue({
      ok: true,
      capabilityId: DDGS_CAPABILITY_ID,
      version: "9.14.4",
      specHash: "ddgs-hash",
      installedGroups: [],
      installedPackages: ["ddgs==9.14.4"],
      pythonPath: paths.pythonPath,
      envPath: paths.envPath,
      manifest: {
        id: DDGS_CAPABILITY_ID,
        version: "9.14.4",
        specHash: "ddgs-hash",
        installedPackages: ["ddgs==9.14.4"],
        installedGroups: [],
        pythonPath: paths.pythonPath,
        envPath: paths.envPath,
        createdAt: "2026-06-13T00:00:00.000Z",
        updatedAt: "2026-06-13T00:00:00.000Z",
        status: "verified"
      }
    });
    capabilityManagerMock.verifyManagedPythonCapabilityEnvironment.mockResolvedValue({
      ok: true,
      capabilityId: DDGS_CAPABILITY_ID,
      version: "9.14.4",
      specHash: "ddgs-hash",
      installedGroups: [],
      installedPackages: ["ddgs==9.14.4"],
      pythonPath: paths.pythonPath,
      envPath: paths.envPath,
      manifest: {
        id: DDGS_CAPABILITY_ID,
        version: "9.14.4",
        specHash: "ddgs-hash",
        installedPackages: ["ddgs==9.14.4"],
        installedGroups: [],
        pythonPath: paths.pythonPath,
        envPath: paths.envPath,
        createdAt: "2026-06-13T00:00:00.000Z",
        updatedAt: "2026-06-13T00:00:00.000Z",
        status: "verified"
      }
    });

    const status = await runCliCommand({
      argv: ["python-env", "status", DDGS_CAPABILITY_ID],
      workspaceRoot: homeDir,
      homeDir
    });
    expect(status.exitCode).toBe(0);
    expect(status.output).toContain("Capability: ddgs");
    expect(status.output).toContain("Version: 9.14.4");

    const deniedSetup = await runCliCommand({
      argv: ["python-env", "setup", DDGS_CAPABILITY_ID],
      workspaceRoot: homeDir,
      homeDir
    });
    expect(deniedSetup.exitCode).toBe(1);
    expect(deniedSetup.output).toContain("Packages: ddgs==9.14.4");
    expect(capabilityManagerMock.installManagedPythonCapabilityEnvironment).not.toHaveBeenCalled();

    const setup = await runCliCommand({
      argv: ["python-env", "setup", DDGS_CAPABILITY_ID, "--yes"],
      workspaceRoot: homeDir,
      homeDir
    });
    expect(setup.exitCode).toBe(0);
    expect(capabilityManagerMock.installManagedPythonCapabilityEnvironment).toHaveBeenCalledWith(expect.objectContaining({
      stateRoot,
      capabilityId: DDGS_CAPABILITY_ID,
      groups: []
    }));

    const verify = await runCliCommand({
      argv: ["python-env", "verify", DDGS_CAPABILITY_ID],
      workspaceRoot: homeDir,
      homeDir
    });
    expect(verify.exitCode).toBe(0);
    expect(capabilityManagerMock.verifyManagedPythonCapabilityEnvironment).toHaveBeenCalledWith(expect.objectContaining({
      stateRoot,
      capabilityId: DDGS_CAPABILITY_ID,
      groups: []
    }));
  });

  it("handles upgrade-required and current upgrade states", async () => {
    capabilityManagerMock.checkManagedPythonCapabilityStatus.mockResolvedValueOnce({
      ok: true,
      status: "verified",
      capabilityId: "fake-capability",
      version: "0.1.0",
      specHash: "hash-current",
      installedGroups: [],
      installedPackages: ["demo-package==1.2.3"],
      pythonPath: "/state/python-envs/fake-capability/bin/python",
      envPath: "/state/python-envs/fake-capability",
      manifest: manifest(homeDir)
    });

    const current = await runCliCommand({
      argv: ["python-env", "upgrade", "fake-capability", "--yes"],
      workspaceRoot: homeDir,
      homeDir
    });

    expect(current.exitCode).toBe(0);
    expect(current.output).toContain("current and verified");
    expect(capabilityManagerMock.installManagedPythonCapabilityEnvironment).not.toHaveBeenCalled();

    capabilityManagerMock.checkManagedPythonCapabilityStatus.mockResolvedValueOnce({
      ok: false,
      capabilityId: "fake-capability",
      reason: "upgrade_required",
      message: "Spec changed.",
      manifest: manifest(homeDir, { specHash: "old-hash" })
    });
    capabilityManagerMock.installManagedPythonCapabilityEnvironment.mockResolvedValue({
      ok: true,
      capabilityId: "fake-capability",
      version: "0.1.0",
      specHash: "hash-current",
      installedGroups: [],
      installedPackages: ["demo-package==1.2.3"],
      pythonPath: "/state/python-envs/fake-capability/bin/python",
      envPath: "/state/python-envs/fake-capability",
      manifest: manifest(homeDir)
    });

    const upgraded = await runCliCommand({
      argv: ["python-env", "upgrade", "fake-capability", "--yes"],
      workspaceRoot: homeDir,
      homeDir
    });

    expect(upgraded.exitCode).toBe(0);
    expect(upgraded.output).toContain("upgrade complete");
    expect(capabilityManagerMock.installManagedPythonCapabilityEnvironment).toHaveBeenCalledTimes(1);
  });

  it("requires explicit approval before upgrade package installation", async () => {
    capabilityManagerMock.checkManagedPythonCapabilityStatus.mockResolvedValue({
      ok: false,
      capabilityId: "fake-capability",
      reason: "upgrade_required",
      message: "Spec changed.",
      manifest: manifest(homeDir, { specHash: "old-hash" })
    });

    const result = await runCliCommand({
      argv: ["python-env", "upgrade", "fake-capability"],
      workspaceRoot: homeDir,
      homeDir
    });

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("--yes");
    expect(capabilityManagerMock.installManagedPythonCapabilityEnvironment).not.toHaveBeenCalled();
  });

  it("requires confirmation before reset and deletes only the generic capability env path", async () => {
    const stateRoot = resolveGlobalStateHome({ homeDir }).stateRoot;
    const genericPaths = resolveManagedPythonCapabilityPaths({ stateRoot, capabilityId: "fake-capability" });
    const legacyFasterWhisperPath = join(stateRoot, "python-env");
    await mkdir(genericPaths.envPath, { recursive: true });
    await mkdir(legacyFasterWhisperPath, { recursive: true });
    await writeFile(join(genericPaths.envPath, "sentinel.txt"), "generic", "utf8");
    await writeFile(join(legacyFasterWhisperPath, "sentinel.txt"), "legacy", "utf8");

    const denied = await runCliCommand({
      argv: ["python-env", "reset", "fake-capability"],
      workspaceRoot: homeDir,
      homeDir
    });

    expect(denied.exitCode).toBe(1);
    expect(denied.output).toContain("--yes");
    expect(await exists(genericPaths.envPath)).toBe(true);

    const approved = await runCliCommand({
      argv: ["python-env", "reset", "fake-capability", "--yes"],
      workspaceRoot: homeDir,
      homeDir
    });

    expect(approved.exitCode).toBe(0);
    expect(await exists(genericPaths.envPath)).toBe(false);
    expect(await exists(legacyFasterWhisperPath)).toBe(true);
  });

  it("fails cleanly for unknown capability ids and optional groups", async () => {
    const unknownId = await runCliCommand({
      argv: ["python-env", "status", "unknown-capability"],
      workspaceRoot: homeDir,
      homeDir
    });
    expect(unknownId.exitCode).toBe(1);
    expect(unknownId.output).toContain("Unknown managed Python capability");

    const unknownGroup = await runCliCommand({
      argv: ["python-env", "setup", "fake-capability", "--group", "missing", "--yes"],
      workspaceRoot: homeDir,
      homeDir
    });
    expect(unknownGroup.exitCode).toBe(1);
    expect(unknownGroup.output).toContain("Unknown optional group 'missing'");
    expect(capabilityManagerMock.installManagedPythonCapabilityEnvironment).not.toHaveBeenCalled();
  });

  it("renders bounded and redacted diagnostics", async () => {
    capabilityManagerMock.installManagedPythonCapabilityEnvironment.mockResolvedValue({
      ok: false,
      capabilityId: "fake-capability",
      reason: "pip_install_failed",
      message: "Could not install managed Python capability packages.",
      diagnostic: `Authorization: Bearer sk-secret-token\n${"x".repeat(2_000)}`
    });

    const result = await runCliCommand({
      argv: ["python-env", "setup", "fake-capability", "--yes"],
      workspaceRoot: homeDir,
      homeDir
    });

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("pip_install_failed");
    expect(result.output).not.toContain("sk-secret-token");
    expect(result.output).toContain("[truncated]");
  });
});

function fakePrompt(answers: string[]): Prompt {
  const prompt = vi.fn(async () => answers.shift() ?? "");
  return prompt as unknown as Prompt;
}
