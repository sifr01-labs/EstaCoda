import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { diagnoseBackupReadiness } from "./backup-readiness.js";

const tempDirs: string[] = [];

async function tempHome(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "estacoda-doctor-backup-"));
  tempDirs.push(directory);
  return directory;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("diagnoseBackupReadiness", () => {
  it("does not create state directories while diagnosing backup readiness", async () => {
    const homeDir = await tempHome();

    const diagnostic = await diagnoseBackupReadiness({ homeDir });

    expect(diagnostic.ok).toBe(true);
    await expect(stat(join(homeDir, ".estacoda"))).rejects.toThrow();
  });
});
