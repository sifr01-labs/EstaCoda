import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveProfileStateHome } from "../config/profile-home.js";
import { AdvisoryAckStore, normalizeAdvisoryId } from "./advisory-store.js";

const tempDirs: string[] = [];
const FIXED_NOW = new Date("2026-07-02T00:00:00.000Z");
const LATER_NOW = new Date("2026-07-03T00:00:00.000Z");

async function tempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "estacoda-advisory-store-"));
  tempDirs.push(directory);
  return directory;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("AdvisoryAckStore", () => {
  it("stores acknowledgements under the selected profile", async () => {
    const homeDir = await tempDir();
    const alpha = resolveProfileStateHome({ homeDir, profileId: "alpha" });
    const beta = resolveProfileStateHome({ homeDir, profileId: "beta" });
    const alphaStore = new AdvisoryAckStore({ path: alpha.advisoriesAckedPath });
    const betaStore = new AdvisoryAckStore({ path: beta.advisoriesAckedPath });

    const result = await alphaStore.acknowledge("GHSA-abcd-1234", { now: () => FIXED_NOW });

    expect(result).toEqual({
      id: "GHSA-abcd-1234",
      acknowledgedAt: "2026-07-02T00:00:00.000Z",
      created: true
    });
    await expect(alphaStore.isAcknowledged("GHSA-abcd-1234")).resolves.toBe(true);
    await expect(betaStore.isAcknowledged("GHSA-abcd-1234")).resolves.toBe(false);
    await expect(readFile(beta.advisoriesAckedPath, "utf8")).rejects.toThrow();
  });

  it("is idempotent and preserves the original acknowledgement timestamp", async () => {
    const homeDir = await tempDir();
    const paths = resolveProfileStateHome({ homeDir, profileId: "default" });
    const store = new AdvisoryAckStore({ path: paths.advisoriesAckedPath });

    await store.acknowledge("GHSA-abcd-1234", { now: () => FIXED_NOW });
    const second = await store.acknowledge("GHSA-abcd-1234", { now: () => LATER_NOW });
    const persisted = JSON.parse(await readFile(paths.advisoriesAckedPath, "utf8")) as {
      acknowledgements: Array<{ id: string; acknowledgedAt: string }>;
    };

    expect(second).toEqual({
      id: "GHSA-abcd-1234",
      acknowledgedAt: "2026-07-02T00:00:00.000Z",
      created: false
    });
    expect(persisted.acknowledgements).toEqual([
      {
        id: "GHSA-abcd-1234",
        acknowledgedAt: "2026-07-02T00:00:00.000Z"
      }
    ]);
  });

  it("rejects malformed advisory ids", () => {
    for (const value of ["", "../secret", "GHSA bad", " GHSA-bad\nnext"]) {
      expect(() => normalizeAdvisoryId(value)).toThrow(/Invalid advisory id/u);
    }
  });
});
