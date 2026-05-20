import { describe, expect, it, vi } from "vitest";
import { normalizeSessionCompressionConfig } from "../config/runtime-config.js";
import type { ModelProfile, ResolvedModelRoute, ProviderRequest, ProviderResponse } from "../contracts/provider.js";
import type { ReplacementSessionMessage, SessionDB, SessionEvent } from "../contracts/session.js";
import type { ProviderExecutionResult } from "../providers/provider-executor.js";
import { ProviderExecutor } from "../providers/provider-executor.js";
import { ProviderRegistry } from "../providers/provider-registry.js";
import { SessionCompressionService, type CompactResult } from "../prompt/session-compression-service.js";
import { InMemorySessionDB } from "../session/in-memory-session-db.js";
import { SESSION_RECALL_UNTRUSTED_NOTICE } from "../session/session-recall-service.js";
import { TrajectoryRecorder } from "../trajectory/trajectory-recorder.js";
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

async function runBasicProviderTurn(loop: ProviderTurnLoop): Promise<Awaited<ReturnType<ProviderTurnLoop["run"]>>> {
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
    initialRiskClass: "read-only-local"
  });
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
    appendMessage: overrides.appendMessage ?? db.appendMessage.bind(db),
    replaceMessages: overrides.replaceMessages ?? db.replaceMessages.bind(db),
    appendEvent: overrides.appendEvent ?? db.appendEvent.bind(db),
    listMessages: overrides.listMessages ?? db.listMessages.bind(db),
    listEvents: overrides.listEvents ?? db.listEvents.bind(db),
    search: overrides.search ?? db.search.bind(db),
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
  it("does not call semantic compression when config is disabled", async () => {
    const harness = await createCompressionHarness();
    const compactIfNeeded = vi.fn(async () => ({
      didCompress: false,
      messages: [],
      diagnostics: compressionDiagnostics(),
      userFacingMessage: undefined
    }));
    const loop = harness.loop({
      sessionCompressionService: { compactIfNeeded },
      compressionConfig: normalizeSessionCompressionConfig({
        enabled: false,
        summaryModelContextLength: 50,
        threshold: 0.10
      })
    });
    await appendHistory(harness.sessionDb, harness.sessionId, "disabled compression history");

    await runBasicProviderTurn(loop);

    expect(compactIfNeeded).not.toHaveBeenCalled();
    const promptEvent = (await harness.sessionDb.listEvents(harness.sessionId))
      .find((event) => event.kind === "prompt-assembled");
    expect(promptEvent).toEqual(expect.objectContaining({
      kind: "prompt-assembled",
      budget: expect.not.objectContaining({ compression: expect.anything() })
    }));
  });

  it("does not call semantic compression below the configured threshold", async () => {
    const harness = await createCompressionHarness();
    const compactIfNeeded = vi.fn(async () => ({
      didCompress: false,
      messages: [],
      diagnostics: compressionDiagnostics({ reason: "below-threshold" }),
      userFacingMessage: undefined
    }));
    const loop = harness.loop({
      sessionCompressionService: { compactIfNeeded },
      compressionConfig: normalizeSessionCompressionConfig({
        enabled: true,
        experimental: true,
        summaryModelContextLength: 100_000,
        threshold: 0.95
      })
    });
    await appendHistory(harness.sessionDb, harness.sessionId, "small history");

    await runBasicProviderTurn(loop);

    expect(compactIfNeeded).not.toHaveBeenCalled();
    const promptEvent = (await harness.sessionDb.listEvents(harness.sessionId))
      .find((event) => event.kind === "prompt-assembled");
    expect(promptEvent).toEqual(expect.objectContaining({
      kind: "prompt-assembled",
      budget: expect.not.objectContaining({ compression: expect.anything() })
    }));
  });

  it("uses image metadata when deciding whether session history crosses the compression threshold", async () => {
    const harness = await createCompressionHarness();
    const compactIfNeeded = vi.fn(async () => ({
      didCompress: false,
      messages: [],
      diagnostics: compressionDiagnostics({
        shouldCompress: false,
        reason: "anti-thrashing"
      }),
      userFacingMessage: undefined
    }));
    const loop = harness.loop({
      sessionCompressionService: { compactIfNeeded },
      compressionConfig: normalizeSessionCompressionConfig({
        enabled: true,
        experimental: true,
        summaryModelContextLength: 1_000,
        threshold: 0.50
      })
    });
    await harness.sessionDb.appendMessage({
      id: `${harness.sessionId}-image-history`,
      sessionId: harness.sessionId,
      role: "user",
      content: "image-heavy history",
      metadata: {
        attachments: [
          { kind: "image", status: "ready" }
        ]
      }
    });

    await runBasicProviderTurn(loop);

    expect(compactIfNeeded).toHaveBeenCalledTimes(1);
  });

  it("calls semantic compression above threshold and uses returned compressed messages", async () => {
    const harness = await createCompressionHarness();
    const compressedMessages: ReplacementSessionMessage[] = [
      {
        id: "summary-1",
        role: "system",
        content: "[CONTEXT COMPACTION — REFERENCE ONLY]\nSemantic summary marker",
        createdAt: "2030-01-01T00:00:00.000Z",
        metadata: { semanticCompression: true, summaryFormatVersion: "v1" }
      },
      {
        id: "current-user",
        role: "user",
        content: "latest user survives",
        createdAt: "2030-01-01T00:00:01.000Z"
      }
    ];
    const compactIfNeeded = vi.fn(async () => ({
      didCompress: true,
      messages: compressedMessages,
      diagnostics: compressionDiagnostics({
        preTokens: 500,
        postTokens: 100,
        estimatedSavingsRatio: 0.8
      }),
      userFacingMessage: "Session history compacted"
    }));
    const loop = harness.loop({
      sessionCompressionService: { compactIfNeeded },
      compressionConfig: normalizeSessionCompressionConfig({
        enabled: true,
        experimental: true,
        summaryModelContextLength: 50,
        threshold: 0.10
      })
    });
    await appendHistory(harness.sessionDb, harness.sessionId, "large history ".repeat(200));

    await runBasicProviderTurn(loop);

    expect(compactIfNeeded).toHaveBeenCalledWith(expect.objectContaining({
      profileId: "default",
      sessionId: harness.sessionId
    }));
    const request = harness.completeSpy.mock.calls[0]?.[0] as ProviderRequest;
    const rendered = JSON.stringify(request.messages);
    expect(rendered).toContain("Semantic summary marker");
    expect(rendered).toContain("Compaction notice:");
    expect(rendered).toContain("latest user survives");
    expect(rendered).not.toContain("large history");
    const promptEvent = (await harness.sessionDb.listEvents(harness.sessionId))
      .find((event) => event.kind === "prompt-assembled");
    expect(promptEvent).toEqual(expect.objectContaining({
      kind: "prompt-assembled",
      budget: expect.objectContaining({
        compression: expect.objectContaining({
          triggered: true,
          mode: "semantic",
          summaryFormatVersion: "v1"
        })
      })
    }));
    const providerEvent = (await harness.sessionDb.listEvents(harness.sessionId))
      .find((event) => event.kind === "provider-completion");
    expect(providerEvent).toEqual(expect.objectContaining({
      kind: "provider-completion",
      usage: expect.objectContaining({
        inputTokens: 123
      })
    }));
  });

  it("passes last assembled prompt estimate and actual provider usage into compression state inputs", async () => {
    const harness = await createCompressionHarness();
    const compressedMessages: ReplacementSessionMessage[] = [
      {
        id: "summary-1",
        role: "system",
        content: "[CONTEXT COMPACTION — REFERENCE ONLY]\nSemantic summary marker",
        createdAt: "2030-01-01T00:00:00.000Z",
        metadata: { semanticCompression: true, summaryFormatVersion: "v1" }
      },
      {
        id: "current-user",
        role: "user",
        content: "latest user survives",
        createdAt: "2030-01-01T00:00:01.000Z"
      }
    ];
    const compactIfNeeded = vi.fn(async () => ({
      didCompress: true,
      messages: compressedMessages,
      diagnostics: compressionDiagnostics({
        preTokens: 500,
        postTokens: 100,
        estimatedSavingsRatio: 0.8
      }),
      userFacingMessage: "Session history compacted"
    }));
    const loop = harness.loop({
      sessionCompressionService: { compactIfNeeded },
      compressionConfig: normalizeSessionCompressionConfig({
        enabled: true,
        experimental: true,
        summaryModelContextLength: 50,
        threshold: 0.10
      })
    });

    await runBasicProviderTurn(loop);
    const promptEvent = (await harness.sessionDb.listEvents(harness.sessionId))
      .find((event) => event.kind === "prompt-assembled");
    const estimatedPromptTokens = promptEvent?.kind === "prompt-assembled"
      ? promptEvent.budget.estimatedTokens
      : undefined;
    await appendHistory(harness.sessionDb, harness.sessionId, "large history ".repeat(200));
    await runBasicProviderTurn(loop);

    expect(estimatedPromptTokens).toEqual(expect.any(Number));
    expect(compactIfNeeded).toHaveBeenCalledWith(expect.objectContaining({
      lastPromptTokensEstimated: estimatedPromptTokens,
      lastActualPromptTokens: 123
    }));
  });

  it("does not fail when provider usage is absent before a later compression check", async () => {
    const harness = await createCompressionHarness();
    harness.completeSpy.mockResolvedValue({
      ok: true,
      response: {
        ok: true,
        content: "mock-response",
        model: "test-model",
        provider: "test-provider"
      },
      fallbackUsed: false,
      attempts: [{ provider: "test-provider", model: "test-model", ok: true, content: "mock-response" }],
      toolCalls: []
    });
    const compactIfNeeded = vi.fn(async () => ({
      didCompress: false,
      messages: [],
      diagnostics: compressionDiagnostics({
        shouldCompress: false,
        reason: "anti-thrashing",
        warnings: ["skipped"]
      }),
      userFacingMessage: undefined
    }));
    const loop = harness.loop({
      sessionCompressionService: { compactIfNeeded },
      compressionConfig: normalizeSessionCompressionConfig({
        enabled: true,
        experimental: true,
        summaryModelContextLength: 50,
        threshold: 0.10
      })
    });

    await runBasicProviderTurn(loop);
    await appendHistory(harness.sessionDb, harness.sessionId, "large history ".repeat(200));
    await expect(runBasicProviderTurn(loop)).resolves.toMatchObject({
      providerExecution: expect.objectContaining({ ok: true })
    });

    expect(compactIfNeeded).toHaveBeenCalledWith(expect.not.objectContaining({
      lastActualPromptTokens: expect.anything()
    }));
  });

  it("provider turn succeeds when semantic compression skips for anti-thrashing", async () => {
    const harness = await createCompressionHarness();
    const compactIfNeeded = vi.fn(async () => ({
      didCompress: false,
      messages: [],
      diagnostics: compressionDiagnostics({
        shouldCompress: false,
        reason: "anti-thrashing",
        warnings: ["last 2 compressions saved <10% each; skipped to avoid thrashing"],
        ineffectiveCompressionCount: 2
      }),
      userFacingMessage: undefined
    }));
    const loop = harness.loop({
      sessionCompressionService: { compactIfNeeded },
      compressionConfig: normalizeSessionCompressionConfig({
        enabled: true,
        experimental: true,
        summaryModelContextLength: 50,
        threshold: 0.10
      })
    });
    await appendHistory(harness.sessionDb, harness.sessionId, "large history ".repeat(200));

    const result = await runBasicProviderTurn(loop);

    expect(result.providerExecution?.ok).toBe(true);
    expect(compactIfNeeded).toHaveBeenCalledTimes(1);
    const promptEvent = (await harness.sessionDb.listEvents(harness.sessionId))
      .find((event) => event.kind === "prompt-assembled");
    expect(promptEvent).toEqual(expect.objectContaining({
      kind: "prompt-assembled",
      budget: expect.objectContaining({
        compression: expect.objectContaining({
          triggered: false,
          mode: "none",
          warnings: expect.arrayContaining(["last 2 compressions saved <10% each; skipped to avoid thrashing"])
        })
      })
    }));
  });

  it("provider turn succeeds when compression event recording fails", async () => {
    const base = await createCompressionHarness();
    await appendHistory(base.sessionDb, base.sessionId, "history requiring compression ".repeat(200));
    const sessionDb = forwardingSessionDb(base.sessionDb, {
      appendEvent: async (sessionId, event) => {
        if (event.kind === "session-history-compressed" || event.kind === "session-compression-state") {
          throw new Error("compression event down");
        }
        return base.sessionDb.appendEvent(sessionId, event);
      }
    });
    const service = new SessionCompressionService({
      sessionDb,
      config: normalizeSessionCompressionConfig({
        enabled: true,
        experimental: true,
        protectFirstN: 0,
        protectLastN: 1,
        summaryModelContextLength: 50,
        threshold: 0.10
      })
    });
    const loop = base.loop({
      sessionDb,
      sessionCompressionService: service,
      compressionConfig: normalizeSessionCompressionConfig({
        enabled: true,
        experimental: true,
        protectFirstN: 0,
        protectLastN: 1,
        summaryModelContextLength: 50,
        threshold: 0.10
      })
    });

    const result = await runBasicProviderTurn(loop);

    expect(result.providerExecution?.ok).toBe(true);
    const promptEvent = (await base.sessionDb.listEvents(base.sessionId))
      .find((event) => event.kind === "prompt-assembled");
    expect(JSON.stringify(promptEvent)).toContain("compression event down");
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
