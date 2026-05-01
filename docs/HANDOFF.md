# Project Handoff

This document is for a coding agent taking over the EstaCoda v2 codebase. It is not end-user documentation.

## Repo Snapshot

- Current branch: `main`
- Current git status at this handoff: clean before this documentation refresh.

Local scratch files may still exist on the developer machine and are intentionally ignored.

Evidence labels used in this document:

- `live-proven`: verified in a real operator run
- `smoke-tested`: covered by `src/smoke.ts`
- `implemented but not live-proven`: code exists, but no fresh operator proof should be assumed
- `intended but not implemented`: target state only

## 1. Product Goal

EstaCoda v2 is intended to become a Hermes-class autonomous agent platform with:

- a real provider-backed agent loop
- reusable skill packages as procedural knowledge
- bounded persistent memory
- capability-first security and approvals
- multi-channel delivery, with Telegram as the first real adapter
- a runtime that can learn over time without drifting away from deterministic operator control

The guiding product rule is: stay Hermes-aligned by default unless there is a deliberate, documented reason to diverge.

## 2. Current Milestone

Current milestone: **MVP candidate / private internal alpha**.

What has been achieved:

- CLI agent loop is real, provider-backed, and uses real tools.
- Skills are no longer decorative metadata; they execute through the normal provider/tool loop.
- Telegram is a real runtime surface, not scaffolding.
- Telegram approvals, progress updates, attachments, and session behavior are implemented.
- Telegram session behavior now includes persisted active-session mapping, explicit group/thread session policy, and configurable auto-reset on the gateway path.
- Internal alpha testing now has a repeatable harness and runbook.
- Vision-backed image analysis support has been added to the runtime and is now live-proven with Kimi; broader provider coverage still depends on configuring and validating additional vision-capable routes.
- A Phase 0 evaluation substrate now exists for future self-evolution work, but it is not yet an autonomous optimization loop.
- A Hermes-shaped MCP client foundation now exists for stdio and HTTP servers, with config-driven discovery, trust metadata, reload semantics, and live proof against a real stdio MCP filesystem server.
- An ACP foundation now exists as a stdio JSON-RPC server with session lifecycle methods, streaming session updates, a registry manifest, editor-backed file reads, and a live-proven JetBrains approval flow.
- A cron foundation now exists with persistent jobs, prompt safety scanning, tick locking, bounded workspace-local script-backed jobs, the `cronjob` tool, `estacoda cron`, `/cron`, local output files, origin/Telegram delivery hooks, and gateway scheduler ticks. It is `smoke-tested`; broader channel delivery remains follow-up work.
- Browser automation now has a Hermes-shaped local-CDP core: status/config, `/browser status|connect|disconnect`, navigate, snapshot, click, type, scroll, press, back, image listing, page-local console capture, raw CDP passthrough, screenshot capture, screenshot vision analysis, and basic JavaScript dialog response. It is `smoke-tested`; Browserbase, Browser Use, Firecrawl, Camofox, and persistent dialog supervisor/cloud dialog bridging remain follow-up work.
- First-run onboarding now covers interface language/style, workspace trust, primary provider/model, optional backup model, protected local credential capture, security mode, workflow-learning mode, optional capabilities, readiness verification, and immediate session start. English and Arabic onboarding are operator-tested; full runtime CLI localization remains follow-up work.

Evidence:

