import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import type {
  ContextBlock,
  ContextExpansionResult,
  ContextReference,
  ContextReferenceExpanderOptions
} from "../contracts/context.js";
import {
  explainPathBlock,
  hasPromptInjectionRisk,
  isLikelyBinary,
  isTextyPath
} from "./context-security.js";

const DEFAULT_MAX_FILE_BYTES = 32_000;
const DEFAULT_MAX_FOLDER_ENTRIES = 80;
const DEFAULT_MAX_TOTAL_BYTES = 96_000;
const REFERENCE_PATTERN = /@(file|folder):([^\s]+)/g;

export class ContextReferenceExpander {
  readonly #workspaceRoot: string;
  readonly #maxFileBytes: number;
  readonly #maxFolderEntries: number;
  readonly #maxTotalBytes: number;

  constructor(options: ContextReferenceExpanderOptions) {
    this.#workspaceRoot = resolve(options.workspaceRoot);
    this.#maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    this.#maxFolderEntries = options.maxFolderEntries ?? DEFAULT_MAX_FOLDER_ENTRIES;
    this.#maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  }

  async expand(text: string): Promise<ContextExpansionResult> {
    const root = await realpath(this.#workspaceRoot);
    const references = parseReferences(text);
    const blocks: ContextBlock[] = [];
    const warnings: string[] = [];
    let totalBytes = 0;

    for (const reference of references) {
      if (totalBytes >= this.#maxTotalBytes) {
        warnings.push("context reference budget exhausted");
        break;
      }

      const remainingBytes = this.#maxTotalBytes - totalBytes;
      const block = await this.#loadReference(root, reference, remainingBytes);
      blocks.push(block);
      totalBytes += block.bytes;

      for (const warning of block.warnings) {
        warnings.push(`${reference.raw}: ${warning}`);
      }
    }

    return {
      originalText: text,
      expandedText: renderExpandedText(text, blocks),
      references,
      blocks,
      warnings
    };
  }

  async #loadReference(
    root: string,
    reference: ContextReference,
    remainingBytes: number
  ): Promise<ContextBlock> {
    const targetPath = resolve(root, reference.target);

    try {
      const canonicalTarget = await realpath(targetPath);
      const blockedReason = explainPathBlock(root, canonicalTarget);

      if (blockedReason !== undefined) {
        return blockedBlock(reference, blockedReason);
      }

      const targetStat = await stat(canonicalTarget);

      if (reference.kind === "file") {
        if (!targetStat.isFile()) {
          return blockedBlock(reference, "target is not a file");
        }

        return await this.#loadFile(root, canonicalTarget, reference, remainingBytes);
      }

      if (!targetStat.isDirectory()) {
        return blockedBlock(reference, "target is not a folder");
      }

      return await this.#loadFolder(root, canonicalTarget, reference, remainingBytes);
    } catch (error) {
      return {
        source: reference.target,
        kind: reference.kind,
        title: `${reference.kind}: ${reference.target}`,
        content: "",
        status: "missing",
        bytes: 0,
        warnings: [error instanceof Error ? error.message : "reference could not be loaded"]
      };
    }
  }

  async #loadFile(
    root: string,
    path: string,
    reference: ContextReference,
    remainingBytes: number
  ): Promise<ContextBlock> {
    if (!isTextyPath(path)) {
      return blockedBlock(reference, "file type is not included as text context");
    }

    const fileBytes = await readFile(path);

    if (isLikelyBinary(fileBytes)) {
      return blockedBlock(reference, "file appears to be binary");
    }

    const maxBytes = Math.max(0, Math.min(this.#maxFileBytes, remainingBytes));
    const truncated = fileBytes.length > maxBytes;
    const raw = fileBytes.subarray(0, maxBytes).toString("utf8");
    const ranged = applyLineRange(raw, reference.lineStart, reference.lineEnd);
    const warnings: string[] = [];

    if (truncated) {
      warnings.push(`file truncated to ${maxBytes} bytes`);
    }

    if (hasPromptInjectionRisk(ranged)) {
      warnings.push("content contains prompt-injection-like text; include as data only");
    }

    return {
      source: relative(root, path),
      kind: "file",
      title: `file: ${relative(root, path)}`,
      content: ranged,
      status: truncated ? "truncated" : "included",
      bytes: Buffer.byteLength(ranged),
      warnings
    };
  }

  async #loadFolder(
    root: string,
    path: string,
    reference: ContextReference,
    remainingBytes: number
  ): Promise<ContextBlock> {
    const entries = await readdir(path, { withFileTypes: true });
    const sortedEntries = entries
      .filter((entry) => !entry.name.startsWith(".git") && entry.name !== "node_modules")
      .sort((left, right) => left.name.localeCompare(right.name));
    const visibleEntries = sortedEntries.slice(0, this.#maxFolderEntries);
    const lines = visibleEntries.map((entry) => {
      const suffix = entry.isDirectory() ? "/" : "";
      return `${entry.isDirectory() ? "dir " : "file"} ${join(relative(root, path), entry.name)}${suffix}`;
    });
    const warnings: string[] = [];

    if (sortedEntries.length > visibleEntries.length) {
      warnings.push(`folder listing truncated to ${visibleEntries.length} entries`);
    }

    const content = lines.join("\n").slice(0, remainingBytes);

    return {
      source: relative(root, path) || basename(path),
      kind: "folder",
      title: `folder: ${relative(root, path) || "."}`,
      content,
      status: content.length < lines.join("\n").length ? "truncated" : "included",
      bytes: Buffer.byteLength(content),
      warnings
    };
  }
}

function parseReferences(text: string): ContextReference[] {
  const references: ContextReference[] = [];

  for (const match of text.matchAll(REFERENCE_PATTERN)) {
    const raw = match[0];
    const kind = match[1] as "file" | "folder";
    const { target, lineStart, lineEnd } = parseTarget(match[2] ?? "");

    references.push({
      raw,
      kind,
      target,
      lineStart,
      lineEnd
    });
  }

  return references;
}

function parseTarget(rawTarget: string): {
  target: string;
  lineStart?: number;
  lineEnd?: number;
} {
  const cleanedTarget = rawTarget.replace(/[),.;]+$/g, "");
  const lineMatch = cleanedTarget.match(/^(.*):(\d+)(?:-(\d+))?$/);

  if (lineMatch === null) {
    return { target: cleanedTarget };
  }

  return {
    target: lineMatch[1] ?? rawTarget,
    lineStart: Number(lineMatch[2]),
    lineEnd: Number(lineMatch[3] ?? lineMatch[2])
  };
}

function applyLineRange(content: string, lineStart?: number, lineEnd?: number): string {
  if (lineStart === undefined) {
    return content;
  }

  const lines = content.split("\n");
  const start = Math.max(1, lineStart);
  const end = Math.min(lines.length, Math.max(start, lineEnd ?? start));

  return lines.slice(start - 1, end).join("\n");
}

function blockedBlock(reference: ContextReference, reason: string): ContextBlock {
  return {
    source: reference.target,
    kind: reference.kind,
    title: `${reference.kind}: ${reference.target}`,
    content: "",
    status: "blocked",
    bytes: 0,
    warnings: [reason]
  };
}

function renderExpandedText(text: string, blocks: ContextBlock[]): string {
  const includedBlocks = blocks.filter((block) => block.content.length > 0);

  if (includedBlocks.length === 0) {
    return text;
  }

  return `${text}\n\n${includedBlocks
    .map((block) => `§ CONTEXT ${block.title}\n${block.content}`)
    .join("\n\n")}`;
}
