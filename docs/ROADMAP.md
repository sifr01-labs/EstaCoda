# Roadmap

This is the agent-facing roadmap snapshot. It mirrors the intent of [NEXT_PHASE_ROADMAP.md](/Users/ahnwy/estacoda-v2/NEXT_PHASE_ROADMAP.md) but is written for implementation handoff.

## Current Stage

EstaCoda v2 is an **MVP candidate for private/internal alpha**.

It is already useful for:

- CLI provider-backed work `live-proven`
- skill-backed workflows `smoke-tested`
- Telegram text usage `live-proven`
- Telegram document analysis `live-proven`
- Telegram image understanding with Kimi `live-proven`
- repeatable internal alpha runs `live-proven`
- first-run onboarding through a working agent session `live-proven`
- Telegram image generation delivery `live-proven`

Current hosted-provider matrix:

- Kimi: full pass `live-proven`
- OpenAI: full pass `live-proven`
- DeepSeek: full pass `live-proven`
- OpenRouter: runtime path works, exactness still partial `live-proven`
- local/Ollama: not accepted in this environment `live-proven`

It is not yet a broad public release. The next product work is packaging, release hardening, and polish rather than proving the basic agent/runtime/onboarding path.

## Milestone Status

### 1. Multi-step agent core

State: mostly strong.

Done:

- provider-backed read/write/edit flows `live-proven`
- recoverable tool-call failures `smoke-tested`
- trusted workspace flow `live-proven`
- visible tool activity `live-proven`
- core tool hardening for invalid search regexes, shell portability, terminal timeout kill escalation, symlink-cycle-safe search, stable provider tool-call IDs, input-schema validation, and stored-result truncation `smoke-tested`

Next:

- OpenRouter exactness/fidelity hardening after the hosted-provider batch
- more realistic multi-tool live tasks

### 2. Executable skills

State: strong.

Done:

- provider-backed skill execution `smoke-tested`
- deterministic fallback path `smoke-tested`
- session-stable skill visibility `live-proven`
- external dirs `smoke-tested`
- skill package indexing `smoke-tested`
- skill mutation actions `smoke-tested`
- skill mutation hardening with schema-preserving generated frontmatter, snapshots, rollback, and validation `smoke-tested`
- skill usage/evolution overlay with usage sidecar, provenance-aware observations/proposed patches, scored per-skill eval fixtures, review/approve/reject UX, rich promotion records with eval deltas, and gated personal-skill promotion `smoke-tested`
- load-time setup context `smoke-tested`

Next:

- stronger skill eval execution with real task fixtures beyond metadata/workflow scoring
- portable per-skill sidecars and richer human-facing review UI for blocked untrusted proposals
- more operational env/credential-backed script conventions
- Skills Hub/distribution later

### 3. Memory and sessions

State: partial.

Done:

- bounded memory files `smoke-tested`
- session DB `live-proven` on gateway path
- persisted channel session context `smoke-tested`
- Telegram session identity policy for DM/group/thread behavior `smoke-tested`
- Telegram auto-reset session lifecycle on gateway path `smoke-tested`
- history packing `smoke-tested`
- prompt cache `smoke-tested`
- skill outcome persistence `smoke-tested`
- repeated preference/project-fact promotion now runs after the response path and uses bounded session search instead of full session/message scans `smoke-tested`

Next:

- better session-summary preservation
- compression protection around recent tool pairs
- richer session-admin UX: lineage / history / resume controls beyond the current `/sessions`, `/search`, and `/switch`

### 4. Channels

State: meaningful Telegram alpha.

Done:

- Telegram adapter `live-proven`
- allowlist/pairing `smoke-tested`
- approvals `smoke-tested`
- inline approval UX `smoke-tested`
- compact progress `smoke-tested`
- attachment download + document path `live-proven` for documents
- vision-backed image analysis support in runtime `live-proven` with Kimi
- gateway diagnostics `live-proven`

Next:

- broader live image verification beyond Kimi
- more Telegram final UX polish
- channel verbosity/profile controls
- next launch channel after Telegram is stable

### 5. Onboarding and packaging

State: onboarding MVP is live-proven for the CLI path; packaging remains partial.

Done:

- canonical `estacoda setup` guided wizard `smoke-tested`
- first-run interactive onboarding from fresh `HOME` through a working agent session `live-proven`
- interface language/style selection for English and Arabic onboarding `live-proven`
- two-step primary provider/model selection plus optional backup model selection `live-proven`
- advanced flag setup via `estacoda setup --advanced ...` `smoke-tested`
- first-launch prompt asks `Run setup now? [Y/n]` instead of silently entering setup `implemented`
- local secret store at `~/.estacoda/.env` with `0600` permissions and config env-var references `smoke-tested`
- user/project config overlays deep-merge provider, credential-pool, auxiliary-provider, and MCP server entries so project overrides do not erase user credentials/models `smoke-tested`
- provider catalog hardening keeps models.dev metadata as an offline-first enrichment layer around the existing resolver, treats catalog-only providers as discovery adapters, preserves credential/base-URL execution in the provider runtime, and supports explicit provider/model execution for selected routes `smoke-tested`
- setup prompts for workspace trust, provider/model, local credential capture, security mode, workflow learning, optional capabilities, and compact readiness verification `smoke-tested`
- `estacoda verify` readiness check and first-run setup check `smoke-tested`
- `estacoda settings` category overview and skill-autonomy mutation `smoke-tested`
- Phase 2A Telegram guided setup via `estacoda telegram setup` with local secret storage, token verification, allow/remove management, command sync, and test message path `smoke-tested`
- Phase 2B browser command alignment via `estacoda browser setup`, `estacoda browser test`, and `estacoda settings browser` `smoke-tested`
- Phase 2C/2D profile/UI foundation via `estacoda profile`, `profile set`, `profile language`, and `settings ui`; config separates UI language, UI flavor, activity labels, agent mode, and response language `smoke-tested`
- Phase 2E local model setup via `estacoda local setup/status/test`; defaults to Ollama's OpenAI-compatible endpoint, probes `/models`, stores no API key, and surfaces Hermes-style 64K context guidance `smoke-tested`
- provider config `smoke-tested`
- doctor checks `live-proven`

Next:

- external-user-quality install flow
- richer recovery UX for bad credentials/config
- runtime CLI copy/UI polish beyond onboarding
- richer localized approval cards and full runtime Arabic interface copy
- Phase 2 migration detection/import
- packaging/distribution decision

### 6. Internal alpha operations

State: good.

Done:

- alpha harness `live-proven`
- runbook `live-proven`
- repeatable run folders `live-proven`

Next:

- stronger pass/fail release gate behavior
- more guided live checks

### 7. Evaluation substrate

State: first foundation now exists.

Done:

- task-based eval scaffold `implemented`
- eval task catalog under `evals/tasks` `implemented`
- repeatable eval-run folders under `.estacoda/eval-runs` `implemented`

Next:

- structured scoring beyond pass/fail
- baseline vs candidate comparison
- skill-first batch evaluation
- eventual substrate for safe self-evolution loops

### 8. MCP and ACP

State: MCP client foundation now includes stdio + HTTP; the stdio path is now live-proven against a real filesystem MCP server. ACP foundation now exists as a stdio JSON-RPC server, and the JetBrains editor flow is now live-proven for chat, editor-backed file reads, shell execution, and approval prompts, but full editor parity is still not implemented.

Done:

- stdio MCP client transport `live-proven`
- HTTP MCP client transport `smoke-tested`
- config-driven MCP server registration/discovery `live-proven` on stdio, `smoke-tested` on HTTP
- MCP tool/resource/prompt discovery and registration into the normal runtime loop `live-proven` on stdio, `smoke-tested` on HTTP
- reload semantics via `estacoda mcp reload` and `/reload-mcp` `live-proven`
- per-server trust metadata now maps MCP tools into runtime risk classes; trusted stdio filesystem execution is `live-proven`
- auxiliary provider routing still reserves an `mcp` task label `implemented`
- ACP foundation now exists with:
  - `estacoda acp serve`
  - `estacoda acp manifest`
  - `acp_registry/agent.json`
  - core methods: `initialize`, `authenticate`, `session/new`, `session/load`, `session/list`, `session/prompt`, `session/cancel`
  - streaming `session/update` notifications for session info, thought chunks, tool calls, agent message chunks, and usage
  - editor-backed file reads in JetBrains
  - approval prompts and explicit shell execution in JetBrains
  `basic editor flow live-proven`

