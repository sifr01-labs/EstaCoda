import type { EnvironmentType } from "./security.js";
import type { SecurityDataEgressContext } from "./security.js";
import type { ProviderUsageLineage } from "./provider-usage.js";
import type { RuntimeEventSink } from "./runtime-event.js";
import type { RuntimeToolContext, SessionToolContext } from "./tool-context.js";
import type { VisionDispatchPhase, VisionInputProvenanceContext } from "./vision.js";
import type { SecureInputRequestHandler } from "./secure-input.js";

export type ToolRiskClass =
  | "read-only-local"
  | "read-only-network"
  | "workspace-write"
  | "external-side-effect"
  | "credential-access"
  | "destructive-local"
  | "shared-state-mutation"
  | "spend-money"
  | "sandbox-escape";

export type ToolsetName =
  | "core"
  | "files"
  | "shell-readonly"
  | "shell-write"
  | "web"
  | "browser"
  | "telegram"
  | "media"
  | "coding"
  | "research"
  | "provider"
  | "configuration"
  | "diagnostics"
  | "memory"
  | "mcp"
  | "dangerous"
  | (string & {});

export type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: unknown;
  riskClass: ToolRiskClass;
  toolsets: ToolsetName[];
  /** Runtime provenance used for deterministic connector-aware tool routing. */
  connector?: {
    kind: "mcp";
    id: string;
  };
  progressLabel: string;
  maxResultSizeChars: number;
  requiredConfig?: string[];
};

export type ToolResultMetadata = Record<string, unknown> & {
  _estacoda_context_summary?: string;
  /** Runtime-owned, reviewed scalar facts retained for foreground-turn continuity. */
  _estacoda_continuity_facts?: RuntimeContinuityFact[];
  /** Set by the MCP adapter from reviewed result identifiers, never input IDs. */
  _estacoda_verification_evidence?: boolean;
};

export type RuntimeContinuityFact = {
  field: string;
  value: string;
  kind: "identifier" | "label";
};

export type ToolResult = {
  ok: boolean;
  content: string;
  metadata?: ToolResultMetadata;
};

export type ToolExecutionContext = {
  /** Runtime-owned artifact scope. Provider input cannot set these values. */
  sessionId?: string;
  profileId?: string;
  /** Stable provider/native call identity for idempotent stateful tools. */
  toolCallId?: string;
  /** Persisted visible user-message identity; never substitute the provider tool-call ID. */
  visibleTurnId?: string;
  /** Immutable Session and Task lineage for provider calls initiated by this tool. */
  providerUsageLineage?: ProviderUsageLineage;
  /** Runtime-derived current-turn image sources; model input cannot set this. */
  visionInputProvenance?: VisionInputProvenanceContext;
  /** Runtime-owned delivery phase for unified vision dispatch. */
  visionDispatchPhase?: VisionDispatchPhase;
  /** Security resolution supplied by ToolExecutor after policy assessment. */
  securityResolution?: ToolSecurityResolution;
  signal?: AbortSignal;
  environmentType?: EnvironmentType;
  onEvent?: RuntimeEventSink;
  /** Suspends an approval-gated call until the active surface approves or denies it. */
  onApprovalRequest?: ToolApprovalHandler;
  /** Supplies protected data independently from action approval. */
  onSecureInputRequest?: SecureInputRequestHandler;
};

export type ToolApprovalRequest = {
  tool: ToolDefinition;
  input: Record<string, unknown>;
  riskClass: ToolRiskClass;
  targetKey?: string;
  targetSummary?: string;
  toolCallId?: string;
  toolCallName?: string;
};

export type ToolApprovalDecision = "approved" | "denied";

export type ToolApprovalHandler = (request: ToolApprovalRequest) => Promise<ToolApprovalDecision>;

export type ToolSecurityResolution = {
  riskClass: ToolRiskClass;
  targetKey?: string;
  targetSummary?: string;
  dataEgress?: SecurityDataEgressContext;
};

export type ToolSecurityResolverContext = Omit<ToolExecutionContext, "securityResolution" | "onApprovalRequest" | "onSecureInputRequest"> & {
  trustedWorkspace: boolean;
  sessionId: string;
};

export type ToolHandler<TInput = unknown> = (input: TInput, context?: ToolExecutionContext) => Promise<ToolResult>;

export type ProtectedToolArgumentDeclaration = {
  /** Reviewed JSON Pointer pattern. `*` may bind one array item. */
  path: string;
  handling: {
    persistence: "none" | "destination-managed" | "unknown";
    sharing: "private" | "workspace" | "account" | "external" | "unknown";
  };
  destination?: {
    type: "mcp-argument";
    serverId: string;
    toolName: string;
  };
};

