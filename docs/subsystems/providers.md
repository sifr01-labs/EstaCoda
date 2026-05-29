---
title: "Providers"
description: "Provider architecture: registry, routing, execution, and credential resolution."
---

# Providers

EstaCoda supports multiple LLM providers with capability-based routing, direct `apiKeyEnv` credential resolution, and auxiliary routes for specialized tasks.

## Files

| File | Lines | Role |
|------|-------|------|
| `src/providers/provider-executor.ts` | ~340 | Streaming execution and tool-call assembly |
| `src/providers/openai-compatible-provider.ts` | 838 | Primary inference adapter |
| `src/providers/provider-registry.ts` | ~180 | Provider registration and discovery |
| `src/providers/auxiliary-model-resolver.ts` | ~160 | Resolve auxiliary model routes |
| `src/providers/model-catalog.ts` | ~180 | Model profile resolution |
| `src/model-catalog/models-dev-registry.ts` | 695 | models.dev metadata registry |

## Supported Providers

| Provider | Status | Evidence |
|----------|--------|----------|
| Kimi | Full pass | `live-proven` |
| OpenAI | Full pass | `live-proven` |
| DeepSeek | Full pass | `live-proven` |
| OpenRouter | Runtime works; exactness partial | `live-proven` |
| Ollama (local) | Architectural; unproven in this env | `implemented but not live-proven` |
| Google | Configurable | `implemented but not live-proven` |
| Anthropic | Configurable | `implemented but not live-proven` |

## Architecture

Two layers:

**1. Registry / Routing**
- Offline-first model catalog enriched from models.dev metadata
- Provider registry with route selection by capability and preference
- Direct credential lookup from provider `apiKeyEnv` to `process.env`

**2. Execution**
- `ProviderExecutor`: streaming token collection, tool-call fragment assembly, fallback handling
- `OpenAICompatibleProvider`: chat completions with tool schema support

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

In this implementation, active runtime orchestration uses external providers for bounded recall and opt-in `memory.curate` mirror writes. The contract and file-backed provider also define `afterTurn` and `flushSession` hooks, but those hooks are reserved for future orchestration unless invoked directly; the runtime does not actively call them yet.

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
| `externalMemory.mirrorWrites` | `false` | Opt-in mirroring for `memory.curate` writes |
| `externalMemory.file.path` | `external-memory.jsonl` | Relative to the profile `external-memory/` directory |
| `externalMemory.file.maxEntries` | `1000` | Clamped to a positive value, max `10000` |

Absolute file paths are rejected. Relative paths must stay under the selected profile's `external-memory/` directory. External memory failures are isolated as warnings and must not block local memory, session recall, provider turns, semantic compression, or memory-file compaction.

Provider status diagnostics are redacted by helper functions in `src/memory/external-memory-provider.ts`. There is no standalone user-facing external memory status CLI command in this implementation.

External provider observability is best-effort and metadata-only:

| Event | Emitted From | Contents |
|-------|--------------|----------|
| `external-memory-recall` | `MemoryRecallOrchestrator` external recall path | provider id, enabled/attempted flags, result count, bounded total character count, warning/failure count, safe scope metadata, redacted/bounded failure reason |
| `external-memory-mirror-write` | `memory.curate` mirror-write path | provider id, mirror enabled/attempted/success flags, local write success, safe memory kind/file metadata, bounded entry size, safe scope metadata, redacted/bounded failure reason |

These audit events do not include raw recalled content, raw mirrored memory content, credentials, or provider secrets. Event recording failure is non-fatal and must not block local memory prompt inclusion, `memory.curate`, recall, mirror-write behavior, provider turns, semantic compression, or memory-file compaction. Local memory remains authoritative.

## Web Research Providers

Web research providers are separate from LLM providers. The registry supports capability-based selection for `search`, `extract`, and `crawl`, and runtime config can name `web.backend`, `web.searchBackend`, `web.extractBackend`, or `web.crawlBackend`.

Current provider state:

| Provider | Capabilities declared | Status |
|----------|-----------------------|--------|
| Firecrawl | search, extract, crawl | Stub only; unavailable even when configured |
| Parallel | search | Stub only; unavailable even when configured |
| Tavily | search, extract | Stub only; unavailable even when configured |
| Exa | search | Stub only; unavailable even when configured |
| SearXNG | search | Stub only; unavailable even when configured |
| Brave | search | Stub only; unavailable even when configured |
| DDGS | search | Stub only; unavailable |
| fetch | extract | Implemented fallback for guarded raw fetch extraction |

`web.search` and `web.crawl` exist as tool infrastructure, but no hosted search/crawl API calls are implemented yet. Explicit unavailable providers do not silently fall back. `web.extract` falls back to the guarded fetch extractor only when no explicit unavailable extract provider was configured and no available extract provider was auto-detected.

## Cloud Browser Providers

Cloud browser providers are separate from web research providers. The registry has stubs for Browserbase, browser-use, Firecrawl, and Camofox. All are unavailable in this release and direct `createSession()` calls throw not-implemented errors. Legacy `browser.backend` values `browserbase`, `firecrawl`, and `camofox` remain accepted for compatibility and report recognized-but-not-implemented status; they do not create real cloud sessions.

## Important Distinctions

- The model catalog is enriched from models.dev when cached/bundled data is available, with local fallback profiles as a safety net.
- Catalog-only providers are discovery adapters, not true inference adapters.
- Runtime config loads catalog metadata with `allowNetwork: false` by default.
- Explicit `{ provider, model }` requests are supported by `ProviderExecutor`.
- Chat-capable providers can be live inference routes.
- Vision routing is implemented in code, but live success depends on actual provider capability plus working credentials.
- Smart approval does not build a legacy provider/model assessor fallback. It requires the resolved `auxiliaryModels.assessor` route, the main route, and a provider executor; missing route/config fails safe to manual approval.
- `estacoda model setup codex` authenticates through OAuth device code, stores tokens in `~/.estacoda/auth.json`, and configures the `codex/o3` route. Raw OAuth tokens are not printed. Route config remains separate from token storage.
- Codex OAuth setup lives on the model setup surface, not in the Onboarding Wizard. If the Onboarding Wizard later offers Codex OAuth, it must delegate to that model setup/OAuth boundary.

## Provider Hardening

Run the live acceptance sweep:

```bash
pnpm run provider:hardening
```

This rotates the selected profile provider route across the acceptance set, runs live diagnostics, captures results, and restores the original config.
