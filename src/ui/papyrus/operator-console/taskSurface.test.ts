import { describe, expect, it } from "vitest";
import { resolveTokens } from "../../../theme/token-resolver.js";
import {
  createOperatorConsoleStyle,
  createInitialOperatorConsoleState,
  createOperatorConsoleLayout,
  getTaskCardSurfaceDesiredHeight,
  renderOperatorConsoleTextLines,
  renderTaskCardSurface,
  renderTaskInspectionSurface,
  subagentInspectionContentLines,
  taskInspectionContentLines,
  resolveOperatorConsoleInputSurface,
  routeTaskSurfaceKey,
  type TaskCardState,
  type TaskCardSubagentState,
} from "./index.js";

describe("durable Task surfaces", () => {
  it("renders one Subagent as exactly seven borderless grey rows with semantic title and truthful footer", () => {
    const style = createOperatorConsoleStyle({
      tokens: resolveTokens("standard", "dark", "kemetBlue"),
      capabilities: { supportsColor: true, supportsTrueColor: true },
    });
    const card = makeCard({
      subagents: [makeSubagent(1, {
        assistantPreview: "I found the relevant comparison data.",
        trace: Array.from({ length: 5 }, (_, index) => ({
          eventId: `event-${index}`,
          kind: "tool-result",
          label: `Safe activity ${index + 1}`,
          category: index % 2 === 0 ? "read" : "search",
          timestamp: `2026-07-20T10:00:0${index}.000Z`,
          subagentIndex: 1,
        })),
      })],
    });
    const lines = renderTaskCardSurface({ cards: [card], selectedTaskId: card.taskId, scrollOffset: 0 }, {
      width: 72,
      isTty: true,
      focusedTaskId: card.taskId,
      style,
      motionElapsedMs: 105,
    });
    const text = stripAnsi(lines.join("\n"));

    expect(lines).toHaveLength(8);
    expect(lines.slice(1)).toHaveLength(7);
    expect(text).toContain("Task 1/1");
    expect(text).toContain("Subagent 1 · Research Company 1");
    expect(text).toContain("+3 earlier activities");
    expect(text).toContain("I found the relevant comparison data.");
    expect(text).toContain("running · 03:18 · 100 tokens · $0.0060");
    expect(text).not.toMatch(/[╭╮╰╯│]/u);
    expect(lines.slice(1).every((line) => line.includes("\x1b[48;2;37;37;37m"))).toBe(true);
    expect(lines[0]).toContain("\x1b[38;2;64;224;208m");
    expect(lines[1]).toContain("\x1b[38;2;78;161;255m");
    expect(lines.every((line) => visibleWidth(line) <= 72)).toBe(true);
  });

  it("uses column-major 1-3 | 4-6 placement, equal widths, and +N more instead of squeezing", () => {
    const four = makeCard({ subagents: Array.from({ length: 4 }, (_, index) => makeSubagent(index + 1)) });
    const wide = renderTaskCardSurface({ cards: [four], scrollOffset: 0 }, { width: 100, isTty: true });

    expect(getTaskCardSurfaceDesiredHeight({ cards: [four], scrollOffset: 0 }, 100)).toBe(24);
    expect(wide).toHaveLength(24);
    expect(wide[1]).toContain("Subagent 1");
    expect(wide[1]).toContain("Subagent 4");
    expect(wide[9]).toContain("Subagent 2");
    expect(wide[17]).toContain("Subagent 3");
    expect(wide.every((line) => visibleWidth(line) === 100)).toBe(true);

    const narrow = renderTaskCardSurface({ cards: [four], scrollOffset: 0 }, { width: 72, isTty: true });
    const narrowText = narrow.join("\n");
    expect(getTaskCardSurfaceDesiredHeight({ cards: [four], scrollOffset: 0 }, 72)).toBe(25);
    expect(narrowText).toContain("Subagent 1");
    expect(narrowText).toContain("Subagent 2");
    expect(narrowText).toContain("Subagent 3");
    expect(narrowText).not.toContain("Subagent 4 ·");
    expect(narrowText).toContain("+1 more Subagents");
  });

  it("adds a third column only when seven Subagents remain readable", () => {
    const card = makeCard({ subagents: Array.from({ length: 7 }, (_, index) => makeSubagent(index + 1)) });
    const threeColumns = renderTaskCardSurface({ cards: [card], scrollOffset: 0 }, { width: 140, isTty: true });
    const twoColumns = renderTaskCardSurface({ cards: [card], scrollOffset: 0 }, { width: 100, isTty: true });

    expect(threeColumns[1]).toContain("Subagent 1");
    expect(threeColumns[1]).toContain("Subagent 4");
    expect(threeColumns[1]).toContain("Subagent 7");
    expect(threeColumns.join("\n")).not.toContain("more Subagents");
    expect(twoColumns.join("\n")).toContain("+1 more Subagents");
  });

  it("never clips a visible card below seven rows and uses a compact tiny-terminal fallback", () => {
    const card = makeCard({ subagents: Array.from({ length: 4 }, (_, index) => makeSubagent(index + 1)) });
    const constrained = renderTaskCardSurface({ cards: [card], scrollOffset: 0 }, { width: 100, height: 9 });
    const tiny = renderTaskCardSurface({ cards: [card], scrollOffset: 0 }, { width: 36, height: 5 });

    expect(constrained).toHaveLength(9);
    expect(constrained.join("\n")).toContain("Subagent 1");
    expect(constrained.join("\n")).toContain("Subagent 2");
    expect(constrained.join("\n")).toContain("+2 more Subagents");
    expect(tiny).toHaveLength(5);
    expect(tiny.join("\n")).toContain("Subagent 1 · running");
    expect(tiny.join("\n")).toContain("Subagent 4 · running");
    expect(tiny.join("\n")).not.toMatch(/[╭╮╰╯│]/u);
  });

  it("updates the latest safe activity without changing stable Subagent identity", () => {
    const first = makeCard({ subagents: [makeSubagent(1, { currentActivity: "Reading package.json" })] });
    const next = makeCard({ subagents: [makeSubagent(1, { currentActivity: "Editing dashboard route" })] });
    const before = renderTaskCardSurface({ cards: [first], scrollOffset: 0 }, { width: 72 }).join("\n");
    const after = renderTaskCardSurface({ cards: [next], scrollOffset: 0 }, { width: 72 }).join("\n");

    expect(before).toContain("Subagent 1");
    expect(after).toContain("Subagent 1");
    expect(before).toContain("Reading package.json");
    expect(after).toContain("Editing dashboard route");
    expect(after).not.toContain("Reading package.json");
  });

  it("uses light surface tokens and degrades to deterministic ASCII in plain mode", () => {
    const lightStyle = createOperatorConsoleStyle({
      tokens: resolveTokens("standard", "light", "kemetBlue"),
      capabilities: { supportsColor: true, supportsTrueColor: true },
    });
    const plainStyle = createOperatorConsoleStyle({
      tokens: resolveTokens("plain", "dark", "kemetBlue"),
      capabilities: { supportsColor: true, supportsTrueColor: true },
    });
    const card = makeCard({ subagents: [makeSubagent(1)] });
    const light = renderTaskCardSurface({ cards: [card], scrollOffset: 0 }, { width: 72, style: lightStyle });
    const plain = renderTaskCardSurface({ cards: [card], scrollOffset: 0 }, { width: 72, style: plainStyle });

    expect(light.slice(1).every((line) => line.includes("\x1b[48;2;245;245;245m"))).toBe(true);
    expect(plain.join("\n")).not.toMatch(/\u001B\[/u);
    expect(plain.join("\n")).toContain(". Subagent 1");
    expect(plain.join("\n")).toContain("> Reading company 1");
    expect(plain.every((line) => visibleWidth(line) === 72)).toBe(true);
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
    }, { width: 80, height: 52, isTty: true });
    const text = lines.join("\n");

    expect(text).toContain("Competitor comparison");
    expect(text).toContain("Activity trace");
    expect(text).toContain("Subagent 1");
    expect(text).toContain("Plan Steps");
    expect(text).toContain("after Research Company A");
    expect(text).toContain("Approvals");
    expect(text).toContain("Blockers");
    expect(text).toContain("Child Tasks");
    expect(text).toContain("T-child-1");
    expect(text).toContain("running");
    expect(text).toContain("Task spending");
    expect(text).toContain("Reserved: $0.18");
    expect(text).toContain("result://safe-1");
    expect(text).toContain("1 of 3 Steps settled");
    expect(text).not.toMatch(/\d+%/u);
    expect(text).not.toContain("raw tool input");
    expect(text).not.toContain("worker-session-secret");
  });

  it("renders one Subagent's filtered safe trace, results, dependencies, and retry Attempts", () => {
    const firstAttempt = {
      attemptId: "attempt-b-1",
      taskId: "T-104",
      stepId: "step-b",
      attemptNumber: 1,
      status: "failed" as const,
      createdAt: "2026-07-20T09:58:00.000Z",
      updatedAt: "2026-07-20T09:59:00.000Z",
      startedAt: "2026-07-20T09:58:00.000Z",
      completedAt: "2026-07-20T09:59:00.000Z",
      elapsedMs: 60_000,
      assistantPreview: "Recovered a partial comparison.",
      usage: cardUsage(0.004),
    };
    const secondAttempt = {
      ...firstAttempt,
      attemptId: "attempt-b-2",
      attemptNumber: 2,
      status: "running" as const,
      completedAt: undefined,
      elapsedMs: 90_000,
      currentActivity: "Reading the comparison table",
      assistantPreview: "The retry has validated both sources.",
      usage: cardUsage(0.008),
    };
    const inspected = makeSubagent(2, {
      stepId: "step-b",
      displayLabel: "Subagent 2",
      objective: "Validate comparison criteria",
      dependsOn: ["step-a"],
      currentActivity: "Reading the comparison table",
      assistantPreview: "The retry has validated both sources.",
      attempts: [firstAttempt, secondAttempt],
      activeAttempt: secondAttempt,
      latestAttempt: secondAttempt,
      trace: [
        { eventId: "b-read", kind: "tool", label: "Read comparison.md", category: "read", timestamp: "2026-07-20T10:01:00.000Z", stepId: "step-b", attemptId: "attempt-b-2", subagentIndex: 2 },
        { eventId: "b-answer", kind: "assistant", label: "Summarized validated criteria", category: "answer", timestamp: "2026-07-20T10:02:00.000Z", stepId: "step-b", attemptId: "attempt-b-2", subagentIndex: 2 },
      ],
      results: [{
        id: "result-b",
        handle: "result://comparison-b",
        kind: "file",
        disposition: "accepted",
        status: "available",
        byteLength: 512,
        primary: true,
        stepId: "step-b",
        attemptId: "attempt-b-2",
        summary: "Validated comparison table",
      }],
    });
    const card = makeCard({
      subagents: [makeSubagent(1, {
        trace: [{ eventId: "a-secret", kind: "tool", label: "Other Subagent activity", category: "search", timestamp: "2026-07-20T10:00:00.000Z", stepId: "step-a", subagentIndex: 1 }],
      }), inspected],
    });
    const state = {
      cards: [card],
      inspectedTaskId: card.taskId,
      inspection: {
        followLive: false,
        selectedTraceEventId: "event-attempt-started",
        selectedSubagentStepId: "step-b",
        inspectedSubagentStepId: "step-b",
        subagentTrace: { followLive: false, selectedTraceEventId: "b-read" },
      },
      scrollOffset: 0,
    } as const;
    const text = renderTaskInspectionSurface(state, { width: 100, height: 44 }).join("\n");

    expect(text).toContain("Main session / Task ⁨T-104⁩ / Subagent 2");
    expect(text).toContain("Validate comparison criteria");
    expect(text).toContain("Subagent total · running · 03:18 · 100 tokens · $0.01");
    expect(text).toContain("Attempt 2 · running · 01:30 · 100 tokens · $0.0080");
    expect(text).toContain("Current activity");
    expect(text).toContain("Reading the comparison table");
    expect(text).toContain("Read comparison.md");
    expect(text).toContain("Summarized validated criteria");
    expect(text).not.toContain("Other Subagent activity");
    expect(text).toContain("The retry has validated both sources.");
    expect(text).toContain("result://comparison-b");
    expect(text).toContain("Attempt 1 · failed");
    expect(text).toContain("Attempt 2 · running · current");
    expect(text).toContain("Research Company A");
    expect(text).not.toContain("worker-session-secret");

    expect(subagentInspectionContentLines(card, inspected, 48, { locale: "en" })).toContain("Retained safe activity");
    const narrow = renderTaskInspectionSurface(state, { width: 48, height: 44 });
    expect(narrow.every((line) => visibleWidth(line) <= 48)).toBe(true);
  });

  it("places Subagents and Plan side by side when wide and stacks them when narrow", () => {
    const card = makeCard();
    const wide = taskInspectionContentLines(card, 120, "en");
    const narrow = taskInspectionContentLines(card, 72, "en");
    const wideSection = wide.find((line) => line.includes("Subagents"));

    expect(wideSection).toContain("Plan Steps");
    expect(narrow.indexOf("Subagents")).toBeLessThan(narrow.indexOf("Plan Steps"));
    expect(narrow.slice(narrow.indexOf("Subagents"), narrow.indexOf("Plan Steps"))).toContain("");
  });

  it("surfaces factual approvals and blockers without inventing progress", () => {
    const base = makeCard();
    const card = makeCard({
      status: "waiting_for_approval",
      waitReason: "Approval required before publishing",
      steps: base.steps.map((step) => step.stepId === "step-a"
        ? { ...step, status: "waiting_for_approval" as const }
        : step.stepId === "step-c"
          ? { ...step, status: "waiting_for_input" as const }
          : step),
    });
    const text = taskInspectionContentLines(card, 100, "en").join("\n");

    expect(text).toContain("Approvals");
    expect(text).toContain("Research Company A");
    expect(text).toContain("Blockers");
    expect(text).toContain("Approval required before publishing");
    expect(text).toContain("Compare findings · waiting for input");
    expect(text).not.toMatch(/\d+%/u);
  });

  it("uses brand, accent, trace, and severity tokens throughout the Task workspace", () => {
    const style = createOperatorConsoleStyle({
      tokens: resolveTokens("standard", "dark", "kemetBlue"),
      capabilities: { supportsColor: true, supportsTrueColor: true },
    });
    const card = makeCard();
    const lines = renderTaskInspectionSurface({
      cards: [card],
      inspectedTaskId: card.taskId,
      inspection: { followLive: true },
      scrollOffset: 0,
    }, { width: 100, height: 30, style });
    const output = lines.join("\n");

    expect(output).toContain("\x1b[38;2;67;137;215m");
    expect(output).toContain("\x1b[38;2;78;161;255m");
    expect(output).toContain("\x1b[38;2;184;153;255m");
    expect(output).toContain("\x1b[38;2;90;172;255m");
  });

  it("separates recovered output from accepted Results and explains its failed status", () => {
    const lines = taskInspectionContentLines(makeCard({
      results: [
        {
          id: "result-accepted",
          handle: "task-result:accepted",
          kind: "text",
          disposition: "accepted",
          status: "available",
          byteLength: 12,
          primary: true
        },
        {
          id: "result-diagnostic",
          handle: "task-result:diagnostic",
          kind: "text",
          disposition: "diagnostic",
          status: "available",
          byteLength: 18,
          primary: false
        }
      ]
    }), 100, "en").join("\n");

    expect(lines).toContain("Recovered output");
    expect(lines).toContain("task-result:diagnostic");
    expect(lines).toContain("May be incomplete; it was not accepted as a successful result");
    expect(lines.indexOf("task-result:accepted")).toBeLessThan(lines.indexOf("Recovered output"));
  });

  it("keeps retained Task card cost honest for partial and unavailable accounting", () => {
    const partial = makeCard({
      subagents: [makeSubagent(1, { usage: { total: partialCardUsage(0.84, 2_400) } })],
      usage: partialCardUsage(0.84, 2_400),
    });
    const unavailable = makeCard({
      taskId: "T-105",
      subagents: [makeSubagent(1, { usage: { total: unavailableCardUsage() } })],
      usage: {
        providerCalls: 1,
        totalTokens: 0,
        usageComplete: false,
        pricingComplete: false,
      },
    });

    expect(renderTaskCardSurface({ cards: [partial], scrollOffset: 0 }, { width: 72, isTty: true }).join("\n"))
      .toContain("≥ $0.84");
    expect(renderTaskCardSurface({ cards: [unavailable], scrollOffset: 0 }, { width: 72, isTty: true }).join("\n"))
      .toContain("unavailable");
    const partialInspection = renderTaskInspectionSurface({
      cards: [partial],
      selectedTaskId: partial.taskId,
      inspectedTaskId: partial.taskId,
      scrollOffset: 0,
    }, { width: 72, height: 52, isTty: true }).join("\n");
    expect(partialInspection).toContain("≥ $0.84");
    expect(partialInspection).toContain("Some provider pricing was unavailable");
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

    state = routeTaskSurfaceKey(state, { type: "key", key: "left" }).state;
    expect(state.tasks.inspection).toMatchObject({ followLive: false, selectedTraceEventId: "event-attempt-started" });
    state = routeTaskSurfaceKey(state, { type: "key", key: "end" }).state;
    expect(state.tasks.inspection).toMatchObject({ followLive: true });
    state = routeTaskSurfaceKey(state, { type: "key", key: "pagedown" }).state;
    expect(state.tasks.scrollOffset).toBeGreaterThan(0);
    state = routeTaskSurfaceKey(state, { type: "key", key: "pageup" }).state;
    state = routeTaskSurfaceKey(state, { type: "key", key: "escape" }).state;
    expect(state.tasks.inspectedTaskId).toBeUndefined();
    expect(state.focus.target).toEqual({ kind: "taskCard", taskId: "T-104" });
  });

  it("opens the selected Subagent by stable Step ID and unwinds Subagent to Task to main session", () => {
    const first = makeSubagent(1, {
      trace: [
        { eventId: "first-1", kind: "read", label: "Read one", category: "read", timestamp: "2026-07-20T10:00:00.000Z", stepId: "step-1", subagentIndex: 1 },
        { eventId: "first-2", kind: "answer", label: "Answered one", category: "answer", timestamp: "2026-07-20T10:01:00.000Z", stepId: "step-1", subagentIndex: 1 },
      ],
    });
    const second = makeSubagent(2, {
      trace: [
        { eventId: "second-1", kind: "read", label: "Read two", category: "read", timestamp: "2026-07-20T10:00:00.000Z", stepId: "step-2", subagentIndex: 2 },
        { eventId: "second-2", kind: "answer", label: "Answered two", category: "answer", timestamp: "2026-07-20T10:01:00.000Z", stepId: "step-2", subagentIndex: 2 },
      ],
    });
    const card = makeCard({ subagents: [first, second] });
    let state = createInitialOperatorConsoleState({
      terminal: { width: 80, height: 20, isTty: true },
      tasks: { cards: [card], selectedTaskId: card.taskId, scrollOffset: 0 },
    });

    state = routeTaskSurfaceKey(state, { type: "key", key: "tab" }).state;
    state = routeTaskSurfaceKey(state, { type: "key", key: "enter" }).state;
    state = routeTaskSurfaceKey(state, { type: "key", key: "left" }).state;
    const taskTraceSelection = state.tasks.inspection?.selectedTraceEventId;
    state = routeTaskSurfaceKey(state, { type: "key", key: "down" }).state;
    expect(state.tasks.inspection?.selectedSubagentStepId).toBe("step-2");
    expect(state.focus.target).toEqual({ kind: "taskSubagent", taskId: "T-104", stepId: "step-2" });

    state = routeTaskSurfaceKey(state, { type: "key", key: "enter" }).state;
    expect(state.tasks.inspection?.inspectedSubagentStepId).toBe("step-2");
    expect(renderTaskInspectionSurface(state.tasks, { width: 80, height: 20 }).join("\n"))
      .toContain("Main session / Task ⁨T-104⁩ / Subagent 2");
    state = routeTaskSurfaceKey(state, { type: "key", key: "left" }).state;
    expect(state.tasks.inspection?.subagentTrace).toEqual({ followLive: false, selectedTraceEventId: "second-1" });

    const refreshedCard = { ...card, subagents: [second, first] };
    state = { ...state, tasks: { ...state.tasks, cards: [refreshedCard] } };
    expect(renderTaskInspectionSurface(state.tasks, { width: 80, height: 20 }).join("\n"))
      .toContain("Subagent 2");

    state = routeTaskSurfaceKey(state, { type: "key", key: "escape" }).state;
    expect(state.tasks.inspection?.inspectedSubagentStepId).toBeUndefined();
    expect(state.tasks.inspection?.selectedTraceEventId).toBe(taskTraceSelection);
    expect(state.tasks.inspectedTaskId).toBe("T-104");
    state = routeTaskSurfaceKey(state, { type: "key", key: "escape" }).state;
    expect(state.tasks.inspectedTaskId).toBeUndefined();
    expect(state.focus.target).toEqual({ kind: "taskCard", taskId: "T-104" });
  });

  it("keeps Subagent accounting truthful and its Arabic plain view width-bounded", () => {
    const partial = makeSubagent(1, {
      objective: "مراجعة النتائج",
      usage: { total: partialCardUsage(0.84, 2_400) },
      currentActivity: "قراءة التقرير",
    });
    const unavailable = makeSubagent(2, {
      usage: { total: unavailableCardUsage() },
    });
    const partialCard = makeCard({ subagents: [partial] });
    const unavailableCard = makeCard({ subagents: [unavailable] });
    const detailState = (card: TaskCardState) => ({
      cards: [card],
      inspectedTaskId: card.taskId,
      inspection: {
        followLive: true,
        selectedSubagentStepId: card.subagents[0]!.stepId,
        inspectedSubagentStepId: card.subagents[0]!.stepId,
        subagentTrace: { followLive: true },
      },
      scrollOffset: 0,
    });

    const partialText = renderTaskInspectionSurface(detailState(partialCard), {
      width: 52,
      height: 28,
      locale: "ar",
    });
    const unavailableText = renderTaskInspectionSurface(detailState(unavailableCard), {
      width: 72,
      height: 20,
    }).join("\n");

    expect(partialText.join("\n")).toContain("إجمالي الوكيل الفرعي");
    expect(subagentInspectionContentLines(partialCard, partial, 80, { locale: "ar" }).join("\n"))
      .toContain("≥ $0.84");
    expect(partialText.join("\n")).toContain("قراءة التقرير");
    expect(partialText.join("\n")).toContain("\u2068Subagent 1\u2069");
    expect(partialText.every((line) => visibleWidth(line) <= 52)).toBe(true);
    expect(partialText.join("\n")).not.toMatch(/\u001B\[/u);
    expect(unavailableText).toContain("unavailable");
    expect(unavailableText).not.toContain("$0.0000");
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

    expect(text).toContain("المهمة");
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
        position: 0,
        title: "Research Company A",
        objective: "Research Company A",
        executorRole: "worker",
        status: "running",
        dependsOn: [],
        childTaskPolicy: "forbid",
        usage: cardUsage(0.006),
        attempts: [{
          attemptId: "attempt-a-1",
          taskId: "T-104",
          stepId: "step-a",
          attemptNumber: 1,
          status: "running",
          workerSessionId: "worker-a",
          createdAt: "2026-07-20T10:00:00.000Z",
          updatedAt: "2026-07-20T10:03:18.000Z",
          startedAt: "2026-07-20T10:00:00.000Z",
          elapsedMs: 198_000,
          currentActivity: "Browsing",
          currentToolCategory: "browser",
          usage: cardUsage(0.006)
        }],
        activeAttempt: {
          attemptId: "attempt-a-1",
          taskId: "T-104",
          stepId: "step-a",
          attemptNumber: 1,
          status: "running",
          workerSessionId: "worker-a",
          createdAt: "2026-07-20T10:00:00.000Z",
          updatedAt: "2026-07-20T10:03:18.000Z",
          startedAt: "2026-07-20T10:00:00.000Z",
          elapsedMs: 198_000,
          currentActivity: "Browsing",
          currentToolCategory: "browser",
          usage: cardUsage(0.006)
        },
      },
      { stepId: "step-b", position: 1, title: "Define comparison criteria", objective: "Define comparison criteria", executorRole: "worker", status: "completed", dependsOn: [], childTaskPolicy: "forbid", usage: cardUsage(0.0063), attempts: [] },
      { stepId: "step-c", position: 2, title: "Compare findings", objective: "Compare findings", executorRole: "synthesis", status: "pending", dependsOn: ["step-a", "step-b"], childTaskPolicy: "forbid", usage: cardUsage(0), attempts: [] },
    ],
    subagents: [{
      stepId: "step-a",
      position: 0,
      displayIndex: 1,
      displayLabel: "Subagent 1",
      title: "Research Company A",
      objective: "Research Company A",
      role: "worker",
      status: "running",
      dependsOn: [],
      elapsedMs: 198_000,
      currentActivity: "Browsing",
      currentToolCategory: "browser",
      usage: { total: cardUsage(0.006), currentAttempt: cardUsage(0.006) },
      attempts: [],
      trace: [],
      results: []
    }],
    trace: {
      events: [{
        eventId: "event-attempt-started",
        kind: "attempt-started",
        label: "Attempt started · Research Company A",
        category: "plan",
        timestamp: "2026-07-20T10:00:00.000Z",
        stepId: "step-a",
        attemptId: "attempt-a-1",
        subagentIndex: 1
      }],
      hasEarlierEvents: false
    },
    childTasks: [],
    recentActivity: [
      { eventId: "event-attempt-started", kind: "attempt-started", label: "Attempt started · Research Company A", category: "plan", timestamp: "2026-07-20T10:00:00.000Z" },
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
    spending: {
      spentCostUsd: 0.42,
      reservedCostUsd: 0.18,
      remainingCostUsd: 0.4,
      maxEstimatedCostUsd: 1,
      warningThresholdPercent: 80,
      state: "available"
    },
    results: [{
      id: "result-safe-1",
      handle: "result://safe-1",
      kind: "artifact",
      disposition: "accepted",
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

function cardUsage(estimatedCostUsd: number): TaskCardState["usage"] {
  return {
    providerCalls: estimatedCostUsd > 0 ? 1 : 0,
    totalTokens: estimatedCostUsd > 0 ? 100 : 0,
    estimatedCostUsd,
    usageComplete: true,
    pricingComplete: true
  };
}

function partialCardUsage(estimatedCostUsd: number, totalTokens: number): TaskCardState["usage"] {
  return {
    providerCalls: 3,
    totalTokens,
    estimatedCostUsd,
    usageComplete: true,
    pricingComplete: false,
  };
}

function unavailableCardUsage(): TaskCardState["usage"] {
  return {
    providerCalls: 1,
    totalTokens: 0,
    usageComplete: false,
    pricingComplete: false,
  };
}

function makeSubagent(
  index: number,
  overrides: Partial<TaskCardSubagentState> = {}
): TaskCardSubagentState {
  const usage = cardUsage(0.006 * index);
  return {
    stepId: `step-${index}`,
    position: index - 1,
    displayIndex: index,
    displayLabel: `Subagent ${index}`,
    title: `Research Company ${index}`,
    objective: `Research Company ${index}`,
    role: "worker",
    status: "running",
    dependsOn: [],
    elapsedMs: 198_000,
    currentActivity: `Reading company ${index}`,
    currentToolCategory: "read",
    usage: { total: usage, currentAttempt: usage },
    attempts: [],
    trace: [],
    results: [],
    ...overrides,
  };
}

function visibleWidth(value: string): number {
  return [...stripAnsi(value).replace(/[\u2066-\u2069]/gu, "")].length;
}

function stripAnsi(value: string): string {
  return value.replace(/\u001B\[[0-?]*[ -/]*[@-~]/gu, "");
}
