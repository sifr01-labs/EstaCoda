import type {
  ChannelAdapter,
  ChannelAuthPolicy,
  ChannelGatewayResult,
  ChannelMessage,
  ChannelSessionKey
} from "../contracts/channel.js";
import type { Runtime } from "../runtime/create-runtime.js";

export type ChannelRuntimeFactory = (input: {
  sessionId: string;
  sessionKey: ChannelSessionKey;
  channel: string;
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
  readonly #activeTurns = new Map<string, AbortController>();

  constructor(options: ChannelGatewayOptions) {
    this.#runtimeForSession = options.runtimeForSession;
    this.#sessionStore = options.sessionStore ?? new InMemoryChannelSessionStore();
    this.#authPolicy = options.authPolicy ?? { mode: "allowlist", allowedUserIds: [], allowedChatIds: [] };
    this.#trustedWorkspace = options.trustedWorkspace;
    this.#onStopRequested = options.onStopRequested;
    this.#pair = options.pair;

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
    const runtime = await this.#runtimeForSession({
      sessionId,
      sessionKey: message.sessionKey,
      channel: message.channel
    });
    let progressCount = 0;
    const activeTurnKey = stableSessionKey(message.sessionKey);
    const controller = new AbortController();
    this.#activeTurns.set(activeTurnKey, controller);
    const trustedWorkspace = typeof this.#trustedWorkspace === "function"
      ? await this.#trustedWorkspace(message)
      : this.#trustedWorkspace;
    const response = await runtime.handle({
        text: renderChannelInput(message),
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
        "/resume - show the latest interrupted-turn resume note",
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
        channel: message.channel
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

  async #resetSession(sessionKey: ChannelSessionKey): Promise<string> {
    if (this.#sessionStore.resetSessionId !== undefined) {
      return this.#sessionStore.resetSessionId(sessionKey);
    }

    return this.#sessionStore.getOrCreateSessionId(sessionKey);
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

function renderChannelInput(message: ChannelMessage): string {
  const attachmentLines = (message.attachments ?? []).map((attachment) => {
    const name = attachment.originalName ?? attachment.name ?? attachment.localPath ?? attachment.path ?? attachment.remoteUrl ?? attachment.url ?? attachment.id;
    return `- ${attachment.kind}: ${name}`;
  });

  if (attachmentLines.length === 0) {
    return message.text;
  }

  return [
    message.text,
    "",
    "Channel attachments:",
    ...attachmentLines
  ].join("\n");
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

function parseGatewayCommand(text: string): "/help" | "/status" | "/new" | "/reset" | "/resume" | "/stop" | undefined {
  const token = text.trim().split(/\s+/u)[0]?.toLowerCase();

  if (token === "/help" || token === "/status" || token === "/new" || token === "/reset" || token === "/resume" || token === "/stop") {
    return token;
  }

  return undefined;
}
