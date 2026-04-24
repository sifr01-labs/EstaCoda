export type PromptLayerName =
  | "identity"
  | "frozen-memory"
  | "skills-index"
  | "project-context"
  | "session-history"
  | "user-message"
  | "intent"
  | "skill"
  | "skill-resources"
  | "context-references"
  | "memory"
  | "native-tools"
  | "tool-results"
  | "artifacts"
  | "fallback"
  | "provider-continuation";

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
};
