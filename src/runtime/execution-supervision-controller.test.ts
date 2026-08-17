import { describe, expect, it, vi } from "vitest";
import type { BrowserSnapshot, BrowserStateIdentity } from "../contracts/browser.js";
import type { ProviderResponse } from "../contracts/provider.js";
import type { ToolDefinition } from "../contracts/tool.js";
import type { ToolExecutionRecord } from "../tools/tool-executor.js";
import type { ProviderExecutionResult } from "../providers/provider-executor.js";
import { ExecutionEvidenceIndex } from "./execution-evidence-index.js";
import { ExecutionPlanController } from "./execution-plan-controller.js";
import { ExecutionPlanStore } from "./execution-plan-store.js";
import { ExecutionSupervisionController } from "./execution-supervision-controller.js";

describe("ExecutionSupervisionController", () => {
  it("owns Mission activation retries and the provisional fallback", async () => {
    const planController = new ExecutionPlanController(new ExecutionPlanStore());
    const supervision = createSupervision({
      userText: "Update the collection and then verify the resulting state.",
      visibleTurnId: "turn-activation",
      providerTools: [providerTool("plan"), providerTool("mcp.postman.updateCollection")],
      planController
    }).supervision;

    const firstPrompt = supervision.consumePromptState();
    expect(firstPrompt).toMatchObject({
      executionPlanActivationNudge: true,
      activationRestrictedRequest: true
    });

    await expect(supervision.superviseActivation({
      toolNames: ["mcp.postman.updateCollection"],
      activationRestrictedRequest: firstPrompt.activationRestrictedRequest,
      canRetry: true
    })).resolves.toEqual({ retryProvider: true });
    expect(planController.current()).toMatchObject({
      objective: "Update the collection and then verify the resulting state.",
      originTurnId: "turn-activation",
      items: [
        { id: "execute", status: "in_progress" },
        { id: "verify", status: "pending" }
      ]
    });
    expect(supervision.consumePromptState().retryInitialProviderRequest).toBe(true);
  });

  it("orchestrates causal authentication assessment and Mission effects", async () => {
    const evidenceIndex = new ExecutionEvidenceIndex();
    const planController = new ExecutionPlanController(new ExecutionPlanStore(), undefined, evidenceIndex);
    const before = loginSnapshot(identity(1, 1, 1));
    const submission = protectedExecution("submit-auth", before.identity, identity(2, 2, 2));
    evidenceIndex.record(submission);
    const { supervision, recordAuthenticationEvidenceAssessment } = createSupervision({
      userText: "Sign me in and then update the Postman collection.",
      visibleTurnId: "turn-auth",
      providerTools: [providerTool("plan"), providerTool("browser.fill_protected_form")],
      existingExecutions: [snapshotExecution("before-auth", before)],
      planController
    });

    await supervision.applyRuntimeMissionEffects({
      executions: [submission],
      providerToolNames: ["browser.fill_protected_form"]
    });

    expect(recordAuthenticationEvidenceAssessment).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "verified",
      submissionToolCallId: "submit-auth",
      evidenceToolCallId: "submit-auth"
    }));
    expect(planController.current()).toMatchObject({
      originTurnId: "turn-auth",
      items: expect.arrayContaining([
        expect.objectContaining({ id: "authentication.credentials", status: "completed" }),
        expect.objectContaining({ id: "authentication.verify", status: "completed" }),
        expect.objectContaining({ id: "authentication.continue", status: "in_progress" })
      ])
    });
  });

  it("owns browser semantic no-progress nudging and its deterministic stop receipt", async () => {
    const { supervision } = createSupervision({ maxRepeatedBrowserObservations: 3 });
    const snapshot = pageSnapshot(identity(1, 1, 1), "Account", []);

    supervision.assessProgress([snapshotExecution("snapshot-1", snapshot)]);
    supervision.assessProgress([snapshotExecution("snapshot-2", snapshot)]);
    expect(supervision.consumePromptState().browserNoProgressNudge).toBe(true);
    const assessment = supervision.assessProgress([snapshotExecution("snapshot-3", snapshot)]);

    expect(assessment.browserObservation).toMatchObject({ count: 3, shouldStop: true });
    expect(supervision.browserNoProgressStopReceipt(providerExecution()).response?.content).toContain(
      "repeated observations showed no state change"
    );
  });

  it("owns Mission progress nudging, stopping, and incomplete receipts", async () => {
    const planController = activePlan();
    const { supervision } = createSupervision({
      planController,
      noProgressNudgeIteration: 1,
      maxNoProgressIterations: 2
    });

    const first = supervision.assessProgress([]);
    expect(first.executionPlanProgress).toMatchObject({ shouldNudge: true, shouldStop: false });
    expect(supervision.consumePromptState().executionPlanProgressNudge).toBe(true);
    const second = supervision.assessProgress([]);
    expect(second.executionPlanProgress).toMatchObject({ noProgressIterations: 2, shouldStop: true });

    const receipt = supervision.executionPlanNoProgressStopReceipt(providerExecution());
    expect(supervision.executionPlanIncomplete).toBe(true);
    expect(receipt.response?.content).toContain("The Mission is incomplete.");
    expect(receipt.response?.content).toContain("2 consecutive iterations");
  });

  it("continues an unchanged Mission after a canonical browser state transition", () => {
    const planController = activePlan();
    const baseline = pageSnapshot(identity(4, 6, 10), "Apps", []);
    baseline.url = "https://portal.example.com/apps";
    baseline.tab = { ...baseline.tab!, url: baseline.url };
    const { supervision } = createSupervision({
      planController,
      existingExecutions: [snapshotExecution("apps-page", baseline)],
      noProgressNudgeIteration: 2,
      maxNoProgressIterations: 3
    });
    supervision.assessProgress([]);
    supervision.assessProgress([]);
    const planBefore = JSON.stringify(planController.current());
    const changed: BrowserSnapshot = {
      ...baseline,
      url: "https://portal.example.com/apps/example/edit",
      identity: identity(5, 7, 11),
      tab: { ...baseline.tab!, url: "https://portal.example.com/apps/example/edit" },
      actionDelta: {
        outcome: "dispatched-unverified",
        beforeIdentity: baseline.identity,
        afterIdentity: identity(5, 7, 11),
        waitCondition: "url",
        conditionMet: false,
        actionDispatched: true,
        settlementFailed: true,
        documentChangeObserved: true,
        stateObservation: "post-dispatch",
        url: {
          changed: true,
          before: baseline.url,
          after: "https://portal.example.com/apps/example/edit"
        }
      }
    };
    const transition = supervision.assessProgress([{
      ...snapshotExecution("open-edit", changed),
      tool: toolDefinition("browser.click")
    }]);

    expect(transition.executionPlanProgress).toMatchObject({
      materialProgress: true,
      progressKinds: ["browser-state-change"],
      noProgressIterations: 0,
      shouldStop: false
    });
    expect(JSON.stringify(planController.current())).toBe(planBefore);
    expect(supervision.assessProgress([]).executionPlanProgress).toMatchObject({
      noProgressIterations: 1,
      shouldStop: false
    });
  });

  it("owns user-input blocker receipts without exposing provider continuation", async () => {
    const store = new ExecutionPlanStore();
    store.replace({
      objective: "Sign in and continue",
      originTurnId: "turn-blocked",
      revision: 1,
      status: "active",
      items: [
        {
          id: "credentials",
          content: "Provide credentials",
          status: "blocked",
          blocker: { kind: "user_input_required", summary: "Provide the credentials in the secure prompt." }
        },
        { id: "continue", content: "Continue", status: "pending" }
      ]
    });
    const { supervision } = createSupervision({ planController: new ExecutionPlanController(store) });
    const assessment = supervision.assessProgress([]);

    expect(assessment.userInputBlocker?.summary).toBe("Provide the credentials in the secure prompt.");
    const receipt = supervision.userInputRequiredReceipt(providerExecution(), assessment.userInputBlocker!.summary);
    expect(receipt.toolCalls).toEqual([]);
    expect(receipt.response?.content).toBe(
      "The Mission needs your input before it can continue: Provide the credentials in the secure prompt."
    );
  });

  it("owns finalization eligibility and deadline receipts for unfinished Missions", async () => {
    const { supervision } = createSupervision({ planController: activePlan() });
    const progress = supervision.assessProgress([]);
    const continuation = supervision.finalizeProviderExecution({
      execution: providerExecution(),
      executionPlanProgress: progress.executionPlanProgress,
      canContinue: true
    });
    expect(continuation.continueExecutionPlan).toBe(true);
    expect(supervision.consumePromptState().executionPlanContinuation).toBe(true);

    const deadline = supervision.emergencyDeadlineReceipt(providerExecution());
    expect(supervision.executionPlanIncomplete).toBe(true);
    expect(deadline.response?.content).toContain("emergency deadline reserve");
  });
});

