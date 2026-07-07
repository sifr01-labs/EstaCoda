---
title: "Providers"
description: "Provider architecture: registry, routing, execution, and credential resolution."
---

# Providers

EstaCoda supports multiple LLM providers with capability-based routing, direct `apiKeyEnv` credential resolution for credentialed routes, `authMethod: "none"` for no-auth routes, and auxiliary routes for specialized tasks.

## Files

| File | Role |
|------|------|
| `src/providers/provider-executor.ts` | Streaming execution, fallback handling, and provider result normalization |
| `src/providers/openai-compatible-provider.ts` | Chat Completions-compatible inference adapter |
| `src/providers/openai-responses-provider.ts` | Responses-compatible provider path used by Codex |
| `src/providers/provider-registry.ts` | Provider registration and discovery |
| `src/providers/provider-metadata.ts` | Provider capability, visibility, configurability, and auth metadata |
| `src/providers/auxiliary-model-resolver.ts` | Resolve auxiliary model routes |
| `src/providers/model-catalog.ts` | Model profile resolution |
| `src/model-catalog/models-dev-registry.ts` | models.dev metadata registry |

## Supported Providers

| Provider | Status | Evidence |
|----------|--------|----------|
| Kimi | Full pass | `live-proven` |
| OpenAI | Full pass | `live-proven` |
| DeepSeek | Full pass | `live-proven` |
| OpenRouter | Runtime works; exactness partial | `live-proven` |
| Local / Custom Endpoint | Built-in `local` provider for Ollama, LM Studio, llama.cpp, vLLM, LiteLLM, or another OpenAI-compatible endpoint. Default no-auth, optional `OPENAI_COMPATIBLE_API_KEY`. | `implemented but not live-proven` |
| Google | Configurable | `implemented but not live-proven` |
| Anthropic | Catalog-known, not runnable | `catalog-known` |

## Architecture

Two layers:

**1. Registry / Routing**
- Offline-first model catalog enriched from models.dev metadata
- Provider registry with route selection by capability and preference
- Direct credential lookup from provider `apiKeyEnv` to `process.env` for credentialed routes
- Explicit no-auth handling for routes such as the default `local` provider

**2. Execution**
- `ProviderExecutor`: streaming token collection, tool-call fragment assembly, fallback handling
- `OpenAICompatibleProvider`: chat completions with tool schema support

## Request Timeouts

Main provider routes use two timeout budgets:

| Field | Default | Scope |
|-------|---------|-------|
| `timeoutMs` | `1800000` | Total provider request budget, including response-body parsing. |
| `staleTimeoutMs` | `120000` | No-progress budget. Non-streaming calls use this for time-to-response-headers only; streaming calls reset it after received response bytes. |

Timeout precedence is route-specific:

```text
model.timeoutMs / model.fallbacks[].timeoutMs
→ providers.<id>.timeoutMs
→ 1800000

model.staleTimeoutMs / model.fallbacks[].staleTimeoutMs
→ providers.<id>.staleTimeoutMs
→ 120000
```

Example:

```json
{
  "model": {
    "provider": "kimi",
    "id": "kimi-k2.6",
    "timeoutMs": 1800000,
    "staleTimeoutMs": 120000
  },
  "providers": {
    "kimi": {
      "timeoutMs": 1800000,
      "staleTimeoutMs": 120000
    }
  }
}
```

`staleTimeoutMs` is intentionally transport-oriented. For non-streaming requests it stops requests that do not return headers. After headers arrive, the stale timer is disabled and the total timeout governs body parsing. For streaming requests it remains active and resets after received bytes, so a stream can run for a long time while still failing closed if it stops producing data.

Auxiliary model route timeouts remain separate through `auxiliaryModels.*.timeoutMs`; this provider-route stale timeout does not add auxiliary stale-timeout behavior. CLI setup commands do not expose timeout flags in this implementation; edit profile config directly for timeout tuning.

## Final State Metadata

