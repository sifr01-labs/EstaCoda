import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { diagnoseConfigHygiene } from "./config-hygiene.js";

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "estacoda-doctor-config-"));
  tempDirs.push(directory);
  return directory;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("diagnoseConfigHygiene", () => {
  it("reports stale root keys, missing sections, and circular fallbacks", async () => {
    const directory = await tempDir();
    const configPath = join(directory, "config.json");
    await writeFile(configPath, `${JSON.stringify({
      provider: "legacy",
      base_url: "https://legacy.example/v1",
      model: {
        provider: "openai",
        id: "gpt-5",
        fallbacks: [
          { provider: "openai", id: "gpt-5" },
          { provider: "deepseek", id: "deepseek-chat" }
        ]
      },
      providers: {},
      ui: {},
      skills: {}
    }, null, 2)}\n`);

    const diagnostic = await diagnoseConfigHygiene(configPath);

    expect(diagnostic.staleRootKeys).toEqual(["provider", "base_url"]);
    expect(diagnostic.missingSections).toEqual(["security"]);
    expect(diagnostic.circularFallbacks).toEqual(["openai/gpt-5"]);
    expect(diagnostic.warnings).toContain("Profile config has stale root keys: provider, base_url");
    expect(diagnostic.warnings).toContain("Profile config is missing recommended sections: security");
    expect(diagnostic.warnings).toContain("Profile config fallback repeats the primary model route: openai/gpt-5");
  });

  it("treats missing or invalid JSON as already covered by config loading", async () => {
    const directory = await tempDir();
    const configPath = join(directory, "config.json");
    await writeFile(configPath, "{");

    await expect(diagnoseConfigHygiene(join(directory, "missing.json"))).resolves.toEqual({
      warnings: [],
      staleRootKeys: [],
      missingSections: [],
      circularFallbacks: []
    });
    await expect(diagnoseConfigHygiene(configPath)).resolves.toEqual({
      warnings: [],
      staleRootKeys: [],
      missingSections: [],
      circularFallbacks: []
    });
  });
});
