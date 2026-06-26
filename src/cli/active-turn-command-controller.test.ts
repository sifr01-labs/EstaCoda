import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { ActiveTurnCommandController } from "./active-turn-command-controller.js";

type ActiveInputPreview = { kind: "message" | "command"; text: string } | undefined;

function makeInput(): NodeJS.ReadStream & {
  readonly rawModes: boolean[];
  press(chunk: string | Buffer | Uint8Array): void;
} {
  const input = new PassThrough() as unknown as NodeJS.ReadStream & {
    rawModes: boolean[];
    press(chunk: string | Buffer | Uint8Array): void;
  };
  input.isTTY = true;
  input.isRaw = false;
  input.rawModes = [];
  input.setRawMode = (mode: boolean) => {
    input.isRaw = mode;
    input.rawModes.push(mode);
    return input;
  };
  input.press = (chunk) => {
    input.emit("data", chunk);
  };
  return input;
}

function createController(input = makeInput()) {
  const previews: ActiveInputPreview[] = [];
  const statuses: string[] = [];
  const inputLines: Array<string | undefined> = [];
  const queuedTexts: string[] = [];
  const abort = vi.fn();
  const steer = vi.fn();
  const emitSigint = vi.fn();
  const controller = new ActiveTurnCommandController({
    input,
    onActiveInputPreviewChange: (preview) => previews.push(preview),
    onInputLineChange: (line) => inputLines.push(line),
    onQueueText: (text) => queuedTexts.push(text),
    onInterrupt: abort,
    onSteer: steer,
    onStatusMessage: (message) => statuses.push(message),
    emitSigint,
  });
  return { input, controller, previews, inputLines, queuedTexts, statuses, abort, steer, emitSigint };
}

