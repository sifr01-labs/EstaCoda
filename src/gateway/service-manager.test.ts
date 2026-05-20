import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { chmod, mkdir, mkdtemp, rm, stat, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { acquireGatewayLock } from "./gateway-lock.js";
import { resolveProfileStateHome } from "../config/profile-home.js";
import { writeGatewayPid } from "./pid-file.js";

const childProcessMock = vi.hoisted(() => ({
  spawn: vi.fn(),
}));

const resolverMock = vi.hoisted(() => ({
  resolveGatewayExec: vi.fn(),
}));

const fsPromisesMock = vi.hoisted(() => ({
  interceptedSystemWrites: [] as Array<{ path: string; data: string; options: unknown }>,
  interceptedSystemChmods: [] as Array<{ path: string; mode: number }>,
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: childProcessMock.spawn,
  };
});

vi.mock("./service-exec-resolver.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./service-exec-resolver.js")>();
  return {
    ...actual,
    resolveGatewayExec: resolverMock.resolveGatewayExec,
  };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  function isSystemdSystemPath(path: unknown): path is string {
    return typeof path === "string" && path.startsWith("/etc/systemd/system");
  }
  return {
    ...actual,
    mkdir: async (path: Parameters<typeof actual.mkdir>[0], ...args: unknown[]) => {
      if (isSystemdSystemPath(String(path))) return undefined;
      return actual.mkdir(path, ...(args as []));
    },
    stat: async (path: Parameters<typeof actual.stat>[0], ...args: unknown[]) => {
      if (isSystemdSystemPath(String(path))) {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      }
      return actual.stat(path, ...(args as []));
    },
    writeFile: async (path: Parameters<typeof actual.writeFile>[0], data: Parameters<typeof actual.writeFile>[1], options?: Parameters<typeof actual.writeFile>[2]) => {
      if (isSystemdSystemPath(String(path))) {
        fsPromisesMock.interceptedSystemWrites.push({ path: String(path), data: String(data), options });
        return undefined;
      }
      return actual.writeFile(path, data, options);
    },
    chmod: async (path: Parameters<typeof actual.chmod>[0], mode: Parameters<typeof actual.chmod>[1]) => {
      if (isSystemdSystemPath(String(path))) {
        fsPromisesMock.interceptedSystemChmods.push({ path: String(path), mode: Number(mode) });
        return undefined;
      }
      return actual.chmod(path, mode);
    },
  };
});

import {
  detectServiceManager,
  installService,
  launchdPlistPath,
  plistNameForProfile,
  probeServiceState,
  systemdUnitPath,
  unitNameForProfile,
  uninstallService,
} from "./service-manager.js";

type SpawnCall = { command: string; args: string[] };
type SpawnResponse = { code?: number; stdout?: string; stderr?: string };

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "estacoda-service-manager-test-"));
}

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", {
    value,
    configurable: true,
  });
}

async function addExecutable(dir: string, name: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, name);
  await writeFile(path, "#!/bin/sh\n", "utf8");
  await chmod(path, 0o755);
}

function mockSpawn(responder?: (call: SpawnCall) => SpawnResponse | Promise<SpawnResponse>): SpawnCall[] {
  const calls: SpawnCall[] = [];
  childProcessMock.spawn.mockImplementation((command: string, args: string[]) => {
    const call = { command, args };
    calls.push(call);
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    queueMicrotask(async () => {
      const response = await Promise.resolve(responder?.(call) ?? { code: 0, stdout: "", stderr: "" });
      if (response.stdout !== undefined) child.stdout.write(response.stdout);
      if (response.stderr !== undefined) child.stderr.write(response.stderr);
      child.stdout.end();
      child.stderr.end();
      child.emit("close", response.code ?? 0);
    });
    return child;
  });
  return calls;
}

