---
title: Provider Reference
description: Provider maturity matrix, status labels, and capability boundaries for v0.1.0.
sidebar_position: 5
---

# Provider Reference

EstaCoda routes every inference request through a provider. This page lists every provider EstaCoda knows about, what maturity label it carries, and what that label means in practice. The label decides what you can claim, what you can debug, and what you should not expect.

A provider being "known" does not mean it is runnable. A provider being "registered" does not mean it is validated. Check the label before you configure.

---

## Maturity Labels

| Label | Meaning | What you can do |
|---|---|---|
| `live-proven` | Configured, tested, and validated in realistic usage. | Set it as a primary route with confidence. |
| `implemented` | Code exists, credentials resolve, and requests execute. Not yet validated in sustained live use. | Set it up and test it. Report gaps. |
| `configurable` | Appears in setup/model selection and has runnable adapter support, but may not be live-proven. | Configure it if you are testing or extending. |
| `catalog-known` | Registered in the offline model catalog. No runnable inference adapter in the current build. | Not a primary route for v0.1.0. |
| `experimental` | Gated behind feature flags or unstable by design. | Enable explicitly. Expect breakage. |
| `unsupported` | No implementation. No adapter. No claim. | Do not configure. |

Labels are cumulative downward. A `live-proven` provider is also `implemented`. A `catalog-known` provider is not `configurable` for inference.

---

## LLM Providers

| Provider | Maturity | Notes |
|---|---|---|
| **Kimi** | `live-proven` | Primary validation target. Tool-call exactness verified. |
| **OpenAI** | `live-proven` | Chat completions and responses modes both supported. |
| **DeepSeek** | `live-proven` | Validated for chat completions with tool schema. |
| **OpenRouter** | `live-proven` | Runtime works. Tool-call exactness is occasionally inconsistent; monitor for routing edge cases. |
| **Codex** | `implemented` | Public CLI setup path via `estacoda model setup codex`. OAuth device-code authentication, token storage in `~/.estacoda/auth.json`, `codex/o3` route configured. Excluded from onboarding wizard by design, not hidden. |
| **Google** | `configurable` | Catalog-enriched. Inference adapter exists but live validation is limited in this build. |
| **Anthropic** | `catalog-known` | Metadata and catalog entries exist, but it is not exposed as a setup/model-picker route and is not runnable as a primary LLM route in this build. |
| **MiniMax** | `catalog-known` | Registered in model catalog. Not runnable in the current build. |
| **Nous** | `catalog-known` | Registered in model catalog. Not runnable in the current build. |
| **Local / private endpoint** | `implemented` | Built-in `local` provider for Ollama, LM Studio, llama.cpp, vLLM, LiteLLM, or another OpenAI-compatible local/private endpoint. Defaults to `http://localhost:11434/v1`, `authMethod: "none"`, and optional API key env `OPENAI_COMPATIBLE_API_KEY`. |
| **Custom (OpenAI-compatible)** | `implemented` | Any non-built-in provider ID with an explicit `baseUrl` is treated as custom OpenAI-compatible. Requires `baseUrl`. Default API key env is `OPENAI_COMPATIBLE_API_KEY`. Use this when you need a separate named provider identity instead of `local`. |
| **unconfigured** | `unsupported` | Placeholder. Not runnable. |

### API Execution Modes

The following API modes are executable by current code:

- `openai_chat_completions`
- `custom_openai_compatible`
- `openai_responses`

### Auth Methods

- `apiKey` — read from `apiKeyEnv` at runtime
- `none` — no credentials required
- `codex_oauth_device_pkce` — Codex-specific OAuth device-code flow

### Request Timeouts

Primary and fallback LLM routes use a total timeout and a stale/no-progress timeout:

| Field | Default | Notes |
|---|---:|---|
| `timeoutMs` | `1800000` | Total provider request budget. |
| `staleTimeoutMs` | `120000` | Time-to-response-headers for non-streaming calls; time between received bytes for streaming calls. |

Precedence is route-specific: `model` or fallback route value, then `providers.<id>` value, then the built-in default. Auxiliary model routes keep their existing `auxiliaryModels.*.timeoutMs` behavior and do not gain stale-timeout controls in this implementation. CLI setup commands do not expose provider timeout flags; configure these values in the selected profile config.

---

## Voice Providers

### TTS (Text to Speech)

| Provider | Maturity | Notes |
|---|---|---|
| **OpenAI** | `live-proven` | Hosted TTS. Requires `OPENAI_API_KEY`. |
| **ElevenLabs** | `live-proven` | Hosted TTS. Requires `ELEVENLABS_API_KEY`. |
| **MiniMax** | `live-proven` | Hosted TTS. |
| **Gemini** | `live-proven` | Hosted TTS. |
| **xAI** | `live-proven` | Hosted TTS. |
| **Edge** | `implemented` | Microsoft Edge TTS. No API key required, but synthesis text is sent over the network to Microsoft's Edge speech service. Not local/offline. |
| **Mistral** | `experimental` | Deferred for v0.1.0. Gated. |
| **Local TTS** | `unsupported` | `neutts` and `kittentts` are deferred in this build. |

### STT (Speech to Text)

