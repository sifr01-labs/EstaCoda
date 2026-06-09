import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ChangeManifestStore } from "./change-manifest-store.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "estacoda-manifest-store-"));
  tempDirs.push(dir);
  return dir;
}

describe("ChangeManifestStore", () => {
  it("normalizes manifest gate aliases to executable commands", async () => {
    const store = new ChangeManifestStore({ root: makeTempDir() });

    const manifest = await store.propose({
      target: "skill",
      filesChanged: [],
      evidence: {
        traces: [],
        failures: [],
        evalCases: []
      },
      hypothesis: "normalize gate commands",
      predictedImpact: "future manifests use executable gates",
      riskLevel: "low",
      evalCommand: "eval:fixtures",
      constraintGates: ["typecheck", "  pnpm   run   smoke  "],
      rollbackPlan: "none"
    });

    expect(manifest.evalCommand).toBe("pnpm run eval:fixtures");
    expect(manifest.constraintGates).toEqual(["pnpm run typecheck", "pnpm run smoke"]);
    await expect(store.list()).resolves.toContainEqual(expect.objectContaining({
      id: manifest.id,
      evalCommand: "pnpm run eval:fixtures",
      constraintGates: ["pnpm run typecheck", "pnpm run smoke"]
    }));
  });
});
