import type { DelegationConfig } from "../contracts/delegation.js";

export const DEFAULT_DELEGATION_CONFIG: DelegationConfig = {
  maxSpawnDepth: 1,
  maxConcurrentChildren: 3,
  maxDelegateCallsPerTurn: 3,
  maxBatchTasks: 10,
  childTimeoutSeconds: 600,
  heartbeatSeconds: 30,
  heartbeatStaleCyclesIdle: 3,
  heartbeatStaleCyclesInTool: 6,
  recoverJsonStringTasks: true,
  diagnostics: {
    enabled: true,
    includePromptPreview: false
  },
  defaultAllowedRiskClasses: ["read-only-local", "read-only-network"],
  defaultExcludedToolsets: ["browser", "media", "mcp"],
  defaultAllowedToolsets: [],
  blockedToolNames: [
    "delegate_task",
    "execute_code",
    "terminal.run",
    "process.start",
    "process.stop",
    "file.write",
    "file.patch",
    "session_search"
  ],
  blockedToolPrefixes: [
    "memory.",
    "skill.",
    "config.",
    "cron",
    "workspace.trust",
    "knowledge.memory."
  ],
  childRuntime: {
    memoryRecall: "disabled",
    skillLearning: "disabled",
    sessionCompression: "disabled",
    projectContext: "bounded"
  }
};
