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
| Hosted TTS | Edge | Implemented | Uses Microsoft Edge's online speech service through `@bestcodes/edge-tts`. No API key is required, but synthesis text is sent over the network to Microsoft's Edge speech service and this is not local/offline TTS. |
| Hosted STT | OpenAI | Implemented | Uses the shared OpenAI audio credential resolver. |
| Hosted STT | Groq | Implemented | Direct environment key lookup. |
| Hosted STT | xAI | Implemented | Uses native `{baseUrl}/stt`, not an OpenAI-compatible shape. |
| Local STT | faster-whisper | Implemented | Default for `stt.provider: "local"` in v0.1.0. Uses EstaCoda's managed Python environment unless a custom Python is configured. |
| Local STT | command | Implemented | Explicit `stt.local.engine: "command"` opt-in. Preserves command-template rendering and prefers stdout transcript text. |
| Local TTS | neutts, kittentts | Deferred | Not implemented. Do not configure as available in v0.1.0. |
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
| `tts.provider` | Selected TTS provider. Implemented values are `openai`, `elevenlabs`, `minimax`, `gemini`, `xai`, and `edge`. |
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
- Edge TTS uses `tts.edge.voice`, optional `tts.edge.speed`, and provider-level `tts.speed` fallback. It does not use an API key. Edge synthesis is a networked external side effect because request text is sent to Microsoft's Edge speech service, and provider output is MP3 (`audio/mpeg`).

## faster-whisper

Local faster-whisper STT runs through one runtime-owned long-lived Python JSONL worker per runtime/profile. In v0.1.0, `stt.provider: "local"` defaults to managed faster-whisper. `stt.local.engine: "command"` is the explicit power-user path for an operator-owned STT command.

Managed environment paths:

```text
~/.estacoda/python-env
~/.estacoda/cache/huggingface
```

The virtual environment and model cache are separate. The Hugging Face/model cache does not live inside the venv.

### faster-whisper environment

Local faster-whisper STT keeps its existing managed environment path for compatibility.

The generic capability environment system uses `<stateRoot>/python-envs/<capability-id>/`, but faster-whisper is not silently migrated to that path in this change.

Config shape:

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

Command mode:

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

Setup behavior:

```bash
estacoda voice setup --stt-provider local
estacoda voice setup --stt-provider local --python-binary /path/to/python
```

Without `--python-binary`, setup checks `~/.estacoda/python-env`, creates or repairs it when needed, installs exactly `faster-whisper==1.2.1`, verifies `import faster_whisper`, and writes local STT config only after the managed environment is ready. It does not install arbitrary packages, and it does not mutate system Python or user-managed venvs. pip cache writes are constrained under EstaCoda state.

With `--python-binary`, setup skips managed environment check/create and stores the custom path. That Python environment is operator-owned.

Runtime behavior:

- Runtime resolves configured `stt.local.pythonBinary` first, otherwise the managed venv path under `~/.estacoda/python-env`.
- Runtime sets persistent model cache env defaults under `~/.estacoda/cache/huggingface`.
- When local faster-whisper STT is configured without a custom `pythonBinary`, runtime creates or repairs the managed Python environment lazily on first transcription.
- Managed runtime setup installs only the pinned faster-whisper package into `~/.estacoda/python-env`; it does not mutate system Python or operator-owned venvs.
- Managed Python setup failure does not block runtime or gateway startup; only local faster-whisper transcription is unavailable until the environment is repaired.
- A later `voice doctor` command may inspect/repair this path.

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
- Default queue depth is 1 unless config overrides it.
- Queue overflow fails fast.
- Gateway first-run model downloads inherit `allowModelDownload`. Because `allowModelDownload` defaults to `true`, the first gateway voice message may fetch the configured model files.
- Set `gatewayAllowModelDownload: false` only when gateway voice messages must use already-cached models.
- Local non-gateway faster-whisper allows model downloads by default.
- `hfHome` is passed to the worker when configured. Otherwise EstaCoda defaults `HF_HOME` to `~/.estacoda/cache/huggingface` and preserves an existing `TRANSFORMERS_CACHE` if the process already set one.

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
- Telegram `/voice on` enables spoken replies only after incoming voice messages, `/voice all` speaks eligible text replies too, `/voice off` disables spoken replies, and `/voice status` reports the resolved mode.
- With `/voice on`, an incoming Telegram voice message follows this path: Telegram voice message -> STT transcript -> agent text response -> configured TTS provider -> Telegram voice/audio reply.
- Telegram auto-TTS creates ephemeral delivery audio. It is not written into durable artifact history, prompt context, model-visible attachments, or normal long-term artifacts.
- Telegram tries to deliver spoken replies as a native voice bubble. Edge returns MP3, so native voice bubbles usually require ffmpeg conversion to OGG/Opus; with ffmpeg, Telegram receives a native voice bubble, and without ffmpeg, Telegram receives a normal audio file instead.
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
4. Apply faster-whisper download policy before any gateway-triggered first-run model download. Gateway downloads inherit `allowModelDownload`, which defaults to `true`; `gatewayAllowModelDownload: false` explicitly blocks them.

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
- faster-whisper uses `~/.estacoda/python-env` for the managed venv and `~/.estacoda/cache/huggingface` for default model cache. These paths are separate.
- faster-whisper model cache is controlled by `hfHome`, existing Hugging Face cache env vars, or the global EstaCoda cache fallback.
- Temp files are best-effort cleaned after delivery or playback paths.