Provider output is not treated as usable until the runtime has a finalized provider response. Streaming token text can be shown while a request is in flight, but canonical assistant content, tool calls, retries, and session writes use the finalized `ProviderResponse` and `ProviderExecutionResult`.

Normalized finish reasons are:

| Finish reason | Meaning | Runtime behavior |
|---------------|---------|------------------|
| `stop` | Provider reported a normal stop. | The response can proceed to tool planning or final assistant output. |
| `length` | Provider stopped at its output limit. | Visible text can enter text continuation. Tool calls are treated as unsafe until retried. Reasoning-only length exhaustion returns safe visible guidance. |
| `tool_calls` | Provider finalized tool calls. | Finalized tool calls can be planned and executed through the normal tool safety path. |
| `content_filter` | Provider stopped for policy/filtering. | The runtime does not text-continue filtered visible text. Operators should inspect provider policy, prompt content, and route choice. |
| `incomplete` | Provider indicated an incomplete response. | The execution is not treated as a complete answer unless a later fallback succeeds. |
| `unknown` | Provider finalized transport without a provider-specific reason. | Chat Completions streaming may finalize visible-only transport completion with `unknown`; tool-fragment streams without explicit final metadata still fail. |

`finishReason: "length"` has two separate safety paths:

- Visible text with no tool calls may continue on the same successful route. Continuation concatenates visible `response.content` only.
- Tool calls produced under `length` are not executed from the first attempt. The runtime retries once on the successful route chain. If the retry is still length-truncated with tool calls, EstaCoda returns a deterministic refusal instead of executing incomplete arguments.

Finalized malformed tool JSON remains a tool-planning error. It is not reclassified as provider failure, incomplete stream, or truncated-tool refusal. This distinction matters when debugging: provider execution succeeded, but the tool planner rejected unusable finalized arguments.

Incomplete streams remain provider failures. Partial streamed tool fragments are discarded and are not surfaced as finalized tool calls. The `transport-done` marker used for `[DONE]` is internal stream-collector state, not user-visible text and not a session message.

Provider usage metadata is normalized as:

| Field | Meaning |
|-------|---------|
| `inputTokens` | Provider-reported prompt/input tokens |
| `outputTokens` | Provider-reported completion/output tokens |
| `totalTokens` | Provider-reported total tokens |
| `reasoningTokens` | Provider-reported reasoning token telemetry |

`reasoningTokens` is safe usage telemetry only. It does not mean raw reasoning was available, extracted, stored, displayed, summarized, or sent back to a provider. Raw reasoning, when an adapter can extract it for turn-local handling, is kept out of attempts, runtime events, session messages, summaries, memory, skill learning, and normal exports. Safe `reasoningMetadata` may record only presence, character count, and format.

Operators can inspect provider final-state behavior through runtime `provider-result` events and session `provider-completion` / `provider-continuation` events. These events include finish reason, incomplete reason, usage, safe reasoning metadata, fallback status, and safe `runtimeMetadata` for truncation or continuation. They do not include raw provider payloads, raw reasoning, or discarded truncated tool arguments.

## Native Tool-Call Replay

EstaCoda can preserve finalized provider tool-call turns and replay them as provider-native history for supported OpenAI-compatible Chat Completions routes. The feature exists so a model can see its prior assistant `tool_calls` and linked `tool` replies in the protocol shape it expects, instead of only as prose in flat session history.

Replay is gated by resolved route metadata, model capability, and API mode:

| Gate | Required value |
|------|----------------|
| Provider route | `supportsNativeToolHistory === true` |
| Model profile | `supportsTools === true` |
| API mode | `openai_chat_completions` |

Unsupported routes keep the existing flat text fallback. Responses API routes remain fallback/deferred. Anthropic native replay remains deferred. Do not assume every OpenAI-compatible provider supports native replay just because it shares a request shape.

### Provider tool-call turns

The runtime persists a provider tool-call turn after Wave 1 finalization and ID normalization, before tool planning and execution. The persisted session message is an `agent` message with `metadata.kind === "provider-tool-call-turn"`.

Rules:

