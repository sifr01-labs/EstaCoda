import { describe, expect, it } from "vitest";
import {
  createInitialOperatorConsoleState,
  createOperatorConsoleLayout,
  renderOperatorConsoleTextLines,
  renderTaskCardSurface,
  renderTaskInspectionSurface,
  resolveOperatorConsoleInputSurface,
  routeTaskSurfaceKey,
  type TaskCardState,
} from "./index.js";

describe("durable Task surfaces", () => {
  it("renders a retained settled card with bounded step detail", () => {
    const card = makeCard({ status: "completed", elapsedMs: 198_000 });
    const lines = renderTaskCardSurface({ cards: [card], selectedTaskId: card.taskId, scrollOffset: 0 }, {
      width: 72,
      isTty: true,
      focusedTaskId: card.taskId,
    });

    expect(lines.join("\n")).toContain("T-104");
    expect(lines.join("\n")).toContain("Define comparison criteria");
    expect(lines.join("\n")).toContain("Browsing");
    expect(lines.join("\n")).toContain("completed");
    expect(lines.every((line) => visibleWidth(line) <= 72)).toBe(true);
  });

  it("renders the full safe inspection projection without raw bodies or internal worker handles", () => {
    const card = makeCard({
      childTasks: [{ taskId: "T-child-1", status: "running", parentAttemptId: "attempt-parent-1" }]
    });
    const lines = renderTaskInspectionSurface({
      cards: [card],
      selectedTaskId: card.taskId,
      inspectedTaskId: card.taskId,
      scrollOffset: 0,
    }, { width: 80, height: 40, isTty: true });
    const text = lines.join("\n");

    expect(text).toContain("Objective");
    expect(text).toContain("Plan revision");
    expect(text).toContain("Dependencies");
    expect(text).toContain("Active Attempt");
    expect(text).toContain("Child Tasks");
    expect(text).toContain("T-child-1");
    expect(text).toContain("running");
    expect(text).toContain("Usage and cost");
    expect(text).toContain("result://safe-1");
    expect(text).not.toContain("raw tool input");
    expect(text).not.toContain("worker-session-secret");
  });

  it("keeps retained Task card cost honest for partial and unavailable accounting", () => {
    const partial = makeCard({
      usage: {
        providerCalls: 3,
        totalTokens: 2_400,
        estimatedCostUsd: 0.84,
        usageComplete: true,
        pricingComplete: false,
      },
    });
    const unavailable = makeCard({
      taskId: "T-105",
      usage: {
        providerCalls: 1,
        totalTokens: 0,
        usageComplete: false,
        pricingComplete: false,
      },
    });

    expect(renderTaskCardSurface({ cards: [partial], scrollOffset: 0 }, { width: 72, isTty: true }).join("\n"))
      .toContain("≥ $0.84");
    const inspection = renderTaskInspectionSurface({
      cards: [unavailable],
      selectedTaskId: unavailable.taskId,
      inspectedTaskId: unavailable.taskId,
      scrollOffset: 0,
    }, { width: 72, height: 40, isTty: true }).join("\n");
    expect(inspection).toContain("unavailable");
    expect(inspection).not.toContain("$0.0000 · incomplete");
  });

  it("uses the Task inspection as a modal region and supports complete keyboard navigation", () => {
    let state = createInitialOperatorConsoleState({
      terminal: { width: 48, height: 10, isTty: true },
      tasks: { cards: [makeCard(), makeCard({ taskId: "T-105", objective: "Second Task" })], scrollOffset: 0 },
    });
    state = routeTaskSurfaceKey(state, { type: "key", key: "tab" }).state;
    expect(state.focus.target).toEqual({ kind: "taskCard", taskId: "T-104" });
    state = routeTaskSurfaceKey(state, { type: "key", key: "down" }).state;
    expect(state.tasks.selectedTaskId).toBe("T-105");
    state = routeTaskSurfaceKey(state, { type: "key", key: "home" }).state;
    state = routeTaskSurfaceKey(state, { type: "key", key: "enter" }).state;
    expect(state.tasks.inspectedTaskId).toBe("T-104");
    expect(createOperatorConsoleLayout(state).regions.map((region) => region.kind)).toEqual(["taskInspection"]);

    state = routeTaskSurfaceKey(state, { type: "key", key: "end" }).state;
    expect(state.tasks.scrollOffset).toBeGreaterThan(0);
    state = routeTaskSurfaceKey(state, { type: "key", key: "pageup" }).state;
    state = routeTaskSurfaceKey(state, { type: "key", key: "escape" }).state;
    expect(state.tasks.inspectedTaskId).toBeUndefined();
    expect(state.focus.target).toEqual({ kind: "taskCard", taskId: "T-104" });
  });

  it("keeps Arabic, bidi identifiers, narrow terminals, and plain output deterministic", () => {
    const card = makeCard({ objective: "مقارنة الشركات وإعداد التقرير" });
    const state = createInitialOperatorConsoleState({
      locale: "ar",
      terminal: { width: 28, height: 12, isTty: false },
      tasks: { cards: [card], selectedTaskId: card.taskId, scrollOffset: 0 },
    });
    const lines = renderOperatorConsoleTextLines(state, createOperatorConsoleLayout(state));
    const text = lines.join("\n");

    expect(text).toContain("المهام");
    expect(text).toContain("\u2068T-104\u2069");
    expect(text).not.toMatch(/\u001B\[/u);
    expect(lines.every((line) => visibleWidth(line) <= 28)).toBe(true);
  });

  it("codifies modal, approval, typeahead, attachment, and prompt precedence", () => {
    const resolve = (overrides: Partial<Parameters<typeof resolveOperatorConsoleInputSurface>[0]> = {}) =>
      resolveOperatorConsoleInputSurface({
        taskInspection: false,
        approval: false,
        typeahead: false,
        attachment: false,
        ...overrides,
      });
    expect(resolve({ taskInspection: true, approval: true, typeahead: true, attachment: true })).toBe("taskInspection");
    expect(resolve({ approval: true, typeahead: true, attachment: true })).toBe("approval");
    expect(resolve({ typeahead: true, attachment: true })).toBe("typeahead");
    expect(resolve({ attachment: true })).toBe("attachment");
    expect(resolve()).toBe("prompt");
  });
});

function makeCard(overrides: Partial<TaskCardState> = {}): TaskCardState {
  return {
    taskId: "T-104",
    objective: "Competitor comparison",
    status: "running",
    executionPreference: "auto",
    execution: "foreground",
    foregroundOwnerActive: true,
    backgroundContinuation: "available",
    progress: { completed: 1, skipped: 0, total: 3 },
    planRevision: { revision: 2, status: "active" },
    steps: [
      {
        stepId: "step-a",
        title: "Research Company A",
        status: "running",
        dependsOn: [],
        childTaskPolicy: "forbid",
        activeAttempt: {
          attemptNumber: 1,
          status: "running",
          elapsedMs: 198_000,
          currentActivity: "Browsing",
          currentToolCategory: "browser",
        },
      },
      { stepId: "step-b", title: "Define comparison criteria", status: "completed", dependsOn: [], childTaskPolicy: "forbid" },
      { stepId: "step-c", title: "Compare findings", status: "pending", dependsOn: ["step-a", "step-b"], childTaskPolicy: "forbid" },
    ],
    childTasks: [],
    recentActivity: [
      { kind: "attempt-started", label: "Attempt started · Research Company A", timestamp: "2026-07-20T10:00:00.000Z" },
    ],
    currentToolCategory: "browser",
    elapsedMs: 198_000,
    usage: {
      providerCalls: 3,
      totalTokens: 2_400,
      estimatedCostUsd: 0.0123,
      usageComplete: true,
      pricingComplete: true,
    },
    results: [{
      handle: "result://safe-1",
      kind: "artifact",
      status: "available",
      byteLength: 2_048,
      primary: true,
      summary: "Comparison table",
    }],
    createdAt: "2026-07-20T09:59:00.000Z",
    updatedAt: "2026-07-20T10:03:18.000Z",
    ...overrides,
  };
}

function visibleWidth(value: string): number {
  return [...value.replace(/[\u2066-\u2069]/gu, "")].length;
}
