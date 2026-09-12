# Desktop PR14B public settings parity inventory

Status: implementation inventory; rows marked pending are delivery gaps until exercised and reconciled. Source inspection covers `EstaCodaConfig` in `src/config/runtime-config.ts`, its public setup input types and writers, `src/setup/setup-editor-actions.ts`, `src/setup/review/apply-executor.ts`, and `src/cli/command-registry.ts`. A type declaration alone does not establish public support; compatibility aliases and runtime-generated fields are distinguished below.

## Shared acceptance and ownership

Every editable setting uses a bounded typed control, a selected-profile draft, explicit review/apply, the existing profile writer lock and recoverable config/credential transaction. Baseline changes invalidate review. Cancellation before durable commit leaves config and credentials untouched; uncertain commit is reconciled by receipt. Saved values round-trip through CLI inspection; CLI edits appear on refresh. Prompt-affecting values take effect at supported runtime reconstruction boundaries. No editor accepts arbitrary JSON or shell scripts.

Secret-bearing header/environment settings use protected entry and stored secret references, never plaintext in general renderer IPC. Existing API-key/OAuth/Telegram flows remain owned by their current candidate stores. Downloads, service installation and billable tests require explicit actions separate from read-only configuration verification. macOS is the declared initial Desktop platform; core configuration may describe other runtime backends without claiming Desktop can operate them.

## Actions outside configuration

| Public action/source | Desktop destination | Authority / credentials | Acceptance | State |
| --- | --- | --- | --- | --- |
| Model/provider/fallback/specialist setup; runtime-config.ts and model-setup.ts | Models and advanced model options | Reviewed route plans; private candidate pipe; profile apply | Route ordering, no-auth/OAuth/API key, existing route advanced fields | Existing + pending advanced |
| Profile list/create/show/use/rename/delete; cli/profile-commands.ts | Runtime / profiles | Profile home owner; destructive and active-pointer changes explicit | Desktop selection never implies profile use; scoped lifecycle | Pending |
| Workspace register/select/trust; cli/workspace-commands.ts | Runtime / workspaces | Workspace registry and global directory trust owner | Canonical target/readiness refresh; explicit trust review | Pending |
| Execution settings; setup/docker-execution-setup.ts | Runtime / execution | Existing policy parser, explicit image acquisition | Host/Docker policy and download gates | Pending |
| Gateway install/start/stop/restart/diagnostics; cli/gateway-commands.ts | Runtime strip / gateway details | Existing gateway controls and durable receipts | Available without Telegram; shared Work acknowledgement | Existing + pending entry |
| Python capability inspect/install; cli/python-env-commands.ts | Browser and media dependencies | Registered capability IDs; managed environment owner | Explicit download, cancellation, redacted bounded diagnostics | Pending |
| Browser capability setup/status; setup/browser-diagnostics.ts | Browser & Search | Existing backend/private URL/cloud spend rules | Settings do not implicitly launch or spend | Pending |
| Skills/packs/MCP configuration; cli/skill-commands.ts, cli/pack-commands.ts | Advanced capabilities | Existing registries/install owners; profile scoping | Discovery does not grant authority; no silent install | Pending |
| Memory/Evolution configuration; cli/memory-commands.ts, cli/evolution-commands.ts | Governance / Library | Existing memory and proposal owners | No live promotion via config save; PR14D review UI retained | Pending configuration; PR14D promotion |
| Lifecycle version/status/update/uninstall; cli/update-command.ts, cli/uninstall-command.ts | Runtime diagnostics / lifecycle | Installation ownership and explicit operator action | Unsupported installation owners remain accurately blocked | Pending |
| Schedule enable/create/update/delete/delivery; cron owner | Schedules | Existing scheduler and delivery authorization | Shared host lifetime and schedule editor acceptance | **PR15 pending** |
| Image attachment/analysis and generated output | Work attachments / retained Results | Existing attachment/artifact/runtime tool owners | Bounded image, original content, generated preview/save, cancel | Pending |
| Microphone/transcription and speech playback | Composer / response controls | OS microphone permission; configured STT/TTS; bounded temporary media | Processing disclosure, explicit record/transcribe/play/stop | Pending |

## Field-level inventory

`*` denotes a named record entry and `#` an array entry. Config paths are technical identifiers and stay untranslated; product labels and help are bilingual. All rows use the shared acceptance above. Header/env/credential-bearing values require the private credential path. Aliases are preserved on read and canonicalized only through the corresponding core writer; they do not create duplicate form controls. Unstructured extension values require a registered typed schema, rather than an unrestricted editor.