- CLI/provider/tool loop: `live-proven`
- skill execution through the normal loop: `smoke-tested`
- Telegram runtime surface: `live-proven`
- Telegram approvals/progress/attachments/session behavior: `smoke-tested`
- Telegram persisted session context + lifecycle policy: `smoke-tested`
- internal alpha harness and runbook: `live-proven`
- vision-backed image support: Kimi path `live-proven`; broader provider coverage `implemented but not live-proven`
- provider acceptance matrix: Kimi/OpenAI/DeepSeek full pass, OpenRouter partial on exactness-sensitive tasks, local/Ollama unproven in this environment `live-proven`
- evaluation substrate: `implemented but not live-proven`
- MCP client foundation across stdio + HTTP: stdio path `live-proven`; HTTP path `smoke-tested`
- ACP foundation: JetBrains chat, file reads, shell execution, and approval prompts are `live-proven`
- First-run onboarding wizard: interface language/style, protected provider key capture, workspace trust, primary/backup model selection, security mode, workflow-learning mode, optional capability setup, compact verify output, and immediate session start are `smoke-tested` and manually E2E-tested.
- Optional onboarding capability branches include Telegram, voice, vision/image generation, and browser setup. Telegram setup plus Telegram image delivery are `live-proven`; browser/voice/vision setup branches are `smoke-tested`.
- Phase 2C/2D profile/UI foundation now separates interface language, aesthetic flavor, activity-label locale, agent behavior mode, and response-language policy. `smoke-tested`
- Security-mode and skill-autonomy settings now render localized English/Arabic labels from `ui.language` while preserving English config values. `smoke-tested`
- Setup, verify, and settings now include clearer recommended paths, post-setup commands, and recovery next actions. `smoke-tested`
- Provider hardening now has models.dev-backed metadata infrastructure wrapped around the existing model catalog resolver, explicit provider/model execution, catalog-only discovery adapters, primary-provider-aware auxiliary routing, credential-pool-preserving provider execution, and runtime config catalog resolution that defaults to `allowNetwork: false`. `smoke-tested`
- Local model setup now has `estacoda local setup/status/test`, aligned with Hermes' local Ollama/custom endpoint path: OpenAI-compatible base URL, no API key, `/models` discovery, and 64K context guidance. `smoke-tested`
- Voice configuration foundation now has Hermes-aligned `tts`/`stt` config plus `estacoda voice status/setup` and `settings voice`; OpenAI-compatible `voice.speak` writes audio-cache artifacts, local custom-command plus OpenAI/Groq-style `voice.transcribe` writes transcript artifacts, Telegram injects voice transcripts before the agent turn, and Telegram uploads Opus/Ogg as `sendVoice` voice bubbles with `sendAudio` fallback. `smoke-tested`
- Image generation foundation now has Hermes-aligned `image_gen` config, FAL default model support, BytePlus/ModelArk Seedream support with Seedream 5 as the default plus `image models`/`--model-version` aliases for provider-specific versions, `image.generate`, image-cache artifact recording, Telegram `sendPhoto` delivery, CLI setup/status/models/verify, local API-key secret storage through the shared capability secret primitive, structured `setup_needed` metadata for missing image credentials, CLI protected credential capture with verification-before-retry, auto-resume of the original `image.generate` call, native `image-generation` routing with attachment-aware precedence, exactly-once deterministic `image.generate` execution, OpenAI-style fragmented tool-call name preservation for `image_generate`, and agent-facing image config tools that no longer advertise raw API-key fields. `smoke-tested`
- Telegram image generation and delivery via BytePlus/Seedream was live-tested end-to-end with generated images attached in Telegram. `live-proven`

## 3. Current Working Capabilities

Confirmed working in code and smoke:

