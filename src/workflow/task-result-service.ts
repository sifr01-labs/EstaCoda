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
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { TaskAttemptLease, TaskResult, TaskResultDisposition, TaskResultKind } from "../contracts/task.js";
import { TASK_GRAPH_LIMITS } from "../contracts/task.js";
import type { SessionDB } from "../contracts/session.js";
import { verifiedCompressionLineage } from "../session/session-lineage.js";
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
  disposition?: TaskResultDisposition;
  content: string | Uint8Array;
  mimeType?: string;
  summary?: string;
  expiresAt?: string;
  /** Scheduler-only settlement fence. Result writes fail when the Attempt lease is stale or cancelled. */
  expectedLease?: {
    ownerId: string;
    fencingToken: number;
  };
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

/** Opaque handle for bodies prepared on disk but not yet published in Task metadata. */
export type PreparedTaskResultBatch = {
  id: string;
  results: readonly TaskResult[];
};

export type TaskResultPreparationRecovery = {
  removed: number;
  finalized: number;
  unresolved: number;
};

type PreparedTaskResultEntry = {
  result: TaskResult;
  bytes: Uint8Array;
  eventId: string;
  expectedLease?: {
    ownerId: string;
    fencingToken: number;
  };
  contentPath: string;
  markerPath: string;
};

