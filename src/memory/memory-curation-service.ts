import type { MemoryCurationConfig } from "../config/memory-config.js";
import type { MemoryOperation } from "../contracts/memory.js";
import type { RuntimeEventSink } from "../contracts/runtime-event.js";
import type { SessionDB, SessionMessage } from "../contracts/session.js";
import type { MemoryIndexWriteSync } from "./memory-index-sync.js";
import type { MemoryPersistenceService } from "./memory-persistence-service.js";
import { isMemoryPersistenceDriftError } from "./memory-persistence-service.js";
import { MemoryStore } from "./memory-store.js";
import type { MemoryFactExtractorOptions, MemoryFactExtractionResult } from "./memory-fact-extractor.js";
import { extractMemoryFacts } from "./memory-fact-extractor.js";
import {
  MemoryCurationStore,
  type MemoryCurationStatus,
  type MemoryCurationTrigger,
  summarizeMemoryOperation
} from "./memory-curation-store.js";
import { reviewMemoryFacts, type CuratedMemoryCandidate } from "./memory-reviewer.js";
import { redactSensitiveText } from "../utils/redaction.js";

type CuratableMemoryOperation = MemoryOperation & { file: "USER.md" | "MEMORY.md" };
type RuntimeMemoryCurationStatus = Exclude<MemoryCurationStatus, "undone">;

export type MemoryCurationCheckpointStatus = MemoryCurationStatus | "skipped";

export type MemoryCurationCheckpointResult = {
  status: MemoryCurationCheckpointStatus;
  trigger: MemoryCurationTrigger;
  sessionId: string;
  sourceMessageCount: number;
  reviewedMessageCount: number;
  extractedFactCount: number;
  candidateCount: number;
  autoAppliedCount: number;
  pendingReviewCount: number;
  ignoredCount: number;
  failedCount: number;
  warnings: string[];
};

export type MemoryCurationServiceOptions = {
  config: MemoryCurationConfig;
  profileId: string;
  sessionId: string | (() => string);
  sessionDb: Pick<SessionDB, "listMessages" | "appendEvent">;
  memoryStore: MemoryStore;
  curationStore: MemoryCurationStore;
  extractorOptions: MemoryFactExtractorOptions;
  persistence?: MemoryPersistenceService;
  persistencePaths?: Partial<Record<"USER.md" | "MEMORY.md", string>>;
  memoryIndexSync?: MemoryIndexWriteSync;
  now?: () => Date;
  extractFacts?: (input: {
    messages: readonly SessionMessage[];
    profileId: string;
    sessionId: string;
    options: MemoryFactExtractorOptions;
    signal?: AbortSignal;
  }) => Promise<MemoryFactExtractionResult>;
};

export class MemoryCurationService {
  readonly #config: MemoryCurationConfig;
  readonly #profileId: string;
  readonly #sessionId: string | (() => string);
  readonly #sessionDb: Pick<SessionDB, "listMessages" | "appendEvent">;
  readonly #memoryStore: MemoryStore;
  readonly #curationStore: MemoryCurationStore;
  readonly #extractorOptions: MemoryFactExtractorOptions;
  readonly #persistence: MemoryPersistenceService | undefined;
  readonly #persistencePaths: Partial<Record<"USER.md" | "MEMORY.md", string>>;
  readonly #memoryIndexSync: MemoryIndexWriteSync | undefined;
  readonly #now: () => Date;
  readonly #extractFacts: NonNullable<MemoryCurationServiceOptions["extractFacts"]>;
  #turnsSinceCheckpoint = 0;

  constructor(options: MemoryCurationServiceOptions) {
    this.#config = options.config;
    this.#profileId = options.profileId;
    this.#sessionId = options.sessionId;
    this.#sessionDb = options.sessionDb;
    this.#memoryStore = options.memoryStore;
    this.#curationStore = options.curationStore;
    this.#extractorOptions = options.extractorOptions;
    this.#persistence = options.persistence;
    this.#persistencePaths = options.persistencePaths ?? {};
    this.#memoryIndexSync = options.memoryIndexSync;
    this.#now = options.now ?? (() => new Date());
    this.#extractFacts = options.extractFacts ?? extractMemoryFacts;
  }