- Provider-backed `file.read`, `file.write`, `file.replace` flows. `live-proven`
- Recoverable malformed tool-call handling. `smoke-tested`
- Recoverable unavailable/legacy tool-call handling. `smoke-tested`
- Provider-safe tool aliases. `smoke-tested`
- Trusted workspace behavior for proactive local work. `live-proven`
- Session-stable prompt assembly with cached system layers and ephemeral request layers. `smoke-tested`
- Session-stable skill visibility with `/reset` refresh semantics. `live-proven`
- External skill directories with local precedence and silent skip for missing roots. `smoke-tested`
- Skill create/edit/patch/delete/write-file/remove-file operations. `smoke-tested`
- Skill mutation hardening: schema-preserving generated JSON frontmatter, workflow/evaluation validation, mutation snapshots, rollback tool, and non-fatal bundled skill load warnings. `smoke-tested`
- Skill usage/evolution overlay: `.estacoda/skill-usage.json`, append-only provenance-aware observations, proposed patches, scored eval records, review/approve/reject tools, rich promotion records with eval deltas, untrusted-source promotion blocking, and schema/frontmatter-gated personal-skill patch promotion. `smoke-tested`
- Skill package indexing for `references/`, `templates/`, `scripts/`, and compatible `assets/`. `smoke-tested`
- Skill load-time setup context for env/config/credential-file presence. `smoke-tested`
- Memory file loading and persistence of skill outcomes. `smoke-tested`
- Repeated preference/project-fact promotion now runs after final response emission and uses bounded session search instead of scanning every session/message before routing. `smoke-tested`
- Core tool hardening now covers invalid `file.search` regexes, symlink-cycle-safe recursive search, portable shell fallback, SIGTERM then SIGKILL timeout behavior, stable provider tool-call IDs, basic schema validation before execution, and stored-result truncation. `smoke-tested`
- Telegram gateway startup/status diagnostics. `live-proven`
- Telegram approvals with persistent approval storage, `/approvals`, `/revoke`, inline buttons, and target-key matching. `smoke-tested`
- Telegram progress compaction into one evolving status message. `smoke-tested`
- Telegram bilingual activity labels (`en` and `ar`). `smoke-tested`
- Telegram persisted session context, policy-driven group/thread identity, and auto-reset lifecycle. `smoke-tested`
- Telegram attachment ingestion, download, failure handling, and document inspection. document path `live-proven`; broader path `smoke-tested`
- Native main-route vision plus fallback vision-tool routing for image attachment analysis. Kimi path `live-proven`; broader provider coverage `implemented but not live-proven`
- Internal alpha harness generation. `live-proven`
- Evaluation task scaffold and run generation. `implemented but not live-proven`

Confirmed live by operator testing:

- CLI provider-backed file edit/read/verify flow. `live-proven`
- CLI `/trust`, `/reset`, `/exit`. `live-proven`
- Telegram text replies. `live-proven`
- Telegram document attachment analysis. `live-proven`
- Telegram image understanding with Kimi, including visible-text and mixed summary prompts. `live-proven`
- Gateway diagnostics and setup flow. `live-proven`

Working but not yet fully proven live in operator testing:

- Telegram image understanding on non-Kimi providers. `implemented but not live-proven`
- Multi-provider live pass across Kimi/OpenRouter/Ollama/DeepSeek. Hosted-provider matrix is now `live-proven`; local/Ollama remains unproven in this environment.
- Repeated user-preference promotion into `USER.md`, including contradiction handling, strengthening, forgetting, and inspection. `smoke-tested`
- Repeated project-fact/convention promotion into `MEMORY.md`. `smoke-tested`
- Workflow learning with `skills.autonomy` (`none | suggest | proactive | autonomous`) now exists for bounded local workflows and creates project skills rather than writing procedures into `MEMORY.md`. `smoke-tested`
- MCP client foundation now exists:
  - stdio transport
  - HTTP transport
  - config-driven server registration
  - server-level trust metadata
  - tool/resource/prompt discovery
  - `estacoda mcp status`
  - `estacoda mcp reload`
  - `/reload-mcp`
  - real stdio third-party server execution is now `live-proven` for the filesystem server after workspace trust is granted
- ACP foundation now exists:
  - stdio JSON-RPC server
  - cwd-bound ACP sessions mapped onto EstaCoda runtimes
  - core methods: `initialize`, `authenticate`, `session/new`, `session/load`, `session/list`, `session/prompt`, `session/cancel`
  - `session/update` streaming
  - editor-backed file reads through ACP fs requests
  - `acp_registry/agent.json`
  `basic editor flow live-proven`

## 4. Architecture Overview

### Main systems

