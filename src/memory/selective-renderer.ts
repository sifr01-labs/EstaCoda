import type { MemoryFileKind, MemoryUsage } from "../contracts/memory.js";
import type { MemorySnapshot } from "./memory-store.js";
import type { MemoryPromotionRecord } from "../contracts/memory.js";

export type SelectiveRenderOptions = {
  query?: string;
  fallbackCount?: number;
};

export type SelectiveRenderResult = {
  text: string;
  usage: MemoryUsage[];
  omittedCount: number;
  renderMode: "selective" | "full";
};

const SAFETY_FILES: readonly MemoryFileKind[] = ["SHARED.md", "SOUL.md", "AGENTS.md"];
const SELECTIVE_FILES: readonly MemoryFileKind[] = ["USER.md", "MEMORY.md"];
const DEFAULT_FALLBACK_COUNT = 3;

type ParsedEntry = {
  line: string;
  content: string;
  index: number; // line index in file
};

export function renderSelective(
  snapshot: MemorySnapshot,
  promotionRecords: MemoryPromotionRecord[],
  options: SelectiveRenderOptions = {}
): SelectiveRenderResult {
  const inactiveSet = buildInactiveContentSet(promotionRecords);
  const usages: MemoryUsage[] = [];
  const parts: string[] = [];
  let totalEntries = 0;
  let includedEntries = 0;

  for (const kind of ["SHARED.md", "USER.md", "SOUL.md", "MEMORY.md", "AGENTS.md"] as const) {
    const content = snapshot.files.get(kind) ?? "";
    const budget = snapshot.budgets.find((b) => b.kind === kind);

    if (SAFETY_FILES.includes(kind)) {
      // Always render safety files in full
      if (content.trim().length > 0) {
        parts.push(`--- ${kind} ---\n${content.trim()}`);
      }
      usages.push({
        kind,
        chars: content.length,
        maxChars: budget?.maxChars,
        percent: budget === undefined ? undefined : Math.round((content.length / budget.maxChars) * 100)
      });
      continue;
    }

    if (!SELECTIVE_FILES.includes(kind)) {
      continue;
    }

    const entries = parseEntries(content, kind);
    totalEntries += entries.length;

    // Filter out inactive entries
    const activeEntries = entries.filter((entry) => !inactiveSet.has(normalizeContentKey(entry.content)));

    let selected: ParsedEntry[];
    let renderMode: "selective" | "full" = "full";

    if (options.query !== undefined && options.query.trim().length > 0) {
      renderMode = "selective";
      const query = options.query.trim().toLowerCase();
      const ranked = activeEntries.map((entry) => ({
        entry,
        score: relevanceScore(entry.content, query)
      }));

      const matches = ranked.filter((r) => r.score > 0).sort((a, b) => b.score - a.score);

      if (matches.length > 0) {
        selected = matches.map((m) => m.entry);
      } else {
        // No matches: fallback to N most recent entries (last N in file order)
        const fallbackCount = options.fallbackCount ?? DEFAULT_FALLBACK_COUNT;
        selected = activeEntries.slice(-fallbackCount);
      }
    } else {
      // No query: return all active entries (backward compatible)
      selected = activeEntries;
    }

    includedEntries += selected.length;

    if (selected.length > 0 || content.trim().length === 0) {
      const header = `--- ${kind} ---`;
      const body = selected.map((entry) => entry.line).join("\n");
      const nonEntryLines = extractNonEntryLines(content);
      const fullBody = nonEntryLines.length > 0 ? `${nonEntryLines.join("\n")}\n${body}` : body;
      parts.push(`${header}\n${fullBody}`);
    }

    const renderedChars = selected.reduce((sum, entry) => sum + entry.line.length, 0);
    usages.push({
      kind,
      chars: renderedChars,
      maxChars: budget?.maxChars,
      percent: budget === undefined ? undefined : Math.round((renderedChars / budget.maxChars) * 100)
    });
  }

  return {
    text: parts.join("\n\n"),
    usage: usages,
    omittedCount: totalEntries - includedEntries,
    renderMode: options.query !== undefined && options.query.trim().length > 0 ? "selective" : "full"
  };
}

function parseEntries(content: string, _kind: MemoryFileKind): ParsedEntry[] {
  const entries: ParsedEntry[] = [];
  const lines = content.split("\n");

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const trimmed = line.trim();
    if (trimmed.startsWith("- ")) {
      entries.push({
        line,
        content: trimmed.slice(2).trim(),
        index
      });
    }
  }

  return entries;
}

function extractNonEntryLines(content: string): string[] {
  return content
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      return trimmed.length > 0 && !trimmed.startsWith("- ");
    });
}

function buildInactiveContentSet(records: MemoryPromotionRecord[]): Set<string> {
  const set = new Set<string>();
  for (const record of records) {
    if (!record.active) {
      set.add(normalizeContentKey(record.content));
    }
  }
  return set;
}

function normalizeContentKey(content: string): string {
  return content.trim().toLowerCase();
}

function relevanceScore(content: string, query: string): number {
  const normalizedContent = content.toLowerCase();

  if (normalizedContent.includes(query)) {
    return 1.0;
  }

  const queryWords = query.split(/\s+/).filter((word) => word.length > 0);
  if (queryWords.length === 0) {
    return 0.0;
  }

  const matchCount = queryWords.filter((word) => normalizedContent.includes(word)).length;
  if (matchCount === queryWords.length) {
    return 0.75;
  }
  if (matchCount > 0) {
    return 0.5;
  }

  return 0.0;
}
