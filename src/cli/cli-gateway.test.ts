import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runCliCommand } from "./cli.js";
import * as supervisorModule from "../gateway/supervisor.js";

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "estacoda-cli-gateway-test-"));
}

describe("cli gateway start", () => {
  let supervisorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
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
    expect(result.output).toContain("estacoda gateway restart");
    expect(result.output).toContain("estacoda gateway restart --graceful");
  });

  it("runs --dry-run without entering the foreground supervisor or writing PID/lock state", async () => {
    const tmpDir = await makeTempDir();
    try {
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
