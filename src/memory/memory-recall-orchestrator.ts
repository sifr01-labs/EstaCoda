import type {
  ExternalMemoryProvider,
  MemoryPromptContext,
  MemoryRecallDecision,
  MemoryScope,
  PromptMemoryBlock
} from "../contracts/memory.js";
import type { RuntimeEventSink } from "../contracts/runtime-event.js";
import type { ExternalMemoryRuntimeConfig } from "./external-memory-provider.js";
import { collectExternalMemoryRecall } from "./external-memory-provider.js";
import {
  detectSessionRecallIntent,
  sessionRecallResultToPromptBlocks,
  type SessionRecallService
} from "../session/session-recall-service.js";
import type { MemoryPromptContextBuilder } from "./memory-prompt-context-builder.js";
import { truncate } from "../utils/formatting.js";
import { redactSensitiveText } from "../utils/redaction.js";

type MemoryPromptContextBuilderLike = Pick<MemoryPromptContextBuilder, "build">;
type SessionRecallServiceLike = Pick<SessionRecallService, "recall">;

type SessionRecallDecisionRecorder = {
  recordSessionRecallDecision(input: {
    triggered: boolean;
    reason: string;
    query?: string;
    sourceSessionIds: string[];
    warningCount: number;
    onEvent?: RuntimeEventSink;
  }): Promise<string[]>;
  recordExternalMemoryRecall?(input: {
    providerIds: string[];
    enabled: boolean;
    attempted: boolean;
    resultCount: number;
    totalChars: number;
    workspaceScoped: boolean;
    warningCount: number;
    failureCount: number;
    failures?: Array<{ providerId?: string; reason: string }>;
    durationMs?: number;
  }): Promise<string[]>;
};

export type MemoryRecallOrchestratorOptions = {
  builder: MemoryPromptContextBuilderLike;
  sessionRecallService?: SessionRecallServiceLike;
  recorder?: SessionRecallDecisionRecorder;
  externalMemory?: ExternalMemoryRuntimeConfig;
  externalMemoryProviders?: ExternalMemoryProvider[];
  profileId?: string;
  sessionId?: string | (() => string);
  workspaceRoot?: string;
};

export type MemoryRecallOrchestratorResult = {
  context: MemoryPromptContext;
  decisions: MemoryRecallDecision[];
};

const LOCAL_AND_SESSION_SCOPES: MemoryScope[] = ["user-global", "project", "session"];
const LOCAL_SESSION_EXTERNAL_SCOPES: MemoryScope[] = ["user-global", "project", "session", "external"];
const DEFAULT_EXTERNAL_MEMORY_CONFIG: ExternalMemoryRuntimeConfig = {
  enabled: false,
  timeoutMs: 750,
  maxResults: 3,
  maxChars: 2_500,
  mirrorWrites: false
};

export class MemoryRecallOrchestrator {
  readonly #builder: MemoryPromptContextBuilderLike;
  readonly #sessionRecallService: SessionRecallServiceLike | undefined;
  readonly #recorder: SessionRecallDecisionRecorder | undefined;
  readonly #externalMemory: ExternalMemoryRuntimeConfig;
  readonly #externalMemoryProviders: ExternalMemoryProvider[];
  readonly #profileId: string;
  readonly #sessionId: string | (() => string) | undefined;
  readonly #workspaceRoot: string | undefined;

  constructor(options: MemoryRecallOrchestratorOptions) {
    this.#builder = options.builder;
    this.#sessionRecallService = options.sessionRecallService;
    this.#recorder = options.recorder;
    this.#externalMemory = options.externalMemory ?? DEFAULT_EXTERNAL_MEMORY_CONFIG;
    this.#externalMemoryProviders = options.externalMemoryProviders ?? [];
    this.#profileId = options.profileId ?? "default";
    this.#sessionId = options.sessionId;
    this.#workspaceRoot = options.workspaceRoot;
  }