- Stable tool-call IDs are shared by persistence and `ToolCallPlanner`; there is no second ID path.
- The same IDs flow into tool result metadata as `tool_call_id`.
- Non-empty assistant content is preserved on the provider tool-call turn.
- No synthetic tool results are created during persistence.
- Invalid, denied, blocked, or failed tool outcomes remain normal tool planning/execution outcomes.

### Turn-level replay safety

`nativeReplaySafe` is a turn-level flag. Native replay is all-or-nothing per provider tool-call turn.

If any call in the turn contains obvious credential material, the whole turn is unsafe for native replay. Secret-bearing calls omit faithful `argumentsText` and mark the affected call with `argumentsRedacted: true`. Unsafe turns do not emit native assistant `tool_calls` or matching native `tool` messages; they remain available only through sanitized flat or summarized text.

This is intentionally conservative. A mixed safe/unsafe multi-call assistant turn is still one assistant protocol turn, so replaying only part of it would produce a transcript the provider never actually saw.

### Budget-selected native suffix

Native history selection operates over raw session messages before irreversible flat summarization. It selects the largest chronological suffix of atomic units that fits the native-history budget after reserving room for system/context/current-user layers and summary text.

Atomic units are:

- ordinary session messages
- provider tool groups: `agent(provider-tool-call-turn)` plus following matching tool results

Selected native units bypass semantic compression and become provider messages. Unselected older units remain available for summary/compression. The current user message is excluded from native history selection and appended once at the end of the provider prompt.

### Provider replay echo

Some thinking-mode providers require replaying prior `reasoning_content` on assistant tool-call turns. EstaCoda stores that data only as `providerReplayEcho`, a bounded private provider protocol field inside provider-tool-call-turn metadata.

`providerReplayEcho` is sensitive persisted state. It is raw provider reasoning retained only for same-provider/API-mode protocol replay. It is not UI text, normal prompt text, memory, summary input, export material, diagnostics content, or logs. It is removed before semantic compression input is constructed and stripped for cross-provider replay.

Rules:

- Store echo only for routes that both support native replay and require echo.
- Store echo only when the whole provider tool-call turn remains `nativeReplaySafe`.
- Missing or oversized required echo disables native replay for that turn unless a provider has an explicitly tested placeholder path.
- DeepSeek and Kimi thinking-mode Chat Completions routes use `reasoning_content` echo when metadata and same-provider/API-mode checks match.
- MiMo is represented in the provider echo contract but must not be documented as enabled unless provider metadata and tests enable it.

Storage tradeoff: if session metadata is not encrypted/private, `providerReplayEcho` is still sensitive persisted state. If EstaCoda later adds encrypted private session metadata, this field should move there.

### Diagnostics

Native replay diagnostics persist as session events:

| Event | Meaning |
|-------|---------|
| `structured-tool-history-selected` | Native history was selected for provider prompt context. |
| `structured-tool-history-repaired` | Builder repaired countable structure, such as dropped orphan tool messages or injected known missing-result stubs. |
| `structured-tool-history-skipped` | Native replay was skipped for a coarse reason. |
| `structured-tool-history-serialized` | Structured native history was present in provider-bound Chat Completions context. |

Payloads are counts and coarse reasons only: provider, model, route role, native pair counts, skipped/repair counts, echo counts, and reason enums such as `provider_unsupported`, `model_tools_unsupported`, `budget_fallback`, `missing_echo`, `echo_oversized`, or `unsafe_arguments`.

Diagnostics must not contain raw arguments, tool results, echo values, raw reasoning, provider payloads, message content, paths, hashes, request bodies, stack traces, or content fingerprints. If you find those in diagnostic events, treat it as a bug.

## Route Output Limits

Primary routes can set a route-level output cap:

```yaml
model:
  provider: openai
  id: gpt-4.1
  maxTokens: 8192
```

The selected profile config is JSON on disk; the YAML above shows the shape. The same `maxTokens` route field is preserved through model aliases, fallback routes, `/model` session overrides, and session override reconstruction.