describe("service manager", () => {
  let tmpDir: string;
  let originalPath: string | undefined;
  let originalPlatform: NodeJS.Platform;

  beforeEach(async () => {
    tmpDir = await makeTempDir();
    originalPath = process.env.PATH;
    originalPlatform = process.platform;
    process.env.PATH = "";
    childProcessMock.spawn.mockReset();
    resolverMock.resolveGatewayExec.mockReset();
    fsPromisesMock.interceptedSystemWrites = [];
    fsPromisesMock.interceptedSystemChmods = [];
    resolverMock.resolveGatewayExec.mockReturnValue({
      ok: true,
      resolved: {
        mode: "source",
        command: "/opt/homebrew/bin/bun",
        args: ["run", join(tmpDir, "workspace with spaces", "src", "index.ts")],
        cwd: join(tmpDir, "workspace with spaces"),
      },
    });
  });

  afterEach(async () => {
    Object.defineProperty(process, "platform", {
      value: originalPlatform,
      configurable: true,
    });
    process.env.PATH = originalPath;
    vi.restoreAllMocks();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("detects systemd user, launchd, or none", async () => {
    const binDir = join(tmpDir, "bin");
    process.env.PATH = binDir;
    setPlatform("linux");
    expect(detectServiceManager()).toBe("none");

    await addExecutable(binDir, "systemctl");
    expect(detectServiceManager()).toBe("systemd-user");

    await rm(join(binDir, "systemctl"), { force: true });
    setPlatform("darwin");
    expect(detectServiceManager()).toBe("none");
    await addExecutable(binDir, "launchctl");
    expect(detectServiceManager()).toBe("launchd");
  });

  it("generates collision-resistant profile-aware names", () => {
    expect(unitNameForProfile("work.prod")).not.toBe(unitNameForProfile("work-prod"));
    expect(plistNameForProfile("work.prod")).not.toBe(plistNameForProfile("work-prod"));
    expect(unitNameForProfile("work.prod")).toMatch(/^estacoda-gateway-work-prod-[a-f0-9]{8}\.service$/u);
    expect(systemdUnitPath({ homeDir: tmpDir, profileId: "work.prod", system: true })).toBe(
      join("/etc", "systemd", "system", unitNameForProfile("work.prod"))
    );
  });

  it("installs a systemd user unit with escaped profile-bound launch command and permissions", async () => {
    const binDir = join(tmpDir, "bin");
    await addExecutable(binDir, "systemctl");
    process.env.PATH = `${binDir}:/usr/bin`;
    setPlatform("linux");
    const calls = mockSpawn();
    const homeDir = join(tmpDir, "home dir");

    const result = await installService({
      homeDir,
      workspaceRoot: join(tmpDir, "workspace with spaces"),
      profileId: "default",
    });

    expect(result).toEqual({ ok: true, mode: "source" });
    const unitPath = systemdUnitPath({ homeDir, profileId: "default" });
    const content = await readFile(unitPath, "utf8");
    expect(content).toContain("Description=EstaCoda Gateway Supervisor (profile: default)");
    expect(content.indexOf("StartLimitIntervalSec=300")).toBeLessThan(content.indexOf("[Service]"));
    expect(content).toContain("StartLimitBurst=10");
    expect(content).toContain("Restart=on-failure");
    expect(content).toContain("RestartSec=5");
    expect(content).toContain("TimeoutStopSec=35");
    expect(content).toContain("KillMode=mixed");
    expect(content).toContain(`Environment="HOME=${homeDir}"`);
    expect(content).toContain("Environment=\"PATH=/opt/homebrew/bin:");
    expect(content).toContain(`WorkingDirectory="${join(tmpDir, "workspace with spaces")}"`);
    expect(content).toContain('"gateway" "start" "--profile" "default"');
    expect(content).not.toContain("--replace");
    expect((await stat(unitPath)).mode & 0o777).toBe(0o600);
    expect(calls.map((call) => [call.command, ...call.args])).toEqual([
      ["systemctl", "--user", "daemon-reload"],
      ["systemctl", "--user", "enable", unitNameForProfile("default")],
      ["systemctl", "--user", "start", unitNameForProfile("default")],
    ]);
  });

  it("escapes systemd paths with quotes", async () => {
    const binDir = join(tmpDir, "bin");
    await addExecutable(binDir, "systemctl");
    process.env.PATH = binDir;
    setPlatform("linux");
    mockSpawn();
    resolverMock.resolveGatewayExec.mockReturnValue({
      ok: true,
      resolved: {
        mode: "compiled",
        command: "/usr/bin/node",
        args: [join(tmpDir, "workspace quote", "dist", "index\"quoted.js")],
        cwd: join(tmpDir, "workspace quote"),
      },
    });

    await installService({ homeDir: tmpDir, workspaceRoot: join(tmpDir, "workspace quote"), profileId: "default" });
    const content = await readFile(systemdUnitPath({ homeDir: tmpDir, profileId: "default" }), "utf8");
    expect(content).toContain('index\\"quoted.js"');
  });

  it("escapes systemd percent specifiers in rendered values", async () => {
    const binDir = join(tmpDir, "bin");
    const pathWithPercent = join(tmpDir, "%i-path");
    await addExecutable(binDir, "systemctl");
    process.env.PATH = `${binDir}:${pathWithPercent}`;
    setPlatform("linux");
    mockSpawn();
    resolverMock.resolveGatewayExec.mockReturnValue({
      ok: true,
      resolved: {
        mode: "compiled",
        command: join(tmpDir, "%h-bin", "node"),
        args: [join(tmpDir, "%i-work", "dist", "index%.js")],
        cwd: join(tmpDir, "%i-work"),
      },
    });

    await installService({ homeDir: tmpDir, workspaceRoot: join(tmpDir, "%i-work"), profileId: "default" });
    const content = await readFile(systemdUnitPath({ homeDir: tmpDir, profileId: "default" }), "utf8");
    expect(content).toContain(`"${join(tmpDir, "%%h-bin", "node")}"`);
    expect(content).toContain(`"${join(tmpDir, "%%i-work", "dist", "index%%.js")}"`);
    expect(content).toContain(`Environment="PATH=${join(tmpDir, "%%h-bin")}:`);
    expect(content).toContain(join(tmpDir, "%%i-path"));
    expect(content).toContain(`WorkingDirectory="${join(tmpDir, "%%i-work")}"`);
  });

  it("rejects systemd unit values with control characters before rendering", async () => {
    const binDir = join(tmpDir, "bin");
    await addExecutable(binDir, "systemctl");
    process.env.PATH = binDir;
    setPlatform("linux");
    mockSpawn();

    await expect(installService({ homeDir: `${tmpDir}\n`, workspaceRoot: tmpDir, profileId: "default" })).resolves.toEqual({
      ok: false,
      error: "Invalid service manager value for homeDir: control characters are not allowed.",
    });

    resolverMock.resolveGatewayExec.mockReturnValueOnce({
      ok: true,
      resolved: {
        mode: "compiled",
        command: join(tmpDir, "bin\nnode"),
        args: [join(tmpDir, "dist", "index.js")],
        cwd: tmpDir,
      },
    });
    await expect(installService({ homeDir: tmpDir, workspaceRoot: tmpDir, profileId: "default" })).resolves.toEqual({
      ok: false,
      error: "Invalid service manager value for resolved.command: control characters are not allowed.",
    });

    resolverMock.resolveGatewayExec.mockReturnValueOnce({
      ok: true,
      resolved: {
        mode: "compiled",
        command: "/usr/bin/node",
        args: [`${join(tmpDir, "dist", "index.js")}\u0000`],
        cwd: tmpDir,
      },
    });
    await expect(installService({ homeDir: tmpDir, workspaceRoot: tmpDir, profileId: "default" })).resolves.toEqual({
      ok: false,
      error: "Invalid service manager value for resolved.args[0]: control characters are not allowed.",
    });

    resolverMock.resolveGatewayExec.mockReturnValueOnce({
      ok: true,
      resolved: {
        mode: "compiled",
        command: "/usr/bin/node",
        args: [join(tmpDir, "dist", "index.js")],
        cwd: `${tmpDir}\r`,
      },
    });
    await expect(installService({ homeDir: tmpDir, workspaceRoot: tmpDir, profileId: "default" })).resolves.toEqual({
      ok: false,
      error: "Invalid service manager value for resolved.cwd: control characters are not allowed.",
    });
  });

  it("rejects systemd run-as-user and computed PATH control characters", async () => {
    const binDir = join(tmpDir, "bin");
    await addExecutable(binDir, "systemctl");
    process.env.PATH = binDir;
    setPlatform("linux");
    mockSpawn();
    vi.spyOn(process, "geteuid").mockReturnValue(0);

    await expect(installService({
      homeDir: tmpDir,
      workspaceRoot: tmpDir,
      profileId: "default",
      system: true,
      runAsUser: "estacoda\nExecStartPost=/bin/false",
    })).resolves.toEqual({
      ok: false,
      error: "Invalid --run-as-user value. Expected a local username matching ^[A-Za-z_][A-Za-z0-9_-]*[$]?$",
    });

    process.env.PATH = `${binDir}:${join(tmpDir, "bad\npath")}`;
    await expect(installService({ homeDir: tmpDir, workspaceRoot: tmpDir, profileId: "default" })).resolves.toEqual({
      ok: false,
      error: "Invalid service manager value for PATH: control characters are not allowed.",
    });
  });

  it("refuses idempotent install without force and stops before overwrite with force", async () => {
    const binDir = join(tmpDir, "bin");
    await addExecutable(binDir, "systemctl");
    process.env.PATH = binDir;
    setPlatform("linux");
    mockSpawn();

    await expect(installService({ homeDir: tmpDir, workspaceRoot: tmpDir, profileId: "default" })).resolves.toMatchObject({ ok: true });
    await expect(installService({ homeDir: tmpDir, workspaceRoot: tmpDir, profileId: "default" })).resolves.toEqual({
      ok: false,
      error: "Service already installed for profile 'default'. Use --force to replace.",
    });

    const calls = mockSpawn();
    await expect(installService({ homeDir: tmpDir, workspaceRoot: tmpDir, profileId: "default", force: true })).resolves.toMatchObject({ ok: true });
    expect(calls.map((call) => [call.command, ...call.args])[0]).toEqual(["systemctl", "--user", "stop", unitNameForProfile("default")]);
  });

  it("stops existing systemd units before checking live gateway evidence during force replacement", async () => {
    const binDir = join(tmpDir, "bin");
    await addExecutable(binDir, "systemctl");
    process.env.PATH = binDir;
    setPlatform("linux");
    mockSpawn();
    await expect(installService({ homeDir: tmpDir, workspaceRoot: tmpDir, profileId: "default" })).resolves.toMatchObject({ ok: true });
    const unitPath = systemdUnitPath({ homeDir: tmpDir, profileId: "default" });
    const originalUnit = await readFile(unitPath, "utf8");
    resolverMock.resolveGatewayExec.mockReturnValue({
      ok: true,
      resolved: {
        mode: "source",
        command: "/usr/bin/node",
        args: [join(tmpDir, "replacement-entry.ts")],
        cwd: tmpDir,
      },
    });
    await acquireGatewayLock(resolveProfileStateHome({ homeDir: tmpDir, profileId: "default" }));

    const calls = mockSpawn();
    await expect(installService({ homeDir: tmpDir, workspaceRoot: tmpDir, profileId: "default", force: true })).resolves.toEqual({
      ok: false,
      error: "Gateway already appears to be running for profile 'default'; stop it before installing/starting the service.",
    });
    await expect(readFile(unitPath, "utf8")).resolves.toBe(originalUnit);
    expect(calls.map((call) => [call.command, ...call.args])).toEqual([
      ["systemctl", "--user", "stop", unitNameForProfile("default")],
    ]);
  });

  it("allows systemd force replacement after stop clears live gateway evidence", async () => {
    const binDir = join(tmpDir, "bin");
    await addExecutable(binDir, "systemctl");
    process.env.PATH = binDir;
    setPlatform("linux");
    mockSpawn();
    await expect(installService({ homeDir: tmpDir, workspaceRoot: tmpDir, profileId: "default" })).resolves.toMatchObject({ ok: true });
    const paths = resolveProfileStateHome({ homeDir: tmpDir, profileId: "default" });
    await acquireGatewayLock(paths);
    const lockPath = join(paths.gatewayStatePath, "gateway.lock");

    const calls = mockSpawn(async (call) => {
      if (call.command === "systemctl" && call.args.includes("stop")) {
        await rm(lockPath, { force: true });
      }
      return { code: 0 };
    });
    await expect(installService({ homeDir: tmpDir, workspaceRoot: tmpDir, profileId: "default", force: true })).resolves.toMatchObject({ ok: true });
    expect(calls.map((call) => [call.command, ...call.args])).toEqual([
      ["systemctl", "--user", "stop", unitNameForProfile("default")],
      ["systemctl", "--user", "daemon-reload"],
      ["systemctl", "--user", "enable", unitNameForProfile("default")],
      ["systemctl", "--user", "start", unitNameForProfile("default")],
    ]);
  });

  it("refuses a live gateway lock but tolerates stale and corrupt lock evidence", async () => {
    const binDir = join(tmpDir, "bin");
    await addExecutable(binDir, "systemctl");
    process.env.PATH = binDir;
    setPlatform("linux");
    mockSpawn();
    const liveHome = join(tmpDir, "live-home");
    await acquireGatewayLock(resolveProfileStateHome({ homeDir: liveHome, profileId: "default" }));

    const liveResult = await installService({ homeDir: liveHome, workspaceRoot: tmpDir, profileId: "default" });
    expect(liveResult).toEqual({
      ok: false,
      error: "Gateway already appears to be running for profile 'default'; stop it before installing/starting the service.",
    });

    const staleHome = join(tmpDir, "stale-home");
    const stalePaths = resolveProfileStateHome({ homeDir: staleHome, profileId: "default" });
    await mkdir(stalePaths.gatewayStatePath, { recursive: true });
    await writeFile(join(stalePaths.gatewayStatePath, "gateway.lock"), JSON.stringify({ pid: 999999, startedAt: "2000-01-01T00:00:00.000Z" }), "utf8");
    await expect(installService({ homeDir: staleHome, workspaceRoot: tmpDir, profileId: "default" })).resolves.toMatchObject({ ok: true });

    const corruptHome = join(tmpDir, "corrupt-home");
    const corruptPaths = resolveProfileStateHome({ homeDir: corruptHome, profileId: "default" });
    await mkdir(corruptPaths.gatewayStatePath, { recursive: true });
    await writeFile(join(corruptPaths.gatewayStatePath, "gateway.lock"), "not-json", "utf8");
    await expect(installService({ homeDir: corruptHome, workspaceRoot: tmpDir, profileId: "default" })).resolves.toMatchObject({ ok: true });
  });

  it("refuses a live gateway PID but tolerates stale PID evidence", async () => {
    const binDir = join(tmpDir, "bin");
    await addExecutable(binDir, "systemctl");
    process.env.PATH = binDir;
    setPlatform("linux");
    mockSpawn();

    const liveHome = join(tmpDir, "live-pid-home");
    await writeGatewayPid(resolveProfileStateHome({ homeDir: liveHome, profileId: "default" }), {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      version: "0.0.6",
      profileId: "default",
    });
    await expect(installService({ homeDir: liveHome, workspaceRoot: tmpDir, profileId: "default" })).resolves.toEqual({
      ok: false,
      error: "Gateway already appears to be running for profile 'default'; stop it before installing/starting the service.",
    });

    const staleHome = join(tmpDir, "stale-pid-home");
    await writeGatewayPid(resolveProfileStateHome({ homeDir: staleHome, profileId: "default" }), {
      pid: 999999,
      startedAt: new Date().toISOString(),
      version: "0.0.6",
      profileId: "default",
    });
    await expect(installService({ homeDir: staleHome, workspaceRoot: tmpDir, profileId: "default" })).resolves.toMatchObject({ ok: true });
  });

  it("enforces system install root guard and run-as-user requirement", async () => {
    const binDir = join(tmpDir, "bin");
    await addExecutable(binDir, "systemctl");
    process.env.PATH = binDir;
    setPlatform("linux");
    vi.spyOn(process, "geteuid").mockReturnValue(1000);

    await expect(installService({ homeDir: tmpDir, workspaceRoot: tmpDir, profileId: "default", system: true, runAsUser: "estacoda" })).resolves.toEqual({
      ok: false,
      error: "System service install requires root. Use sudo or omit --system.",
    });

    vi.spyOn(process, "geteuid").mockReturnValue(0);
    await expect(installService({ homeDir: tmpDir, workspaceRoot: tmpDir, profileId: "default", system: true })).resolves.toEqual({
      ok: false,
      error: "System service install requires --run-as-user <user> so HOME/profile state are explicit.",
    });
  });

  it("rejects invalid system run-as users before invoking id", async () => {
    const binDir = join(tmpDir, "bin");
    await addExecutable(binDir, "systemctl");
    process.env.PATH = binDir;
    setPlatform("linux");
    vi.spyOn(process, "geteuid").mockReturnValue(0);

    for (const runAsUser of ["-root", "bad user", "bad/user", "bad:user", "bad\nuser", `bad${"\u0000"}user`]) {
      const calls = mockSpawn();
      await expect(installService({
        homeDir: tmpDir,
        workspaceRoot: tmpDir,
        profileId: "default",
        system: true,
        runAsUser,
      })).resolves.toEqual({
        ok: false,
        error: "Invalid --run-as-user value. Expected a local username matching ^[A-Za-z_][A-Za-z0-9_-]*[$]?$",
      });
      expect(calls.some((call) => call.command === "id")).toBe(false);
    }
  });

  it("fails system install when the run-as user cannot be resolved", async () => {
    const binDir = join(tmpDir, "bin");
    await addExecutable(binDir, "systemctl");
    process.env.PATH = binDir;
    setPlatform("linux");
    vi.spyOn(process, "geteuid").mockReturnValue(0);
    const calls = mockSpawn((call) => call.command === "id" ? { code: 1, stderr: "no such user" } : { code: 0 });

    await expect(installService({
      homeDir: tmpDir,
      workspaceRoot: tmpDir,
      profileId: "default",
      system: true,
      runAsUser: "estacoda",
    })).resolves.toEqual({
      ok: false,
      error: "System service user 'estacoda' does not exist or cannot be resolved.",
    });
    expect(calls.map((call) => [call.command, ...call.args])).toEqual([
      ["id", "-u", "estacoda"],
    ]);
  });

  it("validates explicit system service home before writing the unit", async () => {
    const binDir = join(tmpDir, "bin");
    await addExecutable(binDir, "systemctl");
    process.env.PATH = binDir;
    setPlatform("linux");
    vi.spyOn(process, "geteuid").mockReturnValue(0);
    mockSpawn((call) => call.command === "id" ? { code: 0, stdout: "501\n" } : { code: 0 });

    await expect(installService({
      homeDir: tmpDir,
      serviceHomeDir: "relative-home",
      workspaceRoot: tmpDir,
      profileId: "default",
      system: true,
      runAsUser: "estacoda",
    })).resolves.toEqual({
      ok: false,
      error: "--home for system service install must be an absolute path.",
    });

    await expect(installService({
      homeDir: tmpDir,
      serviceHomeDir: `${tmpDir}\n`,
      workspaceRoot: tmpDir,
      profileId: "default",
      system: true,
      runAsUser: "estacoda",
    })).resolves.toEqual({
      ok: false,
      error: "Invalid service manager value for --home: control characters are not allowed.",
    });

    const fileHome = join(tmpDir, "not-a-dir");
    await writeFile(fileHome, "not a directory", "utf8");
    await expect(installService({
      homeDir: tmpDir,
      serviceHomeDir: fileHome,
      workspaceRoot: tmpDir,
      profileId: "default",
      system: true,
      runAsUser: "estacoda",
    })).resolves.toEqual({
      ok: false,
      error: "--home for system service install must exist and be a directory.",
    });
  });

  it("fails clearly when getent cannot resolve a system service home", async () => {
    const binDir = join(tmpDir, "bin");
    await addExecutable(binDir, "systemctl");
    process.env.PATH = binDir;
    setPlatform("linux");
    vi.spyOn(process, "geteuid").mockReturnValue(0);

    mockSpawn((call) => {
      if (call.command === "id") return { code: 0, stdout: "501\n" };
      if (call.command === "getent") return { code: 1, stderr: "missing" };
      return { code: 0 };
    });
    await expect(installService({
      homeDir: "/root",
      workspaceRoot: tmpDir,
      profileId: "default",
      system: true,
      runAsUser: "estacoda",
    })).resolves.toEqual({
      ok: false,
      error: "Could not resolve home directory for system service user 'estacoda'. Pass --home <absolute-dir>.",
    });

    mockSpawn((call) => {
      if (call.command === "id") return { code: 0, stdout: "501\n" };
      if (call.command === "getent") return { code: 0, stdout: "malformed\n" };
      return { code: 0 };
    });
    await expect(installService({
      homeDir: "/root",
      workspaceRoot: tmpDir,
      profileId: "default",
      system: true,
      runAsUser: "estacoda",
    })).resolves.toEqual({
      ok: false,
      error: "Malformed passwd entry for system service user 'estacoda'. Pass --home <absolute-dir>.",
    });

    mockSpawn((call) => {
      if (call.command === "id") return { code: 0, stdout: "501\n" };
      if (call.command === "getent") return { code: 0, stdout: "estacoda:x:501:501::relative-home:/bin/sh\n" };
      return { code: 0 };
    });
    await expect(installService({
      homeDir: "/root",
      workspaceRoot: tmpDir,
      profileId: "default",
      system: true,
      runAsUser: "estacoda",
    })).resolves.toEqual({
      ok: false,
      error: "Resolved home directory for system service install must be an absolute path.",
    });
  });

  it("uses the getent-resolved home for system install preflight instead of root HOME", async () => {
    const binDir = join(tmpDir, "bin");
    await addExecutable(binDir, "systemctl");
    process.env.PATH = binDir;
    setPlatform("linux");
    vi.spyOn(process, "geteuid").mockReturnValue(0);
    const serviceHome = join(tmpDir, "service-home");
    await mkdir(serviceHome, { recursive: true });
    mockSpawn((call) => {
      if (call.command === "id") return { code: 0, stdout: "501\n" };
      if (call.command === "getent") return { code: 0, stdout: `estacoda:x:501:501::${serviceHome}:/bin/sh\n` };
      return { code: 0 };
    });
    resolverMock.resolveGatewayExec.mockReturnValue({
      ok: true,
      resolved: {
        mode: "compiled",
        command: "/usr/bin/node",
        args: [join(tmpDir, "dist", "index.js")],
        cwd: `${tmpDir}\n`,
      },
    });

    await expect(installService({
      homeDir: "/root",
      workspaceRoot: tmpDir,
      profileId: "default",
      system: true,
      runAsUser: "estacoda",
    })).resolves.toEqual({
      ok: false,
      error: "Invalid service manager value for resolved.cwd: control characters are not allowed.",
    });
  });

  it("renders system units with run-as user, explicit home, and system permissions without touching real /etc", async () => {
    const binDir = join(tmpDir, "bin");
    await addExecutable(binDir, "systemctl");
    process.env.PATH = binDir;
    setPlatform("linux");
    vi.spyOn(process, "geteuid").mockReturnValue(0);
    const serviceHome = join(tmpDir, "service-home");
    await mkdir(serviceHome, { recursive: true });
    const calls = mockSpawn((call) => call.command === "id" ? { code: 0, stdout: "501\n" } : { code: 0 });
    resolverMock.resolveGatewayExec.mockReturnValue({
      ok: true,
      resolved: {
        mode: "compiled",
        command: "/usr/bin/node",
        args: [join(tmpDir, "dist", "index.js")],
        cwd: tmpDir,
      },
    });

    await expect(installService({
      homeDir: "/root",
      serviceHomeDir: serviceHome,
      workspaceRoot: tmpDir,
      profileId: "default",
      system: true,
      runAsUser: "estacoda",
    })).resolves.toEqual({ ok: true, mode: "compiled" });

    const unitPath = systemdUnitPath({ homeDir: serviceHome, profileId: "default", system: true });
    expect(fsPromisesMock.interceptedSystemWrites).toHaveLength(1);
    expect(fsPromisesMock.interceptedSystemWrites[0]).toMatchObject({
      path: unitPath,
      options: { encoding: "utf8", mode: 0o644 },
    });
    expect(fsPromisesMock.interceptedSystemWrites[0]?.data).toContain("User=estacoda");
    expect(fsPromisesMock.interceptedSystemWrites[0]?.data).toContain(`Environment="HOME=${serviceHome}"`);
    expect(fsPromisesMock.interceptedSystemChmods).toEqual([{ path: unitPath, mode: 0o644 }]);
    expect(calls.map((call) => [call.command, ...call.args])).toEqual([
      ["id", "-u", "estacoda"],
      ["systemctl", "daemon-reload"],
      ["systemctl", "enable", unitNameForProfile("default")],
      ["systemctl", "start", unitNameForProfile("default")],
    ]);
  });

  it("installs a launchd plist with escaped ProgramArguments and permissions", async () => {
    const binDir = join(tmpDir, "bin");
    await addExecutable(binDir, "launchctl");
    process.env.PATH = binDir;
    setPlatform("darwin");
    const calls = mockSpawn();
    const profileId = "work.prod";

    const result = await installService({ homeDir: tmpDir, workspaceRoot: tmpDir, profileId });

    expect(result).toEqual({ ok: true, mode: "source" });
    const plistPath = launchdPlistPath({ homeDir: tmpDir, profileId });
    const content = await readFile(plistPath, "utf8");
    expect(content).toContain(`<string>com.estacoda.gateway.work-prod-`);
    expect(content).toContain("<string>gateway</string>");
    expect(content).toContain("<string>start</string>");
    expect(content).toContain("<string>--profile</string>");
    expect(content).toContain("<string>work.prod</string>");
    expect(content).toContain("<key>RunAtLoad</key><true/>");
    expect(content).toContain("<key>HOME</key>");
    expect(content).toContain("<key>PATH</key>");
    expect(content).toContain("gateway.stdout");
    expect(content).toContain("gateway.stderr");
    expect(content).not.toContain("--replace");
    expect((await stat(plistPath)).mode & 0o777).toBe(0o600);
    expect(calls.map((call) => [call.command, ...call.args])).toEqual([
      ["launchctl", "load", "-w", plistPath],
    ]);
  });

  it("unloads existing launchd plists before checking live gateway evidence during force replacement", async () => {
    const binDir = join(tmpDir, "bin");
    await addExecutable(binDir, "launchctl");
    process.env.PATH = binDir;
    setPlatform("darwin");
    mockSpawn();
    await expect(installService({ homeDir: tmpDir, workspaceRoot: tmpDir, profileId: "default" })).resolves.toMatchObject({ ok: true });
    const plistPath = launchdPlistPath({ homeDir: tmpDir, profileId: "default" });
    const originalPlist = await readFile(plistPath, "utf8");
    resolverMock.resolveGatewayExec.mockReturnValue({
      ok: true,
      resolved: {
        mode: "source",
        command: "/usr/bin/node",
        args: [join(tmpDir, "replacement-entry.ts")],
        cwd: tmpDir,
      },
    });
    await acquireGatewayLock(resolveProfileStateHome({ homeDir: tmpDir, profileId: "default" }));

    const calls = mockSpawn();
    await expect(installService({ homeDir: tmpDir, workspaceRoot: tmpDir, profileId: "default", force: true })).resolves.toEqual({
      ok: false,
      error: "Gateway already appears to be running for profile 'default'; stop it before installing/starting the service.",
    });
    await expect(readFile(plistPath, "utf8")).resolves.toBe(originalPlist);
    expect(calls.map((call) => [call.command, ...call.args])).toEqual([
      ["launchctl", "unload", "-w", plistPath],
    ]);
  });

  it("rejects launchd plist values with control characters before XML escaping", async () => {
    const binDir = join(tmpDir, "bin");
    await addExecutable(binDir, "launchctl");
    process.env.PATH = binDir;
    setPlatform("darwin");
    mockSpawn();

    resolverMock.resolveGatewayExec.mockReturnValueOnce({
      ok: true,
      resolved: {
        mode: "source",
        command: "/opt/homebrew/bin/bun",
        args: ["run", `${join(tmpDir, "src", "index.ts")}\n`],
        cwd: tmpDir,
      },
    });
    await expect(installService({ homeDir: tmpDir, workspaceRoot: tmpDir, profileId: "default" })).resolves.toEqual({
      ok: false,
      error: "Invalid service manager value for resolved.args[1]: control characters are not allowed.",
    });

    process.env.PATH = `${binDir}:${join(tmpDir, "bad\rpath")}`;
    await expect(installService({ homeDir: tmpDir, workspaceRoot: tmpDir, profileId: "default" })).resolves.toEqual({
      ok: false,
      error: "Invalid service manager value for PATH: control characters are not allowed.",
    });
  });

  it("uninstalls systemd services and no-ops when absent", async () => {
    const binDir = join(tmpDir, "bin");
    await addExecutable(binDir, "systemctl");
    process.env.PATH = binDir;
    setPlatform("linux");
    mockSpawn();
    await installService({ homeDir: tmpDir, workspaceRoot: tmpDir, profileId: "default" });

    const calls = mockSpawn();
    await expect(uninstallService({ homeDir: tmpDir, profileId: "default" })).resolves.toEqual({ ok: true });
    expect(calls.map((call) => [call.command, ...call.args])).toEqual([
      ["systemctl", "--user", "stop", unitNameForProfile("default")],
      ["systemctl", "--user", "disable", unitNameForProfile("default")],
      ["systemctl", "--user", "daemon-reload"],
    ]);
    await expect(uninstallService({ homeDir: tmpDir, profileId: "default" })).resolves.toEqual({ ok: true });
  });

  it("parses systemd and launchd probe output", async () => {
    const binDir = join(tmpDir, "bin");
    await addExecutable(binDir, "systemctl");
    process.env.PATH = binDir;
    setPlatform("linux");
    mockSpawn((call) => call.args.includes("show")
      ? { code: 0, stdout: "ActiveState=active\nSubState=running\nLoadState=loaded\n" }
      : { code: 0 });

    await expect(probeServiceState({ homeDir: tmpDir, profileId: "default" })).resolves.toMatchObject({
      kind: "systemd-user",
      installed: true,
      scope: "user",
      activeState: "active",
      subState: "running",
      profileId: "default",
    });

    await rm(join(binDir, "systemctl"), { force: true });
    await addExecutable(binDir, "launchctl");
    setPlatform("darwin");
    mockSpawn(() => ({ code: 0, stdout: `123\t0\t${"com.estacoda.gateway.default-37a8eec1"}\n` }));
    await expect(probeServiceState({ homeDir: tmpDir, profileId: "default" })).resolves.toMatchObject({
      kind: "launchd",
      installed: true,
      activeState: "active",
    });
  });

  it("probeServiceState never throws and keeps system fallback kind/scope consistent", async () => {
    const binDir = join(tmpDir, "bin");
    await addExecutable(binDir, "systemctl");
    process.env.PATH = binDir;
    setPlatform("linux");
    mockSpawn(() => ({ code: 1, stderr: "boom" }));

    await expect(probeServiceState({ homeDir: tmpDir, profileId: "default", system: true })).resolves.toMatchObject({
      kind: "systemd-system",
      installed: false,
      scope: "system",
      activeState: "unknown",
      profileId: "default",
    });

    await rm(join(binDir, "systemctl"), { force: true });
    await addExecutable(binDir, "launchctl");
    setPlatform("darwin");
    mockSpawn(() => ({ code: 1, stderr: "boom" }));
    await expect(probeServiceState({ homeDir: tmpDir, profileId: "default", system: true })).resolves.toMatchObject({
      kind: "launchd",
      installed: false,
      scope: "user",
      activeState: "unknown",
    });
  });
});
