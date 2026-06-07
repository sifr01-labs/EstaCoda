import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { resolveProfileStateHome } from "../config/profile-home.js";
import { runCliCommand } from "./cli.js";

function profileConfigPath(homeDir: string): string {
  return resolveProfileStateHome({ homeDir, profileId: "default" }).configPath;
}

async function writeConfig(homeDir: string, config: unknown): Promise<void> {
  const configPath = profileConfigPath(homeDir);
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

async function readConfig(homeDir: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(profileConfigPath(homeDir), "utf8")) as Record<string, unknown>;
}

describe("browser CLI setup", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "estacoda-browser-cli-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("persists and reports browser cloud provider setup", async () => {
    await writeConfig(tempDir, {
      model: { provider: "openai", id: "gpt-4o" }
    });

    const setup = await runCliCommand({
      argv: ["browser", "setup", "--backend", "browserbase", "--cloud-provider", "browserbase", "--hybrid-routing"],
      workspaceRoot: tempDir,
      homeDir: tempDir
    });

    expect(setup.exitCode).toBe(0);
    expect(setup.output).toContain("Browser backend: browserbase.");
    expect(setup.output).toContain("Cloud provider: browserbase");
    expect(setup.output).toContain("Hybrid routing: enabled");
    await expect(readConfig(tempDir)).resolves.toMatchObject({
      browser: {
        backend: "browserbase",
        cloudProvider: "browserbase",
        hybridRouting: true
      }
    });

    const status = await runCliCommand({
      argv: ["browser", "status"],
      workspaceRoot: tempDir,
      homeDir: tempDir
    });

    expect(status.exitCode).toBe(0);
    expect(status.output).toContain("Browser backend: browserbase");
    expect(status.output).toContain("Cloud provider: browserbase");
    expect(status.output).toContain("Hybrid routing: enabled");
  });

  it("approves and revokes cloud browser spend without changing backend settings", async () => {
    await writeConfig(tempDir, {
      model: { provider: "openai", id: "gpt-4o" },
      browser: {
        backend: "browserbase",
        cloudProvider: "browserbase",
        hybridRouting: true
      }
    });

    const approve = await runCliCommand({
      argv: ["browser", "approve-cloud"],
      workspaceRoot: tempDir,
      homeDir: tempDir
    });

    expect(approve.exitCode).toBe(0);
    expect(approve.output).toContain("may incur charges");
    expect(approve.output).toContain("Cloud spend approval: approved");
    await expect(readConfig(tempDir)).resolves.toMatchObject({
      browser: {
        backend: "browserbase",
        cloudProvider: "browserbase",
        hybridRouting: true,
        cloudSpendApproved: true
      }
    });

    const revoke = await runCliCommand({
      argv: ["browser", "revoke-cloud"],
      workspaceRoot: tempDir,
      homeDir: tempDir
    });

    expect(revoke.exitCode).toBe(0);
    expect(revoke.output).toContain("may incur charges");
    expect(revoke.output).toContain("Cloud spend approval: revoked");
    await expect(readConfig(tempDir)).resolves.toMatchObject({
      browser: {
        backend: "browserbase",
        cloudProvider: "browserbase",
        hybridRouting: true,
        cloudSpendApproved: false
      }
    });
  });

  it("persists structured local CDP launch configuration", async () => {
    await writeConfig(tempDir, {
      model: { provider: "openai", id: "gpt-4o" }
    });

    const setup = await runCliCommand({
      argv: [
        "browser",
        "setup",
        "--backend",
        "local-cdp",
        "--cdp-url",
        "http://127.0.0.1:9222",
        "--launch-executable",
        "/usr/bin/chromium",
        "--launch-arg",
        "--headless=new",
        "--launch-arg",
        "--profile-directory=Default",
        "--chrome-flag",
        "--no-first-run",
        "--chrome-flag",
        "--disable-gpu"
      ],
      workspaceRoot: tempDir,
      homeDir: tempDir
    });

    expect(setup.exitCode).toBe(0);
    expect(setup.output).toContain("Launch executable: /usr/bin/chromium");
    expect(setup.output).toContain("Launch args: 2");
    expect(setup.output).toContain("Chrome flags: 2");
    await expect(readConfig(tempDir)).resolves.toMatchObject({
      browser: {
        backend: "local-cdp",
        cdpUrl: "http://127.0.0.1:9222",
        launchExecutable: "/usr/bin/chromium",
        launchArgs: ["--headless=new", "--profile-directory=Default"],
        chromeFlags: ["--no-first-run", "--disable-gpu"]
      }
    });

    const status = await runCliCommand({
      argv: ["browser", "status"],
      workspaceRoot: tempDir,
      homeDir: tempDir
    });

    expect(status.output).toContain("Supervised mode: enabled");
    expect(status.output).toContain("Auto-launch: disabled");
    expect(status.output).toContain("CDP URL: http://127.0.0.1:9222");
    expect(status.output).toContain("Launch executable: /usr/bin/chromium");
    expect(status.output).toContain("Launch args: 2");
    expect(status.output).toContain("Chrome flags: 2");
  });

  it("keeps deprecated launch command as raw data without splitting shell-like values", async () => {
    await writeConfig(tempDir, {
      model: { provider: "openai", id: "gpt-4o" }
    });

    const setup = await runCliCommand({
      argv: [
        "browser",
        "setup",
        "--backend",
        "local-cdp",
        "--launch-command",
        "google-chrome --remote-debugging-port=9222"
      ],
      workspaceRoot: tempDir,
      homeDir: tempDir
    });

    expect(setup.exitCode).toBe(0);
    expect(setup.output).toContain("Deprecated launch command: google-chrome --remote-debugging-port=9222");
    expect(setup.output).toContain("Warning: browser.launchCommand is deprecated");
    await expect(readConfig(tempDir)).resolves.toMatchObject({
      browser: {
        backend: "local-cdp",
        launchCommand: "google-chrome --remote-debugging-port=9222"
      }
    });
    await expect(readConfig(tempDir)).resolves.not.toMatchObject({
      browser: {
        launchExecutable: expect.any(String),
        launchArgs: expect.any(Array)
      }
    });
  });

  it("renders structured browser launch settings and safer setup command", async () => {
    await writeConfig(tempDir, {
      model: { provider: "openai", id: "gpt-4o" },
      browser: {
        backend: "local-cdp",
        cdpUrl: "http://127.0.0.1:9222",
        launchExecutable: "/usr/bin/chromium",
        launchArgs: ["--headless=new"],
        chromeFlags: ["--no-first-run", "--disable-gpu"],
        launchCommand: "google-chrome --flag",
        autoLaunch: true,
        supervised: false
      }
    });

    const settings = await runCliCommand({
      argv: ["settings", "browser"],
      workspaceRoot: tempDir,
      homeDir: tempDir
    });

    expect(settings.exitCode).toBe(0);
    expect(settings.output).toContain("Backend: local-cdp");
    expect(settings.output).toContain("Supervised mode: disabled");
    expect(settings.output).toContain("Auto-launch: enabled");
    expect(settings.output).toContain("CDP URL: http://127.0.0.1:9222");
    expect(settings.output).toContain("Launch executable: /usr/bin/chromium");
    expect(settings.output).toContain("Launch args: 1");
    expect(settings.output).toContain("Chrome flags: 2");
    expect(settings.output).toContain("Deprecated launch command: configured");
    expect(settings.output).toContain("Hybrid routing: disabled");
    expect(settings.output).toContain("--launch-executable /path/to/chrome");
    expect(settings.output).toContain("--launch-arg --headless=new");
    expect(settings.output).toContain("--chrome-flag --no-first-run");
    expect(settings.output).toContain("--cloud-provider browserbase --hybrid-routing");
  });

  it("shows browser cloud provider setup help", async () => {
    const help = await runCliCommand({
      argv: ["browser"],
      workspaceRoot: tempDir,
      homeDir: tempDir
    });

    expect(help.output).toContain("estacoda browser setup --backend browserbase --cloud-provider browserbase --hybrid-routing");
    expect(help.output).toContain("estacoda browser approve-cloud");
    expect(help.output).toContain("estacoda browser revoke-cloud");
    expect(help.output).toContain("--launch-executable /path/to/chrome");
  });
});