Normalization rules:

| Input | Result |
|-------|--------|
| unset, `null`, empty string, or whitespace | unset; provider default applies |
| positive integer string, for example `"8192"` | accepted and normalized to `8192` |
| positive integer number, for example `8192` | accepted |
| `0`, negative values, floats, and non-numeric strings | rejected |

Request-level `maxTokens` still wins over route-level `maxTokens`, but it is call-local. It does not mutate profile config, routes, aliases, fallback routes, session model overrides, runtime fingerprints, or diagnostics.

Provider diagnostics display `Max output tokens: provider default` when the route value is unset. Configured integers are displayed directly. Values below `2048` warn because they are likely to increase truncation, tool-call refusal, or continuation attempts. Repair is ordinary config repair: edit the selected profile config through setup/model tooling or remove the cap to return to provider defaults.

The provider request parameter name depends on the API mode:

| API mode | Token cap parameter |
|----------|---------------------|
| OpenAI direct Chat Completions | `max_completion_tokens` |
| Third-party OpenAI-compatible Chat Completions | `max_tokens` by default |
| Provider metadata override | The metadata-selected chat token parameter |
| OpenAI Responses API | `max_output_tokens` |

Unset caps send no token parameter. Defensive request construction also omits token cap parameters for `null` or `0`.

## Route-Aware Retries And Continuation

Fallback identity is part of finalization behavior. Retry and continuation begin from the route that produced the successful-but-finalization-sensitive response, then preserve later fallbacks.

Examples:

| Original route chain | Successful route | Retry or continuation chain |
|----------------------|------------------|-----------------------------|
| `primary -> fallbackA -> fallbackB` | `primary` | `primary -> fallbackA -> fallbackB` |
| `primary -> fallbackA -> fallbackB` | `fallbackA` | `fallbackA -> fallbackB` |
| `primary -> fallbackA` | `fallbackA` | `fallbackA` |

This applies to truncated tool-call retry and length-truncated visible text continuation. The runtime does not restart at the original primary after a fallback has already succeeded. Provider failure and fallback behavior still applies inside the sliced chain.

Text continuation adds local-only provider messages:

```json
[
  { "role": "assistant", "content": "<partial visible text>" },
  {
    "role": "user",
    "content": "Your previous response was truncated by the output length limit. Continue exactly where you left off. Do not repeat previous text."
  }
]
```

Those synthetic messages are not persisted and are not emitted as user or assistant output. Continuation concatenates visible response content only, trims exact suffix/prefix overlap, and records safe continuation metadata when available. If all continuation attempts are still length-truncated, the best visible partial is returned without appending a runtime note.

## Streaming Status

OpenAI-compatible Chat Completions streaming is implemented with explicit finalization rules:

- A chunk with a final `finish_reason` finalizes the stream even when usage arrives separately or is absent.
- `[DONE]` is parsed as an internal transport marker.
- Visible-only transport completion without provider finish metadata finalizes as `finishReason: "unknown"`.
- Transport-only tool fragments without final finish metadata fail as `incomplete-stream`.
- Abrupt stream end without transport completion or a final response fails as `incomplete-stream`.

Responses API non-streaming execution is implemented for runnable routes. Responses streaming remains unsupported in this subsystem. If a route requires Responses streaming behavior, treat it as not implemented rather than assuming Chat Completions streaming semantics apply.

## Auxiliary Routes

Auxiliary routes are preference/routing constructs, not separate runtimes:

| Route | Purpose |
|-------|---------|
| `main` | Primary inference |
| `vision` | Image analysis |
| `compression` | Context compression |
| `assessor` | Security assessor |
| `web_extract` | Web extraction |
| `session_search` | Session semantic search |
| `skills_hub` | Skills distribution |
| `mcp` | MCP tool delegation |
| `memory_flush` | Memory operations |
| `delegation` | Subagent delegation |
| `profile_context` | Profile context generation |

