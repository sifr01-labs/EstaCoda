import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveTokens } from "../theme/token-resolver.js";
import {
  createDefaultStatusRailState,
  createOperatorConsoleRuntimeHost,
  createOperatorConsoleStyle,
} from "../ui/papyrus/operator-console/index.js";
import { LiveOperatorConsoleController } from "./live-operator-console-controller.js";

describe("LiveOperatorConsoleController", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("advances visible spinner frames on a timer while activity is active", () => {
    vi.useFakeTimers();
    const output = createOutput();
    const controller = createController(output);

    controller.setTurnActivity({ phase: "thinking" });
    expect(stripAnsi(output.text())).toContain("⣾⣷");

    output.clear();
    vi.advanceTimersByTime(90);

    expect(stripAnsi(output.text())).toContain("⣽⣯");
  });

  it("stops the animation timer when the live frame is cleared", () => {
    vi.useFakeTimers();
    const output = createOutput();
    const controller = createController(output);

    controller.setTurnActivity({ phase: "thinking" });
    controller.clear();
    output.clear();

    vi.advanceTimersByTime(180);

    expect(output.text()).toBe("");
  });

  it("stops the streaming refresh timer when the live frame is cleared", () => {
    vi.useFakeTimers();
    const output = createOutput();
    const controller = createController(output);

    controller.appendStreamingText("partial answer");
    controller.clear();
    output.clear();

    vi.advanceTimersByTime(75);

    expect(output.text()).toBe("");
  });

  it("does not restart animation from stale turn activity after turn cleanup", () => {
    vi.useFakeTimers();
    const output = createOutput();
    const controller = createController(output);

    controller.setTurnActivity({ phase: "thinking" });
    controller.clearTurnActivity();
    controller.clear();
    controller.resetActiveWork();
    output.clear();

    vi.advanceTimersByTime(180);

    expect(output.text()).toBe("");
  });

  it("times active work from prompt submission until turn completion", () => {
    const output = createOutput();
    let nowMs = 5_000;
    const controller = createController(output, {
      now: () => nowMs,
      turnStartedAtMs: 1_000,
    });

    controller.applyActiveWorkEvent({
      id: "read",
      toolName: "read_file",
      status: "running",
      target: "src/app.ts",
    });
    expect(stripAnsi(output.text())).toContain("Running tools  ◷ 00:04");

    output.clear();
    nowMs = 7_000;
    controller.applyActiveWorkEvent({
      id: "read",
      toolName: "read_file",
      status: "done",
      target: "src/app.ts",
      durationMs: 100,
    });
    expect(stripAnsi(output.text())).toContain("Running tools  ◷ 00:06");

    nowMs = 9_000;
    const completed = controller.completeActiveWork();
    expect(completed?.completedAtMs).toBe(9_000);
  });

  it("batches streaming text into the live frame", () => {
    vi.useFakeTimers();
    const output = createOutput();
    const { controller, runtimeHost } = createControllerFixture(output);

    controller.appendStreamingText("Hello");
    controller.appendStreamingText(", streaming world");

    expect(output.text()).toBe("");
    expect(runtimeHost.getState().streaming?.tail).toBe("Hello, streaming world");

    vi.advanceTimersByTime(75);

    const text = stripAnsi(output.text());
    expect(text).toContain("Assistant stream");
    expect(text).toContain("Hello, streaming world");
  });

  it("tracks visible streaming output with trimmed text", () => {
    const output = createOutput();
    const controller = createController(output);

    controller.appendStreamingText("   \n\t");
    expect(controller.hasStreamingOutput()).toBe(false);

    controller.appendStreamingText(" visible");
    expect(controller.hasStreamingOutput()).toBe(true);
  });

  it("bounds the live streaming tail", () => {
    const output = createOutput();
    const { controller, runtimeHost } = createControllerFixture(output);

    controller.appendStreamingText(`${"a".repeat(200)}${"b".repeat(4_000)}`);

    expect(runtimeHost.getState().streaming?.tail).toBe("b".repeat(4_000));
  });

  it("keeps the full current segment when completing a bounded live tail", () => {
    const output = createOutput();
    const { controller, runtimeHost } = createControllerFixture(output);
    const fullText = `${"a".repeat(200)}${"b".repeat(4_000)}`;

    controller.appendStreamingText(fullText);
    const blocks = controller.completeStreaming();

    expect(blocks.map((block) => block.text)).toEqual([fullText]);
    expect(runtimeHost.getState().transcript.map((block) => block.text)).toEqual([fullText]);
  });

  it("flushes streaming prose before running tool chrome appears", () => {
    vi.useFakeTimers();
    const output = createOutput();
    let nowMs = 10_000;
    const { controller, runtimeHost } = createControllerFixture(output, {
      now: () => nowMs,
    });

    controller.appendStreamingText("I will inspect the file first.");
    nowMs = 10_100;
    controller.applyActiveWorkEvent({
      id: "read",
      toolName: "read_file",
      status: "running",
      target: "src/app.ts",
    });

    const streaming = runtimeHost.getState().streaming;
    expect(streaming?.tail).toBe("");
    expect(streaming?.segments).toEqual([expect.objectContaining({
      role: "assistant",
      text: "I will inspect the file first.",
      createdAtMs: 10_100,
    })]);
    expect(stripAnsi(output.text())).toContain("Running tools");

    output.clear();
    vi.advanceTimersByTime(75);
    expect(output.text()).toBe("");
  });

  it("completes streaming atomically into transcript blocks", () => {
    const output = createOutput();
    let nowMs = 20_000;
    const { controller, runtimeHost } = createControllerFixture(output, {
      now: () => nowMs,
    });

    controller.appendStreamingText("First chunk.");
    nowMs = 20_100;
    controller.flushStreamingSegment("tool-boundary");
    controller.appendStreamingText(" Final chunk.");
    output.clear();

    const blocks = controller.completeStreaming();

    expect(blocks).toEqual([
      expect.objectContaining({ role: "assistant", text: "First chunk.", createdAtMs: 20_100 }),
      expect.objectContaining({ role: "assistant", text: " Final chunk.", createdAtMs: 20_100 }),
    ]);
    expect(controller.hasStreamingOutput()).toBe(false);
    expect(runtimeHost.getState().streaming).toBeUndefined();
    expect(runtimeHost.getState().transcript.map((block) => block.text)).toEqual(["First chunk.", " Final chunk."]);
    expect(stripAnsi(output.text())).toContain("Transcript: 2 blocks");
    expect(countOccurrences(stripAnsi(output.text()), "Assistant stream")).toBe(0);
  });

  it("coalesces streaming refresh and animation timer renders", () => {
    vi.useFakeTimers();
    const output = createOutput();
    const controller = createController(output, {
      animationIntervalMs: 90,
      streamingRefreshIntervalMs: 90,
    });

    controller.setTurnActivity({ phase: "thinking" });
    controller.appendStreamingText("The answer is arriving");
    output.clear();

    vi.advanceTimersByTime(90);

    const text = stripAnsi(output.text());
    expect(countOccurrences(text, "Assistant stream")).toBe(1);
    expect(text).toContain("The answer is arriving");
  });
});

