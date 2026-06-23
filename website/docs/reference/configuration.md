---
title: Configuration
description: Profile runtime configuration families and common shapes.
sidebar_position: 3
---

# Configuration

EstaCoda loads one selected profile configuration per session. There is no global config merge, no project-level overlay, and no credential-pool config surface. The profile you select is the profile you get.

Config lives in:

```text
~/.estacoda/profiles/<profile-id>/config.json
```

Secrets belong in the selected profile `.env` or `auth.json`, never in `config.json` examples you paste from documentation.

## Config families

The profile config supports these top-level families. Not every family is required. Omitted families use safe defaults or remain inactive.

### model

Primary model route. Decides which provider and model handle the main inference loop.

```json
{
  "model": {
    "provider": "openai",
    "id": "gpt-4.1",
    "apiKeyEnv": "OPENAI_API_KEY",
    "maxTokens": 8192
  }
}
```

Equivalent shape:

```yaml
model:
  provider: openai
  id: gpt-4.1
  maxTokens: 8192
```

`model.maxTokens` is the route-level output cap. Unset means provider default. Positive integer numbers and positive integer strings are accepted. Zero, negative values, floats, and non-numeric strings are rejected. Diagnostics show `provider default` when unset and warn for configured values below `2048`.

Request-level `maxTokens` overrides route config for that provider call only. It does not mutate profile config, session overrides, aliases, fallbacks, or fingerprints.

Provider request parameter names are selected by API mode:

| Provider/API mode | Sent parameter |
|---|---|
| OpenAI Chat Completions | `max_completion_tokens` |
| Third-party OpenAI-compatible chat | `max_tokens` |
| OpenAI Responses API | `max_output_tokens` |

Unset caps send no token parameter.

Provider requests also have timeout controls:

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

`timeoutMs` is the total provider request budget. It defaults to `1800000` ms, or 30 minutes. `staleTimeoutMs` is the no-progress budget. It defaults to `120000` ms, or 2 minutes.

Precedence:

```text
model.timeoutMs / model.fallbacks[].timeoutMs
→ providers.<id>.timeoutMs
→ 1800000

model.staleTimeoutMs / model.fallbacks[].staleTimeoutMs
→ providers.<id>.staleTimeoutMs
→ 120000
```

For non-streaming provider calls, `staleTimeoutMs` is time-to-response-headers only. After headers arrive, the total timeout governs body parsing. For streaming provider calls, `staleTimeoutMs` resets after received bytes and catches both first-byte stalls and mid-stream stalls. Auxiliary model timeouts are configured separately through `auxiliaryModels.*.timeoutMs`; auxiliary stale timeouts and CLI setup flags for provider timeout tuning are not part of this config surface.

### modelAliases / model_aliases

Named shortcuts for provider/model combinations.

```json
{
  "modelAliases": {
    "fast": { "provider": "openai", "model": "gpt-4o-mini" }
  }
}
```

### providers

Additional provider routes, fallbacks, and metadata.

```json
{
  "providers": {
    "fallback": { "provider": "openrouter", "model": "openrouter/auto" }
  }
}
```

The built-in `local` provider can point at a local or private OpenAI-compatible endpoint. It defaults to `http://localhost:11434/v1` and no auth, so `apiKeyEnv` is optional:

```json
{
  "model": {
    "provider": "local",
    "id": "qwen2.5-coder"
  },
  "providers": {
    "local": {
      "baseUrl": "http://localhost:1234/v1",
      "authMethod": "none"
    }
  }
}
```

If the endpoint requires a key, store the raw key in the selected profile `.env` and reference it from config:

```json
{
  "providers": {
    "local": {
      "baseUrl": "https://private-model-gateway.example/v1",
      "apiKeyEnv": "OPENAI_COMPATIBLE_API_KEY"
    }
  }
}
```

Use a custom provider ID only when you need a separate named OpenAI-compatible route identity:

```json
{
  "providers": {
    "lmstudio": {
      "baseUrl": "http://localhost:1234/v1",
      "apiKeyEnv": "OPENAI_COMPATIBLE_API_KEY"
    }
  }
}
```

### auxiliaryModels

Specialized routes for non-primary tasks. Unsupported auxiliary names throw during config normalization.

