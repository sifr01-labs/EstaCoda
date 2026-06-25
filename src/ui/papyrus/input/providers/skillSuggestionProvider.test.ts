import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { createSuggestionTokenContext } from "../suggestionTypes.js";
import {
  createSkillSuggestionProvider,
  SKILL_SUGGESTION_PROVIDER_ID,
  type SkillSuggestionSource,
} from "./skillSuggestionProvider.js";

describe("Papyrus skill suggestion provider", () => {
  it("is disabled by default and does not read or authorize the injected source", async () => {
    const source = fakeSource([{ label: "Code review" }]);
    const isAuthorized = vi.fn(() => true);
    const provider = createSkillSuggestionProvider({ source, isAuthorized });

    const result = await provider.getSuggestions(skillContext("code"));

    expect(result.type).toBe("empty");
    expect(result.suggestions).toEqual([]);
    expect(isAuthorized).not.toHaveBeenCalled();
    expect(source.listSkills).not.toHaveBeenCalled();
  });

  it("requires explicit authorization before reading the injected source", async () => {
    const source = fakeSource([{ label: "Code review" }]);
    const provider = createSkillSuggestionProvider({
      source,
      enabled: true,
      isAuthorized: vi.fn(() => false),
    });

    const result = await provider.getSuggestions(skillContext("code"));

    expect(result.type).toBe("empty");
    expect(source.listSkills).not.toHaveBeenCalled();
  });

  it("uses the injected source when enabled and authorized", async () => {
    const source = fakeSource([
      {
        label: "Code review",
        id: "code-review",
        description: "Review a patch",
        detail: "quality",
        keywords: ["diff", "risk"],
        metadata: { bundled: true },
      },
      { label: "Image generation" },
    ]);
    const provider = createSkillSuggestionProvider({
      source,
      enabled: true,
      isAuthorized: () => true,
    });

    const result = await provider.getSuggestions(skillContext("code"));

    expect(source.listSkills).toHaveBeenCalledWith({ limit: 200, signal: undefined });
    expect(result.type).toBe("success");
    expect(result.suggestions[0]).toMatchObject({
      id: `${SKILL_SUGGESTION_PROVIDER_ID}:code-review`,
      label: "Code review",
      detail: "quality",
      description: "Review a patch",
      replacementText: "Code review",
      replacementRange: { start: 0, end: 4 },
      providerId: SKILL_SUGGESTION_PROVIDER_ID,
      kind: "skill",
      metadata: {
        label: "Code review",
        id: "code-review",
        description: "Review a patch",
        detail: "quality",
        keywords: ["diff", "risk"],
        skillIndex: 0,
        matchKind: "prefix",
        sourceMetadata: { bundled: true },
      },
    });
  });

  it("supports async authorization and async skill sources", async () => {
    const source = {
      listSkills: vi.fn(async () => [{ label: "Async skill" }]),
    };
    const provider = createSkillSuggestionProvider({
      source,
      enabled: true,
      isAuthorized: async () => true,
    });

    const result = await provider.getSuggestions(skillContext("async"));

    expect(result.suggestions.map((suggestion) => suggestion.label)).toEqual(["Async skill"]);
  });

  it("enforces max skills scanned before ranking", async () => {
    const source = fakeSource([
      { label: "alpha" },
      { label: "beta" },
      { label: "gamma" },
    ]);
    const provider = createSkillSuggestionProvider({
      source,
      enabled: true,
      isAuthorized: () => true,
      maxSkillsToScan: 2,
      maxSuggestions: 10,
    });

    const result = await provider.getSuggestions(skillContext(""));

    expect(source.listSkills).toHaveBeenCalledWith({ limit: 2, signal: undefined });
    expect(result.suggestions.map((suggestion) => suggestion.label)).toEqual(["alpha", "beta"]);
  });

  it("enforces max suggestions returned", async () => {
    const provider = createSkillSuggestionProvider({
      source: fakeSource([
        { label: "alpha" },
        { label: "beta" },
        { label: "gamma" },
      ]),
      enabled: true,
      isAuthorized: () => true,
      maxSuggestions: 2,
    });

    const result = await provider.getSuggestions(skillContext(""));

    expect(result.suggestions.map((suggestion) => suggestion.label)).toEqual(["alpha", "beta"]);
  });

  it("drops empty and duplicate skill labels", async () => {
    const provider = createSkillSuggestionProvider({
      source: fakeSource([
        { label: "" },
        { label: "Code review" },
        { label: " code review " },
        { label: "Docs" },
      ]),
      enabled: true,
      isAuthorized: () => true,
    });

    const result = await provider.getSuggestions(skillContext(""));

    expect(result.suggestions.map((suggestion) => suggestion.label)).toEqual([
      "Code review",
      "Docs",
    ]);
  });

  it("ranks matches deterministically and preserves source order for ties", async () => {
    const provider = createSkillSuggestionProvider({
      source: fakeSource([
        { label: "x alpha" },
        { label: "a-l-p-h-a" },
        { label: "alphabet soup" },
        { label: "alpha" },
        { label: "alpha beta" },
        { label: "alpha gamma" },
      ]),
      enabled: true,
      isAuthorized: () => true,
    });

    const result = await provider.getSuggestions(skillContext("alpha"));

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

  it("matches case-insensitively across label, id, description, detail, and keywords", async () => {
    const provider = createSkillSuggestionProvider({
      source: fakeSource([
        { label: "One", id: "ARCHITECTURE" },
        { label: "Two", description: "Release Notes" },
        { label: "Three", detail: "Skill Cache" },
        { label: "Four", keywords: ["Review"] },
      ]),
      enabled: true,
      isAuthorized: () => true,
    });

    expect((await provider.getSuggestions(skillContext("architecture"))).suggestions[0]?.label).toBe("One");
    expect((await provider.getSuggestions(skillContext("release"))).suggestions[0]?.label).toBe("Two");
    expect((await provider.getSuggestions(skillContext("skill"))).suggestions[0]?.label).toBe("Three");
    expect((await provider.getSuggestions(skillContext("review"))).suggestions[0]?.label).toBe("Four");
  });

  it("represents authorization and source errors as provider error data", async () => {
    const authorizationError = createSkillSuggestionProvider({
      source: fakeSource([{ label: "Code review" }]),
      enabled: true,
      isAuthorized: () => {
        throw new Error("skill authorization unavailable");
      },
    });
    expect(await authorizationError.getSuggestions(skillContext("code"))).toMatchObject({
      type: "error",
      error: {
        message: "skill authorization unavailable",
        recoverable: true,
      },
    });

    const sourceError = createSkillSuggestionProvider({
      source: {
        listSkills: vi.fn(() => {
          throw new Error("skill list unavailable");
        }),
      },
      enabled: true,
      isAuthorized: () => true,
    });
    expect(await sourceError.getSuggestions(skillContext("code"))).toMatchObject({
      type: "error",
      error: {
        message: "skill list unavailable",
        recoverable: true,
      },
    });
  });

  it("returns canceled data when the signal is already aborted", async () => {
    const source = fakeSource([{ label: "Code review" }]);
    const provider = createSkillSuggestionProvider({
      source,
      enabled: true,
      isAuthorized: vi.fn(() => true),
    });
    const controller = new AbortController();
    controller.abort();

    const result = await provider.getSuggestions(skillContext("code"), controller.signal);

    expect(result.type).toBe("canceled");
    expect(result.suggestions).toEqual([]);
    expect(source.listSkills).not.toHaveBeenCalled();
  });

  it("does not use process, filesystem, shell execution, live skill loaders, or provider calls", () => {
    const source = readFileSync(fileURLToPath(new URL("./skillSuggestionProvider.ts", import.meta.url)), "utf8");

    expect(source).not.toMatch(/\bprocess\b|\bnode:fs\b|\bfs\b|\bchild_process\b/u);
    expect(source).not.toMatch(/\bspawn\s*\(|\bexec\s*\(|\bexecFile\s*\(/u);
    expect(source).not.toMatch(/\btelemetry\b|\banalytics\b/u);
    expect(source).not.toMatch(/\bsrc\/(cli|security|runtime|providers|skills|session)\//u);
  });
});

function skillContext(token: string) {
  return createSuggestionTokenContext({
    input: token,
    cursorOffset: token.length,
    tokenRange: { start: 0, end: token.length },
    triggerKind: "custom",
  });
}

function fakeSource(
  skills: readonly {
    readonly label: string;
    readonly id?: string;
    readonly description?: string;
    readonly detail?: string;
    readonly keywords?: readonly string[];
    readonly metadata?: Readonly<Record<string, unknown>>;
  }[]
): SkillSuggestionSource & { readonly listSkills: ReturnType<typeof vi.fn> } {
  return {
    listSkills: vi.fn((options: { readonly limit: number }) => skills.slice(0, options.limit)),
  };
}