describe("ActiveTurnCommandController", () => {
  it("attaches on start and detaches on dispose", () => {
    const { input, controller } = createController();

    controller.start();
    expect(input.listenerCount("data")).toBe(1);
    expect(input.rawModes).toEqual([true]);

    controller.dispose();
    expect(input.listenerCount("data")).toBe(0);
    expect(input.rawModes).toEqual([true, false]);
  });

  it("renders normal active-turn typing in the input lane", () => {
    const { input, controller, previews, inputLines } = createController();
    controller.start();

    input.press("h");
    input.press("i");

    expect(previews).toEqual([
      { kind: "message", text: "h" },
      { kind: "message", text: "hi" },
    ]);
    expect(inputLines).toEqual(["h", "hi"]);
  });

  it("Enter queues normal active-turn text", () => {
    const { input, controller, queuedTexts, previews, abort } = createController();
    controller.start();

    for (const char of "hello while busy") {
      input.press(char);
    }
    input.press("\r");

    expect(queuedTexts).toEqual(["hello while busy"]);
    expect(abort).not.toHaveBeenCalled();
    expect(previews.at(-1)).toBeUndefined();
  });

  it("/ starts command buffering", () => {
    const { input, controller, previews } = createController();
    controller.start();

    input.press("/");

    expect(previews).toEqual([{ kind: "command", text: "/" }]);
  });

  it("fires command lane updates while buffering", () => {
    const { input, controller, previews } = createController();
    controller.start();

    input.press("/");
    input.press("i");
    input.press("n");

    expect(previews).toEqual([
      { kind: "command", text: "/" },
      { kind: "command", text: "/i" },
      { kind: "command", text: "/in" },
    ]);
  });

  it("ignores unsupported navigation key data while buffering active commands", () => {
    const { input, controller, previews, inputLines, queuedTexts, statuses, abort, steer } = createController();
    controller.start();

    input.press("/");
    input.press("\x1b[B");
    input.press("\x1b[A");
    input.press("\x1b[6~");
    input.press("\x1b[5~");
    input.press("\t");
    input.press("\x1b[999~");

    expect(previews).toEqual([{ kind: "command", text: "/" }]);
    expect(inputLines).toEqual(["/"]);
    expect(queuedTexts).toEqual([]);
    expect(statuses).toEqual([]);
    expect(abort).not.toHaveBeenCalled();
    expect(steer).not.toHaveBeenCalled();
  });

  it("ignores unknown control data while buffering active commands", () => {
    const { input, controller, previews, inputLines, queuedTexts, statuses } = createController();
    controller.start();

    input.press("/");
    input.press("\x00");
    input.press(Buffer.from("\x1b[999~"));

    expect(previews).toEqual([{ kind: "command", text: "/" }]);
    expect(inputLines).toEqual(["/"]);
    expect(queuedTexts).toEqual([]);
    expect(statuses).toEqual([]);
  });

  it("ignores unsupported navigation key data while buffering follow-up text", () => {
    const { input, controller, previews, inputLines, queuedTexts, statuses } = createController();
    controller.start();

    input.press("h");
    input.press("\x1b[B");
    input.press("\t");
    input.press("\x1b[999~");
    input.press("i");

    expect(previews).toEqual([
      { kind: "message", text: "h" },
      { kind: "message", text: "hi" },
    ]);
    expect(inputLines).toEqual(["h", "hi"]);
    expect(queuedTexts).toEqual([]);
    expect(statuses).toEqual([]);
  });

  it("backspace edits the command buffer", () => {
    const { input, controller, previews } = createController();
    controller.start();

    input.press("/");
    input.press("x");
    input.press("\x7f");

    expect(previews).toEqual([
      { kind: "command", text: "/" },
      { kind: "command", text: "/x" },
      { kind: "command", text: "/" },
    ]);
  });

  it("Enter submits /interrupt", () => {
    const { input, controller, previews, abort } = createController();
    controller.start();

    for (const char of "/interrupt") {
      input.press(char);
    }
    input.press("\r");

    expect(abort).toHaveBeenCalledTimes(1);
    expect(previews.at(-1)).toBeUndefined();
  });

  it("/interrupt calls abort with CLI interrupt through the caller callback", () => {
    const input = makeInput();
    const abortController = new AbortController();
    const controller = new ActiveTurnCommandController({
      input,
      onActiveInputPreviewChange: () => undefined,
      onInterrupt: () => abortController.abort("CLI interrupt"),
    });
    controller.start();

    for (const char of "/interrupt") {
      input.press(char);
    }
    input.press("\r");

    expect(abortController.signal.aborted).toBe(true);
    expect(abortController.signal.reason).toBe("CLI interrupt");
  });

  it("unknown command emits a status message and does not abort", () => {
    const { input, controller, statuses, abort } = createController();
    controller.start();

    for (const char of "/unknown") {
      input.press(char);
    }
    input.press("\r");

    expect(abort).not.toHaveBeenCalled();
    expect(statuses).toEqual(["Unknown active command: /unknown"]);
  });

  it("empty slash command submits without aborting or showing status", () => {
    const { input, controller, statuses, abort } = createController();
    controller.start();

    input.press("/");
    input.press("\r");

    expect(abort).not.toHaveBeenCalled();
    expect(statuses).toEqual([]);
  });

  it("dispatches /steer distinctly from unknown commands", () => {
    const { input, controller, statuses, abort, steer } = createController();
    controller.start();

    for (const char of "/steer go left") {
      input.press(char);
    }
    input.press("\r");

    expect(abort).not.toHaveBeenCalled();
    expect(steer).toHaveBeenCalledWith("go left");
    expect(statuses).toEqual([]);
  });

  it("empty /steer emits usage and does not abort", () => {
    const { input, controller, statuses, abort, steer } = createController();
    controller.start();

    for (const char of "/steer   ") {
      input.press(char);
    }
    input.press("\r");

    expect(abort).not.toHaveBeenCalled();
    expect(steer).not.toHaveBeenCalled();
    expect(statuses).toEqual(["Usage: /steer <note>"]);
  });

  it("/steer treats literal angle brackets as part of the note", () => {
    const { input, controller, steer } = createController();
    controller.start();

    for (const char of "/steer <note>") {
      input.press(char);
    }
    input.press("\r");

    expect(steer).toHaveBeenCalledWith("<note>");
  });

  it("/steer clears the command lane after submit", () => {
    const { input, controller, previews } = createController();
    controller.start();

    for (const char of "/steer go left") {
      input.press(char);
    }
    input.press("\r");

    expect(previews.at(-1)).toBeUndefined();
  });

  it("Escape clears the command lane", () => {
    const { input, controller, previews } = createController();
    controller.start();

    input.press("/");
    input.press("\x1b");

    expect(previews).toEqual([{ kind: "command", text: "/" }, undefined]);
  });

  it("Ctrl+U clears the command lane", () => {
    const { input, controller, previews } = createController();
    controller.start();

    input.press("/");
    input.press("\x15");

    expect(previews).toEqual([{ kind: "command", text: "/" }, undefined]);
  });

  it("Ctrl+C is forwarded and does not submit an active command", () => {
    const { input, controller, abort, emitSigint } = createController();
    controller.start();

    input.press("/");
    input.press("\x03");

    expect(emitSigint).toHaveBeenCalledTimes(1);
    expect(abort).not.toHaveBeenCalled();
  });

  it("Ctrl+D is ignored as data and does not submit an active command", () => {
    const { input, controller, abort, emitSigint, queuedTexts, statuses } = createController();
    controller.start();

    input.press("/");
    input.press("\x04");

    expect(emitSigint).not.toHaveBeenCalled();
    expect(abort).not.toHaveBeenCalled();
    expect(queuedTexts).toEqual([]);
    expect(statuses).toEqual([]);
  });

  it("dispose clears buffered state and command lane", () => {
    const { input, controller, previews } = createController();
    controller.start();
    input.press("/");

    controller.dispose();

    expect(previews).toEqual([{ kind: "command", text: "/" }, undefined]);
  });

  it("clears preview before queuing normal active-turn text", () => {
    const input = makeInput();
    const events: string[] = [];
    const controller = new ActiveTurnCommandController({
      input,
      onActiveInputPreviewChange: (preview) => events.push(preview === undefined ? "preview:clear" : `preview:${preview.text}`),
      onQueueText: (text) => events.push(`queue:${text}`),
      onInterrupt: () => events.push("interrupt"),
    });
    controller.start();

    for (const char of "hello") {
      input.press(char);
    }
    input.press("\r");

    expect(events.at(-2)).toBe("preview:clear");
    expect(events.at(-1)).toBe("queue:hello");
  });

  it("clears preview before /interrupt action", () => {
    const input = makeInput();
    const events: string[] = [];
    const controller = new ActiveTurnCommandController({
      input,
      onActiveInputPreviewChange: (preview) => events.push(preview === undefined ? "preview:clear" : `preview:${preview.text}`),
      onInterrupt: () => events.push("interrupt"),
    });
    controller.start();

    for (const char of "/interrupt") {
      input.press(char);
    }
    input.press("\r");

    expect(events.at(-2)).toBe("preview:clear");
    expect(events.at(-1)).toBe("interrupt");
  });

  it("clears preview before /steer action", () => {
    const input = makeInput();
    const events: string[] = [];
    const controller = new ActiveTurnCommandController({
      input,
      onActiveInputPreviewChange: (preview) => events.push(preview === undefined ? "preview:clear" : `preview:${preview.text}`),
      onInterrupt: () => events.push("interrupt"),
      onSteer: (note) => events.push(`steer:${note}`),
    });
    controller.start();

    for (const char of "/steer go left") {
      input.press(char);
    }
    input.press("\r");

    expect(events.at(-2)).toBe("preview:clear");
    expect(events.at(-1)).toBe("steer:go left");
  });
});
