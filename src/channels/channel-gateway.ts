import type {
  ChannelAdapter,
  ChannelAuthPolicies,
  ChannelGatewayResult,
  ChannelMessage,
  ChannelTextAction,
  ChannelTextOptions,
  ChannelStreamingTextHandle,
  ChannelStreamingTextOptions,
  ChannelStreamingTextResult,
  ChannelSessionKey
} from "../contracts/channel.js";
import type { ChannelKind } from "../contracts/channel.js";
import type { ChannelBusyPolicy, LoadedRuntimeConfig } from "../config/runtime-config.js";
import { SessionMessageQueue } from "./session-message-queue.js";
import { assessSecurityPolicy, type SecurityApprovalMode, type SecurityAssessment, type SecurityDecision, type SecurityPolicy, type SecurityRequest } from "../contracts/security.js";
import { runCronCommand } from "../cron/cron-command.js";
import { originFromSessionKey } from "../cron/cron-runner.js";
import { CronStore } from "../cron/cron-store.js";
import type { Runtime } from "../runtime/create-runtime.js";
import type {
  AgentLoopPythonCapabilitySetupApprovalRequest,
  AgentLoopSetupApprovalRequest
} from "../runtime/agent-loop.js";
import type { SecurityAssessorRuntimeConfig } from "../security/security-policy-factory.js";
import type { ToolExecutionRecord } from "../tools/tool-executor.js";
import type { RuntimeEvent } from "../contracts/runtime-event.js";
import type { ArtifactRecord } from "../contracts/artifact.js";
import { renderSessionCompactionResult } from "../prompt/session-compression-service.js";
import { isMemoryCurationModeMutation, runMemoryOperatorCommand } from "../memory/memory-operator-commands.js";
import type { SessionHygieneService } from "./session-hygiene-service.js";
import { ChannelApprovalStore, type PersistedApprovalGrant } from "./channel-approval-store.js";
import { buildBaseSessionId, normalizeSessionKey, type ChannelSessionPolicy, shouldAutoResetSession, stableSessionKey } from "./channel-session-store.js";
import { createSecurityPolicyForMode } from "../security/security-policy-factory.js";
import { assessHardlineFloor } from "../security/command-safety.js";
import type { RuntimeCache } from "../runtime/runtime-cache.js";
import type { RuntimeFingerprint } from "../runtime/runtime-fingerprint.js";
import type { ActiveTurnRegistry } from "../gateway/active-turn-registry.js";
import {
  createCommandHash,
  createCommandPreview,
  type GatewayApprovalQueue,
  type ManagedPythonCapabilityApprovalPayload,
  type PendingApproval,
  type PendingApprovalChannel
} from "../gateway/approval-queue.js";
import { HookRegistry, sanitizeHookError } from "../gateway/hook-registry.js";
import { createHash } from "node:crypto";
import { unlink } from "node:fs/promises";
import type { HandoffStore } from "./handoff-store.js";
import type { SurfacePointerStore } from "./surface-pointer-store.js";
import type { SurfaceType } from "./surface-pointer.js";
import type { DeliveryRouter } from "./delivery-router.js";
import {
  parseApprovalAction,
  renderApprovalActions,
  renderSetupApprovalActions,
  type ApprovalActionScope
} from "./approval-actions.js";
import {
  MODEL_PICKER_MODEL_PAGE_SIZE,
  MODEL_PICKER_MAX_CHOICE_ACTIONS,
  modelPickerBackActionValue,
  modelPickerCancelActionValue,
  modelPickerClearActionValue,
  modelPickerPageActionKey,
  modelPickerPageActionValue,
  modelPickerProviderActionKey,
  modelPickerSelectActionKey,
  parseModelPickerAction,
  renderModelPickerActions
} from "./model-picker-actions.js";
import {
  applyModelSwitchPrimaryRoute,
  resolveEffectiveSessionModelOverride,
  resolveModelSwitchRequest,
  type ModelSwitchContext
} from "../providers/model-switch-resolver.js";
import { createProviderModelSelectionFlow } from "../providers/provider-model-selection-flow.js";
import { resolveProfileStateHome } from "../config/profile-home.js";
import { saveRuntimeConfig } from "../config/runtime-config.js";
import type { VoiceStateManager, VoiceMode } from "../gateway/voice-state.js";
import {
  checkTtsProviderStatus,
  synthesizeSpeechToEphemeralArtifact,
  type VoiceFetchLike
} from "../tools/voice-tools.js";
import { getTtsTextCap, type EdgeTtsRunner } from "../tools/tts-providers.js";
import {
  installManagedPythonCapabilityEnvironment,
  type ManagedPythonCapabilityInstallOptions,
  type ManagedPythonCapabilityInstallResult
} from "../python-env/capability-manager.js";
import {
  normalizeWhatsAppAllowlist,
  normalizeWhatsAppGroupAllowlist,
  normalizeWhatsAppGroupId,
  normalizeWhatsAppUserId,
} from "./whatsapp-identity.js";

function sessionKeyHash(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("hex").slice(0, 16);
}

const DEFAULT_GATEWAY_APPROVAL_TTL_MS = 5 * 60 * 1000;

function formatGatewaySubagentDuration(durationMs: number): string {
  const safeMs = Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0;
  if (safeMs < 1000) {
    return `${Math.round(safeMs)}ms`;
  }
  const seconds = Math.floor(safeMs / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
}

function formatGatewaySubagentBatch(batchId: string | undefined, taskIndex: number | undefined): string {
  if (batchId === undefined && taskIndex === undefined) {
    return "";
  }
  if (batchId === undefined) {
    return `(task #${taskIndex})`;
  }
  if (taskIndex === undefined) {
    return `(batch ${batchId})`;
  }
  return `(batch ${batchId} task #${taskIndex})`;
}

function messageProducedVoiceTranscript(message: ChannelMessage): boolean {
  const metadata = message.metadata?.voiceTranscription;
  if (typeof metadata !== "object" || metadata === null) {
    return false;
  }
  const count = (metadata as { count?: unknown }).count;
  const transcripts = (metadata as { transcripts?: unknown }).transcripts;
  return (typeof count === "number" && count > 0) ||
    (Array.isArray(transcripts) && transcripts.length > 0);
}

function isVoiceDeliveryArtifact(artifact: ArtifactRecord): boolean {
  if (artifact.kind !== "audio") {
    return false;
  }
  const metadata = artifact.metadata ?? {};
  return metadata.deliveryHint === "voice" ||
    metadata.ephemeral === true ||
    typeof metadata.voice === "string" ||
    artifact.path.startsWith("voice:");
}

export type BusyPolicyConfig = {
  busyPolicy: ChannelBusyPolicy;
  queueDepth: number;
};

export type WhatsAppTextDebounceConfig = {
  textDebounceMs: number;
  textDebounceMaxMessages: number;
  textDebounceMaxChars: number;
};

export type ChannelRuntimeFactory = (input: {
  sessionId: string;
  sessionKey: ChannelSessionKey;
  channel: string;
  securityPolicy: SecurityPolicy;
  metadata?: Record<string, unknown>;
}) => Promise<Runtime>;

export type ChannelSessionStore = {
  getOrCreateSessionId(sessionKey: ChannelSessionKey, options?: { receivedAt?: string }): Promise<string>;
  resetSessionId?(sessionKey: ChannelSessionKey, options?: { receivedAt?: string }): Promise<string>;
  setSessionId?(sessionKey: ChannelSessionKey, sessionId: string, options?: { receivedAt?: string }): Promise<void>;
};

export type ChannelGatewayOptions = {
  adapters: ChannelAdapter[];
  runtimeForSession: ChannelRuntimeFactory;
  sessionStore?: ChannelSessionStore;
  authPolicy?: ChannelAuthPolicies;
  trustedWorkspace?: boolean | ((message: ChannelMessage) => boolean | Promise<boolean>);
  onStopRequested?: (message: ChannelMessage) => void | Promise<void>;
  pair?: (message: ChannelMessage) => Promise<string | undefined>;
  approvalStore?: ChannelApprovalStore;
  sessionPolicy?: ChannelSessionPolicy;
  securityMode?: SecurityApprovalMode;
  securityAssessor?: SecurityAssessorRuntimeConfig;
  preprocessMessage?: (message: ChannelMessage) => Promise<ChannelMessage>;
  handoffStore?: HandoffStore;
  surfacePointerStore?: SurfacePointerStore;
  diagnostics?: () => Promise<string>;
  deliveryRouter?: DeliveryRouter;
  homeDir?: string;
  profileId?: string;
  approvalQueue?: GatewayApprovalQueue;

  // Stage 5D additions (all optional)
  /** Active turn registry for busy protection and abort tracking. */
  activeTurnRegistry?: ActiveTurnRegistry;
  /** Runtime cache for reusing Runtime instances across turns. */
  runtimeCache?: RuntimeCache;
  /** Static fingerprint for cache key comparison. Required when runtimeCache is provided. */
  runtimeFingerprint?: RuntimeFingerprint;
  /** Stage 6: drain callback to reject new turns while supervisor is shutting down gracefully. */
  isDraining?: () => boolean;
  /** Stage 7: resolver for per-channel busy policy and queue depth config. */
  busyPolicyResolver?: (channelKind: ChannelKind) => BusyPolicyConfig;
  /** Stage 8B: optional hook registry for turn lifecycle events. */
  hookRegistry?: HookRegistry;
  /** Phase 7F: optional gateway-only pre-runtime session hygiene. */
  sessionHygieneService?: Pick<SessionHygieneService, "run">;
  modelSwitchContext?: () => Promise<ModelSwitchContext>;
  logWarning?: (message: string) => void;
  voiceStateManager?: VoiceStateManager;
  voiceAutoTtsDefault?: boolean;
  autoTtsConfig?: () => Promise<Pick<LoadedRuntimeConfig, "tts" | "voice">> | Pick<LoadedRuntimeConfig, "tts" | "voice">;
  autoTtsTempRoot?: string;
  autoTtsPythonStateRoot?: string;
  autoTtsEdgeTtsRunner?: EdgeTtsRunner;
  pythonCapabilityStateRoot?: string;
  pythonCapabilityInstaller?: (
    options: ManagedPythonCapabilityInstallOptions
  ) => Promise<ManagedPythonCapabilityInstallResult>;
  autoTtsFetch?: VoiceFetchLike;
  autoTtsNow?: () => number;
  autoTtsId?: () => string;
  whatsappTextDebounce?: WhatsAppTextDebounceConfig;
  telegramStreaming?: ChannelStreamingTextOptions & { enabled?: boolean };
};

type ApprovalScope = "once" | "session" | "always";

type AutoTtsUsageWindow = {
  windowStartMs: number;
  chars: number;
};

type WhatsAppTextDebounceBuffer = {
  adapter: ChannelAdapter;
  firstMessage: ChannelMessage;
  latestReceivedAt: string;
  textChunks: string[];
  messageIds: string[];
  totalChars: number;
  timer: ReturnType<typeof setTimeout> | undefined;
};

type ProviderServingState =
  | {
      status: "primary" | "fallback";
      provider: string;
      model: string;
    }
  | {
      status: "failed";
      provider: string;
      model: string;
    };

type CommandPendingApprovalContinuation = {
  kind: "command";
  approvalId?: string;
  toolName: string;
  riskClass: string;
  targetKey?: string;
  targetSummary?: string;
  sessionId: string;
  originalMessage: ChannelMessage;
};

type PythonCapabilityPendingApprovalContinuation = {
  kind: "managed-python-capability-install";
  approvalId?: string;
  toolName: "python-env.setup";
  riskClass: "external-side-effect";
  targetKey: string;
  targetSummary: string;
  capability: AgentLoopPythonCapabilitySetupApprovalRequest;
  sessionId: string;
  originalMessage: ChannelMessage;
};

type PendingApprovalContinuation =
  | CommandPendingApprovalContinuation
  | PythonCapabilityPendingApprovalContinuation;

type ApprovalGrant = {
  toolName: string;
  riskClass: string;
  targetKey?: string;
  targetSummary?: string;
  scope: ApprovalScope;
  sessionId?: string;
};

export class InMemoryChannelSessionStore implements ChannelSessionStore {
  readonly #sessions = new Map<string, { sessionId: string; updatedAt: string }>();
  readonly #policy: ChannelSessionPolicy;
  #sequence = 0;

  constructor(options: { policy?: ChannelSessionPolicy } = {}) {
    this.#policy = options.policy ?? {};
  }

  async getOrCreateSessionId(sessionKey: ChannelSessionKey, _options?: { receivedAt?: string }): Promise<string> {
    const key = stableSessionKey(sessionKey, this.#policy);
    const existing = this.#sessions.get(key);
    const receivedAt = _options?.receivedAt === undefined ? new Date() : new Date(_options.receivedAt);

    if (existing !== undefined && !Number.isNaN(receivedAt.getTime())) {
      if (shouldAutoResetSession(existing.updatedAt, receivedAt, this.#policy)) {
        const sessionId = this.#newSessionId(sessionKey);
        this.#sessions.set(key, {
          sessionId,
          updatedAt: receivedAt.toISOString()
        });
        return sessionId;
      }

      existing.updatedAt = receivedAt.toISOString();
      this.#sessions.set(key, existing);
      return existing.sessionId;
    }

    if (existing !== undefined) {
      return existing.sessionId;
    }

    const sessionId = buildBaseSessionId(sessionKey, this.#policy);
    this.#sessions.set(key, {
      sessionId,
      updatedAt: Number.isNaN(receivedAt.getTime()) ? new Date().toISOString() : receivedAt.toISOString()
    });

    return sessionId;
  }

  async resetSessionId(sessionKey: ChannelSessionKey, _options?: { receivedAt?: string }): Promise<string> {
    const key = stableSessionKey(sessionKey, this.#policy);
    const sessionId = this.#newSessionId(sessionKey);

    const receivedAt = _options?.receivedAt === undefined ? new Date() : new Date(_options.receivedAt);
    this.#sessions.set(key, {
      sessionId,
      updatedAt: Number.isNaN(receivedAt.getTime()) ? new Date().toISOString() : receivedAt.toISOString()
    });

    return sessionId;
  }

  async setSessionId(sessionKey: ChannelSessionKey, sessionId: string, _options?: { receivedAt?: string }): Promise<void> {
    const key = stableSessionKey(sessionKey, this.#policy);
    const receivedAt = _options?.receivedAt === undefined ? new Date() : new Date(_options.receivedAt);
    this.#sessions.set(key, {
      sessionId,
      updatedAt: Number.isNaN(receivedAt.getTime()) ? new Date().toISOString() : receivedAt.toISOString()
    });
  }

  #newSessionId(sessionKey: ChannelSessionKey): string {
    this.#sequence += 1;

    return `${buildBaseSessionId(sessionKey, this.#policy)}-${this.#sequence}`;
  }
}

export class ChannelGateway {
  readonly #adapters = new Map<string, ChannelAdapter>();
  readonly #runtimeForSession: ChannelRuntimeFactory;
  readonly #sessionStore: ChannelSessionStore;
  readonly #authPolicy: ChannelAuthPolicies;
  readonly #trustedWorkspace: ChannelGatewayOptions["trustedWorkspace"];
  readonly #onStopRequested: ChannelGatewayOptions["onStopRequested"];
  readonly #pair: ChannelGatewayOptions["pair"];
  readonly #approvalStore: ChannelApprovalStore;
  readonly #sessionPolicy: ChannelSessionPolicy;
  readonly #securityMode: SecurityApprovalMode;
  readonly #securityAssessor: SecurityAssessorRuntimeConfig | undefined;
  readonly #preprocessMessage: ChannelGatewayOptions["preprocessMessage"];
  readonly #handoffStore: HandoffStore | undefined;
  readonly #surfacePointerStore: SurfacePointerStore | undefined;
  readonly #diagnostics: (() => Promise<string>) | undefined;
  readonly #deliveryRouter: DeliveryRouter | undefined;
  readonly #homeDir: string | undefined;
  readonly #profileId: string;
  readonly #approvalQueue: GatewayApprovalQueue | undefined;
  readonly #activeTurns = new Map<string, AbortController>();
  readonly #pendingApprovals = new Map<string, PendingApprovalContinuation>();
  readonly #approvalGrants = new Map<string, ApprovalGrant[]>();
  readonly #yoloSessions = new Map<string, boolean>();

  // Stage 5D additions
  readonly #activeTurnRegistry: ActiveTurnRegistry | undefined;
  readonly #runtimeCache: RuntimeCache | undefined;
  readonly #runtimeFingerprint: RuntimeFingerprint | undefined;
  readonly #sessionIdByTurnKey = new Map<string, string>();
  readonly #activeRuntimeByTurnKey = new Map<string, Runtime>();
  readonly #logWarning?: (message: string) => void;

  // Stage 6
  readonly #isDraining: (() => boolean) | undefined;

  // Stage 7
  readonly #busyPolicyResolver: ((channelKind: ChannelKind) => BusyPolicyConfig) | undefined;
  readonly #sessionMessageQueue = new SessionMessageQueue();
  readonly #drainingQueue = new Set<string>();

