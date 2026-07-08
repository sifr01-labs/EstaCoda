export type MemoryFileKind = "SHARED.md" | "MEMORY.md" | "USER.md" | "SOUL.md";

export type MemoryBudget = {
  kind: MemoryFileKind;
  maxChars: number;
};

export const DEFAULT_MEMORY_BUDGETS: readonly MemoryBudget[] = [
  { kind: "MEMORY.md", maxChars: 2200 },
  { kind: "USER.md", maxChars: 1375 }
];

export type MemoryOperation =
  | {
      kind: "append";
      file: MemoryFileKind;
      content: string;
    }
  | {
      kind: "replace";
      file: MemoryFileKind;
      match: string;
      replacement: string;
    }
  | {
      kind: "remove";
      file: MemoryFileKind;
      match: string;
    };

export type MemoryUsage = {
  kind: MemoryFileKind;
  chars: number;
  maxChars?: number;
  percent?: number;
};

export type RenderedMemorySnapshot = {
  text: string;
  usage: MemoryUsage[];
};

export type MemoryProviderContext = {
  text: string;
  usage: MemoryUsage[];
};

export type MemoryScope =
  | "bundled"
  | "user-global"
  | "project"
  | "workspace"
  | "external"
  | "session";

export type PromptMemoryBlock = {
  id: string;
  kind:
    | "learned-user"
    | "learned-project"
    | "safety"
    | "identity"
    | "session-recall"
    | "external-recall";
  scope: MemoryScope;
  source: string;
  content: string;
  chars: number;
  entryIds?: string[];
  lineRanges?: Array<{ startLine: number; endLine: number }>;
  trusted: boolean;
};

export type MemoryBudgetPressureState = "ok" | "warning" | "critical" | "overflow";

export type MemoryBudgetPressure = {
  kind: MemoryFileKind;
  source: string;
  chars: number;
  maxChars: number;
  ratio: number;
  percent: number;
  state: MemoryBudgetPressureState;
  remainingChars: number;
  overflowChars: number;
};

export type MemoryBudgetOverflow = {
  code: "memory-budget-overflow";
  kind: MemoryFileKind;
  source: string;
  chars: number;
  maxChars: number;
  overflowChars: number;
  pressure: MemoryBudgetPressure;
};

export type MemoryPromptDiagnostics = {
  includedBlocks: Array<{
    id: string;
    kind: PromptMemoryBlock["kind"];
    source: string;
    chars: number;
    entryIds?: string[];
  }>;
  suppressedEntries: number;
  duplicateEntriesRemoved: number;
  recallTriggered: boolean;
  recallDecisions?: MemoryRecallDecision[];
  budgetPressure: MemoryBudgetPressure[];
  compactionPressure: MemoryBudgetPressure[];
  warnings: string[];
};

export type MemoryPromptContext = {
  frozenCompactMemory: PromptMemoryBlock[];
  safetyMemory: PromptMemoryBlock[];
  sessionRecall?: PromptMemoryBlock[];
  externalRecall?: PromptMemoryBlock[];
  diagnostics: MemoryPromptDiagnostics;
};

export type MemoryRecallDecision = {
  included: boolean;
  reason: string;
  query?: string;
  scopesConsidered: MemoryScope[];
  sourceSessions?: string[];
  warnings?: string[];
};

export type MemorySearchResult = {
  source: MemoryFileKind | "session" | "trajectory";
  content: string;
  score: number;
};

export type MemoryAuthority = "canonical" | "derived" | "historical" | "external" | "plugin";

export type MemoryIndexedSourceType = "memory_file" | "shared_memory";

export type MemoryProtectedClass = "none" | "identity" | "safety";

export type MemoryRetrievalMode = "lexical";

export type MemoryLineRange = {
  startLine: number;
  endLine: number;
};

export type MemoryIndexEntry = {
  id: string;
  profileId: string;
  sourceType: MemoryIndexedSourceType;
  source: string;
  sourcePath?: string;
  sourceKey?: string;
  memoryFileKind?: MemoryFileKind;
  authority: MemoryAuthority;
  protectedClass: MemoryProtectedClass;
  contentHash: string;
  excerpt: string;
  lineRanges?: MemoryLineRange[];
  updatedAt: string;
};

export type MemoryRetrievalResult = {
  id: string;
  profileId: string;
  mode: MemoryRetrievalMode;
  sourceType: MemoryIndexedSourceType;
  source: string;
  sourcePath?: string;
  sourceKey?: string;
  memoryFileKind?: MemoryFileKind;
  authority: MemoryAuthority;
  protectedClass: MemoryProtectedClass;
  contentHash: string;
  content: string;
  excerpt: string;
  score: number;
  lineRanges?: MemoryLineRange[];
  updatedAt: string;
};

export type MemoryRetrievalFallbackReason =
  | "index-disabled"
  | "index-unavailable"
  | "index-pending-rebuild"
  | "index-stale"
  | "index-unhealthy";

