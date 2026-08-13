/** Sensitive value categories supported by the protected-input boundary. */
export type SecureInputKind =
  | "account-identifier"
  | "password"
  | "one-time-code"
  | "api-key"
  | "client-secret"
  | "access-token"
  | "private-key"
  | "recovery-code"
  | "generic-secret";

/**
 * Requested retention after delivery. The destination remains authoritative for
 * destination-managed values; this field does not itself grant persistence.
 */
export type SecureInputRetention =
  | "use-once"
  | "destination-managed"
  | "profile-secret-store";

export type BrowserFieldSecureInputDestination = {
  type: "browser-field";
  sessionId: string;
  ref: string;
  expectedOrigin: string;
  tabRef?: string;
  frameId?: string;
  label?: string;
  /** Optional same-document control that the runtime clicks immediately after one-use delivery. */
  submit?: {
    ref: string;
  };
};

export type ApplicationFieldSecureInputDestination = {
  type: "application-field";
  applicationId: string;
  fieldId: string;
  windowId?: string;
  label?: string;
};

export type ProcessStdinSecureInputDestination = {
  type: "process-stdin";
  processId: string;
  promptLabel?: string;
};

export type ProcessEnvironmentSecureInputDestination = {
  type: "process-environment";
  processId: string;
  variableName: string;
};

export type RegisteredStoreSecureInputDestination = {
  type: "registered-store";
  storeId: string;
  entryName: string;
};

export type ToolArgumentSecureInputDestination = {
  type: "tool-argument";
  toolName: string;
  argumentPath: string;
};

export type McpArgumentSecureInputDestination = {
  type: "mcp-argument";
  serverId: string;
  toolName: string;
  argumentPath: string;
};

/** Product-neutral destinations that a reviewed transport may implement. */
export type SecureInputDestination =
  | BrowserFieldSecureInputDestination
  | ApplicationFieldSecureInputDestination
  | ProcessStdinSecureInputDestination
  | ProcessEnvironmentSecureInputDestination
  | RegisteredStoreSecureInputDestination
  | ToolArgumentSecureInputDestination
  | McpArgumentSecureInputDestination;

/** Safe request metadata. A credential value or capability handle never belongs here. */
export type SecureInputRequest = {
  kind: SecureInputKind;
  purpose: string;
  destination: SecureInputDestination;
  retention: SecureInputRetention;
  expiresInMs?: number;
};

/** Exact runtime ownership boundary for one protected-input request. */
export type SecureInputScope = {
  profileId: string;
  sessionId: string;
  userId?: string;
};

export type SecureInputRequestStatus =
  | "awaiting_input"
  | "ready"
  | "consuming"
  | "consumed"
  | "cancelled"
  | "expired";

/** Metadata-only view safe for UI coordination and runtime state transitions. */
export type SecureInputRequestSnapshot = {
  id: string;
  scope: SecureInputScope;
  request: SecureInputRequest;
  status: SecureInputRequestStatus;
  requestedAt: string;
  expiresAt: string;
};

export type SecureInputReceipt = {
  status: "delivered" | "cancelled" | "expired" | "failed";
  destinationLabel: string;
  persisted: boolean;
  reason?: string;
};

/** One independently verified destination within a single operator input flow. */
export type SecureInputGroupItem = {
  id: string;
  request: SecureInputRequest;
  consume: SecureInputConsumer;
};

/**
 * A bounded set of related protected values, such as an account identifier and
 * password. Values are still collected and delivered independently; only safe
 * request metadata is grouped.
 */
export type SecureInputGroupRequest = {
  purpose: string;
  items: readonly SecureInputGroupItem[];
};

export type SecureInputGroupReceipt = {
  status: SecureInputReceipt["status"];
  items: readonly { id: string; receipt: SecureInputReceipt }[];
  reason?: string;
};

export type SecureInputConsumptionContext = {
  requestId: string;
  scope: SecureInputScope;
  request: SecureInputRequest;
  signal: AbortSignal;
};

/**
 * Trusted consumers receive the broker-owned byte view only for the duration of
 * this callback. They must not retain or copy it beyond the delivery attempt.
 * The broker overwrites the view when the attempt settles.
 */
export type SecureInputConsumer = (
  value: Uint8Array,
  context: SecureInputConsumptionContext
) => void | Promise<void>;

/**
 * Runtime-owned request seam exposed to trusted tool implementations. The
 * protected value is delivered only to the supplied one-shot consumer and the
 * tool receives a metadata-only receipt.
 */
export type SecureInputRequestHandler = (
  request: SecureInputRequest,
  consume: SecureInputConsumer
) => Promise<SecureInputReceipt>;

export type GroupedSecureInputRequestHandler = SecureInputRequestHandler & {
  requestGroup: (request: SecureInputGroupRequest) => Promise<SecureInputGroupReceipt>;
};

export type SecureInputCollectionResult =
  | { status: "provided"; value: Uint8Array }
  | { status: "cancelled" };

/** Verified metadata supplied to a trusted collector for operator display. */
export type SecureInputCollectionContext = {
  verifiedDestinationLabel: string;
  group?: {
    purpose: string;
    index: number;
    total: number;
  };
};

/** Trusted UI/channel boundary used to collect a value outside model context. */
export type SecureInputCollector = (
  request: SecureInputRequestSnapshot,
  signal: AbortSignal,
  context: SecureInputCollectionContext
) => Promise<SecureInputCollectionResult>;
