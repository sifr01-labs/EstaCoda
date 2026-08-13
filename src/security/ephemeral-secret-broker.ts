import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
  SecureInputConsumer,
  SecureInputDestination,
  SecureInputKind,
  SecureInputRequest,
  SecureInputRequestSnapshot,
  SecureInputRequestStatus,
  SecureInputRetention,
  SecureInputScope
} from "../contracts/secure-input.js";

const DEFAULT_TTL_MS = 2 * 60 * 1_000;
const DEFAULT_MAX_TTL_MS = 10 * 60 * 1_000;
const DEFAULT_MAX_PENDING_REQUESTS = 32;
const DEFAULT_MAX_RETAINED_TERMINAL_REQUESTS = 128;
const DEFAULT_MAX_SECRET_BYTES = 64 * 1_024;
const MAX_METADATA_TEXT_LENGTH = 512;

const SECURE_INPUT_KINDS = new Set<SecureInputKind>([
  "account-identifier",
  "password",
  "one-time-code",
  "api-key",
  "client-secret",
  "access-token",
  "private-key",
  "recovery-code",
  "generic-secret"
]);

const SECURE_INPUT_RETENTIONS = new Set<SecureInputRetention>([
  "use-once",
  "destination-managed",
  "profile-secret-store"
]);

const TERMINAL_STATUSES = new Set<SecureInputRequestStatus>([
  "consumed",
  "cancelled",
  "expired"
]);

export type EphemeralSecretBrokerOptions = {
  now?: () => Date;
  idFactory?: () => string;
  defaultTtlMs?: number;
  maxTtlMs?: number;
  maxPendingRequests?: number;
  maxRetainedTerminalRequests?: number;
  maxSecretBytes?: number;
};

export type SecureInputBrokerErrorCode =
  | "invalid_request"
  | "capacity_exceeded"
  | "not_found"
  | "invalid_state"
  | "empty_secret"
  | "secret_too_large"
  | "destination_mismatch"
  | "cancelled"
  | "expired"
  | "consumer_failed";

export class SecureInputBrokerError extends Error {
  readonly code: SecureInputBrokerErrorCode;

  constructor(code: SecureInputBrokerErrorCode, message: string) {
    super(message);
    this.name = "SecureInputBrokerError";
    this.code = code;
  }
}

type BrokerEntry = {
  id: string;
  scope: SecureInputScope;
  request: SecureInputRequest;
  status: SecureInputRequestStatus;
  requestedAt: Date;
  expiresAt: Date;
  controller: AbortController;
  secret?: Uint8Array;
  expiryTimer?: ReturnType<typeof setTimeout>;
  detachRequestAbort?: () => void;
  terminalAtMs?: number;
};

export class EphemeralSecretBroker {
  readonly #now: () => Date;
  readonly #idFactory: () => string;
  readonly #defaultTtlMs: number;
  readonly #maxTtlMs: number;
  readonly #maxPendingRequests: number;
  readonly #maxRetainedTerminalRequests: number;
  readonly #maxSecretBytes: number;
  readonly #entries = new Map<string, BrokerEntry>();

