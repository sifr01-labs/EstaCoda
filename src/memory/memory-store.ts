import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  DEFAULT_MEMORY_BUDGETS,
  type MemoryBudgetOverflow,
  type MemoryBudget,
  type MemoryFileKind,
  type MemoryOperation
} from "../contracts/memory.js";
import { scanMemoryContent } from "./memory-scanner.js";
import { calculateMemoryBudgetPressure, findBudget } from "./memory-pressure.js";

export type MemorySnapshot = {
  files: ReadonlyMap<MemoryFileKind, string>;
  budgets: readonly MemoryBudget[];
};

export class MemoryBudgetOverflowError extends Error {
  readonly name = "MemoryBudgetOverflowError";
  readonly overflow: MemoryBudgetOverflow;

  constructor(overflow: MemoryBudgetOverflow) {
    super(`${overflow.kind} exceeds ${overflow.maxChars} character memory budget by ${overflow.overflowChars} characters`);
    this.overflow = overflow;
  }
}

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

  hydrate(kind: MemoryFileKind, content: string): void {
    this.#assertSafeContent(content);
    this.#files.set(kind, content);
  }

  async loadFromDirectory(root: string): Promise<void> {
    for (const kind of MEMORY_FILE_KINDS) {
      try {
        this.hydrate(kind, await readFile(join(root, kind), "utf8"));
      } catch (error) {
        if (!isNotFound(error)) {
          throw error;
        }
      }
    }
  }

  async saveToDirectory(root: string): Promise<void> {
    for (const [kind, content] of this.#files.entries()) {
      await this.saveFileToDirectory(root, kind);
    }
  }

  async saveFileToDirectory(root: string, kind: MemoryFileKind): Promise<void> {
    const path = join(root, kind);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, this.read(kind), "utf8");
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
    const budget = findBudget(this.#budgets, kind);

    if (budget === undefined) {
      return;
    }

    const pressure = calculateMemoryBudgetPressure({
      kind,
      chars: content.length,
      maxChars: budget.maxChars
    });

    if (pressure.state === "overflow") {
      throw new MemoryBudgetOverflowError({
        code: "memory-budget-overflow",
        kind,
        source: kind,
        chars: pressure.chars,
        maxChars: pressure.maxChars,
        overflowChars: pressure.overflowChars,
        pressure
      });
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

export const MEMORY_FILE_KINDS: readonly MemoryFileKind[] = ["SHARED.md", "MEMORY.md", "USER.md", "SOUL.md"];

export function isMemoryBudgetOverflowError(error: unknown): error is MemoryBudgetOverflowError {
  return error instanceof MemoryBudgetOverflowError;
}

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
