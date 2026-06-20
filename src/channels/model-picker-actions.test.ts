import { describe, expect, it } from "vitest";
import {
  MODEL_PICKER_ACTION_VALUE_LIMIT,
  MODEL_PICKER_MAX_CHOICE_ACTIONS,
  compactModelPickerLabel,
  modelPickerBackActionValue,
  modelPickerCancelActionValue,
  modelPickerClearActionValue,
  modelPickerPageActionKey,
  modelPickerPageActionValue,
  modelPickerProviderActionKey,
  modelPickerProviderActionValue,
  modelPickerSelectActionKey,
  modelPickerSelectActionValue,
  parseModelPickerAction,
  renderModelPickerActions
} from "./model-picker-actions.js";

describe("model picker actions", () => {
  it("round-trips ecmodel1 provider, select, page, back, clear, and cancel actions", () => {
    const providerKey = modelPickerProviderActionKey("openrouter");
    const provider = parseModelPickerAction(modelPickerProviderActionValue(providerKey));
    expect(provider).toEqual({
      ok: true,
      action: {
        kind: "provider",
        actionKey: providerKey
      }
    });

    const selectKey = modelPickerSelectActionKey("openrouter", "openai/gpt-4o");
    const select = parseModelPickerAction(modelPickerSelectActionValue(selectKey));
    expect(select).toEqual({
      ok: true,
      action: {
        kind: "select",
        actionKey: selectKey
      }
    });

    const pageKey = modelPickerPageActionKey("openrouter", 2);
    const page = parseModelPickerAction(modelPickerPageActionValue(pageKey));
    expect(page).toEqual({
      ok: true,
      action: {
        kind: "page",
        actionKey: pageKey
      }
    });

    expect(parseModelPickerAction(modelPickerBackActionValue())).toEqual({
      ok: true,
      action: { kind: "back" }
    });
    expect(parseModelPickerAction(modelPickerClearActionValue())).toEqual({
      ok: true,
      action: { kind: "clear" }
    });
    expect(parseModelPickerAction(modelPickerCancelActionValue())).toEqual({
      ok: true,
      action: { kind: "cancel" }
    });
  });

  it("rejects invalid or malformed action payloads safely", () => {
    expect(parseModelPickerAction("not-model-action")).toBeUndefined();
    expect(parseModelPickerAction("ecmodel1")).toEqual({
      ok: false,
      reason: "Invalid model picker action payload."
    });
    expect(parseModelPickerAction("ecmodel1:s:")).toEqual({
      ok: false,
      reason: "Invalid model picker action key."
    });
    expect(parseModelPickerAction("ecmodel1:s:not.a.route")).toEqual({
      ok: false,
      reason: "Invalid model picker action key."
    });
    expect(parseModelPickerAction("ecmodel1:g:not.a.page")).toEqual({
      ok: false,
      reason: "Invalid model picker action key."
    });
    expect(parseModelPickerAction("ecmodel1:b:extra")).toEqual({
      ok: false,
      reason: "Invalid model picker action payload."
    });
  });

  it("renders compact action payloads without raw provider, model, or credential values", () => {
    const longModel = "a".repeat(180);
    const actions = renderModelPickerActions([
      { label: "OpenAI", actionKey: modelPickerProviderActionKey("openai"), kind: "provider" },
      {
        label: longModel,
        actionKey: modelPickerSelectActionKey(
          "openai",
          longModel
        ),
        kind: "select"
      }
    ]);

    const serialized = JSON.stringify(actions);
    for (const action of actions.flat()) {
      expect(action.value.length).toBeLessThanOrEqual(MODEL_PICKER_ACTION_VALUE_LIMIT);
      expect(action.value).not.toContain("openai");
      expect(action.value).not.toContain("openai/");
      expect(action.value).not.toContain("a".repeat(60));
    }
    expect(serialized).toContain("ecmodel1:p:");
    expect(serialized).toContain("ecmodel1:s:");
    expect(serialized).not.toContain("sk-secret");
    expect(serialized).not.toContain("OPENAI_API_KEY=");
    expect(serialized).not.toContain("Bearer ");
  });

  it("renders choices in two columns and caps them to safe channel component limits", () => {
    const actions = renderModelPickerActions(
      Array.from({ length: MODEL_PICKER_MAX_CHOICE_ACTIONS + 10 }, (_, index) => ({
        label: `Provider ${index}`,
        actionKey: modelPickerProviderActionKey(`provider-${index}`),
        kind: "provider" as const
      }))
    );

    expect(actions).toHaveLength(10);
    expect(actions.every((row) => row.length <= 2)).toBe(true);
    expect(actions.flat()).toHaveLength(MODEL_PICKER_MAX_CHOICE_ACTIONS);
  });

  it("keeps page action keys compact, provider-scoped, and opaque", () => {
    const providerOnePageOne = modelPickerPageActionKey("openrouter", 1);
    const providerTwoPageOne = modelPickerPageActionKey("local", 1);
    const providerOnePageTwo = modelPickerPageActionKey("openrouter", 2);

    expect(providerOnePageOne).not.toBe(providerTwoPageOne);
    expect(providerOnePageOne).not.toBe(providerOnePageTwo);

    const value = modelPickerPageActionValue(providerOnePageOne);
    expect(value.length).toBeLessThanOrEqual(MODEL_PICKER_ACTION_VALUE_LIMIT);
    expect(value).not.toContain("openrouter");
    expect(value).not.toContain("local");
  });

  it("compacts labels without changing callback values", () => {
    const longLabel = "kimi-k2-thinking-turbo-preview-with-extra-suffix";
    const actionKey = modelPickerSelectActionKey("kimi", longLabel);
    const actions = renderModelPickerActions([
      { label: longLabel, actionKey, kind: "select" }
    ]);

    expect(compactModelPickerLabel(longLabel)).not.toBe(longLabel);
    expect(actions[0]?.[0]?.label).toBe(compactModelPickerLabel(longLabel));
    expect(actions[0]?.[0]?.value).toBe(modelPickerSelectActionValue(actionKey));
    expect(actions[0]?.[0]?.value).not.toContain(longLabel);
  });
});