function createController(
  output: ReturnType<typeof createOutput>,
  options: Pick<
    ConstructorParameters<typeof LiveOperatorConsoleController>[0],
    "animationIntervalMs" | "now" | "streamingRefreshIntervalMs" | "turnStartedAtMs"
  > = {}
): LiveOperatorConsoleController {
  return createControllerFixture(output, options).controller;
}

function createControllerFixture(
  output: ReturnType<typeof createOutput>,
  options: Pick<
    ConstructorParameters<typeof LiveOperatorConsoleController>[0],
    "animationIntervalMs" | "now" | "streamingRefreshIntervalMs" | "turnStartedAtMs"
  > = {}
): {
  readonly controller: LiveOperatorConsoleController;
  readonly runtimeHost: ReturnType<typeof createOperatorConsoleRuntimeHost>;
} {
  const status = createDefaultStatusRailState();
  const tokens = resolveTokens("standard", "dark", "kemetBlue");
  const runtimeHost = createOperatorConsoleRuntimeHost({
    status,
    terminal: { width: 80, height: 12, isTty: true },
    style: createOperatorConsoleStyle({
      tokens,
      capabilities: { supportsColor: true, supportsTrueColor: true },
    }),
  });
  const controller = new LiveOperatorConsoleController({
    output,
    runtimeHost,
    terminal: { width: 80, height: 12, isTty: true },
    capabilities: { supportsAnimation: true },
    animationIntervalMs: 90,
    getStatus: () => status,
    ...options,
  });
  return { controller, runtimeHost };
}

function createOutput(): {
  readonly columns: number;
  readonly rows: number;
  readonly isTTY: boolean;
  write: (chunk: string | Uint8Array) => boolean;
  text: () => string;
  clear: () => void;
} {
  const writes: string[] = [];
  return {
    columns: 80,
    rows: 24,
    isTTY: true,
    write: (chunk: string | Uint8Array) => {
      writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    },
    text: () => writes.join(""),
    clear: () => {
      writes.length = 0;
    },
  };
}

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/gu, "");
}

function countOccurrences(value: string, search: string): number {
  return value.split(search).length - 1;
}
