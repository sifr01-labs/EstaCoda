import type { ChannelKind } from "./channel.js";
import type { ContextReference } from "./context.js";
import type { IntentRoute } from "./intent.js";
import type { ProviderErrorClass } from "./provider.js";
import type { PromptBudgetReport } from "./prompt.js";
import type { ArtifactRecord } from "./artifact.js";
import type { MemoryConclusion, SkillOutcome } from "./memory.js";
import type { SecurityAssessment, SecurityDecision } from "./security.js";
import type { ToolResult, ToolRiskClass } from "./tool.js";
import type { ToolCallPlan } from "./tool-plan.js";
import type {
  SkillLifecycleState,
  SkillRouteTelemetry,
  SkillRouteTelemetryDetails,
  SkillRouteFinalOutcomeStatus,
  CompiledSkillPlaybook
} from "./skill.js";
import type { FailureRecord } from "./failure.js";
import type { ProviderUsageEntry, ProviderUsageQuery } from "./provider-usage.js";
import type { DelegateRole } from "./delegation.js";
import type {
  ModelProfile,
  ProviderApiMode,
  ProviderAuthMethod,
  ProviderFinishReason,
  ProviderId,
  ProviderLoopRuntimeMetadata,
  ProviderReasoningMetadata,
  ProviderRouteRole,
  ProviderStreamDiagnostics,
  ProviderUsage
} from "./provider.js";

export type SessionRole = "user" | "agent" | "system" | "tool";

export type SessionRecord = {
  id: string;
  profileId: string;
  title?: string;
  createdAt: string;
  updatedAt: string;
  parentSessionId?: string;
  endedAt?: string;
  endReason?: string;
  metadata?: Record<string, unknown>;
};

export type SessionModelOverride = {
  route: {
    provider: ProviderId;
    id: string;
    baseUrl?: string;
    apiKeyEnv?: string;
    apiMode?: ProviderApiMode;
    authMethod?: ProviderAuthMethod;
    contextWindowTokens?: number;
    maxTokens?: number;
    routeId?: string;
  };
  modelProfile: ModelProfile;
  setAt: string;
  source: "cli" | "gateway";
};

export type SessionMessage = {
  id: string;
  sessionId: string;
  role: SessionRole;
  content: string;
  createdAt: string;
  channel?: ChannelKind;
  metadata?: Record<string, unknown>;
};

export type SessionCompressionTrigger = "auto" | "manual" | "hygiene";

export type SessionCompressionSourceRange = {
  startMessageId?: string;
  endMessageId?: string;
  messageCount: number;
  estimatedTokens?: number;
};

export type SessionCompressionProtectedSpan = {
  startMessageId?: string;
  endMessageId?: string;
  messageCount: number;
};

export type SessionCompressionFailure = {
  code: string;
  message: string;
  recoverable?: boolean;
};

export type SessionCompressionState = {
  status: "idle" | "compressed" | "failed";
  trigger?: SessionCompressionTrigger;
  compressionCount: number;
  lastCompressedAt?: string;
  previousSummary?: string;
  lastCompressedThroughMessageId?: string;
  lastPromptTokensEstimated?: number;
  lastActualPromptTokens?: number;
  source?: SessionCompressionSourceRange;
  protectedFirstN: number;
  protectedLastN: number;
  protectedSpans: SessionCompressionProtectedSpan[];
  sourceMessageCount?: number;
  protectedMessageCount?: number;
  summaryFormatVersion?: string;
  summaryMessageId?: string;
  summaryChars?: number;
  summaryEstimatedTokens?: number;
  summaryLengthTokens?: number;
  droppedMessageCount?: number;
  estimatedSavingsTokens?: number;
  lastCompressionSavingsPct?: number;
  ineffectiveCompressionCount: number;
  recentSavingsRatios?: number[];
  summaryFailureCooldownUntil?: string;
  fallbackUsed: boolean;
  fallbackReason?: string;
  model?: string;
  modelUsed?: string;
  auxModelFailure?: SessionCompressionFailure;
  mainRetryFailure?: SessionCompressionFailure;
  warnings: string[];
  failure?: SessionCompressionFailure;
};

export type SessionHistoryCompressedEvent = {
  kind: "session-history-compressed";
  trigger: SessionCompressionTrigger;
  source: SessionCompressionSourceRange;
  sourceMessageCount?: number;
  protectedFirstN: number;
  protectedLastN: number;
  protectedSpans?: SessionCompressionProtectedSpan[];
  protectedMessageCount?: number;
  summaryFormatVersion: string;
  summaryChars: number;
  summaryEstimatedTokens?: number;
  summaryLengthTokens?: number;
  droppedMessageCount?: number;
  estimatedSavingsTokens?: number;
  estimatedSavingsRatio?: number;
  fallbackUsed?: boolean;
  fallbackReason?: string;
  model?: string;
  modelUsed?: string;
  auxModelFailure?: SessionCompressionFailure;
  mainRetryFailure?: SessionCompressionFailure;
  warnings?: string[];
  failure?: SessionCompressionFailure;
};

