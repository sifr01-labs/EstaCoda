import type {
  ChannelAdapter,
  ChannelAuthPolicy,
  ChannelGatewayResult,
  ChannelMessage,
  ChannelSessionKey
} from "../contracts/channel.js";
import { capabilityFirstDefaults, type SecurityDecision, type SecurityPolicy, type SecurityRequest } from "../contracts/security.js";
import type { Runtime } from "../runtime/create-runtime.js";
import type { ToolExecutionRecord } from "../tools/tool-executor.js";
import { ChannelApprovalStore, type PersistedApprovalGrant } from "./channel-approval-store.js";

export type ChannelRuntimeFactory = (input: {
  sessionId: string;
  sessionKey: ChannelSessionKey;
  channel: string;
  securityPolicy: SecurityPolicy;
}) => Promise<Runtime>;

export type ChannelSessionStore = {
  getOrCreateSessionId(sessionKey: ChannelSessionKey): Promise<string>;
  resetSessionId?(sessionKey: ChannelSessionKey): Promise<string>;
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
  readonly #sessions = new Map<string, string>();
  #sequence = 0;

  async getOrCreateSessionId(sessionKey: ChannelSessionKey): Promise<string> {
    const key = stableSessionKey(sessionKey);
    const existing = this.#sessions.get(key);

    if (existing !== undefined) {
      return existing;
    }

    const sessionId = `channel-${sanitizeSessionPart(sessionKey.platform)}-${sanitizeSessionPart(
      sessionKey.accountId ?? "default"
    )}-${sanitizeSessionPart(sessionKey.chatId)}-${sanitizeSessionPart(sessionKey.threadId ?? "main")}`;
    this.#sessions.set(key, sessionId);

    return sessionId;
  }

  async resetSessionId(sessionKey: ChannelSessionKey): Promise<string> {
    const key = stableSessionKey(sessionKey);
    const sessionId = this.#newSessionId(sessionKey);

    this.#sessions.set(key, sessionId);

    return sessionId;
  }

  #newSessionId(sessionKey: ChannelSessionKey): string {
    this.#sequence += 1;

    return `channel-${sanitizeSessionPart(sessionKey.platform)}-${sanitizeSessionPart(
      sessionKey.accountId ?? "default"
    )}-${sanitizeSessionPart(sessionKey.chatId)}-${sanitizeSessionPart(sessionKey.threadId ?? "main")}-${this.#sequence}`;
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
  readonly #activeTurns = new Map<string, AbortController>();
  readonly #pendingApprovals = new Map<string, PendingApproval>();
  readonly #approvalGrants = new Map<string, ApprovalGrant[]>();

  constructor(options: ChannelGatewayOptions) {
    this.#runtimeForSession = options.runtimeForSession;
    this.#sessionStore = options.sessionStore ?? new InMemoryChannelSessionStore();
    this.#authPolicy = options.authPolicy ?? { mode: "allowlist", allowedUserIds: [], allowedChatIds: [] };
    this.#trustedWorkspace = options.trustedWorkspace;
    this.#onStopRequested = options.onStopRequested;
    this.#pair = options.pair;
    this.#approvalStore = options.approvalStore ?? new ChannelApprovalStore();

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

    const sessionId = await this.#sessionStore.getOrCreateSessionId(message.sessionKey);
    const securityPolicy = this.#securityPolicyFor(
      message.sessionKey,
      sessionId,
      await this.#approvalStore.listForSession(message.sessionKey)
    );
    const runtime = await this.#runtimeForSession({
      sessionId,
      sessionKey: message.sessionKey,
      channel: message.channel,
      securityPolicy
    });
    let progressCount = 0;
    const activeTurnKey = stableSessionKey(message.sessionKey);
    const controller = new AbortController();
    this.#activeTurns.set(activeTurnKey, controller);
    const trustedWorkspace = typeof this.#trustedWorkspace === "function"
      ? await this.#trustedWorkspace(message)
      : this.#trustedWorkspace;
    const response = await runtime.handle({
        text: message.text,
        attachments: message.attachments,
        channel: message.channel,
        trustedWorkspace,
        signal: controller.signal,
        onEvent: async (event) => {
          progressCount += 1;
          await adapter.delivery?.sendProgress?.(message.sessionKey, event);
        }
      })
      .finally(() => {
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

    await adapter.delivery?.sendText(message.sessionKey, response.text);
    await adapter.send?.({
      conversationId: message.sessionKey.chatId,
      sessionKey: message.sessionKey,
      text: response.text,
      artifacts: response.artifacts
    });

    for (const artifact of response.artifacts) {
      await adapter.delivery?.sendArtifact?.(message.sessionKey, artifact);
    }

    if (pendingApproval !== undefined) {
      const approvalPrompt = renderApprovalPrompt(pendingApproval, adapter.kind === "telegram" ? "html" : "plain");
      await adapter.delivery?.sendText(
        message.sessionKey,
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
        sessionKey: message.sessionKey,
        text: approvalPrompt
      });
    }

    return {
      sessionId,
      replyText: response.text,
      artifactCount: response.artifacts.length,
      progressCount
    };
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
        "/new - start a fresh session",
        "/reset - alias for /new",
        "/commands - show the Telegram command menu",
        "/resume - show the latest interrupted-turn resume note",
        "/approve [once|session|always] - approve the pending gated action",
        "/deny - deny the pending gated action",
        "/approvals - inspect current approval state",
        "/revoke <approval-id> - revoke a persistent approval",
        "/stop - stop the foreground gateway process"
      ].join("\n");
      await adapter.delivery?.sendText(message.sessionKey, text);

      return {
        sessionId: await this.#sessionStore.getOrCreateSessionId(message.sessionKey),
        replyText: text,
        artifactCount: 0,
        progressCount: 0
      };
    }

    if (command === "/status") {
      const sessionId = await this.#sessionStore.getOrCreateSessionId(message.sessionKey);
      const text = [
        "EstaCoda channel status",
        `Channel: ${message.channel}`,
        `Chat: ${message.sessionKey.chatId}`,
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

    if (command === "/resume") {
      const sessionId = await this.#sessionStore.getOrCreateSessionId(message.sessionKey);
      const runtime = await this.#runtimeForSession({
        sessionId,
        sessionKey: message.sessionKey,
        channel: message.channel,
        securityPolicy: this.#securityPolicyFor(
          message.sessionKey,
          sessionId,
          await this.#approvalStore.listForSession(message.sessionKey)
        )
      });
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
    }

    if (command === "/new" || command === "/reset") {
      const sessionId = await this.#resetSession(message.sessionKey);
      const key = stableSessionKey(message.sessionKey);
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

    if (command === "/commands") {
      const text = [
        "Telegram command menu",
        ...telegramGatewayCommands().map((entry) => `${entry.command} - ${entry.description}`)
      ].join("\n");
      await adapter.delivery?.sendText(message.sessionKey, text);

      return {
        sessionId: await this.#sessionStore.getOrCreateSessionId(message.sessionKey),
        replyText: text,
        artifactCount: 0,
        progressCount: 0
      };
    }

    if (command === "/approve") {
      return this.#approvePending(message, adapter);
    }

    if (command === "/approvals") {
      return this.#showApprovals(message, adapter);
    }

    if (command === "/deny") {
      const key = stableSessionKey(message.sessionKey);
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
        sessionId: pending?.sessionId ?? await this.#sessionStore.getOrCreateSessionId(message.sessionKey),
        replyText: text,
        artifactCount: 0,
        progressCount: 0
      };
    }

    if (command === "/revoke") {
      return this.#revokeApproval(message, adapter);
    }

    if (command === "/stop") {
      const sessionId = await this.#sessionStore.getOrCreateSessionId(message.sessionKey);
      const activeTurn = this.#activeTurns.get(stableSessionKey(message.sessionKey));
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
    const key = stableSessionKey(message.sessionKey);
    const pending = this.#pendingApprovals.get(key);

    if (pending === undefined) {
      const text = "There is no pending approval request for this chat.";
      await adapter.delivery?.sendText(message.sessionKey, text);

      return {
        sessionId: await this.#sessionStore.getOrCreateSessionId(message.sessionKey),
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
        sessionKey: message.sessionKey,
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
    const key = stableSessionKey(message.sessionKey);
    const persistent = await this.#approvalStore.listForSession(message.sessionKey);
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
      sessionId: await this.#sessionStore.getOrCreateSessionId(message.sessionKey),
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
        sessionId: await this.#sessionStore.getOrCreateSessionId(message.sessionKey),
        replyText: text,
        artifactCount: 0,
        progressCount: 0
      };
    }

    const revoked = await this.#approvalStore.revoke(approvalId, message.sessionKey);
    const text = revoked
      ? `Revoked persistent approval ${approvalId}.`
      : `No persistent approval matched ${approvalId} for this chat.`;
    await adapter.delivery?.sendText(message.sessionKey, text);

    return {
      sessionId: await this.#sessionStore.getOrCreateSessionId(message.sessionKey),
      replyText: text,
      artifactCount: 0,
      progressCount: 0
    };
  }

  async #resetSession(sessionKey: ChannelSessionKey): Promise<string> {
    if (this.#sessionStore.resetSessionId !== undefined) {
      return this.#sessionStore.resetSessionId(sessionKey);
    }

    return this.#sessionStore.getOrCreateSessionId(sessionKey);
  }

  #securityPolicyFor(
    sessionKey: ChannelSessionKey,
    sessionId: string,
    persistentApprovals: PersistedApprovalGrant[]
  ): SecurityPolicy {
    const key = stableSessionKey(sessionKey);

    return {
      decide: (request: SecurityRequest): SecurityDecision => {
        const grants = this.#approvalGrants.get(key) ?? [];
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
              this.#approvalGrants.delete(key);
            } else {
              this.#approvalGrants.set(key, grants);
            }
          }

          return "allow";
        }
        if (persistentApprovals.some((grant) => matchesPersistentApproval(grant, request))) {
          return "allow";
        }

        return capabilityFirstDefaults.decide(request);
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

function stableSessionKey(sessionKey: ChannelSessionKey): string {
  return [
    sessionKey.platform,
    sessionKey.accountId ?? "",
    sessionKey.chatId,
    sessionKey.threadId ?? "",
    sessionKey.userId ?? ""
  ].join(":");
}

function sanitizeSessionPart(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");

  return sanitized.length > 0 ? sanitized.slice(0, 64) : "default";
}

function parseGatewayCommand(text: string): "/help" | "/status" | "/new" | "/reset" | "/resume" | "/stop" | "/approve" | "/deny" | "/commands" | "/approvals" | "/revoke" | undefined {
  const token = text.trim().split(/\s+/u)[0]?.toLowerCase();

  if (
    token === "/help" ||
    token === "/status" ||
    token === "/new" ||
    token === "/reset" ||
    token === "/resume" ||
    token === "/stop" ||
    token === "/approve" ||
    token === "/deny" ||
    token === "/commands" ||
    token === "/approvals" ||
    token === "/revoke"
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
    { command: "/new", description: "Start a fresh session" },
    { command: "/reset", description: "Alias for /new" },
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