Security smart approval uses `auxiliaryModels.assessor`. The route key is exactly `assessor`; there is no `auxiliaryModels.approval` route. The assessor route is resolved with `resolveAuxiliaryModelRoute("assessor", ...)` and consumed through `executeAuxiliaryTask(...)`. The assessor route is configurable through the Setup Editor (`edit-auxiliary-model-route`) in addition to direct config edits.

Config should not use legacy auxiliary names such as `models.auxiliary`, `auxiliary.default`, or `auxiliary.contextualize`. Profile-context CLI/documentation should use `--profile-context`, not `--contextualize`.

Config Part 2 consumes the Providers Pass D auxiliary route contract. It does not add a second auxiliary resolver architecture.

## Session Model Switching

Active CLI and gateway sessions support `/model` as a scoped model switcher. By default, `/model <provider>/<model>` writes a session or conversation override only. `/model set <provider>/<model>` is compatibility syntax for the same scoped override; it is not the old persistent `estacoda model set` mutation path. `/model clear` removes the scoped override.

The same model-switch resolver validates CLI typed commands, gateway typed commands, plain-text picker selections, and picker action callbacks. It accepts only already configured runnable routes, preserves direct alias route metadata such as `baseUrl`, `apiKeyEnv`, `apiMode`, and `authMethod` when available, and rejects missing credentials with terminal setup guidance. It does not collect credentials or OAuth tokens inside active sessions or chats.

Scoped overrides persist with the session and are revalidated whenever a runtime is constructed. If the stored route becomes stale, non-runnable, catalog-only, media-only, credential-missing, or otherwise invalid, the override is ignored non-fatally and the configured primary route is used. No raw secrets are stored in session override state or picker action payloads. Fallback routes and auxiliary routes are preserved.

`/model --global <provider>/<model>` and `/model set --global <provider>/<model>` are the explicit persistent forms. They mutate only the profile-level primary model route after the required local or gateway trust/authorization checks pass. `/model --global clear` is rejected. `estacoda model set ...` remains deprecated and disabled; `estacoda model setup` remains the supported surface for credential collection and primary provider setup. Fallback routes are manageable through both the Setup Editor (`edit-fallback-model-route`) and `estacoda model fallback ...`. Auxiliary route management is available through the Setup Editor (`edit-auxiliary-model-route`).

## Delegated Child Model Overrides

`delegate_task` may request a child `modelOverride`. Same-provider model overrides and reviewed cross-provider child routes are supported. Overrides are request-local: they affect only the child loop being constructed and do not mutate profile config, session model overrides, parent fallback routes, auxiliary routes, or provider preferences outside that child.

Cross-provider child routes are derived from the normalized target provider config, not from parent route internals. The executable child route preserves target `baseUrl`, `apiKeyEnv`, `apiMode`, `authMethod`, `enableNetwork`, `timeoutMs`, and `staleTimeoutMs` where configured. Provider preference for the child is set to the target provider only, and fallback routes are disabled with `fallbackBehavior: "disabled-for-override"`.

Credential handling uses the existing provider config and `apiKeyEnv` path. Credential pools are not introduced. `authMethod: "none"` does not require credentials when configured for the target provider. Env-backed missing credentials reject before child session/provider execution. `enableNetwork: false` rejects before child execution with structured override metadata. Literal credential routes or unsupported credential forms are rejected rather than copied into child metadata.

Override metadata is bounded and redacted. It must not include raw API keys, env values, raw route objects, private config paths, prompts, diagnostics payloads, or transcripts.

## Memory-Related Routes

Memory Hardening uses distinct auxiliary route names:

| Route | Used By | Must Not Be Confused With |
|-------|---------|---------------------------|
| `session_search` | `SessionRecallService` manual/runtime recall summaries | raw SQLite FTS search |
| `memory_compaction` | Memory File Compaction for `USER.md` / `MEMORY.md` | semantic session compression |
| `compression` | Semantic session compression for session history | Memory File Compaction |

All three routes resolve through `resolveAuxiliaryModelRoute(...)` and execute through provider infrastructure. Missing routes fail closed or fall back as documented by the calling subsystem.

