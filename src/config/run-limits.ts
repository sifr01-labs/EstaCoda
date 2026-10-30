export type AgentRunLimits = { maxIterations: number; maxToolCalls: number; maxDurationMinutes: number };
export type RunLimitsConfig = { interactive?: Partial<AgentRunLimits>; unattended?: Partial<AgentRunLimits> };
export const DEFAULT_RUN_LIMITS = {
  interactive: { maxIterations: 0, maxToolCalls: 0, maxDurationMinutes: 0 },
  unattended: { maxIterations: 45, maxToolCalls: 100, maxDurationMinutes: 30 }
} satisfies Record<string, AgentRunLimits>;

/** Zero explicitly disables an interactive ceiling. Unattended work remains bounded.
 * Reject malformed policy rather than coercing it into unlimited execution. */
export function normalizeRunLimits(value: unknown): Record<'interactive' | 'unattended', AgentRunLimits> {
  if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value))) throw new Error('Invalid agent run limits.');
  const raw = (value ?? {}) as Record<string, unknown>;
  if (Object.keys(raw).some(key => !['interactive', 'unattended'].includes(key))) throw new Error('Unknown agent run limit scope.');
  const result = structuredClone(DEFAULT_RUN_LIMITS);
  for (const scope of ['interactive', 'unattended'] as const) {
    const limits = raw[scope];
    if (limits === undefined) continue;
    if (!limits || typeof limits !== 'object' || Array.isArray(limits)) throw new Error('Invalid agent run limit scope.');
    for (const [key, amount] of Object.entries(limits)) {
      const max = key === 'maxDurationMinutes' ? 10080 : 1_000_000;
      if (!Object.hasOwn(result[scope], key) || typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount < (scope === 'interactive' ? 0 : 1) || amount > max) throw new Error('Agent run limits must be whole numbers within the supported range.');
      result[scope][key as keyof AgentRunLimits] = amount;
    }
  }
  return result;
}

export function providerBudgetsForRun(limits: AgentRunLimits) {
  return {
    maxProviderIterations: limits.maxIterations || Infinity,
    maxProviderToolCalls: limits.maxToolCalls || Infinity,
    maxProviderWallClockMs: limits.maxDurationMinutes === 0 ? Infinity : limits.maxDurationMinutes * 60_000
  };
}


/** Explicit legacy child timeouts remain a narrower operator ceiling. */
export function unattendedRunLimits(config: {runLimits?:RunLimitsConfig;delegation?:{childTimeoutSeconds?:number}}): AgentRunLimits {
  const limits=normalizeRunLimits(config.runLimits).unattended;
  const legacy=config.delegation?.childTimeoutSeconds;
  if(legacy!==undefined && config.runLimits?.unattended===undefined){
    if(!Number.isFinite(legacy)||legacy<0)throw new Error('Invalid delegated timeout.');
    limits.maxDurationMinutes=Math.min(limits.maxDurationMinutes,Math.max(30,Math.floor(legacy))/60);
  }
  return limits;
}

export function taskLimitsForRun(limits:AgentRunLimits){
  return {maxProviderCalls:limits.maxIterations,maxTotalTokens:1_000_000,maxWallClockMs:Math.floor(limits.maxDurationMinutes*60_000)};
}
