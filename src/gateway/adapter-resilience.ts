import type { ChannelAdapter, ChannelKind, ChannelDelivery, ChannelMessage } from "../contracts/channel.js";
import { classifyWhatsAppBridgeError } from "../channels/whatsapp-bridge-errors.js";
import type { AdapterRuntimeState } from "./adapter-runtime-state.js";
import type { GatewayHookEventName, GatewayHookPayloadByName } from "./hook-registry.js";
import { HookRegistry, sanitizeHookError } from "./hook-registry.js";

export const DEFAULT_ADAPTER_BACKOFF = {
  baseDelayMs: 1000,
  maxDelayMs: 60_000,
  maxAttempts: 5,
  jitter: 0.2,
};

export type BackoffOptions = {
  baseDelayMs?: number;
  maxDelayMs?: number;
  maxAttempts?: number;
  jitter?: number;
  randomFn?: () => number;
};

export function computeBackoffDelay(attempt: number, options: Required<BackoffOptions>): number {
  const base = Math.min(
    options.baseDelayMs * Math.pow(2, attempt - 1),
    options.maxDelayMs
  );
  const jitterFactor = 1 + options.randomFn() * options.jitter;
  return Math.round(base * jitterFactor);
}

export class AdapterResilienceSupervisor {
  readonly rawAdapter: ChannelAdapter;
  readonly #options: Required<BackoffOptions>;
  #state: AdapterRuntimeState;
  #handler: ((message: ChannelMessage) => Promise<void>) | undefined;
  #onStateChange: (() => void) | undefined;
  #hookRegistry?: HookRegistry;

