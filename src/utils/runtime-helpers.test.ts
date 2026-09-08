import { describe, expect, it } from "vitest";
import { abortSourceFromSignal } from "./runtime-helpers.js";

describe("abortSourceFromSignal", () => {
  it("returns undefined until a signal is aborted", () => {
    const controller = new AbortController();

    expect(abortSourceFromSignal(undefined)).toBeUndefined();
    expect(abortSourceFromSignal(controller.signal)).toBeUndefined();
  });

  it.each([
    ["interrupt", "interrupt"],
    ["stop", "stop"],
    ["channel-stop", "stop"],
    ["drain-timeout", "drain-timeout"],
    ["stuck-loop", "stuck-loop"]
  ] as const)("normalizes parent abort reason %s to %s", (reason, expected) => {
    const controller = new AbortController();
    controller.abort(reason);

    expect(abortSourceFromSignal(controller.signal)).toBe(expected);
  });

  it("does not persist arbitrary parent abort payloads", () => {
    const textController = new AbortController();
    const errorController = new AbortController();
    textController.abort("operator supplied private explanation");
    errorController.abort(new Error("private failure details"));

    expect(abortSourceFromSignal(textController.signal)).toBe("unknown");
    expect(abortSourceFromSignal(errorController.signal)).toBe("unknown");
  });
});
