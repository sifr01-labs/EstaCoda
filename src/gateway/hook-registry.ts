/**
 * Gateway Hook Registry — Stage 8A
 *
 * Internal-only, best-effort lifecycle event observation.
 *
 * Privacy conventions:
 * - Never emit message text, prompts, model output, tokens, raw adapter
 *   identities, raw HMAC keys, approval secrets, or raw chat/user IDs.
 * - Use hashed identifiers (SHA-256 truncated to 16-char hex) where session
 *   keys are needed.
 * - Allowed: channel kind, adapter kind, sessionId/turnId/entryId (already
 *   opaque operational IDs), job/execution IDs, error classes, counts,
 *   durations, booleans.
 */

export type GatewayHookEventName =
  | "supervisor:start"
  | "supervisor:stop"
  | "supervisor:drain:start"
  | "supervisor:drain:complete"
  | "supervisor:crash"
  | "adapter:start"
  | "adapter:stop"
  | "adapter:error"
  | "adapter:retry"
  | "adapter:degraded"
  | "adapter:recovered"
  | "session:turn:start"
  | "session:turn:complete"
  | "session:turn:error"
  | "session:turn:abort"
  | "session:cache:hit"
  | "session:cache:miss"
  | "session:cache:evict"
  | "delivery:success"
  | "delivery:error"
  | "gateway:stt:preprocess"
  | "cron:tick:start"
  | "cron:tick:complete"
  | "cron:job:fail";

export type GatewayHookPayloadByName = {
  "supervisor:start": {
    pid: number;
    startedAt: string;
    version: string;
    adapterKinds: string[];
    mode: string;
  };
  "supervisor:stop": {
    pid: number;
    clean: boolean;
    reason: string;
  };
  "supervisor:drain:start": {
    pid: number;
    reason: string;
    activeTurnCount: number;
    timeoutMs: number;
  };
  "supervisor:drain:complete": {
    pid: number;
    completed: boolean;
    timedOut: boolean;
    abortedTurnCount: number;
    durationMs: number;
  };
  "supervisor:crash": {
    pid: number;
    phase: string;
    errorClass: string;
    errorMessage: string;
  };
  "adapter:start": {
    kind: string;
    state: string;
  };
  "adapter:stop": {
    kind: string;
    state: string;
  };
  "adapter:error": {
    kind: string;
    operation: "start" | "poll" | "stop";
    state: string;
    retryCount: number;
    errorClass: string;
    errorMessage: string;
  };
  "adapter:retry": {
    kind: string;
    operation: "start" | "poll" | "stop";
    retryCount: number;
    nextRetryAt: string;
  };
  "adapter:degraded": {
    kind: string;
    operation: "start" | "poll" | "stop";
    state: string;
    retryCount: number;
  };
  "adapter:recovered": {
    kind: string;
    operation: "start" | "poll" | "stop";
    state: string;
  };
  "session:turn:start": {
    turnId: string;
    sessionKeyHash: string;
    channel: string;
    origin: "command" | "message";
    queueSize: number;
  };
  "session:turn:complete": {
    turnId: string;
    sessionKeyHash: string;
    channel: string;
    durationMs: number;
    replyTextLength?: number;
  };
  "session:turn:error": {
    turnId: string;
    sessionId?: string;
    sessionKeyHash: string;
    channel: string;
    errorClass: string;
    errorMessage: string;
    suspendedCache: boolean;
  };
  "session:turn:abort": {
    turnId?: string;
    sessionKeyHash: string;
    channel: string;
    reason: "stop" | "interrupt" | "drain-timeout" | "stuck-loop" | "unknown";
  };
  "session:cache:hit": {
    sessionId: string;
    entryId: string;
    borrowCount: number;
  };
  "session:cache:miss": {
    sessionId: string;
    entryId: string;
    reason: "first-create" | "suspended" | "fingerprint-mismatch";
  };
  "session:cache:evict": {
    sessionId: string;
    entryId: string;
    reason: "ttl" | "lru" | "suspend" | "invalidate" | "disposeAll" | "fingerprint-mismatch";
  };
  "delivery:success": {
    kind: "text" | "progress" | "artifact";
    target: string;
    platform?: string;
    truncated?: boolean;
  };
  "delivery:error": {
    kind: "text" | "progress" | "artifact";
    target: string;
    platform?: string;
    errorClass: string;
    errorMessage: string;
  };
  "gateway:stt:preprocess": {
    outcome: "allow" | "deny" | "fail";
    provider: string;
    reason?: string;
    attachment: {
      id: string;
      kind: string;
      status?: string;
      mimeType?: string;
      bytes?: number;
      pathHash?: string;
    };
  };
  "cron:tick:start": {
    dueCount: number;
  };
  "cron:tick:complete": {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
  };
  "cron:job:fail": {
    jobId: string;
    executionId?: string;
    failureClass: string;
    delivered: boolean;
  };
};