  // Stage 8B
  readonly #hookRegistry: HookRegistry | undefined;
  readonly #sessionHygieneService: Pick<SessionHygieneService, "run"> | undefined;
  readonly #modelSwitchContext: (() => Promise<ModelSwitchContext>) | undefined;
  readonly #abortReasonByKey = new Map<string, string>();
  readonly #voiceStateManager: VoiceStateManager | undefined;
  readonly #voiceAutoTtsDefault: boolean;
  readonly #autoTtsConfig: ChannelGatewayOptions["autoTtsConfig"];
  readonly #autoTtsTempRoot: string | undefined;
  readonly #autoTtsPythonStateRoot: string | undefined;
  readonly #autoTtsEdgeTtsRunner: EdgeTtsRunner | undefined;
  readonly #pythonCapabilityStateRoot: string | undefined;
  readonly #pythonCapabilityInstaller: (
    options: ManagedPythonCapabilityInstallOptions
  ) => Promise<ManagedPythonCapabilityInstallResult>;
  readonly #autoTtsFetch: VoiceFetchLike | undefined;
  readonly #autoTtsNow: () => number;
  readonly #autoTtsId: (() => string) | undefined;
  readonly #autoTtsUsageByChat = new Map<string, AutoTtsUsageWindow>();
  readonly #whatsappTextDebounce: WhatsAppTextDebounceConfig | undefined;
  readonly #whatsappTextDebounceBuffers = new Map<string, WhatsAppTextDebounceBuffer>();
  readonly #telegramStreaming: (ChannelStreamingTextOptions & { enabled?: boolean }) | undefined;
  readonly #providerServingStateBySessionKey = new Map<string, ProviderServingState>();

  constructor(options: ChannelGatewayOptions) {
    this.#runtimeForSession = options.runtimeForSession;
    this.#sessionStore = options.sessionStore ?? new InMemoryChannelSessionStore();
    this.#authPolicy = options.authPolicy ?? {};
    this.#trustedWorkspace = options.trustedWorkspace;
    this.#onStopRequested = options.onStopRequested;
    this.#pair = options.pair;
    this.#approvalStore = options.approvalStore ?? new ChannelApprovalStore();
    this.#sessionPolicy = options.sessionPolicy ?? {};
    this.#securityMode = options.securityMode ?? "adaptive";
    this.#securityAssessor = options.securityAssessor;
    this.#preprocessMessage = options.preprocessMessage;
    this.#handoffStore = options.handoffStore;
    this.#surfacePointerStore = options.surfacePointerStore;
    this.#diagnostics = options.diagnostics;
    this.#deliveryRouter = options.deliveryRouter;
    this.#homeDir = options.homeDir;
    this.#profileId = options.profileId ?? "default";
    this.#approvalQueue = options.approvalQueue;

    // Stage 5D
    this.#activeTurnRegistry = options.activeTurnRegistry;
    this.#runtimeCache = options.runtimeCache;
    this.#runtimeFingerprint = options.runtimeFingerprint;
    this.#logWarning = options.logWarning;

    // Stage 6
    this.#isDraining = options.isDraining;

    // Stage 7
    this.#busyPolicyResolver = options.busyPolicyResolver;

    // Stage 8B
    this.#hookRegistry = options.hookRegistry;
    this.#sessionHygieneService = options.sessionHygieneService;
    this.#modelSwitchContext = options.modelSwitchContext;
    this.#voiceStateManager = options.voiceStateManager;
    this.#voiceAutoTtsDefault = options.voiceAutoTtsDefault ?? false;
    this.#autoTtsConfig = options.autoTtsConfig;
    this.#autoTtsTempRoot = options.autoTtsTempRoot;
    this.#autoTtsPythonStateRoot = options.autoTtsPythonStateRoot;
    this.#autoTtsEdgeTtsRunner = options.autoTtsEdgeTtsRunner;
    this.#pythonCapabilityStateRoot = options.pythonCapabilityStateRoot ?? options.autoTtsPythonStateRoot;
    this.#pythonCapabilityInstaller = options.pythonCapabilityInstaller ?? installManagedPythonCapabilityEnvironment;
    this.#autoTtsFetch = options.autoTtsFetch;
    this.#autoTtsNow = options.autoTtsNow ?? Date.now;
    this.#autoTtsId = options.autoTtsId;
    this.#whatsappTextDebounce = options.whatsappTextDebounce;
    this.#telegramStreaming = options.telegramStreaming;

    for (const adapter of options.adapters) {
      this.#adapters.set(adapter.id ?? adapter.kind, adapter);
    }
  }

  /** Stage 7: check if there is any pending work (active turns, queued messages, draining). */
  hasPendingWork(): boolean {
    const hasActiveTurns = this.#activeTurnRegistry !== undefined
      ? this.#activeTurnRegistry.stats().activeTurnCount > 0
      : this.#activeTurns.size > 0;
    const hasQueued = this.#sessionMessageQueue.totalSize() > 0;
    const hasDraining = this.#drainingQueue.size > 0;
    const hasDebouncedText = this.#whatsappTextDebounceBuffers.size > 0;
    return hasActiveTurns || hasQueued || hasDraining || hasDebouncedText;
  }

  async #deliverText(
    adapter: ChannelAdapter,
    sessionKey: ChannelSessionKey,
    text: string,
    options?: import("../contracts/channel.js").ChannelTextOptions
  ): Promise<void> {
    if (this.#deliveryRouter) {
      await this.#deliveryRouter.deliverText([{ kind: "origin", originalSessionKey: sessionKey }], text, options);
    } else {
      await adapter.delivery?.sendText(sessionKey, text, options);
    }
  }

  async #deliverProgress(
    adapter: ChannelAdapter,
    sessionKey: ChannelSessionKey,
    event: RuntimeEvent
  ): Promise<void> {
    if (this.#deliveryRouter) {
      await this.#deliveryRouter.deliverProgress({ kind: "origin", originalSessionKey: sessionKey }, event);
    } else {
      await adapter.delivery?.sendProgress?.(sessionKey, event);
    }
  }

  #providerServingTransitionEvent(
    sessionKey: ChannelSessionKey,
    event: RuntimeEvent
  ): RuntimeEvent | undefined {
    if (event.kind !== "provider-result") {
      return undefined;
    }

    const key = stableSessionKey(sessionKey, this.#sessionPolicy);
    const previous = this.#providerServingStateBySessionKey.get(key);

    if (!event.ok) {
      if (!event.willFallback) {
        this.#providerServingStateBySessionKey.set(key, {
          status: "failed",
          provider: event.provider,
          model: event.model
        });
      }
      return undefined;
    }

    if (event.fallback) {
      this.#providerServingStateBySessionKey.set(key, {
        status: "fallback",
        provider: event.provider,
        model: event.model
      });

      if (
        previous?.status === "fallback" &&
        previous.provider === event.provider &&
        previous.model === event.model
      ) {
        return undefined;
      }

      return {
        kind: "provider-serving-transition",
        transition: "fallback-active",
        provider: event.provider,
        model: event.model
      };
    }

    this.#providerServingStateBySessionKey.set(key, {
      status: "primary",
      provider: event.provider,
      model: event.model
    });

    if (previous?.status === "fallback" || previous?.status === "failed") {
      return {
        kind: "provider-serving-transition",
        transition: "primary-recovered",
        provider: event.provider,
        model: event.model
      };
    }

    return undefined;
  }

  async #deliverArtifact(
    adapter: ChannelAdapter,
    sessionKey: ChannelSessionKey,
    artifact: ArtifactRecord
  ): Promise<void> {
    if (this.#deliveryRouter) {
      await this.#deliveryRouter.deliverArtifact({ kind: "origin", originalSessionKey: sessionKey }, artifact);
    } else {
      await adapter.delivery?.sendArtifact?.(sessionKey, artifact);
    }
  }

  #startStreamingTextIfEligible(
    adapter: ChannelAdapter,
    sessionKey: ChannelSessionKey,
    signal: AbortSignal | undefined
  ): ChannelStreamingTextHandle | undefined {
    if (
      adapter.kind !== "telegram" ||
      sessionKey.platform !== "telegram" ||
      this.#telegramStreaming?.enabled !== true ||
      adapter.delivery?.startStreamingText === undefined ||
      signal === undefined
    ) {
      return undefined;
    }

    return adapter.delivery.startStreamingText(sessionKey, {
      signal,
      editIntervalMs: this.#telegramStreaming.editIntervalMs,
      minInitialChars: this.#telegramStreaming.minInitialChars,
      cursor: this.#telegramStreaming.cursor,
      maxFloodStrikes: this.#telegramStreaming.maxFloodStrikes,
      cleanupFailedAttempts: this.#telegramStreaming.cleanupFailedAttempts,
      freshFinalAfterSeconds: this.#telegramStreaming.freshFinalAfterSeconds,
      transport: this.#telegramStreaming.transport
    });
  }

  async #handleStreamingEvent(
    streamHandle: ChannelStreamingTextHandle | undefined,
    event: RuntimeEvent,
    options: {
      deltasViaCallbacks?: boolean;
      segmentBreaksViaCallbacks?: boolean;
    } = {}
  ): Promise<boolean> {
    if (streamHandle === undefined) {
      return false;
    }

    if (event.kind === "provider-token") {
      if (options.deltasViaCallbacks !== true) {
        streamHandle.append(event.text);
      }
      return true;
    }

    if (event.kind === "provider-result") {
      streamHandle.providerAttemptResult({
        ok: event.ok,
        willFallback: event.willFallback,
        provider: event.provider,
        model: event.model
      });
      return false;
    }

    if (event.kind === "provider-tool-call") {
      if (options.segmentBreaksViaCallbacks !== true) {
        streamHandle.segmentBreak("provider-tool-call");
      }
      return false;
    }

    if (event.kind === "agent-cancelled") {
      await this.#abortStreamingText(streamHandle, event.reason);
      return false;
    }

    return false;
  }

  async #finishStreamingText(
    streamHandle: ChannelStreamingTextHandle | undefined,
    finalText: string
  ): Promise<ChannelStreamingTextResult | undefined> {
    if (streamHandle === undefined) {
      return undefined;
    }

    try {
      return await streamHandle.finish(finalText);
    } catch {
      return {
        delivered: false,
        fallbackRequired: true
      };
    }
  }

  async #abortStreamingText(streamHandle: ChannelStreamingTextHandle | undefined, reason?: string): Promise<void> {
    if (streamHandle === undefined) {
      return;
    }

    try {
      await streamHandle.abort(reason);
    } catch {
      // Streaming cleanup is secondary to the original turn outcome.
    }
  }

  async #maybeDeliverAutoTts(input: {
    adapter: ChannelAdapter;
    message: ChannelMessage;
    sessionKey: ChannelSessionKey;
    responseText: string;
    artifacts: ArtifactRecord[];
    toolExecutions: ToolExecutionRecord[];
    signal?: AbortSignal;
  }): Promise<void> {
    if (this.#voiceStateManager === undefined || this.#autoTtsConfig === undefined || this.#autoTtsTempRoot === undefined) {
      return;
    }
    if (!this.#isAutoTtsEligibleResponse(input.responseText, input.message, input.artifacts, input.toolExecutions)) {
      return;
    }

    const incomingWasVoice = messageProducedVoiceTranscript(input.message);
    if (!await this.#voiceStateManager.shouldAutoTts(
      input.message.sessionKey.platform,
      input.message.sessionKey.chatId,
      incomingWasVoice,
      this.#voiceAutoTtsDefault
    )) {
      return;
    }

    const config = await this.#autoTtsConfig();
    const text = input.responseText.trim();
    const status = checkTtsProviderStatus(config.tts.provider, config.tts);
    if (!status.ready) {
      this.#logWarning?.(`[voice-auto-tts] skipped: ${status.reason}`);
      return;
    }

    const providerCap = getTtsTextCap({ provider: config.tts.provider, tts: config.tts });
    if (providerCap !== undefined && text.length > providerCap) {
      return;
    }
    if (config.voice.autoTtsMaxCharsPerReply !== undefined && text.length > config.voice.autoTtsMaxCharsPerReply) {
      return;
    }
    if (!this.#canUseAutoTtsChars(input.message.sessionKey, text.length, config.voice.autoTtsMaxCharsPerHourPerChat)) {
      return;
    }

    const result = await synthesizeSpeechToEphemeralArtifact({
      text,
      tts: config.tts,
      tempRoot: this.#autoTtsTempRoot,
      pythonStateRoot: this.#autoTtsPythonStateRoot,
      fetch: this.#autoTtsFetch,
      edgeTtsRunner: this.#autoTtsEdgeTtsRunner,
      id: this.#autoTtsId,
      signal: input.signal
    });
    if (!result.ok) {
      this.#logWarning?.(`[voice-auto-tts] synthesis failed: ${result.content}`);
      return;
    }

    this.#recordAutoTtsChars(input.message.sessionKey, text.length, config.voice.autoTtsMaxCharsPerHourPerChat);

    try {
      await this.#deliverArtifact(input.adapter, input.sessionKey, result.artifact);
    } catch (error) {
      this.#logWarning?.(`[voice-auto-tts] delivery failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      await unlink(result.artifact.localPath ?? result.artifact.path).catch(() => {});
    }
  }

  #isAutoTtsEligibleResponse(
    responseText: string,
    message: ChannelMessage,
    artifacts: ArtifactRecord[],
    toolExecutions: ToolExecutionRecord[]
  ): boolean {
    const text = responseText.trim();
    if (text.length === 0) {
      return false;
    }
    if (message.text.trim().startsWith("/")) {
      return false;
    }
    if (/^(error:|estacoda encountered an error:)/iu.test(text)) {
      return false;
    }
    if (toolExecutions.some((execution) => execution.tool.name === "voice.speak")) {
      return false;
    }
    return !artifacts.some(isVoiceDeliveryArtifact);
  }

  #canUseAutoTtsChars(sessionKey: ChannelSessionKey, chars: number, maxCharsPerHour: number | undefined): boolean {
    if (maxCharsPerHour === undefined) {
      return true;
    }
    const { used } = this.#currentAutoTtsUsage(sessionKey);
    return used + chars <= maxCharsPerHour;
  }

  #recordAutoTtsChars(sessionKey: ChannelSessionKey, chars: number, maxCharsPerHour: number | undefined): void {
    if (maxCharsPerHour === undefined) {
      return;
    }
    const { key, windowStartMs, used } = this.#currentAutoTtsUsage(sessionKey);
    this.#autoTtsUsageByChat.set(key, { windowStartMs, chars: used + chars });
  }

  #currentAutoTtsUsage(sessionKey: ChannelSessionKey): {
    key: string;
    windowStartMs: number;
    used: number;
  } {
    const key = `${sessionKey.platform}:${sessionKey.chatId}`;
    const now = this.#autoTtsNow();
    const current = this.#autoTtsUsageByChat.get(key);
    const resetWindow = current === undefined || now - current.windowStartMs >= 3_600_000;
    const windowStartMs = resetWindow ? now : current.windowStartMs;
    const used = resetWindow ? 0 : current.chars;
    return { key, windowStartMs, used };
  }

  async #createPendingApprovalContinuation(
    pending: PendingApprovalContinuation | undefined,
    adapter: ChannelAdapter
  ): Promise<PendingApprovalContinuation | undefined> {
    if (pending === undefined || this.#approvalQueue === undefined) {
      return pending;
    }

    const payload = pending.kind === "managed-python-capability-install"
      ? managedPythonCapabilityApprovalPreview(pending.capability)
      : pending.targetSummary ?? pending.targetKey ?? pending.toolName;
    const requestedAt = dateOrNow(pending.originalMessage.receivedAt);
    const durable = await this.#approvalQueue.createPendingApproval({
      sessionId: pending.sessionId,
      profileId: this.#profileId,
      commandPreview: createCommandPreview(payload),
      commandHash: createCommandHash(payload),
      commandPayload: pending.kind === "command" ? payload : undefined,
      toolName: pending.toolName,
      approvalKind: pending.kind === "managed-python-capability-install"
        ? "managed_python_capability_install"
        : "command",
      requestPayload: pending.kind === "managed-python-capability-install"
        ? managedPythonCapabilityApprovalPayload(pending.capability, pending.originalMessage)
        : undefined,
      requestedAt,
      expiresAt: new Date(requestedAt.getTime() + DEFAULT_GATEWAY_APPROVAL_TTL_MS),
      channel: toPendingApprovalChannel(adapter.kind),
      chatId: pending.originalMessage.sessionKey.chatId
    });

    if (durable.status !== "pending") {
      return undefined;
    }

    return {
      ...pending,
      approvalId: durable.id,
      targetSummary: durable.commandPreview
    };
  }

  async #refreshCachedRuntimePolicy(sessionId: string, reason: string): Promise<void> {
    if (this.#runtimeCache === undefined) {
      return;
    }

    try {
      await this.#runtimeCache.invalidate(sessionId);
    } catch (error) {
      this.#logWarning?.(
        `${reason} cache invalidate failed for ${sessionId}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  async #refreshAllCachedRuntimes(reason: string): Promise<void> {
    if (this.#runtimeCache === undefined) {
      return;
    }

    try {
      await this.#runtimeCache.disposeAll();
    } catch (error) {
      this.#logWarning?.(
        `${reason} cache disposeAll failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  async start(): Promise<void> {
    for (const adapter of this.#adapters.values()) {
      await adapter.start?.(async (message) => {
        await this.receive(message);
      });
    }
  }

  async stop(): Promise<void> {
    await this.flushPendingDebounces();
    for (const adapter of this.#adapters.values()) {
      await adapter.stop?.();
    }
  }

  async flushPendingDebounces(): Promise<void> {
    const keys = [...this.#whatsappTextDebounceBuffers.keys()];
    for (const key of keys) {
      await this.#flushWhatsAppTextDebounce(key);
    }
  }

  async tickApprovalResolutions(): Promise<void> {
    if (this.#approvalQueue === undefined || this.#pendingApprovals.size === 0) {
      return;
    }

    for (const [key, pending] of [...this.#pendingApprovals]) {
      if (pending.approvalId === undefined) {
        continue;
      }

      let durable = await this.#approvalQueue.getApproval(pending.approvalId, {
        profileId: this.#profileId,
        sessionId: pending.sessionId
      });

      if (durable?.status === "pending" && durable.expiresAt.getTime() <= Date.now()) {
        await this.#approvalQueue.expireStaleApprovals();
        durable = await this.#approvalQueue.getApproval(pending.approvalId, {
          profileId: this.#profileId,
          sessionId: pending.sessionId
        });
      }

      if (durable?.status === "approved") {
        const adapter = this.#adapterFor(pending.originalMessage.channel);
        await this.#resumePendingApproval(key, pending, adapter, "once", "Approved by CLI/operator.");
      } else if (durable?.status === "denied" || durable?.status === "expired") {
        const adapter = this.#adapterFor(pending.originalMessage.channel);
        await this.#terminatePendingApproval(
          key,
          pending,
          adapter,
          durable.status === "expired"
            ? "Approval expired"
            : "Approval denied",
          durable.status === "expired"
            ? "The pending action expired before it was approved."
            : "The pending action was denied by CLI/operator."
        );
      }
    }
  }

  async receive(message: ChannelMessage): Promise<ChannelGatewayResult> {
    const adapter = this.#adapterFor(message.channel);
    const auth = authorizeChannelMessage(message, this.#authPolicy);

    if (!auth.allowed) {
      if (auth.silentDrop === true) {
        return {
          sessionId: "",
          replyText: "",
          artifactCount: 0,
          progressCount: 0
        };
      }

      const pairedMessage = auth.pairingAllowed === false ? undefined : await this.#pair?.(message);

      if (pairedMessage !== undefined) {
        await this.#deliverText(adapter, message.sessionKey, pairedMessage);
        await adapter.send?.({
          conversationId: message.sessionKey.chatId,
          sessionKey: message.sessionKey,
          text: pairedMessage
        });

        return {
          sessionId: "",
          replyText: pairedMessage,
          artifactCount: 0,
          progressCount: 0
        };
      }

      await this.#deliverText(adapter, message.sessionKey, auth.message);
      await adapter.send?.({
        conversationId: message.sessionKey.chatId,
        sessionKey: message.sessionKey,
        text: auth.message
      });

      return {
        sessionId: "",
        replyText: auth.message,
        artifactCount: 0,
        progressCount: 0
      };
    }

    const authorizedMessage = auth.authorizedText === undefined
      ? message
      : { ...message, text: auth.authorizedText };

    const commandResult = await this.#handleCommand(authorizedMessage, adapter);

    if (commandResult !== undefined) {
      return commandResult;
    }

    // --- Drain check (before any turn side effects) ---
    if (this.#isDraining?.()) {
      const drainText = "Gateway is restarting, please try again shortly.";
      await this.#deliverText(adapter, authorizedMessage.sessionKey, drainText);
      return { sessionId: "", replyText: drainText, artifactCount: 0, progressCount: 0 };
    }

    const processedMessage = await this.#preprocessMessage?.(authorizedMessage) ?? authorizedMessage;

    const debounced = await this.#maybeDebounceWhatsAppText(processedMessage, adapter);
    if (debounced !== undefined) {
      return debounced;
    }

    return this.#routeNormalTurn(processedMessage, adapter);
  }

  async #maybeDebounceWhatsAppText(message: ChannelMessage, adapter: ChannelAdapter): Promise<ChannelGatewayResult | undefined> {
    if (!this.#isEligibleForWhatsAppTextDebounce(message)) {
      return undefined;
    }
    const config = this.#whatsappTextDebounce;
    if (config === undefined) {
      return undefined;
    }

    const key = this.#whatsappTextDebounceKey(message);
    const text = message.text.trim();
    const existing = this.#whatsappTextDebounceBuffers.get(key);
    if (existing !== undefined) {
      existing.textChunks.push(text);
      existing.messageIds.push(message.id);
      existing.latestReceivedAt = message.receivedAt;
      existing.totalChars += text.length;
      existing.adapter = adapter;
      this.#resetWhatsAppTextDebounceTimer(key, existing);
      if (
        existing.textChunks.length >= config.textDebounceMaxMessages ||
        existing.totalChars >= config.textDebounceMaxChars
      ) {
        return await this.#flushWhatsAppTextDebounce(key) ?? { sessionId: "", replyText: "", artifactCount: 0, progressCount: 0 };
      }
      return { sessionId: "", replyText: "", artifactCount: 0, progressCount: 0 };
    }

    const buffer: WhatsAppTextDebounceBuffer = {
      adapter,
      firstMessage: message,
      latestReceivedAt: message.receivedAt,
      textChunks: [text],
      messageIds: [message.id],
      totalChars: text.length,
      timer: undefined
    };
    this.#whatsappTextDebounceBuffers.set(key, buffer);
    this.#resetWhatsAppTextDebounceTimer(key, buffer);

    if (
      buffer.textChunks.length >= config.textDebounceMaxMessages ||
      buffer.totalChars >= config.textDebounceMaxChars
    ) {
      return await this.#flushWhatsAppTextDebounce(key) ?? { sessionId: "", replyText: "", artifactCount: 0, progressCount: 0 };
    }

    return { sessionId: "", replyText: "", artifactCount: 0, progressCount: 0 };
  }

  #isEligibleForWhatsAppTextDebounce(message: ChannelMessage): boolean {
    if (message.channel !== "whatsapp") {
      return false;
    }
    if (this.#whatsappTextDebounce === undefined || this.#whatsappTextDebounce.textDebounceMs <= 0) {
      return false;
    }
    if (message.attachments !== undefined && message.attachments.length > 0) {
      return false;
    }
    const text = message.text.trim();
    if (text.length === 0 || text.startsWith("/")) {
      return false;
    }
    return true;
  }

  #whatsappTextDebounceKey(message: ChannelMessage): string {
    return [
      message.channel,
      message.sessionKey.chatId,
      message.sessionKey.userId ?? message.sender.id
    ].join(":");
  }

  #resetWhatsAppTextDebounceTimer(key: string, buffer: WhatsAppTextDebounceBuffer): void {
    if (buffer.timer !== undefined) {
      clearTimeout(buffer.timer);
    }
    buffer.timer = setTimeout(() => {
      void this.#flushWhatsAppTextDebounce(key).catch((error) => {
        this.#logWarning?.(`WhatsApp text debounce flush failed for ${key}: ${error instanceof Error ? error.message : String(error)}`);
      });
    }, this.#whatsappTextDebounce?.textDebounceMs ?? 0);
  }

  async #flushWhatsAppTextDebounce(key: string): Promise<ChannelGatewayResult | undefined> {
    const buffer = this.#whatsappTextDebounceBuffers.get(key);
    if (buffer === undefined) {
      return undefined;
    }
    this.#whatsappTextDebounceBuffers.delete(key);
    if (buffer.timer !== undefined) {
      clearTimeout(buffer.timer);
    }

    const combinedText = buffer.textChunks.join("\n\n");
    const combinedMessage: ChannelMessage = {
      ...buffer.firstMessage,
      text: combinedText,
      receivedAt: buffer.latestReceivedAt,
      metadata: {
        ...(buffer.firstMessage.metadata ?? {}),
        debouncedMessageIds: buffer.messageIds,
        debounceSize: buffer.textChunks.length,
        debounceWindowMs: this.#whatsappTextDebounce?.textDebounceMs ?? 0
      }
    };

    return this.#routeNormalTurn(combinedMessage, buffer.adapter);
  }

  async #routeNormalTurn(processedMessage: ChannelMessage, adapter: ChannelAdapter): Promise<ChannelGatewayResult> {
    const activeTurnKey = stableSessionKey(processedMessage.sessionKey, this.#sessionPolicy);
    const normalizedSessionKey = normalizeSessionKey(processedMessage.sessionKey, this.#sessionPolicy);

    const policy = this.#busyPolicyResolver?.(processedMessage.channel) ?? { busyPolicy: "reject" as const, queueDepth: 3 };
    const isBusy = this.#activeTurnRegistry !== undefined
      ? this.#activeTurnRegistry.isBusy(activeTurnKey)
      : this.#activeTurns.has(activeTurnKey);
    const hasQueued = this.#sessionMessageQueue.size(activeTurnKey) > 0;
    const isDrainingQueued = this.#drainingQueue.has(activeTurnKey);

    if (isBusy || hasQueued || isDrainingQueued) {
      switch (policy.busyPolicy) {
        case "reject": {
          if (this.#activeTurnRegistry !== undefined) {
            if (this.#activeTurnRegistry.consumeBusyAck(activeTurnKey)) {
              const busyText = "EstaCoda is busy with another request in this chat. Please wait.";
              await this.#deliverText(adapter, normalizedSessionKey, busyText);
            }
          }
          return { sessionId: "", replyText: "", artifactCount: 0, progressCount: 0 };
        }
        case "queue": {
          const policy = this.#busyPolicyResolver?.(processedMessage.channel) ?? { busyPolicy: "reject" as const, queueDepth: 3 };
          const enqueueResult = this.#sessionMessageQueue.enqueue(
            activeTurnKey,
            processedMessage,
            policy.busyPolicy,
            policy.queueDepth
          );
          if (enqueueResult.accepted) {
            const position = enqueueResult.position;
            if (position !== undefined) {
              await this.#deliverText(adapter, normalizedSessionKey, `Queued (position ${position})`);
            }
          } else {
            await this.#deliverText(adapter, normalizedSessionKey, "Queue is full. Please try again later.");
          }
          return { sessionId: "", replyText: "", artifactCount: 0, progressCount: 0 };
        }
        case "interrupt": {
          if (this.#hasActiveSubagentsForTurn(activeTurnKey)) {
            const enqueueResult = this.#sessionMessageQueue.enqueue(
              activeTurnKey,
              processedMessage,
              policy.busyPolicy,
              policy.queueDepth
            );
            if (enqueueResult.accepted) {
              const position = enqueueResult.position;
              if (position !== undefined) {
                await this.#deliverText(adapter, normalizedSessionKey, `Queued (position ${position})`);
              }
            } else {
              await this.#deliverText(adapter, normalizedSessionKey, "Queue is full. Please try again later.");
            }
            return { sessionId: "", replyText: "", artifactCount: 0, progressCount: 0 };
          }
          this.#sessionMessageQueue.clear(activeTurnKey);
          this.#sessionMessageQueue.unshift(
            activeTurnKey,
            processedMessage,
            policy.busyPolicy,
            policy.queueDepth
          );
          // Abort active turn if one exists
          if (this.#activeTurnRegistry !== undefined) {
            this.#abortReasonByKey.set(activeTurnKey, "interrupt");
            this.#activeTurnRegistry.abortTurn(activeTurnKey, "interrupt");
          } else {
            this.#abortReasonByKey.set(activeTurnKey, "interrupt");
            this.#activeTurns.get(activeTurnKey)?.abort("interrupt");
          }
          return { sessionId: "", replyText: "", artifactCount: 0, progressCount: 0 };
        }
      }
    }

    // Not busy — process immediately
    return this.#processTurn(processedMessage, adapter);
  }

  async #processTurn(message: ChannelMessage, adapter: ChannelAdapter): Promise<ChannelGatewayResult> {
    const activeTurnKey = stableSessionKey(message.sessionKey, this.#sessionPolicy);
    const normalizedSessionKey = normalizeSessionKey(message.sessionKey, this.#sessionPolicy);

    // --- Busy check (early, before any expensive work) ---
    const controller = new AbortController();
    let turnId: string | undefined;
    let turnStarted = false;

    if (this.#activeTurnRegistry !== undefined) {
      const startResult = this.#activeTurnRegistry.startTurn(activeTurnKey, controller);
      if (!startResult.ok) {
        if (this.#activeTurnRegistry.consumeBusyAck(activeTurnKey)) {
          const busyText = "EstaCoda is busy with another request in this chat. Please wait.";
          await this.#deliverText(adapter, normalizedSessionKey, busyText);
        }
        return { sessionId: "", replyText: "", artifactCount: 0, progressCount: 0 };
      }
      turnId = startResult.turnId;
    } else {
      if (this.#activeTurns.has(activeTurnKey)) {
        return { sessionId: "", replyText: "", artifactCount: 0, progressCount: 0 };
      }
      this.#activeTurns.set(activeTurnKey, controller);
    }
    turnStarted = true;

    const queueSize = this.#sessionMessageQueue.size(activeTurnKey);
    void this.#hookRegistry?.emit("session:turn:start", {
      turnId: turnId ?? activeTurnKey,
      sessionKeyHash: sessionKeyHash(activeTurnKey),
      channel: message.channel,
      origin: message.text.startsWith("/") ? "command" : "message",
      queueSize,
    });

    // --- Single try/finally: every path after startTurn must endTurn ---
    let runtime: Runtime | undefined;
    let sessionId = "";
    let progressCount = 0;
    let terminalEventEmitted = false;
    let streamHandle: ChannelStreamingTextHandle | undefined;
    const turnStartTime = Date.now();
    try {
      // Session resolution
      sessionId = await this.#sessionStore.getOrCreateSessionId(message.sessionKey, {
        receivedAt: message.receivedAt
      });

      // Update turn metadata with sessionId (for Stage 5E stuck-loop mapping)
      if (this.#activeTurnRegistry !== undefined && turnId !== undefined) {
        this.#activeTurnRegistry.updateTurn(activeTurnKey, turnId, { sessionId });
      }

      // Cache invalidation on session change
      const previousSessionId = this.#sessionIdByTurnKey.get(activeTurnKey);
      if (previousSessionId !== undefined && previousSessionId !== sessionId) {
        if (this.#runtimeCache !== undefined) {
          try {
            await this.#runtimeCache.invalidate(previousSessionId);
          } catch (invalidateErr) {
            this.#logWarning?.(
              `Session reset cache invalidate failed for ${previousSessionId}: ${invalidateErr instanceof Error ? invalidateErr.message : String(invalidateErr)}`
            );
          }
        }
      }
      this.#sessionIdByTurnKey.set(activeTurnKey, sessionId);

      const hygieneResult = await this.#runSessionHygiene(sessionId, controller.signal);
      if (hygieneResult?.status === "compacted" && hygieneResult.rotated) {
        const nextSessionId = hygieneResult.activeSessionId;
        await this.#adoptSessionId(message.sessionKey, sessionId, nextSessionId, {
          receivedAt: message.receivedAt,
          reason: "Gateway session hygiene"
        });
        sessionId = nextSessionId;
        if (this.#activeTurnRegistry !== undefined && turnId !== undefined) {
          this.#activeTurnRegistry.updateTurn(activeTurnKey, turnId, { sessionId });
        }
      }

      const securityPolicy = this.#securityPolicyFor(
        normalizedSessionKey,
        sessionId,
        await this.#approvalStore.listForSession(normalizedSessionKey)
      );

      // Runtime acquisition
      runtime = await this.#acquireRuntime(sessionId, securityPolicy, message, normalizedSessionKey);
      this.#activeRuntimeByTurnKey.set(activeTurnKey, runtime);

      const trustedWorkspace = typeof this.#trustedWorkspace === "function"
        ? await this.#trustedWorkspace(message)
        : this.#trustedWorkspace;
      const debounceMetadata = readDebounceMetadata(message.metadata);
      streamHandle = this.#startStreamingTextIfEligible(adapter, normalizedSessionKey, controller.signal);
      const streamCallbacksWired = streamHandle !== undefined;

      // Handle the turn
      const response = await runtime.handle({
        text: message.text,
        attachments: message.attachments,
        channel: message.channel,
        trustedWorkspace,
        signal: controller.signal,
        inputMetadata: {
          surfaceType: message.sessionKey.platform,
          chatId: message.sessionKey.chatId,
          userId: message.sender.id,
          origin: message.text.startsWith("/") ? "command" : "message",
          ...(debounceMetadata === undefined ? {} : debounceMetadata)
        },
        ...(streamCallbacksWired
          ? {
              onDelta: (text) => streamHandle?.append(text),
              onSegmentBreak: (reason) => streamHandle?.segmentBreak(reason)
            }
          : {}),
        onEvent: async (event) => {
          if (await this.#handleStreamingEvent(streamHandle, event, {
            deltasViaCallbacks: streamCallbacksWired,
            segmentBreaksViaCallbacks: streamCallbacksWired
          })) {
            return;
          }
          const providerServingTransition = this.#providerServingTransitionEvent(normalizedSessionKey, event);
          if (providerServingTransition !== undefined) {
            progressCount += 1;
            await this.#deliverProgress(adapter, normalizedSessionKey, providerServingTransition);
            return;
          }
          if (event.kind === "provider-result") {
            return;
          }
          progressCount += 1;
          await this.#deliverProgress(adapter, normalizedSessionKey, event);
        }
      });
      sessionId = await this.#consumeRuntimeRotation({
        runtime,
        sessionKey: message.sessionKey,
        expectedSessionId: sessionId,
        activeTurnKey,
        turnId,
        receivedAt: message.receivedAt
      }) ?? sessionId;

      const pendingApproval = await this.#createPendingApprovalContinuation(
        firstPendingSetupApproval(response.setupApprovals, message, sessionId) ??
          firstPendingApproval(response.toolExecutions, message, sessionId),
        adapter
      );
      if (pendingApproval !== undefined) {
        this.#pendingApprovals.set(activeTurnKey, pendingApproval);
      } else {
        this.#pendingApprovals.delete(activeTurnKey);
      }

      const approvalBoundary = pendingApproval !== undefined;
      const artifactBoundary = response.artifacts.length > 0;
      const streamResult = await this.#finishStreamingText(streamHandle, response.text);
      const streamingDeliveredFinalText = streamResult?.delivered === true &&
        streamResult.fallbackRequired === false &&
        streamResult.deliveredText === response.text &&
        response.text.trim().length > 0 &&
        !approvalBoundary &&
        !artifactBoundary;

      if (!streamingDeliveredFinalText) {
        await this.#deliverText(
          adapter,
          normalizedSessionKey,
          response.text,
          message.channel === "whatsapp" ? { replyTo: message.id } : undefined
        );
      }
      await adapter.send?.({
        conversationId: message.sessionKey.chatId,
        sessionKey: normalizedSessionKey,
        text: response.text,
        artifacts: response.artifacts
      });

      for (const artifact of response.artifacts) {
        await this.#deliverArtifact(adapter, normalizedSessionKey, artifact);
      }

      await this.#maybeDeliverAutoTts({
        adapter,
        message,
        sessionKey: normalizedSessionKey,
        responseText: response.text,
        artifacts: response.artifacts,
        toolExecutions: response.toolExecutions,
        signal: controller.signal
      });

      if (pendingApproval !== undefined) {
        const approvalPrompt = renderApprovalPrompt(pendingApproval, adapter.kind === "telegram" ? "html" : "plain");
        await this.#deliverText(adapter,
          normalizedSessionKey,
          approvalPrompt,
          pendingApproval.approvalId === undefined
            ? adapter.kind === "telegram"
              ? { format: "html" }
              : undefined
            : {
                format: adapter.kind === "telegram" ? "html" : undefined,
                actions: renderPendingApprovalActions(pendingApproval)
              }
        );
        await adapter.send?.({
          conversationId: message.sessionKey.chatId,
          sessionKey: normalizedSessionKey,
          text: approvalPrompt
        });
      }

      terminalEventEmitted = true;
      const abortReason = this.#abortReasonByKey.get(activeTurnKey);
      if (abortReason !== undefined) {
        this.#abortReasonByKey.delete(activeTurnKey);
        const reason = abortReason === "channel-stop" ? "stop" : abortReason as "unknown" | "interrupt" | "stop" | "drain-timeout" | "stuck-loop";
        void this.#hookRegistry?.emit("session:turn:abort", {
          turnId: turnId ?? activeTurnKey,
          sessionKeyHash: sessionKeyHash(activeTurnKey),
          channel: message.channel,
          reason,
        });
      } else {
        void this.#hookRegistry?.emit("session:turn:complete", {
          turnId: turnId ?? activeTurnKey,
          sessionKeyHash: sessionKeyHash(activeTurnKey),
          channel: message.channel,
          durationMs: Date.now() - turnStartTime,
          replyTextLength: response.text.length,
        });
      }

      return { sessionId, replyText: response.text, artifactCount: response.artifacts.length, progressCount };
    } catch (turnErr) {
      // Classify abort vs runtime error
      const isAbort = controller.signal.aborted || this.#isAbortError(turnErr);
      await this.#abortStreamingText(streamHandle, isAbort ? "abort" : "error");
      sessionId = await this.#consumeRuntimeRotation({
        runtime,
        sessionKey: message.sessionKey,
        expectedSessionId: sessionId,
        activeTurnKey,
        turnId,
        receivedAt: message.receivedAt
      }) ?? sessionId;

      if (!isAbort && this.#runtimeCache !== undefined && runtime !== undefined) {
        try {
          await this.#runtimeCache.suspend(sessionId, "runtime-error");
        } catch (suspendErr) {
          this.#logWarning?.(
            `Runtime suspend failed for ${sessionId}: ${suspendErr instanceof Error ? suspendErr.message : String(suspendErr)}`
          );
        }
      }

      const errorText = turnErr instanceof Error
        ? `EstaCoda encountered an error: ${turnErr.message}`
        : "EstaCoda encountered an unexpected error.";

      try {
        await this.#deliverText(adapter, normalizedSessionKey, errorText);
      } catch {
        // Delivery failure is secondary; already in error path
      }

      terminalEventEmitted = true;
      if (isAbort) {
        const rawReason = this.#abortReasonByKey.get(activeTurnKey)
          ?? (controller.signal.reason as string | undefined)
          ?? "unknown";
        this.#abortReasonByKey.delete(activeTurnKey);
        const reason = rawReason === "channel-stop" ? "stop" : rawReason as "unknown" | "interrupt" | "stop" | "drain-timeout" | "stuck-loop";
        void this.#hookRegistry?.emit("session:turn:abort", {
          turnId: turnId ?? activeTurnKey,
          sessionKeyHash: sessionKeyHash(activeTurnKey),
          channel: message.channel,
          reason,
        });
      } else {
        const suspendedCache = !isAbort && this.#runtimeCache !== undefined && runtime !== undefined;
        void this.#hookRegistry?.emit("session:turn:error", {
          turnId: turnId ?? activeTurnKey,
          sessionId,
          sessionKeyHash: sessionKeyHash(activeTurnKey),
          channel: message.channel,
          ...sanitizeHookError(turnErr),
          suspendedCache,
        });
      }

      return { sessionId, replyText: errorText, artifactCount: 0, progressCount: 0 };
    } finally {
      // 1. End the active turn
      if (this.#activeTurnRegistry !== undefined && turnId !== undefined) {
        this.#activeTurnRegistry.endTurn(activeTurnKey, turnId);
      } else {
        if (this.#activeTurns.get(activeTurnKey) === controller) {
          this.#activeTurns.delete(activeTurnKey);
        }
      }

      // 2. Release runtime only if it was successfully acquired
      if (runtime !== undefined) {
        this.#activeRuntimeByTurnKey.delete(activeTurnKey);
        try {
          await runtime.dispose();
        } catch (disposeErr) {
          this.#logWarning?.(
            `Runtime dispose failed: ${disposeErr instanceof Error ? disposeErr.message : String(disposeErr)}`
          );
        }
      }

      // 3. Drain queued turns only if this turn actually started
      // Fire-and-owned: the completed turn must resolve its receive promise
      // independently of how long the queue takes to drain.
      if (turnStarted) {
        void this.#drainQueuedTurns(activeTurnKey).catch((err) => {
          this.#logWarning?.(
            `Drain queued turns failed for ${activeTurnKey}: ${
              err instanceof Error ? err.message : String(err)
            }`
          );
        });
      }
    }
  }

  async #runSessionHygiene(sessionId: string, signal: AbortSignal): Promise<Awaited<ReturnType<SessionHygieneService["run"]>> | undefined> {
    if (this.#sessionHygieneService === undefined || this.#isDraining?.()) {
      return;
    }

    try {
      const result = await this.#sessionHygieneService.run({ sessionId, signal });
      if (result.status === "failed") {
        this.#logWarning?.(`Gateway session hygiene skipped after failure for ${sessionId}: ${result.error}`);
      }
      return result;
    } catch (error) {
      this.#logWarning?.(
        `Gateway session hygiene failed for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`
      );
      return undefined;
    }
  }

  #hasActiveSubagentsForTurn(activeTurnKey: string): boolean {
    const runtime = this.#activeRuntimeByTurnKey.get(activeTurnKey);
    if (runtime?.hasActiveSubagents === undefined) {
      return false;
    }

    const activeSessionId = this.#activeTurnRegistry?.getTurn(activeTurnKey)?.metadata?.sessionId;
    const sessionId = typeof activeSessionId === "string"
      ? activeSessionId
      : this.#sessionIdByTurnKey.get(activeTurnKey);
    if (sessionId === undefined) {
      return false;
    }

    return runtime.hasActiveSubagents(sessionId);
  }

  #activeSubagentStatusLines(message: ChannelMessage, sessionId: string): string[] {
    const activeTurnKey = stableSessionKey(message.sessionKey, this.#sessionPolicy);
    const runtime = this.#activeRuntimeByTurnKey.get(activeTurnKey);
    const status = runtime?.activeSubagents?.(sessionId);
    if (status === undefined || status.activeCount === 0) {
      return [];
    }

    const lines = [
      `Active subagents: ${status.activeCount}`,
      ...status.subagents.map((subagent) => {
        const state = subagent.cancellationState === undefined
          ? subagent.status
          : `${subagent.status}/${subagent.cancellationState}`;
        const batch = subagent.batchId === undefined && subagent.taskIndex === undefined
          ? ""
          : ` ${formatGatewaySubagentBatch(subagent.batchId, subagent.taskIndex)}`;
        return [
          `- child ${subagent.childSessionId}`,
          `role ${subagent.role}`,
          `depth ${subagent.depth}`,
          `model ${subagent.provider}/${subagent.model}`,
          `status ${state}`,
          `duration ${formatGatewaySubagentDuration(subagent.durationMs)}${batch}`
        ].join(" | ");
      })
    ];
    if (status.omittedCount > 0) {
      lines.push(`- ${status.omittedCount} more active subagent(s) omitted`);
    }
    return lines;
  }

  async #consumeRuntimeRotation(input: {
    runtime: Runtime | undefined;
    sessionKey: ChannelSessionKey;
    expectedSessionId: string;
    activeTurnKey: string;
    turnId: string | undefined;
    receivedAt?: string;
  }): Promise<string | undefined> {
    const runtimeRotation = input.runtime?.consumeSessionRotation?.();
    if (runtimeRotation === undefined || runtimeRotation.originalSessionId !== input.expectedSessionId) {
      return undefined;
    }

    await this.#adoptSessionId(input.sessionKey, input.expectedSessionId, runtimeRotation.activeSessionId, {
      receivedAt: input.receivedAt,
      reason: "Runtime session rotation"
    });
    if (this.#activeTurnRegistry !== undefined && input.turnId !== undefined) {
      this.#activeTurnRegistry.updateTurn(input.activeTurnKey, input.turnId, {
        sessionId: runtimeRotation.activeSessionId
      });
    }
    return runtimeRotation.activeSessionId;
  }

  async #adoptSessionId(
    sessionKey: ChannelSessionKey,
    previousSessionId: string,
    nextSessionId: string,
    options: { receivedAt?: string; reason: string }
  ): Promise<void> {
    if (previousSessionId === nextSessionId) {
      return;
    }

    if (this.#sessionStore.setSessionId === undefined) {
      this.#logWarning?.(`${options.reason} could not update channel session pointer: session store does not support setSessionId`);
    } else {
      await this.#sessionStore.setSessionId(sessionKey, nextSessionId, { receivedAt: options.receivedAt });
    }

    const key = stableSessionKey(sessionKey, this.#sessionPolicy);
    const cachedSessionId = this.#sessionIdByTurnKey.get(key);
    const invalidateIds = uniqueStrings([
      previousSessionId,
      ...(cachedSessionId === undefined ? [] : [cachedSessionId])
    ]).filter((sessionId) => sessionId !== nextSessionId);
    for (const sessionId of invalidateIds) {
      try {
        await this.#runtimeCache?.invalidate(sessionId);
      } catch (error) {
        this.#logWarning?.(
          `${options.reason} cache invalidate failed for ${sessionId}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }
    this.#sessionIdByTurnKey.set(key, nextSessionId);
  }

  async #drainQueuedTurns(activeTurnKey: string): Promise<void> {
    if (this.#drainingQueue.has(activeTurnKey)) {
      return;
    }

    while (true) {
      if (this.#drainingQueue.has(activeTurnKey)) {
        return;
      }

      const queued = this.#sessionMessageQueue.dequeue(activeTurnKey);
      if (queued === undefined) {
        return;
      }

      this.#drainingQueue.add(activeTurnKey);

      let adapter: ChannelAdapter;
      try {
        adapter = this.#adapterFor(queued.channelKind);
      } catch {
        this.#logWarning?.(`No adapter found for channel kind ${queued.channelKind}; dropping queued message`);
        this.#drainingQueue.delete(activeTurnKey);
        continue;
      }

      // Launch turn. #processTurn registers the active turn synchronously
      // before its first await, so we can clear the guard immediately.
      const turnPromise = this.#processTurn(queued.message, adapter);

      // Clear guard NOW, before awaiting. The active turn is already registered.
      this.#drainingQueue.delete(activeTurnKey);

      let result: ChannelGatewayResult;
      try {
        result = await turnPromise;
      } catch (err) {
        this.#logWarning?.(`Queued turn failed for ${activeTurnKey}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }

      // If the turn didn't actually start (busy race), re-enqueue and stop draining
      if (result.sessionId === "") {
        this.#sessionMessageQueue.unshift(
          activeTurnKey,
          queued.message,
          queued.policyAtArrival,
          queued.queueDepthAtArrival
        );
        return;
      }

      // Turn completed successfully. Loop to drain the next queued message.
    }
  }

  async #acquireRuntime(
    sessionId: string,
    securityPolicy: SecurityPolicy,
    message: ChannelMessage,
    normalizedSessionKey: ChannelSessionKey
  ): Promise<Runtime> {
    if (this.#runtimeCache !== undefined && this.#runtimeFingerprint !== undefined) {
      return this.#runtimeCache.get(
        sessionId,
        this.#runtimeFingerprint,
        securityPolicy,
        {
          surfaceType: message.sessionKey.platform,
          chatId: message.sessionKey.chatId,
          userId: message.sender.id,
          sessionId,
          origin: message.text.startsWith("/") ? "command" : "message"
        }
      );
    }

    if (this.#runtimeCache !== undefined && this.#runtimeFingerprint === undefined) {
      this.#logWarning?.("runtimeCache provided without runtimeFingerprint; falling back to runtimeForSession");
    }

    return this.#runtimeForSession({
      sessionId,
      sessionKey: normalizedSessionKey,
      channel: message.channel,
      securityPolicy,
      metadata: {
        surfaceType: message.sessionKey.platform,
        chatId: message.sessionKey.chatId,
        userId: message.sender.id,
        sessionId,
        origin: message.text.startsWith("/") ? "command" : "message"
      }
    });
  }

  async #runtimeForSessionCommand(message: ChannelMessage, sessionId: string): Promise<Runtime> {
    const normalizedSessionKey = normalizeSessionKey(message.sessionKey, this.#sessionPolicy);
    return this.#runtimeForSession({
      sessionId,
      sessionKey: normalizedSessionKey,
      channel: message.channel,
      securityPolicy: this.#securityPolicyFor(
        normalizedSessionKey,
        sessionId,
        await this.#approvalStore.listForSession(normalizedSessionKey)
      ),
      metadata: {
        surfaceType: message.sessionKey.platform,
        chatId: message.sessionKey.chatId,
        userId: message.sender.id,
        sessionId,
        origin: "command"
      }
    });
  }

  async #handleModelCommand(
    message: ChannelMessage,
    adapter: ChannelAdapter,
    command: GatewayModelCommand,
    deliveryOptions?: ChannelTextOptions
  ): Promise<ChannelGatewayResult> {
    const sessionId = await this.#sessionStore.getOrCreateSessionId(message.sessionKey, { receivedAt: message.receivedAt });
    this.#sessionIdByTurnKey.set(stableSessionKey(message.sessionKey, this.#sessionPolicy), sessionId);

    if (command.kind === "show") {
      return this.#showModelPicker(message, adapter, sessionId, deliveryOptions);
    }

    if (command.kind === "cancel") {
      const text = "Model selection canceled.";
      await this.#deliverText(adapter, message.sessionKey, text, deliveryOptions);
      return { sessionId, replyText: text, artifactCount: 0, progressCount: 0 };
    }

    if (command.kind === "clear") {
      if (command.scope === "global") {
        const text = [
          "Clearing the global primary model is not supported from /model --global.",
          "Use estacoda model setup from a terminal to choose a new primary model."
        ].join("\n");
        await this.#deliverText(adapter, message.sessionKey, text, deliveryOptions);
        return { sessionId, replyText: text, artifactCount: 0, progressCount: 0 };
      }

      const runtime = await this.#runtimeForSessionCommand(message, sessionId);
      try {
        await runtime.sessionDb.clearSessionModelOverride(sessionId);
      } finally {
        await runtime.dispose();
      }
      await this.#refreshCachedRuntimePolicy(sessionId, "Gateway model override clear");
      const text = [
        "Session model override cleared.",
        "Scope: session",
        "Future gateway turns will use the configured primary route."
      ].join("\n");
      await this.#deliverText(adapter, message.sessionKey, text, deliveryOptions);
      return { sessionId, replyText: text, artifactCount: 0, progressCount: 0 };
    }

    if (command.modelInput.trim().length === 0) {
      const text = command.scope === "global"
        ? "Usage: /model --global <provider>/<model>\nAlso accepted: /model set --global <provider>/<model>"
        : "Usage: /model <provider>/<model>\nAlso accepted: /model set <provider>/<model>";
      await this.#deliverText(adapter, message.sessionKey, text, deliveryOptions);
      return { sessionId, replyText: text, artifactCount: 0, progressCount: 0 };
    }

    const context = await this.#loadModelSwitchContext();
    if (context === undefined) {
      const text = "Gateway model switching is unavailable in this process.";
      await this.#deliverText(adapter, message.sessionKey, text, deliveryOptions);
      return { sessionId, replyText: text, artifactCount: 0, progressCount: 0 };
    }

    if (command.scope === "session" && !command.modelInput.includes("/")) {
      const flow = await this.#createGatewayModelFlow(context);
      const provider = (await flow.listProviderCandidates()).find((candidate) => candidate.id === command.modelInput.trim());
      if (provider !== undefined) {
        return this.#showModelProviderPicker(message, adapter, sessionId, provider.id, 0, deliveryOptions);
      }
    }

    const resolution = await resolveModelSwitchRequest({
      modelInput: command.modelInput,
      source: "gateway"
    }, context);
    if (!resolution.ok) {
      const text = `${resolution.message}\n${resolution.guidance}`;
      await this.#deliverText(adapter, message.sessionKey, text, deliveryOptions);
      return { sessionId, replyText: text, artifactCount: 0, progressCount: 0 };
    }

    if (command.scope === "global") {
      const trustProof = await this.#proveWorkspaceTrustForGlobalModelWrite(message, sessionId);
      if (!trustProof.ok) {
        const text = [
          "Global model changes require an authorized channel and a trusted workspace/profile.",
          `Run estacoda model setup ${resolution.route.provider} from a terminal to change the profile primary model.`
        ].join("\n");
        await this.#deliverText(adapter, message.sessionKey, text, deliveryOptions);
        return { sessionId, replyText: text, artifactCount: 0, progressCount: 0 };
      }

      if (context.homeDir === undefined) {
        const text = [
          "Gateway cannot prove the profile config location for a safe global model write.",
          `Run estacoda model setup ${resolution.route.provider} from a terminal to change the profile primary model.`
        ].join("\n");
        await this.#deliverText(adapter, message.sessionKey, text, deliveryOptions);
        return { sessionId, replyText: text, artifactCount: 0, progressCount: 0 };
      }

      const targetPath = resolveProfileStateHome({ homeDir: context.homeDir, profileId: this.#profileId }).configPath;
      await saveRuntimeConfig(targetPath, applyModelSwitchPrimaryRoute(context.config, resolution.route));
      const runtime = await this.#runtimeForSessionCommand(message, sessionId);
      try {
        await runtime.sessionDb.clearSessionModelOverride(sessionId);
      } finally {
        await runtime.dispose();
      }
      await this.#refreshAllCachedRuntimes("Gateway global model set");

      const text = [
        `Global primary model set: ${resolution.displayName}`,
        "Scope: global",
        "Fallback routes remain unchanged."
      ].join("\n");
      await this.#deliverText(adapter, message.sessionKey, text, deliveryOptions);
      return { sessionId, replyText: text, artifactCount: 0, progressCount: 0 };
    }

    const runtime = await this.#runtimeForSessionCommand(message, sessionId);
    try {
      await runtime.sessionDb.setSessionModelOverride(sessionId, resolution.override);
    } finally {
      await runtime.dispose();
    }
    await this.#refreshCachedRuntimePolicy(sessionId, "Gateway model override set");

    const text = [
      `Session model override set: ${resolution.displayName}`,
      "Scope: session",
      "Fallback routes remain unchanged."
    ].join("\n");
    await this.#deliverText(adapter, message.sessionKey, text, deliveryOptions);
    return { sessionId, replyText: text, artifactCount: 0, progressCount: 0 };
  }

  async #handleModelPickerSelectCallback(
    message: ChannelMessage,
    adapter: ChannelAdapter,
    sessionId: string,
    modelInput: string,
    deliveryOptions?: ChannelTextOptions
  ): Promise<ChannelGatewayResult> {
    const context = await this.#loadModelSwitchContext();
    if (context === undefined) {
      const text = "Run /model again.";
      await this.#deliverText(adapter, message.sessionKey, text, modelPickerFinalDeliveryOptions(message, deliveryOptions));
      return { sessionId, replyText: text, artifactCount: 0, progressCount: 0 };
    }

    const resolution = await resolveModelSwitchRequest({
      modelInput,
      source: "gateway"
    }, context);
    if (!resolution.ok) {
      const text = "Run /model again.";
      await this.#deliverText(adapter, message.sessionKey, text, modelPickerFinalDeliveryOptions(message, deliveryOptions));
      return { sessionId, replyText: text, artifactCount: 0, progressCount: 0 };
    }

    const runtime = await this.#runtimeForSessionCommand(message, sessionId);
    try {
      await runtime.sessionDb.setSessionModelOverride(sessionId, resolution.override);
    } finally {
      await runtime.dispose();
    }
    await this.#refreshCachedRuntimePolicy(sessionId, "Gateway model override set");

    const flow = await this.#createGatewayModelFlow(context);
    const providers = await flow.listProviderCandidates();
    const provider = providers.find((candidate) => candidate.id === resolution.route.provider);
    const text = [
      "**Model Configuration**",
      `Current model: ${resolution.route.id}`,
      `Provider: ${provider?.displayName ?? resolution.route.provider}`,
      "Session override updated."
    ].join("\n");
    await this.#deliverText(adapter, message.sessionKey, text, modelPickerFinalDeliveryOptions(message, deliveryOptions));
    return { sessionId, replyText: text, artifactCount: 0, progressCount: 0 };
  }

  async #handleModelPickerClearCallback(
    message: ChannelMessage,
    adapter: ChannelAdapter,
    sessionId: string,
    deliveryOptions?: ChannelTextOptions
  ): Promise<ChannelGatewayResult> {
    const runtime = await this.#runtimeForSessionCommand(message, sessionId);
    try {
      await runtime.sessionDb.clearSessionModelOverride(sessionId);
    } finally {
      await runtime.dispose();
    }
    await this.#refreshCachedRuntimePolicy(sessionId, "Gateway model override clear");

    const text = [
      "**Model Configuration**",
      "Session model override cleared.",
      "Future gateway turns will use the configured primary route."
    ].join("\n");
    await this.#deliverText(adapter, message.sessionKey, text, modelPickerFinalDeliveryOptions(message, deliveryOptions));
    return { sessionId, replyText: text, artifactCount: 0, progressCount: 0 };
  }

  async #proveWorkspaceTrustForGlobalModelWrite(
    message: ChannelMessage,
    sessionId: string
  ): Promise<{ ok: true } | { ok: false }> {
    let runtime: Runtime | undefined;
    try {
      runtime = await this.#runtimeForSessionCommand(message, sessionId);
      return await runtime.isWorkspaceTrusted() ? { ok: true } : { ok: false };
    } catch (error) {
      this.#logWarning?.(
        `Gateway global model trust proof failed for ${sessionId}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return { ok: false };
    } finally {
      await runtime?.dispose();
    }
  }

  async #showModelPicker(
    message: ChannelMessage,
    adapter: ChannelAdapter,
    sessionId: string,
    deliveryOptions?: ChannelTextOptions
  ): Promise<ChannelGatewayResult> {
    const context = await this.#loadModelSwitchContext();
    if (context === undefined) {
      const text = "Gateway model switching is unavailable in this process.";
      await this.#deliverText(adapter, message.sessionKey, text, deliveryOptions);
      return { sessionId, replyText: text, artifactCount: 0, progressCount: 0 };
    }

    const flow = await this.#createGatewayModelFlow(context);
    const providers = await flow.listProviderCandidates();
    const choices = providers.map((provider) => ({
      label: provider.displayName,
      actionKey: modelPickerProviderActionKey(provider.id),
      kind: "provider" as const
    }));
    const renderedChoices = choices.slice(0, MODEL_PICKER_MAX_CHOICE_ACTIONS);
    const truncated = choices.length > renderedChoices.length;
    const currentModel = await this.#describeCurrentModelSelection(sessionId, message, context);
    const currentModelLines = renderModelPickerCurrentLines(currentModel, providers);

    const text = providers.length === 0
      ? [
          "No configured runnable model providers are available for this gateway session.",
          "Run estacoda model setup from a terminal to configure credentials."
        ].join("\n")
      : [
          "**Model Configuration**",
          ...currentModelLines,
          "Select a provider:",
          truncated
            ? `Showing ${renderedChoices.length} of ${providers.length} providers.`
            : undefined
        ].filter((line) => line !== undefined).join("\n");
    await this.#deliverText(
      adapter,
      message.sessionKey,
      text,
      modelPickerDeliveryOptions(message, choices.length === 0 ? undefined : [
        ...renderModelPickerActions(renderedChoices, { columns: 2 }),
        ...modelPickerProviderControlRows()
      ], deliveryOptions)
    );
    return { sessionId, replyText: text, artifactCount: 0, progressCount: 0 };
  }

  async #showModelProviderPicker(
    message: ChannelMessage,
    adapter: ChannelAdapter,
    sessionId: string,
    providerId: string,
    page = 0,
    deliveryOptions?: ChannelTextOptions
  ): Promise<ChannelGatewayResult> {
    const context = await this.#loadModelSwitchContext();
    if (context === undefined) {
      const text = "Gateway model switching is unavailable in this process.";
      await this.#deliverText(adapter, message.sessionKey, text, deliveryOptions);
      return { sessionId, replyText: text, artifactCount: 0, progressCount: 0 };
    }

    const flow = await this.#createGatewayModelFlow(context);
    const providers = await flow.listProviderCandidates();
    const provider = providers.find((candidate) => candidate.id === providerId);
    if (provider === undefined) {
      const text = [
        `Model provider is not available: ${providerId}`,
        "Run /model to see configured runnable providers."
      ].join("\n");
      await this.#deliverText(adapter, message.sessionKey, text, deliveryOptions);
      return { sessionId, replyText: text, artifactCount: 0, progressCount: 0 };
    }

    const models = await this.#listRunnableModelChoices(flow, provider.id);
    const choices = models.map((model) => ({
      label: model.id,
      actionKey: modelPickerSelectActionKey(model.provider, model.id),
      kind: "select" as const
    }));
    const totalPages = Math.max(1, Math.ceil(choices.length / MODEL_PICKER_MODEL_PAGE_SIZE));
    const safePage = clampModelPickerPage(page, totalPages);
    const start = safePage * MODEL_PICKER_MODEL_PAGE_SIZE;
    const renderedChoices = choices.slice(start, start + MODEL_PICKER_MODEL_PAGE_SIZE);
    const end = start + renderedChoices.length;

    const text = choices.length === 0
      ? [
          `No runnable models are configured for ${provider.displayName}.`,
          `Run estacoda model setup ${provider.id} from a terminal.`
        ].join("\n")
      : [
          "**Model Configuration**",
          `Provider: ${provider.displayName} (${start + 1}-${end} of ${choices.length})`,
          "Select a model:"
        ].filter((line) => line !== undefined).join("\n");

    await this.#deliverText(
      adapter,
      message.sessionKey,
      text,
      modelPickerDeliveryOptions(message, choices.length === 0 ? undefined : [
        ...renderModelPickerActions(renderedChoices, {
          columns: 2,
          maxChoices: MODEL_PICKER_MODEL_PAGE_SIZE
        }),
        ...modelPickerModelNavigationRows(provider.id, safePage, totalPages)
      ], deliveryOptions)
    );
    return { sessionId, replyText: text, artifactCount: 0, progressCount: 0 };
  }

  async #createGatewayModelFlow(context: ModelSwitchContext) {
    return createProviderModelSelectionFlow({
      config: context.config,
      providerRegistry: context.providerRegistry,
      homeDir: context.homeDir,
      modelsDevOptions: context.modelsDevOptions,
      allowNetwork: false,
      mode: "normal"
    });
  }

  async #listRunnableModelChoices(
    flow: Awaited<ReturnType<typeof createProviderModelSelectionFlow>>,
    providerId: string
  ) {
    const models = await flow.listModelCandidates(providerId);
    return models
      .filter((model) => model.executable && !model.catalogOnly)
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  async #describeCurrentModelSelection(
    sessionId: string,
    message: ChannelMessage,
    context: ModelSwitchContext
  ): Promise<string> {
    let runtime: Runtime | undefined;
    try {
      runtime = await this.#runtimeForSessionCommand(message, sessionId);
      const stored = await runtime.sessionDb.getSessionModelOverride(sessionId);
      const effective = await resolveEffectiveSessionModelOverride(stored, context);
      if (effective?.ok === true) {
        return `${effective.route.provider}/${effective.route.id} (session)`;
      }
    } catch (error) {
      this.#logWarning?.(
        `Gateway model picker current override read failed for ${sessionId}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    } finally {
      await runtime?.dispose();
    }

    const provider = context.config.model?.provider;
    const id = context.config.model?.id;
    return provider !== undefined && id !== undefined ? `${provider}/${id} (global)` : "not configured";
  }

  async #resolveProviderActionKey(actionKey: string, context: ModelSwitchContext): Promise<string | undefined> {
    const flow = await this.#createGatewayModelFlow(context);
    const matches = (await flow.listProviderCandidates())
      .filter((provider) => modelPickerProviderActionKey(provider.id) === actionKey);
    return matches.length === 1 ? matches[0]?.id : undefined;
  }

  async #resolveModelActionKey(actionKey: string, context: ModelSwitchContext): Promise<string | undefined> {
    const flow = await this.#createGatewayModelFlow(context);
    const providers = await flow.listProviderCandidates();
    const matches: string[] = [];
    for (const provider of providers) {
      const models = await this.#listRunnableModelChoices(flow, provider.id);
      for (const model of models) {
        if (modelPickerSelectActionKey(model.provider, model.id) === actionKey) {
          matches.push(`${model.provider}/${model.id}`);
        }
      }
    }
    return matches.length === 1 ? matches[0] : undefined;
  }

  async #resolvePageActionKey(
    actionKey: string,
    context: ModelSwitchContext
  ): Promise<{ providerId: string; page: number } | undefined> {
    const flow = await this.#createGatewayModelFlow(context);
    const providers = await flow.listProviderCandidates();
    const matches: Array<{ providerId: string; page: number }> = [];
    for (const provider of providers) {
      const models = await this.#listRunnableModelChoices(flow, provider.id);
      const totalPages = Math.max(1, Math.ceil(models.length / MODEL_PICKER_MODEL_PAGE_SIZE));
      for (let page = 0; page < totalPages; page += 1) {
        if (modelPickerPageActionKey(provider.id, page) === actionKey) {
          matches.push({ providerId: provider.id, page });
        }
      }
    }
    return matches.length === 1 ? matches[0] : undefined;
  }

  async #loadModelSwitchContext(): Promise<ModelSwitchContext | undefined> {
    if (this.#modelSwitchContext === undefined) {
      return undefined;
    }

    return this.#modelSwitchContext();
  }

  #isAbortError(err: unknown): boolean {
    if (err instanceof Error) {
      return err.name === "AbortError" ||
             err.message.includes("aborted") ||
             err.message.includes("cancel");
    }
    return false;
  }

  async #handleCommand(message: ChannelMessage, adapter: ChannelAdapter): Promise<ChannelGatewayResult | undefined> {
    const approvalAction = parseApprovalAction(message.text);
    if (approvalAction !== undefined) {
      if (approvalAction.decision === "approved") {
        return this.#approvePending(message, adapter, {
          approvalId: approvalAction.approvalId,
          scope: approvalAction.scope
        });
      }

      return this.#denyPending(message, adapter, {
        approvalId: approvalAction.approvalId
      });
    }

    const modelAction = parseModelPickerAction(message.text);
    if (modelAction !== undefined) {
      const sessionId = await this.#sessionStore.getOrCreateSessionId(message.sessionKey, { receivedAt: message.receivedAt });
      const pickerDeliveryOptions = modelPickerDeliveryOptions(message);
      if (!modelAction.ok) {
        const text = "Run /model again.";
        await this.#deliverText(adapter, message.sessionKey, text, modelPickerFinalDeliveryOptions(message, pickerDeliveryOptions));
        return { sessionId, replyText: text, artifactCount: 0, progressCount: 0 };
      }

      if (modelAction.action.kind === "provider") {
        const context = await this.#loadModelSwitchContext();
        const providerId = context === undefined
          ? undefined
          : await this.#resolveProviderActionKey(modelAction.action.actionKey, context);
        if (providerId === undefined) {
          const text = "Run /model again.";
          await this.#deliverText(adapter, message.sessionKey, text, modelPickerFinalDeliveryOptions(message, pickerDeliveryOptions));
          return { sessionId, replyText: text, artifactCount: 0, progressCount: 0 };
        }
        return this.#showModelProviderPicker(message, adapter, sessionId, providerId, 0, pickerDeliveryOptions);
      }

      if (modelAction.action.kind === "page") {
        const context = await this.#loadModelSwitchContext();
        const pageTarget = context === undefined
          ? undefined
          : await this.#resolvePageActionKey(modelAction.action.actionKey, context);
        if (pageTarget === undefined) {
          const text = "Run /model again.";
          await this.#deliverText(adapter, message.sessionKey, text, modelPickerFinalDeliveryOptions(message, pickerDeliveryOptions));
          return { sessionId, replyText: text, artifactCount: 0, progressCount: 0 };
        }
        return this.#showModelProviderPicker(message, adapter, sessionId, pageTarget.providerId, pageTarget.page, pickerDeliveryOptions);
      }

      if (modelAction.action.kind === "back") {
        return this.#showModelPicker(message, adapter, sessionId, pickerDeliveryOptions);
      }

      if (modelAction.action.kind === "select") {
        const context = await this.#loadModelSwitchContext();
        const modelInput = context === undefined
          ? undefined
          : await this.#resolveModelActionKey(modelAction.action.actionKey, context);
        if (modelInput === undefined) {
          const text = "Run /model again.";
          await this.#deliverText(adapter, message.sessionKey, text, modelPickerFinalDeliveryOptions(message, pickerDeliveryOptions));
          return { sessionId, replyText: text, artifactCount: 0, progressCount: 0 };
        }
        return this.#handleModelPickerSelectCallback(message, adapter, sessionId, modelInput, pickerDeliveryOptions);
      }

      if (modelAction.action.kind === "clear") {
        return this.#handleModelPickerClearCallback(message, adapter, sessionId, pickerDeliveryOptions);
      }

      const text = "Model selection canceled.";
      await this.#deliverText(adapter, message.sessionKey, text, modelPickerFinalDeliveryOptions(message, pickerDeliveryOptions));
      return { sessionId, replyText: text, artifactCount: 0, progressCount: 0 };
    }

    const modelCommand = parseGatewayModelCommand(message.text);
    if (modelCommand !== undefined) {
      return this.#handleModelCommand(message, adapter, modelCommand);
    }

    const voiceCommand = parseGatewayVoiceCommand(message.text);
    if (voiceCommand !== undefined) {
      return this.#handleVoiceCommand(message, adapter, voiceCommand);
    }

    const command = parseGatewayCommand(message.text);

    if (command === undefined) {
      return undefined;
    }

    if (command === "/help") {
      const text = [
        "EstaCoda channel commands",
        "/help - show this help",
        "/status - show the active channel session",
        "/model - choose a session model",
        "/model <provider>/<model> - set the model for this session",
        "/model clear - clear this session model override",
        "/memory [mode|populate|review|apply|reject|undo|forget|recent|edit|clear] - inspect and manage memory curation",
        "/sessions - list recent sessions for this chat",
        "/switch <session-id> - switch this chat to a specific session",
        "/search <query> - search session history",
        "/compact [topic] - compact this session context",
        "/new - start a fresh session",
        "/reset - alias for /new",
        "/reload-mcp - reload MCP config for future turns in this chat",
        "/trust - trust this workspace for local read/write work",
        "/untrust - revoke workspace trust for this chat session",
        "/workspace.trust.status - show current workspace trust state",
        "/voice on|all|off|status - control voice reply mode for this chat",
        "/yolo - toggle YOLO/open mode for this chat session",
        "/cron <command> - manage scheduled tasks",
        "/commands - show the Telegram command menu",
        "/resume - show the latest interrupted-turn resume note",
        "/approve [once|session|always] - approve the pending gated action",
        "/deny - deny the pending gated action",
        "/approvals - inspect current approval state",
        "/revoke <approval-id> - revoke a persistent approval",
        "/attach <code> - attach this chat to a CLI session via handoff code",
        "/detach - detach this chat from the linked CLI session",
        "/sethome [local|clear] - set default delivery target for this chat",
        "/diagnostics - show gateway health and config",
        "/stop - stop the foreground gateway process"
      ].join("\n");
      await this.#deliverText(adapter, message.sessionKey, text);

      return {
        sessionId: await this.#sessionStore.getOrCreateSessionId(message.sessionKey, { receivedAt: message.receivedAt }),
        replyText: text,
        artifactCount: 0,
        progressCount: 0
      };
    }

    if (command === "/status") {
      const sessionId = await this.#sessionStore.getOrCreateSessionId(message.sessionKey, { receivedAt: message.receivedAt });
      const pointer = this.#surfacePointerStore !== undefined
        ? await this.#surfacePointerStore.getPointer(message.sessionKey.platform as SurfaceType, message.sessionKey.chatId)
        : undefined;
      const text = [
        "EstaCoda channel status",
        `Channel: ${message.channel}`,
        `Chat: ${message.sessionKey.chatId}`,
        `Session: ${sessionId}`,
        pointer !== undefined ? `Attached to: ${pointer.sessionId} (since ${pointer.attachedAt})` : "Session: independent",
        pointer?.homeDelivery !== undefined ? `Home delivery: ${pointer.homeDelivery}` : undefined,
        `YOLO mode: ${this.#isYoloEnabled(message.sessionKey, sessionId) ? "on" : "off"}`,
        ...this.#activeSubagentStatusLines(message, sessionId)
      ].filter((line) => line !== undefined).join("\n");
      await this.#deliverText(adapter, message.sessionKey, text);

      return {
        sessionId,
        replyText: text,
        artifactCount: 0,
        progressCount: 0
      };
    }

    if (command === "/yolo") {
      const sessionId = await this.#sessionStore.getOrCreateSessionId(message.sessionKey, { receivedAt: message.receivedAt });
      const enabled = this.#toggleYolo(message.sessionKey, sessionId);
      const text = enabled
        ? "⚡ YOLO mode ON — EstaCoda will auto-approve eligible actions for this chat session. Hard safety blocks still apply."
        : `⚠ YOLO mode OFF — risky actions will use ${this.#securityMode} approval mode.`;
      await this.#deliverText(adapter, message.sessionKey, text);

      return {
        sessionId,
        replyText: text,
        artifactCount: 0,
        progressCount: 0
      };
    }

    if (command === "/attach") {
      const code = message.text.trim().split(/\s+/u)[1];
      if (code === undefined || code.length === 0) {
        const text = "Usage: /attach <handoff-code>";
        await this.#deliverText(adapter, message.sessionKey, text);
        return {
          sessionId: await this.#sessionStore.getOrCreateSessionId(message.sessionKey, { receivedAt: message.receivedAt }),
          replyText: text,
          artifactCount: 0,
          progressCount: 0
        };
      }

      if (this.#handoffStore === undefined || this.#surfacePointerStore === undefined) {
        const text = "Handoff is not configured on this gateway.";
        await this.#deliverText(adapter, message.sessionKey, text);
        return {
          sessionId: await this.#sessionStore.getOrCreateSessionId(message.sessionKey, { receivedAt: message.receivedAt }),
          replyText: text,
          artifactCount: 0,
          progressCount: 0
        };
      }

      const result = await this.#handoffStore.redeem({
        code,
        surfaceType: message.sessionKey.platform,
        surfaceId: message.sessionKey.chatId
      });

      if (!result.ok) {
        const text = `Attach failed: ${result.reason}`;
        await this.#deliverText(adapter, message.sessionKey, text);
        return {
          sessionId: await this.#sessionStore.getOrCreateSessionId(message.sessionKey, { receivedAt: message.receivedAt }),
          replyText: text,
          artifactCount: 0,
          progressCount: 0
        };
      }

      await this.#surfacePointerStore.setPointer(
        message.sessionKey.platform as SurfaceType,
        message.sessionKey.chatId,
        { sessionId: result.handoff.sessionId, attachedAt: new Date().toISOString() }
      );

      const text = [
        "Attached this chat to session.",
        `Session: ${result.handoff.sessionId}`,
        "This chat now shares context with that session. Use /detach to return to an independent session."
      ].join("\n");
      await this.#deliverText(adapter, message.sessionKey, text);

      return {
        sessionId: result.handoff.sessionId,
        replyText: text,
        artifactCount: 0,
        progressCount: 0
      };
    }

    if (command === "/detach") {
      if (this.#surfacePointerStore === undefined) {
        const text = "Handoff is not configured on this gateway.";
        await this.#deliverText(adapter, message.sessionKey, text);
        return {
          sessionId: await this.#sessionStore.getOrCreateSessionId(message.sessionKey, { receivedAt: message.receivedAt }),
          replyText: text,
          artifactCount: 0,
          progressCount: 0
        };
      }

      const pointer = await this.#surfacePointerStore.getPointer(message.sessionKey.platform as SurfaceType, message.sessionKey.chatId);
      if (pointer === undefined) {
        const text = "This chat is not attached to any session.";
        await this.#deliverText(adapter, message.sessionKey, text);
        return {
          sessionId: await this.#sessionStore.getOrCreateSessionId(message.sessionKey, { receivedAt: message.receivedAt }),
          replyText: text,
          artifactCount: 0,
          progressCount: 0
        };
      }

      await this.#surfacePointerStore.removePointer(message.sessionKey.platform as SurfaceType, message.sessionKey.chatId);

      // After detach, get the new independent session id
      const newSessionId = await this.#sessionStore.getOrCreateSessionId(message.sessionKey, { receivedAt: message.receivedAt });
      const key = stableSessionKey(message.sessionKey, this.#sessionPolicy);
      const previousSessionId = this.#sessionIdByTurnKey.get(key);
      if (previousSessionId !== undefined && previousSessionId !== newSessionId) {
        try {
          await this.#runtimeCache?.invalidate(previousSessionId);
        } catch (err) {
          this.#logWarning?.(`Session detach cache invalidate failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      this.#sessionIdByTurnKey.set(key, newSessionId);
      const text = [
        "Detached this chat from the linked session.",
        `Previous session: ${pointer.sessionId}`,
        `Current session: ${newSessionId}`,
        "This chat now operates independently."
      ].join("\n");
      await this.#deliverText(adapter, message.sessionKey, text);

      return {
        sessionId: newSessionId,
        replyText: text,
        artifactCount: 0,
        progressCount: 0
      };
    }

    if (command === "/sethome") {
      const sessionId = await this.#sessionStore.getOrCreateSessionId(message.sessionKey, { receivedAt: message.receivedAt });
      if (this.#surfacePointerStore === undefined) {
        const text = "Surface pointers are not configured on this gateway.";
        await this.#deliverText(adapter, message.sessionKey, text);
        return {
          sessionId,
          replyText: text,
          artifactCount: 0,
          progressCount: 0
        };
      }

      const arg = message.text.trim().split(/\s+/u)[1];
      const pointer = await this.#surfacePointerStore.getPointer(message.sessionKey.platform as SurfaceType, message.sessionKey.chatId);
      const base = pointer ?? { sessionId, attachedAt: new Date().toISOString() };

      if (arg === "clear") {
        const { homeDelivery: _, ...rest } = base;
        await this.#surfacePointerStore.setPointer(message.sessionKey.platform as SurfaceType, message.sessionKey.chatId, rest);
        const text = "Cleared home delivery target for this chat.";
        await this.#deliverText(adapter, message.sessionKey, text);
        return { sessionId, replyText: text, artifactCount: 0, progressCount: 0 };
      }

      const homeDelivery = arg === "local" ? "local" : `${message.sessionKey.platform}:${message.sessionKey.chatId}`;
      await this.#surfacePointerStore.setPointer(message.sessionKey.platform as SurfaceType, message.sessionKey.chatId, {
        ...base,
        homeDelivery
      });
      const text = `Set home delivery target for this chat to ${homeDelivery}.`;
      await this.#deliverText(adapter, message.sessionKey, text);
      return { sessionId, replyText: text, artifactCount: 0, progressCount: 0 };
    }

    if (command === "/diagnostics") {
      const sessionId = await this.#sessionStore.getOrCreateSessionId(message.sessionKey, { receivedAt: message.receivedAt });
      const text = this.#diagnostics !== undefined
        ? await this.#diagnostics()
        : [
            "EstaCoda gateway diagnostics",
            "No diagnostics provider configured.",
            `Registered adapters: ${[...this.#adapters.keys()].join(", ") || "none"}`
          ].join("\n");
      await this.#deliverText(adapter, message.sessionKey, text);
      return { sessionId, replyText: text, artifactCount: 0, progressCount: 0 };
    }

    if (command === "/cron") {
      const sessionId = await this.#sessionStore.getOrCreateSessionId(message.sessionKey, { receivedAt: message.receivedAt });
      const result = await runCronCommand({
        args: tokenizeCommandArgs(message.text).slice(1),
        store: new CronStore(),
        origin: originFromSessionKey(message.sessionKey, message.channel),
        defaultDelivery: "origin"
      });
      await this.#deliverText(adapter, message.sessionKey, result.output);

      return {
        sessionId,
        replyText: result.output,
        artifactCount: 0,
        progressCount: 0
      };
    }

    if (command === "/trust" || command === "/workspace.trust.grant") {
      const sessionId = await this.#sessionStore.getOrCreateSessionId(message.sessionKey, { receivedAt: message.receivedAt });
      const normalizedSessionKey = normalizeSessionKey(message.sessionKey, this.#sessionPolicy);
      const runtime = await this.#runtimeForSession({
        sessionId,
        sessionKey: normalizedSessionKey,
        channel: message.channel,
        securityPolicy: this.#securityPolicyFor(
          normalizedSessionKey,
          sessionId,
          await this.#approvalStore.listForSession(normalizedSessionKey)
        )
      });
      try {
        await runtime.trustWorkspace();
        const text = "Workspace trusted. EstaCoda will proceed with normal local work here.";
        await this.#deliverText(adapter, message.sessionKey, text);
        return {
          sessionId,
          replyText: text,
          artifactCount: 0,
          progressCount: 0
        };
      } finally {
        await runtime.dispose();
      }
    }

    if (command === "/untrust" || command === "/workspace.trust.revoke") {
      const sessionId = await this.#sessionStore.getOrCreateSessionId(message.sessionKey, { receivedAt: message.receivedAt });
      const normalizedSessionKey = normalizeSessionKey(message.sessionKey, this.#sessionPolicy);
      const runtime = await this.#runtimeForSession({
        sessionId,
        sessionKey: normalizedSessionKey,
        channel: message.channel,
        securityPolicy: this.#securityPolicyFor(
          normalizedSessionKey,
          sessionId,
          await this.#approvalStore.listForSession(normalizedSessionKey)
        )
      });
      try {
        await runtime.revokeWorkspaceTrust();
        const text = "Workspace trust revoked. EstaCoda will ask before workspace writes here.";
        await this.#deliverText(adapter, message.sessionKey, text);
        return {
          sessionId,
          replyText: text,
          artifactCount: 0,
          progressCount: 0
        };
      } finally {
        await runtime.dispose();
      }
    }

    if (command === "/workspace.trust.status") {
      const sessionId = await this.#sessionStore.getOrCreateSessionId(message.sessionKey, { receivedAt: message.receivedAt });
      const normalizedSessionKey = normalizeSessionKey(message.sessionKey, this.#sessionPolicy);
      const runtime = await this.#runtimeForSession({
        sessionId,
        sessionKey: normalizedSessionKey,
        channel: message.channel,
        securityPolicy: this.#securityPolicyFor(
          normalizedSessionKey,
          sessionId,
          await this.#approvalStore.listForSession(normalizedSessionKey)
        )
      });
      try {
        const trusted = await runtime.isWorkspaceTrusted();
        const text = `Workspace trust: ${trusted ? "trusted" : "not trusted"}`;
        await this.#deliverText(adapter, message.sessionKey, text);
        return {
          sessionId,
          replyText: text,
          artifactCount: 0,
          progressCount: 0
        };
      } finally {
        await runtime.dispose();
      }
    }

    if (command === "/memory") {
      const sessionId = await this.#sessionStore.getOrCreateSessionId(message.sessionKey, { receivedAt: message.receivedAt });
      const normalizedSessionKey = normalizeSessionKey(message.sessionKey, this.#sessionPolicy);
      const runtime = await this.#runtimeForSession({
        sessionId,
        sessionKey: normalizedSessionKey,
        channel: message.channel,
        securityPolicy: this.#securityPolicyFor(
          normalizedSessionKey,
          sessionId,
          await this.#approvalStore.listForSession(normalizedSessionKey)
        )
      });
      try {
        const profileId = (await runtime.sessionDb.getSession(runtime.sessionId))?.profileId;
        const memoryArgs = parseGatewayCommandArgs(message.text);
        const result = await runMemoryOperatorCommand({
          args: memoryArgs,
          homeDir: this.#homeDir,
          profileId,
          runtime
        });
        if (result.ok && isMemoryCurationModeMutation(memoryArgs)) {
          await this.#refreshAllCachedRuntimes("Gateway memory curation mode update");
        }
        const text = result.output;
        await this.#deliverText(adapter, message.sessionKey, text);
        return {
          sessionId,
          replyText: text,
          artifactCount: 0,
          progressCount: 0
        };
      } finally {
        await runtime.dispose();
      }
    }

    if (command === "/sessions") {
      const sessionId = await this.#sessionStore.getOrCreateSessionId(message.sessionKey, { receivedAt: message.receivedAt });
      const normalizedSessionKey = normalizeSessionKey(message.sessionKey, this.#sessionPolicy);
      const runtime = await this.#runtimeForSession({
        sessionId,
        sessionKey: normalizedSessionKey,
        channel: message.channel,
        securityPolicy: this.#securityPolicyFor(
          normalizedSessionKey,
          sessionId,
          await this.#approvalStore.listForSession(normalizedSessionKey)
        )
      });
      try {
        const prefix = buildBaseSessionId(message.sessionKey, this.#sessionPolicy);
        const sessions = (await runtime.sessionDb.listSessions("default"))
          .filter((session) => session.id === sessionId || session.id.startsWith(prefix))
          .slice(0, 10);
        const text = sessions.length === 0
          ? "No sessions found for this chat."
          : [
              "Recent sessions for this chat",
              ...sessions.map((session, index) =>
                `${index + 1}. ${session.id}${session.id === sessionId ? " (active)" : ""}${session.updatedAt ? ` — updated ${session.updatedAt}` : ""}`
              )
            ].join("\n");
        await this.#deliverText(adapter, message.sessionKey, text);

        return {
          sessionId,
          replyText: text,
          artifactCount: 0,
          progressCount: 0
        };
      } finally {
        await runtime.dispose();
      }
    }

    if (command === "/resume") {
      const sessionId = await this.#sessionStore.getOrCreateSessionId(message.sessionKey, { receivedAt: message.receivedAt });
      const normalizedSessionKey = normalizeSessionKey(message.sessionKey, this.#sessionPolicy);
      const runtime = await this.#runtimeForSession({
        sessionId,
        sessionKey: normalizedSessionKey,
        channel: message.channel,
        securityPolicy: this.#securityPolicyFor(
          normalizedSessionKey,
          sessionId,
          await this.#approvalStore.listForSession(normalizedSessionKey)
        )
      });
      try {
        const resumeNote = await runtime.latestResumeNote();
        const text = resumeNote === undefined
          ? "No interrupted turn is available to resume for this chat."
          : [
              "Latest interrupted turn",
              resumeNote
            ].join("\n");
        await this.#deliverText(adapter, message.sessionKey, text);

        return {
          sessionId,
          replyText: text,
          artifactCount: 0,
          progressCount: 0
        };
      } finally {
        await runtime.dispose();
      }
    }

    if (command === "/new" || command === "/reset") {
      const key = stableSessionKey(message.sessionKey, this.#sessionPolicy);
      const previousSessionId = this.#sessionIdByTurnKey.get(key);
      if (previousSessionId !== undefined) {
        try {
          await this.#runtimeCache?.invalidate(previousSessionId);
        } catch (err) {
          this.#logWarning?.(`Session reset cache invalidate failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      this.#sessionIdByTurnKey.delete(key);
      this.#pendingApprovals.delete(key);
      this.#approvalGrants.delete(key);
      await this.#surfacePointerStore?.removePointer(message.sessionKey.platform as SurfaceType, message.sessionKey.chatId);
      const sessionId = await this.#resetSession(message.sessionKey, message.receivedAt);
      const text = this.#renderFreshSessionNotice(sessionId);
      await this.#deliverText(adapter, message.sessionKey, text);

      return {
        sessionId,
        replyText: text,
        artifactCount: 0,
        progressCount: 0
      };
    }

    if (command === "/reload-mcp") {
      const sessionId = await this.#sessionStore.getOrCreateSessionId(message.sessionKey, { receivedAt: message.receivedAt });
      const normalizedSessionKey = normalizeSessionKey(message.sessionKey, this.#sessionPolicy);
      const runtime = await this.#runtimeForSession({
        sessionId,
        sessionKey: normalizedSessionKey,
        channel: message.channel,
        securityPolicy: this.#securityPolicyFor(
          normalizedSessionKey,
          sessionId,
          await this.#approvalStore.listForSession(normalizedSessionKey)
        )
      });
      try {
        const snapshots = runtime.inspectMcpServers();
        const ready = snapshots.filter((snapshot) => snapshot.available).length;
        const text = snapshots.length === 0
          ? "Reloaded MCP configuration. No MCP servers are configured for this runtime."
          : `Reloaded MCP configuration. MCP servers ready: ${ready}/${snapshots.length}.`;
        await this.#deliverText(adapter, message.sessionKey, text);

        return {
          sessionId,
          replyText: text,
          artifactCount: 0,
          progressCount: 0
        };
      } finally {
        await runtime.dispose();
      }
    }

    if (command === "/commands") {
      const text = [
        "Telegram command menu",
        ...telegramGatewayCommands().map((entry) => `${entry.command} - ${entry.description}`)
      ].join("\n");
      await this.#deliverText(adapter, message.sessionKey, text);

      return {
        sessionId: await this.#sessionStore.getOrCreateSessionId(message.sessionKey, { receivedAt: message.receivedAt }),
        replyText: text,
        artifactCount: 0,
        progressCount: 0
      };
    }

    if (command === "/switch") {
      const targetSessionId = message.text.trim().split(/\s+/u)[1];
      const currentSessionId = await this.#sessionStore.getOrCreateSessionId(message.sessionKey, { receivedAt: message.receivedAt });
      if (targetSessionId === undefined || targetSessionId.length === 0) {
        const text = "Usage: /switch <session-id>";
        await this.#deliverText(adapter, message.sessionKey, text);
        return {
          sessionId: currentSessionId,
          replyText: text,
          artifactCount: 0,
          progressCount: 0
        };
      }

      const normalizedSessionKey = normalizeSessionKey(message.sessionKey, this.#sessionPolicy);
      const runtime = await this.#runtimeForSession({
        sessionId: currentSessionId,
        sessionKey: normalizedSessionKey,
        channel: message.channel,
        securityPolicy: this.#securityPolicyFor(
          normalizedSessionKey,
          currentSessionId,
          await this.#approvalStore.listForSession(normalizedSessionKey)
        )
      });
      try {
        const targetSession = await runtime.sessionDb.getSession(targetSessionId);
        if (targetSession === undefined) {
          const text = `Session not found: ${targetSessionId}`;
          await this.#deliverText(adapter, message.sessionKey, text);
          return {
            sessionId: currentSessionId,
            replyText: text,
            artifactCount: 0,
            progressCount: 0
          };
        }

        await this.#sessionStore.setSessionId?.(message.sessionKey, targetSessionId, { receivedAt: message.receivedAt });
        const key = stableSessionKey(message.sessionKey, this.#sessionPolicy);
        const previousSessionId = this.#sessionIdByTurnKey.get(key);
        if (previousSessionId !== undefined && previousSessionId !== targetSessionId) {
          try {
            await this.#runtimeCache?.invalidate(previousSessionId);
          } catch (err) {
            this.#logWarning?.(`Session switch cache invalidate failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        this.#sessionIdByTurnKey.set(key, targetSessionId);
        this.#pendingApprovals.delete(key);
        this.#approvalGrants.delete(key);
        const text = [
          "Switched this chat to an existing session.",
          `Session: ${targetSessionId}`
        ].join("\n");
        await this.#deliverText(adapter, message.sessionKey, text);
        return {
          sessionId: targetSessionId,
          replyText: text,
          artifactCount: 0,
          progressCount: 0
        };
      } finally {
        await runtime.dispose();
      }
    }

    if (command === "/search") {
      const query = message.text.replace(/^\/search\s*/u, "").trim();
      const sessionId = await this.#sessionStore.getOrCreateSessionId(message.sessionKey, { receivedAt: message.receivedAt });
      if (query.length === 0) {
        const text = "Usage: /search <query>";
        await this.#deliverText(adapter, message.sessionKey, text);
        return {
          sessionId,
          replyText: text,
          artifactCount: 0,
          progressCount: 0
        };
      }
      const normalizedSessionKey = normalizeSessionKey(message.sessionKey, this.#sessionPolicy);
      const runtime = await this.#runtimeForSession({
        sessionId,
        sessionKey: normalizedSessionKey,
        channel: message.channel,
        securityPolicy: this.#securityPolicyFor(
          normalizedSessionKey,
          sessionId,
          await this.#approvalStore.listForSession(normalizedSessionKey)
        )
      });
      try {
        const prefix = buildBaseSessionId(message.sessionKey, this.#sessionPolicy);
        const matches = (await runtime.sessionDb.search(query, { profileId: this.#profileId, limit: 20 }))
          .filter((result) => result.session.id.startsWith(prefix))
          .slice(0, 5);
        const text = matches.length === 0
          ? `No matching session history for "${query}".`
          : [
              `Search results for "${query}"`,
              ...matches.map((result, index) =>
                `${index + 1}. [${result.session.id}] ${result.message.role}: ${truncateSingleLine(result.message.content, 100)}`
              )
            ].join("\n");
        await this.#deliverText(adapter, message.sessionKey, text);
        return {
          sessionId,
          replyText: text,
          artifactCount: 0,
          progressCount: 0
        };
      } finally {
        await runtime.dispose();
      }
    }

    if (command === "/compact") {
      const busyResult = await this.#rejectCompactIfSessionBusy(message, adapter);
      if (busyResult !== undefined) {
        return busyResult;
      }
      const focusTopic = message.text.replace(/^\/compact\s*/u, "").trim();
      const normalizedTopic = focusTopic.length === 0 ? undefined : focusTopic;
      const sessionId = await this.#sessionStore.getOrCreateSessionId(message.sessionKey, { receivedAt: message.receivedAt });
      const normalizedSessionKey = normalizeSessionKey(message.sessionKey, this.#sessionPolicy);
      const runtime = await this.#runtimeForSession({
        sessionId,
        sessionKey: normalizedSessionKey,
        channel: message.channel,
        securityPolicy: this.#securityPolicyFor(
          normalizedSessionKey,
          sessionId,
          await this.#approvalStore.listForSession(normalizedSessionKey)
        )
      });
      try {
        const compactResult = runtime.compactSession === undefined
          ? undefined
          : await runtime.compactSession({
              sessionId,
              focusTopic: normalizedTopic,
              preserveTranscript: true
            });
        if (compactResult?.rotated === true) {
          await this.#adoptSessionId(message.sessionKey, sessionId, compactResult.activeSessionId, {
            receivedAt: message.receivedAt,
            reason: "Gateway /compact"
          });
        }
        const text = compactResult === undefined
          ? "Session compaction is not available in this runtime."
          : renderSessionCompactionResult(compactResult, {
              focusTopic: normalizedTopic
            });
        await this.#deliverText(adapter, message.sessionKey, text);
        return {
          sessionId: compactResult?.activeSessionId ?? sessionId,
          replyText: text,
          artifactCount: 0,
          progressCount: 0
        };
      } catch (error) {
        const text = `Session compaction failed: ${error instanceof Error ? error.message : String(error)}`;
        await this.#deliverText(adapter, message.sessionKey, text);
        return {
          sessionId,
          replyText: text,
          artifactCount: 0,
          progressCount: 0
        };
      } finally {
        await runtime.dispose();
      }
    }

    if (command === "/approve") {
      return this.#approvePending(message, adapter);
    }

    if (command === "/approvals") {
      return this.#showApprovals(message, adapter);
    }

    if (command === "/deny") {
      return this.#denyPending(message, adapter);
    }

    if (command === "/revoke") {
      return this.#revokeApproval(message, adapter);
    }

    if (command === "/stop") {
      const sessionId = await this.#sessionStore.getOrCreateSessionId(message.sessionKey, { receivedAt: message.receivedAt });
      const key = stableSessionKey(message.sessionKey, this.#sessionPolicy);
      const hasActiveTurn = this.#activeTurnRegistry !== undefined
        ? this.#activeTurnRegistry.isBusy(key)
        : this.#activeTurns.has(key);

      if (hasActiveTurn) {
        // Active turn exists: abort it, leave queued messages intact
        if (this.#activeTurnRegistry !== undefined) {
          this.#abortReasonByKey.set(key, "channel-stop");
          this.#activeTurnRegistry.abortTurn(key, "channel-stop");
        } else {
          this.#abortReasonByKey.set(key, "channel-stop");
          this.#activeTurns.get(key)?.abort("channel-stop");
        }
        const text = "Cancelled the active EstaCoda turn for this chat.";
        await this.#deliverText(adapter, message.sessionKey, text);
        return { sessionId, replyText: text, artifactCount: 0, progressCount: 0 };
      }

      const queueSize = this.#sessionMessageQueue.size(key);
      if (queueSize > 0) {
        // No active turn, but queued messages: clear them
        this.#sessionMessageQueue.clear(key);
        const text = `Stopped. Cleared ${queueSize} queued message${queueSize === 1 ? "" : "s"}.`;
        await this.#deliverText(adapter, message.sessionKey, text);
        return { sessionId, replyText: text, artifactCount: 0, progressCount: 0 };
      }

      const text = "Stopping the EstaCoda gateway after this update.";
      await this.#deliverText(adapter, message.sessionKey, text);
      await this.#onStopRequested?.(message);

      return {
        sessionId,
        replyText: text,
        artifactCount: 0,
        progressCount: 0
      };
    }

    return undefined;
  }

  async #handleVoiceCommand(
    message: ChannelMessage,
    adapter: ChannelAdapter,
    command: GatewayVoiceCommand
  ): Promise<ChannelGatewayResult> {
    const sessionId = await this.#sessionStore.getOrCreateSessionId(message.sessionKey, { receivedAt: message.receivedAt });
    if (this.#voiceStateManager === undefined) {
      const text = "Voice controls are not configured on this gateway.";
      await this.#deliverText(adapter, message.sessionKey, text);
      return { sessionId, replyText: text, artifactCount: 0, progressCount: 0 };
    }

    if (command.kind === "channel" || command.kind === "leave") {
      if (message.sessionKey.platform !== "discord") {
        const text = "Discord voice channel controls are available only from Discord.";
        await this.#deliverText(adapter, message.sessionKey, text);
        return { sessionId, replyText: text, artifactCount: 0, progressCount: 0 };
      }
      const capability = command.kind === "channel"
        ? adapter.joinVoiceChannelForMessage
        : adapter.leaveVoiceChannelForMessage;
      if (capability === undefined) {
        const text = "Discord voice channel controls are not available on this adapter.";
        await this.#deliverText(adapter, message.sessionKey, text);
        return { sessionId, replyText: text, artifactCount: 0, progressCount: 0 };
      }
      const result = await capability.call(adapter, message);
      const text = result.content;
      await this.#deliverText(adapter, message.sessionKey, text);
      return { sessionId, replyText: text, artifactCount: 0, progressCount: 0 };
    }

    if (command.kind === "status") {
      const explicitMode = await this.#voiceStateManager.getMode(message.sessionKey.platform, message.sessionKey.chatId);
      const mode = explicitMode ?? (this.#voiceAutoTtsDefault ? "voice_only" : "off");
      const text = [
        "Voice status",
        `Mode: ${mode}`,
        explicitMode === undefined ? `Source: default (${this.#voiceAutoTtsDefault ? "voice_only" : "off"})` : "Source: chat"
      ].join("\n");
      await this.#deliverText(adapter, message.sessionKey, text);
      return { sessionId, replyText: text, artifactCount: 0, progressCount: 0 };
    }

    await this.#voiceStateManager.setMode(message.sessionKey.platform, message.sessionKey.chatId, command.mode);
    const text = `Voice mode set to ${command.mode}.`;
    await this.#deliverText(adapter, message.sessionKey, text);
    return { sessionId, replyText: text, artifactCount: 0, progressCount: 0 };
  }

  async #rejectCompactIfSessionBusy(
    message: ChannelMessage,
    adapter: ChannelAdapter
  ): Promise<ChannelGatewayResult | undefined> {
    const activeTurnKey = stableSessionKey(message.sessionKey, this.#sessionPolicy);
    const isBusy = this.#activeTurnRegistry !== undefined
      ? this.#activeTurnRegistry.isBusy(activeTurnKey)
      : this.#activeTurns.has(activeTurnKey);
    const hasQueued = this.#sessionMessageQueue.size(activeTurnKey) > 0;
    const isDrainingQueued = this.#drainingQueue.has(activeTurnKey);

    if (!isBusy && !hasQueued && !isDrainingQueued) {
      return undefined;
    }

    const text = "EstaCoda is busy with another request in this chat. Please wait before compacting.";
    await this.#deliverText(adapter, message.sessionKey, text);
    return {
      sessionId: "",
      replyText: text,
      artifactCount: 0,
      progressCount: 0
    };
  }

  async #approvePending(
    message: ChannelMessage,
    adapter: ChannelAdapter,
    action?: { approvalId?: string; scope?: ApprovalActionScope }
  ): Promise<ChannelGatewayResult> {
    const pendingResult = await this.#pendingApprovalForMessage(message, adapter, action?.approvalId);
    if ("replyText" in pendingResult) {
      return pendingResult;
    }

    const { key, pending } = pendingResult;
    const scope = action?.scope ?? parseApprovalScope(message.text);
    if (pending.kind === "managed-python-capability-install") {
      return await this.#approvePythonCapabilitySetup(key, pending, adapter, message);
    }

    if (pending.approvalId !== undefined && this.#approvalQueue !== undefined) {
      try {
        await this.#approvalQueue.resolveApproval(
          pending.approvalId,
          "approved",
          message.sender.id,
          { profileId: this.#profileId, sessionId: pending.sessionId }
        );
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        await this.#deliverText(adapter, message.sessionKey, text);
        return {
          sessionId: pending.sessionId,
          replyText: text,
          artifactCount: 0,
          progressCount: 0
        };
      }
    }

    const approvalText = scope === "always"
      ? [
          "✅ Approval granted",
          `Tool: ${pending.toolName}`,
          "Scope: persistent for this chat",
          "EstaCoda is resuming the blocked request now."
        ].join("\n")
      : [
          "✅ Approval granted",
          `Tool: ${pending.toolName}`,
          `Scope: ${scope}`,
          "EstaCoda is resuming the blocked request now."
        ].join("\n");
    return await this.#resumePendingApproval(key, pending, adapter, scope, approvalText);
  }

  async #denyPending(
    message: ChannelMessage,
    adapter: ChannelAdapter,
    action?: { approvalId?: string }
  ): Promise<ChannelGatewayResult> {
    const pendingResult = await this.#pendingApprovalForMessage(message, adapter, action?.approvalId);
    if ("replyText" in pendingResult) {
      return pendingResult;
    }

    const { key, pending } = pendingResult;

    if (pending.approvalId !== undefined && this.#approvalQueue !== undefined) {
      try {
        await this.#approvalQueue.resolveApproval(
          pending.approvalId,
          "denied",
          message.sender.id,
          { profileId: this.#profileId, sessionId: pending.sessionId }
        );
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        await this.#deliverText(adapter, message.sessionKey, text);
        return {
          sessionId: pending.sessionId,
          replyText: text,
          artifactCount: 0,
          progressCount: 0
        };
      }
    }

    return await this.#terminatePendingApproval(
      key,
      pending,
      adapter,
      "Approval denied",
      "EstaCoda will not run that action unless it is requested again."
    );
  }

  async #approvePythonCapabilitySetup(
    key: string,
    pending: PythonCapabilityPendingApprovalContinuation,
    adapter: ChannelAdapter,
    approvingMessage: ChannelMessage
  ): Promise<ChannelGatewayResult> {
    if (pending.approvalId !== undefined && this.#approvalQueue !== undefined) {
      try {
        await this.#approvalQueue.resolveApproval(
          pending.approvalId,
          "approved",
          approvingMessage.sender.id,
          { profileId: this.#profileId, sessionId: pending.sessionId }
        );
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        await this.#deliverText(adapter, approvingMessage.sessionKey, text);
        return {
          sessionId: pending.sessionId,
          replyText: text,
          artifactCount: 0,
          progressCount: 0
        };
      }
    }

    if (this.#pythonCapabilityStateRoot === undefined) {
      const text = [
        "Capability setup could not start",
        `Capability: ${pending.capability.capabilityId}`,
        "Managed Python state is not configured for this gateway."
      ].join("\n");
      this.#pendingApprovals.delete(key);
      await this.#deliverText(adapter, pending.originalMessage.sessionKey, text);
      return {
        sessionId: pending.sessionId,
        replyText: text,
        artifactCount: 0,
        progressCount: 0
      };
    }

    const install = await this.#pythonCapabilityInstaller({
      stateRoot: this.#pythonCapabilityStateRoot,
      capabilityId: pending.capability.capabilityId,
      groups: pending.capability.groups,
      onProgress: (progress) => this.#logWarning?.(`Managed Python setup ${pending.capability.capabilityId}: ${progress}`)
    });

    if (!install.ok) {
      const text = [
        "Capability setup failed",
        `Capability: ${pending.capability.capabilityId}`,
        install.message
      ].join("\n");
      this.#pendingApprovals.delete(key);
      await this.#refreshCachedRuntimePolicy(pending.sessionId, "Managed Python capability setup failed");
      await this.#deliverText(adapter, pending.originalMessage.sessionKey, text);
      return {
        sessionId: pending.sessionId,
        replyText: text,
        artifactCount: 0,
        progressCount: 0
      };
    }

    await this.#refreshCachedRuntimePolicy(pending.sessionId, "Managed Python capability setup completed");
    this.#pendingApprovals.delete(key);

    const approvalText = [
      "✅ Capability setup complete",
      `Capability: ${install.capabilityId}`,
      "EstaCoda is resuming the blocked request now."
    ].join("\n");

    await this.#deliverText(adapter, pending.originalMessage.sessionKey, approvalText);

    const resumed = await this.receive({
      ...pending.originalMessage,
      id: `${pending.originalMessage.id}-capability-approved-${Date.now()}`,
      metadata: {
        ...(pending.originalMessage.metadata ?? {}),
        capabilitySetupApproved: pending.capability.capabilityId
      }
    });

    return {
      sessionId: resumed.sessionId,
      replyText: [approvalText, "", resumed.replyText].join("\n"),
      artifactCount: resumed.artifactCount,
      progressCount: resumed.progressCount
    };
  }

  async #pendingApprovalForMessage(
    message: ChannelMessage,
    adapter: ChannelAdapter,
    approvalId?: string
  ): Promise<{ key: string; pending: PendingApprovalContinuation } | ChannelGatewayResult> {
    const key = stableSessionKey(message.sessionKey, this.#sessionPolicy);
    const pending = this.#pendingApprovals.get(key);
    if (pending !== undefined && (approvalId === undefined || pending.approvalId === approvalId)) {
      return { key, pending };
    }

    const sessionId = await this.#sessionStore.getOrCreateSessionId(message.sessionKey, { receivedAt: message.receivedAt });
    let text = "There is no pending approval request for this chat.";
    if (approvalId !== undefined && this.#approvalQueue !== undefined) {
      const durable = await this.#approvalQueue.getApprovalRequest(approvalId, {
        profileId: this.#profileId,
        sessionId
      });
      const restored = this.#restorePendingSetupApprovalFromDurable({
        durable,
        message,
        adapter,
        key
      });
      if (restored !== undefined) {
        return restored;
      }
      if (durable?.status === "approved") {
        text = "Pending approval is already approved.";
      } else if (durable?.status === "denied") {
        text = "Pending approval is already denied.";
      } else if (durable?.status === "expired") {
        text = "Pending approval has expired.";
      }
    } else if (this.#approvalQueue !== undefined) {
      const durableApprovals = await this.#approvalQueue.listPending({
        profileId: this.#profileId,
        sessionId
      });
      const restorable = durableApprovals.filter((approval) =>
        approval.approvalKind === "managed_python_capability_install" &&
        approval.channel === toPendingApprovalChannel(adapter.kind) &&
        approval.chatId === message.sessionKey.chatId
      );
      if (restorable.length === 1) {
        const durable = await this.#approvalQueue.getApprovalRequest(restorable[0]!.id, {
          profileId: this.#profileId,
          sessionId
        });
        const restored = this.#restorePendingSetupApprovalFromDurable({
          durable,
          message,
          adapter,
          key
        });
        if (restored !== undefined) {
          return restored;
        }
      }
    }

    await this.#deliverText(adapter, message.sessionKey, text);
    return {
      sessionId,
      replyText: text,
      artifactCount: 0,
      progressCount: 0
    };
  }

  #restorePendingSetupApprovalFromDurable(input: {
    durable: PendingApproval | undefined;
    message: ChannelMessage;
    adapter: ChannelAdapter;
    key: string;
  }): { key: string; pending: PendingApprovalContinuation } | undefined {
    const { durable, message, adapter, key } = input;
    if (
      durable === undefined ||
      durable.status !== "pending" ||
      durable.approvalKind !== "managed_python_capability_install" ||
      durable.requestPayload === undefined ||
      durable.requestPayload.originalMessage === undefined ||
      durable.channel !== toPendingApprovalChannel(adapter.kind) ||
      durable.chatId !== message.sessionKey.chatId
    ) {
      return undefined;
    }

    const originalMessage = channelMessageFromApprovalPayload(durable.requestPayload.originalMessage);
    if (originalMessage === undefined) {
      return undefined;
    }
    const capability: AgentLoopPythonCapabilitySetupApprovalRequest = {
      kind: "managed-python-capability-install",
      skillName: durable.requestPayload.skillName,
      capabilityId: durable.requestPayload.capabilityId,
      groups: [...durable.requestPayload.groups],
      packages: [...durable.requestPayload.packages],
      estimatedInstallSizeMb: durable.requestPayload.estimatedInstallSizeMb,
      reason: durable.requestPayload.reason,
      repairCommand: durable.requestPayload.repairCommand
    };
    return {
      key,
      pending: {
        kind: "managed-python-capability-install",
        approvalId: durable.id,
        toolName: "python-env.setup",
        riskClass: "external-side-effect",
        targetKey: `python-env.setup:${capability.capabilityId}:${capability.groups.join(",")}`,
        targetSummary: durable.commandPreview,
        capability,
        sessionId: durable.sessionId,
        originalMessage
      }
    };
  }

  async #resumePendingApproval(
    key: string,
    pending: PendingApprovalContinuation,
    adapter: ChannelAdapter,
    scope: ApprovalScope,
    approvalText: string
  ): Promise<ChannelGatewayResult> {
    const normalizedSessionKey = normalizeSessionKey(pending.originalMessage.sessionKey, this.#sessionPolicy);
    if (scope !== "always") {
      const grants = this.#approvalGrants.get(key) ?? [];
      grants.push({
        toolName: pending.toolName,
        riskClass: pending.riskClass,
        targetKey: pending.targetKey,
        targetSummary: pending.targetSummary,
        scope,
        sessionId: scope === "session" ? pending.sessionId : undefined
      });
      this.#approvalGrants.set(key, grants);
    } else {
      await this.#approvalStore.grant({
        sessionKey: normalizedSessionKey,
        toolName: pending.toolName,
        riskClass: pending.riskClass,
        targetKey: pending.targetKey,
        targetSummary: pending.targetSummary
      });
      await this.#refreshCachedRuntimePolicy(pending.sessionId, "Persistent approval grant");
    }
    this.#pendingApprovals.delete(key);

    await this.#deliverText(adapter, pending.originalMessage.sessionKey, approvalText);

    const resumed = await this.receive({
      ...pending.originalMessage,
      id: `${pending.originalMessage.id}-approved-${Date.now()}`,
      metadata: {
        ...(pending.originalMessage.metadata ?? {}),
        approvalScope: scope
      }
    });

    return {
      sessionId: resumed.sessionId,
      replyText: [approvalText, "", resumed.replyText].join("\n"),
      artifactCount: resumed.artifactCount,
      progressCount: resumed.progressCount
    };
  }

  async #terminatePendingApproval(
    key: string,
    pending: PendingApprovalContinuation,
    adapter: ChannelAdapter,
    title: string,
    detail: string
  ): Promise<ChannelGatewayResult> {
    this.#pendingApprovals.delete(key);
    const text = [
      title,
      `Tool: ${pending.toolName}`,
      detail
    ].join("\n");
    await this.#deliverText(adapter, pending.originalMessage.sessionKey, text);

    return {
      sessionId: pending.sessionId,
      replyText: text,
      artifactCount: 0,
      progressCount: 0
    };
  }

  async #showApprovals(message: ChannelMessage, adapter: ChannelAdapter): Promise<ChannelGatewayResult> {
    const normalizedSessionKey = normalizeSessionKey(message.sessionKey, this.#sessionPolicy);
    const key = stableSessionKey(message.sessionKey, this.#sessionPolicy);
    const persistent = await this.#approvalStore.listForSession(normalizedSessionKey);
    const sessionScoped = this.#approvalGrants.get(key) ?? [];
    const pending = this.#pendingApprovals.get(key);
    const text = [
      "Approval status",
      pending === undefined
        ? "Pending: none"
        : formatPendingApproval(pending),
      "",
      "Session approvals:",
      ...(sessionScoped.length === 0
        ? ["none"]
        : sessionScoped.map((grant, index) => `${index + 1}. ${formatEphemeralApproval(grant)}`)),
      "",
      "Persistent approvals:",
      ...(persistent.length === 0
        ? ["none"]
        : persistent.map((grant, index) => `${index + 1}. [${grant.id}] ${formatPersistentApproval(grant)}`)),
      "",
      "Use /revoke <approval-id> to remove a persistent approval."
    ].join("\n");
    await this.#deliverText(adapter, message.sessionKey, text);

    return {
      sessionId: await this.#sessionStore.getOrCreateSessionId(message.sessionKey, { receivedAt: message.receivedAt }),
      replyText: text,
      artifactCount: 0,
      progressCount: 0
    };
  }

  async #revokeApproval(message: ChannelMessage, adapter: ChannelAdapter): Promise<ChannelGatewayResult> {
    const approvalId = message.text.trim().split(/\s+/u)[1];

    if (approvalId === undefined || approvalId.length === 0) {
      const text = "Usage: /revoke <approval-id>";
      await this.#deliverText(adapter, message.sessionKey, text);

      return {
        sessionId: await this.#sessionStore.getOrCreateSessionId(message.sessionKey, { receivedAt: message.receivedAt }),
        replyText: text,
        artifactCount: 0,
        progressCount: 0
      };
    }

    const sessionId = await this.#sessionStore.getOrCreateSessionId(message.sessionKey, { receivedAt: message.receivedAt });
    const revoked = await this.#approvalStore.revoke(approvalId, normalizeSessionKey(message.sessionKey, this.#sessionPolicy));
    if (revoked) {
      await this.#refreshCachedRuntimePolicy(sessionId, "Persistent approval revoke");
    }
    const text = revoked
      ? `Revoked persistent approval ${approvalId}.`
      : `No persistent approval matched ${approvalId} for this chat.`;
    await this.#deliverText(adapter, message.sessionKey, text);

    return {
      sessionId,
      replyText: text,
      artifactCount: 0,
      progressCount: 0
    };
  }

  async #resetSession(sessionKey: ChannelSessionKey, receivedAt?: string): Promise<string> {
    if (this.#sessionStore.resetSessionId !== undefined) {
      return this.#sessionStore.resetSessionId(sessionKey, { receivedAt });
    }

    return this.#sessionStore.getOrCreateSessionId(sessionKey, { receivedAt });
  }

  #securityPolicyFor(
    sessionKey: ChannelSessionKey,
    sessionId: string,
    persistentApprovals: PersistedApprovalGrant[]
  ): SecurityPolicy {
    const key = stableSessionKey(sessionKey, this.#sessionPolicy);
    const securityMode = this.#yoloSessions.get(yoloSessionKey(key, sessionId)) === true ? "open" : this.#securityMode;
    const securityAssessor = this.#securityAssessor;
    const approvalGrants = this.#approvalGrants;

    const assess = async (request: SecurityRequest) => {
      const basePolicy = createSecurityPolicyForMode(securityMode, {
        assessor: securityAssessor === undefined
          ? undefined
          : {
            ...securityAssessor,
            sessionId
          }
      });
      const hardline = hardlineAssessmentForRequest(request, securityMode);
      if (hardline !== undefined) {
        return hardline;
      }

      const grants = approvalGrants.get(key) ?? [];
      const grantIndex = grants.findIndex((grant) =>
        grant.toolName === request.toolName &&
        grant.riskClass === request.riskClass &&
        grant.targetKey === request.targetKey &&
        (grant.scope !== "session" || grant.sessionId === sessionId)
      );

      if (grantIndex >= 0) {
        const grant = grants[grantIndex];

        if (grant?.scope === "once") {
          grants.splice(grantIndex, 1);

          if (grants.length === 0) {
            approvalGrants.delete(key);
          } else {
            approvalGrants.set(key, grants);
          }
        }

          return {
            decision: "allow" as const,
            mode: securityMode,
            reason: "Allowed by a session approval grant.",
            risk: request.riskClass === "destructive-local" ||
              request.riskClass === "credential-access" ||
              request.riskClass === "sandbox-escape" ||
              request.riskClass === "spend-money"
              ? "high"
              : "medium"
          } as const;
        }
        if (persistentApprovals.some((grant) => matchesPersistentApproval(grant, request))) {
          return {
            decision: "allow" as const,
            mode: securityMode,
          reason: "Allowed by a persisted approval grant.",
          risk: request.riskClass === "destructive-local" ||
              request.riskClass === "credential-access" ||
              request.riskClass === "sandbox-escape" ||
              request.riskClass === "spend-money"
              ? "high"
              : "medium"
          } as const;
        }

      return await assessSecurityPolicy(basePolicy, request, securityMode);
    };

    return {
      assess(request: SecurityRequest) {
        return assess(request);
      },
      decide(request: SecurityRequest): SecurityDecision {
        const basePolicy = createSecurityPolicyForMode(securityMode);
        const hardline = hardlineAssessmentForRequest(request, securityMode);
        if (hardline !== undefined) {
          return hardline.decision;
        }

        const grants = approvalGrants.get(key) ?? [];
        const grantIndex = grants.findIndex((grant) =>
          grant.toolName === request.toolName &&
          grant.riskClass === request.riskClass &&
          grant.targetKey === request.targetKey &&
          (grant.scope !== "session" || grant.sessionId === sessionId)
        );
        if (grantIndex >= 0 || persistentApprovals.some((grant) => matchesPersistentApproval(grant, request))) {
          return "allow";
        }
        return basePolicy.decide(request);
      }
    };
  }

  #adapterFor(channel: string): ChannelAdapter {
    const adapter = this.#adapters.get(channel);

    if (adapter !== undefined) {
      return adapter;
    }

    const fallback = [...this.#adapters.values()][0];

    if (fallback === undefined) {
      throw new Error("ChannelGateway requires at least one adapter");
    }

    return fallback;
  }

  #isYoloEnabled(sessionKey: ChannelSessionKey, sessionId: string): boolean {
    return this.#yoloSessions.get(yoloSessionKey(stableSessionKey(sessionKey, this.#sessionPolicy), sessionId)) === true;
  }

  #toggleYolo(sessionKey: ChannelSessionKey, sessionId: string): boolean {
    const key = yoloSessionKey(stableSessionKey(sessionKey, this.#sessionPolicy), sessionId);
    const enabled = this.#yoloSessions.get(key) !== true;

    if (enabled) {
      this.#yoloSessions.set(key, true);
    } else {
      this.#yoloSessions.delete(key);
    }

    return enabled;
  }

  #renderFreshSessionNotice(sessionId: string): string {
    const model = this.#runtimeFingerprint === undefined
      ? "unknown"
      : `${this.#runtimeFingerprint.modelProvider}/${this.#runtimeFingerprint.modelId}`;

    return [
      "𓂀 Fresh EstaCoda session",
      "",
      `◈ Model: ${model}`,
      `◈ Session: ${shortGatewaySessionId(sessionId)}`,
      `◈ Profile: ${this.#profileId}`,
      `◈ Security: ${formatGatewayFreshSessionSecurity(this.#securityMode)}`
    ].join("\n");
  }
}