- `src/index.ts`
  Startup entrypoint. Loads config, asks whether to run setup on first launch, builds runtime, dispatches CLI commands, interactive session loop, or one-shot prompt.

- `src/runtime/create-runtime.ts`
  Runtime composition root. Builds the tool registry, skill registry, memory store, provider registry/executor, browser backend, session DB, and `AgentLoop`.

- `src/runtime/agent-loop.ts`
  Core orchestration loop. Handles message intake, attachments, intent routing, prompt assembly, provider execution, tool planning/execution, continuation prompts, memory/session writes, and cancellation.

- `src/prompt/prompt-assembly.ts`
  Builds provider prompts from identity, frozen memory, skills index, session history, user message, attachments, selected skill context, tool results, and continuation feedback.

- `src/providers/*`
  Model routing, capability inference, provider execution, credential pools, OpenAI-compatible transport, and auxiliary route logic.

- `src/tools/*`
  Concrete tool surfaces and execution helpers.

- `src/skills/*`
  Loading, resource hydration, visibility filtering, registry, skill tools, and workflow plan compilation.

- `src/channels/*`
  Channel gateway, Telegram adapter, approval store, activity-label rendering, Telegram formatting, and gateway runner diagnostics.

- `src/memory/*`
  Bounded memory store, rendering, scanning, memory tool, and local memory provider.

- `src/session/*`
  In-memory and SQLite-backed session persistence.

### High-level runtime flow

1. Load merged config from user and project config files.
   User-level `~/.estacoda/.env` is loaded first as a local secret store without overriding already-exported environment variables.
2. Build runtime:
   - load model/provider registry
   - load memory files
   - load official + personal + project + external skills
   - filter visible skills by runtime conditions
   - register tools
3. Receive input through CLI or channel gateway.
4. Normalize attachments and fail fast on unsupported attachment states.
5. Route intent and select skills.
6. Assemble provider prompt.
7. Execute provider request through `ProviderExecutor`.
8. Convert provider tool calls into `ToolCallPlan`s.
9. Execute tools through `ToolExecutor` with security decisions.
10. Re-assemble provider continuation prompt if tool results require another model turn.
11. Persist messages/events/tool results/trajectory.
12. Return final text plus artifacts to CLI or channel.

### Storage and state roots

Unless overridden by config, the main runtime state lives under `~/.estacoda/`:

- `config.json`
- `trust.json`
- `sessions.sqlite`
- `channel-media/`
- `channel-approvals.json`
- `skills/`
- memory files such as `SOUL.md`, `USER.md`, `MEMORY.md`, `AGENTS.md`

Project-local overlays live under `<workspace>/.estacoda/` and can override or extend config, memory, project skills, and generated operator artifacts.

## 5. Important Files

- [src/index.ts](/Users/ahnwy/estacoda-v2/src/index.ts)
  Main entrypoint. Best place to understand startup modes.

- [src/runtime/create-runtime.ts](/Users/ahnwy/estacoda-v2/src/runtime/create-runtime.ts)
  Runtime composition root. Most important architectural file.

- [src/runtime/agent-loop.ts](/Users/ahnwy/estacoda-v2/src/runtime/agent-loop.ts)
  Core agent orchestration. If behavior feels “wrong,” it is usually here or in prompt assembly.

- [src/prompt/prompt-assembly.ts](/Users/ahnwy/estacoda-v2/src/prompt/prompt-assembly.ts)
  Prompt layering and attachment/skill/tool-result injection.

- [src/providers/provider-executor.ts](/Users/ahnwy/estacoda-v2/src/providers/provider-executor.ts)
  Provider route execution, fallback behavior, and tool-call stream collection.

- [src/providers/openai-compatible-provider.ts](/Users/ahnwy/estacoda-v2/src/providers/openai-compatible-provider.ts)
  Network transport for OpenAI-compatible providers.

