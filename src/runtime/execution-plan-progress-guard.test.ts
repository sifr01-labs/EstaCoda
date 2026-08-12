import { describe, expect, it } from "vitest";
import type { ExecutionPlan } from "../contracts/execution-plan.js";
import type { ToolExecutionRecord } from "../tools/tool-executor.js";
import { ExecutionPlanProgressGuard } from "./execution-plan-progress-guard.js";

function activePlan(overrides: Partial<ExecutionPlan> = {}): ExecutionPlan {
  return {
    objective: "Complete the mission",
    originTurnId: "turn-1",
    revision: 1,
    status: "active",
    items: [{ id: "work", content: "Do the work", status: "in_progress" }],
    ...overrides
  };
}

function execution(overrides: Partial<ToolExecutionRecord> = {}): ToolExecutionRecord {
  return {
    tool: {
      name: "web.extract",
      description: "Read a page",
      inputSchema: {},
      riskClass: "read-only-network",
      toolsets: ["web"],
      progressLabel: "reading",
      maxResultSizeChars: 1_000
    },
    decision: "allow",
    riskClass: "read-only-network",
    toolCallId: "call-1",
    result: { ok: true, content: "new evidence" },
    ...overrides
  };
}

describe("ExecutionPlanProgressGuard", () => {
  it("nudges at three and stops at six no-progress iterations", () => {
    const plan = activePlan();
    const guard = new ExecutionPlanProgressGuard({
      plan,
      noProgressNudgeIteration: 3,
      maxNoProgressIterations: 6
    });

    const assessments = Array.from({ length: 6 }, () => guard.observe({ plan, executions: [] }));

    expect(assessments.map((assessment) => assessment.noProgressIterations)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(assessments.filter((assessment) => assessment.shouldNudge)).toHaveLength(1);
    expect(assessments.at(-1)?.shouldStop).toBe(true);
  });

  it("resets after a plan transition and successful new evidence", () => {
    const plan = activePlan();
    const guard = new ExecutionPlanProgressGuard({
      plan,
      noProgressNudgeIteration: 3,
      maxNoProgressIterations: 6
    });
    guard.observe({ plan, executions: [] });
    guard.observe({ plan, executions: [] });

    const transitioned = activePlan({
      revision: 2,
      items: [
        { id: "work", content: "Do the work", status: "completed", evidenceCallIds: ["call-work"], evidence: [{
          toolCallId: "call-work",
          tool: "web.extract",
          outcome: "success",
          riskClass: "read-only-network"
        }] },
        { id: "verify", content: "Verify", status: "in_progress" }
      ]
    });
    expect(guard.observe({ plan: transitioned, executions: [] })).toMatchObject({
      materialProgress: true,
      noProgressIterations: 0
    });
    expect(guard.observe({ plan: transitioned, executions: [execution()] })).toMatchObject({
      materialProgress: true,
      noProgressIterations: 0
    });
    expect(guard.observe({
      plan: transitioned,
      executions: [execution({ toolCallId: "call-2" })]
    })).toMatchObject({
      materialProgress: false,
      noProgressIterations: 1
    });
  });

  it("counts successful mutations but not repeated failures or plan reads", () => {
    const plan = activePlan();
    const guard = new ExecutionPlanProgressGuard({
      plan,
      noProgressNudgeIteration: 3,
      maxNoProgressIterations: 6
    });
    const mutation = execution({
      tool: { ...execution().tool, name: "mcp.postman.updateCollection", riskClass: "external-side-effect" },
      riskClass: "external-side-effect",
      toolCallId: "mutation-1"
    });
    expect(guard.observe({ plan, executions: [mutation] }).materialProgress).toBe(true);
    expect(guard.observe({ plan, executions: [mutation] }).materialProgress).toBe(false);
    expect(guard.observe({
      plan,
      executions: [execution({ result: { ok: false, content: "same failure" } })]
    }).materialProgress).toBe(false);
    expect(guard.observe({
      plan,
      executions: [execution({ tool: { ...execution().tool, name: "plan" } })]
    }).materialProgress).toBe(false);
  });

  it("keeps content-derived fingerprints in memory-only assessments", () => {
    const secret = "private-browser-page-token";
    const plan = activePlan();
    const guard = new ExecutionPlanProgressGuard({
      plan,
      noProgressNudgeIteration: 3,
      maxNoProgressIterations: 6
    });

    const assessment = guard.observe({ plan, executions: [execution({
      tool: { ...execution().tool, name: "browser.snapshot" },
      result: { ok: true, content: secret }
    })] });

    expect(JSON.stringify(assessment)).not.toContain(secret);
  });
});
