import type { ToolRiskClass, ToolsetName } from "./tool.js";

export type DelegateRole = "leaf" | "orchestrator";

export const MAX_DELEGATE_MODEL_OVERRIDE_ID_LENGTH = 200;
export const MAX_DELEGATE_PROVIDER_OVERRIDE_ID_LENGTH = 100;

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
