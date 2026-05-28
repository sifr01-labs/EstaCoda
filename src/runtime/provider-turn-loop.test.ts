import { describe, expect, it, vi } from "vitest";
import { normalizeSessionCompressionConfig } from "../config/runtime-config.js";
import type { ModelProfile, ResolvedModelRoute, ProviderRequest, ProviderResponse } from "../contracts/provider.js";
import type { RuntimeEvent } from "../contracts/runtime-event.js";
import type { ReplacementSessionMessage, SessionDB, SessionEvent } from "../contracts/session.js";
import type { ToolCallPlan } from "../contracts/tool-plan.js";
import type { ToolDefinition } from "../contracts/tool.js";
import type { ProviderExecutionResult } from "../providers/provider-executor.js";
import { ProviderExecutor } from "../providers/provider-executor.js";
import { ProviderRegistry } from "../providers/provider-registry.js";
import { SessionCompressionService, type CompactResult } from "../prompt/session-compression-service.js";
import { InMemorySessionDB } from "../session/in-memory-session-db.js";
import { SESSION_RECALL_UNTRUSTED_NOTICE } from "../session/session-recall-service.js";
import { TrajectoryRecorder } from "../trajectory/trajectory-recorder.js";
import type { ToolExecutionRecord } from "../tools/tool-executor.js";
import { RunRecorder } from "./run-recorder.js";
import { ToolPlanRunner } from "./tool-plan-runner.js";
import { ProviderTurnLoop, type ProviderTurnLoopOptions } from "./provider-turn-loop.js";

function createMockAdapter() {
  return {
    id: "test-provider" as const,
    name: "Test Provider",
    executable: true,
    health() {
      return { available: true };
    },
    listModels() {
      return [];
    },
    async complete(request: ProviderRequest): Promise<ProviderResponse> {
      return {
        ok: true,
        content: "mock-response",
        model: request.model,
        provider: "test-provider"
      };
    }
  };
}

const mockModel: ModelProfile = {
  id: "test-model",
  provider: "test-provider",
  contextWindowTokens: 128_000,
  supportsTools: true,
  supportsVision: false,
  supportsStructuredOutput: true
};

const primaryRoute: ResolvedModelRoute = {
  provider: "test-provider",
  id: "test-model",
  profile: mockModel,
  baseUrl: "https://primary.example.com/v1",
  apiKeyEnv: "PRIMARY_KEY"
};

const fallbackRoute: ResolvedModelRoute = {
  provider: "test-provider",
  id: "test-model-fallback",
  profile: {
    id: "test-model-fallback",
    provider: "test-provider",
    contextWindowTokens: 64_000,
    supportsTools: true,
    supportsVision: false,
    supportsStructuredOutput: true
  },
  baseUrl: "https://fallback.example.com/v1",
  apiKeyEnv: "FALLBACK_KEY"
};

const testTool: ToolDefinition = {
  name: "test.tool",
  description: "Test tool",
  inputSchema: {},
  riskClass: "read-only-local",
  toolsets: ["test"],
  progressLabel: "testing",
  maxResultSizeChars: 1000
};

async function createProviderTurnLoopForTest(
  overrides: Partial<Pick<ProviderTurnLoopOptions, "providerExecutor" | "model">> = {}
): Promise<ProviderTurnLoop> {
  const registry = new ProviderRegistry();
  registry.register(createMockAdapter());
  const providerExecutor = new ProviderExecutor({ registry });
  const sessionDb = new InMemorySessionDB();
  const sessionId = `test-session-${Date.now()}-${Math.random()}`;
  await sessionDb.createSession({ id: sessionId, profileId: "default", title: "test" });
  const trajectoryRecorder = new TrajectoryRecorder({
    profileId: "default",
    sessionId,
    modelId: "test-model"
  });
  const runRecorder = new RunRecorder({
    sessionDb,
    sessionId,
    trajectoryRecorder,
    profileId: "default"
  });
  const toolPlanRunner = new ToolPlanRunner({
    toolCallPlanner: undefined,
    toolExecutor: {} as any,
    runRecorder,
    sessionId,
    maxConcurrentSafeTools: 4
  });

  return new ProviderTurnLoop({
    providerExecutor,
    model: mockModel,
    primaryModelRoute: primaryRoute,
    modelFallbackRoutes: [fallbackRoute],
    providerPreferences: {
      providerOrder: ["test-provider"]
    },
    sessionDb,
    sessionId,
    profileId: "default",
    trajectoryRecorder,
    runRecorder,
    toolPlanRunner,
    soul: undefined,
    memoryPromptContext: undefined,
    skillsIndex: [],
    ui: undefined,
    agentProfile: undefined,
    budgets: {
      maxProviderIterations: 2,
      maxProviderToolCalls: 4,
      maxRepeatedToolFailures: 2,
      maxProviderWallClockMs: 10_000
    },
    ...overrides
  });
}