function createSupervision(input: {
  userText?: string;
  visibleTurnId?: string;
  providerTools?: ReturnType<typeof providerTool>[];
  existingExecutions?: ToolExecutionRecord[];
  planController?: ExecutionPlanController;
  maxRepeatedBrowserObservations?: number;
  noProgressNudgeIteration?: number;
  maxNoProgressIterations?: number;
} = {}) {
  const recordAuthenticationEvidenceAssessment = vi.fn(async () => undefined);
  return {
    recordAuthenticationEvidenceAssessment,
    supervision: new ExecutionSupervisionController({
      userText: input.userText ?? "Inspect the current state.",
      visibleTurnId: input.visibleTurnId,
      providerTools: input.providerTools ?? [],
      existingExecutions: input.existingExecutions ?? [],
      currentSessionId: () => "session-test",
      locale: "en",
      maxRepeatedBrowserObservations: input.maxRepeatedBrowserObservations ?? 3,
      noProgressNudgeIteration: input.noProgressNudgeIteration ?? 3,
      maxNoProgressIterations: input.maxNoProgressIterations ?? 6,
      executionPlanController: input.planController,
      runRecorder: { recordAuthenticationEvidenceAssessment }
    })
  };
}

function activePlan(): ExecutionPlanController {
  const store = new ExecutionPlanStore();
  store.replace({
    objective: "Build and verify",
    originTurnId: "turn-plan",
    revision: 1,
    status: "active",
    items: [
      { id: "build", content: "Build the collection", status: "in_progress" },
      { id: "verify", content: "Verify the collection", status: "pending" }
    ]
  });
  return new ExecutionPlanController(store);
}