function yoloSessionKey(stableKey: string, sessionId: string): string {
  return `${stableKey}:${sessionId}`;
}

function shortGatewaySessionId(sessionId: string): string {
  const compact = sessionId.replace(/[^a-z0-9]/giu, "");
  const source = compact.length > 0 ? compact : sessionId;
  return source.slice(-8);
}

function formatGatewayFreshSessionSecurity(mode: SecurityApprovalMode): string {
  return mode === "open" ? "↯ YOLO mode" : formatGatewaySecurityMode(mode);
}

function formatGatewaySecurityMode(mode: SecurityApprovalMode): string {
  return `${mode[0]?.toUpperCase() ?? ""}${mode.slice(1)}`;
}

function tokenizeCommandArgs(text: string): string[] {
  const matches = text.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/gu);
  return [...matches].map((match) => match[1] ?? match[2] ?? match[3] ?? "");
}

function renderModelPickerCurrentLines(
  currentModel: string,
  providers: Array<{ id: string; displayName: string }>
): string[] {
  const route = parseModelPickerRouteDescription(currentModel);
  if (route === undefined) {
    return [`Current model: ${currentModel}`];
  }

  const provider = providers.find((candidate) => candidate.id === route.providerId);
  return [
    `Current model: ${route.modelId}`,
    `Provider: ${provider?.displayName ?? route.providerId}`
  ];
}