async function createCompressionHarness() {
  const registry = new ProviderRegistry();
  registry.register(createMockAdapter());
  const providerExecutor = new ProviderExecutor({ registry });
  const completeSpy = vi.spyOn(providerExecutor, "complete").mockResolvedValue({
    ok: true,
    response: {
      ok: true,
      content: "mock-response",
      model: "test-model",
      provider: "test-provider",
      usage: {
        inputTokens: 123,
        outputTokens: 12,
        totalTokens: 135
      }
    },
    fallbackUsed: false,
    attempts: [
      {
        provider: "test-provider",
        model: "test-model",
        ok: true,
        content: "mock-response"
      }
    ],
    toolCalls: []
  });
  const sessionDb = new InMemorySessionDB();
  const sessionId = `compression-session-${Date.now()}-${Math.random()}`;
  await sessionDb.createSession({ id: sessionId, profileId: "default", title: "compression" });
  const trajectoryRecorder = new TrajectoryRecorder({
    profileId: "default",
    sessionId,
    modelId: "test-model"
  });
  const runRecorder = new RunRecorder({
    sessionDb,
    sessionId,
    trajectoryRecorder,
    profileId: "default"
  });
  const toolPlanRunner = new ToolPlanRunner({
    toolCallPlanner: undefined,
    toolExecutor: {} as any,
    runRecorder,
    sessionId,
    maxConcurrentSafeTools: 4
  });
  const loop = (overrides: Partial<ProviderTurnLoopOptions> = {}) => new ProviderTurnLoop({
    providerExecutor,
    model: mockModel,
    primaryModelRoute: primaryRoute,
    modelFallbackRoutes: [fallbackRoute],
    providerPreferences: {
      providerOrder: ["test-provider"]
    },
    sessionDb,
    sessionId,
    profileId: "default",
    trajectoryRecorder,
    runRecorder,
    toolPlanRunner,
    soul: undefined,
    memoryPromptContext: undefined,
    skillsIndex: [],
    ui: undefined,
    agentProfile: undefined,
    budgets: {
      maxProviderIterations: 2,
      maxProviderToolCalls: 4,
      maxRepeatedToolFailures: 2,
      maxProviderWallClockMs: 10_000
    },
    ...overrides
  });

  return {
    sessionDb,
    sessionId,
    providerExecutor,
    completeSpy,
    loop
  };
}

async function appendHistory(db: InMemorySessionDB, sessionId: string, content: string): Promise<void> {
  await db.appendMessage({
    id: `${sessionId}-history`,
    sessionId,
    role: "user",
    content
  });
  await db.appendMessage({
    id: `${sessionId}-latest`,
    sessionId,
    role: "user",
    content: "current user request"
  });
}

async function runBasicProviderTurn(
  loop: ProviderTurnLoop,
  onEvent?: (event: RuntimeEvent) => void
): Promise<Awaited<ReturnType<ProviderTurnLoop["run"]>>> {
  return await loop.run({
    userText: "current user request",
    routedText: "current user request",
    selectedSkill: undefined,
    selectedSkillInstructions: undefined,
    selectedSkillResources: undefined,
    selectedSkillSetup: undefined,
    intent: { labels: ["general"], confidence: 1, nativeIntent: "general", evidence: [], suggestedToolsets: [], suggestedSkills: [], confirmationRequired: false, rationale: "" },
    securityDecision: "allow",
    toolExecutions: [],
    context: undefined,
    projectContext: undefined,
    attachments: undefined,
    memoryPromptContext: undefined,
    providerTools: [],
    fallbackText: "",
    toolPlans: [],
    trustedWorkspace: false,
    initialRiskClass: "read-only-local",
    onEvent
  });
}

function providerExecution(content: string, toolCalls: ProviderExecutionResult["toolCalls"] = []): ProviderExecutionResult {
  return {
    ok: true,
    response: {
      ok: true,
      content,
      model: "test-model",
      provider: "test-provider"
    },
    fallbackUsed: false,
    attempts: [
      {
        provider: "test-provider",
        model: "test-model",
        ok: true,
        content
      }
    ],
    toolCalls
  };
}

function providerToolCall(id: string): ProviderExecutionResult["toolCalls"][number] {
  return {
    id,
    name: testTool.name,
    argumentsText: "{}"
  };
}

function toolExecution(id: string, content = `tool result ${id}`): ToolExecutionRecord {
  return toolExecutionForTool(id, testTool.name, content);
}

function toolExecutionForTool(id: string, toolName: string, content = `tool result ${id}`): ToolExecutionRecord {
  const tool = {
    ...testTool,
    name: toolName
  };

  return {
    tool,
    input: {},
    decision: "allow",
    riskClass: "read-only-local",
    toolCallId: id,
    toolCallName: toolName,
    result: {
      ok: true,
      content
    }
  };
}

function toolPlan(id: string, status: ToolCallPlan["status"] = "executed"): ToolCallPlan {
  return {
    id,
    tool: testTool.name,
    input: {},
    source: "provider-tool-call",
    status,
    result: status === "executed"
      ? {
          ok: true,
          content: `tool result ${id}`
        }
      : undefined
  };
}