| Route | Purpose |
|-------|---------|
| `vision` | Image analysis |
| `compression` | Semantic session compression |
| `assessor` | Security approval assessor |
| `web_extract` | Web extraction |
| `session_search` | Session recall summarization |
| `mcp` | MCP tool delegation |
| `memory_flush` | Memory operations |
| `delegation` | Subagent delegation |
| `skills_library` | Skills distribution |
| `title_generation` | Session title generation |
| `curator` | Skill curation |
| `memory_compaction` | Memory file compaction |
| `profile_context` | Profile context generation |

### delegation

Subagent delegation config is normalized with defaults when omitted.

| Key | Default | Behavior |
|-----|---------|----------|
| `maxSpawnDepth` | `1` | Maximum recursive child delegation depth. `leaf` children cannot delegate. |
| `maxConcurrentChildren` | `3` | Maximum active children in a batch. |
| `maxDelegateCallsPerTurn` | `3` | Per-provider-turn cap for separate `delegate_task` calls. |
| `maxBatchTasks` | `10` | Maximum `tasks[]` length. |
| `childTimeoutSeconds` | `600` | Child timeout floor is 30 seconds. |
| `heartbeatSeconds` | `30` | Parent heartbeat interval while child work runs. |
| `heartbeatStaleCyclesIdle` | `3` | Idle stale-heartbeat threshold. |
| `heartbeatStaleCyclesInTool` | `6` | In-tool stale-heartbeat threshold. |
| `recoverJsonStringTasks` | `true` | Strictly recover JSON-string `tasks` arrays. |
| `diagnostics.enabled` | `true` | Write bounded timeout/stale diagnostics where a profile diagnostics root exists. |
| `diagnostics.includePromptPreview` | `false` | Full prompt previews stay off by default. |
| `outcomeMemory.enabled` | `false` | Opt-in bounded delegation outcome memory. |
| `defaultAllowedRiskClasses` | `read-only-local`, `read-only-network` | Default child tool risk classes after parent-visible intersection. |
| `defaultExcludedToolsets` | `browser`, `media`, `mcp` | Toolsets stripped from default child schemas. |
| `defaultAllowedToolsets` | empty | No broad default toolset grant. |
| `blockedToolNames` / `blockedToolPrefixes` | built-in deny list | Exact/prefix tool stripping before child schemas are built. |
| `childRuntime` | recall/learning/compression disabled, project context bounded | Suppresses parent-like runtime features in child loops. |

`terminal.run`, write/process control, memory/session search, skill/config/cron/trust mutation, and credential surfaces are stripped by default. `terminal.inspect` is read-only-local and may be child-visible only when parent-visible and allowed by the read-only policy. Delegation config participates in the runtime fingerprint so schema-affecting changes rebuild provider tool schemas.

### web

Web research backend selection.

```json
{
  "web": {
    "searchBackend": "brave",
    "extractBackend": "fetch",
    "brave": {
      "apiKeyEnv": "BRAVE_SEARCH_API_KEY"
    }
  }
}
```

Selection is capability-specific:

```text
web.searchBackend / web.extractBackend / web.crawlBackend
→ web.backend
→ auto-detect available providers
→ unavailable
```

Explicit config wins. If `web.searchBackend` names an unavailable provider, `web.search` reports that provider's unavailable reason instead of silently falling back.

| Key | Type | Notes |
|---|---|---|
| `web.backend` | string | Legacy/general web provider preference used when no capability-specific backend is set. |
| `web.searchBackend` | string | Search provider preference. Live search providers are `brave` and `ddgs`. |
| `web.extractBackend` | string | Extraction provider preference. `fetch` is the guarded live extraction fallback. |
| `web.crawlBackend` | string | Crawl provider preference. No live crawl provider is implemented in this release. |
| `web.brave.apiKeyEnv` | string | Env-var reference for Brave Search. Defaults to `BRAVE_SEARCH_API_KEY`. Do not store the raw API key in config. |

Brave Search is a credentialed external provider and uses the same env-reference/deferred-secret setup pattern as model providers. DDGS uses the managed Python capability `ddgs`; install or verify it explicitly with `estacoda python-env setup ddgs` and `estacoda python-env verify ddgs`. Runtime `web.search` does not install Python packages automatically.

Firecrawl, Parallel, Tavily, Exa, and SearXNG remain registered stubs and report unavailable when configured.

