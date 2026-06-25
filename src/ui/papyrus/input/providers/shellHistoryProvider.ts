import {
  normalizeSuggestionProviderResult,
  type SuggestionItem,
  type SuggestionProvider,
  type SuggestionProviderError,
  type SuggestionTokenContext,
} from "../suggestionTypes.js";

export const SHELL_HISTORY_SUGGESTION_PROVIDER_ID = "shell-history";
export const DEFAULT_SHELL_HISTORY_MAX_ENTRIES = 200;
export const DEFAULT_SHELL_HISTORY_MAX_SUGGESTIONS = 20;

export type ShellHistorySourceReadOptions = {
  readonly limit: number;
  readonly signal?: AbortSignal;
};

export type ShellHistorySource = {
  readonly read: (
    options: ShellHistorySourceReadOptions
  ) => readonly string[] | Promise<readonly string[]>;
};

export type ShellHistorySuggestionMetadata = {
  readonly entry: string;
  readonly entryIndex: number;
  readonly matchKind: ShellHistoryMatchKind;
};

export type ShellHistorySuggestionProviderOptions = {
  readonly source: ShellHistorySource;
  readonly enabled?: boolean;
  readonly maxEntriesToScan?: number;
  readonly maxSuggestions?: number;
  readonly filterEntry?: (entry: string) => boolean;
};

type ShellHistoryMatchKind = "exact" | "prefix" | "contains" | "subsequence";

type RankedHistoryEntry = {
  readonly entry: string;
  readonly entryIndex: number;
  readonly score: number;
  readonly matchKind: ShellHistoryMatchKind;
};

export function createShellHistorySuggestionProvider(
  options: ShellHistorySuggestionProviderOptions
): SuggestionProvider<ShellHistorySuggestionMetadata> {
  const maxEntriesToScan = positiveIntegerOrDefault(
    options.maxEntriesToScan,
    DEFAULT_SHELL_HISTORY_MAX_ENTRIES
  );
  const maxSuggestions = positiveIntegerOrDefault(
    options.maxSuggestions,
    DEFAULT_SHELL_HISTORY_MAX_SUGGESTIONS
  );

  return {
    id: SHELL_HISTORY_SUGGESTION_PROVIDER_ID,
    name: "Shell history",
    capabilityTags: ["history", "shell"],
    getSuggestions: async (context, signal) => {
      if (isSignalAborted(signal)) {
        return normalizeSuggestionProviderResult(SHELL_HISTORY_SUGGESTION_PROVIDER_ID, { canceled: true });
      }
      if (options.enabled !== true) {
        return normalizeSuggestionProviderResult(SHELL_HISTORY_SUGGESTION_PROVIDER_ID);
      }

      try {
        const entries = await options.source.read({ limit: maxEntriesToScan, signal });
        if (isSignalAborted(signal)) {
          return normalizeSuggestionProviderResult(SHELL_HISTORY_SUGGESTION_PROVIDER_ID, { canceled: true });
        }

        const suggestions = rankHistoryEntries({
          entries: entries.slice(0, maxEntriesToScan),
          context,
          filterEntry: options.filterEntry,
        })
          .slice(0, maxSuggestions)
          .map((entry) => toShellHistorySuggestion(entry, context));

        return normalizeSuggestionProviderResult(SHELL_HISTORY_SUGGESTION_PROVIDER_ID, { suggestions });
      } catch (error) {
        return normalizeSuggestionProviderResult(SHELL_HISTORY_SUGGESTION_PROVIDER_ID, {
          error: providerError(error),
        });
      }
    },
  };
}

function rankHistoryEntries(input: {
  readonly entries: readonly string[];
  readonly context: SuggestionTokenContext;
  readonly filterEntry?: (entry: string) => boolean;
}): readonly RankedHistoryEntry[] {
  const seen = new Set<string>();
  const query = normalizeSearchText(input.context.token);
  const ranked: RankedHistoryEntry[] = [];

  for (const [entryIndex, rawEntry] of input.entries.entries()) {
    const entry = rawEntry.trim();
    if (entry.length === 0 || seen.has(entry)) continue;
    seen.add(entry);
    if (isSensitiveLookingHistoryEntry(entry)) continue;
    if (input.filterEntry?.(entry) === false) continue;
    const match = scoreHistoryEntry(entry, query);
    if (match === undefined) continue;
    ranked.push({
      entry,
      entryIndex,
      score: match.score,
      matchKind: match.kind,
    });
  }

  return ranked.sort((left, right) => left.score - right.score || left.entryIndex - right.entryIndex);
}

function toShellHistorySuggestion(
  entry: RankedHistoryEntry,
  context: SuggestionTokenContext
): SuggestionItem<ShellHistorySuggestionMetadata> {
  return {
    id: `${SHELL_HISTORY_SUGGESTION_PROVIDER_ID}:${entry.entryIndex}`,
    label: entry.entry,
    replacementText: entry.entry,
    replacementRange: context.tokenRange,
    providerId: SHELL_HISTORY_SUGGESTION_PROVIDER_ID,
    kind: "history",
    rank: {
      score: entry.score,
    },
    metadata: {
      entry: entry.entry,
      entryIndex: entry.entryIndex,
      matchKind: entry.matchKind,
    },
  };
}

function scoreHistoryEntry(entry: string, query: string): {
  readonly kind: ShellHistoryMatchKind;
  readonly score: number;
} | undefined {
  if (query.length === 0) return { kind: "prefix", score: 1 };

  const text = normalizeSearchText(entry);
  if (text === query) return { kind: "exact", score: 0 };
  if (text.startsWith(query)) return { kind: "prefix", score: 1 };
  if (text.includes(query)) return { kind: "contains", score: 2 };
  if (isSubsequence(text, query)) return { kind: "subsequence", score: 3 };
  return undefined;
}

function normalizeSearchText(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function isSubsequence(text: string, query: string): boolean {
  let queryIndex = 0;
  for (const char of text) {
    if (char === query[queryIndex]) queryIndex += 1;
    if (queryIndex === query.length) return true;
  }
  return false;
}

function isSensitiveLookingHistoryEntry(entry: string): boolean {
  return /\b(password|passwd|token|api[_-]?key|secret)\s*=/iu.test(entry)
    || /\b[A-Z0-9_]*SECRET[A-Z0-9_]*=/u.test(entry);
}

function providerError(error: unknown): SuggestionProviderError {
  if (error instanceof Error) return { message: error.message, recoverable: true };
  return { message: String(error), recoverable: true };
}

function positiveIntegerOrDefault(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.floor(value));
}

function isSignalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}
