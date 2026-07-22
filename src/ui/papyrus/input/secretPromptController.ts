import { graphemeSpans, previousGraphemeRange } from "../../input/cursor.js";
import type { ParsedKeypress } from "../../input/parseKeypress.js";

export type SecretPromptRenderState = {
  readonly label: string;
  readonly maskedText: string;
  readonly charCount: number;
  readonly isEmpty: boolean;
  readonly error?: string;
};

export type SecretPromptIntent =
  | { readonly type: "submit"; readonly value: string }
  | { readonly type: "cancel" }
  | { readonly type: "eof" };

export type SecretPromptApplyResult = {
  readonly renderState: SecretPromptRenderState;
  readonly intent?: SecretPromptIntent;
};

export type SecretPromptControllerOptions = {
  readonly label: string;
  readonly maskCharacter?: string;
};

export class SecretPromptController {
  readonly #label: string;
  readonly #maskCharacter: string;
  #value = "";

  constructor(options: SecretPromptControllerOptions) {
    this.#label = options.label;
    this.#maskCharacter = options.maskCharacter ?? "*";
  }

  get renderState(): SecretPromptRenderState {
    const charCount = graphemeSpans(this.#value).length;
    return {
      label: this.#label,
      maskedText: this.#maskCharacter.repeat(charCount),
      charCount,
      isEmpty: charCount === 0,
    };
  }

  apply(event: ParsedKeypress): SecretPromptApplyResult {
    if (event.type === "text" || event.type === "paste") {
      this.#value += event.text;
      return { renderState: this.renderState };
    }

    if (event.type === "unknown" || event.type === "mouse") {
      return { renderState: this.renderState };
    }

    if (event.key === "enter") {
      const value = this.#value;
      this.clear();
      return {
        renderState: this.renderState,
        intent: { type: "submit", value },
      };
    }

    if (event.key === "escape" || (event.ctrl === true && event.key === "c")) {
      this.clear();
      return {
        renderState: this.renderState,
        intent: { type: "cancel" },
      };
    }

    if (event.ctrl === true && event.key === "d" && this.#value.length === 0) {
      this.clear();
      return {
        renderState: this.renderState,
        intent: { type: "eof" },
      };
    }

    if (event.key === "backspace") {
      const previous = previousGraphemeRange(this.#value, this.#value.length);
      if (previous !== undefined) {
        this.#value = this.#value.slice(0, previous.start);
      }
    }

    return { renderState: this.renderState };
  }

  clear(): void {
    this.#value = "";
  }
}
