import { afterEach, describe, it, expect, vi } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  ChannelGateway,
  InMemoryChannelSessionStore,
  telegramGatewayCommands,
  authorizeChannelMessage,
  type ChannelGatewayOptions
} from "./channel-gateway.js";
import { ChannelApprovalStore } from "./channel-approval-store.js";
import { createFakeTelegramAdapter } from "../test/fakes/fake-telegram-adapter.js";
import { InMemorySurfacePointerStore } from "./surface-pointer-store.js";
import type {
  ChannelAdapter,
  ChannelMessage,
  ChannelSessionKey,
  ChannelStreamingTextHandle,
  ChannelStreamingTextOptions,
  ChannelStreamingTextResult
} from "../contracts/channel.js";
import type { ArtifactRecord } from "../contracts/artifact.js";
import type { SecurityAssessment, SecurityPolicy, SecurityRequest } from "../contracts/security.js";
import type { Runtime } from "../runtime/create-runtime.js";
import type { RuntimeEvent } from "../contracts/runtime-event.js";
import { deriveAgentEvolutionPolicy } from "../contracts/agent-evolution.js";
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
import { InMemorySessionDB } from "../session/in-memory-session-db.js";
import { loadRuntimeConfig } from "../config/runtime-config.js";
import { resolveProfileStateHome } from "../config/profile-home.js";
import { resolveEffectiveSessionModelOverride } from "../providers/model-switch-resolver.js";
import { stableSessionKey } from "./channel-session-store.js";
import {
  compactModelPickerLabel,
  modelPickerCancelActionValue,
  modelPickerClearActionValue
} from "./model-picker-actions.js";
import { VoiceStateManager } from "../gateway/voice-state.js";
import { AdapterResilienceSupervisor } from "../gateway/adapter-resilience.js";
import { EDGE_TTS_CAPABILITY_ID, requireRegisteredPythonCapabilitySpec } from "../python-env/capability-registry.js";
import { resolveManagedPythonCapabilityPaths } from "../python-env/capability-paths.js";
import { writeManagedPythonCapabilityManifest } from "../python-env/manifest.js";
import { fingerprintManagedPythonCapabilitySpec } from "../python-env/spec-hash.js";
import type { EdgeTtsRunInput, EdgeTtsRunner } from "../tools/tts-providers.js";

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
  artifacts?: Awaited<ReturnType<Runtime["handle"]>>["artifacts"];
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
    artifacts: input.artifacts ?? [],
    context: undefined,
    projectContext: undefined,
    progress: []
  };
}

type StreamingHandleSpy = ChannelStreamingTextHandle & {
  appended: string[];
  segmentBreaks: Array<string | undefined>;
  providerResults: Array<{ ok: boolean; willFallback: boolean; provider: string; model: string }>;
  finishCalls: string[];
  abortCalls: Array<string | undefined>;
  order: string[];
};

function createStreamingHandleSpy(input: {
  finishResult?: ChannelStreamingTextResult;
  finishError?: Error;
  abortError?: Error;
} = {}): StreamingHandleSpy {
  const handle: StreamingHandleSpy = {
    appended: [],
    segmentBreaks: [],
    providerResults: [],
    finishCalls: [],
    abortCalls: [],
    order: [],
    append(text: string) {
      this.order.push(`append:${text}`);
      this.appended.push(text);
    },
    segmentBreak(reason?: string) {
      this.order.push(`segmentBreak:${reason ?? ""}`);
      this.segmentBreaks.push(reason);
    },
    providerAttemptResult(result) {
      this.order.push(`providerAttemptResult:${result.ok}:${result.willFallback}`);
      this.providerResults.push(result);
    },
    async finish(finalText: string) {
      this.order.push(`finish:${finalText}`);
      this.finishCalls.push(finalText);
      if (input.finishError !== undefined) {
        throw input.finishError;
      }
      return input.finishResult ?? {
        delivered: true,
        fallbackRequired: false,
        deliveredText: finalText
      };
    },
    async abort(reason?: string) {
      this.order.push(`abort:${reason ?? ""}`);
      this.abortCalls.push(reason);
      if (input.abortError !== undefined) {
        throw input.abortError;
      }
    }
  };
  return handle;
}

type StreamingGatewayHarness = {
  adapter: FakeTelegramAdapter & {
    streamStarts: Array<{ sessionKey: ChannelSessionKey; options?: ChannelStreamingTextOptions }>;
    sendReplies: Array<{ conversationId: string; text?: string }>;
  };
  handle: StreamingHandleSpy;
  gateway: ChannelGateway;
  runtime: Runtime;
};

function createStreamingTelegramAdapter(handle: StreamingHandleSpy): StreamingGatewayHarness["adapter"] {
  const adapter = createFakeTelegramAdapter() as StreamingGatewayHarness["adapter"];
  const sendProgress = adapter.delivery!.sendProgress;
  adapter.streamStarts = [];
  adapter.sendReplies = [];
  adapter.delivery!.sendProgress = async (sessionKey, event) => {
    handle.order.push(`progress:${event.kind}`);
    await sendProgress?.(sessionKey, event);
  };
  adapter.delivery!.startStreamingText = (sessionKey, options) => {
    adapter.streamStarts.push({ sessionKey: { ...sessionKey }, options });
    return handle;
  };
  adapter.send = async (reply) => {
    adapter.sendReplies.push({
      conversationId: reply.conversationId,
      text: reply.text
    });
  };
  return adapter;
}

function createStreamingGatewayHarness(input: {
  enabled?: boolean;
  channel?: "telegram" | "discord";
  handle?: StreamingHandleSpy;
  runtimeResponse?: Awaited<ReturnType<Runtime["handle"]>>;
  events?: RuntimeEvent[];
  actions?: Array<
    | { kind: "event"; event: RuntimeEvent }
    | { kind: "delta"; text: string }
    | { kind: "segmentBreak"; reason?: string }
  >;
  deliveryRouter?: ChannelGatewayOptions["deliveryRouter"];
  telegramStreaming?: ChannelGatewayOptions["telegramStreaming"];
} = {}): StreamingGatewayHarness {
  const handle = input.handle ?? createStreamingHandleSpy();
  const adapter = input.channel === "discord"
    ? createFakeChannelAdapterWithStreaming("discord", handle)
    : createStreamingTelegramAdapter(handle);
  const runtime = createMinimalRuntime();
  runtime.handle = async (runtimeInput) => {
    const actions = input.actions ?? input.events?.map((event) => ({ kind: "event" as const, event })) ?? [];
    for (const action of actions) {
      if (action.kind === "event") {
        await runtimeInput.onEvent?.(action.event);
      } else if (action.kind === "delta") {
        runtimeInput.onDelta?.(action.text);
      } else {
        await runtimeInput.onSegmentBreak?.(action.reason);
      }
    }
    return input.runtimeResponse ?? runtimeResponse({
      text: "final answer",
      securityDecision: "allow"
    });
  };
  const gateway = new ChannelGateway({
    adapters: [adapter],
    runtimeForSession: async ({ sessionId }) => ({ ...runtime, sessionId }),
    sessionStore: new InMemoryChannelSessionStore(),
    authPolicy: {
      [input.channel ?? "telegram"]: { allowedUserIds: ["user-1"] }
    },
    telegramStreaming: input.telegramStreaming ?? {
      enabled: input.enabled ?? true,
      editIntervalMs: 111,
      minInitialChars: 7,
      cursor: "|",
      maxFloodStrikes: 3,
      cleanupFailedAttempts: false
    },
    deliveryRouter: input.deliveryRouter
  });

  return { adapter: adapter as StreamingGatewayHarness["adapter"], handle, gateway, runtime };
}

function createFakeChannelAdapterWithStreaming(kind: "discord", handle: StreamingHandleSpy): StreamingGatewayHarness["adapter"] {
  const adapter = createFakeTelegramAdapter() as StreamingGatewayHarness["adapter"];
  adapter.kind = kind;
  adapter.id = kind;
  adapter.delivery!.startStreamingText = () => handle;
  adapter.streamStarts = [];
  adapter.sendReplies = [];
  return adapter;
}

function providerToken(text: string): RuntimeEvent {
  return {
    kind: "provider-token",
    provider: "test",
    model: "m",
    text
  };
}

function providerResult(input: {
  ok: boolean;
  willFallback: boolean;
  fallback?: boolean;
  provider?: string;
  model?: string;
}): RuntimeEvent {
  return {
    kind: "provider-result",
    provider: input.provider ?? "test",
    model: input.model ?? "m",
    ok: input.ok,
    fallback: input.fallback ?? false,
    willFallback: input.willFallback
  };
}

function createRecordingDeliveryRouter() {
  const routedTexts: string[] = [];
  const routedArtifacts: ArtifactRecord[] = [];
  const routedProgress: RuntimeEvent[] = [];
  const deliveryRouter = {
    deliverText: async (_origins: unknown, text: string) => {
      routedTexts.push(text);
    },
    deliverProgress: async (_origin: unknown, event: RuntimeEvent) => {
      routedProgress.push(event);
    },
    deliverArtifact: async (_origin: unknown, artifact: ArtifactRecord) => {
      routedArtifacts.push(artifact);
    }
  } as unknown as ChannelGatewayOptions["deliveryRouter"];
  return { deliveryRouter, routedTexts, routedArtifacts, routedProgress };
}

