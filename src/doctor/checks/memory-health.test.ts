import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureDefaultProfileState } from "../../cli/profile-state.js";
import { resolveGlobalStateHome, resolveProfileStateHome } from "../../config/profile-home.js";
import { diagnoseMemoryHealth } from "./memory-health.js";

const tempDirs: string[] = [];

async function tempHome(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "estacoda-doctor-memory-"));
  tempDirs.push(directory);
  return directory;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("diagnoseMemoryHealth", () => {
  it("reports initialized profile memory files as ready", async () => {
    const homeDir = await tempHome();
    await ensureDefaultProfileState({ homeDir });
    const globalPaths = resolveGlobalStateHome({ homeDir });
    const paths = resolveProfileStateHome({ homeDir, profileId: "default" });

    const diagnostic = await diagnoseMemoryHealth({ homeDir, profileId: "default" });

    expect(diagnostic.status).toBe("ready");
    expect(diagnostic.provider).toBe("file");
    expect(diagnostic.readyFiles).toEqual([
      paths.userMdPath,
      paths.soulMdPath,
      paths.memoryMdPath
    ]);
    expect(diagnostic.readySupportingPaths).toEqual([
      paths.promotionsPath
    ]);
    expect(diagnostic.missingSupportingPaths).toEqual([
      globalPaths.sharedMemoryPath
    ]);
    expect(diagnostic.warnings).toEqual([]);
    expect(diagnostic.notes).toEqual([]);
  });

  it("treats missing first-write memory files as notes", async () => {
    const homeDir = await tempHome();
    const paths = resolveProfileStateHome({ homeDir, profileId: "default" });
    await mkdir(paths.profileRoot, { recursive: true });

    const diagnostic = await diagnoseMemoryHealth({ homeDir, profileId: "default" });

    expect(diagnostic.status).toBe("ready");
    expect(diagnostic.missingFiles).toEqual([
      paths.userMdPath,
      paths.soulMdPath,
      paths.memoryMdPath
    ]);
    expect(diagnostic.warnings).toEqual([]);
    expect(diagnostic.notes).toEqual([
      `Memory file will be created on first write: ${paths.userMdPath}`,
      `Memory file will be created on first write: ${paths.soulMdPath}`,
      `Memory file will be created on first write: ${paths.memoryMdPath}`
    ]);
    expect(diagnostic.missingSupportingPaths).toEqual([
      paths.promotionsPath,
      resolveGlobalStateHome({ homeDir }).sharedMemoryPath
    ]);
  });

  it("warns when supporting memory state is not usable", async () => {
    const homeDir = await tempHome();
    await ensureDefaultProfileState({ homeDir });
    const paths = resolveProfileStateHome({ homeDir, profileId: "default" });
    await rm(paths.promotionsPath);
    await mkdir(paths.promotionsPath);

    const diagnostic = await diagnoseMemoryHealth({ homeDir, profileId: "default" });

    expect(diagnostic.status).toBe("warning");
    expect(diagnostic.problemFiles).toEqual([
      expect.objectContaining({
        path: paths.promotionsPath,
        label: "promotions.json",
        status: "invalid"
      })
    ]);
    expect(diagnostic.warnings).toEqual([
      `Memory supporting state promotions.json is not usable: ${paths.promotionsPath}`
    ]);
  });

  it("warns when a memory file path is not a usable file", async () => {
    const homeDir = await tempHome();
    await ensureDefaultProfileState({ homeDir });
    const paths = resolveProfileStateHome({ homeDir, profileId: "default" });
    await rm(paths.memoryMdPath);
    await mkdir(paths.memoryMdPath);

    const diagnostic = await diagnoseMemoryHealth({ homeDir, profileId: "default" });

    expect(diagnostic.status).toBe("warning");
    expect(diagnostic.problemFiles).toEqual([
      expect.objectContaining({
        path: paths.memoryMdPath,
        label: "MEMORY.md",
        status: "invalid"
      })
    ]);
    expect(diagnostic.warnings).toEqual([
      `Memory file MEMORY.md is not usable: ${paths.memoryMdPath}`
    ]);
  });
});
