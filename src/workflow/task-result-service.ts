import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { TaskResult, TaskResultKind } from "../contracts/task.js";
import { TASK_GRAPH_LIMITS } from "../contracts/task.js";
import type { SessionDB } from "../contracts/session.js";
import type { TaskStore } from "./task-store.js";

export const TASK_RESULT_PAGE_DEFAULT_CHARS = 4_000;
export const TASK_RESULT_PAGE_MAX_CHARS = 20_000;
export const TASK_RESULT_SUMMARY_MAX_CHARS = 2_000;

export type RecordTaskResultInput = {
  id?: string;
  taskId: string;
  stepId?: string;
  attemptId?: string;
  kind: TaskResultKind;
  content: string | Uint8Array;
  mimeType?: string;
  summary?: string;
  expiresAt?: string;
};

export type ReadTaskResultPageInput = {
  taskId: string;
  resultId: string;
  sessionId: string;
  offset?: number;
  maxChars?: number;
};

export type TaskResultPage = {
  result: TaskResult;
  content: string;
  offset: number;
  nextOffset?: number;
  totalChars: number;
  hasMore: boolean;
};

export type TaskResultServiceOptions = {
  store: TaskStore;
  profileId: string;
  contentRoot: string;
  sessionDb?: Pick<SessionDB, "getSession">;
  id?: () => string;
  handleId?: () => string;
  eventId?: () => string;
  now?: () => Date;
};

export class TaskResultAccessError extends Error {
  readonly code = "task-result-not-accessible";

  constructor() {
    super("Task result was not found or is not accessible from this session.");
    this.name = "TaskResultAccessError";
  }
}

export class TaskResultContentError extends Error {
  constructor(public readonly code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TaskResultContentError";
  }
}

/**
 * Canonical Task result plane. Metadata lives in the profile-bound TaskStore;
 * content lives under the same profile's private state root and is addressed only
 * through opaque handles. No filesystem path is returned to callers.
 */
export class TaskResultService {
  readonly #store: TaskStore;
  readonly #profileId: string;
  readonly #contentRoot: string;
  readonly #sessionDb: Pick<SessionDB, "getSession"> | undefined;
  readonly #id: () => string;
  readonly #handleId: () => string;
  readonly #eventId: () => string;
  readonly #now: () => Date;

  constructor(options: TaskResultServiceOptions) {
    const profileId = options.profileId.trim();
    if (profileId.length === 0) {
      throw new TaskResultContentError("invalid-profile", "TaskResultService requires a profile ID.");
    }
    if (options.store.profileId !== profileId) {
      throw new TaskResultContentError(
        "profile-store-mismatch",
        "TaskResultService profile does not match its TaskStore profile."
      );
    }
    if (options.contentRoot.trim().length === 0) {
      throw new TaskResultContentError("invalid-content-root", "TaskResultService requires a content root.");
    }
    this.#store = options.store;
    this.#profileId = profileId;
    this.#contentRoot = resolve(options.contentRoot);
    this.#sessionDb = options.sessionDb;
    this.#id = options.id ?? randomUUID;
    this.#handleId = options.handleId ?? randomUUID;
    this.#eventId = options.eventId ?? randomUUID;
    this.#now = options.now ?? (() => new Date());
  }

  record(input: RecordTaskResultInput): TaskResult {
    if (!isTaskResultKind(input.kind)) {
      throw new TaskResultContentError("invalid-kind", "Task result kind is invalid.");
    }
    const bytes = normalizeContent(input.kind, input.content);
    if (bytes.byteLength > TASK_GRAPH_LIMITS.maxResultBytesPerStep) {
      throw new TaskResultContentError(
        "result-too-large",
        `Task result exceeds the ${TASK_GRAPH_LIMITS.maxResultBytesPerStep}-byte limit.`
      );
    }
    if (input.summary !== undefined && codePointLength(input.summary) > TASK_RESULT_SUMMARY_MAX_CHARS) {
      throw new TaskResultContentError(
        "summary-too-large",
        `Task result summary exceeds ${TASK_RESULT_SUMMARY_MAX_CHARS} characters.`
      );
    }
    if (input.mimeType !== undefined && codePointLength(input.mimeType) > 255) {
      throw new TaskResultContentError("mime-type-too-large", "Task result MIME type exceeds 255 characters.");
    }

