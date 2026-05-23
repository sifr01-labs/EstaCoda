---
title: "Voice"
description: "Voice tools, provider dispatch, gateway voice policy, auto-TTS, CLI voice mode, and Discord voice-channel support."
---

# Voice

Voice is an optional media capability. It is separate from the primary LLM provider route and uses direct environment-variable credentials only.

## Provider Matrix

| Capability | Provider | Status | Notes |
|------------|----------|--------|-------|
| Hosted TTS | OpenAI | Implemented | Default TTS provider. Uses the shared OpenAI audio credential resolver. |
| Hosted TTS | ElevenLabs | Implemented | Uses `xi-api-key` and provider text limits. |
| Hosted TTS | MiniMax | Implemented | Decodes base64 JSON audio responses. |
| Hosted TTS | Gemini | Implemented | Uses `speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName`. |
| Hosted TTS | xAI | Implemented | Uses native `{baseUrl}/tts`, not an OpenAI-compatible shape. |
| Hosted STT | OpenAI | Implemented | Uses the shared OpenAI audio credential resolver. |
| Hosted STT | Groq | Implemented | Direct environment key lookup. |
| Hosted STT | xAI | Implemented | Uses native `{baseUrl}/stt`, not an OpenAI-compatible shape. |
| Local STT | command | Implemented | Preserves command-template rendering and prefers stdout transcript text. |
| Local STT | faster-whisper | Implemented | Runtime-owned long-lived Python JSONL worker. |
| Local TTS | Deferred | Not implemented | Do not configure as available in v0.1.0. |
| Mistral TTS/STT | Deferred | Not implemented | Config shape may exist, but execution is unavailable in v0.1.0. |

## Configuration