Next:

- add richer per-server trust/visibility controls
- refine resource/prompt ergonomics
- deepen ACP toward Hermes parity after MCP client and memory/session maturity
  The next explicit live proof should be richer terminal/process rendering and cleaner result formatting across editor clients.
- treat MCP server bridging as later than MCP client and ACP

## Correct Next Milestone

The best next milestone is:

1. **private repo / release hygiene**
2. **packaging and install flow**
3. **release hardening around setup recovery, credentials, and channel diagnostics**
4. **runtime CLI UI polish and broader localization**
5. **workflow-learning, MCP trust, and eval substrate refinement**

## Product Gap Analysis

The following product areas came up explicitly and should be treated as tracked gaps rather than fuzzy future ideas.

### 1. Onboarding experience

State: MVP first-run onboarding is built and live-proven.

- canonical first-run setup wizard exists `live-proven`
- English/Arabic onboarding exists `live-proven`
- provider -> model, optional backup model, protected credential capture, security mode, workflow-learning mode, optional capabilities, and compact setup check exist `live-proven` / `smoke-tested`
- secret persistence to `~/.estacoda/.env` exists `smoke-tested`
- readiness verification via `estacoda verify` exists `smoke-tested`
- lightweight settings category view exists `smoke-tested`
- provider setup/config exists `smoke-tested`
- doctor/health checks exist `live-proven`

What remains:

- better recovery from bad credentials/config
- deeper runtime CLI copy polish beyond onboarding
- richer localized approval cards and status copy
- packaging/install polish for non-builders

### 2. Migration from Hermes / OpenClaw

State: not meaningfully built.

- no migration CLI
- no import path for skills/config/memory
- no compatibility guide
- currently `intended but not implemented`

What remains:

- migration guide doc
- import mapping for skills/config where feasible
- explicit statement of what can and cannot be carried over

### 3. Telegram pairing flow

State: partially built.

- allowlist and pairing concepts exist `smoke-tested`
- gateway security flow exists `smoke-tested`
- security approval modes now exist across CLI/runtime/channel/ACP: `strict`, `adaptive`, `open` `smoke-tested`
- adaptive assessor path now exists with structured fallback-to-ask behavior `smoke-tested`
- CLI approval scopes and persistent workspace approval revocation now exist `smoke-tested`
- hard safety floor now covers broader destructive, secret-read, pipe-to-interpreter, and force-push cases `smoke-tested`
- adaptive assessor now defaults to a dedicated `approval` auxiliary route when enabled without an explicit provider/model override `smoke-tested`
- CLI security audit/debug views now exist for recent decisions `smoke-tested`
- `/yolo` session-scoped open-mode toggles now exist in CLI and gateway `smoke-tested`
- cron foundation now exists: `cronjob`, `estacoda cron`, `/cron`, persistent jobs, prompt scanning, bounded workspace-local script-backed jobs, tick locking, local output, origin/Telegram delivery hooks, and gateway ticks `smoke-tested`
- browser automation now has a Hermes-shaped local-CDP core: navigate, snapshot refs, click/type/scroll/press/back, image listing, console capture, raw CDP, screenshots, screenshot vision, dialog response, `/browser`, and config/status `smoke-tested`
- Telegram guided setup/management command surface now exists: `telegram setup`, `allow-user`, `remove-user`, `allow-chat`, `remove-chat`, `set-default-chat`, `sync-commands`, and `test` `smoke-tested`
- fully polished pairing UX is `implemented but not live-proven`

What remains:

- cleaner first-contact pairing flow
- clearer pairing diagnostics
- operator proof of the full pairing path

### 4. Local and open-source models

State: architecturally supported, operationally partial.

- provider routing supports non-hosted routes `smoke-tested`
- `estacoda local setup/status/test` provides a Hermes-aligned custom endpoint flow for Ollama/local OpenAI-compatible servers `smoke-tested`
- local setup defaults to `http://localhost:11434/v1`, requires no API key, probes `/models`, and auto-selects the model when exactly one is visible `smoke-tested`

What remains:

- explicit support matrix for text vs tool calling vs vision
- live operator proof against an actual Ollama/local endpoint in the target environment

### 5. UI design

State: only surface-level so far.

- Telegram and CLI interaction polish exists `live-proven` / `smoke-tested`
- broader UI/system design is `intended but not implemented`

What remains:

- product-level design language
- cross-channel response style system
- future visual surfaces beyond CLI/Telegram

### 6. RL capabilities

State: groundwork only.

- trajectory recording exists `smoke-tested`
- real RL/eval/improvement loop is `intended but not implemented`

What remains:

- data pipeline and eval policy
- reward/selection logic
- agent-improvement loop that is actually operational

### 7. Voice and TTS

State: Hermes-aligned voice foundation is smoke-tested for Telegram, hosted STT, and OpenAI-compatible TTS.

- Hermes-aligned `tts` and `stt` config sections exist with Edge TTS and local STT defaults `smoke-tested`
- `estacoda voice status/setup` and `estacoda settings voice` exist `smoke-tested`
- hosted TTS/STT provider key-env slots are represented for OpenAI, ElevenLabs, MiniMax, Mistral, Gemini, xAI, and Groq where applicable `smoke-tested`
- `voice.speak` generates OpenAI-compatible TTS audio, saves it under the audio cache, and records an audio artifact `smoke-tested`
- `voice.transcribe` sends OpenAI-compatible hosted STT requests for OpenAI/Groq-style providers and records transcript artifacts `smoke-tested`
- local STT custom-command execution via `stt.local.command` / `HERMES_LOCAL_STT_COMMAND` is enabled `smoke-tested`
- Telegram audio/voice attachments download into channel media and are automatically transcribed into the gateway message before the agent turn `smoke-tested`
- audio/voice attachments suggest `voice.transcribe` in the assembled prompt `implemented`
- Telegram audio artifacts are delivered with `sendAudio` when the generated file is available, with artifact-notice fallback `smoke-tested`
- Telegram Opus/Ogg audio artifacts are delivered with `sendVoice` voice bubbles `smoke-tested`
- TUI voice input is `intended but not implemented`

What remains:

- local Whisper/faster-whisper auto-detection beyond custom command
- Mistral-specific STT execution adapter
- ffmpeg conversion from MP3/WAV/PCM into Opus/Ogg for voice bubbles
- per-channel UX
- security/privacy stance for audio processing

### 8. Profiles and modes

State: profile/UI foundation exists.

- config separates `ui.language`, `ui.flavor`, `ui.activityLabels`, `profile.mode`, and `profile.responseLanguage` `smoke-tested`
- `estacoda profile`, `profile set`, and `profile language` exist `smoke-tested`
- `estacoda settings ui` exists `smoke-tested`
- prompt assembly receives profile and response-language guidance `smoke-tested`
- Telegram activity labels now follow configured UI activity-label locale on the gateway path `smoke-tested`
- security-mode and skill-autonomy labels/descriptions localize from `ui.language`; config values remain English (`strict`, `adaptive`, `open`, `none`, `suggest`, `proactive`, `autonomous`) `smoke-tested`

What remains:

- profile effects beyond prompt guidance
- channel-specific mode settings
- richer Arabic interface copy and localized approval cards beyond the security/skill settings

### 9. Image Generation

State: Hermes-aligned first foundation exists; Telegram image delivery is live-proven.

