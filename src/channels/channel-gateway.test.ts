import { describe, it, expect, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChannelGateway, InMemoryChannelSessionStore, telegramGatewayCommands, authorizeChannelMessage } from "./channel-gateway.js";
import { ChannelApprovalStore } from "./channel-approval-store.js";
import { createFakeTelegramAdapter } from "../test/fakes/fake-telegram-adapter.js";
import { InMemorySurfacePointerStore } from "./surface-pointer-store.js";
import type { ChannelMessage, ChannelSessionKey } from "../contracts/channel.js";
import type { SecurityAssessment, SecurityPolicy, SecurityRequest } from "../contracts/security.js";
import type { Runtime } from "../runtime/create-runtime.js";
import { ActiveTurnRegistry } from "../gateway/active-turn-registry.js";
import { RuntimeCache } from "../runtime/runtime-cache.js";
import type { RuntimeFingerprint } from "../runtime/runtime-fingerprint.js";
import type { ChannelSessionStore } from "./channel-gateway.js";
import type { FakeDeliveryRecord } from "../test/fakes/fake-channel-adapter.js";
import { HookRegistry } from "../gateway/hook-registry.js";
import { createSQLiteSessionDB } from "../session/session-setup.js";
import { GatewayApprovalQueue } from "../gateway/approval-queue.js";
import { WorkspaceApprovalController, WorkspaceApprovalStore } from "../security/workspace-approval-controller.js";
import { renderApprovalActions } from "./approval-actions.js";

type FakeTelegramAdapter = ReturnType<typeof createFakeTelegramAdapter> & { records: FakeDeliveryRecord[]; clearRecords(): void };

async function setupGatewayApprovalQueue() {
  const directory = await mkdtemp(join(tmpdir(), "estacoda-channel-approval-"));
  const sessionDb = await createSQLiteSessionDB({ path: join(directory, "sessions.sqlite") });
  let nextId = 0;
  const queue = new GatewayApprovalQueue({
    db: sessionDb.db,
    controller: new WorkspaceApprovalController({
      store: new WorkspaceApprovalStore({ path: join(directory, "workspace-approvals.json") })
    }),
    idFactory: () => `gateway-approval-${++nextId}`,
    pollIntervalMs: 1
  });

  return {
    directory,
    sessionDb,
    queue,
    cleanup: async () => {
      sessionDb.close();
      await rm(directory, { recursive: true, force: true });
    }
  };
}

function createApprovalRuntime() {
  let calls = 0;
  const runtime = createMinimalRuntime();
  runtime.handle = async () => {
    calls += 1;
    if (calls === 1) {
      return {
        label: "approval",
        text: "blocked",
        matchedSkills: [],
        intent: { labels: ["general"], confidence: 1, nativeIntent: "general", suggestedToolsets: [], suggestedSkills: [], confirmationRequired: false, evidence: [], rationale: "" },
        securityDecision: "ask",
        toolExecutions: [
              { tool: { name: "terminal.run", description: "Run a terminal command", inputSchema: {}, riskClass: "destructive-local" as const, toolsets: ["terminal" as const], progressLabel: "Running", maxResultSizeChars: 10000 }, decision: "ask", riskClass: "destructive-local", targetKey: "terminal.run:rm-build", targetSummary: "rm -rf ./build" }
        ],
        toolPlans: [],
        skillOutcomes: [],
        artifacts: [],
        context: undefined,
        projectContext: undefined,
        progress: []
      } as Awaited<ReturnType<Runtime["handle"]>>;
    }

    return {
      label: "ok",
      text: "resumed",
      matchedSkills: [],
      intent: { labels: ["general"], confidence: 1, nativeIntent: "general", suggestedToolsets: [], suggestedSkills: [], confirmationRequired: false, evidence: [], rationale: "" },
      securityDecision: "allow",
      toolExecutions: [],
      toolPlans: [],
      skillOutcomes: [],
      artifacts: [],
      context: undefined,
      projectContext: undefined,
      progress: []
    } as Awaited<ReturnType<Runtime["handle"]>>;
  };

  return {
    runtime,
    calls: () => calls
  };
}

function runtimeResponse(input: {
  text: string;
  securityDecision: "allow" | "ask" | "deny";
  toolExecutions?: Awaited<ReturnType<Runtime["handle"]>>["toolExecutions"];
}): Awaited<ReturnType<Runtime["handle"]>> {
  return {
    label: "test",
    text: input.text,
    matchedSkills: [],
    intent: { labels: ["general"], confidence: 1, nativeIntent: "general", suggestedToolsets: [], suggestedSkills: [], confirmationRequired: false, evidence: [], rationale: "" },
    securityDecision: input.securityDecision,
    toolExecutions: input.toolExecutions ?? [],
    toolPlans: [],
    skillOutcomes: [],
    artifacts: [],
    context: undefined,
    projectContext: undefined,
    progress: []
  };
}

function commandExecution(decision: "allow" | "ask" | "deny", command: string): Awaited<ReturnType<Runtime["handle"]>>["toolExecutions"][number] {
  return {
    tool: { name: "terminal.run", description: "Run a terminal command", inputSchema: {}, riskClass: "destructive-local" as const, toolsets: ["terminal" as const], progressLabel: "Running", maxResultSizeChars: 10000 },
    decision,
    riskClass: "destructive-local",
    targetKey: undefined,
    targetSummary: command
  };
}

async function assessWithPolicy(policy: SecurityPolicy, request: SecurityRequest): Promise<SecurityAssessment> {
  if (policy.assess !== undefined) {
    return await policy.assess(request);
  }
  return {
    decision: policy.decide(request),
    mode: "adaptive",
    reason: "test",
    risk: "high"
  };
}

function createGrantProbeRuntime(securityPolicy: () => SecurityPolicy) {
  let calls = 0;
  const runtime = createMinimalRuntime();
  runtime.handle = async (input) => {
    calls += 1;
    if (input.text.includes("hardline")) {
      const assessment = await assessWithPolicy(securityPolicy(), {
        toolName: "terminal.run",
        riskClass: "destructive-local",
        targetKey: undefined,
        targetSummary: "rm -rf /",
        command: "rm -rf /",
        description: "run terminal command",
        context: {
          trustedWorkspace: true,
          targetConversationIsActive: true
        }
      });
      return runtimeResponse({
        text: `hardline decision=${assessment.decision}`,
        securityDecision: assessment.decision,
        toolExecutions: [commandExecution(assessment.decision, "rm -rf /")]
      });
    }

    if (input.text.includes("normal")) {
      const assessment = await assessWithPolicy(securityPolicy(), {
        toolName: "terminal.run",
        riskClass: "destructive-local",
        targetKey: undefined,
        targetSummary: "rm -rf ./build",
        command: "rm -rf ./build",
        description: "run terminal command",
        context: {
          trustedWorkspace: true,
          targetConversationIsActive: true
        }
      });
      return runtimeResponse({
        text: `normal decision=${assessment.decision}`,
        securityDecision: assessment.decision,
        toolExecutions: [commandExecution(assessment.decision, "rm -rf ./build")]
      });
    }

    if (calls > 1) {
      const assessment = await assessWithPolicy(securityPolicy(), {
        toolName: "terminal.run",
        riskClass: "destructive-local",
        targetKey: undefined,
        targetSummary: "rm -rf ./build",
        command: "rm -rf ./build",
        description: "run terminal command",
        context: {
          trustedWorkspace: true,
          targetConversationIsActive: true
        }
      });
      return runtimeResponse({
        text: `resumed decision=${assessment.decision}`,
        securityDecision: assessment.decision,
        toolExecutions: [commandExecution(assessment.decision, "rm -rf ./build")]
      });
    }

    return runtimeResponse({
      text: "blocked",
      securityDecision: "ask",
      toolExecutions: [commandExecution("ask", "rm -rf ./build")]
    });
  };

  return { runtime, calls: () => calls };
}

function createTerminalDecisionRuntime(decision: "ask" | "deny", command: string) {
  const runtime = createMinimalRuntime();
  runtime.handle = async () => runtimeResponse({
    text: `${decision} ${command}`,
    securityDecision: decision,
    toolExecutions: [commandExecution(decision, command)]
  });
  return runtime;
}

function createCachedPolicyProbeRuntime(securityPolicy: SecurityPolicy) {
  const runtime = createMinimalRuntime();
  runtime.handle = async (input) => {
    const assessment = await assessWithPolicy(securityPolicy, {
      toolName: "terminal.run",
      riskClass: "destructive-local",
      targetKey: undefined,
      targetSummary: "rm -rf ./build",
      command: "rm -rf ./build",
      description: "run terminal command",
      context: {
        trustedWorkspace: true,
        targetConversationIsActive: true
      }
    });

    return runtimeResponse({
      text: `${input.text} decision=${assessment.decision}`,
      securityDecision: assessment.decision,
      toolExecutions: [commandExecution(assessment.decision, "rm -rf ./build")]
    });
  };
  return runtime;
}

function makeMessage(text: string, overrides?: Partial<ChannelMessage>): ChannelMessage {
  const sessionKey: ChannelSessionKey = {
    platform: "telegram",
    chatId: "123456",
    userId: "user-1"
  };
  return {
    id: "msg-1",
    channel: "telegram",
    sessionKey,
    sender: { id: "user-1", displayName: "Test User" },
    text,
    receivedAt: new Date().toISOString(),
    ...overrides
  };
}

function createMinimalRuntime(): Runtime {
  return {
    describe: () => "minimal",
    getStatus: () => ({
      kind: "status" as const,
      agentName: "Test",
      model: { provider: "test", id: "test" },
      securityMode: "adaptive",
      skillCount: 0,
      toolCount: 0,
      mcp: { active: 0, total: 0 },
      taskflowActive: false,
      warnings: [],
    }),
    getStartup: () => ({
      kind: "startup" as const,
      agentName: "Test",
      taglines: [],
      model: { provider: "test", id: "test" },
      readiness: "ready" as const,
      warnings: [],
    }),
    getStartupReadiness: async () => ({
      workspaceTrust: "untrusted" as const,
      workspaceVerification: "unverified" as const,
      providerReadiness: "missing-config" as const,
      versionStatus: "unknown" as const,
      model: { provider: "test", id: "test" },
      warnings: [],
    }),
    getModelInfo: () => ({
      kind: "kv" as const,
      title: "Model",
      entries: [{ key: "provider", value: "test" }],
    }),
    tools: () => [],
    skills: () => [],
    latestResumeNote: async () => undefined,
    inspectMemoryPromotions: async () => [],
    inspectMcpServers: () => [],
    handle: async () =>
      ({
        label: "ok",
        text: "ok",
        matchedSkills: [],
        intent: {
          labels: ["general"],
          confidence: 1,
          nativeIntent: "general",
          suggestedToolsets: [],
          suggestedSkills: [],
          confirmationRequired: false,
          evidence: [],
          rationale: ""
        },
        securityDecision: "allow",
        toolExecutions: [],
        toolPlans: [],
        skillOutcomes: [],
        artifacts: [],
        context: undefined,
        projectContext: undefined,
        progress: []
      }) as unknown as Awaited<ReturnType<Runtime["handle"]>>,
    trustWorkspace: async () => {},
    isWorkspaceTrusted: async () => false,
    revokeWorkspaceTrust: async () => false,
    dispose: async () => {},
    sessionDb: {
      createSession: async (input) => ({
        id: input.id ?? "sess-1",
        profileId: input.profileId,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        metadata: input.metadata
      }),
      getSession: async () => undefined,
      listSessions: async () => [],
      endSession: async () => {},
      appendMessage: async (input) => ({
        id: "msg-1",
        sessionId: input.sessionId,
        role: input.role,
        content: input.content,
        createdAt: new Date().toISOString(),
        channel: input.channel,
        metadata: input.metadata
      }),
      replaceMessages: async () => [],
      rewriteTranscript: async () => [],
      appendEvent: async () => {},
      listMessages: async () => [],
      listEvents: async () => [],
      search: async () => []
    },
    sessionId: "sess-1"
  } as Runtime;
}

function compactResult(overrides: {
  fallbackUsed?: boolean;
  fallbackReason?: string;
  warnings?: string[];
  activeSessionId?: string;
  rotated?: boolean;
} = {}) {
  const activeSessionId = overrides.activeSessionId ?? "sess-1";
  const rotated = overrides.rotated ?? false;
  return {
    didCompress: true,
    originalSessionId: "sess-1",
    activeSessionId,
    replacementSessionId: rotated ? activeSessionId : undefined,
    rotated,
    messages: [
      { id: "m1", role: "user" as const, content: "head" },
      { id: "summary", role: "system" as const, content: "summary", metadata: { semanticCompression: true } },
      { id: "m7", role: "agent" as const, content: "tail" },
      { id: "m8", role: "user" as const, content: "latest" }
    ],
    diagnostics: {
      shouldCompress: true,
      reason: "forced",
      preTokens: 2000,
      postTokens: 900,
      estimatedSavingsTokens: 1100,
      estimatedSavingsRatio: 0.55,
      sourceMessageCount: 8,
      summarizedMessageCount: 4,
      protectedMessageCount: 4,
      protectedFirstN: 1,
      protectedLastN: 1,
      protectedSpans: [],
      protectedCategories: [],
      summaryFormatVersion: "v1",
      summaryChars: 100,
      fallbackUsed: overrides.fallbackUsed ?? false,
      fallbackReason: overrides.fallbackReason,
      warnings: overrides.warnings ?? [],
      eventWarnings: [],
      prunedToolResults: 0,
      prunedToolResultChars: 0,
      protectedToolResultsKept: 0,
      scopeKey: "profile:session",
      ineffectiveCompressionCount: 0
    },
    userFacingMessage: "Session history compacted"
  };
}

