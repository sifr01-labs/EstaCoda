import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { diagnoseConfigDrift } from "./config-drift.js";

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "estacoda-doctor-config-drift-"));
  tempDirs.push(directory);
  return directory;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("diagnoseConfigDrift", () => {
  it("reports stale root keys with migration planning metadata", async () => {
    const directory = await tempDir();
    const configPath = join(directory, "config.json");
    await writeJson(configPath, {
      provider: "openai",
      base_url: "https://legacy.example/v1",
      model: {
        id: "gpt-5"
      },
      providers: {},
      security: {},
      skills: {},
      ui: {}
    });

    const diagnostic = await diagnoseConfigDrift({
      configPath,
      envPath: join(directory, ".env")
    });

    expect(diagnostic.status).toBe("warning");
    expect(diagnostic.staleRootKeys).toEqual([
      {
        key: "provider",
        target: "model.provider",
        migrationId: "move-stale-root-model-provider"
      },
      {
        key: "base_url",
        target: "providers.openai.baseUrl",
        migrationId: "move-stale-root-model-provider"
      }
    ]);
    expect(diagnostic.pendingMigrations).toEqual(["move-stale-root-model-provider"]);
    expect(diagnostic.warnings).toEqual([
      "Config contains stale root-level key: provider -> model.provider",
      "Config contains stale root-level key: base_url -> providers.openai.baseUrl"
    ]);
  });

  it("reports known credential keys saved in .env but no longer referenced by config", async () => {
    const directory = await tempDir();
    const configPath = join(directory, "config.json");
    const envPath = join(directory, ".env");
    await writeJson(configPath, {
      model: {
        provider: "openrouter",
        id: "anthropic/claude-sonnet-4"
      },
      providers: {
        openrouter: {
          apiKeyEnv: "OPENROUTER_API_KEY"
        }
      },
      security: {},
      skills: {},
      ui: {}
    });
    await writeFile(envPath, "OPENROUTER_API_KEY=live-secret\nOPENAI_API_KEY=old-secret\n", "utf8");

    const diagnostic = await diagnoseConfigDrift({ configPath, envPath });

    expect(diagnostic.status).toBe("warning");
    expect(diagnostic.envGhosts).toEqual([
      {
        key: "OPENAI_API_KEY",
        reason: "saved profile .env key is not referenced by the selected profile config"
      }
    ]);
    expect(JSON.stringify(diagnostic)).not.toContain("old-secret");
    expect(JSON.stringify(diagnostic)).not.toContain("live-secret");
  });

  it("reports no drift for clean config and matching profile env keys", async () => {
    const directory = await tempDir();
    const configPath = join(directory, "config.json");
    const envPath = join(directory, ".env");
    await writeJson(configPath, {
      model: {
        provider: "openai",
        id: "gpt-5"
      },
      providers: {
        openai: {
          apiKeyEnv: "OPENAI_API_KEY"
        }
      },
      security: {},
      skills: {},
      ui: {}
    });
    await writeFile(envPath, "OPENAI_API_KEY=secret\n", "utf8");

    await expect(diagnoseConfigDrift({ configPath, envPath })).resolves.toEqual({
      status: "ready",
      staleRootKeys: [],
      envGhosts: [],
      pendingMigrations: [],
      warnings: [],
      notes: []
    });
  });

  it("blocks migration planning when config JSON is malformed", async () => {
    const directory = await tempDir();
    const configPath = join(directory, "config.json");
    await writeFile(configPath, "{not-json", "utf8");

    const diagnostic = await diagnoseConfigDrift({
      configPath,
      envPath: join(directory, ".env")
    });

    expect(diagnostic.status).toBe("blocked");
    expect(diagnostic.pendingMigrations).toEqual([]);
    expect(diagnostic.warnings).toEqual([
      expect.stringContaining("Config drift could not be planned because config JSON is invalid:")
    ]);
  });
});

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