Voice config lives in the selected profile config at `~/.estacoda/profiles/<profile-id>/config.json`.

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
  },
  "stt": {
    "enabled": true,
    "provider": "openai",
    "openai": {
      "model": "gpt-4o-mini-transcribe",
      "apiKeyEnv": "VOICE_TOOLS_OPENAI_KEY"
    }
  },
  "voice": {
    "autoTts": false,
    "autoTtsMaxCharsPerReply": 1200,
    "autoTtsMaxCharsPerHourPerChat": 5000
  }
}
```

Core fields:

| Field | Meaning |
|-------|---------|
| `tts.provider` | Selected TTS provider. Implemented hosted values are `openai`, `elevenlabs`, `minimax`, `gemini`, and `xai`. |
| `tts.enabled` | When `false`, TTS readiness fails even if credentials are present. |
| `stt.provider` | Selected STT provider. Implemented values are `openai`, `groq`, `xai`, and `local`. |
| `stt.enabled` | When `false`, STT readiness fails before transcription side effects. |
| `voice.autoTts` | Gateway auto-TTS global default. Default `false`. When `true` and no per-chat override exists, it maps to `voice_only`. |
| `voice.autoTtsMaxCharsPerReply` | Optional per-reply cap checked before auto-TTS synthesis. |
| `voice.autoTtsMaxCharsPerHourPerChat` | Optional hourly cap tracked per platform/chat. |

Credential rules:

- Voice credentials are direct environment variables only.
- There are no voice credential pools, gateway brokers, managed fallbacks, `useGateway`, or non-env credential sources.
- OpenAI audio credentials resolve in this order:
  1. `config.openai.apiKeyEnv`
  2. `VOICE_TOOLS_OPENAI_KEY`
  3. `OPENAI_API_KEY`, only when the configured env is the default `VOICE_TOOLS_OPENAI_KEY`
- A custom OpenAI audio env var that is missing does not fall back to `OPENAI_API_KEY`.
- Resolved key values are not logged, returned in errors, or exposed in metadata.

Provider-specific notes:

- xAI TTS uses `voiceId`, `language`, `sampleRate`, `bitRate`, `baseUrl`, `apiKeyEnv`, and optional `speed`. It does not use `tts.xai.model`.
- xAI STT uses `baseUrl`/`base_url`, `apiKeyEnv`/`api_key_env`, optional `language`, `format`, `diarize`/`diarization`, `keyterms`/`key_terms`, `fillerWords`/`filler_words`, and raw-audio hints where needed. It does not use `stt.xai.model`.
- Gemini TTS sends `speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName`.

## faster-whisper

Local faster-whisper STT runs through one runtime-owned long-lived Python JSONL worker per runtime/profile.

Config shape:

```json
{
  "stt": {
    "provider": "local",
    "local": {
      "engine": "faster-whisper",
      "fasterWhisper": {
        "enabled": true,
        "model": "base",
        "device": "auto",
        "computeType": "default",
        "hfHome": "/path/to/profile-local/hf-cache",
        "allowModelDownload": false,
        "gatewayAllowModelDownload": false,
        "queueDepth": 3,
        "timeoutMs": 300000
      }
    }
  }
}
```

Operational behavior:

- Default model is `base`.
- Supported presets are `tiny`, `small`, `medium`, `large-v1`, `large-v2`, and `large-v3`.
- The worker protocol includes `protocolVersion: 1`.
- The worker supports probe, status, transcription, and shutdown messages.
- Models are cached by `(model, device, computeType)`.
- CUDA/device failures retry once with `device: "cpu"` and `computeType: "int8"` through the same worker.
- Unexpected worker exit restarts once, then marks faster-whisper unavailable for the current runtime/client.
- `runtime.dispose()` shuts down the worker.
- Default timeout is 300 seconds.
- Default queue depth is 3 for gateway-triggered use and 1 for CLI/local interactive use unless config overrides it.
- Queue overflow fails fast.
- The gateway denies first-run model downloads by default before worker startup. Set `gatewayAllowModelDownload: true` only when that side effect is acceptable.
- `hfHome` is passed to the worker when configured. Otherwise the worker respects existing `HF_HOME` or `TRANSFORMERS_CACHE` and uses profile-local cache/temp policy where EstaCoda controls the path.

## Tools

| Tool | Availability contract |
|------|-----------------------|
| `voice.speak` | Boolean `isAvailable()` only. Readiness reasons are exposed through exported helpers and CLI/status surfaces. |
| `voice.transcribe` | Boolean `isAvailable()` only. Readiness reasons are exposed through exported helpers and CLI/status surfaces. |

`voice.speak` writes normal tool artifacts through the artifact path. Gateway auto-TTS is different: it creates ephemeral delivery objects and does not insert generated audio into durable artifacts, session DB, artifact history, prompt context, or model-visible attachments.

Provider output validation is part of the tool path:

- TTS providers must return non-empty audio bytes/files.
- STT providers must return non-empty valid transcript text unless the provider explicitly returns a valid no-speech condition.
- Provider failures use stable provider/reason metadata and bounded sanitized snippets. Request text, API keys, and secrets are not included.

## Gateway Voice Policy

Gateway `/voice` parsing is owned by `ChannelGateway`, not adapters. Adapters expose capability methods where needed.

Per-chat voice state is profile-local at:

```text
~/.estacoda/profiles/<profile-id>/gateway/voice-mode.json
```

Modes:

| Mode | Meaning |
|------|---------|
| `off` | Do not auto-TTS gateway replies for the chat. |
| `voice_only` | Auto-TTS only replies to incoming voice messages that produced a transcript. |
| `all` | Auto-TTS eligible non-command text replies in that chat. |

Commands:

| Command | Behavior |
|---------|----------|
| `/voice on` | Set the chat to `voice_only`. |
| `/voice voice` | Alias for `voice_only`. |
| `/voice all` | Set the chat to `all`. |
| `/voice tts` | Alias for `all`. |
| `/voice off` | Set the chat to `off`. |
| `/voice status` | Report the resolved mode for the chat. |
| `/voice channel` | Discord only. Delegates to Discord voice capability methods. |
| `/voice leave` | Discord only. Delegates to Discord voice capability methods. |

Group-chat `/voice` handling follows the existing gateway auth, mention, and free-response gating. `/voice` commands are intercepted before runtime routing and do not invoke the agent loop.

### Transcript Injection

Successful voice transcript injection uses exactly:

```text
[Voice message transcript]
{text}
```

After successful transcription, the original audio attachment is removed from model context. Failed transcription does not silently turn an invalid audio file into model-visible text.

Duplicate transcript suppression is per `(platform, chatId)`:

- Rolling buffer of the last 5 normalized transcripts.
- 12-second comparison window.
- Normalization trims, lowercases, collapses whitespace, and strips punctuation.
- Exact hash/text matches are dropped.
- Near-match ratio applies only when both strings are at least 16 characters.
- Compared text length is capped before bounded O(n*m) work.

### Auto-TTS

Gateway auto-TTS is opt-in and text-first:

- `voice.autoTts` defaults to `false`.
- If no per-chat override exists, `voice.autoTts: true` maps to `voice_only`, not `all`.
- Text delivery remains primary.
- Auto-TTS is best-effort and fail-open to text.
- Provider and delivery failures log safe warnings/events and leave text intact.

Auto-TTS skips:

- mode `off`
- `voice_only` when the incoming message was not a transcribed voice message
- empty or whitespace response text
- error responses, including `Error:`
- gateway command responses such as `/voice status`
- turns where the agent already produced a TTS/voice artifact or called `voice.speak`
- responses that already contain a voice delivery artifact
- provider cap breaches
- `voice.autoTtsMaxCharsPerReply` breaches
- `voice.autoTtsMaxCharsPerHourPerChat` breaches
- provider readiness failures

Auto-TTS media is ephemeral. Generated files are written under selected profile temp audio space, delivered as artifact-shaped objects with `metadata.deliveryHint: "voice"` and `metadata.ephemeral: true`, and deleted in a best-effort `finally` block after delivery succeeds or fails.

Arbitrary model-emitted `MEDIA:/path` text is not an auto-TTS signal.

## Discord Voice Channels

Discord voice channels are disabled by default:

```json
{
  "channels": {
    "discord": {
      "voiceChannel": {
        "enabled": false,
        "autoJoinOnCommand": true
      }
    }
  }
}
```

When enabled:

- `GatewayIntentBits.GuildVoiceStates` is requested.
- `/voice channel` joins the caller's current Discord voice channel when available.
- `/voice leave` leaves the current Discord voice channel.
- Before joining, the bot checks `Connect`, `Speak`, and `UseVAD`.
- Missing optional Discord voice packages return a structured setup error and do not break normal Discord text startup.
- Voice-hinted TTS artifacts play through the active voice connection when joined; otherwise Discord falls back to file upload.
- Received Discord voice audio is packaged as a valid WAV file under selected profile temp audio before it is fed back through the existing gateway message path.
- Stage 2 path validation/audit and Stage 3A duplicate suppression still apply.
- Gateway shutdown and adapter stop destroy voice connections best-effort.

Optional Discord voice packages are not base dependencies. Operators install them only when they intend to use Discord voice-channel support.

## Security Boundaries

Gateway STT preprocessing runs before provider dispatch, worker startup, ffmpeg, hosted STT, downloads, or temp writes:

1. Canonicalize `attachment.localPath ?? attachment.path` under allowed media/audio roots.
2. Validate file type and size with audio input validation.
3. Check STT readiness and `stt.enabled !== false`.
4. Reject gateway-triggered faster-whisper first-run downloads unless explicitly allowed.

Allowed roots are profile-local channel media, audio cache, and selected profile temp audio roots used by voice-channel receive paths.

Audit events:

- Hook event: `gateway:stt:preprocess`
- JSONL path: `~/.estacoda/profiles/<profile-id>/gateway/logs/voice-stt-preprocess.jsonl`
- Deny/fail warning prefix: `[voice-stt-preprocess]`
- Audit data uses stable path hashes plus safe attachment metadata, not full private paths.

Local STT risk matrix:

| Local STT path | Risk class |
|----------------|------------|
| `local.command` without ffmpeg normalization | `read-only-local` |
| `local.command` with ffmpeg normalization | `workspace-write` |
| cached `local.faster-whisper` | `workspace-write` |
| first-run faster-whisper download allowed | `external-side-effect` |
| uncached faster-whisper download disallowed | `unavailable` |

Temp and cache behavior:

- Recorded CLI voice input is written under selected profile temp audio space.
- Gateway auto-TTS and Telegram conversion temps are written under selected profile temp audio space.
- Audio caches live under selected profile `audio-cache/`.
- faster-whisper model cache is controlled by `hfHome`, existing Hugging Face cache env vars, or profile-local fallback policy.
- Temp files are best-effort cleaned after delivery or playback paths.
