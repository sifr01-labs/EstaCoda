import {
  createSelectNavigationState,
  focusOption,
  getFocusedOption,
  type CreateSelectNavigationStateOptions,
  type SelectNavigationState,
} from "./selectModel.js";
import type { PapyrusOption } from "./optionMap.js";
import type { SelectKeyEvent } from "./selectKeymap.js";

export type MultiSelectState<TValue = string, TMetadata = unknown> = {
  readonly navigation: SelectNavigationState<TValue, TMetadata>;
  readonly selectedValues: readonly TValue[];
  readonly minSelections?: number;
  readonly maxSelections?: number;
};

export type CreateMultiSelectStateOptions<TValue = string> =
  CreateSelectNavigationStateOptions<TValue> & {
    readonly selectedValues?: readonly TValue[];
    readonly minSelections?: number;
    readonly maxSelections?: number;
  };

export type MultiSelectIntent<TValue = string> =
  | { readonly type: "toggled"; readonly value: TValue; readonly selected: boolean }
  | { readonly type: "submitted"; readonly values: readonly TValue[] }
  | { readonly type: "cancel" };

export type MultiSelectResult<TValue = string, TMetadata = unknown> = {
  readonly state: MultiSelectState<TValue, TMetadata>;
  readonly intent?: MultiSelectIntent<TValue>;
};

export function createMultiSelectState<TValue = string, TMetadata = unknown>(
  options: readonly PapyrusOption<TValue, TMetadata>[],
  stateOptions: CreateMultiSelectStateOptions<TValue> = {}
): MultiSelectState<TValue, TMetadata> {
  const navigation = createSelectNavigationState(options, stateOptions);
  return {
    navigation,
    selectedValues: normalizeSelectedValues(navigation, stateOptions.selectedValues ?? []),
    minSelections: normalizeSelectionBound(stateOptions.minSelections),
    maxSelections: normalizeSelectionBound(stateOptions.maxSelections),
  };
}

export function toggleFocusedMultiSelectOption<TValue, TMetadata>(
  state: MultiSelectState<TValue, TMetadata>
): MultiSelectResult<TValue, TMetadata> {
  const focused = getFocusedOption(state.navigation);
  if (focused === undefined || focused.disabled === true) return { state };
  return toggleMultiSelectValue(state, focused.value);
}

export function toggleMultiSelectValue<TValue, TMetadata>(
  state: MultiSelectState<TValue, TMetadata>,
  value: TValue
): MultiSelectResult<TValue, TMetadata> {
  const option = state.navigation.optionMap.get(value);
  if (option === undefined || option.disabled === true) return { state };

  const alreadySelected = state.selectedValues.includes(value);
  if (alreadySelected && state.minSelections !== undefined && state.selectedValues.length <= state.minSelections) {
    return { state };
  }
  if (!alreadySelected && state.maxSelections !== undefined && state.selectedValues.length >= state.maxSelections) {
    return { state };
  }

  const selectedValues = alreadySelected
    ? state.selectedValues.filter((selected) => selected !== value)
    : [...state.selectedValues, value];
  const nextState = {
    ...state,
    navigation: focusOption(state.navigation, value),
    selectedValues: orderSelectedValues(state.navigation, selectedValues),
  };

  return {
    state: nextState,
    intent: {
      type: "toggled",
      value,
      selected: !alreadySelected,
    },
  };
}

export function submitMultiSelect<TValue, TMetadata>(
  state: MultiSelectState<TValue, TMetadata>
): MultiSelectResult<TValue, TMetadata> {
  if (state.minSelections !== undefined && state.selectedValues.length < state.minSelections) {
    return { state };
  }
  return {
    state,
    intent: {
      type: "submitted",
      values: state.selectedValues,
    },
  };
}

export function cancelMultiSelect<TValue, TMetadata>(
  state: MultiSelectState<TValue, TMetadata>
): MultiSelectResult<TValue, TMetadata> {
  return {
    state,
    intent: { type: "cancel" },
  };
}

export function applyMultiSelectKey<TValue = string, TMetadata = unknown>(
  state: MultiSelectState<TValue, TMetadata>,
  event: SelectKeyEvent
): MultiSelectResult<TValue, TMetadata> {
  switch (event.key) {
    case "enter":
      return submitMultiSelect(state);
    case "escape":
      return cancelMultiSelect(state);
    case "digit":
      if (!Number.isInteger(event.digit) || event.digit < 1) return { state };
      {
        const option = state.navigation.optionMap.items[event.digit - 1];
        return option === undefined ? { state } : toggleMultiSelectValue(state, option.value);
      }
    default:
      return { state };
  }
}

function normalizeSelectedValues<TValue, TMetadata>(
  navigation: SelectNavigationState<TValue, TMetadata>,
  values: readonly TValue[]
): readonly TValue[] {
  const uniqueValues = [...new Set(values)];
  return orderSelectedValues(
    navigation,
    uniqueValues.filter((value) => {
      const option = navigation.optionMap.get(value);
      return option !== undefined && option.disabled !== true;
    })
  );
}

function orderSelectedValues<TValue, TMetadata>(
  navigation: SelectNavigationState<TValue, TMetadata>,
  values: readonly TValue[]
): readonly TValue[] {
  const selected = new Set(values);
  return navigation.optionMap.items
    .filter((item) => selected.has(item.value))
    .map((item) => item.value);
}

function normalizeSelectionBound(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.floor(value));
}
