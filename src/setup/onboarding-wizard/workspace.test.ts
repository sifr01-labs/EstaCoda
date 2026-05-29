import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validateOnboardingWorkspacePath } from "./workspace.js";

describe("onboarding workspace validation", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "estacoda-onboarding-workspace-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("rejects a missing path without creating it", async () => {
    const missingPath = join(tempDir, "missing-workspace");

    await expect(validateOnboardingWorkspacePath(missingPath)).resolves.toEqual({
      ok: false,
      inputPath: missingPath,
      reason: "missing",
      message: `Workspace path does not exist: ${missingPath}`,
    });
    expect(existsSync(missingPath)).toBe(false);
  });

  it("rejects a non-directory path", async () => {
    const filePath = join(tempDir, "workspace.txt");
    await writeFile(filePath, "not a directory\n", "utf8");

    await expect(validateOnboardingWorkspacePath(filePath)).resolves.toEqual({
      ok: false,
      inputPath: filePath,
      reason: "not-directory",
      message: `Workspace path is not a directory: ${filePath}`,
    });
  });

  it("returns the canonical realpath for an existing directory", async () => {
    const workspaceRoot = join(tempDir, "workspace");
    await mkdir(workspaceRoot, { recursive: true });
    const nonCanonicalPath = join(workspaceRoot, "..", "workspace");

    await expect(validateOnboardingWorkspacePath(nonCanonicalPath)).resolves.toEqual({
      ok: true,
      inputPath: nonCanonicalPath,
      canonicalPath: await realpath(workspaceRoot),
    });
  });
});
