import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveTokens } from "../../../theme/token-resolver.js";
import { stringWidth } from "../screen/stringWidth.js";
import {
  ACTIVE_WORK_STATUS_SYMBOLS,
  createOperatorConsoleStyle,
  createDefaultToolActivityState,
  formatActiveWorkSummary,
  getActiveWorkSurfaceDesiredHeight,
  hasActiveWork,
  renderCompletedActiveWorkSurface,
  renderActiveWorkSurface,
  resolveActiveWorkCopy,
  sortActiveWorkItems,
  type ActiveWorkItem,
  type ActiveWorkItemStatus,
  type ToolActivityState,
} from "./index.js";

const thisDir = dirname(fileURLToPath(import.meta.url));

describe("Papyrus operator console active work surface", () => {
  it("starts with an empty inert active work model", () => {
    const state = createDefaultToolActivityState();

    expect(state).toEqual({
      items: [],
      scrollOffset: 0,
      expanded: false,
    });
    expect(hasActiveWork(state)).toBe(false);
    expect(renderActiveWorkSurface(state, { width: 80 })).toEqual([]);
  });

  it("supports more than 5 and more than 8 active work items without truncating the model", () => {
    const state = createState({ items: manyItems(12) });

    expect(state.items).toHaveLength(12);
    expect(renderActiveWorkSurface(state, { width: 80, height: 14 }).filter((line) => line.includes("tool_"))).toHaveLength(12);
  });

  it("does not impose a fixed 5-slot or 8-slot render cap when viewport allows", () => {
    const output = renderActiveWorkSurface(createState({
      expanded: true,
      items: manyItems(12, "running"),
    }), { width: 90, height: 16 });
    const renderedItemRows = output.filter((line) => line.includes("tool_"));

    expect(renderedItemRows).toHaveLength(12);
    expect(renderedItemRows.length).toBeGreaterThan(8);
  });

  it("sorts running, queued, and awaiting approval items above completed items", () => {
    const state = createState({
      items: [
        item("done", "succeeded"),
        item("queued", "queued"),
        item("failed", "failed"),
        item("approval", "awaitingApproval"),
        item("running", "running"),
      ],
    });

    expect(sortActiveWorkItems(state).map((entry) => entry.id)).toEqual([
      "running",
      "queued",
      "approval",
      "done",
      "failed",
    ]);
  });

  it("keeps each active status above completed terminal statuses", () => {
    const state = createState({
      items: [
        item("succeeded", "succeeded"),
        item("failed", "failed"),
        item("cancelled", "cancelled"),
        item("queued", "queued"),
        item("approval", "awaitingApproval"),
        item("running", "running"),
      ],
    });
    const sortedIds = sortActiveWorkItems(state).map((entry) => entry.id);

    expect(sortedIds.indexOf("running")).toBeLessThan(sortedIds.indexOf("succeeded"));
    expect(sortedIds.indexOf("queued")).toBeLessThan(sortedIds.indexOf("failed"));
    expect(sortedIds.indexOf("approval")).toBeLessThan(sortedIds.indexOf("cancelled"));
  });

  it("uses the running tools title for active turn headers", () => {
    const output = renderActiveWorkSurface(createState({
      expanded: true,
      items: [
        item("run", "running"),
        item("ok", "succeeded"),
        item("bad", "failed"),
        item("stop", "cancelled"),
      ],
    }), { width: 80, height: 8 });

    expect(output[0]).toContain("Running tools");
  });

  it("renders completed items during an active turn", () => {
    const output = renderActiveWorkSurface(createLiveState(), { width: 80, height: 8 }).join("\n");

    expect(output).toContain("✓");
    expect(output).toContain("typecheck");
    expect(output).toContain("passed");
  });

  it("renders active work at full desired height without completed overflow", () => {
    const state = createLiveState();
    const output = renderActiveWorkSurface(state, { width: 80 });

    expect(output[0]).toMatch(/^╭─ Running tools ─+╮$/u);
    expect(output).toContainEqual(expect.stringContaining("read_file"));
    expect(output).toContainEqual(expect.stringContaining("tool_18"));
    expect(output.join("\n")).not.toContain("more completed this turn");
    expect(output).toHaveLength(getActiveWorkSurfaceDesiredHeight(state));
    expect(output.at(-1)).toMatch(/^╰─+╯$/u);
    expect(output.every((line) => stringWidth(line) <= 80)).toBe(true);
  });

  it("honors an explicit constrained height without adding overflow summary rows", () => {
    const output = renderActiveWorkSurface(createLiveState(), { width: 80, height: 5 });

    expect(output).toHaveLength(5);
    expect(output.join("\n")).not.toContain("more completed this turn");
  });

  it("does not summarize hidden completed items when a caller constrains height", () => {
    const output = renderActiveWorkSurface(createState({
      items: [
        item("run", "running"),
        item("queue", "queued"),
        ...manyItems(5, "succeeded"),
      ],
    }), { width: 80, height: 6 });

    expect(output.join("\n")).not.toContain("more completed this turn");
  });

  it("renders expanded active work at full height without scroll footer controls", () => {
    const state = createState({
      expanded: true,
      scrollOffset: 2,
      items: [
        item("exec", "running", { toolName: "terminal.exec", target: "pnpm test", durationMs: 43_000 }),
        item("read", "running", { toolName: "read_file", target: "src/cli/session-loop.ts", durationMs: 4_000 }),
        item("rg", "running", { toolName: "rg", target: "\"operatorConsole\" src", durationMs: 2_000 }),
        ...manyItems(42, "succeeded"),
      ],
    });
    const output = renderActiveWorkSurface(state, { width: 80 });
    const text = output.join("\n");

    expect(output[0]).toContain("Running tools");
    expect(text).toContain("terminal.exec");
    expect(text).toContain("rg");
    expect(text).toContain("tool_42");
    expect(text).not.toContain("↑↓ scroll · Enter inspect · Esc collapse");
    expect(output).toHaveLength(getActiveWorkSurfaceDesiredHeight(state));
    expect(output.every((line) => stringWidth(line) <= 80)).toBe(true);
  });

  it("keeps constrained expanded renders bounded without scroll footer rows", () => {
    const output = renderActiveWorkSurface(createState({
      expanded: true,
      items: manyItems(20, "running"),
    }), { width: 80, height: 7 });

    expect(output).toHaveLength(7);
    expect(output.join("\n")).not.toContain("↑↓ scroll");
  });

  it("ignores expanded scroll offset when full height can show every row", () => {
    const base = createState({
      expanded: true,
      items: manyItems(12, "running"),
    });
    const top = renderActiveWorkSurface({ ...base, scrollOffset: 0 }, { width: 80 }).join("\n");
    const scrolled = renderActiveWorkSurface({ ...base, scrollOffset: 4 }, { width: 80 }).join("\n");

    expect(top).toContain("tool_1");
    expect(top).toContain("tool_12");
    expect(scrolled).toContain("tool_1");
    expect(scrolled).toContain("tool_7");
  });

  it("formats durations deterministically from explicit or start/end timing", () => {
    const output = renderActiveWorkSurface(createState({
      items: [
        item("explicit", "running", { durationMs: 3_400 }),
        item("derived", "succeeded", { startedAtMs: 10_000, endedAtMs: 28_900 }),
      ],
    }), { width: 72, height: 6 }).join("\n");

    expect(output).toContain("3.4s");
    expect(output).toContain("19s");
  });

  it("formats row durations as compact elapsed values", () => {
    const output = renderActiveWorkSurface(createState({
      items: [
        item("zero", "succeeded", { durationMs: 0 }),
        item("subsecond", "succeeded", { durationMs: 100 }),
        item("one-second", "succeeded", { durationMs: 1_000 }),
        item("one-half", "succeeded", { durationMs: 1_500 }),
        item("fifty-eight", "succeeded", { durationMs: 58_000 }),
        item("minute", "succeeded", { durationMs: 81_000 }),
        item("long", "succeeded", { durationMs: 3_936_000 }),
      ],
    }), { width: 96, height: 9 }).join("\n");

    expect(output).toContain("0s");
    expect(output).toContain("0.1s");
    expect(output).toContain("1s");
    expect(output).toContain("1.5s");
    expect(output).toContain("58s");
    expect(output).toContain("1m21s");
    expect(output).toContain("65m36s");
  });

  it("shows a live working timer in the active work header when turn timing is available", () => {
    const output = renderActiveWorkSurface(createState({
      startedAtMs: 1_000,
      updatedAtMs: 2_900,
      items: [
        item("read", "running", { toolName: "read_file", target: "src/app.ts" }),
      ],
    }), { width: 72, height: 4 });

    expect(output[0]).toContain("Running tools  ◷ 00:01");
    expect(output.every((line) => stringWidth(line) <= 72)).toBe(true);
  });

  it("keeps the live working timer visible for queued and approval work", () => {
    const output = renderActiveWorkSurface(createState({
      startedAtMs: 1_000,
      updatedAtMs: 62_000,
      items: [
        item("queued", "queued", { toolName: "read_file", target: "src/app.ts" }),
        item("approval", "awaitingApproval", { toolName: "shell", target: "pnpm run build" }),
      ],
    }), { width: 72, height: 5 });
    const text = output.join("\n");

    expect(output[0]).toContain("Running tools  ◷ 01:01");
    expect(text).toContain("! shell");
    expect(text).toContain("pnpm run build");
    expect(output.every((line) => stringWidth(line) <= 72)).toBe(true);
  });

  it("isolates the Arabic live timer in the active work header", () => {
    const output = renderActiveWorkSurface(createState({
      startedAtMs: 1_000,
      updatedAtMs: 13_000,
      items: [
        item("read", "running", { toolName: "read_file", target: "src/app.ts" }),
      ],
    }), { width: 72, height: 4, locale: "ar" });
    const logicalHeader = output[0].replace(/[\u2068\u2069]/gu, "");

    expect(output[0]).toContain("⁨00:12⁩");
    expect(logicalHeader).toContain("تنفيذ الأدوات  ◷ 00:12");
    expect(output.every((line) => stringWidth(line) <= 72)).toBe(true);
  });

  it("renders completed tool logs with the summary and worked duration at the bottom", () => {
    const output = renderCompletedActiveWorkSurface(createState({
      startedAtMs: 0,
      completedAtMs: 1_532_000,
      items: [
        item("read", "succeeded", { toolName: "read_file", target: "src/app.ts", durationMs: 1_000 }),
        item("test", "failed", { toolName: "test", target: "failed", durationMs: 18_000 }),
      ],
    }), { width: 96 });
    const text = output.join("\n");

    expect(output[0]).toContain("Tools completed");
    expect(text).toContain("read_file");
    expect(text).toContain("src/app.ts");
    expect(text).toContain("test");
    expect(text).toContain("failed");
    expect(text).toContain("1 completed · 0 active · 1 failed · Worked for 25:32");
    expect(output.every((line) => stringWidth(line) <= 96)).toBe(true);
  });

  it("renders Arabic completed tool logs with localized duration copy within bounds", () => {
    const output = renderCompletedActiveWorkSurface(createState({
      startedAtMs: 0,
      completedAtMs: 65_000,
      items: [
        item("read", "succeeded", { toolName: "read_file", target: "src/app.ts", durationMs: 1_000 }),
        item("approval", "failed", { toolName: "shell", target: "approval required", durationMs: 8_000 }),
      ],
    }), { width: 72, locale: "ar" });
    const text = output.join("\n");
    const logicalText = text.replace(/[\u2068\u2069]/gu, "");

    expect(output[0]).toContain("اكتمل تنفيذ الأدوات");
    expect(logicalText).toContain("1 اكتملت · 0 نشطة · 1 فشلت · المدة 01:05");
    expect(logicalText).toContain("read_file");
    expect(logicalText).toContain("shell");
    expect(output.every((line) => stringWidth(line) <= 72)).toBe(true);
  });

  it("keeps status symbols mapped in one deterministic table", () => {
    expect(ACTIVE_WORK_STATUS_SYMBOLS).toEqual({
      queued: "·",
      running: "◷",
      succeeded: "✓",
      failed: "✗",
      cancelled: "×",
      awaitingApproval: "!",
    });
  });

  it("animates running tool rows from the active work frame index", () => {
    const tokens = resolveTokens("standard", "dark", "kemetBlue");
    const style = createOperatorConsoleStyle({
      tokens,
      capabilities: {
        supportsColor: true,
        supportsTrueColor: true,
      },
    });
    const state = createState({
      frameIndex: 1,
      items: [item("run", "running", { toolName: "read_file" })],
    });

    const output = renderActiveWorkSurface(state, { width: 72, height: 4, style }).join("\n");

    expect(output).toContain("⣽");
    expect(output).not.toContain("⣾ read_file");
  });

  it("truncates long tool names and targets safely", () => {
    const output = renderActiveWorkSurface(createState({
      items: [
        item("long", "running", {
          toolName: "terminal.exec.with.a.very.long.name",
          target: "src/runtime/deeply/nested/provider-turn-loop-with-a-very-long-name.ts",
        }),
      ],
    }), { width: 44, height: 4 });
    const text = output.join("\n");

    expect(text).toContain("terminal");
    expect(text).not.toContain("terminal.exec.with.a.very.long.name");
    expect(text).not.toContain("provider-turn-loop-with-a-very-long-name.ts");
    expect(output.every((line) => stringWidth(line) <= 44)).toBe(true);
  });

  it("emits no ANSI escape sequences or cursor-control strings", () => {
    const output = renderActiveWorkSurface(createLiveState(), { width: 80, height: 8 }).join("\n");

    expect(output).not.toContain("\u001b");
    expect(output).not.toContain("\\x1b");
    expect(output).not.toContain("\\u001b");
    expect(output).not.toContain("\\033");
    expect(output).not.toMatch(/\b(moveCursor|clearLine|clearScreenDown|cursorTo|setRawMode)\b/u);
    expect(output).not.toMatch(/\[[0-9;?]*[A-Za-z]/u);
  });

  it("does not mutate active work state while rendering", () => {
    const state = createLiveState();
    const before = JSON.stringify(state);

    renderActiveWorkSurface(state, { width: 80, height: 8 });
    sortActiveWorkItems(state);

    expect(JSON.stringify(state)).toBe(before);
  });

  it("formats collapsed turn-end tool summaries by default", () => {
    const state = createState({
      items: [
        item("run-1", "running"),
        item("run-2", "queued"),
        item("run-3", "awaitingApproval"),
        item("edit", "succeeded", { toolName: "apply_patch", fileChangeInspected: true }),
        ...manyItems(38, "succeeded"),
      ],
    });

    expect(formatActiveWorkSummary(state)).toBe(
      "39 completed · 3 active · 0 failed · Worked for 00:38"
    );
  });

  it("counts all tool events in the collapsed summary even when rendering is viewport-limited", () => {
    const state = createState({
      items: [
        item("run", "running"),
        ...manyItems(11, "succeeded"),
      ],
    });

    expect(renderActiveWorkSurface(state, { width: 80, height: 5 })).toHaveLength(5);
    expect(formatActiveWorkSummary(state)).toContain("11 completed · 1 active · 0 failed");
  });

  it("formats Arabic turn-end tool summaries through active work copy", () => {
    const state = createState({
      items: [
        item("run-1", "running"),
        item("edit", "succeeded", { toolName: "apply_patch", fileChangeInspected: true }),
      ],
    });

    expect(formatActiveWorkSummary(state, { locale: "ar" })).toBe(
      "1 اكتملت · 1 نشطة · 0 فشلت · المدة ⁨00:00⁩"
    );
  });

  it("resolves English copy by default and Arabic copy when requested", () => {
    expect(resolveActiveWorkCopy().runningTools).toBe("Running tools");
    expect(resolveActiveWorkCopy().toolsCompleted).toBe("Tools completed");
    expect(resolveActiveWorkCopy("ar").runningTools).toBe("تنفيذ الأدوات");
    expect(resolveActiveWorkCopy("ar").toolsCompleted).toBe("اكتمل تنفيذ الأدوات");
    expect(resolveActiveWorkCopy("ar").awaitingApproval).toBe("بانتظار الموافقة");
  });

  it("keeps active work summary copy token-backed and local to operator console", () => {
    const surfaceSource = readFileSync(join(thisDir, "activeWorkSurface.ts"), "utf8");
    const copySource = readFileSync(join(thisDir, "activeWorkCopy.ts"), "utf8");

    expect(surfaceSource).not.toContain("Completed tool work:");
    expect(surfaceSource).not.toContain("running steps resolved");
    expect(surfaceSource).not.toContain("total tool events");
    expect(surfaceSource).not.toContain("file change inspected");
    expect(copySource).not.toContain("Completed tool work");
    expect(copySource).not.toContain("running steps resolved");
    expect(copySource).toContain("Running tools");
    expect(copySource).toContain("Tools completed");
  });

  it("does not depend on CLI or setup copy modules", () => {
    const source = [
      readFileSync(join(thisDir, "activeWorkSurface.ts"), "utf8"),
      readFileSync(join(thisDir, "activeWorkCopy.ts"), "utf8"),
    ].join("\n");

    expect(source).not.toMatch(/from\s+["'][^"']*(?:cli|setup)[^"']*["']/u);
  });

  it("renders Arabic labels while preserving technical tool names, paths, and durations", () => {
    const output = renderActiveWorkSurface(createState({
      expanded: true,
      items: [
        item("read", "running", {
          toolName: "read_file",
          target: "src/ui/papyrus/screen/output.ts",
          durationMs: 3_000,
        }),
        item("done", "succeeded", {
          toolName: "typecheck",
          target: "passed",
          durationMs: 18_000,
        }),
      ],
    }), { width: 80, height: 7, locale: "ar" });
    const text = output.join("\n");

    expect(text).toContain("تنفيذ الأدوات");
    expect(text).toContain("read_file");
    expect(text).toContain("src/ui/papyrus/screen/output.ts");
    expect(text).toContain("3s");
    expect(text).toContain("typecheck");
    expect(text).toContain("passed");
    expect(text).toContain("18s");
    expect(text).not.toContain("↑↓ تمرير");
    expect(output.every((line) => stringWidth(line) <= 80)).toBe(true);
  });

  it("renders Arabic full active work without collapsed overflow copy", () => {
    const output = renderActiveWorkSurface(createLiveState(), { width: 80, locale: "ar" });
    const text = output.join("\n");

    expect(text).toContain("تنفيذ الأدوات");
    expect(text).toContain("tool_18");
    expect(text).not.toContain("أخرى مكتملة في هذه الجولة");
    expect(output.every((line) => stringWidth(line) <= 80)).toBe(true);
  });
});

function createState(input: Partial<ToolActivityState> = {}): ToolActivityState {
  return {
    items: [],
    scrollOffset: 0,
    expanded: false,
    ...input,
  };
}

function createLiveState(): ToolActivityState {
  return createState({
    items: [
      item("read-output", "running", {
        toolName: "read_file",
        target: "src/ui/papyrus/screen/output.ts",
        durationMs: 3_000,
      }),
      item("rg-readline", "running", {
        toolName: "rg",
        target: "\"createReadlinePrompt\" src",
        durationMs: 2_000,
      }),
      item("read-session", "succeeded", {
        toolName: "read_file",
        target: "src/cli/session-loop.ts",
        durationMs: 1_000,
      }),
      item("grep-approval", "succeeded", {
        toolName: "grep",
        target: "approval required",
        durationMs: 1_000,
      }),
      item("typecheck", "succeeded", {
        toolName: "typecheck",
        target: "passed",
        durationMs: 18_000,
      }),
      ...manyItems(18, "succeeded"),
    ],
  });
}

function manyItems(count: number, status: ActiveWorkItemStatus = "running"): readonly ActiveWorkItem[] {
  return Array.from({ length: count }, (_, index) => item(`item-${index + 1}`, status, {
    toolName: `tool_${index + 1}`,
    target: `target ${index + 1}`,
    durationMs: (index + 1) * 1000,
  }));
}

function item(
  id: string,
  status: ActiveWorkItemStatus,
  input: Partial<ActiveWorkItem> = {}
): ActiveWorkItem {
  return {
    id,
    toolName: input.toolName ?? id,
    status,
    summary: input.summary ?? input.target ?? id,
    ...(input.target === undefined ? {} : { target: input.target }),
    ...(input.startedAtMs === undefined ? {} : { startedAtMs: input.startedAtMs }),
    ...(input.endedAtMs === undefined ? {} : { endedAtMs: input.endedAtMs }),
    ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
    ...(input.detailsRef === undefined ? {} : { detailsRef: input.detailsRef }),
    ...(input.riskLevel === undefined ? {} : { riskLevel: input.riskLevel }),
    ...(input.approvalRef === undefined ? {} : { approvalRef: input.approvalRef }),
    ...(input.fileChangeInspected === undefined ? {} : { fileChangeInspected: input.fileChangeInspected }),
  };
}
