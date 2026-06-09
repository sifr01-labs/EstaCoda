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

### web

Web research backend selection.

```json
{
  "web": {
    "backend": "fetch",
    "searchBackend": "fetch",
    "extractBackend": "fetch"
  }
}
```

Only `fetch` is live-implemented. Firecrawl, Parallel, Tavily, Exa, SearXNG, Brave, and DDGS are registered stubs and will report unavailable even when configured.

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
    "provider": "openai",
    "openai": {
      "model": "gpt-4o-mini-tts",
      "voice": "alloy",
      "apiKeyEnv": "VOICE_TOOLS_OPENAI_KEY"
    }
  }
}
```

Stable hosted TTS: OpenAI, ElevenLabs, MiniMax, Gemini, xAI. Local TTS and Mistral TTS are deferred.

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

`skills.autonomy` is the persisted compatibility key for Agent Evolution. In Phase 1A it controls reviewable evidence/proposal behavior only. `autonomous` is shadow-only: it records decisions for review but does not auto-promote, auto-rollback, or mutate skill files.

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
      "busyPolicy": "reject",
      "queueDepth": 3
    }
  }
}
```

Guided Telegram setup stores the bot token in the selected profile `.env` under `ESTACODA_TELEGRAM_BOT_TOKEN` and writes `botTokenEnv: "ESTACODA_TELEGRAM_BOT_TOKEN"` to config. The raw Telegram bot token must not appear in config review or setup output.

## Secret handling

- Provider setup writes raw API keys only to the selected profile `.env`, never to `config.json`.
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