/** Runtime-only capability facts that cannot be supplied by provider tool input. */
export type RegisteredToolCapabilityMetadata = {
  protectedInput?: {
    /** The registered handler can deliver multiple protected values atomically. */
    groupedDelivery: boolean;
    /** Trusted protected-value sources accepted by this tool integration. */
    sources: readonly "browser"[];
  };
  verification?: {
    /** Canonical mutation tool names whose resulting state this tool can verify. */
    verifies: readonly string[];
  };
  artifactInput?: {
    /** Reviewed artifact-envelope argument paths accepted by this tool. */
    paths: readonly string[];
  };
  resultRedaction?: {
    /** Reviewed result paths redacted before connector output reaches the model. */
    paths: readonly string[];
  };
};

export type ToolExecutionConcurrencyContext = {
  /** Current EstaCoda runtime session used to derive default scoped resources. */
  sessionId: string;
};

/** Trusted runtime-only scheduling policy; never projected into provider tool definitions. */
export type RegisteredToolExecutionConcurrency<TInput = any> = {
  mode: "exclusive";
  resourceKey(input: TInput, context: ToolExecutionConcurrencyContext): string;
};

/** Resolved runtime-only scheduling fact for one concrete tool call. */
export type ToolExecutionConcurrency = {
  mode: "exclusive";
  resourceKey: string;
};

export type ToolExecutionTerminalStatus = "completed" | "failed" | "cancelled" | "timed_out";

export type ToolExecutionDispatchState = "not_started" | "started" | "finished" | "unknown";

export type ToolExecutionSideEffectState = "none" | "possible" | "confirmed";

/** Runtime-owned execution outcome facts; provider output cannot set these values. */
export type ToolExecutionSettlement = {
  terminalStatus: ToolExecutionTerminalStatus;
  dispatchState: ToolExecutionDispatchState;
  sideEffectState: ToolExecutionSideEffectState;
  timeoutMs?: number;
};

/** Trusted runtime-only effect metadata derived from a registered tool. */
export type ToolExecutionEffect =
  | {
      kind: "read";
      connector?: { kind: "mcp"; id: string };
    }
  | {
      kind: "mutation";
      connector?: { kind: "mcp"; id: string };
    }
  | {
      kind: "verification";
      verifies: string[];
      connector?: { kind: "mcp"; id: string };
    };

/** Safe semantic coordinates produced by trusted tool registration code. */
export type ToolOperationIdentity = {
  destinationId?: string;
  subjectId?: string;
  artifactHash?: string;
  operationRevision?: number;
};

export type ToolOperationVerification = ToolOperationIdentity & {
  outcome: "present" | "absent";
};

export type RegisteredToolOperationJournal<TInput = any> = {
  identify(input: TInput): ToolOperationIdentity | undefined;
  verify?(input: TInput, result: ToolResult): ToolOperationVerification | undefined;
};

export type RegisteredTool<TInput = any> = ToolDefinition & {
  /** Runtime-only declaration; ToolRegistry intentionally omits it from ToolDefinition. */
  protectedArguments?: readonly ProtectedToolArgumentDeclaration[];
  /** Runtime-only execution capability metadata; never projected into provider schemas. */
  capabilityMetadata?: RegisteredToolCapabilityMetadata;
  /** Runtime-only resource scheduling policy; never projected into provider schemas. */
  executionConcurrency?: RegisteredToolExecutionConcurrency<TInput>;
  /** Runtime-only handler deadline override; never projected into provider schemas. */
  executionTimeoutMs?: number;
  /**
   * Bounded time to let an aborted handler finish trusted cleanup before its
   * exclusive execution resource is treated as unsettled.
   */
  executionAbortSettlementGraceMs?: number;
  /** Runtime-only reviewed operation identity; never projected into provider schemas. */
  operationJournal?: RegisteredToolOperationJournal<TInput>;
  isAvailable(): Promise<boolean> | boolean;
  resolveSecurity?(input: TInput, context: ToolSecurityResolverContext): Promise<ToolSecurityResolution | undefined> | ToolSecurityResolution | undefined;
  run: ToolHandler<TInput>;
};

export interface StaticToolProvider {
  readonly name: string;
  readonly kind: "static";
  readonly tools: readonly RegisteredTool[];
}

export interface RuntimeToolProvider {
  readonly name: string;
  readonly kind: "runtime";
  createTools(ctx: RuntimeToolContext): readonly RegisteredTool[];
}

export interface SessionToolProvider {
  readonly name: string;
  readonly kind: "session";
  createTools(ctx: SessionToolContext): readonly RegisteredTool[];
}

export type ToolProvider =
  | StaticToolProvider
  | RuntimeToolProvider
  | SessionToolProvider;

// Context shapes are defined in src/contracts/tool-context.ts.
