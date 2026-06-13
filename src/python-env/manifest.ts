import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { resolveManagedPythonCapabilityManifestPath } from "./capability-paths.js";

export type ManagedPythonCapabilityEnvManifestStatus = "installing" | "installed" | "verified" | "broken";

export type ManagedPythonCapabilityEnvManifest = {
  id: string;
  version: string;
  specHash: string;
  installedPackages: string[];
  installedGroups: string[];
  pythonPath: string;
  envPath: string;
  createdAt: string;
  updatedAt: string;
  verifiedAt?: string;
  status: ManagedPythonCapabilityEnvManifestStatus;
};

export type ManagedPythonCapabilityManifestOptions = {
  stateRoot: string;
  capabilityId: string;
};

export async function readManagedPythonCapabilityManifest(
  options: ManagedPythonCapabilityManifestOptions
): Promise<ManagedPythonCapabilityEnvManifest | undefined> {
  const manifestPath = resolveManagedPythonCapabilityManifestPath(options);
  let raw: string;
  try {
    raw = await readFile(manifestPath, "utf8");
  } catch (error) {
    if (isNotFoundError(error)) {
      return undefined;
    }
    throw error;
  }
  return parseManifest(JSON.parse(raw), manifestPath);
}

export async function writeManagedPythonCapabilityManifest(
  options: ManagedPythonCapabilityManifestOptions,
  manifest: ManagedPythonCapabilityEnvManifest
): Promise<void> {
  if (manifest.id !== options.capabilityId) {
    throw new Error(`Manifest capability id '${manifest.id}' does not match requested capability '${options.capabilityId}'.`);
  }
  const manifestPath = resolveManagedPythonCapabilityManifestPath(options);
  const manifestDir = dirname(manifestPath);
  await mkdir(manifestDir, { recursive: true });
  const tempPath = `${manifestPath}.${process.pid}.${randomUUID()}.tmp`;
  const payload = `${JSON.stringify(manifest, null, 2)}\n`;
  try {
    await writeFile(tempPath, payload, { encoding: "utf8", mode: 0o600 });
    await rename(tempPath, manifestPath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function parseManifest(value: unknown, manifestPath: string): ManagedPythonCapabilityEnvManifest {
  if (!isRecord(value)) {
    throw new Error(`Managed Python capability manifest is not an object: ${manifestPath}`);
  }
  const manifest = value as Record<string, unknown>;
  const parsed: ManagedPythonCapabilityEnvManifest = {
    id: readString(manifest, "id", manifestPath),
    version: readString(manifest, "version", manifestPath),
    specHash: readString(manifest, "specHash", manifestPath),
    installedPackages: readStringArray(manifest, "installedPackages", manifestPath),
    installedGroups: readStringArray(manifest, "installedGroups", manifestPath),
    pythonPath: readString(manifest, "pythonPath", manifestPath),
    envPath: readString(manifest, "envPath", manifestPath),
    createdAt: readString(manifest, "createdAt", manifestPath),
    updatedAt: readString(manifest, "updatedAt", manifestPath),
    status: readStatus(manifest, manifestPath)
  };
  if (manifest.verifiedAt !== undefined) {
    parsed.verifiedAt = readString(manifest, "verifiedAt", manifestPath);
  }
  return parsed;
}

function readString(manifest: Record<string, unknown>, key: string, manifestPath: string): string {
  const value = manifest[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Managed Python capability manifest field '${key}' must be a non-empty string: ${manifestPath}`);
  }
  return value;
}

function readStringArray(manifest: Record<string, unknown>, key: string, manifestPath: string): string[] {
  const value = manifest[key];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`Managed Python capability manifest field '${key}' must be a string array: ${manifestPath}`);
  }
  return [...value] as string[];
}

function readStatus(
  manifest: Record<string, unknown>,
  manifestPath: string
): ManagedPythonCapabilityEnvManifestStatus {
  const value = manifest.status;
  if (value === "installing" || value === "installed" || value === "verified" || value === "broken") {
    return value;
  }
  throw new Error(`Managed Python capability manifest field 'status' is invalid: ${manifestPath}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNotFoundError(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}
