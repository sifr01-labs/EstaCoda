import type {SettingField} from '../contracts/desktop-control/index.js';
/** Public channel/capability settings. Secret-bearing legacy maps are replaced with private references. */
export const capabilitySettings:readonly SettingField[]=[
  {
    "id": "gateway.lifecycleNotifications.enabled",
    "path": [
      "gateway",
      "lifecycleNotifications",
      "enabled"
    ],
    "section": "channels",
    "kind": "choice",
    "choices": [
      false,
      true
    ]
  },
  {
    "id": "gateway.messageQueue.persistence",
    "path": [
      "gateway",
      "messageQueue",
      "persistence"
    ],
    "section": "channels",
    "kind": "choice",
    "choices": [
      "memory",
      "sqlite"
    ]
  },
  {
    "id": "gateway.messageQueue.maxPendingPerProfile",
    "path": [
      "gateway",
      "messageQueue",
      "maxPendingPerProfile"
    ],
    "section": "channels",
    "kind": "number",
    "min": 0,
    "max": 100000000
  },
  {
    "id": "gateway.messageQueue.uncertainRetentionDays",
    "path": [
      "gateway",
      "messageQueue",
      "uncertainRetentionDays"
    ],
    "section": "channels",
    "kind": "number",
    "min": 0,
    "max": 100000000
  },
  {
    "id": "mcpServers.*.enabled",
    "path": [
      "mcpServers",
      "*",
      "enabled"
    ],
    "section": "capabilities",
    "kind": "choice",
    "choices": [
      false,
      true
    ]
  },
  {
    "id": "mcpServers.*.transport",
    "path": [
      "mcpServers",
      "*",
      "transport"
    ],
    "section": "capabilities",
    "kind": "choice",
    "choices": [
      "stdio",
      "http"
    ]
  },
  {
    "id": "mcpServers.*.command",
    "path": [
      "mcpServers",
      "*",
      "command"
    ],
    "section": "capabilities",
    "kind": "text"
  },
  {
    "id": "mcpServers.*.args",
    "path": [
      "mcpServers",
      "*",
      "args"
    ],
    "section": "capabilities",
    "kind": "strings"
  },
  {
    "id": "mcpServers.*.cwd",
    "path": [
      "mcpServers",
      "*",
      "cwd"
    ],
    "section": "capabilities",
    "kind": "text"
  },
  {
    "id": "mcpServers.*.envRefs.*",
    "path": [
      "mcpServers",
      "*",
      "envRefs",
      "*"
    ],
    "section": "capabilities",
    "kind": "secret"
  },
  {
    "id": "mcpServers.*.url",
    "path": [
      "mcpServers",
      "*",
      "url"
    ],
    "section": "capabilities",
    "kind": "text"
  },
  {
    "id": "mcpServers.*.tools.include",
    "path": [
      "mcpServers",
      "*",
      "tools",
      "include"
    ],
    "section": "capabilities",
    "kind": "strings"
  },
  {
    "id": "mcpServers.*.tools.exclude",
    "path": [
      "mcpServers",
      "*",
      "tools",
      "exclude"
    ],
    "section": "capabilities",
    "kind": "strings"
  },
  {
    "id": "mcpServers.*.tools.resources",
    "path": [
      "mcpServers",
      "*",
      "tools",
      "resources"
    ],
    "section": "capabilities",
    "kind": "choice",
    "choices": [
      false,
      true
    ]
  },
  {
    "id": "mcpServers.*.tools.prompts",
    "path": [
      "mcpServers",
      "*",
      "tools",
      "prompts"
    ],
    "section": "capabilities",
    "kind": "choice",
    "choices": [
      false,
      true
    ]
  },
  {
    "id": "mcpServers.*.tools.prefix",
    "path": [
      "mcpServers",
      "*",
      "tools",
      "prefix"
    ],
    "section": "capabilities",
    "kind": "scalar"
  },
  {
    "id": "mcpServers.*.timeoutMs",
    "path": [
      "mcpServers",
      "*",
      "timeoutMs"
    ],
    "section": "capabilities",
    "kind": "number",
    "min": 0,
    "max": 100000000
  },
  {
    "id": "mcpServers.*.connectTimeoutMs",
    "path": [
      "mcpServers",
      "*",
      "connectTimeoutMs"
    ],
    "section": "capabilities",
    "kind": "number",
    "min": 0,
    "max": 100000000
  },
  {
    "id": "mcpServers.*.trust",
    "path": [
      "mcpServers",
      "*",
      "trust"
    ],
    "section": "capabilities",
    "kind": "choice",
    "choices": [
      "read-only-local",
      "read-only-network",
      "conservative"
    ]
  },
  {
    "id": "mcpServers.*.toolRiskClass",
    "path": [
      "mcpServers",
      "*",
      "toolRiskClass"
    ],
    "section": "capabilities",
    "kind": "choice",
    "choices": [
      "read-only-local",
      "read-only-network",
      "workspace-write",
      "external-side-effect",
      "credential-access",
      "destructive-local",
      "shared-state-mutation",
      "spend-money",
      "sandbox-escape"
    ]
  },
  {
    "id": "mcpServers.*.toolRiskClasses.*",
    "path": [
      "mcpServers",
      "*",
      "toolRiskClasses",
      "*"
    ],
    "section": "capabilities",
    "kind": "choice",
    "choices": [
      "read-only-local",
      "read-only-network",
      "workspace-write",
      "external-side-effect",
      "credential-access",
      "destructive-local",
      "shared-state-mutation",
      "spend-money",
      "sandbox-escape"
    ]
  },
  {
    "id": "mcpServers.*.protectedToolArguments.*.paths",
    "path": [
      "mcpServers",
      "*",
      "protectedToolArguments",
      "*",
      "paths"
    ],
    "section": "capabilities",
    "kind": "strings"
  },
  {
    "id": "mcpServers.*.protectedToolArguments.*.handling.persistence",
    "path": [
      "mcpServers",
      "*",
      "protectedToolArguments",
      "*",
      "handling",
      "persistence"
    ],
    "section": "capabilities",
    "kind": "choice",
    "choices": [
      "none",
      "destination-managed",
      "unknown"
    ]
  },
  {
    "id": "mcpServers.*.protectedToolArguments.*.handling.sharing",
    "path": [
      "mcpServers",
      "*",
      "protectedToolArguments",
      "*",
      "handling",
      "sharing"
    ],
    "section": "capabilities",
    "kind": "choice",
    "choices": [
      "unknown",
      "private",
      "workspace",
      "account",
      "external"
    ]
  },
  {
    "id": "mcpServers.*.protectedToolArguments.*.groupedDelivery",
    "path": [
      "mcpServers",
      "*",
      "protectedToolArguments",
      "*",
      "groupedDelivery"
    ],
    "section": "capabilities",
    "kind": "choice",
    "choices": [
      false,
      true
    ]
  },
  {
    "id": "mcpServers.*.protectedToolArguments.*.browserRelay",
    "path": [
      "mcpServers",
      "*",
      "protectedToolArguments",
      "*",
      "browserRelay"
    ],
    "section": "capabilities",
    "kind": "choice",
    "choices": [
      false,
      true
    ]
  },
  {
    "id": "mcpServers.*.artifactToolArguments.*.typeMapping.argument",
    "path": [
      "mcpServers",
      "*",
      "artifactToolArguments",
      "*",
      "typeMapping",
      "argument"
    ],
    "section": "capabilities",
    "kind": "text"
  },
  {
    "id": "mcpServers.*.artifactToolArguments.*.typeMapping.values.*",
    "path": [
      "mcpServers",
      "*",
      "artifactToolArguments",
      "*",
      "typeMapping",
      "values",
      "*"
    ],
    "section": "capabilities",
    "kind": "text"
  },
  {
    "id": "mcpServers.*.artifactToolArguments.*.paths",
    "path": [
      "mcpServers",
      "*",
      "artifactToolArguments",
      "*",
      "paths"
    ],
    "section": "capabilities",
    "kind": "strings"
  },
  {
    "id": "mcpServers.*.artifactToolArguments.*.allowedMimeTypes",
    "path": [
      "mcpServers",
      "*",
      "artifactToolArguments",
      "*",
      "allowedMimeTypes"
    ],
    "section": "capabilities",
    "kind": "strings"
  },
  {
    "id": "mcpServers.*.artifactToolArguments.*.maxBytes",
    "path": [
      "mcpServers",
      "*",
      "artifactToolArguments",
      "*",
      "maxBytes"
    ],
    "section": "capabilities",
    "kind": "number",
    "min": 0,
    "max": 100000000
  },
  {
    "id": "mcpServers.*.redactedToolResultPaths.*",
    "path": [
      "mcpServers",
      "*",
      "redactedToolResultPaths",
      "*"
    ],
    "section": "capabilities",
    "kind": "strings"
  },
  {
    "id": "mcpServers.*.continuityToolResultPaths.*",
    "path": [
      "mcpServers",
      "*",
      "continuityToolResultPaths",
      "*"
    ],
    "section": "capabilities",
    "kind": "strings"
  },
  {
    "id": "mcpServers.*.toolVerificationRelationships.*",
    "path": [
      "mcpServers",
      "*",
      "toolVerificationRelationships",
      "*"
    ],
    "section": "capabilities",
    "kind": "strings"
  },
  {
    "id": "mcpServers.*.resourceReadRiskClass",
    "path": [
      "mcpServers",
      "*",
      "resourceReadRiskClass"
    ],
    "section": "capabilities",
    "kind": "choice",
    "choices": [
      "read-only-local",
      "read-only-network",
      "workspace-write",
      "external-side-effect",
      "credential-access",
      "destructive-local",
      "shared-state-mutation",
      "spend-money",
      "sandbox-escape"
    ]
  },
  {
    "id": "mcpServers.*.promptGetRiskClass",
    "path": [
      "mcpServers",
      "*",
      "promptGetRiskClass"
    ],
    "section": "capabilities",
    "kind": "choice",
    "choices": [
      "read-only-local",
      "read-only-network",
      "workspace-write",
      "external-side-effect",
      "credential-access",
      "destructive-local",
      "shared-state-mutation",
      "spend-money",
      "sandbox-escape"
    ]
  },
  {
    "id": "skills.externalDirs",
    "path": [
      "skills",
      "externalDirs"
    ],
    "section": "capabilities",
    "kind": "strings"
  },
  {
    "id": "skills.config.*.*",
    "path": [
      "skills",
      "config",
      "*",
      "*"
    ],
    "section": "capabilities",
    "kind": "scalar"
  },
  {
    "id": "channels.telegram.enabled",
    "path": [
      "channels",
      "telegram",
      "enabled"
    ],
    "section": "channels",
    "kind": "choice",
    "choices": [
      false,
      true
    ]
  },
  {
    "id": "channels.telegram.botTokenEnv",
    "path": [
      "channels",
      "telegram",
      "botTokenEnv"
    ],
    "section": "channels",
    "kind": "secret"
  },
  {
    "id": "channels.telegram.defaultChatId",
    "path": [
      "channels",
      "telegram",
      "defaultChatId"
    ],
    "section": "channels",
    "kind": "text"
  },
  {
    "id": "channels.telegram.allowedUserIds",
    "path": [
      "channels",
      "telegram",
      "allowedUserIds"
    ],
    "section": "channels",
    "kind": "strings"
  },
  {
    "id": "channels.telegram.allowedChatIds",
    "path": [
      "channels",
      "telegram",
      "allowedChatIds"
    ],
    "section": "channels",
    "kind": "strings"
  },
  {
    "id": "channels.telegram.groupSessionsPerUser",
    "path": [
      "channels",
      "telegram",
      "groupSessionsPerUser"
    ],
    "section": "channels",
    "kind": "choice",
    "choices": [
      false,
      true
    ]
  },
  {
    "id": "channels.telegram.threadSessionsPerUser",
    "path": [
      "channels",
      "telegram",
      "threadSessionsPerUser"
    ],
    "section": "channels",
    "kind": "choice",
    "choices": [
      false,
      true
    ]
  },
  {
    "id": "channels.telegram.sessionResetPolicy",
    "path": [
      "channels",
      "telegram",
      "sessionResetPolicy"
    ],
    "section": "channels",
    "kind": "choice",
    "choices": [
      "none",
      "idle",
      "daily",
      "both"
    ]
  },
  {
    "id": "channels.telegram.sessionIdleResetMinutes",
    "path": [
      "channels",
      "telegram",
      "sessionIdleResetMinutes"
    ],
    "section": "channels",
    "kind": "number",
    "min": 0,
    "max": 100000000
  },
  {
    "id": "channels.telegram.pollTimeoutSeconds",
    "path": [
      "channels",
      "telegram",
      "pollTimeoutSeconds"
    ],
    "section": "channels",
    "kind": "number",
    "min": 0,
    "max": 100000000
  },
  {
    "id": "channels.telegram.maxAttachmentBytes",
    "path": [
      "channels",
      "telegram",
      "maxAttachmentBytes"
    ],
    "section": "channels",
    "kind": "number",
    "min": 0,
    "max": 100000000
  },
  {
    "id": "channels.telegram.busyPolicy",
    "path": [
      "channels",
      "telegram",
      "busyPolicy"
    ],
    "section": "channels",
    "kind": "choice",
    "choices": [
      "reject",
      "queue",
      "interrupt"
    ]
  },
  {
    "id": "channels.telegram.queueDepth",
    "path": [
      "channels",
      "telegram",
      "queueDepth"
    ],
    "section": "channels",
    "kind": "number",
    "min": 0,
    "max": 100000000
  },
  {
    "id": "channels.telegram.busyTextCoalescing.enabled",
    "path": [
      "channels",
      "telegram",
      "busyTextCoalescing",
      "enabled"
    ],
    "section": "channels",
    "kind": "choice",
    "choices": [
      false,
      true
    ]
  },
  {
    "id": "channels.telegram.busyTextCoalescing.windowMs",
    "path": [
      "channels",
      "telegram",
      "busyTextCoalescing",
      "windowMs"
    ],
    "section": "channels",
    "kind": "number",
    "min": 0,
    "max": 100000000
  },
  {
    "id": "channels.telegram.busyTextCoalescing.maxMessages",
    "path": [
      "channels",
      "telegram",
      "busyTextCoalescing",
      "maxMessages"
    ],
    "section": "channels",
    "kind": "number",
    "min": 0,
    "max": 100000000
  },
  {
    "id": "channels.telegram.busyTextCoalescing.maxChars",
    "path": [
      "channels",
      "telegram",
      "busyTextCoalescing",
      "maxChars"
    ],
    "section": "channels",
    "kind": "number",
    "min": 0,
    "max": 100000000
  },
  {
    "id": "channels.telegram.textDebounceMs",
    "path": [
      "channels",
      "telegram",
      "textDebounceMs"
    ],
    "section": "channels",
    "kind": "number",
    "min": 0,
    "max": 100000000
  },
  {
    "id": "channels.telegram.textDebounceMaxMessages",
    "path": [
      "channels",
      "telegram",
      "textDebounceMaxMessages"
    ],
    "section": "channels",
    "kind": "number",
    "min": 0,
    "max": 100000000
  },
  {
    "id": "channels.telegram.textDebounceMaxChars",
    "path": [
      "channels",
      "telegram",
      "textDebounceMaxChars"
    ],
    "section": "channels",
    "kind": "number",
    "min": 0,
    "max": 100000000
  },
  {
    "id": "channels.telegram.secureInputMode",
    "path": [
      "channels",
      "telegram",
      "secureInputMode"
    ],
    "section": "channels",
    "kind": "choice",
    "choices": [
      "disabled",
      "protected-handoff",
      "direct-dm"
    ]
  },
  {
    "id": "channels.telegram.streaming.enabled",
    "path": [
      "channels",
      "telegram",
      "streaming",
      "enabled"
    ],
    "section": "channels",
    "kind": "choice",
    "choices": [
      false,
      true
    ]
  },
  {
    "id": "channels.telegram.streaming.editIntervalMs",
    "path": [
      "channels",
      "telegram",
      "streaming",
      "editIntervalMs"
    ],
    "section": "channels",
    "kind": "number",
    "min": 0,
    "max": 100000000
  },
  {
    "id": "channels.telegram.streaming.minInitialChars",
    "path": [
      "channels",
      "telegram",
      "streaming",
      "minInitialChars"
    ],
    "section": "channels",
    "kind": "number",
    "min": 0,
    "max": 100000000
  },
  {
    "id": "channels.telegram.streaming.cursor",
    "path": [
      "channels",
      "telegram",
      "streaming",
      "cursor"
    ],
    "section": "channels",
    "kind": "text"
  },
  {
    "id": "channels.telegram.streaming.maxFloodStrikes",
    "path": [
      "channels",
      "telegram",
      "streaming",
      "maxFloodStrikes"
    ],
    "section": "channels",
    "kind": "number",
    "min": 0,
    "max": 100000000
  },
  {
    "id": "channels.telegram.streaming.cleanupFailedAttempts",
    "path": [
      "channels",
      "telegram",
      "streaming",
      "cleanupFailedAttempts"
    ],
    "section": "channels",
    "kind": "choice",
    "choices": [
      false,
      true
    ]
  },
  {
    "id": "channels.telegram.streaming.freshFinalAfterSeconds",
    "path": [
      "channels",
      "telegram",
      "streaming",
      "freshFinalAfterSeconds"
    ],
    "section": "channels",
    "kind": "number",
    "min": 0,
    "max": 100000000
  },
  {
    "id": "channels.telegram.streaming.transport",
    "path": [
      "channels",
      "telegram",
      "streaming",
      "transport"
    ],
    "section": "channels",
    "kind": "choice",
    "choices": [
      "auto",
      "edit",
      "draft"
    ]
  },
  {
    "id": "channels.discord.enabled",
    "path": [
      "channels",
      "discord",
      "enabled"
    ],
    "section": "channels",
    "kind": "choice",
    "choices": [
      false,
      true
    ]
  },
  {
    "id": "channels.discord.botTokenEnv",
    "path": [
      "channels",
      "discord",
      "botTokenEnv"
    ],
    "section": "channels",
    "kind": "secret"
  },
  {
    "id": "channels.discord.allowedUsers",
    "path": [
      "channels",
      "discord",
      "allowedUsers"
    ],
    "section": "channels",
    "kind": "strings"
  },
  {
    "id": "channels.discord.allowedGuilds",
    "path": [
      "channels",
      "discord",
      "allowedGuilds"
    ],
    "section": "channels",
    "kind": "strings"
  },
  {
    "id": "channels.discord.allowedChannels",
    "path": [
      "channels",
      "discord",
      "allowedChannels"
    ],
    "section": "channels",
    "kind": "strings"
  },
  {
    "id": "channels.discord.freeResponseChannels",
    "path": [
      "channels",
      "discord",
      "freeResponseChannels"
    ],
    "section": "channels",
    "kind": "strings"
  },
  {
    "id": "channels.discord.voiceChannel.enabled",
    "path": [
      "channels",
      "discord",
      "voiceChannel",
      "enabled"
    ],
    "section": "channels",
    "kind": "choice",
    "choices": [
      false,
      true
    ]
  },
  {
    "id": "channels.discord.voiceChannel.autoJoinOnCommand",
    "path": [
      "channels",
      "discord",
      "voiceChannel",
      "autoJoinOnCommand"
    ],
    "section": "channels",
    "kind": "choice",
    "choices": [
      false,
      true
    ]
  },
  {
    "id": "channels.discord.busyPolicy",
    "path": [
      "channels",
      "discord",
      "busyPolicy"
    ],
    "section": "channels",
    "kind": "choice",
    "choices": [
      "reject",
      "queue",
      "interrupt"
    ]
  },
  {
    "id": "channels.discord.queueDepth",
    "path": [
      "channels",
      "discord",
      "queueDepth"
    ],
    "section": "channels",
    "kind": "number",
    "min": 0,
    "max": 100000000
  },
  {
    "id": "channels.discord.busyTextCoalescing.enabled",
    "path": [
      "channels",
      "discord",
      "busyTextCoalescing",
      "enabled"
    ],
    "section": "channels",
    "kind": "choice",
    "choices": [
      false,
      true
    ]
  },
  {
    "id": "channels.discord.busyTextCoalescing.windowMs",
    "path": [
      "channels",
      "discord",
      "busyTextCoalescing",
      "windowMs"
    ],
    "section": "channels",
    "kind": "number",
    "min": 0,
    "max": 100000000
  },
  {
    "id": "channels.discord.busyTextCoalescing.maxMessages",
    "path": [
      "channels",
      "discord",
      "busyTextCoalescing",
      "maxMessages"
    ],
    "section": "channels",
    "kind": "number",
    "min": 0,
    "max": 100000000
  },
  {
    "id": "channels.discord.busyTextCoalescing.maxChars",
    "path": [
      "channels",
      "discord",
      "busyTextCoalescing",
      "maxChars"
    ],
    "section": "channels",
    "kind": "number",
    "min": 0,
    "max": 100000000
  },
  {
    "id": "channels.email.enabled",
    "path": [
      "channels",
      "email",
      "enabled"
    ],
    "section": "channels",
    "kind": "choice",
    "choices": [
      false,
      true
    ]
  },
  {
    "id": "channels.email.imapHost",
    "path": [
      "channels",
      "email",
      "imapHost"
    ],
    "section": "channels",
    "kind": "text"
  },
  {
    "id": "channels.email.imapPort",
    "path": [
      "channels",
      "email",
      "imapPort"
    ],
    "section": "channels",
    "kind": "number",
    "min": 0,
    "max": 100000000
  },
  {
    "id": "channels.email.smtpHost",
    "path": [
      "channels",
      "email",
      "smtpHost"
    ],
    "section": "channels",
    "kind": "text"
  },
  {
    "id": "channels.email.smtpPort",
    "path": [
      "channels",
      "email",
      "smtpPort"
    ],
    "section": "channels",
    "kind": "number",
    "min": 0,
    "max": 100000000
  },
  {
    "id": "channels.email.username",
    "path": [
      "channels",
      "email",
      "username"
    ],
    "section": "channels",
    "kind": "text"
  },
  {
    "id": "channels.email.passwordEnv",
    "path": [
      "channels",
      "email",
      "passwordEnv"
    ],
    "section": "channels",
    "kind": "secret"
  },
  {
    "id": "channels.email.ownAddress",
    "path": [
      "channels",
      "email",
      "ownAddress"
    ],
    "section": "channels",
    "kind": "text"
  },
  {
    "id": "channels.email.homeAddress",
    "path": [
      "channels",
      "email",
      "homeAddress"
    ],
    "section": "channels",
    "kind": "text"
  },
  {
    "id": "channels.email.allowedSenders",
    "path": [
      "channels",
      "email",
      "allowedSenders"
    ],
    "section": "channels",
    "kind": "strings"
  },
  {
    "id": "channels.email.allowAllUsers",
    "path": [
      "channels",
      "email",
      "allowAllUsers"
    ],
    "section": "channels",
    "kind": "choice",
    "choices": [
      false,
      true
    ]
  },
  {
    "id": "channels.email.pollIntervalSeconds",
    "path": [
      "channels",
      "email",
      "pollIntervalSeconds"
    ],
    "section": "channels",
    "kind": "number",
    "min": 0,
    "max": 100000000
  },
  {
    "id": "channels.email.maxAttachmentBytes",
    "path": [
      "channels",
      "email",
      "maxAttachmentBytes"
    ],
    "section": "channels",
    "kind": "number",
    "min": 0,
    "max": 100000000
  },
  {
    "id": "channels.email.busyPolicy",
    "path": [
      "channels",
      "email",
      "busyPolicy"
    ],
    "section": "channels",
    "kind": "choice",
    "choices": [
      "reject",
      "queue",
      "interrupt"
    ]
  },
  {
    "id": "channels.email.queueDepth",
    "path": [
      "channels",
      "email",
      "queueDepth"
    ],
    "section": "channels",
    "kind": "number",
    "min": 0,
    "max": 100000000
  },
  {
    "id": "channels.email.busyTextCoalescing.enabled",
    "path": [
      "channels",
      "email",
      "busyTextCoalescing",
      "enabled"
    ],
    "section": "channels",
    "kind": "choice",
    "choices": [
      false,
      true
    ]
  },
  {
    "id": "channels.email.busyTextCoalescing.windowMs",
    "path": [
      "channels",
      "email",
      "busyTextCoalescing",
      "windowMs"
    ],
    "section": "channels",
    "kind": "number",
    "min": 0,
    "max": 100000000
  },
  {
    "id": "channels.email.busyTextCoalescing.maxMessages",
    "path": [
      "channels",
      "email",
      "busyTextCoalescing",
      "maxMessages"
    ],
    "section": "channels",
    "kind": "number",
    "min": 0,
    "max": 100000000
  },
  {
    "id": "channels.email.busyTextCoalescing.maxChars",
    "path": [
      "channels",
      "email",
      "busyTextCoalescing",
      "maxChars"
    ],
    "section": "channels",
    "kind": "number",
    "min": 0,
    "max": 100000000
  },
  {
    "id": "channels.whatsapp.enabled",
    "path": [
      "channels",
      "whatsapp",
      "enabled"
    ],
    "section": "channels",
    "kind": "choice",
    "choices": [
      false,
      true
    ]
  },
  {
    "id": "channels.whatsapp.experimental",
    "path": [
      "channels",
      "whatsapp",
      "experimental"
    ],
    "section": "channels",
    "kind": "choice",
    "choices": [
      false,
      true
    ]
  },
  {
    "id": "channels.whatsapp.authDir",
    "path": [
      "channels",
      "whatsapp",
      "authDir"
    ],
    "section": "channels",
    "kind": "text"
  },
  {
    "id": "channels.whatsapp.allowedUsers",
    "path": [
      "channels",
      "whatsapp",
      "allowedUsers"
    ],
    "section": "channels",
    "kind": "strings"
  },
  {
    "id": "channels.whatsapp.allowedGroups",
    "path": [
      "channels",
      "whatsapp",
      "allowedGroups"
    ],
    "section": "channels",
    "kind": "strings"
  },
  {
    "id": "channels.whatsapp.mode",
    "path": [
      "channels",
      "whatsapp",
      "mode"
    ],
    "section": "channels",
    "kind": "choice",
    "choices": [
      "bot",
      "self-chat"
    ]
  },
  {
    "id": "channels.whatsapp.dmPolicy",
    "path": [
      "channels",
      "whatsapp",
      "dmPolicy"
    ],
    "section": "channels",
    "kind": "choice",
    "choices": [
      "disabled",
      "open",
      "allowlist",
      "pairing"
    ]
  },
  {
    "id": "channels.whatsapp.groupPolicy",
    "path": [
      "channels",
      "whatsapp",
      "groupPolicy"
    ],
    "section": "channels",
    "kind": "choice",
    "choices": [
      "disabled",
      "open",
      "allowlist"
    ]
  },
  {
    "id": "channels.whatsapp.requireMention",
    "path": [
      "channels",
      "whatsapp",
      "requireMention"
    ],
    "section": "channels",
    "kind": "choice",
    "choices": [
      false,
      true
    ]
  },
  {
    "id": "channels.whatsapp.mentionPatterns",
    "path": [
      "channels",
      "whatsapp",
      "mentionPatterns"
    ],
    "section": "channels",
    "kind": "strings"
  },
  {
    "id": "channels.whatsapp.freeResponseChats",
    "path": [
      "channels",
      "whatsapp",
      "freeResponseChats"
    ],
    "section": "channels",
    "kind": "strings"
  },
  {
    "id": "channels.whatsapp.replyPrefix",
    "path": [
      "channels",
      "whatsapp",
      "replyPrefix"
    ],
    "section": "channels",
    "kind": "text"
  },
  {
    "id": "channels.whatsapp.pairingMode",
    "path": [
      "channels",
      "whatsapp",
      "pairingMode"
    ],
    "section": "channels",
    "kind": "choice",
    "choices": [
      "qr"
    ]
  },
  {
    "id": "channels.whatsapp.busyPolicy",
    "path": [
      "channels",
      "whatsapp",
      "busyPolicy"
    ],
    "section": "channels",
    "kind": "choice",
    "choices": [
      "reject",
      "queue",
      "interrupt"
    ]
  },
  {
    "id": "channels.whatsapp.queueDepth",
    "path": [
      "channels",
      "whatsapp",
      "queueDepth"
    ],
    "section": "channels",
    "kind": "number",
    "min": 0,
    "max": 100000000
  },
  {
    "id": "channels.whatsapp.busyTextCoalescing.enabled",
    "path": [
      "channels",
      "whatsapp",
      "busyTextCoalescing",
      "enabled"
    ],
    "section": "channels",
    "kind": "choice",
    "choices": [
      false,
      true
    ]
  },
  {
    "id": "channels.whatsapp.busyTextCoalescing.windowMs",
    "path": [
      "channels",
      "whatsapp",
      "busyTextCoalescing",
      "windowMs"
    ],
    "section": "channels",
    "kind": "number",
    "min": 0,
    "max": 100000000
  },
  {
    "id": "channels.whatsapp.busyTextCoalescing.maxMessages",
    "path": [
      "channels",
      "whatsapp",
      "busyTextCoalescing",
      "maxMessages"
    ],
    "section": "channels",
    "kind": "number",
    "min": 0,
    "max": 100000000
  },
  {
    "id": "channels.whatsapp.busyTextCoalescing.maxChars",
    "path": [
      "channels",
      "whatsapp",
      "busyTextCoalescing",
      "maxChars"
    ],
    "section": "channels",
    "kind": "number",
    "min": 0,
    "max": 100000000
  },
  {
    "id": "channels.whatsapp.textDebounceMs",
    "path": [
      "channels",
      "whatsapp",
      "textDebounceMs"
    ],
    "section": "channels",
    "kind": "number",
    "min": 0,
    "max": 100000000
  },
  {
    "id": "channels.whatsapp.textDebounceMaxMessages",
    "path": [
      "channels",
      "whatsapp",
      "textDebounceMaxMessages"
    ],
    "section": "channels",
    "kind": "number",
    "min": 0,
    "max": 100000000
  },
  {
    "id": "channels.whatsapp.textDebounceMaxChars",
    "path": [
      "channels",
      "whatsapp",
      "textDebounceMaxChars"
    ],
    "section": "channels",
    "kind": "number",
    "min": 0,
    "max": 100000000
  },
  {
    "id": "mcpServers.*.headerRefs.*",
    "path": [
      "mcpServers",
      "*",
      "headerRefs",
      "*"
    ],
    "section": "capabilities",
    "kind": "secret"
  }
];