| Provider | Maturity | Notes |
|---|---|---|
| **OpenAI** | `live-proven` | Hosted STT. |
| **Groq** | `live-proven` | Hosted STT. |
| **xAI** | `live-proven` | Hosted STT. |
| **local** | `implemented` | Managed `faster-whisper` by default for `stt.provider: "local"`; command engine with explicit `stt.local.engine: "command"`. Gateway faster-whisper model downloads follow `allowModelDownload` by default and can be blocked with `gatewayAllowModelDownload: false`. |
| **Mistral** | `experimental` | Deferred for v0.1.0. |

---

## Image Generation Providers

| Provider | Maturity | Notes |
|---|---|---|
| **FAL** | `live-proven` | Default image generation provider. Requires `FAL_KEY`. |
| **BytePlus / Seedream** | `live-proven` | Requires `BYTEPLUS_API_KEY`. |

---

## Web Research Providers

Brave Search and DDGS are implemented search providers. `fetch` is the guarded extraction baseline. The remaining named providers are registered stubs.

| Provider | Capabilities Declared | Maturity | Notes |
|---|---|---|---|
| **fetch** | extract | `live-proven` | Guarded built-in extraction fallback. No API key required. |
| **Brave** | search | `implemented` | Live Brave Search API provider. Requires an env reference under `web.brave.apiKeyEnv`, defaulting to `BRAVE_SEARCH_API_KEY`. |
| **DDGS** | search | `implemented` | Live subprocess provider backed by the managed Python capability `ddgs`. Run `estacoda python-env setup ddgs` before use. |
| **Firecrawl** | search, extract, crawl | `unsupported` | Registered stub. Unavailable even when configured. |
| **Parallel** | search | `unsupported` | Registered stub. |
| **Tavily** | search, extract | `unsupported` | Registered stub. |
| **Exa** | search | `unsupported` | Registered stub. |
| **SearXNG** | search | `unsupported` | Registered stub. |

`web.search` can use Brave or DDGS when the selected provider is available. `web.extract` falls back to the guarded fetch extractor only when no explicit unavailable extract provider was configured and no available extract provider was auto-detected. `web.crawl` exists as tool infrastructure, but no live crawl provider is implemented.

Provider selection checks `web.searchBackend`, `web.extractBackend`, or `web.crawlBackend` first, then `web.backend`, then auto-detects available providers. Explicit unavailable providers do not silently fall back.

---

## Cloud Browser Providers

| Provider | Maturity | Notes |
|---|---|---|
| **local-cdp** | `live-proven` | Local Chrome DevTools Protocol. Supervised mode is opt-in. |
| **mock** | `implemented` | Test backend. No real browser. |
| **Browserbase** | `implemented` | Cloud browser backend. Requires credentials and explicit cloud spend approval. |
| **browser-use** | `unsupported` | Registered stub. Not implemented. |
| **Firecrawl (browser)** | `unsupported` | Registered stub. Not implemented. |
| **Camofox** | `unsupported` | Registered stub. Not implemented. |

Browserbase requires `BROWSERBASE_API_KEY`, `BROWSERBASE_PROJECT_ID`, and explicit `browser.cloudSpendApproved: true` before cloud sessions can be created. `estacoda browser approve-cloud` approves billable session creation, and `estacoda browser revoke-cloud` blocks it again. Browserbase direct provider-registry `createSession()` calls still throw because cloud spend approval is enforced through the browser backend. Legacy `browser.backend` values `firecrawl` and `camofox` remain accepted for compatibility but report unavailable status.

---

## Auxiliary Model Slots

Auxiliary routes are preference constructs, not separate runtimes. They resolve through the same provider infrastructure as the primary route.

| Slot | Purpose | Maturity |
|---|---|---|
| `vision` | Image analysis | `implemented` |
| `compression` | Semantic session compression | `experimental` |
| `assessor` | Security smart approval classifier | `implemented` |
| `web_extract` | Web extraction | `implemented` |
| `session_search` | Session semantic search / recall | `implemented` |
| `mcp` | MCP tool delegation | `implemented` |
| `memory_flush` | Memory operations | `implemented` |
| `delegation` | Subagent delegation | `implemented` |
| `skills_library` | Skills distribution | `implemented` |
| `title_generation` | Session title generation | `implemented` |
| `curator` | Memory curation | `implemented` |
| `memory_compaction` | Memory file compaction | `implemented` |
| `profile_context` | Profile context generation | `implemented` |

Unsupported auxiliary task names throw during config normalization. Config should not use legacy names such as `models.auxiliary`, `auxiliary.default`, or `auxiliary.contextualize`.

Delegated child `modelOverride` requests use configured provider routes only. Same-provider and reviewed cross-provider child overrides preserve target provider config, use existing `apiKeyEnv` credentials, respect `authMethod: "none"`, reject `enableNetwork: false` before execution, and disable fallback routes for the overridden child. They do not introduce credential pools or mutate parent/session/profile routes.

---

## Unsupported in v0.1.0

The following are explicitly out of scope for this release:

- Runnable Anthropic Messages API adapter as a primary route
- Runnable MiniMax or Nous LLM adapters
- Live web search via Firecrawl, Parallel, Tavily, Exa, or SearXNG
- Live cloud browser sessions via browser-use, Firecrawl, or Camofox
- Arbitrary external memory providers configured by name without a built-in implementation

---

## Related

- [Providers](../user-guide/providers.md) — user-facing setup and model switching
- [Configuration](./configuration.md) — config file schema
- [Environment Variables](./environment-variables.md) — env var reference
