import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveProfileStateHome } from "../config/profile-home.js";
import { ensureProfileSkeleton } from "./profile-state.js";

const require = createRequire(import.meta.url);
const tsxLoaderPath = require.resolve("tsx");

describe("entrypoint home directory propagation", () => {
  let root: string;
  let prodHome: string;
  let devHome: string;
  let workspaceRoot: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "estacoda-entrypoint-home-"));
    prodHome = join(root, "prod-home");
    devHome = join(root, "dev-home");
    workspaceRoot = join(root, "workspace");
    await mkdir(prodHome, { recursive: true });
    await mkdir(devHome, { recursive: true });
    await mkdir(workspaceRoot, { recursive: true });
    workspaceRoot = await realpath(workspaceRoot);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("passes ESTACODA_HOME-resolved state home into pre-runtime CLI commands", async () => {
    await ensureProfileSkeleton({ homeDir: devHome, profileId: "default", blank: true });

    const result = await runEntrypoint({
      argv: ["profile", "show", "default"],
      cwd: workspaceRoot,
      homeDir: prodHome,
      estacodaHome: devHome
    });
    const devPaths = resolveProfileStateHome({ homeDir: devHome, profileId: "default" });
    const prodPaths = resolveProfileStateHome({ homeDir: prodHome, profileId: "default" });

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(`Path: ${devPaths.profileRoot}`);
    expect(result.stdout).toContain(`Config: ${devPaths.configPath}`);
    expect(result.stdout).not.toContain(prodPaths.profileRoot);
  });

  it("starts fresh by default and continues only the profile/workspace v2 pointer explicitly", async () => {
    const profilePaths = await ensureProfileSkeleton({ homeDir: devHome, profileId: "default", blank: true });
    await writeFile(profilePaths.configPath, JSON.stringify({
      model: { provider: "unconfigured", id: "unconfigured" },
      stt: {
        provider: "local",
        local: {
          engine: "command",
          command: "mock-stt"
        }
      }
    }, null, 2));

    const first = await runEntrypoint({
      argv: ["/doctor"],
      cwd: workspaceRoot,
      homeDir: prodHome,
      estacodaHome: devHome
    });
    const second = await runEntrypoint({
      argv: ["/doctor"],
      cwd: workspaceRoot,
      homeDir: prodHome,
      estacodaHome: devHome
    });
    const firstSessionId = extractSessionId(first.stdout);
    const secondSessionId = extractSessionId(second.stdout);
    const continued = await runEntrypoint({
      argv: ["--continue", "/doctor"],
      cwd: workspaceRoot,
      homeDir: prodHome,
      estacodaHome: devHome
    });
    const continuedSessionId = extractSessionId(continued.stdout);
    const continuationState = JSON.parse(await readFile(join(devHome, ".estacoda", "cli-sessions.json"), "utf8")) as {
      version: number;
      entries: Array<{ profileId: string; workspaceRoot: string; sessionId: string }>;
    };

    expect(first.code).toBe(0);
    expect(second.code).toBe(0);
    expect(continued.code).toBe(0);
    expect(first.stderr).toBe("");
    expect(second.stderr).toBe("");
    expect(continued.stderr).toBe("");
    expect(firstSessionId).toBeDefined();
    expect(secondSessionId).toBeDefined();
    expect(secondSessionId).not.toBe(firstSessionId);
    expect(continuedSessionId).toBe(secondSessionId);
    expect(continuationState).toMatchObject({
      version: 2,
      entries: [{ profileId: "default", workspaceRoot, sessionId: secondSessionId }],
    });
    await expect(access(join(devHome, ".estacoda", "sessions.sqlite"))).resolves.toBeUndefined();
    await expect(access(join(prodHome, ".estacoda", "sessions.sqlite"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(join(prodHome, ".estacoda", "cli-sessions.json"))).rejects.toMatchObject({ code: "ENOENT" });
  }, 15_000);

  it("fails closed when --continue has no pointer for the profile and workspace", async () => {
    const profilePaths = await ensureProfileSkeleton({ homeDir: devHome, profileId: "default", blank: true });
    await writeFile(profilePaths.configPath, JSON.stringify({
      model: { provider: "unconfigured", id: "unconfigured" },
    }, null, 2));

    const result = await runEntrypoint({
      argv: ["--continue", "/doctor"],
      cwd: workspaceRoot,
      homeDir: prodHome,
      estacodaHome: devHome,
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("No previous session is available for this profile and workspace");
    await expect(access(join(devHome, ".estacoda", "cli-sessions.json")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });
});

type EntrypointResult = {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
};

function runEntrypoint(input: {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly homeDir: string;
  readonly estacodaHome: string;
}): Promise<EntrypointResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      "--import",
      tsxLoaderPath,
      join(process.cwd(), "src", "index.ts"),
      ...input.argv
    ], {
      cwd: input.cwd,
      env: {
        ...process.env,
        HOME: input.homeDir,
        ESTACODA_HOME: input.estacodaHome,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("Timed out waiting for entrypoint home propagation command."));
    }, 10_000);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({ code, stdout, stderr });
    });
  });
}

function extractSessionId(output: string): string | undefined {
  return output.match(/Session:\s+([^\s]+)/)?.[1];
}