- [src/providers/auxiliary-provider-router.ts](/Users/ahnwy/estacoda-v2/src/providers/auxiliary-provider-router.ts)
  Defines auxiliary routes including `vision` and the dedicated `approval` assessor lane.

- [src/config/runtime-config.ts](/Users/ahnwy/estacoda-v2/src/config/runtime-config.ts)
  Config schema, merging, provider registry construction, channel config, and setup helpers.

- [src/channels/channel-gateway.ts](/Users/ahnwy/estacoda-v2/src/channels/channel-gateway.ts)
  Channel session handling, approvals, commands, and runtime bridging.

- [src/channels/channel-session-store.ts](/Users/ahnwy/estacoda-v2/src/channels/channel-session-store.ts)
  Persisted channel-session mapping, normalized session-key policy, and auto-reset lifecycle logic.

- [src/channels/gateway-runner.ts](/Users/ahnwy/estacoda-v2/src/channels/gateway-runner.ts)
  Telegram gateway startup path and diagnostics.

- [src/channels/telegram-adapter.ts](/Users/ahnwy/estacoda-v2/src/channels/telegram-adapter.ts)
  Telegram polling, attachment download, send/edit progress messages, callback handling.

- [src/channels/telegram-format.ts](/Users/ahnwy/estacoda-v2/src/channels/telegram-format.ts)
  Telegram final-reply formatting layer.

- [src/channels/channel-approval-store.ts](/Users/ahnwy/estacoda-v2/src/channels/channel-approval-store.ts)
  Persistent approval storage.

- [src/tools/tool-executor.ts](/Users/ahnwy/estacoda-v2/src/tools/tool-executor.ts)
  Applies security decisions, target keys, tool execution, and result persistence.

- [src/tools/vision-tools.ts](/Users/ahnwy/estacoda-v2/src/tools/vision-tools.ts)
  Vision-backed image analysis via the auxiliary vision route.

- [src/skills/skill-tools.ts](/Users/ahnwy/estacoda-v2/src/skills/skill-tools.ts)
  Skill management surface.

- [src/skills/skill-loader.ts](/Users/ahnwy/estacoda-v2/src/skills/skill-loader.ts)
  Skill parsing, hydration, and resource discovery.

- [src/skills/skill-visibility.ts](/Users/ahnwy/estacoda-v2/src/skills/skill-visibility.ts)
  Hermes-style session visibility filtering.

- [src/memory/local-memory-provider.ts](/Users/ahnwy/estacoda-v2/src/memory/local-memory-provider.ts)
  Current memory write path.

- [src/session/sqlite-session-db.ts](/Users/ahnwy/estacoda-v2/src/session/sqlite-session-db.ts)
  Persistent session/event/message store used by the gateway.

- [src/smoke.ts](/Users/ahnwy/estacoda-v2/src/smoke.ts)
  Current regression net. Very important.

- [docs/INTERNAL_ALPHA_RUNBOOK.md](/Users/ahnwy/estacoda-v2/docs/INTERNAL_ALPHA_RUNBOOK.md)
  Manual operator runbook for real alpha passes.

- [NEXT_PHASE_ROADMAP.md](/Users/ahnwy/estacoda-v2/NEXT_PHASE_ROADMAP.md)
  Current tracked roadmap.

- [docs/EVALUATION.md](/Users/ahnwy/estacoda-v2/docs/EVALUATION.md)
  Phase 0 evaluation-substrate overview for future self-evolution work.

- [scripts/eval-substrate.ts](/Users/ahnwy/estacoda-v2/scripts/eval-substrate.ts)
  Generates a repeatable evaluation run folder and task manifest from `evals/tasks`.

## 6. Execution Flow

### Startup

1. `src/index.ts` loads runtime config from:
   - `~/.estacoda/config.json`
   - `<workspace>/.estacoda/config.json`
2. If interactive and onboarding is needed, onboarding can run first.
3. `buildRuntime()` calls `createRuntime()`.

### Runtime creation

`createRuntime()` does the following:

1. Initializes stores and registries.
2. Loads provider models and auxiliary routes.
3. Loads official skills, then personal/project/external skills.
4. Registers tools:
   - builtin tools
   - Python tools
   - web tools
   - workspace tools
   - media tools
   - vision tools
   - process tools
   - trust/config/onboarding/memory/delegation tools
5. Filters visible skills for the current runtime session.
6. Creates:
   - `IntentRouter`
   - `ProviderExecutor`
   - `ToolExecutor`
   - `AgentLoop`

### Input handling

For CLI or channels:

1. Incoming text and attachments are normalized.
2. Session DB records the user message.
3. Attachment preflight may short-circuit on unsupported/missing/too-large states.
4. Intent router selects labels and candidate skills.
5. Security decision is computed.

### Provider + tool loop

1. `assembleProviderPrompt()` builds a layered prompt.
2. `ProviderExecutor.complete()` sends the prompt to the chosen provider route.
3. Provider tool calls are turned into `ToolCallPlan`s.
4. `ToolExecutor` runs tools under security policy.
5. Tool results are packetized back into continuation prompts.
6. `assembleProviderContinuationPrompt()` drives the next provider turn if needed.
7. Final text, artifacts, skill outcomes, and progress are returned.

### Memory and persistence

Current persistence paths:

- session messages/events -> session DB
- trajectory events -> `TrajectoryRecorder`
- memory files -> `MemoryStore` / `LocalMemoryProvider`
- skill outcomes -> appended to configured memory targets

### Channel flow

For Telegram:

1. `gateway-runner.ts` constructs gateway + adapter.
2. `TelegramAdapter.pollOnce()` pulls updates.
3. Attachments are downloaded into `~/.estacoda/channel-media/...`.
4. `ChannelGateway.receive()` normalizes session identity, applies session lifecycle policy, then handles auth, commands, runtime invocation, approvals, and delivery.
5. Progress is sent as one evolving edited Telegram message.
6. Final text is formatted by `telegram-format.ts`.

## 7. Known Bugs / Weak Areas

- Telegram image vision path is live-proven with Kimi, but not yet broadly live-proven across providers after the native-main-route wiring.
- Live provider support is strongest for OpenAI-compatible providers; catalog-only providers are discovery-only.
- Memory promotion is off the pre-routing full-scan path, but a future idle/background queue could make promotion fully non-blocking after response delivery.
- Telegram final reply formatting is much better than before, but still not full Hermes parity.
- Channel verbosity/profile controls are not implemented yet.
- CLI now resumes the active workspace session across launches through a persisted CLI session pointer. `smoke-tested`
- Session-admin UX now has a first real surface (`/sessions`, `/search`, `/switch`) in both CLI and channel flows, but it is still thinner than Hermes overall. `smoke-tested`
- Internal alpha harness is strong but still manual; it is not a full release gate yet.
- `doctor --live` can return successful status with empty response text for some providers. This is noted but not fully improved.
- CLI multiline paste ergonomics are still rough in interactive mode.
- Some success paths are stronger in smoke than in live multi-provider testing.
- Prompt/history packing has baseline regression coverage for latest-user survival, recent tool context, and older-turn summarization; deeper output-reserve and frozen-memory compression tests are still useful.

## 8. Design Decisions

- **Hermes alignment first**
  Skills are session-stable, progressively disclosed, and executed through the normal provider/tool loop.

- **Separate v2 codebase**
  v2 was intentionally rebuilt rather than evolved from v1 to avoid carrying old assumptions.

- **TypeScript runtime + Python execution lane**
  Orchestration stays in TypeScript; code/doc/media execution capabilities can go through Python.