async function createPostToolNudgeHarness(input: {
  responses: ProviderExecutionResult[];
  toolSteps: Array<{
    executions?: ToolExecutionRecord[];
    plans?: ToolCallPlan[];
  }>;
  maxProviderIterations?: number;
}) {
  let responseIndex = 0;
  const completeSpy = vi.fn<ProviderExecutor["complete"]>(async () => {
    const response = input.responses[Math.min(responseIndex, input.responses.length - 1)] ?? providerExecution("");
    responseIndex += 1;
    return response;
  });
  const providerExecutor = {
    complete: completeSpy
  } as unknown as ProviderExecutor;
  const sessionDb = new InMemorySessionDB();
  const sessionId = `nudge-session-${Date.now()}-${Math.random()}`;
  await sessionDb.createSession({ id: sessionId, profileId: "default", title: "nudge" });
  const trajectoryRecorder = new TrajectoryRecorder({
    profileId: "default",
    sessionId,
    modelId: "test-model"
  });
  const runRecorder = new RunRecorder({
    sessionDb,
    sessionId,
    trajectoryRecorder,
    profileId: "default"
  });
  let toolStepIndex = 0;
  const executePlans = vi.fn(async (stepInput: Parameters<ToolPlanRunner["executePlans"]>[0]) => {
    const step = input.toolSteps[toolStepIndex] ?? {};
    toolStepIndex += 1;
    for (const plan of step.plans ?? []) {
      stepInput.toolPlans.push(plan);
    }
    for (const execution of step.executions ?? []) {
      stepInput.toolPlans.push(toolPlan(execution.toolCallId ?? execution.tool.name));
    }
    return {
      executions: step.executions ?? [],
      maxObservedRisk: stepInput.riskBaseline
    };
  });
  const toolPlanRunner = {
    executePlans
  } as unknown as ToolPlanRunner;
  const loop = new ProviderTurnLoop({
    providerExecutor,
    model: mockModel,
    primaryModelRoute: primaryRoute,
    modelFallbackRoutes: [fallbackRoute],
    providerPreferences: {
      providerOrder: ["test-provider"]
    },
    sessionDb,
    sessionId,
    profileId: "default",
    trajectoryRecorder,
    runRecorder,
    toolPlanRunner,
    soul: undefined,
    memoryPromptContext: undefined,
    skillsIndex: [],
    ui: undefined,
    agentProfile: undefined,
    budgets: {
      maxProviderIterations: input.maxProviderIterations ?? 3,
      maxProviderToolCalls: 8,
      maxRepeatedToolFailures: 3,
      maxProviderWallClockMs: 10_000
    }
  });

  return {
    loop,
    completeSpy,
    executePlans,
    sessionDb,
    sessionId
  };
}

function compressionDiagnostics(
  overrides: Partial<CompactResult["diagnostics"]> = {}
): CompactResult["diagnostics"] {
  return {
    shouldCompress: true,
    reason: "above-threshold",
    preTokens: 100,
    postTokens: 40,
    estimatedSavingsTokens: 60,
    estimatedSavingsRatio: 0.6,
    sourceMessageCount: 2,
    summarizedMessageCount: 1,
    protectedMessageCount: 1,
    protectedFirstN: 0,
    protectedLastN: 1,
    protectedSpans: [{ startMessageId: "current-user", endMessageId: "current-user", messageCount: 1 }],
    protectedCategories: ["current_user_request" as const],
    summaryFormatVersion: "v1",
    summaryChars: 40,
    fallbackUsed: false,
    warnings: [],
    prunedToolResults: 0,
    prunedToolResultChars: 0,
    protectedToolResultsKept: 0,
    scopeKey: "default:test",
    ineffectiveCompressionCount: 0,
    eventWarnings: [],
    ...overrides
  };
}

function forwardingSessionDb(db: InMemorySessionDB, overrides: Partial<SessionDB>): SessionDB {
  return {
    createSession: overrides.createSession ?? db.createSession.bind(db),
    getSession: overrides.getSession ?? db.getSession.bind(db),
    listSessions: overrides.listSessions ?? db.listSessions.bind(db),
    endSession: overrides.endSession ?? db.endSession.bind(db),
    appendMessage: overrides.appendMessage ?? db.appendMessage.bind(db),
    replaceMessages: overrides.replaceMessages ?? db.replaceMessages.bind(db),
    rewriteTranscript: overrides.rewriteTranscript ?? db.rewriteTranscript.bind(db),
    appendEvent: overrides.appendEvent ?? db.appendEvent.bind(db),
    listMessages: overrides.listMessages ?? db.listMessages.bind(db),
    listEvents: overrides.listEvents ?? db.listEvents.bind(db),
    search: overrides.search ?? db.search.bind(db),
    setSessionModelOverride: overrides.setSessionModelOverride ?? db.setSessionModelOverride.bind(db),
    clearSessionModelOverride: overrides.clearSessionModelOverride ?? db.clearSessionModelOverride.bind(db),
    getSessionModelOverride: overrides.getSessionModelOverride ?? db.getSessionModelOverride.bind(db),
    saveFailure: overrides.saveFailure ?? db.saveFailure.bind(db)
  };
}