function parseModelPickerRouteDescription(
  currentModel: string
): { providerId: string; modelId: string } | undefined {
  const routeText = currentModel.replace(/\s+\([^)]+\)$/u, "");
  const slashIndex = routeText.indexOf("/");
  if (slashIndex <= 0 || slashIndex === routeText.length - 1) {
    return undefined;
  }

  return {
    providerId: routeText.slice(0, slashIndex),
    modelId: routeText.slice(slashIndex + 1)
  };
}

function modelPickerProviderControlRows(): ChannelTextAction[][] {
  return [[
    { label: "Clear", value: modelPickerClearActionValue() },
    { label: "Cancel", value: modelPickerCancelActionValue() }
  ]];
}

function modelPickerDeliveryOptions(
  message: ChannelMessage,
  actions?: ChannelTextAction[][],
  baseOptions?: ChannelTextOptions
): ChannelTextOptions | undefined {
  const editMessageId = modelPickerTelegramCallbackMessageId(message);
  if (actions === undefined && editMessageId === undefined && baseOptions === undefined) {
    return undefined;
  }

  return {
    ...baseOptions,
    actions: actions ?? baseOptions?.actions,
    editMessageId: baseOptions?.editMessageId ?? editMessageId
  };
}

function modelPickerFinalDeliveryOptions(
  message: ChannelMessage,
  baseOptions?: ChannelTextOptions
): ChannelTextOptions {
  return modelPickerDeliveryOptions(message, [], baseOptions) ?? { actions: [] };
}