type PreparedTaskResultState = {
  batch: PreparedTaskResultBatch;
  entries: readonly PreparedTaskResultEntry[];
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
  readonly #prepared = new Map<string, PreparedTaskResultState>();

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
    const batch = this.prepare([input]);
    try {
      const published = this.#store.atomicWrite((store) => this.publishPrepared(batch, store));
      this.finalizePrepared(batch);
      return published[0]!;
    } catch (error) {
      this.discardPrepared(batch);
      throw error;
    }
  }

  /** Writes and verifies bodies while keeping their metadata absent from the TaskStore. */
  prepare(inputs: readonly RecordTaskResultInput[]): PreparedTaskResultBatch {
    const entries = inputs.map((input) => this.#prepareEntry(input));
    this.#validatePreparedEntries(this.#store, entries);
    const ids = new Set<string>();
    const handles = new Set<string>();
    for (const entry of entries) {
      if (ids.has(entry.result.id) || handles.has(entry.result.handle)) {
        throw new TaskResultContentError("duplicate-prepared-result", "Prepared Task result identities must be unique.");
      }
      ids.add(entry.result.id);
      handles.add(entry.result.handle);
    }

    const written: PreparedTaskResultEntry[] = [];
    try {
      for (const entry of entries) {
        this.#writePreparedContent(entry);
        this.#readVerifiedContent(entry.result);
        written.push(entry);
      }
    } catch (error) {
      for (const entry of [...written, ...entries.slice(written.length)]) this.#removePreparedEntry(entry, false);
      throw error;
    }

    let id = randomUUID();
    while (this.#prepared.has(id)) id = randomUUID();
    const batch = { id, results: entries.map((entry) => entry.result) } satisfies PreparedTaskResultBatch;
    this.#prepared.set(id, { batch, entries });
    return batch;
  }

  /**
   * Inserts prepared metadata and journal events into the caller's active transaction.
   * The caller must settle the Attempt/Step/Task in that same transaction, then call finalizePrepared.
   */
  publishPrepared(batch: PreparedTaskResultBatch, store: TaskStore): readonly TaskResult[] {
    const state = this.#preparedState(batch);
    this.#validatePreparedEntries(store, state.entries);
    for (const entry of state.entries) {
      const result = entry.result;
      const persistedAttempt = result.attemptId === undefined ? null : store.getAttempt(result.attemptId);
      const persistedStep = result.stepId === undefined ? null : store.getStep(result.stepId);
      store.recordResult(result);
      store.appendEvent({
        id: entry.eventId,
        profileId: this.#profileId,
        taskId: result.taskId,
        ...(persistedAttempt === null
          ? persistedStep === null ? {} : { planRevisionId: persistedStep.planRevisionId }
          : { planRevisionId: persistedAttempt.planRevisionId }),
        ...(result.stepId === undefined ? {} : { stepId: result.stepId }),
        ...(result.attemptId === undefined ? {} : { attemptId: result.attemptId }),
        kind: "result-recorded",
        timestamp: result.createdAt,
        data: {
          resultId: result.id,
          kind: result.kind,
          disposition: result.disposition,
          handle: result.handle,
          byteLength: result.byteLength,
          contentHash: result.contentHash
        }
      });
    }
    return state.batch.results;
  }

  /** Removes preparation markers after the enclosing SQLite transaction commits. */
  finalizePrepared(batch: PreparedTaskResultBatch): void {
    const state = this.#prepared.get(batch.id);
    if (state === undefined || state.batch !== batch) return;
    this.#prepared.delete(batch.id);
    for (const entry of state.entries) removeFileBestEffort(entry.markerPath);
  }

  /** Removes uncommitted bodies; committed bodies are preserved if the transaction did succeed. */
  discardPrepared(batch: PreparedTaskResultBatch): void {
    const state = this.#prepared.get(batch.id);
    if (state === undefined || state.batch !== batch) return;
    this.#prepared.delete(batch.id);
    for (const entry of state.entries) this.#removePreparedEntry(entry, true);
  }

  /** Reconciles preparation markers left by a process crash before or after SQLite commit. */
  recoverPrepared(): TaskResultPreparationRecovery {
    const recovery: TaskResultPreparationRecovery = { removed: 0, finalized: 0, unresolved: 0 };
    if (!existsSync(this.#contentRoot)) return recovery;
    assertPrivateDirectory(this.#contentRoot);
    for (const shard of readdirSync(this.#contentRoot, { withFileTypes: true })) {
      if (!/^[0-9a-f]{2}$/u.test(shard.name) || !shard.isDirectory()) continue;
      const shardPath = join(this.#contentRoot, shard.name);
      assertPrivateDirectory(shardPath);
      for (const file of readdirSync(shardPath, { withFileTypes: true })) {
        if (!file.isFile()) continue;
        if (/^\.[A-Za-z0-9._-]+\.tmp$/u.test(file.name)) {
          removeFileIfPresent(join(shardPath, file.name));
          recovery.removed++;
          continue;
        }
        const marker = /^([0-9a-f]{64})\.pending$/u.exec(file.name);
        if (marker === null) continue;
        const markerPath = join(shardPath, file.name);
        const contentPath = join(shardPath, `${marker[1]}.bin`);
        const resultId = readPreparedResultId(markerPath);
        if (resultId === undefined) {
          recovery.unresolved++;
          continue;
        }
        const result = this.#store.getResult(resultId);
        const committed = result !== null && contentDigest(result.handle) === marker[1];
        if (committed) recovery.finalized++;
        else {
          removeFileIfPresent(contentPath);
          recovery.removed++;
        }
        removeFileIfPresent(markerPath);
      }
    }
    return recovery;
  }

  #prepareEntry(input: RecordTaskResultInput): PreparedTaskResultEntry {
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
    if (input.expiresAt !== undefined && !Number.isFinite(Date.parse(input.expiresAt))) {
      throw new TaskResultContentError("invalid-expiry", "Task result expiresAt must be an ISO-compatible timestamp.");
    }

    const taskId = nonEmpty(input.taskId, "Task ID");
    const attemptId = input.attemptId === undefined ? undefined : nonEmpty(input.attemptId, "Attempt ID");
    const attempt = attemptId === undefined ? null : this.#store.getAttempt(attemptId);
    const effectiveStepId = input.stepId ?? attempt?.stepId;
    const task = this.#store.getTask(taskId);
    if (task === null) throw new TaskResultAccessError();
    if (attemptId !== undefined && (attempt === null || attempt.taskId !== taskId)) {
      throw new TaskResultContentError("attempt-task-mismatch", "Result Attempt does not belong to its Task.");
    }
    if (input.expectedLease !== undefined) {
      if (attempt === null) {
        throw new TaskResultContentError("result-fence-missing-attempt", "A fenced Result requires an Attempt.");
      }
      assertCurrentResultLease(attempt.lease, input.expectedLease, this.#now().getTime());
    }
    const step = effectiveStepId === undefined ? null : this.#store.getStep(nonEmpty(effectiveStepId, "Step ID"));
    if (effectiveStepId !== undefined && (step === null || step.taskId !== taskId)) {
      throw new TaskResultContentError("step-task-mismatch", "Result Step does not belong to its Task.");
    }
    if (attempt !== null && step !== null && attempt.stepId !== step.id) {
      throw new TaskResultContentError("attempt-step-mismatch", "Result Attempt does not belong to its Step.");
    }
    const disposition = input.disposition ?? "accepted";
    if (step !== null && disposition === "accepted") assertResultMatchesStepPolicy(step.resultPolicy.kind, input.kind);
    const id = nonEmpty(input.id ?? this.#id(), "result ID");
    const handle = `task-result:${nonEmpty(this.#handleId(), "result handle ID")}`;
    const now = this.#now().toISOString();
    const result: TaskResult = {
      id,
      profileId: this.#profileId,
      taskId,
      ...(effectiveStepId === undefined ? {} : { stepId: nonEmpty(effectiveStepId, "Step ID") }),
      ...(attemptId === undefined ? {} : { attemptId }),
      kind: input.kind,
      disposition,
      status: "available",
      handle,
      byteLength: bytes.byteLength,
      contentHash: hashContent(bytes),
      mimeType: input.mimeType ?? defaultMimeType(input.kind),
      ...(input.summary === undefined ? {} : { summary: input.summary }),
      createdAt: now,
      ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt })
    };
    return {
      result,
      bytes,
      eventId: this.#eventId(),
      expectedLease: input.expectedLease,
      contentPath: this.#contentPath(handle),
      markerPath: this.#markerPath(result)
    };
  }

  #validatePreparedEntries(store: TaskStore, entries: readonly PreparedTaskResultEntry[]): void {
    const addedBytesByStep = new Map<string, Map<TaskResultDisposition, number>>();
    for (const entry of entries) {
      const result = entry.result;
      const task = store.getTask(result.taskId);
      if (task === null) throw new TaskResultAccessError();
      const attempt = result.attemptId === undefined ? null : store.getAttempt(result.attemptId);
      if (result.attemptId !== undefined && (attempt === null || attempt.taskId !== result.taskId)) {
        throw new TaskResultContentError("attempt-task-mismatch", "Result Attempt does not belong to its Task.");
      }
      if (entry.expectedLease !== undefined) {
        if (attempt === null) {
          throw new TaskResultContentError("result-fence-missing-attempt", "A fenced Result requires an Attempt.");
        }
        assertCurrentResultLease(attempt.lease, entry.expectedLease, this.#now().getTime());
      }
      const step = result.stepId === undefined ? null : store.getStep(result.stepId);
      if (result.stepId !== undefined && (step === null || step.taskId !== result.taskId)) {
        throw new TaskResultContentError("step-task-mismatch", "Result Step does not belong to its Task.");
      }
      if (attempt !== null && step !== null && attempt.stepId !== step.id) {
        throw new TaskResultContentError("attempt-step-mismatch", "Result Attempt does not belong to its Step.");
      }
      if (step === null) continue;
      if (result.disposition === "accepted") assertResultMatchesStepPolicy(step.resultPolicy.kind, result.kind);
      const byDisposition = addedBytesByStep.get(step.id) ?? new Map<TaskResultDisposition, number>();
      byDisposition.set(result.disposition, (byDisposition.get(result.disposition) ?? 0) + result.byteLength);
      addedBytesByStep.set(step.id, byDisposition);
    }
    for (const [stepId, byDisposition] of addedBytesByStep) {
      const step = store.getStep(stepId)!;
      for (const [disposition, addedBytes] of byDisposition) {
        const existingBytes = store.listResults(step.taskId)
          .filter((candidate) => candidate.status === "available" && candidate.stepId === stepId &&
            candidate.disposition === disposition)
          .reduce((total, candidate) => total + candidate.byteLength, 0);
        const resultLimit = Math.min(TASK_GRAPH_LIMITS.maxResultBytesPerStep, step.resultPolicy.maxBytes);
        if (existingBytes + addedBytes > resultLimit) {
          throw new TaskResultContentError(
            "step-result-budget-exceeded",
            `Task Step ${disposition} result content exceeds its ${resultLimit}-byte limit.`
          );
        }
      }
    }
  }

  #preparedState(batch: PreparedTaskResultBatch): PreparedTaskResultState {
    const state = this.#prepared.get(batch.id);
    if (state === undefined || state.batch !== batch) {
      throw new TaskResultContentError("prepared-result-unavailable", "Prepared Task result batch is unavailable.");
    }
    return state;
  }

  #writePreparedContent(entry: PreparedTaskResultEntry): void {
    const parent = dirname(entry.contentPath);
    ensurePrivateDirectory(this.#contentRoot, true);
    ensurePrivateDirectory(parent);
    chmodSync(this.#contentRoot, 0o700);
    chmodSync(parent, 0o700);
    if (existsSync(entry.contentPath) || existsSync(entry.markerPath)) {
      throw new TaskResultContentError("content-collision", "Task result content handle already exists.");
    }
    const tempPath = join(parent, `.${randomUUID()}.tmp`);
    try {
      writeFileSync(entry.markerPath, entry.result.id, { flag: "wx", mode: 0o600 });
      writeFileSync(tempPath, entry.bytes, { flag: "wx", mode: 0o600 });
      renameSync(tempPath, entry.contentPath);
      chmodSync(entry.contentPath, 0o600);
    } catch (error) {
      removeFileBestEffort(tempPath);
      this.#removePreparedEntry(entry, false);
      throw new TaskResultContentError("content-write-failed", "Failed to prepare Task result content.", { cause: error });
    }
  }

  #removePreparedEntry(entry: PreparedTaskResultEntry, preserveCommitted: boolean): void {
    const persisted = preserveCommitted ? this.#store.getResult(entry.result.id) : null;
    if (persisted === null || persisted.handle !== entry.result.handle) {
      try {
        removeFileIfPresent(entry.contentPath);
      } catch {
        // Keep the marker so startup recovery can retry without losing the ownership record.
        return;
      }
    }
    removeFileBestEffort(entry.markerPath);
  }

  #markerPath(result: TaskResult): string {
    const digest = contentDigest(result.handle);
    return join(dirname(this.#contentPath(result.handle)), `${digest}.pending`);
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
    const digest = contentDigest(handle);
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
    const lineage = await verifiedCompressionLineage(this.#sessionDb, sessionId, this.#profileId);
    return lineage?.slice(1).some((session) => linkedSessionIds.has(session.id)) === true;
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

function assertCurrentResultLease(
  lease: TaskAttemptLease | undefined,
  expected: { ownerId: string; fencingToken: number },
  nowMs: number
): void {
  if (
    lease === undefined ||
    lease.ownerId !== expected.ownerId ||
    lease.fencingToken !== expected.fencingToken ||
    Date.parse(lease.expiresAt) <= nowMs ||
    lease.cancellationRequestedAt !== undefined
  ) {
    throw new TaskResultContentError("result-fence-lost", "Task result settlement lease is no longer current.");
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

function contentDigest(handle: string): string {
  return createHash("sha256").update(handle, "utf8").digest("hex");
}

function readPreparedResultId(path: string): string | undefined {
  let descriptor: number | undefined;
  try {
    const pathStat = lstatSync(path);
    if (pathStat.isSymbolicLink() || !pathStat.isFile() || pathStat.size > 4_096) return undefined;
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size > 4_096) return undefined;
    const value = readFileSync(descriptor, "utf8");
    return value.length === 0 || value.includes("\u0000") ? undefined : value;
  } catch {
    return undefined;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
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
