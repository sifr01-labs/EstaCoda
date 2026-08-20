import { describe, expect, it, vi } from "vitest";
import type { BrowserSnapshot, BrowserStateIdentity } from "../contracts/browser.js";
import type { ProviderResponse } from "../contracts/provider.js";
import type { RuntimeEventSink } from "../contracts/runtime-event.js";
import type { ToolDefinition } from "../contracts/tool.js";
import type { ToolExecutionRecord } from "../tools/tool-executor.js";
import type { ProviderExecutionResult } from "../providers/provider-executor.js";
import { ExecutionSupervisionController } from "./execution-supervision-controller.js";

describe("ExecutionSupervisionController", () => {
  it("initializes supervision without creating or requiring an execution plan", async () => {
    const supervision = createSupervision({ foregroundTurnId: "turn-runtime" }).supervision;

    await supervision.initialize();
    await supervision.initialize();
    expect(supervision.consumePromptState()).toEqual({
      browserEvidenceNudge: false,
      browserRetargetNudge: false,
      suppressedBrowserTools: [],
      toolLoopProgressNudge: false
    });
    expect(supervision.observeReasoningOnly()).toMatchObject({
      active: false,
      materialProgress: false,
      progressKinds: [],
      noProgressIterations: 0
    });
  });

  it("orchestrates causal authentication assessment without creating Mission state", async () => {
    const before = loginSnapshot(identity(1, 1, 1));
    const submission = protectedExecution("submit-auth", before.identity, identity(2, 2, 2));
    const { supervision, recordAuthenticationEvidenceAssessment } = createSupervision({
      existingExecutions: [snapshotExecution("before-auth", before)]
    });

    await supervision.applyRuntimeEffects({ executions: [submission] });

    expect(recordAuthenticationEvidenceAssessment).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "verified",
      submissionToolCallId: "submit-auth",
      evidenceToolCallId: "submit-auth"
    }));
    expect(supervision.assessProgress([]).runtimeUserInputBlocker).toBeUndefined();
  });

  it("emits authentication lifecycle events without allowing observers to interrupt execution", async () => {
    const before = loginSnapshot(identity(1, 1, 1));
    const submission = protectedExecution("submit-auth", before.identity, identity(2, 2, 2));
    const onEvent = vi.fn<RuntimeEventSink>()
      .mockRejectedValueOnce(new Error("observer unavailable"))
      .mockResolvedValue(undefined);
    const { supervision } = createSupervision({
      existingExecutions: [snapshotExecution("before-auth", before)],
      onEvent,
    });

    await expect(supervision.applyRuntimeEffects({ executions: [submission] })).resolves.toBeUndefined();

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

  it("owns evidence-aware browser nudging, focused suppression, and its deterministic stop receipt", async () => {
    const { supervision } = createSupervision({ maxRepeatedBrowserObservations: 3 });
    const snapshot = pageSnapshot(identity(1, 1, 1), "Account", []);

    supervision.assessProgress([snapshotExecution("snapshot-1", snapshot)]);
    supervision.assessProgress([snapshotExecution("snapshot-2", snapshot)]);
    expect(supervision.consumePromptState()).toMatchObject({
      browserEvidenceNudge: true,
      browserRetargetNudge: false,
      suppressedBrowserTools: ["browser.snapshot"]
    });
    const assessment = supervision.assessProgress([snapshotExecution("snapshot-3", snapshot)]);
    expect(assessment.browserObservation).toMatchObject({ count: 2, shouldStop: true });
    expect(assessment.terminationCause).toBe("browser_no_progress");
    expect(supervision.browserNoProgressStopReceipt(providerExecution()).response?.content).toContain(
      "repeated without a new grounded strategy"
    );
  });

  it("owns one bounded retarget prompt when target resolution dispatches no action", () => {
    const { supervision } = createSupervision({ maxRepeatedBrowserObservations: 3 });
    const failedTarget: ToolExecutionRecord = {
      tool: toolDefinition("browser.click"),
      input: { locator: { text: "TikTok Connect" } },
      decision: "allow",
      riskClass: "read-only-network",
      result: {
        ok: false,
        content: "Browser locator did not match a current element.",
        metadata: {
          reason: "browser-target-not-found",
          currentIdentity: identity(1, 1, 1)
        }
      }
    };

    expect(supervision.assessProgress([failedTarget]).terminationCause).toBeUndefined();

    expect(supervision.consumePromptState()).toMatchObject({
      browserEvidenceNudge: true,
      browserRetargetNudge: true,
      suppressedBrowserTools: []
    });
    expect(supervision.assessProgress([failedTarget]).terminationCause).toBe("browser_no_progress");
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
    expect(secondRepeat.terminationCause).toBe("tool_loop_no_progress");

    const receipt = supervision.toolLoopNoProgressStopReceipt(providerExecution());
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

  it("owns trusted runtime user-input blocker receipts without Mission state", async () => {
    const { supervision } = createSupervision();
    await supervision.applyRuntimeEffects({
      executions: [cancelledProtectedExecution("call-cancelled")]
    });
    const assessment = supervision.assessProgress([]);

    expect(assessment.runtimeUserInputBlocker?.summary).toBe("The required authentication credentials were not provided.");
    expect(assessment.terminationCause).toBe("user_input_required");
    const receipt = supervision.runtimeUserInputRequiredReceipt(
      providerExecution(),
      assessment.runtimeUserInputBlocker!.summary
    );
    expect(receipt.toolCalls).toEqual([]);
    expect(receipt.response?.content).toBe(
      "Authentication needs your input before the runtime can continue: The required authentication credentials were not provided."
    );
  });

  it("uses a plan-independent deadline receipt", async () => {
    const { supervision } = createSupervision();
    const deadline = supervision.emergencyDeadlineReceipt(providerExecution());
    expect(deadline.response?.content).toContain("emergency deadline reserve");
    expect(deadline.response?.content).not.toContain("Mission");
  });
});

function createSupervision(input: {
  foregroundTurnId?: string;
  existingExecutions?: ToolExecutionRecord[];
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
      foregroundTurnId: input.foregroundTurnId ?? "turn-runtime",
      existingExecutions: input.existingExecutions ?? [],
      currentSessionId: () => "session-test",
      locale: input.locale ?? "en",
      maxRepeatedBrowserObservations: input.maxRepeatedBrowserObservations ?? 3,
      noProgressNudgeIteration: input.noProgressNudgeIteration ?? 3,
      maxNoProgressIterations: input.maxNoProgressIterations ?? 6,
      runRecorder: { recordAuthenticationEvidenceAssessment },
      onEvent: input.onEvent,
    })
  };
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

function cancelledProtectedExecution(toolCallId: string): ToolExecutionRecord {
  return {
    tool: toolDefinition("browser.fill_protected_form"),
    input: { tabRef: "@t1" },
    decision: "allow",
    riskClass: "external-side-effect",
    toolCallId,
    result: {
      ok: false,
      content: "protected input cancelled",
      metadata: { secureInputGroupReceipt: { status: "cancelled" } }
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