function modelPickerTelegramCallbackMessageId(message: ChannelMessage): string | undefined {
  if (message.sessionKey.platform !== "telegram") {
    return undefined;
  }

  const telegram = message.metadata?.telegram;
  if (typeof telegram !== "object" || telegram === null) {
    return undefined;
  }

  const callbackQueryId = (telegram as { callbackQueryId?: unknown }).callbackQueryId;
  if (callbackQueryId === undefined || callbackQueryId === null || String(callbackQueryId).length === 0) {
    return undefined;
  }

  const messageId = (telegram as { messageId?: unknown }).messageId;
  if (typeof messageId === "number" && Number.isFinite(messageId)) {
    return String(messageId);
  }
  if (typeof messageId === "string" && messageId.trim().length > 0) {
    return messageId;
  }
  return undefined;
}

function modelPickerModelNavigationRows(providerId: string, page: number, totalPages: number): ChannelTextAction[][] {
  const safeTotalPages = Math.max(1, totalPages);
  const safePage = clampModelPickerPage(page, safeTotalPages);
  const rows: ChannelTextAction[][] = [];

  if (safeTotalPages > 1) {
    const currentPage = {
      label: `${safePage + 1}/${safeTotalPages}`,
      value: modelPickerPageActionValue(modelPickerPageActionKey(providerId, safePage))
    };
    const previousPage = safePage > 0
      ? {
          label: "< Prev",
          value: modelPickerPageActionValue(modelPickerPageActionKey(providerId, safePage - 1))
        }
      : currentPage;
    const nextPage = safePage < safeTotalPages - 1
      ? {
          label: "Next >",
          value: modelPickerPageActionValue(modelPickerPageActionKey(providerId, safePage + 1))
        }
      : currentPage;

    rows.push([previousPage, nextPage]);
  }

  rows.push([
    { label: "< Back", value: modelPickerBackActionValue() },
    { label: "Cancel", value: modelPickerCancelActionValue() }
  ]);
  return rows;
}

