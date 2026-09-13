import type {SettingField} from '../contracts/desktop-control/index.js';
/** Canonical governance settings; legacy assessor route names remain read-compatible only. */
export const governanceSettings:readonly SettingField[]=[
  {
    "id": "memory.retrieval.enabled",
    "path": [
      "memory",
      "retrieval",
      "enabled"
    ],
    "section": "governance",
    "kind": "choice",
    "choices": [
      false,
      true
    ]
  },
  {
    "id": "memory.retrieval.mode",
    "path": [
      "memory",
      "retrieval",
      "mode"
    ],
    "section": "governance",
    "kind": "choice",
    "choices": [
      "lexical"
    ]
  },
  {
    "id": "memory.retrieval.maxResults",
    "path": [
      "memory",
      "retrieval",
      "maxResults"
    ],
    "section": "governance",
    "kind": "number",
    "min": 1,
    "max": 50
  },
  {
    "id": "memory.retrieval.maxChars",
    "path": [
      "memory",
      "retrieval",
      "maxChars"
    ],
    "section": "governance",
    "kind": "number",
    "min": 1,
    "max": 20000
  },
  {
    "id": "memory.index.enabled",
    "path": [
      "memory",
      "index",
      "enabled"
    ],
    "section": "governance",
    "kind": "choice",
    "choices": [
      false,
      true
    ]
  },
  {
    "id": "memory.index.backfillOnStartup",
    "path": [
      "memory",
      "index",
      "backfillOnStartup"
    ],
    "section": "governance",
    "kind": "choice",
    "choices": [
      "off",
      "bounded",
      "full"
    ]
  },
  {
    "id": "memory.index.reindexOnStartup",
    "path": [
      "memory",
      "index",
      "reindexOnStartup"
    ],
    "section": "governance",
    "kind": "choice",
    "choices": [
      false,
      true
    ]
  },
  {
    "id": "memory.index.vacuumIntervalDays",
    "path": [
      "memory",
      "index",
      "vacuumIntervalDays"
    ],
    "section": "governance",
    "kind": "number",
    "min": 1,
    "max": 365
  },
  {
    "id": "memory.curation.mode",
    "path": [
      "memory",
      "curation",
      "mode"
    ],
    "section": "governance",
    "kind": "choice",
    "choices": [
      "auto",
      "review",
      "manual"
    ]
  },
  {
    "id": "memory.curation.checkpointEveryTurns",
    "path": [
      "memory",
      "curation",
      "checkpointEveryTurns"
    ],
    "section": "governance",
    "kind": "number",
    "min": 1,
    "max": 500
  },
  {
    "id": "memory.curation.auditOnCompact",
    "path": [
      "memory",
      "curation",
      "auditOnCompact"
    ],
    "section": "governance",
    "kind": "choice",
    "choices": [
      false,
      true
    ]
  },
  {
    "id": "memory.curation.auditOnHandoff",
    "path": [
      "memory",
      "curation",
      "auditOnHandoff"
    ],
    "section": "governance",
    "kind": "choice",
    "choices": [
      false,
      true
    ]
  },
  {
    "id": "memory.curation.auditOnRuntimeDispose",
    "path": [
      "memory",
      "curation",
      "auditOnRuntimeDispose"
    ],
    "section": "governance",
    "kind": "choice",
    "choices": [
      false,
      true
    ]
  },
  {
    "id": "memory.curation.runtimeDisposeMinNewMessages",
    "path": [
      "memory",
      "curation",
      "runtimeDisposeMinNewMessages"
    ],
    "section": "governance",
    "kind": "number",
    "min": 1,
    "max": 100
  },
  {
    "id": "memory.curation.runtimeDisposeMinIntervalMinutes",
    "path": [
      "memory",
      "curation",
      "runtimeDisposeMinIntervalMinutes"
    ],
    "section": "governance",
    "kind": "number",
    "min": 1,
    "max": 1440
  },
  {
    "id": "memory.curation.autoApplyMaxRisk",
    "path": [
      "memory",
      "curation",
      "autoApplyMaxRisk"
    ],
    "section": "governance",
    "kind": "choice",
    "choices": [
      "low",
      "medium",
      "high"
    ]
  },
  {
    "id": "memory.curation.autoApplyMinConfidence",
    "path": [
      "memory",
      "curation",
      "autoApplyMinConfidence"
    ],
    "section": "governance",
    "kind": "number",
    "min": 0,
    "max": 1
  },
  {
    "id": "memory.curation.autoWriteVisibility",
    "path": [
      "memory",
      "curation",
      "autoWriteVisibility"
    ],
    "section": "governance",
    "kind": "choice",
    "choices": [
      "off",
      "activity",
      "inline"
    ]
  },
  {
    "id": "compression.enabled",
    "path": [
      "compression",
      "enabled"
    ],
    "section": "governance",
    "kind": "choice",
    "choices": [
      false,
      true
    ]
  },
  {
    "id": "compression.threshold",
    "path": [
      "compression",
      "threshold"
    ],
    "section": "governance",
    "kind": "number",
    "min": 0.1,
    "max": 0.95
  },
  {
    "id": "compression.targetRatio",
    "path": [
      "compression",
      "targetRatio"
    ],
    "section": "governance",
    "kind": "number",
    "min": 0.1,
    "max": 0.8
  },
  {
    "id": "compression.protectFirstN",
    "path": [
      "compression",
      "protectFirstN"
    ],
    "section": "governance",
    "kind": "number",
    "min": 0,
    "max": 100000000
  },
  {
    "id": "compression.protectLastN",
    "path": [
      "compression",
      "protectLastN"
    ],
    "section": "governance",
    "kind": "number",
    "min": 1,
    "max": 100000
  },
  {
    "id": "compression.summaryModelContextLength",
    "path": [
      "compression",
      "summaryModelContextLength"
    ],
    "section": "governance",
    "kind": "number",
    "min": 0,
    "max": 100000000
  },
  {
    "id": "compression.experimental",
    "path": [
      "compression",
      "experimental"
    ],
    "section": "governance",
    "kind": "choice",
    "choices": [
      false,
      true
    ]
  },
  {
    "id": "externalMemory.enabled",
    "path": [
      "externalMemory",
      "enabled"
    ],
    "section": "governance",
    "kind": "choice",
    "choices": [
      false,
      true
    ]
  },
  {
    "id": "externalMemory.provider",
    "path": [
      "externalMemory",
      "provider"
    ],
    "section": "governance",
    "kind": "text"
  },
  {
    "id": "externalMemory.timeoutMs",
    "path": [
      "externalMemory",
      "timeoutMs"
    ],
    "section": "governance",
    "kind": "number",
    "min": 1,
    "max": 5000
  },
  {
    "id": "externalMemory.maxResults",
    "path": [
      "externalMemory",
      "maxResults"
    ],
    "section": "governance",
    "kind": "number",
    "min": 1,
    "max": 10
  },
  {
    "id": "externalMemory.maxChars",
    "path": [
      "externalMemory",
      "maxChars"
    ],
    "section": "governance",
    "kind": "number",
    "min": 1,
    "max": 20000
  },
  {
    "id": "externalMemory.mirrorWrites",
    "path": [
      "externalMemory",
      "mirrorWrites"
    ],
    "section": "governance",
    "kind": "choice",
    "choices": [
      false,
      true
    ]
  },
  {
    "id": "externalMemory.file.path",
    "path": [
      "externalMemory",
      "file",
      "path"
    ],
    "section": "governance",
    "kind": "text"
  },
  {
    "id": "externalMemory.file.maxEntries",
    "path": [
      "externalMemory",
      "file",
      "maxEntries"
    ],
    "section": "governance",
    "kind": "number",
    "min": 1,
    "max": 10000
  },
  {
    "id": "delegation.maxSpawnDepth",
    "path": [
      "delegation",
      "maxSpawnDepth"
    ],
    "section": "governance",
    "kind": "number",
    "min": 0,
    "max": 100000000
  },
  {
    "id": "delegation.maxConcurrentChildren",
    "path": [
      "delegation",
      "maxConcurrentChildren"
    ],
    "section": "governance",
    "kind": "number",
    "min": 0,
    "max": 100000000
  },
  {
    "id": "delegation.maxDelegateCallsPerTurn",
    "path": [
      "delegation",
      "maxDelegateCallsPerTurn"
    ],
    "section": "governance",
    "kind": "number",
    "min": 0,
    "max": 100000000
  },
  {
    "id": "delegation.childTimeoutSeconds",
    "path": [
      "delegation",
      "childTimeoutSeconds"
    ],
    "section": "governance",
    "kind": "number",
    "min": 0,
    "max": 100000000
  },
  {
    "id": "delegation.maxBatchTasks",
    "path": [
      "delegation",
      "maxBatchTasks"
    ],
    "section": "governance",
    "kind": "number",
    "min": 0,
    "max": 100000000
  },
  {
    "id": "delegation.heartbeatSeconds",
    "path": [
      "delegation",
      "heartbeatSeconds"
    ],
    "section": "governance",
    "kind": "number",
    "min": 0,
    "max": 100000000
  },
  {
    "id": "delegation.heartbeatStaleCyclesIdle",
    "path": [
      "delegation",
      "heartbeatStaleCyclesIdle"
    ],
    "section": "governance",
    "kind": "number",
    "min": 0,
    "max": 100000000
  },
  {
    "id": "delegation.heartbeatStaleCyclesInTool",
    "path": [
      "delegation",
      "heartbeatStaleCyclesInTool"
    ],
    "section": "governance",
    "kind": "number",
    "min": 0,
    "max": 100000000
  },
  {
    "id": "delegation.recoverJsonStringTasks",
    "path": [
      "delegation",
      "recoverJsonStringTasks"
    ],
    "section": "governance",
    "kind": "choice",
    "choices": [
      false,
      true
    ]
  },
  {
    "id": "delegation.defaultAllowedRiskClasses",
    "path": [
      "delegation",
      "defaultAllowedRiskClasses"
    ],
    "section": "governance",
    "kind": "strings"
  },
  {
    "id": "delegation.defaultExcludedToolsets",
    "path": [
      "delegation",
      "defaultExcludedToolsets"
    ],
    "section": "governance",
    "kind": "strings"
  },
  {
    "id": "delegation.defaultAllowedToolsets",
    "path": [
      "delegation",
      "defaultAllowedToolsets"
    ],
    "section": "governance",
    "kind": "strings"
  },
  {
    "id": "delegation.blockedToolNames",
    "path": [
      "delegation",
      "blockedToolNames"
    ],
    "section": "governance",
    "kind": "strings"
  },
  {
    "id": "delegation.blockedToolPrefixes",
    "path": [
      "delegation",
      "blockedToolPrefixes"
    ],
    "section": "governance",
    "kind": "strings"
  },
  {
    "id": "delegation.diagnostics.enabled",
    "path": [
      "delegation",
      "diagnostics",
      "enabled"
    ],
    "section": "governance",
    "kind": "choice",
    "choices": [
      false,
      true
    ]
  },
  {
    "id": "delegation.diagnostics.includePromptPreview",
    "path": [
      "delegation",
      "diagnostics",
      "includePromptPreview"
    ],
    "section": "governance",
    "kind": "choice",
    "choices": [
      false,
      true
    ]
  },
  {
    "id": "delegation.childRuntime.memoryRecall",
    "path": [
      "delegation",
      "childRuntime",
      "memoryRecall"
    ],
    "section": "governance",
    "kind": "choice",
    "choices": [
      "disabled",
      "bounded"
    ]
  },
  {
    "id": "delegation.childRuntime.skillLearning",
    "path": [
      "delegation",
      "childRuntime",
      "skillLearning"
    ],
    "section": "governance",
    "kind": "choice",
    "choices": [
      "disabled"
    ]
  },
  {
    "id": "delegation.childRuntime.sessionCompression",
    "path": [
      "delegation",
      "childRuntime",
      "sessionCompression"
    ],
    "section": "governance",
    "kind": "choice",
    "choices": [
      "disabled",
      "enabled"
    ]
  },
  {
    "id": "delegation.childRuntime.projectContext",
    "path": [
      "delegation",
      "childRuntime",
      "projectContext"
    ],
    "section": "governance",
    "kind": "choice",
    "choices": [
      "disabled",
      "bounded"
    ]
  },
  {
    "id": "budgets.task.maxEstimatedCostUsd",
    "path": [
      "budgets",
      "task",
      "maxEstimatedCostUsd"
    ],
    "section": "governance",
    "kind": "number",
    "min": 0,
    "max": 100000000
  },
  {
    "id": "budgets.task.warningThresholdPercent",
    "path": [
      "budgets",
      "task",
      "warningThresholdPercent"
    ],
    "section": "governance",
    "kind": "number",
    "min": 1,
    "max": 100
  },
  {
    "id": "budgets.session.maxEstimatedCostUsd",
    "path": [
      "budgets",
      "session",
      "maxEstimatedCostUsd"
    ],
    "section": "governance",
    "kind": "number",
    "min": 0,
    "max": 100000000
  },
  {
    "id": "budgets.session.warningThresholdPercent",
    "path": [
      "budgets",
      "session",
      "warningThresholdPercent"
    ],
    "section": "governance",
    "kind": "number",
    "min": 1,
    "max": 100
  },
  {
    "id": "skills.autonomy",
    "path": [
      "skills",
      "autonomy"
    ],
    "section": "governance",
    "kind": "choice",
    "choices": [
      "none",
      "suggest",
      "proactive",
      "autonomous"
    ]
  },
  {
    "id": "security.approvalMode",
    "path": [
      "security",
      "approvalMode"
    ],
    "section": "governance",
    "kind": "choice",
    "choices": [
      "strict",
      "adaptive",
      "open"
    ]
  },
  {
    "id": "security.allowPrivateUrls",
    "path": [
      "security",
      "allowPrivateUrls"
    ],
    "section": "governance",
    "kind": "boolean"
  },
  {
    "id": "security.websiteBlocklist.domains",
    "path": [
      "security",
      "websiteBlocklist",
      "domains"
    ],
    "section": "governance",
    "kind": "strings"
  },
  {
    "id": "security.websiteBlocklist.sharedFiles",
    "path": [
      "security",
      "websiteBlocklist",
      "sharedFiles"
    ],
    "section": "governance",
    "kind": "strings"
  },
  {
    "id": "security.assessor.enabled",
    "path": [
      "security",
      "assessor",
      "enabled"
    ],
    "section": "governance",
    "kind": "choice",
    "choices": [
      false,
      true
    ]
  },
  {
    "id": "security.assessor.timeoutMs",
    "path": [
      "security",
      "assessor",
      "timeoutMs"
    ],
    "section": "governance",
    "kind": "number",
    "min": 0,
    "max": 100000000
  }
];
