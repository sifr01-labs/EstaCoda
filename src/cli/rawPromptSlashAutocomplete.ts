import type { SlashCommandSuggestionMetadata } from "../ui/papyrus/input/providers/slashCommandProvider.js";
import type { SuggestionItem } from "../ui/papyrus/input/suggestionTypes.js";
import type { TypeaheadState } from "../ui/papyrus/input/typeaheadController.js";
import { createSelectNavigationState } from "../ui/papyrus/widgets/selectModel.js";
import { buildSelectRenderRows } from "../ui/papyrus/widgets/selectRenderRows.js";
import type { RawPromptOverlayRow } from "./rawPromptRenderLoop.js";

export function buildRawPromptSlashAutocompleteRows(
  state: TypeaheadState<SlashCommandSuggestionMetadata>
): readonly RawPromptOverlayRow[] {
  switch (state.status) {
    case "loading":
      return [{ id: "slash.loading", text: "  Loading slash commands..." }];
    case "empty":
      return [{ id: "slash.empty", text: "  No slash commands found" }];
    case "error":
      return [{ id: "slash.error", text: `  Slash suggestions unavailable: ${state.error?.message ?? "unknown error"}` }];
    case "open":
      return slashItemsToRows(state.items, state.focusedIndex);
    default:
      return [];
  }
}

function slashItemsToRows(
  items: readonly SuggestionItem<SlashCommandSuggestionMetadata>[],
  focusedIndex: number | undefined
): readonly RawPromptOverlayRow[] {
  const options = items.map((item) => ({
    value: item.id,
    label: item.label,
    description: item.description ?? item.detail,
    metadata: item,
  }));
  const focused = focusedIndex === undefined ? undefined : options[focusedIndex]?.value;
  const state = createSelectNavigationState(options, {
    focusedValue: focused,
    viewportSize: Math.max(1, items.length),
    wrap: false,
  });

  return buildSelectRenderRows(state)
    .filter((row) => row.kind !== "empty")
    .map((row) => {
    const marker = row.focused ? ">" : " ";
    const description = row.description === undefined || row.description.length === 0
      ? ""
      : ` - ${row.description}`;
    return {
      id: `slash.${row.value}`,
      text: `${marker} ${row.label}${description}`,
    };
  });
}