| Config path | Declared type | Desktop area | Delivery classification |
| --- | --- | --- | --- |
| `execution.backend` | `"host" \| "docker"` | Execution | Pending structured form |
| `execution.imageId` | `string` | Execution | Pending structured form |
| `execution.workspaceAccess.value` | `"read-only" \| "read-write"` | Execution | Pending structured form |
| `execution.workspaceAccess.requirement` | `"mandatory" \| "advisory"` | Execution | Pending structured form |
| `execution.commandNetwork.value` | `"unrestricted" \| "disabled"` | Execution | Pending structured form |
| `execution.commandNetwork.requirement` | `"mandatory" \| "advisory"` | Execution | Pending structured form |
| `execution.credentialCapabilities.value` | `readonly string[]` | Execution | Pending structured form |
| `execution.credentialCapabilities.requirement` | `"mandatory" \| "advisory"` | Execution | Pending structured form |
| `execution.lifetime.value` | `"host" \| "session"` | Execution | Pending structured form |
| `execution.lifetime.requirement` | `"mandatory" \| "advisory"` | Execution | Pending structured form |
| `execution.limits.value.cpu` | `number` | Execution | Pending structured form |
| `execution.limits.value.memoryBytes` | `number` | Execution | Pending structured form |
| `execution.limits.value.pids` | `number` | Execution | Pending structured form |
| `execution.limits.value.outputBytes` | `number` | Execution | Pending structured form |
| `execution.limits.value.timeoutMs` | `number` | Execution | Pending structured form |
| `execution.limits.requirement` | `"mandatory" \| "advisory"` | Execution | Pending structured form |
| `model.provider` | `ProviderId \| undefined` | Models | Pending structured form |
| `model.id` | `string` | Models | Pending structured form |
| `model.contextWindowTokens` | `number` | Models | Pending structured form |
| `model.maxTokens` | `number` | Models | Pending structured form |
| `model.timeoutMs` | `number` | Models | Pending structured form |
| `model.staleTimeoutMs` | `number` | Models | Pending structured form |
| `model.fallbacks.#.provider` | `ProviderId` | Models | Pending structured form |
| `model.fallbacks.#.id` | `string` | Models | Pending structured form |
| `model.fallbacks.#.baseUrl` | `string` | Models | Pending structured form |
| `model.fallbacks.#.apiKeyEnv` | `string` | Models | Pending structured form |
| `model.fallbacks.#.contextWindowTokens` | `number` | Models | Pending structured form |
| `model.fallbacks.#.maxTokens` | `number` | Models | Pending structured form |
| `model.fallbacks.#.timeoutMs` | `number` | Models | Pending structured form |
| `model.fallbacks.#.staleTimeoutMs` | `number` | Models | Pending structured form |
| `modelAliases.*.provider` | `ProviderId` | Models | Pending structured form |
| `modelAliases.*.model` | `string` | Models | Pending structured form |
| `modelAliases.*.baseUrl` | `string` | Models | Pending structured form |
| `modelAliases.*.apiMode` | `string` | Models | Pending structured form |
| `modelAliases.*.apiKeyEnv` | `string` | Models | Pending structured form |
| `modelAliases.*.maxTokens` | `number` | Models | Pending structured form |
| `model_aliases.*.provider` | `ProviderId` | Canonical alias area | Compatibility alias; canonical control |
| `model_aliases.*.model` | `string` | Canonical alias area | Compatibility alias; canonical control |
| `model_aliases.*.baseUrl` | `string` | Canonical alias area | Compatibility alias; canonical control |
| `model_aliases.*.apiMode` | `string` | Canonical alias area | Compatibility alias; canonical control |
| `model_aliases.*.apiKeyEnv` | `string` | Canonical alias area | Compatibility alias; canonical control |
| `model_aliases.*.maxTokens` | `number` | Canonical alias area | Compatibility alias; canonical control |
| `providers.*.kind` | `"openai-compatible" \| "catalog" \| undefined` | Models | Pending structured form |
| `providers.*.baseUrl` | `string` | Models | Pending structured form |
| `providers.*.apiKeyEnv` | `string` | Models | Pending structured form |
| `providers.*.apiMode` | `ProviderApiMode \| undefined` | Models | Pending structured form |
| `providers.*.authMethod` | `ProviderAuthMethod \| undefined` | Models | Pending structured form |
| `providers.*.models` | `string[]` | Models | Pending structured form |
| `providers.*.enableNetwork` | `boolean \| undefined` | Models | Pending structured form |
| `providers.*.timeoutMs` | `number` | Models | Pending structured form |
| `providers.*.staleTimeoutMs` | `number` | Models | Pending structured form |
| `providers.*.headers.*` | `string` | Models | Pending protected credential/reference control |
| `auxiliaryModels.default` | `AuxiliaryModelSlotInput \| undefined` | Models / Vision | Pending structured form |
| `auxiliaryModels.vision` | `AuxiliaryModelSlotInput \| undefined` | Models / Vision | Pending structured form |
| `auxiliaryModels.compression` | `AuxiliaryModelSlotInput \| undefined` | Models / Vision | Pending structured form |
| `auxiliaryModels.assessor` | `AuxiliaryModelSlotInput \| undefined` | Models / Vision | Pending structured form |
| `auxiliaryModels.web_extract` | `AuxiliaryModelSlotInput \| undefined` | Models / Vision | Pending structured form |
| `auxiliaryModels.session_search` | `AuxiliaryModelSlotInput \| undefined` | Models / Vision | Pending structured form |
| `auxiliaryModels.mcp` | `AuxiliaryModelSlotInput \| undefined` | Models / Vision | Pending structured form |
| `auxiliaryModels.memory_flush` | `AuxiliaryModelSlotInput \| undefined` | Models / Vision | Pending structured form |
| `auxiliaryModels.delegation` | `AuxiliaryModelSlotInput \| undefined` | Models / Vision | Pending structured form |
| `auxiliaryModels.skills_library` | `AuxiliaryModelSlotInput \| undefined` | Models / Vision | Pending structured form |
| `auxiliaryModels.title_generation` | `AuxiliaryModelSlotInput \| undefined` | Models / Vision | Pending structured form |
| `auxiliaryModels.curator` | `AuxiliaryModelSlotInput \| undefined` | Models / Vision | Pending structured form |
| `auxiliaryModels.memory_compaction` | `AuxiliaryModelSlotInput \| undefined` | Models / Vision | Pending structured form |
| `auxiliaryModels.profile_context` | `AuxiliaryModelSlotInput \| undefined` | Models / Vision | Pending structured form |
| `web.enableNetwork` | `boolean \| undefined` | Browser & Search | Pending structured form |
| `web.maxContentChars` | `number` | Browser & Search | Pending structured form |
| `web.backend` | `string` | Browser & Search | Pending structured form |
| `web.searchBackend` | `string` | Browser & Search | Pending structured form |
| `web.extractBackend` | `string` | Browser & Search | Pending structured form |
| `web.crawlBackend` | `string` | Browser & Search | Pending structured form |
| `web.brave.apiKeyEnv` | `string` | Browser & Search | Pending structured form |
| `memory.retrieval.enabled` | `boolean \| undefined` | Governance | Pending structured form |
| `memory.retrieval.mode` | `"lexical"` | Governance | Pending structured form |
| `memory.retrieval.maxResults` | `number` | Governance | Pending structured form |
| `memory.retrieval.maxChars` | `number` | Governance | Pending structured form |
| `memory.index.enabled` | `boolean \| undefined` | Governance | Pending structured form |
| `memory.index.backfillOnStartup` | `MemoryIndexBackfillOnStartup \| undefined` | Governance | Pending structured form |
| `memory.index.reindexOnStartup` | `boolean \| undefined` | Governance | Pending structured form |
| `memory.index.vacuumIntervalDays` | `number` | Governance | Pending structured form |
| `memory.curation.mode` | `MemoryCurationMode \| undefined` | Governance | Pending structured form |
| `memory.curation.checkpointEveryTurns` | `number` | Governance | Pending structured form |
| `memory.curation.auditOnCompact` | `boolean \| undefined` | Governance | Pending structured form |
| `memory.curation.auditOnHandoff` | `boolean \| undefined` | Governance | Pending structured form |
| `memory.curation.auditOnRuntimeDispose` | `boolean \| undefined` | Governance | Pending structured form |
| `memory.curation.runtimeDisposeMinNewMessages` | `number` | Governance | Pending structured form |
| `memory.curation.runtimeDisposeMinIntervalMinutes` | `number` | Governance | Pending structured form |
| `memory.curation.autoApplyMaxRisk` | `MemoryAutoApplyRisk \| undefined` | Governance | Pending structured form |
| `memory.curation.autoApplyMinConfidence` | `number` | Governance | Pending structured form |
| `memory.curation.autoWriteVisibility` | `MemoryAutoWriteVisibility \| undefined` | Governance | Pending structured form |
| `compression.enabled` | `boolean \| undefined` | Governance | Pending structured form |
| `compression.threshold` | `number` | Governance | Pending structured form |
| `compression.targetRatio` | `number` | Governance | Pending structured form |
| `compression.protectFirstN` | `number` | Governance | Pending structured form |
| `compression.protectLastN` | `number` | Governance | Pending structured form |
| `compression.summaryModelContextLength` | `number` | Governance | Pending structured form |
| `compression.experimental` | `boolean \| undefined` | Governance | Pending structured form |
| `externalMemory.enabled` | `boolean \| undefined` | Governance | Pending structured form |
| `externalMemory.provider` | `string` | Governance | Pending structured form |
| `externalMemory.timeoutMs` | `number` | Governance | Pending structured form |
| `externalMemory.maxResults` | `number` | Governance | Pending structured form |
| `externalMemory.maxChars` | `number` | Governance | Pending structured form |
| `externalMemory.mirrorWrites` | `boolean \| undefined` | Governance | Pending structured form |
| `externalMemory.credentials.*` | `unknown` | Governance | Pending protected credential/reference control |
| `externalMemory.file.path` | `string` | Governance | Pending structured form |
| `externalMemory.file.maxEntries` | `number` | Governance | Pending structured form |
| `external_memory.enabled` | `boolean \| undefined` | Canonical alias area | Compatibility alias; canonical control |
| `external_memory.provider` | `string` | Canonical alias area | Compatibility alias; canonical control |
| `external_memory.timeoutMs` | `number` | Canonical alias area | Compatibility alias; canonical control |
| `external_memory.maxResults` | `number` | Canonical alias area | Compatibility alias; canonical control |
| `external_memory.maxChars` | `number` | Canonical alias area | Compatibility alias; canonical control |
| `external_memory.mirrorWrites` | `boolean \| undefined` | Canonical alias area | Compatibility alias; canonical control |
| `external_memory.credentials.*` | `unknown` | Canonical alias area | Pending protected credential/reference control |
| `external_memory.file.path` | `string` | Canonical alias area | Compatibility alias; canonical control |
| `external_memory.file.maxEntries` | `number` | Canonical alias area | Compatibility alias; canonical control |
| `delegation.maxSpawnDepth` | `number` | Execution | Pending structured form |
| `delegation.maxConcurrentChildren` | `number` | Execution | Pending structured form |
| `delegation.maxDelegateCallsPerTurn` | `number` | Execution | Pending structured form |
| `delegation.childTimeoutSeconds` | `number` | Execution | Pending structured form |
| `delegation.maxBatchTasks` | `number` | Execution | Pending structured form |
| `delegation.heartbeatSeconds` | `number` | Execution | Pending structured form |
| `delegation.heartbeatStaleCyclesIdle` | `number` | Execution | Pending structured form |
| `delegation.heartbeatStaleCyclesInTool` | `number` | Execution | Pending structured form |
| `delegation.recoverJsonStringTasks` | `boolean \| undefined` | Execution | Pending structured form |
| `delegation.defaultAllowedRiskClasses.#` | `ToolRiskClass` | Execution | Pending structured form |
| `delegation.defaultExcludedToolsets.#` | `ToolsetName` | Execution | Pending structured form |
| `delegation.defaultAllowedToolsets.#` | `ToolsetName` | Execution | Pending structured form |
| `delegation.blockedToolNames` | `string[]` | Execution | Pending structured form |
| `delegation.blockedToolPrefixes` | `string[]` | Execution | Pending structured form |
| `delegation.diagnostics.enabled` | `boolean \| undefined` | Execution | Pending structured form |
| `delegation.diagnostics.includePromptPreview` | `boolean \| undefined` | Execution | Pending structured form |
| `delegation.childRuntime.memoryRecall` | `"disabled" \| "bounded" \| undefined` | Execution | Pending structured form |
| `delegation.childRuntime.skillLearning` | `"disabled"` | Execution | Pending structured form |
| `delegation.childRuntime.sessionCompression` | `"disabled" \| "enabled" \| undefined` | Execution | Pending structured form |
| `delegation.childRuntime.projectContext` | `"disabled" \| "bounded" \| undefined` | Execution | Pending structured form |
| `budgets.task.maxEstimatedCostUsd` | `number` | Governance | Pending structured form |
| `budgets.task.warningThresholdPercent` | `number` | Governance | Pending structured form |
| `budgets.session.maxEstimatedCostUsd` | `number` | Governance | Pending structured form |
| `budgets.session.warningThresholdPercent` | `number` | Governance | Pending structured form |
| `browser.backend` | `BrowserBackendKind \| undefined` | Browser & Search | Pending structured form |
| `browser.cloudProvider` | `BrowserCloudProviderKind \| undefined` | Browser & Search | Pending structured form |
| `browser.cdpUrl` | `string` | Browser & Search | Pending structured form |
| `browser.launchCommand` | `string` | Browser & Search | Pending structured form |
| `browser.launchExecutable` | `string` | Browser & Search | Pending structured form |
| `browser.launchArgs` | `string[]` | Browser & Search | Pending structured form |
| `browser.autoLaunch` | `boolean \| undefined` | Browser & Search | Pending structured form |
| `browser.headless` | `boolean \| undefined` | Browser & Search | Pending structured form |
| `browser.supervised` | `boolean \| undefined` | Browser & Search | Pending structured form |
| `browser.chromeFlags` | `string[]` | Browser & Search | Pending structured form |
| `browser.engine` | `BrowserEngineKind \| undefined` | Browser & Search | Pending structured form |
| `browser.commandTimeout` | `number` | Browser & Search | Pending structured form |
| `browser.inactivityTimeout` | `number` | Browser & Search | Pending structured form |
| `browser.recordSessions` | `boolean \| undefined` | Browser & Search | Pending structured form |
| `browser.hybridRouting` | `boolean \| undefined` | Browser & Search | Pending structured form |
| `browser.cloudFallback` | `boolean \| undefined` | Browser & Search | Pending structured form |
| `browser.cloudSpendApproved` | `BrowserCloudSpendApproval \| undefined` | Browser & Search | Pending structured form |
| `browser.summarizeSnapshots` | `BrowserSnapshotSummarizeMode \| undefined` | Browser & Search | Pending structured form |
| `browser.snapshotSummarizeThreshold` | `number` | Browser & Search | Pending structured form |
| `browser.allowPrivateUrls` | `string \| boolean \| undefined` | Browser & Search | Pending structured form |
| `imageGen.provider` | `ImageGenerationProvider \| undefined` | Vision & Images | Pending structured form |
| `imageGen.model` | `string` | Vision & Images | Pending structured form |
| `imageGen.useGateway` | `boolean \| undefined` | Vision & Images | Pending structured form |
| `imageGen.use_gateway` | `boolean \| undefined` | Vision & Images | Compatibility alias; canonical control |
| `imageGen.apiKeyEnv` | `string` | Vision & Images | Pending structured form |
| `imageGen.api_key_env` | `string` | Vision & Images | Compatibility alias; canonical control |
| `imageGen.baseUrl` | `string` | Vision & Images | Pending structured form |
| `imageGen.base_url` | `string` | Vision & Images | Compatibility alias; canonical control |
| `imageGen.fal.model` | `string` | Vision & Images | Pending structured form |
| `imageGen.fal.apiKeyEnv` | `string` | Vision & Images | Pending structured form |
| `imageGen.fal.api_key_env` | `string` | Vision & Images | Compatibility alias; canonical control |
| `imageGen.fal.baseUrl` | `string` | Vision & Images | Pending structured form |
| `imageGen.fal.base_url` | `string` | Vision & Images | Compatibility alias; canonical control |
| `imageGen.byteplus.model` | `string` | Vision & Images | Pending structured form |
| `imageGen.byteplus.apiKeyEnv` | `string` | Vision & Images | Pending structured form |
| `imageGen.byteplus.api_key_env` | `string` | Vision & Images | Compatibility alias; canonical control |
| `imageGen.byteplus.baseUrl` | `string` | Vision & Images | Pending structured form |
| `imageGen.byteplus.base_url` | `string` | Vision & Images | Compatibility alias; canonical control |
| `imageGen.openai.model` | `string` | Vision & Images | Pending structured form |
| `imageGen.openai.apiKeyEnv` | `string` | Vision & Images | Pending structured form |
| `imageGen.openai.api_key_env` | `string` | Vision & Images | Compatibility alias; canonical control |
| `imageGen.openai.baseUrl` | `string` | Vision & Images | Pending structured form |
| `imageGen.openai.base_url` | `string` | Vision & Images | Compatibility alias; canonical control |
| `image_gen.provider` | `ImageGenerationProvider \| undefined` | Canonical alias area | Compatibility alias; canonical control |
| `image_gen.model` | `string` | Canonical alias area | Compatibility alias; canonical control |
| `image_gen.useGateway` | `boolean \| undefined` | Canonical alias area | Compatibility alias; canonical control |
| `image_gen.use_gateway` | `boolean \| undefined` | Canonical alias area | Compatibility alias; canonical control |
| `image_gen.apiKeyEnv` | `string` | Canonical alias area | Compatibility alias; canonical control |
| `image_gen.api_key_env` | `string` | Canonical alias area | Compatibility alias; canonical control |
| `image_gen.baseUrl` | `string` | Canonical alias area | Compatibility alias; canonical control |
| `image_gen.base_url` | `string` | Canonical alias area | Compatibility alias; canonical control |
| `image_gen.fal.model` | `string` | Canonical alias area | Compatibility alias; canonical control |
| `image_gen.fal.apiKeyEnv` | `string` | Canonical alias area | Compatibility alias; canonical control |
| `image_gen.fal.api_key_env` | `string` | Canonical alias area | Compatibility alias; canonical control |
| `image_gen.fal.baseUrl` | `string` | Canonical alias area | Compatibility alias; canonical control |
| `image_gen.fal.base_url` | `string` | Canonical alias area | Compatibility alias; canonical control |
| `image_gen.byteplus.model` | `string` | Canonical alias area | Compatibility alias; canonical control |
| `image_gen.byteplus.apiKeyEnv` | `string` | Canonical alias area | Compatibility alias; canonical control |
| `image_gen.byteplus.api_key_env` | `string` | Canonical alias area | Compatibility alias; canonical control |
| `image_gen.byteplus.baseUrl` | `string` | Canonical alias area | Compatibility alias; canonical control |
| `image_gen.byteplus.base_url` | `string` | Canonical alias area | Compatibility alias; canonical control |
| `image_gen.openai.model` | `string` | Canonical alias area | Compatibility alias; canonical control |
| `image_gen.openai.apiKeyEnv` | `string` | Canonical alias area | Compatibility alias; canonical control |
| `image_gen.openai.api_key_env` | `string` | Canonical alias area | Compatibility alias; canonical control |
| `image_gen.openai.baseUrl` | `string` | Canonical alias area | Compatibility alias; canonical control |
| `image_gen.openai.base_url` | `string` | Canonical alias area | Compatibility alias; canonical control |
| `gateway.lifecycleNotifications.enabled` | `boolean \| undefined` | Channels / Runtime | Pending structured form |
| `gateway.messageQueue.persistence` | `GatewayMessageQueuePersistence \| undefined` | Channels / Runtime | Pending structured form |
| `gateway.messageQueue.maxPendingPerProfile` | `number` | Channels / Runtime | Pending structured form |
| `gateway.messageQueue.uncertainRetentionDays` | `number` | Channels / Runtime | Pending structured form |
| `tts.provider` | `TtsProvider \| undefined` | Voice | Pending structured form |
| `tts.enabled` | `boolean \| undefined` | Voice | Pending structured form |
| `tts.speed` | `number` | Voice | Pending structured form |
| `tts.edge.voice` | `string` | Voice | Pending structured form |
| `tts.edge.speed` | `number` | Voice | Pending structured form |
| `tts.elevenlabs.voiceId` | `string` | Voice | Pending structured form |
| `tts.elevenlabs.voice_id` | `string` | Voice | Pending structured form |
| `tts.elevenlabs.modelId` | `string` | Voice | Pending structured form |
| `tts.elevenlabs.model_id` | `string` | Voice | Pending structured form |
| `tts.elevenlabs.apiKeyEnv` | `string` | Voice | Pending structured form |
| `tts.elevenlabs.api_key_env` | `string` | Voice | Compatibility alias; canonical control |
| `tts.openai.model` | `string` | Voice | Pending structured form |
| `tts.openai.voice` | `string` | Voice | Pending structured form |
| `tts.openai.baseUrl` | `string` | Voice | Pending structured form |
| `tts.openai.base_url` | `string` | Voice | Compatibility alias; canonical control |
| `tts.openai.speed` | `number` | Voice | Pending structured form |
| `tts.openai.apiKeyEnv` | `string` | Voice | Pending structured form |
| `tts.openai.api_key_env` | `string` | Voice | Compatibility alias; canonical control |
| `tts.minimax.model` | `string` | Voice | Pending structured form |
| `tts.minimax.voiceId` | `string` | Voice | Pending structured form |
| `tts.minimax.voice_id` | `string` | Voice | Pending structured form |
| `tts.minimax.speed` | `number` | Voice | Pending structured form |
| `tts.minimax.vol` | `number` | Voice | Pending structured form |
| `tts.minimax.pitch` | `number` | Voice | Pending structured form |
| `tts.minimax.apiKeyEnv` | `string` | Voice | Pending structured form |
| `tts.minimax.api_key_env` | `string` | Voice | Compatibility alias; canonical control |
| `tts.mistral.model` | `string` | Voice | Pending structured form |
| `tts.mistral.voiceId` | `string` | Voice | Pending structured form |
| `tts.mistral.voice_id` | `string` | Voice | Pending structured form |
| `tts.mistral.apiKeyEnv` | `string` | Voice | Pending structured form |
| `tts.mistral.api_key_env` | `string` | Voice | Compatibility alias; canonical control |
| `tts.gemini.model` | `string` | Voice | Pending structured form |
| `tts.gemini.voice` | `string` | Voice | Pending structured form |
| `tts.gemini.apiKeyEnv` | `string` | Voice | Pending structured form |
| `tts.gemini.api_key_env` | `string` | Voice | Compatibility alias; canonical control |
| `tts.xai.voiceId` | `string` | Voice | Pending structured form |
| `tts.xai.voice_id` | `string` | Voice | Pending structured form |
| `tts.xai.language` | `string` | Voice | Pending structured form |
| `tts.xai.sampleRate` | `number` | Voice | Pending structured form |
| `tts.xai.sample_rate` | `number` | Voice | Pending structured form |
| `tts.xai.bitRate` | `number` | Voice | Pending structured form |
| `tts.xai.bit_rate` | `number` | Voice | Pending structured form |
| `tts.xai.speed` | `number` | Voice | Pending structured form |
| `tts.xai.baseUrl` | `string` | Voice | Pending structured form |
| `tts.xai.base_url` | `string` | Voice | Compatibility alias; canonical control |
| `tts.xai.apiKeyEnv` | `string` | Voice | Pending structured form |
| `tts.xai.api_key_env` | `string` | Voice | Compatibility alias; canonical control |
| `tts.neutts.refAudio` | `string` | Voice | Pending structured form |
| `tts.neutts.ref_audio` | `string` | Voice | Pending structured form |
| `tts.neutts.refText` | `string` | Voice | Pending structured form |
| `tts.neutts.ref_text` | `string` | Voice | Pending structured form |
| `tts.neutts.model` | `string` | Voice | Pending structured form |
| `tts.neutts.device` | `string` | Voice | Pending structured form |
| `tts.kittentts.model` | `string` | Voice | Pending structured form |
| `tts.kittentts.voice` | `string` | Voice | Pending structured form |
| `tts.kittentts.speed` | `number` | Voice | Pending structured form |
| `tts.kittentts.cleanText` | `boolean \| undefined` | Voice | Pending structured form |
| `tts.kittentts.clean_text` | `boolean \| undefined` | Voice | Pending structured form |
| `stt.provider` | `SttProvider \| undefined` | Voice | Pending structured form |
| `stt.enabled` | `boolean \| undefined` | Voice | Pending structured form |
| `stt.local.model` | `string` | Voice | Pending structured form |
| `stt.local.command` | `string` | Voice | Pending structured form |
| `stt.local.engine` | `"command" \| "faster-whisper" \| undefined` | Voice | Pending structured form |
| `stt.local.pythonBinary` | `string` | Voice | Pending structured form |
| `stt.local.python_binary` | `string` | Voice | Pending structured form |
| `stt.local.normalizeWithFfmpeg` | `boolean \| undefined` | Voice | Pending structured form |
| `stt.local.normalize_with_ffmpeg` | `boolean \| undefined` | Voice | Pending structured form |
| `stt.local.ffmpegPath` | `string` | Voice | Pending structured form |
| `stt.local.ffmpeg_path` | `string` | Voice | Pending structured form |
| `stt.local.fasterWhisper.enabled` | `boolean \| undefined` | Voice | Pending structured form |
| `stt.local.fasterWhisper.model` | `string` | Voice | Pending structured form |
| `stt.local.fasterWhisper.device` | `string` | Voice | Pending structured form |
| `stt.local.fasterWhisper.computeType` | `string` | Voice | Pending structured form |
| `stt.local.fasterWhisper.compute_type` | `string` | Voice | Compatibility alias; canonical control |
| `stt.local.fasterWhisper.hfHome` | `string` | Voice | Pending structured form |
| `stt.local.fasterWhisper.hf_home` | `string` | Voice | Compatibility alias; canonical control |
| `stt.local.fasterWhisper.allowModelDownload` | `boolean \| undefined` | Voice | Pending structured form |
| `stt.local.fasterWhisper.allow_model_download` | `boolean \| undefined` | Voice | Compatibility alias; canonical control |
| `stt.local.fasterWhisper.gatewayAllowModelDownload` | `boolean \| undefined` | Voice | Pending structured form |
| `stt.local.fasterWhisper.gateway_allow_model_download` | `boolean \| undefined` | Voice | Compatibility alias; canonical control |
| `stt.local.fasterWhisper.queueDepth` | `number` | Voice | Pending structured form |
| `stt.local.fasterWhisper.queue_depth` | `number` | Voice | Compatibility alias; canonical control |
| `stt.local.fasterWhisper.timeoutMs` | `number` | Voice | Pending structured form |
| `stt.local.fasterWhisper.timeout_ms` | `number` | Voice | Compatibility alias; canonical control |
| `stt.local.fasterWhisper.modelCached` | `boolean \| undefined` | Voice | Generated state; inspect through owner |
| `stt.local.fasterWhisper.model_cached` | `boolean \| undefined` | Voice | Pending structured form |
| `stt.local.faster_whisper.enabled` | `boolean \| undefined` | Voice | Pending structured form |
| `stt.local.faster_whisper.model` | `string` | Voice | Pending structured form |
| `stt.local.faster_whisper.device` | `string` | Voice | Pending structured form |
| `stt.local.faster_whisper.computeType` | `string` | Voice | Pending structured form |
| `stt.local.faster_whisper.compute_type` | `string` | Voice | Compatibility alias; canonical control |
| `stt.local.faster_whisper.hfHome` | `string` | Voice | Pending structured form |
| `stt.local.faster_whisper.hf_home` | `string` | Voice | Compatibility alias; canonical control |
| `stt.local.faster_whisper.allowModelDownload` | `boolean \| undefined` | Voice | Pending structured form |
| `stt.local.faster_whisper.allow_model_download` | `boolean \| undefined` | Voice | Compatibility alias; canonical control |
| `stt.local.faster_whisper.gatewayAllowModelDownload` | `boolean \| undefined` | Voice | Pending structured form |
| `stt.local.faster_whisper.gateway_allow_model_download` | `boolean \| undefined` | Voice | Compatibility alias; canonical control |
| `stt.local.faster_whisper.queueDepth` | `number` | Voice | Pending structured form |
| `stt.local.faster_whisper.queue_depth` | `number` | Voice | Compatibility alias; canonical control |
| `stt.local.faster_whisper.timeoutMs` | `number` | Voice | Pending structured form |
| `stt.local.faster_whisper.timeout_ms` | `number` | Voice | Compatibility alias; canonical control |
| `stt.local.faster_whisper.modelCached` | `boolean \| undefined` | Voice | Generated state; inspect through owner |
| `stt.local.faster_whisper.model_cached` | `boolean \| undefined` | Voice | Pending structured form |
| `stt.groq.model` | `string` | Voice | Pending structured form |
| `stt.groq.apiKeyEnv` | `string` | Voice | Pending structured form |
| `stt.groq.api_key_env` | `string` | Voice | Compatibility alias; canonical control |
| `stt.openai.model` | `string` | Voice | Pending structured form |
| `stt.openai.apiKeyEnv` | `string` | Voice | Pending structured form |
| `stt.openai.api_key_env` | `string` | Voice | Compatibility alias; canonical control |
| `stt.mistral.model` | `string` | Voice | Pending structured form |
| `stt.mistral.apiKeyEnv` | `string` | Voice | Pending structured form |
| `stt.mistral.api_key_env` | `string` | Voice | Compatibility alias; canonical control |
| `stt.xai.baseUrl` | `string` | Voice | Pending structured form |
| `stt.xai.base_url` | `string` | Voice | Compatibility alias; canonical control |
| `stt.xai.apiKeyEnv` | `string` | Voice | Pending structured form |
| `stt.xai.api_key_env` | `string` | Voice | Compatibility alias; canonical control |
| `stt.xai.language` | `string` | Voice | Pending structured form |
| `stt.xai.format` | `string` | Voice | Pending structured form |
| `stt.xai.diarize` | `boolean \| undefined` | Voice | Pending structured form |
| `stt.xai.diarization` | `boolean \| undefined` | Voice | Pending structured form |
| `stt.xai.keyterms` | `string[]` | Voice | Pending structured form |
| `stt.xai.key_terms` | `string[]` | Voice | Pending structured form |
| `stt.xai.fillerWords` | `boolean \| undefined` | Voice | Pending structured form |
| `stt.xai.filler_words` | `boolean \| undefined` | Voice | Pending structured form |
| `stt.xai.rawAudioHints` | `boolean \| undefined` | Voice | Pending structured form |
| `stt.xai.raw_audio_hints` | `boolean \| undefined` | Voice | Pending structured form |
| `voice.autoTts` | `boolean \| undefined` | Voice | Pending structured form |
| `voice.autoTtsMaxCharsPerReply` | `number` | Voice | Pending structured form |
| `voice.autoTtsMaxCharsPerHourPerChat` | `number` | Voice | Pending structured form |
| `mcpServers.*.enabled` | `boolean \| undefined` | Capabilities | Pending structured form |
| `mcpServers.*.transport` | `MCPServerTransport \| undefined` | Capabilities | Pending structured form |
| `mcpServers.*.command` | `string` | Capabilities | Pending structured form |
| `mcpServers.*.args` | `string[]` | Capabilities | Pending structured form |
| `mcpServers.*.cwd` | `string` | Capabilities | Pending structured form |
| `mcpServers.*.env.*` | `string` | Capabilities | Pending protected credential/reference control |
| `mcpServers.*.envRefs.*` | `string` | Capabilities | Pending structured form |
| `mcpServers.*.url` | `string` | Capabilities | Pending structured form |
| `mcpServers.*.headers.*` | `string` | Capabilities | Pending protected credential/reference control |
| `mcpServers.*.tools.include` | `string[]` | Capabilities | Pending structured form |
| `mcpServers.*.tools.exclude` | `string[]` | Capabilities | Pending structured form |
| `mcpServers.*.tools.resources` | `boolean \| undefined` | Capabilities | Pending structured form |
| `mcpServers.*.tools.prompts` | `boolean \| undefined` | Capabilities | Pending structured form |
| `mcpServers.*.tools.prefix` | `string \| boolean \| undefined` | Capabilities | Pending structured form |
| `mcpServers.*.includeTools` | `string[]` | Capabilities | Pending structured form |
| `mcpServers.*.excludeTools` | `string[]` | Capabilities | Pending structured form |
| `mcpServers.*.exposeResources` | `boolean \| undefined` | Capabilities | Pending structured form |
| `mcpServers.*.exposePrompts` | `boolean \| undefined` | Capabilities | Pending structured form |
| `mcpServers.*.toolPrefix` | `string \| boolean \| undefined` | Capabilities | Pending structured form |
| `mcpServers.*.timeoutMs` | `number` | Capabilities | Pending structured form |
| `mcpServers.*.connectTimeoutMs` | `number` | Capabilities | Pending structured form |
| `mcpServers.*.trust` | `MCPServerTrust \| undefined` | Capabilities | Pending structured form |
| `mcpServers.*.toolRiskClass` | `ToolRiskClass \| undefined` | Capabilities | Pending structured form |
| `mcpServers.*.toolRiskClasses.*` | `ToolRiskClass` | Capabilities | Pending structured form |
| `mcpServers.*.protectedToolArguments.*.paths` | `string[]` | Capabilities | Pending structured form |
| `mcpServers.*.protectedToolArguments.*.handling.persistence` | `"none" \| "destination-managed" \| "unknown"` | Capabilities | Pending structured form |
| `mcpServers.*.protectedToolArguments.*.handling.sharing` | `"unknown" \| "private" \| "workspace" \| "account" \| "external"` | Capabilities | Pending structured form |
| `mcpServers.*.protectedToolArguments.*.groupedDelivery` | `boolean \| undefined` | Capabilities | Pending structured form |
| `mcpServers.*.protectedToolArguments.*.browserRelay` | `boolean \| undefined` | Capabilities | Pending structured form |
| `mcpServers.*.artifactToolArguments.*.typeMapping.argument` | `string` | Capabilities | Pending structured form |
| `mcpServers.*.artifactToolArguments.*.typeMapping.values.*` | `string` | Capabilities | Pending structured form |
| `mcpServers.*.artifactToolArguments.*.paths` | `string[]` | Capabilities | Pending structured form |
| `mcpServers.*.artifactToolArguments.*.allowedMimeTypes` | `string[]` | Capabilities | Pending structured form |
| `mcpServers.*.artifactToolArguments.*.maxBytes` | `number` | Capabilities | Pending structured form |
| `mcpServers.*.redactedToolResultPaths.*` | `string[]` | Capabilities | Pending structured form |
| `mcpServers.*.continuityToolResultPaths.*` | `string[]` | Capabilities | Pending structured form |
| `mcpServers.*.toolVerificationRelationships.*` | `string[]` | Capabilities | Pending structured form |
| `mcpServers.*.resourceReadRiskClass` | `ToolRiskClass \| undefined` | Capabilities | Pending structured form |
| `mcpServers.*.promptGetRiskClass` | `ToolRiskClass \| undefined` | Capabilities | Pending structured form |
| `mcp_servers.*.enabled` | `boolean \| undefined` | Canonical alias area | Compatibility alias; canonical control |
| `mcp_servers.*.transport` | `MCPServerTransport \| undefined` | Canonical alias area | Compatibility alias; canonical control |
| `mcp_servers.*.command` | `string` | Canonical alias area | Compatibility alias; canonical control |
| `mcp_servers.*.args` | `string[]` | Canonical alias area | Compatibility alias; canonical control |
| `mcp_servers.*.cwd` | `string` | Canonical alias area | Compatibility alias; canonical control |
| `mcp_servers.*.env.*` | `string` | Canonical alias area | Pending protected credential/reference control |
| `mcp_servers.*.envRefs.*` | `string` | Canonical alias area | Compatibility alias; canonical control |
| `mcp_servers.*.url` | `string` | Canonical alias area | Compatibility alias; canonical control |
| `mcp_servers.*.headers.*` | `string` | Canonical alias area | Pending protected credential/reference control |
| `mcp_servers.*.tools.include` | `string[]` | Canonical alias area | Compatibility alias; canonical control |
| `mcp_servers.*.tools.exclude` | `string[]` | Canonical alias area | Compatibility alias; canonical control |
| `mcp_servers.*.tools.resources` | `boolean \| undefined` | Canonical alias area | Compatibility alias; canonical control |
| `mcp_servers.*.tools.prompts` | `boolean \| undefined` | Canonical alias area | Compatibility alias; canonical control |
| `mcp_servers.*.tools.prefix` | `string \| boolean \| undefined` | Canonical alias area | Compatibility alias; canonical control |
| `mcp_servers.*.includeTools` | `string[]` | Canonical alias area | Compatibility alias; canonical control |
| `mcp_servers.*.excludeTools` | `string[]` | Canonical alias area | Compatibility alias; canonical control |
| `mcp_servers.*.exposeResources` | `boolean \| undefined` | Canonical alias area | Compatibility alias; canonical control |
| `mcp_servers.*.exposePrompts` | `boolean \| undefined` | Canonical alias area | Compatibility alias; canonical control |
| `mcp_servers.*.toolPrefix` | `string \| boolean \| undefined` | Canonical alias area | Compatibility alias; canonical control |
| `mcp_servers.*.timeoutMs` | `number` | Canonical alias area | Compatibility alias; canonical control |
| `mcp_servers.*.connectTimeoutMs` | `number` | Canonical alias area | Compatibility alias; canonical control |
| `mcp_servers.*.trust` | `MCPServerTrust \| undefined` | Canonical alias area | Compatibility alias; canonical control |
| `mcp_servers.*.toolRiskClass` | `ToolRiskClass \| undefined` | Canonical alias area | Compatibility alias; canonical control |
| `mcp_servers.*.toolRiskClasses.*` | `ToolRiskClass` | Canonical alias area | Compatibility alias; canonical control |
| `mcp_servers.*.protectedToolArguments.*.paths` | `string[]` | Canonical alias area | Compatibility alias; canonical control |
| `mcp_servers.*.protectedToolArguments.*.handling.persistence` | `"none" \| "destination-managed" \| "unknown"` | Canonical alias area | Compatibility alias; canonical control |
| `mcp_servers.*.protectedToolArguments.*.handling.sharing` | `"unknown" \| "private" \| "workspace" \| "account" \| "external"` | Canonical alias area | Compatibility alias; canonical control |
| `mcp_servers.*.protectedToolArguments.*.groupedDelivery` | `boolean \| undefined` | Canonical alias area | Compatibility alias; canonical control |
| `mcp_servers.*.protectedToolArguments.*.browserRelay` | `boolean \| undefined` | Canonical alias area | Compatibility alias; canonical control |
| `mcp_servers.*.artifactToolArguments.*.typeMapping.argument` | `string` | Canonical alias area | Compatibility alias; canonical control |
| `mcp_servers.*.artifactToolArguments.*.typeMapping.values.*` | `string` | Canonical alias area | Compatibility alias; canonical control |
| `mcp_servers.*.artifactToolArguments.*.paths` | `string[]` | Canonical alias area | Compatibility alias; canonical control |
| `mcp_servers.*.artifactToolArguments.*.allowedMimeTypes` | `string[]` | Canonical alias area | Compatibility alias; canonical control |
| `mcp_servers.*.artifactToolArguments.*.maxBytes` | `number` | Canonical alias area | Compatibility alias; canonical control |
| `mcp_servers.*.redactedToolResultPaths.*` | `string[]` | Canonical alias area | Compatibility alias; canonical control |
| `mcp_servers.*.continuityToolResultPaths.*` | `string[]` | Canonical alias area | Compatibility alias; canonical control |
| `mcp_servers.*.toolVerificationRelationships.*` | `string[]` | Canonical alias area | Compatibility alias; canonical control |
| `mcp_servers.*.resourceReadRiskClass` | `ToolRiskClass \| undefined` | Canonical alias area | Compatibility alias; canonical control |
| `mcp_servers.*.promptGetRiskClass` | `ToolRiskClass \| undefined` | Canonical alias area | Compatibility alias; canonical control |
| `skills.externalDirs` | `string[]` | Capabilities / Evolution | Pending structured form |
| `skills.autonomy` | `SkillAutonomy \| undefined` | Capabilities / Evolution | Pending structured form |
| `skills.config.*.*` | `unknown` | Capabilities / Evolution | Pending typed extension schema; no arbitrary JSON |
| `ui.language` | `UiLanguage \| undefined` | Runtime language | Pending structured form |
| `ui.flavor` | `UiFlavor \| undefined` | Runtime language | Pending structured form |
| `ui.activityLabels` | `ActivityLabelsLocale \| undefined` | Runtime language | Pending structured form |
| `ui.showResponseProgress` | `boolean \| undefined` | Runtime language | Pending structured form |
| `profile.mode` | `AgentProfileMode \| undefined` | Runtime profile | Pending structured form |
| `profile.responseLanguage` | `AgentResponseLanguage \| undefined` | Runtime profile | Pending structured form |
| `security.approvalMode` | `"off" \| "manual" \| SecurityApprovalMode \| "smart" \| undefined` | Governance | Pending structured form |
| `security.allowPrivateUrls` | `string \| boolean \| undefined` | Governance | Pending structured form |
| `security.websiteBlocklist.domains` | `string[]` | Governance | Pending structured form |
| `security.websiteBlocklist.sharedFiles` | `string[]` | Governance | Pending structured form |
| `security.assessor.enabled` | `boolean \| undefined` | Governance | Pending structured form |
| `security.assessor.provider` | `ProviderId \| undefined` | Governance | Pending structured form |
| `security.assessor.model` | `string` | Governance | Pending structured form |
| `security.assessor.timeoutMs` | `number` | Governance | Pending structured form |
| `security.approvals.mode` | `"off" \| "manual" \| SecurityApprovalMode \| "smart" \| undefined` | Governance | Pending structured form |
| `channels.telegram.enabled` | `boolean \| undefined` | Channels | Pending structured form |
| `channels.telegram.botTokenEnv` | `string` | Channels | Pending structured form |
| `channels.telegram.defaultChatId` | `string` | Channels | Pending structured form |
| `channels.telegram.allowedUserIds` | `string[]` | Channels | Pending structured form |
| `channels.telegram.allowedChatIds` | `string[]` | Channels | Pending structured form |
| `channels.telegram.groupSessionsPerUser` | `boolean \| undefined` | Channels | Pending structured form |
| `channels.telegram.threadSessionsPerUser` | `boolean \| undefined` | Channels | Pending structured form |
| `channels.telegram.sessionResetPolicy` | `"none" \| "idle" \| "daily" \| "both" \| undefined` | Channels | Pending structured form |
| `channels.telegram.sessionIdleResetMinutes` | `number` | Channels | Pending structured form |
| `channels.telegram.pollTimeoutSeconds` | `number` | Channels | Pending structured form |
| `channels.telegram.maxAttachmentBytes` | `number` | Channels | Pending structured form |
| `channels.telegram.busyPolicy` | `ChannelBusyPolicy \| undefined` | Channels | Pending structured form |
| `channels.telegram.queueDepth` | `number` | Channels | Pending structured form |
| `channels.telegram.busyTextCoalescing.enabled` | `boolean \| undefined` | Channels | Pending structured form |
| `channels.telegram.busyTextCoalescing.windowMs` | `number` | Channels | Pending structured form |
| `channels.telegram.busyTextCoalescing.maxMessages` | `number` | Channels | Pending structured form |
| `channels.telegram.busyTextCoalescing.maxChars` | `number` | Channels | Pending structured form |
| `channels.telegram.textDebounceMs` | `number` | Channels | Pending structured form |
| `channels.telegram.textDebounceMaxMessages` | `number` | Channels | Pending structured form |
| `channels.telegram.textDebounceMaxChars` | `number` | Channels | Pending structured form |
| `channels.telegram.secureInputMode` | `TelegramSecureInputMode \| undefined` | Channels | Pending structured form |
| `channels.telegram.streaming.enabled` | `boolean \| undefined` | Channels | Pending structured form |
| `channels.telegram.streaming.editIntervalMs` | `number` | Channels | Pending structured form |
| `channels.telegram.streaming.minInitialChars` | `number` | Channels | Pending structured form |
| `channels.telegram.streaming.cursor` | `string` | Channels | Pending structured form |
| `channels.telegram.streaming.maxFloodStrikes` | `number` | Channels | Pending structured form |
| `channels.telegram.streaming.cleanupFailedAttempts` | `boolean \| undefined` | Channels | Pending structured form |
| `channels.telegram.streaming.freshFinalAfterSeconds` | `number` | Channels | Pending structured form |
| `channels.telegram.streaming.transport` | `"auto" \| "edit" \| "draft" \| undefined` | Channels | Pending structured form |
| `channels.telegram.pairing.code` | `string` | Channels | Generated state; inspect through owner |
| `channels.telegram.pairing.createdAt` | `string` | Channels | Generated state; inspect through owner |
| `channels.telegram.pairing.expiresAt` | `string` | Channels | Generated state; inspect through owner |
| `channels.discord.enabled` | `boolean \| undefined` | Channels | Pending structured form |
| `channels.discord.botTokenEnv` | `string` | Channels | Pending structured form |
| `channels.discord.allowedUsers` | `string[]` | Channels | Pending structured form |
| `channels.discord.allowedGuilds` | `string[]` | Channels | Pending structured form |
| `channels.discord.allowedChannels` | `string[]` | Channels | Pending structured form |
| `channels.discord.freeResponseChannels` | `string[]` | Channels | Pending structured form |
| `channels.discord.voiceChannel.enabled` | `boolean \| undefined` | Channels | Pending structured form |
| `channels.discord.voiceChannel.autoJoinOnCommand` | `boolean \| undefined` | Channels | Pending structured form |
| `channels.discord.busyPolicy` | `ChannelBusyPolicy \| undefined` | Channels | Pending structured form |
| `channels.discord.queueDepth` | `number` | Channels | Pending structured form |
| `channels.discord.busyTextCoalescing.enabled` | `boolean \| undefined` | Channels | Pending structured form |
| `channels.discord.busyTextCoalescing.windowMs` | `number` | Channels | Pending structured form |
| `channels.discord.busyTextCoalescing.maxMessages` | `number` | Channels | Pending structured form |
| `channels.discord.busyTextCoalescing.maxChars` | `number` | Channels | Pending structured form |
| `channels.email.enabled` | `boolean \| undefined` | Channels | Pending structured form |
| `channels.email.imapHost` | `string` | Channels | Pending structured form |
| `channels.email.imapPort` | `number` | Channels | Pending structured form |
| `channels.email.smtpHost` | `string` | Channels | Pending structured form |
| `channels.email.smtpPort` | `number` | Channels | Pending structured form |
| `channels.email.username` | `string` | Channels | Pending structured form |
| `channels.email.passwordEnv` | `string` | Channels | Pending structured form |
| `channels.email.ownAddress` | `string` | Channels | Pending structured form |
| `channels.email.homeAddress` | `string` | Channels | Pending structured form |
| `channels.email.allowedSenders` | `string[]` | Channels | Pending structured form |
| `channels.email.allowAllUsers` | `boolean \| undefined` | Channels | Pending structured form |
| `channels.email.pollIntervalSeconds` | `number` | Channels | Pending structured form |
| `channels.email.maxAttachmentBytes` | `number` | Channels | Pending structured form |
| `channels.email.busyPolicy` | `ChannelBusyPolicy \| undefined` | Channels | Pending structured form |
| `channels.email.queueDepth` | `number` | Channels | Pending structured form |
| `channels.email.busyTextCoalescing.enabled` | `boolean \| undefined` | Channels | Pending structured form |
| `channels.email.busyTextCoalescing.windowMs` | `number` | Channels | Pending structured form |
| `channels.email.busyTextCoalescing.maxMessages` | `number` | Channels | Pending structured form |
| `channels.email.busyTextCoalescing.maxChars` | `number` | Channels | Pending structured form |
| `channels.whatsapp.enabled` | `boolean \| undefined` | Channels | Pending structured form |
| `channels.whatsapp.experimental` | `boolean \| undefined` | Channels | Pending structured form |
| `channels.whatsapp.authDir` | `string` | Channels | Pending structured form |
| `channels.whatsapp.allowedUsers` | `string[]` | Channels | Pending structured form |
| `channels.whatsapp.allowedGroups` | `string[]` | Channels | Pending structured form |
| `channels.whatsapp.mode` | `WhatsAppChannelMode \| undefined` | Channels | Pending structured form |
| `channels.whatsapp.dmPolicy` | `WhatsAppDmPolicy \| undefined` | Channels | Pending structured form |
| `channels.whatsapp.groupPolicy` | `WhatsAppGroupPolicy \| undefined` | Channels | Pending structured form |
| `channels.whatsapp.requireMention` | `boolean \| undefined` | Channels | Pending structured form |
| `channels.whatsapp.mentionPatterns` | `string[]` | Channels | Pending structured form |
| `channels.whatsapp.freeResponseChats` | `string[]` | Channels | Pending structured form |
| `channels.whatsapp.replyPrefix` | `string` | Channels | Pending structured form |
| `channels.whatsapp.pairingMode` | `"qr"` | Channels | Pending structured form |
| `channels.whatsapp.busyPolicy` | `ChannelBusyPolicy \| undefined` | Channels | Pending structured form |
| `channels.whatsapp.queueDepth` | `number` | Channels | Pending structured form |
| `channels.whatsapp.busyTextCoalescing.enabled` | `boolean \| undefined` | Channels | Pending structured form |
| `channels.whatsapp.busyTextCoalescing.windowMs` | `number` | Channels | Pending structured form |
| `channels.whatsapp.busyTextCoalescing.maxMessages` | `number` | Channels | Pending structured form |
| `channels.whatsapp.busyTextCoalescing.maxChars` | `number` | Channels | Pending structured form |
| `channels.whatsapp.textDebounceMs` | `number` | Channels | Pending structured form |
| `channels.whatsapp.textDebounceMaxMessages` | `number` | Channels | Pending structured form |
| `channels.whatsapp.textDebounceMaxChars` | `number` | Channels | Pending structured form |
