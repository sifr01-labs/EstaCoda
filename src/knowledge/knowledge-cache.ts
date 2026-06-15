import { readFile, writeFile, stat, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, relative } from "node:path";
import {
  type CodeDependencyGraph,
  type GraphParseOptions,
  buildCodeDependencyGraph,
  graphFromJson,
  graphToJson,
} from "./code-dependency-graph.js";

export type CachedGraph = {
  graph: CodeDependencyGraph;
  sourceHash: string;    // hash of scanned file mtimes
  generatedAt: string;
};

export type KnowledgeCacheOptions = {
  workspaceRoot: string;
  cachePath?: string;
  ignoreDirs?: Set<string>;
};

export class KnowledgeCache {
  readonly #workspaceRoot: string;
  readonly #cachePath: string;
  readonly #ignoreDirs: Set<string>;
  #cached: CachedGraph | null = null;

  constructor(options: KnowledgeCacheOptions) {
    this.#workspaceRoot = options.workspaceRoot;
    this.#cachePath =
      options.cachePath ??
      join(this.#workspaceRoot, ".estacoda", "code-dependency-graph.json");
    this.#ignoreDirs = options.ignoreDirs ?? new Set([
      "node_modules", "dist", "build", ".git", ".estacoda", "coverage"
    ]);
  }

  async getGraph(options?: { forceRefresh?: boolean }): Promise<CodeDependencyGraph> {
    if (options?.forceRefresh) {
      return this.#regenerate();
    }

    // Try load from memory cache
    if (this.#cached !== null) {
      const currentHash = await this.#computeSourceHash();
      if (currentHash === this.#cached.sourceHash) {
        return this.#cached.graph;
      }
    }

    // Try load from disk cache
    const diskCache = await this.#loadFromDisk();
    if (diskCache !== null) {
      const currentHash = await this.#computeSourceHash();
      if (currentHash === diskCache.sourceHash) {
        this.#cached = diskCache;
        return diskCache.graph;
      }
    }

    // Regenerate
    return this.#regenerate();
  }

  async invalidate(): Promise<void> {
    this.#cached = null;
    try {
      await writeFile(this.#cachePath, "", "utf8");
    } catch {
      // ignore
    }
  }

  async #regenerate(): Promise<CodeDependencyGraph> {
    const graph = await buildCodeDependencyGraph({
      workspaceRoot: this.#workspaceRoot,
      ignoreDirs: this.#ignoreDirs,
    });
    const sourceHash = await this.#computeSourceHash();
    const cached: CachedGraph = { graph, sourceHash, generatedAt: graph.generatedAt };
    this.#cached = cached;
    await this.#saveToDisk(cached);
    return graph;
  }

  async #loadFromDisk(): Promise<CachedGraph | null> {
    try {
      const raw = await readFile(this.#cachePath, "utf8");
      if (raw.length === 0) return null;
      const parsed = JSON.parse(raw) as {
        graph: string;
        sourceHash: string;
        generatedAt: string;
      };
      const graph = graphFromJson(parsed.graph);
      return { graph, sourceHash: parsed.sourceHash, generatedAt: parsed.generatedAt };
    } catch {
      return null;
    }
  }

  async #saveToDisk(cached: CachedGraph): Promise<void> {
    try {
      await mkdir(dirname(this.#cachePath), { recursive: true });
    } catch {
      // ignore
    }
    const payload = {
      graph: graphToJson(cached.graph),
      sourceHash: cached.sourceHash,
      generatedAt: cached.generatedAt,
    };
    await writeFile(this.#cachePath, JSON.stringify(payload, null, 2), "utf8");
  }

  async #computeSourceHash(): Promise<string> {
    const hash = createHash("sha256");
    const { readdir, stat } = await import("node:fs/promises");
    const { join } = await import("node:path");

    async function* walk(root: string, ignoreDirs: Set<string>): AsyncGenerator<string> {
      const stack: string[] = [root];
      while (stack.length > 0) {
        const dir = stack.pop()!;
        let entries: string[];
        try {
          entries = await readdir(dir);
        } catch {
          continue;
        }
        for (const entry of entries) {
          if (ignoreDirs.has(entry)) continue;
          const full = join(dir, entry);
          const st = await stat(full).catch(() => null);
          if (!st) continue;
          if (st.isDirectory()) {
            stack.push(full);
          } else if (st.isFile()) {
            const ext = full.slice(full.lastIndexOf("."));
            if (
              ext === ".ts" || ext === ".tsx" || ext === ".js" || ext === ".jsx" ||
              ext === ".mjs" || ext === ".cjs" || ext === ".json"
            ) {
              hash.update(`${relative(root, full)}:${st.mtimeMs}`);
            }
          }
        }
      }
    }

    for await (const _ of walk(this.#workspaceRoot, this.#ignoreDirs)) {
      // hash is updated inside walk
    }

    return hash.digest("hex");
  }
}
