import type {
  ChannelAdapter,
  ChannelAuthPolicy,
  ChannelGatewayResult,
  ChannelMessage,
  ChannelSessionKey
} from "../contracts/channel.js";
import { assessSecurityPolicy, type SecurityApprovalMode, type SecurityDecision, type SecurityPolicy, type SecurityRequest } from "../contracts/security.js";
import { runCronCommand } from "../cron/cron-command.js";
import { originFromSessionKey } from "../cron/cron-runner.js";
import { CronStore } from "../cron/cron-store.js";
import type { Runtime } from "../runtime/create-runtime.js";
import type { SecurityAssessorRuntimeConfig } from "../security/security-policy-factory.js";
import type { ToolExecutionRecord } from "../tools/tool-executor.js";
import { ChannelApprovalStore, type PersistedApprovalGrant } from "./channel-approval-store.js";
import { buildBaseSessionId, normalizeSessionKey, type ChannelSessionPolicy, shouldAutoResetSession, stableSessionKey } from "./channel-session-store.js";
import { createSecurityPolicyForMode } from "../security/security-policy-factory.js";
import type { HandoffStore } from "./handoff-store.js";
import type { SurfacePointerStore } from "./surface-pointer-store.js";
import type { SurfaceType } from "./surface-pointer.js";

