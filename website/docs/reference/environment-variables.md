---
title: Environment Variables
description: Runtime environment variable reference.
sidebar_position: 4
---

# Environment Variables

Environment variables are runtime inputs loaded for the selected profile. EstaCoda reads them from the process environment and from the selected profile `.env` file.

The preferred storage location for secrets is:

```text
~/.estacoda/profiles/<profile-id>/.env
```

Setup flows write secrets there with `0600` permissions. You can also reference an existing environment variable by name in config.

## State isolation

| Variable | Purpose |
|----------|---------|
| `ESTACODA_HOME` | Override the default state root (`~/.estacoda`). Use this to run dev builds against isolated state without touching your real user data. |

## LLM provider API keys

| Variable | Provider | Status |
|----------|----------|--------|
| `KIMI_API_KEY` | Kimi | Live-proven |
| `OPENAI_API_KEY` | OpenAI | Live-proven |
| `DEEPSEEK_API_KEY` | DeepSeek | Live-proven |
| `OPENROUTER_API_KEY` | OpenRouter | Live-proven |
| `GOOGLE_API_KEY` | Google | Configurable/catalog-known |
| `ANTHROPIC_API_KEY` | Anthropic | Configurable/catalog-known |

MiniMax and Nous are catalog-known but not runnable in the current build.

## Codex OAuth

Codex authentication stores tokens in `~/.estacoda/auth.json` after OAuth device-code flow. The env secret store does not manage Codex tokens.

## Voice provider keys

| Variable | Purpose |
|----------|---------|
| `VOICE_TOOLS_OPENAI_KEY` | Default OpenAI audio key for TTS/STT |
| `OPENAI_API_KEY` | OpenAI audio fallback only when the configured OpenAI audio env is the default `VOICE_TOOLS_OPENAI_KEY` |
| `ELEVENLABS_API_KEY` | ElevenLabs TTS |
| `MINIMAX_API_KEY` | MiniMax TTS |
| `GEMINI_API_KEY` | Gemini TTS |
| `XAI_API_KEY` | xAI native TTS/STT |
| `GROQ_API_KEY` | Groq STT |
| `HF_HOME` | Optional faster-whisper / Hugging Face model cache root |
| `TRANSFORMERS_CACHE` | Optional Hugging Face cache env respected by the worker environment |

Voice credentials are direct environment-variable references only. There are no voice credential pools, gateway brokers, managed fallbacks, or non-env sources.

Managed local STT defaults to `~/.estacoda/cache/huggingface` for faster-whisper model cache when `hfHome` is not configured. If `TRANSFORMERS_CACHE` is already set in the process environment, runtime preserves it. The managed Python venv remains separate at `~/.estacoda/python-env`.

## Image generation keys

| Variable | Provider |
|----------|----------|
| `FAL_KEY` | FAL |
| `BYTEPLUS_ARK_API_KEY` | BytePlus / Seedream |

## Browser provider keys

| Variable | Provider | Purpose |
|----------|----------|---------|
| `BROWSERBASE_API_KEY` | Browserbase | Browserbase API authentication. |
| `BROWSERBASE_PROJECT_ID` | Browserbase | Browserbase project used for cloud browser sessions. |

These credentials satisfy Browserbase readiness only. They do not approve billable session creation. Browserbase sessions remain blocked until `browser.cloudSpendApproved === true`, normally set with `estacoda browser approve-cloud` and revoked with `estacoda browser revoke-cloud`.

## Channel keys

| Variable | Channel |
|----------|---------|
| `ESTACODA_TELEGRAM_BOT_TOKEN` | Telegram bot token used by guided setup |
| `ESTACODA_DISCORD_TOKEN` | Discord bot token |

Email uses `passwordEnv` config keys that reference arbitrary env vars, for example `EMAIL_PASSWORD`.

## Browser and web debug

| Variable | Effect |
|----------|--------|
| `ESTACODA_BROWSER_DEBUG` | Enables browser debug telemetry |
| `ESTACODA_WEB_TOOLS_DEBUG` | Enables web tool debug telemetry |

Debug data is redacted before storage or return.

## Private URL override

| Variable | Effect |
|----------|--------|
| `ESTACODA_ALLOW_PRIVATE_URLS` | Overrides `security.allowPrivateUrls` config. Accepts `1`, `true`, `yes`, `on` for true; `0`, `false`, `no`, `off` for false. Any other value fails config loading. |

## Rules

- Do not hardcode secrets in repo files.
- Do not commit real keys.
- Default setup stores pasted secrets in the selected profile `.env`.
- Advanced setup can reference an existing environment variable by name.
- A custom OpenAI audio env var that is missing does not fall back to `OPENAI_API_KEY`.
- Resolved key values are never logged or returned in errors.

## Related docs

- [Configuration](./configuration.md) — config file families
- [State and Files](./state-and-files.md) — where `.env` lives
- [Providers](../user-guide/providers.md) — provider setup