  constructor(
    adapter: ChannelAdapter,
    options?: BackoffOptions,
    onStateChange?: () => void,
    hookRegistry?: HookRegistry,
  ) {
    this.rawAdapter = adapter;
    this.#options = {
      baseDelayMs: options?.baseDelayMs ?? DEFAULT_ADAPTER_BACKOFF.baseDelayMs,
      maxDelayMs: options?.maxDelayMs ?? DEFAULT_ADAPTER_BACKOFF.maxDelayMs,
      maxAttempts: options?.maxAttempts ?? DEFAULT_ADAPTER_BACKOFF.maxAttempts,
      jitter: options?.jitter ?? DEFAULT_ADAPTER_BACKOFF.jitter,
      randomFn: options?.randomFn ?? Math.random,
    };
    this.#onStateChange = onStateChange;
    this.#hookRegistry = hookRegistry;
    this.#state = {
      kind: adapter.kind,
      state: "starting",
      pollsTotal: 0,
      pollsFailed: 0,
      pollMessagesProcessed: 0,
    };
  }

  get id(): string | undefined {
    return this.rawAdapter.id;
  }

  get kind(): ChannelKind {
    return this.rawAdapter.kind;
  }

  get delivery(): ChannelDelivery | undefined {
    return this.rawAdapter.delivery;
  }

  get pair(): ChannelAdapter["pair"] {
    return this.rawAdapter.pair;
  }

  get receive(): ChannelAdapter["receive"] {
    return this.rawAdapter.receive;
  }

  get send(): ChannelAdapter["send"] {
    return this.rawAdapter.send;
  }

  get getCapabilities(): ChannelAdapter["getCapabilities"] {
    return this.rawAdapter.getCapabilities;
  }

  get joinVoiceChannelForMessage(): ChannelAdapter["joinVoiceChannelForMessage"] {
    return this.rawAdapter.joinVoiceChannelForMessage?.bind(this.rawAdapter);
  }

  get leaveVoiceChannelForMessage(): ChannelAdapter["leaveVoiceChannelForMessage"] {
    return this.rawAdapter.leaveVoiceChannelForMessage?.bind(this.rawAdapter);
  }

  get deleteInboundMessage(): ChannelAdapter["deleteInboundMessage"] {
    return this.rawAdapter.deleteInboundMessage?.bind(this.rawAdapter);
  }

  get setInboundProcessingIndicator(): ChannelAdapter["setInboundProcessingIndicator"] {
    return this.rawAdapter.setInboundProcessingIndicator?.bind(this.rawAdapter);
  }

  get beginSecureInputIntake(): ChannelAdapter["beginSecureInputIntake"] {
    return this.rawAdapter.beginSecureInputIntake?.bind(this.rawAdapter);
  }

  get pollOnce(): ChannelAdapter["pollOnce"] {
    return this.rawAdapter.pollOnce === undefined
      ? undefined
      : this.poll.bind(this);
  }

  getState(): AdapterRuntimeState {
    return { ...this.#state };
  }

  async start(handler: (message: ChannelMessage) => Promise<void>): Promise<void> {
    this.#handler = handler;
    this.#state.state = "starting";
    this.#state.startedAt = new Date().toISOString();
    this.#emitChange();

    try {
      await this.rawAdapter.start?.(handler);
      this.#state.state = "healthy";
      this.#state.pendingOperation = undefined;
      this.#state.lastError = undefined;
      this.#state.retry = undefined;
      this.#emitHook("adapter:start", { kind: this.kind, state: "healthy" });
      this.#emitChange();
    } catch (err) {
      this.#handleFailure("start", err);
    }
  }

  async stop(): Promise<void> {
    this.#state.state = "stopped";
    this.#state.stoppedAt = new Date().toISOString();
    this.#state.pendingOperation = undefined;
    this.#state.retry = undefined;
    this.#emitHook("adapter:stop", { kind: this.kind, state: "stopped" });
    this.#emitChange();

    try {
      await this.rawAdapter.stop?.();
    } catch (err) {
      const { errorClass, errorMessage } = sanitizeHookError(err);
      this.#emitHook("adapter:error", {
        kind: this.kind,
        operation: "stop",
        state: "stopped",
        retryCount: 0,
        errorClass,
        errorMessage,
      });
    }
  }

  async tick(): Promise<void> {
    if (this.#state.state === "stopped" || this.#state.state === "failed") {
      return;
    }

    if (this.#state.state === "degraded" && this.#state.pendingOperation === "start") {
      await this.#retryOperation("start");
      return;
    }

    if (this.#state.state === "retry_scheduled" && this.#state.pendingOperation !== undefined) {
      const now = Date.now();
      const nextRetryAt = this.#state.retry !== undefined
        ? new Date(this.#state.retry.nextRetryAt).getTime()
        : 0;
      if (!Number.isNaN(nextRetryAt) && now >= nextRetryAt) {
        await this.#retryOperation(this.#state.pendingOperation);
      }
      return;
    }
  }

  async poll(): Promise<number> {
    if (this.rawAdapter.pollOnce === undefined) {
      return 0;
    }

    if (
      this.#state.state !== "healthy" &&
      !(this.#state.state === "degraded" && this.#state.pendingOperation === "poll")
    ) {
      return 0;
    }

    try {
      const count = await this.rawAdapter.pollOnce();
      this.#state.pollsTotal += 1;
      this.#state.pollMessagesProcessed += typeof count === "number" ? count : 0;
      if (this.#state.state !== "healthy") {
        this.#state.state = "healthy";
        this.#state.pendingOperation = undefined;
        this.#state.lastError = undefined;
        this.#state.retry = undefined;
        this.#emitHook("adapter:recovered", { kind: this.kind, operation: "poll", state: "healthy" });
      }
      this.#emitChange();
      return typeof count === "number" ? count : 0;
    } catch (err) {
      this.#state.pollsFailed += 1;
      this.#handleFailure("poll", err);
      return 0;
    }
  }

  #handleFailure(operation: "start" | "poll", err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    const classification = this.kind === "whatsapp" ? classifyWhatsAppBridgeError(err) : undefined;
    const now = new Date().toISOString();
    const isRetry = this.#state.lastError !== undefined && this.#state.pendingOperation === operation;
    const consecutiveCount = isRetry
      ? this.#state.lastError!.count + 1
      : 1;

    this.#state.lastError = {
      message,
      timestamp: now,
      count: consecutiveCount,
    };
    this.#state.pendingOperation = operation;

    let attempt: number | undefined;

    if (classification?.retryable === false) {
      this.#state.state = "failed";
      this.#state.retry = undefined;
    } else if (classification?.retryDelayMs !== undefined) {
      attempt = isRetry && this.#state.retry !== undefined ? this.#state.retry.attempt + 1 : 1;
      if (attempt > this.#options.maxAttempts) {
        this.#state.state = "failed";
        this.#state.retry = undefined;
      } else {
        this.#state.state = "retry_scheduled";
        this.#state.retry = {
          attempt,
          maxAttempts: this.#options.maxAttempts,
          nextRetryAt: new Date(Date.now() + classification.retryDelayMs).toISOString(),
        };
      }
    } else if (!isRetry) {
      // First failure for this operation
      this.#state.state = "degraded";
      this.#state.retry = undefined;
    } else {
      // Subsequent failure - apply backoff
      attempt = this.#state.retry !== undefined
        ? this.#state.retry.attempt + 1
        : 2;
      if (attempt > this.#options.maxAttempts) {
        this.#state.state = "failed";
        this.#state.retry = undefined;
      } else {
        const delay = computeBackoffDelay(attempt - 1, this.#options);
        const nextRetryAt = new Date(Date.now() + delay).toISOString();
        this.#state.state = "retry_scheduled";
        this.#state.retry = {
          attempt,
          maxAttempts: this.#options.maxAttempts,
          nextRetryAt,
        };
      }
    }

    const { errorClass, errorMessage } = sanitizeHookError(err);

    // 2. Emit adapter:error after state fields updated
    this.#emitHook("adapter:error", {
      kind: this.kind,
      operation,
      state: this.#state.state,
      retryCount: consecutiveCount,
      errorClass,
      errorMessage,
    });

    // 3. Emit adapter:degraded or adapter:retry if applicable
    if (classification?.retryable === false) {
      // Non-retryable bridge failures are terminal for this adapter run.
    } else if (classification?.retryDelayMs !== undefined && this.#state.retry !== undefined) {
      this.#emitHook("adapter:retry", {
        kind: this.kind,
        operation,
        retryCount: this.#state.retry.attempt,
        nextRetryAt: this.#state.retry.nextRetryAt,
      });
    } else if (!isRetry) {
      this.#emitHook("adapter:degraded", {
        kind: this.kind,
        operation,
        state: "degraded",
        retryCount: 1,
      });
    } else if (attempt !== undefined && attempt <= this.#options.maxAttempts) {
      this.#emitHook("adapter:retry", {
        kind: this.kind,
        operation,
        retryCount: attempt,
        nextRetryAt: this.#state.retry!.nextRetryAt,
      });
    }

    // 4. Call emitChange
    this.#emitChange();
  }

  async #retryOperation(operation: "start" | "poll"): Promise<void> {
    if (operation === "start") {
      this.#state.state = "starting";
      this.#emitChange();
      try {
        await this.rawAdapter.start?.(this.#handler!);
        this.#state.state = "healthy";
        this.#state.pendingOperation = undefined;
        this.#state.lastError = undefined;
        this.#state.retry = undefined;
        this.#emitHook("adapter:recovered", { kind: this.kind, operation: "start", state: "healthy" });
        this.#emitChange();
      } catch (err) {
        this.#handleFailure("start", err);
      }
    } else {
      try {
        const count = await this.rawAdapter.pollOnce?.();
        this.#state.pollsTotal += 1;
        this.#state.pollMessagesProcessed += typeof count === "number" ? count : 0;
        this.#state.state = "healthy";
        this.#state.pendingOperation = undefined;
        this.#state.lastError = undefined;
        this.#state.retry = undefined;
        this.#emitHook("adapter:recovered", { kind: this.kind, operation: "poll", state: "healthy" });
        this.#emitChange();
      } catch (err) {
        this.#state.pollsFailed += 1;
        this.#handleFailure("poll", err);
      }
    }
  }

  #emitChange(): void {
    this.#onStateChange?.();
  }

  #emitHook<N extends GatewayHookEventName>(
    name: N,
    payload: GatewayHookPayloadByName[N],
  ): void {
    try {
      const p = this.#hookRegistry?.emit(name, payload);
      if (p) {
        p.catch(() => {});
      }
    } catch {
      // HookRegistry.emit itself threw synchronously — ignore
    }
  }
}