    const taskId = nonEmpty(input.taskId, "Task ID");
    const task = this.#store.getTask(taskId);
    if (task === null) throw new TaskResultAccessError();
    const attempt = input.attemptId === undefined
      ? null
      : this.#store.getAttempt(nonEmpty(input.attemptId, "Attempt ID"));
    if (input.attemptId !== undefined && (attempt === null || attempt.taskId !== taskId)) {
      throw new TaskResultContentError("attempt-task-mismatch", "Result Attempt does not belong to its Task.");
    }
    const effectiveStepId = input.stepId ?? attempt?.stepId;
    const step = effectiveStepId === undefined
      ? null
      : this.#store.getStep(nonEmpty(effectiveStepId, "Step ID"));
    if (effectiveStepId !== undefined && (step === null || step.taskId !== taskId)) {
      throw new TaskResultContentError("step-task-mismatch", "Result Step does not belong to its Task.");
    }
    if (attempt !== null && step !== null && attempt.stepId !== step.id) {
      throw new TaskResultContentError("attempt-step-mismatch", "Result Attempt does not belong to its Step.");
    }
    if (step !== null) assertResultMatchesStepPolicy(step.resultPolicy.kind, input.kind);
    if (input.expiresAt !== undefined && !Number.isFinite(Date.parse(input.expiresAt))) {
      throw new TaskResultContentError("invalid-expiry", "Task result expiresAt must be an ISO-compatible timestamp.");
    }

    const id = nonEmpty(input.id ?? this.#id(), "result ID");
    const handle = `task-result:${nonEmpty(this.#handleId(), "result handle ID")}`;
    const now = this.#now().toISOString();
    const contentHash = hashContent(bytes);
    const result: TaskResult = {
      id,
      profileId: this.#profileId,
      taskId,
      ...(effectiveStepId === undefined ? {} : { stepId: effectiveStepId }),
      ...(input.attemptId === undefined ? {} : { attemptId: nonEmpty(input.attemptId, "Attempt ID") }),
      kind: input.kind,
      status: "available",
      handle,
      byteLength: bytes.byteLength,
      contentHash,
      mimeType: input.mimeType ?? defaultMimeType(input.kind),
      ...(input.summary === undefined ? {} : { summary: input.summary }),
      createdAt: now,
      ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt })
    };

