import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveProfileStateHome, writeActiveProfile } from "../config/profile-home.js";
import { MemoryPromotionStore } from "../memory/memory-promotion-store.js";
import { knowledge } from "./knowledge-commands.js";

const tempDirs: string[] = [];

async function makeTempHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "estacoda-knowledge-commands-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await rm(dir, { recursive: true, force: true });
  }
});

describe("knowledge memory commands", () => {
  it("lists promotions from the selected profile only", async () => {
    const homeDir = await makeTempHome();
    const alpha = resolveProfileStateHome({ homeDir, profileId: "alpha" });
    const beta = resolveProfileStateHome({ homeDir, profileId: "beta" });
    await mkdir(alpha.profileRoot, { recursive: true });
    await mkdir(beta.profileRoot, { recursive: true });
    await writeFile(alpha.userMdPath, "- alpha prefers quiet output", "utf8");
    await writeFile(beta.userMdPath, "- beta prefers detailed output", "utf8");

    await new MemoryPromotionStore({ path: alpha.promotionsPath }).applyUserPreference({
      id: "alpha-pref",
      content: "alpha prefers quiet output",
      confidence: 0.9,
      occurrences: 1,
      source: "test",
      sourceSessionIds: [],
    });
    await new MemoryPromotionStore({ path: beta.promotionsPath }).applyUserPreference({
      id: "beta-pref",
      content: "beta prefers detailed output",
      confidence: 0.9,
      occurrences: 1,
      source: "test",
      sourceSessionIds: [],
    });
    writeActiveProfile("beta", { homeDir });

    const result = await knowledge(
      { argv: ["knowledge"], workspaceRoot: homeDir, homeDir },
      ["memory", "list"]
    );

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("beta-pref");
    expect(result.output).not.toContain("alpha-pref");
  });
});
