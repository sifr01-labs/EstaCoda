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
      argv: ["browser", "setup", "--backend", "browserbase", "--cloud-provider", "browserbase"],
      workspaceRoot: tempDir,
      homeDir: tempDir
    });

    expect(setup.exitCode).toBe(0);
    expect(setup.output).toContain("Browser backend: browserbase.");
    expect(setup.output).toContain("Cloud provider: browserbase");
    await expect(readConfig(tempDir)).resolves.toMatchObject({
      browser: {
        backend: "browserbase",
        cloudProvider: "browserbase"
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
  });

  it("shows browser cloud provider setup help", async () => {
    const help = await runCliCommand({
      argv: ["browser"],
      workspaceRoot: tempDir,
      homeDir: tempDir
    });

    expect(help.output).toContain("estacoda browser setup --backend browserbase --cloud-provider browserbase");
  });
});
