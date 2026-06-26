import { describe, expect, it } from "vitest";
import {
  SLASH_COMMAND_SUGGESTION_PROVIDER_ID,
  type SlashCommandSuggestionMetadata,
} from "../ui/papyrus/input/providers/slashCommandProvider.js";
import type { SuggestionItem } from "../ui/papyrus/input/suggestionTypes.js";
import type { TypeaheadState } from "../ui/papyrus/input/typeaheadController.js";
import { buildRawPromptSlashAutocompleteRows } from "./rawPromptSlashAutocomplete.js";

describe("raw prompt slash autocomplete rows", () => {
  it("renders slash suggestions in provider order with focused marker", () => {
    const rows = buildRawPromptSlashAutocompleteRows(state({
      status: "open",
      items: [
        item("help", "Show help"),
        item("status", "Show status"),
      ],
      focusedIndex: 1,
    }));

    expect(rows.map((row) => row.text)).toEqual([
      "  /help - Show help",
      "> /status - Show status",
    ]);
  });

  it("uses detail when description is absent", () => {
    const rows = buildRawPromptSlashAutocompleteRows(state({
      status: "open",
      items: [
        {
          ...item("model"),
          description: undefined,
          detail: "Show model",
        },
      ],
      focusedIndex: 0,
    }));

    expect(rows[0]?.text).toBe("> /model - Show model");
  });

  it("renders loading, empty, and error states as inert overlay rows", () => {
    expect(buildRawPromptSlashAutocompleteRows(state({ status: "loading" })).map((row) => row.text)).toEqual([
      "  Loading slash commands...",
    ]);
    expect(buildRawPromptSlashAutocompleteRows(state({ status: "empty" })).map((row) => row.text)).toEqual([
      "  No slash commands found",
    ]);
    expect(buildRawPromptSlashAutocompleteRows(state({
      status: "error",
      error: { message: "provider failed" },
    })).map((row) => row.text)).toEqual([
      "  Slash suggestions unavailable: provider failed",
    ]);
  });

  it("returns no rows for closed or dismissed state", () => {
    expect(buildRawPromptSlashAutocompleteRows(state({ status: "closed" }))).toEqual([]);
    expect(buildRawPromptSlashAutocompleteRows(state({ status: "dismissed" }))).toEqual([]);
  });
});

function state(
  overrides: Partial<TypeaheadState<SlashCommandSuggestionMetadata>>
): TypeaheadState<SlashCommandSuggestionMetadata> {
  return {
    status: "closed",
    items: [],
    generation: 0,
    ...overrides,
  };
}

function item(
  commandName: string,
  description?: string
): SuggestionItem<SlashCommandSuggestionMetadata> {
  return {
    id: `slash.${commandName}`,
    label: `/${commandName}`,
    description,
    replacementText: `/${commandName}`,
    replacementRange: { start: 0, end: commandName.length + 1 },
    providerId: SLASH_COMMAND_SUGGESTION_PROVIDER_ID,
    kind: "slash",
    metadata: {
      commandName,
      aliases: [],
      category: "Test",
    },
  };
}
