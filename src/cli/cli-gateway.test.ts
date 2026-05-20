import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const childProcessMock = vi.hoisted(() => ({
  spawn: vi.fn(),
}));

const serviceManagerMock = vi.hoisted(() => ({
  detectServiceManager: vi.fn(),
  installService: vi.fn(),
  uninstallService: vi.fn(),
  probeServiceState: vi.fn(),
  restartService: vi.fn(),
  stopService: vi.fn(),
}));

const execResolverMock = vi.hoisted(() => ({
  resolveGatewayExec: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: childProcessMock.spawn,
  };
});

vi.mock("../gateway/service-manager.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../gateway/service-manager.js")>();
  return {
    ...actual,
    detectServiceManager: serviceManagerMock.detectServiceManager,
    installService: serviceManagerMock.installService,
    uninstallService: serviceManagerMock.uninstallService,
    probeServiceState: serviceManagerMock.probeServiceState,
    restartService: serviceManagerMock.restartService,
    stopService: serviceManagerMock.stopService,
  };
});

vi.mock("../gateway/service-exec-resolver.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../gateway/service-exec-resolver.js")>();
  return {
    ...actual,
    resolveGatewayExec: execResolverMock.resolveGatewayExec,
  };
});

import { runCliCommand } from "./cli.js";
import * as supervisorModule from "../gateway/supervisor.js";
import { resolveProfileStateHome } from "../config/profile-home.js";

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "estacoda-cli-gateway-test-"));
}