export type SessionCompressionStateEvent = {
  kind: "session-compression-state";
  state: Partial<SessionCompressionState>;
};

export type SessionContextWindowUsage = {
  usedTokens: number;
  totalTokens: number;
  provider: string;
  model: string;
  routeRole?: ProviderRouteRole;
};

export type SessionContextWindowUsageEvent = SessionContextWindowUsage & {
  kind: "context-window-usage";
};

export type SessionContextWindowUsageInvalidatedEvent = {
  kind: "context-window-usage-invalidated";
  reason: "model-change" | "compaction";
};

export type SessionCompactionForkedEvent = {
  kind: "session-compaction-forked";
  trigger: SessionCompressionTrigger;
  childSessionId: string;
  compactedAt: string;
  sourceMessageCount: number;
  compactedMessageCount: number;
};

export type StructuredToolHistoryDiagnosticReason =
  | "provider_unsupported"
  | "model_tools_unsupported"
  | "no_native_messages"
  | "malformed_history"
  | "budget_fallback"
  | "serialization_unsupported"
  | "missing_echo"
  | "echo_oversized"
  | "unsafe_arguments";

export type StructuredToolHistoryDiagnosticEvent = {
  kind:
    | "structured-tool-history-selected"
    | "structured-tool-history-repaired"
    | "structured-tool-history-skipped"
    | "structured-tool-history-serialized";
  provider?: ProviderId;
  model?: string;
  routeRole?: string;
  nativePairs?: number;
  droppedOrphans?: number;
  injectedStubs?: number;
  mergedUsers?: number;
  skippedMalformedToolCalls?: number;
  skippedUnsafeTurns?: number;
  echoMessages?: number;
  preservedEchoMessages?: number;
  placeholderEchoMessages?: number;
  strippedEchoMessages?: number;
  echoMissing?: number;
  echoOversized?: number;
  nativeReplayUnsafeTurns?: number;
  historicalNativeReplay?: true;
  historicalToolResultsLabeled?: number;
  mutableStateToolResultsLabeled?: number;
  reason?: StructuredToolHistoryDiagnosticReason;
};

