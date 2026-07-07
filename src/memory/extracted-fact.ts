export type ExtractedFactCategory =
  | "work"
  | "project"
  | "preference"
  | "operating-style"
  | "recurring-constraint"
  | "technical-default"
  | "personal"
  | "other";

export type ExtractedFactExplicitness = "explicit" | "strongly-implied" | "inferred";
export type ExtractedFactSensitivity = "none" | "private" | "sensitive" | "secret";

export type ExtractedFactEvidence = {
  messageId: string;
  exactSpan: string;
};

export type ExtractedFact = {
  id: string;
  statement: string;
  category: ExtractedFactCategory;
  evidence: ExtractedFactEvidence[];
  explicitness: ExtractedFactExplicitness;
  sensitivity: ExtractedFactSensitivity;
  confidence: number;
};

export function normalizeExtractedFact(input: unknown, id: () => string = () => crypto.randomUUID()): ExtractedFact | undefined {
  if (!isRecord(input)) {
    return undefined;
  }
  const statement = stringValue(input.statement);
  const category = normalizeCategory(input.category);
  const explicitness = normalizeExplicitness(input.explicitness);
  const sensitivity = normalizeSensitivity(input.sensitivity);
  const confidence = normalizeConfidence(input.confidence);
  const evidence = normalizeEvidence(input.evidence);

  if (
    statement === undefined ||
    category === undefined ||
    explicitness === undefined ||
    sensitivity === undefined ||
    confidence === undefined ||
    evidence.length === 0
  ) {
    return undefined;
  }

  return {
    id: stringValue(input.id) ?? id(),
    statement,
    category,
    evidence,
    explicitness,
    sensitivity,
    confidence
  };
}

export function evidenceSpanExists(input: {
  fact: Pick<ExtractedFact, "evidence">;
  messages: ReadonlyArray<{ id: string; content: string }>;
}): boolean {
  const messageById = new Map(input.messages.map((message) => [message.id, message.content]));
  return input.fact.evidence.some((evidence) => {
    const content = messageById.get(evidence.messageId);
    return content !== undefined && evidence.exactSpan.length > 0 && content.includes(evidence.exactSpan);
  });
}

function normalizeEvidence(value: unknown): ExtractedFactEvidence[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry): ExtractedFactEvidence[] => {
    if (!isRecord(entry)) {
      return [];
    }
    const messageId = stringValue(entry.messageId);
    const exactSpan = stringValue(entry.exactSpan);
    if (messageId === undefined || exactSpan === undefined) {
      return [];
    }
    return [{ messageId, exactSpan }];
  }).slice(0, 8);
}

function normalizeCategory(value: unknown): ExtractedFactCategory | undefined {
  return oneOf(value, [
    "work",
    "project",
    "preference",
    "operating-style",
    "recurring-constraint",
    "technical-default",
    "personal",
    "other"
  ]);
}

function normalizeExplicitness(value: unknown): ExtractedFactExplicitness | undefined {
  return oneOf(value, ["explicit", "strongly-implied", "inferred"]);
}

function normalizeSensitivity(value: unknown): ExtractedFactSensitivity | undefined {
  return oneOf(value, ["none", "private", "sensitive", "secret"]);
}

function normalizeConfidence(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.min(1, Math.max(0, value));
}

function oneOf<T extends string>(value: unknown, values: readonly T[]): T | undefined {
  return typeof value === "string" && (values as readonly string[]).includes(value)
    ? value as T
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