  constructor(options: EphemeralSecretBrokerOptions = {}) {
    this.#now = options.now ?? (() => new Date());
    this.#idFactory = options.idFactory ?? (() => `secure_input_${randomUUID()}`);
    this.#defaultTtlMs = positiveInteger(options.defaultTtlMs ?? DEFAULT_TTL_MS, "defaultTtlMs");
    this.#maxTtlMs = positiveInteger(options.maxTtlMs ?? DEFAULT_MAX_TTL_MS, "maxTtlMs");
    this.#maxPendingRequests = positiveInteger(
      options.maxPendingRequests ?? DEFAULT_MAX_PENDING_REQUESTS,
      "maxPendingRequests"
    );
    this.#maxRetainedTerminalRequests = nonNegativeInteger(
      options.maxRetainedTerminalRequests ?? DEFAULT_MAX_RETAINED_TERMINAL_REQUESTS,
      "maxRetainedTerminalRequests"
    );
    this.#maxSecretBytes = positiveInteger(options.maxSecretBytes ?? DEFAULT_MAX_SECRET_BYTES, "maxSecretBytes");
    if (this.#defaultTtlMs > this.#maxTtlMs) {
      throw new SecureInputBrokerError("invalid_request", "The default secure-input TTL exceeds the maximum TTL.");
    }
  }

  createRequest(input: {
    scope: SecureInputScope;
    request: SecureInputRequest;
    signal?: AbortSignal;
  }): SecureInputRequestSnapshot {
    this.expireStaleRequests();
    validateScope(input.scope);
    validateRequest(input.request, this.#maxTtlMs);
    if (input.signal?.aborted === true) {
      throw new SecureInputBrokerError("cancelled", "The secure-input request was cancelled before creation.");
    }
    if (this.#pendingCount() >= this.#maxPendingRequests) {
      throw new SecureInputBrokerError("capacity_exceeded", "Too many secure-input requests are pending.");
    }

    const id = requireIdentifier(this.#idFactory(), "request id");
    if (this.#entries.has(id)) {
      throw new SecureInputBrokerError("invalid_request", "The secure-input request id is already in use.");
    }

    const requestedAt = this.#now();
    const ttlMs = input.request.expiresInMs ?? this.#defaultTtlMs;
    const entry: BrokerEntry = {
      id,
      scope: clone(input.scope),
      request: clone(input.request),
      status: "awaiting_input",
      requestedAt,
      expiresAt: new Date(requestedAt.getTime() + ttlMs),
      controller: new AbortController()
    };

    if (input.signal !== undefined) {
      const onAbort = () => this.#cancelEntry(entry);
      input.signal.addEventListener("abort", onAbort, { once: true });
      entry.detachRequestAbort = () => input.signal?.removeEventListener("abort", onAbort);
    }

    this.#entries.set(id, entry);
    entry.expiryTimer = setTimeout(() => {
      if (this.#entries.get(entry.id) === entry && !TERMINAL_STATUSES.has(entry.status)) {
        this.#finishEntry(entry, "expired");
      }
    }, ttlMs);
    entry.expiryTimer.unref?.();
    return snapshot(entry);
  }

  getRequest(id: string, scope: SecureInputScope): SecureInputRequestSnapshot | undefined {
    const entry = this.#getScopedEntry(id, scope);
    if (entry === undefined) return undefined;
    this.#expireEntryIfStale(entry);
    return snapshot(entry);
  }

  provideSecret(input: {
    requestId: string;
    scope: SecureInputScope;
    value: string | Uint8Array;
  }): SecureInputRequestSnapshot {
    const entry = this.#requireScopedEntry(input.requestId, input.scope);
    this.#expireEntryIfStale(entry);
    if (entry.status === "expired") {
      throw new SecureInputBrokerError("expired", "The secure-input request has expired.");
    }
    if (entry.status === "cancelled") {
      throw new SecureInputBrokerError("cancelled", "The secure-input request was cancelled.");
    }
    if (entry.status !== "awaiting_input") {
      throw new SecureInputBrokerError("invalid_state", "The secure-input request is not awaiting a value.");
    }

    if (input.value.length === 0) {
      throw new SecureInputBrokerError("empty_secret", "The protected value cannot be empty.");
    }
    if (input.value.length > this.#maxSecretBytes) {
      throw new SecureInputBrokerError("secret_too_large", "The protected value exceeds the configured size limit.");
    }
    const bytes = typeof input.value === "string"
      ? new TextEncoder().encode(input.value)
      : new Uint8Array(input.value);
    if (bytes.byteLength > this.#maxSecretBytes) {
      bytes.fill(0);
      throw new SecureInputBrokerError("secret_too_large", "The protected value exceeds the configured size limit.");
    }

    entry.secret = bytes;
    entry.status = "ready";
    return snapshot(entry);
  }

  async consume(input: {
    requestId: string;
    scope: SecureInputScope;
    destination: SecureInputDestination;
    signal?: AbortSignal;
  }, consumer: SecureInputConsumer): Promise<SecureInputRequestSnapshot> {
    const entry = this.#requireScopedEntry(input.requestId, input.scope);
    this.#expireEntryIfStale(entry);
    if (entry.status === "expired") {
      throw new SecureInputBrokerError("expired", "The secure-input request has expired.");
    }
    if (entry.status === "cancelled" || input.signal?.aborted === true) {
      this.#cancelEntry(entry);
      throw new SecureInputBrokerError("cancelled", "The secure-input request was cancelled.");
    }
    if (entry.status !== "ready" || entry.secret === undefined) {
      throw new SecureInputBrokerError("invalid_state", "The secure-input request is not ready for consumption.");
    }
    if (!isDeepStrictEqual(entry.request.destination, input.destination)) {
      this.#cancelEntry(entry);
      throw new SecureInputBrokerError("destination_mismatch", "The protected destination no longer matches the request.");
    }

    entry.status = "consuming";
    const secret = entry.secret;
    let detachConsumeAbort: (() => void) | undefined;
    if (input.signal !== undefined) {
      const onAbort = () => this.#cancelEntry(entry);
      input.signal.addEventListener("abort", onAbort, { once: true });
      detachConsumeAbort = () => input.signal?.removeEventListener("abort", onAbort);
    }

    try {
      await consumer(secret, {
        requestId: entry.id,
        scope: clone(entry.scope),
        request: clone(entry.request),
        signal: entry.controller.signal
      });
      if (entry.controller.signal.aborted) throw this.#interruptionError(entry);
      this.#finishEntry(entry, "consumed");
      return snapshot(entry);
    } catch (error) {
      if (error instanceof SecureInputBrokerError && (error.code === "cancelled" || error.code === "expired")) {
        throw error;
      }
      if (entry.controller.signal.aborted) throw this.#interruptionError(entry);
      this.#finishEntry(entry, "consumed");
      throw new SecureInputBrokerError("consumer_failed", "Protected input delivery failed.");
    } finally {
      detachConsumeAbort?.();
      clearBytes(secret);
      if (entry.secret === secret) entry.secret = undefined;
      if (entry.status === "consuming") this.#finishEntry(entry, "consumed");
    }
  }

  cancelRequest(id: string, scope: SecureInputScope): SecureInputRequestSnapshot {
    const entry = this.#requireScopedEntry(id, scope);
    this.#expireEntryIfStale(entry);
    if (!TERMINAL_STATUSES.has(entry.status)) this.#cancelEntry(entry);
    return snapshot(entry);
  }

  expireStaleRequests(): number {
    let expired = 0;
    for (const entry of this.#entries.values()) {
      if (this.#expireEntryIfStale(entry)) expired += 1;
    }
    return expired;
  }

  stats(): Readonly<Record<SecureInputRequestStatus, number>> {
    this.expireStaleRequests();
    const counts: Record<SecureInputRequestStatus, number> = {
      awaiting_input: 0,
      ready: 0,
      consuming: 0,
      consumed: 0,
      cancelled: 0,
      expired: 0
    };
    for (const entry of this.#entries.values()) counts[entry.status] += 1;
    return counts;
  }

  dispose(): void {
    for (const entry of this.#entries.values()) {
      clearBytes(entry.secret);
      entry.secret = undefined;
      if (entry.expiryTimer !== undefined) clearTimeout(entry.expiryTimer);
      entry.detachRequestAbort?.();
      entry.controller.abort();
    }
    this.#entries.clear();
  }

  #getScopedEntry(id: string, scope: SecureInputScope): BrokerEntry | undefined {
    if (!isValidScope(scope)) return undefined;
    const entry = this.#entries.get(id);
    return entry !== undefined && isDeepStrictEqual(entry.scope, scope) ? entry : undefined;
  }

  #requireScopedEntry(id: string, scope: SecureInputScope): BrokerEntry {
    const entry = this.#getScopedEntry(id, scope);
    if (entry === undefined) {
      throw new SecureInputBrokerError("not_found", "The secure-input request was not found in this scope.");
    }
    return entry;
  }

  #pendingCount(): number {
    let count = 0;
    for (const entry of this.#entries.values()) {
      if (!TERMINAL_STATUSES.has(entry.status)) count += 1;
    }
    return count;
  }

  #expireEntryIfStale(entry: BrokerEntry): boolean {
    if (TERMINAL_STATUSES.has(entry.status)) return false;
    if (entry.expiresAt.getTime() > this.#now().getTime()) return false;
    this.#finishEntry(entry, "expired");
    return true;
  }

  #cancelEntry(entry: BrokerEntry): void {
    if (TERMINAL_STATUSES.has(entry.status)) return;
    this.#finishEntry(entry, "cancelled");
  }

  #interruptionError(entry: BrokerEntry): SecureInputBrokerError {
    return entry.status === "expired"
      ? new SecureInputBrokerError("expired", "The secure-input request expired during consumption.")
      : new SecureInputBrokerError("cancelled", "The secure-input request was cancelled during consumption.");
  }

  #finishEntry(entry: BrokerEntry, status: "consumed" | "cancelled" | "expired"): void {
    clearBytes(entry.secret);
    entry.secret = undefined;
    entry.status = status;
    entry.terminalAtMs = this.#now().getTime();
    if (entry.expiryTimer !== undefined) clearTimeout(entry.expiryTimer);
    entry.expiryTimer = undefined;
    entry.detachRequestAbort?.();
    entry.detachRequestAbort = undefined;
    if (!entry.controller.signal.aborted) entry.controller.abort();
    this.#pruneTerminalEntries();
  }

  #pruneTerminalEntries(): void {
    const terminal = [...this.#entries.values()]
      .filter((entry) => TERMINAL_STATUSES.has(entry.status))
      .sort((left, right) => (left.terminalAtMs ?? 0) - (right.terminalAtMs ?? 0));
    const removeCount = Math.max(0, terminal.length - this.#maxRetainedTerminalRequests);
    for (const entry of terminal.slice(0, removeCount)) this.#entries.delete(entry.id);
  }
}

