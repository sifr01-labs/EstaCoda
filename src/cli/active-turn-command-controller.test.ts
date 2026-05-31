import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { ActiveTurnCommandController } from "./active-turn-command-controller.js";

function makeInput(): NodeJS.ReadStream & {
  readonly rawModes: boolean[];
  press(chunk: string, key?: { name?: string; ctrl?: boolean; sequence?: string }): void;
} {
  const input = new PassThrough() as unknown as NodeJS.ReadStream & {
    rawModes: boolean[];
    press(chunk: string, key?: { name?: string; ctrl?: boolean; sequence?: string }): void;
  };
  input.isTTY = true;
  input.isRaw = false;
  input.rawModes = [];
  input.setRawMode = (mode: boolean) => {
    input.isRaw = mode;
    input.rawModes.push(mode);
    return input;
  };
  input.press = (chunk, key = {}) => {
    input.emit("keypress", chunk, key);
  };
  return input;
}

function createController(input = makeInput()) {
  const laneUpdates: Array<string | undefined> = [];
  const statuses: string[] = [];
  const abort = vi.fn();
  const emitSigint = vi.fn();
  const controller = new ActiveTurnCommandController({
    input,
    onCommandLaneChange: (line) => laneUpdates.push(line),
    onInterrupt: abort,
    onStatusMessage: (message) => statuses.push(message),
    emitSigint,
  });
  return { input, controller, laneUpdates, statuses, abort, emitSigint };
}

describe("ActiveTurnCommandController", () => {
  it("attaches on start and detaches on dispose", () => {
    const { input, controller } = createController();

    controller.start();
    expect(input.listenerCount("keypress")).toBe(1);
    expect(input.rawModes).toEqual([true]);

    controller.dispose();
    expect(input.listenerCount("keypress")).toBe(0);
    expect(input.rawModes).toEqual([true, false]);
  });

  it("ignores normal typed characters before a slash command starts", () => {
    const { input, controller, laneUpdates } = createController();
    controller.start();

    input.press("h", { name: "h" });
    input.press("i", { name: "i" });

    expect(laneUpdates).toEqual([]);
  });

  it("/ starts command buffering", () => {
    const { input, controller, laneUpdates } = createController();
    controller.start();

    input.press("/", { sequence: "/" });

    expect(laneUpdates).toEqual(["active command: /"]);
  });

  it("fires command lane updates while buffering", () => {
    const { input, controller, laneUpdates } = createController();
    controller.start();

    input.press("/", { sequence: "/" });
    input.press("i", { name: "i" });
    input.press("n", { name: "n" });

    expect(laneUpdates).toEqual([
      "active command: /",
      "active command: /i",
      "active command: /in",
    ]);
  });

  it("backspace edits the command buffer", () => {
    const { input, controller, laneUpdates } = createController();
    controller.start();

    input.press("/", { sequence: "/" });
    input.press("x", { name: "x" });
    input.press("", { name: "backspace" });

    expect(laneUpdates).toEqual([
      "active command: /",
      "active command: /x",
      "active command: /",
    ]);
  });

  it("Enter submits /interrupt", () => {
    const { input, controller, laneUpdates, abort } = createController();
    controller.start();

    for (const char of "/interrupt") {
      input.press(char, { name: char });
    }
    input.press("\r", { name: "return" });

    expect(abort).toHaveBeenCalledTimes(1);
    expect(laneUpdates.at(-1)).toBeUndefined();
  });

  it("/interrupt calls abort with CLI interrupt through the caller callback", () => {
    const input = makeInput();
    const abortController = new AbortController();
    const controller = new ActiveTurnCommandController({
      input,
      onCommandLaneChange: () => undefined,
      onInterrupt: () => abortController.abort("CLI interrupt"),
    });
    controller.start();

    for (const char of "/interrupt") {
      input.press(char, { name: char });
    }
    input.press("\r", { name: "return" });

    expect(abortController.signal.aborted).toBe(true);
    expect(abortController.signal.reason).toBe("CLI interrupt");
  });

  it("unknown command emits a status message and does not abort", () => {
    const { input, controller, statuses, abort } = createController();
    controller.start();

    for (const char of "/unknown") {
      input.press(char, { name: char });
    }
    input.press("\r", { name: "return" });

    expect(abort).not.toHaveBeenCalled();
    expect(statuses).toEqual(["Unknown active command: /unknown"]);
  });

  it("empty slash command submits without aborting or showing status", () => {
    const { input, controller, statuses, abort } = createController();
    controller.start();

    input.press("/", { sequence: "/" });
    input.press("\r", { name: "return" });

    expect(abort).not.toHaveBeenCalled();
    expect(statuses).toEqual([]);
  });

  it("does not implement /steer", () => {
    const { input, controller, statuses, abort } = createController();
    controller.start();

    for (const char of "/steer go left") {
      input.press(char, { name: char });
    }
    input.press("\r", { name: "return" });

    expect(abort).not.toHaveBeenCalled();
    expect(statuses).toEqual(["/steer is reserved for a later active-turn flow."]);
  });

  it("Escape clears the command lane", () => {
    const { input, controller, laneUpdates } = createController();
    controller.start();

    input.press("/", { sequence: "/" });
    input.press("", { name: "escape" });

    expect(laneUpdates).toEqual(["active command: /", undefined]);
  });

  it("Ctrl+U clears the command lane", () => {
    const { input, controller, laneUpdates } = createController();
    controller.start();

    input.press("/", { sequence: "/" });
    input.press("", { name: "u", ctrl: true });

    expect(laneUpdates).toEqual(["active command: /", undefined]);
  });

  it("Ctrl+C is forwarded and does not submit an active command", () => {
    const { input, controller, abort, emitSigint } = createController();
    controller.start();

    input.press("/", { sequence: "/" });
    input.press("\u0003", { name: "c", ctrl: true });

    expect(emitSigint).toHaveBeenCalledTimes(1);
    expect(abort).not.toHaveBeenCalled();
  });

  it("dispose clears buffered state and command lane", () => {
    const { input, controller, laneUpdates } = createController();
    controller.start();
    input.press("/", { sequence: "/" });

    controller.dispose();

    expect(laneUpdates).toEqual(["active command: /", undefined]);
  });
});
