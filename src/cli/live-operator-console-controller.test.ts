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
});

function createController(
  output: ReturnType<typeof createOutput>,
  options: Pick<ConstructorParameters<typeof LiveOperatorConsoleController>[0], "now" | "turnStartedAtMs"> = {}
): LiveOperatorConsoleController {
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
  return new LiveOperatorConsoleController({
    output,
    runtimeHost,
    terminal: { width: 80, height: 12, isTty: true },
    capabilities: { supportsAnimation: true },
    animationIntervalMs: 90,
    getStatus: () => status,
    ...options,
  });
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
