export type PromptLayerName =
  | "identity"
  | "profile"
  | "mutable-state-grounding"
  | "safety-memory"
  | "skills-index"
  | "project-context"
  | "session-history"
  | "conversation-continuation"
  | "compaction-notice"
  | "user-message"
  | "channel-attachments"
  | "intent"
  | "skill"
  | "skill-setup"
  | "skill-resources"
  | "context-references"
  | "memory"
  | "session-recall"
  | "external-recall"
  | "native-tools"
  | "tool-results"
  | "artifacts"
  | "fallback"
  | "provider-continuation";

export type PromptSemanticCompressionReport = {
  triggered: boolean;
  mode: "semantic" | "deterministic" | "none";
  summaryFormatVersion?: string;
  preTokens?: number;
  postTokens?: number;
  savingsPct?: number;
  fallbackUsed?: boolean;
  fallbackReason?: string;
  protectedSpans?: Array<{
    category?: string;
    startMessageId?: string;
    endMessageId?: string;
    messageCount?: number;
  }>;
  warnings?: string[];
};

export type PromptLayerReport = {
  name: PromptLayerName;
  chars: number;
  estimatedTokens: number;
  cacheable: boolean;
  truncated: boolean;
  compressed: boolean;
  protected: boolean;
  priority: number;
  cacheKey?: string;
  cacheStatus?: "hit" | "miss" | "uncacheable";
};

export type PromptBudgetReport = {
  model: string;
  contextWindowTokens: number;
  targetTokens: number;
  estimatedTokens: number;
  remainingTokens: number;
  layers: PromptLayerReport[];
  compressedLayers: PromptLayerName[];
  cache: {
    hits: number;
    misses: number;
    uncacheable: number;
  };
  warnings: string[];
  compression?: PromptSemanticCompressionReport;
};
