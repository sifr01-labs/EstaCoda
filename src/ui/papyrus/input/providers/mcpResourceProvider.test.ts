import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { createSuggestionTokenContext } from "../suggestionTypes.js";
import {
  createMcpResourceSuggestionProvider,
  MCP_RESOURCE_SUGGESTION_PROVIDER_ID,
  type McpResourceSuggestionSource,
} from "./mcpResourceProvider.js";

describe("Papyrus MCP resource suggestion provider", () => {
  it("is disabled by default and does not read or authorize the injected source", async () => {
    const source = fakeSource([{ label: "Project notes" }]);
    const isAuthorized = vi.fn(() => true);
    const provider = createMcpResourceSuggestionProvider({ source, isAuthorized });

    const result = await provider.getSuggestions(mcpContext("project"));

    expect(result.type).toBe("empty");
    expect(result.suggestions).toEqual([]);
    expect(isAuthorized).not.toHaveBeenCalled();
    expect(source.listResources).not.toHaveBeenCalled();
  });

  it("requires explicit authorization before reading the injected source", async () => {
    const source = fakeSource([{ label: "Project notes" }]);
    const provider = createMcpResourceSuggestionProvider({
      source,
      enabled: true,
      isAuthorized: vi.fn(() => false),
    });

    const result = await provider.getSuggestions(mcpContext("project"));

    expect(result.type).toBe("empty");
    expect(source.listResources).not.toHaveBeenCalled();
  });

  it("uses the injected source when enabled and authorized", async () => {
    const source = fakeSource([
      {
        label: "Project notes",
        uri: "mcp://docs/project",
        description: "Planning notes",
        detail: "docs",
        metadata: { serverId: "docs" },
      },
      { label: "Scratch" },
    ]);
    const provider = createMcpResourceSuggestionProvider({
      source,
      enabled: true,
      isAuthorized: () => true,
    });

    const result = await provider.getSuggestions(mcpContext("project"));

    expect(source.listResources).toHaveBeenCalledWith({ limit: 200, signal: undefined });
    expect(result.type).toBe("success");
    expect(result.suggestions[0]).toMatchObject({
      id: `${MCP_RESOURCE_SUGGESTION_PROVIDER_ID}:0`,
      label: "Project notes",
      detail: "docs",
      description: "Planning notes",
      replacementText: "Project notes",
      replacementRange: { start: 0, end: 7 },
      providerId: MCP_RESOURCE_SUGGESTION_PROVIDER_ID,
      kind: "mcp",
      metadata: {
        label: "Project notes",
        uri: "mcp://docs/project",
        description: "Planning notes",
        detail: "docs",
        resourceIndex: 0,
        matchKind: "prefix",
        sourceMetadata: { serverId: "docs" },
      },
    });
  });

  it("supports async authorization and async resource sources", async () => {
    const source = {
      listResources: vi.fn(async () => [{ label: "Async resource" }]),
    };
    const provider = createMcpResourceSuggestionProvider({
      source,
      enabled: true,
      isAuthorized: async () => true,
    });

    const result = await provider.getSuggestions(mcpContext("async"));

    expect(result.suggestions.map((suggestion) => suggestion.label)).toEqual(["Async resource"]);
  });

  it("enforces max resources scanned before ranking", async () => {
    const source = fakeSource([
      { label: "alpha" },
      { label: "beta" },
      { label: "gamma" },
    ]);
    const provider = createMcpResourceSuggestionProvider({
      source,
      enabled: true,
      isAuthorized: () => true,
      maxResourcesToScan: 2,
      maxSuggestions: 10,
    });

    const result = await provider.getSuggestions(mcpContext(""));

    expect(source.listResources).toHaveBeenCalledWith({ limit: 2, signal: undefined });
    expect(result.suggestions.map((suggestion) => suggestion.label)).toEqual(["alpha", "beta"]);
  });

  it("enforces max suggestions returned", async () => {
    const provider = createMcpResourceSuggestionProvider({
      source: fakeSource([
        { label: "alpha" },
        { label: "beta" },
        { label: "gamma" },
      ]),
      enabled: true,
      isAuthorized: () => true,
      maxSuggestions: 2,
    });

    const result = await provider.getSuggestions(mcpContext(""));

    expect(result.suggestions.map((suggestion) => suggestion.label)).toEqual(["alpha", "beta"]);
  });

  it("drops empty and duplicate resource labels", async () => {
    const provider = createMcpResourceSuggestionProvider({
      source: fakeSource([
        { label: "" },
        { label: "Project notes" },
        { label: " project notes " },
        { label: "Runbook" },
      ]),
      enabled: true,
      isAuthorized: () => true,
    });

    const result = await provider.getSuggestions(mcpContext(""));

    expect(result.suggestions.map((suggestion) => suggestion.label)).toEqual([
      "Project notes",
      "Runbook",
    ]);
  });

  it("ranks matches deterministically and preserves source order for ties", async () => {
    const provider = createMcpResourceSuggestionProvider({
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

    const result = await provider.getSuggestions(mcpContext("alpha"));

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

  it("matches case-insensitively across label, URI, description, and detail", async () => {
    const provider = createMcpResourceSuggestionProvider({
      source: fakeSource([
        { label: "One", uri: "mcp://docs/ARCHITECTURE" },
        { label: "Two", description: "Release Notes" },
        { label: "Three", detail: "Skill Cache" },
      ]),
      enabled: true,
      isAuthorized: () => true,
    });

    expect((await provider.getSuggestions(mcpContext("architecture"))).suggestions[0]?.label).toBe("One");
    expect((await provider.getSuggestions(mcpContext("release"))).suggestions[0]?.label).toBe("Two");
    expect((await provider.getSuggestions(mcpContext("skill"))).suggestions[0]?.label).toBe("Three");
  });

  it("represents authorization and source errors as provider error data", async () => {
    const authorizationError = createMcpResourceSuggestionProvider({
      source: fakeSource([{ label: "Project notes" }]),
      enabled: true,
      isAuthorized: () => {
        throw new Error("MCP authorization unavailable");
      },
    });
    expect(await authorizationError.getSuggestions(mcpContext("project"))).toMatchObject({
      type: "error",
      error: {
        message: "MCP authorization unavailable",
        recoverable: true,
      },
    });

    const sourceError = createMcpResourceSuggestionProvider({
      source: {
        listResources: vi.fn(() => {
          throw new Error("MCP resource list unavailable");
        }),
      },
      enabled: true,
      isAuthorized: () => true,
    });
    expect(await sourceError.getSuggestions(mcpContext("project"))).toMatchObject({
      type: "error",
      error: {
        message: "MCP resource list unavailable",
        recoverable: true,
      },
    });
  });

  it("returns canceled data when the signal is already aborted", async () => {
    const source = fakeSource([{ label: "Project notes" }]);
    const provider = createMcpResourceSuggestionProvider({
      source,
      enabled: true,
      isAuthorized: vi.fn(() => true),
    });
    const controller = new AbortController();
    controller.abort();

    const result = await provider.getSuggestions(mcpContext("project"), controller.signal);

    expect(result.type).toBe("canceled");
    expect(result.suggestions).toEqual([]);
    expect(source.listResources).not.toHaveBeenCalled();
  });

  it("does not use process, filesystem, shell execution, or live MCP clients", () => {
    const source = readFileSync(fileURLToPath(new URL("./mcpResourceProvider.ts", import.meta.url)), "utf8");

    expect(source).not.toMatch(/\bprocess\b|\bnode:fs\b|\bfs\b|\bchild_process\b/u);
    expect(source).not.toMatch(/\bspawn\s*\(|\bexec\s*\(|\bexecFile\s*\(/u);
    expect(source).not.toMatch(/\btelemetry\b|\banalytics\b/u);
    expect(source).not.toMatch(/\bsrc\/(cli|security|runtime|providers|mcp|session)\//u);
  });
});

function mcpContext(token: string) {
  return createSuggestionTokenContext({
    input: token,
    cursorOffset: token.length,
    tokenRange: { start: 0, end: token.length },
    triggerKind: "custom",
  });
}

function fakeSource(
  resources: readonly { readonly label: string; readonly uri?: string; readonly description?: string; readonly detail?: string; readonly metadata?: Readonly<Record<string, unknown>> }[]
): McpResourceSuggestionSource & { readonly listResources: ReturnType<typeof vi.fn> } {
  return {
    listResources: vi.fn((options: { readonly limit: number }) => resources.slice(0, options.limit)),
  };
}