    const contentPath = this.#writeContent(handle, bytes);
    try {
      this.#store.atomicWrite((store) => {
        const persistedTask = store.getTask(result.taskId);
        if (persistedTask === null) throw new TaskResultAccessError();

        const persistedStep = result.stepId === undefined ? null : store.getStep(result.stepId);
        if (result.stepId !== undefined && (persistedStep === null || persistedStep.taskId !== result.taskId)) {
          throw new TaskResultContentError("step-task-mismatch", "Result Step does not belong to its Task.");
        }
        const persistedAttempt = result.attemptId === undefined ? null : store.getAttempt(result.attemptId);
        if (result.attemptId !== undefined && (persistedAttempt === null || persistedAttempt.taskId !== result.taskId)) {
          throw new TaskResultContentError("attempt-task-mismatch", "Result Attempt does not belong to its Task.");
        }
        if (persistedAttempt !== null && result.stepId !== undefined && persistedAttempt.stepId !== result.stepId) {
          throw new TaskResultContentError("attempt-step-mismatch", "Result Attempt does not belong to its Step.");
        }

        if (result.stepId !== undefined) {
          const effectiveStep = persistedStep;
          if (effectiveStep === null || effectiveStep.taskId !== result.taskId) {
            throw new TaskResultContentError("step-task-mismatch", "Result Step does not belong to its Task.");
          }
          assertResultMatchesStepPolicy(effectiveStep.resultPolicy.kind, result.kind);
          const existingBytes = store.listResults(result.taskId)
            .filter((candidate) => candidate.status === "available" && candidate.stepId === result.stepId)
            .reduce((total, candidate) => total + candidate.byteLength, 0);
          const resultLimit = Math.min(
            TASK_GRAPH_LIMITS.maxResultBytesPerStep,
            effectiveStep.resultPolicy.maxBytes
          );
          if (existingBytes + result.byteLength > resultLimit) {
            throw new TaskResultContentError(
              "step-result-budget-exceeded",
              `Task Step result content exceeds its ${resultLimit}-byte limit.`
            );
          }
        }

        store.recordResult(result);
        store.appendEvent({
          id: this.#eventId(),
          profileId: this.#profileId,
          taskId: result.taskId,
          ...(persistedAttempt === null
            ? persistedStep === null ? {} : { planRevisionId: persistedStep.planRevisionId }
            : { planRevisionId: persistedAttempt.planRevisionId }),
          ...(result.stepId === undefined ? {} : { stepId: result.stepId }),
          ...(result.attemptId === undefined ? {} : { attemptId: result.attemptId }),
          kind: "result-recorded",
          timestamp: now,
          data: {
            resultId: result.id,
            kind: result.kind,
            handle: result.handle,
            byteLength: result.byteLength,
            contentHash: result.contentHash
          }
        });
      });
    } catch (error) {
      removeFileBestEffort(contentPath);
      throw error;
    }

    return result;
  }

  async readPage(input: ReadTaskResultPageInput): Promise<TaskResultPage> {
    const taskId = nonEmpty(input.taskId, "Task ID");
    const resultId = nonEmpty(input.resultId, "Result ID");
    const sessionId = nonEmpty(input.sessionId, "session ID");
    const task = this.#store.getTask(taskId);
    const authorized = task !== null && await this.#isSessionAuthorized(taskId, sessionId);
    const result = this.#store.getResult(resultId);
    if (!authorized || result === null || result.taskId !== taskId || result.status !== "available") {
      throw new TaskResultAccessError();
    }
    if (result.expiresAt !== undefined && Date.parse(result.expiresAt) <= this.#now().getTime()) {
      throw new TaskResultAccessError();
    }
    if (!isTextReadable(result)) {
      throw new TaskResultContentError(
        "result-not-text",
        "Task result is binary and cannot be read through the text paging tool."
      );
    }

    const offset = boundedInteger(input.offset, 0, Number.MAX_SAFE_INTEGER, 0, "offset");
    const maxChars = boundedInteger(
      input.maxChars,
      1,
      TASK_RESULT_PAGE_MAX_CHARS,
      TASK_RESULT_PAGE_DEFAULT_CHARS,
      "maxChars"
    );
    const bytes = this.#readVerifiedContent(result);
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (error) {
      throw new TaskResultContentError("invalid-utf8", "Task result is not valid UTF-8 text.", { cause: error });
    }
    const characters = Array.from(text);
    if (offset > characters.length) {
      throw new TaskResultContentError("offset-out-of-range", "Task result offset exceeds its character length.");
    }
    const end = Math.min(characters.length, offset + maxChars);
    const hasMore = end < characters.length;
    return {
      result,
      content: characters.slice(offset, end).join(""),
      offset,
      ...(hasMore ? { nextOffset: end } : {}),
      totalChars: characters.length,
      hasMore
    };
  }

  prune(taskId: string, resultId: string): TaskResult {
    const result = this.#store.getResult(nonEmpty(resultId, "Result ID"));
    if (result === null || result.taskId !== nonEmpty(taskId, "Task ID")) {
      throw new TaskResultAccessError();
    }
    if (result.status === "pruned") return result;
    const pruned: TaskResult = {
      ...result,
      status: "pruned",
      prunedAt: this.#now().toISOString()
    };
    this.#store.updateResult(pruned);
    this.#removeContent(result.handle);
    return pruned;
  }

  #writeContent(handle: string, bytes: Uint8Array): string {
    const path = this.#contentPath(handle);
    const parent = dirname(path);
    ensurePrivateDirectory(this.#contentRoot, true);
    ensurePrivateDirectory(parent);
    chmodSync(this.#contentRoot, 0o700);
    chmodSync(parent, 0o700);
    if (existsSync(path)) {
      throw new TaskResultContentError("content-collision", "Task result content handle already exists.");
    }
    const tempPath = join(parent, `.${randomUUID()}.tmp`);
    try {
      writeFileSync(tempPath, bytes, { flag: "wx", mode: 0o600 });
      renameSync(tempPath, path);
      chmodSync(path, 0o600);
      return path;
    } catch (error) {
      removeFileBestEffort(tempPath);
      removeFileBestEffort(path);
      throw new TaskResultContentError("content-write-failed", "Failed to persist Task result content.", { cause: error });
    }
  }

  #readVerifiedContent(result: TaskResult): Uint8Array {
    let bytes: Buffer;
    let descriptor: number | undefined;
    try {
      const path = this.#verifiedContentPath(result.handle);
      const pathStat = lstatSync(path);
      if (pathStat.isSymbolicLink() || !pathStat.isFile()) {
        throw new TaskResultContentError("content-path-invalid", "Task result content path is not a regular file.");
      }
      descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = fstatSync(descriptor);
      if (!stat.isFile()) {
        throw new TaskResultContentError("content-path-invalid", "Task result content path is not a regular file.");
      }
      if (stat.size !== result.byteLength) {
        throw new TaskResultContentError(
          "content-integrity-failed",
          "Task result content failed integrity verification."
        );
      }
      bytes = readFileSync(descriptor);
    } catch (error) {
      if (error instanceof TaskResultContentError) throw error;
      throw new TaskResultContentError("content-missing", "Task result content is unavailable.", { cause: error });
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
    if (hashContent(bytes) !== result.contentHash) {
      throw new TaskResultContentError("content-integrity-failed", "Task result content failed integrity verification.");
    }
    return bytes;
  }

  #contentPath(handle: string): string {
    if (!/^task-result:[A-Za-z0-9._-]+$/u.test(handle)) {
      throw new TaskResultContentError("invalid-handle", "Stored Task result handle is invalid.");
    }
    const digest = createHash("sha256").update(handle, "utf8").digest("hex");
    return join(this.#contentRoot, digest.slice(0, 2), `${digest}.bin`);
  }

  #verifiedContentPath(handle: string): string {
    const path = this.#contentPath(handle);
    assertPrivateDirectory(this.#contentRoot);
    assertPrivateDirectory(dirname(path));
    return path;
  }

  #removeContent(handle: string): void {
    const path = this.#contentPath(handle);
    const parent = dirname(path);
    if (!existsSync(this.#contentRoot) || !existsSync(parent)) return;
    assertPrivateDirectory(this.#contentRoot);
    assertPrivateDirectory(parent);
    removeFileIfPresent(path);
  }

  async #isSessionAuthorized(taskId: string, sessionId: string): Promise<boolean> {
    const linkedSessionIds = new Set(this.#store.listSessionLinks(taskId).map((link) => link.sessionId));
    if (linkedSessionIds.has(sessionId)) return true;
    if (this.#sessionDb === undefined) return false;

    const visited = new Set<string>();
    let currentSessionId = sessionId;
    for (let depth = 0; depth < 32; depth++) {
      if (visited.has(currentSessionId)) return false;
      visited.add(currentSessionId);
      const current = await this.#sessionDb.getSession(currentSessionId);
      if (current === undefined || current.profileId !== this.#profileId) return false;
      const parentSessionId = current.parentSessionId;
      if (parentSessionId === undefined || current.metadata?.compactedFromSessionId !== parentSessionId) return false;
      const parent = await this.#sessionDb.getSession(parentSessionId);
      if (parent === undefined || parent.profileId !== this.#profileId || parent.endReason !== "compression") return false;
      if (linkedSessionIds.has(parentSessionId)) return true;
      currentSessionId = parentSessionId;
    }
    return false;
  }
}

function normalizeContent(kind: TaskResultKind, content: string | Uint8Array): Uint8Array {
  const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
  if (kind === "json") {
    let decoded: string;
    try {
      decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      JSON.parse(decoded);
    } catch (error) {
      throw new TaskResultContentError("invalid-json", "JSON Task result content must contain valid UTF-8 JSON.", {
        cause: error
      });
    }
  }
  if ((kind === "text" || kind === "summary") && typeof content !== "string") {
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (error) {
      throw new TaskResultContentError("invalid-utf8", "Text Task result content must be valid UTF-8.", { cause: error });
    }
  }
  return bytes;
}

function isTaskResultKind(value: unknown): value is TaskResultKind {
  return value === "text" || value === "json" || value === "artifact" || value === "summary";
}

function assertResultMatchesStepPolicy(
  expected: "none" | "text" | "json" | "artifact",
  actual: TaskResultKind
): void {
  if (expected === "none" || expected !== actual) {
    throw new TaskResultContentError(
      "result-policy-mismatch",
      `Task result kind ${actual} does not match the Step result policy ${expected}.`
    );
  }
}

function defaultMimeType(kind: TaskResultKind): string {
  switch (kind) {
    case "json":
      return "application/json";
    case "text":
    case "summary":
      return "text/plain; charset=utf-8";
    case "artifact":
      return "application/octet-stream";
  }
}

function isTextReadable(result: TaskResult): boolean {
  if (result.kind !== "artifact") return true;
  const mimeType = result.mimeType?.toLowerCase() ?? "";
  return mimeType.startsWith("text/") || mimeType === "application/json" || mimeType.endsWith("+json");
}

function hashContent(content: Uint8Array): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function nonEmpty(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new TaskResultContentError("invalid-identifier", `Task result ${label} must not be empty.`);
  }
  return normalized;
}

function boundedInteger(
  value: number | undefined,
  minimum: number,
  maximum: number,
  fallback: number,
  label: string
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new TaskResultContentError(
      `invalid-${label}`,
      `Task result ${label} must be an integer between ${minimum} and ${maximum}.`
    );
  }
  return resolved;
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function removeFileIfPresent(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }
}

function removeFileBestEffort(path: string): void {
  try {
    removeFileIfPresent(path);
  } catch {
    // Preserve the persistence failure that triggered cleanup.
  }
}

function assertPrivateDirectory(path: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new TaskResultContentError("content-root-invalid", "Task result content root is not a private directory.");
  }
}

function ensurePrivateDirectory(path: string, recursive = false): void {
  if (existsSync(path)) {
    assertPrivateDirectory(path);
    return;
  }
  mkdirSync(path, { recursive, mode: 0o700 });
  assertPrivateDirectory(path);
}