  async observeCompletedTurn(input: {
    signal?: AbortSignal;
    onEvent?: RuntimeEventSink;
  } = {}): Promise<MemoryCurationCheckpointResult> {
    this.#turnsSinceCheckpoint += 1;
    if (this.#turnsSinceCheckpoint < this.#config.checkpointEveryTurns) {
      return this.#skipped("turn-count", this.#currentSessionId(), "turn threshold not reached");
    }
    this.#turnsSinceCheckpoint = 0;
    return await this.checkpoint({
      trigger: "turn-count",
      signal: input.signal,
      onEvent: input.onEvent
    });
  }

  async checkpoint(input: {
    trigger: MemoryCurationTrigger;
    sessionId?: string;
    minNewMessages?: number;
    signal?: AbortSignal;
    onEvent?: RuntimeEventSink;
  }): Promise<MemoryCurationCheckpointResult> {
    const sessionId = input.sessionId ?? this.#currentSessionId();
    if (!this.#triggerEnabled(input.trigger)) {
      return this.#skipped(input.trigger, sessionId, "memory curation trigger disabled");
    }
    if (this.#config.mode === "manual" && input.trigger !== "manual") {
      return this.#skipped(input.trigger, sessionId, "memory curation mode is manual");
    }

    const allMessages = await this.#sessionDb.listMessages(sessionId);
    const latest = await this.#curationStore.latestForSession(sessionId);
    if (input.trigger === "runtime-dispose" && latest?.createdAt !== undefined) {
      const lastAuditMs = new Date(latest.createdAt).getTime();
      const minIntervalMs = this.#config.runtimeDisposeMinIntervalMinutes * 60_000;
      if (Number.isFinite(lastAuditMs) && this.#now().getTime() - lastAuditMs < minIntervalMs) {
        return this.#skipped(input.trigger, sessionId, "runtime dispose audit interval not reached", allMessages.length);
      }
    }
    const lastSourceMessageCount = latest?.sourceMessageCount === undefined
      ? 0
      : Math.min(latest.sourceMessageCount, allMessages.length);
    const messages = allMessages.slice(lastSourceMessageCount);
    if (messages.length === 0) {
      return this.#skipped(input.trigger, sessionId, "no new session messages to review", allMessages.length);
    }
    if (input.minNewMessages !== undefined && messages.length < input.minNewMessages) {
      return this.#skipped(input.trigger, sessionId, "minimum new-message threshold not reached", allMessages.length, messages.length);
    }

    const extraction = await this.#extractFacts({
      messages,
      profileId: this.#profileId,
      sessionId,
      options: this.#extractorOptions,
      signal: input.signal
    });
    const candidates = reviewMemoryFacts({
      facts: extraction.facts,
      memoryStore: this.#memoryStore,
      messages,
      config: this.#config
    });
    const applyResult = await this.#applyAutoCandidates(candidates);
    const pendingReviewCount = candidates.filter((candidate) => candidate.disposition === "pending-review").length;
    const ignoredCount = candidates.filter((candidate) => candidate.disposition === "ignore").length;
    const warnings = [
      ...extraction.diagnostics.warnings,
      ...applyResult.warnings
    ];
    const status = aggregateStatus({
      failedCount: applyResult.failedCount,
      autoAppliedCount: applyResult.autoAppliedCount,
      pendingReviewCount,
      ignoredCount,
      candidateCount: candidates.length
    });
    const reason = reasonForStatus(status, {
      extractionOk: extraction.diagnostics.ok,
      candidates,
      warnings
    });
    await this.#curationStore.append({
      profileId: this.#profileId,
      sessionId,
      trigger: input.trigger,
      status,
      sourceMessageCount: allMessages.length,
      sourceMessageIds: messages.map((message) => message.id),
      extractedFactIds: extraction.facts.map((fact) => fact.id),
      operations: applyResult.operations,
      reason
    });
    await this.#recordEvent({
      trigger: input.trigger,
      status,
      sessionId,
      sourceMessageCount: allMessages.length,
      extractedFactCount: extraction.facts.length,
      candidateCount: candidates.length,
      autoAppliedCount: applyResult.autoAppliedCount,
      pendingReviewCount,
      ignoredCount,
      failedCount: applyResult.failedCount,
      warnings,
      onEvent: input.onEvent
    });

    return {
      status,
      trigger: input.trigger,
      sessionId,
      sourceMessageCount: allMessages.length,
      reviewedMessageCount: messages.length,
      extractedFactCount: extraction.facts.length,
      candidateCount: candidates.length,
      autoAppliedCount: applyResult.autoAppliedCount,
      pendingReviewCount,
      ignoredCount,
      failedCount: applyResult.failedCount,
      warnings
    };
  }

  async #applyAutoCandidates(candidates: readonly CuratedMemoryCandidate[]): Promise<{
    autoAppliedCount: number;
    failedCount: number;
    operations: ReturnType<typeof summarizeMemoryOperation>[];
    warnings: string[];
  }> {
    let autoAppliedCount = 0;
    let failedCount = 0;
    const operations: ReturnType<typeof summarizeMemoryOperation>[] = [];
    const warnings: string[] = [];

    for (const candidate of candidates) {
      if (candidate.disposition !== "auto-apply") {
        continue;
      }
      const operation = operationFromCandidate(candidate);
      if (operation === undefined) {
        failedCount += 1;
        warnings.push(`memory candidate ${candidate.id} could not be converted to an operation`);
        continue;
      }
      const previous = this.#memoryStore.read(operation.file);
      try {
        this.#memoryStore.apply(operation);
        await this.#persistOperation(operation);
        warnings.push(...(await this.#syncIndex(operation)));
        operations.push(summarizeMemoryOperation(operation));
        autoAppliedCount += 1;
      } catch (error) {
        failedCount += 1;
        try {
          this.#memoryStore.write(operation.file, previous);
        } catch {
          // Keep the original failure as the surfaced diagnostic.
        }
        warnings.push(`memory curation failed for ${operation.file}: ${safeErrorMessage(error)}`);
      }
    }

    return { autoAppliedCount, failedCount, operations, warnings };
  }

  async #persistOperation(operation: CuratableMemoryOperation): Promise<void> {
    if (this.#persistence === undefined) {
      return;
    }
    const path = this.#persistencePaths[operation.file];
    if (path === undefined) {
      throw new Error(`no persistence path configured for ${operation.file}`);
    }
    await this.#persistence.writeFile({
      path,
      kind: operation.file,
      content: this.#memoryStore.read(operation.file)
    });
  }

  async #syncIndex(operation: CuratableMemoryOperation): Promise<string[]> {
    try {
      const result = await this.#memoryIndexSync?.syncMemoryFile({
        file: operation.file,
        content: this.#memoryStore.read(operation.file),
        sourcePath: this.#persistencePaths[operation.file]
      });
      return result?.warning === undefined ? [] : [result.warning];
    } catch (error) {
      return [`memory index sync failed for ${operation.file}: ${safeErrorMessage(error)}`];
    }
  }

  async #recordEvent(input: {
    trigger: MemoryCurationTrigger;
    status: RuntimeMemoryCurationStatus;
    sessionId: string;
    sourceMessageCount: number;
    extractedFactCount: number;
    candidateCount: number;
    autoAppliedCount: number;
    pendingReviewCount: number;
    ignoredCount: number;
    failedCount: number;
    warnings: readonly string[];
    onEvent?: RuntimeEventSink;
  }): Promise<void> {
    const event = {
      kind: "memory-curation" as const,
      trigger: input.trigger,
      status: input.status,
      sourceMessageCount: input.sourceMessageCount,
      extractedFactCount: input.extractedFactCount,
      candidateCount: input.candidateCount,
      autoAppliedCount: input.autoAppliedCount,
      pendingReviewCount: input.pendingReviewCount,
      ignoredCount: input.ignoredCount,
      failedCount: input.failedCount,
      warningCount: input.warnings.length,
      ...(input.warnings.length === 0 ? {} : { warnings: input.warnings.slice(0, 8) })
    };
    await this.#sessionDb.appendEvent(input.sessionId, event).catch(() => undefined);
    if (this.#config.autoWriteVisibility !== "off") {
      await input.onEvent?.({
        kind: "memory-curation",
        trigger: input.trigger,
        status: input.status,
        extractedFactCount: input.extractedFactCount,
        candidateCount: input.candidateCount,
        autoAppliedCount: input.autoAppliedCount,
        pendingReviewCount: input.pendingReviewCount,
        ignoredCount: input.ignoredCount,
        failedCount: input.failedCount,
        warningCount: input.warnings.length
      });
    }
  }

  #triggerEnabled(trigger: MemoryCurationTrigger): boolean {
    if (trigger === "compact") {
      return this.#config.auditOnCompact;
    }
    if (trigger === "handoff") {
      return this.#config.auditOnHandoff;
    }
    if (trigger === "runtime-dispose") {
      return this.#config.auditOnRuntimeDispose;
    }
    return true;
  }

  #currentSessionId(): string {
    return typeof this.#sessionId === "function" ? this.#sessionId() : this.#sessionId;
  }

  #skipped(
    trigger: MemoryCurationTrigger,
    sessionId: string,
    reason: string,
    sourceMessageCount = 0,
    reviewedMessageCount = 0
  ): MemoryCurationCheckpointResult {
    return {
      status: "skipped",
      trigger,
      sessionId,
      sourceMessageCount,
      reviewedMessageCount,
      extractedFactCount: 0,
      candidateCount: 0,
      autoAppliedCount: 0,
      pendingReviewCount: 0,
      ignoredCount: 0,
      failedCount: 0,
      warnings: [reason]
    };
  }
}

