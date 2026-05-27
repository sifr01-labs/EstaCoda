import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { resolveProfileStateHome } from "./profile-home.js";

export type EnvSecretWriteResult = {
  path: string;
  key: string;
};

export type SavedEnvSecretPresence = {
  path: string;
  exists: boolean;
};

export function defaultEnvPath(homeDir?: string): string {
  return join(homeDir ?? process.env.HOME ?? "", ".estacoda", ".env");
}

export async function writeEnvSecret(options: {
  homeDir?: string;
  path?: string;
  profileId?: string;
  key: string;
  value: string;
}): Promise<EnvSecretWriteResult> {
  const path = options.path ?? (options.profileId === undefined
    ? defaultEnvPath(options.homeDir)
    : resolveProfileStateHome({ homeDir: options.homeDir, profileId: options.profileId }).envPath);
  const key = normalizeEnvKey(options.key);
  const nextLine = `${key}=${quoteDotEnvValue(options.value)}`;
  const existing = await readEnvFile(path);
  const lines = existing.length === 0 ? [] : existing.split(/\r?\n/u);
  let replaced = false;
  const updated = lines.map((line) => {
    if (line.trimStart().startsWith(`${key}=`)) {
      replaced = true;
      return nextLine;
    }
    return line;
  }).filter((line, index, all) => !(line === "" && index === all.length - 1));

  if (!replaced) {
    updated.push(nextLine);
  }

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${updated.join("\n")}\n`, "utf8");
  await chmod(path, 0o600);

  return { path, key };
}

export async function loadDotEnvSecrets(options: {
  homeDir?: string;
  path?: string;
  profileId?: string;
  override?: boolean;
}): Promise<string[]> {
  const path = options.path ?? (options.profileId === undefined
    ? defaultEnvPath(options.homeDir)
    : resolveProfileStateHome({ homeDir: options.homeDir, profileId: options.profileId }).envPath);
  const content = await readEnvFile(path);
  const loaded: string[] = [];

  for (const line of content.split(/\r?\n/u)) {
    const parsed = parseDotEnvLine(line);
    if (parsed === undefined) {
      continue;
    }
    if (options.override !== true && process.env[parsed.key] !== undefined) {
      continue;
    }
    process.env[parsed.key] = parsed.value;
    loaded.push(parsed.key);
  }

  return loaded;
}

export async function hasSavedEnvSecret(options: {
  homeDir?: string;
  path?: string;
  profileId?: string;
  key: string;
}): Promise<SavedEnvSecretPresence> {
  const path = options.path ?? (options.profileId === undefined
    ? defaultEnvPath(options.homeDir)
    : resolveProfileStateHome({ homeDir: options.homeDir, profileId: options.profileId }).envPath);
  const key = normalizeEnvKey(options.key);
  const content = await readEnvFile(path);

  for (const line of content.split(/\r?\n/u)) {
    const parsed = parseDotEnvLine(line);
    if (parsed?.key === key) {
      if (parsed.value.trim().length > 0) {
        return { path, exists: true };
      }
    }
  }

  return { path, exists: false };
}

function normalizeEnvKey(key: string): string {
  const trimmed = key.trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(trimmed)) {
    throw new Error(`Invalid environment variable name: ${key}`);
  }
  return trimmed;
}

async function readEnvFile(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

function quoteDotEnvValue(value: string): string {
  return `"${value.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"').replace(/\n/gu, "\\n")}"`;
}

function parseDotEnvLine(line: string): { key: string; value: string } | undefined {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.startsWith("#")) {
    return undefined;
  }

  const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u.exec(trimmed);
  if (match === null) {
    return undefined;
  }

  return {
    key: match[1],
    value: unquoteDotEnvValue(match[2].trim())
  };
}

function unquoteDotEnvValue(value: string): string {
  if (value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\n/gu, "\n").replace(/\\"/gu, '"').replace(/\\\\/gu, "\\");
  }
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  return value;
}
