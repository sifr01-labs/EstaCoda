# Desktop PR14B public settings parity inventory

Status: PR14B implementation and acceptance inventory, reconciled 2026-09-13. The settings and media implementation is present, but the full public-parity exit gate remains open for the gaps listed below. All 479 registered controls have individual reviewed persistence round-trip tests; native/live journeys and the action limits below remain separate acceptance gates. Source inspection covers `EstaCodaConfig` in `src/config/runtime-config.ts`, its public setup input types and writers, `src/setup/setup-editor-actions.ts`, `src/setup/review/apply-executor.ts`, and `src/cli/command-registry.ts`. A type declaration alone does not establish public support; compatibility aliases and runtime-generated fields are distinguished below.

## Shared acceptance and ownership

Every editable setting uses a bounded typed control, a selected-profile draft, explicit review/apply, the existing profile writer lock and recoverable config/credential transaction. Baseline changes invalidate review. Cancellation before durable commit leaves config and credentials untouched; uncertain commit is reconciled by receipt. Each registered field is exercised through reviewed apply, CLI read/save and Desktop refresh using a valid configured fixture. Separate tests cover canonical and compatibility-alias projection. This proves persistence for the tested values, not every value combination or provider behavior. Prompt-affecting values take effect at supported runtime reconstruction boundaries. No editor accepts arbitrary JSON or shell scripts.

Secret-bearing header/environment settings use protected entry and stored secret references, never plaintext in general renderer IPC. Existing API-key/OAuth/Telegram flows remain owned by their current candidate stores. Downloads, service installation and billable tests require explicit actions separate from read-only configuration verification. macOS is the declared initial Desktop platform; core configuration may describe other runtime backends without claiming Desktop can operate them.

## Actions outside configuration

| Public action/source | Desktop destination | Authority / credentials | Acceptance | State |
| --- | --- | --- | --- | --- |
| Model/provider/fallback/specialist setup; runtime-config.ts and model-setup.ts | Models and advanced model options | Reviewed route plans; private candidate pipe; profile apply | Route ordering, no-auth/OAuth/API key, existing route advanced fields | Implemented route selection/order and indexed advanced fallback controls |
| Profile list/create/show/use/rename/delete; cli/profile-commands.ts | Runtime / profiles | Profile home owner; destructive and active-pointer changes explicit | Desktop selection never implies profile use; scoped lifecycle | Implemented list/select/create/copy/default and reviewed rename/delete of unused inactive profiles; used-profile lifecycle remains a parity limit |
| Workspace register/select/trust; cli/workspace-commands.ts | Runtime / workspaces | Workspace registry and global directory trust owner | Canonical target/readiness refresh; explicit trust review | Implemented registration/selection/trust and reviewed rename/relocate/remove |
| Execution settings; setup/docker-execution-setup.ts | Runtime / execution | Existing policy parser, explicit image acquisition | Host/Docker policy and download gates | Policy controls and explicit bundled Docker image provisioning; local engine required; policy apply remains separate |
| Gateway install/start/stop/restart/diagnostics; cli/gateway-commands.ts | Runtime strip / gateway details | Existing gateway controls and durable receipts | Available without Telegram; shared Work acknowledgement | Implemented independent gateway entry and existing receipts |
| Python capability inspect/install; cli/python-env-commands.ts | Browser and media dependencies | Registered capability IDs; managed environment owner | Explicit download, cancellation, redacted bounded diagnostics | Registered inspect/install implemented; cancel before start, inspect after dispatch |
| Browser capability setup/status; setup/browser-diagnostics.ts | Browser & Search | Existing backend/private URL/cloud spend rules | Settings do not implicitly launch or spend | Structured backend/search/policy controls; no implicit launch or spend |
| Skills/packs/MCP configuration; cli/skill-commands.ts, cli/pack-commands.ts | Advanced capabilities | Existing registries/install owners; profile scoping | Discovery does not grant authority; no silent install | Structured settings and reviewed local pack actions; no marketplace claim |
| Memory/Evolution configuration; cli/memory-commands.ts, cli/evolution-commands.ts | Governance / Library | Existing memory and proposal owners | No live promotion via config save; PR14D review UI retained | Configuration implemented; PR14D promotion remains separate |
| Lifecycle version/status/update/uninstall; cli/update-command.ts, cli/uninstall-command.ts | Runtime diagnostics / lifecycle | Installation ownership and explicit operator action | Unsupported installation owners remain accurately blocked | Read-only installation owner/version status implemented; update/uninstall remain owner-required and an open parity limit |
| Schedule enable/create/update/delete/delivery; cron owner | Schedules | Existing scheduler and delivery authorization | Shared host lifetime and schedule editor acceptance | **PR15 pending** |
| Image attachment/analysis and generated output | Work attachments / retained Results | Existing attachment/artifact/runtime tool owners | Bounded image, original content, generated preview/save, cancel | Implemented bounded Conversation attachments and retained image preview/save |
| Microphone/transcription and speech playback | Composer / response controls | OS microphone permission; configured STT/TTS; bounded temporary media | Processing disclosure, explicit record/transcribe/play/stop | Implemented bounded capture, configured batch tool requests and retained playback |

## Field-level inventory

`*` denotes a named record entry and `#` an array entry. Config paths are technical identifiers and stay untranslated; product labels and help are bilingual. All rows use the shared acceptance above. Header/env/credential-bearing values require the private credential path. Aliases are preserved on read and canonicalized only through the corresponding core writer; they do not create duplicate form controls. Unstructured extension values require a registered typed schema, rather than an unrestricted editor.

