import { describe, it, expect, vi } from "vitest";
import { ChannelGateway, InMemoryChannelSessionStore, telegramGatewayCommands, authorizeChannelMessage } from "./channel-gateway.js";
import { createFakeTelegramAdapter } from "../test/fakes/fake-telegram-adapter.js";
import { InMemorySurfacePointerStore } from "./surface-pointer-store.js";
import type { ChannelMessage, ChannelSessionKey } from "../contracts/channel.js";
import type { Runtime } from "../runtime/create-runtime.js";
import { ActiveTurnRegistry } from "../gateway/active-turn-registry.js";
import type { RuntimeCache } from "../runtime/runtime-cache.js";
import type { RuntimeFingerprint } from "../runtime/runtime-fingerprint.js";
import type { ChannelSessionStore } from "./channel-gateway.js";
import type { FakeDeliveryRecord } from "../test/fakes/fake-channel-adapter.js";

type FakeTelegramAdapter = ReturnType<typeof createFakeTelegramAdapter> & { records: FakeDeliveryRecord[]; clearRecords(): void };

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
      appendMessage: async (input) => ({
        id: "msg-1",
        sessionId: input.sessionId,
        role: input.role,
        content: input.content,
        createdAt: new Date().toISOString(),
        channel: input.channel,
        metadata: input.metadata
      }),
      appendEvent: async () => {},
      listMessages: async () => [],
      listEvents: async () => [],
      search: async () => []
    },
    sessionId: "sess-1"
  } as Runtime;
}

describe("ChannelGateway commands", () => {
  describe("/sethome", () => {
    it("sets home delivery to current chat by default", async () => {
      const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
      const pointerStore = new InMemorySurfacePointerStore();
      const gateway = new ChannelGateway({
        adapters: [adapter],
        runtimeForSession: async () => createMinimalRuntime(),
        sessionStore: new InMemoryChannelSessionStore(),
        authPolicy: { mode: "allow-all" },
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
        authPolicy: { mode: "allow-all" },
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
        authPolicy: { mode: "allow-all" },
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
        authPolicy: { mode: "allow-all" }
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
        authPolicy: { mode: "allow-all" },
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
        authPolicy: { mode: "allow-all" }
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
        authPolicy: { mode: "allow-all" },
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
        authPolicy: { mode: "allow-all" }
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
        authPolicy: { mode: "allow-all" }
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
        authPolicy: { mode: "allow-all" }
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
        authPolicy: { mode: "allow-all" }
      });

      await gateway.receive(makeMessage("hello world"));
      expect(capturedMetadata?.origin).toBe("message");
    });
  });

  describe("telegramGatewayCommands", () => {
    it("includes /sethome and /diagnostics", () => {
      const commands = telegramGatewayCommands();
      const sethome = commands.find((c) => c.command === "/sethome");
      const diagnostics = commands.find((c) => c.command === "/diagnostics");
      expect(sethome).toBeDefined();
      expect(diagnostics).toBeDefined();
    });
  });

  describe("authorizeChannelMessage", () => {
    it("allows messages from allowed user ids", () => {
      const result = authorizeChannelMessage(
        makeMessage("hi"),
        { mode: "allowlist", allowedUserIds: ["user-1"], allowedChatIds: [] }
      );
      expect(result.allowed).toBe(true);
    });

    it("denies messages from unknown users", () => {
      const result = authorizeChannelMessage(
        makeMessage("hi"),
        { mode: "allowlist", allowedUserIds: ["user-2"], allowedChatIds: [] }
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
        authPolicy: { mode: "allow-all" },
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
        authPolicy: { mode: "allow-all" },
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
        authPolicy: { mode: "allow-all" },
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
        authPolicy: { mode: "allow-all" },
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
        authPolicy: { mode: "allow-all" }
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
        authPolicy: { mode: "allow-all" },
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
        authPolicy: { mode: "allow-all" },
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
        authPolicy: { mode: "allow-all" },
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
        authPolicy: { mode: "allow-all" },
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
        authPolicy: { mode: "allow-all" },
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
        authPolicy: { mode: "allow-all" },
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
        authPolicy: { mode: "allow-all" },
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
        authPolicy: { mode: "allow-all" },
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
        authPolicy: { mode: "allow-all" },
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
        authPolicy: { mode: "allow-all" }
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
        authPolicy: { mode: "allow-all" },
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
        authPolicy: { mode: "allow-all" },
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
        authPolicy: { mode: "allow-all" },
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
        authPolicy: { mode: "allow-all" },
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
        authPolicy: { mode: "allow-all" },
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
        authPolicy: { mode: "allow-all" },
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
        authPolicy: { mode: "allow-all" },
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
        authPolicy: { mode: "allow-all" }
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
        authPolicy: { mode: "allow-all" }
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
        authPolicy: { mode: "allow-all" },
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
        authPolicy: { mode: "allow-all" },
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
        authPolicy: { mode: "allow-all" },
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
        authPolicy: { mode: "allow-all" },
        activeTurnRegistry: registry
      });

      const first = gateway.receive(makeMessage("hello"));
      const second = gateway.receive(makeMessage("hello again"));
      await Promise.all([first, second]);

      const textRecords = adapter.records.filter((r) => r.kind === "text");
      expect(textRecords.some((r) => r.text?.includes("busy"))).toBe(true);
    });
  });
});
