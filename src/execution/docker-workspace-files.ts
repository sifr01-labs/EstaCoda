import { DockerFileService } from "./docker-file-service.js";
import type { HostProcesses } from "./host-processes.js";
import { resolve } from "node:path";
import type { Stats, Dirent } from "node:fs";
import { explainPathBlock } from "../context/context-security.js";
import type { WorkspaceFiles, WorkspacePathOptions } from "./host-workspace-files.js";
import type { WorkspacePathResolution } from "../tools/workspace-paths.js";
import { DockerContainer } from "./docker-container.js";
const services = new WeakMap<DockerContainer, DockerFileService>();

export class DockerWorkspaceFiles implements WorkspaceFiles {
  constructor(readonly container: DockerContainer, readonly assertActive: () => void = () => {}, readonly processes?: HostProcesses, readonly homeDir?: string) {}
  async #call(op: string, path: string | undefined, extra: Record<string, unknown> = {}): Promise<any> {
    this.assertActive();
    const root = this.container.workspace.canonicalPath;
    if (typeof path !== "string" || !path) throw new Error("path must be a non-empty string");
    for (const raw of [path, extra.to].filter((p): p is string => typeof p === "string")) {
      const blocked = explainPathBlock(root, resolve(root, raw)); if (blocked) throw new Error(blocked);
    }
    if (["write", "mkdir", "rm", "rename"].includes(op) && this.container.facts.workspaceAccess !== "read-write") throw new Error("Docker workspace is read-only.");
    const input = JSON.stringify({ root, op, path, ...extra });
    if (Buffer.byteLength(input)>12*1024*1024) throw new Error("Workspace request exceeds its limit.");
    this.assertActive();
    let result: unknown;
    if (this.processes) {
      if (!this.processes.workspaceRequest) throw new Error("Docker file transport is unavailable; host fallback is disabled.");
      result = await this.processes.workspaceRequest(input);
    } else {
      let service = services.get(this.container);
      if (!service) {
        await this.container.verify();
        this.assertActive();
        service = services.get(this.container);
        if (!service) { service = new DockerFileService(this.container, this.homeDir); services.set(this.container, service); }
      }
      result = await service.request(input);
    }
    this.assertActive(); return result;
  }
  async resolvePath(path: string | undefined, options: WorkspacePathOptions = {}): Promise<WorkspacePathResolution> {
    try {
      const result = await this.#call("resolve", path, { options });
      const blocked = explainPathBlock(this.container.workspace.canonicalPath, result);
      return blocked ? { ok: false, content: blocked } : { ok: true, path: result };
    } catch (error) { return { ok: false, content: error instanceof Error ? error.message : "Docker path is unavailable." }; }
  }
  async #resolved(path: string, options: WorkspacePathOptions = {}): Promise<string> {
    const result = await this.resolvePath(path, options);
    if (!result.ok) throw Object.assign(new Error(result.content), { code: result.content.includes("does not exist") ? "ENOENT" : "EACCES" });
    return result.path;
  }
  async realpath(path: string): Promise<string> { return this.#resolved(path, { allowDirectory: true }); }
  async readFile(path: string): Promise<Buffer>;
  async readFile(path: string, encoding: "utf8"): Promise<string>;
  async readFile(path: string, encoding?: "utf8"): Promise<Buffer | string> {
    const result = Buffer.from(await this.#call("read", await this.#resolved(path)), "base64");
    return encoding ? result.toString(encoding) : result;
  }
  async preview(path: string): Promise<{bytes:Buffer;size:number}> {
    const result = await this.#call("preview", path);
    return {bytes:Buffer.from(result.bytes,"base64"),size:result.size};
  }
  async writeFile(path: string, content: string, options: "utf8" | { encoding: "utf8"; flag: string } = "utf8"): Promise<void> { await this.#call("write", path, { content, options: typeof options === "string" ? {} : options }); }
  async stat(path: string): Promise<Stats> { return nodeStats(await this.#call("stat", await this.#resolved(path, { allowDirectory: true }))) as Stats; }
  async lstat(path: string): Promise<Stats> { await this.#resolved(path, { allowDirectory: true }); return nodeStats(await this.#call("lstat", path)) as Stats; }
  async readdir(path: string, _options: { withFileTypes: true }): Promise<Dirent[]> { return (await this.#call("readdir", await this.#resolved(path, { allowDirectory: true }))).map((entry: any) => ({ ...nodeStats(entry), name: entry.name, parentPath: path, path })); }
  async mkdir(path: string): Promise<void> { await this.#call("mkdir", path); }
  async rm(path: string, options?: { force?: boolean }): Promise<void> { await this.#call("rm", path, { options }); }
  async rename(from: string, to: string): Promise<void> { await this.#call("rename", from, { to }); }
}
function nodeStats(value: any) {
  return { ...value, mtime: new Date(value.mtimeMs), atime: new Date(value.atimeMs), ctime: new Date(value.ctimeMs), birthtime: new Date(value.birthtimeMs),
    isFile: () => value.kind === "file", isDirectory: () => value.kind === "directory", isSymbolicLink: () => value.kind === "symlink",
    isSocket: () => false, isFIFO: () => false, isBlockDevice: () => false, isCharacterDevice: () => false };
}
