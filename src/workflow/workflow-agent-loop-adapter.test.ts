import { describe, expect, it, vi } from "vitest";
import type { AgentLoop, AgentLoopInput, AgentLoopResponse } from "../runtime/agent-loop.js";
import { FakeWorkflowStore } from "./fake-workflow-store.js";
import { WorkflowAgentLoopAdapter } from "./workflow-agent-loop-adapter.js";
import type { WorkflowRun, WorkflowStep } from "./types.js";

describe("WorkflowAgentLoopAdapter workflow context", () => {
  it("passes workflow run, step, and metadata activation reason into AgentLoop", async () => {
    const agentLoop = fakeAgentLoop();
    const adapter = new WorkflowAgentLoopAdapter({
      agentLoop: agentLoop.instance,
      store: new FakeWorkflowStore()
    });

    await adapter.runTurn({
      run: makeRun({ activationReason: "playbook" }),
      step: makeStep("step-1"),
      text: "continue",
      channel: "cli"
    });

    expect(agentLoop.handle).toHaveBeenCalledWith(expect.objectContaining({
      text: "continue",
      channel: "cli",
      workflow: {
        runId: "run-1",
        stepId: "step-1",
        activationReason: "playbook"
      }
    }));
  });

  it("defaults missing activation metadata to explicit without throwing", async () => {
    const agentLoop = fakeAgentLoop();
    const adapter = new WorkflowAgentLoopAdapter({
      agentLoop: agentLoop.instance,
      store: new FakeWorkflowStore()
    });

    await adapter.runTurn({
      run: makeRun(),
      text: "continue",
      channel: "cli"
    });

    expect(agentLoop.handle).toHaveBeenCalledWith(expect.objectContaining({
      workflow: {
        runId: "run-1",
        activationReason: "explicit"
      }
    }));
    expect(agentLoop.handle.mock.calls[0]?.[0].workflow).not.toHaveProperty("stepId");
  });

  it("handles unsupported activation metadata conservatively", async () => {
    const agentLoop = fakeAgentLoop();
    const adapter = new WorkflowAgentLoopAdapter({
      agentLoop: agentLoop.instance,
      store: new FakeWorkflowStore()
    });

    await adapter.runTurn({
      run: makeRun({ activationReason: "surprise" }),
      text: "continue",
      channel: "cli"
    });

    expect(agentLoop.handle).toHaveBeenCalledWith(expect.objectContaining({
      workflow: {
        runId: "run-1",
        activationReason: "explicit"
      }
    }));
  });
});

function fakeAgentLoop() {
  const handle = vi.fn(async (_input: AgentLoopInput): Promise<AgentLoopResponse> => ({
    label: "Test",
    text: "ok",
    matchedSkills: [],
    intent: {
      nativeIntent: "general",
      labels: [],
      confidence: 1,
      suggestedToolsets: [],
      suggestedSkills: [],
      confirmationRequired: false,
      evidence: [],
      rationale: "test"
    },
    securityDecision: "allow",
    toolExecutions: [],
    toolPlans: [],
    skillOutcomes: [],
    artifacts: [],
    context: undefined,
    projectContext: undefined,
    progress: []
  }));

  return {
    handle,
    instance: {
      handle,
      get trajectoryId() {
        return "trajectory-1";
      }
    } as unknown as AgentLoop
  };
}

function makeRun(metadata: Record<string, unknown> = {}): WorkflowRun {
  return {
    id: "run-1",
    sessionId: "session-1",
    status: "running",
    intent: {
      nativeIntent: "general",
      labels: [],
      confidence: 1,
      suggestedToolsets: [],
      suggestedSkills: [],
      confirmationRequired: false,
      evidence: [],
      rationale: "test"
    },
    currentStepId: "step-1",
    createdAt: "2030-01-01T00:00:00.000Z",
    updatedAt: "2030-01-01T00:00:00.000Z",
    checkpointCount: 0,
    stepCount: 1,
    retryCount: 0,
    metadata
  };
}

function makeStep(id: string): WorkflowStep {
  return {
    id,
    runId: "run-1",
    index: 0,
    status: "running",
    name: "Step",
    description: "Step",
    toolPlans: [],
    executions: [],
    retryPolicy: {
      maxAttempts: 1,
      backoffMs: 0,
      backoffMultiplier: 1,
      retryableFailureClasses: [],
      nonRetryableFailureClasses: [],
      requireIdempotent: true
    },
    retryCount: 0,
    maxRetries: 0,
    idempotent: false,
    safeToRetry: false,
    failurePolicy: {
      defaultAction: "stop",
      stopOnNonRetryable: true,
      allowSkipIfSkippable: false
    },
    attemptNumber: 1,
    createdAt: "2030-01-01T00:00:00.000Z",
    updatedAt: "2030-01-01T00:00:00.000Z"
  };
}