- `image_gen` / `imageGen` config normalizes to FAL by default with `fal-ai/flux-2/klein/9b` `smoke-tested`
- BytePlus/ModelArk Seedream backend is represented as an additional provider with `BYTEPLUS_ARK_API_KEY`, Seedream 5 as the default model, and version aliases for Seedream 5/4.5/4.0 `smoke-tested`
- `image.generate` accepts a minimal agent-facing schema: prompt, aspect ratio, model override, and seed `smoke-tested`
- image-generation prompts route to native image tooling rather than requiring a skill, while image-conditioned/edit prompts with ready image attachments stay on attachment analysis until a dedicated image-editing path exists `smoke-tested`
- `estacoda image status/setup/models` exists, including local secret-store support when a user provides an API key and a model-version picker surface for provider-specific image model IDs `smoke-tested`
- agent-facing `config.image.status` and `config.image.setup` tools exist so EstaCoda can configure image generation provider/model/key-env references without advertising raw API-key input `smoke-tested`
- FAL aspect ratios map to model-native `image_size` presets `smoke-tested`
- BytePlus/Seedream aspect ratios map to concrete image sizes above Seedream 5's minimum pixel requirement `smoke-tested`
- generated image URLs are downloaded into `.estacoda/image-cache/` and recorded as image artifacts `smoke-tested`
- Telegram image artifacts upload through `sendPhoto` with artifact-notice fallback `smoke-tested`
- `estacoda image verify` checks provider config, key-env presence, cache path, Telegram delivery readiness, and a safe provider capability probe `smoke-tested`
- missing image credentials return structured `setup_needed` metadata with provider options, required secret env, suggested command/tool, and `resumeIntent: image.generate` `smoke-tested`
- image setup now uses the shared capability secret-storage primitive, ready to generalize to voice/search/browser credentials `smoke-tested`
- CLI runtime intercepts image `setup_needed`, captures the API key with masked input outside the provider loop, stores it in `.estacoda/.env`, verifies setup, and resumes the original `image.generate` call `smoke-tested`
- OpenAI-style fragmented streaming tool calls preserve their function name across argument-only chunks, so provider-safe `image_generate` maps back to `image.generate` instead of `unknown` `smoke-tested`
- native `image-generation` intents execute deterministic `image.generate` exactly once and suppress duplicate provider tool selection for the same turn `smoke-tested`
- BytePlus `ModelNotOpen` failures now explain that model access is version-specific and point users to `estacoda image models --provider byteplus` plus `--model-version` setup aliases `smoke-tested`
- BytePlus/Seedream generated images were live-tested through Telegram delivery with `sendPhoto` attachment behavior. `live-proven`

What remains:

- broader live provider proof with FAL and additional BytePlus model versions
- richer CLI image/audio artifact cards remain follow-up; generated artifact prompt paths are now safe `artifact://<id>` references with internal `localPath` delivery support
- Telegram/channel protected credential capture and resume UX
- richer model picker UX similar to Hermes' `hermes tools`
- Nous gateway/proxy path
- FAL Clarity upscaler policy
- richer per-model capability filtering beyond the first FAL/Seedream payload mapping

### 10. Update story

State: not built.

- no real self-update or release-channel UX
- packaging path is still undecided
- overall update story is `intended but not implemented`

What remains:

- release/install method decision
- version/update command or package-manager path
- migration behavior across releases

### 11. MCP / ACP

State: MCP client foundation now exists across stdio + HTTP; ACP foundation now exists, and basic editor chat plus editor-backed file reads are now live-proven, but only the first editor slice is implemented.

- stdio MCP client transport exists `live-proven`
- HTTP MCP client transport exists `smoke-tested`
- MCP config surface exists `live-proven` on stdio usage, `smoke-tested` more broadly
- MCP tool/resource/prompt discovery exists `live-proven` on stdio usage, `smoke-tested` more broadly
- reload semantics now exist:
  - `estacoda mcp reload`
  - `/reload-mcp`
  `smoke-tested`
- per-server trust metadata exists and currently maps server trust to runtime risk classes `smoke-tested`
- ACP adapter/server foundation now exists; base editor flow is `live-proven`
- current `mcp` auxiliary route remains a routing preference construct, not the protocol client itself

What remains:

- Phase 1: MCP client for stdio servers `done / smoke-tested`
- Phase 2: trust/visibility refinement and richer resource/prompt ergonomics
- Phase 3: ACP foundation `done`; base editor flow is `live-proven`, and next is live approval proof plus richer editor/tool parity
- Later: MCP server bridge if/when EstaCoda should expose messaging/approvals outward the way Hermes does

## Launch Readiness Read

Closest honest label:

- usable internal alpha: yes
- small private MVP candidate: yes
- public-ready MVP today: no

Main blockers to MVP:

- install/distribution polish is not done
- private repo/release hygiene still needs completion
- recovery UX for bad provider/channel credentials still needs polish
- runtime CLI localization is not yet as complete as onboarding localization
- channel-level verbosity/profile controls are still missing
- provider breadth still needs repeated live proof beyond the current accepted routes
