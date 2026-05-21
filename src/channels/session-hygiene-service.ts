import type { SessionCompressionConfig } from "../config/runtime-config.js";
import type { SessionDB } from "../contracts/session.js";
import type { CompactResult, SessionCompressionRequest, SessionCompressionService } from "../prompt/session-compression-service.js";
import { estimateMessagesTokensRough } from "../prompt/token-estimator.js";

export const GATEWAY_HYGIENE_THRESHOLD = 0.85;

export type SessionHygieneResult =
  | {
      status: "skipped";
      reason: "disabled" | "below-threshold" | "no-messages" | "compression-skipped";
      preTokens: number;
      thresholdTokens: number;
    }
  | {
      status: "compacted";
      reason: "threshold-exceeded";
      preTokens: number;
      thresholdTokens: number;
      activeSessionId: string;
      rotated: boolean;
      result: CompactResult;
      warnings: readonly string[];
    }
  | {
      status: "failed";
      reason: "compression-failed";
      preTokens: number;
      thresholdTokens: number;
      error: string;
      warnings: readonly string[];
    };

export type SessionHygieneServiceOptions = {
  sessionDb: Pick<SessionDB, "listMessages">;
  profileId: string;
  compressionConfig: SessionCompressionConfig;
  compressionService: Pick<SessionCompressionService, "compactIfNeeded">;
  contextWindowTokens?: number;
  logWarning?: (message: string) => void;
};

export type SessionHygieneRunInput = {
  sessionId: string;
  signal?: AbortSignal;
};

export class SessionHygieneService {
  readonly #sessionDb: Pick<SessionDB, "listMessages">;
  readonly #profileId: string;
  readonly #compressionConfig: SessionCompressionConfig;
  readonly #compressionService: Pick<SessionCompressionService, "compactIfNeeded">;
  readonly #contextWindowTokens: number;
  readonly #logWarning: ((message: string) => void) | undefined;

  constructor(options: SessionHygieneServiceOptions) {
    this.#sessionDb = options.sessionDb;
    this.#profileId = options.profileId;
    this.#compressionConfig = options.compressionConfig;
    this.#compressionService = options.compressionService;
    this.#contextWindowTokens = options.contextWindowTokens
      ?? options.compressionConfig.summaryModelContextLength
      ?? 128_000;
    this.#logWarning = options.logWarning;
  }

  async run(input: SessionHygieneRunInput): Promise<SessionHygieneResult> {
    const thresholdTokens = Math.floor(this.#contextWindowTokens * GATEWAY_HYGIENE_THRESHOLD);

    if (this.#compressionConfig.enabled !== true) {
      return {
        status: "skipped",
        reason: "disabled",
        preTokens: 0,
        thresholdTokens
      };
    }

    const messages = await this.#sessionDb.listMessages(input.sessionId);
    const preTokens = estimateMessagesTokensRough(messages.map((message) => ({
      role: message.role,
      content: message.content,
      metadata: message.metadata
    })));

    if (messages.length === 0) {
      return {
        status: "skipped",
        reason: "no-messages",
        preTokens,
        thresholdTokens
      };
    }

    if (preTokens < thresholdTokens) {
      return {
        status: "skipped",
        reason: "below-threshold",
        preTokens,
        thresholdTokens
      };
    }

    try {
      const request: SessionCompressionRequest = {
        profileId: this.#profileId,
        sessionId: input.sessionId,
        trigger: "hygiene",
        preserveTranscript: true,
        signal: input.signal
      };
      const result = await this.#compressionService.compactIfNeeded(request);
      const warnings = [
        ...result.diagnostics.warnings,
        ...result.diagnostics.eventWarnings
      ];
      if (!result.didCompress) {
        return {
          status: "skipped",
          reason: result.diagnostics.reason === "below-threshold" ? "below-threshold" : "compression-skipped",
          preTokens,
          thresholdTokens
        };
      }
      return {
        status: "compacted",
        reason: "threshold-exceeded",
        preTokens,
        thresholdTokens,
        activeSessionId: result.activeSessionId,
        rotated: result.rotated,
        result,
        warnings
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#logWarning?.(`Gateway session hygiene failed for ${input.sessionId}: ${message}`);
      return {
        status: "failed",
        reason: "compression-failed",
        preTokens,
        thresholdTokens,
        error: message,
        warnings: [message]
      };
    }
  }
}
