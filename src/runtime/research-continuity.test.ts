import { describe, expect, it } from "vitest";
import { validateRequestRequirements } from "../contracts/request-requirements.js";
import { hydratableExecutionCheckpoint } from "../session/execution-checkpoint-state.js";
import { ExecutionCheckpointController } from "./execution-checkpoint-controller.js";
import { continueRequestRequirements, deriveRequestRequirements, requirementFollowUp } from "./request-requirements.js";
import { answer, createResearchWorkflowHarness } from "../test/fakes/research-workflow-harness.js";

const objective = "Find recent battery papers. Use three subagents. Save report.md";
const requirements = deriveRequestRequirements(objective, "original-turn");

describe("bounded research requirement continuity", () => {
  it("retains topic requirements for reruns and reduces save-only follow-ups to file output", () => {
    const text = "Rerun this task but use the research skill.";
    expect(requirementFollowUp(text, requirements)).toBe("rerun");
    expect(continueRequestRequirements(requirements, deriveRequestRequirements(text), "rerun")).toMatchObject({
      delegation: { count: 3 }, research: { domain: "literature", fresh: true }, skillReferences: ["research"]
    });
    expect(requirementFollowUp("Please prepare a markdown file", requirements)).toBe("save");
    expect(continueRequestRequirements(requirements, deriveRequestRequirements("Save result.md"), "save")).toEqual({
      skillReferences: [], issues: [], fileOutput: { format: "markdown", path: "result.md", directoryUnspecified: true }
    });
    for (const text of ['He said "rerun this task"', "Do not rerun this task", "Write a new poem in poem.md", "Save a file about cats in cats.md", "Clear this file scratch.txt"]) {
      expect(requirementFollowUp(text, requirements)).toBeUndefined();
    }
  });

  it.each(["continue", "Try again", "Continue with two workers instead", "تابع التقرير"])("retains genuine follow-up context: %s", async text => {
    const controller = new ExecutionCheckpointController({ sessionId: "session", profileId: "profile" });
    await controller.ensure({ originTurnId: "original-turn", originalObjective: objective, qualificationReasons: ["research_request"],
      requestRequirements: requirements, intentLabels: [], requiredOperations: ["read"], connectorIds: [], completionFloor: "none" });
    expect((await controller.prepareForTurn(text)).disposition).not.toBe("superseded");
  });

  it("rejects malformed, oversized, absolute-path and forged satisfaction state", () => {
    expect(validateRequestRequirements(requirements)).toEqual(requirements);
    for (const input of [
      { ...requirements, satisfied: true }, { ...requirements, skillReferences: Array(5).fill("research") },
      { ...requirements, delegation: { count: Infinity } }, { ...requirements, research: { domain: "unknown", fresh: true } },
      { ...requirements, fileOutput: { format: "markdown", path: "/private/report.md" } },
      { ...requirements, fileOutput: { format: "markdown", path: "../report.md" } }
    ]) expect(() => validateRequestRequirements(input)).toThrow();
  });

  it("replays only immutable requirements in a coherent owned checkpoint chain", async () => {
    const events: import("../contracts/session.js").SessionEvent[] = [];
    const controller = new ExecutionCheckpointController({ sessionId: "session", profileId: "profile", record: async (event) => { events.push(event); } });
    const created = await controller.ensure({ originTurnId: "original-turn", originalObjective: objective, qualificationReasons: ["research_request"],
      requestRequirements: requirements, intentLabels: ["research"], requiredOperations: ["read"], connectorIds: [], completionFloor: "none" });
    events.push({ kind: "execution-checkpoint-updated", transition: "corrected", checkpoint: { ...created, revision: 2, requestRequirements: { ...requirements, delegation: { count: 1 } } } });
    const restored = hydratableExecutionCheckpoint({ events, sessionId: "session", profileId: "profile" })!;
    expect(restored.requestRequirements?.delegation?.count).toBe(3);
    expect(hydratableExecutionCheckpoint({ events, sessionId: "session", profileId: "other" })).toBeUndefined();
    const restarted = new ExecutionCheckpointController({ sessionId: "session", profileId: "profile" });
    restarted.hydrate(restored);
    expect(await restarted.prepareForTurn("Rerun this task with the research skill.")).toMatchObject({ disposition: "requirement_followup", requirementMode: "rerun" });
    expect(restarted.current()?.status).toBe("superseded");
  });

  it("retains requirements across a runtime restart and clears research on a save-only follow-up", async () => {
    const h = await createResearchWorkflowHarness();
    try {
      h.enqueue(answer("No file was written."), answer("No file was written."), answer("No file was written."));
      await h.turn(objective);
      await h.restart();
      h.enqueue(answer("No new evidence was collected."), answer("No new evidence was collected."), answer("No new evidence was collected."));
      const rerun = await h.turn("Rerun this task but use the research skill.");
      expect(rerun.intent.requestRequirements).toMatchObject({ delegation: { count: 3 }, research: { fresh: true }, skillReferences: ["research"] });
      expect(h.requests.at(-1)?.messages.some((message) => typeof message.content === "string" && message.content.includes("battery"))).toBe(true);
      h.enqueue(answer("The file has not been saved."), answer("The file has not been saved."), answer("The file has not been saved."));
      const save = await h.turn("Please prepare a markdown file");
      expect(save.intent.requestRequirements?.research).toBeUndefined();
      expect(save.intent.requestRequirements?.delegation).toBeUndefined();
      expect(save.intent.requestRequirements?.fileOutput).toBeDefined();
      expect(h.scriptErrors).toEqual([]);
    } finally { await h.dispose(); }
  });

  it("answers an unrelated question after restart without replaying the old research contract", async () => {
    const h = await createResearchWorkflowHarness();
    try {
      h.enqueue(answer("No file was written."), answer("No file was written."), answer("No file was written."));
      await h.turn(objective);
      await h.restart();
      h.enqueue(answer("30%"));
      const result = await h.turn("What percentage is 30 out of 100? No tools.");
      expect(result.text).toBe("30%");
      expect(result.intent.requestRequirements?.research).toBeUndefined();
      expect(result.intent.requestRequirements?.delegation).toBeUndefined();
      expect(result.intent.requestRequirements?.fileOutput).toBeUndefined();
      expect(result.finalOutcome?.status).toBe("completed");
      expect(result.toolExecutions).toHaveLength(0);
      expect(h.scriptErrors).toEqual([]);
      expect(h.remainingSteps()).toBe(0);
    } finally { await h.dispose(); }
  });

  it.each(["cancel", "Research ocean temperatures.", "ابحث عن درجات حرارة المحيط", "What percentage is 30 out of 100?", "كم يساوي ٣٠ من ١٠٠؟"])("does not carry requirements into %s", async (text) => {
    const controller = new ExecutionCheckpointController({ sessionId: "session", profileId: "profile" });
    await controller.ensure({ originTurnId: "original-turn", originalObjective: objective, qualificationReasons: ["research_request"],
      requestRequirements: requirements, intentLabels: [], requiredOperations: ["read"], connectorIds: [], completionFloor: "none" });
    expect((await controller.prepareForTurn(text)).disposition).toBe(text === "cancel" ? "cancelled" : "superseded");
    expect((await controller.prepareForTurn("continue")).disposition).toBe("none");
  });
  it.each(["cancel", "New topic: write a poem", "What percentage is 30 out of 100?"])("retires completed requirements durably on %s", async (text) => {
    const events: import("../contracts/session.js").SessionEvent[] = [];
    const controller = new ExecutionCheckpointController({ sessionId: "session", profileId: "profile", record: async (event) => { events.push(event); } });
    const created = await controller.ensure({ originTurnId: "original-turn", originalObjective: objective, qualificationReasons: ["research_request"],
      requestRequirements: requirements, intentLabels: [], requiredOperations: ["read"], connectorIds: [], completionFloor: "none" });
    const outcome = { status: "completed" as const, terminationCause: "normal" as const, completionFloor: "none" as const, confirmedActions: [], uncertainActions: [] };
    events.push({ kind: "execution-evidence-recorded", toolCallId: "read-result", tool: "task.result.read",
      status: "success", riskClass: "read-only-local", executionEffect: { kind: "read" } });
    events.push({ kind: "execution-final-outcome-recorded", ...outcome });
    await controller.settleAttempt(created.revision, { outcome });
    expect(controller.current()?.status).toBe("completed");
    await controller.prepareForTurn(text);
    const restored = hydratableExecutionCheckpoint({ events, sessionId: "session", profileId: "profile" })!;
    expect(restored.status).toBe(text === "cancel" ? "cancelled" : "superseded");
    controller.hydrate(restored);
    expect((await controller.prepareForTurn("Save this report to report.md")).disposition).toBe("none");
  });

});
