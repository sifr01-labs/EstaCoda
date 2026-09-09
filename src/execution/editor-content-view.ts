import { relative } from "node:path";
import type { WorkspaceFiles } from "./host-workspace-files.js";

/** Editor reads are observations, not an executable filesystem overlay. Only
 * paths actually supplied to the agent are tracked; unobserved buffers are unknown. */
export class EditorContentView {
  readonly #readers = new Map<string, () => Promise<string>>();
  constructor(readonly files: WorkspaceFiles, readonly root: string) {}
  async read(path: string, reader: () => Promise<string>): Promise<string> {
    const resolved = await this.files.resolvePath(path, { allowMissingLeaf: true });
    if (!resolved.ok) throw new Error(resolved.content);
    if (!this.#readers.has(resolved.path) && this.#readers.size >= 128) throw new Error("Editor context limit reached. Save your files and start a new session.");
    const content = await this.#boundedRead(reader);
    this.#readers.set(resolved.path, reader);
    return content;
  }
  async isMaterialized(path: string): Promise<boolean> {
    const resolved = await this.files.resolvePath(path, { allowMissingLeaf: true });
    if (!resolved.ok) throw new Error(resolved.content);
    const reader = this.#readers.get(resolved.path);
    if (!reader) return true;
    try { return await this.#boundedRead(reader) === await this.files.readFile(resolved.path, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw new Error("Editor content could not be verified. Save or reload the file before running workspace operations.");
    }
  }
  async assertMaterialized(): Promise<void> {
    for (const path of this.#readers.keys()) {
      if (!await this.isMaterialized(path)) throw new Error(`Editor content for ${relative(this.root, path)} differs from the execution files. Save or reload it before running workspace operations.`);
    }
  }
  async #boundedRead(reader: () => Promise<string>): Promise<string> {
    const content = await reader();
    if (Buffer.byteLength(content) > 8 * 1024 * 1024) throw new Error("Editor file exceeds the 8 MiB read limit.");
    return content;
  }
}
export type ExecutionContentView = Pick<EditorContentView, "read" | "isMaterialized" | "assertMaterialized">;