describe("ProviderTurnLoop provider availability", () => {
  it("can run provider when executor and configured model are present", async () => {
    const loop = await createProviderTurnLoopForTest();

    expect(loop.canRunProvider()).toBe(true);
  });

  it("cannot run provider without a provider executor", async () => {
    const loop = await createProviderTurnLoopForTest({ providerExecutor: undefined });

    expect(loop.canRunProvider()).toBe(false);
  });

  it("cannot run provider without a model", async () => {
    const loop = await createProviderTurnLoopForTest({ model: undefined });

    expect(loop.canRunProvider()).toBe(false);
  });

  it("cannot run provider for the unconfigured provider", async () => {
    const loop = await createProviderTurnLoopForTest({
      model: {
        ...mockModel,
        provider: "unconfigured"
      }
    });

    expect(loop.canRunProvider()).toBe(false);
  });
});

describe("ProviderTurnLoop semantic session compression", () => {
  it("does not own persistent semantic compression or session forking", async () => {
    const harness = await createCompressionHarness();
    await appendHistory(harness.sessionDb, harness.sessionId, "large history ".repeat(200));
    const loop = harness.loop();

    const result = await runBasicProviderTurn(loop);

    expect(result.providerExecution?.ok).toBe(true);
    const request = harness.completeSpy.mock.calls[0]?.[0] as ProviderRequest;
    expect(JSON.stringify(request.messages)).toContain("large history");
    const events = await harness.sessionDb.listEvents(harness.sessionId);
    expect(events.some((event) => event.kind === "session-history-compressed")).toBe(false);
    expect(events.some((event) => event.kind === "session-compaction-forked")).toBe(false);
  });

  it("records prompt and actual input token tracking without compression ownership", async () => {
    const harness = await createCompressionHarness();
    const loop = harness.loop();

    await runBasicProviderTurn(loop);

    expect(loop.lastPromptTokens()).toEqual(expect.any(Number));
    expect(loop.lastPromptTokens()).toBeGreaterThan(0);
    expect(loop.lastActualPromptTokens()).toBe(123);
  });

  it("emits context usage for assembled prompts and provider actual usage", async () => {
    const harness = await createCompressionHarness();
    const events: RuntimeEvent[] = [];

    await runBasicProviderTurn(harness.loop(), (event) => events.push(event));

    const usageEvents = events.filter((event): event is Extract<RuntimeEvent, { kind: "context-usage" }> =>
      event.kind === "context-usage"
    );
    expect(usageEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: "assembled-prompt",
        total: mockModel.contextWindowTokens
      }),
      {
        kind: "context-usage",
        filled: 123,
        total: mockModel.contextWindowTokens,
        source: "provider-actual"
      }
    ]));
    expect(usageEvents.find((event) => event.source === "assembled-prompt")?.filled).toBeGreaterThan(0);
  });
});

