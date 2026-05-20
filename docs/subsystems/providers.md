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

Security smart approval uses `auxiliaryModels.assessor`. The route key is exactly `assessor`; there is no `auxiliaryModels.approval` route. The assessor route is resolved with `resolveAuxiliaryModelRoute("assessor", ...)` and consumed through `executeAuxiliaryTask(...)`.

Config should not use legacy auxiliary names such as `models.auxiliary`, `auxiliary.default`, or `auxiliary.contextualize`. Profile-context CLI/documentation should use `--profile-context`, not `--contextualize`.

Config Part 2 consumes the Providers Pass D auxiliary route contract. It does not add a second auxiliary resolver architecture.

## Memory-Related Routes

Memory Hardening uses distinct auxiliary route names:

| Route | Used By | Must Not Be Confused With |
|-------|---------|---------------------------|
| `session_search` | `SessionRecallService` manual/runtime recall summaries | raw SQLite FTS search |
| `memory_compaction` | Memory File Compaction for `USER.md` / `MEMORY.md` | semantic session compression |
| `compression` | Semantic session compression for session history | Memory File Compaction |

All three routes resolve through `resolveAuxiliaryModelRoute(...)` and execute through provider infrastructure. Missing routes fail closed or fall back as documented by the calling subsystem.

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

## Important Distinctions

- The model catalog is enriched from models.dev when cached/bundled data is available, with local fallback profiles as a safety net.
- Catalog-only providers are discovery adapters, not true inference adapters.
- Runtime config loads catalog metadata with `allowNetwork: false` by default.
- Explicit `{ provider, model }` requests are supported by `ProviderExecutor`.
- Chat-capable providers can be live inference routes.
- Vision routing is implemented in code, but live success depends on actual provider capability plus working credentials.
- Smart approval does not build a legacy provider/model assessor fallback. It requires the resolved `auxiliaryModels.assessor` route, the main route, and a provider executor; missing route/config fails safe to manual approval.
- `estacoda model setup codex` authenticates through OAuth device code, stores tokens in `~/.estacoda/auth.json`, and configures the `codex/o3` route. Raw OAuth tokens are not printed. Route config remains separate from token storage.
- Codex OAuth setup lives on the model setup surface, not in first-run guided onboarding. If guided onboarding later offers Codex OAuth, it must delegate to that model setup/OAuth boundary.

## Provider Hardening

Run the live acceptance sweep:

```bash
pnpm run provider:hardening
```

This rotates the selected profile provider route across the acceptance set, runs live diagnostics, captures results, and restores the original config.
