export type MemoryFileKind = "MEMORY.md" | "USER.md" | "SOUL.md" | "AGENTS.md";

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

export type MemorySearchResult = {
  source: MemoryFileKind | "session" | "trajectory";
  content: string;
  score: number;
};

export type MemoryConclusion = {
  id: string;
  kind: "skill-outcome" | "user-preference" | "project-fact" | "session-summary";
  content: string;
  confidence: number;
  source?: string;
};

export type SkillOutcome = {
  skill: string;
  stepId?: string;
  summary: string;
  status: "succeeded" | "failed" | "blocked" | "partial";
  tools: string[];
  memoryTargets?: MemoryFileKind[];
  metadata?: Record<string, unknown>;
};

export type MemoryProvider = {
  id: string;
  context(): Promise<MemoryProviderContext> | MemoryProviderContext;
  search(query: string, options?: { limit?: number }): Promise<MemorySearchResult[]> | MemorySearchResult[];
  conclude(conclusion: MemoryConclusion): Promise<void> | void;
  recordSkillOutcome(outcome: SkillOutcome): Promise<void> | void;
};
