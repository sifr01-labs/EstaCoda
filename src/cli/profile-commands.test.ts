import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readActiveProfile, resolveProfileStateHome, writeActiveProfile } from "../config/profile-home.js";
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

  it("fails contextualization clearly when no provider/model contextualizer is available", async () => {
    await seedProfile("default", { user: "active user", memory: "active memory", soul: "active soul" });

    const result = await run(["create", "focused", "--contextualize", "writing"]);

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("requires an available provider/model");
  });

  it("writes contextualized SOUL.md through the injected contextualizer", async () => {
    await seedProfile("default", { user: "active user", memory: "active memory", soul: "active soul" });
    const contextualizer = vi.fn(async () => "focused soul");

    const result = await run(["create", "focused", "--contextualize", "writing"], { profileContextualizer: contextualizer });
    const paths = resolveProfileStateHome({ homeDir: tempDir, profileId: "focused" });

    expect(result.exitCode).toBe(0);
    expect(contextualizer).toHaveBeenCalledWith(expect.objectContaining({
      profileId: "focused",
      sourceProfileId: "default",
      focus: "writing",
    }));
    await expect(readFile(paths.soulMdPath, "utf8")).resolves.toBe("focused soul");
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