describe("ProviderTurnLoop post-tool empty response recovery", () => {
  it("uses prior content when an empty continuation follows housekeeping tools", async () => {
    const harness = await createPostToolNudgeHarness({
      responses: [
        providerExecution("Housekeeping-visible answer.", [providerToolCall("call-memory")]),
        providerExecution("")
      ],
      toolSteps: [
        { executions: [toolExecutionForTool("call-memory", "memory.curate")] },
        {}
      ],
      maxProviderIterations: 3
    });

    const result = await runBasicProviderTurn(harness.loop);

    expect(result.iterations).toBe(2);
    expect(result.providerExecution?.response?.content).toBe("Housekeeping-visible answer.");
    expect(harness.completeSpy).toHaveBeenCalledTimes(2);
    const requests = harness.completeSpy.mock.calls.map((call) => JSON.stringify((call[0] as ProviderRequest).messages));
    expect(requests.some((request) => request.includes("You just executed tool calls but returned an empty response."))).toBe(false);
    const events = await harness.sessionDb.listEvents(harness.sessionId);
    const continuationEvents = events.filter((event) => event.kind === "provider-continuation");
    expect(continuationEvents.map((event) => "nudge" in event ? event.nudge : undefined)).toEqual([
      false
    ]);
  });

  it("does not reuse content from substantive tools and keeps the post-tool nudge", async () => {
    const harness = await createPostToolNudgeHarness({
      responses: [
        providerExecution("Substantive progress text.", [providerToolCall("call-terminal")]),
        providerExecution(""),
        providerExecution("Nudge recovered after terminal.")
      ],
      toolSteps: [
        { executions: [toolExecutionForTool("call-terminal", "terminal.run")] },
        {},
        {}
      ],
      maxProviderIterations: 3
    });

    const result = await runBasicProviderTurn(harness.loop);

    expect(result.iterations).toBe(3);
    expect(result.providerExecution?.response?.content).toBe("Nudge recovered after terminal.");
    expect(harness.completeSpy).toHaveBeenCalledTimes(3);
    const nudgeRequest = harness.completeSpy.mock.calls[2]?.[0] as ProviderRequest | undefined;
    expect(JSON.stringify(nudgeRequest?.messages ?? [])).toContain(
      "You just executed tool calls but returned an empty response. Please process the tool results above and continue with the task."
    );
  });

  it("does not treat mutating skill promotion as housekeeping", async () => {
    const harness = await createPostToolNudgeHarness({
      responses: [
        providerExecution("Promotion progress text.", [providerToolCall("call-promote")]),
        providerExecution(""),
        providerExecution("Nudge recovered after promotion.")
      ],
      toolSteps: [
        { executions: [toolExecutionForTool("call-promote", "skill.promote_patch")] },
        {},
        {}
      ],
      maxProviderIterations: 3
    });

    const result = await runBasicProviderTurn(harness.loop);

    expect(result.iterations).toBe(3);
    expect(result.providerExecution?.response?.content).toBe("Nudge recovered after promotion.");
    expect(harness.completeSpy).toHaveBeenCalledTimes(3);
    const requests = harness.completeSpy.mock.calls.map((call) => JSON.stringify((call[0] as ProviderRequest).messages));
    expect(requests.filter((request) => request.includes("You just executed tool calls but returned an empty response."))).toHaveLength(1);
  });

  it("clears stale housekeeping content when a later substantive tool executes", async () => {
    const harness = await createPostToolNudgeHarness({
      responses: [
        providerExecution("Housekeeping-visible answer.", [providerToolCall("call-memory")]),
        providerExecution("Substantive progress text.", [providerToolCall("call-terminal")]),
        providerExecution(""),
        providerExecution("Nudge recovered after stale capture cleared.")
      ],
      toolSteps: [
        { executions: [toolExecutionForTool("call-memory", "memory.curate")] },
        { executions: [toolExecutionForTool("call-terminal", "terminal.run")] },
        {},
        {}
      ],
      maxProviderIterations: 4
    });

    const result = await runBasicProviderTurn(harness.loop);

    expect(result.iterations).toBe(4);
    expect(result.providerExecution?.response?.content).toBe("Nudge recovered after stale capture cleared.");
    expect(result.providerExecution?.response?.content).not.toBe("Housekeeping-visible answer.");
    const requests = harness.completeSpy.mock.calls.map((call) => JSON.stringify((call[0] as ProviderRequest).messages));
    expect(requests.filter((request) => request.includes("You just executed tool calls but returned an empty response."))).toHaveLength(1);
  });

  it("adds a nudge on the next iteration when a post-tool continuation is empty and budget remains", async () => {
    const harness = await createPostToolNudgeHarness({
      responses: [
        providerExecution("", [providerToolCall("call-initial")]),
        providerExecution(""),
        providerExecution("Recovered final answer.")
      ],
      toolSteps: [
        { executions: [toolExecution("call-initial")] },
        {},
        {}
      ],
      maxProviderIterations: 3
    });

    const result = await runBasicProviderTurn(harness.loop);

    expect(result.iterations).toBe(3);
    expect(result.providerExecution?.response?.content).toBe("Recovered final answer.");
    expect(harness.completeSpy).toHaveBeenCalledTimes(3);
    const nudgeRequest = harness.completeSpy.mock.calls[2]?.[0] as ProviderRequest | undefined;
    expect(nudgeRequest).toBeDefined();
    expect(JSON.stringify(nudgeRequest!.messages)).toContain(
      "You just executed tool calls but returned an empty response. Please process the tool results above and continue with the task."
    );
    const events = await harness.sessionDb.listEvents(harness.sessionId);
    const continuationEvents = events.filter((event) => event.kind === "provider-continuation");
    expect(continuationEvents.map((event) => "nudge" in event ? event.nudge : undefined)).toEqual([
      false,
      true
    ]);
    expect(events).toContainEqual(expect.objectContaining({
      kind: "provider-continuation",
      iteration: 2,
      nudge: true
    }));
  });

  it("uses nudge text as the final response", async () => {
    const harness = await createPostToolNudgeHarness({
      responses: [
        providerExecution("", [providerToolCall("call-initial")]),
        providerExecution(""),
        providerExecution("Nudge produced visible text.")
      ],
      toolSteps: [
        { executions: [toolExecution("call-initial")] },
        {},
        {}
      ],
      maxProviderIterations: 3
    });

    const result = await runBasicProviderTurn(harness.loop);

    expect(result.providerExecution?.ok).toBe(true);
    expect(result.providerExecution?.response?.content).toBe("Nudge produced visible text.");
  });

  it("executes tool calls returned by the nudge through the normal tool path", async () => {
    const nudgeToolExecution = toolExecution("call-nudge", "nudge tool result");
    const harness = await createPostToolNudgeHarness({
      responses: [
        providerExecution("", [providerToolCall("call-initial")]),
        providerExecution(""),
        providerExecution("", [providerToolCall("call-nudge")])
      ],
      toolSteps: [
        { executions: [toolExecution("call-initial")] },
        {},
        { executions: [nudgeToolExecution] }
      ],
      maxProviderIterations: 3
    });

    const result = await runBasicProviderTurn(harness.loop);

    expect(harness.completeSpy).toHaveBeenCalledTimes(3);
    expect(harness.executePlans).toHaveBeenCalledTimes(3);
    const nudgeToolRunInput = harness.executePlans.mock.calls[2]?.[0];
    expect(nudgeToolRunInput).toBeDefined();
    expect(nudgeToolRunInput?.providerExecution?.toolCalls).toEqual([
      expect.objectContaining({ id: "call-nudge" })
    ]);
    expect(result.toolExecutions).toContain(nudgeToolExecution);
  });

  it("does not nudge empty continuations when no tools executed earlier in the loop", async () => {
    const harness = await createPostToolNudgeHarness({
      responses: [
        providerExecution("", [providerToolCall("call-initial")]),
        providerExecution("")
      ],
      toolSteps: [
        { plans: [toolPlan("call-initial", "blocked")] },
        {}
      ],
      maxProviderIterations: 3
    });

    const result = await runBasicProviderTurn(harness.loop);

    expect(result.iterations).toBe(2);
    expect(harness.completeSpy).toHaveBeenCalledTimes(2);
    const requests = harness.completeSpy.mock.calls.map((call) => JSON.stringify((call[0] as ProviderRequest).messages));
    expect(requests.some((request) => request.includes("You just executed tool calls but returned an empty response."))).toBe(false);
  });

  it("does not nudge empty initial provider responses", async () => {
    const harness = await createPostToolNudgeHarness({
      responses: [
        providerExecution("")
      ],
      toolSteps: [
        {}
      ],
      maxProviderIterations: 3
    });

    const result = await runBasicProviderTurn(harness.loop);

    expect(result.iterations).toBe(1);
    expect(harness.completeSpy).toHaveBeenCalledTimes(1);
  });

  it("does not exceed the provider iteration budget to nudge an empty final iteration", async () => {
    const harness = await createPostToolNudgeHarness({
      responses: [
        providerExecution("", [providerToolCall("call-initial")]),
        providerExecution("")
      ],
      toolSteps: [
        { executions: [toolExecution("call-initial")] },
        {}
      ],
      maxProviderIterations: 2
    });

    const result = await runBasicProviderTurn(harness.loop);

    expect(result.iterations).toBe(2);
    expect(harness.completeSpy).toHaveBeenCalledTimes(2);
  });

  it("nudges only once when the nudge also returns empty", async () => {
    const harness = await createPostToolNudgeHarness({
      responses: [
        providerExecution("", [providerToolCall("call-initial")]),
        providerExecution(""),
        providerExecution("")
      ],
      toolSteps: [
        { executions: [toolExecution("call-initial")] },
        {},
        {}
      ],
      maxProviderIterations: 4
    });

    const result = await runBasicProviderTurn(harness.loop);

    expect(result.iterations).toBe(3);
    expect(harness.completeSpy).toHaveBeenCalledTimes(3);
    const requests = harness.completeSpy.mock.calls.map((call) => JSON.stringify((call[0] as ProviderRequest).messages));
    expect(requests.filter((request) => request.includes("You just executed tool calls but returned an empty response."))).toHaveLength(1);
  });

  it("leaves existing non-empty continuation behavior unchanged", async () => {
    const harness = await createPostToolNudgeHarness({
      responses: [
        providerExecution("", [providerToolCall("call-initial")]),
        providerExecution("Normal continuation answer.")
      ],
      toolSteps: [
        { executions: [toolExecution("call-initial")] },
        {}
      ],
      maxProviderIterations: 3
    });

    const result = await runBasicProviderTurn(harness.loop);

    expect(result.iterations).toBe(2);
    expect(result.providerExecution?.response?.content).toBe("Normal continuation answer.");
    expect(harness.completeSpy).toHaveBeenCalledTimes(2);
  });
});

