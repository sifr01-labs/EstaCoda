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

  it("nudges only once per active item even when later progress resets the counter", () => {
    const plan = activePlan();
    const guard = new ExecutionPlanProgressGuard({
      plan,
      noProgressNudgeIteration: 2,
      maxNoProgressIterations: 4
    });

    expect(guard.observe({ plan, executions: [] }).shouldNudge).toBe(false);
    expect(guard.observe({ plan, executions: [] }).shouldNudge).toBe(true);
    expect(guard.observe({ plan, executions: [execution({
      tool: { ...execution().tool, name: "mcp.postman.updateCollection", riskClass: "external-side-effect" },
      riskClass: "external-side-effect",
      input: { collectionId: "one" }
    })] })).toMatchObject({ materialProgress: true, noProgressIterations: 0 });
    expect(guard.observe({ plan, executions: [] }).shouldNudge).toBe(false);
    expect(guard.observe({ plan, executions: [] }).shouldNudge).toBe(false);
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
      progressKinds: ["verification"],
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

  it("bounds distinct discovery reads per active item and stops the MTN loop", () => {
    const plan = activePlan({
      objective: "Configure MTN products in Postman",
      items: [{ id: "inspect", content: "Inspect MTN products in Postman", status: "in_progress" }]
    });
    const guard = new ExecutionPlanProgressGuard({
      plan,
      noProgressNudgeIteration: 3,
      maxNoProgressIterations: 4
    });
    const steps = [
      execution({ tool: { ...execution().tool, name: "mcp.postman.getCollection" }, toolCallId: "collection-1" }),
      execution({ tool: { ...execution().tool, name: "mcp.postman.getWorkspaces" }, toolCallId: "workspaces-1" }),
      execution({ tool: { ...execution().tool, name: "browser.snapshot" }, toolCallId: "snapshot-1" }),
      execution({
        tool: { ...execution().tool, name: "mcp.postman.getCollection" },
        toolCallId: "collection-2",
        result: { ok: true, content: "a different representation of the same collection" }
      }),
      execution({ tool: { ...execution().tool, name: "browser.navigate" }, toolCallId: "navigate-1" }),
      execution({ tool: { ...execution().tool, name: "mcp.postman.getCollection" }, toolCallId: "collection-3" })
    ];

    const assessments = steps.map((step) => guard.observe({ plan, executions: [step] }));

    expect(assessments.map((entry) => entry.materialProgress)).toEqual([true, true, false, false, false, false]);
    expect(assessments.map((entry) => entry.noProgressIterations)).toEqual([0, 0, 1, 2, 3, 4]);
    expect(assessments.filter((entry) => entry.shouldNudge)).toHaveLength(1);
    expect(assessments.at(-1)).toMatchObject({
      progressKinds: ["incidental-observation"],
      shouldStop: true
    });
  });

  it("counts only the first verification observation for an active verification item", () => {
    const plan = activePlan({
      items: [{ id: "verify", content: "Verify the Postman collection", status: "in_progress" }]
    });
    const guard = new ExecutionPlanProgressGuard({
      plan,
      noProgressNudgeIteration: 3,
      maxNoProgressIterations: 6
    });

    expect(guard.observe({ plan, executions: [execution({
      tool: { ...execution().tool, name: "mcp.postman.getCollection" },
      toolCallId: "verify-1"
    })] })).toMatchObject({
      materialProgress: true,
      progressKinds: ["verification"]
    });
    expect(guard.observe({ plan, executions: [execution({
      tool: { ...execution().tool, name: "mcp.postman.getWorkspaces" },
      toolCallId: "verify-2"
    })] })).toMatchObject({
      materialProgress: false,
      progressKinds: ["incidental-observation"]
    });
    expect(guard.observe({ plan, executions: [execution({
      tool: { ...execution().tool, name: "browser.snapshot" },
      toolCallId: "verify-3"
    })] })).toMatchObject({
      materialProgress: false,
      progressKinds: ["incidental-observation"]
    });
    expect(guard.observe({ plan, executions: [execution({
      tool: { ...execution().tool, name: "browser.navigate" },
      toolCallId: "verify-4"
    })] })).toMatchObject({
      materialProgress: false,
      progressKinds: ["incidental-observation"]
    });
  });

  it("ignores no-op revisions and classifies a concrete blocker", () => {
    const plan = activePlan();
    const guard = new ExecutionPlanProgressGuard({
      plan,
      noProgressNudgeIteration: 3,
      maxNoProgressIterations: 6
    });
    const revisionOnly = activePlan({ revision: 2 });
    const blocked = activePlan({
      revision: 3,
      status: "blocked",
      items: [{
        id: "work",
        content: "Do the work",
        status: "blocked",
        blocker: { kind: "missing_capability", summary: "Postman mutation tool is unavailable" }
      }]
    });

    expect(guard.observe({ plan: revisionOnly, executions: [] })).toMatchObject({
      materialProgress: false,
      progressKinds: ["incidental-observation"]
    });
    expect(guard.observe({ plan: blocked, executions: [] })).toMatchObject({
      active: false,
      materialProgress: true,
      progressKinds: ["plan-transition", "concrete-blocker"]
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

  it("does not credit a successful mutation unrelated to the active item", () => {
    const plan = activePlan({
      items: [{ id: "update", content: "Update the Postman collection", status: "in_progress" }]
    });
    const guard = new ExecutionPlanProgressGuard({
      plan,
      noProgressNudgeIteration: 3,
      maxNoProgressIterations: 6
    });
    const unrelated = execution({
      tool: { ...execution().tool, name: "mcp.github.updateIssue", riskClass: "external-side-effect" },
      riskClass: "external-side-effect",
      targetKey: "github:issue",
      input: { issue: 42 },
      toolCallId: "unrelated-update"
    });
    const relevant = execution({
      tool: { ...execution().tool, name: "mcp.postman.updateCollection", riskClass: "external-side-effect" },
      riskClass: "external-side-effect",
      targetKey: "postman:collection",
      input: { collectionId: "collection" },
      toolCallId: "postman-write"
    });

    expect(guard.observe({ plan, executions: [unrelated] })).toMatchObject({
      materialProgress: false,
      progressKinds: ["incidental-observation"]
    });
    expect(guard.observe({ plan, executions: [relevant] })).toMatchObject({
      materialProgress: true,
      progressKinds: ["target-mutation"],
      noProgressIterations: 0
    });
  });

  it("credits only browser actions whose settled delta confirms a state change", () => {
    const plan = activePlan({
      items: [{ id: "configure", content: "Configure the browser form", status: "in_progress" }]
    });
    const guard = new ExecutionPlanProgressGuard({
      plan,
      noProgressNudgeIteration: 3,
      maxNoProgressIterations: 6
    });
    const browserAction = (
      outcome: "changed" | "no-change" | "timeout",
      callId: string,
      tool = "browser.click"
    ) => execution({
      tool: { ...execution().tool, name: tool },
      toolCallId: callId,
      result: {
        ok: true,
        content: outcome,
        metadata: { snapshot: { actionDelta: { outcome } } }
      }
    });

    expect(guard.observe({ plan, executions: [browserAction("no-change", "no-change")] })).toMatchObject({
      materialProgress: false,
      progressKinds: ["incidental-observation"]
    });
    expect(guard.observe({ plan, executions: [browserAction("timeout", "timeout")] })).toMatchObject({
      materialProgress: false,
      progressKinds: ["incidental-observation"]
    });
    expect(guard.observe({ plan, executions: [browserAction("changed", "changed")] })).toMatchObject({
      materialProgress: true,
      progressKinds: ["target-mutation"]
    });
    expect(guard.observe({ plan, executions: [browserAction("changed", "select-changed", "browser.select")] })).toMatchObject({
      materialProgress: true,
      progressKinds: ["target-mutation"]
    });
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

  it("does not credit cosmetic browser snapshot changes", () => {
    const plan = activePlan({
      items: [{ id: "inspect", content: "Inspect the account page", status: "in_progress" }]
    });
    const guard = new ExecutionPlanProgressGuard({
      plan,
      noProgressNudgeIteration: 3,
      maxNoProgressIterations: 6
    });
    const first = execution({
      tool: { ...execution().tool, name: "browser.snapshot" },
      targetKey: "browser-session:account",
      toolCallId: "snapshot-1",
      result: { ok: true, content: "Notifications: 1; timestamp: 10:00" }
    });
    const cosmetic = execution({
      tool: { ...execution().tool, name: "browser.snapshot" },
      targetKey: "browser-session:account",
      toolCallId: "snapshot-2",
      result: { ok: true, content: "Notifications: 2; timestamp: 10:01" }
    });

    expect(guard.observe({ plan, executions: [first] }).materialProgress).toBe(true);
    expect(guard.observe({ plan, executions: [cosmetic] })).toMatchObject({
      materialProgress: false,
      progressKinds: ["incidental-observation"],
      noProgressIterations: 1
    });
  });
});
