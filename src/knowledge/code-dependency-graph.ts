import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve } from "node:path";

export type ModuleNode = {
  id: string;           // relative file path from workspace root
  kind: "ts" | "js" | "json" | "external";
  sizeBytes: number;
};

export type ImportEdge = {
  from: string;         // importer module id
  to: string;           // imported module id
  kind: "static" | "dynamic" | "type-only";
  sourceLine: number;
};

export type CodeDependencyGraph = {
  nodes: Map<string, ModuleNode>;
  edges: ImportEdge[];
  generatedAt: string;
};

export type GraphParseOptions = {
  workspaceRoot: string;
  ignoreDirs?: Set<string>;
  ignoreGlobs?: string[];
};

const DEFAULT_IGNORE_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  ".git",
  ".estacoda",
  "coverage",
]);

const SOURCE_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

function isSourceFile(filename: string): boolean {
  const ext = extname(filename);
  if (ext === ".d.ts") return false;
  return SOURCE_EXTS.has(ext);
}

function moduleKindFromExt(filename: string): ModuleNode["kind"] {
  const ext = extname(filename);
  if (ext === ".json") return "json";
  if (SOURCE_EXTS.has(ext)) {
    return ext.startsWith(".js") || ext === ".mjs" || ext === ".cjs" ? "js" : "ts";
  }
  return "external";
}

async function* walkSourceFiles(root: string, ignoreDirs: Set<string>): AsyncGenerator<string> {
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
      const full = join(dir, entry);
      if (ignoreDirs.has(entry)) continue;
      const st = await stat(full).catch(() => null);
      if (!st) continue;
      if (st.isDirectory()) {
        stack.push(full);
      } else if (st.isFile() && isSourceFile(entry)) {
        yield full;
      }
    }
  }
}

