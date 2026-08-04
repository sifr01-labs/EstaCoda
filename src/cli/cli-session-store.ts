import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { resolveHomeDir } from "../config/home-dir.js";
import { normalizeProfileId } from "../config/profile-home.js";

type CliSessionFileV2 = {
  version: 2;
  entries: CliSessionEntryV2[];
};

export type CliSessionEntryV2 = {
  profileId: string;
  workspaceRoot: string;
  sessionId: string;
  updatedAt: string;
};

export class PersistentCliSessionStore {
  readonly #path: string;
  readonly #now: () => Date;

  constructor(options: { path?: string; homeDir?: string; now?: () => Date } = {}) {
    this.#path = options.path ?? join(resolveHomeDir(options.homeDir), ".estacoda", "cli-sessions.json");
    this.#now = options.now ?? (() => new Date());
  }

  get path(): string {
    return this.#path;
  }

  async getSessionId(input: { profileId: string; workspaceRoot: string }): Promise<string | undefined> {
    const key = normalizeKey(input);
    const file = await this.#read();
    return file.entries.find((entry) => entry.profileId === key.profileId && entry.workspaceRoot === key.workspaceRoot)?.sessionId;
  }

  async setSessionId(input: { profileId: string; workspaceRoot: string; sessionId: string }): Promise<void> {
    const key = normalizeKey(input);
    const sessionId = normalizeSessionId(input.sessionId);
    const file = await this.#read();
    const entry: CliSessionEntryV2 = {
      ...key,
      sessionId,
      updatedAt: this.#now().toISOString(),
    };
    const entries = file.entries
      .filter((candidate) => candidate.profileId !== key.profileId || candidate.workspaceRoot !== key.workspaceRoot);
    entries.push(entry);
    entries.sort((left, right) =>
      left.profileId.localeCompare(right.profileId) || left.workspaceRoot.localeCompare(right.workspaceRoot)
    );
    await this.#write({ version: 2, entries });
  }

  async #read(): Promise<CliSessionFileV2> {
    try {
      const value: unknown = JSON.parse(await readFile(this.#path, "utf8"));
      if (typeof value !== "object" || value === null) {
        return emptyFile();
      }
      const parsed = value as Partial<CliSessionFileV2>;
      if (parsed.version !== 2 || !Array.isArray(parsed.entries)) {
        return emptyFile();
      }
      return {
        version: 2,
        entries: parsed.entries.flatMap((entry) => normalizeEntry(entry)),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) {
        return emptyFile();
      }
      throw error;
    }
  }

  async #write(file: CliSessionFileV2): Promise<void> {
    const tempPath = `${this.#path}.${process.pid}.${Date.now()}.tmp`;
    await mkdir(dirname(this.#path), { recursive: true });
    try {
      await writeFile(tempPath, `${JSON.stringify(file, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await chmod(tempPath, 0o600).catch(() => undefined);
      await rename(tempPath, this.#path);
      await chmod(this.#path, 0o600).catch(() => undefined);
    } catch (error) {
      await unlink(tempPath).catch(() => undefined);
      throw error;
    }
  }
}

function emptyFile(): CliSessionFileV2 {
  return { version: 2, entries: [] };
}

function normalizeEntry(value: unknown): CliSessionEntryV2[] {
  if (typeof value !== "object" || value === null) return [];
  const entry = value as Partial<CliSessionEntryV2>;
  if (
    typeof entry.profileId !== "string" ||
    typeof entry.workspaceRoot !== "string" ||
    typeof entry.sessionId !== "string" ||
    typeof entry.updatedAt !== "string"
  ) return [];
  try {
    return [{
      ...normalizeKey({ profileId: entry.profileId, workspaceRoot: entry.workspaceRoot }),
      sessionId: normalizeSessionId(entry.sessionId),
      updatedAt: entry.updatedAt,
    }];
  } catch {
    return [];
  }
}

function normalizeKey(input: { profileId: string; workspaceRoot: string }): {
  profileId: string;
  workspaceRoot: string;
} {
  if (input.workspaceRoot.trim().length === 0 || /[\u0000-\u001f\u007f]/u.test(input.workspaceRoot)) {
    throw new Error("Invalid CLI session workspace root.");
  }
  return {
    profileId: normalizeProfileId(input.profileId),
    workspaceRoot: resolve(input.workspaceRoot),
  };
}

function normalizeSessionId(value: string): string {
  const sessionId = value.trim();
  if (sessionId.length === 0 || sessionId.length > 256 || /[\u0000-\u001f\u007f]/u.test(sessionId)) {
    throw new Error("Invalid CLI session id.");
  }
  return sessionId;
}
