import { describe, expect, it } from "vitest";
import { resolveTokens } from "../../../theme/token-resolver.js";
import {
  createOperatorConsoleStyle,
  getActivityTraceWindow,
  navigateActivityTrace,
  renderActivityTraceSurface,
  type TaskCardActivityState,
  type TaskCardState,
} from "./index.js";

describe("Task activity trace surface", () => {
  it("renders semantic event colors, a selected event, an independent live marker, and all-time counters", () => {
    const style = createOperatorConsoleStyle({
      tokens: resolveTokens("standard", "dark", "kemetBlue"),
      capabilities: { supportsColor: true, supportsTrueColor: true },
    });
    const events = makeEvents(9);
    const card = makeCard(events);
    const lines = renderActivityTraceSurface(card, {
      followLive: false,
      selectedTraceEventId: "event-4",
    }, { width: 100, style });
    const text = stripAnsi(lines.join("\n"));

    expect(text).toContain("Activity trace · 9 events");
    expect(text).toContain("□");
    expect(text).toContain("◆ live");
    expect(text).toContain("Edit · Subagent 1 · 10:00:04 · Safe event 4");
    expect(text).toContain("Terminal ×1");
    expect(text).toContain("Failed ×1");
    expect(text).toContain("Return to live → End");
    expect(lines.join("\n")).toContain("\x1b[38;2;");
  });

  it("uses a readable overflow window and supports stable left, right, Home, and End navigation", () => {
    const events = makeEvents(80);
    const liveWindow = getActivityTraceWindow(events, { followLive: true }, 40);
    const home = navigateActivityTrace(events, { followLive: true }, "home", 40);
    const left = navigateActivityTrace(events, { followLive: true }, "left", 40);
    const right = navigateActivityTrace(events, left, "right", 40);
    const end = navigateActivityTrace(events, home, "end", 40);
    const rendered = renderActivityTraceSurface(makeCard(events), { followLive: true }, { width: 40 }).join("\n");

    expect(liveWindow.events).toHaveLength(16);
    expect(liveWindow.earlierCount).toBe(64);
    expect(home).toEqual({ followLive: false, selectedTraceEventId: "event-64" });
    expect(left).toEqual({ followLive: false, selectedTraceEventId: "event-78" });
    expect(right).toEqual({ followLive: false, selectedTraceEventId: "event-79" });
    expect(end).toEqual({ followLive: true });
    expect(rendered).toContain("< 64 earlier");
  });

  it("keeps a historical event selected by stable ID when new live events arrive", () => {
    const inspection = { followLive: false, selectedTraceEventId: "event-2" } as const;
    const before = renderActivityTraceSurface(makeCard(makeEvents(4)), inspection, { width: 72 }).join("\n");
    const after = renderActivityTraceSurface(makeCard(makeEvents(7)), inspection, { width: 72 }).join("\n");

    expect(before).toContain("Safe event 2");
    expect(after).toContain("Safe event 2");
    expect(after).toContain("Return to live");
    expect(after).not.toContain("Safe event 6");
  });

  it("degrades deterministically when no safe events are retained", () => {
    const lines = renderActivityTraceSurface(makeCard([]), { followLive: true }, { width: 40 });
    expect(lines).toEqual([
      "Activity trace · 0 events",
      "  No retained safe activity yet",
      "  ",
    ]);
  });

  it("keeps counters all-time when older projected history was omitted", () => {
    const card = {
      ...makeCard(makeEvents(3)),
      trace: {
        events: makeEvents(3),
        totalEvents: 12,
        categoryCounts: { ...emptyCounts(), terminal: 8, search: 3, plan: 1 },
        hasEarlierEvents: true,
      },
    };
    const text = renderActivityTraceSurface(card, { followLive: true }, { width: 72 }).join("\n");

    expect(text).toContain("Activity trace · 12 events");
    expect(text).toContain("< earlier history omitted");
    expect(text).toContain("Terminal ×8");
    expect(text).not.toContain("retained ·");
  });
});

const CATEGORIES: readonly TaskCardActivityState["category"][] = [
  "terminal",
  "search",
  "plan",
  "read",
  "edit",
  "answer",
  "wait",
  "finish",
  "failed",
];

function makeEvents(count: number): readonly TaskCardActivityState[] {
  return Array.from({ length: count }, (_, index) => ({
    eventId: `event-${index}`,
    kind: `safe-${index}`,
    label: `Safe event ${index}`,
    category: CATEGORIES[index % CATEGORIES.length]!,
    timestamp: `2026-07-20T10:00:${String(index % 60).padStart(2, "0")}.000Z`,
    stepId: "step-1",
    attemptId: "attempt-1",
    subagentIndex: 1,
  }));
}

function makeCard(events: readonly TaskCardActivityState[]): TaskCardState {
  return {
    taskId: "T-trace",
    objective: "Inspect the aggregate trace",
    status: "running",
    executionPreference: "auto",
    execution: "foreground",
    foregroundOwnerActive: true,
    backgroundContinuation: "available",
    progress: { completed: 0, skipped: 0, total: 1 },
    steps: [],
    subagents: [{
      stepId: "step-1",
      position: 0,
      displayIndex: 1,
      displayLabel: "Subagent 1",
      title: "Inspect trace",
      objective: "Inspect trace",
      role: "worker",
      status: "running",
      dependsOn: [],
      elapsedMs: 1_000,
      usage: { total: usage() },
      attempts: [],
      trace: events,
      results: [],
    }],
    trace: { events, totalEvents: events.length, categoryCounts: countEvents(events), hasEarlierEvents: false },
    childTasks: [],
    phase: {
      name: "delegating",
      workerProgress: { completed: 0, settled: 0, total: 1 },
    },
    recentActivity: events.slice(-3),
    elapsedMs: 1_000,
    usage: usage(),
    results: [],
    createdAt: "2026-07-20T10:00:00.000Z",
    updatedAt: "2026-07-20T10:00:01.000Z",
  };
}

function emptyCounts(): Record<TaskCardActivityState["category"], number> {
  return Object.fromEntries(CATEGORIES.map((category) => [category, 0])) as Record<
    TaskCardActivityState["category"],
    number
  >;
}

function countEvents(events: readonly TaskCardActivityState[]): Record<TaskCardActivityState["category"], number> {
  const counts = emptyCounts();
  for (const event of events) counts[event.category] += 1;
  return counts;
}

function usage(): TaskCardState["usage"] {
  return {
    providerCalls: 0,
    totalTokens: 0,
    usageComplete: true,
    pricingComplete: true,
  };
}

function stripAnsi(value: string): string {
  return value.replace(/\u001B\[[0-?]*[ -/]*[@-~]/gu, "");
}