export type SessionEvent =
  | {
      kind: "intent-routed";
      route: IntentRoute;
    }
  | {
      kind: "skill-selected";
      skill: string;
    }
  | {
      kind: "skill-playbook-planned";
      plan: CompiledSkillPlaybook;
    }
  | {
      kind: "skill-playbook-step";
      skill: string;
      stepId: string;
      description: string;
      status: "tool-executed" | "no-tool" | "blocked" | "skipped";
      toolsets: string[];
      tool?: string;
      reason?: string;
    }
  | {
      kind: "security-decided";
      decision: SecurityDecision;
      description: string;
      mode?: string;
      reason?: string;
    }
  | {
      kind: "security-assessed";
      tool: string;
      riskClass: ToolRiskClass;
      targetKey?: string;
      targetSummary?: string;
      assessment: SecurityAssessment;
    }
  | {
      kind: "trajectory-linked";
      trajectoryId: string;
    }
  | {
      kind: "context-expanded";
      references: ContextReference[];
      blocks: Array<{
        source: string;
        status: string;
        bytes: number;
        warnings: string[];
      }>;
      warnings: string[];
    }
  | {
      kind: "delegation-diagnostic";
      childSessionId: string;
      reason: "timeout" | "stale-heartbeat";
      diagnosticPath: string;
      taskHash: string;
      taskPreview: string;
      role?: DelegateRole;
      depth?: number;
      taskIndex?: number;
      batchId?: string;
    }
  | {
      kind: "tool-called";
      tool: string;
      input: Record<string, unknown>;
      toolCallId?: string;
      toolCallName?: string;
      providerNativeToolCall?: unknown;
    }
  | {
      kind: "tool-gated";
      tool: string;
      decision: SecurityDecision;
      riskClass: ToolRiskClass;
    }
  | {
      kind: "tool-result";
      tool: string;
      result: ToolResult;
      toolCallId?: string;
      toolCallName?: string;
      providerNativeToolCall?: unknown;
    }
  | {
      kind: "artifact-created";
      artifact: ArtifactRecord;
      tool?: string;
    }
  | SessionContextWindowUsageEvent
  | SessionContextWindowUsageInvalidatedEvent
  | {
      kind: "provider-completion";
      iteration?: number;
      ok: boolean;
      finishReason?: ProviderFinishReason;
      incompleteReason?: string;
      attempts: Array<{
        provider: string;
        model: string;
        dispatched?: boolean;
        dispatchedAt?: string;
        credentialId?: string;
        ok: boolean;
        errorClass?: ProviderErrorClass | string;
        finishReason?: ProviderFinishReason;
        incompleteReason?: string;
        usage?: ProviderUsage;
        reasoningMetadata?: ProviderReasoningMetadata;
        streamDiagnostics?: ProviderStreamDiagnostics;
      }>;
      fallbackUsed: boolean;
      usage?: ProviderUsage;
      runtimeMetadata?: ProviderLoopRuntimeMetadata;
    }
  | {
      kind: "provider-continuation";
      iteration?: number;
      ok: boolean;
      finishReason?: ProviderFinishReason;
      incompleteReason?: string;
      attempts: Array<{
        provider: string;
        model: string;
        dispatched?: boolean;
        dispatchedAt?: string;
        credentialId?: string;
        ok: boolean;
        errorClass?: ProviderErrorClass | string;
        finishReason?: ProviderFinishReason;
        incompleteReason?: string;
        usage?: ProviderUsage;
        reasoningMetadata?: ProviderReasoningMetadata;
        streamDiagnostics?: ProviderStreamDiagnostics;
      }>;
      toolPlans: Array<{
        id: string;
        tool: string;
        status: string;
      }>;
      usage?: ProviderUsage;
      runtimeMetadata?: ProviderLoopRuntimeMetadata;
    }
  | {
      kind: "provider-iteration";
      iteration: number;
      phase: "initial" | "continuation";
      ok: boolean;
      toolCalls: number;
      executedTools: number;
      exhausted: boolean;
    }
  | {
      kind: "prompt-assembled";
      budget: PromptBudgetReport;
    }
  | {
      kind: "session-recall-decision";
      triggered: boolean;
      reason: string;
      query?: string;
      sourceSessionIds: string[];
      warningCount: number;
    }
  | {
      kind: "external-memory-recall";
      providerIds: string[];
      enabled: boolean;
      attempted: boolean;
      resultCount: number;
      totalChars: number;
      profileId?: string;
      workspaceScoped: boolean;
      warningCount: number;
      failureCount: number;
      failures?: Array<{
        providerId?: string;
        reason: string;
      }>;
      durationMs?: number;
    }
  | {
      kind: "external-memory-mirror-write";
      providerIds: string[];
      enabled: boolean;
      mirrorEnabled: boolean;
      localWriteSucceeded: boolean;
      mirrorAttempted: boolean;
      mirrorSucceeded: boolean;
      memoryFile?: string;
      operationKind?: string;
      entryChars: number;
      profileId?: string;
      workspaceScoped: boolean;
      warningCount: number;
      failureCount: number;
      failures?: Array<{
        providerId?: string;
        reason: string;
      }>;
    }
  | {
      kind: "session-history-packed";
      sourceMessageCount: number;
      summarizedMessageCount: number;
      protectedMessageCount: number;
      protectedToolPairCount?: number;
      estimatedTokens: number;
      summary?: string;
    }
  | SessionHistoryCompressedEvent
  | SessionCompressionStateEvent
  | SessionCompactionForkedEvent
  | StructuredToolHistoryDiagnosticEvent
  | {
      kind: "provider-budget-exhausted";
      budget: string;
      limit: number;
      observed: number;
      reason: string;
    }
  | {
      kind: "skill-route-usage";
      timestamp: string;
      promptHash?: string;
      skillName?: string;
      nativeIntent: string;
      taskClass?: string;
      labels: string[];
      selected: boolean;
      invoked: boolean;
      deferred: boolean;
      deferReason?: string;
      confidence: number;
      evidenceKinds: string[];
      surface?: string;
    }
  | {
      kind: "skill-route-telemetry";
      telemetry: {
        promptHash: string;
        labels: string[];
        confidence: number;
        routeConfidence?: number;
        selectedSkill?: string;
        finalSkillUsed?: string;
        explicitInvocation: boolean;
        candidates: SkillRouteTelemetry[];
        candidatesShown?: string[];
        finalOutcomeStatus?: SkillRouteFinalOutcomeStatus;
      } & SkillRouteTelemetryDetails;
    }
  | {
      kind: "skill-route-advisory";
      timestamp: string;
      promptHash: string;
      selectedSkill?: string;
      action: "reject_route" | "search_routes" | "rerank";
      details: SkillRouteTelemetryDetails;
    }
  | {
      kind: "skill-lifecycle-changed";
      skillName: string;
      from?: SkillLifecycleState;
      to: SkillLifecycleState;
      reason?: string;
    }
  | {
      kind: "security-risk-escalated";
      from: ToolRiskClass;
      to: ToolRiskClass;
      reason: string;
    }
  | {
      kind: "agent-cancelled";
      reason: string;
      resumeNote?: string;
      activeSkill?: string;
      activeToolPlans?: Array<{
        id: string;
        tool: string;
        status: string;
      }>;
    }
  | {
      kind: "tool-plan";
      plan: ToolCallPlan;
    }
  | {
      kind: "memory-write";
      provider: string;
      outcome: SkillOutcome;
    }
  | {
      kind: "memory-conclusion";
      provider: string;
      conclusion: MemoryConclusion;
    }
  | {
      kind: "memory-promotion-failed";
      provider: string;
      reason: "memory-budget-overflow";
      targetFile: string;
      memoryKind: string;
      pressure?: {
        state: string;
        chars: number;
        maxChars?: number;
        overflowChars?: number;
      };
      conclusionKind?: MemoryConclusion["kind"];
      conclusionId?: string;
      remediationHint: string;
      failure?: string;
    }
  | {
      kind: "memory-file-compaction";
      file?: string;
      dryRun?: boolean;
      status: string;
      backupId?: string;
      preRestoreBackupId?: string;
      originalChars?: number;
      compactedChars?: number;
      restoredChars?: number;
    }
  | {
      kind: "memory-curation";
      trigger: "turn-count" | "compact" | "handoff" | "runtime-dispose" | "manual";
      status: "auto-applied" | "pending-review" | "ignored" | "failed";
      sourceMessageCount: number;
      extractedFactCount: number;
      candidateCount: number;
      autoAppliedCount: number;
      pendingReviewCount: number;
      ignoredCount: number;
      failedCount: number;
      warningCount: number;
      warnings?: string[];
    }
  | {
      kind: "skill-learned";
      action: "observed" | "candidate" | "created";
      record: {
        key: string;
        name: string;
        content: string;
        occurrences: number;
        sourceSessionIds: string[];
        tools: string[];
        requiredToolsets: string[];
        bounded: boolean;
        status: "observed" | "candidate" | "created" | "stale";
        staleReason?: "created-path-missing" | "created-path-outside-profile";
        staleDetectedAt?: string;
        evidenceIds?: string[];
        candidateId?: string;
        candidateKind?: string;
        promptHash?: string;
        selectedSkillName?: string;
        createdSkillName?: string;
        createdSkillPath?: string;
        updatedAt: string;
      };
    }
  | {
      kind: "user-correction";
      correctionText: string;
      skillName?: string;
      reason?: string;
    };