### compression

Semantic session compression. Experimental-only in v0.1.0.

```json
{
  "compression": {
    "enabled": false,
    "experimental": false,
    "threshold": 0.50,
    "targetRatio": 0.20,
    "protectFirstTurns": 3,
    "protectLastTurns": 20
  }
}
```

Both `enabled` and `experimental` must be `true` for compression to activate.

### externalMemory / external_memory

Optional external recall and mirror writes. Disabled by default.

```json
{
  "externalMemory": {
    "enabled": false,
    "provider": "file",
    "timeoutMs": 750,
    "maxResults": 3,
    "maxChars": 2500,
    "mirrorWrites": false
  }
}
```

Only the built-in `file` provider is implemented. Absolute paths are rejected.

### browser

Browser backend selection.

```json
{
  "browser": {
    "backend": "local-cdp",
    "supervised": true,
    "autoLaunch": true,
    "launchExecutable": "/path/to/chrome",
    "launchArgs": ["--headless=new"],
    "chromeFlags": ["--no-first-run"],
    "summarizeSnapshots": "auto",
    "snapshotSummarizeThreshold": 8000
  }
}
```

`local-cdp` supports manual CDP connections and supervised auto-launch. Use `launchExecutable`, `launchArgs`, and `chromeFlags` for structured launch configuration. `launchCommand` remains accepted only as deprecated compatibility data and is not shell-parsed.

| Key | Type | Notes |
|---|---|---|
| `browser.launchExecutable` | string | Preferred explicit Chrome/Chromium executable path for supervised local CDP auto-launch. |
| `browser.launchArgs` | string array | Structured launch arguments. Repeat `--launch-arg` in CLI setup to append. |
| `browser.chromeFlags` | string array | Structured Chrome flags. Repeat `--chrome-flag` in CLI setup to append. |
| `browser.launchCommand` | string | Deprecated compatibility data only. Not split, guessed, or shell-parsed. |
| `browser.hybridRouting` | boolean | Routes public HTTP(S) URLs to cloud and allowed private/internal URLs to local when configured. Does not bypass URL safety. |
| `browser.cloudFallback` | boolean | Allows eligible Browserbase failures to fall back to local. Spend approval failures do not fall back. |
| `browser.cloudSpendApproved` | boolean or `"pending"` | Explicit approval for billable cloud browser session creation. Credentials alone do not approve spend. |
| `browser.summarizeSnapshots` | boolean or `"auto"` | Controls whether oversized rendered snapshots may be summarized. |
| `browser.snapshotSummarizeThreshold` | number | Rendered snapshot character threshold before summarization is considered. |

Browserbase is implemented through the browser backend and requires `BROWSERBASE_API_KEY`, `BROWSERBASE_PROJECT_ID`, and explicit `browser.cloudSpendApproved: true` before billable sessions can be created. `estacoda browser approve-cloud` sets approval, and `estacoda browser revoke-cloud` disables it. Config alone does not create Browserbase sessions. browser-use, Firecrawl browser, and Camofox remain deferred providers.

Hybrid routing follows the browser URL-safety policy: private/internal URLs remain blocked unless `security.allowPrivateUrls` is explicitly true, metadata endpoints are always blocked, and unsafe redirects are blanked to `about:blank` when possible or the unsafe session is closed.

### imageGen / image_gen

Image generation provider and model.

```json
{
  "imageGen": {
    "provider": "fal",
    "model": "fal-ai/flux-2/klein/9b",
    "useGateway": false
  }
}
```

Supported providers: `fal`, `byteplus`.

### tts

Text-to-speech provider and voice settings.

```json
{
  "tts": {
    "enabled": true,
    "provider": "edge",
    "edge": {
      "voice": "en-US-AriaNeural",
      "speed": 1.0
    }
  }
}
```

Implemented TTS: OpenAI, ElevenLabs, MiniMax, Gemini, xAI, and Edge. Edge requires no API key, but it is networked: synthesis text is sent to Microsoft's Edge speech service, and output is MP3 (`audio/mpeg`). Local/offline TTS providers `neutts` and `kittentts`, and Mistral TTS, are deferred.

