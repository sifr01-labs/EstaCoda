import { copyFile, readFile, rename, writeFile } from "node:fs/promises";
import { defaultProfileId, readActiveProfile, resolveGlobalStateHome, resolveProfileStateHome } from "../config/profile-home.js";
import { applyConfigMigration, planConfigMigrations, type ConfigMigrationId } from "../config/migrations.js";
import type { EstaCodaConfig } from "../config/runtime-config.js";
import type { DoctorLocale } from "./types.js";
import { diagnoseConfigDrift } from "./checks/config-drift.js";

export type DoctorConfigRepairOperationKind =
  | "backup-config"
  | "apply-migration"
  | "backup-env"
  | "remove-env-ghost";

export type DoctorConfigRepairOperation = {
  readonly id: string;
  readonly kind: DoctorConfigRepairOperationKind;
  readonly path?: string;
  readonly key?: string;
  readonly migrationId?: ConfigMigrationId;
};

export type DoctorConfigRepairResult = {
  readonly locale: DoctorLocale;
  readonly profile: string;
  readonly home: string;
  readonly status: "repaired" | "not-needed" | "blocked";
  readonly operations: readonly DoctorConfigRepairOperation[];
  readonly notChanged: readonly string[];
  readonly warnings: readonly string[];
  readonly backupPath?: string;
  readonly envBackupPath?: string;
};

export async function runDoctorConfigRepair(options: {
  readonly homeDir?: string;
  readonly profileId?: string;
  readonly locale?: DoctorLocale;
  readonly removeEnvGhosts?: boolean;
  readonly now?: () => Date;
}): Promise<DoctorConfigRepairResult> {
  const activeProfile = readActiveProfileForConfigRepair({ homeDir: options.homeDir });
  const profileId = options.profileId ?? activeProfile.profileId;
  const profilePaths = resolveProfileStateHome({ homeDir: options.homeDir, profileId });
  const globalPaths = resolveGlobalStateHome({ homeDir: options.homeDir });
  const locale = options.locale ?? "en";
  const parsed = await readConfigObject(profilePaths.configPath);

  if (parsed.kind === "missing") {
    return blockedResult({
      locale,
      profileId,
      home: globalPaths.stateRoot,
      warnings: [`Profile config is missing: ${profilePaths.configPath}`, ...activeProfile.warnings]
    });
  }
  if (parsed.kind === "malformed") {
    return blockedResult({
      locale,
      profileId,
      home: globalPaths.stateRoot,
      warnings: [`Config repair blocked because config JSON is invalid: ${parsed.message}`, ...activeProfile.warnings]
    });
  }
  if (!isRecord(parsed.value)) {
    return blockedResult({
      locale,
      profileId,
      home: globalPaths.stateRoot,
      warnings: [`Config repair blocked because profile config is not a JSON object: ${profilePaths.configPath}`, ...activeProfile.warnings]
    });
  }

  const drift = await diagnoseConfigDrift({
    configPath: profilePaths.configPath,
    envPath: profilePaths.envPath
  });
  const migrationPlans = planConfigMigrations(parsed.value);
  const operations: DoctorConfigRepairOperation[] = [];
  let backupPath: string | undefined;
  let envBackupPath: string | undefined;

  if (migrationPlans.length > 0) {
    backupPath = backupPathFor(profilePaths.configPath, options.now?.() ?? new Date());
    await copyFile(profilePaths.configPath, backupPath);
    operations.push({
      id: `backup-config:${backupPath}`,
      kind: "backup-config",
      path: backupPath
    });

    let migrated = parsed.value as EstaCodaConfig;
    for (const plan of migrationPlans) {
      migrated = applyConfigMigration(migrated, plan.id);
      operations.push({
        id: `apply-migration:${plan.id}`,
        kind: "apply-migration",
        migrationId: plan.id
      });
    }
    await writeJsonAtomic(profilePaths.configPath, migrated);
  }

  if (options.removeEnvGhosts === true && drift.envGhosts.length > 0) {
    envBackupPath = backupPathFor(profilePaths.envPath, options.now?.() ?? new Date());
    await copyFile(profilePaths.envPath, envBackupPath);
    operations.push({
      id: `backup-env:${envBackupPath}`,
      kind: "backup-env",
      path: envBackupPath
    });
    await removeEnvKeys(profilePaths.envPath, drift.envGhosts.map((ghost) => ghost.key));
    for (const ghost of drift.envGhosts) {
      operations.push({
        id: `remove-env-ghost:${ghost.key}`,
        kind: "remove-env-ghost",
        key: ghost.key
      });
    }
  }

  const notChanged: string[] = [
    "Workspace trust was not changed",
    "Provider credentials were not created",
    "Network providers were not enabled"
  ];
  if (drift.envGhosts.length > 0 && options.removeEnvGhosts !== true) {
    notChanged.push("Profile .env ghost keys were not removed; rerun with --remove-env-ghosts after review");
  }

  return {
    locale,
    profile: profileId,
    home: globalPaths.stateRoot,
    status: operations.length > 0 ? "repaired" : "not-needed",
    operations,
    notChanged,
    warnings: activeProfile.warnings,
    backupPath,
    envBackupPath
  };
}

function blockedResult(input: {
  readonly locale: DoctorLocale;
  readonly profileId: string;
  readonly home: string;
  readonly warnings: readonly string[];
}): DoctorConfigRepairResult {
  return {
    locale: input.locale,
    profile: input.profileId,
    home: input.home,
    status: "blocked",
    operations: [],
    notChanged: [
      "Profile config was not changed",
      "Profile .env was not changed"
    ],
    warnings: input.warnings
  };
}

async function readConfigObject(path: string): Promise<
  | { readonly kind: "loaded"; readonly value: unknown }
  | { readonly kind: "missing" }
  | { readonly kind: "malformed"; readonly message: string }
> {
  try {
    return { kind: "loaded", value: JSON.parse(await readFile(path, "utf8")) };
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) return { kind: "missing" };
    if (error instanceof SyntaxError) return { kind: "malformed", message: error.message };
    throw error;
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const tempPath = `${path}.${process.pid}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tempPath, path);
}

async function removeEnvKeys(path: string, keys: readonly string[]): Promise<void> {
  const keySet = new Set(keys);
  const content = await readFile(path, "utf8");
  const lines = content.split(/\r?\n/u);
  const filtered = lines.filter((line) => {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/u.exec(line);
    return match === null || !keySet.has(match[1]!);
  });
  await writeFile(path, normalizeTrailingNewline(filtered.join("\n")), "utf8");
}

function backupPathFor(path: string, now: Date): string {
  return `${path}.bak-${now.toISOString().replace(/[:.]/gu, "-")}`;
}

function normalizeTrailingNewline(content: string): string {
  const withoutTrailingBlank = content.replace(/\n+$/u, "");
  return withoutTrailingBlank.length === 0 ? "" : `${withoutTrailingBlank}\n`;
}

function readActiveProfileForConfigRepair(options: { readonly homeDir?: string }): {
  readonly profileId: string;
  readonly warnings: readonly string[];
} {
  try {
    return {
      profileId: readActiveProfile(options).profileId ?? defaultProfileId(),
      warnings: []
    };
  } catch (error) {
    return {
      profileId: defaultProfileId(),
      warnings: [`Active profile state was not changed because it is invalid: ${errorMessage(error)}`]
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