| Config path | Declared type | Desktop area | Delivery classification |
| --- | --- | --- | --- |
| `execution.backend` | `"host" \| "docker"` | Execution | Structured reviewed control; individual persistence round-trip coverage |
| `execution.imageId` | `string` | Execution | Structured reviewed control; individual persistence round-trip coverage |
| `execution.workspaceAccess.value` | `"read-only" \| "read-write"` | Execution | Structured reviewed control; individual persistence round-trip coverage |
| `execution.workspaceAccess.requirement` | `"mandatory" \| "advisory"` | Execution | Structured reviewed control; individual persistence round-trip coverage |
| `execution.commandNetwork.value` | `"unrestricted" \| "disabled"` | Execution | Structured reviewed control; individual persistence round-trip coverage |
| `execution.commandNetwork.requirement` | `"mandatory" \| "advisory"` | Execution | Structured reviewed control; individual persistence round-trip coverage |
| `execution.credentialCapabilities.value` | `readonly string[]` | Execution | Structured reviewed control; individual persistence round-trip coverage |
| `execution.credentialCapabilities.requirement` | `"mandatory" \| "advisory"` | Execution | Structured reviewed control; individual persistence round-trip coverage |
| `execution.lifetime.value` | `"host" \| "session"` | Execution | Structured reviewed control; individual persistence round-trip coverage |
| `execution.lifetime.requirement` | `"mandatory" \| "advisory"` | Execution | Structured reviewed control; individual persistence round-trip coverage |
| `execution.limits.value.cpu` | `number` | Execution | Structured reviewed control; individual persistence round-trip coverage |
| `execution.limits.value.memoryBytes` | `number` | Execution | Structured reviewed control; individual persistence round-trip coverage |
| `execution.limits.value.pids` | `number` | Execution | Structured reviewed control; individual persistence round-trip coverage |
| `execution.limits.value.outputBytes` | `number` | Execution | Structured reviewed control; individual persistence round-trip coverage |
| `execution.limits.value.timeoutMs` | `number` | Execution | Structured reviewed control; individual persistence round-trip coverage |
| `execution.limits.requirement` | `"mandatory" \| "advisory"` | Execution | Structured reviewed control; individual persistence round-trip coverage |
| `model.provider` | `ProviderId \| undefined` | Models | Models primary-route editor |
| `model.id` | `string` | Models | Models primary-route editor |
| `model.contextWindowTokens` | `number` | Models | Structured reviewed control; individual persistence round-trip coverage |
| `model.maxTokens` | `number` | Models | Structured reviewed control; individual persistence round-trip coverage |
| `model.timeoutMs` | `number` | Models | Structured reviewed control; individual persistence round-trip coverage |
| `model.staleTimeoutMs` | `number` | Models | Structured reviewed control; individual persistence round-trip coverage |
| `model.fallbacks.#.provider` | `ProviderId` | Models | Models route editor |
| `model.fallbacks.#.id` | `string` | Models | Models route editor |
| `model.fallbacks.#.baseUrl` | `string` | Models | Indexed advanced control for an existing fallback; individual persistence round-trip coverage |
| `model.fallbacks.#.apiKeyEnv` | `string` | Models | Indexed advanced control for an existing fallback; individual persistence round-trip coverage |
| `model.fallbacks.#.contextWindowTokens` | `number` | Models | Indexed advanced control for an existing fallback; individual persistence round-trip coverage |
| `model.fallbacks.#.maxTokens` | `number` | Models | Indexed advanced control for an existing fallback; individual persistence round-trip coverage |
| `model.fallbacks.#.timeoutMs` | `number` | Models | Indexed advanced control for an existing fallback; individual persistence round-trip coverage |
| `model.fallbacks.#.staleTimeoutMs` | `number` | Models | Indexed advanced control for an existing fallback; individual persistence round-trip coverage |
| `modelAliases.*.provider` | `ProviderId` | Models | Structured reviewed control; individual persistence round-trip coverage |
| `modelAliases.*.model` | `string` | Models | Structured reviewed control; individual persistence round-trip coverage |
| `modelAliases.*.baseUrl` | `string` | Models | Structured reviewed control; individual persistence round-trip coverage |
| `modelAliases.*.apiMode` | `string` | Models | Structured reviewed control; individual persistence round-trip coverage |
| `modelAliases.*.apiKeyEnv` | `string` | Models | Protected staged credential/reference control |
| `modelAliases.*.maxTokens` | `number` | Models | Structured reviewed control; individual persistence round-trip coverage |
| `model_aliases.*.provider` | `ProviderId` | Canonical alias area | Compatibility alias/list member; canonical control `modelAliases.*.provider` |
| `model_aliases.*.model` | `string` | Canonical alias area | Compatibility alias/list member; canonical control `modelAliases.*.model` |
| `model_aliases.*.baseUrl` | `string` | Canonical alias area | Compatibility alias/list member; canonical control `modelAliases.*.baseUrl` |
| `model_aliases.*.apiMode` | `string` | Canonical alias area | Compatibility alias/list member; canonical control `modelAliases.*.apiMode` |
| `model_aliases.*.apiKeyEnv` | `string` | Canonical alias area | Compatibility alias/list member; canonical control `modelAliases.*.apiKeyEnv` |
| `model_aliases.*.maxTokens` | `number` | Canonical alias area | Compatibility alias/list member; canonical control `modelAliases.*.maxTokens` |
| `providers.*.kind` | `"openai-compatible" \| "catalog" \| undefined` | Models | Structured reviewed control; individual persistence round-trip coverage |
| `providers.*.baseUrl` | `string` | Models | Structured reviewed control; individual persistence round-trip coverage |
| `providers.*.apiKeyEnv` | `string` | Models | Protected staged credential/reference control |
| `providers.*.apiMode` | `ProviderApiMode \| undefined` | Models | Structured reviewed control; individual persistence round-trip coverage |
| `providers.*.authMethod` | `ProviderAuthMethod \| undefined` | Models | Structured reviewed control; individual persistence round-trip coverage |
| `providers.*.models` | `string[]` | Models | Structured reviewed control; individual persistence round-trip coverage |
| `providers.*.enableNetwork` | `boolean \| undefined` | Models | Structured reviewed control; individual persistence round-trip coverage |
| `providers.*.timeoutMs` | `number` | Models | Structured reviewed control; individual persistence round-trip coverage |
| `providers.*.staleTimeoutMs` | `number` | Models | Structured reviewed control; individual persistence round-trip coverage |
| `providers.*.headers.*` | `string` | Models | Existing plaintext preserved privately; replace through protected headerRefs control |
| `auxiliaryModels.default` | `AuxiliaryModelSlotInput \| undefined` | Models / Vision | Compatibility shorthand; structured child controls write the canonical slot |
| `auxiliaryModels.vision` | `AuxiliaryModelSlotInput \| undefined` | Models / Vision | Compatibility shorthand; structured child controls write the canonical slot |
| `auxiliaryModels.compression` | `AuxiliaryModelSlotInput \| undefined` | Models / Vision | Compatibility shorthand; structured child controls write the canonical slot |
| `auxiliaryModels.assessor` | `AuxiliaryModelSlotInput \| undefined` | Models / Vision | Compatibility shorthand; structured child controls write the canonical slot |
| `auxiliaryModels.web_extract` | `AuxiliaryModelSlotInput \| undefined` | Models / Vision | Compatibility shorthand; structured child controls write the canonical slot |
| `auxiliaryModels.session_search` | `AuxiliaryModelSlotInput \| undefined` | Models / Vision | Compatibility shorthand; structured child controls write the canonical slot |
| `auxiliaryModels.mcp` | `AuxiliaryModelSlotInput \| undefined` | Models / Vision | Compatibility shorthand; structured child controls write the canonical slot |
| `auxiliaryModels.memory_flush` | `AuxiliaryModelSlotInput \| undefined` | Models / Vision | Compatibility shorthand; structured child controls write the canonical slot |
| `auxiliaryModels.delegation` | `AuxiliaryModelSlotInput \| undefined` | Models / Vision | Compatibility shorthand; structured child controls write the canonical slot |
| `auxiliaryModels.skills_library` | `AuxiliaryModelSlotInput \| undefined` | Models / Vision | Compatibility shorthand; structured child controls write the canonical slot |
| `auxiliaryModels.title_generation` | `AuxiliaryModelSlotInput \| undefined` | Models / Vision | Compatibility shorthand; structured child controls write the canonical slot |
| `auxiliaryModels.curator` | `AuxiliaryModelSlotInput \| undefined` | Models / Vision | Compatibility shorthand; structured child controls write the canonical slot |
| `auxiliaryModels.memory_compaction` | `AuxiliaryModelSlotInput \| undefined` | Models / Vision | Compatibility shorthand; structured child controls write the canonical slot |
| `auxiliaryModels.profile_context` | `AuxiliaryModelSlotInput \| undefined` | Models / Vision | Compatibility shorthand; structured child controls write the canonical slot |
| `web.enableNetwork` | `boolean \| undefined` | Browser & Search | Structured reviewed control; individual persistence round-trip coverage |
| `web.maxContentChars` | `number` | Browser & Search | Structured reviewed control; individual persistence round-trip coverage |
| `web.backend` | `string` | Browser & Search | Structured reviewed control; individual persistence round-trip coverage |
| `web.searchBackend` | `string` | Browser & Search | Structured reviewed control; individual persistence round-trip coverage |
| `web.extractBackend` | `string` | Browser & Search | Structured reviewed control; individual persistence round-trip coverage |
| `web.crawlBackend` | `string` | Browser & Search | Structured reviewed control; individual persistence round-trip coverage |
| `web.brave.apiKeyEnv` | `string` | Browser & Search | Protected staged credential/reference control |
| `memory.retrieval.enabled` | `boolean \| undefined` | Governance | Structured reviewed control; individual persistence round-trip coverage |
| `memory.retrieval.mode` | `"lexical"` | Governance | Structured reviewed control; individual persistence round-trip coverage |
| `memory.retrieval.maxResults` | `number` | Governance | Structured reviewed control; individual persistence round-trip coverage |
| `memory.retrieval.maxChars` | `number` | Governance | Structured reviewed control; individual persistence round-trip coverage |
| `memory.index.enabled` | `boolean \| undefined` | Governance | Structured reviewed control; individual persistence round-trip coverage |
| `memory.index.backfillOnStartup` | `MemoryIndexBackfillOnStartup \| undefined` | Governance | Structured reviewed control; individual persistence round-trip coverage |
| `memory.index.reindexOnStartup` | `boolean \| undefined` | Governance | Structured reviewed control; individual persistence round-trip coverage |
| `memory.index.vacuumIntervalDays` | `number` | Governance | Structured reviewed control; individual persistence round-trip coverage |
| `memory.curation.mode` | `MemoryCurationMode \| undefined` | Governance | Structured reviewed control; individual persistence round-trip coverage |
| `memory.curation.checkpointEveryTurns` | `number` | Governance | Structured reviewed control; individual persistence round-trip coverage |
| `memory.curation.auditOnCompact` | `boolean \| undefined` | Governance | Structured reviewed control; individual persistence round-trip coverage |
| `memory.curation.auditOnHandoff` | `boolean \| undefined` | Governance | Structured reviewed control; individual persistence round-trip coverage |
| `memory.curation.auditOnRuntimeDispose` | `boolean \| undefined` | Governance | Structured reviewed control; individual persistence round-trip coverage |
| `memory.curation.runtimeDisposeMinNewMessages` | `number` | Governance | Structured reviewed control; individual persistence round-trip coverage |
| `memory.curation.runtimeDisposeMinIntervalMinutes` | `number` | Governance | Structured reviewed control; individual persistence round-trip coverage |
| `memory.curation.autoApplyMaxRisk` | `MemoryAutoApplyRisk \| undefined` | Governance | Structured reviewed control; individual persistence round-trip coverage |
| `memory.curation.autoApplyMinConfidence` | `number` | Governance | Structured reviewed control; individual persistence round-trip coverage |
| `memory.curation.autoWriteVisibility` | `MemoryAutoWriteVisibility \| undefined` | Governance | Structured reviewed control; individual persistence round-trip coverage |
| `compression.enabled` | `boolean \| undefined` | Governance | Structured reviewed control; individual persistence round-trip coverage |
| `compression.threshold` | `number` | Governance | Structured reviewed control; individual persistence round-trip coverage |
| `compression.targetRatio` | `number` | Governance | Structured reviewed control; individual persistence round-trip coverage |
| `compression.protectFirstN` | `number` | Governance | Structured reviewed control; individual persistence round-trip coverage |
| `compression.protectLastN` | `number` | Governance | Structured reviewed control; individual persistence round-trip coverage |
| `compression.summaryModelContextLength` | `number` | Governance | Structured reviewed control; individual persistence round-trip coverage |
| `compression.experimental` | `boolean \| undefined` | Governance | Structured reviewed control; individual persistence round-trip coverage |
| `externalMemory.enabled` | `boolean \| undefined` | Governance | Structured reviewed control; individual persistence round-trip coverage |
| `externalMemory.provider` | `string` | Governance | Structured reviewed control; individual persistence round-trip coverage |
| `externalMemory.timeoutMs` | `number` | Governance | Structured reviewed control; individual persistence round-trip coverage |
| `externalMemory.maxResults` | `number` | Governance | Structured reviewed control; individual persistence round-trip coverage |
| `externalMemory.maxChars` | `number` | Governance | Structured reviewed control; individual persistence round-trip coverage |
| `externalMemory.mirrorWrites` | `boolean \| undefined` | Governance | Structured reviewed control; individual persistence round-trip coverage |
| `externalMemory.credentials.*` | `unknown` | Governance | Unstructured provider extension; no active credential-requiring external-memory adapter exposed |
| `externalMemory.file.path` | `string` | Governance | Structured reviewed control; individual persistence round-trip coverage |
| `externalMemory.file.maxEntries` | `number` | Governance | Structured reviewed control; individual persistence round-trip coverage |
| `external_memory.enabled` | `boolean \| undefined` | Canonical alias area | Compatibility alias/list member; canonical control `externalMemory.enabled` |
| `external_memory.provider` | `string` | Canonical alias area | Compatibility alias/list member; canonical control `externalMemory.provider` |
| `external_memory.timeoutMs` | `number` | Canonical alias area | Compatibility alias/list member; canonical control `externalMemory.timeoutMs` |
| `external_memory.maxResults` | `number` | Canonical alias area | Compatibility alias/list member; canonical control `externalMemory.maxResults` |
| `external_memory.maxChars` | `number` | Canonical alias area | Compatibility alias/list member; canonical control `externalMemory.maxChars` |
| `external_memory.mirrorWrites` | `boolean \| undefined` | Canonical alias area | Compatibility alias/list member; canonical control `externalMemory.mirrorWrites` |
| `external_memory.credentials.*` | `unknown` | Canonical alias area | Unstructured provider extension; no active credential-requiring external-memory adapter exposed |
| `external_memory.file.path` | `string` | Canonical alias area | Compatibility alias/list member; canonical control `externalMemory.file.path` |
| `external_memory.file.maxEntries` | `number` | Canonical alias area | Compatibility alias/list member; canonical control `externalMemory.file.maxEntries` |
| `delegation.maxSpawnDepth` | `number` | Execution | Structured reviewed control; individual persistence round-trip coverage |
| `delegation.maxConcurrentChildren` | `number` | Execution | Structured reviewed control; individual persistence round-trip coverage |
| `delegation.maxDelegateCallsPerTurn` | `number` | Execution | Structured reviewed control; individual persistence round-trip coverage |
| `delegation.childTimeoutSeconds` | `number` | Execution | Structured reviewed control; individual persistence round-trip coverage |
| `delegation.maxBatchTasks` | `number` | Execution | Structured reviewed control; individual persistence round-trip coverage |
| `delegation.heartbeatSeconds` | `number` | Execution | Structured reviewed control; individual persistence round-trip coverage |
| `delegation.heartbeatStaleCyclesIdle` | `number` | Execution | Structured reviewed control; individual persistence round-trip coverage |
| `delegation.heartbeatStaleCyclesInTool` | `number` | Execution | Structured reviewed control; individual persistence round-trip coverage |
| `delegation.recoverJsonStringTasks` | `boolean \| undefined` | Execution | Structured reviewed control; individual persistence round-trip coverage |
| `delegation.defaultAllowedRiskClasses.#` | `ToolRiskClass` | Execution | Compatibility alias/list member; canonical control `delegation.defaultAllowedRiskClasses` |
| `delegation.defaultExcludedToolsets.#` | `ToolsetName` | Execution | Compatibility alias/list member; canonical control `delegation.defaultExcludedToolsets` |
| `delegation.defaultAllowedToolsets.#` | `ToolsetName` | Execution | Compatibility alias/list member; canonical control `delegation.defaultAllowedToolsets` |
| `delegation.blockedToolNames` | `string[]` | Execution | Structured reviewed control; individual persistence round-trip coverage |
| `delegation.blockedToolPrefixes` | `string[]` | Execution | Structured reviewed control; individual persistence round-trip coverage |
| `delegation.diagnostics.enabled` | `boolean \| undefined` | Execution | Structured reviewed control; individual persistence round-trip coverage |
| `delegation.diagnostics.includePromptPreview` | `boolean \| undefined` | Execution | Structured reviewed control; individual persistence round-trip coverage |
| `delegation.childRuntime.memoryRecall` | `"disabled" \| "bounded" \| undefined` | Execution | Structured reviewed control; individual persistence round-trip coverage |
| `delegation.childRuntime.skillLearning` | `"disabled"` | Execution | Structured reviewed control; individual persistence round-trip coverage |
| `delegation.childRuntime.sessionCompression` | `"disabled" \| "enabled" \| undefined` | Execution | Structured reviewed control; individual persistence round-trip coverage |
| `delegation.childRuntime.projectContext` | `"disabled" \| "bounded" \| undefined` | Execution | Structured reviewed control; individual persistence round-trip coverage |
| `budgets.task.maxEstimatedCostUsd` | `number` | Governance | Structured reviewed control; individual persistence round-trip coverage |
| `budgets.task.warningThresholdPercent` | `number` | Governance | Structured reviewed control; individual persistence round-trip coverage |
| `budgets.session.maxEstimatedCostUsd` | `number` | Governance | Structured reviewed control; individual persistence round-trip coverage |
| `budgets.session.warningThresholdPercent` | `number` | Governance | Structured reviewed control; individual persistence round-trip coverage |
| `browser.backend` | `BrowserBackendKind \| undefined` | Browser & Search | Structured reviewed control; individual persistence round-trip coverage |
| `browser.cloudProvider` | `BrowserCloudProviderKind \| undefined` | Browser & Search | Structured reviewed control; individual persistence round-trip coverage |
| `browser.cdpUrl` | `string` | Browser & Search | Structured reviewed control; individual persistence round-trip coverage |
| `browser.launchCommand` | `string` | Browser & Search | Deprecated path-only alias; use launchExecutable and launchArgs |
| `browser.launchExecutable` | `string` | Browser & Search | Structured reviewed control; individual persistence round-trip coverage |
| `browser.launchArgs` | `string[]` | Browser & Search | Structured reviewed control; individual persistence round-trip coverage |
| `browser.autoLaunch` | `boolean \| undefined` | Browser & Search | Structured reviewed control; individual persistence round-trip coverage |
| `browser.headless` | `boolean \| undefined` | Browser & Search | Structured reviewed control; individual persistence round-trip coverage |
| `browser.supervised` | `boolean \| undefined` | Browser & Search | Structured reviewed control; individual persistence round-trip coverage |
| `browser.chromeFlags` | `string[]` | Browser & Search | Structured reviewed control; individual persistence round-trip coverage |
| `browser.engine` | `BrowserEngineKind \| undefined` | Browser & Search | Structured reviewed control; individual persistence round-trip coverage |
| `browser.commandTimeout` | `number` | Browser & Search | Structured reviewed control; individual persistence round-trip coverage |
| `browser.inactivityTimeout` | `number` | Browser & Search | Structured reviewed control; individual persistence round-trip coverage |
| `browser.recordSessions` | `boolean \| undefined` | Browser & Search | Structured reviewed control; individual persistence round-trip coverage |
| `browser.hybridRouting` | `boolean \| undefined` | Browser & Search | Structured reviewed control; individual persistence round-trip coverage |
| `browser.cloudFallback` | `boolean \| undefined` | Browser & Search | Structured reviewed control; individual persistence round-trip coverage |
| `browser.cloudSpendApproved` | `BrowserCloudSpendApproval \| undefined` | Browser & Search | Structured reviewed control; individual persistence round-trip coverage |
| `browser.summarizeSnapshots` | `BrowserSnapshotSummarizeMode \| undefined` | Browser & Search | Structured reviewed control; individual persistence round-trip coverage |
| `browser.snapshotSummarizeThreshold` | `number` | Browser & Search | Structured reviewed control; individual persistence round-trip coverage |
| `browser.allowPrivateUrls` | `string \| boolean \| undefined` | Browser & Search | Structured reviewed control; individual persistence round-trip coverage |
| `imageGen.provider` | `ImageGenerationProvider \| undefined` | Vision & Images | Structured reviewed control; individual persistence round-trip coverage |
| `imageGen.model` | `string` | Vision & Images | Structured reviewed control; individual persistence round-trip coverage |
| `imageGen.useGateway` | `boolean \| undefined` | Vision & Images | Structured reviewed control; individual persistence round-trip coverage |
| `imageGen.use_gateway` | `boolean \| undefined` | Vision & Images | Compatibility alias/list member; canonical control `imageGen.useGateway` |
| `imageGen.apiKeyEnv` | `string` | Vision & Images | Protected staged credential/reference control |
| `imageGen.api_key_env` | `string` | Vision & Images | Compatibility alias/list member; canonical control `imageGen.apiKeyEnv` |
| `imageGen.baseUrl` | `string` | Vision & Images | Structured reviewed control; individual persistence round-trip coverage |
| `imageGen.base_url` | `string` | Vision & Images | Compatibility alias/list member; canonical control `imageGen.baseUrl` |
| `imageGen.fal.model` | `string` | Vision & Images | Structured reviewed control; individual persistence round-trip coverage |
| `imageGen.fal.apiKeyEnv` | `string` | Vision & Images | Protected staged credential/reference control |
| `imageGen.fal.api_key_env` | `string` | Vision & Images | Compatibility alias/list member; canonical control `imageGen.fal.apiKeyEnv` |
| `imageGen.fal.baseUrl` | `string` | Vision & Images | Structured reviewed control; individual persistence round-trip coverage |
| `imageGen.fal.base_url` | `string` | Vision & Images | Compatibility alias/list member; canonical control `imageGen.fal.baseUrl` |
| `imageGen.byteplus.model` | `string` | Vision & Images | Structured reviewed control; individual persistence round-trip coverage |
| `imageGen.byteplus.apiKeyEnv` | `string` | Vision & Images | Protected staged credential/reference control |
| `imageGen.byteplus.api_key_env` | `string` | Vision & Images | Compatibility alias/list member; canonical control `imageGen.byteplus.apiKeyEnv` |
| `imageGen.byteplus.baseUrl` | `string` | Vision & Images | Structured reviewed control; individual persistence round-trip coverage |
| `imageGen.byteplus.base_url` | `string` | Vision & Images | Compatibility alias/list member; canonical control `imageGen.byteplus.baseUrl` |
| `imageGen.openai.model` | `string` | Vision & Images | Structured reviewed control; individual persistence round-trip coverage |
| `imageGen.openai.apiKeyEnv` | `string` | Vision & Images | Protected staged credential/reference control |
| `imageGen.openai.api_key_env` | `string` | Vision & Images | Compatibility alias/list member; canonical control `imageGen.openai.apiKeyEnv` |
| `imageGen.openai.baseUrl` | `string` | Vision & Images | Structured reviewed control; individual persistence round-trip coverage |
| `imageGen.openai.base_url` | `string` | Vision & Images | Compatibility alias/list member; canonical control `imageGen.openai.baseUrl` |
| `image_gen.provider` | `ImageGenerationProvider \| undefined` | Canonical alias area | Compatibility alias/list member; canonical control `imageGen.provider` |
| `image_gen.model` | `string` | Canonical alias area | Compatibility alias/list member; canonical control `imageGen.model` |
| `image_gen.useGateway` | `boolean \| undefined` | Canonical alias area | Compatibility alias/list member; canonical control `imageGen.useGateway` |
| `image_gen.use_gateway` | `boolean \| undefined` | Canonical alias area | Compatibility alias/list member; canonical control `imageGen.useGateway` |
| `image_gen.apiKeyEnv` | `string` | Canonical alias area | Compatibility alias/list member; canonical control `imageGen.apiKeyEnv` |
| `image_gen.api_key_env` | `string` | Canonical alias area | Compatibility alias/list member; canonical control `imageGen.apiKeyEnv` |
| `image_gen.baseUrl` | `string` | Canonical alias area | Compatibility alias/list member; canonical control `imageGen.baseUrl` |
| `image_gen.base_url` | `string` | Canonical alias area | Compatibility alias/list member; canonical control `imageGen.baseUrl` |
| `image_gen.fal.model` | `string` | Canonical alias area | Compatibility alias/list member; canonical control `imageGen.fal.model` |
| `image_gen.fal.apiKeyEnv` | `string` | Canonical alias area | Compatibility alias/list member; canonical control `imageGen.fal.apiKeyEnv` |
| `image_gen.fal.api_key_env` | `string` | Canonical alias area | Compatibility alias/list member; canonical control `imageGen.fal.apiKeyEnv` |
| `image_gen.fal.baseUrl` | `string` | Canonical alias area | Compatibility alias/list member; canonical control `imageGen.fal.baseUrl` |
| `image_gen.fal.base_url` | `string` | Canonical alias area | Compatibility alias/list member; canonical control `imageGen.fal.baseUrl` |
| `image_gen.byteplus.model` | `string` | Canonical alias area | Compatibility alias/list member; canonical control `imageGen.byteplus.model` |
| `image_gen.byteplus.apiKeyEnv` | `string` | Canonical alias area | Compatibility alias/list member; canonical control `imageGen.byteplus.apiKeyEnv` |
| `image_gen.byteplus.api_key_env` | `string` | Canonical alias area | Compatibility alias/list member; canonical control `imageGen.byteplus.apiKeyEnv` |
| `image_gen.byteplus.baseUrl` | `string` | Canonical alias area | Compatibility alias/list member; canonical control `imageGen.byteplus.baseUrl` |
| `image_gen.byteplus.base_url` | `string` | Canonical alias area | Compatibility alias/list member; canonical control `imageGen.byteplus.baseUrl` |
| `image_gen.openai.model` | `string` | Canonical alias area | Compatibility alias/list member; canonical control `imageGen.openai.model` |
| `image_gen.openai.apiKeyEnv` | `string` | Canonical alias area | Compatibility alias/list member; canonical control `imageGen.openai.apiKeyEnv` |
| `image_gen.openai.api_key_env` | `string` | Canonical alias area | Compatibility alias/list member; canonical control `imageGen.openai.apiKeyEnv` |
| `image_gen.openai.baseUrl` | `string` | Canonical alias area | Compatibility alias/list member; canonical control `imageGen.openai.baseUrl` |
| `image_gen.openai.base_url` | `string` | Canonical alias area | Compatibility alias/list member; canonical control `imageGen.openai.baseUrl` |
| `gateway.lifecycleNotifications.enabled` | `boolean \| undefined` | Channels / Runtime | Structured reviewed control; individual persistence round-trip coverage |
| `gateway.messageQueue.persistence` | `GatewayMessageQueuePersistence \| undefined` | Channels / Runtime | Structured reviewed control; individual persistence round-trip coverage |
| `gateway.messageQueue.maxPendingPerProfile` | `number` | Channels / Runtime | Structured reviewed control; individual persistence round-trip coverage |
| `gateway.messageQueue.uncertainRetentionDays` | `number` | Channels / Runtime | Structured reviewed control; individual persistence round-trip coverage |
| `tts.provider` | `TtsProvider \| undefined` | Voice | Structured reviewed control; individual persistence round-trip coverage |
| `tts.enabled` | `boolean \| undefined` | Voice | Structured reviewed control; individual persistence round-trip coverage |
| `tts.speed` | `number` | Voice | Structured reviewed control; individual persistence round-trip coverage |
| `tts.edge.voice` | `string` | Voice | Structured reviewed control; individual persistence round-trip coverage |
| `tts.edge.speed` | `number` | Voice | Structured reviewed control; individual persistence round-trip coverage |
| `tts.elevenlabs.voiceId` | `string` | Voice | Structured reviewed control; individual persistence round-trip coverage |
| `tts.elevenlabs.voice_id` | `string` | Voice | Compatibility alias/list member; canonical control `tts.elevenlabs.voiceId` |
| `tts.elevenlabs.modelId` | `string` | Voice | Structured reviewed control; individual persistence round-trip coverage |
| `tts.elevenlabs.model_id` | `string` | Voice | Compatibility alias/list member; canonical control `tts.elevenlabs.modelId` |
| `tts.elevenlabs.apiKeyEnv` | `string` | Voice | Protected staged credential/reference control |
| `tts.elevenlabs.api_key_env` | `string` | Voice | Compatibility alias/list member; canonical control `tts.elevenlabs.apiKeyEnv` |
| `tts.openai.model` | `string` | Voice | Structured reviewed control; individual persistence round-trip coverage |
| `tts.openai.voice` | `string` | Voice | Structured reviewed control; individual persistence round-trip coverage |
| `tts.openai.baseUrl` | `string` | Voice | Structured reviewed control; individual persistence round-trip coverage |
| `tts.openai.base_url` | `string` | Voice | Compatibility alias/list member; canonical control `tts.openai.baseUrl` |
| `tts.openai.speed` | `number` | Voice | Structured reviewed control; individual persistence round-trip coverage |
| `tts.openai.apiKeyEnv` | `string` | Voice | Protected staged credential/reference control |
| `tts.openai.api_key_env` | `string` | Voice | Compatibility alias/list member; canonical control `tts.openai.apiKeyEnv` |
| `tts.minimax.model` | `string` | Voice | Structured reviewed control; individual persistence round-trip coverage |
| `tts.minimax.voiceId` | `string` | Voice | Structured reviewed control; individual persistence round-trip coverage |
| `tts.minimax.voice_id` | `string` | Voice | Compatibility alias/list member; canonical control `tts.minimax.voiceId` |
| `tts.minimax.speed` | `number` | Voice | Structured reviewed control; individual persistence round-trip coverage |
| `tts.minimax.vol` | `number` | Voice | Structured reviewed control; individual persistence round-trip coverage |
| `tts.minimax.pitch` | `number` | Voice | Structured reviewed control; individual persistence round-trip coverage |
| `tts.minimax.apiKeyEnv` | `string` | Voice | Protected staged credential/reference control |
| `tts.minimax.api_key_env` | `string` | Voice | Compatibility alias/list member; canonical control `tts.minimax.apiKeyEnv` |
| `tts.mistral.model` | `string` | Voice | Structured reviewed control; individual persistence round-trip coverage |
| `tts.mistral.voiceId` | `string` | Voice | Structured reviewed control; individual persistence round-trip coverage |
| `tts.mistral.voice_id` | `string` | Voice | Compatibility alias/list member; canonical control `tts.mistral.voiceId` |
| `tts.mistral.apiKeyEnv` | `string` | Voice | Protected staged credential/reference control |
| `tts.mistral.api_key_env` | `string` | Voice | Compatibility alias/list member; canonical control `tts.mistral.apiKeyEnv` |
| `tts.gemini.model` | `string` | Voice | Structured reviewed control; individual persistence round-trip coverage |
| `tts.gemini.voice` | `string` | Voice | Structured reviewed control; individual persistence round-trip coverage |
| `tts.gemini.apiKeyEnv` | `string` | Voice | Protected staged credential/reference control |
| `tts.gemini.api_key_env` | `string` | Voice | Compatibility alias/list member; canonical control `tts.gemini.apiKeyEnv` |
| `tts.xai.voiceId` | `string` | Voice | Structured reviewed control; individual persistence round-trip coverage |
| `tts.xai.voice_id` | `string` | Voice | Compatibility alias/list member; canonical control `tts.xai.voiceId` |
| `tts.xai.language` | `string` | Voice | Structured reviewed control; individual persistence round-trip coverage |
| `tts.xai.sampleRate` | `number` | Voice | Structured reviewed control; individual persistence round-trip coverage |
| `tts.xai.sample_rate` | `number` | Voice | Compatibility alias/list member; canonical control `tts.xai.sampleRate` |
| `tts.xai.bitRate` | `number` | Voice | Structured reviewed control; individual persistence round-trip coverage |
| `tts.xai.bit_rate` | `number` | Voice | Compatibility alias/list member; canonical control `tts.xai.bitRate` |
| `tts.xai.speed` | `number` | Voice | Structured reviewed control; individual persistence round-trip coverage |
| `tts.xai.baseUrl` | `string` | Voice | Structured reviewed control; individual persistence round-trip coverage |
| `tts.xai.base_url` | `string` | Voice | Compatibility alias/list member; canonical control `tts.xai.baseUrl` |
| `tts.xai.apiKeyEnv` | `string` | Voice | Protected staged credential/reference control |
| `tts.xai.api_key_env` | `string` | Voice | Compatibility alias/list member; canonical control `tts.xai.apiKeyEnv` |
| `tts.neutts.refAudio` | `string` | Voice | Structured reviewed control; individual persistence round-trip coverage |
| `tts.neutts.ref_audio` | `string` | Voice | Compatibility alias/list member; canonical control `tts.neutts.refAudio` |
| `tts.neutts.refText` | `string` | Voice | Structured reviewed control; individual persistence round-trip coverage |
| `tts.neutts.ref_text` | `string` | Voice | Compatibility alias/list member; canonical control `tts.neutts.refText` |
| `tts.neutts.model` | `string` | Voice | Structured reviewed control; individual persistence round-trip coverage |
| `tts.neutts.device` | `string` | Voice | Structured reviewed control; individual persistence round-trip coverage |
| `tts.kittentts.model` | `string` | Voice | Structured reviewed control; individual persistence round-trip coverage |
| `tts.kittentts.voice` | `string` | Voice | Structured reviewed control; individual persistence round-trip coverage |
| `tts.kittentts.speed` | `number` | Voice | Structured reviewed control; individual persistence round-trip coverage |
| `tts.kittentts.cleanText` | `boolean \| undefined` | Voice | Structured reviewed control; individual persistence round-trip coverage |
| `tts.kittentts.clean_text` | `boolean \| undefined` | Voice | Compatibility alias/list member; canonical control `tts.kittentts.cleanText` |
| `stt.provider` | `SttProvider \| undefined` | Voice | Structured reviewed control; individual persistence round-trip coverage |
| `stt.enabled` | `boolean \| undefined` | Voice | Structured reviewed control; individual persistence round-trip coverage |
| `stt.local.model` | `string` | Voice | Structured reviewed control; individual persistence round-trip coverage |
| `stt.local.command` | `string` | Voice | Structured reviewed control; individual persistence round-trip coverage |
| `stt.local.engine` | `"command" \| "faster-whisper" \| undefined` | Voice | Structured reviewed control; individual persistence round-trip coverage |
| `stt.local.pythonBinary` | `string` | Voice | Structured reviewed control; individual persistence round-trip coverage |
| `stt.local.python_binary` | `string` | Voice | Compatibility alias/list member; canonical control `stt.local.pythonBinary` |
| `stt.local.normalizeWithFfmpeg` | `boolean \| undefined` | Voice | Structured reviewed control; individual persistence round-trip coverage |
| `stt.local.normalize_with_ffmpeg` | `boolean \| undefined` | Voice | Compatibility alias/list member; canonical control `stt.local.normalizeWithFfmpeg` |
| `stt.local.ffmpegPath` | `string` | Voice | Structured reviewed control; individual persistence round-trip coverage |
| `stt.local.ffmpeg_path` | `string` | Voice | Compatibility alias/list member; canonical control `stt.local.ffmpegPath` |
| `stt.local.fasterWhisper.enabled` | `boolean \| undefined` | Voice | Structured reviewed control; individual persistence round-trip coverage |
| `stt.local.fasterWhisper.model` | `string` | Voice | Structured reviewed control; individual persistence round-trip coverage |
| `stt.local.fasterWhisper.device` | `string` | Voice | Structured reviewed control; individual persistence round-trip coverage |
| `stt.local.fasterWhisper.computeType` | `string` | Voice | Structured reviewed control; individual persistence round-trip coverage |
| `stt.local.fasterWhisper.compute_type` | `string` | Voice | Compatibility alias/list member; canonical control `stt.local.fasterWhisper.computeType` |
| `stt.local.fasterWhisper.hfHome` | `string` | Voice | Structured reviewed control; individual persistence round-trip coverage |
| `stt.local.fasterWhisper.hf_home` | `string` | Voice | Compatibility alias/list member; canonical control `stt.local.fasterWhisper.hfHome` |
| `stt.local.fasterWhisper.allowModelDownload` | `boolean \| undefined` | Voice | Structured reviewed control; individual persistence round-trip coverage |
| `stt.local.fasterWhisper.allow_model_download` | `boolean \| undefined` | Voice | Compatibility alias/list member; canonical control `stt.local.fasterWhisper.allowModelDownload` |
| `stt.local.fasterWhisper.gatewayAllowModelDownload` | `boolean \| undefined` | Voice | Structured reviewed control; individual persistence round-trip coverage |
| `stt.local.fasterWhisper.gateway_allow_model_download` | `boolean \| undefined` | Voice | Compatibility alias/list member; canonical control `stt.local.fasterWhisper.gatewayAllowModelDownload` |
| `stt.local.fasterWhisper.queueDepth` | `number` | Voice | Structured reviewed control; individual persistence round-trip coverage |
| `stt.local.fasterWhisper.queue_depth` | `number` | Voice | Compatibility alias/list member; canonical control `stt.local.fasterWhisper.queueDepth` |
| `stt.local.fasterWhisper.timeoutMs` | `number` | Voice | Structured reviewed control; individual persistence round-trip coverage |
| `stt.local.fasterWhisper.timeout_ms` | `number` | Voice | Compatibility alias/list member; canonical control `stt.local.fasterWhisper.timeoutMs` |
| `stt.local.fasterWhisper.modelCached` | `boolean \| undefined` | Voice | Compatibility cache hint; dependency inspection reports installed state |
| `stt.local.fasterWhisper.model_cached` | `boolean \| undefined` | Voice | Compatibility cache hint; dependency inspection reports installed state |
| `stt.local.faster_whisper.enabled` | `boolean \| undefined` | Voice | Compatibility alias/list member; canonical control `stt.local.fasterWhisper.enabled` |
| `stt.local.faster_whisper.model` | `string` | Voice | Compatibility alias/list member; canonical control `stt.local.fasterWhisper.model` |
| `stt.local.faster_whisper.device` | `string` | Voice | Compatibility alias/list member; canonical control `stt.local.fasterWhisper.device` |
| `stt.local.faster_whisper.computeType` | `string` | Voice | Compatibility alias/list member; canonical control `stt.local.fasterWhisper.computeType` |
| `stt.local.faster_whisper.compute_type` | `string` | Voice | Compatibility alias/list member; canonical control `stt.local.fasterWhisper.computeType` |
| `stt.local.faster_whisper.hfHome` | `string` | Voice | Compatibility alias/list member; canonical control `stt.local.fasterWhisper.hfHome` |
| `stt.local.faster_whisper.hf_home` | `string` | Voice | Compatibility alias/list member; canonical control `stt.local.fasterWhisper.hfHome` |
| `stt.local.faster_whisper.allowModelDownload` | `boolean \| undefined` | Voice | Compatibility alias/list member; canonical control `stt.local.fasterWhisper.allowModelDownload` |
| `stt.local.faster_whisper.allow_model_download` | `boolean \| undefined` | Voice | Compatibility alias/list member; canonical control `stt.local.fasterWhisper.allowModelDownload` |
| `stt.local.faster_whisper.gatewayAllowModelDownload` | `boolean \| undefined` | Voice | Compatibility alias/list member; canonical control `stt.local.fasterWhisper.gatewayAllowModelDownload` |
| `stt.local.faster_whisper.gateway_allow_model_download` | `boolean \| undefined` | Voice | Compatibility alias/list member; canonical control `stt.local.fasterWhisper.gatewayAllowModelDownload` |
| `stt.local.faster_whisper.queueDepth` | `number` | Voice | Compatibility alias/list member; canonical control `stt.local.fasterWhisper.queueDepth` |
| `stt.local.faster_whisper.queue_depth` | `number` | Voice | Compatibility alias/list member; canonical control `stt.local.fasterWhisper.queueDepth` |
| `stt.local.faster_whisper.timeoutMs` | `number` | Voice | Compatibility alias/list member; canonical control `stt.local.fasterWhisper.timeoutMs` |
| `stt.local.faster_whisper.timeout_ms` | `number` | Voice | Compatibility alias/list member; canonical control `stt.local.fasterWhisper.timeoutMs` |
| `stt.local.faster_whisper.modelCached` | `boolean \| undefined` | Voice | Compatibility cache hint; dependency inspection reports installed state |
| `stt.local.faster_whisper.model_cached` | `boolean \| undefined` | Voice | Compatibility cache hint; dependency inspection reports installed state |
| `stt.groq.model` | `string` | Voice | Structured reviewed control; individual persistence round-trip coverage |
| `stt.groq.apiKeyEnv` | `string` | Voice | Protected staged credential/reference control |
| `stt.groq.api_key_env` | `string` | Voice | Compatibility alias/list member; canonical control `stt.groq.apiKeyEnv` |
| `stt.openai.model` | `string` | Voice | Structured reviewed control; individual persistence round-trip coverage |
| `stt.openai.apiKeyEnv` | `string` | Voice | Protected staged credential/reference control |
| `stt.openai.api_key_env` | `string` | Voice | Compatibility alias/list member; canonical control `stt.openai.apiKeyEnv` |
| `stt.mistral.model` | `string` | Voice | Structured reviewed control; individual persistence round-trip coverage |
| `stt.mistral.apiKeyEnv` | `string` | Voice | Protected staged credential/reference control |
| `stt.mistral.api_key_env` | `string` | Voice | Compatibility alias/list member; canonical control `stt.mistral.apiKeyEnv` |
| `stt.xai.baseUrl` | `string` | Voice | Structured reviewed control; individual persistence round-trip coverage |
| `stt.xai.base_url` | `string` | Voice | Compatibility alias/list member; canonical control `stt.xai.baseUrl` |
| `stt.xai.apiKeyEnv` | `string` | Voice | Protected staged credential/reference control |
| `stt.xai.api_key_env` | `string` | Voice | Compatibility alias/list member; canonical control `stt.xai.apiKeyEnv` |
| `stt.xai.language` | `string` | Voice | Structured reviewed control; individual persistence round-trip coverage |
| `stt.xai.format` | `string` | Voice | Structured reviewed control; individual persistence round-trip coverage |
| `stt.xai.diarize` | `boolean \| undefined` | Voice | Structured reviewed control; individual persistence round-trip coverage |
| `stt.xai.diarization` | `boolean \| undefined` | Voice | Structured reviewed control; individual persistence round-trip coverage |
| `stt.xai.keyterms` | `string[]` | Voice | Structured reviewed control; individual persistence round-trip coverage |
| `stt.xai.key_terms` | `string[]` | Voice | Compatibility alias; canonical control `stt.xai.keyterms` |
| `stt.xai.fillerWords` | `boolean \| undefined` | Voice | Structured reviewed control; individual persistence round-trip coverage |
| `stt.xai.filler_words` | `boolean \| undefined` | Voice | Compatibility alias/list member; canonical control `stt.xai.fillerWords` |
| `stt.xai.rawAudioHints` | `boolean \| undefined` | Voice | Structured reviewed control; individual persistence round-trip coverage |
| `stt.xai.raw_audio_hints` | `boolean \| undefined` | Voice | Compatibility alias/list member; canonical control `stt.xai.rawAudioHints` |
| `voice.autoTts` | `boolean \| undefined` | Voice | Structured reviewed control; individual persistence round-trip coverage |
| `voice.autoTtsMaxCharsPerReply` | `number` | Voice | Structured reviewed control; individual persistence round-trip coverage |
| `voice.autoTtsMaxCharsPerHourPerChat` | `number` | Voice | Structured reviewed control; individual persistence round-trip coverage |
| `mcpServers.*.enabled` | `boolean \| undefined` | Capabilities | Structured reviewed control; individual persistence round-trip coverage |
| `mcpServers.*.transport` | `MCPServerTransport \| undefined` | Capabilities | Structured reviewed control; individual persistence round-trip coverage |
| `mcpServers.*.command` | `string` | Capabilities | Structured reviewed control; individual persistence round-trip coverage |
| `mcpServers.*.args` | `string[]` | Capabilities | Structured reviewed control; individual persistence round-trip coverage |
| `mcpServers.*.cwd` | `string` | Capabilities | Structured reviewed control; individual persistence round-trip coverage |
| `mcpServers.*.env.*` | `string` | Capabilities | Existing plaintext preserved privately; replace through protected envRefs control |
| `mcpServers.*.envRefs.*` | `string` | Capabilities | Protected staged credential/reference control |
| `mcpServers.*.url` | `string` | Capabilities | Structured reviewed control; individual persistence round-trip coverage |
| `mcpServers.*.headers.*` | `string` | Capabilities | Existing plaintext preserved privately; replace through protected headerRefs control |
| `mcpServers.*.tools.include` | `string[]` | Capabilities | Structured reviewed control; individual persistence round-trip coverage |
| `mcpServers.*.tools.exclude` | `string[]` | Capabilities | Structured reviewed control; individual persistence round-trip coverage |
| `mcpServers.*.tools.resources` | `boolean \| undefined` | Capabilities | Structured reviewed control; individual persistence round-trip coverage |
| `mcpServers.*.tools.prompts` | `boolean \| undefined` | Capabilities | Structured reviewed control; individual persistence round-trip coverage |
| `mcpServers.*.tools.prefix` | `string \| boolean \| undefined` | Capabilities | Structured reviewed control; individual persistence round-trip coverage |
| `mcpServers.*.includeTools` | `string[]` | Capabilities | Compatibility alias; use structured tools.include/exclude/resources/prompts/prefix |
| `mcpServers.*.excludeTools` | `string[]` | Capabilities | Compatibility alias; use structured tools.include/exclude/resources/prompts/prefix |
| `mcpServers.*.exposeResources` | `boolean \| undefined` | Capabilities | Compatibility alias; use structured tools.include/exclude/resources/prompts/prefix |
| `mcpServers.*.exposePrompts` | `boolean \| undefined` | Capabilities | Compatibility alias; use structured tools.include/exclude/resources/prompts/prefix |
| `mcpServers.*.toolPrefix` | `string \| boolean \| undefined` | Capabilities | Compatibility alias; use structured tools.include/exclude/resources/prompts/prefix |
| `mcpServers.*.timeoutMs` | `number` | Capabilities | Structured reviewed control; individual persistence round-trip coverage |
| `mcpServers.*.connectTimeoutMs` | `number` | Capabilities | Structured reviewed control; individual persistence round-trip coverage |
| `mcpServers.*.trust` | `MCPServerTrust \| undefined` | Capabilities | Structured reviewed control; individual persistence round-trip coverage |
| `mcpServers.*.toolRiskClass` | `ToolRiskClass \| undefined` | Capabilities | Structured reviewed control; individual persistence round-trip coverage |
| `mcpServers.*.toolRiskClasses.*` | `ToolRiskClass` | Capabilities | Structured reviewed control; individual persistence round-trip coverage |
| `mcpServers.*.protectedToolArguments.*.paths` | `string[]` | Capabilities | Structured reviewed control; individual persistence round-trip coverage |
| `mcpServers.*.protectedToolArguments.*.handling.persistence` | `"none" \| "destination-managed" \| "unknown"` | Capabilities | Structured reviewed control; individual persistence round-trip coverage |
| `mcpServers.*.protectedToolArguments.*.handling.sharing` | `"unknown" \| "private" \| "workspace" \| "account" \| "external"` | Capabilities | Structured reviewed control; individual persistence round-trip coverage |
| `mcpServers.*.protectedToolArguments.*.groupedDelivery` | `boolean \| undefined` | Capabilities | Structured reviewed control; individual persistence round-trip coverage |
| `mcpServers.*.protectedToolArguments.*.browserRelay` | `boolean \| undefined` | Capabilities | Structured reviewed control; individual persistence round-trip coverage |
| `mcpServers.*.artifactToolArguments.*.typeMapping.argument` | `string` | Capabilities | Structured reviewed control; individual persistence round-trip coverage |
| `mcpServers.*.artifactToolArguments.*.typeMapping.values.*` | `string` | Capabilities | Structured reviewed control; individual persistence round-trip coverage |
| `mcpServers.*.artifactToolArguments.*.paths` | `string[]` | Capabilities | Structured reviewed control; individual persistence round-trip coverage |
| `mcpServers.*.artifactToolArguments.*.allowedMimeTypes` | `string[]` | Capabilities | Structured reviewed control; individual persistence round-trip coverage |
| `mcpServers.*.artifactToolArguments.*.maxBytes` | `number` | Capabilities | Structured reviewed control; individual persistence round-trip coverage |
| `mcpServers.*.redactedToolResultPaths.*` | `string[]` | Capabilities | Structured reviewed control; individual persistence round-trip coverage |
| `mcpServers.*.continuityToolResultPaths.*` | `string[]` | Capabilities | Structured reviewed control; individual persistence round-trip coverage |
| `mcpServers.*.toolVerificationRelationships.*` | `string[]` | Capabilities | Structured reviewed control; individual persistence round-trip coverage |
| `mcpServers.*.resourceReadRiskClass` | `ToolRiskClass \| undefined` | Capabilities | Structured reviewed control; individual persistence round-trip coverage |
| `mcpServers.*.promptGetRiskClass` | `ToolRiskClass \| undefined` | Capabilities | Structured reviewed control; individual persistence round-trip coverage |
| `mcp_servers.*.enabled` | `boolean \| undefined` | Canonical alias area | Compatibility alias/list member; canonical control `mcpServers.*.enabled` |
| `mcp_servers.*.transport` | `MCPServerTransport \| undefined` | Canonical alias area | Compatibility alias/list member; canonical control `mcpServers.*.transport` |
| `mcp_servers.*.command` | `string` | Canonical alias area | Compatibility alias/list member; canonical control `mcpServers.*.command` |
| `mcp_servers.*.args` | `string[]` | Canonical alias area | Compatibility alias/list member; canonical control `mcpServers.*.args` |
| `mcp_servers.*.cwd` | `string` | Canonical alias area | Compatibility alias/list member; canonical control `mcpServers.*.cwd` |
| `mcp_servers.*.env.*` | `string` | Canonical alias area | Existing plaintext preserved privately; replace through protected envRefs control |
| `mcp_servers.*.envRefs.*` | `string` | Canonical alias area | Compatibility alias/list member; canonical control `mcpServers.*.envRefs.*` |
| `mcp_servers.*.url` | `string` | Canonical alias area | Compatibility alias/list member; canonical control `mcpServers.*.url` |
| `mcp_servers.*.headers.*` | `string` | Canonical alias area | Existing plaintext preserved privately; replace through protected headerRefs control |
| `mcp_servers.*.tools.include` | `string[]` | Canonical alias area | Compatibility alias/list member; canonical control `mcpServers.*.tools.include` |
| `mcp_servers.*.tools.exclude` | `string[]` | Canonical alias area | Compatibility alias/list member; canonical control `mcpServers.*.tools.exclude` |
| `mcp_servers.*.tools.resources` | `boolean \| undefined` | Canonical alias area | Compatibility alias/list member; canonical control `mcpServers.*.tools.resources` |
| `mcp_servers.*.tools.prompts` | `boolean \| undefined` | Canonical alias area | Compatibility alias/list member; canonical control `mcpServers.*.tools.prompts` |
| `mcp_servers.*.tools.prefix` | `string \| boolean \| undefined` | Canonical alias area | Compatibility alias/list member; canonical control `mcpServers.*.tools.prefix` |
| `mcp_servers.*.includeTools` | `string[]` | Canonical alias area | Compatibility alias; canonical mcpServers controls |
| `mcp_servers.*.excludeTools` | `string[]` | Canonical alias area | Compatibility alias; canonical mcpServers controls |
| `mcp_servers.*.exposeResources` | `boolean \| undefined` | Canonical alias area | Compatibility alias; canonical mcpServers controls |
| `mcp_servers.*.exposePrompts` | `boolean \| undefined` | Canonical alias area | Compatibility alias; canonical mcpServers controls |
| `mcp_servers.*.toolPrefix` | `string \| boolean \| undefined` | Canonical alias area | Compatibility alias; canonical mcpServers controls |
| `mcp_servers.*.timeoutMs` | `number` | Canonical alias area | Compatibility alias/list member; canonical control `mcpServers.*.timeoutMs` |
| `mcp_servers.*.connectTimeoutMs` | `number` | Canonical alias area | Compatibility alias/list member; canonical control `mcpServers.*.connectTimeoutMs` |
| `mcp_servers.*.trust` | `MCPServerTrust \| undefined` | Canonical alias area | Compatibility alias/list member; canonical control `mcpServers.*.trust` |
| `mcp_servers.*.toolRiskClass` | `ToolRiskClass \| undefined` | Canonical alias area | Compatibility alias/list member; canonical control `mcpServers.*.toolRiskClass` |
| `mcp_servers.*.toolRiskClasses.*` | `ToolRiskClass` | Canonical alias area | Compatibility alias/list member; canonical control `mcpServers.*.toolRiskClasses.*` |
| `mcp_servers.*.protectedToolArguments.*.paths` | `string[]` | Canonical alias area | Compatibility alias/list member; canonical control `mcpServers.*.protectedToolArguments.*.paths` |
| `mcp_servers.*.protectedToolArguments.*.handling.persistence` | `"none" \| "destination-managed" \| "unknown"` | Canonical alias area | Compatibility alias/list member; canonical control `mcpServers.*.protectedToolArguments.*.handling.persistence` |
| `mcp_servers.*.protectedToolArguments.*.handling.sharing` | `"unknown" \| "private" \| "workspace" \| "account" \| "external"` | Canonical alias area | Compatibility alias/list member; canonical control `mcpServers.*.protectedToolArguments.*.handling.sharing` |
| `mcp_servers.*.protectedToolArguments.*.groupedDelivery` | `boolean \| undefined` | Canonical alias area | Compatibility alias/list member; canonical control `mcpServers.*.protectedToolArguments.*.groupedDelivery` |
| `mcp_servers.*.protectedToolArguments.*.browserRelay` | `boolean \| undefined` | Canonical alias area | Compatibility alias/list member; canonical control `mcpServers.*.protectedToolArguments.*.browserRelay` |
| `mcp_servers.*.artifactToolArguments.*.typeMapping.argument` | `string` | Canonical alias area | Compatibility alias/list member; canonical control `mcpServers.*.artifactToolArguments.*.typeMapping.argument` |
| `mcp_servers.*.artifactToolArguments.*.typeMapping.values.*` | `string` | Canonical alias area | Compatibility alias/list member; canonical control `mcpServers.*.artifactToolArguments.*.typeMapping.values.*` |
| `mcp_servers.*.artifactToolArguments.*.paths` | `string[]` | Canonical alias area | Compatibility alias/list member; canonical control `mcpServers.*.artifactToolArguments.*.paths` |
| `mcp_servers.*.artifactToolArguments.*.allowedMimeTypes` | `string[]` | Canonical alias area | Compatibility alias/list member; canonical control `mcpServers.*.artifactToolArguments.*.allowedMimeTypes` |
| `mcp_servers.*.artifactToolArguments.*.maxBytes` | `number` | Canonical alias area | Compatibility alias/list member; canonical control `mcpServers.*.artifactToolArguments.*.maxBytes` |
| `mcp_servers.*.redactedToolResultPaths.*` | `string[]` | Canonical alias area | Compatibility alias/list member; canonical control `mcpServers.*.redactedToolResultPaths.*` |
| `mcp_servers.*.continuityToolResultPaths.*` | `string[]` | Canonical alias area | Compatibility alias/list member; canonical control `mcpServers.*.continuityToolResultPaths.*` |
| `mcp_servers.*.toolVerificationRelationships.*` | `string[]` | Canonical alias area | Compatibility alias/list member; canonical control `mcpServers.*.toolVerificationRelationships.*` |
| `mcp_servers.*.resourceReadRiskClass` | `ToolRiskClass \| undefined` | Canonical alias area | Compatibility alias/list member; canonical control `mcpServers.*.resourceReadRiskClass` |
| `mcp_servers.*.promptGetRiskClass` | `ToolRiskClass \| undefined` | Canonical alias area | Compatibility alias/list member; canonical control `mcpServers.*.promptGetRiskClass` |
| `skills.externalDirs` | `string[]` | Capabilities / Evolution | Structured reviewed control; individual persistence round-trip coverage |
| `skills.autonomy` | `SkillAutonomy \| undefined` | Capabilities / Evolution | Structured reviewed control; individual persistence round-trip coverage |
| `skills.config.*.*` | `unknown` | Capabilities / Evolution | Structured reviewed control; individual persistence round-trip coverage |
| `ui.language` | `UiLanguage \| undefined` | Runtime language | Structured reviewed control; individual persistence round-trip coverage |
| `ui.flavor` | `UiFlavor \| undefined` | Runtime language | Structured reviewed control; individual persistence round-trip coverage |
| `ui.activityLabels` | `ActivityLabelsLocale \| undefined` | Runtime language | Structured reviewed control; individual persistence round-trip coverage |
| `ui.showResponseProgress` | `boolean \| undefined` | Runtime language | Structured reviewed control; individual persistence round-trip coverage |
| `profile.mode` | `AgentProfileMode \| undefined` | Runtime profile | Structured reviewed control; individual persistence round-trip coverage |
| `profile.responseLanguage` | `AgentResponseLanguage \| undefined` | Runtime profile | Structured reviewed control; individual persistence round-trip coverage |
| `security.approvalMode` | `"off" \| "manual" \| SecurityApprovalMode \| "smart" \| undefined` | Governance | Structured reviewed control; individual persistence round-trip coverage |
| `security.allowPrivateUrls` | `string \| boolean \| undefined` | Governance | Structured reviewed control; individual persistence round-trip coverage |
| `security.websiteBlocklist.domains` | `string[]` | Governance | Structured reviewed control; individual persistence round-trip coverage |
| `security.websiteBlocklist.sharedFiles` | `string[]` | Governance | Structured reviewed control; individual persistence round-trip coverage |
| `security.assessor.enabled` | `boolean \| undefined` | Governance | Structured reviewed control; individual persistence round-trip coverage |
| `security.assessor.provider` | `ProviderId \| undefined` | Governance | Retired routing field; use auxiliaryModels.assessor |
| `security.assessor.model` | `string` | Governance | Retired routing field; use auxiliaryModels.assessor |
| `security.assessor.timeoutMs` | `number` | Governance | Structured reviewed control; individual persistence round-trip coverage |
| `security.approvals.mode` | `"off" \| "manual" \| SecurityApprovalMode \| "smart" \| undefined` | Governance | Compatibility alias; use security.approvalMode |
| `channels.telegram.enabled` | `boolean \| undefined` | Channels | Structured reviewed control; individual persistence round-trip coverage |
| `channels.telegram.botTokenEnv` | `string` | Channels | Protected staged credential/reference control |
| `channels.telegram.defaultChatId` | `string` | Channels | Structured reviewed control; individual persistence round-trip coverage |
| `channels.telegram.allowedUserIds` | `string[]` | Channels | Structured reviewed control; individual persistence round-trip coverage |
| `channels.telegram.allowedChatIds` | `string[]` | Channels | Structured reviewed control; individual persistence round-trip coverage |
| `channels.telegram.groupSessionsPerUser` | `boolean \| undefined` | Channels | Structured reviewed control; individual persistence round-trip coverage |
| `channels.telegram.threadSessionsPerUser` | `boolean \| undefined` | Channels | Structured reviewed control; individual persistence round-trip coverage |
| `channels.telegram.sessionResetPolicy` | `"none" \| "idle" \| "daily" \| "both" \| undefined` | Channels | Structured reviewed control; individual persistence round-trip coverage |
| `channels.telegram.sessionIdleResetMinutes` | `number` | Channels | Structured reviewed control; individual persistence round-trip coverage |
| `channels.telegram.pollTimeoutSeconds` | `number` | Channels | Structured reviewed control; individual persistence round-trip coverage |
| `channels.telegram.maxAttachmentBytes` | `number` | Channels | Structured reviewed control; individual persistence round-trip coverage |
| `channels.telegram.busyPolicy` | `ChannelBusyPolicy \| undefined` | Channels | Structured reviewed control; individual persistence round-trip coverage |
| `channels.telegram.queueDepth` | `number` | Channels | Structured reviewed control; individual persistence round-trip coverage |
| `channels.telegram.busyTextCoalescing.enabled` | `boolean \| undefined` | Channels | Structured reviewed control; individual persistence round-trip coverage |
| `channels.telegram.busyTextCoalescing.windowMs` | `number` | Channels | Structured reviewed control; individual persistence round-trip coverage |
| `channels.telegram.busyTextCoalescing.maxMessages` | `number` | Channels | Structured reviewed control; individual persistence round-trip coverage |
| `channels.telegram.busyTextCoalescing.maxChars` | `number` | Channels | Structured reviewed control; individual persistence round-trip coverage |
| `channels.telegram.textDebounceMs` | `number` | Channels | Structured reviewed control; individual persistence round-trip coverage |
| `channels.telegram.textDebounceMaxMessages` | `number` | Channels | Structured reviewed control; individual persistence round-trip coverage |
| `channels.telegram.textDebounceMaxChars` | `number` | Channels | Structured reviewed control; individual persistence round-trip coverage |
| `channels.telegram.secureInputMode` | `TelegramSecureInputMode \| undefined` | Channels | Structured reviewed control; individual persistence round-trip coverage |
| `channels.telegram.streaming.enabled` | `boolean \| undefined` | Channels | Structured reviewed control; individual persistence round-trip coverage |
| `channels.telegram.streaming.editIntervalMs` | `number` | Channels | Structured reviewed control; individual persistence round-trip coverage |
| `channels.telegram.streaming.minInitialChars` | `number` | Channels | Structured reviewed control; individual persistence round-trip coverage |
| `channels.telegram.streaming.cursor` | `string` | Channels | Structured reviewed control; individual persistence round-trip coverage |
| `channels.telegram.streaming.maxFloodStrikes` | `number` | Channels | Structured reviewed control; individual persistence round-trip coverage |
| `channels.telegram.streaming.cleanupFailedAttempts` | `boolean \| undefined` | Channels | Structured reviewed control; individual persistence round-trip coverage |
| `channels.telegram.streaming.freshFinalAfterSeconds` | `number` | Channels | Structured reviewed control; individual persistence round-trip coverage |
| `channels.telegram.streaming.transport` | `"auto" \| "edit" \| "draft" \| undefined` | Channels | Structured reviewed control; individual persistence round-trip coverage |
| `channels.telegram.pairing.code` | `string` | Channels | Runtime-generated pairing state; owned by Telegram pairing flow |
| `channels.telegram.pairing.createdAt` | `string` | Channels | Runtime-generated pairing state; owned by Telegram pairing flow |
| `channels.telegram.pairing.expiresAt` | `string` | Channels | Runtime-generated pairing state; owned by Telegram pairing flow |
| `channels.discord.enabled` | `boolean \| undefined` | Channels | Structured reviewed control; individual persistence round-trip coverage |
| `channels.discord.botTokenEnv` | `string` | Channels | Protected staged credential/reference control |
| `channels.discord.allowedUsers` | `string[]` | Channels | Structured reviewed control; individual persistence round-trip coverage |
| `channels.discord.allowedGuilds` | `string[]` | Channels | Structured reviewed control; individual persistence round-trip coverage |
| `channels.discord.allowedChannels` | `string[]` | Channels | Structured reviewed control; individual persistence round-trip coverage |
| `channels.discord.freeResponseChannels` | `string[]` | Channels | Structured reviewed control; individual persistence round-trip coverage |
| `channels.discord.voiceChannel.enabled` | `boolean \| undefined` | Channels | Structured reviewed control; individual persistence round-trip coverage |
| `channels.discord.voiceChannel.autoJoinOnCommand` | `boolean \| undefined` | Channels | Structured reviewed control; individual persistence round-trip coverage |
| `channels.discord.busyPolicy` | `ChannelBusyPolicy \| undefined` | Channels | Structured reviewed control; individual persistence round-trip coverage |
| `channels.discord.queueDepth` | `number` | Channels | Structured reviewed control; individual persistence round-trip coverage |
| `channels.discord.busyTextCoalescing.enabled` | `boolean \| undefined` | Channels | Structured reviewed control; individual persistence round-trip coverage |
| `channels.discord.busyTextCoalescing.windowMs` | `number` | Channels | Structured reviewed control; individual persistence round-trip coverage |
| `channels.discord.busyTextCoalescing.maxMessages` | `number` | Channels | Structured reviewed control; individual persistence round-trip coverage |
| `channels.discord.busyTextCoalescing.maxChars` | `number` | Channels | Structured reviewed control; individual persistence round-trip coverage |
| `channels.email.enabled` | `boolean \| undefined` | Channels | Structured reviewed control; individual persistence round-trip coverage |
| `channels.email.imapHost` | `string` | Channels | Structured reviewed control; individual persistence round-trip coverage |
| `channels.email.imapPort` | `number` | Channels | Structured reviewed control; individual persistence round-trip coverage |
| `channels.email.smtpHost` | `string` | Channels | Structured reviewed control; individual persistence round-trip coverage |
| `channels.email.smtpPort` | `number` | Channels | Structured reviewed control; individual persistence round-trip coverage |
| `channels.email.username` | `string` | Channels | Structured reviewed control; individual persistence round-trip coverage |
| `channels.email.passwordEnv` | `string` | Channels | Protected staged credential/reference control |
| `channels.email.ownAddress` | `string` | Channels | Structured reviewed control; individual persistence round-trip coverage |
| `channels.email.homeAddress` | `string` | Channels | Structured reviewed control; individual persistence round-trip coverage |
| `channels.email.allowedSenders` | `string[]` | Channels | Structured reviewed control; individual persistence round-trip coverage |
| `channels.email.allowAllUsers` | `boolean \| undefined` | Channels | Structured reviewed control; individual persistence round-trip coverage |
| `channels.email.pollIntervalSeconds` | `number` | Channels | Structured reviewed control; individual persistence round-trip coverage |
| `channels.email.maxAttachmentBytes` | `number` | Channels | Structured reviewed control; individual persistence round-trip coverage |
| `channels.email.busyPolicy` | `ChannelBusyPolicy \| undefined` | Channels | Structured reviewed control; individual persistence round-trip coverage |
| `channels.email.queueDepth` | `number` | Channels | Structured reviewed control; individual persistence round-trip coverage |
| `channels.email.busyTextCoalescing.enabled` | `boolean \| undefined` | Channels | Structured reviewed control; individual persistence round-trip coverage |
| `channels.email.busyTextCoalescing.windowMs` | `number` | Channels | Structured reviewed control; individual persistence round-trip coverage |
| `channels.email.busyTextCoalescing.maxMessages` | `number` | Channels | Structured reviewed control; individual persistence round-trip coverage |
| `channels.email.busyTextCoalescing.maxChars` | `number` | Channels | Structured reviewed control; individual persistence round-trip coverage |
| `channels.whatsapp.enabled` | `boolean \| undefined` | Channels | Structured reviewed control; individual persistence round-trip coverage |
| `channels.whatsapp.experimental` | `boolean \| undefined` | Channels | Structured reviewed control; individual persistence round-trip coverage |
| `channels.whatsapp.authDir` | `string` | Channels | Structured reviewed control; individual persistence round-trip coverage |
| `channels.whatsapp.allowedUsers` | `string[]` | Channels | Structured reviewed control; individual persistence round-trip coverage |
| `channels.whatsapp.allowedGroups` | `string[]` | Channels | Structured reviewed control; individual persistence round-trip coverage |
| `channels.whatsapp.mode` | `WhatsAppChannelMode \| undefined` | Channels | Structured reviewed control; individual persistence round-trip coverage |
| `channels.whatsapp.dmPolicy` | `WhatsAppDmPolicy \| undefined` | Channels | Structured reviewed control; individual persistence round-trip coverage |
| `channels.whatsapp.groupPolicy` | `WhatsAppGroupPolicy \| undefined` | Channels | Structured reviewed control; individual persistence round-trip coverage |
| `channels.whatsapp.requireMention` | `boolean \| undefined` | Channels | Structured reviewed control; individual persistence round-trip coverage |
| `channels.whatsapp.mentionPatterns` | `string[]` | Channels | Structured reviewed control; individual persistence round-trip coverage |
| `channels.whatsapp.freeResponseChats` | `string[]` | Channels | Structured reviewed control; individual persistence round-trip coverage |
| `channels.whatsapp.replyPrefix` | `string` | Channels | Structured reviewed control; individual persistence round-trip coverage |
| `channels.whatsapp.pairingMode` | `"qr"` | Channels | Structured reviewed control; individual persistence round-trip coverage |
| `channels.whatsapp.busyPolicy` | `ChannelBusyPolicy \| undefined` | Channels | Structured reviewed control; individual persistence round-trip coverage |
| `channels.whatsapp.queueDepth` | `number` | Channels | Structured reviewed control; individual persistence round-trip coverage |
| `channels.whatsapp.busyTextCoalescing.enabled` | `boolean \| undefined` | Channels | Structured reviewed control; individual persistence round-trip coverage |
| `channels.whatsapp.busyTextCoalescing.windowMs` | `number` | Channels | Structured reviewed control; individual persistence round-trip coverage |
| `channels.whatsapp.busyTextCoalescing.maxMessages` | `number` | Channels | Structured reviewed control; individual persistence round-trip coverage |
| `channels.whatsapp.busyTextCoalescing.maxChars` | `number` | Channels | Structured reviewed control; individual persistence round-trip coverage |
| `channels.whatsapp.textDebounceMs` | `number` | Channels | Structured reviewed control; individual persistence round-trip coverage |
| `channels.whatsapp.textDebounceMaxMessages` | `number` | Channels | Structured reviewed control; individual persistence round-trip coverage |
| `channels.whatsapp.textDebounceMaxChars` | `number` | Channels | Structured reviewed control; individual persistence round-trip coverage |

