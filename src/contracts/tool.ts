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
  progressLabel: string;
  maxResultSizeChars: number;
  requiredConfig?: string[];
};

export type ToolResultMetadata = Record<string, unknown> & {
  _estacoda_context_summary?: string;
};

export type ToolResult = {
  ok: boolean;
  content: string;
  metadata?: ToolResultMetadata;
};

export type ToolExecutionContext = {
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
  /** Dot-separated object path from reviewed code or profile configuration. */
  path: string;
  destination?: {
    type: "mcp-argument";
    serverId: string;
    toolName: string;
  };
};

export type RegisteredTool<TInput = any> = ToolDefinition & {
  /** Runtime-only declaration; ToolRegistry intentionally omits it from ToolDefinition. */
  protectedArguments?: readonly ProtectedToolArgumentDeclaration[];
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