Interactive setup asks for the TTS provider only. It uses runtime defaults for models, voices, and provider settings, and collects hosted provider API keys through masked input. Config stores env-var references such as `apiKeyEnv`, while profile-local secret values are written to `.env` only after reviewed apply. Direct operator CLI flags such as `estacoda voice setup --tts-model`, `--tts-api-key-env`, and `--tts-api-key` remain available for scripted setup.

### stt

Speech-to-text provider and model.

```json
{
  "stt": {
    "enabled": true,
    "provider": "openai",
    "openai": {
      "model": "gpt-4o-mini-transcribe",
      "apiKeyEnv": "VOICE_TOOLS_OPENAI_KEY"
    }
  }
}
```

Stable hosted STT: OpenAI, Groq, xAI. Local STT supports `command` and `faster-whisper`. Mistral STT is deferred.

Interactive setup asks for the STT provider only. It uses runtime defaults for models and provider settings, and collects hosted provider API keys through masked input. Config stores env-var references such as `apiKeyEnv`, while profile-local secret values are written to `.env` only after reviewed apply. Direct operator CLI flags such as `estacoda voice setup --stt-model`, `--stt-api-key-env`, and `--stt-api-key` remain available for scripted setup.

In v0.1.0, `stt.provider: "local"` defaults to managed faster-whisper:

```json
{
  "stt": {
    "provider": "local",
    "local": {
      "engine": "faster-whisper",
      "model": "base",
      "pythonBinary": "/optional/custom/python",
      "fasterWhisper": {
        "enabled": true,
        "model": "base",
        "device": "auto",
        "computeType": "default",
        "hfHome": "/optional/model-cache",
        "allowModelDownload": true,
        "gatewayAllowModelDownload": true,
        "queueDepth": 1,
        "timeoutMs": 300000
      }
    }
  }
}
```

Omit `pythonBinary` for the managed path resolved under `~/.estacoda/python-env`, or set it to an operator-owned Python when using `estacoda voice setup --stt-provider local --python-binary /path/to/python`. The default model cache is `~/.estacoda/cache/huggingface`; it is separate from the venv.

Gateway model downloads inherit `allowModelDownload`. Because `allowModelDownload` defaults to `true`, gateway-triggered first-run downloads are allowed by default; set `gatewayAllowModelDownload: false` only when gateway voice messages must require a cached model.

Command mode is explicit:

```json
{
  "stt": {
    "provider": "local",
    "local": {
      "engine": "command",
      "command": "/path/to/transcriber {input}"
    }
  }
}
```

`engine: "command"` wins and does not use managed faster-whisper.

### voice

Gateway auto-TTS behavior.

```json
{
  "voice": {
    "autoTts": false,
    "autoTtsMaxCharsPerReply": 1200,
    "autoTtsMaxCharsPerHourPerChat": 5000
  }
}
```

### mcpServers / mcp_servers

MCP server definitions.

```json
{
  "mcpServers": {
    "my-server": {
      "command": "node",
      "args": ["/path/to/server.js"],
      "cwd": "/optional/cwd",
      "env": { "KEY": "value" },
      "includeTools": ["tool1"],
      "excludeTools": ["tool2"],
      "trust": "conservative",
      "timeout": 30000
    }
  }
}
```

Trust levels: `conservative`, `read-only-network`, `read-only-local`.

### skills

Skill loading and Agent Evolution policy.

```json
{
  "skills": {
    "autonomy": "suggest",
    "externalDirs": ["/optional/external/skill/root"]
  }
}
```

Autonomy modes: `none`, `suggest`, `proactive`, `autonomous`.

`skills.autonomy` is the persisted compatibility key for Agent Evolution. It controls reviewable evidence/proposal behavior. `autonomous` is shadow-only: it records decisions for review but does not auto-promote, auto-rollback, or mutate skill files.

### ui

Terminal UI preferences.

```json
{
  "ui": {
    "theme": "dark",
    "locale": "en"
  }
}
```

### profile

Profile metadata.

```json
{
  "profile": {
    "name": "work",
    "description": "Production work profile"
  }
}
```

### security

Security mode and policy overrides.

```json
{
  "security": {
    "mode": "adaptive",
    "allowPrivateUrls": false,
    "websiteBlocklist": {
      "domains": ["*.example.com"]
    }
  }
}
```

Modes: `strict`, `adaptive`, `open`. Default is `adaptive`.

### channels

