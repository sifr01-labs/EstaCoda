import type { MemoryCurationConfig } from "../config/memory-config.js";
import type { MemoryFileKind, MemoryOperation } from "../contracts/memory.js";
import { scanMemoryContent } from "./memory-scanner.js";
import { MemoryStore, type MemorySnapshot } from "./memory-store.js";
import type { ExtractedFact, ExtractedFactCategory } from "./extracted-fact.js";
import { evidenceSpanExists } from "./extracted-fact.js";

export type MemoryCandidateDisposition = "auto-apply" | "pending-review" | "ignore";
export type MemoryCandidateRisk = "low" | "medium" | "high";

export type CuratedMemoryCandidate = {
  id: string;
  factId: string;
  target: "USER.md" | "MEMORY.md";
  operation: "append" | "replace" | "remove";
  content?: string;
  match?: string;
  replacement?: string;
  disposition: MemoryCandidateDisposition;
  reason: string;
  risk: MemoryCandidateRisk;
};

export type ReviewMemoryFactsInput = {
  facts: readonly ExtractedFact[];
  memoryStore: Pick<MemoryStore, "read" | "snapshot">;
  messages: ReadonlyArray<{ id: string; content: string }>;
  config: MemoryCurationConfig;
  id?: () => string;
};

export function reviewMemoryFacts(input: ReviewMemoryFactsInput): CuratedMemoryCandidate[] {
  const id = input.id ?? (() => crypto.randomUUID());
  return input.facts.map((fact) => reviewMemoryFact({
    fact,
    memoryStore: input.memoryStore,
    messages: input.messages,
    config: input.config,
    id
  }));
}

function reviewMemoryFact(input: {
  fact: ExtractedFact;
  memoryStore: Pick<MemoryStore, "read" | "snapshot">;
  messages: ReadonlyArray<{ id: string; content: string }>;
  config: MemoryCurationConfig;
  id: () => string;
}): CuratedMemoryCandidate {
  const target = targetForFact(input.fact);
  const content = renderFactMemoryLine(input.fact);
  const operation: MemoryOperation = {
    kind: "append",
    file: target,
    content
  };
  const risk = riskForFact(input.fact);
  const rejection = autoApplyRejection({
    fact: input.fact,
    target,
    content,
    operation,
    memoryStore: input.memoryStore,
    messages: input.messages,
    config: input.config,
    risk
  });

  return {
    id: input.id(),
    factId: input.fact.id,
    target,
    operation: "append",
    content,
    disposition: rejection === undefined ? "auto-apply" : rejection.disposition,
    reason: rejection?.reason ?? "explicit low-risk fact passed curation policy",
    risk
  };
}

function autoApplyRejection(input: {
  fact: ExtractedFact;
  target: "USER.md" | "MEMORY.md";
  content: string;
  operation: MemoryOperation;
  memoryStore: Pick<MemoryStore, "read" | "snapshot">;
  messages: ReadonlyArray<{ id: string; content: string }>;
  config: MemoryCurationConfig;
  risk: MemoryCandidateRisk;
}): { disposition: Exclude<MemoryCandidateDisposition, "auto-apply">; reason: string } | undefined {
  if (input.config.mode !== "auto") {
    return {
      disposition: input.config.mode === "review" ? "pending-review" : "ignore",
      reason: `memory curation mode is ${input.config.mode}`
    };
  }
  if (input.fact.explicitness !== "explicit") {
    return { disposition: "pending-review", reason: `fact explicitness is ${input.fact.explicitness}` };
  }
  if (input.fact.sensitivity !== "none") {
    return { disposition: "pending-review", reason: `fact sensitivity is ${input.fact.sensitivity}` };
  }
  if (input.fact.confidence < input.config.autoApplyMinConfidence) {
    return { disposition: "pending-review", reason: `fact confidence ${input.fact.confidence} is below ${input.config.autoApplyMinConfidence}` };
  }
  if (!evidenceSpanExists({ fact: input.fact, messages: input.messages })) {
    return { disposition: "pending-review", reason: "fact evidence span was not found in source messages" };
  }
  if (riskRank(input.risk) > riskRank(input.config.autoApplyMaxRisk)) {
    return { disposition: "pending-review", reason: `fact risk ${input.risk} is above ${input.config.autoApplyMaxRisk}` };
  }
  if (isDuplicate(input.content, input.memoryStore.read(input.target))) {
    return { disposition: "ignore", reason: `${input.target} already contains this memory` };
  }
  const scan = scanMemoryContent(input.content);
  if (!scan.ok) {
    return { disposition: "pending-review", reason: `memory scanner rejected content: ${scan.issues.join("; ")}` };
  }
  if (isBlockedCategory(input.fact.category) || hasBlockedSubjectMatter(input.fact.statement)) {
    return { disposition: "pending-review", reason: "fact category or subject matter requires review" };
  }
  if (wouldOverflowBudget(input.operation, input.memoryStore.snapshot())) {
    return { disposition: "pending-review", reason: `${input.target} budget would overflow` };
  }
  return undefined;
}

function targetForFact(fact: ExtractedFact): "USER.md" | "MEMORY.md" {
  if (
    fact.category === "project" ||
    fact.category === "technical-default"
  ) {
    return "MEMORY.md";
  }
  return "USER.md";
}

function renderFactMemoryLine(fact: ExtractedFact): string {
  const statement = stripTrailingPunctuation(fact.statement);
  return `- ${statement}.`;
}

function riskForFact(fact: ExtractedFact): MemoryCandidateRisk {
  if (fact.sensitivity === "secret" || fact.sensitivity === "sensitive") {
    return "high";
  }
  if (fact.sensitivity === "private" || fact.explicitness !== "explicit" || isBlockedCategory(fact.category)) {
    return "medium";
  }
  if (hasBlockedSubjectMatter(fact.statement)) {
    return "medium";
  }
  return "low";
}

function isBlockedCategory(category: ExtractedFactCategory): boolean {
  return category === "personal";
}

function hasBlockedSubjectMatter(statement: string): boolean {
  return /\b(?:medical|diagnosis|medication|legal|lawsuit|attorney|financial|bank|salary|relationship|spouse|partner|child|passport|ssn|social security|token|credential|password)\b/iu.test(statement);
}

function isDuplicate(content: string, current: string): boolean {
  return content.trim().length > 0 && current.includes(content.trim());
}

function wouldOverflowBudget(operation: MemoryOperation, snapshot: MemorySnapshot): boolean {
  const clone = new MemoryStore({ budgets: snapshot.budgets });
  for (const [file, content] of snapshot.files.entries()) {
    clone.write(file, content);
  }
  try {
    clone.apply(operation);
    return false;
  } catch {
    return true;
  }
}

function riskRank(risk: MemoryCandidateRisk): number {
  if (risk === "low") {
    return 0;
  }
  if (risk === "medium") {
    return 1;
  }
  return 2;
}

function stripTrailingPunctuation(value: string): string {
  return value.trim().replace(/[.?!]+$/u, "");
}
