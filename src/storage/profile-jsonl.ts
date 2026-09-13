import { constants } from "node:fs";
import { lstat, open, rename, rm, type FileHandle } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { randomUUID, createHash } from "node:crypto";

export type JsonlQuery<T> = {
  where?: (row: T) => boolean;
  offset?: number;
  limit?: number;
  tail?: boolean;
};

/** Profile-selected state only. Bound records and materialized results, not lifetime history. */
export class ProfileJsonl {
  constructor(readonly root: string) {}

  async check(path: string) {
    const rel = relative(this.root, path);
    if (!rel || rel.startsWith("..") || resolve(this.root, rel) !== path) {
      throw new Error("Invalid evolution path");
    }
    for (let dir = dirname(path); ; dir = dirname(dir)) {
      const stat = await lstat(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Invalid evolution directory");
      if (dir === this.root) break;
    }
  }

  async *rows<T>(path: string): AsyncGenerator<T> {
    let file: FileHandle;
    try {
      await this.check(path);
      file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    try {
      const stat = await file.stat();
      if (!stat.isFile()) throw new Error("Invalid evolution file");
      const buffer = Buffer.alloc(65536);
      let position = 0, pending = Buffer.alloc(0);
      const parse = (line: Buffer): T | undefined => {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(line).trim();
        if (!text) return;
        const row = JSON.parse(text);
        if (!row || typeof row !== "object" || typeof row.id !== "string" || !/^[A-Za-z0-9_.:-]{1,160}$/.test(row.id)) {
          throw new Error("Invalid evolution record");
        }
        return row as T;
      };
      // A descriptor and initial length give a finite scan even during continuous append.
      while (position < stat.size) {
        const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, stat.size - position), position);
        if (!bytesRead) throw new Error("Evolution history changed during read");
        position += bytesRead;
        pending = Buffer.concat([pending, buffer.subarray(0, bytesRead)]);
        let newline: number;
        while ((newline = pending.indexOf(10)) >= 0) {
          if (newline > 1048576) throw new Error("Evolution record exceeds bound");
          const row = parse(pending.subarray(0, newline));
          pending = pending.subarray(newline + 1);
          if (row !== undefined) yield row;
        }
        if (pending.length > 1048576) throw new Error("Evolution record exceeds bound");
      }
      if (pending.length) {
        const row = parse(pending);
        if (row !== undefined) yield row;
      }
    } finally {
      await file.close();
    }
  }

  async query<T>(path: string, query: JsonlQuery<T> = {}): Promise<T[]> {
    const rows: T[] = [];
    let skipped = 0;
    const limit = query.limit ?? 1000;
    for await (const row of this.rows<T>(path)) {
      if (query.where && !query.where(row)) continue;
      if (skipped++ < (query.offset ?? 0)) continue;
      if (query.tail) {
        rows.push(row);
        if (rows.length > limit) rows.shift();
      } else {
        rows.push(row);
        if (rows.length === limit && query.limit !== undefined) break;
        if (rows.length > limit) throw new Error("Evolution query exceeds bound");
      }
    }
    return rows;
  }

  async digest<T>(path: string, where: (row: T) => boolean) {
    const hash = createHash("sha256");
    for await (const row of this.rows<T>(path)) {
      if (where(row)) hash.update(JSON.stringify(row) + "\n");
    }
    return hash.digest("hex");
  }

  /** Called under the existing profile write lock. Never truncate history to a UI page. */
  async rewrite<T extends { id: string }>(path: string, id: string, update: (row: T) => T): Promise<T | undefined> {
    await this.check(path);
    const before = await lstat(path);
    const temp = path + "." + randomUUID();
    const output = await open(temp, "wx", 0o600);
    let updated: T | undefined;
    try {
      for await (const row of this.rows<T>(path)) {
        const next = row.id === id ? (updated = update(row)) : row;
        await output.writeFile(JSON.stringify(next) + "\n");
      }
      await output.sync();
      await output.close();
      if (updated) {
        const current = await lstat(path);
        if (current.isSymbolicLink() || current.ino !== before.ino || current.size !== before.size || current.mtimeMs !== before.mtimeMs) {
          throw new Error("Evolution history changed during rewrite");
        }
        await rename(temp, path);
        const directory = await open(dirname(path), "r");
        try { await directory.sync(); } finally { await directory.close(); }
      }
      return updated;
    } finally {
      await output.close();
      await rm(temp, { force: true });
    }
  }
}
