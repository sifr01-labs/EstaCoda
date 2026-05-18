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
| `src/providers/auxiliary-provider-router.ts` | ~160 | Route auxiliary tasks |
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

## Important Distinctions

- The model catalog is enriched from models.dev when cached/bundled data is available, with local fallback profiles as a safety net.
- Catalog-only providers are discovery adapters, not true inference adapters.
- Runtime config loads catalog metadata with `allowNetwork: false` by default.
- Explicit `{ provider, model }` requests are supported by `ProviderExecutor`.
- Chat-capable providers can be live inference routes.
- Vision routing is implemented in code, but live success depends on actual provider capability plus working credentials.
- `estacoda model setup codex` authenticates through OAuth device code, stores tokens in `~/.estacoda/auth.json`, and configures the `codex/o3` route. Raw OAuth tokens are not printed. Route config remains separate from token storage.
- Codex OAuth setup lives on the model setup surface, not in first-run guided onboarding. If guided onboarding later offers Codex OAuth, it must delegate to that model setup/OAuth boundary.

## Provider Hardening

Run the live acceptance sweep:

```bash
pnpm run provider:hardening
```

This rotates the selected profile provider route across the acceptance set, runs live diagnostics, captures results, and restores the original config.
