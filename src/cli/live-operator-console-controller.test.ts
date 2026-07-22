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

  it("advances visible motion from elapsed time and the token cadence", () => {
    vi.useFakeTimers();
    const output = createOutput();
    const { controller, runtimeHost } = createControllerFixture(output);

    controller.setTurnActivity({ phase: "thinking" });
    expect(stripAnsi(output.text())).toContain("◜");

    output.clear();
    vi.advanceTimersByTime(120);

    expect(stripAnsi(output.text())).toContain("◠");
    expect(runtimeHost.getState().motionElapsedMs).toBe(120);
  });

  it("does not redraw between visible frame changes", () => {
    vi.useFakeTimers();
    const output = createOutput();
    const controller = createController(output);

    controller.setTurnActivity({ phase: "thinking" });
    output.clear();
    vi.advanceTimersByTime(105);

    expect(output.text()).toBe("");
  });

  it("retries a frame change that was temporarily coalesced", () => {
    vi.useFakeTimers();
    const output = createOutput();
    const controller = createController(output);

    controller.setTurnActivity({ phase: "thinking" });
    vi.advanceTimersByTime(115);
    controller.refresh();
    output.clear();

    vi.advanceTimersByTime(20);

    expect(stripAnsi(output.text())).toContain("◠");
  });

  it("does not run the motion clock for hidden tool activity", () => {
    vi.useFakeTimers();
    const output = createOutput();
    const controller = createController(output);

    controller.applyActiveWorkEvent({ id: "read", toolName: "read_file", status: "running" });
    output.clear();
    vi.advanceTimersByTime(180);

    expect(output.text()).toBe("");
  });

  it("animates a running tool once its inline trail is visible", () => {
    vi.useFakeTimers();
    const output = createOutput();
    const controller = createController(output);

    controller.appendStreamingText("I will inspect this first.");
    controller.applyActiveWorkEvent({ id: "read", toolName: "read_file", status: "running" });
    output.clear();
    vi.advanceTimersByTime(90);

    expect(stripAnsi(output.text())).toContain("◷");
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
    const { controller, runtimeHost } = createControllerFixture(output, {
      now: () => nowMs,
      turnStartedAtMs: 1_000,
    });

    const running = controller.applyActiveWorkEvent({
      id: "read",
      toolName: "read_file",
      status: "running",
      target: "src/app.ts",
    });
    expect(running.startedAtMs).toBe(1_000);
    expect(running.updatedAtMs).toBe(5_000);
    expect(runtimeHost.getState().activeWork.startedAtMs).toBe(1_000);
    expect(stripAnsi(output.text())).not.toContain("Running tools");

    output.clear();
    nowMs = 7_000;
    const done = controller.applyActiveWorkEvent({
      id: "read",
      toolName: "read_file",
      status: "done",
      target: "src/app.ts",
      durationMs: 100,
    });
    expect(done.startedAtMs).toBe(1_000);
    expect(done.updatedAtMs).toBe(7_000);
    expect(runtimeHost.getState().activeWork.updatedAtMs).toBe(7_000);
    expect(stripAnsi(output.text())).not.toContain("Running tools");

    nowMs = 9_000;
    const completed = controller.completeActiveWork();
    expect(completed?.completedAtMs).toBe(9_000);
  });

  it("renders retained durable Task cards while the foreground turn is active", () => {
    const output = createOutput();
    const { controller, runtimeHost } = createControllerFixture(output, {
      getTasks: () => [{
        taskId: "T-live-1",
        objective: "Research competitor",
        status: "running",
        executionPreference: "auto",
        execution: "foreground",
        foregroundOwnerActive: true,
        backgroundContinuation: "available",
        progress: { completed: 0, skipped: 0, total: 1 },
        steps: [{
          stepId: "step-1",
          position: 0,
          title: "Research Company A",
          objective: "Research Company A",
          executorRole: "worker",
          status: "running",
          dependsOn: [],
          childTaskPolicy: "forbid",
          usage: { providerCalls: 1, totalTokens: 100, estimatedCostUsd: 0.001, usageComplete: true, pricingComplete: true },
          attempts: [],
          activeAttempt: {
            attemptId: "attempt-1",
            taskId: "T-live-1",
            stepId: "step-1",
            attemptNumber: 1,
            status: "running",
            createdAt: "2026-07-20T10:00:00.000Z",
            updatedAt: "2026-07-20T10:00:03.000Z",
            startedAt: "2026-07-20T10:00:00.000Z",
            elapsedMs: 3_000,
            usage: { providerCalls: 1, totalTokens: 100, estimatedCostUsd: 0.001, usageComplete: true, pricingComplete: true }
          },
        }],
        subagents: [],
        trace: { events: [], hasEarlierEvents: false },
        childTasks: [],
        recentActivity: [],
        currentToolCategory: "browser",
        elapsedMs: 3_000,
        usage: {
          providerCalls: 1,
          totalTokens: 100,
          estimatedCostUsd: 0.001,
          usageComplete: true,
          pricingComplete: true,
        },
        results: [],
        createdAt: "2026-07-20T10:00:00.000Z",
        updatedAt: "2026-07-20T10:00:03.000Z",
      }],
    });

    controller.setTurnActivity({ phase: "provider" });

    expect(runtimeHost.getState().tasks.cards[0]?.taskId).toBe("T-live-1");
    expect(stripAnsi(output.text())).toContain("Research competitor");
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
    expect(text).toContain("EstaCoda");
    expect(text).toContain("Hello, streaming world");
    expect(text).toContain("Hello, streaming world▍");
    expect(text).not.toContain("Assistant stream");
  });

  it("keeps follow-up steer typing to the prompt region while streaming stays live", () => {
    const output = createOutput();
    const { controller, runtimeHost } = createControllerFixture(output);

    controller.appendStreamingText("Live assistant draft that should not repaint on every steer key.");
    controller.refresh();
    expect(stripAnsi(output.text())).toContain("Live assistant draft that should not repaint on every steer key.▍");
    output.clear();

    controller.setSteer({ mode: "drafting", draft: "h", cursorOffset: 1 });
    const firstSteerRender = stripAnsi(output.text());
    expect(runtimeHost.getState().streaming?.showCursor).toBe(false);
    expect(firstSteerRender).toContain("Live assistant draft that should not repaint on every steer key.");
    expect(firstSteerRender).not.toContain("Live assistant draft that should not repaint on every steer key.▍");
    expect(firstSteerRender).toContain("Steer current turn");
    expect(firstSteerRender).toContain("› h");
    output.clear();

    controller.setSteer({ mode: "drafting", draft: "he", cursorOffset: 2 });
    const secondSteerRender = stripAnsi(output.text());
    expect(secondSteerRender).toContain("Steer current turn");
    expect(secondSteerRender).toContain("› he");
    expect(secondSteerRender).not.toContain("Live assistant draft that should not repaint");
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
    const text = stripAnsi(output.text());
    expect(text).toContain("I will inspect the file first.");
    expect(text).toContain("read_file");
    expect(text).toContain("src/app.ts");
    expect(text).not.toContain("Running tools");

    output.clear();
    vi.advanceTimersByTime(75);
    expect(output.text()).toBe("");
  });

  it("tracks inline tool trail metadata from active work events", () => {
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

    expect(runtimeHost.getState().streaming?.toolTrail).toEqual([expect.objectContaining({
      id: "read",
      sequence: 1,
      toolName: "read_file",
      status: "running",
      summary: "running",
      target: "src/app.ts",
      startedAtMs: 10_100,
      afterSegmentId: "streaming-segment-1",
    })]);

    nowMs = 11_200;
    controller.applyActiveWorkEvent({
      id: "read",
      toolName: "read_file",
      status: "done",
      summary: "src/app.ts",
      target: "src/app.ts",
      durationMs: 1_100,
    });

    expect(runtimeHost.getState().streaming?.toolTrail).toEqual([expect.objectContaining({
      id: "read",
      sequence: 1,
      status: "succeeded",
      summary: "src/app.ts",
      durationMs: 1_100,
      endedAtMs: 11_200,
      afterSegmentId: "streaming-segment-1",
    })]);

    controller.completeStreaming();

    expect(runtimeHost.getState().streaming).toBeUndefined();
    expect(runtimeHost.getState().transcript[0]?.toolTrail).toEqual([expect.objectContaining({
      id: "read",
      sequence: 1,
      status: "succeeded",
      durationMs: 1_100,
      afterSegmentId: "streaming-segment-1",
    })]);
  });

  it("does not count tool-trail-only streaming as visible assistant output", () => {
    const output = createOutput();
    const { controller, runtimeHost } = createControllerFixture(output);

    controller.applyActiveWorkEvent({
      id: "read",
      toolName: "read_file",
      status: "running",
      target: "src/app.ts",
    });

    expect(runtimeHost.getState().streaming?.toolTrail).toEqual([expect.objectContaining({
      id: "read",
      status: "running",
    })]);
    expect(controller.hasStreamingOutput()).toBe(false);
  });

  it("keeps subagent rows live-only and removes them when delegation settles", () => {
    const output = createOutput();
    const { controller, runtimeHost } = createControllerFixture(output);

    controller.appendStreamingText("I will delegate three inspections in parallel.");
    controller.applyActiveWorkEvent({
      id: "delegate-1",
      toolName: "delegate_task",
      displayLabel: "Delegate Task",
      status: "running",
      target: "starting subagents",
    });
    controller.applyActiveWorkEvent({
      id: "subagent:child-1",
      toolName: "delegate_task",
      displayLabel: "Worker 1",
      source: "subagent",
      groupId: "batch-1",
      status: "running",
      target: "Read File",
    });

    const delegatedFrame = stripAnsi(runtimeHost.render().lines.join("\n"));
    expect(delegatedFrame).toContain("I will delegate three inspections in parallel.");
    expect(delegatedFrame).toContain("Delegated work");
    expect(runtimeHost.getState().activeWork.items).toHaveLength(2);
    expect(runtimeHost.getState().streaming?.toolTrail?.map((entry) => entry.id)).toEqual(["delegate-1"]);

    controller.appendStreamingText("Drafting the merged response.");
    expect(stripAnsi(runtimeHost.render().lines.join("\n"))).not.toContain("Delegated work");

    controller.applyActiveWorkEvent({
      id: "subagent:child-1",
      toolName: "delegate_task",
      displayLabel: "Worker 1",
      source: "subagent",
      groupId: "batch-1",
      status: "done",
      target: "completed",
      durationMs: 1_000,
    });
    controller.applyActiveWorkEvent({
      id: "delegate-1",
      toolName: "delegate_task",
      displayLabel: "Delegate Task",
      status: "done",
      target: "1 completed",
      durationMs: 1_200,
    });

    expect(controller.activeWork.items).toEqual([
      expect.objectContaining({ id: "delegate-1", status: "succeeded", target: "1 completed" }),
    ]);
    expect(stripAnsi(runtimeHost.render().lines.join("\n"))).not.toContain("Delegated work");
    expect(controller.completeActiveWork()?.items).toHaveLength(1);
  });

  it("settles tool-first trail metadata into the first assistant transcript block", () => {
    const output = createOutput();
    const { controller, runtimeHost } = createControllerFixture(output);

    controller.applyActiveWorkEvent({
      id: "read",
      toolName: "read_file",
      status: "running",
      target: "src/app.ts",
    });
    controller.appendStreamingText("The file shows the session loop path.");
    controller.completeStreaming();

    expect(runtimeHost.getState().transcript[0]?.text).toBe("The file shows the session loop path.");
    expect(runtimeHost.getState().transcript[0]?.toolTrail).toEqual([expect.objectContaining({
      id: "read",
      status: "running",
    })]);
    expect(runtimeHost.getState().transcript[0]?.toolTrail?.[0]?.afterSegmentId).toBeUndefined();
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
    expect(stripAnsi(output.text())).toContain("First chunk.");
    expect(stripAnsi(output.text())).toContain("Final chunk.");
    expect(stripAnsi(output.text())).toContain("EstaCoda");
    expect(countOccurrences(stripAnsi(output.text()), "Assistant stream")).toBe(0);
    expect(stripAnsi(output.text())).not.toContain("▍");
  });

  it("discards streaming state without redrawing stale live transcript rows", () => {
    const output = createOutput();
    const { controller, runtimeHost } = createControllerFixture(output);

    controller.appendStreamingText("live preview only");
    controller.refresh();
    expect(stripAnsi(output.text())).toContain("live preview only");
    output.clear();

    controller.clear();
    output.clear();
    controller.discardStreaming();

    expect(output.text()).toBe("");
    expect(runtimeHost.getState().streaming).toBeUndefined();
    expect(runtimeHost.getState().transcript).toEqual([]);
    expect(controller.hasStreamingOutput()).toBe(false);
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
    expect(countOccurrences(text, "The answer is arriving")).toBe(1);
    expect(text).toContain("The answer is arriving");
    expect(text).toContain("The answer is arriving▍");
    expect(text).not.toContain("Assistant stream");
  });

  it("keeps hidden live active work from expanding the frame while preserving streaming output", () => {
    const output = createOutput();
    const { controller, runtimeHost } = createControllerFixture(output);

    controller.appendStreamingText("I will inspect the memory files.");

    for (let index = 0; index < 20; index += 1) {
      controller.applyActiveWorkEvent({
        id: `read-${index}`,
        toolName: "read_file",
        status: "running",
        target: `src/file-${index}.ts`,
      });
    }

    const lines = runtimeHost.render().lines;
    const text = stripAnsi(lines.join("\n"));

    expect(runtimeHost.getState().terminal.height).toBe(12);
    expect(lines.length).toBeLessThanOrEqual(12);
    expect(text).not.toContain("Running tools");
    expect(text).toContain("read_file");
    expect(text).toContain("src/file-19.ts");
    expect(runtimeHost.getState().streaming?.segments).toContainEqual(expect.objectContaining({
      text: "I will inspect the memory files.",
    }));
  });
});

function createController(
  output: ReturnType<typeof createOutput>,
  options: Pick<
    ConstructorParameters<typeof LiveOperatorConsoleController>[0],
    "animationIntervalMs" | "now" | "streamingRefreshIntervalMs" | "turnStartedAtMs"
      | "getTasks"
  > = {}
): LiveOperatorConsoleController {
  return createControllerFixture(output, options).controller;
}

function createControllerFixture(
  output: ReturnType<typeof createOutput>,
  options: Pick<
    ConstructorParameters<typeof LiveOperatorConsoleController>[0],
    "animationIntervalMs" | "now" | "streamingRefreshIntervalMs" | "turnStartedAtMs"
      | "getTasks"
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
    animationIntervalMs: 15,
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