// Regex patterns for import/export detection
const IMPORT_DEFAULT_RE = /^import\s+\w+\s+from\s+['"]([^'"]+)['"];?\s*$/;
const IMPORT_NAMED_RE = /^import\s+\{[^}]+\}\s+from\s+['"]([^'"]+)['"];?\s*$/;
const IMPORT_NAMESPACE_RE = /^import\s+\*\s+as\s+\w+\s+from\s+['"]([^'"]+)['"];?\s*$/;
const IMPORT_TYPE_RE = /^import\s+type\s+.*\s+from\s+['"]([^'"]+)['"];?\s*$/;
const IMPORT_SIDE_EFFECT_RE = /^import\s+['"]([^'"]+)['"];?\s*$/;
const EXPORT_FROM_RE = /^export\s+(?:\{[^}]*\}|\*|type\s+\{[^}]*\})\s+from\s+['"]([^'"]+)['"];?\s*$/;
const REQUIRE_RE = /(?:^|;|[(])\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/;
const DYNAMIC_IMPORT_RE = /(?:^|;|[(=])\s*(?:await\s+)?import\s*\(\s*['"]([^'"]+)['"]\s*\)/;

function extractImports(source: string, fromModule: string, workspaceRoot: string): ImportEdge[] {
  const edges: ImportEdge[] = [];
  const lines = source.split("\n");
  const seen = new Set<string>();

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex].trim();
    if (line.startsWith("//")) continue;

    let specifiers: { spec: string; kind: ImportEdge["kind"] }[] = [];

    // Static imports
    for (const pattern of [IMPORT_DEFAULT_RE, IMPORT_NAMED_RE, IMPORT_NAMESPACE_RE, IMPORT_SIDE_EFFECT_RE]) {
      const m = line.match(pattern);
      if (m) {
        specifiers.push({ spec: m[1], kind: "static" });
        break;
      }
    }

    // Type imports
    if (specifiers.length === 0) {
      const typeMatch = line.match(IMPORT_TYPE_RE);
      if (typeMatch) {
        specifiers.push({ spec: typeMatch[1], kind: "type-only" });
      }
    }

    // Export from
    if (specifiers.length === 0) {
      const exportMatch = line.match(EXPORT_FROM_RE);
      if (exportMatch) {
        specifiers.push({ spec: exportMatch[1], kind: "static" });
      }
    }

    // require()
    if (specifiers.length === 0) {
      const reqMatch = line.match(REQUIRE_RE);
      if (reqMatch) {
        specifiers.push({ spec: reqMatch[1], kind: "static" });
      }
    }

    // dynamic import()
    if (specifiers.length === 0) {
      const dynMatch = line.match(DYNAMIC_IMPORT_RE);
      if (dynMatch) {
        specifiers.push({ spec: dynMatch[1], kind: "dynamic" });
      }
    }

    for (const { spec, kind } of specifiers) {
      const key = `${fromModule}→${spec}:${kind}:${lineIndex + 1}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const resolved = resolveImportSpecifier(spec, fromModule, workspaceRoot);
      edges.push({
        from: fromModule,
        to: resolved,
        kind,
        sourceLine: lineIndex + 1
      });
    }
  }

  return edges;
}

function resolveImportSpecifier(spec: string, fromModule: string, workspaceRoot: string): string {
  // External package
  if (!spec.startsWith(".") && !spec.startsWith("/")) {
    return `<external:${spec}>`;
  }

  // Absolute path (treat as project-relative for simplicity)
  if (spec.startsWith("/")) {
    const abs = resolve(workspaceRoot, "." + spec);
    return relative(workspaceRoot, abs);
  }

  // Relative path
  const fromDir = dirname(resolve(workspaceRoot, fromModule));
  let resolved = resolve(fromDir, spec);

  // Try adding extensions if none provided
  if (!extname(resolved)) {
    for (const ext of [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", "/index.ts", "/index.js"]) {
      const withExt = resolved + ext;
      // We can't check filesystem here in a pure function; return most likely
      // The caller will validate existence or the graph will have dangling refs
      // For the graph, we store the resolved path
    }
    // Default: append .ts if no extension (most common in TS projects)
    resolved += ".ts";
  }

  return relative(workspaceRoot, resolved);
}

export async function buildCodeDependencyGraph(options: GraphParseOptions): Promise<CodeDependencyGraph> {
  const { workspaceRoot, ignoreDirs = DEFAULT_IGNORE_DIRS } = options;
  const nodes = new Map<string, ModuleNode>();
  const edges: ImportEdge[] = [];

  for await (const fullPath of walkSourceFiles(workspaceRoot, ignoreDirs)) {
    const moduleId = relative(workspaceRoot, fullPath);
    const st = await stat(fullPath);
    const kind = moduleKindFromExt(fullPath);

    nodes.set(moduleId, {
      id: moduleId,
      kind,
      sizeBytes: st.size
    });

    if (kind === "json") continue;

    const source = await readFile(fullPath, "utf8").catch(() => "");
    const moduleEdges = extractImports(source, moduleId, workspaceRoot);
    edges.push(...moduleEdges);
  }

  // Add nodes for external dependencies that appear as edges but have no node
  for (const edge of edges) {
    if (edge.to.startsWith("<external:") && !nodes.has(edge.to)) {
      const pkgName = edge.to.slice(10, -1).split("/")[0];
      nodes.set(edge.to, {
        id: edge.to,
        kind: "external",
        sizeBytes: 0
      });
    }
  }

  return {
    nodes,
    edges,
    generatedAt: new Date().toISOString()
  };
}

export function forwardDeps(graph: CodeDependencyGraph, moduleId: string): string[] {
  return graph.edges
    .filter((e) => e.from === moduleId)
    .map((e) => e.to);
}

export function reverseDeps(graph: CodeDependencyGraph, moduleId: string): string[] {
  return graph.edges
    .filter((e) => e.to === moduleId)
    .map((e) => e.from);
}

export function affectedFiles(graph: CodeDependencyGraph, moduleId: string, maxDepth = 5): string[] {
  const visited = new Set<string>();
  const queue: Array<{ id: string; depth: number }> = [{ id: moduleId, depth: 0 }];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current.id)) continue;
    if (current.depth >= maxDepth) continue;
    visited.add(current.id);

    for (const importer of reverseDeps(graph, current.id)) {
      if (!visited.has(importer)) {
        queue.push({ id: importer, depth: current.depth + 1 });
      }
    }
  }

  visited.delete(moduleId);
  return [...visited];
}

export function graphSummary(graph: CodeDependencyGraph): {
  nodeCount: number;
  edgeCount: number;
  isolatedFiles: string[];
  highlyConnected: string[];
  externalDependencies: string[];
} {
  const inDegree = new Map<string, number>();
  const outDegree = new Map<string, number>();

  for (const nodeId of graph.nodes.keys()) {
    inDegree.set(nodeId, 0);
    outDegree.set(nodeId, 0);
  }

  for (const edge of graph.edges) {
    inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1);
    outDegree.set(edge.from, (outDegree.get(edge.from) ?? 0) + 1);
  }

  const isolatedFiles: string[] = [];
  const highlyConnected: string[] = [];
  const externalSet = new Set<string>();

  for (const [nodeId, node] of graph.nodes) {
    const incoming = inDegree.get(nodeId) ?? 0;
    const outgoing = outDegree.get(nodeId) ?? 0;

    if (incoming === 0 && outgoing === 0 && node.kind !== "external") {
      isolatedFiles.push(nodeId);
    }

    if (incoming + outgoing > 10) {
      highlyConnected.push(nodeId);
    }

    if (node.kind === "external") {
      const pkgName = nodeId.slice(10, -1).split("/")[0];
      externalSet.add(pkgName);
    }
  }

  return {
    nodeCount: graph.nodes.size,
    edgeCount: graph.edges.length,
    isolatedFiles,
    highlyConnected,
    externalDependencies: [...externalSet].sort()
  };
}

export function graphToJson(graph: CodeDependencyGraph): string {
  return JSON.stringify(
    {
      nodes: [...graph.nodes.values()],
      edges: graph.edges,
      generatedAt: graph.generatedAt
    },
    null,
    2
  );
}

export function graphFromJson(json: string): CodeDependencyGraph {
  const parsed = JSON.parse(json) as {
    nodes: ModuleNode[];
    edges: ImportEdge[];
    generatedAt: string;
  };
  const nodes = new Map<string, ModuleNode>();
  for (const node of parsed.nodes) {
    nodes.set(node.id, node);
  }
  return {
    nodes,
    edges: parsed.edges,
    generatedAt: parsed.generatedAt
  };
}
