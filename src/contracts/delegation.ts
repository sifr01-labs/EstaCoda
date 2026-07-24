import type { ToolRiskClass, ToolsetName } from "./tool.js";

export type DelegateRole = "leaf" | "orchestrator";

export const MAX_DELEGATION_BATCH_TASKS = 10;
export const DELEGATE_TASK_MAX_RESULT_CHARS = 8_000;
export const MAX_DELEGATE_MODEL_OVERRIDE_ID_LENGTH = 200;
export const MAX_DELEGATE_PROVIDER_OVERRIDE_ID_LENGTH = 100;
export const MAX_DELEGATE_RESEARCH_SCOPE_LENGTH = 120;

export type DelegateModelOverride = {
  model: string;
  provider?: string;
};

export type DelegateModelOverrideMetadata = {
  requested: boolean;
  status: "applied" | "rejected";
  provider?: string;
  model?: string;
  reason?: string;
  fallbackBehavior?: "parent" | "disabled-for-override";
};

export type DelegationConfig = {
  maxSpawnDepth: number;
  maxConcurrentChildren: number;
  maxDelegateCallsPerTurn?: number;
  childTimeoutSeconds: number;
  maxBatchTasks: number;
  heartbeatSeconds: number;
  heartbeatStaleCyclesIdle: number;
  heartbeatStaleCyclesInTool: number;
  recoverJsonStringTasks: boolean;
  diagnostics: {
    enabled: boolean;
    includePromptPreview: boolean;
  };
  defaultAllowedRiskClasses: ToolRiskClass[];
  defaultExcludedToolsets: ToolsetName[];
  defaultAllowedToolsets: ToolsetName[];
  blockedToolNames: string[];
  blockedToolPrefixes: string[];
  childRuntime: {
    memoryRecall: "disabled" | "bounded";
    skillLearning: "disabled";
    sessionCompression: "disabled" | "enabled";
    projectContext: "disabled" | "bounded";
  };
};

export type DelegateTaskItem = {
  task: string;
  context?: string;
  allowedToolsets?: ToolsetName[];
  allowedTools?: string[];
  role?: DelegateRole;
  modelOverride?: DelegateModelOverride;
  research?: DelegationResearchContract;
};

/** Immutable evidence requirements for one delegated research Step. */
export type DelegationResearchContract = {
  scope: string;
  requireLiveSources: boolean;
  requireRepositoryEvidence: boolean;
};

export type DelegationToolStripReason =
  | "not-parent-visible"
  | "blocked-exact-name"
  | "blocked-prefix"
  | "disallowed-risk-class"
  | "excluded-toolset"
  | "outside-requested-allowed-tools"
  | "outside-requested-allowed-toolsets"
  | "unknown-unclassified-mcp-like-tool"
  | "leaf-delegation-disabled"
  | "spawn-depth-exceeded";

export type DelegationToolDiagnostic = {
  name: string;
  reasons: DelegationToolStripReason[];
  toolsets?: ToolsetName[];
  riskClass?: string;
};

/** Bounded, durable authority-resolution evidence for one delegated Step. */
export type DelegationAccessAudit = {
  version: 1;
  requestedTools: readonly string[];
  requestedToolsets: readonly ToolsetName[];
  parentVisibleTools: readonly string[];
  effectiveAllowedTools: readonly string[];
  effectiveAllowedToolsets: readonly ToolsetName[];
  strippedTools: readonly DelegationToolDiagnostic[];
  rejectedRequestedTools: readonly DelegationToolDiagnostic[];
  rejectedRequestedToolsets: readonly DelegationToolDiagnostic[];
  omittedParentVisibleToolCount?: number;
  omittedStrippedToolCount?: number;
};

/** One fixed terminal Step that combines the durable results of every delegated worker. */
export type DelegateSynthesis = {
  objective: string;
  modelOverride?: DelegateModelOverride;
};

export type DelegationStaleFileWarning = {
  kind: "stale-parent-file-read";
  normalizedPath: string;
  displayPath?: string;
  parentSessionId: string;
  childSessionId: string;
  parentReadAt: string;
  childWriteAt: string;
  writeOperation: "write" | "replace" | "delete" | "unknown-write";
  sourceTool: string;
  taskIndex?: number;
  batchId?: string;
};