## Acceptance evidence and remaining gates

The implementation registers **479 typed field controls** across Models, Vision, Voice, Browser, Runtime, Governance, Channels and Capabilities. All 479 have individual reviewed apply → CLI read/save → Desktop refresh tests. This count includes structured children of shorthand schema unions; it differs from the 522 source-inventory rows, which also include aliases, route-editor fields and runtime/internal state. Dedicated Models controls own primary/fallback route selection and order. Advanced fallback selectors address existing zero-based entries 0–99; they cannot append a route or create an array hole.

Regression evidence:

- `src/control-service/public-settings-matrix.test.ts`: 479 individual persistence cases using valid configured prerequisites. These test supported writes and preservation across the shared CLI writer, not all permutations or network behavior.
- `src/control-service/public-settings.test.ts` and `public-settings-roundtrip.test.ts`: reviewed apply, CLI UI writer round trips, profile isolation, legacy alias projection, bounded pages, rejected invalid values, cancellation, stale review and indexed fallback credentials.
- `src/setup/review/profile-apply.test.ts`: transaction recovery and protected credential apply ownership.
- `src/config/header-secret-references.test.ts`: selected-profile resolution, no cross-profile borrowing, symlink rejection, header injection checks and case-insensitive replacement of legacy headers.
- `src/control-service/settings-actions.test.ts`, `settings-packs.test.ts`, `settings-dependencies.test.ts`: reviewed registration/trust/profile lifecycle, pack ownership, fixed Docker provisioning and dependency receipts. Docker tests inject the provisioner; they do not download or build an image.
- `src/artifacts/desktop-media-input.test.ts`, `src/control-service/desktop-media-output.test.ts`, `src/tools/voice-tools.test.ts`: input snapshots, target/submission binding, storage isolation, retained integrity, profile-scoped transfers and a single retained speech record.
- Desktop microphone/window-policy unit tests: permission denial, camera/subframe rejection, capture invalidation and bounded WAV sealing.
- Desktop `desktop-media.spec.ts` and `desktop-microphone.spec.ts`: English/Arabic image preview/save, explicit speech Play/Stop and the actual AudioWorklet processing synthetic audio. These tests do not access a physical microphone or call a paid provider.