export type HookEvent<N extends GatewayHookEventName> = {
  name: N;
  emittedAt: string;
  payload: GatewayHookPayloadByName[N];
};

export type HookHandler<N extends GatewayHookEventName> = (
  event: HookEvent<N>
) => void | Promise<void>;

export type HookRegistryOptions = {
  logWarning?: (message: string) => void;
};

export class HookRegistry {
  readonly #handlers = new Map<
    GatewayHookEventName,
    Array<HookHandler<GatewayHookEventName>>
  >();
  readonly #logWarning?: (message: string) => void;

  constructor(options?: HookRegistryOptions) {
    this.#logWarning = options?.logWarning;
  }

  /**
   * Register a handler for a named event.
   * Returns an unsubscribe function.
   */
  on<N extends GatewayHookEventName>(
    name: N,
    handler: HookHandler<N>
  ): () => void {
    const list = this.#handlers.get(name) ?? [];
    const typedHandler = handler as HookHandler<GatewayHookEventName>;
    list.push(typedHandler);
    this.#handlers.set(name, list);

    return () => {
      const current = this.#handlers.get(name);
      if (current === undefined) return;
      const idx = current.indexOf(typedHandler);
      if (idx >= 0) {
        current.splice(idx, 1);
      }
      if (current.length === 0) {
        this.#handlers.delete(name);
      }
    };
  }

  /**
   * Emit an event to all registered handlers for that name.
   *
   * Behavior:
   * - Handlers run in registration order.
   * - Each handler is awaited sequentially.
   * - Sync throws and async rejections are caught individually.
   * - A failing handler does not stop later handlers.
   * - This method never throws to its caller.
   *
   * Call-site rule: hot paths must not await emit() before critical state
   * transitions. Use fire-and-own with explicit catch:
   *   void registry.emit("...", payload).catch(logHookError);
   */
  async emit<N extends GatewayHookEventName>(
    name: N,
    payload: GatewayHookPayloadByName[N]
  ): Promise<void> {
    const handlers = this.#handlers.get(name);
    if (handlers === undefined || handlers.length === 0) {
      return;
    }

    const event: HookEvent<N> = {
      name,
      emittedAt: new Date().toISOString(),
      payload,
    };

    for (const handler of handlers) {
      try {
        const result = handler(event as HookEvent<GatewayHookEventName>);
        if (result instanceof Promise) {
          await result;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.#logWarning?.(`Hook handler failed for ${name}: ${message}`);
      }
    }
  }
}

export function sanitizeHookError(err: unknown): {
  errorClass: string;
  errorMessage: string;
} {
  let rawMessage: string;
  let errorClass: string;

  if (err instanceof Error) {
    errorClass = err.name;
    rawMessage = err.message;
  } else {
    errorClass = "UnknownError";
    rawMessage = String(err);
  }

  // Redact known token patterns
  const redacted = rawMessage
    .replace(/\bsk-proj-[A-Za-z0-9_-]+\b/g, "[REDACTED]")
    .replace(/\bsk-[A-Za-z0-9]{20,}\b/g, "[REDACTED]")
    .replace(/\bant-[A-Za-z0-9]{20,}\b/g, "[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._-]+\b/g, "Bearer [REDACTED]");

  // Cap length
  const MAX_LEN = 200;
  const errorMessage =
    redacted.length > MAX_LEN
      ? redacted.slice(0, MAX_LEN) + " [truncated]"
      : redacted;

  return { errorClass, errorMessage };
}
