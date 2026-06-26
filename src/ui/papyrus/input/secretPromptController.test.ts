import { describe, expect, it } from "vitest";
import { SecretPromptController } from "./secretPromptController.js";

describe("SecretPromptController", () => {
  it("starts with safe masked render data only", () => {
    const controller = new SecretPromptController({ label: "Secret: " });

    expect(controller.renderState).toEqual({
      label: "Secret: ",
      maskedText: "",
      charCount: 0,
      isEmpty: true,
    });
    expect(JSON.stringify(controller.renderState)).not.toContain("secret-value");
  });

  it("appends printable input while rendering only masks", () => {
    const controller = new SecretPromptController({ label: "Secret: " });

    controller.apply({ type: "text", text: "top-secret" });

    expect(controller.renderState).toMatchObject({
      maskedText: "**********",
      charCount: 10,
      isEmpty: false,
    });
    expect(JSON.stringify(controller.renderState)).not.toContain("top-secret");
  });

  it("appends pasted text without exposing raw value in render state", () => {
    const controller = new SecretPromptController({ label: "Secret: " });

    controller.apply({ type: "paste", text: "pasted-secret" });

    expect(controller.renderState.maskedText).toBe("*************");
    expect(controller.renderState.charCount).toBe(13);
    expect(JSON.stringify(controller.renderState)).not.toContain("pasted-secret");
  });

  it("deletes by grapheme for emoji and combining marks", () => {
    const controller = new SecretPromptController({ label: "Secret: " });

    controller.apply({ type: "text", text: "a\u0301👩‍💻" });
    expect(controller.renderState.charCount).toBe(2);

    controller.apply({ type: "key", key: "backspace" });
    expect(controller.renderState).toMatchObject({ maskedText: "*", charCount: 1 });

    controller.apply({ type: "key", key: "backspace" });
    expect(controller.renderState).toMatchObject({ maskedText: "", charCount: 0, isEmpty: true });
  });

  it("submits the raw value once and clears the private buffer", () => {
    const controller = new SecretPromptController({ label: "Secret: " });

    controller.apply({ type: "text", text: "top-secret" });
    const result = controller.apply({ type: "key", key: "enter" });

    expect(result.intent).toEqual({ type: "submit", value: "top-secret" });
    expect(controller.renderState).toMatchObject({ maskedText: "", charCount: 0, isEmpty: true });

    const next = controller.apply({ type: "key", key: "enter" });
    expect(next.intent).toEqual({ type: "submit", value: "" });
  });

  it("clears the private buffer on cancel and eof", () => {
    const canceled = new SecretPromptController({ label: "Secret: " });
    canceled.apply({ type: "text", text: "cancel-secret" });
    expect(canceled.apply({ type: "key", key: "escape" }).intent).toEqual({ type: "cancel" });
    expect(canceled.renderState.charCount).toBe(0);

    const eof = new SecretPromptController({ label: "Secret: " });
    expect(eof.apply({ type: "key", key: "d", ctrl: true }).intent).toEqual({ type: "eof" });
    expect(eof.renderState.charCount).toBe(0);
  });
});
