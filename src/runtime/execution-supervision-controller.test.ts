import { describe, expect, it, vi } from "vitest";
import type { BrowserSnapshot, BrowserStateIdentity } from "../contracts/browser.js";
import type { ProviderResponse } from "../contracts/provider.js";
import type { RuntimeEventSink } from "../contracts/runtime-event.js";
import type { ToolDefinition } from "../contracts/tool.js";
import type { ToolExecutionRecord } from "../tools/tool-executor.js";
import type { ProviderExecutionResult } from "../providers/provider-executor.js";
import { ExecutionEvidenceIndex } from "./execution-evidence-index.js";
import { ExecutionPlanController } from "./execution-plan-controller.js";
import { ExecutionPlanStore } from "./execution-plan-store.js";
import { ExecutionSupervisionController } from "./execution-supervision-controller.js";

describe("ExecutionSupervisionController", () => {
  it("creates the provisional Mission before provider work without an activation retry", async () => {
    const planController = new ExecutionPlanController(new ExecutionPlanStore());
    const supervision = createSupervision({
      userText: "Update the collection and then verify the resulting state.",
      visibleTurnId: "turn-activation",
      providerTools: [providerTool("plan"), providerTool("mcp.postman.updateCollection")],
      planController
    }).supervision;

    await supervision.initialize();
    expect(planController.current()).toMatchObject({
      objective: "Update the collection and then verify the resulting state.",
      originTurnId: "turn-activation",
      provenance: { source: "runtime", provisional: true, sessionId: "session-test" },
      items: [
        { id: "execute", status: "in_progress" },
        { id: "verify", status: "pending" }
      ]
    });
    expect(planController.current()?.revision).toBe(1);
    await supervision.initialize();
    expect(planController.current()?.revision).toBe(1);
    expect(supervision.consumePromptState()).toEqual({
      browserNoProgressNudge: false,
      toolLoopProgressNudge: false
    });
    expect(supervision.observeReasoningOnly()).toMatchObject({
      active: false,
      materialProgress: false,
      progressKinds: [],
      noProgressIterations: 0
    });
    await expect(supervision.superviseActivation(["mcp.postman.updateCollection"])).resolves.toBeUndefined();
    expect(planController.current()?.revision).toBe(1);
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

  it("emits authentication lifecycle events without allowing observers to interrupt execution", async () => {
    const before = loginSnapshot(identity(1, 1, 1));
    const submission = protectedExecution("submit-auth", before.identity, identity(2, 2, 2));
    const onEvent = vi.fn<RuntimeEventSink>()
      .mockRejectedValueOnce(new Error("observer unavailable"))
      .mockResolvedValue(undefined);
    const { supervision } = createSupervision({
      userText: "Sign me in.",
      providerTools: [providerTool("plan"), providerTool("browser.fill_protected_form")],
      existingExecutions: [snapshotExecution("before-auth", before)],
      planController: new ExecutionPlanController(new ExecutionPlanStore()),
      onEvent,
    });

    await expect(supervision.applyRuntimeMissionEffects({
      executions: [submission],
      providerToolNames: ["browser.fill_protected_form"],
    })).resolves.toBeUndefined();

    expect(onEvent).toHaveBeenCalledWith({
      kind: "authentication-lifecycle",
      stage: "credentials-submitted",
      toolCallId: "submit-auth",
    });
    expect(onEvent).toHaveBeenCalledWith({
      kind: "authentication-lifecycle",
      stage: "verification-pending",
      toolCallId: "submit-auth",
    });
    expect(onEvent).toHaveBeenCalledWith({
      kind: "authentication-lifecycle",
      stage: "authenticated",
      toolCallId: "submit-auth",
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

  it("owns tool-loop progress nudging and stopping without Mission state", async () => {
    const { supervision } = createSupervision({
      noProgressNudgeIteration: 1,
      maxNoProgressIterations: 2
    });

    expect(supervision.assessProgress([readExecution("read-1")]).toolLoopProgress).toMatchObject({
      materialProgress: true,
      noProgressIterations: 0
    });
    const firstRepeat = supervision.assessProgress([readExecution("read-2")]);
    expect(firstRepeat.toolLoopProgress).toMatchObject({ shouldNudge: true, shouldStop: false });
    expect(supervision.consumePromptState().toolLoopProgressNudge).toBe(true);
    const secondRepeat = supervision.assessProgress([readExecution("read-3")]);
    expect(secondRepeat.toolLoopProgress).toMatchObject({ noProgressIterations: 2, shouldStop: true });

    const receipt = supervision.toolLoopNoProgressStopReceipt(providerExecution());
    expect(supervision.executionPlanIncomplete).toBe(false);
    expect(receipt.response?.content).not.toContain("Mission");
    expect(receipt.response?.content).toContain("2 consecutive iterations");
  });

  it("recognizes a canonical browser state transition without consulting Mission state", () => {
    const baseline = pageSnapshot(identity(4, 6, 10), "Apps", []);
    baseline.url = "https://portal.example.com/apps";
    baseline.tab = { ...baseline.tab!, url: baseline.url };
    const { supervision } = createSupervision({
      existingExecutions: [snapshotExecution("apps-page", baseline)],
      noProgressNudgeIteration: 2,
      maxNoProgressIterations: 3
    });
    supervision.assessProgress([]);
    supervision.assessProgress([]);
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

    expect(transition.toolLoopProgress).toMatchObject({
      materialProgress: true,
      progressKinds: ["new-tool-result"],
      noProgressIterations: 0,
      shouldStop: false
    });
    expect(supervision.assessProgress([]).toolLoopProgress).toMatchObject({
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

  it("stops on the first missing capability with localized deterministic receipts", () => {
    const store = new ExecutionPlanStore();
    store.replace({
      objective: "Provision the destination",
      originTurnId: "turn-capability",
      revision: 1,
      status: "blocked",
      items: [{
        id: "update",
        content: "Update destination",
        status: "blocked",
        blocker: { kind: "missing_capability", summary: "stored English fallback" }
      }],
      requirements: [{
        id: "destination-write",
        itemId: "update",
        tool: "mcp.target.update",
        capability: "mutate"
      }],
      capabilityPreflight: {
        status: "blocked",
        assessments: [{
          requirementId: "destination-write",
          itemId: "update",
          tool: "mcp.target.update",
          capability: "mutate",
          status: "missing",
          reasonCode: "tool_missing"
        }]
      }
    });

    for (const [locale, expected] of [
      ["en", 'The Mission stopped before substantive work because a required capability is unavailable: Required tool "mcp.target.update" is not exposed to this session.'],
      ["ar", 'توقفت خطة التنفيذ قبل بدء العمل لأن قدرة مطلوبة غير متاحة: الأداة المطلوبة "mcp.target.update" غير متاحة في هذه الجلسة.']
    ] as const) {
      const { supervision } = createSupervision({
        planController: new ExecutionPlanController(store),
        locale
      });
      const blocker = supervision.assessProgress([]).missingCapabilityBlocker;
      expect(blocker).toBeDefined();
      expect(supervision.missingCapabilityReceipt(providerExecution(), blocker!.summary).response?.content).toBe(expected);
      expect(supervision.executionPlanIncomplete).toBe(true);
    }
  });

  it("uses a plan-independent deadline receipt", async () => {
    const { supervision } = createSupervision({ planController: activePlan() });
    const deadline = supervision.emergencyDeadlineReceipt(providerExecution());
    expect(supervision.executionPlanIncomplete).toBe(false);
    expect(deadline.response?.content).toContain("emergency deadline reserve");
    expect(deadline.response?.content).not.toContain("Mission");
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
  locale?: "en" | "ar";
  onEvent?: RuntimeEventSink;
} = {}) {
  const recordAuthenticationEvidenceAssessment = vi.fn(async () => undefined);
  return {
    recordAuthenticationEvidenceAssessment,
    supervision: new ExecutionSupervisionController({
      userText: input.userText ?? "Inspect the current state.",
      visibleTurnId: input.visibleTurnId,
      foregroundTurnId: input.visibleTurnId ?? "turn-runtime",
      providerTools: input.providerTools ?? [],
      existingExecutions: input.existingExecutions ?? [],
      currentSessionId: () => "session-test",
      locale: input.locale ?? "en",
      maxRepeatedBrowserObservations: input.maxRepeatedBrowserObservations ?? 3,
      noProgressNudgeIteration: input.noProgressNudgeIteration ?? 3,
      maxNoProgressIterations: input.maxNoProgressIterations ?? 6,
      executionPlanController: input.planController,
      runRecorder: { recordAuthenticationEvidenceAssessment },
      onEvent: input.onEvent,
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

function readExecution(toolCallId: string): ToolExecutionRecord {
  return {
    tool: {
      name: "mcp.postman.getCollection",
      description: "Read collection",
      inputSchema: {},
      riskClass: "read-only-network",
      toolsets: ["mcp"],
      progressLabel: "reading",
      maxResultSizeChars: 8_000
    },
    input: { collectionId: "collection-1" },
    decision: "allow",
    riskClass: "read-only-network",
    toolCallId,
    executionEffect: { kind: "read", connector: { kind: "mcp", id: "postman" } },
    result: { ok: true, content: "same collection state" }
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
