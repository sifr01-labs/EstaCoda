import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveProfileStateHome } from "../config/profile-home.js";
import { loadIdentityContext } from "./identity-loader.js";

const tempDirs: string[] = [];

async function makeTempHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "estacoda-identity-loader-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await rm(dir, { recursive: true, force: true });
  }
});

describe("loadIdentityContext", () => {
  it("loads USER.md when present", async () => {
    const homeDir = await makeTempHome();
    const paths = resolveProfileStateHome({ homeDir, profileId: "default" });
    await mkdir(paths.profileRoot, { recursive: true });
    await writeFile(paths.userMdPath, "user prefs", "utf8");

    await expect(loadIdentityContext({ profilePaths: paths })).resolves.toMatchObject({
      user: "user prefs",
      soul: undefined,
      memory: undefined,
    });
  });

  it("handles missing USER.md safely", async () => {
    const homeDir = await makeTempHome();
    const paths = resolveProfileStateHome({ homeDir, profileId: "default" });

    await expect(loadIdentityContext({ profilePaths: paths })).resolves.toMatchObject({
      user: undefined,
    });
  });

  it("loads SOUL.md when present", async () => {
    const homeDir = await makeTempHome();
    const paths = resolveProfileStateHome({ homeDir, profileId: "default" });
    await mkdir(paths.profileRoot, { recursive: true });
    await writeFile(paths.soulMdPath, "persona", "utf8");

    await expect(loadIdentityContext({ profilePaths: paths })).resolves.toMatchObject({
      soul: "persona",
    });
  });

  it("handles missing SOUL.md safely", async () => {
    const homeDir = await makeTempHome();
    const paths = resolveProfileStateHome({ homeDir, profileId: "default" });

    await expect(loadIdentityContext({ profilePaths: paths })).resolves.toMatchObject({
      soul: undefined,
    });
  });

  it("loads MEMORY.md when present and handles it missing", async () => {
    const homeDir = await makeTempHome();
    const paths = resolveProfileStateHome({ homeDir, profileId: "default" });
    await mkdir(paths.profileRoot, { recursive: true });
    await writeFile(paths.memoryMdPath, "learned facts", "utf8");

    await expect(loadIdentityContext({ profilePaths: paths })).resolves.toMatchObject({
      memory: "learned facts",
    });

    const missingPaths = resolveProfileStateHome({ homeDir, profileId: "empty" });
    await expect(loadIdentityContext({ profilePaths: missingPaths })).resolves.toMatchObject({
      memory: undefined,
    });
  });

  it("loads all three files from the same selected profile and does not leak across profiles", async () => {
    const homeDir = await makeTempHome();
    const alpha = resolveProfileStateHome({ homeDir, profileId: "alpha" });
    const beta = resolveProfileStateHome({ homeDir, profileId: "beta" });
    await mkdir(alpha.profileRoot, { recursive: true });
    await mkdir(beta.profileRoot, { recursive: true });
    await writeFile(alpha.userMdPath, "alpha user", "utf8");
    await writeFile(alpha.soulMdPath, "alpha soul", "utf8");
    await writeFile(alpha.memoryMdPath, "alpha memory", "utf8");
    await writeFile(beta.userMdPath, "beta user", "utf8");
    await writeFile(beta.soulMdPath, "beta soul", "utf8");
    await writeFile(beta.memoryMdPath, "beta memory", "utf8");

    await expect(loadIdentityContext({ profilePaths: beta })).resolves.toEqual({
      user: "beta user",
      soul: "beta soul",
      memory: "beta memory",
    });
  });
});