function operationFromCandidate(candidate: CuratedMemoryCandidate): CuratableMemoryOperation | undefined {
  if (candidate.operation === "append" && candidate.content !== undefined) {
    return {
      kind: "append",
      file: candidate.target,
      content: candidate.content
    };
  }
  if (candidate.operation === "replace" && candidate.match !== undefined && candidate.replacement !== undefined) {
    return {
      kind: "replace",
      file: candidate.target,
      match: candidate.match,
      replacement: candidate.replacement
    };
  }
  if (candidate.operation === "remove" && candidate.match !== undefined) {
    return {
      kind: "remove",
      file: candidate.target,
      match: candidate.match
    };
  }
  return undefined;
}

function aggregateStatus(input: {
  failedCount: number;
  autoAppliedCount: number;
  pendingReviewCount: number;
  ignoredCount: number;
  candidateCount: number;
}): RuntimeMemoryCurationStatus {
  if (input.failedCount > 0) {
    return "failed";
  }
  if (input.autoAppliedCount > 0) {
    return "auto-applied";
  }
  if (input.pendingReviewCount > 0) {
    return "pending-review";
  }
  return "ignored";
}

function reasonForStatus(status: MemoryCurationStatus, input: {
  extractionOk: boolean;
  candidates: readonly CuratedMemoryCandidate[];
  warnings: readonly string[];
}): string {
  if (status === "auto-applied") {
    return "auto-applied explicit low-risk memory candidates";
  }
  if (status === "pending-review") {
    return "memory candidates require review";
  }
  if (status === "failed") {
    return input.warnings[0] ?? "memory curation failed";
  }
  if (!input.extractionOk) {
    return "memory extraction unavailable";
  }
  if (input.candidates.length === 0) {
    return "no durable memory candidates";
  }
  return "all memory candidates were ignored";
}

function safeErrorMessage(error: unknown): string {
  if (isMemoryPersistenceDriftError(error)) {
    return error.code;
  }
  return redactSensitiveText(error instanceof Error ? error.message : String(error));
}