function clampModelPickerPage(page: number, totalPages: number): number {
  if (!Number.isFinite(page)) {
    return 0;
  }
  return Math.min(Math.max(Math.trunc(page), 0), Math.max(totalPages - 1, 0));
}

type GatewayModelCommand =
  | { kind: "show" }
  | { kind: "set"; scope: "session" | "global"; modelInput: string }
  | { kind: "clear"; scope: "session" | "global" }
  | { kind: "cancel" };

type GatewayVoiceCommand =
  | { kind: "status" }
  | { kind: "set"; mode: VoiceMode }
  | { kind: "channel" }
  | { kind: "leave" };

function parseGatewayModelCommand(text: string): GatewayModelCommand | undefined {
  const args = tokenizeCommandArgs(text.trim());
  const rawToken = args[0];
  if (rawToken === undefined) {
    return undefined;
  }

  const token = rawToken.toLowerCase().replace(/@[\w_]+$/u, "");
  if (token === "model-clear") {
    return { kind: "clear", scope: "session" };
  }
  if (token === "model-select") {
    return { kind: "set", scope: "session", modelInput: args.slice(1).join(" ") };
  }
  if (token !== "/model") {
    return undefined;
  }

  const modelArgs = args.slice(1);
  const scope = modelArgs.includes("--global") ? "global" : "session";
  const normalized = modelArgs.filter((arg) => arg !== "--global");
  const subcommand = normalized[0]?.toLowerCase();
  if (subcommand === undefined) {
    return { kind: "show" };
  }
  if (subcommand === "clear") {
    return { kind: "clear", scope };
  }
  if (subcommand === "set") {
    return { kind: "set", scope, modelInput: normalized.slice(1).join(" ") };
  }

  return { kind: "set", scope, modelInput: normalized.join(" ") };
}