export type SessionSearchResult = {
  session: SessionRecord;
  message: SessionMessage;
  score: number;
};

export type SessionSearchOptions = {
  profileId?: string;
  limit?: number;
  rootSessionsOnly?: boolean;
};

export type CreateSessionInput = {
  id?: string;
  profileId: string;
  title?: string;
  parentSessionId?: string;
  endedAt?: string;
  endReason?: string;
  metadata?: Record<string, unknown>;
};

export type AppendMessageInput = {
  id?: string;
  sessionId: string;
  role: SessionRole;
  content: string;
  channel?: ChannelKind;
  metadata?: Record<string, unknown>;
};

export type ReplacementSessionMessage = {
  id?: string;
  role: SessionRole;
  content: string;
  createdAt?: string;
  channel?: ChannelKind;
  metadata?: Record<string, unknown>;
};

export type RewriteSessionTranscriptInput = {
  sessionId: string;
  messages: ReplacementSessionMessage[];
  /** Events committed atomically with the transcript replacement. */
  events?: SessionEvent[];
};

export type SessionDB = {
  createSession(input: CreateSessionInput): Promise<SessionRecord>;
  getSession(id: string): Promise<SessionRecord | undefined>;
  listSessions(profileId?: string): Promise<SessionRecord[]>;
  endSession(sessionId: string, reason: string): Promise<void>;
  setSessionModelOverride(sessionId: string, override: SessionModelOverride): Promise<void>;
  clearSessionModelOverride(sessionId: string): Promise<void>;
  getSessionModelOverride(sessionId: string): Promise<SessionModelOverride | undefined>;
  appendMessage(input: AppendMessageInput): Promise<SessionMessage>;
  replaceMessages(input: RewriteSessionTranscriptInput): Promise<SessionMessage[]>;
  rewriteTranscript(input: RewriteSessionTranscriptInput): Promise<SessionMessage[]>;
  appendEvent(sessionId: string, event: SessionEvent): Promise<void>;
  recordProviderUsageEntries(entries: readonly ProviderUsageEntry[]): Promise<void>;
  listProviderUsageEntries(profileId: string, query?: ProviderUsageQuery): Promise<ProviderUsageEntry[]>;
  listMessages(sessionId: string): Promise<SessionMessage[]>;
  listEvents(sessionId: string): Promise<SessionEvent[]>;
  search(query: string, options?: SessionSearchOptions): Promise<SessionSearchResult[]>;
  saveFailure?(record: FailureRecord): Promise<void>;
};
