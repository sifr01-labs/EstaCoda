import type { ChannelTextAction } from "../contracts/channel.js";
import { createHash } from "node:crypto";

const ACTION_PREFIX = "ecmodel1";
export const MODEL_PICKER_ACTION_VALUE_LIMIT = 64;
export const MODEL_PICKER_MAX_CHOICE_ACTIONS = 20;
export const MODEL_PICKER_MODEL_PAGE_SIZE = 8;
const MODEL_PICKER_DEFAULT_COLUMNS = 2;
const MODEL_PICKER_LABEL_MAX_CHARS = 24;
const ACTION_KEY_PATTERN = /^[A-Za-z0-9_-]{8,24}$/u;

export type ModelPickerAction =
  | { kind: "provider"; actionKey: string }
  | { kind: "select"; actionKey: string }
  | { kind: "page"; actionKey: string }
  | { kind: "back" }
  | { kind: "clear" }
  | { kind: "cancel" };

export type ModelPickerActionParseResult =
  | { ok: true; action: ModelPickerAction }
  | { ok: false; reason: string };

export type ModelPickerChoice = {
  label: string;
  actionKey: string;
  kind: "provider" | "select";
};

export type ModelPickerRenderOptions = {
  columns?: number;
  maxChoices?: number;
};

export function modelPickerProviderActionKey(provider: string): string {
  return compactActionKey(["provider", provider]);
}

export function modelPickerSelectActionKey(provider: string, model: string): string {
  return compactActionKey(["model", provider, model]);
}

export function modelPickerPageActionKey(provider: string, page: number): string {
  return compactActionKey(["page", provider, String(page)]);
}

export function modelPickerProviderActionValue(actionKey: string): string {
  return [ACTION_PREFIX, "p", actionKey].join(":");
}

export function modelPickerSelectActionValue(actionKey: string): string {
  return [ACTION_PREFIX, "s", actionKey].join(":");
}

export function modelPickerPageActionValue(actionKey: string): string {
  return [ACTION_PREFIX, "g", actionKey].join(":");
}

export function modelPickerBackActionValue(): string {
  return [ACTION_PREFIX, "b"].join(":");
}

export function modelPickerClearActionValue(): string {
  return [ACTION_PREFIX, "c"].join(":");
}

export function modelPickerCancelActionValue(): string {
  return [ACTION_PREFIX, "x"].join(":");
}

export function renderModelPickerActions(
  choices: ModelPickerChoice[],
  options: ModelPickerRenderOptions = {}
): ChannelTextAction[][] {
  const rows: ChannelTextAction[][] = [];
  const columns = clampInteger(options.columns ?? MODEL_PICKER_DEFAULT_COLUMNS, 1, 5);
  const maxChoices = clampInteger(options.maxChoices ?? MODEL_PICKER_MAX_CHOICE_ACTIONS, 0, MODEL_PICKER_MAX_CHOICE_ACTIONS);
  const cappedChoices = choices.slice(0, maxChoices);
  for (let index = 0; index < cappedChoices.length; index += columns) {
    rows.push(cappedChoices.slice(index, index + columns).map((choice) => ({
      label: compactModelPickerLabel(choice.label),
      value: choice.kind === "provider"
        ? modelPickerProviderActionValue(choice.actionKey)
        : modelPickerSelectActionValue(choice.actionKey)
    })));
  }

  return rows;
}

export function compactModelPickerLabel(label: string, maxChars = MODEL_PICKER_LABEL_MAX_CHARS): string {
  const chars = Array.from(label);
  if (chars.length <= maxChars) {
    return label;
  }
  if (maxChars <= 6) {
    return chars.slice(0, maxChars).join("");
  }

  const marker = "...";
  const remaining = maxChars - marker.length;
  const head = Math.ceil(remaining / 2);
  const tail = Math.floor(remaining / 2);
  return `${chars.slice(0, head).join("")}${marker}${chars.slice(chars.length - tail).join("")}`;
}

export function parseModelPickerAction(value: string): ModelPickerActionParseResult | undefined {
  const parts = value.trim().split(":");
  if (parts[0] !== ACTION_PREFIX) {
    return undefined;
  }

  const action = parts[1];
  if (action === "p" && parts.length === 3) {
    const actionKey = parts[2] ?? "";
    if (!isValidActionKey(actionKey)) {
      return { ok: false, reason: "Invalid model picker action key." };
    }
    return { ok: true, action: { kind: "provider", actionKey } };
  }
  if (action === "g" && parts.length === 3) {
    const actionKey = parts[2] ?? "";
    if (!isValidActionKey(actionKey)) {
      return { ok: false, reason: "Invalid model picker action key." };
    }
    return { ok: true, action: { kind: "page", actionKey } };
  }
  if (action === "b" && parts.length === 2) {
    return { ok: true, action: { kind: "back" } };
  }
  if (action === "c" && parts.length === 2) {
    return { ok: true, action: { kind: "clear" } };
  }
  if (action === "x" && parts.length === 2) {
    return { ok: true, action: { kind: "cancel" } };
  }
  if (action !== "s" || parts.length !== 3) {
    return { ok: false, reason: "Invalid model picker action payload." };
  }

  const actionKey = parts[2] ?? "";
  if (!isValidActionKey(actionKey)) {
    return { ok: false, reason: "Invalid model picker action key." };
  }

  return {
    ok: true,
    action: {
      kind: "select",
      actionKey
    }
  };
}

function compactActionKey(parts: string[]): string {
  return createHash("sha256")
    .update(parts.join("\0"))
    .digest("base64url")
    .slice(0, 12);
}

function isValidActionKey(value: string): boolean {
  return ACTION_KEY_PATTERN.test(value) &&
    [ACTION_PREFIX, "s", value].join(":").length <= MODEL_PICKER_ACTION_VALUE_LIMIT;
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, Math.trunc(value)));
}
