import { describe, expect, it, vi } from "vitest";
import {
  dispatchNativeBrowserClick,
  NativeBrowserInputDispatchError
} from "./native-input.js";

describe("native browser input", () => {
  it("uses trusted CDP pointer events without invoking DOM click", async () => {
    const send = vi.fn(async (method: string, _params?: Record<string, unknown>) => method === "Runtime.evaluate"
      ? { result: { value: { x: 20, y: 30 } } }
      : {});

    await dispatchNativeBrowserClick({ send }, "@e1");

    expect(send.mock.calls.filter(([method]) => method === "Input.dispatchMouseEvent").map(([, params]) =>
      (params as Record<string, unknown>).type)).toEqual(["mouseMoved", "mousePressed", "mouseReleased"]);
    expect(String((send.mock.calls[0]?.[1] as Record<string, unknown> | undefined)?.expression)).not.toContain(".click()");
  });

  it("marks a failure after mouse press as dispatched and attempts to release the pointer", async () => {
    let releaseAttempts = 0;
    const send = vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method === "Runtime.evaluate") return { result: { value: { x: 20, y: 30 } } };
      if (method === "Input.dispatchMouseEvent" && params?.type === "mouseReleased" && ++releaseAttempts === 1) {
        throw new Error("CDP response lost");
      }
      return {};
    });

    const error = await dispatchNativeBrowserClick({ send }, "@e1").catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(NativeBrowserInputDispatchError);
    expect(error).toMatchObject({ actionDispatched: true });
    expect(releaseAttempts).toBe(2);
  });
});
