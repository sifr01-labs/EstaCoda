import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  defaultProfileId,
  normalizeProfileId,
  readActiveProfile,
  resolveGlobalStateHome,
  resolveProfileStateHome,
  writeActiveProfile
} from "./profile-home.js";

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "estacoda-profile-home-test-"));
}

describe("normalizeProfileId", () => {
  it("rejects traversal profile ids", () => {
    for (const value of [".", "..", "a/b", "a\\b"]) {
      expect(() => normalizeProfileId(value)).toThrow(/Invalid profile id/u);
    }
  });
});

describe("profile home paths", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await makeTempDir();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("resolves default profile paths under profiles/default", () => {
    const paths = resolveProfileStateHome({ homeDir: tempDir, profileId: defaultProfileId() });
    const profileRoot = join(tempDir, ".estacoda", "profiles", "default");

    expect(paths).toEqual({
      profileId: "default",
      profileRoot,
      configPath: join(profileRoot, "config.json"),
      envPath: join(profileRoot, ".env"),
      authJsonPath: join(profileRoot, "auth.json"),
      soulMdPath: join(profileRoot, "SOUL.md"),
      memoryMdPath: join(profileRoot, "MEMORY.md"),
      userMdPath: join(profileRoot, "USER.md"),
      promotionsPath: join(profileRoot, "promotions.json"),
      skillsPath: join(profileRoot, "skills"),
      logsPath: join(profileRoot, "logs"),
      channelMediaPath: join(profileRoot, "channel-media"),
      audioCachePath: join(profileRoot, "audio-cache"),
      imageCachePath: join(profileRoot, "image-cache"),
      gatewayStatePath: join(profileRoot, "gateway"),
      tempPath: join(profileRoot, "temp"),
      cronPath: join(profileRoot, "cron")
    });
  });

  it("keeps trust and sessions paths global", () => {
    const paths = resolveGlobalStateHome({ homeDir: tempDir });

    expect(paths.trustJsonPath).toBe(join(tempDir, ".estacoda", "trust.json"));
    expect(paths.sessionsSqlitePath).toBe(join(tempDir, ".estacoda", "sessions.sqlite"));
  });

  it("keeps USER.md profile-local and shared memory global", () => {
    const globalPaths = resolveGlobalStateHome({ homeDir: tempDir });
    const profilePaths = resolveProfileStateHome({ homeDir: tempDir, profileId: "research" });

    expect("userMdPath" in globalPaths).toBe(false);
    expect(profilePaths.userMdPath).toBe(join(tempDir, ".estacoda", "profiles", "research", "USER.md"));
    expect(globalPaths.sharedMemoryPath).toBe(join(tempDir, ".estacoda", "memory", "shared"));
  });

  it("round-trips active-profile.json", async () => {
    writeActiveProfile("coder", { homeDir: tempDir });
    const paths = resolveGlobalStateHome({ homeDir: tempDir });
    const raw = JSON.parse(await readFile(paths.activeProfilePath, "utf8")) as Record<string, unknown>;

    expect(raw.profileId).toBe("coder");
    expect(raw.profile).toBeUndefined();
    expect(raw.lastSwitchedAt).toEqual(expect.any(String));
    expect(raw.previousProfileId).toBeNull();

    const active = readActiveProfile({ homeDir: tempDir });
    expect(active.profileId).toBe("coder");
    expect(active.lastSwitchedAt).toEqual(expect.any(String));
    expect(active.previousProfileId).toBeNull();

    writeActiveProfile("research", { homeDir: tempDir });
    expect(readActiveProfile({ homeDir: tempDir })).toMatchObject({
      profileId: "research",
      previousProfileId: "coder"
    });
  });

  it("preserves active-profile.json when a stale temp write is present", async () => {
    writeActiveProfile("default", { homeDir: tempDir });
    const paths = resolveGlobalStateHome({ homeDir: tempDir });
    await writeFile(`${paths.activeProfilePath}.${process.pid}.stale.tmp`, "{", "utf8");

    expect(readActiveProfile({ homeDir: tempDir }).profileId).toBe("default");

    writeActiveProfile("coder", { homeDir: tempDir });
    expect(readActiveProfile({ homeDir: tempDir })).toMatchObject({
      profileId: "coder",
      previousProfileId: "default"
    });
  });

  it("defaults to the default profile when active-profile.json is missing", () => {
    expect(readActiveProfile({ homeDir: tempDir })).toEqual({
      profileId: "default",
      previousProfileId: null
    });
  });
});