Channel adapter configuration. See [Channel Configuration](../user-guide/channels.md) for full schema.

```json
{
  "channels": {
    "telegram": {
      "enabled": true,
      "botTokenEnv": "ESTACODA_TELEGRAM_BOT_TOKEN",
      "streaming": {
        "enabled": true,
        "editIntervalMs": 750,
        "minInitialChars": 24,
        "cursor": "▌",
        "maxFloodStrikes": 2,
        "cleanupFailedAttempts": true,
        "transport": "auto",
        "freshFinalAfterSeconds": 0
      },
      "busyPolicy": "reject",
      "queueDepth": 3
    }
  }
}
```

Guided Telegram setup stores the bot token in the selected profile `.env` under `ESTACODA_TELEGRAM_BOT_TOKEN` and writes `botTokenEnv: "ESTACODA_TELEGRAM_BOT_TOKEN"` to config. The raw Telegram bot token must not appear in config review or setup output.

Telegram streaming is configured under `channels.telegram.streaming`. It defaults to enabled for configured Telegram channels and affects Telegram delivery only. Set `channels.telegram.streaming.enabled` to `false` to opt out. It does not change session state, memory, approvals, tool execution, artifacts, or final `response.text`.

| Setting | Type / allowed values | Default | Notes |
|---|---|---:|---|
| `channels.telegram.streaming.enabled` | `boolean` | `true` | Enables Telegram streaming for configured Telegram channels. Set to `false` to opt out. |
| `channels.telegram.streaming.editIntervalMs` | non-negative integer | `750` | Coalescing interval for Telegram partial edits. |
| `channels.telegram.streaming.minInitialChars` | non-negative integer | `24` | Visible filtered character threshold before first partial send. |
| `channels.telegram.streaming.cursor` | `string` | `"▌"` | Temporary live cursor appended to partial messages. |
| `channels.telegram.streaming.maxFloodStrikes` | non-negative integer | `2` | Active-turn flood-control degradation limit. |
| `channels.telegram.streaming.cleanupFailedAttempts` | `boolean` | `true` | Delete or neutralize provisional streamed messages after provider failure/fallback. |
| `channels.telegram.streaming.transport` | `"auto"`, `"edit"`, or `"draft"` | `"auto"` | `"auto"` selects draft previews for DMs when supported and edit streaming otherwise. `"edit"` uses ordinary message edits. `"draft"` uses Telegram draft previews in DMs only when supported by the Bot API. |
| `channels.telegram.streaming.freshFinalAfterSeconds` | non-negative integer | `0` | `0` disables fresh-final delivery. A positive value sends the completed answer as a fresh message after a preview has been visible that many seconds, then deletes the preview best-effort. |

Telegram streaming runs before normal final-text routing. If streaming cannot deliver the completed answer, `ChannelGateway` falls back to normal `DeliveryRouter` delivery. Partial streaming uses lightweight HTML escaping; final delivery uses normal Telegram formatting. Draft previews and rich message delivery depend on Telegram and Bot API support. Rich message delivery is opportunistic and falls back to normal Telegram formatting when unsupported, too long, or ambiguous. Flood control, oversized partial payloads, approval boundaries, artifact boundaries, or final edit failures force normal final text fallback for the active turn only. Streaming remains delivery UX only; final `response.text` remains authoritative.

## Secret handling

- Provider setup writes raw API keys only to the selected profile `.env`, never to `config.json`. Local / private endpoints are no-auth by default and write a key only when one is provided.
- Voice setup review manifests show env-var references only. Raw Voice API keys are not stored in config, shown in review manifests, or inserted into prompt context.
- Profile `.env` is chmodded to `0600` when written by the env secret store.
- Runtime config loads the selected profile `.env` before execution.
- Do not paste real secrets into config snippets.

## Validation

EstaCoda validates config during load. Invalid values fall back to defaults or clamp to bounds where safe. Missing required credentials produce setup-needed hints, not crashes.

## Related docs

- [Environment Variables](./environment-variables.md) — env var names and behavior
- [State and Files](./state-and-files.md) — where config files live
- [Providers](../user-guide/providers.md) — provider setup and maturity
- [Channels](../user-guide/channels.md) — channel configuration
- [Security and Approvals](../user-guide/security-and-approvals.md) — security modes
