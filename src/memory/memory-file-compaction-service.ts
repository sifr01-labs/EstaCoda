import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type {
  MemoryBudgetPressure,
  MemoryFileKind
} from "../contracts/memory.js";
import type {
  ProviderRequest,
  ResolvedAuxiliaryRoute,
  ResolvedModelRoute
} from "../contracts/provider.js";
import type { SessionDB, SessionEvent } from "../contracts/session.js";
import { executeAuxiliaryTask } from "../providers/auxiliary-executor.js";
import type { ProviderExecutor } from "../providers/provider-executor.js";
import type { TrajectoryRecorder } from "../trajectory/trajectory-recorder.js";
import { calculateMemoryBudgetPressure, findBudget } from "./memory-pressure.js";
import { scanMemoryContent } from "./memory-scanner.js";
import { isMemoryBudgetOverflowError, type MemoryStore } from "./memory-store.js";

export type MemoryFileCompactionTarget = "USER.md" | "MEMORY.md";

export type MemoryFileCompactionConfig = {
  automaticEnabled: boolean;
};

export const DEFAULT_MEMORY_FILE_COMPACTION_CONFIG: MemoryFileCompactionConfig = {
  automaticEnabled: false
};

export type MemoryFileCompactionResult =
  | {
      ok: true;
      status: "dry-run" | "applied";
      file: MemoryFileCompactionTarget;
      originalChars: number;
      compactedChars: number;
      compactedText: string;
      backupId?: string;
      pressureBefore?: MemoryBudgetPressure;
      pressureAfter?: MemoryBudgetPressure;
      warnings?: string[];
    }
  | {
      ok: false;
      status:
        | "invalid-target"
        | "empty"
        | "route-unavailable"
        | "provider-failed"
        | "provider-invalid-output"
        | "scanner-blocked"
        | "write-failed"
        | "backup-not-found";
      file?: MemoryFileKind | string;
      message: string;
      code: string;
      issues?: string[];
      pressure?: MemoryBudgetPressure;
      attempts?: string[];
      diagnostics?: string[];
    };

export type MemoryFileRestoreResult =
  | {
      ok: true;
      status: "restored";
      file: MemoryFileCompactionTarget;
      backupId: string;
      preRestoreBackupId?: string;
      restoredChars: number;
      warnings?: string[];
    }
  | {
      ok: false;
      status: "invalid-target" | "backup-not-found" | "scanner-blocked" | "write-failed";
      file?: MemoryFileKind | string;
      backupId?: string;
      message: string;
      code: string;
      issues?: string[];
    };

export type MemoryFileCompactionServiceOptions = {
  store: MemoryStore;
  memoryRoot: string;
  route?: ResolvedAuxiliaryRoute;
  mainRoute?: ResolvedModelRoute;
  providerExecutor?: Pick<ProviderExecutor, "complete">;
  trajectoryRecorder?: TrajectoryRecorder;
  sessionDb?: Pick<SessionDB, "appendEvent">;
  sessionId?: string;
  now?: () => Date;
  id?: () => string;
  config?: Partial<MemoryFileCompactionConfig>;
};

export class MemoryFileCompactionService {
  readonly #store: MemoryStore;
  readonly #memoryRoot: string;
  readonly #route: ResolvedAuxiliaryRoute | undefined;
  readonly #mainRoute: ResolvedModelRoute | undefined;
  readonly #providerExecutor: Pick<ProviderExecutor, "complete"> | undefined;
  readonly #trajectoryRecorder: TrajectoryRecorder | undefined;
  readonly #sessionDb: Pick<SessionDB, "appendEvent"> | undefined;
  readonly #sessionId: string | undefined;
  readonly #now: () => Date;
  readonly #id: () => string;
  readonly #config: MemoryFileCompactionConfig;