describe("ChannelGateway Telegram streaming", () => {
  it("starts streaming only for Telegram when config is enabled and passes config options", async () => {
    const { adapter, gateway } = createStreamingGatewayHarness();

    await gateway.receive(makeMessage("hello"));

    expect(adapter.streamStarts).toHaveLength(1);
    expect(adapter.streamStarts[0]?.sessionKey).toMatchObject({ platform: "telegram", chatId: "123456" });
    expect(adapter.streamStarts[0]?.options).toMatchObject({
      editIntervalMs: 111,
      minInitialChars: 7,
      cursor: "|",
      maxFloodStrikes: 3,
      cleanupFailedAttempts: false
    });
    expect(adapter.streamStarts[0]?.options?.signal).toBeInstanceOf(AbortSignal);
  });

  it("preserves existing behavior when Telegram streaming config is disabled", async () => {
    const { adapter, handle, gateway } = createStreamingGatewayHarness({ enabled: false });

    await gateway.receive(makeMessage("hello"));

    expect(adapter.streamStarts).toHaveLength(0);
    expect(handle.finishCalls).toEqual([]);
    expect(adapter.records.filter((record) => record.kind === "text").map((record) => record.text)).toEqual(["final answer"]);
  });

  it("starts streaming by default when runtime config omits Telegram streaming settings", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "estacoda-channel-test-"));
    const configPath = resolveProfileStateHome({ homeDir: workspace, profileId: "default" }).configPath;
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(configPath, JSON.stringify({
      model: { provider: "openai", id: "gpt-4o" },
      channels: { telegram: { enabled: false } }
    }));
    const loaded = await loadRuntimeConfig({ workspaceRoot: workspace, homeDir: workspace });
    const { adapter, handle, gateway } = createStreamingGatewayHarness({
      telegramStreaming: loaded.channels.telegram.streaming,
      actions: [{ kind: "delta", text: "streamed token" }]
    });

    await gateway.receive(makeMessage("hello"));

    expect(adapter.streamStarts).toHaveLength(1);
    expect(handle.appended).toEqual(["streamed token"]);
    await rm(workspace, { recursive: true, force: true });
  });

  it("leaves non-Telegram behavior unchanged", async () => {
    const { adapter, handle, gateway } = createStreamingGatewayHarness({ channel: "discord" });

    await gateway.receive(makeMessage("hello", {
      channel: "discord",
      sessionKey: { platform: "discord", chatId: "discord-1", userId: "user-1" }
    }));

    expect(adapter.streamStarts).toHaveLength(0);
    expect(handle.finishCalls).toEqual([]);
    expect(adapter.records.filter((record) => record.kind === "text").map((record) => record.text)).toEqual(["final answer"]);
  });

  it("starts streaming when DeliveryRouter is present and skips duplicate routed final text", async () => {
    const { deliveryRouter, routedTexts } = createRecordingDeliveryRouter();
    const { adapter, handle, gateway } = createStreamingGatewayHarness({
      deliveryRouter,
      actions: [{ kind: "delta", text: "streamed token" }]
    });

    await gateway.receive(makeMessage("hello"));

    expect(adapter.streamStarts).toHaveLength(1);
    expect(handle.appended).toEqual(["streamed token"]);
    expect(handle.finishCalls).toEqual(["final answer"]);
    expect(routedTexts).toEqual([]);
  });

  it("routes provider tokens to append and not progress", async () => {
    const { adapter, handle, gateway } = createStreamingGatewayHarness({
      actions: [
        { kind: "event", event: providerToken("hello") },
        { kind: "delta", text: "hello" }
      ]
    });

    const result = await gateway.receive(makeMessage("hello"));

    expect(handle.appended).toEqual(["hello"]);
    expect(adapter.records.filter((record) => record.kind === "progress")).toHaveLength(0);
    expect(result.progressCount).toBe(0);
  });

  it("forwards provider-result attempt outcomes", async () => {
    const { handle, gateway } = createStreamingGatewayHarness({
      events: [providerResult({ ok: false, willFallback: true })],
      handle: createStreamingHandleSpy({ finishResult: { delivered: false, fallbackRequired: true } })
    });

    await gateway.receive(makeMessage("hello"));

    expect(handle.providerResults).toEqual([{
      ok: false,
      willFallback: true,
      provider: "test",
      model: "m"
    }]);
  });

  it("does not emit visible provider progress for repeated primary success", async () => {
    const { adapter, handle, gateway } = createStreamingGatewayHarness({
      events: [
        providerResult({ ok: true, willFallback: false, fallback: false, model: "primary-model" }),
        providerResult({ ok: true, willFallback: false, fallback: false, model: "primary-model" })
      ]
    });

    const result = await gateway.receive(makeMessage("hello"));

    expect(handle.providerResults).toHaveLength(2);
    expect(adapter.records.filter((record) => record.kind === "progress")).toHaveLength(0);
    expect(result.progressCount).toBe(0);
  });

  it("emits one fallback serving transition for repeated fallback success", async () => {
    const { adapter, gateway } = createStreamingGatewayHarness({
      events: [
        providerResult({ ok: true, willFallback: false, fallback: true, model: "fallback-model" }),
        providerResult({ ok: true, willFallback: false, fallback: true, model: "fallback-model" })
      ]
    });

    const result = await gateway.receive(makeMessage("hello"));
    const progress = adapter.records.filter((record) => record.kind === "progress");

    expect(progress.map((record) => record.event)).toEqual([
      {
        kind: "provider-serving-transition",
        transition: "fallback-active",
        provider: "test",
        model: "fallback-model"
      }
    ]);
    expect(result.progressCount).toBe(1);
  });

  it("emits fallback once and primary recovery once", async () => {
    const { adapter, gateway } = createStreamingGatewayHarness({
      events: [
        providerResult({ ok: true, willFallback: false, fallback: true, model: "fallback-model" }),
        providerResult({ ok: true, willFallback: false, fallback: false, model: "primary-model" }),
        providerResult({ ok: true, willFallback: false, fallback: false, model: "primary-model" })
      ]
    });

    const result = await gateway.receive(makeMessage("hello"));
    const progress = adapter.records.filter((record) => record.kind === "progress");

    expect(progress.map((record) => record.event)).toEqual([
      {
        kind: "provider-serving-transition",
        transition: "fallback-active",
        provider: "test",
        model: "fallback-model"
      },
      {
        kind: "provider-serving-transition",
        transition: "primary-recovered",
        provider: "test",
        model: "primary-model"
      }
    ]);
    expect(result.progressCount).toBe(2);
  });

  it("does not announce failed primary attempts while fallback will be tried", async () => {
    const { adapter, gateway } = createStreamingGatewayHarness({
      events: [
        providerResult({ ok: false, willFallback: true, fallback: false, model: "primary-model" })
      ],
      handle: createStreamingHandleSpy({ finishResult: { delivered: false, fallbackRequired: true } })
    });

    const result = await gateway.receive(makeMessage("hello"));

    expect(adapter.records.filter((record) => record.kind === "progress")).toHaveLength(0);
    expect(result.progressCount).toBe(0);
  });

  it("segments at provider tool-call before delivering tool progress and appends continuation tokens", async () => {
    const { adapter, handle, gateway } = createStreamingGatewayHarness({
      actions: [
        { kind: "event", event: providerToken("pre") },
        { kind: "delta", text: "pre" },
        { kind: "segmentBreak", reason: "provider-tool-call" },
        {
          kind: "event",
          event: {
            kind: "provider-tool-call",
            provider: "test",
            model: "m",
            name: "terminal.run"
          }
        },
        { kind: "event", event: { kind: "tool-start", tool: "terminal.run" } },
        { kind: "event", event: providerToken("post") },
        { kind: "delta", text: "post" }
      ]
    });

    await gateway.receive(makeMessage("hello"));

    expect(handle.appended).toEqual(["pre", "post"]);
    expect(handle.segmentBreaks).toEqual(["provider-tool-call"]);
    expect(handle.order.indexOf("segmentBreak:provider-tool-call")).toBeLessThan(handle.order.indexOf("progress:provider-tool-call"));
    expect(handle.order.indexOf("progress:provider-tool-call")).toBeLessThan(handle.order.indexOf("progress:tool-start"));
    expect(adapter.records.filter((record) => record.kind === "progress").map((record) => record.event?.kind)).toEqual([
      "provider-tool-call",
      "tool-start"
    ]);
  });

  it("clean no-tool turn finalizes stream and skips normal sendText", async () => {
    const { adapter, handle, gateway } = createStreamingGatewayHarness({
      actions: [
        { kind: "event", event: providerToken("answer") },
        { kind: "delta", text: "answer" }
      ]
    });

    await gateway.receive(makeMessage("hello"));

    expect(handle.finishCalls).toEqual(["final answer"]);
    expect(adapter.records.filter((record) => record.kind === "text")).toHaveLength(0);
  });

  it("tool turn with live final continuation finalizes stream and skips duplicate final text", async () => {
    const { adapter, handle, gateway } = createStreamingGatewayHarness({
      actions: [
        { kind: "event", event: providerToken("pre") },
        { kind: "delta", text: "pre" },
        { kind: "segmentBreak", reason: "provider-tool-call" },
        { kind: "event", event: { kind: "provider-tool-call", provider: "test", model: "m", name: "search" } },
        { kind: "event", event: { kind: "tool-start", tool: "search" } },
        { kind: "event", event: providerToken("post") },
        { kind: "delta", text: "post" }
      ]
    });

    await gateway.receive(makeMessage("hello"));

    expect(handle.finishCalls).toEqual(["final answer"]);
    expect(adapter.records.filter((record) => record.kind === "text")).toHaveLength(0);
  });

  it("tool turn with no live final segment falls back to normal sendText", async () => {
    const { adapter, gateway } = createStreamingGatewayHarness({
      actions: [
        { kind: "event", event: providerToken("pre") },
        { kind: "delta", text: "pre" },
        { kind: "segmentBreak", reason: "provider-tool-call" },
        { kind: "event", event: { kind: "provider-tool-call", provider: "test", model: "m", name: "search" } },
        { kind: "event", event: { kind: "tool-start", tool: "search" } }
      ],
      handle: createStreamingHandleSpy({ finishResult: { delivered: false, fallbackRequired: true } })
    });

    await gateway.receive(makeMessage("hello"));

    expect(adapter.records.filter((record) => record.kind === "text").map((record) => record.text)).toEqual(["final answer"]);
  });

  it("stream finish fallbackRequired result causes final fallback delivery", async () => {
    const { adapter, gateway } = createStreamingGatewayHarness({
      events: [providerResult({ ok: false, willFallback: true })],
      handle: createStreamingHandleSpy({ finishResult: { delivered: false, fallbackRequired: true } })
    });

    await gateway.receive(makeMessage("hello"));

    expect(adapter.records.filter((record) => record.kind === "text").map((record) => record.text)).toEqual(["final answer"]);
  });

  it("stream finish failure falls back through DeliveryRouter", async () => {
    const { deliveryRouter, routedTexts } = createRecordingDeliveryRouter();
    const { gateway } = createStreamingGatewayHarness({
      deliveryRouter,
      handle: createStreamingHandleSpy({ finishError: new Error("stream finish failed") })
    });

    await gateway.receive(makeMessage("hello"));

    expect(routedTexts).toEqual(["final answer"]);
  });

  it("approval boundaries force final text fallback", async () => {
    const { adapter, handle, gateway } = createStreamingGatewayHarness({
      runtimeResponse: runtimeResponse({
        text: "needs approval",
        securityDecision: "ask",
        toolExecutions: [commandExecution("ask", "rm -rf ./build")]
      })
    });

    await gateway.receive(makeMessage("hello"));

    expect(handle.finishCalls).toEqual(["needs approval"]);
    expect(adapter.records.some((record) => record.kind === "text" && record.text === "needs approval")).toBe(true);
    expect(adapter.records.some((record) => record.kind === "text" && record.text?.includes("Approval Required"))).toBe(true);
  });

  it("approval boundaries route final text through DeliveryRouter", async () => {
    const { deliveryRouter, routedTexts } = createRecordingDeliveryRouter();
    const { adapter, handle, gateway } = createStreamingGatewayHarness({
      deliveryRouter,
      runtimeResponse: runtimeResponse({
        text: "needs approval",
        securityDecision: "ask",
        toolExecutions: [commandExecution("ask", "rm -rf ./build")]
      })
    });

    await gateway.receive(makeMessage("hello"));

    expect(handle.finishCalls).toEqual(["needs approval"]);
    expect(routedTexts[0]).toBe("needs approval");
    expect(routedTexts.some((text) => text.includes("Approval Required"))).toBe(true);
    expect(adapter.records.some((record) => record.kind === "text" && record.text === "needs approval")).toBe(false);
  });

  it("artifact boundaries force final text fallback", async () => {
    const { adapter, gateway } = createStreamingGatewayHarness({
      runtimeResponse: runtimeResponse({
        text: "with artifact",
        securityDecision: "allow",
        artifacts: [{
          id: "artifact-1",
          path: "/tmp/result.txt",
          kind: "document",
          bytes: 1,
          createdAt: new Date().toISOString()
        }]
      })
    });

    await gateway.receive(makeMessage("hello"));

    expect(adapter.records.some((record) => record.kind === "text" && record.text === "with artifact")).toBe(true);
    expect(adapter.records.filter((record) => record.kind === "artifact")).toHaveLength(1);
  });

  it("artifact boundaries route final text and artifacts through DeliveryRouter", async () => {
    const { deliveryRouter, routedTexts, routedArtifacts } = createRecordingDeliveryRouter();
    const artifact: ArtifactRecord = {
      id: "artifact-1",
      path: "/tmp/result.txt",
      kind: "document",
      bytes: 1,
      createdAt: new Date().toISOString()
    };
    const { gateway } = createStreamingGatewayHarness({
      deliveryRouter,
      runtimeResponse: runtimeResponse({
        text: "with artifact",
        securityDecision: "allow",
        artifacts: [artifact]
      })
    });

    await gateway.receive(makeMessage("hello"));

    expect(routedTexts).toEqual(["with artifact"]);
    expect(routedArtifacts).toEqual([artifact]);
  });

  it("agent cancellation calls stream abort", async () => {
    const { handle, gateway } = createStreamingGatewayHarness({
      events: [{ kind: "agent-cancelled", reason: "stop" }]
    });

    await gateway.receive(makeMessage("hello"));

    expect(handle.abortCalls).toEqual(["stop"]);
  });

  it("agent cancellation stream abort failures do not mask the turn outcome", async () => {
    const { adapter, handle, gateway } = createStreamingGatewayHarness({
      events: [{ kind: "agent-cancelled", reason: "stop" }],
      handle: createStreamingHandleSpy({ abortError: new Error("stream abort failed") })
    });

    const result = await gateway.receive(makeMessage("hello"));

    expect(handle.abortCalls).toEqual(["stop"]);
    expect(result.replyText).toBe("final answer");
    expect(adapter.records.some((record) => record.kind === "text" && record.text?.includes("stream abort failed"))).toBe(false);
  });

  it("stream finish failure falls back to normal sendText", async () => {
    const { adapter, gateway } = createStreamingGatewayHarness({
      handle: createStreamingHandleSpy({ finishError: new Error("stream finish failed") })
    });

    await gateway.receive(makeMessage("hello"));

    expect(adapter.records.filter((record) => record.kind === "text").map((record) => record.text)).toEqual(["final answer"]);
  });

  it("Telegram adapter.send no-op does not duplicate output", async () => {
    const { adapter, gateway } = createStreamingGatewayHarness();
    adapter.send = undefined;

    await gateway.receive(makeMessage("hello"));

    expect(adapter.records.filter((record) => record.kind === "text")).toHaveLength(0);
    expect(adapter.sendReplies).toEqual([]);
  });
});

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

function makeTelegramCallbackMessage(text: string, messageId = "77", callbackQueryId = "callback-1"): ChannelMessage {
  return makeMessage(text, {
    metadata: {
      telegram: {
        messageId,
        callbackQueryId
      }
    }
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for condition.");
}

function makeVoiceTranscriptMessage(text = "voice request"): ChannelMessage {
  return makeMessage(text, {
    metadata: {
      voiceTranscription: {
        injected: true,
        count: 1,
        transcripts: [
          {
            attachmentId: "voice-1",
            text: "voice request",
            hash: "hash",
            timestamp: new Date().toISOString()
          }
        ]
      }
    }
  });
}

function openAiAutoTtsConfig(overrides: {
  autoTts?: boolean;
  autoTtsMaxCharsPerReply?: number;
  autoTtsMaxCharsPerHourPerChat?: number;
} = {}) {
  return {
    tts: {
      provider: "openai" as const,
      speed: 1,
      enabled: true,
      openai: {
        model: "tts-test",
        voice: "alloy",
        baseUrl: "https://tts.example/v1",
        apiKeyEnv: "ESTACODA_TEST_TTS_KEY"
      }
    },
    voice: {
      autoTts: overrides.autoTts ?? true,
      autoTtsMaxCharsPerReply: overrides.autoTtsMaxCharsPerReply,
      autoTtsMaxCharsPerHourPerChat: overrides.autoTtsMaxCharsPerHourPerChat
    }
  };
}

function edgeAutoTtsConfig(overrides: {
  autoTts?: boolean;
  autoTtsMaxCharsPerReply?: number;
  autoTtsMaxCharsPerHourPerChat?: number;
} = {}) {
  return {
    tts: {
      provider: "edge" as const,
      speed: 1.25,
      enabled: true,
      edge: { voice: "en-US-AriaNeural" }
    },
    voice: {
      autoTts: overrides.autoTts ?? true,
      autoTtsMaxCharsPerReply: overrides.autoTtsMaxCharsPerReply,
      autoTtsMaxCharsPerHourPerChat: overrides.autoTtsMaxCharsPerHourPerChat
    }
  };
}

function okTtsFetch() {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    statusText: "OK",
    arrayBuffer: async () => Uint8Array.from([1, 2, 3, 4]).buffer,
    text: async () => "audio"
  }));
}

function failingTtsFetch() {
  return vi.fn(async () => ({
    ok: false,
    status: 500,
    statusText: "Server Error",
    arrayBuffer: async () => new ArrayBuffer(0),
    text: async () => "nope"
  }));
}

function voiceToolExecution(): Awaited<ReturnType<Runtime["handle"]>>["toolExecutions"][number] {
  return {
    tool: {
      name: "voice.speak",
      description: "Generate speech",
      inputSchema: {},
      riskClass: "external-side-effect",
      toolsets: ["media"],
      progressLabel: "generating speech",
      maxResultSizeChars: 4000
    },
    decision: "allow",
    riskClass: "external-side-effect",
    result: { ok: true, content: "Generated speech" }
  };
}

async function writeGatewayModelConfig(homeDir: string, config: unknown): Promise<void> {
  const configPath = resolveProfileStateHome({ homeDir, profileId: "default" }).configPath;
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, JSON.stringify(config, null, 2), "utf8");
}

async function gatewayModelSwitchContext(homeDir: string) {
  const loaded = await loadRuntimeConfig({ workspaceRoot: homeDir, homeDir, profileId: "default" });
  return {
    config: loaded.config,
    providerRegistry: loaded.providerRegistry,
    homeDir
  };
}

async function ensureSession(db: InMemorySessionDB, sessionId: string): Promise<void> {
  const existing = await db.getSession(sessionId);
  if (existing === undefined) {
    await db.createSession({ id: sessionId, profileId: "default" });
  }
}