describe("ProviderTurnLoop explicit route propagation", () => {
  it("uses the per-turn memory prompt context when assembling provider prompts", async () => {
    const registry = new ProviderRegistry();
    registry.register(createMockAdapter());
    const providerExecutor = new ProviderExecutor({ registry });
    const completeSpy = vi.spyOn(providerExecutor, "complete").mockResolvedValue({
      ok: true,
      response: {
        ok: true,
        content: "mock-response",
        model: "test-model",
        provider: "test-provider"
      },
      fallbackUsed: false,
      attempts: [
        {
          provider: "test-provider",
          model: "test-model",
          ok: true,
          content: "mock-response"
        }
      ],
      toolCalls: []
    });
    const loop = await createProviderTurnLoopForTest({ providerExecutor });

    await loop.run({
      userText: "What did we decide last time?",
      routedText: "What did we decide last time?",
      selectedSkill: undefined,
      selectedSkillInstructions: undefined,
      selectedSkillResources: undefined,
      selectedSkillSetup: undefined,
      intent: { labels: ["general"], confidence: 1, nativeIntent: "general", evidence: [], suggestedToolsets: [], suggestedSkills: [], confirmationRequired: false, rationale: "" },
      securityDecision: "allow",
      toolExecutions: [],
      context: undefined,
      projectContext: undefined,
      attachments: undefined,
      memoryPromptContext: {
        frozenCompactMemory: [],
        safetyMemory: [],
        sessionRecall: [
          {
            id: "session-recall:sess-1",
            kind: "session-recall",
            scope: "session",
            source: "session:sess-1",
            content: `${SESSION_RECALL_UNTRUSTED_NOTICE}\nRuntime recall marker`,
            chars: `${SESSION_RECALL_UNTRUSTED_NOTICE}\nRuntime recall marker`.length,
            entryIds: ["sess-1"],
            trusted: false
          }
        ],
        diagnostics: {
          includedBlocks: [],
          suppressedEntries: 0,
          duplicateEntriesRemoved: 0,
          recallTriggered: true,
          budgetPressure: [],
          compactionPressure: [],
          warnings: []
        }
      },
      providerTools: [],
      fallbackText: "",
      toolPlans: [],
      trustedWorkspace: false,
      initialRiskClass: "read-only-local"
    });

    const request = completeSpy.mock.calls[0]?.[0] as ProviderRequest;
    expect(JSON.stringify(request.messages)).toContain("Runtime recall marker");
    expect(JSON.stringify(request.messages)).toContain(SESSION_RECALL_UNTRUSTED_NOTICE);
  });

  it("always passes primaryRoute and fallbackChain to ProviderExecutor.complete", async () => {
    const registry = new ProviderRegistry();
    registry.register(createMockAdapter());

    const providerExecutor = new ProviderExecutor({ registry });
    const completeSpy = vi.spyOn(providerExecutor, "complete").mockResolvedValue({
      ok: true,
      response: {
        ok: true,
        content: "mock-response",
        model: "test-model",
        provider: "test-provider"
      },
      fallbackUsed: false,
      attempts: [
        {
          provider: "test-provider",
          model: "test-model",
          ok: true,
          content: "mock-response"
        }
      ],
      toolCalls: []
    });

    const sessionDb = new InMemorySessionDB();
    const sessionId = "test-session-123";
    await sessionDb.createSession({ id: sessionId, profileId: "default", title: "test" });

    const trajectoryRecorder = new TrajectoryRecorder({
      profileId: "default",
      sessionId,
      modelId: "test-model"
    });

    const runRecorder = new RunRecorder({
      sessionDb,
      sessionId,
      trajectoryRecorder,
      profileId: "default"
    });

    const toolPlanRunner = new ToolPlanRunner({
      toolCallPlanner: undefined,
      toolExecutor: {} as any,
      runRecorder,
      sessionId,
      maxConcurrentSafeTools: 4
    });

    const loop = new ProviderTurnLoop({
      providerExecutor,
      model: mockModel,
      primaryModelRoute: primaryRoute,
      modelFallbackRoutes: [fallbackRoute],
      providerPreferences: {
        providerOrder: ["test-provider"]
      },
      sessionDb,
      sessionId,
      profileId: "default",
      trajectoryRecorder,
      runRecorder,
      toolPlanRunner,
      soul: undefined,
      memoryPromptContext: undefined,
      skillsIndex: [],
      ui: undefined,
      agentProfile: undefined,
      budgets: {
        maxProviderIterations: 2,
        maxProviderToolCalls: 4,
        maxRepeatedToolFailures: 2,
        maxProviderWallClockMs: 10_000
      }
    });

    const result = await loop.run({
      userText: "hello",
      routedText: "hello",
      selectedSkill: undefined,
      selectedSkillInstructions: undefined,
      selectedSkillResources: undefined,
      selectedSkillSetup: undefined,
      intent: { labels: ["general"], confidence: 1, nativeIntent: "general", evidence: [], suggestedToolsets: [], suggestedSkills: [], confirmationRequired: false, rationale: "" },
      securityDecision: "allow",
      toolExecutions: [],
      context: undefined,
      projectContext: undefined,
      attachments: undefined,
      memoryPromptContext: undefined,
      providerTools: [],
      fallbackText: "",
      toolPlans: [],
      trustedWorkspace: false,
      initialRiskClass: "read-only-local"
    });

    expect(completeSpy).toHaveBeenCalledTimes(1);

    const callArgs = completeSpy.mock.calls[0];
    const executionOptions = callArgs[2] as { primaryRoute?: ResolvedModelRoute; fallbackChain?: ResolvedModelRoute[] };

    expect(executionOptions).toBeDefined();
    expect(executionOptions.primaryRoute).toBeDefined();
    expect(executionOptions.primaryRoute!.provider).toBe("test-provider");
    expect(executionOptions.primaryRoute!.id).toBe("test-model");
    expect(executionOptions.primaryRoute!.baseUrl).toBe("https://primary.example.com/v1");
    expect(executionOptions.primaryRoute!.apiKeyEnv).toBe("PRIMARY_KEY");

    expect(executionOptions.fallbackChain).toBeDefined();
    expect(executionOptions.fallbackChain!.length).toBe(1);
    expect(executionOptions.fallbackChain![0].provider).toBe("test-provider");
    expect(executionOptions.fallbackChain![0].id).toBe("test-model-fallback");
    expect(executionOptions.fallbackChain![0].baseUrl).toBe("https://fallback.example.com/v1");
    expect(executionOptions.fallbackChain![0].apiKeyEnv).toBe("FALLBACK_KEY");

    expect(result.providerExecution).toBeDefined();
    expect(result.providerExecution!.ok).toBe(true);

    completeSpy.mockRestore();
  });

  it("passes undefined fallbackChain when no fallback routes are configured", async () => {
    const registry = new ProviderRegistry();
    registry.register(createMockAdapter());

    const providerExecutor = new ProviderExecutor({ registry });
    const completeSpy = vi.spyOn(providerExecutor, "complete").mockResolvedValue({
      ok: true,
      response: {
        ok: true,
        content: "mock-response",
        model: "test-model",
        provider: "test-provider"
      },
      fallbackUsed: false,
      attempts: [
        {
          provider: "test-provider",
          model: "test-model",
          ok: true,
          content: "mock-response"
        }
      ],
      toolCalls: []
    });

    const sessionDb = new InMemorySessionDB();
    const sessionId = "test-session-456";
    await sessionDb.createSession({ id: sessionId, profileId: "default", title: "test" });

    const trajectoryRecorder = new TrajectoryRecorder({
      profileId: "default",
      sessionId,
      modelId: "test-model"
    });

    const runRecorder = new RunRecorder({
      sessionDb,
      sessionId,
      trajectoryRecorder,
      profileId: "default"
    });

    const toolPlanRunner = new ToolPlanRunner({
      toolCallPlanner: undefined,
      toolExecutor: {} as any,
      runRecorder,
      sessionId,
      maxConcurrentSafeTools: 4
    });

    const loop = new ProviderTurnLoop({
      providerExecutor,
      model: mockModel,
      primaryModelRoute: primaryRoute,
      modelFallbackRoutes: [],
      providerPreferences: {
        providerOrder: ["test-provider"]
      },
      sessionDb,
      sessionId,
      profileId: "default",
      trajectoryRecorder,
      runRecorder,
      toolPlanRunner,
      soul: undefined,
      memoryPromptContext: undefined,
      skillsIndex: [],
      ui: undefined,
      agentProfile: undefined,
      budgets: {
        maxProviderIterations: 2,
        maxProviderToolCalls: 4,
        maxRepeatedToolFailures: 2,
        maxProviderWallClockMs: 10_000
      }
    });

    await loop.run({
      userText: "hello",
      routedText: "hello",
      selectedSkill: undefined,
      selectedSkillInstructions: undefined,
      selectedSkillResources: undefined,
      selectedSkillSetup: undefined,
      intent: { labels: ["general"], confidence: 1, nativeIntent: "general", evidence: [], suggestedToolsets: [], suggestedSkills: [], confirmationRequired: false, rationale: "" },
      securityDecision: "allow",
      toolExecutions: [],
      context: undefined,
      projectContext: undefined,
      attachments: undefined,
      memoryPromptContext: undefined,
      providerTools: [],
      fallbackText: "",
      toolPlans: [],
      trustedWorkspace: false,
      initialRiskClass: "read-only-local"
    });

    expect(completeSpy).toHaveBeenCalledTimes(1);
    const executionOptions = completeSpy.mock.calls[0][2] as { primaryRoute?: ResolvedModelRoute; fallbackChain?: ResolvedModelRoute[] };

    expect(executionOptions.primaryRoute).toBeDefined();
    expect(executionOptions.fallbackChain).toEqual([]);

    completeSpy.mockRestore();
  });

  it("returns undefined providerExecution when providerExecutor is undefined", async () => {
    const sessionDb = new InMemorySessionDB();
    const sessionId = "test-session-789";
    await sessionDb.createSession({ id: sessionId, profileId: "default", title: "test" });

    const trajectoryRecorder = new TrajectoryRecorder({
      profileId: "default",
      sessionId,
      modelId: "test-model"
    });

    const runRecorder = new RunRecorder({
      sessionDb,
      sessionId,
      trajectoryRecorder,
      profileId: "default"
    });

    const toolPlanRunner = new ToolPlanRunner({
      toolCallPlanner: undefined,
      toolExecutor: {} as any,
      runRecorder,
      sessionId,
      maxConcurrentSafeTools: 4
    });

    const loop = new ProviderTurnLoop({
      providerExecutor: undefined,
      model: mockModel,
      primaryModelRoute: primaryRoute,
      modelFallbackRoutes: [fallbackRoute],
      providerPreferences: {
        providerOrder: ["test-provider"]
      },
      sessionDb,
      sessionId,
      profileId: "default",
      trajectoryRecorder,
      runRecorder,
      toolPlanRunner,
      soul: undefined,
      memoryPromptContext: undefined,
      skillsIndex: [],
      ui: undefined,
      agentProfile: undefined,
      budgets: {
        maxProviderIterations: 2,
        maxProviderToolCalls: 4,
        maxRepeatedToolFailures: 2,
        maxProviderWallClockMs: 10_000
      }
    });

    const result = await loop.run({
      userText: "hello",
      routedText: "hello",
      selectedSkill: undefined,
      selectedSkillInstructions: undefined,
      selectedSkillResources: undefined,
      selectedSkillSetup: undefined,
      intent: { labels: ["general"], confidence: 1, nativeIntent: "general", evidence: [], suggestedToolsets: [], suggestedSkills: [], confirmationRequired: false, rationale: "" },
      securityDecision: "allow",
      toolExecutions: [],
      context: undefined,
      projectContext: undefined,
      attachments: undefined,
      memoryPromptContext: undefined,
      providerTools: [],
      fallbackText: "",
      toolPlans: [],
      trustedWorkspace: false,
      initialRiskClass: "read-only-local"
    });

    expect(result.providerExecution).toBeUndefined();
    expect(result.iterations).toBe(0);
  });
});
