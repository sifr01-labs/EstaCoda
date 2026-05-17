import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { resolveGlobalStateHome } from "../config/profile-home.js";

export type SharedMemoryEntry = {
  key: string;
  content: string;
  createdAt: Date;
  updatedAt: Date;
};

export type SharedMemoryOptions = {
  homeDir?: string;
};

export async function readSharedMemory(key: string, options?: SharedMemoryOptions): Promise<string | undefined> {
  try {
    return await readFile(resolveSharedMemoryPath(key, options), "utf8");
  } catch (error) {
    if (isNotFound(error)) {
      return undefined;
    }
    throw error;
  }
}

export async function writeSharedMemory(key: string, content: string, options?: SharedMemoryOptions): Promise<void> {
  const path = resolveSharedMemoryPath(key, options);
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, content, { encoding: "utf8", mode: 0o600 });
  await rename(tempPath, path);
}

export async function listSharedMemory(options?: SharedMemoryOptions): Promise<SharedMemoryEntry[]> {
  const root = resolveGlobalStateHome(options).sharedMemoryPath;
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isNotFound(error)) {
      return [];
    }
    throw error;
  }

  const result: SharedMemoryEntry[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || entry.name.startsWith(".")) {
      continue;
    }
    const key = entry.name.endsWith(".md") ? entry.name.slice(0, -3) : entry.name;
    validateSharedMemoryKey(key);
    const path = join(root, entry.name);
    const [content, metadata] = await Promise.all([
      readFile(path, "utf8"),
      stat(path),
    ]);
    result.push({
      key,
      content,
      createdAt: metadata.birthtime,
      updatedAt: metadata.mtime,
    });
  }

  return result.sort((left, right) => left.key.localeCompare(right.key));
}

function resolveSharedMemoryPath(key: string, options?: SharedMemoryOptions): string {
  const normalized = validateSharedMemoryKey(key);
  const filename = normalized.endsWith(".md") ? normalized : `${normalized}.md`;
  return join(resolveGlobalStateHome(options).sharedMemoryPath, filename);
}

function validateSharedMemoryKey(value: string): string {
  const key = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(key) || key === "." || key === "..") {
    throw new Error(`Invalid shared memory key: ${value}`);
  }
  return key;
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