export type ChannelRuntimeFactory = (input: {
  sessionId: string;
  sessionKey: ChannelSessionKey;
  channel: string;
  securityPolicy: SecurityPolicy;
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
  authPolicy?: ChannelAuthPolicy;
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
};

type ApprovalScope = "once" | "session" | "always";

type PendingApproval = {
  toolName: string;
  riskClass: string;
  targetKey?: string;
  targetSummary?: string;
  sessionId: string;
  originalMessage: ChannelMessage;
};

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
  readonly #authPolicy: ChannelAuthPolicy;
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
  readonly #activeTurns = new Map<string, AbortController>();
  readonly #pendingApprovals = new Map<string, PendingApproval>();
  readonly #approvalGrants = new Map<string, ApprovalGrant[]>();
  readonly #yoloSessions = new Map<string, boolean>();

  constructor(options: ChannelGatewayOptions) {
    this.#runtimeForSession = options.runtimeForSession;
    this.#sessionStore = options.sessionStore ?? new InMemoryChannelSessionStore();
    this.#authPolicy = options.authPolicy ?? { mode: "allowlist", allowedUserIds: [], allowedChatIds: [] };
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

    for (const adapter of options.adapters) {
      this.#adapters.set(adapter.id ?? adapter.kind, adapter);
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
    for (const adapter of this.#adapters.values()) {
      await adapter.stop?.();
    }
  }

  async receive(message: ChannelMessage): Promise<ChannelGatewayResult> {
    const adapter = this.#adapterFor(message.channel);
    const auth = authorizeChannelMessage(message, this.#authPolicy);

    if (!auth.allowed) {
      const pairedMessage = await this.#pair?.(message);

      if (pairedMessage !== undefined) {
        await adapter.delivery?.sendText(message.sessionKey, pairedMessage);
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

      await adapter.delivery?.sendText(message.sessionKey, auth.message);
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

    const commandResult = await this.#handleCommand(message, adapter);

    if (commandResult !== undefined) {
      return commandResult;
    }

    const processedMessage = await this.#preprocessMessage?.(message) ?? message;

    const sessionId = await this.#sessionStore.getOrCreateSessionId(processedMessage.sessionKey, {
      receivedAt: processedMessage.receivedAt
    });
    const normalizedSessionKey = normalizeSessionKey(processedMessage.sessionKey, this.#sessionPolicy);
    const securityPolicy = this.#securityPolicyFor(
      normalizedSessionKey,
      sessionId,
      await this.#approvalStore.listForSession(normalizedSessionKey)
    );
    const runtime = await this.#runtimeForSession({
      sessionId,
      sessionKey: normalizedSessionKey,
      channel: message.channel,
      securityPolicy
    });
    let progressCount = 0;
    const activeTurnKey = stableSessionKey(processedMessage.sessionKey, this.#sessionPolicy);
    const controller = new AbortController();
    this.#activeTurns.set(activeTurnKey, controller);
    const trustedWorkspace = typeof this.#trustedWorkspace === "function"
      ? await this.#trustedWorkspace(message)
      : this.#trustedWorkspace;
    const response = await runtime.handle({
      text: processedMessage.text,
      attachments: processedMessage.attachments,
      channel: processedMessage.channel,
      trustedWorkspace,
      signal: controller.signal,
      onEvent: async (event) => {
        progressCount += 1;
        await adapter.delivery?.sendProgress?.(normalizedSessionKey, event);
      }
    }).finally(() => {
      if (this.#activeTurns.get(activeTurnKey) === controller) {
        this.#activeTurns.delete(activeTurnKey);
      }
    });

    const pendingApproval = firstPendingApproval(response.toolExecutions, message, sessionId);
    if (pendingApproval !== undefined) {
      this.#pendingApprovals.set(activeTurnKey, pendingApproval);
    } else {
      this.#pendingApprovals.delete(activeTurnKey);
    }

    try {
      await adapter.delivery?.sendText(normalizedSessionKey, response.text);
      await adapter.send?.({
        conversationId: message.sessionKey.chatId,
        sessionKey: normalizedSessionKey,
        text: response.text,
        artifacts: response.artifacts
      });

      for (const artifact of response.artifacts) {
        await adapter.delivery?.sendArtifact?.(normalizedSessionKey, artifact);
      }

      if (pendingApproval !== undefined) {
        const approvalPrompt = renderApprovalPrompt(pendingApproval, adapter.kind === "telegram" ? "html" : "plain");
        await adapter.delivery?.sendText(
          normalizedSessionKey,
          approvalPrompt,
          adapter.kind === "telegram"
            ? {
                format: "html",
                actions: approvalActions()
              }
            : undefined
        );
        await adapter.send?.({
          conversationId: message.sessionKey.chatId,
          sessionKey: normalizedSessionKey,
          text: approvalPrompt
        });
      }

      return {
        sessionId,
        replyText: response.text,
        artifactCount: response.artifacts.length,
        progressCount
      };
    } finally {
      await runtime.dispose();
    }
  }

  async #handleCommand(message: ChannelMessage, adapter: ChannelAdapter): Promise<ChannelGatewayResult | undefined> {
    const command = parseGatewayCommand(message.text);

    if (command === undefined) {
      return undefined;
    }

    if (command === "/help") {
      const text = [
        "EstaCoda channel commands",
        "/help - show this help",
        "/status - show the active channel session",
        "/memory - inspect promoted memory conclusions",
        "/sessions - list recent sessions for this chat",
        "/switch <session-id> - switch this chat to a specific session",
        "/search <query> - search session history",
        "/new - start a fresh session",
        "/reset - alias for /new",
        "/reload-mcp - reload MCP config for future turns in this chat",
        "/trust - trust this workspace for local read/write work",
        "/untrust - revoke workspace trust for this chat session",
        "/workspace.trust.status - show current workspace trust state",
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
        "/stop - stop the foreground gateway process"
      ].join("\n");
      await adapter.delivery?.sendText(message.sessionKey, text);

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
        `YOLO mode: ${this.#isYoloEnabled(message.sessionKey, sessionId) ? "on" : "off"}`
      ].join("\n");
      await adapter.delivery?.sendText(message.sessionKey, text);

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
      await adapter.delivery?.sendText(message.sessionKey, text);

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
        await adapter.delivery?.sendText(message.sessionKey, text);
        return {
          sessionId: await this.#sessionStore.getOrCreateSessionId(message.sessionKey, { receivedAt: message.receivedAt }),
          replyText: text,
          artifactCount: 0,
          progressCount: 0
        };
      }

      if (this.#handoffStore === undefined || this.#surfacePointerStore === undefined) {
        const text = "Handoff is not configured on this gateway.";
        await adapter.delivery?.sendText(message.sessionKey, text);
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
        await adapter.delivery?.sendText(message.sessionKey, text);
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
      await adapter.delivery?.sendText(message.sessionKey, text);

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
        await adapter.delivery?.sendText(message.sessionKey, text);
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
        await adapter.delivery?.sendText(message.sessionKey, text);
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
      const text = [
        "Detached this chat from the linked session.",
        `Previous session: ${pointer.sessionId}`,
        `Current session: ${newSessionId}`,
        "This chat now operates independently."
      ].join("\n");
      await adapter.delivery?.sendText(message.sessionKey, text);

      return {
        sessionId: newSessionId,
        replyText: text,
        artifactCount: 0,
        progressCount: 0
      };
    }

    if (command === "/cron") {
      const sessionId = await this.#sessionStore.getOrCreateSessionId(message.sessionKey, { receivedAt: message.receivedAt });
      const result = await runCronCommand({
        args: tokenizeCommandArgs(message.text).slice(1),
        store: new CronStore(),
        origin: originFromSessionKey(message.sessionKey, message.channel),
        defaultDelivery: "origin"
      });
      await adapter.delivery?.sendText(message.sessionKey, result.output);

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
        await adapter.delivery?.sendText(message.sessionKey, text);
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
        await adapter.delivery?.sendText(message.sessionKey, text);
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
        await adapter.delivery?.sendText(message.sessionKey, text);
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
        const promotions = await runtime.inspectMemoryPromotions();
        const text = promotions.length === 0
          ? "No promoted memory conclusions found."
          : [
              "Promoted memory conclusions",
              ...promotions.map((record, index) => {
                const state = record.active ? "active" : record.forgottenAt !== undefined ? "forgotten" : "inactive";
                const source = record.sourceSessionIds.length === 0 ? "no session provenance" : `${record.sourceSessionIds.length} session${record.sourceSessionIds.length === 1 ? "" : "s"}`;
                return `${index + 1}. ${record.content} [${state}; occurrences:${record.occurrences}; ${source}]`;
              })
            ].join("\n");
        await adapter.delivery?.sendText(message.sessionKey, text);
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
        await adapter.delivery?.sendText(message.sessionKey, text);

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
        await adapter.delivery?.sendText(message.sessionKey, text);

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
      const sessionId = await this.#resetSession(message.sessionKey, message.receivedAt);
      const key = stableSessionKey(message.sessionKey, this.#sessionPolicy);
      this.#pendingApprovals.delete(key);
      this.#approvalGrants.delete(key);
      const text = [
        "Started a fresh EstaCoda session for this chat.",
        `Session: ${sessionId}`
      ].join("\n");
      await adapter.delivery?.sendText(message.sessionKey, text);

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
        await adapter.delivery?.sendText(message.sessionKey, text);

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
      await adapter.delivery?.sendText(message.sessionKey, text);

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
        await adapter.delivery?.sendText(message.sessionKey, text);
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
          await adapter.delivery?.sendText(message.sessionKey, text);
          return {
            sessionId: currentSessionId,
            replyText: text,
            artifactCount: 0,
            progressCount: 0
          };
        }

        await this.#sessionStore.setSessionId?.(message.sessionKey, targetSessionId, { receivedAt: message.receivedAt });
        const key = stableSessionKey(message.sessionKey, this.#sessionPolicy);
        this.#pendingApprovals.delete(key);
        this.#approvalGrants.delete(key);
        const text = [
          "Switched this chat to an existing session.",
          `Session: ${targetSessionId}`
        ].join("\n");
        await adapter.delivery?.sendText(message.sessionKey, text);
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
        await adapter.delivery?.sendText(message.sessionKey, text);
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
        const matches = (await runtime.sessionDb.search(query, { profileId: "default", limit: 20 }))
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
        await adapter.delivery?.sendText(message.sessionKey, text);
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
      const key = stableSessionKey(message.sessionKey, this.#sessionPolicy);
      const pending = this.#pendingApprovals.get(key);
      const text = pending === undefined
        ? "There is no pending approval request for this chat."
        : [
            "❌ Approval denied",
            `Tool: ${pending.toolName}`,
            "EstaCoda will not run that action unless it is requested again."
          ].join("\n");
      this.#pendingApprovals.delete(key);
      await adapter.delivery?.sendText(message.sessionKey, text);

      return {
        sessionId: pending?.sessionId ?? await this.#sessionStore.getOrCreateSessionId(message.sessionKey, { receivedAt: message.receivedAt }),
        replyText: text,
        artifactCount: 0,
        progressCount: 0
      };
    }

    if (command === "/revoke") {
      return this.#revokeApproval(message, adapter);
    }

    if (command === "/stop") {
      const sessionId = await this.#sessionStore.getOrCreateSessionId(message.sessionKey, { receivedAt: message.receivedAt });
      const activeTurn = this.#activeTurns.get(stableSessionKey(message.sessionKey, this.#sessionPolicy));
      if (activeTurn !== undefined) {
        activeTurn.abort("channel-stop");
        const text = "Cancelled the active EstaCoda turn for this chat.";
        await adapter.delivery?.sendText(message.sessionKey, text);

        return {
          sessionId,
          replyText: text,
          artifactCount: 0,
          progressCount: 0
        };
      }

      const text = "Stopping the EstaCoda gateway after this update.";
      await adapter.delivery?.sendText(message.sessionKey, text);
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

  async #approvePending(message: ChannelMessage, adapter: ChannelAdapter): Promise<ChannelGatewayResult> {
    const key = stableSessionKey(message.sessionKey, this.#sessionPolicy);
    const normalizedSessionKey = normalizeSessionKey(message.sessionKey, this.#sessionPolicy);
    const pending = this.#pendingApprovals.get(key);

    if (pending === undefined) {
      const text = "There is no pending approval request for this chat.";
      await adapter.delivery?.sendText(message.sessionKey, text);

      return {
        sessionId: await this.#sessionStore.getOrCreateSessionId(message.sessionKey, { receivedAt: message.receivedAt }),
        replyText: text,
        artifactCount: 0,
        progressCount: 0
      };
    }

    const scope = parseApprovalScope(message.text);
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
    }
    this.#pendingApprovals.delete(key);

    if (scope === "always") {
      await this.#approvalStore.grant({
        sessionKey: normalizedSessionKey,
        toolName: pending.toolName,
        riskClass: pending.riskClass,
        targetKey: pending.targetKey,
        targetSummary: pending.targetSummary
      });
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
    await adapter.delivery?.sendText(message.sessionKey, approvalText);

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
    await adapter.delivery?.sendText(message.sessionKey, text);

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
      await adapter.delivery?.sendText(message.sessionKey, text);

      return {
        sessionId: await this.#sessionStore.getOrCreateSessionId(message.sessionKey, { receivedAt: message.receivedAt }),
        replyText: text,
        artifactCount: 0,
        progressCount: 0
      };
    }

    const revoked = await this.#approvalStore.revoke(approvalId, normalizeSessionKey(message.sessionKey, this.#sessionPolicy));
    const text = revoked
      ? `Revoked persistent approval ${approvalId}.`
      : `No persistent approval matched ${approvalId} for this chat.`;
    await adapter.delivery?.sendText(message.sessionKey, text);

    return {
      sessionId: await this.#sessionStore.getOrCreateSessionId(message.sessionKey, { receivedAt: message.receivedAt }),
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
}

function yoloSessionKey(stableKey: string, sessionId: string): string {
  return `${stableKey}:${sessionId}`;
}

function tokenizeCommandArgs(text: string): string[] {
  const matches = text.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/gu);
  return [...matches].map((match) => match[1] ?? match[2] ?? match[3] ?? "");
}

export function authorizeChannelMessage(message: ChannelMessage, policy: ChannelAuthPolicy): {
  allowed: boolean;
  message: string;
} {
  if (policy.mode === "allow-all") {
    return { allowed: true, message: "" };
  }

  const allowedUserIds = new Set(policy.allowedUserIds ?? []);
  const allowedChatIds = new Set(policy.allowedChatIds ?? []);
  const allowed =
    allowedUserIds.has(message.sender.id) ||
    allowedUserIds.has(message.sessionKey.userId ?? "") ||
    allowedChatIds.has(message.sessionKey.chatId);

  return {
    allowed,
    message: allowed
      ? ""
      : policy.deniedMessage ??
        "This EstaCoda gateway is not paired with this account yet. Pair this chat from a trusted local session first."
  };
}

function parseGatewayCommand(text: string): "/help" | "/status" | "/memory" | "/sessions" | "/switch" | "/search" | "/new" | "/reset" | "/reload-mcp" | "/resume" | "/stop" | "/approve" | "/deny" | "/commands" | "/approvals" | "/revoke" | "/trust" | "/untrust" | "/workspace.trust.grant" | "/workspace.trust.revoke" | "/workspace.trust.status" | "/yolo" | "/cron" | "/attach" | "/detach" | undefined {
  const token = text.trim().split(/\s+/u)[0]?.toLowerCase();

  if (
    token === "/help" ||
    token === "/status" ||
    token === "/memory" ||
    token === "/sessions" ||
    token === "/switch" ||
    token === "/search" ||
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
    token === "/detach"
  ) {
    return token;
  }

  return undefined;
}

function firstPendingApproval(
  executions: ToolExecutionRecord[],
  originalMessage: ChannelMessage,
  sessionId: string
): PendingApproval | undefined {
  const blocked = executions.find((execution) => execution.decision === "ask" || execution.decision === "deny");

  if (blocked === undefined) {
    return undefined;
  }

  return {
    toolName: blocked.tool.name,
    riskClass: blocked.riskClass,
    targetKey: blocked.targetKey,
    targetSummary: blocked.targetSummary,
    sessionId,
    originalMessage
  };
}

function renderApprovalPrompt(input: PendingApproval, format: "plain" | "html" = "plain"): string {
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
    { command: "/memory", description: "Inspect promoted memory conclusions" },
    { command: "/sessions", description: "List recent chat sessions" },
    { command: "/switch", description: "Switch to an existing session" },
    { command: "/search", description: "Search session history" },
    { command: "/new", description: "Start a fresh session" },
    { command: "/reset", description: "Alias for /new" },
    { command: "/trust", description: "Trust this workspace" },
    { command: "/untrust", description: "Revoke workspace trust" },
    { command: "/workspace.trust.status", description: "Show workspace trust state" },
    { command: "/yolo", description: "Toggle YOLO/open mode for this chat" },
    { command: "/cron", description: "Manage scheduled tasks" },
    { command: "/resume", description: "Show the latest interrupted turn" },
    { command: "/approve", description: "Approve the pending gated action" },
    { command: "/deny", description: "Deny the pending gated action" },
    { command: "/approvals", description: "Show approval state for this chat" },
    { command: "/revoke", description: "Revoke a persistent approval" },
    { command: "/commands", description: "Show available Telegram commands" },
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

function formatPendingApproval(pending: PendingApproval): string {
  return [
    "Pending approval:",
    `Tool: ${pending.toolName}`,
    `Risk: ${formatRiskLabel(pending.riskClass)}`,
    pending.targetSummary === undefined ? undefined : `Target: ${pending.targetSummary}`
  ].filter(Boolean).join("\n");
}

function approvalActions() {
  return [
    [
      { label: "✅ Allow Once", value: "/approve once" },
      { label: "✅ Session", value: "/approve session" }
    ],
    [
      { label: "✅ Always", value: "/approve always" },
      { label: "❌ Deny", value: "/deny" }
    ]
  ];
}

function deriveApprovalReason(input: PendingApproval): string {
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

  if (input.toolName === "file.write" || input.toolName === "file.replace") {
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
