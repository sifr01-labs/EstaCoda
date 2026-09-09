import { explainPathBlock } from "../context/context-security.js";
import * as fs from "node:fs/promises";
import type { Dirent, Stats } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { resolveWorkspacePath, type WorkspacePathResolution } from "../tools/workspace-paths.js";

export type WorkspacePathOptions = { allowMissingLeaf?: boolean; allowDirectory?: boolean; forbidSymlinks?: boolean };
/** Only operations used by workspace tools and inspection. Paths belong to this
 * execution view; implementations must not fall back to the caller's host FS. */
export interface WorkspaceFiles {
  realpath(path: string): Promise<string>;
  resolvePath(path: string | undefined, options?: WorkspacePathOptions): Promise<WorkspacePathResolution>;
  readFile(path: string): Promise<Buffer>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
  writeFile(path: string, content: string, options?: "utf8" | { encoding: "utf8"; flag: string }): Promise<void>;
  stat(path: string): Promise<Stats>;
  lstat(path: string): Promise<Stats>;
  readdir(path: string, options: { withFileTypes: true }): Promise<Dirent[]>;
  mkdir(path: string): Promise<void>;
  rm(path: string, options?: { force?: boolean }): Promise<void>;
  rename(from: string, to: string): Promise<void>;
}

export class HostWorkspaceFiles implements WorkspaceFiles {
  readonly #root: string;
  readonly #assertActive: () => void;
  #canonicalRoot?: string;
  constructor(workspaceRoot: string, assertActive: () => void = () => {}) {
    this.#root = resolve(workspaceRoot);
    this.#assertActive = assertActive;
  }
  async #rootPath(): Promise<string> {
    this.#assertActive();
    const actual = await fs.realpath(this.#root);
    this.#canonicalRoot ??= actual;
    if (this.#canonicalRoot !== actual) throw new Error("Workspace execution view changed. Select the target again.");
    this.#assertActive();
    return actual;
  }
  async resolvePath(path: string | undefined, options: WorkspacePathOptions = {}): Promise<WorkspacePathResolution> {
    const root = await this.#rootPath();
    if (path !== undefined && isAbsolute(path)) {
      const suffix = relative(this.#root, path);
      if (suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix)) path = resolve(root, suffix);
    }
    const result = await resolveWorkspacePath(root, path, options);
    const blocked = result.ok ? explainPathBlock(root, result.path) : undefined;
    return blocked === undefined ? result : { ok: false, content: blocked };
  }
  async #checked(path: string, options: WorkspacePathOptions = {}): Promise<string> {
    const result = await this.resolvePath(path, options);
    if (!result.ok) throw Object.assign(new Error(result.content), { code: result.content.includes("ENOENT") ? "ENOENT" : "EACCES" });
    this.#assertActive();
    return result.path;
  }
  async realpath(path: string): Promise<string> { return this.#checked(path, { allowDirectory: true }); }
  async stat(path: string): Promise<Stats> { return fs.stat(await this.#checked(path, { allowDirectory: true })); }
  async lstat(path: string): Promise<Stats> {
    await this.#checked(path, { allowDirectory: true, allowMissingLeaf: true });
    return fs.lstat(path);
  }
  async readdir(path: string, _options: { withFileTypes: true }): Promise<Dirent[]> {
    return fs.readdir(await this.#checked(path, { allowDirectory: true }), { withFileTypes: true });
  }
  async readFile(path: string): Promise<Buffer>;
  async readFile(path: string, encoding: "utf8"): Promise<string>;
  async readFile(path: string, encoding?: "utf8"): Promise<Buffer | string> {
    const checked = await this.#checked(path);
    const info = await fs.stat(checked);
    if (!info.isFile()) throw new Error("Workspace reads require a regular file.");
    const bytes = await fs.readFile(checked);
    return encoding === undefined ? bytes : bytes.toString(encoding);
  }
  async writeFile(path: string, content: string, options: "utf8" | { encoding: "utf8"; flag: string } = "utf8"): Promise<void> {
    await fs.writeFile(await this.#checked(path, { allowMissingLeaf: true, forbidSymlinks: true }), content, options);
  }
  async mkdir(path: string): Promise<void> { await fs.mkdir(await this.#checked(path, { allowMissingLeaf: true, allowDirectory: true, forbidSymlinks: true })); }
  async rm(path: string, options?: { force?: boolean }): Promise<void> {
    await fs.rm(await this.#checked(path, { allowMissingLeaf: options?.force, forbidSymlinks: true }), options);
  }
  async rename(from: string, to: string): Promise<void> {
    const source = await this.#checked(from, { forbidSymlinks: true });
    const target = await this.#checked(to, { allowMissingLeaf: true, forbidSymlinks: true });
    await fs.rename(source, target);
  }
}
