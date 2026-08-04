import { describe, expect, it } from "vitest";
import { resolveTokens } from "../../../theme/token-resolver.js";
import {
  createOperatorConsoleStyle,
  deriveTaskStageModel,
  renderTaskStageSurface,
  type TaskCardState,
} from "./index.js";

describe("Task stage command center", () => {
  it("keeps degraded worker outcomes separate from the active synthesis stage", () => {
    const card = makeSynthesisCard();
    const model = deriveTaskStageModel(card);

    expect(model.current).toBe("synthesis");
    expect(model.stages).toEqual([
      { name: "plan", status: "completed" },
      { name: "subagents", status: "warning" },
      { name: "synthesis", status: "active" },
      { name: "deliver", status: "pending" },
    ]);
    expect(model.workerOutcomes).toEqual({ usable: 1, failed: 2, cancelled: 0, total: 3 });
  });

  it("renders wide, medium, and narrow hierarchies without exposing orchestration jargon", () => {
    const card = makeSynthesisCard();
    const wide = renderTaskStageSurface(card, { width: 120 }).join("\n");
    const medium = renderTaskStageSurface(card, { width: 80 }).join("\n");
    const narrow = renderTaskStageSurface(card, { width: 48 }).join("\n");
    const widePlain = stripBidi(wide);

    expect(widePlain).toContain("Research recursive improvement");
    expect(widePlain).toContain("SYNTHESIZING");
    expect(widePlain).toContain("Task #task_05f70fba");
    expect(widePlain).toContain("1 usable report · 2 failed");
    expect(widePlain).toContain("Plan ✓ ─── Subagents ⚠ ─── Synthesis ● ─── Deliver ○");
    expect(widePlain).toContain("Elapsed 12:37 · Est. provider cost $0.55 · 84.7k tokens");
    expect(medium.split("\n")).toHaveLength(3);
    expect(narrow.split("\n")).toHaveLength(2);
    expect(wide).not.toContain("Delegated Task");
    expect(wide).not.toContain("settled");
  });

  it("preserves Arabic labels and deterministic plain rendering", () => {
    const style = createOperatorConsoleStyle({
      tokens: resolveTokens("plain", "dark", "kemetBlue"),
      capabilities: { supportsColor: true, supportsTrueColor: true },
    });
    const text = renderTaskStageSurface(makeSynthesisCard(), {
      width: 100,
      locale: "ar",
      style,
    }).join("\n");

    expect(text).toContain("التخطيط [OK]");
    expect(text).toContain("الوكلاء الفرعيون !");
    expect(text).toContain("التجميع -");
    expect(stripBidi(text)).toContain("نتائج صالحة: 1 · فشل: 2");
    expect(text).toContain("⁨المهمة #task_05f70fba⁩");
    expect(text).not.toMatch(/\u001B\[/u);
  });
});

function makeSynthesisCard(): TaskCardState {
  const usage = {
    providerCalls: 4,
    totalTokens: 84_700,
    estimatedCostUsd: 0.55,
    usageComplete: true,
    pricingComplete: true,
  };
  return {
    taskId: "task_05f70fba-a0dd-4c99-b76e-af176fbaeb17",
    objective: "Research recursive improvement",
    status: "running",
    executionPreference: "auto",
    execution: "foreground",
    foregroundOwnerActive: true,
    backgroundContinuation: "available",
    progress: { completed: 2, skipped: 0, total: 3 },
    planRevision: { revision: 1, status: "active" },
    steps: [{
      stepId: "synthesis",
      position: 2,
      title: "Synthesize reports",
      objective: "Synthesize reports",
      executorRole: "synthesis",
      status: "running",
      dependsOn: ["worker-1", "worker-2"],
      childTaskPolicy: "forbid",
      usage,
      attempts: [],
    }],
    subagents: [],
    trace: { events: [], spans: [], hasEarlierEvents: false },
    childTasks: [],
    phase: {
      name: "synthesizing",
      workerProgress: {
        completed: 1,
        failed: 2,
        cancelled: 0,
        settled: 3,
        usable: 1,
        recovered: 0,
        total: 3,
      },
    },
    recentActivity: [],
    elapsedMs: 757_000,
    usage,
    results: [],
    createdAt: "2026-08-04T10:00:00.000Z",
    updatedAt: "2026-08-04T10:12:37.000Z",
  };
}

function stripBidi(value: string): string {
  return value.replace(/[\u2066-\u2069]/gu, "");
}
