import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveProfileStateHome } from "../config/profile-home.js";
import { runDoctorConfigRepair } from "./config-repair.js";

const tempDirs: string[] = [];
const FIXED_NOW = new Date("2026-07-02T00:00:00.000Z");

async function tempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "estacoda-doctor-config-repair-"));
  tempDirs.push(directory);
  return directory;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("runDoctorConfigRepair", () => {
  it("backs up config before applying stale root key migrations", async () => {
    const homeDir = await tempDir();
    const paths = resolveProfileStateHome({ homeDir, profileId: "default" });
    const original = {
      provider: "openai",
      base_url: "https://legacy.example/v1",
      model: {
        id: "gpt-5"
      },
      providers: {},
      security: {},
      skills: {},
      ui: {}
    };
    await writeJson(paths.configPath, original);

    const result = await runDoctorConfigRepair({
      homeDir,
      profileId: "default",
      now: () => FIXED_NOW
    });
    const backupPath = `${paths.configPath}.bak-2026-07-02T00-00-00-000Z`;
    const migrated = JSON.parse(await readFile(paths.configPath, "utf8")) as Record<string, unknown>;

    expect(result.status).toBe("repaired");
    expect(result.backupPath).toBe(backupPath);
    await expect(stat(backupPath)).resolves.toMatchObject({});
    expect(JSON.parse(await readFile(backupPath, "utf8"))).toEqual(original);
    expect(migrated.provider).toBeUndefined();
    expect(migrated.base_url).toBeUndefined();
    expect(migrated.model).toMatchObject({ provider: "openai", id: "gpt-5" });
    expect(migrated.providers).toMatchObject({
      openai: {
        baseUrl: "https://legacy.example/v1"
      }
    });
    expect(result.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "backup-config", path: backupPath }),
      expect.objectContaining({ kind: "apply-migration", migrationId: "move-stale-root-model-provider" })
    ]));
  });

  it("is idempotent after migrations have already been applied", async () => {
    const homeDir = await tempDir();
    const paths = resolveProfileStateHome({ homeDir, profileId: "default" });
    const config = {
      model: {
        provider: "openai",
        id: "gpt-5"
      },
      providers: {
        openai: {
          baseUrl: "https://api.openai.com/v1"
        }
      },
      security: {},
      skills: {},
      ui: {}
    };
    await writeJson(paths.configPath, config);

    const result = await runDoctorConfigRepair({
      homeDir,
      profileId: "default",
      now: () => FIXED_NOW
    });

    expect(result.status).toBe("not-needed");
    expect(result.operations).toEqual([]);
    expect(result.backupPath).toBeUndefined();
    await expect(stat(`${paths.configPath}.bak-2026-07-02T00-00-00-000Z`)).rejects.toThrow();
    expect(JSON.parse(await readFile(paths.configPath, "utf8"))).toEqual(config);
  });

  it("blocks malformed config without backing up or mutating", async () => {
    const homeDir = await tempDir();
    const paths = resolveProfileStateHome({ homeDir, profileId: "default" });
    await mkdir(dirname(paths.configPath), { recursive: true });
    await writeFile(paths.configPath, "{not-json", "utf8");

    const result = await runDoctorConfigRepair({
      homeDir,
      profileId: "default",
      now: () => FIXED_NOW
    });

    expect(result.status).toBe("blocked");
    expect(result.backupPath).toBeUndefined();
    expect(result.warnings).toEqual([
      expect.stringContaining("Config repair blocked because config JSON is invalid:")
    ]);
    expect(await readFile(paths.configPath, "utf8")).toBe("{not-json");
    await expect(stat(`${paths.configPath}.bak-2026-07-02T00-00-00-000Z`)).rejects.toThrow();
  });

  it("removes env ghosts only when explicitly requested", async () => {
    const homeDir = await tempDir();
    const paths = resolveProfileStateHome({ homeDir, profileId: "default" });
    await writeJson(paths.configPath, {
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
    await writeFile(paths.envPath, "OPENROUTER_API_KEY=live-secret\nOPENAI_API_KEY=old-secret\n", "utf8");

    const defaultResult = await runDoctorConfigRepair({
      homeDir,
      profileId: "default",
      now: () => FIXED_NOW
    });

    expect(defaultResult.status).toBe("not-needed");
    expect(defaultResult.envBackupPath).toBeUndefined();
    expect(defaultResult.notChanged).toContain("Profile .env ghost keys were not removed; rerun with --remove-env-ghosts after review");
    expect(await readFile(paths.envPath, "utf8")).toContain("OPENAI_API_KEY=old-secret");

    const removalResult = await runDoctorConfigRepair({
      homeDir,
      profileId: "default",
      removeEnvGhosts: true,
      now: () => FIXED_NOW
    });
    const envBackupPath = `${paths.envPath}.bak-2026-07-02T00-00-00-000Z`;

    expect(removalResult.status).toBe("repaired");
    expect(removalResult.envBackupPath).toBe(envBackupPath);
    await expect(stat(envBackupPath)).resolves.toMatchObject({});
    expect(await readFile(envBackupPath, "utf8")).toContain("OPENAI_API_KEY=old-secret");
    expect(await readFile(paths.envPath, "utf8")).toBe("OPENROUTER_API_KEY=live-secret\n");
    expect(JSON.stringify(removalResult)).not.toContain("old-secret");
    expect(JSON.stringify(removalResult)).not.toContain("live-secret");
  });
});

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