- **Capability-first security**
  Trust and approval behavior are tied to tool/risk/target rather than raw text.
  Public approval modes are now `strict`, `adaptive`, and `open`, with `adaptive` as the default.
  `adaptive` now supports an optional auxiliary assessor after deterministic triage, while the dangerous-command floor remains non-overridable.
  `/yolo` now toggles session-scoped `open` mode in CLI and gateway sessions, while preserving the non-overridable hard floor.
  Channel and CLI approval scopes now both support `once`, `session`, and `always`, while ACP remains narrower because of editor permission-card constraints.
  The hard floor now explicitly covers broad destructive deletes, disk-destructive commands, system power commands, fork-bomb or kill-all patterns, explicit secret reads including environment dumps, pipe-to-interpreter installs, destructive inline Python/Node/Bun/Deno code, and git force-pushes.
  CLI operators can inspect the last security decisions with `/security`, or use `/security debug` for target keys, deterministic rules, and assessor status.

- **Local-first skill mutation**
  External skill roots are read-only. Agent-authored or edited skills write into the local personal skill home.

- **Session-stable skill visibility**
  New skills do not silently mutate provider-visible context mid-session; `/reset` is the boundary.

- **Telegram as first adapter, not a special-case architecture**
  Telegram is implemented through the generic channel gateway contracts.

- **Auxiliary route architecture**
  Non-main tasks such as `vision` use auxiliary provider routing rather than ad hoc branching.

## 9. Rejected Approaches

- **Pre-executing skill workflows before the provider turn**
  Rejected because it drifted away from Hermes and made skills feel like hidden local macros.

- **Mid-session live mutation of provider-visible skill catalogs**
  Rejected because Hermes semantics are session-stable with explicit refresh.

- **Unstructured persistent approvals**
  Rejected. Persistent approvals now match on structured target keys, not loose summaries.

- **Treating channel attachments as fake user text**
  Rejected. Attachments are first-class structured runtime inputs.

- **Spamming Telegram with one message per progress event**
  Rejected in favor of one edited progress message per active turn.

## 10. Current Tests / Smokes

Primary checks:

```bash
cd /Users/ahnwy/estacoda-v2
/Users/ahnwy/.bun/bin/bun run typecheck
/Users/ahnwy/.bun/bin/bun run smoke
```

What smoke currently covers at a high level:

- provider routing, explicit provider/model execution, metadata catalog fallback, and fallback behavior
- tool-call recovery behavior
- runtime prompt assembly invariants
- skill loading, visibility, mutation, resources, and package behavior
- Telegram progress, approvals, callbacks, attachments, and formatting
- gateway diagnostics
- auxiliary routing basics
- vision-backed image attachment flow in smoke

Important nuance:

- smoke proves the runtime can route images to both native main-route vision and `vision.analyze` fallback paths
- Kimi live image understanding is proven
- other providers still require a configured and actually usable vision-capable route plus operator proof
- if no vision route is available, image attachments fall back to metadata-only inspection rather than semantic image understanding

Manual operator path:

- [docs/INTERNAL_ALPHA_RUNBOOK.md](/Users/ahnwy/estacoda-v2/docs/INTERNAL_ALPHA_RUNBOOK.md)

Harness:

```bash
cd /Users/ahnwy/estacoda-v2
/Users/ahnwy/.bun/bin/bun run alpha:harness
```

Evaluation substrate:

```bash
cd /Users/ahnwy/estacoda-v2
/Users/ahnwy/.bun/bin/bun run eval:substrate
```

## 11. Environment Setup

Install / bootstrap:

```bash
cd /Users/ahnwy/estacoda-v2
/Users/ahnwy/.bun/bin/bun install
```

Typecheck:

```bash
cd /Users/ahnwy/estacoda-v2
/Users/ahnwy/.bun/bin/bun run typecheck
```

Smoke tests:

```bash
cd /Users/ahnwy/estacoda-v2
/Users/ahnwy/.bun/bin/bun run smoke
```

Live provider checks:

```bash
cd /Users/ahnwy/estacoda-v2
export KIMI_API_KEY='REDACTED'
/Users/ahnwy/.bun/bin/bun run dev -- doctor --live
```

Interactive CLI session:

```bash
cd /Users/ahnwy/estacoda-v2
/Users/ahnwy/.bun/bin/bun run dev
```

Key env vars by provider:

- `KIMI_API_KEY`
- `DEEPSEEK_API_KEY`
- `OPENROUTER_API_KEY`
- `OPENAI_API_KEY`
- `GOOGLE_API_KEY`
- `ANTHROPIC_API_KEY`

Telegram:

- `ESTACODA_TELEGRAM_BOT_TOKEN`

Vision-capable live image analysis:

- requires either a vision-capable main route or, preferably, an auxiliary `vision` route in config
- if the active provider cannot accept image content, Telegram image tasks will degrade to metadata-only responses

Config files:

- user config: `~/.estacoda/config.json`
- project config: `<workspace>/.estacoda/config.json`
- reference environment guide: [ENVIRONMENT.md](/Users/ahnwy/estacoda-v2/docs/ENVIRONMENT.md)

Important runtime state paths:

- trust store: `~/.estacoda/trust.json`
- session DB: `~/.estacoda/sessions.sqlite`
- channel media: `~/.estacoda/channel-media/`
- channel approvals: `~/.estacoda/channel-approvals.json`
- personal skills: `~/.estacoda/skills/`
- project skills: `<workspace>/.estacoda/skills/`

Credential placeholders:

- Never hardcode real provider keys into config.
- Prefer provider env names in config and local secret storage in `~/.estacoda/.env` with `0600` permissions.
- Advanced/operator paths may reference pre-existing shell environment variables instead of storing a new secret.
- Do not commit secret-bearing shell history or screenshots.

## 12. Next Milestone

Correct next milestone: **MVP hardening after strong internal alpha**.

Best next development target:

1. Broaden live Telegram image verification beyond Kimi. `implemented but not live-proven`
2. Harden OpenRouter exactness/instruction fidelity after the live provider batch. OpenRouter runtime path is `live-proven`; exactness-sensitive tasks are still partial.
3. Extend skill evolution beyond the minimal overlay
   - add real task fixtures beyond metadata/workflow scoring, richer human-facing review UI, and eventual per-skill portable sidecars `intended but not implemented`
4. Expand the evaluation substrate into a scored skill-first benchmark layer. `implemented but not live-proven`
5. Finish onboarding/distribution polish. `intended but not implemented`

This is the shortest honest path from strong internal alpha to a private MVP candidate.

## 13. Do Not Break

- Session-stable skill visibility and `/reset` semantics.
- Progressive skill/resource disclosure.
- External skill directories must remain read-only.
- Approval matching must stay on structured target keys, not display text.
- Telegram progress must remain a single edited status message per active turn.
- Attachment failures must remain clean and non-crashing.
- Secrets must never be injected into provider prompts.
- Trusted workspace behavior should remain proactive while still gating genuinely risky actions.
- Channel gateway should remain adapter-based, not Telegram-special-cased in architecture.
- Session identity, approval scope, and active-turn keys must stay aligned under shared-thread/group policies.

## 14. Open Questions

- What should the long-term threshold and patch/update policy be for autonomous workflow skills beyond the current `none | suggest | proactive | autonomous` ladder?
- What should the first real channel verbosity/profile model look like?
- Should the gateway become a true daemon/service with liveness tracking, or remain foreground-first?
- What is the right packaging/distribution shape for MVP: Bun-based install, npm wrapper, packaged binary, Homebrew, or multiple?
- Which non-Telegram channel is next at launch, and does it share the same approval UX model?
- Should the vision route be configured as an explicit separate user-facing setup surface during onboarding?
- What should the Hermes/OpenClaw migration story be: documentation-only, import tooling, partial compatibility layer, or something deeper?
- How should local/open-source model support be explained and constrained for users, especially around tool-calling and vision differences?
- Do profiles/modes belong in config, memory, channel settings, or all three?
- Is voice input a core MVP-adjacent feature or a post-MVP channel enhancement?