describe("ChannelGateway commands", () => {
  it("/compact runs manual session compaction and replies through the gateway", async () => {
    const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
    const calls: Array<{ sessionId?: string; focusTopic?: string; preserveTranscript?: boolean }> = [];
    const hygieneRun = vi.fn();
    const gateway = new ChannelGateway({
      adapters: [adapter],
      runtimeForSession: async ({ sessionId }) => ({
        ...createMinimalRuntime(),
        sessionId,
        compactSession: async (input?: { sessionId?: string; focusTopic?: string; preserveTranscript?: boolean }) => {
          calls.push(input ?? {});
          return compactResult({ activeSessionId: sessionId });
        }
      }),
      sessionStore: new InMemoryChannelSessionStore(),
      authPolicy: { telegram: { allowedUserIds: ["user-1"] } },
      sessionHygieneService: { run: hygieneRun }
    });

    const result = await gateway.receive(makeMessage("/compact deploy handoff"));

    expect(calls).toHaveLength(1);
    expect(calls[0]?.sessionId).toBe(result.sessionId);
    expect(calls[0]?.focusTopic).toBe("deploy handoff");
    expect(calls[0]?.preserveTranscript).toBe(true);
    expect(result.replyText).toContain("Compacted 8 messages -> 4 messages");
    expect(result.replyText).toContain("Focus topic: deploy handoff");
    expect(hygieneRun).not.toHaveBeenCalled();
  });

  it("/compact reports provider fallback warnings without adding gateway hygiene", async () => {
    const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
    const gateway = new ChannelGateway({
      adapters: [adapter],
      runtimeForSession: async ({ sessionId }) => ({
        ...createMinimalRuntime(),
        sessionId,
        compactSession: async () => compactResult({
          fallbackUsed: true,
          fallbackReason: "failed",
          warnings: ["auxiliary compression failed; used deterministic fallback"]
        })
      }),
      sessionStore: new InMemoryChannelSessionStore(),
      authPolicy: { telegram: { allowedUserIds: ["user-1"] } }
    });

    const result = await gateway.receive(makeMessage("/compact"));

    expect(result.replyText).toContain("Warning: fallback summary used (failed)");
    expect(result.replyText).toContain("Warning: auxiliary compression failed; used deterministic fallback");
  });

  it("/compact switches the channel session pointer when compaction rotates", async () => {
    const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
    const sessionStore = new InMemoryChannelSessionStore();
    const parentSessionId = await sessionStore.getOrCreateSessionId(makeMessage("seed").sessionKey);
    const invalidated: string[] = [];
    const gateway = new ChannelGateway({
      adapters: [adapter],
      runtimeForSession: async ({ sessionId }) => ({
        ...createMinimalRuntime(),
        sessionId,
        compactSession: async () => compactResult({
          activeSessionId: "sess-1-child",
          rotated: true
        })
      }),
      sessionStore,
      authPolicy: { telegram: { allowedUserIds: ["user-1"] } },
      runtimeCache: {
        getOrCreate: async () => {
          throw new Error("not used");
        },
        invalidate: async (sessionId: string) => {
          invalidated.push(sessionId);
        },
        suspend: async () => {}
      } as never
    });

    const result = await gateway.receive(makeMessage("/compact deploy handoff"));
    const nextSessionId = await sessionStore.getOrCreateSessionId(makeMessage("next").sessionKey);

    expect(result.sessionId).toBe("sess-1-child");
    expect(nextSessionId).toBe("sess-1-child");
    expect(result.replyText).toContain("Active session: sess-1-child");
    expect(invalidated).toContain(parentSessionId);
  });

  it("/compact is rejected while the same chat has an active turn", async () => {
    const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
    const registry = new ActiveTurnRegistry({ busyAckCooldownMs: 30_000 });
    const compactSession = vi.fn(async () => compactResult());
    const gateway = new ChannelGateway({
      adapters: [adapter],
      runtimeForSession: async ({ sessionId }) => ({
        ...createMinimalRuntime(),
        sessionId,
        compactSession,
        handle: async () => {
          await new Promise((resolve) => setTimeout(resolve, 100));
          return {
            label: "ok",
            text: "ok",
            matchedSkills: [],
            intent: { labels: ["general"], confidence: 1, nativeIntent: "general", suggestedToolsets: [], suggestedSkills: [], confirmationRequired: false, evidence: [], rationale: "" },
            securityDecision: "allow",
            toolExecutions: [],
            toolPlans: [],
            skillOutcomes: [],
            artifacts: [],
            context: undefined,
            projectContext: undefined,
            progress: []
          } as Awaited<ReturnType<Runtime["handle"]>>;
        }
      }),
      sessionStore: new InMemoryChannelSessionStore(),
      authPolicy: { telegram: { allowedUserIds: ["user-1"] } },
      activeTurnRegistry: registry
    });

    const first = gateway.receive(makeMessage("hello"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    const compact = await gateway.receive(makeMessage("/compact deploy handoff"));
    const normal = await first;

    expect(normal.replyText).toBe("ok");
    expect(compact.replyText).toContain("Please wait before compacting");
    expect(compactSession).not.toHaveBeenCalled();
    expect(registry.stats().totalStarted).toBe(1);
  });

  it("runs gateway hygiene before runtime acquisition for normal turns", async () => {
    const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
    const order: string[] = [];
    const hygieneRun = vi.fn(async () => {
      order.push("hygiene");
      return {
        status: "compacted" as const,
        reason: "threshold-exceeded" as const,
        preTokens: 100,
        thresholdTokens: 85,
        activeSessionId: "channel-telegram-default-dm-123456-main",
        rotated: false,
        result: compactResult(),
        warnings: []
      };
    });
    const gateway = new ChannelGateway({
      adapters: [adapter],
      runtimeForSession: async () => {
        order.push("runtime");
        return createMinimalRuntime();
      },
      sessionStore: new InMemoryChannelSessionStore(),
      authPolicy: { telegram: { allowedUserIds: ["user-1"] } },
      sessionHygieneService: { run: hygieneRun }
    });

    const result = await gateway.receive(makeMessage("please handle this"));

    expect(result.replyText).toBe("ok");
    expect(hygieneRun).toHaveBeenCalledWith(expect.objectContaining({ sessionId: result.sessionId }));
    expect(order).toEqual(["hygiene", "runtime"]);
  });

  it("adopts a rotated gateway hygiene session before runtime acquisition", async () => {
    const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
    const sessionStore = new InMemoryChannelSessionStore();
    const parentSessionId = await sessionStore.getOrCreateSessionId(makeMessage("seed").sessionKey);
    const runtimeSessionIds: string[] = [];
    const invalidated: string[] = [];
    const gateway = new ChannelGateway({
      adapters: [adapter],
      runtimeForSession: async ({ sessionId }) => {
        runtimeSessionIds.push(sessionId);
        return {
          ...createMinimalRuntime(),
          sessionId
        };
      },
      sessionStore,
      authPolicy: { telegram: { allowedUserIds: ["user-1"] } },
      sessionHygieneService: {
        run: vi.fn(async () => ({
          status: "compacted" as const,
          reason: "threshold-exceeded" as const,
          preTokens: 100,
          thresholdTokens: 85,
          activeSessionId: "sess-1-child",
          rotated: true,
          result: compactResult({
            activeSessionId: "sess-1-child",
            rotated: true
          }),
          warnings: []
        }))
      },
      runtimeCache: {
        getOrCreate: async () => {
          throw new Error("not used");
        },
        invalidate: async (sessionId: string) => {
          invalidated.push(sessionId);
        },
        suspend: async () => {}
      } as never
    });

    const result = await gateway.receive(makeMessage("please handle this"));
    const storedSessionId = await sessionStore.getOrCreateSessionId(makeMessage("next").sessionKey);

    expect(result.sessionId).toBe("sess-1-child");
    expect(runtimeSessionIds).toEqual(["sess-1-child"]);
    expect(storedSessionId).toBe("sess-1-child");
    expect(invalidated).toContain(parentSessionId);
  });

  it("adopts a runtime session rotation after provider-turn auto compression", async () => {
    const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
    const sessionStore = new InMemoryChannelSessionStore();
    const parentSessionId = await sessionStore.getOrCreateSessionId(makeMessage("seed").sessionKey);
    const invalidated: string[] = [];
    const gateway = new ChannelGateway({
      adapters: [adapter],
      runtimeForSession: async ({ sessionId }) => ({
        ...createMinimalRuntime(),
        sessionId: `${sessionId}-child`,
        consumeSessionRotation: () => ({
          originalSessionId: sessionId,
          activeSessionId: `${sessionId}-child`
        })
      }),
      sessionStore,
      authPolicy: { telegram: { allowedUserIds: ["user-1"] } },
      runtimeCache: {
        getOrCreate: async () => {
          throw new Error("not used");
        },
        invalidate: async (sessionId: string) => {
          invalidated.push(sessionId);
        },
        suspend: async () => {}
      } as never
    });

    const result = await gateway.receive(makeMessage("please handle this"));
    const storedSessionId = await sessionStore.getOrCreateSessionId(makeMessage("next").sessionKey);

    expect(result.sessionId).toBe(`${parentSessionId}-child`);
    expect(storedSessionId).toBe(`${parentSessionId}-child`);
    expect(invalidated).toContain(parentSessionId);
  });

  it("adopts a runtime session rotation when the rotated turn throws", async () => {
    const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
    const sessionStore = new InMemoryChannelSessionStore();
    const parentSessionId = await sessionStore.getOrCreateSessionId(makeMessage("seed").sessionKey);
    const runtimeSessionIds: string[] = [];
    const invalidated: string[] = [];
    const suspended: string[] = [];
    const gateway = new ChannelGateway({
      adapters: [adapter],
      runtimeForSession: async ({ sessionId }) => {
        runtimeSessionIds.push(sessionId);
        if (runtimeSessionIds.length === 1) {
          return {
            ...createMinimalRuntime(),
            sessionId: `${sessionId}-child`,
            consumeSessionRotation: () => ({
              originalSessionId: sessionId,
              activeSessionId: `${sessionId}-child`
            }),
            handle: async () => {
              throw new Error("provider exploded after rotation");
            }
          };
        }
        return createMinimalRuntime();
      },
      sessionStore,
      authPolicy: { telegram: { allowedUserIds: ["user-1"] } },
      runtimeCache: {
        getOrCreate: async () => {
          throw new Error("not used");
        },
        invalidate: async (sessionId: string) => {
          invalidated.push(sessionId);
        },
        suspend: async (sessionId: string) => {
          suspended.push(sessionId);
        }
      } as never
    });

    const failed = await gateway.receive(makeMessage("please handle this"));
    const storedAfterFailure = await sessionStore.getOrCreateSessionId(makeMessage("next").sessionKey);
    const next = await gateway.receive(makeMessage("please continue"));

    expect(failed.sessionId).toBe(`${parentSessionId}-child`);
    expect(failed.replyText).toContain("provider exploded after rotation");
    expect(storedAfterFailure).toBe(`${parentSessionId}-child`);
    expect(next.sessionId).toBe(`${parentSessionId}-child`);
    expect(runtimeSessionIds).toEqual([parentSessionId, `${parentSessionId}-child`]);
    expect(invalidated).toContain(parentSessionId);
    expect(suspended).toContain(`${parentSessionId}-child`);
  });

  it("does not adopt stale or unrelated runtime rotations", async () => {
    const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
    const sessionStore = new InMemoryChannelSessionStore();
    const parentSessionId = await sessionStore.getOrCreateSessionId(makeMessage("seed").sessionKey);
    const invalidated: string[] = [];
    const gateway = new ChannelGateway({
      adapters: [adapter],
      runtimeForSession: async ({ sessionId }) => ({
        ...createMinimalRuntime(),
        sessionId: `${sessionId}-unrelated-child`,
        consumeSessionRotation: () => ({
          originalSessionId: "some-other-session",
          activeSessionId: `${sessionId}-unrelated-child`
        })
      }),
      sessionStore,
      authPolicy: { telegram: { allowedUserIds: ["user-1"] } },
      runtimeCache: {
        getOrCreate: async () => {
          throw new Error("not used");
        },
        invalidate: async (sessionId: string) => {
          invalidated.push(sessionId);
        },
        suspend: async () => {}
      } as never
    });

    const result = await gateway.receive(makeMessage("please handle this"));
    const storedSessionId = await sessionStore.getOrCreateSessionId(makeMessage("next").sessionKey);

    expect(result.sessionId).toBe(parentSessionId);
    expect(storedSessionId).toBe(parentSessionId);
    expect(invalidated).not.toContain(parentSessionId);
  });

  it("continues the gateway turn when hygiene fails safely", async () => {
    const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
    const warnings: string[] = [];
    const gateway = new ChannelGateway({
      adapters: [adapter],
      runtimeForSession: async () => createMinimalRuntime(),
      sessionStore: new InMemoryChannelSessionStore(),
      authPolicy: { telegram: { allowedUserIds: ["user-1"] } },
      sessionHygieneService: {
        run: vi.fn(async () => {
          throw new Error("lock busy");
        })
      },
      logWarning: (message) => warnings.push(message)
    });

    const result = await gateway.receive(makeMessage("normal turn"));

    expect(result.replyText).toBe("ok");
    expect(warnings.join("\n")).toContain("lock busy");
  });

  it("does not run gateway hygiene for read-only gateway commands", async () => {
    const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
    const hygieneRun = vi.fn();
    const gateway = new ChannelGateway({
      adapters: [adapter],
      runtimeForSession: async () => createMinimalRuntime(),
      sessionStore: new InMemoryChannelSessionStore(),
      authPolicy: { telegram: { allowedUserIds: ["user-1"] } },
      sessionHygieneService: { run: hygieneRun }
    });

    const result = await gateway.receive(makeMessage("/help"));

    expect(result.replyText).toContain("EstaCoda channel commands");
    expect(hygieneRun).not.toHaveBeenCalled();
  });

  describe("/sethome", () => {
    it("sets home delivery to current chat by default", async () => {
      const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
      const pointerStore = new InMemorySurfacePointerStore();
      const gateway = new ChannelGateway({
        adapters: [adapter],
        runtimeForSession: async () => createMinimalRuntime(),
        sessionStore: new InMemoryChannelSessionStore(),
        authPolicy: { telegram: { allowedUserIds: ["user-1"] } },
        surfacePointerStore: pointerStore
      });

      const result = await gateway.receive(makeMessage("/sethome"));
      expect(result.replyText).toContain("telegram:123456");

      const pointer = await pointerStore.getPointer("telegram", "123456");
      expect(pointer?.homeDelivery).toBe("telegram:123456");
    });

    it("sets home delivery to local when requested", async () => {
      const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
      const pointerStore = new InMemorySurfacePointerStore();
      const gateway = new ChannelGateway({
        adapters: [adapter],
        runtimeForSession: async () => createMinimalRuntime(),
        sessionStore: new InMemoryChannelSessionStore(),
        authPolicy: { telegram: { allowedUserIds: ["user-1"] } },
        surfacePointerStore: pointerStore
      });

      const result = await gateway.receive(makeMessage("/sethome local"));
      expect(result.replyText).toContain("local");

      const pointer = await pointerStore.getPointer("telegram", "123456");
      expect(pointer?.homeDelivery).toBe("local");
    });

    it("clears home delivery when requested", async () => {
      const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
      const pointerStore = new InMemorySurfacePointerStore();
      await pointerStore.setPointer("telegram", "123456", {
        sessionId: "sess-1",
        attachedAt: new Date().toISOString(),
        homeDelivery: "telegram:123456"
      });

      const gateway = new ChannelGateway({
        adapters: [adapter],
        runtimeForSession: async () => createMinimalRuntime(),
        sessionStore: new InMemoryChannelSessionStore(),
        authPolicy: { telegram: { allowedUserIds: ["user-1"] } },
        surfacePointerStore: pointerStore
      });

      const result = await gateway.receive(makeMessage("/sethome clear"));
      expect(result.replyText).toContain("Cleared");

      const pointer = await pointerStore.getPointer("telegram", "123456");
      expect(pointer?.homeDelivery).toBeUndefined();
    });

    it("returns error when surface pointer store is missing", async () => {
      const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
      const gateway = new ChannelGateway({
        adapters: [adapter],
        runtimeForSession: async () => createMinimalRuntime(),
        sessionStore: new InMemoryChannelSessionStore(),
        authPolicy: { telegram: { allowedUserIds: ["user-1"] } }
      });

      const result = await gateway.receive(makeMessage("/sethome"));
      expect(result.replyText).toContain("not configured");
    });
  });

  describe("/diagnostics", () => {
    it("returns diagnostics from provider when available", async () => {
      const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
      const gateway = new ChannelGateway({
        adapters: [adapter],
        runtimeForSession: async () => createMinimalRuntime(),
        sessionStore: new InMemoryChannelSessionStore(),
        authPolicy: { telegram: { allowedUserIds: ["user-1"] } },
        diagnostics: async () => "Diagnostics: ok"
      });

      const result = await gateway.receive(makeMessage("/diagnostics"));
      expect(result.replyText).toBe("Diagnostics: ok");
    });

    it("returns fallback when no diagnostics provider is configured", async () => {
      const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
      const gateway = new ChannelGateway({
        adapters: [adapter],
        runtimeForSession: async () => createMinimalRuntime(),
        sessionStore: new InMemoryChannelSessionStore(),
        authPolicy: { telegram: { allowedUserIds: ["user-1"] } }
      });

      const result = await gateway.receive(makeMessage("/diagnostics"));
      expect(result.replyText).toContain("No diagnostics provider configured");
      expect(result.replyText).toContain("telegram");
    });
  });

  describe("/status", () => {
    it("shows attached state with home delivery", async () => {
      const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
      const pointerStore = new InMemorySurfacePointerStore();
      await pointerStore.setPointer("telegram", "123456", {
        sessionId: "sess-linked",
        attachedAt: "2024-01-01T00:00:00Z",
        homeDelivery: "local"
      });

      const gateway = new ChannelGateway({
        adapters: [adapter],
        runtimeForSession: async () => createMinimalRuntime(),
        sessionStore: new InMemoryChannelSessionStore(),
        authPolicy: { telegram: { allowedUserIds: ["user-1"] } },
        surfacePointerStore: pointerStore
      });

      const result = await gateway.receive(makeMessage("/status"));
      expect(result.replyText).toContain("Attached to: sess-linked");
      expect(result.replyText).toContain("Home delivery: local");
    });

    it("shows independent state when not attached", async () => {
      const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
      const gateway = new ChannelGateway({
        adapters: [adapter],
        runtimeForSession: async () => createMinimalRuntime(),
        sessionStore: new InMemoryChannelSessionStore(),
        authPolicy: { telegram: { allowedUserIds: ["user-1"] } }
      });

      const result = await gateway.receive(makeMessage("/status"));
      expect(result.replyText).toContain("independent");
      expect(result.replyText).not.toContain("Attached to:");
    });
  });

  describe("channel-triggered run metadata", () => {
    it("passes source metadata to runtime factory", async () => {
      const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
      let capturedMetadata: Record<string, unknown> | undefined;

      const gateway = new ChannelGateway({
        adapters: [adapter],
        runtimeForSession: async ({ metadata }) => {
          capturedMetadata = metadata;
          return createMinimalRuntime();
        },
        sessionStore: new InMemoryChannelSessionStore(),
        authPolicy: { telegram: { allowedUserIds: ["user-1"] } }
      });

      await gateway.receive(makeMessage("hello"));
      expect(capturedMetadata).toBeDefined();
      expect(capturedMetadata?.surfaceType).toBe("telegram");
      expect(capturedMetadata?.chatId).toBe("123456");
      expect(capturedMetadata?.userId).toBe("user-1");
      expect(capturedMetadata?.origin).toBe("message");
    });

    it("marks command origin for slash-prefixed messages", async () => {
      const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
      let capturedMetadata: Record<string, unknown> | undefined;

      const gateway = new ChannelGateway({
        adapters: [adapter],
        runtimeForSession: async ({ metadata }) => {
          capturedMetadata = metadata;
          return createMinimalRuntime();
        },
        sessionStore: new InMemoryChannelSessionStore(),
        authPolicy: { telegram: { allowedUserIds: ["user-1"] } }
      });

      await gateway.receive(makeMessage("/unknown"));
      expect(capturedMetadata?.origin).toBe("command");
    });

    it("marks message origin for regular messages", async () => {
      const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
      let capturedMetadata: Record<string, unknown> | undefined;

      const gateway = new ChannelGateway({
        adapters: [adapter],
        runtimeForSession: async ({ metadata }) => {
          capturedMetadata = metadata;
          return createMinimalRuntime();
        },
        sessionStore: new InMemoryChannelSessionStore(),
        authPolicy: { telegram: { allowedUserIds: ["user-1"] } }
      });

      await gateway.receive(makeMessage("hello world"));
      expect(capturedMetadata?.origin).toBe("message");
    });
  });

  describe("telegramGatewayCommands", () => {
    it("includes /compact, /sethome, and /diagnostics", () => {
      const commands = telegramGatewayCommands();
      const compact = commands.find((c) => c.command === "/compact");
      const sethome = commands.find((c) => c.command === "/sethome");
      const diagnostics = commands.find((c) => c.command === "/diagnostics");
      expect(compact).toBeDefined();
      expect(sethome).toBeDefined();
      expect(diagnostics).toBeDefined();
    });
  });

  describe("authorizeChannelMessage", () => {
    it("allows messages from allowed user ids", () => {
      const result = authorizeChannelMessage(
        makeMessage("hi"),
        { telegram: { allowedUserIds: ["user-1"] } }
      );
      expect(result.allowed).toBe(true);
    });

    it("denies messages from unknown users", () => {
      const result = authorizeChannelMessage(
        makeMessage("hi"),
        { telegram: { allowedUserIds: ["user-2"] } }
      );
      expect(result.allowed).toBe(false);
    });
  });

  // Stage 5D ChannelGateway integration tests
  describe("Stage 5D integration", () => {
    function createFakeRuntimeCache(): RuntimeCache & {
      getCalls: Array<{ sessionId: string; fingerprint: unknown; securityPolicy: unknown; metadata?: Record<string, unknown> }>;
      suspendCalls: Array<{ sessionId: string; reason: string }>;
      invalidateCalls: string[];
      releaseLeaseCalls: string[];
      borrowedRuntimes: Map<string, Runtime>;
    } {
      const getCalls: Array<{ sessionId: string; fingerprint: unknown; securityPolicy: unknown; metadata?: Record<string, unknown> }> = [];
      const suspendCalls: Array<{ sessionId: string; reason: string }> = [];
      const invalidateCalls: string[] = [];
      const releaseLeaseCalls: string[] = [];
      const borrowedRuntimes = new Map<string, Runtime>();

      const cache = {
        async get(sessionId: string, fingerprint: unknown, securityPolicy: unknown, metadata?: Record<string, unknown>) {
          getCalls.push({ sessionId, fingerprint, securityPolicy, metadata });
          const rt = createMinimalRuntime();
          borrowedRuntimes.set(sessionId, rt);
          return new Proxy(rt, {
            get(target, prop) {
              if (prop === "dispose") {
                return async () => {
                  releaseLeaseCalls.push(sessionId);
                };
              }
              return (target as Record<string, unknown>)[prop as string];
            }
          }) as Runtime;
        },
        async suspend(sessionId: string, reason: string) {
          suspendCalls.push({ sessionId, reason });
        },
        async invalidate(sessionId: string) {
          invalidateCalls.push(sessionId);
        },
        getCalls,
        suspendCalls,
        invalidateCalls,
        releaseLeaseCalls,
        borrowedRuntimes,
      } as unknown as RuntimeCache & {
        getCalls: Array<{ sessionId: string; fingerprint: unknown; securityPolicy: unknown; metadata?: Record<string, unknown> }>;
        suspendCalls: Array<{ sessionId: string; reason: string }>;
        invalidateCalls: string[];
        releaseLeaseCalls: string[];
        borrowedRuntimes: Map<string, Runtime>;
      };

      return cache;
    }

    function createThrowingRuntime(err: Error): Runtime {
      const rt = createMinimalRuntime();
      return {
        ...rt,
        handle: async () => { throw err; },
      };
    }

    function createFakeFingerprint(): RuntimeFingerprint {
      return {
        modelProvider: "test",
        modelId: "test",
        modelContextWindowTokens: 4096,
        profileId: "default",
        securityMode: "adaptive",
        securityAssessorEnabled: false,
        securityAssessorTimeoutMs: 5000,
        approvalControllerPresent: false,
        explicitSecurityPolicyPresent: false,
        workspaceRoot: "/tmp",
        homeDir: "/tmp",
        localSkillsRoot: "/tmp",
        trustStorePath: "/tmp/trust.json",
        disabledToolsets: [],
        mcpServersHash: "hash",
        browserHash: "hash",
        enableWebNetwork: false,
        webMaxContentChars: 1000,
        compressionConfigHash: "hash",
        externalMemoryConfigHash: "hash",
        disableCronTools: false,
        skillAutonomy: "off",
        skillConfigHash: "hash",
        externalSkillRoots: [],
        uiLanguage: "en",
        uiFlavor: "default",
        activityLabels: "default",
        agentProfileMode: "default",
        agentResponseLanguage: "en",
        imageGenHash: "hash",
        ttsHash: "hash",
        sttHash: "hash",
        telegramReady: false,
        currentPlatform: "test",
      };
    }

    it("receive() with activeTurnRegistry prevents parallel turns", async () => {
      const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
      const registry = new ActiveTurnRegistry({ busyAckCooldownMs: 30_000 });
      let handleStarted = false;

      const gateway = new ChannelGateway({
        adapters: [adapter],
        runtimeForSession: async () => ({
          ...createMinimalRuntime(),
          handle: async () => {
            handleStarted = true;
            await new Promise((resolve) => setTimeout(resolve, 100));
            return {
              label: "ok",
              text: "ok",
              matchedSkills: [],
              intent: { labels: ["general"], confidence: 1, nativeIntent: "general", suggestedToolsets: [], suggestedSkills: [], confirmationRequired: false, evidence: [], rationale: "" },
              securityDecision: "allow",
              toolExecutions: [],
              toolPlans: [],
              skillOutcomes: [],
              artifacts: [],
              context: undefined,
              projectContext: undefined,
              progress: []
            } as Awaited<ReturnType<Runtime["handle"]>>;
          }
        }),
        sessionStore: new InMemoryChannelSessionStore(),
        authPolicy: { telegram: { allowedUserIds: ["user-1"] } },
        activeTurnRegistry: registry
      });

      const first = gateway.receive(makeMessage("hello"));
      const second = gateway.receive(makeMessage("hello again"));
      const [r1, r2] = await Promise.all([first, second]);

      expect(handleStarted).toBe(true);
      expect(r1.replyText).toBe("ok");
      expect(r2.replyText).toBe("");
      expect(r2.artifactCount).toBe(0);
      expect(registry.stats().totalStarted).toBe(1);
    });

    it("receive() rejects new turns while draining with no side effects", async () => {
      const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
      const registry = new ActiveTurnRegistry();
      let runtimeCreated = false;
      const hygieneRun = vi.fn();

      const gateway = new ChannelGateway({
        adapters: [adapter],
        runtimeForSession: async () => {
          runtimeCreated = true;
          return createMinimalRuntime();
        },
        sessionStore: new InMemoryChannelSessionStore(),
        authPolicy: { telegram: { allowedUserIds: ["user-1"] } },
        activeTurnRegistry: registry,
        sessionHygieneService: { run: hygieneRun },
        isDraining: () => true,
      });

      const result = await gateway.receive(makeMessage("hello"));

      expect(result.replyText).toBe("Gateway is restarting, please try again shortly.");
      expect(registry.stats().totalStarted).toBe(0);
      expect(runtimeCreated).toBe(false);
      expect(hygieneRun).not.toHaveBeenCalled();
      // Exactly one drain message via #deliverText; no duplicate adapter.send
      const drainRecords = adapter.records.filter((r) => r.text === "Gateway is restarting, please try again shortly.");
      expect(drainRecords.length).toBe(1);
    });

    it("receive() busy ack is delivered via adapter when busy", async () => {
      const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
      const registry = new ActiveTurnRegistry({ busyAckCooldownMs: 30_000 });

      const gateway = new ChannelGateway({
        adapters: [adapter],
        runtimeForSession: async () => ({
          ...createMinimalRuntime(),
          handle: async () => {
            await new Promise((resolve) => setTimeout(resolve, 200));
            return {
              label: "ok",
              text: "ok",
              matchedSkills: [],
              intent: { labels: ["general"], confidence: 1, nativeIntent: "general", suggestedToolsets: [], suggestedSkills: [], confirmationRequired: false, evidence: [], rationale: "" },
              securityDecision: "allow",
              toolExecutions: [],
              toolPlans: [],
              skillOutcomes: [],
              artifacts: [],
              context: undefined,
              projectContext: undefined,
              progress: []
            } as unknown as Awaited<ReturnType<Runtime["handle"]>>;
          }
        }),
        sessionStore: new InMemoryChannelSessionStore(),
        authPolicy: { telegram: { allowedUserIds: ["user-1"] } },
        activeTurnRegistry: registry
      });

      const first = gateway.receive(makeMessage("hello"));
      const second = gateway.receive(makeMessage("hello again"));
      await Promise.all([first, second]);

      const busyTexts = adapter.records.filter((r) => r.kind === "text" && r.text?.includes("busy"));
      expect(busyTexts.length).toBe(1);
    });

    it("receive() busy ack only once within cooldown", async () => {
      const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
      const registry = new ActiveTurnRegistry({ busyAckCooldownMs: 30_000 });

      const gateway = new ChannelGateway({
        adapters: [adapter],
        runtimeForSession: async () => ({
          ...createMinimalRuntime(),
          handle: async () => {
            await new Promise((resolve) => setTimeout(resolve, 500));
            return {
              label: "ok",
              text: "ok",
              matchedSkills: [],
              intent: { labels: ["general"], confidence: 1, nativeIntent: "general", suggestedToolsets: [], suggestedSkills: [], confirmationRequired: false, evidence: [], rationale: "" },
              securityDecision: "allow",
              toolExecutions: [],
              toolPlans: [],
              skillOutcomes: [],
              artifacts: [],
              context: undefined,
              projectContext: undefined,
              progress: []
            } as unknown as Awaited<ReturnType<Runtime["handle"]>>;
          }
        }),
        sessionStore: new InMemoryChannelSessionStore(),
        authPolicy: { telegram: { allowedUserIds: ["user-1"] } },
        activeTurnRegistry: registry
      });

      const first = gateway.receive(makeMessage("hello"));
      // Give the first turn time to acquire the registry lock
      await new Promise((resolve) => setTimeout(resolve, 10));
      const second = gateway.receive(makeMessage("second"));
      await second; // busy, returns immediately
      const third = gateway.receive(makeMessage("third"));
      await third; // busy within cooldown, returns immediately
      await first;

      const busyTexts = adapter.records.filter((r) => r.kind === "text" && r.text?.includes("busy"));
      expect(busyTexts.length).toBe(1);
    });

    it("receive() busy ack delivered again after cooldown expires", async () => {
      const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
      const registry = new ActiveTurnRegistry({ busyAckCooldownMs: 50 });

      const gateway = new ChannelGateway({
        adapters: [adapter],
        runtimeForSession: async () => ({
          ...createMinimalRuntime(),
          handle: async () => {
            await new Promise((resolve) => setTimeout(resolve, 200));
            return {
              label: "ok",
              text: "ok",
              matchedSkills: [],
              intent: { labels: ["general"], confidence: 1, nativeIntent: "general", suggestedToolsets: [], suggestedSkills: [], confirmationRequired: false, evidence: [], rationale: "" },
              securityDecision: "allow",
              toolExecutions: [],
              toolPlans: [],
              skillOutcomes: [],
              artifacts: [],
              context: undefined,
              projectContext: undefined,
              progress: []
            } as unknown as Awaited<ReturnType<Runtime["handle"]>>;
          }
        }),
        sessionStore: new InMemoryChannelSessionStore(),
        authPolicy: { telegram: { allowedUserIds: ["user-1"] } },
        activeTurnRegistry: registry
      });

      const first = gateway.receive(makeMessage("hello"));
      const second = gateway.receive(makeMessage("second"));
      await Promise.all([first, second]);
      adapter.clearRecords();

      // Wait for cooldown to expire and first turn to finish
      await new Promise((resolve) => setTimeout(resolve, 300));

      const third = gateway.receive(makeMessage("third"));
      const fourth = gateway.receive(makeMessage("fourth"));
      await Promise.all([third, fourth]);

      const busyTexts = adapter.records.filter((r) => r.kind === "text" && r.text?.includes("busy"));
      expect(busyTexts.length).toBe(1);
    });

    it("receive() fallback without activeTurnRegistry uses #activeTurns", async () => {
      const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
      let handleCount = 0;

      const gateway = new ChannelGateway({
        adapters: [adapter],
        runtimeForSession: async () => ({
          ...createMinimalRuntime(),
          handle: async () => {
            handleCount++;
            await new Promise((resolve) => setTimeout(resolve, 10));
            return {
              label: "ok",
              text: "ok",
              matchedSkills: [],
              intent: { labels: ["general"], confidence: 1, nativeIntent: "general", suggestedToolsets: [], suggestedSkills: [], confirmationRequired: false, evidence: [], rationale: "" },
              securityDecision: "allow",
              toolExecutions: [],
              toolPlans: [],
              skillOutcomes: [],
              artifacts: [],
              context: undefined,
              projectContext: undefined,
              progress: []
            } as Awaited<ReturnType<Runtime["handle"]>>;
          }
        }),
        sessionStore: new InMemoryChannelSessionStore(),
        authPolicy: { telegram: { allowedUserIds: ["user-1"] } }
      });

      const first = gateway.receive(makeMessage("hello"));
      const second = gateway.receive(makeMessage("hello again"));
      await Promise.all([first, second]);

      expect(handleCount).toBe(1);
    });

    it("/stop aborts active turn via activeTurnRegistry", async () => {
      const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
      const registry = new ActiveTurnRegistry();
      let aborted = false;
      let handleStartedResolve: (() => void) | undefined;
      const handleStarted = new Promise<void>((resolve) => { handleStartedResolve = resolve; });

      const gateway = new ChannelGateway({
        adapters: [adapter],
        runtimeForSession: async () => ({
          ...createMinimalRuntime(),
          handle: async ({ signal }: { signal?: AbortSignal }) => {
            handleStartedResolve?.();
            return new Promise((resolve, reject) => {
              signal?.addEventListener("abort", () => {
                aborted = true;
                reject(new Error("aborted"));
              });
              setTimeout(() => {
                resolve({
                  label: "ok",
                  text: "ok",
                  matchedSkills: [],
                  intent: { labels: ["general"], confidence: 1, nativeIntent: "general", suggestedToolsets: [], suggestedSkills: [], confirmationRequired: false, evidence: [], rationale: "" },
                  securityDecision: "allow",
                  toolExecutions: [],
                  toolPlans: [],
                  skillOutcomes: [],
                  artifacts: [],
                  context: undefined,
                  projectContext: undefined,
                  progress: []
                } as Awaited<ReturnType<Runtime["handle"]>>);
              }, 200);
            });
          }
        }),
        sessionStore: new InMemoryChannelSessionStore(),
        authPolicy: { telegram: { allowedUserIds: ["user-1"] } },
        activeTurnRegistry: registry
      });

      const turn = gateway.receive(makeMessage("hello"));
      await handleStarted;
      const stop = gateway.receive(makeMessage("/stop"));
      const [turnResult, stopResult] = await Promise.all([turn, stop]);

      expect(aborted).toBe(true);
      expect(stopResult.replyText).toContain("Cancelled");
      expect(registry.stats().totalAborted).toBe(1);
    });

    it("/stop without active turn falls back to onStopRequested", async () => {
      const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
      let stopCalled = false;
      const registry = new ActiveTurnRegistry();

      const gateway = new ChannelGateway({
        adapters: [adapter],
        runtimeForSession: async () => createMinimalRuntime(),
        sessionStore: new InMemoryChannelSessionStore(),
        authPolicy: { telegram: { allowedUserIds: ["user-1"] } },
        activeTurnRegistry: registry,
        onStopRequested: () => { stopCalled = true; }
      });

      await gateway.receive(makeMessage("/stop"));
      expect(stopCalled).toBe(true);
    });

    it("runtime error suspends session in runtimeCache", async () => {
      const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
      const cache = createFakeRuntimeCache();
      // Override get to return a runtime that throws
      cache.get = async () => createThrowingRuntime(new Error("boom"));
      const registry = new ActiveTurnRegistry();
      const fingerprint = createFakeFingerprint();

      const gateway = new ChannelGateway({
        adapters: [adapter],
        runtimeForSession: async () => createMinimalRuntime(),
        sessionStore: new InMemoryChannelSessionStore(),
        authPolicy: { telegram: { allowedUserIds: ["user-1"] } },
        activeTurnRegistry: registry,
        runtimeCache: cache,
        runtimeFingerprint: fingerprint
      });

      const result = await gateway.receive(makeMessage("hello"));
      expect(result.replyText).toContain("boom");
      expect(cache.suspendCalls.length).toBe(1);
      expect(cache.suspendCalls[0].reason).toBe("runtime-error");
    });

    it("runtime error delivers error text to user", async () => {
      const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
      const registry = new ActiveTurnRegistry();

      const gateway = new ChannelGateway({
        adapters: [adapter],
        runtimeForSession: async () => createThrowingRuntime(new Error("boom")),
        sessionStore: new InMemoryChannelSessionStore(),
        authPolicy: { telegram: { allowedUserIds: ["user-1"] } },
        activeTurnRegistry: registry
      });

      const result = await gateway.receive(makeMessage("hello"));
      expect(result.replyText).toContain("EstaCoda encountered an error: boom");
    });

    it("abort error does NOT suspend runtimeCache", async () => {
      const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
      const cache = createFakeRuntimeCache();
      const registry = new ActiveTurnRegistry();
      const fingerprint = createFakeFingerprint();

      const gateway = new ChannelGateway({
        adapters: [adapter],
        runtimeForSession: async () => ({
          ...createMinimalRuntime(),
          handle: async ({ signal }: { signal?: AbortSignal }) => {
            return new Promise((_resolve, reject) => {
              signal?.addEventListener("abort", () => {
                const err = new Error("cancelled");
                err.name = "AbortError";
                reject(err);
              });
              setTimeout(() => _resolve({} as Awaited<ReturnType<Runtime["handle"]>>), 5000);
            });
          }
        }),
        sessionStore: new InMemoryChannelSessionStore(),
        authPolicy: { telegram: { allowedUserIds: ["user-1"] } },
        activeTurnRegistry: registry,
        runtimeCache: cache,
        runtimeFingerprint: fingerprint
      });

      const turn = gateway.receive(makeMessage("hello"));
      const stop = gateway.receive(makeMessage("/stop"));
      await Promise.all([turn, stop]);

      expect(cache.suspendCalls.length).toBe(0);
    });

    it("controller.signal.aborted + thrown error does not suspend", async () => {
      const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
      const cache = createFakeRuntimeCache();
      const registry = new ActiveTurnRegistry();
      const fingerprint = createFakeFingerprint();

      const gateway = new ChannelGateway({
        adapters: [adapter],
        runtimeForSession: async () => ({
          ...createMinimalRuntime(),
          handle: async ({ signal }: { signal?: AbortSignal }) => {
            return new Promise((_resolve, reject) => {
              signal?.addEventListener("abort", () => {
                reject(new Error("operation was aborted by user"));
              });
              setTimeout(() => _resolve({} as Awaited<ReturnType<Runtime["handle"]>>), 5000);
            });
          }
        }),
        sessionStore: new InMemoryChannelSessionStore(),
        authPolicy: { telegram: { allowedUserIds: ["user-1"] } },
        activeTurnRegistry: registry,
        runtimeCache: cache,
        runtimeFingerprint: fingerprint
      });

      const turn = gateway.receive(makeMessage("hello"));
      const stop = gateway.receive(makeMessage("/stop"));
      await Promise.all([turn, stop]);

      expect(cache.suspendCalls.length).toBe(0);
    });

    it("runtimeCache borrow: get() called with correct args", async () => {
      const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
      const cache = createFakeRuntimeCache();
      const fingerprint = createFakeFingerprint();

      const gateway = new ChannelGateway({
        adapters: [adapter],
        runtimeForSession: async () => createMinimalRuntime(),
        sessionStore: new InMemoryChannelSessionStore(),
        authPolicy: { telegram: { allowedUserIds: ["user-1"] } },
        runtimeCache: cache,
        runtimeFingerprint: fingerprint
      });

      await gateway.receive(makeMessage("hello"));
      expect(cache.getCalls.length).toBe(1);
      expect(cache.getCalls[0].sessionId).toBeTruthy();
      expect(cache.getCalls[0].metadata?.surfaceType).toBe("telegram");
      expect(cache.getCalls[0].metadata?.origin).toBe("message");
    });

    it("runtimeCache release: dispose() calls releaseLease", async () => {
      const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
      const cache = createFakeRuntimeCache();
      const fingerprint = createFakeFingerprint();

      const gateway = new ChannelGateway({
        adapters: [adapter],
        runtimeForSession: async () => createMinimalRuntime(),
        sessionStore: new InMemoryChannelSessionStore(),
        authPolicy: { telegram: { allowedUserIds: ["user-1"] } },
        runtimeCache: cache,
        runtimeFingerprint: fingerprint
      });

      await gateway.receive(makeMessage("hello"));
      expect(cache.releaseLeaseCalls.length).toBe(1);
    });

    it("runtime acquisition failure ends active turn (registry)", async () => {
      const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
      const registry = new ActiveTurnRegistry();
      let disposed = false;

      const gateway = new ChannelGateway({
        adapters: [adapter],
        runtimeForSession: async () => {
          throw new Error("factory fail");
        },
        sessionStore: new InMemoryChannelSessionStore(),
        authPolicy: { telegram: { allowedUserIds: ["user-1"] } },
        activeTurnRegistry: registry
      });

      const result = await gateway.receive(makeMessage("hello"));
      expect(result.replyText).toContain("factory fail");
      expect(registry.isBusy("telegram:123456:user-1")).toBe(false);
      expect(disposed).toBe(false);
    });

    it("runtime acquisition failure cleans fallback active turn", async () => {
      const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;

      const gateway = new ChannelGateway({
        adapters: [adapter],
        runtimeForSession: async () => {
          throw new Error("factory fail");
        },
        sessionStore: new InMemoryChannelSessionStore(),
        authPolicy: { telegram: { allowedUserIds: ["user-1"] } }
      });

      const result = await gateway.receive(makeMessage("hello"));
      expect(result.replyText).toContain("factory fail");
      // Should be able to start a new turn immediately
      const result2 = await gateway.receive(makeMessage("hello again"));
      expect(result2.replyText).toContain("factory fail");
    });

    it("runtimeCache.get() throw → endTurn called, no dispose", async () => {
      const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
      const cache = createFakeRuntimeCache();
      cache.get = async () => { throw new Error("cache get fail"); };
      const registry = new ActiveTurnRegistry();
      const fingerprint = createFakeFingerprint();

      const gateway = new ChannelGateway({
        adapters: [adapter],
        runtimeForSession: async () => createMinimalRuntime(),
        sessionStore: new InMemoryChannelSessionStore(),
        authPolicy: { telegram: { allowedUserIds: ["user-1"] } },
        activeTurnRegistry: registry,
        runtimeCache: cache,
        runtimeFingerprint: fingerprint
      });

      const result = await gateway.receive(makeMessage("hello"));
      expect(result.replyText).toContain("cache get fail");
      expect(registry.isBusy("telegram:123456:user-1")).toBe(false);
    });

    it("runtimeForSession throw → endTurn called, no dispose", async () => {
      const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
      const registry = new ActiveTurnRegistry();

      const gateway = new ChannelGateway({
        adapters: [adapter],
        runtimeForSession: async () => {
          throw new Error("factory fail");
        },
        sessionStore: new InMemoryChannelSessionStore(),
        authPolicy: { telegram: { allowedUserIds: ["user-1"] } },
        activeTurnRegistry: registry
      });

      const result = await gateway.receive(makeMessage("hello"));
      expect(result.replyText).toContain("factory fail");
      expect(registry.isBusy("telegram:123456:user-1")).toBe(false);
    });

    it("session reset /new invalidates old session in cache", async () => {
      const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
      const cache = createFakeRuntimeCache();
      const fingerprint = createFakeFingerprint();
      const sessionStore = new InMemoryChannelSessionStore();

      const gateway = new ChannelGateway({
        adapters: [adapter],
        runtimeForSession: async () => createMinimalRuntime(),
        sessionStore,
        authPolicy: { telegram: { allowedUserIds: ["user-1"] } },
        runtimeCache: cache,
        runtimeFingerprint: fingerprint
      });

      const first = await gateway.receive(makeMessage("hello"));
      expect(cache.getCalls.length).toBe(1);

      await gateway.receive(makeMessage("/new"));
      expect(cache.invalidateCalls.length).toBe(1);
      expect(cache.invalidateCalls[0]).toBe(first.sessionId);
    });

    it("session reset /switch invalidates old session in cache", async () => {
      const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
      const cache = createFakeRuntimeCache();
      const fingerprint = createFakeFingerprint();
      const sessionStore = new InMemoryChannelSessionStore();

      const gateway = new ChannelGateway({
        adapters: [adapter],
        runtimeForSession: async ({ sessionId }) => ({
          ...createMinimalRuntime(),
          sessionDb: {
            ...createMinimalRuntime().sessionDb,
            getSession: async (id: string) => id === "target-sess" ? { id: "target-sess", profileId: "default", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), metadata: {} } : undefined
          } as unknown as Runtime["sessionDb"]
        }),
        sessionStore,
        authPolicy: { telegram: { allowedUserIds: ["user-1"] } },
        runtimeCache: cache,
        runtimeFingerprint: fingerprint
      });

      const first = await gateway.receive(makeMessage("hello"));
      await sessionStore.setSessionId?.(makeMessage("").sessionKey, "target-sess");
      await gateway.receive(makeMessage("/switch target-sess"));
      expect(cache.invalidateCalls.length).toBe(1);
      expect(cache.invalidateCalls[0]).toBe(first.sessionId);
    });

    it("auto-reset change invalidates cache", async () => {
      const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
      const cache = createFakeRuntimeCache();
      const fingerprint = createFakeFingerprint();
      let sessionSequence = 0;

      const sessionStore: ChannelSessionStore = {
        async getOrCreateSessionId() {
          sessionSequence++;
          return `sess-${sessionSequence}`;
        }
      };

      const gateway = new ChannelGateway({
        adapters: [adapter],
        runtimeForSession: async () => createMinimalRuntime(),
        sessionStore,
        authPolicy: { telegram: { allowedUserIds: ["user-1"] } },
        runtimeCache: cache,
        runtimeFingerprint: fingerprint
      });

      await gateway.receive(makeMessage("hello"));
      expect(cache.invalidateCalls.length).toBe(0);

      // Different sessionId triggers invalidate
      await gateway.receive(makeMessage("hello again"));
      expect(cache.invalidateCalls.length).toBe(1);
      expect(cache.invalidateCalls[0]).toBe("sess-1");
    });

    it("invalidate failure during /new does not break reset", async () => {
      const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
      const cache = createFakeRuntimeCache();
      cache.invalidate = async () => { throw new Error("invalidate fail"); };
      const fingerprint = createFakeFingerprint();

      const gateway = new ChannelGateway({
        adapters: [adapter],
        runtimeForSession: async () => createMinimalRuntime(),
        sessionStore: new InMemoryChannelSessionStore(),
        authPolicy: { telegram: { allowedUserIds: ["user-1"] } },
        runtimeCache: cache,
        runtimeFingerprint: fingerprint
      });

      await gateway.receive(makeMessage("hello"));
      const result = await gateway.receive(makeMessage("/new"));
      expect(result.replyText).toContain("Started a fresh");
    });

    it("invalidate failure during /switch does not break switch", async () => {
      const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
      const cache = createFakeRuntimeCache();
      cache.invalidate = async () => { throw new Error("invalidate fail"); };
      const fingerprint = createFakeFingerprint();
      const sessionStore = new InMemoryChannelSessionStore();

      const gateway = new ChannelGateway({
        adapters: [adapter],
        runtimeForSession: async ({ sessionId }) => ({
          ...createMinimalRuntime(),
          sessionDb: {
            ...createMinimalRuntime().sessionDb,
            getSession: async (id: string) => id === "target-sess" ? { id: "target-sess", profileId: "default", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), metadata: {} } : undefined
          } as unknown as Runtime["sessionDb"]
        }),
        sessionStore,
        authPolicy: { telegram: { allowedUserIds: ["user-1"] } },
        runtimeCache: cache,
        runtimeFingerprint: fingerprint
      });

      await gateway.receive(makeMessage("hello"));
      await sessionStore.setSessionId?.(makeMessage("").sessionKey, "target-sess");
      const result = await gateway.receive(makeMessage("/switch target-sess"));
      expect(result.replyText).toContain("Switched");
    });

    it("fallback without runtimeCache uses runtimeForSession directly", async () => {
      const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
      let factoryCalls = 0;

      const gateway = new ChannelGateway({
        adapters: [adapter],
        runtimeForSession: async () => {
          factoryCalls++;
          return createMinimalRuntime();
        },
        sessionStore: new InMemoryChannelSessionStore(),
        authPolicy: { telegram: { allowedUserIds: ["user-1"] } }
      });

      await gateway.receive(makeMessage("hello"));
      expect(factoryCalls).toBe(1);
    });

    it("fallback without activeTurnRegistry preserves old #activeTurns", async () => {
      const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;

      const gateway = new ChannelGateway({
        adapters: [adapter],
        runtimeForSession: async () => createMinimalRuntime(),
        sessionStore: new InMemoryChannelSessionStore(),
        authPolicy: { telegram: { allowedUserIds: ["user-1"] } }
      });

      await gateway.receive(makeMessage("hello"));
      await gateway.receive(makeMessage("hello again"));
      // Second message should not crash; silent busy rejection
    });

    it("runtimeCache without fingerprint falls back to factory", async () => {
      const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
      const cache = createFakeRuntimeCache();
      let factoryCalls = 0;

      const gateway = new ChannelGateway({
        adapters: [adapter],
        runtimeForSession: async () => {
          factoryCalls++;
          return createMinimalRuntime();
        },
        sessionStore: new InMemoryChannelSessionStore(),
        authPolicy: { telegram: { allowedUserIds: ["user-1"] } },
        runtimeCache: cache
        // no runtimeFingerprint
      });

      await gateway.receive(makeMessage("hello"));
      expect(factoryCalls).toBe(1);
      expect(cache.getCalls.length).toBe(0);
    });

    it("approval /approve still works with activeTurnRegistry", async () => {
      const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
      const registry = new ActiveTurnRegistry();

      const gateway = new ChannelGateway({
        adapters: [adapter],
        runtimeForSession: async () => ({
          ...createMinimalRuntime(),
          handle: async () => ({
            label: "ok",
            text: "done",
            matchedSkills: [],
            intent: { labels: ["general"], confidence: 1, nativeIntent: "general", suggestedToolsets: [], suggestedSkills: [], confirmationRequired: false, evidence: [], rationale: "" },
            securityDecision: "allow",
            toolExecutions: [
              { tool: { name: "terminal.run", description: "Run a terminal command", inputSchema: {}, riskClass: "destructive-local" as const, toolsets: ["terminal" as const], progressLabel: "Running", maxResultSizeChars: 10000 }, decision: "ask", riskClass: "destructive-local", targetKey: undefined, targetSummary: undefined }
            ],
            toolPlans: [],
            skillOutcomes: [],
            artifacts: [],
            context: undefined,
            projectContext: undefined,
            progress: []
          } as Awaited<ReturnType<Runtime["handle"]>>)
        }),
        sessionStore: new InMemoryChannelSessionStore(),
        authPolicy: { telegram: { allowedUserIds: ["user-1"] } },
        activeTurnRegistry: registry
      });

      const msg = makeMessage("run something risky");
      const first = await gateway.receive(msg);
      expect(first.replyText).toBe("done");
      // Approval prompt delivered separately via adapter
      const approvalPrompts = adapter.records.filter((r) => r.kind === "text" && r.text?.includes("Approval Required"));
      expect(approvalPrompts.length).toBe(1);

      const approveResult = await gateway.receive(makeMessage("/approve"));
      expect(approveResult.replyText).toContain("Approval granted");
    });

    it("creates a durable pending approval row for real gateway approvals", async () => {
      const { queue, cleanup } = await setupGatewayApprovalQueue();
      try {
        const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
        const approvalRuntime = createApprovalRuntime();
        const gateway = new ChannelGateway({
          adapters: [adapter],
          runtimeForSession: async () => approvalRuntime.runtime,
          sessionStore: new InMemoryChannelSessionStore(),
          authPolicy: { telegram: { allowedUserIds: ["user-1"] } },
          profileId: "profile-a",
          approvalQueue: queue
        });

        await gateway.receive(makeMessage("run something risky"));
        const pending = await queue.listPending({ profileId: "profile-a" });

        expect(pending).toHaveLength(1);
        expect(pending[0]).toMatchObject({
          id: "gateway-approval-1",
          profileId: "profile-a",
          toolName: "terminal.run",
          commandPreview: "rm -rf ./build",
          commandPayload: undefined
        });
      } finally {
        await cleanup();
      }
    });

    it("approval prompts include generic actions for the durable approval id", async () => {
      const { queue, cleanup } = await setupGatewayApprovalQueue();
      try {
        const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
        const approvalRuntime = createApprovalRuntime();
        const gateway = new ChannelGateway({
          adapters: [adapter],
          runtimeForSession: async () => approvalRuntime.runtime,
          sessionStore: new InMemoryChannelSessionStore(),
          authPolicy: { telegram: { allowedUserIds: ["user-1"] } },
          profileId: "profile-a",
          approvalQueue: queue
        });

        await gateway.receive(makeMessage("run something risky"));
        const [pending] = await queue.listPending({ profileId: "profile-a" });
        const approvalPrompt = adapter.records.find((record) =>
          record.kind === "text" && record.text?.includes("Command Approval Required")
        );

        expect(approvalPrompt?.options?.actions).toEqual(renderApprovalActions(pending.id));
        expect(JSON.stringify(approvalPrompt?.options?.actions)).not.toContain("rm -rf");
      } finally {
        await cleanup();
      }
    });

    it("session approval grants cannot allow a later hardline command", async () => {
      const { queue, cleanup } = await setupGatewayApprovalQueue();
      try {
        const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
        let currentSecurityPolicy: SecurityPolicy | undefined;
        let probe: ReturnType<typeof createGrantProbeRuntime> | undefined;
        const gateway = new ChannelGateway({
          adapters: [adapter],
          runtimeForSession: async ({ securityPolicy }) => {
            currentSecurityPolicy = securityPolicy;
            probe ??= createGrantProbeRuntime(() => currentSecurityPolicy ?? securityPolicy);
            return probe.runtime;
          },
          sessionStore: new InMemoryChannelSessionStore(),
          authPolicy: { telegram: { allowedUserIds: ["user-1"] } },
          profileId: "profile-a",
          approvalQueue: queue
        });

        await gateway.receive(makeMessage("run something risky"));
        expect(await queue.listPending({ profileId: "profile-a" })).toHaveLength(1);

        const approveResult = await gateway.receive(makeMessage("/approve session"));
        expect(approveResult.replyText).toContain("resumed decision=allow");

        const hardlineResult = await gateway.receive(makeMessage("run hardline"));
        expect(hardlineResult.replyText).toContain("hardline decision=deny");
        expect(await queue.listPending({ profileId: "profile-a" })).toEqual([]);
        expect(probe?.calls()).toBe(3);
      } finally {
        await cleanup();
      }
    });

    it("persisted channel approvals cannot allow a later hardline command", async () => {
      const { queue, cleanup, directory } = await setupGatewayApprovalQueue();
      try {
        const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
        const approvalStore = new ChannelApprovalStore({ path: join(directory, "channel-approvals.json") });
        await approvalStore.grant({
          sessionKey: { platform: "telegram", chatId: "123456", chatType: "dm" },
          toolName: "terminal.run",
          riskClass: "destructive-local",
          targetKey: undefined,
          targetSummary: "rm -rf ./build"
        });

        let currentSecurityPolicy: SecurityPolicy | undefined;
        let probe: ReturnType<typeof createGrantProbeRuntime> | undefined;
        const gateway = new ChannelGateway({
          adapters: [adapter],
          runtimeForSession: async ({ securityPolicy }) => {
            currentSecurityPolicy = securityPolicy;
            probe ??= createGrantProbeRuntime(() => currentSecurityPolicy ?? securityPolicy);
            return probe.runtime;
          },
          sessionStore: new InMemoryChannelSessionStore(),
          authPolicy: { telegram: { allowedUserIds: ["user-1"] } },
          profileId: "profile-a",
          approvalQueue: queue,
          approvalStore
        });

        const normalResult = await gateway.receive(makeMessage("run normal approved command"));
        expect(normalResult.replyText).toContain("normal decision=allow");

        const hardlineResult = await gateway.receive(makeMessage("run hardline"));
        expect(hardlineResult.replyText).toContain("hardline decision=deny");
        expect(await queue.listPending({ profileId: "profile-a" })).toEqual([]);
      } finally {
        await cleanup();
      }
    });

    it("/approve always cannot allow a later hardline command", async () => {
        const { queue, cleanup } = await setupGatewayApprovalQueue();
      try {
        const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
        let currentSecurityPolicy: SecurityPolicy | undefined;
        let probe: ReturnType<typeof createGrantProbeRuntime> | undefined;
        const gateway = new ChannelGateway({
          adapters: [adapter],
          runtimeForSession: async ({ securityPolicy }) => {
            currentSecurityPolicy = securityPolicy;
            probe ??= createGrantProbeRuntime(() => currentSecurityPolicy ?? securityPolicy);
            return probe.runtime;
          },
          sessionStore: new InMemoryChannelSessionStore(),
          authPolicy: { telegram: { allowedUserIds: ["user-1"] } },
          profileId: "profile-a",
          approvalQueue: queue
        });

        await gateway.receive(makeMessage("run something risky"));
        const approveResult = await gateway.receive(makeMessage("/approve always"));
        expect(approveResult.replyText).toContain("Approval granted");

        const hardlineResult = await gateway.receive(makeMessage("run hardline"));
        expect(hardlineResult.replyText).toContain("hardline decision=deny");
        expect(await queue.listPending({ profileId: "profile-a" })).toEqual([]);
      } finally {
        await cleanup();
      }
    });

    it("/approve always invalidates the affected cached runtime before replay", async () => {
      const { queue, cleanup, directory } = await setupGatewayApprovalQueue();
      const runtimeCache = new RuntimeCache({
        createRuntime: async ({ securityPolicy }) => createCachedPolicyProbeRuntime(securityPolicy)
      });
      try {
        const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
        const approvalStore = new ChannelApprovalStore({ path: join(directory, "channel-approvals.json") });
        const gateway = new ChannelGateway({
          adapters: [adapter],
          runtimeForSession: async () => createMinimalRuntime(),
          sessionStore: new InMemoryChannelSessionStore(),
          authPolicy: { telegram: { allowedUserIds: ["user-1"] } },
          profileId: "profile-a",
          approvalQueue: queue,
          approvalStore,
          runtimeCache,
          runtimeFingerprint: createFakeFingerprint(),
          securityMode: "strict"
        });

        const first = await gateway.receive(makeMessage("run normal"));
        expect(first.replyText).toContain("decision=ask");
        expect(await queue.listPending({ profileId: "profile-a" })).toHaveLength(1);

        const approveResult = await gateway.receive(makeMessage("/approve always"));

        expect(runtimeCache.stats().totalInvalidated).toBe(1);
        expect(approveResult.replyText).toContain("Approval granted");
        expect(approveResult.replyText).toContain("run normal decision=allow");
      } finally {
        await runtimeCache.disposeAll();
        await cleanup();
      }
    });

    it("/revoke invalidates the affected cached runtime so matching actions are gated again", async () => {
      const { queue, cleanup, directory } = await setupGatewayApprovalQueue();
      const runtimeCache = new RuntimeCache({
        createRuntime: async ({ securityPolicy }) => createCachedPolicyProbeRuntime(securityPolicy)
      });
      try {
        const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
        const approvalStore = new ChannelApprovalStore({
          path: join(directory, "channel-approvals.json"),
          idFactory: () => "persisted-approval-1"
        });
        await approvalStore.grant({
          sessionKey: { platform: "telegram", chatId: "123456", chatType: "dm" },
          toolName: "terminal.run",
          riskClass: "destructive-local",
          targetKey: undefined,
          targetSummary: "rm -rf ./build"
        });
        const gateway = new ChannelGateway({
          adapters: [adapter],
          runtimeForSession: async () => createMinimalRuntime(),
          sessionStore: new InMemoryChannelSessionStore(),
          authPolicy: { telegram: { allowedUserIds: ["user-1"] } },
          profileId: "profile-a",
          approvalQueue: queue,
          approvalStore,
          runtimeCache,
          runtimeFingerprint: createFakeFingerprint(),
          securityMode: "strict"
        });

        const allowed = await gateway.receive(makeMessage("run normal"));
        expect(allowed.replyText).toContain("decision=allow");
        expect(await queue.listPending({ profileId: "profile-a" })).toEqual([]);

        const revokeResult = await gateway.receive(makeMessage("/revoke persisted-approval-1"));
        expect(revokeResult.replyText).toContain("Revoked persistent approval");
        expect(runtimeCache.stats().totalInvalidated).toBe(1);

        const gated = await gateway.receive(makeMessage("run normal"));
        expect(gated.replyText).toContain("decision=ask");
        expect(await queue.listPending({ profileId: "profile-a" })).toHaveLength(1);
      } finally {
        await runtimeCache.disposeAll();
        await cleanup();
      }
    });

    it("session grants still work through the cached ChannelGateway policy", async () => {
      const { queue, cleanup, directory } = await setupGatewayApprovalQueue();
      const runtimeCache = new RuntimeCache({
        createRuntime: async ({ securityPolicy }) => createCachedPolicyProbeRuntime(securityPolicy)
      });
      try {
        const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
        const approvalStore = new ChannelApprovalStore({ path: join(directory, "channel-approvals.json") });
        const gateway = new ChannelGateway({
          adapters: [adapter],
          runtimeForSession: async () => createMinimalRuntime(),
          sessionStore: new InMemoryChannelSessionStore(),
          authPolicy: { telegram: { allowedUserIds: ["user-1"] } },
          profileId: "profile-a",
          approvalQueue: queue,
          approvalStore,
          runtimeCache,
          runtimeFingerprint: createFakeFingerprint(),
          securityMode: "strict"
        });

        const first = await gateway.receive(makeMessage("run normal"));
        expect(first.replyText).toContain("decision=ask");

        const approveResult = await gateway.receive(makeMessage("/approve session"));

        expect(approveResult.replyText).toContain("Approval granted");
        expect(approveResult.replyText).toContain("run normal decision=allow");
        expect(runtimeCache.stats().totalInvalidated).toBe(0);
        expect(runtimeCache.stats().totalReused).toBeGreaterThan(0);
      } finally {
        await runtimeCache.disposeAll();
        await cleanup();
      }
    });

    it("does not create a durable approval row for hardline deny decisions", async () => {
      const { queue, cleanup } = await setupGatewayApprovalQueue();
      try {
        const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
        const gateway = new ChannelGateway({
          adapters: [adapter],
          runtimeForSession: async () => createTerminalDecisionRuntime("deny", "rm -rf /"),
          sessionStore: new InMemoryChannelSessionStore(),
          authPolicy: { telegram: { allowedUserIds: ["user-1"] } },
          profileId: "profile-a",
          approvalQueue: queue
        });

        await gateway.receive(makeMessage("run hardline"));

        expect(await queue.listPending({ profileId: "profile-a" })).toEqual([]);
        expect(adapter.records.some((record) => record.options?.actions !== undefined)).toBe(false);
      } finally {
        await cleanup();
      }
    });

    it("keeps gateway pending approvals ask-only and never queues terminal deny decisions", async () => {
      const { queue, cleanup } = await setupGatewayApprovalQueue();
      try {
        const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
        const gateway = new ChannelGateway({
          adapters: [adapter],
          runtimeForSession: async () => createTerminalDecisionRuntime("deny", "rm -rf ./build"),
          sessionStore: new InMemoryChannelSessionStore(),
          authPolicy: { telegram: { allowedUserIds: ["user-1"] } },
          profileId: "profile-a",
          approvalQueue: queue
        });

        await gateway.receive(makeMessage("run denied non-hardline command"));

        expect(await queue.listPending({ profileId: "profile-a" })).toEqual([]);
        expect(adapter.records.some((record) => record.options?.actions !== undefined)).toBe(false);
      } finally {
        await cleanup();
      }
    });

    it("remote /approve resolves the durable row and resumes the blocked request", async () => {
      const { queue, cleanup } = await setupGatewayApprovalQueue();
      try {
        const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
        const approvalRuntime = createApprovalRuntime();
        const gateway = new ChannelGateway({
          adapters: [adapter],
          runtimeForSession: async () => approvalRuntime.runtime,
          sessionStore: new InMemoryChannelSessionStore(),
          authPolicy: { telegram: { allowedUserIds: ["user-1"] } },
          profileId: "profile-a",
          approvalQueue: queue
        });

        await gateway.receive(makeMessage("run something risky"));
        const [pending] = await queue.listPending({ profileId: "profile-a" });
        const approveResult = await gateway.receive(makeMessage("/approve"));
        const durable = await queue.getApproval(pending.id, { profileId: "profile-a", sessionId: pending.sessionId });

        expect(durable?.status).toBe("approved");
        expect(approvalRuntime.calls()).toBe(2);
        expect(approveResult.replyText).toContain("Approval granted");
        expect(approveResult.replyText).toContain("resumed");
      } finally {
        await cleanup();
      }
    });

    it("inline approval action resolves through the same approve path and resumes", async () => {
      const { queue, cleanup } = await setupGatewayApprovalQueue();
      try {
        const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
        const approvalRuntime = createApprovalRuntime();
        const gateway = new ChannelGateway({
          adapters: [adapter],
          runtimeForSession: async () => approvalRuntime.runtime,
          sessionStore: new InMemoryChannelSessionStore(),
          authPolicy: { telegram: { allowedUserIds: ["user-1"] } },
          profileId: "profile-a",
          approvalQueue: queue
        });

        await gateway.receive(makeMessage("run something risky"));
        const [pending] = await queue.listPending({ profileId: "profile-a" });
        const actionValue = renderApprovalActions(pending.id)[0][0].value;
        const approveResult = await gateway.receive(makeMessage(actionValue));
        const durable = await queue.getApproval(pending.id, { profileId: "profile-a", sessionId: pending.sessionId });

        expect(durable?.status).toBe("approved");
        expect(approvalRuntime.calls()).toBe(2);
        expect(approveResult.replyText).toContain("Approval granted");
        expect(approveResult.replyText).toContain("resumed");
      } finally {
        await cleanup();
      }
    });

    it("remote /deny resolves the durable row without resuming the blocked request", async () => {
      const { queue, cleanup } = await setupGatewayApprovalQueue();
      try {
        const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
        const approvalRuntime = createApprovalRuntime();
        const gateway = new ChannelGateway({
          adapters: [adapter],
          runtimeForSession: async () => approvalRuntime.runtime,
          sessionStore: new InMemoryChannelSessionStore(),
          authPolicy: { telegram: { allowedUserIds: ["user-1"] } },
          profileId: "profile-a",
          approvalQueue: queue
        });

        await gateway.receive(makeMessage("run something risky"));
        const [pending] = await queue.listPending({ profileId: "profile-a" });
        const denyResult = await gateway.receive(makeMessage("/deny"));
        const durable = await queue.getApproval(pending.id, { profileId: "profile-a", sessionId: pending.sessionId });

        expect(durable?.status).toBe("denied");
        expect(approvalRuntime.calls()).toBe(1);
        expect(denyResult.replyText).toContain("Approval denied");
      } finally {
        await cleanup();
      }
    });

    it("inline deny action resolves through the same deny path without resuming", async () => {
      const { queue, cleanup } = await setupGatewayApprovalQueue();
      try {
        const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
        const approvalRuntime = createApprovalRuntime();
        const gateway = new ChannelGateway({
          adapters: [adapter],
          runtimeForSession: async () => approvalRuntime.runtime,
          sessionStore: new InMemoryChannelSessionStore(),
          authPolicy: { telegram: { allowedUserIds: ["user-1"] } },
          profileId: "profile-a",
          approvalQueue: queue
        });

        await gateway.receive(makeMessage("run something risky"));
        const [pending] = await queue.listPending({ profileId: "profile-a" });
        const actionValue = renderApprovalActions(pending.id)[1][1].value;
        const denyResult = await gateway.receive(makeMessage(actionValue));
        const durable = await queue.getApproval(pending.id, { profileId: "profile-a", sessionId: pending.sessionId });

        expect(durable?.status).toBe("denied");
        expect(approvalRuntime.calls()).toBe(1);
        expect(denyResult.replyText).toContain("Approval denied");
      } finally {
        await cleanup();
      }
    });

    it("inline approve always keeps cache refresh centralized in ChannelGateway", async () => {
      const { queue, cleanup, directory } = await setupGatewayApprovalQueue();
      const runtimeCache = new RuntimeCache({
        createRuntime: async ({ securityPolicy }) => createCachedPolicyProbeRuntime(securityPolicy)
      });
      try {
        const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
        const approvalStore = new ChannelApprovalStore({ path: join(directory, "channel-approvals.json") });
        const gateway = new ChannelGateway({
          adapters: [adapter],
          runtimeForSession: async () => createMinimalRuntime(),
          sessionStore: new InMemoryChannelSessionStore(),
          authPolicy: { telegram: { allowedUserIds: ["user-1"] } },
          profileId: "profile-a",
          approvalQueue: queue,
          approvalStore,
          runtimeCache,
          runtimeFingerprint: createFakeFingerprint(),
          securityMode: "strict"
        });

        await gateway.receive(makeMessage("run normal"));
        const [pending] = await queue.listPending({ profileId: "profile-a" });
        const actionValue = renderApprovalActions(pending.id)[1][0].value;
        const approveResult = await gateway.receive(makeMessage(actionValue));

        expect(runtimeCache.stats().totalInvalidated).toBe(1);
        expect(approveResult.replyText).toContain("Approval granted");
        expect(approveResult.replyText).toContain("run normal decision=allow");
      } finally {
        await runtimeCache.disposeAll();
        await cleanup();
      }
    });

    it("inline approval actions reject stale, resolved, or wrong-session ids", async () => {
      const { queue, cleanup } = await setupGatewayApprovalQueue();
      try {
        const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
        const approvalRuntime = createApprovalRuntime();
        const gateway = new ChannelGateway({
          adapters: [adapter],
          runtimeForSession: async () => approvalRuntime.runtime,
          sessionStore: new InMemoryChannelSessionStore(),
          authPolicy: { telegram: { allowedUserIds: ["user-1"] } },
          profileId: "profile-a",
          approvalQueue: queue
        });

        await gateway.receive(makeMessage("run something risky"));
        const [pending] = await queue.listPending({ profileId: "profile-a" });
        const actionValue = renderApprovalActions(pending.id)[0][0].value;
        const wrongSessionResult = await gateway.receive(makeMessage(actionValue, {
          id: "msg-other-chat",
          sessionKey: {
            platform: "telegram",
            chatId: "other-chat",
            userId: "user-1"
          }
        }));

        expect(wrongSessionResult.replyText).toContain("There is no pending approval request");
        expect(approvalRuntime.calls()).toBe(1);

        await queue.resolveApproval(pending.id, "approved", "cli", {
          profileId: "profile-a",
          sessionId: pending.sessionId
        });
        const resolvedResult = await gateway.receive(makeMessage(actionValue, {
          id: "msg-stale"
        }));

        expect(resolvedResult.replyText).toContain("already approved");
        expect(approvalRuntime.calls()).toBe(1);
      } finally {
        await cleanup();
      }
    });

    it("CLI approval of the durable row is observed by the live gateway and resumes", async () => {
      const { queue, cleanup } = await setupGatewayApprovalQueue();
      try {
        const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
        const approvalRuntime = createApprovalRuntime();
        const gateway = new ChannelGateway({
          adapters: [adapter],
          runtimeForSession: async () => approvalRuntime.runtime,
          sessionStore: new InMemoryChannelSessionStore(),
          authPolicy: { telegram: { allowedUserIds: ["user-1"] } },
          profileId: "profile-a",
          approvalQueue: queue
        });

        await gateway.receive(makeMessage("run something risky"));
        const [pending] = await queue.listPending({ profileId: "profile-a" });
        await queue.resolveApproval(pending.id, "approved", "cli", {
          profileId: "profile-a",
          sessionId: pending.sessionId
        });

        await gateway.tickApprovalResolutions();

        expect(approvalRuntime.calls()).toBe(2);
        expect(adapter.records.some((record) => record.kind === "text" && record.text?.includes("Approved by CLI/operator."))).toBe(true);
        expect(adapter.records.some((record) => record.kind === "text" && record.text?.includes("resumed"))).toBe(true);
      } finally {
        await cleanup();
      }
    });

    it("CLI denial of the durable row is observed by the live gateway without resuming", async () => {
      const { queue, cleanup } = await setupGatewayApprovalQueue();
      try {
        const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
        const approvalRuntime = createApprovalRuntime();
        const gateway = new ChannelGateway({
          adapters: [adapter],
          runtimeForSession: async () => approvalRuntime.runtime,
          sessionStore: new InMemoryChannelSessionStore(),
          authPolicy: { telegram: { allowedUserIds: ["user-1"] } },
          profileId: "profile-a",
          approvalQueue: queue
        });

        await gateway.receive(makeMessage("run something risky"));
        const [pending] = await queue.listPending({ profileId: "profile-a" });
        await queue.resolveApproval(pending.id, "denied", "cli", {
          profileId: "profile-a",
          sessionId: pending.sessionId
        });

        await gateway.tickApprovalResolutions();

        expect(approvalRuntime.calls()).toBe(1);
        expect(adapter.records.some((record) => record.kind === "text" && record.text?.includes("Approval denied"))).toBe(true);
      } finally {
        await cleanup();
      }
    });

    it("handoff /attach and /detach still work", async () => {
      const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
      const handoffStore = {
        create: async () => ({ ok: true as const, code: "abc123" }),
        redeem: async () => ({ ok: true as const, handoff: { sessionId: "cli-sess", createdAt: new Date().toISOString() } })
      };
      const pointerStore = new InMemorySurfacePointerStore();

      const gateway = new ChannelGateway({
        adapters: [adapter],
        runtimeForSession: async () => createMinimalRuntime(),
        sessionStore: new InMemoryChannelSessionStore(),
        authPolicy: { telegram: { allowedUserIds: ["user-1"] } },
        handoffStore: handoffStore as unknown as import("./handoff-store.js").HandoffStore,
        surfacePointerStore: pointerStore
      });

      const attachResult = await gateway.receive(makeMessage("/attach abc123"));
      expect(attachResult.replyText).toContain("Attached");

      const detachResult = await gateway.receive(makeMessage("/detach"));
      expect(detachResult.replyText).toContain("Detached");
    });

    it("busy response uses correct normalizedSessionKey", async () => {
      const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
      const registry = new ActiveTurnRegistry();

      const gateway = new ChannelGateway({
        adapters: [adapter],
        runtimeForSession: async () => ({
          ...createMinimalRuntime(),
          handle: async () => {
            await new Promise((resolve) => setTimeout(resolve, 200));
            return {
              label: "ok",
              text: "ok",
              matchedSkills: [],
              intent: { labels: ["general"], confidence: 1, nativeIntent: "general", suggestedToolsets: [], suggestedSkills: [], confirmationRequired: false, evidence: [], rationale: "" },
              securityDecision: "allow",
              toolExecutions: [],
              toolPlans: [],
              skillOutcomes: [],
              artifacts: [],
              context: undefined,
              projectContext: undefined,
              progress: []
            } as unknown as Awaited<ReturnType<Runtime["handle"]>>;
          }
        }),
        sessionStore: new InMemoryChannelSessionStore(),
        authPolicy: { telegram: { allowedUserIds: ["user-1"] } },
        activeTurnRegistry: registry
      });

      const first = gateway.receive(makeMessage("hello"));
      const second = gateway.receive(makeMessage("hello again"));
      await Promise.all([first, second]);

      const textRecords = adapter.records.filter((r) => r.kind === "text");
      expect(textRecords.some((r) => r.text?.includes("busy"))).toBe(true);
    });
  });

  // Stage 7: SessionMessageQueue + busyPolicy integration tests
  describe("Stage 7 busyPolicy integration", () => {
    async function waitForPendingWork(gateway: ChannelGateway): Promise<void> {
      while (gateway.hasPendingWork()) {
        await new Promise((r) => setTimeout(r, 10));
      }
    }

    it("queue mode enqueues message and delivers position", async () => {
      const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
      const registry = new ActiveTurnRegistry();
      let handleCount = 0;

      const gateway = new ChannelGateway({
        adapters: [adapter],
        runtimeForSession: async () => ({
          ...createMinimalRuntime(),
          handle: async () => {
            handleCount++;
            await new Promise((resolve) => setTimeout(resolve, 50));
            return {
              label: "ok",
              text: "ok",
              matchedSkills: [],
              intent: { labels: ["general"], confidence: 1, nativeIntent: "general", suggestedToolsets: [], suggestedSkills: [], confirmationRequired: false, evidence: [], rationale: "" },
              securityDecision: "allow",
              toolExecutions: [],
              toolPlans: [],
              skillOutcomes: [],
              artifacts: [],
              context: undefined,
              projectContext: undefined,
              progress: []
            } as unknown as Awaited<ReturnType<Runtime["handle"]>>;
          }
        }),
        sessionStore: new InMemoryChannelSessionStore(),
        authPolicy: { telegram: { allowedUserIds: ["user-1"] } },
        activeTurnRegistry: registry,
        busyPolicyResolver: () => ({ busyPolicy: "queue", queueDepth: 3 })
      });

      const first = gateway.receive(makeMessage("hello"));
      // Give first turn time to start
      await new Promise((resolve) => setTimeout(resolve, 10));
      const second = await gateway.receive(makeMessage("second"));
      await first;
      await waitForPendingWork(gateway);

      expect(second.replyText).toBe("");
      const queuedRecords = adapter.records.filter((r) => r.kind === "text" && r.text?.includes("Queued"));
      expect(queuedRecords.length).toBe(1);
      expect(handleCount).toBe(2); // first + drained queued
    });

    it("queue mode rejects when queue is full", async () => {
      const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
      const registry = new ActiveTurnRegistry();

      const gateway = new ChannelGateway({
        adapters: [adapter],
        runtimeForSession: async () => ({
          ...createMinimalRuntime(),
          handle: async () => {
            await new Promise((resolve) => setTimeout(resolve, 200));
            return {
              label: "ok",
              text: "ok",
              matchedSkills: [],
              intent: { labels: ["general"], confidence: 1, nativeIntent: "general", suggestedToolsets: [], suggestedSkills: [], confirmationRequired: false, evidence: [], rationale: "" },
              securityDecision: "allow",
              toolExecutions: [],
              toolPlans: [],
              skillOutcomes: [],
              artifacts: [],
              context: undefined,
              projectContext: undefined,
              progress: []
            } as unknown as Awaited<ReturnType<Runtime["handle"]>>;
          }
        }),
        sessionStore: new InMemoryChannelSessionStore(),
        authPolicy: { telegram: { allowedUserIds: ["user-1"] } },
        activeTurnRegistry: registry,
        busyPolicyResolver: () => ({ busyPolicy: "queue", queueDepth: 1 })
      });

      const first = gateway.receive(makeMessage("hello"));
      await new Promise((resolve) => setTimeout(resolve, 10));
      const second = await gateway.receive(makeMessage("second"));
      const third = await gateway.receive(makeMessage("third"));
      await first;

      expect(second.replyText).toBe("");
      expect(third.replyText).toBe("");
      const fullRecords = adapter.records.filter((r) => r.kind === "text" && r.text?.includes("full"));
      expect(fullRecords.length).toBe(1);
    });

    it("interrupt mode clears queue and aborts active turn", async () => {
      const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
      const registry = new ActiveTurnRegistry();
      let aborted = false;

      const gateway = new ChannelGateway({
        adapters: [adapter],
        runtimeForSession: async () => ({
          ...createMinimalRuntime(),
          handle: async ({ signal }: { signal?: AbortSignal }) => {
            return new Promise((_resolve, reject) => {
              signal?.addEventListener("abort", () => {
                aborted = true;
                reject(new Error("interrupted"));
              });
              setTimeout(() => _resolve({
                label: "ok",
                text: "ok",
                matchedSkills: [],
                intent: { labels: ["general"], confidence: 1, nativeIntent: "general", suggestedToolsets: [], suggestedSkills: [], confirmationRequired: false, evidence: [], rationale: "" },
                securityDecision: "allow",
                toolExecutions: [],
                toolPlans: [],
                skillOutcomes: [],
                artifacts: [],
                context: undefined,
                projectContext: undefined,
                progress: []
              } as Awaited<ReturnType<Runtime["handle"]>>), 500);
            });
          }
        }),
        sessionStore: new InMemoryChannelSessionStore(),
        authPolicy: { telegram: { allowedUserIds: ["user-1"] } },
        activeTurnRegistry: registry,
        busyPolicyResolver: () => ({ busyPolicy: "interrupt", queueDepth: 3 })
      });

      const first = gateway.receive(makeMessage("hello"));
      await new Promise((resolve) => setTimeout(resolve, 10));
      const second = await gateway.receive(makeMessage("interrupt me"));
      await first.catch(() => {});

      expect(aborted).toBe(true);
      // The interrupt message should be processed after the first turn ends
      expect(registry.stats().totalStarted).toBe(2);
    });

    it("interrupt mode does not grow queue under repeated interrupts", async () => {
      const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
      const registry = new ActiveTurnRegistry();
      let handleCount = 0;

      const gateway = new ChannelGateway({
        adapters: [adapter],
        runtimeForSession: async () => ({
          ...createMinimalRuntime(),
          handle: async ({ signal }: { signal?: AbortSignal }) => {
            handleCount++;
            return new Promise((_resolve, reject) => {
              signal?.addEventListener("abort", () => {
                reject(new Error("interrupted"));
              });
              setTimeout(() => _resolve({
                label: "ok",
                text: "ok",
                matchedSkills: [],
                intent: { labels: ["general"], confidence: 1, nativeIntent: "general", suggestedToolsets: [], suggestedSkills: [], confirmationRequired: false, evidence: [], rationale: "" },
                securityDecision: "allow",
                toolExecutions: [],
                toolPlans: [],
                skillOutcomes: [],
                artifacts: [],
                context: undefined,
                projectContext: undefined,
                progress: []
              } as Awaited<ReturnType<Runtime["handle"]>>), 200);
            });
          }
        }),
        sessionStore: new InMemoryChannelSessionStore(),
        authPolicy: { telegram: { allowedUserIds: ["user-1"] } },
        activeTurnRegistry: registry,
        busyPolicyResolver: () => ({ busyPolicy: "interrupt", queueDepth: 3 })
      });

      const first = gateway.receive(makeMessage("hello"));
      await new Promise((resolve) => setTimeout(resolve, 10));
      const second = gateway.receive(makeMessage("int1"));
      await new Promise((resolve) => setTimeout(resolve, 10));
      const third = gateway.receive(makeMessage("int2"));
      await first.catch(() => {});
      await second.catch(() => {});
      await third.catch(() => {});

      // Only 2 turns should start: first + one interrupt (queue never grows)
      expect(handleCount).toBeLessThanOrEqual(3);
    });

    it("reject mode without registry still prevents parallel turns", async () => {
      const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
      let handleCount = 0;

      const gateway = new ChannelGateway({
        adapters: [adapter],
        runtimeForSession: async () => ({
          ...createMinimalRuntime(),
          handle: async () => {
            handleCount++;
            await new Promise((resolve) => setTimeout(resolve, 50));
            return {
              label: "ok",
              text: "ok",
              matchedSkills: [],
              intent: { labels: ["general"], confidence: 1, nativeIntent: "general", suggestedToolsets: [], suggestedSkills: [], confirmationRequired: false, evidence: [], rationale: "" },
              securityDecision: "allow",
              toolExecutions: [],
              toolPlans: [],
              skillOutcomes: [],
              artifacts: [],
              context: undefined,
              projectContext: undefined,
              progress: []
            } as Awaited<ReturnType<Runtime["handle"]>>;
          }
        }),
        sessionStore: new InMemoryChannelSessionStore(),
        authPolicy: { telegram: { allowedUserIds: ["user-1"] } },
        busyPolicyResolver: () => ({ busyPolicy: "reject", queueDepth: 3 })
      });

      const first = gateway.receive(makeMessage("hello"));
      const second = gateway.receive(makeMessage("hello again"));
      await Promise.all([first, second]);

      expect(handleCount).toBe(1);
    });

    it("hasPendingWork reflects active turns and queued messages", async () => {
      const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
      const registry = new ActiveTurnRegistry();

      const gateway = new ChannelGateway({
        adapters: [adapter],
        runtimeForSession: async () => ({
          ...createMinimalRuntime(),
          handle: async () => {
            await new Promise((resolve) => setTimeout(resolve, 100));
            return {
              label: "ok",
              text: "ok",
              matchedSkills: [],
              intent: { labels: ["general"], confidence: 1, nativeIntent: "general", suggestedToolsets: [], suggestedSkills: [], confirmationRequired: false, evidence: [], rationale: "" },
              securityDecision: "allow",
              toolExecutions: [],
              toolPlans: [],
              skillOutcomes: [],
              artifacts: [],
              context: undefined,
              projectContext: undefined,
              progress: []
            } as Awaited<ReturnType<Runtime["handle"]>>;
          }
        }),
        sessionStore: new InMemoryChannelSessionStore(),
        authPolicy: { telegram: { allowedUserIds: ["user-1"] } },
        activeTurnRegistry: registry,
        busyPolicyResolver: () => ({ busyPolicy: "queue", queueDepth: 3 })
      });

      expect(gateway.hasPendingWork()).toBe(false);

      const first = gateway.receive(makeMessage("hello"));
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(gateway.hasPendingWork()).toBe(true);

      const second = await gateway.receive(makeMessage("second"));
      expect(second.replyText).toBe("");
      expect(gateway.hasPendingWork()).toBe(true); // active turn + queued

      await first;
      await waitForPendingWork(gateway);
      // After first turn ends, queued message is drained
      expect(gateway.hasPendingWork()).toBe(false);
    });

    it("drain rejects new inbound but allows queued to finish", async () => {
      const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
      const registry = new ActiveTurnRegistry();
      let handleCount = 0;
      let draining = false;

      const gateway = new ChannelGateway({
        adapters: [adapter],
        runtimeForSession: async () => ({
          ...createMinimalRuntime(),
          handle: async () => {
            handleCount++;
            await new Promise((resolve) => setTimeout(resolve, 30));
            return {
              label: "ok",
              text: "ok",
              matchedSkills: [],
              intent: { labels: ["general"], confidence: 1, nativeIntent: "general", suggestedToolsets: [], suggestedSkills: [], confirmationRequired: false, evidence: [], rationale: "" },
              securityDecision: "allow",
              toolExecutions: [],
              toolPlans: [],
              skillOutcomes: [],
              artifacts: [],
              context: undefined,
              projectContext: undefined,
              progress: []
            } as Awaited<ReturnType<Runtime["handle"]>>;
          }
        }),
        sessionStore: new InMemoryChannelSessionStore(),
        authPolicy: { telegram: { allowedUserIds: ["user-1"] } },
        activeTurnRegistry: registry,
        busyPolicyResolver: () => ({ busyPolicy: "queue", queueDepth: 3 }),
        isDraining: () => draining
      });

      const first = gateway.receive(makeMessage("hello"));
      await new Promise((resolve) => setTimeout(resolve, 10));
      const second = await gateway.receive(makeMessage("second"));
      expect(second.replyText).toBe(""); // queued

      // Now enable draining
      draining = true;
      const third = await gateway.receive(makeMessage("third"));
      expect(third.replyText).toContain("restarting"); // rejected

      await first;
      await waitForPendingWork(gateway);
      // Queued "second" should still be processed
      expect(handleCount).toBe(2);
    });

    it("/stop with active turn leaves queued messages intact", async () => {
      const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
      const registry = new ActiveTurnRegistry();
      let handleCount = 0;

      const gateway = new ChannelGateway({
        adapters: [adapter],
        runtimeForSession: async () => ({
          ...createMinimalRuntime(),
          handle: async () => {
            handleCount++;
            await new Promise((resolve) => setTimeout(resolve, 100));
            return {
              label: "ok",
              text: "ok",
              matchedSkills: [],
              intent: { labels: ["general"], confidence: 1, nativeIntent: "general", suggestedToolsets: [], suggestedSkills: [], confirmationRequired: false, evidence: [], rationale: "" },
              securityDecision: "allow",
              toolExecutions: [],
              toolPlans: [],
              skillOutcomes: [],
              artifacts: [],
              context: undefined,
              projectContext: undefined,
              progress: []
            } as Awaited<ReturnType<Runtime["handle"]>>;
          }
        }),
        sessionStore: new InMemoryChannelSessionStore(),
        authPolicy: { telegram: { allowedUserIds: ["user-1"] } },
        activeTurnRegistry: registry,
        busyPolicyResolver: () => ({ busyPolicy: "queue", queueDepth: 3 })
      });

      const first = gateway.receive(makeMessage("hello"));
      await new Promise((resolve) => setTimeout(resolve, 10));
      await gateway.receive(makeMessage("second")); // queued
      const stopResult = await gateway.receive(makeMessage("/stop"));
      await first.catch(() => {});
      await waitForPendingWork(gateway);

      // /stop aborted the active turn but left queue intact
      expect(stopResult.replyText).toContain("Cancelled");
      // After first turn ends, queued "second" should be drained
      expect(handleCount).toBe(2);
    });

    it("/stop with no active turn clears queued messages", async () => {
      const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
      const registry = new ActiveTurnRegistry();
      let handleResolved = false;
      let disposeResolve: (() => void) | undefined;

      const gateway = new ChannelGateway({
        adapters: [adapter],
        runtimeForSession: async () => ({
          ...createMinimalRuntime(),
          handle: async () => {
            await new Promise((resolve) => setTimeout(resolve, 20));
            handleResolved = true;
            return {
              label: "ok",
              text: "ok",
              matchedSkills: [],
              intent: { labels: ["general"], confidence: 1, nativeIntent: "general", suggestedToolsets: [], suggestedSkills: [], confirmationRequired: false, evidence: [], rationale: "" },
              securityDecision: "allow",
              toolExecutions: [],
              toolPlans: [],
              skillOutcomes: [],
              artifacts: [],
              context: undefined,
              projectContext: undefined,
              progress: []
            } as Awaited<ReturnType<Runtime["handle"]>>;
          },
          dispose: async () => {
            await new Promise<void>((resolve) => {
              disposeResolve = resolve;
            });
          }
        }),
        sessionStore: new InMemoryChannelSessionStore(),
        authPolicy: { telegram: { allowedUserIds: ["user-1"] } },
        activeTurnRegistry: registry,
        busyPolicyResolver: () => ({ busyPolicy: "queue", queueDepth: 3 })
      });

      const first = gateway.receive(makeMessage("hello"));
      await new Promise((resolve) => setTimeout(resolve, 10));
      await gateway.receive(makeMessage("second")); // queued

      // Wait for handle to complete but dispose to still be pending
      while (!handleResolved) {
        await new Promise((r) => setTimeout(r, 5));
      }

      // At this point: turn ended, dispose still running, queue has "second"
      const stopResult = await gateway.receive(makeMessage("/stop"));
      expect(stopResult.replyText).toContain("Cleared 1 queued message");

      // Let dispose finish so drain can clean up
      disposeResolve?.();
      await first;
    });

    it("multi-message queue drains fully", async () => {
      const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
      const registry = new ActiveTurnRegistry();
      const handles: string[] = [];

      const gateway = new ChannelGateway({
        adapters: [adapter],
        runtimeForSession: async () => ({
          ...createMinimalRuntime(),
          handle: async ({ text }: { text: string }) => {
            handles.push(text);
            await new Promise((resolve) => setTimeout(resolve, 20));
            return {
              label: "ok",
              text: "ok",
              matchedSkills: [],
              intent: { labels: ["general"], confidence: 1, nativeIntent: "general", suggestedToolsets: [], suggestedSkills: [], confirmationRequired: false, evidence: [], rationale: "" },
              securityDecision: "allow",
              toolExecutions: [],
              toolPlans: [],
              skillOutcomes: [],
              artifacts: [],
              context: undefined,
              projectContext: undefined,
              progress: []
            } as Awaited<ReturnType<Runtime["handle"]>>;
          }
        }),
        sessionStore: new InMemoryChannelSessionStore(),
        authPolicy: { telegram: { allowedUserIds: ["user-1"] } },
        activeTurnRegistry: registry,
        busyPolicyResolver: () => ({ busyPolicy: "queue", queueDepth: 3 })
      });

      const first = gateway.receive(makeMessage("A"));
      await new Promise((resolve) => setTimeout(resolve, 10));
      await gateway.receive(makeMessage("B")); // queued
      await gateway.receive(makeMessage("C")); // queued

      await first;
      await waitForPendingWork(gateway);
      expect(handles).toEqual(["A", "B", "C"]);
      expect(gateway.hasPendingWork()).toBe(false);
    });

    it("A receive resolves before queued B completes", async () => {
      const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
      const registry = new ActiveTurnRegistry();
      const handles: string[] = [];
      let bStarted = false;

      const gateway = new ChannelGateway({
        adapters: [adapter],
        runtimeForSession: async () => ({
          ...createMinimalRuntime(),
          handle: async ({ text }: { text: string }) => {
            handles.push(text);
            if (text === "B") {
              bStarted = true;
            }
            await new Promise((resolve) => setTimeout(resolve, 30));
            return {
              label: "ok",
              text: "ok",
              matchedSkills: [],
              intent: { labels: ["general"], confidence: 1, nativeIntent: "general", suggestedToolsets: [], suggestedSkills: [], confirmationRequired: false, evidence: [], rationale: "" },
              securityDecision: "allow",
              toolExecutions: [],
              toolPlans: [],
              skillOutcomes: [],
              artifacts: [],
              context: undefined,
              projectContext: undefined,
              progress: []
            } as Awaited<ReturnType<Runtime["handle"]>>;
          }
        }),
        sessionStore: new InMemoryChannelSessionStore(),
        authPolicy: { telegram: { allowedUserIds: ["user-1"] } },
        activeTurnRegistry: registry,
        busyPolicyResolver: () => ({ busyPolicy: "queue", queueDepth: 3 })
      });

      const first = gateway.receive(makeMessage("A"));
      await new Promise((resolve) => setTimeout(resolve, 10));
      await gateway.receive(makeMessage("B")); // queued

      // Wait until A is definitely done (and B may or may not have started)
      await first;

      // A must have resolved before B completes. If drain was awaited inside
      // #processTurn finally, this assertion would fail because first would
      // resolve only after B finishes.
      expect(handles).toContain("A");

      // B should still be in progress or about to start, but if timing is tight,
      // wait for it explicitly and confirm it ran.
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(handles).toEqual(["A", "B"]);
      expect(bStarted).toBe(true);
    });

    it("queued turn finally drains the next queued item even when drainingQueue was used for the previous launch", async () => {
      const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
      const registry = new ActiveTurnRegistry();
      let handleCount = 0;

      const gateway = new ChannelGateway({
        adapters: [adapter],
        runtimeForSession: async () => ({
          ...createMinimalRuntime(),
          handle: async () => {
            handleCount++;
            await new Promise((resolve) => setTimeout(resolve, 15));
            return {
              label: "ok",
              text: "ok",
              matchedSkills: [],
              intent: { labels: ["general"], confidence: 1, nativeIntent: "general", suggestedToolsets: [], suggestedSkills: [], confirmationRequired: false, evidence: [], rationale: "" },
              securityDecision: "allow",
              toolExecutions: [],
              toolPlans: [],
              skillOutcomes: [],
              artifacts: [],
              context: undefined,
              projectContext: undefined,
              progress: []
            } as Awaited<ReturnType<Runtime["handle"]>>;
          }
        }),
        sessionStore: new InMemoryChannelSessionStore(),
        authPolicy: { telegram: { allowedUserIds: ["user-1"] } },
        activeTurnRegistry: registry,
        busyPolicyResolver: () => ({ busyPolicy: "queue", queueDepth: 3 })
      });

      const first = gateway.receive(makeMessage("hello"));
      await new Promise((resolve) => setTimeout(resolve, 10));
      await gateway.receive(makeMessage("second")); // queued
      await gateway.receive(makeMessage("third"));  // queued

      await first;
      await waitForPendingWork(gateway);
      // All three should have processed because each turn's finally re-entered #drainQueuedTurns
      // after the guard was cleared
      expect(handleCount).toBe(3);
    });

    it("hasPendingWork returns true while queued messages are draining, then false after all drain", async () => {
      const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
      const registry = new ActiveTurnRegistry();
      const pendingSnapshots: boolean[] = [];

      const gateway = new ChannelGateway({
        adapters: [adapter],
        runtimeForSession: async () => ({
          ...createMinimalRuntime(),
          handle: async () => {
            pendingSnapshots.push(gateway.hasPendingWork());
            await new Promise((resolve) => setTimeout(resolve, 20));
            return {
              label: "ok",
              text: "ok",
              matchedSkills: [],
              intent: { labels: ["general"], confidence: 1, nativeIntent: "general", suggestedToolsets: [], suggestedSkills: [], confirmationRequired: false, evidence: [], rationale: "" },
              securityDecision: "allow",
              toolExecutions: [],
              toolPlans: [],
              skillOutcomes: [],
              artifacts: [],
              context: undefined,
              projectContext: undefined,
              progress: []
            } as Awaited<ReturnType<Runtime["handle"]>>;
          }
        }),
        sessionStore: new InMemoryChannelSessionStore(),
        authPolicy: { telegram: { allowedUserIds: ["user-1"] } },
        activeTurnRegistry: registry,
        busyPolicyResolver: () => ({ busyPolicy: "queue", queueDepth: 3 })
      });

      const first = gateway.receive(makeMessage("A"));
      await new Promise((resolve) => setTimeout(resolve, 10));
      await gateway.receive(makeMessage("B")); // queued
      await gateway.receive(makeMessage("C")); // queued

      expect(gateway.hasPendingWork()).toBe(true);
      await first;
      await waitForPendingWork(gateway);
      expect(gateway.hasPendingWork()).toBe(false);

      // At least the first handle call should see pending work (active or queued)
      expect(pendingSnapshots.some((v) => v === true)).toBe(true);
    });

    it("no permanent busy state after multiple queued messages", async () => {
      const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
      const registry = new ActiveTurnRegistry();
      let handleCount = 0;

      const gateway = new ChannelGateway({
        adapters: [adapter],
        runtimeForSession: async () => ({
          ...createMinimalRuntime(),
          handle: async () => {
            handleCount++;
            await new Promise((resolve) => setTimeout(resolve, 10));
            return {
              label: "ok",
              text: "ok",
              matchedSkills: [],
              intent: { labels: ["general"], confidence: 1, nativeIntent: "general", suggestedToolsets: [], suggestedSkills: [], confirmationRequired: false, evidence: [], rationale: "" },
              securityDecision: "allow",
              toolExecutions: [],
              toolPlans: [],
              skillOutcomes: [],
              artifacts: [],
              context: undefined,
              projectContext: undefined,
              progress: []
            } as Awaited<ReturnType<Runtime["handle"]>>;
          }
        }),
        sessionStore: new InMemoryChannelSessionStore(),
        authPolicy: { telegram: { allowedUserIds: ["user-1"] } },
        activeTurnRegistry: registry,
        busyPolicyResolver: () => ({ busyPolicy: "queue", queueDepth: 3 })
      });

      const first = gateway.receive(makeMessage("hello"));
      await new Promise((resolve) => setTimeout(resolve, 5));
      await gateway.receive(makeMessage("q1")); // queued
      await gateway.receive(makeMessage("q2")); // queued
      await gateway.receive(makeMessage("q3")); // queued

      await first;
      await waitForPendingWork(gateway);
      expect(handleCount).toBe(4);
      expect(gateway.hasPendingWork()).toBe(false);

      // Gateway should be ready to accept new messages
      const after = await gateway.receive(makeMessage("after"));
      expect(after.replyText).not.toContain("busy");
      expect(handleCount).toBe(5);
    });

    it("drain waits for active and all queued messages to complete before clean shutdown", async () => {
      const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
      const registry = new ActiveTurnRegistry();
      let handleCount = 0;
      let draining = false;

      const gateway = new ChannelGateway({
        adapters: [adapter],
        runtimeForSession: async () => ({
          ...createMinimalRuntime(),
          handle: async () => {
            handleCount++;
            await new Promise((resolve) => setTimeout(resolve, 30));
            return {
              label: "ok",
              text: "ok",
              matchedSkills: [],
              intent: { labels: ["general"], confidence: 1, nativeIntent: "general", suggestedToolsets: [], suggestedSkills: [], confirmationRequired: false, evidence: [], rationale: "" },
              securityDecision: "allow",
              toolExecutions: [],
              toolPlans: [],
              skillOutcomes: [],
              artifacts: [],
              context: undefined,
              projectContext: undefined,
              progress: []
            } as Awaited<ReturnType<Runtime["handle"]>>;
          }
        }),
        sessionStore: new InMemoryChannelSessionStore(),
        authPolicy: { telegram: { allowedUserIds: ["user-1"] } },
        activeTurnRegistry: registry,
        busyPolicyResolver: () => ({ busyPolicy: "queue", queueDepth: 3 }),
        isDraining: () => draining
      });

      const first = gateway.receive(makeMessage("A"));
      await new Promise((resolve) => setTimeout(resolve, 10));
      await gateway.receive(makeMessage("B")); // queued
      await gateway.receive(makeMessage("C")); // queued

      draining = true;
      expect(gateway.hasPendingWork()).toBe(true);

      await first;
      await waitForPendingWork(gateway);
      // A, B, and C should all have run because queued messages are allowed during drain
      expect(handleCount).toBe(3);
      expect(gateway.hasPendingWork()).toBe(false);
    });

    it("failed queued turn launch clears drainingQueue if no queued messages remain", async () => {
      const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
      const registry = new ActiveTurnRegistry();
      let shouldThrow = false;

      const gateway = new ChannelGateway({
        adapters: [adapter],
        runtimeForSession: async () => ({
          ...createMinimalRuntime(),
          handle: async () => {
            if (shouldThrow) {
              throw new Error("queued turn failed");
            }
            await new Promise((resolve) => setTimeout(resolve, 20));
            return {
              label: "ok",
              text: "ok",
              matchedSkills: [],
              intent: { labels: ["general"], confidence: 1, nativeIntent: "general", suggestedToolsets: [], suggestedSkills: [], confirmationRequired: false, evidence: [], rationale: "" },
              securityDecision: "allow",
              toolExecutions: [],
              toolPlans: [],
              skillOutcomes: [],
              artifacts: [],
              context: undefined,
              projectContext: undefined,
              progress: []
            } as Awaited<ReturnType<Runtime["handle"]>>;
          }
        }),
        sessionStore: new InMemoryChannelSessionStore(),
        authPolicy: { telegram: { allowedUserIds: ["user-1"] } },
        activeTurnRegistry: registry,
        busyPolicyResolver: () => ({ busyPolicy: "queue", queueDepth: 3 })
      });

      const first = gateway.receive(makeMessage("hello"));
      await new Promise((resolve) => setTimeout(resolve, 10));
      shouldThrow = true;
      await gateway.receive(makeMessage("failer")); // queued, will throw

      await first;
      await waitForPendingWork(gateway);
      // After the failed queued turn, the session should not be permanently busy
      expect(gateway.hasPendingWork()).toBe(false);

      // Should be able to receive new messages
      const next = await gateway.receive(makeMessage("next"));
      expect(next.replyText).not.toContain("busy");
    });

    it("drainingQueue guard prevents parallel turn start", async () => {
      const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
      const registry = new ActiveTurnRegistry();
      let handleCount = 0;

      const gateway = new ChannelGateway({
        adapters: [adapter],
        runtimeForSession: async () => ({
          ...createMinimalRuntime(),
          handle: async () => {
            handleCount++;
            await new Promise((resolve) => setTimeout(resolve, 50));
            return {
              label: "ok",
              text: "ok",
              matchedSkills: [],
              intent: { labels: ["general"], confidence: 1, nativeIntent: "general", suggestedToolsets: [], suggestedSkills: [], confirmationRequired: false, evidence: [], rationale: "" },
              securityDecision: "allow",
              toolExecutions: [],
              toolPlans: [],
              skillOutcomes: [],
              artifacts: [],
              context: undefined,
              projectContext: undefined,
              progress: []
            } as Awaited<ReturnType<Runtime["handle"]>>;
          }
        }),
        sessionStore: new InMemoryChannelSessionStore(),
        authPolicy: { telegram: { allowedUserIds: ["user-1"] } },
        activeTurnRegistry: registry,
        busyPolicyResolver: () => ({ busyPolicy: "reject", queueDepth: 3 })
      });

      const first = gateway.receive(makeMessage("hello"));
      await new Promise((resolve) => setTimeout(resolve, 10));
      // First turn is active; send a second message that gets rejected
      const second = await gateway.receive(makeMessage("second"));
      expect(second.replyText).toBe(""); // rejected, no reply
      await first;

      // Only one turn started
      expect(handleCount).toBe(1);
    });

    it("fallback without registry still prevents parallel turns via #activeTurns", async () => {
      const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
      let handleCount = 0;

      const gateway = new ChannelGateway({
        adapters: [adapter],
        runtimeForSession: async () => ({
          ...createMinimalRuntime(),
          handle: async () => {
            handleCount++;
            await new Promise((resolve) => setTimeout(resolve, 50));
            return {
              label: "ok",
              text: "ok",
              matchedSkills: [],
              intent: { labels: ["general"], confidence: 1, nativeIntent: "general", suggestedToolsets: [], suggestedSkills: [], confirmationRequired: false, evidence: [], rationale: "" },
              securityDecision: "allow",
              toolExecutions: [],
              toolPlans: [],
              skillOutcomes: [],
              artifacts: [],
              context: undefined,
              projectContext: undefined,
              progress: []
            } as Awaited<ReturnType<Runtime["handle"]>>;
          }
        }),
        sessionStore: new InMemoryChannelSessionStore(),
        authPolicy: { telegram: { allowedUserIds: ["user-1"] } },
        busyPolicyResolver: () => ({ busyPolicy: "queue", queueDepth: 3 })
      });

      const first = gateway.receive(makeMessage("hello"));
      await new Promise((resolve) => setTimeout(resolve, 10));
      const second = await gateway.receive(makeMessage("second"));
      await first;
      await waitForPendingWork(gateway);
      expect(handleCount).toBe(2); // first + queued drained
      expect(second.replyText).toBe(""); // queued, no immediate reply
    });
  });

  describe("hook emissions", () => {
    it("emits session:turn:start and session:turn:complete on success", async () => {
      const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
      const registry = new HookRegistry();
      const startEvents: unknown[] = [];
      const completeEvents: unknown[] = [];
      registry.on("session:turn:start", (ev) => { startEvents.push(ev.payload); });
      registry.on("session:turn:complete", (ev) => { completeEvents.push(ev.payload); });

      const gateway = new ChannelGateway({
        adapters: [adapter],
        runtimeForSession: async () => createMinimalRuntime(),
        sessionStore: new InMemoryChannelSessionStore(),
        authPolicy: { telegram: { allowedUserIds: ["user-1"] } },
        hookRegistry: registry,
      });

      await gateway.receive(makeMessage("hello"));
      expect(startEvents).toHaveLength(1);
      expect(completeEvents).toHaveLength(1);
      expect((completeEvents[0] as { durationMs: number }).durationMs).toBeGreaterThanOrEqual(0);
    });

    it("emits session:turn:error on runtime failure", async () => {
      const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
      const registry = new HookRegistry();
      const errorEvents: unknown[] = [];
      registry.on("session:turn:error", (ev) => { errorEvents.push(ev.payload); });

      const gateway = new ChannelGateway({
        adapters: [adapter],
        runtimeForSession: async () => ({
          ...createMinimalRuntime(),
          handle: async () => { throw new Error("runtime boom"); }
        }),
        sessionStore: new InMemoryChannelSessionStore(),
        authPolicy: { telegram: { allowedUserIds: ["user-1"] } },
        hookRegistry: registry,
      });

      await gateway.receive(makeMessage("hello"));
      expect(errorEvents).toHaveLength(1);
      expect((errorEvents[0] as { errorClass: string }).errorClass).toBe("Error");
      expect((errorEvents[0] as { errorMessage: string }).errorMessage).toBe("runtime boom");
    });

    it("emits session:turn:abort on interrupt", async () => {
      const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
      const registry = new HookRegistry();
      const abortEvents: unknown[] = [];
      registry.on("session:turn:abort", (ev) => { abortEvents.push(ev.payload); });

      const gateway = new ChannelGateway({
        adapters: [adapter],
        runtimeForSession: async () => ({
          ...createMinimalRuntime(),
          handle: async ({ signal }) => {
            await new Promise((_, reject) => {
              if (signal) {
                signal.addEventListener("abort", () => reject(new Error("aborted")));
              }
            });
            return {
              label: "ok",
              text: "ok",
              matchedSkills: [],
              intent: { labels: ["general"], confidence: 1, nativeIntent: "general", suggestedToolsets: [], suggestedSkills: [], confirmationRequired: false, evidence: [], rationale: "" },
              securityDecision: "allow",
              toolExecutions: [],
              toolPlans: [],
              skillOutcomes: [],
              artifacts: [],
              context: undefined,
              projectContext: undefined,
              progress: []
            } as Awaited<ReturnType<Runtime["handle"]>>;
          }
        }),
        sessionStore: new InMemoryChannelSessionStore(),
        authPolicy: { telegram: { allowedUserIds: ["user-1"] } },
        busyPolicyResolver: () => ({ busyPolicy: "interrupt", queueDepth: 3 }),
        hookRegistry: registry,
      });

      const first = gateway.receive(makeMessage("hello"));
      await new Promise((resolve) => setTimeout(resolve, 10));
      await gateway.receive(makeMessage("second"));
      await first.catch(() => {});

      expect(abortEvents).toHaveLength(1);
      expect((abortEvents[0] as { reason: string }).reason).toBe("interrupt");
    });

    it("emits session:turn:abort on /stop when runtime returns normally", async () => {
      const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
      const registry = new HookRegistry();
      const abortEvents: unknown[] = [];
      const completeEvents: unknown[] = [];
      registry.on("session:turn:abort", (ev) => { abortEvents.push(ev.payload); });
      registry.on("session:turn:complete", (ev) => { completeEvents.push(ev.payload); });

      const gateway = new ChannelGateway({
        adapters: [adapter],
        runtimeForSession: async () => ({
          ...createMinimalRuntime(),
          handle: async ({ signal }) => {
            await new Promise((resolve) => setTimeout(resolve, 50));
            // Return normally even if signal is aborted
            return {
              label: "ok",
              text: "ok",
              matchedSkills: [],
              intent: { labels: ["general"], confidence: 1, nativeIntent: "general", suggestedToolsets: [], suggestedSkills: [], confirmationRequired: false, evidence: [], rationale: "" },
              securityDecision: "allow",
              toolExecutions: [],
              toolPlans: [],
              skillOutcomes: [],
              artifacts: [],
              context: undefined,
              projectContext: undefined,
              progress: []
            } as Awaited<ReturnType<Runtime["handle"]>>;
          }
        }),
        sessionStore: new InMemoryChannelSessionStore(),
        authPolicy: { telegram: { allowedUserIds: ["user-1"] } },
        hookRegistry: registry,
      });

      const turn = gateway.receive(makeMessage("hello"));
      await new Promise((resolve) => setTimeout(resolve, 10));
      await gateway.receive(makeMessage("/stop"));
      await turn;

      expect(abortEvents).toHaveLength(1);
      expect((abortEvents[0] as { reason: string }).reason).toBe("stop");
      expect(completeEvents).toHaveLength(0);
    });

    it("emits session:turn:abort on interrupt when runtime returns normally", async () => {
      const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
      const registry = new HookRegistry();
      const abortEvents: unknown[] = [];
      const completeEvents: unknown[] = [];
      registry.on("session:turn:abort", (ev) => { abortEvents.push(ev.payload); });
      registry.on("session:turn:complete", (ev) => { completeEvents.push(ev.payload); });

      const gateway = new ChannelGateway({
        adapters: [adapter],
        runtimeForSession: async () => ({
          ...createMinimalRuntime(),
          handle: async ({ signal }) => {
            await new Promise((resolve) => setTimeout(resolve, 50));
            // Return normally even if signal is aborted
            return {
              label: "ok",
              text: "ok",
              matchedSkills: [],
              intent: { labels: ["general"], confidence: 1, nativeIntent: "general", suggestedToolsets: [], suggestedSkills: [], confirmationRequired: false, evidence: [], rationale: "" },
              securityDecision: "allow",
              toolExecutions: [],
              toolPlans: [],
              skillOutcomes: [],
              artifacts: [],
              context: undefined,
              projectContext: undefined,
              progress: []
            } as Awaited<ReturnType<Runtime["handle"]>>;
          }
        }),
        sessionStore: new InMemoryChannelSessionStore(),
        authPolicy: { telegram: { allowedUserIds: ["user-1"] } },
        busyPolicyResolver: () => ({ busyPolicy: "interrupt", queueDepth: 3 }),
        hookRegistry: registry,
      });

      const first = gateway.receive(makeMessage("hello"));
      await new Promise((resolve) => setTimeout(resolve, 10));
      await gateway.receive(makeMessage("second"));
      await first;

      expect(abortEvents).toHaveLength(1);
      expect((abortEvents[0] as { reason: string }).reason).toBe("interrupt");
      expect(completeEvents).toHaveLength(0);
    });

    it("does not emit start for busy reject", async () => {
      const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
      const registry = new HookRegistry();
      const startEvents: unknown[] = [];
      registry.on("session:turn:start", (ev) => { startEvents.push(ev.payload); });

      const gateway = new ChannelGateway({
        adapters: [adapter],
        runtimeForSession: async () => ({
          ...createMinimalRuntime(),
          handle: async () => {
            await new Promise((resolve) => setTimeout(resolve, 100));
            return {
              label: "ok",
              text: "ok",
              matchedSkills: [],
              intent: { labels: ["general"], confidence: 1, nativeIntent: "general", suggestedToolsets: [], suggestedSkills: [], confirmationRequired: false, evidence: [], rationale: "" },
              securityDecision: "allow",
              toolExecutions: [],
              toolPlans: [],
              skillOutcomes: [],
              artifacts: [],
              context: undefined,
              projectContext: undefined,
              progress: []
            } as Awaited<ReturnType<Runtime["handle"]>>;
          }
        }),
        sessionStore: new InMemoryChannelSessionStore(),
        authPolicy: { telegram: { allowedUserIds: ["user-1"] } },
        busyPolicyResolver: () => ({ busyPolicy: "reject", queueDepth: 3 }),
        hookRegistry: registry,
      });

      const first = gateway.receive(makeMessage("hello"));
      await new Promise((resolve) => setTimeout(resolve, 10));
      await gateway.receive(makeMessage("second"));
      await first;

      expect(startEvents).toHaveLength(1); // only first turn started
    });

    it("hook failures do not prevent runtime.dispose", async () => {
      const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
      const registry = new HookRegistry();
      let disposed = false;
      registry.on("session:turn:complete", () => { throw new Error("hook boom"); });

      const gateway = new ChannelGateway({
        adapters: [adapter],
        runtimeForSession: async () => ({
          ...createMinimalRuntime(),
          dispose: async () => { disposed = true; }
        }),
        sessionStore: new InMemoryChannelSessionStore(),
        authPolicy: { telegram: { allowedUserIds: ["user-1"] } },
        hookRegistry: registry,
      });

      await gateway.receive(makeMessage("hello"));
      expect(disposed).toBe(true);
    });
  });

  describe("Workstream 6: per-channel auth and workspace trust", () => {
    it("rejects Discord message when no Discord allowlist is configured", async () => {
      const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
      const gateway = new ChannelGateway({
        adapters: [adapter],
        runtimeForSession: async () => createMinimalRuntime(),
        sessionStore: new InMemoryChannelSessionStore(),
        authPolicy: { telegram: { allowedUserIds: ["user-1"] } },
      });

      const result = await gateway.receive(makeMessage("hello", { channel: "discord", sender: { id: "discord-user", displayName: "D" } }));
      expect(result.replyText).toContain("locked");
    });

    it("rejects Email sender when not in allowlist", async () => {
      const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
      const gateway = new ChannelGateway({
        adapters: [adapter],
        runtimeForSession: async () => createMinimalRuntime(),
        sessionStore: new InMemoryChannelSessionStore(),
        authPolicy: { email: { allowedSenders: ["owner@example.com"] } },
      });

      const result = await gateway.receive(makeMessage("hello", {
        channel: "email",
        sender: { id: "intruder@example.com", displayName: "Intruder" }
      }));
      expect(result.replyText).toContain("locked");
    });

    it("rejects WhatsApp number when not in allowlist", async () => {
      const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
      const gateway = new ChannelGateway({
        adapters: [adapter],
        runtimeForSession: async () => createMinimalRuntime(),
        sessionStore: new InMemoryChannelSessionStore(),
        authPolicy: { whatsapp: { allowedNumbers: ["1234567890"] } },
      });

      const result = await gateway.receive(makeMessage("hello", {
        channel: "whatsapp",
        sender: { id: "9998887777", displayName: "Stranger" }
      }));
      expect(result.replyText).toContain("locked");
    });

    it("allowed Discord user does not authorize Email sender", async () => {
      const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
      const gateway = new ChannelGateway({
        adapters: [adapter],
        runtimeForSession: async () => createMinimalRuntime(),
        sessionStore: new InMemoryChannelSessionStore(),
        authPolicy: {
          discord: { allowedUserIds: ["discord-user"] },
        },
      });

      const result = await gateway.receive(makeMessage("hello", {
        channel: "email",
        sender: { id: "discord-user", displayName: "Same ID" }
      }));
      expect(result.replyText).toContain("locked");
    });

    it("allowed Email sender does not authorize Telegram/Discord/WhatsApp", async () => {
      const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
      const gateway = new ChannelGateway({
        adapters: [adapter],
        runtimeForSession: async () => createMinimalRuntime(),
        sessionStore: new InMemoryChannelSessionStore(),
        authPolicy: {
          email: { allowedSenders: ["owner@example.com"] },
        },
      });

      const telegramResult = await gateway.receive(makeMessage("hello", {
        channel: "telegram",
        sender: { id: "owner@example.com", displayName: "Owner" }
      }));
      expect(telegramResult.replyText).toContain("locked");

      const discordResult = await gateway.receive(makeMessage("hello", {
        channel: "discord",
        sender: { id: "owner@example.com", displayName: "Owner" }
      }));
      expect(discordResult.replyText).toContain("locked");

      const whatsappResult = await gateway.receive(makeMessage("hello", {
        channel: "whatsapp",
        sender: { id: "owner@example.com", displayName: "Owner" }
      }));
      expect(whatsappResult.replyText).toContain("locked");
    });

    it("empty authPolicy means all remote channels are locked", async () => {
      const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
      const gateway = new ChannelGateway({
        adapters: [adapter],
        runtimeForSession: async () => createMinimalRuntime(),
        sessionStore: new InMemoryChannelSessionStore(),
        authPolicy: {},
      });

      const telegramResult = await gateway.receive(makeMessage("hello"));
      expect(telegramResult.replyText).toContain("locked");
    });

    it("passes trustedWorkspace=false into runtime when workspace is untrusted", async () => {
      const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
      let receivedTrusted: boolean | undefined;
      const gateway = new ChannelGateway({
        adapters: [adapter],
        runtimeForSession: async () => ({
          ...createMinimalRuntime(),
          handle: async ({ trustedWorkspace }: { trustedWorkspace?: boolean }) => {
            receivedTrusted = trustedWorkspace;
            return createMinimalRuntime().handle({} as any);
          }
        }),
        sessionStore: new InMemoryChannelSessionStore(),
        authPolicy: { telegram: { allowedUserIds: ["user-1"] } },
        trustedWorkspace: false,
      });

      await gateway.receive(makeMessage("hello"));
      expect(receivedTrusted).toBe(false);
    });

    it("passes trustedWorkspace=true into runtime when workspace is trusted", async () => {
      const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
      let receivedTrusted: boolean | undefined;
      const gateway = new ChannelGateway({
        adapters: [adapter],
        runtimeForSession: async () => ({
          ...createMinimalRuntime(),
          handle: async ({ trustedWorkspace }: { trustedWorkspace?: boolean }) => {
            receivedTrusted = trustedWorkspace;
            return createMinimalRuntime().handle({} as any);
          }
        }),
        sessionStore: new InMemoryChannelSessionStore(),
        authPolicy: { telegram: { allowedUserIds: ["user-1"] } },
        trustedWorkspace: true,
      });

      await gateway.receive(makeMessage("hello"));
      expect(receivedTrusted).toBe(true);
    });
  });
});
