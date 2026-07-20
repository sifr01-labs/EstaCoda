export type UsageCostSummary = {
  providerCalls: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  /** Undefined means no usable price component is known. */
  estimatedCostUsd?: number;
  usageComplete: boolean;
  costComplete: boolean;
  incompleteReasons: readonly string[];
};

export type TurnUsageSummary = {
  /** Persisted user-message ID for the runtime handle that produced this summary. */
  turnId: string;
  mainAgent: UsageCostSummary;
  total: UsageCostSummary;
};

export type SessionCostSummary = UsageCostSummary;
