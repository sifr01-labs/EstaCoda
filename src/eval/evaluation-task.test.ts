import { describe, expect, it } from "vitest";
import { EVALUATION_METRICS, parseEvaluationTask } from "./evaluation-task.js";

const baseTask = {
  id: "vision-ocr",
  title: "Vision OCR",
  channel: "provider",
  evidence: "implemented but not live-proven",
  goal: "Measure OCR reliability.",
  steps: ["Run the fixture."],
  assertions: ["Text is accurate."]
};

describe("parseEvaluationTask", () => {
  it("defaults optional live-evaluation fields without changing legacy tasks", () => {
    expect(parseEvaluationTask(JSON.stringify(baseTask), "task.json")).toEqual({
      ...baseTask,
      prompt: undefined,
      prerequisites: [],
      notes: [],
      optIn: false,
      fixtures: [],
      metrics: []
    });
  });

  it("accepts opt-in fixtures and the governed metric vocabulary", () => {
    const parsed = parseEvaluationTask(JSON.stringify({
      ...baseTask,
      optIn: true,
      fixtures: ["evals/fixtures/vision/english-ocr.png"],
      metrics: EVALUATION_METRICS
    }), "vision.json");

    expect(parsed.optIn).toBe(true);
    expect(parsed.fixtures).toEqual(["evals/fixtures/vision/english-ocr.png"]);
    expect(parsed.metrics).toEqual(EVALUATION_METRICS);
  });

  it("rejects unknown metrics instead of silently dropping evidence", () => {
    expect(() => parseEvaluationTask(JSON.stringify({
      ...baseTask,
      metrics: ["quality_vibes"]
    }), "vision.json")).toThrow("Unsupported eval metric in vision.json: quality_vibes");
  });

  it("rejects invalid channels and opt-in flags", () => {
    expect(() => parseEvaluationTask(JSON.stringify({
      ...baseTask,
      channel: "browser"
    }), "vision.json")).toThrow("Invalid eval task channel");
    expect(() => parseEvaluationTask(JSON.stringify({
      ...baseTask,
      optIn: "yes"
    }), "vision.json")).toThrow("Invalid eval task optIn flag");
  });
});
