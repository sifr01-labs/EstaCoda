import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  applySuggestionReplacement,
  createSuggestionTokenContext,
  normalizeSuggestionProviderResult,
  type SuggestionItem,
  type SuggestionProvider,
} from "./suggestionTypes.js";
import {
  applyTypeaheadResult,
  createTypeaheadControllerState,
  dismissTypeahead,
  focusedSuggestion,
  focusNextSuggestion,
  focusPreviousSuggestion,
  openTypeahead,
  requestTypeaheadSuggestions,
  selectFocusedSuggestion,
} from "./typeaheadController.js";
import { createMcpResourceSuggestionProvider } from "./providers/mcpResourceProvider.js";
import { createSkillSuggestionProvider } from "./providers/skillSuggestionProvider.js";

const context = createSuggestionTokenContext({
  input: "run /he now",
  cursorOffset: 7,
  tokenRange: { start: 4, end: 7 },
  triggerKind: "slash",
});
const optionalProviderContext = createSuggestionTokenContext({
  input: "",
  cursorOffset: 0,
  tokenRange: { start: 0, end: 0 },
  triggerKind: "custom",
});

const helpItem = item("help", "/help");
const helloItem = item("hello", "/hello");

describe("Papyrus typeahead controller", () => {
  it("starts closed without invoking providers", () => {
    let calls = 0;
    const provider = providerFor("slash", () => {
      calls += 1;
      return [helpItem];
    });

    const state = createTypeaheadControllerState();

    expect(state).toEqual({
      status: "closed",
      context: undefined,
      items: [],
      generation: 0,
    });
    expect(calls).toBe(0);
    expect(provider.id).toBe("slash");
  });

  it("opens on valid context when a provider is eligible", () => {
    const state = openTypeahead(createTypeaheadControllerState(), context, [
      providerFor("slash", () => [helpItem]),
    ]);

    expect(state).toMatchObject({
      status: "loading",
      context,
      providerId: "slash",
      items: [],
    });
  });

  it("stays closed when no providers are available", async () => {
    const request = requestTypeaheadSuggestions(createTypeaheadControllerState(), context, []);
    const state = applyTypeaheadResult(request.state, request.generation, await request.result);

    expect(request.state.status).toBe("closed");
    expect(state.status).toBe("empty");
    expect(state.items).toEqual([]);
  });

  it("applies sync provider results as open suggestion data", async () => {
    const request = requestTypeaheadSuggestions(createTypeaheadControllerState(), context, [
      providerFor("slash", () => [helpItem, helloItem]),
    ], { requestId: "req-sync" });
    const state = applyTypeaheadResult(request.state, request.generation, await request.result);

    expect(state).toMatchObject({
      status: "open",
      providerId: "slash",
      requestId: "req-sync",
      generation: 1,
      focusedIndex: 0,
    });
    expect(state.items.map((suggestion) => suggestion.id)).toEqual(["help", "hello"]);
  });

  it("applies async provider results", async () => {
    const request = requestTypeaheadSuggestions(createTypeaheadControllerState(), context, [
      {
        id: "history",
        name: "History",
        getSuggestions: async () => normalizeSuggestionProviderResult("history", {
          suggestions: [item("recent", "/recent")],
        }),
      },
    ]);
    const state = applyTypeaheadResult(request.state, request.generation, await request.result);

    expect(state.status).toBe("open");
    expect(state.providerId).toBe("history");
    expect(state.items.map((suggestion) => suggestion.id)).toEqual(["recent"]);
  });

  it("represents provider errors as state data", async () => {
    const request = requestTypeaheadSuggestions(createTypeaheadControllerState(), context, [
      {
        id: "files",
        name: "Files",
        getSuggestions: () => {
          throw new Error("provider unavailable");
        },
      },
    ]);
    const state = applyTypeaheadResult(request.state, request.generation, await request.result);

    expect(state.status).toBe("error");
    expect(state.error).toEqual({ message: "provider unavailable" });
    expect(state.items).toEqual([]);
  });

  it("ignores stale async results from superseded generations", async () => {
    let resolveOld: ((value: readonly SuggestionItem[]) => void) | undefined;
    const oldProvider: SuggestionProvider = {
      id: "old",
      name: "Old",
      getSuggestions: () => new Promise((resolve) => {
        resolveOld = (suggestions) => resolve(normalizeSuggestionProviderResult("old", { suggestions }));
      }),
    };
    const nextProvider = providerFor("next", () => [item("fresh", "/fresh")]);
    const initial = createTypeaheadControllerState();
    const oldRequest = requestTypeaheadSuggestions(initial, context, [oldProvider], { requestId: "old-req" });
    const nextRequest = requestTypeaheadSuggestions(oldRequest.state, context, [nextProvider], { requestId: "next-req" });
    const freshState = applyTypeaheadResult(nextRequest.state, nextRequest.generation, await nextRequest.result);

    resolveOld?.([item("stale", "/stale")]);
    const staleState = applyTypeaheadResult(freshState, oldRequest.generation, await oldRequest.result);

    expect(freshState.generation).toBe(2);
    expect(staleState.items.map((suggestion) => suggestion.id)).toEqual(["fresh"]);
    expect(staleState.requestId).toBe("next-req");
  });

  it("represents cancellation results as state data", async () => {
    const request = requestTypeaheadSuggestions(createTypeaheadControllerState(), context, [
      {
        id: "files",
        name: "Files",
        getSuggestions: () => normalizeSuggestionProviderResult("files", { canceled: true }),
      },
    ]);
    const state = applyTypeaheadResult(request.state, request.generation, await request.result);

    expect(state.status).toBe("canceled");
    expect(state.items).toEqual([]);
  });

  it("ignores stale canceled results without overwriting the active generation", async () => {
    const oldResult = normalizeSuggestionProviderResult("old", {
      canceled: true,
      requestId: "old-req",
    });
    const active = applyTypeaheadResult(
      {
        status: "loading",
        context,
        providerId: "next",
        items: [],
        generation: 2,
        requestId: "next-req",
      },
      2,
      normalizeSuggestionProviderResult("next", { suggestions: [helpItem], requestId: "next-req" })
    );

    const afterStaleCancel = applyTypeaheadResult(active, 1, oldResult);

    expect(afterStaleCancel.status).toBe("open");
    expect(afterStaleCancel.generation).toBe(2);
    expect(afterStaleCancel.requestId).toBe("next-req");
    expect(afterStaleCancel.items.map((suggestion) => suggestion.id)).toEqual(["help"]);
  });

  it("keeps optional MCP provider canceled and stale results data-only", async () => {
    const controller = new AbortController();
    controller.abort();
    const canceledProvider = createMcpResourceSuggestionProvider({
      source: {
        listResources: () => [{ label: "Project notes" }],
      },
      enabled: true,
      isAuthorized: () => true,
    });
    const canceledRequest = requestTypeaheadSuggestions(
      createTypeaheadControllerState(),
      optionalProviderContext,
      [canceledProvider],
      { signal: controller.signal }
    );
    const canceledState = applyTypeaheadResult(
      canceledRequest.state,
      canceledRequest.generation,
      await canceledRequest.result
    );

    expect(canceledState.status).toBe("canceled");
    expect(canceledState.items).toEqual([]);

    let resolveOld: (() => void) | undefined;
    const staleProvider = createMcpResourceSuggestionProvider({
      source: {
        listResources: () => new Promise((resolve) => {
          resolveOld = () => resolve([{ label: "Stale MCP resource" }]);
        }),
      },
      enabled: true,
      isAuthorized: () => true,
    });
    const freshProvider = createMcpResourceSuggestionProvider({
      source: {
        listResources: () => [{ label: "Fresh MCP resource" }],
      },
      enabled: true,
      isAuthorized: () => true,
    });
    const oldRequest = requestTypeaheadSuggestions(createTypeaheadControllerState(), optionalProviderContext, [staleProvider]);
    const freshRequest = requestTypeaheadSuggestions(oldRequest.state, optionalProviderContext, [freshProvider]);
    const freshState = applyTypeaheadResult(freshRequest.state, freshRequest.generation, await freshRequest.result);

    resolveOld?.();
    const afterStale = applyTypeaheadResult(freshState, oldRequest.generation, await oldRequest.result);

    expect(afterStale.status).toBe("open");
    expect(afterStale.generation).toBe(freshRequest.generation);
    expect(afterStale.items.map((suggestion) => suggestion.label)).toEqual(["Fresh MCP resource"]);
  });

  it("keeps optional skill provider canceled and stale results data-only", async () => {
    const controller = new AbortController();
    controller.abort();
    const canceledProvider = createSkillSuggestionProvider({
      source: {
        listSkills: () => [{ label: "Code review" }],
      },
      enabled: true,
      isAuthorized: () => true,
    });
    const canceledRequest = requestTypeaheadSuggestions(
      createTypeaheadControllerState(),
      optionalProviderContext,
      [canceledProvider],
      { signal: controller.signal }
    );
    const canceledState = applyTypeaheadResult(
      canceledRequest.state,
      canceledRequest.generation,
      await canceledRequest.result
    );

    expect(canceledState.status).toBe("canceled");
    expect(canceledState.items).toEqual([]);

    let resolveOld: (() => void) | undefined;
    const staleProvider = createSkillSuggestionProvider({
      source: {
        listSkills: () => new Promise((resolve) => {
          resolveOld = () => resolve([{ label: "Stale skill" }]);
        }),
      },
      enabled: true,
      isAuthorized: () => true,
    });
    const freshProvider = createSkillSuggestionProvider({
      source: {
        listSkills: () => [{ label: "Fresh skill" }],
      },
      enabled: true,
      isAuthorized: () => true,
    });
    const oldRequest = requestTypeaheadSuggestions(createTypeaheadControllerState(), optionalProviderContext, [staleProvider]);
    const freshRequest = requestTypeaheadSuggestions(oldRequest.state, optionalProviderContext, [freshProvider]);
    const freshState = applyTypeaheadResult(freshRequest.state, freshRequest.generation, await freshRequest.result);

    resolveOld?.();
    const afterStale = applyTypeaheadResult(freshState, oldRequest.generation, await oldRequest.result);

    expect(afterStale.status).toBe("open");
    expect(afterStale.generation).toBe(freshRequest.generation);
    expect(afterStale.items.map((suggestion) => suggestion.label)).toEqual(["Fresh skill"]);
  });

  it("moves focus next and previous through items", async () => {
    const request = requestTypeaheadSuggestions(createTypeaheadControllerState(), context, [
      providerFor("slash", () => [helpItem, helloItem]),
    ]);
    let state = applyTypeaheadResult(request.state, request.generation, await request.result);

    state = focusNextSuggestion(state);
    expect(focusedSuggestion(state)?.id).toBe("hello");

    state = focusPreviousSuggestion(state);
    expect(focusedSuggestion(state)?.id).toBe("help");
  });

  it("selects the focused item and returns replacement intent only", async () => {
    const request = requestTypeaheadSuggestions(createTypeaheadControllerState(), context, [
      providerFor("slash", () => [helpItem, helloItem]),
    ]);
    const state = focusNextSuggestion(
      applyTypeaheadResult(request.state, request.generation, await request.result)
    );
    const result = selectFocusedSuggestion(state);

    expect(result.intent).toEqual({
      type: "replace",
      item: helloItem,
      replacementText: "/hello",
      replacementRange: { start: 4, end: 7 },
      nextInput: "run /hello now",
    });
    expect(applySuggestionReplacement(context.input, helloItem.replacementRange, helloItem.replacementText)).toBe(
      "run /hello now"
    );
  });

  it("dismisses without command execution", async () => {
    const request = requestTypeaheadSuggestions(createTypeaheadControllerState(), context, [
      providerFor("slash", () => [helpItem]),
    ]);
    const state = applyTypeaheadResult(request.state, request.generation, await request.result);
    const result = dismissTypeahead(state);

    expect(result.intent).toEqual({ type: "dismiss" });
    expect(result.state).toMatchObject({
      status: "dismissed",
      items: [],
      focusedIndex: undefined,
    });
  });

  it("orders by ranking metadata deterministically without adding dependencies", async () => {
    const request = requestTypeaheadSuggestions(createTypeaheadControllerState(), context, [
      providerFor("slash", () => [
        item("low", "/low", { priority: 1, score: 1 }),
        item("high", "/high", { priority: 2, score: 0 }),
        item("same-a", "/same-a", { priority: 1, score: 5 }),
        item("same-b", "/same-b", { priority: 1, score: 5 }),
      ]),
    ]);
    const state = applyTypeaheadResult(request.state, request.generation, await request.result);

    expect(state.items.map((suggestion) => suggestion.id)).toEqual([
      "high",
      "same-a",
      "same-b",
      "low",
    ]);
  });

  it("preserves provider order for exact ranking ties", async () => {
    const request = requestTypeaheadSuggestions(createTypeaheadControllerState(), context, [
      providerFor("slash", () => [
        item("first", "/first", { priority: 1, score: 1 }),
        item("second", "/second", { priority: 1, score: 1 }),
        item("third", "/third", { priority: 1, score: 1 }),
      ]),
    ]);
    const state = applyTypeaheadResult(request.state, request.generation, await request.result);

    expect(state.items.map((suggestion) => suggestion.id)).toEqual(["first", "second", "third"]);
  });

  it("does not import command registry, policy, approval, or session code", () => {
    const source = readFileSync(fileURLToPath(new URL("./typeaheadController.ts", import.meta.url)), "utf8");

    expect(source).not.toMatch(/\bslash-menu\b|src\/cli|src\/security|src\/session|grantApproval|approval/i);
  });
});

function item(
  id: string,
  replacementText: string,
  rank?: SuggestionItem["rank"]
): SuggestionItem {
  return {
    id,
    label: replacementText,
    replacementText,
    replacementRange: { start: 4, end: 7 },
    providerId: "slash",
    kind: "slash",
    rank,
  };
}

function providerFor(
  id: string,
  getSuggestions: () => readonly SuggestionItem[]
): SuggestionProvider {
  return {
    id,
    name: id,
    getSuggestions: () => normalizeSuggestionProviderResult(id, {
      suggestions: getSuggestions(),
    }),
  };
}