Remaining PR14B parity/acceptance limits:

1. Profile rename/delete is restricted to unused, inactive, non-default profiles with no retained global history. Review checks the gateway, pending config writes, profile inventory and history; apply rechecks under the profile writer lock. It does not migrate used-profile ownership/history or provide an exclusive lifecycle lease across independently starting CLI processes. Stop other consumers before lifecycle changes. Used-profile lifecycle is not counted as full CLI parity.
2. Installation owner/version inspection is read-only. Desktop does not update or uninstall a separately owned CLI installation or its running application bundle. Those mutations remain with the installation owner; packaged delivery acceptance belongs to PR16. This is an explicit action-parity limit, not a completed update/uninstall path.
3. Native packaged microphone permission, real-device capture and configured live STT/TTS/image provider journeys have not been exercised in this pass. Raw PCM TTS output and outputs larger than 8 MB do not have the retained media preview path; supported retained playback formats are MPEG, WAV, Ogg, AAC and FLAC, subject to Electron codec support.

PR15 owns the schedule editor/delivery acceptance rows. They remain **PR15 pending** and are not counted as completed PR14B work. Video remains PR21. These dependencies do not erase the limits above. The 18-commit implementation sequence is delivered; the full public-parity exit gate and external-alpha readiness are not declared complete. See the [validation record](desktop-pr14b-validation.md) for executed checks and exclusions.

## Security and ownership notes

Configuration saves use the existing selected-profile transaction, writer lock, journal and invalidation boundary. Review is not execution authority. Browser private-URL/cloud policy, tool approvals, hardline blocks and spending limits remain runtime-owned. General renderer IPC never carries staged API keys or header credentials. Header/env references resolve from the selected profile; MCP reference resolution no longer borrows process-wide credential values.

Recording is opt-in, limited to 60 seconds at 16 kHz mono PCM, converted to a local WAV attachment and kept in the draft until Send. The submitted request uses the normal configured STT tool and may require hosted processing approval. This is batch transcription into Work, not realtime dictation. Image generation and speech generation likewise insert a reviewable request into the draft. Playback uses verified retained bytes and does not create another synthesis request.

Dependency installation uses registered package/capability definitions. Docker provisioning accepts only the fixed `docker-execution` action and bundled Dockerfile; inspection exposes the prepared immutable image ID. Provisioning does not enable Docker execution or change policy. Cancellation before dispatch avoids installation; an already running installation is reconciled by its durable receipt and may continue. No rollback guarantee is implied. Media staging expires, retained previews are capped at 8 MB, transfer chunks are bounded and profile/window changes invalidate handles.