Transcript-preserving semantic compaction is a session DB/runtime lineage behavior layered around the `compression` route. It does not involve external memory providers, vector search, embeddings, or the `memory_compaction` route.

## External Memory Provider

External memory providers are not LLM providers. They implement a memory lifecycle contract and are wired from runtime config under `externalMemory`.

In this implementation, active runtime orchestration uses external providers for bounded recall and opt-in shared memory mutation mirror writes. The contract and file-backed provider also define `afterTurn` and `flushSession` hooks, but those hooks are reserved for future orchestration unless invoked directly; the runtime does not actively call them yet.

Implemented provider:

| Provider | Status | Storage | Notes |
|----------|--------|---------|-------|
| `file` | Implemented, disabled by default | `~/.estacoda/profiles/<id>/external-memory/*.jsonl` | Local file-backed external memory for lifecycle proof |

Config shape:

```json
{
  "externalMemory": {
    "enabled": true,
    "provider": "file",
    "timeoutMs": 750,
    "maxResults": 3,
    "maxChars": 2500,
    "mirrorWrites": false,
    "file": {
      "path": "external-memory.jsonl",
      "maxEntries": 1000
    }
  }
}
```

Defaults:

| Key | Default | Notes |
|-----|---------|-------|
| `externalMemory.enabled` | `false` | Also requires a non-empty `provider` id |
| `externalMemory.provider` | unset | Only `file` constructs a built-in provider |
| `externalMemory.timeoutMs` | `750` | Clamped to a positive value, max `5000` |
| `externalMemory.maxResults` | `3` | Clamped to a positive value, max `10` |
| `externalMemory.maxChars` | `2500` | Clamped to a positive value, max `20000` |
| `externalMemory.mirrorWrites` | `false` | Opt-in mirroring for shared memory mutation writes |
| `externalMemory.file.path` | `external-memory.jsonl` | Relative to the profile `external-memory/` directory |
| `externalMemory.file.maxEntries` | `1000` | Clamped to a positive value, max `10000` |

Absolute file paths are rejected. Relative paths must stay under the selected profile's `external-memory/` directory. External memory failures are isolated as warnings and must not block local memory, session recall, provider turns, semantic compression, or memory-file compaction.

Provider status diagnostics are redacted by helper functions in `src/memory/external-memory-provider.ts`. There is no standalone user-facing external memory status CLI command in this implementation.

External provider observability is best-effort and metadata-only:

| Event | Emitted From | Contents |
|-------|--------------|----------|
| `external-memory-recall` | `MemoryRecallOrchestrator` external recall path | provider id, enabled/attempted flags, result count, bounded total character count, warning/failure count, safe scope metadata, redacted/bounded failure reason |
| `external-memory-mirror-write` | Shared memory mutation mirror-write path | provider id, mirror enabled/attempted/success flags, local write success, safe memory kind/file metadata, bounded entry size, safe scope metadata, redacted/bounded failure reason |

These audit events do not include raw recalled content, raw mirrored memory content, credentials, or provider secrets. Event recording failure is non-fatal and must not block local memory prompt inclusion, shared memory mutations, recall, mirror-write behavior, provider turns, semantic compression, or memory-file compaction. Local memory remains authoritative.

## Web Research Providers

Web research providers are separate from LLM providers. The registry supports capability-based selection for `search`, `extract`, and `crawl`, and runtime config can name `web.backend`, `web.searchBackend`, `web.extractBackend`, or `web.crawlBackend`.

Current provider state:

| Provider | Capabilities declared | Status |
|----------|-----------------------|--------|
| Brave | search | Implemented live provider; requires `web.brave.apiKeyEnv` and defaults to `BRAVE_SEARCH_API_KEY` |
| DDGS | search | Implemented managed Python provider; requires registered capability `ddgs` to be installed and verified |
| fetch | extract | Implemented fallback for guarded raw fetch extraction |
| Firecrawl | search, extract, crawl | Stub only; unavailable even when configured |
| Parallel | search | Stub only; unavailable even when configured |
| Tavily | search, extract | Stub only; unavailable even when configured |
| Exa | search | Stub only; unavailable even when configured |
| SearXNG | search | Stub only; unavailable even when configured |

