import type { MemoryConclusion, MemoryProvider } from "../contracts/memory.js";
import type { SessionDB } from "../contracts/session.js";
import { stripInlineReasoning } from "../providers/provider-reasoning.js";

export type UserPreferencePromotionResult =
  | {
      kind: "conclusion";
      conclusion: MemoryConclusion;
    }
  | {
      kind: "forgotten";
      content: string;
    };

export type ProjectFactPromotionResult = {
  kind: "conclusion";
  conclusion: MemoryConclusion;
};

export async function resolveUserPreferencePromotion(options: {
  profileId: string;
  currentUserText: string;
  sessionDb: SessionDB;
  memoryProvider: MemoryProvider;
  sourceTrajectoryId?: string;
  sourceEventId?: string;
}): Promise<UserPreferencePromotionResult | undefined> {
  const currentUserText = sanitizeMemoryLearningText(options.currentUserText);
  const forgottenContent = detectForgetPreference(currentUserText);
  if (forgottenContent !== undefined && options.memoryProvider.forgetPromotion !== undefined) {
    const forgotten = await options.memoryProvider.forgetPromotion(forgottenContent);
    if (forgotten !== undefined) {
      return {
        kind: "forgotten",
        content: forgotten.content
      };
    }
  }

  const currentPreference = detectUserPreference(currentUserText);

  if (currentPreference === undefined) {
    return undefined;
  }

  const matchingSessionIds = new Set<string>();
  const matches = await options.sessionDb.search(currentPreference.content, {
    profileId: options.profileId,
    limit: 50
  });

  for (const match of matches) {
    if (match.message.role !== "user") {
      continue;
    }

    const candidate = detectUserPreference(sanitizeMemoryLearningText(match.message.content));
    if (candidate?.key === currentPreference.key) {
      matchingSessionIds.add(match.session.id);
    }
  }

  if (matchingSessionIds.size < 2) {
    return undefined;
  }

  const conclusion: MemoryConclusion = {
    id: `memory-preference-${currentPreference.key}`,
    kind: "user-preference",
    content: currentPreference.content,
    confidence: Math.min(0.95, 0.55 + (matchingSessionIds.size - 2) * 0.15),
    source: "repeated-user-input",
    occurrences: matchingSessionIds.size,
    sourceSessionIds: [...matchingSessionIds],
    sourceTrajectoryId: options.sourceTrajectoryId,
    sourceEventId: options.sourceEventId,
    createdAt: new Date().toISOString()
  };

  await options.memoryProvider.conclude(conclusion);
  return {
    kind: "conclusion",
    conclusion
  };
}

export async function resolveProjectFactPromotion(options: {
  profileId: string;
  currentUserText: string;
  sessionDb: SessionDB;
  memoryProvider: MemoryProvider;
  sourceTrajectoryId?: string;
  sourceEventId?: string;
}): Promise<ProjectFactPromotionResult | undefined> {
  const currentUserText = sanitizeMemoryLearningText(options.currentUserText);
  const currentFact = detectProjectFact(currentUserText);

  if (currentFact === undefined) {
    return undefined;
  }

  const matchingSessionIds = new Set<string>();
  const matches = await options.sessionDb.search(currentFact.content, {
    profileId: options.profileId,
    limit: 50
  });

  for (const match of matches) {
    if (match.message.role !== "user") {
      continue;
    }

    const candidate = detectProjectFact(sanitizeMemoryLearningText(match.message.content));
    if (candidate?.key === currentFact.key) {
      matchingSessionIds.add(match.session.id);
    }
  }

  if (matchingSessionIds.size < 2) {
    return undefined;
  }

  const conclusion: MemoryConclusion = {
    id: `memory-project-fact-${currentFact.key}`,
    kind: "project-fact",
    content: currentFact.content,
    confidence: Math.min(0.95, 0.55 + (matchingSessionIds.size - 2) * 0.15),
    source: "repeated-user-input",
    occurrences: matchingSessionIds.size,
    sourceSessionIds: [...matchingSessionIds],
    sourceTrajectoryId: options.sourceTrajectoryId,
    sourceEventId: options.sourceEventId,
    createdAt: new Date().toISOString()
  };

  await options.memoryProvider.conclude(conclusion);
  return {
    kind: "conclusion",
    conclusion
  };
}

type PreferenceCandidate = {
  key: string;
  content: string;
};

function detectUserPreference(text: string): PreferenceCandidate | undefined {
  const normalized = normalize(text);
  if (normalized.length === 0) {
    return undefined;
  }

  const verbosity = detectVerbosityPreference(normalized);
  if (verbosity !== undefined) {
    return verbosity;
  }

  const patterns: Array<{
    regex: RegExp;
    render: (value: string) => string;
  }> = [
    {
      regex: /^(?:i\s+)?prefer\s+(.+)$/iu,
      render: (value) => `Prefer ${value}`
    },
    {
      regex: /^(?:please\s+)?use\s+(.+?)\s+by\s+default$/iu,
      render: (value) => `Use ${value} by default`
    },
    {
      regex: /^(?:please\s+)?default\s+to\s+(.+)$/iu,
      render: (value) => `Default to ${value}`
    },
    {
      regex: /^(?:please\s+)?always\s+use\s+(.+)$/iu,
      render: (value) => `Always use ${value}`
    },
    {
      regex: /^(?:we\s+)?want\s+(.+?)\s+by\s+default$/iu,
      render: (value) => `Want ${value} by default`
    }
  ];

  for (const pattern of patterns) {
    const match = normalized.match(pattern.regex);
    const captured = match?.[1]?.trim().replace(/[.?!]+$/u, "");

    if (captured === undefined || captured.length === 0) {
      continue;
    }

    const content = `${pattern.render(captured)}.`;
    return {
      key: content.toLowerCase(),
      content
    };
  }

  return undefined;
}

