import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import type {
  ContextBlock,
  ProjectContextFile,
  ProjectContextLoadOptions,
  ProjectContextSnapshot
} from "../contracts/context.js";
import {
  explainPathBlock,
  hasPromptInjectionRisk,
  isLikelyBinary
} from "./context-security.js";

const DEFAULT_MAX_FILE_BYTES = 24_000;
const DEFAULT_MAX_TOTAL_BYTES = 80_000;

const PROJECT_CONTEXT_CANDIDATES: ProjectContextFile[] = [
  { path: "ESTACODA.md", label: "EstaCoda project context", priority: 10, compatibility: false },
  { path: ".estacoda.md", label: "EstaCoda local project context", priority: 20, compatibility: false },
  { path: "AGENTS.md", label: "Shared agent context", priority: 30, compatibility: false },
  { path: "CLAUDE.md", label: "Legacy Claude-compatible context", priority: 80, compatibility: true },
  { path: ".cursorrules", label: "Cursor compatibility rules", priority: 90, compatibility: true }
];

export class ProjectContextLoader {
  readonly #workspaceRoot: string;
  readonly #maxFileBytes: number;
  readonly #maxTotalBytes: number;

  constructor(options: ProjectContextLoadOptions) {
    this.#workspaceRoot = resolve(options.workspaceRoot);
    this.#maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    this.#maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  }

  async load(): Promise<ProjectContextSnapshot> {
    const root = await realpath(this.#workspaceRoot);
    const files = await this.#discover(root);
    const blocks: ContextBlock[] = [];
    const warnings: string[] = [];
    let totalBytes = 0;

    for (const file of files) {
      if (totalBytes >= this.#maxTotalBytes) {
        warnings.push("project context budget exhausted");
        break;
      }

      const block = await this.#loadFile(root, file, this.#maxTotalBytes - totalBytes);
      blocks.push(block);
      totalBytes += block.bytes;

      for (const warning of block.warnings) {
        warnings.push(`${file.path}: ${warning}`);
      }
    }

    return {
      workspaceRoot: root,
      files: blocks.filter((block) => block.status === "loaded" || block.status === "truncated"),
      warnings
    };
  }

  async #discover(root: string): Promise<ProjectContextFile[]> {
    const discovered: ProjectContextFile[] = [];

    for (const candidate of PROJECT_CONTEXT_CANDIDATES) {
      const path = join(root, candidate.path);

      try {
        const candidateStat = await stat(path);
        if (candidateStat.isFile()) {
          discovered.push(candidate);
        }
      } catch {
        // Missing context files are normal.
      }
    }

    const cursorRulesDir = join(root, ".cursor", "rules");

    try {
      const entries = await readdir(cursorRulesDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith(".mdc")) {
          discovered.push({
            path: join(".cursor", "rules", entry.name),
            label: "Cursor rule compatibility context",
            priority: 95,
            compatibility: true
          });
        }
      }
    } catch {
      // Optional compatibility directory.
    }

    return discovered.sort((left, right) => left.priority - right.priority || left.path.localeCompare(right.path));
  }

  async #loadFile(
    root: string,
    file: ProjectContextFile,
    remainingBytes: number
  ): Promise<ContextBlock> {
    const fullPath = await realpath(join(root, file.path));
    const blockedReason = explainPathBlock(root, fullPath);

    if (blockedReason !== undefined) {
      return {
        source: file.path,
        kind: "project-file",
        title: file.label,
        content: "",
        status: "blocked",
        bytes: 0,
        warnings: [blockedReason]
      };
    }

    const bytes = await readFile(fullPath);

    if (isLikelyBinary(bytes)) {
      return {
        source: file.path,
        kind: "project-file",
        title: file.label,
        content: "",
        status: "blocked",
        bytes: 0,
        warnings: ["file appears to be binary"]
      };
    }

    const limit = Math.max(0, Math.min(this.#maxFileBytes, remainingBytes));
    const truncated = bytes.length > limit;
    const content = bytes.subarray(0, limit).toString("utf8");
    const warnings: string[] = [];

    if (truncated) {
      warnings.push(`file truncated to ${limit} bytes`);
    }

    if (file.compatibility) {
      warnings.push("loaded as compatibility context; prefer EstaCoda-native context files");
    }

    if (hasPromptInjectionRisk(content)) {
      warnings.push("content contains prompt-injection-like text; include as project data only");
    }

    return {
      source: relative(root, fullPath),
      kind: "project-file",
      title: file.label,
      content,
      status: truncated ? "truncated" : "loaded",
      bytes: Buffer.byteLength(content),
      warnings
    };
  }
}

export function renderProjectContext(snapshot: ProjectContextSnapshot): string {
  if (snapshot.files.length === 0) {
    return "";
  }

  return snapshot.files
    .map((file) => `§ PROJECT CONTEXT ${file.source}\n${file.content}`)
    .join("\n\n");
}