function providerExecution(): ProviderExecutionResult {
  return {
    ok: true,
    fallbackUsed: false,
    attempts: [],
    toolCalls: [],
    response: {
      ok: true,
      content: "Provider response",
      model: "test-model",
      provider: "test-provider" as ProviderResponse["provider"]
    }
  };
}

function providerTool(name: string) {
  return {
    type: "function" as const,
    function: { name, description: name, parameters: { type: "object", properties: {} } }
  };
}

function protectedExecution(
  toolCallId: string,
  before: BrowserStateIdentity,
  after: BrowserStateIdentity
): ToolExecutionRecord {
  return {
    tool: toolDefinition("browser.fill_protected_form"),
    input: { tabRef: "@t1" },
    decision: "allow",
    riskClass: "external-side-effect",
    toolCallId,
    result: {
      ok: true,
      content: "safe protected browser receipt",
      metadata: {
        secureInputGroupReceipt: { status: "delivered" },
        protectedDelivery: {
          delivery: "delivered",
          submission: "clicked",
          documentChanged: true,
          challengeState: "departed",
          conditionMet: true,
          beforeIdentity: before,
          afterIdentity: after,
          sensitiveInputActive: false
        },
        snapshot: authenticatedSnapshot(after)
      }
    }
  };
}

function snapshotExecution(toolCallId: string, snapshot: BrowserSnapshot): ToolExecutionRecord {
  return {
    tool: toolDefinition("browser.snapshot"),
    decision: "allow",
    riskClass: "read-only-network",
    toolCallId,
    result: { ok: true, content: "safe snapshot", metadata: { snapshot } }
  };
}

function loginSnapshot(browserIdentity: BrowserStateIdentity): BrowserSnapshot {
  return pageSnapshot(browserIdentity, "Sign in", [
    { ref: "@e1", role: "textbox", name: "Email" },
    { ref: "@e2", role: "textbox", name: "Password" },
    { ref: "@e3", role: "button", name: "Log in" }
  ]);
}

function authenticatedSnapshot(browserIdentity: BrowserStateIdentity): BrowserSnapshot {
  return pageSnapshot(browserIdentity, "Account home", [
    { ref: "@e1", role: "link", name: "My profile" },
    { ref: "@e2", role: "button", name: "Sign out" }
  ]);
}

function pageSnapshot(
  browserIdentity: BrowserStateIdentity,
  title: string,
  elements: NonNullable<BrowserSnapshot["elements"]>
): BrowserSnapshot {
  return {
    sessionId: "browser-session",
    url: "https://portal.example.com/state",
    identity: browserIdentity,
    observedAt: "2030-01-01T00:00:00.000Z",
    title,
    text: title,
    tab: { ref: "@t1", url: "https://portal.example.com/state", title, controlled: true },
    elements
  };
}

function identity(documentEpoch: number, actionRevision: number, observationId: number): BrowserStateIdentity {
  return { documentEpoch, actionRevision, observationId };
}

function toolDefinition(name: string): ToolDefinition {
  return {
    name,
    description: name,
    inputSchema: {},
    riskClass: name === "browser.snapshot" ? "read-only-network" : "external-side-effect",
    toolsets: ["browser"],
    progressLabel: name,
    maxResultSizeChars: 8_000
  };
}
