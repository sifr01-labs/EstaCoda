import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  readActiveProfile,
  resolveGlobalStateHome,
  resolveProfileStateHome,
  writeActiveProfile
} from "../config/profile-home.js";
import { createSQLiteSessionDB } from "../session/session-setup.js";
import { profileCommand } from "./profile-commands.js";
import { ensureProfileSkeleton } from "./profile-state.js";
import { parseGlobalCliOptions, runCliCommand, type CliOptions } from "./cli.js";

describe("profileCommand", () => {
  let tempDir: string;
  let workspaceRoot: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "estacoda-profile-command-"));
    workspaceRoot = join(tempDir, "workspace");
    await mkdir(workspaceRoot, { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("creates the profile skeleton", async () => {
    const result = await run(["create", "research", "--blank"]);
    const paths = resolveProfileStateHome({ homeDir: tempDir, profileId: "research" });

    expect(result.exitCode).toBe(0);
    for (const path of [
      paths.configPath,
      paths.envPath,
      paths.authJsonPath,
      paths.userMdPath,
      paths.soulMdPath,
      paths.memoryMdPath,
      paths.promotionsPath,
      paths.skillsPath,
      paths.cronPath,
      paths.logsPath,
      paths.gatewayStatePath,
      paths.channelMediaPath,
      paths.audioCachePath,
      paths.imageCachePath,
      paths.tempPath,
    ]) {
      expect(existsSync(path)).toBe(true);
    }
  });

  it("lists profiles with the active marker", async () => {
    await ensureProfileSkeleton({ homeDir: tempDir, profileId: "default", blank: true });
    await ensureProfileSkeleton({ homeDir: tempDir, profileId: "research", blank: true });
    writeActiveProfile("research", { homeDir: tempDir });

    const result = await run(["list"]);

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("  default");
    expect(result.output).toContain("* research");
  });

  it("writes active-profile.json on use", async () => {
    await ensureProfileSkeleton({ homeDir: tempDir, profileId: "default", blank: true });
    await ensureProfileSkeleton({ homeDir: tempDir, profileId: "research", blank: true });
    writeActiveProfile("default", { homeDir: tempDir });

    const result = await run(["use", "research"]);
    const active = readActiveProfile({ homeDir: tempDir });

    expect(result.exitCode).toBe(0);
    expect(active.profileId).toBe("research");
    expect(active.previousProfileId).toBe("default");
    expect(active.lastSwitchedAt).toEqual(expect.any(String));
  });

  it("shows profile paths without leaking secret values", async () => {
    await ensureProfileSkeleton({ homeDir: tempDir, profileId: "default", blank: true });
    const paths = resolveProfileStateHome({ homeDir: tempDir, profileId: "default" });
    await writeFile(paths.envPath, "OPENAI_API_KEY=sk-secret\n", "utf8");

    const result = await run(["show", "default"]);

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("OPENAI_API_KEY=***");
    expect(result.output).not.toContain("sk-secret");
  });

  it("refuses to delete the active profile unless forced", async () => {
    await ensureProfileSkeleton({ homeDir: tempDir, profileId: "default", blank: true });
    writeActiveProfile("default", { homeDir: tempDir });

    const result = await run(["delete", "default"]);

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Refusing to delete active profile");
  });

  it("refuses to delete a non-empty inactive profile unless forced", async () => {
    await ensureProfileSkeleton({ homeDir: tempDir, profileId: "default", blank: true });
    await ensureProfileSkeleton({ homeDir: tempDir, profileId: "research", blank: true });
    writeActiveProfile("default", { homeDir: tempDir });

    const result = await run(["delete", "research"]);

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Refusing to delete non-empty profile");
  });

  it("moves active-profile.json to a remaining profile when forced active deletion succeeds", async () => {
    await ensureProfileSkeleton({ homeDir: tempDir, profileId: "default", blank: true });
    await ensureProfileSkeleton({ homeDir: tempDir, profileId: "research", blank: true });
    writeActiveProfile("default", { homeDir: tempDir });

    const result = await run(["delete", "default", "--force"]);

    expect(result.exitCode).toBe(0);
    expect(existsSync(resolveProfileStateHome({ homeDir: tempDir, profileId: "default" }).profileRoot)).toBe(false);
    expect(readActiveProfile({ homeDir: tempDir }).profileId).toBe("research");
  });

  it("recreates the default skeleton instead of leaving active-profile.json broken after deleting the last profile", async () => {
    await ensureProfileSkeleton({ homeDir: tempDir, profileId: "default", blank: true });
    writeActiveProfile("default", { homeDir: tempDir });

    const result = await run(["delete", "default", "--force"]);
    const paths = resolveProfileStateHome({ homeDir: tempDir, profileId: "default" });

    expect(result.exitCode).toBe(0);
    expect(readActiveProfile({ homeDir: tempDir }).profileId).toBe("default");
    expect(existsSync(paths.configPath)).toBe(true);
  });

  it("renames a profile directory and updates the active profile record", async () => {
    await ensureProfileSkeleton({ homeDir: tempDir, profileId: "old", blank: true });
    writeActiveProfile("old", { homeDir: tempDir });

    const result = await run(["rename", "old", "new"]);

    expect(result.exitCode).toBe(0);
    expect(existsSync(resolveProfileStateHome({ homeDir: tempDir, profileId: "old" }).profileRoot)).toBe(false);
    expect(existsSync(resolveProfileStateHome({ homeDir: tempDir, profileId: "new" }).profileRoot)).toBe(true);
    expect(readActiveProfile({ homeDir: tempDir }).profileId).toBe("new");
  });

  it("copies USER.md and MEMORY.md from the active profile by default with fresh SOUL.md", async () => {
    await seedProfile("default", {
      user: "active user",
      memory: "active memory",
      soul: "active soul",
    });
    writeActiveProfile("default", { homeDir: tempDir });

    const result = await run(["create", "research"]);
    const paths = resolveProfileStateHome({ homeDir: tempDir, profileId: "research" });

    expect(result.exitCode).toBe(0);
    await expect(readFile(paths.userMdPath, "utf8")).resolves.toBe("active user");
    await expect(readFile(paths.memoryMdPath, "utf8")).resolves.toBe("active memory");
    await expect(readFile(paths.soulMdPath, "utf8")).resolves.toBe("");
  });

  it("creates a blank profile when requested", async () => {
    await seedProfile("default", {
      user: "active user",
      memory: "active memory",
      soul: "active soul",
    });
    writeActiveProfile("default", { homeDir: tempDir });

    const result = await run(["create", "blank", "--blank"]);
    const paths = resolveProfileStateHome({ homeDir: tempDir, profileId: "blank" });

    expect(result.exitCode).toBe(0);
    await expect(readFile(paths.userMdPath, "utf8")).resolves.toBe("");
    await expect(readFile(paths.memoryMdPath, "utf8")).resolves.toBe("");
    await expect(readFile(paths.soulMdPath, "utf8")).resolves.toBe("");
  });

  it("copies from the named source profile", async () => {
    await seedProfile("default", { user: "default user", memory: "default memory", soul: "default soul" });
    await seedProfile("source", { user: "source user", memory: "source memory", soul: "source soul" });
    writeActiveProfile("default", { homeDir: tempDir });

    const result = await run(["create", "target", "--from", "source"]);
    const paths = resolveProfileStateHome({ homeDir: tempDir, profileId: "target" });

    expect(result.exitCode).toBe(0);
    await expect(readFile(paths.userMdPath, "utf8")).resolves.toBe("source user");
    await expect(readFile(paths.memoryMdPath, "utf8")).resolves.toBe("source memory");
    await expect(readFile(paths.soulMdPath, "utf8")).resolves.toBe("");
  });

  it("copies only selected memory files", async () => {
    await seedProfile("source", { user: "source user", memory: "source memory", soul: "source soul" });

    const result = await run(["create", "target", "--from", "source", "--files", "soul"]);
    const paths = resolveProfileStateHome({ homeDir: tempDir, profileId: "target" });

    expect(result.exitCode).toBe(0);
    await expect(readFile(paths.userMdPath, "utf8")).resolves.toBe("");
    await expect(readFile(paths.memoryMdPath, "utf8")).resolves.toBe("");
    await expect(readFile(paths.soulMdPath, "utf8")).resolves.toBe("source soul");
  });

  it("removes --contextualize as a profile creation option", async () => {
    const result = await run(["create", "focused", "--contextualize", "writing"]);

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Unknown option: --contextualize");
    expect(result.output).toContain("--profile-context");
  });

  it("fails profile context generation clearly when no provider/model route is available", async () => {
    await seedProfile("default", { user: "active user", memory: "active memory", soul: "active soul" });

    const result = await run(["create", "focused", "--profile-context", "writing"]);

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Profile context generation route is unavailable");
  });

  it("writes SOUL.md through the injected ProfileContextGenerator", async () => {
    await seedProfile("default", { user: "active user", memory: "active memory", soul: "active soul" });
    const profileContextGenerator = vi.fn(async () => "focused soul");

    const result = await run(["create", "focused", "--profile-context", "writing"], { profileContextGenerator });
    const paths = resolveProfileStateHome({ homeDir: tempDir, profileId: "focused" });

    expect(result.exitCode).toBe(0);
    expect(profileContextGenerator).toHaveBeenCalledWith(expect.objectContaining({
      profileId: "focused",
      sourceProfileId: "default",
      profileContextFocus: "writing",
    }));
    await expect(readFile(paths.soulMdPath, "utf8")).resolves.toBe("focused soul\n");
  });

  it("uses profile_context route in production profile context wiring", async () => {
    await seedProfile("default", { user: "active user", memory: "active memory", soul: "active soul" });
    const defaultPaths = resolveProfileStateHome({ homeDir: tempDir, profileId: "default" });
    await writeFile(defaultPaths.configPath, JSON.stringify({
      providers: {
        local: {
          kind: "openai-compatible",
          baseUrl: "http://localhost:11434/v1",
          models: ["main", "context-model"],
          enableNetwork: true
        }
      },
      model: {
        provider: "local",
        id: "main"
      },
      auxiliaryModels: {
        profile_context: {
          provider: "local",
          id: "context-model",
          timeoutMs: 1000,
          maxConcurrency: 1
        }
      }
    }, null, 2), "utf8");
    let requestBody: { model?: string; messages?: Array<{ content?: unknown }> } | undefined;
    const providerFetch = vi.fn(async (_url: string, init: { body: string }) => {
      requestBody = JSON.parse(init.body) as typeof requestBody;
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        async json() {
          return {
            choices: [
              {
                message: {
                  content: "Generated profile soul"
                }
              }
            ]
          };
        },
        async text() {
          return "";
        }
      };
    });

    const result = await run(["create", "focused", "--profile-context", "writing"], { providerFetch });
    const paths = resolveProfileStateHome({ homeDir: tempDir, profileId: "focused" });

    expect(result.exitCode).toBe(0);
    expect(providerFetch).toHaveBeenCalledTimes(1);
    expect(requestBody?.model).toBe("context-model");
    expect(JSON.stringify(requestBody?.messages)).toContain("profileContextFocus");
    await expect(readFile(paths.soulMdPath, "utf8")).resolves.toBe("Generated profile soul\n");
    const sessionDb = await createSQLiteSessionDB({
      path: resolveGlobalStateHome({ homeDir: tempDir }).sessionsSqlitePath
    });
    try {
      await expect(sessionDb.listProviderUsageEntries("default")).resolves.toEqual([
        expect.objectContaining({
          sourceKind: "auxiliary",
          auxiliaryKind: "profile_context",
          provider: "local",
          model: "context-model"
        })
      ]);
    } finally {
      await sessionDb.close();
    }
  });

  it("parses --profile as a global command option", () => {
    const parsed = parseGlobalCliOptions(["--profile", "research", "model", "status"]);

    expect(parsed).toEqual({
      ok: true,
      argv: ["model", "status"],
      profileId: "research",
    });
  });

  it("uses --profile for the current command without changing active-profile.json", async () => {
    await ensureProfileSkeleton({ homeDir: tempDir, profileId: "default", blank: true });
    await ensureProfileSkeleton({ homeDir: tempDir, profileId: "research", blank: true });
    writeActiveProfile("default", { homeDir: tempDir });

    const result = await runCliCommand({
      argv: ["--profile", "research", "profile", "show"],
      homeDir: tempDir,
      workspaceRoot,
    });

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("Profile: research");
    expect(readActiveProfile({ homeDir: tempDir }).profileId).toBe("default");
  });

  it("uses --profile for setup writes without changing active-profile.json", async () => {
    await ensureProfileSkeleton({ homeDir: tempDir, profileId: "default", blank: true });
    await ensureProfileSkeleton({ homeDir: tempDir, profileId: "research", blank: true });
    writeActiveProfile("default", { homeDir: tempDir });

    const result = await runCliCommand({
      argv: ["--profile", "research", "setup", "--provider", "local", "--model", "research-local", "--offline"],
      homeDir: tempDir,
      workspaceRoot,
      interactive: false,
    });
    const defaultConfig = JSON.parse(await readFile(resolveProfileStateHome({ homeDir: tempDir, profileId: "default" }).configPath, "utf8")) as {
      model?: { provider?: string; id?: string };
    };
    const researchConfig = JSON.parse(await readFile(resolveProfileStateHome({ homeDir: tempDir, profileId: "research" }).configPath, "utf8")) as {
      model?: { provider?: string; id?: string };
    };

    expect(result.exitCode).toBe(0);
    expect(defaultConfig.model).toEqual({ provider: "unconfigured", id: "unconfigured" });
    expect(researchConfig.model).toEqual({ provider: "local", id: "research-local" });
    expect(readActiveProfile({ homeDir: tempDir }).profileId).toBe("default");
  });

  async function seedProfile(
    profileId: string,
    memory: { readonly user: string; readonly memory: string; readonly soul: string }
  ): Promise<void> {
    const paths = await ensureProfileSkeleton({ homeDir: tempDir, profileId, blank: true });
    await writeFile(paths.userMdPath, memory.user, "utf8");
    await writeFile(paths.memoryMdPath, memory.memory, "utf8");
    await writeFile(paths.soulMdPath, memory.soul, "utf8");
  }

  async function run(args: string[], overrides: Partial<CliOptions> = {}) {
    return profileCommand({
      argv: [],
      homeDir: tempDir,
      workspaceRoot,
      ...overrides,
    }, args);
  }
});
