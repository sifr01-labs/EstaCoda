import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { createSuggestionTokenContext } from "../suggestionTypes.js";
import {
  createShellHistorySuggestionProvider,
  SHELL_HISTORY_SUGGESTION_PROVIDER_ID,
  type ShellHistorySource,
} from "./shellHistoryProvider.js";

describe("Papyrus shell history suggestion provider", () => {
  it("is disabled by default and does not read the injected source", async () => {
    const source = fakeSource(["git status"]);
    const provider = createShellHistorySuggestionProvider({ source });

    const result = await provider.getSuggestions(historyContext("git"));

    expect(result.type).toBe("empty");
    expect(result.suggestions).toEqual([]);
    expect(source.read).not.toHaveBeenCalled();
  });

  it("uses the injected source when explicitly enabled", async () => {
    const source = fakeSource(["git status", "pnpm test"]);
    const provider = createShellHistorySuggestionProvider({ source, enabled: true });

    const result = await provider.getSuggestions(historyContext("git"));

    expect(source.read).toHaveBeenCalledWith({ limit: 200, signal: undefined });
    expect(result.type).toBe("success");
    expect(result.suggestions.map((suggestion) => suggestion.label)).toEqual(["git status"]);
    expect(result.suggestions[0]).toMatchObject({
      providerId: SHELL_HISTORY_SUGGESTION_PROVIDER_ID,
      kind: "history",
      replacementText: "git status",
      replacementRange: { start: 0, end: 3 },
      metadata: {
        entry: "git status",
        entryIndex: 0,
        matchKind: "prefix",
      },
    });
  });

  it("enforces max entries scanned before ranking", async () => {
    const source = fakeSource(["alpha", "beta", "gamma"]);
    const provider = createShellHistorySuggestionProvider({
      source,
      enabled: true,
      maxEntriesToScan: 2,
      maxSuggestions: 10,
    });

    const result = await provider.getSuggestions(historyContext(""));

    expect(source.read).toHaveBeenCalledWith({ limit: 2, signal: undefined });
    expect(result.suggestions.map((suggestion) => suggestion.label)).toEqual(["alpha", "beta"]);
  });

  it("enforces max suggestions returned", async () => {
    const provider = createShellHistorySuggestionProvider({
      source: fakeSource(["alpha", "beta", "gamma"]),
      enabled: true,
      maxSuggestions: 2,
    });

    const result = await provider.getSuggestions(historyContext(""));

    expect(result.suggestions.map((suggestion) => suggestion.label)).toEqual(["alpha", "beta"]);
  });

  it("drops empty, duplicate, and sensitive-looking entries", async () => {
    const provider = createShellHistorySuggestionProvider({
      source: fakeSource([
        "",
        "git status",
        "git status",
        "deploy token=secret",
        "curl API_KEY=secret",
        "echo SECRET=value",
        "pnpm test",
      ]),
      enabled: true,
    });

    const result = await provider.getSuggestions(historyContext(""));

    expect(result.suggestions.map((suggestion) => suggestion.label)).toEqual([
      "git status",
      "pnpm test",
    ]);
  });

  it("supports an optional injected redaction filter", async () => {
    const provider = createShellHistorySuggestionProvider({
      source: fakeSource(["git status", "open private"]),
      enabled: true,
      filterEntry: (entry) => !entry.includes("private"),
    });

    const result = await provider.getSuggestions(historyContext(""));

    expect(result.suggestions.map((suggestion) => suggestion.label)).toEqual(["git status"]);
  });

  it("ranks matches deterministically and preserves source order for ties", async () => {
    const provider = createShellHistorySuggestionProvider({
      source: fakeSource([
        "x alpha",
        "a-l-p-h-a",
        "alphabet soup",
        "alpha",
        "alpha beta",
        "alpha gamma",
      ]),
      enabled: true,
    });

    const result = await provider.getSuggestions(historyContext("alpha"));

    expect(result.suggestions.map((suggestion) => [
      suggestion.label,
      suggestion.metadata?.matchKind,
    ])).toEqual([
      ["alpha", "exact"],
      ["alphabet soup", "prefix"],
      ["alpha beta", "prefix"],
      ["alpha gamma", "prefix"],
      ["x alpha", "contains"],
      ["a-l-p-h-a", "subsequence"],
    ]);
  });

  it("represents source errors as provider error data", async () => {
    const provider = createShellHistorySuggestionProvider({
      source: {
        read: vi.fn(() => {
          throw new Error("history unavailable");
        }),
      },
      enabled: true,
    });

    const result = await provider.getSuggestions(historyContext("git"));

    expect(result).toMatchObject({
      type: "error",
      error: {
        message: "history unavailable",
        recoverable: true,
      },
    });
  });

  it("returns canceled data when the signal is already aborted", async () => {
    const source = fakeSource(["git status"]);
    const provider = createShellHistorySuggestionProvider({ source, enabled: true });
    const controller = new AbortController();
    controller.abort();

    const result = await provider.getSuggestions(historyContext("git"), controller.signal);

    expect(result.type).toBe("canceled");
    expect(result.suggestions).toEqual([]);
    expect(source.read).not.toHaveBeenCalled();
  });

  it("does not use process, filesystem, shell execution, or telemetry helpers", () => {
    const source = readFileSync(fileURLToPath(new URL("./shellHistoryProvider.ts", import.meta.url)), "utf8");

    expect(source).not.toMatch(/\bprocess\b|\bnode:fs\b|\bfs\b|\bchild_process\b/u);
    expect(source).not.toMatch(/\bspawn\s*\(|\bexec\s*\(|\bexecFile\s*\(/u);
    expect(source).not.toMatch(/\btelemetry\b|\banalytics\b|\bclipboard\b/u);
  });
});

function historyContext(token: string) {
  return createSuggestionTokenContext({
    input: token,
    cursorOffset: token.length,
    tokenRange: { start: 0, end: token.length },
    triggerKind: "history",
  });
}

function fakeSource(entries: readonly string[]): ShellHistorySource & { readonly read: ReturnType<typeof vi.fn> } {
  return {
    read: vi.fn((options: { readonly limit: number }) => entries.slice(0, options.limit)),
  };
}