describe("cli gateway start", () => {
  let supervisorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    childProcessMock.spawn.mockReset();
    childProcessMock.spawn.mockReturnValue({
      pid: 12346,
      unref: vi.fn(),
    });
    serviceManagerMock.detectServiceManager.mockReset();
    serviceManagerMock.installService.mockReset();
    serviceManagerMock.uninstallService.mockReset();
    serviceManagerMock.probeServiceState.mockReset();
    serviceManagerMock.restartService.mockReset();
    serviceManagerMock.stopService.mockReset();
    execResolverMock.resolveGatewayExec.mockReset();
    serviceManagerMock.detectServiceManager.mockReturnValue("none");
    serviceManagerMock.installService.mockResolvedValue({ ok: true, mode: "compiled" });
    serviceManagerMock.uninstallService.mockResolvedValue({ ok: true });
    serviceManagerMock.restartService.mockResolvedValue({ ok: true });
    serviceManagerMock.stopService.mockResolvedValue({ ok: true });
    execResolverMock.resolveGatewayExec.mockReturnValue({
      ok: true,
      resolved: {
        mode: "compiled",
        command: "/usr/bin/node",
        args: ["/tmp/estacoda/dist/index.js"],
        cwd: "/tmp/estacoda",
      },
    });
    serviceManagerMock.probeServiceState.mockResolvedValue({
      kind: "none",
      installed: false,
      scope: "user",
      activeState: "unknown",
      profileId: "default",
    });
    supervisorSpy = vi.spyOn(supervisorModule, "runGatewaySupervisor").mockResolvedValue({
      ok: true,
      output: "Gateway started",
      polls: 0,
      processed: 0,
    });
  });

  afterEach(() => {
    supervisorSpy.mockRestore();
  });
  it("rejects --telegram with deprecation error", async () => {
    const result = await runCliCommand({
      argv: ["gateway", "start", "--telegram"],
      workspaceRoot: "/tmp",
    });
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("deprecated");
    expect(result.output).toContain("estacoda gateway start");
  });

  it("rejects --discord with deprecation error", async () => {
    const result = await runCliCommand({
      argv: ["gateway", "start", "--discord"],
      workspaceRoot: "/tmp",
    });
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("deprecated");
  });

  it("rejects --email with deprecation error", async () => {
    const result = await runCliCommand({
      argv: ["gateway", "start", "--email"],
      workspaceRoot: "/tmp",
    });
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("deprecated");
  });

  it("rejects --whatsapp with deprecation error", async () => {
    const result = await runCliCommand({
      argv: ["gateway", "start", "--whatsapp"],
      workspaceRoot: "/tmp",
    });
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("deprecated");
  });

  it("shows updated help text without per-channel flags", async () => {
    const result = await runCliCommand({
      argv: ["gateway"],
      workspaceRoot: "/tmp",
    });
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("estacoda gateway start");
    expect(result.output).not.toContain("--telegram");
    expect(result.output).toContain("estacoda gateway start --dry-run");
    expect(result.output).toContain("estacoda gateway start --background");
    expect(result.output).toContain("estacoda gateway restart");
    expect(result.output).toContain("estacoda gateway restart --graceful");
    expect(result.output).toContain("estacoda gateway install");
    expect(result.output).toContain("estacoda gateway uninstall");
  });

  it("runs --dry-run without entering the foreground supervisor or writing PID/lock state", async () => {
    const tmpDir = await makeTempDir();
    try {
      const paths = resolveProfileStateHome({ homeDir: tmpDir, profileId: "default" });
      await mkdir(join(paths.cronPath, "output"), { recursive: true });
      await mkdir(join(paths.cronPath, "locks"), { recursive: true });
      await mkdir(paths.logsPath, { recursive: true });

      const result = await runCliCommand({
        argv: ["gateway", "start", "--dry-run"],
        workspaceRoot: tmpDir,
        homeDir: tmpDir,
      });

      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("Adapters:");
      expect(result.output).toContain("Mode:");
      expect(result.output).toContain("Gateway lock: no active owner detected");
      expect(result.output).not.toContain("Gateway lock: available");
      expect(supervisorSpy).not.toHaveBeenCalled();
      await expect(readFile(join(tmpDir, ".estacoda", "gateway", "gateway.pid"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(join(tmpDir, ".estacoda", "gateway", "gateway.lock"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns a failing exit code when --dry-run readiness is blocked", async () => {
    const tmpDir = await makeTempDir();
    try {
      const result = await runCliCommand({
        argv: ["gateway", "start", "--dry-run"],
        workspaceRoot: tmpDir,
        homeDir: tmpDir,
      });

      expect(result.exitCode).toBe(1);
      expect(result.output).toContain("run estacoda init");
      expect(supervisorSpy).not.toHaveBeenCalled();
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("runs --background without entering the foreground supervisor", async () => {
    const tmpDir = await makeTempDir();
    try {
      const result = await runCliCommand({
        argv: ["gateway", "start", "--background"],
        workspaceRoot: tmpDir,
        homeDir: tmpDir,
      });

      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("Gateway started (PID 12346)");
      expect(result.output).toContain(join(resolveProfileStateHome({ homeDir: tmpDir, profileId: "default" }).logsPath, "gateway.log"));
      expect(supervisorSpy).not.toHaveBeenCalled();
      expect(childProcessMock.spawn).toHaveBeenCalledWith(
        expect.any(String),
        expect.arrayContaining(["gateway", "start"]),
        expect.objectContaining({ detached: true })
      );
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("parses gateway restart subcommand", async () => {
    const result = await runCliCommand({
      argv: ["gateway", "restart"],
      workspaceRoot: "/tmp",
    });
    expect(result.handled).toBe(true);
    // Will fail to start due to no config, but command is handled
    expect(result.output).toContain("Gateway was not running");
  });

  it("parses gateway restart --graceful", async () => {
    const result = await runCliCommand({
      argv: ["gateway", "restart", "--graceful"],
      workspaceRoot: "/tmp",
    });
    expect(result.handled).toBe(true);
    expect(result.output).toContain("Gateway was not running");
  });

  it("parses gateway stop --system", async () => {
    serviceManagerMock.detectServiceManager.mockReturnValue("systemd-user");
    serviceManagerMock.probeServiceState.mockResolvedValue({
      kind: "systemd-system",
      installed: true,
      scope: "system",
      activeState: "active",
      profileId: "default",
    });

    const result = await runCliCommand({
      argv: ["gateway", "stop", "--system"],
      workspaceRoot: "/tmp",
      homeDir: "/tmp/home",
    });

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("system scope");
    expect(serviceManagerMock.stopService).toHaveBeenCalledWith(expect.objectContaining({ system: true }));
  });

  it("parses gateway restart --system", async () => {
    serviceManagerMock.detectServiceManager.mockReturnValue("systemd-user");
    serviceManagerMock.probeServiceState.mockResolvedValue({
      kind: "systemd-system",
      installed: true,
      scope: "system",
      activeState: "active",
      profileId: "default",
    });

    const result = await runCliCommand({
      argv: ["gateway", "restart", "--system"],
      workspaceRoot: "/tmp",
      homeDir: "/tmp/home",
    });

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("system scope");
    expect(serviceManagerMock.restartService).toHaveBeenCalledWith(expect.objectContaining({ system: true }));
  });

  it("parses gateway install aliases and service flags", async () => {
    const result = await runCliCommand({
      argv: ["gateway", "install-service", "--profile", "work", "--system", "--run-as-user", "estacoda", "--home", "/home/estacoda", "--force"],
      workspaceRoot: "/tmp",
      homeDir: "/tmp/home",
    });

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("Gateway service installed");
    expect(serviceManagerMock.installService).toHaveBeenCalledWith(expect.objectContaining({
      profileId: "work",
      system: true,
      runAsUser: "estacoda",
      serviceHomeDir: "/home/estacoda",
      force: true,
    }));
  });

  it("parses gateway uninstall aliases and service flags", async () => {
    const result = await runCliCommand({
      argv: ["gateway", "uninstall-service", "--profile", "work", "--system"],
      workspaceRoot: "/tmp",
      homeDir: "/tmp/home",
    });

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("Gateway service uninstalled");
    expect(serviceManagerMock.uninstallService).toHaveBeenCalledWith(expect.objectContaining({
      profileId: "work",
      system: true,
    }));
  });
});

describe("cli channels enable extra arguments", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTempDir();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("rejects extra arguments and does not modify config", async () => {
    const configDir = join(tmpDir, ".estacoda");
    const configPath = join(configDir, "config.json");
    const originalConfig = JSON.stringify({ channels: { telegram: { enabled: false } } }, null, 2) + "\n";
    await mkdir(configDir, { recursive: true });
    await writeFile(configPath, originalConfig, "utf8");

    const result = await runCliCommand({
      argv: ["channels", "enable", "telegram", "discord"],
      workspaceRoot: tmpDir,
      homeDir: tmpDir,
    });

    expect(result.handled).toBe(true);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Usage: estacoda channels enable <channel>");

    const after = await readFile(configPath, "utf8");
    expect(after).toBe(originalConfig);
  });
});

describe("cli channels disable extra arguments", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTempDir();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("rejects extra arguments and does not modify config", async () => {
    const configDir = join(tmpDir, ".estacoda");
    const configPath = join(configDir, "config.json");
    const originalConfig = JSON.stringify({ channels: { telegram: { enabled: true } } }, null, 2) + "\n";
    await mkdir(configDir, { recursive: true });
    await writeFile(configPath, originalConfig, "utf8");

    const result = await runCliCommand({
      argv: ["channels", "disable", "telegram", "discord"],
      workspaceRoot: tmpDir,
      homeDir: tmpDir,
    });

    expect(result.handled).toBe(true);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Usage: estacoda channels disable <channel>");

    const after = await readFile(configPath, "utf8");
    expect(after).toBe(originalConfig);
  });
});
