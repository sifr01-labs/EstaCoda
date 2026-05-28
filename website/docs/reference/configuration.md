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
    "model": "gpt-4o",
    "apiKeyEnv": "OPENAI_API_KEY"
  }
}
```

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
    "autoLaunch": false,
    "allowPrivateUrls": false
  }
}
```

`local-cdp` is the only live-implemented backend. Browserbase, browser-use, Firecrawl, and Camofox are registered but cannot create live sessions.

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
        "gatewayAllowModelDownload": false,
        "queueDepth": 1,
        "timeoutMs": 300000
      }
    }
  }
}
```

Omit `pythonBinary` for the managed path resolved under `~/.estacoda/python-env`, or set it to an operator-owned Python when using `estacoda voice setup --stt-provider local --python-binary /path/to/python`. The default model cache is `~/.estacoda/cache/huggingface`; it is separate from the venv.

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

Skill loading and autonomy.

```json
{
  "skills": {
    "autonomy": "suggest",
    "externalDirs": ["/optional/external/skill/root"]
  }
}
```

Autonomy modes: `none`, `suggest`, `proactive`, `autonomous`.

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
      "botTokenEnv": "ESTACODA_TELEGRAM_TOKEN",
      "busyPolicy": "reject",
      "queueDepth": 3
    }
  }
}
```

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