function detectProjectFact(text: string): PreferenceCandidate | undefined {
  const normalized = normalize(text);
  if (normalized.length === 0) {
    return undefined;
  }

  const patterns: Array<{
    regex: RegExp;
    render: (...groups: string[]) => string;
  }> = [
    {
      regex: /^project uses (.+)$/iu,
      render: (value) => `Project uses ${stripTrailingPunctuation(value)}.`
    },
    {
      regex: /^run checks with (.+)$/iu,
      render: (value) => `Run checks with ${ensureWrappedCommand(stripTrailingPunctuation(value))}.`
    },
    {
      regex: /^(.+?) is stored under [`'"]?(.+?)[`'"]?$/iu,
      render: (subject, path) => `${capitalize(stripTrailingPunctuation(subject))} is stored under ${ensureWrappedCommand(stripTrailingPunctuation(path))}.`
    },
    {
      regex: /^(.+?) is persisted in [`'"]?(.+?)[`'"]?$/iu,
      render: (subject, path) => `${capitalize(stripTrailingPunctuation(subject))} is persisted in ${ensureWrappedCommand(stripTrailingPunctuation(path))}.`
    },
    {
      regex: /^run tests with (.+)$/iu,
      render: (value) => `Run tests with ${ensureWrappedCommand(stripTrailingPunctuation(value))}.`
    }
  ];

  for (const pattern of patterns) {
    const match = normalized.match(pattern.regex);
    if (match === null) {
      continue;
    }

    const groups = match.slice(1).map((group) => stripTrailingPunctuation(group.trim()));
    if (groups.some((group) => group.length === 0)) {
      continue;
    }

    const content = pattern.render(...groups);
    return {
      key: content.toLowerCase(),
      content
    };
  }

  return undefined;
}

function detectVerbosityPreference(normalized: string): PreferenceCandidate | undefined {
  const concisePatterns = [
    /^(?:i\s+)?prefer\s+concise(?:\s+telegram)?\s+repl(?:y|ies)$/iu,
    /^please\s+keep\s+repl(?:y|ies)\s+concise$/iu,
    /^(?:please\s+)?use\s+concise\s+repl(?:y|ies)$/iu,
    /^(?:please\s+)?give\s+me\s+concise\s+repl(?:y|ies)$/iu
  ];
  const detailedPatterns = [
    /^(?:i\s+)?prefer\s+detailed(?:\s+telegram)?\s+repl(?:y|ies)$/iu,
    /^(?:actually\s+)?give\s+me\s+detailed\s+repl(?:y|ies)$/iu,
    /^please\s+keep\s+repl(?:y|ies)\s+detailed$/iu,
    /^(?:please\s+)?use\s+detailed\s+repl(?:y|ies)$/iu
  ];

  if (concisePatterns.some((pattern) => pattern.test(normalized))) {
    return {
      key: "prefer concise replies.",
      content: "Prefer concise replies."
    };
  }

  if (detailedPatterns.some((pattern) => pattern.test(normalized))) {
    return {
      key: "prefer detailed replies.",
      content: "Prefer detailed replies."
    };
  }

  return undefined;
}

function detectForgetPreference(text: string): string | undefined {
  const normalized = normalize(text);
  const match = normalized.match(/^(?:please\s+)?forget\s+that\s+i\s+prefer\s+(.+)$/iu);
  const captured = match?.[1]?.trim().replace(/[.?!]+$/u, "");
  if (captured === undefined || captured.length === 0) {
    return undefined;
  }

  if (captured.includes("concise")) {
    return "Prefer concise replies.";
  }
  if (captured.includes("detailed")) {
    return "Prefer detailed replies.";
  }

  return `Prefer ${captured}.`;
}

function normalize(value: string): string {
  return value.trim().replace(/\s+/gu, " ");
}

function sanitizeMemoryLearningText(value: string): string {
  return stripInlineReasoning(value);
}

function stripTrailingPunctuation(value: string): string {
  return value.replace(/[.?!]+$/u, "").trim();
}

function ensureWrappedCommand(value: string): string {
  if (value.startsWith("`") && value.endsWith("`")) {
    return value;
  }

  return `\`${value}\``;
}

function capitalize(value: string): string {
  if (value.length === 0) {
    return value;
  }

  return `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}`;
}

export function __detectUserPreferenceForTest(text: string): string | undefined {
  return detectUserPreference(text)?.content;
}

export function __detectForgetPreferenceForTest(text: string): string | undefined {
  return detectForgetPreference(text);
}

export function __detectProjectFactForTest(text: string): string | undefined {
  return detectProjectFact(text)?.content;
}