export type MemoryRetrievalDiagnosticCode =
  | "memory-retrieval-disabled"
  | "memory-invalid-source"
  | "memory-index-disabled"
  | "memory-index-unavailable"
  | "memory-index-pending-rebuild"
  | "memory-index-stale"
  | "memory-index-unhealthy"
  | "memory-retrieval-fallback"
  | "memory-protected-filtered"
  | "memory-result-truncated";

export type MemoryRetrievalDiagnostic = {
  code: MemoryRetrievalDiagnosticCode;
  message: string;
  sourceType?: MemoryIndexedSourceType;
  source?: string;
  memoryFileKind?: MemoryFileKind;
  protectedClass?: MemoryProtectedClass;
};

export type MemoryRetrievalDiagnostics = {
  mode: MemoryRetrievalMode;
  profileId: string;
  indexEnabled: boolean;
  indexAvailable: boolean;
  indexStale: boolean;
  fallbackUsed: boolean;
  fallbackReason?: MemoryRetrievalFallbackReason;
  includeProtected: boolean;
  protectedFilteredCount: number;
  resultCount: number;
  truncated: boolean;
  diagnostics: MemoryRetrievalDiagnostic[];
};

export type ExternalMemoryProviderStatus = {
  id: string;
  enabled: boolean;
  healthy?: boolean;
  message?: string;
  diagnostics?: Record<string, unknown>;
};

export type ExternalMemoryRecallResult = {
  id: string;
  source: string;
  content: string;
  score?: number;
  entryIds?: string[];
  metadata?: Record<string, unknown>;
};

export type ExternalMemoryProviderContext = {
  profileId: string;
  sessionId?: string;
  workspaceRoot?: string;
  maxResults: number;
  maxChars: number;
};

export type ExternalMemoryTurn = {
  profileId: string;
  sessionId?: string;
  workspaceRoot?: string;
  userText?: string;
  assistantText?: string;
  metadata?: Record<string, unknown>;
};

export type ExternalMemorySessionSummary = {
  profileId: string;
  sessionId?: string;
  workspaceRoot?: string;
  summary: string;
  metadata?: Record<string, unknown>;
};

export type ExternalMemoryWriteEntry = {
  profileId: string;
  sessionId?: string;
  workspaceRoot?: string;
  operation: MemoryOperation;
  source: "memory.curate" | "promotion" | "skill-outcome" | "unknown";
  metadata?: Record<string, unknown>;
};

export type ExternalMemoryProvider = {
  id: string;
  prefetch?(
    query: string,
    context: ExternalMemoryProviderContext
  ): Promise<ExternalMemoryRecallResult[]> | ExternalMemoryRecallResult[];
  afterTurn?(turn: ExternalMemoryTurn): Promise<void> | void;
  flushSession?(summary: ExternalMemorySessionSummary): Promise<void> | void;
  mirrorMemoryWrite?(entry: ExternalMemoryWriteEntry): Promise<void> | void;
  search?(
    query: string,
    context: ExternalMemoryProviderContext
  ): Promise<ExternalMemoryRecallResult[]> | ExternalMemoryRecallResult[];
  status?(): Promise<ExternalMemoryProviderStatus> | ExternalMemoryProviderStatus;
};

export type MemoryConclusion = {
  id: string;
  kind: "skill-outcome" | "user-preference" | "project-fact" | "session-summary";
  content: string;
  confidence: number;
  source?: string;
  occurrences?: number;
  sourceSessionIds?: string[];
  sourceTrajectoryId?: string;
  sourceEventId?: string;
  createdAt?: string;
};

export type MemoryPromotionRecord = {
  id: string;
  kind: "user-preference" | "project-fact";
  content: string;
  active: boolean;
  confidence: number;
  occurrences: number;
  source: string;
  sourceSessionIds: string[];
  supersededBy?: string;
  forgottenAt?: string;
  forgottenReason?: string;
  updatedAt: string;
  createdAt?: string;
  sourceTrajectoryId?: string;
  sourceEventId?: string;
};

export type SkillOutcome = {
  skill: string;
  stepId?: string;
  summary: string;
  status: "succeeded" | "failed" | "blocked" | "partial";
  tools: string[];
  metadata?: Record<string, unknown>;
};

export type MemoryProvider = {
  id: string;
  context(options?: { query?: string }): Promise<MemoryProviderContext> | MemoryProviderContext;
  search(query: string, options?: { limit?: number }): Promise<MemorySearchResult[]> | MemorySearchResult[];
  conclude(conclusion: MemoryConclusion): Promise<void> | void;
  inspectPromotions?(): Promise<MemoryPromotionRecord[]> | MemoryPromotionRecord[];
  forgetPromotion?(content: string): Promise<MemoryPromotionRecord | undefined> | MemoryPromotionRecord | undefined;
};