function parseGatewayVoiceCommand(text: string): GatewayVoiceCommand | undefined {
  const args = tokenizeCommandArgs(text.trim());
  const rawToken = args[0];
  if (rawToken === undefined) {
    return undefined;
  }
  const token = rawToken.toLowerCase().replace(/@[\w_]+$/u, "");
  if (token !== "/voice") {
    return undefined;
  }
  const subcommand = args[1]?.toLowerCase() ?? "status";
  switch (subcommand) {
    case "on":
    case "voice":
      return { kind: "set", mode: "voice_only" };
    case "all":
    case "tts":
      return { kind: "set", mode: "all" };
    case "off":
      return { kind: "set", mode: "off" };
    case "status":
      return { kind: "status" };
    case "channel":
      return { kind: "channel" };
    case "leave":
      return { kind: "leave" };
    default:
      return { kind: "status" };
  }
}

export function authorizeChannelMessage(message: ChannelMessage, policies: ChannelAuthPolicies): {
  allowed: boolean;
  message: string;
  pairingAllowed?: boolean;
  silentDrop?: boolean;
  authorizedText?: string;
} {
  const kind = message.channel;
  const policy = policies[kind as keyof ChannelAuthPolicies];

  if (policy === undefined) {
    return {
      allowed: false,
      message: `This EstaCoda ${kind} gateway is locked. No authorization policy is configured for this channel.`
    };
  }

  if (kind === "telegram") {
    const telegramPolicy = policy as import("../contracts/channel.js").TelegramAuthPolicy;
    const allowedUserIds = new Set(telegramPolicy.allowedUserIds ?? []);
    const allowedChatIds = new Set(telegramPolicy.allowedChatIds ?? []);
    const allowed =
      allowedUserIds.has(message.sender.id) ||
      allowedUserIds.has(message.sessionKey.userId ?? "") ||
      allowedChatIds.has(message.sessionKey.chatId);
    return {
      allowed,
      message: allowed
        ? ""
        : telegramPolicy.deniedMessage ??
          "This EstaCoda Telegram bot is not paired with this account. Ask the owner to add your Telegram user ID or chat ID."
    };
  }

  if (kind === "discord") {
    const discordPolicy = policy as import("../contracts/channel.js").DiscordAuthPolicy;
    const allowedUserIds = new Set(discordPolicy.allowedUserIds ?? []);
    const allowedGuildIds = new Set(discordPolicy.allowedGuildIds ?? []);
    const allowed =
      allowedUserIds.has(message.sender.id) ||
      allowedUserIds.has(message.sessionKey.userId ?? "") ||
      allowedGuildIds.has((message.metadata?.guildId as string) ?? "");
    return {
      allowed,
      message: allowed
        ? ""
        : discordPolicy.deniedMessage ??
          "This EstaCoda Discord gateway is locked. Ask the owner to add your Discord user ID or guild ID."
    };
  }

  if (kind === "email") {
    const emailPolicy = policy as import("../contracts/channel.js").EmailAuthPolicy;
    const allowedSenders = new Set((emailPolicy.allowedSenders ?? []).map((s) => s.toLowerCase()));
    const senderId = message.sender.id.toLowerCase();
    const allowed = allowedSenders.has(senderId);
    return {
      allowed,
      message: allowed
        ? ""
        : emailPolicy.deniedMessage ??
          "This EstaCoda email gateway is locked. Ask the owner to add your sender address to the allowlist."
    };
  }

  if (kind === "whatsapp") {
    const whatsappPolicy = policy as import("../contracts/channel.js").WhatsAppAuthPolicy;
    if (message.sessionKey.chatType === "group") {
      const groupPolicy = whatsappPolicy.groupPolicy ?? "disabled";
      const groupId = normalizeWhatsAppGroupId(message.sessionKey.chatId);
      const allowedGroups = new Set(normalizeWhatsAppGroupAllowlist(whatsappPolicy.allowedGroups));
      const freeResponseChats = new Set(normalizeWhatsAppGroupAllowlist(whatsappPolicy.freeResponseChats));
      const groupAllowed = groupPolicy === "open" || (groupPolicy === "allowlist" && allowedGroups.has(groupId));
      const matchedMentionPattern = firstMatchingMentionPattern(message.text, whatsappPolicy.mentionPatterns ?? []);
      const mentionAllowed =
        whatsappPolicy.requireMention !== true ||
        freeResponseChats.has(groupId) ||
        matchedMentionPattern !== undefined;
      const allowed = groupAllowed && mentionAllowed;
      return {
        allowed,
        pairingAllowed: false,
        silentDrop: !allowed,
        authorizedText: allowed && whatsappPolicy.requireMention === true && !freeResponseChats.has(groupId) && matchedMentionPattern !== undefined
          ? stripMentionPattern(message.text, matchedMentionPattern)
          : undefined,
        message: allowed
          ? ""
          : whatsappPolicy.deniedMessage ??
            "This EstaCoda WhatsApp gateway is locked. Ask the owner to allow this WhatsApp group."
      };
    }

    const dmPolicy = whatsappPolicy.dmPolicy ?? "allowlist";
    if (dmPolicy === "disabled") {
      return {
        allowed: false,
        pairingAllowed: false,
        message: whatsappPolicy.deniedMessage ??
          "This EstaCoda WhatsApp gateway is not accepting direct messages."
      };
    }
    if (dmPolicy === "open") {
      return { allowed: true, message: "" };
    }

    const allowedNumbers = new Set(normalizeWhatsAppAllowlist(whatsappPolicy.allowedNumbers));
    const normalizedSender = normalizeWhatsAppUserId(message.sender.id);
    const normalizedSessionUser = normalizeWhatsAppUserId(message.sessionKey.userId ?? "");
    const allowed = dmPolicy === "allowlist" &&
      (allowedNumbers.has(normalizedSender) || allowedNumbers.has(normalizedSessionUser));
    return {
      allowed,
      pairingAllowed: dmPolicy === "pairing",
      message: allowed
        ? ""
        : whatsappPolicy.deniedMessage ??
          "This EstaCoda WhatsApp gateway is locked. Ask the owner to add your phone number to the allowlist."
    };
  }

  return {
    allowed: false,
    message: `This EstaCoda ${kind} gateway is locked. Authorization is not implemented for this channel kind.`
  };
}

