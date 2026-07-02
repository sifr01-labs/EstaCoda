import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveProfileStateHome } from "../../config/profile-home.js";
import { ensureDefaultProfileState } from "../../cli/profile-state.js";
import { diagnoseDirectoryStructure } from "./directory-structure.js";

const tempDirs: string[] = [];

async function tempHome(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "estacoda-doctor-state-"));
  tempDirs.push(directory);
  return directory;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("diagnoseDirectoryStructure", () => {
  it("warns once when the selected profile root is missing", async () => {
    const homeDir = await tempHome();

    const diagnostic = await diagnoseDirectoryStructure({ homeDir, profileId: "default" });

    expect(diagnostic.warnings).toEqual([
      expect.stringContaining("Selected profile root is missing or invalid:")
    ]);
    expect(diagnostic.missingProfilePaths).toHaveLength(1);
    expect(diagnostic.notes).toEqual(expect.arrayContaining([
      expect.stringContaining("Global sessions store is not initialized:")
    ]));
  });

  it("reports permissive private profile files without reading their contents", async () => {
    const homeDir = await tempHome();
    await ensureDefaultProfileState({ homeDir });
    const profilePaths = resolveProfileStateHome({ homeDir, profileId: "default" });
    await chmod(profilePaths.envPath, 0o644);

    const diagnostic = await diagnoseDirectoryStructure({ homeDir, profileId: "default" });

    expect(diagnostic.privateFileModeIssues).toEqual([
      expect.objectContaining({
        path: profilePaths.envPath,
        expected: "private-file",
        actual: "mode",
        mode: "0o644"
      })
    ]);
    expect(diagnostic.warnings).toContain(`Selected profile .env is not private: ${profilePaths.envPath} (0o644)`);
  });
});