function snapshot(entry: BrokerEntry): SecureInputRequestSnapshot {
  return {
    id: entry.id,
    scope: clone(entry.scope),
    request: clone(entry.request),
    status: entry.status,
    requestedAt: entry.requestedAt.toISOString(),
    expiresAt: entry.expiresAt.toISOString()
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function clearBytes(value: Uint8Array | undefined): void {
  value?.fill(0);
}

function validateRequest(request: SecureInputRequest, maxTtlMs: number): void {
  if (typeof request !== "object" || request === null) invalidRequest();
  if (!hasOnlyKeys(request, ["kind", "purpose", "destination", "retention", "expiresInMs"])) invalidRequest();
  if (!SECURE_INPUT_KINDS.has(request.kind)) invalidRequest();
  requireMetadataText(request.purpose, "purpose");
  if (!SECURE_INPUT_RETENTIONS.has(request.retention)) invalidRequest();
  if (request.expiresInMs !== undefined) {
    const ttl = positiveInteger(request.expiresInMs, "expiresInMs");
    if (ttl > maxTtlMs) {
      throw new SecureInputBrokerError("invalid_request", "The secure-input request TTL exceeds the configured maximum.");
    }
  }
  validateDestination(request.destination);
}

function validateDestination(destination: SecureInputDestination): void {
  if (typeof destination !== "object" || destination === null) invalidRequest();
  switch (destination.type) {
    case "browser-field":
      if (!hasOnlyKeys(destination, ["type", "sessionId", "ref", "expectedOrigin", "tabRef", "frameId", "label", "submit"])) {
        invalidRequest();
      }
      requireIdentifier(destination.sessionId, "browser session id");
      requireIdentifier(destination.ref, "browser field ref");
      requireHttpsOrigin(destination.expectedOrigin);
      optionalMetadataText(destination.tabRef, "browser tab ref");
      optionalMetadataText(destination.frameId, "browser frame id");
      optionalMetadataText(destination.label, "destination label");
      if (destination.submit !== undefined) {
        if (typeof destination.submit !== "object" || destination.submit === null ||
          !hasOnlyKeys(destination.submit, ["ref"])) invalidRequest();
        requireIdentifier(destination.submit.ref, "browser submit ref");
      }
      return;
    case "application-field":
      if (!hasOnlyKeys(destination, ["type", "applicationId", "fieldId", "windowId", "label"])) invalidRequest();
      requireIdentifier(destination.applicationId, "application id");
      requireIdentifier(destination.fieldId, "application field id");
      optionalMetadataText(destination.windowId, "application window id");
      optionalMetadataText(destination.label, "destination label");
      return;
    case "process-stdin":
      if (!hasOnlyKeys(destination, ["type", "processId", "promptLabel"])) invalidRequest();
      requireIdentifier(destination.processId, "process id");
      optionalMetadataText(destination.promptLabel, "process prompt label");
      return;
    case "process-environment":
      if (!hasOnlyKeys(destination, ["type", "processId", "variableName"])) invalidRequest();
      requireIdentifier(destination.processId, "process id");
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(destination.variableName)) invalidRequest();
      return;
    case "registered-store":
      if (!hasOnlyKeys(destination, ["type", "storeId", "entryName"])) invalidRequest();
      requireIdentifier(destination.storeId, "store id");
      requireMetadataText(destination.entryName, "store entry name");
      return;
    case "tool-argument":
      if (!hasOnlyKeys(destination, ["type", "toolName", "argumentPath"])) invalidRequest();
      requireIdentifier(destination.toolName, "tool name");
      requireMetadataText(destination.argumentPath, "tool argument path");
      return;
    case "mcp-argument":
      if (!hasOnlyKeys(destination, ["type", "serverId", "toolName", "argumentPath"])) invalidRequest();
      requireIdentifier(destination.serverId, "MCP server id");
      requireIdentifier(destination.toolName, "MCP tool name");
      requireMetadataText(destination.argumentPath, "MCP argument path");
      return;
    default:
      invalidRequest();
  }
}

function validateScope(scope: SecureInputScope): void {
  if (!isValidScope(scope)) invalidRequest();
}

function isValidScope(scope: SecureInputScope): boolean {
  return typeof scope === "object" && scope !== null &&
    hasOnlyKeys(scope, ["profileId", "sessionId", "userId"]) &&
    isIdentifier(scope.profileId) &&
    isIdentifier(scope.sessionId) &&
    (scope.userId === undefined || isIdentifier(scope.userId));
}

function requireHttpsOrigin(value: string): void {
  requireMetadataText(value, "expected origin");
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" || parsed.origin !== value || parsed.username.length > 0 || parsed.password.length > 0) {
      invalidRequest();
    }
  } catch {
    invalidRequest();
  }
}

function optionalMetadataText(value: string | undefined, label: string): void {
  if (value !== undefined) requireMetadataText(value, label);
}

function requireMetadataText(value: string, _label: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > MAX_METADATA_TEXT_LENGTH) {
    invalidRequest();
  }
  if (/[ --]/u.test(value)) invalidRequest();
  return value;
}

function requireIdentifier(value: string, label: string): string {
  if (!isIdentifier(value)) {
    throw new SecureInputBrokerError("invalid_request", `Invalid secure-input ${label}.`);
  }
  return value;
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= MAX_METADATA_TEXT_LENGTH &&
    !/[ -]/u.test(value);
}

function hasOnlyKeys(value: object, allowedKeys: readonly string[]): boolean {
  const allowed = new Set(allowedKeys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new SecureInputBrokerError("invalid_request", `Secure-input ${label} must be a positive integer.`);
  }
  return value;
}

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new SecureInputBrokerError("invalid_request", `Secure-input ${label} must be a non-negative integer.`);
  }
  return value;
}

function invalidRequest(): never {
  throw new SecureInputBrokerError("invalid_request", "Invalid secure-input request metadata.");
}
