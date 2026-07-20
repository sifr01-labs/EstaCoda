import type { ProviderUsage, ResolvedModelRoute } from "../contracts/provider.js";

export type ProviderUsageEstimate = {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
  usageComplete: boolean;
  pricingComplete: boolean;
  incompleteReasons: readonly string[];
};

export type TokenUsageCostRates = {
  input?: number;
  output?: number;
  reasoning?: number;
  cacheRead?: number;
  cacheWrite?: number;
  inputAudio?: number;
  outputAudio?: number;
};

export type TokenUsageCostBreakdown = {
  inputUsd: number;
  outputUsd: number;
  reasoningUsd: number;
  cacheReadUsd: number;
  cacheWriteUsd: number;
  inputAudioUsd: number;
  outputAudioUsd: number;
};

/** Shared pricing primitive for registry estimates and the persisted request ledger. */
export function estimateTokenUsageCost(
  usage: {
    inputTokens?: number;
    outputTokens?: number;
    reasoningTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    inputAudioTokens?: number;
    outputAudioTokens?: number;
  },
  rates: TokenUsageCostRates
): { amountUsd: number; breakdown: TokenUsageCostBreakdown; missingCategories: readonly string[] } {
  const cacheRead = tokenCount(usage.cacheReadTokens) ?? 0;
  const cacheWrite = tokenCount(usage.cacheWriteTokens) ?? 0;
  const uncachedInput = Math.max(0, (tokenCount(usage.inputTokens) ?? 0) - cacheRead - cacheWrite);
  const categories: Array<[keyof TokenUsageCostBreakdown, number, number | undefined, string]> = [
    ["inputUsd", uncachedInput, rates.input, "input"],
    ["outputUsd", tokenCount(usage.outputTokens) ?? 0, rates.output, "output"],
    ["reasoningUsd", tokenCount(usage.reasoningTokens) ?? 0, rates.reasoning, "reasoning"],
    ["cacheReadUsd", cacheRead, rates.cacheRead, "cache-read"],
    ["cacheWriteUsd", cacheWrite, rates.cacheWrite, "cache-write"],
    ["inputAudioUsd", tokenCount(usage.inputAudioTokens) ?? 0, rates.inputAudio, "input-audio"],
    ["outputAudioUsd", tokenCount(usage.outputAudioTokens) ?? 0, rates.outputAudio, "output-audio"]
  ];
  const breakdown: TokenUsageCostBreakdown = {
    inputUsd: 0,
    outputUsd: 0,
    reasoningUsd: 0,
    cacheReadUsd: 0,
    cacheWriteUsd: 0,
    inputAudioUsd: 0,
    outputAudioUsd: 0
  };
  const missingCategories: string[] = [];
  for (const [field, tokens, rate, category] of categories) {
    if (tokens === 0) continue;
    if (!validRate(rate)) {
      missingCategories.push(category);
      continue;
    }
    breakdown[field] = (tokens / 1_000_000) * rate;
  }
  return {
    amountUsd: Object.values(breakdown).reduce((sum, value) => sum + value, 0),
    breakdown,
    missingCategories
  };
}

/** Prices a provider response against the exact route used for that request. */
export function estimateProviderUsage(
  usage: ProviderUsage | undefined,
  route: ResolvedModelRoute | undefined,
  attemptIndex: number
): ProviderUsageEstimate {
  const label = `provider-attempt-${attemptIndex + 1}`;
  const reasons = new Set<string>();
  const input = tokenCount(usage?.inputTokens);
  const output = tokenCount(usage?.outputTokens);
  const reasoning = tokenCount(usage?.reasoningTokens) ?? 0;
  const cacheRead = tokenCount(usage?.cacheReadTokens) ?? 0;
  const cacheWrite = tokenCount(usage?.cacheWriteTokens) ?? 0;
  const reportedTotal = tokenCount(usage?.totalTokens);
  let usageComplete = usage !== undefined && input !== undefined && output !== undefined;
  if (usage === undefined) reasons.add(`${label}-usage-missing`);
  if (input === undefined || output === undefined) reasons.add(`${label}-token-breakdown-incomplete`);

  const derivedTotal = (input ?? 0) + (output ?? 0);
  if (reportedTotal === undefined && !usageComplete) reasons.add(`${label}-total-tokens-missing`);
  if (reportedTotal !== undefined && reportedTotal < derivedTotal) {
    usageComplete = false;
    reasons.add(`${label}-total-tokens-invalid`);
  }
  if (cacheRead + cacheWrite > (input ?? 0)) {
    usageComplete = false;
    reasons.add(`${label}-cache-tokens-invalid`);
  }

  const costs = route?.profile.cost;
  let pricingComplete = usageComplete;
  const cost = estimateTokenUsageCost({
    inputTokens: input,
    outputTokens: output,
    reasoningTokens: reasoning,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite
  }, {
    input: costs?.inputPerMillionTokens,
    output: costs?.outputPerMillionTokens,
    reasoning: costs?.reasoningPerMillionTokens,
    cacheRead: costs?.cacheReadPerMillionTokens,
    cacheWrite: costs?.cacheWritePerMillionTokens
  });
  for (const category of cost.missingCategories) {
    pricingComplete = false;
    reasons.add(`${label}-${category}-pricing-missing`);
  }

  return {
    inputTokens: input ?? 0,
    outputTokens: output ?? 0,
    reasoningTokens: reasoning,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    totalTokens: reportedTotal ?? derivedTotal,
    estimatedCostUsd: cost.amountUsd,
    usageComplete,
    pricingComplete,
    incompleteReasons: [...reasons].slice(0, 32)
  };
}

function tokenCount(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function validRate(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