function firstMatchingMentionPattern(text: string, patterns: readonly string[]): string | undefined {
  let best: { pattern: string; index: number } | undefined;
  for (const pattern of patterns) {
    if (pattern.length === 0) continue;
    const index = text.indexOf(pattern);
    if (index === -1) continue;
    if (best === undefined || index < best.index || (index === best.index && pattern.length > best.pattern.length)) {
      best = { pattern, index };
    }
  }
  return best?.pattern;
}

function stripMentionPattern(text: string, pattern: string): string {
  const index = text.indexOf(pattern);
  if (index === -1) return text;
  const before = text.slice(0, index).replace(/[\s,;:.-]+$/u, " ");
  const after = text.slice(index + pattern.length).replace(/^[\s,;:.-]+/u, " ");
  return `${before}${after}`
    .replace(/[ \t]{2,}/gu, " ")
    .trim();
}

function readDebounceMetadata(metadata: Record<string, unknown> | undefined): {
  debouncedMessageIds: string[];
  debounceSize: number;
  debounceWindowMs: number;
} | undefined {
  const ids = metadata?.debouncedMessageIds;
  const size = metadata?.debounceSize;
  const windowMs = metadata?.debounceWindowMs;
  if (
    !Array.isArray(ids) ||
    ids.some((id) => typeof id !== "string") ||
    typeof size !== "number" ||
    !Number.isFinite(size) ||
    typeof windowMs !== "number" ||
    !Number.isFinite(windowMs)
  ) {
    return undefined;
  }
  return {
    debouncedMessageIds: ids.slice(0, 100),
    debounceSize: Math.max(0, Math.trunc(size)),
    debounceWindowMs: Math.max(0, Math.trunc(windowMs))
  };
}

function parseGatewayCommand(text: string): "/help" | "/status" | "/memory" | "/sessions" | "/switch" | "/search" | "/compact" | "/new" | "/reset" | "/reload-mcp" | "/resume" | "/stop" | "/approve" | "/deny" | "/commands" | "/approvals" | "/revoke" | "/trust" | "/untrust" | "/workspace.trust.grant" | "/workspace.trust.revoke" | "/workspace.trust.status" | "/yolo" | "/cron" | "/attach" | "/detach" | "/sethome" | "/diagnostics" | undefined {
  const token = text.trim().split(/\s+/u)[0]?.toLowerCase();

  if (
    token === "/help" ||
    token === "/status" ||
    token === "/memory" ||
    token === "/sessions" ||
    token === "/switch" ||
    token === "/search" ||
    token === "/compact" ||
    token === "/new" ||
    token === "/reset" ||
    token === "/reload-mcp" ||
    token === "/trust" ||
    token === "/untrust" ||
    token === "/workspace.trust.grant" ||
    token === "/workspace.trust.revoke" ||
    token === "/workspace.trust.status" ||
    token === "/yolo" ||
    token === "/cron" ||
    token === "/resume" ||
    token === "/stop" ||
    token === "/approve" ||
    token === "/deny" ||
    token === "/commands" ||
    token === "/approvals" ||
    token === "/revoke" ||
    token === "/attach" ||
    token === "/detach" ||
    token === "/sethome" ||
    token === "/diagnostics"
  ) {
    return token;
  }

  return undefined;
}

function parseGatewayCommandArgs(text: string): string[] {
  const [, ...args] = text.trim().split(/\s+/u);
  return args;
}

function firstPendingApproval(
  executions: ToolExecutionRecord[],
  originalMessage: ChannelMessage,
  sessionId: string
): PendingApprovalContinuation | undefined {
  const blocked = executions.find((execution) => execution.decision === "ask");

  if (blocked === undefined) {
    return undefined;
  }

  return {
    kind: "command",
    toolName: blocked.tool.name,
    riskClass: blocked.riskClass,
    targetKey: blocked.targetKey,
    targetSummary: blocked.targetSummary,
    sessionId,
    originalMessage
  };
}

function firstPendingSetupApproval(
  requests: AgentLoopSetupApprovalRequest[] | undefined,
  originalMessage: ChannelMessage,
  sessionId: string
): PendingApprovalContinuation | undefined {
  const request = requests?.find((item): item is AgentLoopPythonCapabilitySetupApprovalRequest =>
    item.kind === "managed-python-capability-install"
  );
  if (request === undefined) {
    return undefined;
  }

  const targetSummary = managedPythonCapabilityApprovalPreview(request);
  return {
    kind: "managed-python-capability-install",
    toolName: "python-env.setup",
    riskClass: "external-side-effect",
    targetKey: `python-env.setup:${request.capabilityId}:${request.groups.join(",")}`,
    targetSummary,
    capability: request,
    sessionId,
    originalMessage
  };
}

function hardlineAssessmentForRequest(
  request: SecurityRequest,
  mode: SecurityApprovalMode
): SecurityAssessment | undefined {
  const command = request.command ?? request.targetSummary ?? "";
  const hardline = assessHardlineFloor(command, { environmentType: request.environmentType });
  if (hardline === undefined) {
    return undefined;
  }

  return {
    decision: "deny",
    mode,
    reason: hardline.reason,
    risk: "high",
    deterministicRule: hardline.code,
    assessor: {
      used: false,
      status: "hard-block-overrode-assessor"
    }
  };
}

function renderApprovalPrompt(input: PendingApprovalContinuation, format: "plain" | "html" = "plain"): string {
  if (input.kind === "managed-python-capability-install") {
    return renderPythonCapabilityApprovalPrompt(input, format);
  }

  const reason = deriveApprovalReason(input);
  const preview = truncateForApprovalPreview(input.targetSummary ?? input.toolName, 320);

  if (format === "html") {
    return [
      "<b>⚠️ Command Approval Required</b>",
      `<b>${escapeHtml(formatApprovalToolLabel(input.toolName))}</b>`,
      `<pre>${escapeHtml(preview)}</pre>`,
      `<b>Reason:</b> ${escapeHtml(reason)}`,
      `<b>Risk:</b> ${escapeHtml(formatRiskLabel(input.riskClass))}`
    ].join("\n");
  }

  return [
    "⚠️ Command approval required",
    `Tool: ${formatApprovalToolLabel(input.toolName)}`,
    `Preview: ${preview}`,
    `Reason: ${reason}`,
    `Risk: ${formatRiskLabel(input.riskClass)}`,
    "",
    "Choose one:",
    "• /approve once - allow this exact action one time",
    "• /approve session - allow matching actions for the current session",
    "• /approve always - persist approval for this chat and matching target",
    "• /deny - keep it blocked",
    "",
    "Use /approvals to review current trust state."
  ].join("\n");
}

function renderPendingApprovalActions(input: PendingApprovalContinuation): ChannelTextAction[][] {
  if (input.approvalId === undefined) {
    return [];
  }
  return input.kind === "managed-python-capability-install"
    ? renderSetupApprovalActions(input.approvalId)
    : renderApprovalActions(input.approvalId);
}

function renderPythonCapabilityApprovalPrompt(
  input: PythonCapabilityPendingApprovalContinuation,
  format: "plain" | "html"
): string {
  const capability = input.capability;
  const packages = capability.packages.length === 0 ? "registered packages" : capability.packages.join(", ");
  const groups = capability.groups.length === 0 ? "none" : capability.groups.join(", ");
  const size = capability.estimatedInstallSizeMb === undefined
    ? undefined
    : `${capability.estimatedInstallSizeMb} MB estimated`;
  const reason = capability.reason ?? "Required by the selected skill before it can run.";

  if (format === "html") {
    return [
      "<b>⚠️ Capability Setup Approval Required</b>",
      `<b>${escapeHtml(capability.capabilityId)}</b>`,
      capability.skillName === undefined ? undefined : `<b>Skill:</b> ${escapeHtml(capability.skillName)}`,
      `<b>Packages:</b> ${escapeHtml(packages)}`,
      `<b>Groups:</b> ${escapeHtml(groups)}`,
      size === undefined ? undefined : `<b>Size:</b> ${escapeHtml(size)}`,
      `<b>Reason:</b> ${escapeHtml(reason)}`,
      "Approve only if you want EstaCoda to download and install this managed Python capability."
    ].filter((line): line is string => line !== undefined).join("\n");
  }

  return [
    "⚠️ Capability setup approval required",
    `Capability: ${capability.capabilityId}`,
    capability.skillName === undefined ? undefined : `Skill: ${capability.skillName}`,
    `Packages: ${packages}`,
    `Groups: ${groups}`,
    size === undefined ? undefined : `Size: ${size}`,
    `Reason: ${reason}`,
    "",
    "Choose one:",
    "• /approve - download and install this managed capability",
    "• /deny - keep it uninstalled"
  ].filter((line): line is string => line !== undefined).join("\n");
}

function managedPythonCapabilityApprovalPreview(
  request: AgentLoopPythonCapabilitySetupApprovalRequest
): string {
  const groups = request.groups.length === 0 ? "none" : request.groups.join(",");
  const packages = request.packages.length === 0 ? "registered packages" : request.packages.join(", ");
  return [
    `Install managed Python capability ${request.capabilityId}`,
    `groups=${groups}`,
    `packages=${packages}`
  ].join("; ");
}

function managedPythonCapabilityApprovalPayload(
  request: AgentLoopPythonCapabilitySetupApprovalRequest,
  originalMessage: ChannelMessage
): ManagedPythonCapabilityApprovalPayload {
  return {
    capabilityId: request.capabilityId,
    groups: [...request.groups],
    packages: [...request.packages],
    estimatedInstallSizeMb: request.estimatedInstallSizeMb,
    skillName: request.skillName,
    reason: request.reason,
    repairCommand: request.repairCommand,
    originalMessage: {
      id: originalMessage.id,
      channel: originalMessage.channel,
      sessionKey: { ...originalMessage.sessionKey },
      sender: { ...originalMessage.sender },
      text: originalMessage.text,
      receivedAt: originalMessage.receivedAt,
      attachments: originalMessage.attachments?.map((attachment) => ({ ...attachment })),
      metadata: cloneJsonObject(originalMessage.metadata)
    }
  };
}

function channelMessageFromApprovalPayload(
  payload: NonNullable<ManagedPythonCapabilityApprovalPayload["originalMessage"]>
): ChannelMessage | undefined {
  if (payload.sessionKey.chatId.trim() === "" || payload.sender.id.trim() === "") {
    return undefined;
  }
  return {
    id: payload.id,
    channel: payload.channel,
    sessionKey: { ...payload.sessionKey },
    sender: { ...payload.sender },
    text: payload.text,
    receivedAt: payload.receivedAt,
    attachments: payload.attachments?.map((attachment) => ({ ...attachment })),
    metadata: cloneJsonObject(payload.metadata)
  };
}

function cloneJsonObject<T extends Record<string, unknown> | undefined>(value: T): T {
  if (value === undefined) {
    return undefined as T;
  }
  try {
    return JSON.parse(JSON.stringify(value)) as T;
  } catch {
    return undefined as T;
  }
}

function parseApprovalScope(text: string): ApprovalScope {
  const lower = text.toLowerCase();

  if (/\balways\b/u.test(lower)) {
    return "always";
  }

  if (/\bsession\b/u.test(lower)) {
    return "session";
  }

  return "once";
}

export function telegramGatewayCommands(): Array<{ command: string; description: string }> {
  return [
    { command: "/help", description: "Show Telegram help" },
    { command: "/status", description: "Show current session status" },
    { command: "/model", description: "Choose a session model" },
    { command: "/memory", description: "Inspect and manage memory curation" },
    { command: "/sessions", description: "List recent chat sessions" },
    { command: "/switch", description: "Switch to an existing session" },
    { command: "/search", description: "Search session history" },
    { command: "/compact", description: "Compact this session context" },
    { command: "/new", description: "Start a fresh session" },
    { command: "/reset", description: "Alias for /new" },
    { command: "/trust", description: "Trust this workspace" },
    { command: "/untrust", description: "Revoke workspace trust" },
    { command: "/workspace.trust.status", description: "Show workspace trust state" },
    { command: "/voice", description: "Control voice reply mode" },
    { command: "/yolo", description: "Toggle YOLO/open mode for this chat" },
    { command: "/cron", description: "Manage scheduled tasks" },
    { command: "/resume", description: "Show the latest interrupted turn" },
    { command: "/approve", description: "Approve the pending gated action" },
    { command: "/deny", description: "Deny the pending gated action" },
    { command: "/approvals", description: "Show approval state for this chat" },
    { command: "/revoke", description: "Revoke a persistent approval" },
    { command: "/commands", description: "Show available Telegram commands" },
    { command: "/attach", description: "Attach to a CLI session" },
    { command: "/detach", description: "Detach from linked CLI session" },
    { command: "/sethome", description: "Set default delivery target for this chat" },
    { command: "/diagnostics", description: "Show gateway health and config" },
    { command: "/stop", description: "Stop the active turn or gateway" }
  ];
}

function formatEphemeralApproval(grant: ApprovalGrant): string {
  return [
    `${grant.toolName} (${grant.riskClass})`,
    grant.targetKey === undefined ? undefined : `match=${grant.targetKey}`,
    grant.targetSummary === undefined ? undefined : `target=${grant.targetSummary}`,
    `scope=${grant.scope}`
  ].filter(Boolean).join(" · ");
}

function formatPersistentApproval(grant: PersistedApprovalGrant): string {
  return [
    `${grant.toolName} (${grant.riskClass})`,
    grant.targetKey === undefined ? undefined : `match=${grant.targetKey}`,
    grant.targetSummary === undefined ? undefined : `target=${grant.targetSummary}`,
    grant.chatId === undefined ? undefined : `chat=${grant.chatId}`
  ].filter(Boolean).join(" · ");
}

function formatPendingApproval(pending: PendingApprovalContinuation): string {
  return [
    "Pending approval:",
    pending.approvalId === undefined ? undefined : `ID: ${pending.approvalId}`,
    `Tool: ${pending.toolName}`,
    `Risk: ${formatRiskLabel(pending.riskClass)}`,
    pending.targetSummary === undefined ? undefined : `Target: ${pending.targetSummary}`
  ].filter(Boolean).join("\n");
}

function deriveApprovalReason(input: PendingApprovalContinuation): string {
  const summary = (input.targetSummary ?? "").toLowerCase();

  if (input.toolName === "terminal.run") {
    if (/\brm\b/.test(summary) && / -r| -rf| --recursive/.test(summary)) {
      return "recursive delete";
    }

    if (/\bcurl\b|\bwget\b/.test(summary)) {
      return "network fetch";
    }

    if (/\bchmod\b|\bchown\b/.test(summary)) {
      return "permission change";
    }
  }

  if (input.toolName === "file.write" || input.toolName === "file.patch") {
    return "file modification";
  }

  if (input.toolName === "process.start" || input.toolName === "process.stop") {
    return "process control";
  }

  return formatRiskLabel(input.riskClass);
}

function truncateSingleLine(value: string, maxLength: number): string {
  const singleLine = value.replace(/\s+/gu, " ").trim();
  if (singleLine.length <= maxLength) {
    return singleLine;
  }

  return `${singleLine.slice(0, Math.max(0, maxLength - 1))}…`;
}

function formatApprovalToolLabel(toolName: string): string {
  if (toolName === "terminal.run") {
    return "Shell";
  }

  if (toolName.startsWith("file.")) {
    return "File";
  }

  if (toolName.startsWith("process.")) {
    return "Process";
  }

  return toolName;
}

function truncateForApprovalPreview(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars - 1)}…`;
}

function dateOrNow(value: string): Date {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function toPendingApprovalChannel(channel: ChannelKind): PendingApprovalChannel {
  const value = String(channel);
  if (value === "telegram" || value === "discord" || value === "email" || value === "cli") {
    return value;
  }

  return "cli";
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function formatRiskLabel(riskClass: string): string {
  switch (riskClass) {
    case "destructive-local":
      return "destructive local action";
    case "workspace-write":
      return "workspace write";
    case "shared-state-mutation":
      return "shared state change";
    case "credential-access":
      return "credential access";
    case "external-side-effect":
      return "external side effect";
    case "sandbox-escape":
      return "sandbox escape";
    case "spend-money":
      return "spend money";
    case "read-only-network":
      return "read-only network";
    case "read-only-local":
      return "read-only local";
    default:
      return riskClass;
  }
}

function matchesPersistentApproval(grant: PersistedApprovalGrant, request: SecurityRequest): boolean {
  return grant.toolName === request.toolName &&
    grant.riskClass === request.riskClass &&
    grant.targetKey === request.targetKey;
}