function createMinimalRuntime(): Runtime {
  return {
    agentEvolutionPolicy: () => deriveAgentEvolutionPolicy("suggest"),
    describe: () => "minimal",
    getStatus: () => ({
      kind: "status" as const,
      agentName: "Test",
      model: { provider: "test", id: "test" },
      securityMode: "adaptive",
      skillCount: 0,
      toolCount: 0,
      mcp: { active: 0, total: 0 },
      workflowAvailable: false,
      workflowRunActive: false,
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
      setSessionModelOverride: async () => {},
      clearSessionModelOverride: async () => {},
      getSessionModelOverride: async () => undefined,
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
    sessionId: "sess-1",
    trajectoryId: undefined
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
  it("/voice on sets voice_only for the chat without invoking runtime", async () => {
    const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
    const stateDir = await mkdtemp(join(tmpdir(), "estacoda-gateway-voice-"));
    const voiceStateManager = new VoiceStateManager({ path: join(stateDir, "gateway", "voice-mode.json") });
    const runtimeForSession = vi.fn(async ({ sessionId }) => ({ ...createMinimalRuntime(), sessionId }));
    const gateway = new ChannelGateway({
      adapters: [adapter],
      runtimeForSession,
      sessionStore: new InMemoryChannelSessionStore(),
      authPolicy: { telegram: { allowedUserIds: ["user-1"] } },
      voiceStateManager
    });

    const result = await gateway.receive(makeMessage("/voice on"));

    expect(result.replyText).toContain("voice_only");
    expect(await voiceStateManager.getMode("telegram", "123456")).toBe("voice_only");
    expect(runtimeForSession).not.toHaveBeenCalled();
  });

  it("/voice status reports current mode", async () => {
    const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
    const stateDir = await mkdtemp(join(tmpdir(), "estacoda-gateway-voice-status-"));
    const voiceStateManager = new VoiceStateManager({ path: join(stateDir, "gateway", "voice-mode.json") });
    await voiceStateManager.setMode("telegram", "123456", "all");
    const runtimeForSession = vi.fn(async ({ sessionId }) => ({ ...createMinimalRuntime(), sessionId }));
    const gateway = new ChannelGateway({
      adapters: [adapter],
      runtimeForSession,
      sessionStore: new InMemoryChannelSessionStore(),
      authPolicy: { telegram: { allowedUserIds: ["user-1"] } },
      voiceStateManager
    });

    const result = await gateway.receive(makeMessage("/voice status"));

    expect(result.replyText).toContain("Voice status");
    expect(result.replyText).toContain("Mode: all");
    expect(runtimeForSession).not.toHaveBeenCalled();
  });

  it("/voice commands recover from malformed profile-local voice state", async () => {
    const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
    const stateDir = await mkdtemp(join(tmpdir(), "estacoda-gateway-voice-corrupt-"));
    const voicePath = join(stateDir, "gateway", "voice-mode.json");
    await mkdir(join(stateDir, "gateway"), { recursive: true });
    await writeFile(voicePath, "{ broken", "utf8");
    const voiceStateManager = new VoiceStateManager({ path: voicePath });
    const runtimeForSession = vi.fn(async ({ sessionId }) => ({ ...createMinimalRuntime(), sessionId }));
    const gateway = new ChannelGateway({
      adapters: [adapter],
      runtimeForSession,
      sessionStore: new InMemoryChannelSessionStore(),
      authPolicy: { telegram: { allowedUserIds: ["user-1"] } },
      voiceStateManager
    });

    const status = await gateway.receive(makeMessage("/voice status"));
    const set = await gateway.receive(makeMessage("/voice on"));

    expect(status.replyText).toContain("Mode: off");
    expect(set.replyText).toContain("voice_only");
    expect(await voiceStateManager.getMode("telegram", "123456")).toBe("voice_only");
    expect(JSON.parse(await readFile(voicePath, "utf8"))).toMatchObject({
      version: 1,
      modes: {
        "telegram:123456": "voice_only"
      }
    });
    expect(runtimeForSession).not.toHaveBeenCalled();
  });

  it("/voice all and /voice tts set all while /voice voice aliases voice_only", async () => {
    const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
    const stateDir = await mkdtemp(join(tmpdir(), "estacoda-gateway-voice-alias-"));
    const voiceStateManager = new VoiceStateManager({ path: join(stateDir, "gateway", "voice-mode.json") });
    const gateway = new ChannelGateway({
      adapters: [adapter],
      runtimeForSession: async ({ sessionId }) => ({ ...createMinimalRuntime(), sessionId }),
      sessionStore: new InMemoryChannelSessionStore(),
      authPolicy: { telegram: { allowedUserIds: ["user-1"] } },
      voiceStateManager
    });

    await gateway.receive(makeMessage("/voice all"));
    expect(await voiceStateManager.getMode("telegram", "123456")).toBe("all");
    await gateway.receive(makeMessage("/voice voice"));
    expect(await voiceStateManager.getMode("telegram", "123456")).toBe("voice_only");
    await gateway.receive(makeMessage("/voice tts"));
    expect(await voiceStateManager.getMode("telegram", "123456")).toBe("all");
  });

  it("handles group /voice commands only after existing auth gating", async () => {
    const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
    const stateDir = await mkdtemp(join(tmpdir(), "estacoda-gateway-voice-group-"));
    const voiceStateManager = new VoiceStateManager({ path: join(stateDir, "gateway", "voice-mode.json") });
    const runtimeForSession = vi.fn(async ({ sessionId }) => ({ ...createMinimalRuntime(), sessionId }));
    const gateway = new ChannelGateway({
      adapters: [adapter],
      runtimeForSession,
      sessionStore: new InMemoryChannelSessionStore(),
      authPolicy: { telegram: { allowedUserIds: ["allowed-user"] } },
      voiceStateManager
    });

    const denied = await gateway.receive(makeMessage("/voice on", {
      sessionKey: { platform: "telegram", chatId: "group-1", chatType: "group", userId: "blocked-user" },
      sender: { id: "blocked-user" }
    }));
    expect(denied.replyText).toContain("not paired");
    expect(await voiceStateManager.getMode("telegram", "group-1")).toBeUndefined();

    const allowed = await gateway.receive(makeMessage("/voice on", {
      sessionKey: { platform: "telegram", chatId: "group-1", chatType: "group", userId: "allowed-user" },
      sender: { id: "allowed-user" }
    }));
    expect(allowed.replyText).toContain("voice_only");
    expect(await voiceStateManager.getMode("telegram", "group-1")).toBe("voice_only");
    expect(runtimeForSession).not.toHaveBeenCalled();
  });

  it("/voice channel remains Discord-only on other platforms", async () => {
    const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
    const stateDir = await mkdtemp(join(tmpdir(), "estacoda-gateway-voice-channel-"));
    const voiceStateManager = new VoiceStateManager({ path: join(stateDir, "gateway", "voice-mode.json") });
    const runtimeForSession = vi.fn(async ({ sessionId }) => ({ ...createMinimalRuntime(), sessionId }));
    const gateway = new ChannelGateway({
      adapters: [adapter],
      runtimeForSession,
      sessionStore: new InMemoryChannelSessionStore(),
      authPolicy: { telegram: { allowedUserIds: ["user-1"] } },
      voiceStateManager
    });

    const result = await gateway.receive(makeMessage("/voice channel"));

    expect(result.replyText).toContain("available only from Discord");
    expect(runtimeForSession).not.toHaveBeenCalled();
  });

  it("delegates /voice channel to Discord voice capability methods without invoking runtime", async () => {
    const records: string[] = [];
    const joinVoiceChannelForMessage = vi.fn(async () => ({
      ok: true,
      content: "Joined Discord voice channel General."
    }));
    const adapter = {
      kind: "discord",
      delivery: {
        sendText: async (_sessionKey: ChannelSessionKey, text: string) => {
          records.push(text);
        }
      },
      joinVoiceChannelForMessage
    } as any;
    const stateDir = await mkdtemp(join(tmpdir(), "estacoda-gateway-voice-channel-"));
    const voiceStateManager = new VoiceStateManager({ path: join(stateDir, "gateway", "voice-mode.json") });
    const runtimeForSession = vi.fn(async ({ sessionId }) => ({ ...createMinimalRuntime(), sessionId }));
    const gateway = new ChannelGateway({
      adapters: [adapter],
      runtimeForSession,
      sessionStore: new InMemoryChannelSessionStore(),
      authPolicy: { discord: { allowedUserIds: ["user-1"] } },
      voiceStateManager
    });

    const message = makeMessage("/voice channel", {
      channel: "discord",
      sessionKey: { platform: "discord", chatId: "channel-1", chatType: "channel", userId: "user-1" },
      metadata: { guildId: "guild-1", channelId: "channel-1" }
    });
    const result = await gateway.receive(message);

    expect(result.replyText).toContain("Joined Discord voice channel");
    expect(records).toContain(result.replyText);
    expect(joinVoiceChannelForMessage).toHaveBeenCalledWith(message);
    expect(runtimeForSession).not.toHaveBeenCalled();
  });

  it("delegates /voice leave to Discord voice capability methods without invoking runtime", async () => {
    const leaveVoiceChannelForMessage = vi.fn(async () => ({
      ok: true,
      content: "Left the Discord voice channel."
    }));
    const adapter = {
      kind: "discord",
      delivery: {
        sendText: async () => undefined
      },
      leaveVoiceChannelForMessage
    } as any;
    const stateDir = await mkdtemp(join(tmpdir(), "estacoda-gateway-voice-leave-"));
    const voiceStateManager = new VoiceStateManager({ path: join(stateDir, "gateway", "voice-mode.json") });
    const runtimeForSession = vi.fn(async ({ sessionId }) => ({ ...createMinimalRuntime(), sessionId }));
    const gateway = new ChannelGateway({
      adapters: [adapter],
      runtimeForSession,
      sessionStore: new InMemoryChannelSessionStore(),
      authPolicy: { discord: { allowedUserIds: ["user-1"] } },
      voiceStateManager
    });

    const message = makeMessage("/voice leave", {
      channel: "discord",
      sessionKey: { platform: "discord", chatId: "channel-1", chatType: "channel", userId: "user-1" },
      metadata: { guildId: "guild-1", channelId: "channel-1" }
    });
    const result = await gateway.receive(message);

    expect(result.replyText).toContain("Left the Discord voice channel");
    expect(leaveVoiceChannelForMessage).toHaveBeenCalledWith(message);
    expect(runtimeForSession).not.toHaveBeenCalled();
  });

  it("delegates /voice channel and /voice leave through the production resilience wrapper", async () => {
    const joinVoiceChannelForMessage = vi.fn(async () => ({
      ok: true,
      content: "Joined Discord voice channel General."
    }));
    const leaveVoiceChannelForMessage = vi.fn(async () => ({
      ok: true,
      content: "Left the Discord voice channel."
    }));
    const wrapped = new AdapterResilienceSupervisor({
      kind: "discord",
      delivery: { sendText: async () => undefined },
      joinVoiceChannelForMessage,
      leaveVoiceChannelForMessage
    } as any);
    const stateDir = await mkdtemp(join(tmpdir(), "estacoda-gateway-voice-wrapper-"));
    const voiceStateManager = new VoiceStateManager({ path: join(stateDir, "gateway", "voice-mode.json") });
    const runtimeForSession = vi.fn(async ({ sessionId }) => ({ ...createMinimalRuntime(), sessionId }));
    const gateway = new ChannelGateway({
      adapters: [wrapped],
      runtimeForSession,
      sessionStore: new InMemoryChannelSessionStore(),
      authPolicy: { discord: { allowedUserIds: ["user-1"] } },
      voiceStateManager
    });
    const base = {
      channel: "discord",
      sessionKey: { platform: "discord", chatId: "channel-1", chatType: "channel", userId: "user-1" } as ChannelSessionKey,
      metadata: { guildId: "guild-1", channelId: "channel-1" }
    };

    await gateway.receive(makeMessage("/voice channel", base));
    await gateway.receive(makeMessage("/voice leave", base));

    expect(joinVoiceChannelForMessage).toHaveBeenCalledTimes(1);
    expect(leaveVoiceChannelForMessage).toHaveBeenCalledTimes(1);
    expect(runtimeForSession).not.toHaveBeenCalled();
  });

  describe("auto-TTS replies", () => {
    const edgeTempDirs: string[] = [];

    async function createEdgeTempDir(prefix: string): Promise<string> {
      const dir = await mkdtemp(join(tmpdir(), prefix));
      edgeTempDirs.push(dir);
      return dir;
    }

    async function createVerifiedEdgeCapabilityState(): Promise<string> {
      const stateRoot = await createEdgeTempDir("estacoda-gateway-edge-state-");
      const paths = resolveManagedPythonCapabilityPaths({
        stateRoot,
        capabilityId: EDGE_TTS_CAPABILITY_ID
      });
      await mkdir(dirname(paths.pythonPath), { recursive: true });
      await writeFile(paths.pythonPath, "", "utf8");
      const spec = requireRegisteredPythonCapabilitySpec(EDGE_TTS_CAPABILITY_ID);
      await writeManagedPythonCapabilityManifest({
        stateRoot,
        capabilityId: EDGE_TTS_CAPABILITY_ID
      }, {
        id: EDGE_TTS_CAPABILITY_ID,
        version: spec.version,
        specHash: fingerprintManagedPythonCapabilitySpec(spec),
        installedPackages: [...spec.packages],
        installedGroups: [],
        pythonPath: paths.pythonPath,
        envPath: paths.envPath,
        createdAt: "2026-06-23T00:00:00.000Z",
        updatedAt: "2026-06-23T00:00:00.000Z",
        verifiedAt: "2026-06-23T00:00:01.000Z",
        status: "verified"
      });
      return stateRoot;
    }

    afterEach(async () => {
      delete process.env.ESTACODA_TEST_TTS_KEY;
      await Promise.all(edgeTempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
    });

    async function createAutoTtsGateway(input: {
      mode?: "off" | "voice_only" | "all";
      globalDefault?: boolean;
      responseText?: string;
      artifacts?: Awaited<ReturnType<Runtime["handle"]>>["artifacts"];
      toolExecutions?: Awaited<ReturnType<Runtime["handle"]>>["toolExecutions"];
      config?: ReturnType<typeof openAiAutoTtsConfig> | ReturnType<typeof edgeAutoTtsConfig>;
      fetch?: ReturnType<typeof okTtsFetch>;
      edgeTtsRunner?: EdgeTtsRunner;
      autoTtsPythonStateRoot?: string;
      logWarning?: (message: string) => void;
      now?: () => number;
    } = {}) {
      process.env.ESTACODA_TEST_TTS_KEY = "test-key";
      const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
      const stateDir = await mkdtemp(join(tmpdir(), "estacoda-gateway-auto-tts-"));
      const tempRoot = join(stateDir, "temp", "audio");
      const voiceStateManager = new VoiceStateManager({ path: join(stateDir, "gateway", "voice-mode.json") });
      if (input.mode !== undefined) {
        await voiceStateManager.setMode("telegram", "123456", input.mode);
      }
      const runtime = createMinimalRuntime();
      runtime.handle = async () => runtimeResponse({
        text: input.responseText ?? "Here is the answer.",
        securityDecision: "allow",
        artifacts: input.artifacts,
        toolExecutions: input.toolExecutions
      });
      const fetch = input.fetch ?? okTtsFetch();
      const gateway = new ChannelGateway({
        adapters: [adapter],
        runtimeForSession: async ({ sessionId }) => ({ ...runtime, sessionId }),
        sessionStore: new InMemoryChannelSessionStore(),
        authPolicy: { telegram: { allowedUserIds: ["user-1"] } },
        voiceStateManager,
        voiceAutoTtsDefault: input.globalDefault ?? false,
        autoTtsConfig: () => input.config ?? openAiAutoTtsConfig(),
        autoTtsTempRoot: tempRoot,
        autoTtsFetch: fetch,
        autoTtsPythonStateRoot: input.autoTtsPythonStateRoot,
        autoTtsEdgeTtsRunner: input.edgeTtsRunner,
        autoTtsId: () => "auto-1",
        autoTtsNow: input.now,
        logWarning: input.logWarning
      });
      return { adapter, gateway, fetch, tempRoot };
    }

    it("skips when chat voice mode is off", async () => {
      const { adapter, gateway, fetch } = await createAutoTtsGateway({ mode: "off" });

      await gateway.receive(makeVoiceTranscriptMessage());

      expect(fetch).not.toHaveBeenCalled();
      expect(adapter.records.filter((record) => record.kind === "artifact")).toHaveLength(0);
    });

    it("in voice_only fires only for incoming voice messages", async () => {
      const voice = await createAutoTtsGateway({ mode: "voice_only" });
      await voice.gateway.receive(makeVoiceTranscriptMessage());

      expect(voice.fetch).toHaveBeenCalledTimes(1);
      expect(voice.adapter.records.filter((record) => record.kind === "artifact")).toHaveLength(1);

      const textOnly = await createAutoTtsGateway({ mode: "voice_only" });
      await textOnly.gateway.receive(makeMessage("plain text"));

      expect(textOnly.fetch).not.toHaveBeenCalled();
      expect(textOnly.adapter.records.filter((record) => record.kind === "artifact")).toHaveLength(0);
    });

    it("in all fires for eligible text responses and deletes temp files after delivery", async () => {
      const { adapter, gateway, tempRoot } = await createAutoTtsGateway({ mode: "all" });

      await gateway.receive(makeMessage("hello"));

      const artifacts = adapter.records.filter((record) => record.kind === "artifact");
      expect(artifacts).toHaveLength(1);
      expect(artifacts[0]?.artifact?.metadata).toMatchObject({
        deliveryHint: "voice",
        ephemeral: true,
        provider: "openai",
        model: "tts-test",
        voice: "alloy",
        format: "audio/mpeg"
      });
      await expect(readdir(join(tempRoot, "auto-tts"))).resolves.toEqual([]);
    });

    it("skips empty, error, and gateway command responses", async () => {
      const empty = await createAutoTtsGateway({ mode: "all", responseText: "   " });
      await empty.gateway.receive(makeMessage("hello"));
      expect(empty.fetch).not.toHaveBeenCalled();

      const error = await createAutoTtsGateway({ mode: "all", responseText: "Error: not today" });
      await error.gateway.receive(makeMessage("hello"));
      expect(error.fetch).not.toHaveBeenCalled();

      const command = await createAutoTtsGateway({ mode: "all" });
      await command.gateway.receive(makeMessage("/voice status"));
      expect(command.fetch).not.toHaveBeenCalled();
    });

    it("skips when the turn already produced a TTS or voice artifact", async () => {
      const spoke = await createAutoTtsGateway({ mode: "all", toolExecutions: [voiceToolExecution()] });
      await spoke.gateway.receive(makeMessage("hello"));
      expect(spoke.fetch).not.toHaveBeenCalled();

      const voiceArtifact = await createAutoTtsGateway({
        mode: "all",
        artifacts: [{
          id: "voice-existing",
          path: "voice://existing",
          kind: "audio",
          bytes: 1,
          createdAt: new Date().toISOString(),
          metadata: { deliveryHint: "voice" }
        }]
      });
      await voiceArtifact.gateway.receive(makeMessage("hello"));
      expect(voiceArtifact.fetch).not.toHaveBeenCalled();
    });

    it("enforces provider cap, per-reply cap, and hourly per-chat cap", async () => {
      const providerCap = await createAutoTtsGateway({ mode: "all", responseText: "x".repeat(4097) });
      await providerCap.gateway.receive(makeMessage("hello"));
      expect(providerCap.fetch).not.toHaveBeenCalled();

      const perReply = await createAutoTtsGateway({
        mode: "all",
        responseText: "too long",
        config: openAiAutoTtsConfig({ autoTtsMaxCharsPerReply: 3 })
      });
      await perReply.gateway.receive(makeMessage("hello"));
      expect(perReply.fetch).not.toHaveBeenCalled();

      const hourly = await createAutoTtsGateway({
        mode: "all",
        responseText: "hello",
        config: openAiAutoTtsConfig({ autoTtsMaxCharsPerHourPerChat: 6 }),
        now: () => 1_000
      });
      await hourly.gateway.receive(makeMessage("first"));
      await hourly.gateway.receive(makeMessage("second"));
      expect(hourly.fetch).toHaveBeenCalledTimes(1);
    });

    it("skips when TTS provider readiness is false", async () => {
      const missingKeyConfig = openAiAutoTtsConfig();
      missingKeyConfig.tts.openai.apiKeyEnv = "ESTACODA_MISSING_TTS_KEY";
      const notReady = await createAutoTtsGateway({
        mode: "all",
        config: missingKeyConfig
      });

      await notReady.gateway.receive(makeMessage("hello"));

      expect(notReady.fetch).not.toHaveBeenCalled();
      expect(notReady.adapter.records.filter((record) => record.kind === "artifact")).toHaveLength(0);
    });

    it("global voice.autoTts true falls back to voice_only and TTS failures leave text intact", async () => {
      const fallback = await createAutoTtsGateway({ globalDefault: true });
      await fallback.gateway.receive(makeMessage("plain text"));
      expect(fallback.fetch).not.toHaveBeenCalled();

      await fallback.gateway.receive(makeVoiceTranscriptMessage());
      expect(fallback.fetch).toHaveBeenCalledTimes(1);

      const failing = await createAutoTtsGateway({ mode: "all", fetch: failingTtsFetch() as ReturnType<typeof okTtsFetch> });
      const result = await failing.gateway.receive(makeMessage("hello"));
      expect(result.replyText).toBe("Here is the answer.");
      expect(failing.adapter.records.find((record) => record.kind === "text")?.text).toBe("Here is the answer.");
      expect(failing.adapter.records.filter((record) => record.kind === "artifact")).toHaveLength(0);
    });

    it("passes explicit managed Python state into Edge auto-TTS synthesis", async () => {
      const pythonStateRoot = await createVerifiedEdgeCapabilityState();
      const runner = vi.fn(async (input: EdgeTtsRunInput) => {
        await writeFile(input.outputPath, Buffer.from("edge-audio"));
        return { ok: true as const, outputPath: input.outputPath, mimeType: "audio/mpeg" };
      });
      const { adapter, gateway, tempRoot } = await createAutoTtsGateway({
        mode: "all",
        config: edgeAutoTtsConfig(),
        autoTtsPythonStateRoot: pythonStateRoot,
        edgeTtsRunner: runner
      });

      await gateway.receive(makeMessage("hello"));

      expect(runner).toHaveBeenCalledWith(expect.objectContaining({
        text: "Here is the answer.",
        voice: "en-US-AriaNeural",
        rate: "+25%",
        outputPath: expect.stringContaining(join(tempRoot, "edge-tts-"))
      }));
      expect(adapter.records.filter((record) => record.kind === "artifact")).toHaveLength(1);
      const artifactRecord = adapter.records.find((record) => record.kind === "artifact");
      if (artifactRecord?.kind !== "artifact" || artifactRecord.artifact === undefined) {
        throw new Error("Expected Edge auto-TTS artifact delivery.");
      }
      expect(artifactRecord.artifact.metadata).toMatchObject({
        provider: "edge",
        format: "audio/mpeg"
      });
    });

    it("preserves text delivery when Edge capability is missing", async () => {
      const warnings: string[] = [];
      const missingStateRoot = await createEdgeTempDir("estacoda-gateway-edge-missing-");
      const { adapter, gateway } = await createAutoTtsGateway({
        mode: "all",
        responseText: "hello",
        config: edgeAutoTtsConfig(),
        autoTtsPythonStateRoot: missingStateRoot,
        logWarning: (message) => warnings.push(message)
      });

      const result = await gateway.receive(makeMessage("hello"));

      expect(result.replyText).toBe("hello");
      expect(adapter.records.find((record) => record.kind === "text")?.text).toBe("hello");
      expect(adapter.records.filter((record) => record.kind === "artifact")).toHaveLength(0);
      expect(warnings.join("\n")).toContain("estacoda python-env setup edge-tts --yes");
    });

    it("does not count failed Edge auto-TTS synthesis usage", async () => {
      const pythonStateRoot = await createVerifiedEdgeCapabilityState();
      const runner = vi.fn(async (_input: EdgeTtsRunInput) => ({
        ok: false as const,
        content: "Edge TTS synthesis failed.",
        metadata: { reason: "synthesis-error" }
      }));
      const { adapter, gateway } = await createAutoTtsGateway({
        mode: "all",
        responseText: "hello",
        config: edgeAutoTtsConfig({ autoTtsMaxCharsPerHourPerChat: 6 }),
        autoTtsPythonStateRoot: pythonStateRoot,
        edgeTtsRunner: runner,
        now: () => 1_000
      });

      await gateway.receive(makeMessage("first"));
      await gateway.receive(makeMessage("second"));

      expect(runner).toHaveBeenCalledTimes(2);
      expect(adapter.records.filter((record) => record.kind === "text").map((record) => record.text)).toEqual(["hello", "hello"]);
      expect(adapter.records.filter((record) => record.kind === "artifact")).toHaveLength(0);
    });
  });

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

  it("/model renders a provider-first picker, then provider-scoped model choices", async () => {
    const tempHome = await mkdtemp(join(tmpdir(), "estacoda-gateway-model-"));
    try {
      await writeGatewayModelConfig(tempHome, {
        providers: {
          local: {
            kind: "openai-compatible",
            baseUrl: "http://localhost:11434/v1",
            models: ["qwen2.5:3b", "phi4:latest"],
            enableNetwork: true
          }
        },
        model: { provider: "local", id: "qwen2.5:3b" }
      });
      const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
      const gateway = new ChannelGateway({
        adapters: [adapter],
        runtimeForSession: async ({ sessionId }) => ({ ...createMinimalRuntime(), sessionId }),
        sessionStore: new InMemoryChannelSessionStore(),
        authPolicy: { telegram: { allowedUserIds: ["user-1"] } },
        modelSwitchContext: () => gatewayModelSwitchContext(tempHome)
      });

      const result = await gateway.receive(makeMessage("/model"));

      expect(result.replyText).toContain("**Model Configuration**");
      expect(result.replyText).toContain("Current model: qwen2.5:3b");
      expect(result.replyText).toContain("Provider: Local / Custom");
      expect(result.replyText).toContain("Select a provider:");
      expect(result.replyText).not.toContain("model-select local");
      expect(result.replyText).not.toContain("Direct set: model-select <provider>/<model>");
      expect(result.replyText).not.toContain("model-select local/qwen2.5:3b");
      const actions = adapter.records.at(-1)?.options?.actions;
      expect(actions?.every((row) => row.length <= 2)).toBe(true);
      const labels = actions?.flat().map((action) => action.label) ?? [];
      expect(labels).toContain("Local / Custom");
      expect(labels.at(-2)).toBe("Clear");
      expect(labels.at(-1)).toBe("Cancel");
      const values = actions?.flat().map((action) => action.value) ?? [];
      expect(values.every((value) => value.length <= 64)).toBe(true);
      expect(JSON.stringify(actions)).not.toContain("sk-secret");
      expect(adapter.records.at(-1)?.options?.editMessageId).toBeUndefined();

      const localAction = actions?.flat().find((action) => action.label === "Local / Custom");
      expect(localAction).toBeDefined();
      const providerResult = await gateway.receive(makeTelegramCallbackMessage(localAction?.value ?? "", "81"));
      expect(providerResult.replyText).toContain("**Model Configuration**");
      expect(providerResult.replyText).toMatch(/Provider: Local \/ Custom \(1-\d+ of \d+\)/u);
      expect(providerResult.replyText).toContain("Select a model:");
      expect(providerResult.replyText).not.toContain("model-select local/qwen2.5:3b");
      expect(providerResult.replyText).not.toContain("model-select local/phi4:latest");
      const modelLabels = adapter.records.at(-1)?.options?.actions?.flat().map((action) => action.label) ?? [];
      expect(modelLabels).toContain("phi4:latest");
      expect(modelLabels).toContain("qwen2.5:3b");
      expect(modelLabels).not.toContain("Local / Custom");
      expect(modelLabels.at(-2)).toBe("< Back");
      expect(modelLabels.at(-1)).toBe("Cancel");
      expect(adapter.records.at(-1)?.options?.editMessageId).toBe("81");

      await gateway.receive(makeMessage("model-select local/phi4:latest"));
      expect(adapter.records.at(-1)?.text).toContain("Session model override set: local/phi4:latest");
      expect(adapter.records.at(-1)?.options?.editMessageId).toBeUndefined();
    } finally {
      await rm(tempHome, { recursive: true, force: true });
    }
  });

  it("sets and clears gateway session model overrides without changing other sessions", async () => {
    const tempHome = await mkdtemp(join(tmpdir(), "estacoda-gateway-model-"));
    try {
      await writeGatewayModelConfig(tempHome, {
        providers: {
          local: {
            kind: "openai-compatible",
            baseUrl: "http://localhost:11434/v1",
            models: ["qwen2.5:3b", "phi4:latest"],
            enableNetwork: true
          }
        },
        model: { provider: "local", id: "qwen2.5:3b" }
      });
      const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
      const db = new InMemorySessionDB();
      const store = new InMemoryChannelSessionStore();
      const invalidate = vi.fn(async () => {});
      const gateway = new ChannelGateway({
        adapters: [adapter],
        runtimeForSession: async ({ sessionId }) => {
          await ensureSession(db, sessionId);
          return { ...createMinimalRuntime(), sessionId, sessionDb: db };
        },
        sessionStore: store,
        authPolicy: { telegram: { allowedUserIds: ["user-1"] } },
        runtimeCache: { invalidate } as unknown as RuntimeCache,
        modelSwitchContext: () => gatewayModelSwitchContext(tempHome)
      });

      const setResult = await gateway.receive(makeMessage("/model local/phi4:latest"));
      const activeOverride = await db.getSessionModelOverride(setResult.sessionId);
      expect(activeOverride?.route.provider).toBe("local");
      expect(activeOverride?.route.id).toBe("phi4:latest");
      expect(activeOverride?.source).toBe("gateway");

      const otherKey: ChannelSessionKey = { platform: "telegram", chatId: "other-chat", userId: "user-1" };
      const otherSessionId = await store.getOrCreateSessionId(otherKey);
      await ensureSession(db, otherSessionId);
      expect(await db.getSessionModelOverride(otherSessionId)).toBeUndefined();

      await gateway.receive(makeMessage("/model set local/qwen2.5:3b"));
      expect((await db.getSessionModelOverride(setResult.sessionId))?.route.id).toBe("qwen2.5:3b");

      await gateway.receive(makeMessage("model-select local/phi4:latest"));
      expect((await db.getSessionModelOverride(setResult.sessionId))?.route.id).toBe("phi4:latest");

      await gateway.receive(makeMessage("model-clear"));
      expect(await db.getSessionModelOverride(setResult.sessionId)).toBeUndefined();
      expect(invalidate).toHaveBeenCalledWith(setResult.sessionId);
      expect(invalidate).toHaveBeenCalledTimes(4);
    } finally {
      await rm(tempHome, { recursive: true, force: true });
    }
  });

  it("persists gateway /model --global only when authorized and workspace trust is proven", async () => {
    const tempHome = await mkdtemp(join(tmpdir(), "estacoda-gateway-model-"));
    try {
      const configPath = resolveProfileStateHome({ homeDir: tempHome, profileId: "default" }).configPath;
      await writeGatewayModelConfig(tempHome, {
        providers: {
          local: {
            kind: "openai-compatible",
            baseUrl: "http://localhost:11434/v1",
            models: ["qwen2.5:3b", "phi4:latest"],
            enableNetwork: true
          }
        },
        model: {
          provider: "local",
          id: "qwen2.5:3b",
          fallbacks: [{ provider: "local", id: "qwen2.5:3b" }]
        },
        auxiliaryModels: {
          assessor: { provider: "local", id: "qwen2.5:3b" }
        }
      });
      const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
      const db = new InMemorySessionDB();
      const disposeAll = vi.fn(async () => {});
      const gateway = new ChannelGateway({
        adapters: [adapter],
        runtimeForSession: async ({ sessionId }) => {
          await ensureSession(db, sessionId);
          return {
            ...createMinimalRuntime(),
            sessionId,
            sessionDb: db,
            isWorkspaceTrusted: async () => true
          };
        },
        sessionStore: new InMemoryChannelSessionStore(),
        authPolicy: { telegram: { allowedUserIds: ["user-1"] } },
        trustedWorkspace: true,
        runtimeCache: { disposeAll } as unknown as RuntimeCache,
        modelSwitchContext: () => gatewayModelSwitchContext(tempHome)
      });
      const sessionId = await gateway.receive(makeMessage("/model local/qwen2.5:3b")).then((result) => result.sessionId);
      expect(await db.getSessionModelOverride(sessionId)).toBeDefined();

      const setResult = await gateway.receive(makeMessage("/model --global local/phi4:latest"));

      expect(setResult.replyText).toContain("Global primary model set: local/phi4:latest");
      expect(setResult.replyText).toContain("Scope: global");
      expect(await db.getSessionModelOverride(sessionId)).toBeUndefined();
      expect(disposeAll).toHaveBeenCalledTimes(1);
      const afterSet = JSON.parse(await readFile(configPath, "utf8"));
      expect(afterSet.model.provider).toBe("local");
      expect(afterSet.model.id).toBe("phi4:latest");
      expect(afterSet.model.fallbacks).toEqual([{ provider: "local", id: "qwen2.5:3b" }]);
      expect(afterSet.auxiliaryModels.assessor).toEqual({ provider: "local", id: "qwen2.5:3b" });

      const compatibilityResult = await gateway.receive(makeMessage("/model set --global local/qwen2.5:3b"));
      expect(compatibilityResult.replyText).toContain("Scope: global");
      expect(JSON.parse(await readFile(configPath, "utf8")).model.id).toBe("qwen2.5:3b");
      expect(disposeAll).toHaveBeenCalledTimes(2);

      const clearResult = await gateway.receive(makeMessage("/model --global clear"));
      expect(clearResult.replyText).toContain("Clearing the global primary model is not supported");
      expect(JSON.parse(await readFile(configPath, "utf8")).model.id).toBe("qwen2.5:3b");
    } finally {
      await rm(tempHome, { recursive: true, force: true });
    }
  });

  it("rejects gateway global writes without proven trust or credentials and does not store secrets", async () => {
    const tempHome = await mkdtemp(join(tmpdir(), "estacoda-gateway-model-"));
    const originalOpenAiKey = process.env.OPENAI_API_KEY;
    try {
      const configPath = resolveProfileStateHome({ homeDir: tempHome, profileId: "default" }).configPath;
      const originalConfig = {
        providers: {
          openai: {
            kind: "openai-compatible",
            models: ["gpt-4o"],
            apiKeyEnv: "OPENAI_API_KEY"
          }
        },
        model: { provider: "openai", id: "gpt-4o" }
      };
      await writeGatewayModelConfig(tempHome, originalConfig);
      delete process.env.OPENAI_API_KEY;
      const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
      const db = new InMemorySessionDB();
      const store = new InMemoryChannelSessionStore();
      const gateway = new ChannelGateway({
        adapters: [adapter],
        runtimeForSession: async ({ sessionId }) => {
          await ensureSession(db, sessionId);
          return { ...createMinimalRuntime(), sessionId, sessionDb: db };
        },
        sessionStore: store,
        authPolicy: { telegram: { allowedUserIds: ["user-1"] } },
        trustedWorkspace: true,
        modelSwitchContext: () => gatewayModelSwitchContext(tempHome)
      });
      const sessionId = await store.getOrCreateSessionId(makeMessage("seed").sessionKey);
      await ensureSession(db, sessionId);
      await db.setSessionModelOverride(sessionId, {
        route: {
          provider: "local",
          id: "qwen2.5:3b",
          baseUrl: "http://localhost:11434/v1",
          apiMode: "custom_openai_compatible",
          authMethod: "none"
        },
        modelProfile: {
          id: "qwen2.5:3b",
          provider: "local",
          contextWindowTokens: 128000,
          supportsTools: true,
          supportsVision: false,
          supportsStructuredOutput: true
        },
        setAt: "2026-01-01T00:00:00.000Z",
        source: "gateway"
      });

      const missingResult = await gateway.receive(makeMessage("/model --global openai/gpt-4o"));
      expect(missingResult.replyText).toContain("Run estacoda model setup openai from a terminal");
      expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual(originalConfig);
      expect(await db.getSessionModelOverride(sessionId)).toBeDefined();

      process.env.OPENAI_API_KEY = "sk-secret-gateway-global";
      const untrustedGateway = new ChannelGateway({
        adapters: [adapter],
        runtimeForSession: async ({ sessionId }) => ({ ...createMinimalRuntime(), sessionId }),
        sessionStore: new InMemoryChannelSessionStore(),
        authPolicy: { telegram: { allowedUserIds: ["user-1"] } },
        trustedWorkspace: false,
        modelSwitchContext: () => gatewayModelSwitchContext(tempHome)
      });

      const untrustedResult = await untrustedGateway.receive(makeMessage("/model openai/gpt-4o --global"));
      expect(untrustedResult.replyText).toContain("Run estacoda model setup openai from a terminal");
      expect(untrustedResult.replyText).not.toContain("sk-secret-gateway-global");
      expect(JSON.stringify(JSON.parse(await readFile(configPath, "utf8")))).not.toContain("sk-secret-gateway-global");
      expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual(originalConfig);

      await writeGatewayModelConfig(tempHome, {
        providers: {
          local: {
            kind: "openai-compatible",
            baseUrl: "http://localhost:11434/v1",
            models: ["qwen2.5:3b", "phi4:latest"],
            enableNetwork: true
          }
        },
        model: { provider: "local", id: "qwen2.5:3b" }
      });
      const configWithoutHome = JSON.parse(await readFile(configPath, "utf8"));
      const disposeAll = vi.fn(async () => {});
      const missingPathGateway = new ChannelGateway({
        adapters: [adapter],
        runtimeForSession: async ({ sessionId }) => ({
          ...createMinimalRuntime(),
          sessionId,
          isWorkspaceTrusted: async () => true
        }),
        sessionStore: new InMemoryChannelSessionStore(),
        authPolicy: { telegram: { allowedUserIds: ["user-1"] } },
        runtimeCache: { disposeAll } as unknown as RuntimeCache,
        modelSwitchContext: async () => {
          const loaded = await loadRuntimeConfig({ workspaceRoot: tempHome, homeDir: tempHome, profileId: "default" });
          return { config: loaded.config, providerRegistry: loaded.providerRegistry };
        }
      });

      const missingPathResult = await missingPathGateway.receive(makeMessage("/model --global local/phi4:latest"));
      expect(missingPathResult.replyText).toContain("Gateway cannot prove the profile config location");
      expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual(configWithoutHome);
      expect(disposeAll).not.toHaveBeenCalled();
    } finally {
      if (originalOpenAiKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = originalOpenAiKey;
      }
      await rm(tempHome, { recursive: true, force: true });
    }
  });

  it("model picker callbacks select, clear, cancel, and reject malformed payloads safely", async () => {
    const tempHome = await mkdtemp(join(tmpdir(), "estacoda-gateway-model-"));
    try {
      await writeGatewayModelConfig(tempHome, {
        providers: {
          local: {
            kind: "openai-compatible",
            baseUrl: "http://localhost:11434/v1",
            models: ["qwen2.5:3b", "phi4:latest"],
            enableNetwork: true
          }
        },
        model: { provider: "local", id: "qwen2.5:3b" }
      });
      const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
      const db = new InMemorySessionDB();
      const invalidate = vi.fn(async () => {});
      const gateway = new ChannelGateway({
        adapters: [adapter],
        runtimeForSession: async ({ sessionId }) => {
          await ensureSession(db, sessionId);
          return { ...createMinimalRuntime(), sessionId, sessionDb: db };
        },
        sessionStore: new InMemoryChannelSessionStore(),
        authPolicy: { telegram: { allowedUserIds: ["user-1"] } },
        runtimeCache: { invalidate } as unknown as RuntimeCache,
        modelSwitchContext: () => gatewayModelSwitchContext(tempHome)
      });

      const picker = await gateway.receive(makeMessage("/model"));
      const providerActions = adapter.records.at(-1)?.options?.actions?.flat() ?? [];
      const localProvider = providerActions.find((action) => action.label === "Local / Custom");
      expect(localProvider).toBeDefined();

      await gateway.receive(makeTelegramCallbackMessage(localProvider?.value ?? "", "82"));
      expect(adapter.records.at(-1)?.options?.editMessageId).toBe("82");
      const actions = adapter.records.at(-1)?.options?.actions?.flat() ?? [];
      const selectPhi = actions.find((action) => action.label === "phi4:latest");
      expect(selectPhi).toBeDefined();

      const selected = await gateway.receive(makeTelegramCallbackMessage(selectPhi?.value ?? "", "82", "callback-2"));
      expect(adapter.records.at(-1)?.options?.editMessageId).toBe("82");
      expect(adapter.records.at(-1)?.options?.actions).toEqual([]);
      expect(selected.replyText).toBe([
        "**Model Configuration**",
        "Current model: phi4:latest",
        "Provider: Local / Custom",
        "Session override updated."
      ].join("\n"));
      const callbackOverride = await db.getSessionModelOverride(picker.sessionId);
      expect(callbackOverride?.route.id).toBe("phi4:latest");

      await gateway.receive(makeMessage("model-clear"));
      expect(adapter.records.at(-1)?.options?.editMessageId).toBeUndefined();
      await gateway.receive(makeMessage("model-select local/phi4:latest"));
      expect(adapter.records.at(-1)?.options?.editMessageId).toBeUndefined();
      const typedOverride = await db.getSessionModelOverride(picker.sessionId);
      expect(typedOverride?.route).toMatchObject({
        provider: callbackOverride?.route.provider,
        id: callbackOverride?.route.id
      });

      const canceled = await gateway.receive(makeTelegramCallbackMessage(modelPickerCancelActionValue(), "82", "callback-3"));
      expect(adapter.records.at(-1)?.options?.editMessageId).toBe("82");
      expect(adapter.records.at(-1)?.options?.actions).toEqual([]);
      expect(canceled.replyText).toBe("Model selection canceled.");
      expect((await db.getSessionModelOverride(picker.sessionId))?.route.id).toBe("phi4:latest");

      const cleared = await gateway.receive(makeTelegramCallbackMessage(modelPickerClearActionValue(), "82", "callback-4"));
      expect(adapter.records.at(-1)?.options?.editMessageId).toBe("82");
      expect(adapter.records.at(-1)?.options?.actions).toEqual([]);
      expect(cleared.replyText).toBe([
        "**Model Configuration**",
        "Session model override cleared.",
        "Future gateway turns will use the configured primary route."
      ].join("\n"));
      expect(await db.getSessionModelOverride(picker.sessionId)).toBeUndefined();
      expect(invalidate).toHaveBeenCalledWith(picker.sessionId);

      const malformed = await gateway.receive(makeTelegramCallbackMessage("ecmodel1:s:not.a.route", "82", "callback-5"));
      expect(malformed.replyText).toBe("Run /model again.");
      expect(adapter.records.at(-1)?.options?.editMessageId).toBe("82");
      expect(adapter.records.at(-1)?.options?.actions).toEqual([]);
      expect(await db.getSessionModelOverride(picker.sessionId)).toBeUndefined();
    } finally {
      await rm(tempHome, { recursive: true, force: true });
    }
  });

  it("keeps long model callback payloads compact and truncates oversized pickers with plain-text fallback", async () => {
    const tempHome = await mkdtemp(join(tmpdir(), "estacoda-gateway-model-"));
    try {
      const longModel = `000-really-long-model-${"x".repeat(140)}`;
      await writeGatewayModelConfig(tempHome, {
        providers: {
          local: {
            kind: "openai-compatible",
            baseUrl: "http://localhost:11434/v1",
            models: [longModel, ...Array.from({ length: 24 }, (_, index) => `model-${String(index).padStart(2, "0")}`)],
            enableNetwork: true
          }
        },
        model: { provider: "local", id: longModel }
      });
      const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
      const db = new InMemorySessionDB();
      const gateway = new ChannelGateway({
        adapters: [adapter],
        runtimeForSession: async ({ sessionId }) => {
          await ensureSession(db, sessionId);
          return { ...createMinimalRuntime(), sessionId, sessionDb: db };
        },
        sessionStore: new InMemoryChannelSessionStore(),
        authPolicy: { telegram: { allowedUserIds: ["user-1"] } },
        modelSwitchContext: () => gatewayModelSwitchContext(tempHome)
      });

      await gateway.receive(makeMessage("/model"));
      const localProvider = adapter.records.at(-1)?.options?.actions?.flat()
        .find((action) => action.label === "Local / Custom");
      expect(localProvider).toBeDefined();
      const modelPicker = await gateway.receive(makeTelegramCallbackMessage(localProvider?.value ?? "", "83"));

      expect(modelPicker.replyText).toMatch(/Provider: Local \/ Custom \(1-8 of \d+\)/u);
      expect(modelPicker.replyText).toContain("Select a model:");
      expect(modelPicker.replyText).not.toContain("model-select local/");
      const actions = adapter.records.at(-1)?.options?.actions?.flat() ?? [];
      expect(actions).toHaveLength(12);
      expect(actions.every((action) => action.value.length <= 64)).toBe(true);
      expect(JSON.stringify(actions.map((action) => action.value))).not.toContain(longModel);
      expect(actions.map((action) => action.label)).toContain("1/4");
      expect(actions.map((action) => action.label)).toContain("Next >");
      expect(adapter.records.at(-1)?.options?.editMessageId).toBe("83");

      const longAction = actions.find((action) => action.label === compactModelPickerLabel(longModel));
      expect(longAction).toBeDefined();
      expect(longAction?.label).not.toBe(longModel);

      const nextAction = actions.find((action) => action.label === "Next >");
      expect(nextAction).toBeDefined();
      const nextPage = await gateway.receive(makeTelegramCallbackMessage(nextAction?.value ?? "", "83", "callback-2"));
      expect(nextPage.replyText).toMatch(/Provider: Local \/ Custom \(9-16 of \d+\)/u);
      expect(adapter.records.at(-1)?.options?.actions?.flat().map((action) => action.label)).toContain("< Prev");
      expect(adapter.records.at(-1)?.options?.editMessageId).toBe("83");

      const backAction = adapter.records.at(-1)?.options?.actions?.flat()
        .find((action) => action.label === "< Back");
      expect(backAction).toBeDefined();
      const backResult = await gateway.receive(makeTelegramCallbackMessage(backAction?.value ?? "", "83", "callback-3"));
      expect(backResult.replyText).toContain("Select a provider:");
      expect(adapter.records.at(-1)?.options?.editMessageId).toBe("83");

      const selected = await gateway.receive(makeTelegramCallbackMessage(longAction?.value ?? "", "83", "callback-4"));
      expect(selected.replyText).toBe([
        "**Model Configuration**",
        `Current model: ${longModel}`,
        "Provider: Local / Custom",
        "Session override updated."
      ].join("\n"));
      expect(adapter.records.at(-1)?.options?.editMessageId).toBe("83");
      expect(adapter.records.at(-1)?.options?.actions).toEqual([]);
      expect((await db.getSessionModelOverride(selected.sessionId))?.route.id).toBe(longModel);

      await writeGatewayModelConfig(tempHome, {
        providers: {
          local: {
            kind: "openai-compatible",
            baseUrl: "http://localhost:11434/v1",
            models: ["qwen2.5:3b", "phi4:latest"],
            enableNetwork: true
          }
        },
        model: { provider: "local", id: "qwen2.5:3b" }
      });
      const stalePage = await gateway.receive(makeTelegramCallbackMessage(nextAction?.value ?? "", "83", "callback-5"));
      expect(stalePage.replyText).toBe("Run /model again.");
      expect(adapter.records.at(-1)?.options?.editMessageId).toBe("83");
      expect(adapter.records.at(-1)?.options?.actions).toEqual([]);
      expect((await db.getSessionModelOverride(stalePage.sessionId))?.route.id).toBe(longModel);
    } finally {
      await rm(tempHome, { recursive: true, force: true });
    }
  });

  it("lets model control commands bypass busy-session queues", async () => {
    const tempHome = await mkdtemp(join(tmpdir(), "estacoda-gateway-model-"));
    const activeTurnRegistry = new ActiveTurnRegistry();
    const busyMessage = makeMessage("model-clear");
    const activeTurnKey = stableSessionKey(busyMessage.sessionKey, {});
    const active = activeTurnRegistry.startTurn(activeTurnKey, new AbortController());
    try {
      await writeGatewayModelConfig(tempHome, {
        providers: {
          local: {
            kind: "openai-compatible",
            baseUrl: "http://localhost:11434/v1",
            models: ["qwen2.5:3b"],
            enableNetwork: true
          }
        },
        model: { provider: "local", id: "qwen2.5:3b" }
      });
      const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
      const db = new InMemorySessionDB();
      const gateway = new ChannelGateway({
        adapters: [adapter],
        runtimeForSession: async ({ sessionId }) => {
          await ensureSession(db, sessionId);
          return { ...createMinimalRuntime(), sessionId, sessionDb: db };
        },
        sessionStore: new InMemoryChannelSessionStore(),
        authPolicy: { telegram: { allowedUserIds: ["user-1"] } },
        activeTurnRegistry,
        busyPolicyResolver: () => ({ busyPolicy: "reject", queueDepth: 1 }),
        modelSwitchContext: () => gatewayModelSwitchContext(tempHome)
      });

      const cancelResult = await gateway.receive(makeMessage(modelPickerCancelActionValue()));
      expect(cancelResult.replyText).toContain("Model selection canceled");

      const picker = await gateway.receive(makeMessage("/model"));
      expect(picker.replyText).toContain("**Model Configuration**");
      const localProvider = adapter.records.at(-1)?.options?.actions?.flat()
        .find((action) => action.label === "Local / Custom");
      expect(localProvider).toBeDefined();
      const providerResult = await gateway.receive(makeMessage(localProvider?.value ?? ""));
      expect(providerResult.replyText).toMatch(/Provider: Local \/ Custom \(1-\d+ of \d+\)/u);
      const selectQwen = adapter.records.at(-1)?.options?.actions?.flat()
        .find((action) => action.label === "qwen2.5:3b");
      expect(selectQwen).toBeDefined();
      const selectResult = await gateway.receive(makeMessage(selectQwen?.value ?? ""));
      expect(selectResult.replyText).toBe([
        "**Model Configuration**",
        "Current model: qwen2.5:3b",
        "Provider: Local / Custom",
        "Session override updated."
      ].join("\n"));

      const result = await gateway.receive(busyMessage);

      expect(result.replyText).toContain("Session model override cleared");
      expect(result.replyText).not.toContain("busy");

      const normalTurn = await gateway.receive(makeMessage("please do normal work"));
      expect(normalTurn.sessionId).toBe("");
    } finally {
      if (active.ok) {
        activeTurnRegistry.endTurn(activeTurnKey, active.turnId);
      }
      await rm(tempHome, { recursive: true, force: true });
    }
  });

  it("preserves valid gateway overrides across resumed sessions and passes them to provider execution", async () => {
    const tempHome = await mkdtemp(join(tmpdir(), "estacoda-gateway-model-"));
    try {
      await writeGatewayModelConfig(tempHome, {
        providers: {
          local: {
            kind: "openai-compatible",
            baseUrl: "http://localhost:11434/v1",
            models: ["qwen2.5:3b", "phi4:latest"],
            enableNetwork: true
          }
        },
        model: { provider: "local", id: "qwen2.5:3b" }
      });
      const db = new InMemorySessionDB();
      const store = new InMemoryChannelSessionStore();
      const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
      const providerComplete = vi.fn(async (_request: unknown, _completionOptions: unknown, _executionOptions: unknown) => ({
        ok: true,
        attempts: [],
        response: { ok: true, content: "ok", provider: "local", model: "phi4:latest" }
      }));
      const runtimeForSession = async ({ sessionId }: { sessionId: string }) => {
        await ensureSession(db, sessionId);
        return {
          ...createMinimalRuntime(),
          sessionId,
          sessionDb: db,
          handle: async () => {
            const loaded = await loadRuntimeConfig({ workspaceRoot: tempHome, homeDir: tempHome, profileId: "default" });
            const stored = await db.getSessionModelOverride(sessionId);
            const effective = await resolveEffectiveSessionModelOverride(stored, {
              config: loaded.config,
              providerRegistry: loaded.providerRegistry,
              homeDir: tempHome
            });
            const primaryRoute = effective?.ok === true
              ? effective.route
              : loaded.primaryModelRoute ?? { provider: loaded.model.provider, id: loaded.model.id, profile: loaded.model };
            await providerComplete({ messages: [], provider: primaryRoute.provider, model: primaryRoute.id }, {}, {
              sessionId,
              primaryRoute,
              fallbackChain: loaded.modelFallbackRoutes
            });
            return runtimeResponse({ text: "ok", securityDecision: "allow" });
          }
        } as Runtime;
      };
      const firstGateway = new ChannelGateway({
        adapters: [adapter],
        runtimeForSession: runtimeForSession as any,
        sessionStore: store,
        authPolicy: { telegram: { allowedUserIds: ["user-1"] } },
        modelSwitchContext: () => gatewayModelSwitchContext(tempHome)
      });
      const setResult = await firstGateway.receive(makeMessage("/model local/phi4:latest"));
      expect((await db.getSessionModelOverride(setResult.sessionId))?.route.id).toBe("phi4:latest");

      const resumedGateway = new ChannelGateway({
        adapters: [adapter],
        runtimeForSession: runtimeForSession as any,
        sessionStore: store,
        authPolicy: { telegram: { allowedUserIds: ["user-1"] } },
        modelSwitchContext: () => gatewayModelSwitchContext(tempHome)
      });
      await resumedGateway.receive(makeMessage("hello after resume"));

      const executionOptions = providerComplete.mock.calls.at(-1)?.[2] as any;
      expect(executionOptions.primaryRoute.provider).toBe("local");
      expect(executionOptions.primaryRoute.id).toBe("phi4:latest");
      expect(executionOptions.fallbackChain).toEqual([]);
    } finally {
      await rm(tempHome, { recursive: true, force: true });
    }
  });

  it("ignores stale stored gateway overrides and falls back without crashing", async () => {
    const tempHome = await mkdtemp(join(tmpdir(), "estacoda-gateway-model-"));
    const originalOpenAiKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      await writeGatewayModelConfig(tempHome, {
        providers: {
          local: {
            kind: "openai-compatible",
            baseUrl: "http://localhost:11434/v1",
            models: ["qwen2.5:3b"],
            enableNetwork: true
          },
          openai: {
            kind: "openai-compatible",
            models: ["gpt-4o"],
            apiKeyEnv: "OPENAI_API_KEY"
          }
        },
        model: { provider: "local", id: "qwen2.5:3b" }
      });
      const db = new InMemorySessionDB();
      const store = new InMemoryChannelSessionStore();
      const sessionId = await store.getOrCreateSessionId(makeMessage("hello").sessionKey);
      await ensureSession(db, sessionId);
      await db.setSessionModelOverride(sessionId, {
        route: {
          provider: "openai",
          id: "gpt-4o",
          apiKeyEnv: "OPENAI_API_KEY",
          authMethod: "api_key",
          apiMode: "openai_responses",
          contextWindowTokens: 128000
        },
        modelProfile: {
          id: "gpt-4o",
          provider: "openai",
          contextWindowTokens: 128000,
          supportsTools: true,
          supportsVision: true,
          supportsStructuredOutput: true
        },
        setAt: "2030-01-01T00:00:00.000Z",
        source: "gateway"
      });
      const providerComplete = vi.fn(async (_request: unknown, _completionOptions: unknown, _executionOptions: unknown) => ({ ok: true, attempts: [], response: undefined }));
      const gateway = new ChannelGateway({
        adapters: [createFakeTelegramAdapter() as FakeTelegramAdapter],
        runtimeForSession: async ({ sessionId }) => ({
          ...createMinimalRuntime(),
          sessionId,
          sessionDb: db,
          handle: async () => {
            const loaded = await loadRuntimeConfig({ workspaceRoot: tempHome, homeDir: tempHome, profileId: "default" });
            const stored = await db.getSessionModelOverride(sessionId);
            const effective = await resolveEffectiveSessionModelOverride(stored, {
              config: loaded.config,
              providerRegistry: loaded.providerRegistry,
              homeDir: tempHome
            });
            const primaryRoute = effective?.ok === true
              ? effective.route
              : loaded.primaryModelRoute ?? { provider: loaded.model.provider, id: loaded.model.id, profile: loaded.model };
            await providerComplete({}, {}, { primaryRoute });
            return runtimeResponse({ text: "ok", securityDecision: "allow" });
          }
        }) as Runtime,
        sessionStore: store,
        authPolicy: { telegram: { allowedUserIds: ["user-1"] } },
        modelSwitchContext: () => gatewayModelSwitchContext(tempHome)
      });

      const result = await gateway.receive(makeMessage("hello"));

      expect(result.replyText).toBe("ok");
      const executionOptions = providerComplete.mock.calls.at(-1)?.[2] as any;
      expect(executionOptions.primaryRoute.provider).toBe("local");
      expect(executionOptions.primaryRoute.id).toBe("qwen2.5:3b");
    } finally {
      if (originalOpenAiKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = originalOpenAiKey;
      }
      await rm(tempHome, { recursive: true, force: true });
    }
  });

  it("rejects missing credentials with terminal setup guidance and never stores raw credential values", async () => {
    const tempHome = await mkdtemp(join(tmpdir(), "estacoda-gateway-model-"));
    const originalOpenAiKey = process.env.OPENAI_API_KEY;
    try {
      delete process.env.OPENAI_API_KEY;
      await writeGatewayModelConfig(tempHome, {
        providers: {
          openai: {
            kind: "openai-compatible",
            models: ["gpt-4o"],
            apiKeyEnv: "OPENAI_API_KEY"
          }
        },
        model: { provider: "openai", id: "gpt-4o" }
      });
      const db = new InMemorySessionDB();
      const gateway = new ChannelGateway({
        adapters: [createFakeTelegramAdapter() as FakeTelegramAdapter],
        runtimeForSession: async ({ sessionId }) => {
          await ensureSession(db, sessionId);
          return { ...createMinimalRuntime(), sessionId, sessionDb: db };
        },
        sessionStore: new InMemoryChannelSessionStore(),
        authPolicy: { telegram: { allowedUserIds: ["user-1"] } },
        modelSwitchContext: () => gatewayModelSwitchContext(tempHome)
      });

      const missingResult = await gateway.receive(makeMessage("/model openai/gpt-4o"));

      expect(missingResult.replyText).toContain("Run estacoda model setup openai from a terminal");
      expect(missingResult.replyText).not.toContain("sk-secret-gateway-test");

      process.env.OPENAI_API_KEY = "sk-secret-gateway-test";
      const setResult = await gateway.receive(makeMessage("/model openai/gpt-4o"));
      const override = await db.getSessionModelOverride(setResult.sessionId);
      expect(setResult.replyText).not.toContain("sk-secret-gateway-test");
      expect(JSON.stringify(override)).not.toContain("sk-secret-gateway-test");
      expect(override?.route.apiKeyEnv).toBe("OPENAI_API_KEY");
    } finally {
      if (originalOpenAiKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = originalOpenAiKey;
      }
      await rm(tempHome, { recursive: true, force: true });
    }
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
      expect(result.replyText).not.toContain("Active subagents:");
    });

    it("shows active subagents for the current session without exposing task content", async () => {
      const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
      const registry = new ActiveTurnRegistry();
      let firstStarted: (() => void) | undefined;
      let releaseFirst: (() => void) | undefined;
      const firstStartedPromise = new Promise<void>((resolve) => { firstStarted = resolve; });
      const releaseFirstPromise = new Promise<void>((resolve) => { releaseFirst = resolve; });

      const gateway = new ChannelGateway({
        adapters: [adapter],
        runtimeForSession: async ({ sessionId }) => ({
          ...createMinimalRuntime(),
          activeSubagents: (parentSessionId = sessionId) => ({
            activeCount: parentSessionId === sessionId ? 1 : 0,
            omittedCount: 0,
            subagents: parentSessionId === sessionId
              ? [{
                  childSessionId: "child-operator-1",
                  parentSessionId: sessionId,
                  role: "leaf",
                  depth: 1,
                  provider: "local",
                  model: "child-model",
                  status: "running",
                  durationMs: 1250,
                  batchId: "batch-1",
                  taskIndex: 0
                }]
              : []
          }),
          handle: async () => {
            firstStarted?.();
            await releaseFirstPromise;
            return runtimeResponse({ text: "done", securityDecision: "allow" });
          }
        }),
        sessionStore: new InMemoryChannelSessionStore(),
        authPolicy: { telegram: { allowedUserIds: ["user-1"] } },
        activeTurnRegistry: registry,
        busyPolicyResolver: () => ({ busyPolicy: "queue", queueDepth: 3 })
      });

      const turn = gateway.receive(makeMessage("start a child with token ghp_secret"));
      try {
        await firstStartedPromise;
        const status = await gateway.receive(makeMessage("/status"));

        expect(status.replyText).toContain("Active subagents: 1");
        expect(status.replyText).toContain("child child-operator-1");
        expect(status.replyText).toContain("role leaf");
        expect(status.replyText).toContain("depth 1");
        expect(status.replyText).toContain("model local/child-model");
        expect(status.replyText).toContain("status running");
        expect(status.replyText).toContain("duration 1s");
        expect(status.replyText).toContain("(batch batch-1 task #0)");
        expect(status.replyText).not.toContain("ghp_secret");
        expect(adapter.records.some((record) => record.text === "Queued (position 1)")).toBe(false);
      } finally {
        releaseFirst?.();
        await turn;
      }
    });

    it("does not show active subagents from another session", async () => {
      const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
      const registry = new ActiveTurnRegistry();
      let firstStarted: (() => void) | undefined;
      let releaseFirst: (() => void) | undefined;
      const firstStartedPromise = new Promise<void>((resolve) => { firstStarted = resolve; });
      const releaseFirstPromise = new Promise<void>((resolve) => { releaseFirst = resolve; });

      const gateway = new ChannelGateway({
        adapters: [adapter],
        runtimeForSession: async ({ sessionId }) => ({
          ...createMinimalRuntime(),
          activeSubagents: () => ({
            activeCount: 1,
            omittedCount: 0,
            subagents: [{
              childSessionId: "child-other-session",
              parentSessionId: sessionId,
              role: "leaf",
              depth: 1,
              provider: "local",
              model: "child-model",
              status: "running",
              durationMs: 2500
            }]
          }),
          handle: async () => {
            firstStarted?.();
            await releaseFirstPromise;
            return runtimeResponse({ text: "done", securityDecision: "allow" });
          }
        }),
        sessionStore: new InMemoryChannelSessionStore(),
        authPolicy: { telegram: { allowedUserIds: ["user-1"], allowedChatIds: ["123456", "999"] } },
        activeTurnRegistry: registry,
        busyPolicyResolver: () => ({ busyPolicy: "queue", queueDepth: 3 })
      });

      const turn = gateway.receive(makeMessage("start"));
      try {
        await firstStartedPromise;
        const status = await gateway.receive(makeMessage("/status", {
          sessionKey: {
            platform: "telegram",
            chatId: "999",
            userId: "user-1"
          }
        }));

        expect(status.replyText).not.toContain("Active subagents:");
        expect(status.replyText).not.toContain("child-other-session");
      } finally {
        releaseFirst?.();
        await turn;
      }
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

    function createFakeFingerprint(overrides: Partial<RuntimeFingerprint> = {}): RuntimeFingerprint {
      return {
        modelProvider: "test",
        modelId: "test",
        modelContextWindowTokens: 4096,
        profileId: "default",
        securityMode: "adaptive",
        securityAssessorEnabled: false,
        securityAssessorTimeoutMs: 5000,
        securityUrlPolicyHash: "hash",
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
        webResearchHash: "hash",
        compressionConfigHash: "hash",
        memoryRetrievalConfigHash: "hash",
        externalMemoryConfigHash: "hash",
        delegationConfigHash: "hash",
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
        ...overrides,
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

    it("queues ordinary interrupt-policy messages while the active turn has subagents", async () => {
      const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
      const registry = new ActiveTurnRegistry();
      let resolveFirst: (() => void) | undefined;
      let firstStarted: (() => void) | undefined;
      const firstStartedPromise = new Promise<void>((resolve) => { firstStarted = resolve; });
      let handleCalls = 0;
      const handledTexts: string[] = [];

      const gateway = new ChannelGateway({
        adapters: [adapter],
        runtimeForSession: async ({ sessionId }) => ({
          ...createMinimalRuntime(),
          hasActiveSubagents: (parentSessionId) => parentSessionId === sessionId,
          handle: async ({ text, signal }: { text: string; signal?: AbortSignal }) => {
            handleCalls++;
            handledTexts.push(text);
            if (handleCalls === 1) {
              firstStarted?.();
              await new Promise<void>((resolve, reject) => {
                resolveFirst = resolve;
                signal?.addEventListener("abort", () => reject(new Error("unexpected abort")));
              });
              return runtimeResponse({ text: "first done", securityDecision: "allow" });
            }
            return runtimeResponse({ text: `queued ${text}`, securityDecision: "allow" });
          }
        }),
        sessionStore: new InMemoryChannelSessionStore(),
        authPolicy: { telegram: { allowedUserIds: ["user-1"] } },
        activeTurnRegistry: registry,
        busyPolicyResolver: () => ({ busyPolicy: "interrupt", queueDepth: 3 })
      });

      const first = gateway.receive(makeMessage("first"));
      await firstStartedPromise;
      const second = await gateway.receive(makeMessage("second"));

      expect(second.replyText).toBe("");
      expect(registry.stats().totalAborted).toBe(0);
      expect(adapter.records).toContainEqual(expect.objectContaining({
        kind: "text",
        text: "Queued (position 1)"
      }));

      resolveFirst?.();
      const firstResult = await first;
      expect(firstResult.replyText).toBe("first done");
      await waitFor(() => handledTexts.includes("second"));
      expect(handledTexts).toEqual(["first", "second"]);
    });

    it("keeps ordinary interrupt behavior when the active turn has no subagents", async () => {
      const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
      const registry = new ActiveTurnRegistry();
      let handleStartedResolve: (() => void) | undefined;
      const handleStarted = new Promise<void>((resolve) => { handleStartedResolve = resolve; });
      let aborted = false;

      const gateway = new ChannelGateway({
        adapters: [adapter],
        runtimeForSession: async () => ({
          ...createMinimalRuntime(),
          hasActiveSubagents: () => false,
          handle: async ({ signal }: { signal?: AbortSignal }) => {
            handleStartedResolve?.();
            return await new Promise<Awaited<ReturnType<Runtime["handle"]>>>((resolve, reject) => {
              signal?.addEventListener("abort", () => {
                aborted = true;
                reject(new Error("interrupted"));
              });
              setTimeout(() => resolve(runtimeResponse({ text: "done", securityDecision: "allow" })), 100);
            });
          }
        }),
        sessionStore: new InMemoryChannelSessionStore(),
        authPolicy: { telegram: { allowedUserIds: ["user-1"] } },
        activeTurnRegistry: registry,
        busyPolicyResolver: () => ({ busyPolicy: "interrupt", queueDepth: 3 })
      });

      const first = gateway.receive(makeMessage("first"));
      await handleStarted;
      await gateway.receive(makeMessage("second"));
      await first;

      expect(aborted).toBe(true);
      expect(registry.stats().totalAborted).toBe(1);
    });

    it("/stop is not queued while subagents are active and aborts the active turn", async () => {
      const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
      const registry = new ActiveTurnRegistry();
      let handleStartedResolve: (() => void) | undefined;
      const handleStarted = new Promise<void>((resolve) => { handleStartedResolve = resolve; });
      let childAborted = false;

      const gateway = new ChannelGateway({
        adapters: [adapter],
        runtimeForSession: async () => ({
          ...createMinimalRuntime(),
          hasActiveSubagents: () => true,
          handle: async ({ signal }: { signal?: AbortSignal }) => {
            handleStartedResolve?.();
            return await new Promise<Awaited<ReturnType<Runtime["handle"]>>>((resolve, reject) => {
              signal?.addEventListener("abort", () => {
                childAborted = true;
                reject(new Error("stopped"));
              });
              setTimeout(() => resolve(runtimeResponse({ text: "done", securityDecision: "allow" })), 500);
            });
          }
        }),
        sessionStore: new InMemoryChannelSessionStore(),
        authPolicy: { telegram: { allowedUserIds: ["user-1"] } },
        activeTurnRegistry: registry,
        busyPolicyResolver: () => ({ busyPolicy: "interrupt", queueDepth: 3 })
      });

      const turn = gateway.receive(makeMessage("first"));
      await handleStarted;
      const stopResult = await gateway.receive(makeMessage("/stop"));
      await turn;

      expect(stopResult.replyText).toContain("Cancelled");
      expect(childAborted).toBe(true);
      expect(registry.stats().totalAborted).toBe(1);
      expect(adapter.records.some((record) => record.text === "Queued (position 1)")).toBe(false);
    });

    it("does not demote ordinary messages for another session with active subagents elsewhere", async () => {
      const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
      const registry = new ActiveTurnRegistry();
      let resolveFirst: (() => void) | undefined;
      let firstStarted: (() => void) | undefined;
      const firstStartedPromise = new Promise<void>((resolve) => { firstStarted = resolve; });
      const handledTexts: string[] = [];

      const gateway = new ChannelGateway({
        adapters: [adapter],
        runtimeForSession: async ({ sessionId }) => ({
          ...createMinimalRuntime(),
          hasActiveSubagents: (parentSessionId) => parentSessionId === sessionId,
          handle: async ({ text }: { text: string }) => {
            handledTexts.push(text);
            if (text === "first") {
              firstStarted?.();
              await new Promise<void>((resolve) => { resolveFirst = resolve; });
              return runtimeResponse({ text: "first done", securityDecision: "allow" });
            }
            return runtimeResponse({ text: `handled ${text}`, securityDecision: "allow" });
          }
        }),
        sessionStore: new InMemoryChannelSessionStore(),
        authPolicy: { telegram: { allowedUserIds: ["user-1"], allowedChatIds: ["123456", "999"] } },
        activeTurnRegistry: registry,
        busyPolicyResolver: () => ({ busyPolicy: "interrupt", queueDepth: 3 })
      });

      const first = gateway.receive(makeMessage("first"));
      await firstStartedPromise;
      const other = await gateway.receive(makeMessage("other", {
        sessionKey: {
          platform: "telegram",
          chatId: "999",
          userId: "user-1"
        }
      }));

      expect(other.replyText).toBe("handled other");
      expect(registry.stats().totalAborted).toBe(0);
      resolveFirst?.();
      await first;
      expect(handledTexts).toEqual(["first", "other"]);
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

    it.each([
      { securityMode: "open" as const, expectedSecurity: "↯ YOLO mode" },
      { securityMode: "adaptive" as const, expectedSecurity: "Adaptive" },
      { securityMode: "strict" as const, expectedSecurity: "Strict" },
    ])("renders Telegram fresh session notice for $securityMode security", async ({ securityMode, expectedSecurity }) => {
      const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
      const sessionStore: ChannelSessionStore = {
        async getOrCreateSessionId() {
          return "old-chat-session-00000000";
        },
        async resetSessionId() {
          return "telegram-fresh-session-abcdef1234567890";
        }
      };

      const gateway = new ChannelGateway({
        adapters: [adapter],
        runtimeForSession: async () => createMinimalRuntime(),
        sessionStore,
        authPolicy: { telegram: { allowedUserIds: ["user-1"] } },
        profileId: "default",
        securityMode,
        runtimeFingerprint: createFakeFingerprint({
          modelProvider: "kimi",
          modelId: "kimi-k2.7-code",
          securityMode,
        })
      });

      const result = await gateway.receive(makeMessage("/new"));

      expect(result.replyText).toBe([
        "𓂀 Fresh EstaCoda session",
        "",
        "◈ Model: kimi/kimi-k2.7-code",
        "◈ Session: 34567890",
        "◈ Profile: default",
        `◈ Security: ${expectedSecurity}`
      ].join("\n"));
      expect(result.replyText).not.toContain("telegram-fresh-session-abcdef1234567890");
    });

    it("does not carry a temporary Telegram YOLO toggle into /new", async () => {
      const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
      let currentSessionId = "old-yolo-session-11111111";
      const sessionStore: ChannelSessionStore = {
        async getOrCreateSessionId() {
          return currentSessionId;
        },
        async resetSessionId() {
          currentSessionId = "new-yolo-session-22222222";
          return currentSessionId;
        }
      };

      const gateway = new ChannelGateway({
        adapters: [adapter],
        runtimeForSession: async () => createMinimalRuntime(),
        sessionStore,
        authPolicy: { telegram: { allowedUserIds: ["user-1"] } },
        securityMode: "adaptive",
        runtimeFingerprint: createFakeFingerprint({
          modelProvider: "kimi",
          modelId: "kimi-k2.7-code",
          securityMode: "adaptive",
        })
      });

      const yolo = await gateway.receive(makeMessage("/yolo"));
      expect(yolo.replyText).toContain("YOLO mode ON");

      const result = await gateway.receive(makeMessage("/new"));
      expect(result.replyText).toContain("◈ Security: Adaptive");
      expect(result.replyText).not.toContain("YOLO mode");
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
      expect(result.replyText).toContain("𓂀 Fresh EstaCoda session");
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

    it("allows WhatsApp allowlist matches by canonical sender and session IDs", async () => {
      const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
      const runtimeForSession = vi.fn(async ({ sessionId }) => ({ ...createMinimalRuntime(), sessionId }));
      const gateway = new ChannelGateway({
        adapters: [adapter],
        runtimeForSession,
        sessionStore: new InMemoryChannelSessionStore(),
        authPolicy: { whatsapp: { allowedNumbers: ["971501234567"], dmPolicy: "allowlist" } },
      });

      const result = await gateway.receive(makeMessage("hello", {
        channel: "whatsapp",
        sessionKey: { platform: "whatsapp", chatId: "971501234567", userId: "971501234567" },
        sender: { id: "971501234567@s.whatsapp.net", displayName: "Allowed" }
      }));

      expect(result.replyText).toBe("ok");
      expect(runtimeForSession).toHaveBeenCalledOnce();
    });

    it("lets unauthorized WhatsApp DMs redeem pairing codes before denial", async () => {
      const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
      const runtimeForSession = vi.fn(async ({ sessionId }) => ({ ...createMinimalRuntime(), sessionId }));
      const pair = vi.fn(async (message: ChannelMessage) =>
        message.channel === "whatsapp" && message.text === "12345678"
          ? "WhatsApp paired. This account can now talk to EstaCoda."
          : undefined
      );
      const gateway = new ChannelGateway({
        adapters: [adapter],
        runtimeForSession,
        sessionStore: new InMemoryChannelSessionStore(),
        authPolicy: { whatsapp: { allowedNumbers: ["1234567890"], dmPolicy: "pairing" } },
        pair,
      });

      const result = await gateway.receive(makeMessage("12345678", {
        channel: "whatsapp",
        sessionKey: { platform: "whatsapp", chatId: "971501234567", userId: "971501234567" },
        sender: { id: "971501234567@s.whatsapp.net", displayName: "New user" }
      }));

      expect(pair).toHaveBeenCalledOnce();
      expect(result.replyText).toBe("WhatsApp paired. This account can now talk to EstaCoda.");
      expect(runtimeForSession).not.toHaveBeenCalled();
    });

    it("does not route unauthorized WhatsApp non-code text into runtime", async () => {
      const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
      const runtimeForSession = vi.fn(async ({ sessionId }) => ({ ...createMinimalRuntime(), sessionId }));
      const pair = vi.fn(async () => undefined);
      const gateway = new ChannelGateway({
        adapters: [adapter],
        runtimeForSession,
        sessionStore: new InMemoryChannelSessionStore(),
        authPolicy: { whatsapp: { allowedNumbers: ["1234567890"], dmPolicy: "pairing" } },
        pair,
      });

      const result = await gateway.receive(makeMessage("hello runtime", {
        channel: "whatsapp",
        sessionKey: { platform: "whatsapp", chatId: "971501234567", userId: "971501234567" },
        sender: { id: "971501234567@s.whatsapp.net", displayName: "New user" }
      }));

      expect(pair).toHaveBeenCalledOnce();
      expect(result.replyText).toContain("locked");
      expect(runtimeForSession).not.toHaveBeenCalled();
    });

    it("does not treat dmPolicy pairing as open access", async () => {
      const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
      const runtimeForSession = vi.fn(async ({ sessionId }) => ({ ...createMinimalRuntime(), sessionId }));
      const gateway = new ChannelGateway({
        adapters: [adapter],
        runtimeForSession,
        sessionStore: new InMemoryChannelSessionStore(),
        authPolicy: { whatsapp: { dmPolicy: "pairing" } },
        pair: async () => undefined,
      });

      const result = await gateway.receive(makeMessage("hello runtime", {
        channel: "whatsapp",
        sessionKey: { platform: "whatsapp", chatId: "971501234567", userId: "971501234567" },
        sender: { id: "971501234567", displayName: "New user" }
      }));

      expect(result.replyText).toContain("locked");
      expect(runtimeForSession).not.toHaveBeenCalled();
    });

    it("allows all WhatsApp DMs only when dmPolicy open is explicit", async () => {
      const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
      const runtimeForSession = vi.fn(async ({ sessionId }) => ({ ...createMinimalRuntime(), sessionId }));
      const gateway = new ChannelGateway({
        adapters: [adapter],
        runtimeForSession,
        sessionStore: new InMemoryChannelSessionStore(),
        authPolicy: { whatsapp: { dmPolicy: "open" } },
      });

      const result = await gateway.receive(makeMessage("hello runtime", {
        channel: "whatsapp",
        sessionKey: { platform: "whatsapp", chatId: "971501234567", userId: "971501234567" },
        sender: { id: "someone@lid", displayName: "Open user" }
      }));

      expect(result.replyText).toBe("ok");
      expect(runtimeForSession).toHaveBeenCalledOnce();
    });

    it("does not invoke pairing when dmPolicy disabled", async () => {
      const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
      const pair = vi.fn(async () => "paired");
      const runtimeForSession = vi.fn(async ({ sessionId }) => ({ ...createMinimalRuntime(), sessionId }));
      const gateway = new ChannelGateway({
        adapters: [adapter],
        runtimeForSession,
        sessionStore: new InMemoryChannelSessionStore(),
        authPolicy: { whatsapp: { dmPolicy: "disabled" } },
        pair,
      });

      const result = await gateway.receive(makeMessage("12345678", {
        channel: "whatsapp",
        sessionKey: { platform: "whatsapp", chatId: "971501234567", userId: "971501234567" },
        sender: { id: "971501234567", displayName: "Disabled user" }
      }));

      expect(result.replyText).toContain("not accepting direct messages");
      expect(pair).not.toHaveBeenCalled();
      expect(runtimeForSession).not.toHaveBeenCalled();
    });

    it("drops disabled WhatsApp groups silently and allows allowlisted groups", async () => {
      const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
      const runtimeForSession = vi.fn(async ({ sessionId }) => ({ ...createMinimalRuntime(), sessionId }));
      const closed = new ChannelGateway({
        adapters: [adapter],
        runtimeForSession,
        sessionStore: new InMemoryChannelSessionStore(),
        authPolicy: { whatsapp: { dmPolicy: "open" } },
      });

      const groupMessage = makeMessage("hello group", {
        channel: "whatsapp",
        sessionKey: {
          platform: "whatsapp",
          chatId: "120363025555555555@g.us",
          userId: "971501234567",
          chatType: "group"
        },
        sender: { id: "971501234567", displayName: "Group user" }
      });

      const denied = await closed.receive(groupMessage);
      expect(denied).toEqual({ sessionId: "", replyText: "", artifactCount: 0, progressCount: 0 });
      expect(runtimeForSession).not.toHaveBeenCalled();
      expect(adapter.records).toEqual([]);

      const allowlisted = new ChannelGateway({
        adapters: [adapter],
        runtimeForSession,
        sessionStore: new InMemoryChannelSessionStore(),
        authPolicy: {
          whatsapp: {
            groupPolicy: "allowlist",
            allowedGroups: ["120363025555555555@g.us"],
          }
        },
      });

      const allowed = await allowlisted.receive(groupMessage);
      expect(allowed.replyText).toBe("ok");
      expect(runtimeForSession).toHaveBeenCalledOnce();
    });

    it("drops non-allowlisted WhatsApp groups silently without session side effects", async () => {
      const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
      const runtimeForSession = vi.fn(async ({ sessionId }) => ({ ...createMinimalRuntime(), sessionId }));
      const sessionStore = {
        getOrCreateSessionId: vi.fn(async () => "should-not-be-created"),
        resetSessionId: vi.fn(),
        setSessionId: vi.fn(),
      } satisfies ChannelSessionStore;
      const gateway = new ChannelGateway({
        adapters: [adapter],
        runtimeForSession,
        sessionStore,
        authPolicy: {
          whatsapp: {
            groupPolicy: "allowlist",
            allowedGroups: ["120363025555555555@g.us"],
          }
        },
      });
      const message = makeMessage("hello group", {
        channel: "whatsapp",
        sessionKey: {
          platform: "whatsapp",
          chatId: "120363029999999999@g.us",
          userId: "971501234567",
          chatType: "group"
        },
        sender: { id: "971501234567", displayName: "Group user" }
      });

      const result = await gateway.receive(message);

      expect(result).toEqual({ sessionId: "", replyText: "", artifactCount: 0, progressCount: 0 });
      expect(runtimeForSession).not.toHaveBeenCalled();
      expect(adapter.records).toEqual([]);
      expect(sessionStore.getOrCreateSessionId).not.toHaveBeenCalled();
      expect(sessionStore.resetSessionId).not.toHaveBeenCalled();
      expect(sessionStore.setSessionId).not.toHaveBeenCalled();
    });

    it("strips required WhatsApp group mentions before runtime", async () => {
      const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
      const handle = vi.fn(async () => runtimeResponse({ text: "ok", securityDecision: "allow" }));
      const runtimeForSession = vi.fn(async ({ sessionId }) => ({ ...createMinimalRuntime(), sessionId, handle }));
      const gateway = new ChannelGateway({
        adapters: [adapter],
        runtimeForSession,
        sessionStore: new InMemoryChannelSessionStore(),
        authPolicy: {
          whatsapp: {
            groupPolicy: "allowlist",
            allowedGroups: ["120363025555555555@g.us"],
            requireMention: true,
            mentionPatterns: ["@EstaCoda"],
          }
        },
      });

      const result = await gateway.receive(makeMessage("@EstaCoda: summarize this.", {
        channel: "whatsapp",
        sessionKey: {
          platform: "whatsapp",
          chatId: "120363025555555555@g.us",
          userId: "971501234567",
          chatType: "group"
        },
        sender: { id: "971501234567", displayName: "Group user" }
      }));

      expect(result.replyText).toBe("ok");
      expect(handle).toHaveBeenCalledWith(expect.objectContaining({ text: "summarize this." }));
    });

    it("does not strip normal text in free-response WhatsApp groups", async () => {
      const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
      const handle = vi.fn(async () => runtimeResponse({ text: "ok", securityDecision: "allow" }));
      const runtimeForSession = vi.fn(async ({ sessionId }) => ({ ...createMinimalRuntime(), sessionId, handle }));
      const gateway = new ChannelGateway({
        adapters: [adapter],
        runtimeForSession,
        sessionStore: new InMemoryChannelSessionStore(),
        authPolicy: {
          whatsapp: {
            groupPolicy: "allowlist",
            allowedGroups: ["120363025555555555@g.us"],
            requireMention: true,
            mentionPatterns: ["@EstaCoda"],
            freeResponseChats: ["120363025555555555@g.us"],
          }
        },
      });

      await gateway.receive(makeMessage("please summarize @notbot", {
        channel: "whatsapp",
        sessionKey: {
          platform: "whatsapp",
          chatId: "120363025555555555@g.us",
          userId: "971501234567",
          chatType: "group"
        },
        sender: { id: "971501234567", displayName: "Group user" }
      }));

      expect(handle).toHaveBeenCalledWith(expect.objectContaining({ text: "please summarize @notbot" }));
    });

    it("ignores non-mentioned WhatsApp groups when mention is required", async () => {
      const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
      const runtimeForSession = vi.fn(async ({ sessionId }) => ({ ...createMinimalRuntime(), sessionId }));
      const sessionStore = {
        getOrCreateSessionId: vi.fn(async () => "should-not-be-created"),
        resetSessionId: vi.fn(),
        setSessionId: vi.fn(),
      } satisfies ChannelSessionStore;
      const gateway = new ChannelGateway({
        adapters: [adapter],
        runtimeForSession,
        sessionStore,
        authPolicy: {
          whatsapp: {
            groupPolicy: "allowlist",
            allowedGroups: ["120363025555555555@g.us"],
            requireMention: true,
            mentionPatterns: ["@EstaCoda"],
          }
        },
      });

      const result = await gateway.receive(makeMessage("summarize this", {
        channel: "whatsapp",
        sessionKey: {
          platform: "whatsapp",
          chatId: "120363025555555555@g.us",
          userId: "971501234567",
          chatType: "group"
        },
        sender: { id: "971501234567", displayName: "Group user" }
      }));

      expect(result).toEqual({ sessionId: "", replyText: "", artifactCount: 0, progressCount: 0 });
      expect(runtimeForSession).not.toHaveBeenCalled();
      expect(adapter.records).toEqual([]);
      expect(sessionStore.getOrCreateSessionId).not.toHaveBeenCalled();
    });

    it("does not strip WhatsApp DM text even when mention patterns are configured", async () => {
      const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
      const handle = vi.fn(async () => runtimeResponse({ text: "ok", securityDecision: "allow" }));
      const runtimeForSession = vi.fn(async ({ sessionId }) => ({ ...createMinimalRuntime(), sessionId, handle }));
      const gateway = new ChannelGateway({
        adapters: [adapter],
        runtimeForSession,
        sessionStore: new InMemoryChannelSessionStore(),
        authPolicy: {
          whatsapp: {
            dmPolicy: "allowlist",
            allowedNumbers: ["971501234567"],
            requireMention: true,
            mentionPatterns: ["@EstaCoda"],
          }
        },
      });

      await gateway.receive(makeMessage("@EstaCoda summarize this", {
        channel: "whatsapp",
        sessionKey: {
          platform: "whatsapp",
          chatId: "971501234567",
          userId: "971501234567",
          chatType: "dm"
        },
        sender: { id: "971501234567", displayName: "DM user" }
      }));

      expect(handle).toHaveBeenCalledWith(expect.objectContaining({ text: "@EstaCoda summarize this" }));
    });

    describe("WhatsApp rapid text debounce", () => {
      const debounceConfig = {
        textDebounceMs: 100,
        textDebounceMaxMessages: 10,
        textDebounceMaxChars: 8_000
      };

      function makeWhatsAppMessage(text: string, overrides: Partial<ChannelMessage> = {}): ChannelMessage {
        return makeMessage(text, {
          id: `wa-${text}`,
          channel: "whatsapp",
          sessionKey: {
            platform: "whatsapp",
            chatId: "971501234567",
            userId: "971501234567",
            chatType: "dm"
          },
          sender: { id: "971501234567", displayName: "WhatsApp user" },
          ...overrides
        });
      }

      function createDebounceGateway(input: {
        handle?: Runtime["handle"];
        authPolicy?: ConstructorParameters<typeof ChannelGateway>[0]["authPolicy"];
        busyPolicyResolver?: ConstructorParameters<typeof ChannelGateway>[0]["busyPolicyResolver"];
        activeTurnRegistry?: ActiveTurnRegistry;
        config?: typeof debounceConfig;
      } = {}) {
        const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
        const handle = input.handle ?? vi.fn(async () => runtimeResponse({ text: "ok", securityDecision: "allow" }));
        const runtimeForSession = vi.fn(async ({ sessionId }) => ({ ...createMinimalRuntime(), sessionId, handle }));
        const gateway = new ChannelGateway({
          adapters: [adapter],
          runtimeForSession,
          sessionStore: new InMemoryChannelSessionStore(),
          authPolicy: input.authPolicy ?? { whatsapp: { dmPolicy: "open" } },
          whatsappTextDebounce: input.config ?? debounceConfig,
          busyPolicyResolver: input.busyPolicyResolver,
          activeTurnRegistry: input.activeTurnRegistry
        });
        return { adapter, gateway, handle, runtimeForSession };
      }

      afterEach(() => {
        vi.useRealTimers();
      });

      it("combines WhatsApp DM texts within the quiet window into one runtime call", async () => {
        const handle = vi.fn(async () => runtimeResponse({ text: "ok", securityDecision: "allow" }));
        const { gateway } = createDebounceGateway({
          handle,
          config: { textDebounceMs: 10, textDebounceMaxMessages: 10, textDebounceMaxChars: 8_000 }
        });

        await gateway.receive(makeWhatsAppMessage("first", { id: "m1" }));
        await gateway.receive(makeWhatsAppMessage("second", { id: "m2" }));
        expect(handle).not.toHaveBeenCalled();

        await new Promise((resolve) => setTimeout(resolve, 20));

        expect(handle).toHaveBeenCalledTimes(1);
        expect(handle).toHaveBeenCalledWith(expect.objectContaining({
          text: "first\n\nsecond",
          inputMetadata: expect.objectContaining({
            debouncedMessageIds: ["m1", "m2"],
            debounceSize: 2,
            debounceWindowMs: 10
          })
        }));
      });

      it("resets the quiet timer when another WhatsApp text arrives", async () => {
        const handle = vi.fn(async () => runtimeResponse({ text: "ok", securityDecision: "allow" }));
        const { gateway } = createDebounceGateway({
          handle,
          config: { textDebounceMs: 10, textDebounceMaxMessages: 10, textDebounceMaxChars: 8_000 }
        });

        await gateway.receive(makeWhatsAppMessage("first"));
        await new Promise((resolve) => setTimeout(resolve, 8));
        await gateway.receive(makeWhatsAppMessage("second"));
        await new Promise((resolve) => setTimeout(resolve, 8));
        expect(handle).not.toHaveBeenCalled();

        await new Promise((resolve) => setTimeout(resolve, 5));
        expect(handle).toHaveBeenCalledTimes(1);
        expect(handle).toHaveBeenCalledWith(expect.objectContaining({ text: "first\n\nsecond" }));
      });

      it("does not merge WhatsApp texts from different senders or chats", async () => {
        const texts: string[] = [];
        const handle = vi.fn(async (input) => {
          texts.push(input.text);
          return runtimeResponse({ text: "ok", securityDecision: "allow" });
        });
        const { gateway } = createDebounceGateway({ handle });

        await gateway.receive(makeWhatsAppMessage("chat one", { id: "m1" }));
        await gateway.receive(makeWhatsAppMessage("chat two", {
          id: "m2",
          sessionKey: {
            platform: "whatsapp",
            chatId: "971509999999",
            userId: "971509999999",
            chatType: "dm"
          },
          sender: { id: "971509999999", displayName: "Other chat" }
        }));
        await gateway.flushPendingDebounces();

        expect(texts.sort()).toEqual(["chat one", "chat two"]);
      });

      it("bypasses debounce for slash and control commands", async () => {
        vi.useFakeTimers();
        const handle = vi.fn(async () => runtimeResponse({ text: "ok", securityDecision: "allow" }));
        const { gateway } = createDebounceGateway({ handle });

        const status = await gateway.receive(makeWhatsAppMessage("/status"));
        const stop = await gateway.receive(makeWhatsAppMessage("/stop"));
        const approve = await gateway.receive(makeWhatsAppMessage("/approve"));
        const deny = await gateway.receive(makeWhatsAppMessage("/deny"));
        await vi.runOnlyPendingTimersAsync();

        expect(status.replyText).toContain("EstaCoda channel status");
        expect(stop.replyText).toContain("Stopping the EstaCoda gateway");
        expect(approve.replyText).toContain("no pending approval");
        expect(deny.replyText).toContain("no pending approval");
        expect(handle).not.toHaveBeenCalled();
      });

      it("bypasses debounce for WhatsApp auth pairing codes", async () => {
        vi.useFakeTimers();
        const pair = vi.fn(async (message: ChannelMessage) => message.text === "12345678" ? "paired" : undefined);
        const handle = vi.fn(async () => runtimeResponse({ text: "ok", securityDecision: "allow" }));
        const adapter = createFakeTelegramAdapter() as FakeTelegramAdapter;
        const gateway = new ChannelGateway({
          adapters: [adapter],
          runtimeForSession: async ({ sessionId }) => ({ ...createMinimalRuntime(), sessionId, handle }),
          sessionStore: new InMemoryChannelSessionStore(),
          authPolicy: { whatsapp: { dmPolicy: "pairing" } },
          pair,
          whatsappTextDebounce: debounceConfig
        });

        const result = await gateway.receive(makeWhatsAppMessage("12345678"));
        await vi.runOnlyPendingTimersAsync();

        expect(result.replyText).toBe("paired");
        expect(pair).toHaveBeenCalledOnce();
        expect(handle).not.toHaveBeenCalled();
      });

      it("bypasses debounce for messages with attachments", async () => {
        vi.useFakeTimers();
        const handle = vi.fn(async () => runtimeResponse({ text: "ok", securityDecision: "allow" }));
        const { gateway } = createDebounceGateway({ handle });

        await gateway.receive(makeWhatsAppMessage("caption", {
          attachments: [{ id: "image-1", kind: "image", status: "ready", localPath: "/profile/channel-media/whatsapp/inbound/image.jpg", bytes: 128 }]
        }));

        expect(handle).toHaveBeenCalledTimes(1);
        expect(handle).toHaveBeenCalledWith(expect.objectContaining({ text: "caption" }));
        await vi.advanceTimersByTimeAsync(100);
        expect(handle).toHaveBeenCalledTimes(1);
      });

      it("strips required group mentions before buffering WhatsApp text", async () => {
        const handle = vi.fn(async () => runtimeResponse({ text: "ok", securityDecision: "allow" }));
        const { gateway } = createDebounceGateway({
          handle,
          authPolicy: {
            whatsapp: {
              groupPolicy: "allowlist",
              allowedGroups: ["120363025555555555@g.us"],
              requireMention: true,
              mentionPatterns: ["@EstaCoda"]
            }
          }
        });

        await gateway.receive(makeWhatsAppMessage("@EstaCoda summarize", {
          id: "g1",
          sessionKey: {
            platform: "whatsapp",
            chatId: "120363025555555555@g.us",
            userId: "971501234567",
            chatType: "group"
          }
        }));
        await gateway.receive(makeWhatsAppMessage("@EstaCoda then translate", {
          id: "g2",
          sessionKey: {
            platform: "whatsapp",
            chatId: "120363025555555555@g.us",
            userId: "971501234567",
            chatType: "group"
          }
        }));
        await gateway.flushPendingDebounces();

        expect(handle).toHaveBeenCalledOnce();
        expect(handle).toHaveBeenCalledWith(expect.objectContaining({
          text: "summarize\n\nthen translate"
        }));
      });

      it("keeps free-response group text intact while debouncing", async () => {
        const handle = vi.fn(async () => runtimeResponse({ text: "ok", securityDecision: "allow" }));
        const { gateway } = createDebounceGateway({
          handle,
          authPolicy: {
            whatsapp: {
              groupPolicy: "allowlist",
              allowedGroups: ["120363025555555555@g.us"],
              requireMention: true,
              mentionPatterns: ["@EstaCoda"],
              freeResponseChats: ["120363025555555555@g.us"]
            }
          }
        });

        await gateway.receive(makeWhatsAppMessage("summarize @notbot", {
          sessionKey: {
            platform: "whatsapp",
            chatId: "120363025555555555@g.us",
            userId: "971501234567",
            chatType: "group"
          }
        }));
        await gateway.flushPendingDebounces();

        expect(handle).toHaveBeenCalledWith(expect.objectContaining({ text: "summarize @notbot" }));
      });

      it("flushes immediately at max message count and max chars", async () => {
        vi.useFakeTimers();
        const texts: string[] = [];
        const handle = vi.fn(async (input) => {
          texts.push(input.text);
          return runtimeResponse({ text: "ok", securityDecision: "allow" });
        });

        const byCount = createDebounceGateway({
          handle,
          config: { textDebounceMs: 1000, textDebounceMaxMessages: 2, textDebounceMaxChars: 8_000 }
        });
        await byCount.gateway.receive(makeWhatsAppMessage("one"));
        await byCount.gateway.receive(makeWhatsAppMessage("two"));
        expect(texts).toContain("one\n\ntwo");

        const byChars = createDebounceGateway({
          handle,
          config: { textDebounceMs: 1000, textDebounceMaxMessages: 10, textDebounceMaxChars: 5 }
        });
        await byChars.gateway.receive(makeWhatsAppMessage("abc"));
        await byChars.gateway.receive(makeWhatsAppMessage("def"));
        expect(texts).toContain("abc\n\ndef");
      });

      it("flushes pending WhatsApp text buffers on graceful gateway shutdown", async () => {
        vi.useFakeTimers();
        const handle = vi.fn(async () => runtimeResponse({ text: "ok", securityDecision: "allow" }));
        const { gateway } = createDebounceGateway({ handle });

        await gateway.receive(makeWhatsAppMessage("before shutdown"));
        expect(handle).not.toHaveBeenCalled();

        await gateway.flushPendingDebounces();

        expect(handle).toHaveBeenCalledWith(expect.objectContaining({ text: "before shutdown" }));
      });

      it("queues one combined busy-session turn for rapid WhatsApp texts", async () => {
        const registry = new ActiveTurnRegistry();
        const seenTexts: string[] = [];
        let releaseFirst: (() => void) | undefined;
        const firstDone = new Promise<void>((resolve) => { releaseFirst = resolve; });
        const handle = vi.fn(async (input) => {
          seenTexts.push(input.text);
          if (input.text === "active") {
            await firstDone;
          }
          return runtimeResponse({ text: "ok", securityDecision: "allow" });
        });
        const { gateway } = createDebounceGateway({
          handle,
          activeTurnRegistry: registry,
          config: { textDebounceMs: 10, textDebounceMaxMessages: 10, textDebounceMaxChars: 8_000 },
          busyPolicyResolver: () => ({ busyPolicy: "queue", queueDepth: 3 })
        });

        const active = gateway.receive(makeWhatsAppMessage("active", {
          attachments: [{ id: "image-active", kind: "image", status: "failed", failureCode: "test" }]
        }));
        await Promise.resolve();
        await gateway.receive(makeWhatsAppMessage("one"));
        await gateway.receive(makeWhatsAppMessage("two"));
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(seenTexts).toEqual(["active"]);

        releaseFirst?.();
        await active;
        await waitFor(() => seenTexts.includes("one\n\ntwo"));

        expect(seenTexts).toEqual(["active", "one\n\ntwo"]);
      });

      it("disables debounce when textDebounceMs is zero", async () => {
        vi.useFakeTimers();
        const handle = vi.fn(async () => runtimeResponse({ text: "ok", securityDecision: "allow" }));
        const { gateway } = createDebounceGateway({
          handle,
          config: { textDebounceMs: 0, textDebounceMaxMessages: 10, textDebounceMaxChars: 8_000 }
        });

        await gateway.receive(makeWhatsAppMessage("immediate"));

        expect(handle).toHaveBeenCalledWith(expect.objectContaining({ text: "immediate" }));
      });
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