  async prepareForTurn(input: {
    text: string;
    onEvent?: RuntimeEventSink;
  }): Promise<MemoryRecallOrchestratorResult> {
    const intent = detectSessionRecallIntent(input.text);
    const session = await this.#sessionRecall(intent, input.onEvent);
    const external = await this.#externalRecall({
      query: intent.query,
      triggered: intent.triggered
    });
    const warnings = [
      ...session.warnings,
      ...external.warnings
    ];
    const decisions = [
      session.decision,
      external.decision
    ];
    const context = await this.#builder.build({
      recallTriggered: session.triggered,
      sessionRecall: session.blocks,
      externalRecall: external.blocks,
      recallWarnings: warnings,
      recallDecisions: decisions
    });
    return {
      context,
      decisions
    };
  }

  async #sessionRecall(
    intent: ReturnType<typeof detectSessionRecallIntent>,
    onEvent?: RuntimeEventSink
  ): Promise<{
    triggered: boolean;
    blocks: PromptMemoryBlock[];
    warnings: string[];
    decision: MemoryRecallDecision;
  }> {
    if (!intent.triggered || this.#sessionRecallService === undefined) {
      const reason = intent.triggered ? "session recall service unavailable" : intent.reason;
      const warnings = await this.#recordSessionRecallDecision({
        triggered: false,
        reason,
        query: intent.query,
        sourceSessionIds: [],
        warningCount: 0,
        onEvent
      });
      const decision: MemoryRecallDecision = {
        included: false,
        reason,
        query: intent.query,
        scopesConsidered: LOCAL_AND_SESSION_SCOPES,
        sourceSessions: [],
        warnings
      };
      return {
        triggered: false,
        blocks: [],
        warnings,
        decision
      };
    }

    const recall = await this.#sessionRecallService.recall(intent.query);
    const blocks = sessionRecallResultToPromptBlocks(recall);
    const sourceSessionIds = uniqueSourceSessionIds(blocks);
    const eventWarnings = await this.#recordSessionRecallDecision({
      triggered: true,
      reason: intent.reason,
      query: intent.query,
      sourceSessionIds,
      warningCount: recall.diagnostics.warnings.length,
      onEvent
    });
    const warnings = [
      ...recall.diagnostics.warnings,
      ...eventWarnings
    ];
    const decision: MemoryRecallDecision = {
      included: blocks.length > 0,
      reason: blocks.length > 0 ? intent.reason : "explicit recall trigger matched, but no recall blocks were returned",
      query: intent.query,
      scopesConsidered: LOCAL_AND_SESSION_SCOPES,
      sourceSessions: sourceSessionIds,
      warnings
    };
    return {
      triggered: true,
      blocks,
      warnings,
      decision
    };
  }

  async #externalRecall(input: {
    query: string;
    triggered: boolean;
  }): Promise<{
    blocks: PromptMemoryBlock[];
    warnings: string[];
    decision: MemoryRecallDecision;
  }> {
    if (this.#externalMemory.enabled !== true || this.#externalMemoryProviders.length === 0) {
      return {
        blocks: [],
        warnings: [],
        decision: {
          included: false,
          reason: this.#externalMemory.enabled === true ? "external memory provider unavailable" : "external memory disabled",
          query: input.query,
          scopesConsidered: LOCAL_SESSION_EXTERNAL_SCOPES,
          sourceSessions: []
        }
      };
    }

    if (!input.triggered) {
      return {
        blocks: [],
        warnings: [],
        decision: {
          included: false,
          reason: "no explicit recall trigger",
          query: input.query,
          scopesConsidered: LOCAL_SESSION_EXTERNAL_SCOPES,
          sourceSessions: []
        }
      };
    }

    const startedAt = Date.now();
    const result = await collectExternalMemoryRecall({
      query: input.query,
      providers: this.#externalMemoryProviders,
      config: this.#externalMemory,
      context: {
        profileId: this.#profileId,
        sessionId: this.#currentSessionId(),
        workspaceRoot: this.#workspaceRoot
      }
    });
    const eventWarnings = await this.#recordExternalMemoryRecall({
      providerIds: this.#externalMemoryProviders.map((provider) => provider.id),
      enabled: this.#externalMemory.enabled === true,
      attempted: true,
      resultCount: result.blocks.length,
      totalChars: result.blocks.reduce((sum, block) => sum + block.content.length, 0),
      workspaceScoped: this.#workspaceRoot !== undefined,
      warningCount: result.warnings.length,
      failureCount: result.warnings.filter((warning) => /\b(?:failed|timed out|no recall hook)\b/iu.test(warning)).length,
      failures: failuresFromWarnings(result.warnings),
      durationMs: Date.now() - startedAt
    });
    const warnings = [
      ...result.warnings,
      ...eventWarnings
    ];
    return {
      blocks: result.blocks,
      warnings,
      decision: {
        included: result.blocks.length > 0,
        reason: result.blocks.length > 0
          ? "explicit recall trigger matched external memory"
          : "external memory returned no recall blocks",
        query: input.query,
        scopesConsidered: LOCAL_SESSION_EXTERNAL_SCOPES,
        sourceSessions: result.sourceProviders,
        warnings
      }
    };
  }

  #currentSessionId(): string | undefined {
    return typeof this.#sessionId === "function" ? this.#sessionId() : this.#sessionId;
  }

  async #recordSessionRecallDecision(input: {
    triggered: boolean;
    reason: string;
    query?: string;
    sourceSessionIds: string[];
    warningCount: number;
    onEvent?: RuntimeEventSink;
  }): Promise<string[]> {
    if (this.#recorder === undefined) {
      return [];
    }
    return await this.#recorder.recordSessionRecallDecision(input);
  }

  async #recordExternalMemoryRecall(input: {
    providerIds: string[];
    enabled: boolean;
    attempted: boolean;
    resultCount: number;
    totalChars: number;
    workspaceScoped: boolean;
    warningCount: number;
    failureCount: number;
    failures?: Array<{ providerId?: string; reason: string }>;
    durationMs?: number;
  }): Promise<string[]> {
    if (this.#recorder?.recordExternalMemoryRecall === undefined) {
      return [];
    }
    try {
      return await this.#recorder.recordExternalMemoryRecall(input);
    } catch (error) {
      return [`external memory recall event failed: ${truncate(redactSensitiveText(error instanceof Error ? error.message : String(error)), 240)}`];
    }
  }
}

function uniqueSourceSessionIds(blocks: PromptMemoryBlock[]): string[] {
  return [...new Set(blocks.flatMap((block) => block.entryIds ?? []))];
}

function failuresFromWarnings(warnings: readonly string[]): Array<{ providerId?: string; reason: string }> | undefined {
  const failures = warnings
    .filter((warning) => /\b(?:failed|timed out|no recall hook)\b/iu.test(warning))
    .map((warning) => ({
      providerId: providerIdFromWarning(warning),
      reason: truncate(redactSensitiveText(warning), 240)
    }));
  return failures.length === 0 ? undefined : failures;
}

function providerIdFromWarning(warning: string): string | undefined {
  const match = /external memory provider ([^\s]+) /iu.exec(warning);
  return match?.[1];
}