  constructor(options: MemoryFileCompactionServiceOptions) {
    this.#store = options.store;
    this.#memoryRoot = options.memoryRoot;
    this.#route = options.route;
    this.#mainRoute = options.mainRoute;
    this.#providerExecutor = options.providerExecutor;
    this.#trajectoryRecorder = options.trajectoryRecorder;
    this.#sessionDb = options.sessionDb;
    this.#sessionId = options.sessionId;
    this.#now = options.now ?? (() => new Date());
    this.#id = options.id ?? randomId;
    this.#config = {
      ...DEFAULT_MEMORY_FILE_COMPACTION_CONFIG,
      ...(options.config ?? {})
    };
  }

  get automaticEnabled(): boolean {
    return this.#config.automaticEnabled;
  }

  async compact(input: {
    file: string;
    dryRun?: boolean;
    signal?: AbortSignal;
  }): Promise<MemoryFileCompactionResult> {
    const target = toTarget(input.file);
    if (target === undefined) {
      return invalidTarget(input.file);
    }

    const original = this.#store.read(target);
    const pressureBefore = this.#pressure(target, original);
    if (original.trim().length === 0) {
      return {
        ok: false,
        status: "empty",
        file: target,
        message: `${target} is empty; nothing to compact.`,
        code: "memory-file-compaction-empty",
        pressure: pressureBefore
      };
    }

    if (this.#route?.route === undefined || this.#providerExecutor === undefined || this.#mainRoute === undefined) {
      return {
        ok: false,
        status: "route-unavailable",
        file: target,
        message: "Memory file compaction is unavailable because no memory_compaction auxiliary route is configured.",
        code: "memory-file-compaction-route-unavailable",
        pressure: pressureBefore,
        diagnostics: this.#route?.diagnostics ?? ["memory_compaction route was not resolved"]
      };
    }

    const generated = await this.#generateCompactedText({
      file: target,
      original,
      signal: input.signal
    });
    if (!generated.ok) {
      return {
        ...generated,
        pressure: pressureBefore
      };
    }

    const scan = scanMemoryContent(generated.compactedText);
    if (!scan.ok) {
      return {
        ok: false,
        status: "scanner-blocked",
        file: target,
        message: "Generated memory file compaction output was blocked by the memory scanner.",
        code: "memory-file-compaction-scanner-blocked",
        issues: scan.issues,
        pressure: pressureBefore
      };
    }

    const pressureAfter = this.#pressure(target, generated.compactedText);
    if (input.dryRun === true) {
      const warnings = await this.#recordEvent({
        file: target,
        dryRun: true,
        status: "dry-run",
        originalChars: original.length,
        compactedChars: generated.compactedText.length
      });
      return {
        ok: true,
        status: "dry-run",
        file: target,
        originalChars: original.length,
        compactedChars: generated.compactedText.length,
        compactedText: generated.compactedText,
        pressureBefore,
        pressureAfter,
        warnings: optionalWarnings(warnings)
      };
    }

    const backupId = await this.#writeBackup(target, original);
    try {
      this.#store.write(target, generated.compactedText);
      await this.#store.saveFileToDirectory(this.#memoryRoot, target);
    } catch (error) {
      this.#store.write(target, original);
      if (isMemoryBudgetOverflowError(error)) {
        return {
          ok: false,
          status: "write-failed",
          file: target,
          message: "Generated memory file compaction output still exceeded the memory budget.",
          code: "memory-file-compaction-overflow",
          pressure: error.overflow.pressure
        };
      }
      return {
        ok: false,
        status: "write-failed",
        file: target,
        message: error instanceof Error ? error.message : "Memory file compaction write failed.",
        code: "memory-file-compaction-write-failed",
        pressure: pressureBefore
      };
    }

    const warnings = await this.#recordEvent({
      file: target,
      dryRun: false,
      status: "applied",
      backupId,
      originalChars: original.length,
      compactedChars: generated.compactedText.length
    });

    return {
      ok: true,
      status: "applied",
      file: target,
      originalChars: original.length,
      compactedChars: generated.compactedText.length,
      compactedText: generated.compactedText,
      backupId,
      pressureBefore,
      pressureAfter,
      warnings: optionalWarnings(warnings)
    };
  }

  async restoreBackup(input: {
    file: string;
    backupId?: string;
  }): Promise<MemoryFileRestoreResult> {
    const target = toTarget(input.file);
    if (target === undefined) {
      return {
        ...invalidTarget(input.file),
        status: "invalid-target"
      };
    }

    const backupId = input.backupId ?? await this.#latestBackupId(target);
    if (backupId === undefined || backupId !== basename(backupId) || !backupId.startsWith(backupPrefix(target))) {
      return {
        ok: false,
        status: "backup-not-found",
        file: target,
        backupId,
        message: "No memory file compaction backup was found for restore.",
        code: "memory-file-compaction-backup-not-found"
      };
    }

    let content: string;
    try {
      content = await readFile(join(this.#backupRoot(), backupId), "utf8");
    } catch {
      return {
        ok: false,
        status: "backup-not-found",
        file: target,
        backupId,
        message: "No memory file compaction backup was found for restore.",
        code: "memory-file-compaction-backup-not-found"
      };
    }

    const scan = scanMemoryContent(content);
    if (!scan.ok) {
      return {
        ok: false,
        status: "scanner-blocked",
        file: target,
        backupId,
        message: "Memory file compaction backup was blocked by the memory scanner.",
        code: "memory-file-compaction-restore-scanner-blocked",
        issues: scan.issues
      };
    }

    const previous = this.#store.read(target);
    let preRestoreBackupId: string | undefined;
    try {
      preRestoreBackupId = await this.#writeBackup(target, previous);
      this.#store.write(target, content);
      await this.#store.saveFileToDirectory(this.#memoryRoot, target);
    } catch (error) {
      try {
        this.#store.write(target, previous);
      } catch {
        // The previous value came from this store, so rollback should normally be safe.
      }
      return {
        ok: false,
        status: "write-failed",
        file: target,
        backupId,
        message: error instanceof Error ? error.message : "Memory file compaction restore failed.",
        code: "memory-file-compaction-restore-write-failed"
      };
    }

    const warnings = await this.#recordEvent({
      file: target,
      dryRun: false,
      status: "restored",
      backupId,
      preRestoreBackupId,
      restoredChars: content.length
    });

    return {
      ok: true,
      status: "restored",
      file: target,
      backupId,
      preRestoreBackupId,
      restoredChars: content.length,
      warnings: optionalWarnings(warnings)
    };
  }

  async #generateCompactedText(input: {
    file: MemoryFileCompactionTarget;
    original: string;
    signal?: AbortSignal;
  }): Promise<
    | { ok: true; compactedText: string }
    | {
        ok: false;
        status: "provider-failed" | "provider-invalid-output";
        file: MemoryFileCompactionTarget;
        message: string;
        code: string;
        attempts?: string[];
        diagnostics?: string[];
      }
  > {
    const route = this.#route!;
    const auxiliaryResult = await executeAuxiliaryTask({
      route,
      mainRoute: this.#mainRoute!,
      providerExecutor: this.#providerExecutor!,
      request: memoryFileCompactionRequest(input.file, input.original, route.route!.id),
      signal: input.signal
    });

    const attempts = auxiliaryResult.attempts.map((attempt) =>
      `${attempt.provider}/${attempt.model}:${attempt.ok ? "ok" : attempt.errorClass ?? "error"}`
    );

    if (!auxiliaryResult.ok || auxiliaryResult.response === undefined) {
      return {
        ok: false,
        status: "provider-failed",
        file: input.file,
        message: "Memory file compaction provider failed; original memory file was preserved.",
        code: "memory-file-compaction-provider-failed",
        attempts,
        diagnostics: auxiliaryResult.diagnostics
      };
    }

    const parsed = parseCompactionResponse(auxiliaryResult.response.content);
    if (parsed === undefined) {
      return {
        ok: false,
        status: "provider-invalid-output",
        file: input.file,
        message: "Memory file compaction provider returned invalid structured output; original memory file was preserved.",
        code: "memory-file-compaction-provider-invalid-output",
        attempts
      };
    }

    return {
      ok: true,
      compactedText: parsed
    };
  }

  async #writeBackup(file: MemoryFileCompactionTarget, content: string): Promise<string> {
    const baseBackupId = `${backupPrefix(file)}${safeTimestamp(this.#now())}-${this.#id()}`;
    await mkdir(this.#backupRoot(), { recursive: true });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const backupId = `${baseBackupId}${attempt === 0 ? "" : `-${attempt}`}.bak.md`;
      try {
        await writeFile(join(this.#backupRoot(), backupId), content, { encoding: "utf8", flag: "wx" });
        return backupId;
      } catch (error) {
        if (!isAlreadyExists(error)) {
          throw error;
        }
      }
    }
    throw new Error(`Could not create a unique memory file compaction backup for ${file}`);
  }

  async #latestBackupId(file: MemoryFileCompactionTarget): Promise<string | undefined> {
    try {
      const prefix = backupPrefix(file);
      const entries = await readdir(this.#backupRoot());
      return entries
        .filter((entry) => entry.startsWith(prefix))
        .sort()
        .at(-1);
    } catch {
      return undefined;
    }
  }

  #pressure(file: MemoryFileCompactionTarget, content: string): MemoryBudgetPressure | undefined {
    const budget = findBudget(this.#store.snapshot().budgets, file);
    if (budget === undefined) {
      return undefined;
    }
    return calculateMemoryBudgetPressure({
      kind: file,
      chars: content.length,
      maxChars: budget.maxChars
    });
  }

  #backupRoot(): string {
    return join(this.#memoryRoot, ".memory-file-compaction-backups");
  }

  async #recordEvent(data: Record<string, unknown>): Promise<string[]> {
    const warnings: string[] = [];
    try {
      this.#trajectoryRecorder?.record("memory-file-compaction", data);
    } catch (error) {
      warnings.push(`trajectory event failed: ${errorMessage(error)}`);
    }
    if (this.#sessionDb !== undefined && this.#sessionId !== undefined) {
      try {
        await this.#sessionDb.appendEvent(this.#sessionId, {
          kind: "memory-file-compaction",
          ...data
        } as SessionEvent);
      } catch (error) {
        warnings.push(`session event failed: ${errorMessage(error)}`);
      }
    }
    return warnings;
  }
}