Provider selection checks the capability-specific key first, then `web.backend`, then auto-detection. Explicit unavailable providers do not silently fall back. `web.extract` falls back to the guarded fetch extractor only when no explicit unavailable extract provider was configured and no available extract provider was auto-detected. `web.crawl` exists as tool infrastructure, but no live crawl provider is implemented yet.

Brave credentials use the same `apiKeyEnv` reference model as other credentialed providers; raw API keys do not belong in config. DDGS uses the managed Python capability registry and must not install packages during runtime search.

## Cloud Browser Providers

Cloud browser providers are separate from web research providers. Browserbase is implemented through the browser backend, requires `BROWSERBASE_API_KEY` and `BROWSERBASE_PROJECT_ID`, and is blocked until `browser.cloudSpendApproved === true`. `estacoda browser approve-cloud` approves billable session creation, and `estacoda browser revoke-cloud` blocks it again. Direct provider-registry `createSession()` calls for Browserbase still throw because spend approval must be enforced by the backend. browser-use, Firecrawl browser, and Camofox remain deferred provider stubs. Legacy `browser.backend` values `firecrawl` and `camofox` remain accepted for compatibility and report unavailable status; they do not create real cloud sessions.

## Important Distinctions

- The model catalog is enriched from models.dev when cached/bundled data is available, with local fallback profiles as a safety net.
- Catalog-only providers are discovery adapters, not true inference adapters.
- Runtime config loads catalog metadata with `allowNetwork: false` by default.
- Explicit `{ provider, model }` requests are supported by `ProviderExecutor`.
- Chat-capable providers can be live inference routes.
- Vision routing is implemented in code, but live success depends on actual provider capability plus working credentials.
- Smart approval does not build a legacy provider/model assessor fallback. It requires the resolved `auxiliaryModels.assessor` route, the main route, and a provider executor; missing route/config fails safe to manual approval.
- Codex can be configured from the model picker when the nested OpenAI choice is enabled: choose `OpenAI`, then `Codex`. `OpenAI Models` is the API-key OpenAI path; `Codex` is the OAuth path.
- `estacoda model setup codex` remains the direct CLI path. It authenticates through OAuth device code, stores tokens in the selected profile's `auth.json`, and configures the `codex/gpt-5.5` route with provider `codex`, auth method `oauth_device_pkce`, and API mode `openai_responses`. Raw OAuth tokens are not printed, and route config remains separate from token storage.
- The Setup Editor can configure Codex as a primary or fallback route through reviewed apply. OAuth tokens are written only after review approval; cancelling review after OAuth does not persist tokens.
- Codex OAuth setup does not live in the Onboarding Wizard in this pass. If the Onboarding Wizard later offers Codex OAuth, it must delegate to that model setup/OAuth boundary.
- Auxiliary model routes remain unchanged in this pass and do not introduce Codex OAuth setup.
- `estacoda model setup local` configures the built-in Local / Custom Endpoint route. It prompts for or accepts a `baseUrl`, keeps no-auth as the default, and stores an optional key as `OPENAI_COMPATIBLE_API_KEY` through the normal profile `.env` boundary. Endpoint/base URL changes must be reviewed and applied through provider-route drafts, not credential-only drafts.
- `estacoda model setup custom` remains the separate named-provider path for OpenAI-compatible endpoints that should not use the built-in `local` provider ID.
- The Setup Editor uses the same Local / Custom endpoint-first flow for primary, fallback, and auxiliary model routes. Endpoint discovery, manual model entry, optional auth, chat-completion testing, and review are shared; only the reviewed config scope changes.

## Provider Hardening

Run the live acceptance sweep:

```bash
pnpm run provider:hardening
```

This rotates the selected profile provider route across the acceptance set, runs live diagnostics, captures results, and restores the original config.
