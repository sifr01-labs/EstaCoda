import { copyFile, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";
import type { MemoryFileKind } from "../contracts/memory.js";

export type MemoryPersistenceKind = MemoryFileKind | "promotions.json";

export type MemoryDiskSnapshot = {
  path: string;
  kind: MemoryPersistenceKind;
  mtimeMs: number | undefined;
  size: number;
  contentHash: string;
};

export type MemoryPersistenceWritePolicy = {
  createBackup?: boolean;
  now?: () => Date;
};

export type MemoryPersistenceWriteResult = {
  snapshot: MemoryDiskSnapshot;
  backupPath?: string;
};

export class MemoryPersistenceDriftError extends Error {
  readonly name = "MemoryPersistenceDriftError";
  readonly code = "memory-disk-drift";
  readonly kind: MemoryPersistenceKind;
  readonly path: string;
  readonly expected: MemoryDiskSnapshot;
  readonly actual: MemoryDiskSnapshot;

  constructor(input: {
    kind: MemoryPersistenceKind;
    path: string;
    expected: MemoryDiskSnapshot;
    actual: MemoryDiskSnapshot;
  }) {
    super(`Refusing to overwrite ${input.kind} because the disk file changed after it was loaded.`);
    this.kind = input.kind;
    this.path = input.path;
    this.expected = input.expected;
    this.actual = input.actual;
  }
}

export class MemoryPersistenceService {
  readonly #snapshots = new Map<string, MemoryDiskSnapshot>();

  async readFile(options: {
    path: string;
    kind: MemoryPersistenceKind;
  }): Promise<string | undefined> {
    const current = await readCurrentSnapshot(options.path, options.kind);
    this.#snapshots.set(options.path, current.snapshot);
    return current.content;
  }

  async trackFile(options: {
    path: string;
    kind: MemoryPersistenceKind;
  }): Promise<MemoryDiskSnapshot> {
    const current = await readCurrentSnapshot(options.path, options.kind);
    this.#snapshots.set(options.path, current.snapshot);
    return current.snapshot;
  }

  async writeFile(options: {
    path: string;
    kind: MemoryPersistenceKind;
    content: string;
    policy?: MemoryPersistenceWritePolicy;
  }): Promise<MemoryPersistenceWriteResult> {
    const current = await readCurrentSnapshot(options.path, options.kind);
    const expected = this.#snapshots.get(options.path) ?? current.snapshot;

    if (!snapshotsMatch(expected, current.snapshot)) {
      throw new MemoryPersistenceDriftError({
        kind: options.kind,
        path: options.path,
        expected,
        actual: current.snapshot
      });
    }

    let backupPath: string | undefined;
    if (options.policy?.createBackup === true && current.content !== undefined) {
      backupPath = `${options.path}.bak.${formatBackupTimestamp(options.policy.now?.() ?? new Date())}`;
      await copyFile(options.path, backupPath);
    }

    await atomicWriteFile(options.path, options.content);
    const written = await readCurrentSnapshot(options.path, options.kind);
    this.#snapshots.set(options.path, written.snapshot);
    return backupPath === undefined
      ? { snapshot: written.snapshot }
      : { snapshot: written.snapshot, backupPath };
  }

  snapshotFor(path: string): MemoryDiskSnapshot | undefined {
    return this.#snapshots.get(path);
  }
}

async function atomicWriteFile(path: string, content: string): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  const tempPath = join(
    directory,
    `.${basename(path)}.${process.pid}.${Date.now()}.${randomBytes(8).toString("hex")}.tmp`
  );
  let renamed = false;
  try {
    await writeFile(tempPath, content, "utf8");
    await rename(tempPath, path);
    renamed = true;
  } finally {
    if (!renamed) {
      await unlink(tempPath).catch(() => undefined);
    }
  }
}

export function isMemoryPersistenceDriftError(error: unknown): error is MemoryPersistenceDriftError {
  return error instanceof MemoryPersistenceDriftError;
}

async function readCurrentSnapshot(
  path: string,
  kind: MemoryPersistenceKind
): Promise<{ snapshot: MemoryDiskSnapshot; content: string | undefined }> {
  try {
    const [stats, content] = await Promise.all([
      stat(path),
      readFile(path, "utf8")
    ]);
    return {
      content,
      snapshot: {
        path,
        kind,
        mtimeMs: stats.mtimeMs,
        size: stats.size,
        contentHash: hashContent(content)
      }
    };
  } catch (error) {
    if (!isNotFound(error)) {
      throw error;
    }
    return {
      content: undefined,
      snapshot: {
        path,
        kind,
        mtimeMs: undefined,
        size: 0,
        contentHash: hashContent("")
      }
    };
  }
}

function snapshotsMatch(left: MemoryDiskSnapshot, right: MemoryDiskSnapshot): boolean {
  return left.path === right.path &&
    left.kind === right.kind &&
    left.mtimeMs === right.mtimeMs &&
    left.size === right.size &&
    left.contentHash === right.contentHash;
}

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function formatBackupTimestamp(date: Date): string {
  return date.toISOString().replace(/[:.]/gu, "-");
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