function memoryFileCompactionRequest(
  file: MemoryFileCompactionTarget,
  original: string,
  model: string
): Omit<ProviderRequest, "model"> & { model?: string } {
  return {
    model,
    responseFormat: { type: "json_object" },
    maxTokens: 900,
    messages: [
      {
        role: "system",
        content: [
          "You are EstaCoda's memory file compaction lane.",
          "Compact only the provided USER.md or MEMORY.md content.",
          "Preserve durable facts and preferences. Remove duplication, stale wording, and verbose phrasing.",
          "Do not add new facts. Do not include secrets. Return JSON only with a compactedText string."
        ].join("\n")
      },
      {
        role: "user",
        content: [
          `File: ${file}`,
          "Return JSON exactly like:",
          "{\"compactedText\":\"- concise durable memory\"}",
          "",
          "Original memory file:",
          original
        ].join("\n")
      }
    ]
  };
}

function parseCompactionResponse(content: string): string | undefined {
  try {
    const parsed = JSON.parse(content) as { compactedText?: unknown };
    if (typeof parsed.compactedText !== "string" || parsed.compactedText.trim().length === 0) {
      return undefined;
    }
    return parsed.compactedText.trim();
  } catch {
    return undefined;
  }
}

function toTarget(file: string): MemoryFileCompactionTarget | undefined {
  return file === "USER.md" || file === "MEMORY.md" ? file : undefined;
}

function invalidTarget(file: string): MemoryFileCompactionResult & { ok: false } {
  return {
    ok: false,
    status: "invalid-target",
    file,
    message: "Memory file compaction only supports USER.md and MEMORY.md.",
    code: "memory-file-compaction-invalid-target"
  };
}

function backupPrefix(file: MemoryFileCompactionTarget): string {
  return `${file.replace(/\.md$/u, "").toLowerCase()}-`;
}

function safeTimestamp(date: Date): string {
  return date.toISOString().replace(/[^0-9]/gu, "");
}

function randomId(): string {
  return Math.random().toString(36).slice(2, 10);
}

function optionalWarnings(warnings: string[]): string[] | undefined {
  return warnings.length === 0 ? undefined : warnings;
}

function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "EEXIST"
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
