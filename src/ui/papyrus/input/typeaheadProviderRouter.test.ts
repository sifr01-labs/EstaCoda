import { describe, expect, it, vi } from "vitest";
import {
  DIRECTORY_SUGGESTION_PROVIDER_ID,
} from "./providers/directoryProvider.js";
import {
  FILE_SUGGESTION_PROVIDER_ID,
} from "./providers/fileProvider.js";
import {
  SLASH_COMMAND_SUGGESTION_PROVIDER_ID,
} from "./providers/slashCommandProvider.js";
import {
  normalizeSuggestionProviderResult,
  type SuggestionProvider,
} from "./suggestionTypes.js";
import { createTypeaheadProviderRouter } from "./typeaheadProviderRouter.js";

describe("Papyrus typeahead provider router", () => {
  it("routes slash tokens to the slash provider", () => {
    const slash = provider(SLASH_COMMAND_SUGGESTION_PROVIDER_ID);
    const router = createTypeaheadProviderRouter({
      providers: [slash],
    });

    const selection = router.route({ input: "run /he now", cursorOffset: 7 });

    expect(selection).toMatchObject({
      triggerKind: "slash",
      context: {
        input: "run /he now",
        cursorOffset: 7,
        token: "/he",
        tokenRange: { start: 4, end: 7 },
      },
      provider: slash,
    });
  });

  it("does not route non-slash input to the slash provider", () => {
    const slash = provider(SLASH_COMMAND_SUGGESTION_PROVIDER_ID);
    const router = createTypeaheadProviderRouter({
      providers: [slash],
    });

    expect(router.route({ input: "hello there", cursorOffset: 5 })).toBeUndefined();
    expect(slash.getSuggestions).not.toHaveBeenCalled();
  });

  it("selects by provider id and not provider array order", () => {
    const directory = provider(DIRECTORY_SUGGESTION_PROVIDER_ID);
    const file = provider(FILE_SUGGESTION_PROVIDER_ID);
    const slash = provider(SLASH_COMMAND_SUGGESTION_PROVIDER_ID);
    const router = createTypeaheadProviderRouter({
      providers: [directory, file, slash],
    });

    const selection = router.route({ input: "/sta", cursorOffset: 4 });

    expect(selection?.provider).toBe(slash);
    expect(selection?.context.token).toBe("/sta");
    expect(directory.getSuggestions).not.toHaveBeenCalled();
    expect(file.getSuggestions).not.toHaveBeenCalled();
    expect(slash.getSuggestions).not.toHaveBeenCalled();
  });

  it("keeps directory and file providers out of the live router until explicitly enabled", () => {
    const directory = provider(DIRECTORY_SUGGESTION_PROVIDER_ID);
    const file = provider(FILE_SUGGESTION_PROVIDER_ID);
    const router = createTypeaheadProviderRouter({
      providers: [directory, file],
    });

    expect(router.route({ input: "./src", cursorOffset: 5 })).toBeUndefined();
    expect(router.route({ input: "/help", cursorOffset: 5 })).toBeUndefined();
    expect(directory.getSuggestions).not.toHaveBeenCalled();
    expect(file.getSuggestions).not.toHaveBeenCalled();
  });
});

function provider(id: string): SuggestionProvider {
  return {
    id,
    name: id,
    getSuggestions: vi.fn(() => normalizeSuggestionProviderResult(id)),
  };
}
