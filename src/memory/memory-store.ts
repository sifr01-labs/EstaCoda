import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  DEFAULT_MEMORY_BUDGETS,
  type MemoryBudget,
  type MemoryFileKind,
  type MemoryOperation
} from "../contracts/memory.js";
import { scanMemoryContent } from "./memory-scanner.js";

export type MemorySnapshot = {
  files: ReadonlyMap<MemoryFileKind, string>;
  budgets: readonly MemoryBudget[];
};

export class MemoryStore {
  readonly #files = new Map<MemoryFileKind, string>();
  readonly #budgets: readonly MemoryBudget[];

  constructor(options: { budgets?: readonly MemoryBudget[] } = {}) {
    this.#budgets = options.budgets ?? DEFAULT_MEMORY_BUDGETS;
  }

  read(kind: MemoryFileKind): string {
    return this.#files.get(kind) ?? "";
  }

  write(kind: MemoryFileKind, content: string): void {
    this.#assertSafeContent(content);
    this.#assertBudget(kind, content);
    this.#files.set(kind, content);
  }

  async loadFromDirectory(root: string): Promise<void> {
    for (const kind of MEMORY_FILE_KINDS) {
      try {
        this.write(kind, await readFile(join(root, kind), "utf8"));
      } catch (error) {
        if (!isNotFound(error)) {
          throw error;
        }
      }
    }
  }

  async saveToDirectory(root: string): Promise<void> {
    for (const [kind, content] of this.#files.entries()) {
      const path = join(root, kind);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content, "utf8");
    }
  }

  apply(operation: MemoryOperation): void {
    if (operation.kind === "append") {
      const current = this.read(operation.file);
      this.#assertNotDuplicate(current, operation.content, operation.file);
      const separator = current.trim().length === 0 ? "" : "\n";
      this.write(operation.file, `${current}${separator}${operation.content}`);
      return;
    }

    if (operation.kind === "replace") {
      const current = this.read(operation.file);
      const index = findUniqueMatch(current, operation.match, operation.file);

      this.write(
        operation.file,
        `${current.slice(0, index)}${operation.replacement}${current.slice(
          index + operation.match.length
        )}`
      );
      return;
    }

    const current = this.read(operation.file);
    const index = findUniqueMatch(current, operation.match, operation.file);

    this.write(operation.file, `${current.slice(0, index)}${current.slice(index + operation.match.length)}`);
  }

  snapshot(): MemorySnapshot {
    return {
      files: new Map(this.#files),
      budgets: this.#budgets
    };
  }

  #assertBudget(kind: MemoryFileKind, content: string): void {
    const budget = this.#budgets.find((entry) => entry.kind === kind);

    if (budget !== undefined && content.length > budget.maxChars) {
      throw new Error(`${kind} exceeds ${budget.maxChars} character memory budget`);
    }
  }

  #assertSafeContent(content: string): void {
    const scan = scanMemoryContent(content);

    if (!scan.ok) {
      throw new Error(`Memory content rejected: ${scan.issues.join("; ")}`);
    }
  }

  #assertNotDuplicate(current: string, content: string, kind: MemoryFileKind): void {
    if (content.trim().length > 0 && current.includes(content.trim())) {
      throw new Error(`Duplicate memory entry rejected in ${kind}`);
    }
  }
}

const MEMORY_FILE_KINDS: readonly MemoryFileKind[] = ["MEMORY.md", "USER.md", "SOUL.md", "AGENTS.md"];

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function findUniqueMatch(content: string, match: string, kind: MemoryFileKind): number {
  const first = content.indexOf(match);

  if (first === -1) {
    throw new Error(`Memory match not found in ${kind}: ${match}`);
  }

  const second = content.indexOf(match, first + match.length);

  if (second !== -1) {
    throw new Error(`Memory match is ambiguous in ${kind}: ${match}`);
  }

  return first;
}
