---
title: Voice
description: TTS, STT, auto-TTS, and CLI push-to-talk.
sidebar_position: 12
---

# Voice

Voice is an optional media capability. It is separate from the primary LLM provider route and uses direct environment-variable credentials only.

If voice providers, local audio tooling, or live credentials are absent, core CLI and gateway text operation continues unchanged. Voice does not block the rest of the system.

## What voice covers

| Capability | What it does |
|------------|--------------|
| TTS | Converts agent text replies into audio. |
| STT | Converts user audio into transcript text. |
| Auto-TTS | Optionally vocalizes gateway replies per chat. |
| CLI push-to-talk | Records local microphone input and injects the transcript into the current CLI session. |

## Provider maturity in v0.1.0

### Hosted TTS — stable

| Provider | Notes |
|----------|-------|
| OpenAI | Default. Uses shared OpenAI audio credential resolver. |
| ElevenLabs | Uses `xi-api-key` and provider text limits. |
| MiniMax | Decodes base64 JSON audio responses. |
| Gemini | Sends `speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName`. |
| xAI | Uses native `{baseUrl}/tts`; not OpenAI-compatible. |

### Hosted STT — stable

| Provider | Notes |
|----------|-------|
| OpenAI | Uses shared OpenAI audio credential resolver. |
| Groq | Direct environment key lookup. |
| xAI | Uses native `{baseUrl}/stt`; not OpenAI-compatible. |

### Local STT — stable

| Engine | Notes |
|--------|-------|
| `faster-whisper` | Default for `stt.provider: "local"` in v0.1.0. Uses EstaCoda's managed Python environment unless a custom Python is configured. |
| `command` | Explicit `stt.local.engine: "command"` opt-in. Runs a configured command template; prefers stdout transcript text. |

### Deferred or experimental

- Local TTS providers — not implemented in v0.1.0.
- Mistral TTS/STT — config shape may exist, but execution is unavailable.

Do not configure deferred providers as production-ready.

## Configuration

Voice config lives in the selected profile:

```text
~/.estacoda/profiles/<profile-id>/config.json
```

Example:

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
| `tts.provider` | Implemented hosted values: `openai`, `elevenlabs`, `minimax`, `gemini`, `xai`. |
| `tts.enabled` | When `false`, TTS readiness fails even if credentials are present. |
| `stt.provider` | Implemented values: `openai`, `groq`, `xai`, `local`. |
| `stt.enabled` | When `false`, STT readiness fails before transcription side effects. |
| `voice.autoTts` | Gateway auto-TTS global default. Default `false`. When `true` and no per-chat override exists, it maps to `voice_only`. |
| `voice.autoTtsMaxCharsPerReply` | Optional per-reply cap checked before synthesis. |
| `voice.autoTtsMaxCharsPerHourPerChat` | Optional hourly cap tracked per platform/chat. |

### Credentials

Voice credentials are direct environment variables only. There are no voice credential pools, gateway brokers, managed fallbacks, or non-env sources.

OpenAI audio credential resolver order:

1. `config.openai.apiKeyEnv`
2. `VOICE_TOOLS_OPENAI_KEY`
3. `OPENAI_API_KEY`, only when the configured env is the default `VOICE_TOOLS_OPENAI_KEY`

A custom OpenAI audio env var that is missing does not fall back to `OPENAI_API_KEY`. Resolved keys are never logged or returned in errors.

Provider-specific notes:

- xAI TTS uses `voiceId`, `language`, `sampleRate`, `bitRate`, `baseUrl`, `apiKeyEnv`, and optional `speed`. It does not use `tts.xai.model`.
- xAI STT uses `baseUrl`/`base_url`, `apiKeyEnv`/`api_key_env`, optional `language`, `format`, `diarize`, `keyterms`, `fillerWords`, and raw-audio hints. It does not use `stt.xai.model`.
- Gemini TTS sends `speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName`.

## CLI push-to-talk

CLI voice mode is profile-local:

```bash
estacoda voice mode on       # Enable push-to-talk input
estacoda voice mode tts      # Enable push-to-talk with best-effort local playback of TTS replies
estacoda voice mode off      # Disable
estacoda voice mode status   # Show current mode
```

State file:

```text
~/.estacoda/profiles/<profile-id>/cli-voice-mode.json
```

Behavior:

- Records local microphone input as 16 kHz mono WAV.
- Writes audio only under the selected profile temp audio space.
- Transcribes through the configured STT provider.
- Prints the transcript.
- Injects non-empty transcript text as the next user turn in the current CLI conversation.
- In `tts` mode, local playback is best-effort after the response is available.
- Supported playback commands: `afplay`, `aplay`, `paplay`, `ffplay`.
- If no local player is available, playback is skipped cleanly.

Microphone detection:

| Environment | Behavior |
|-------------|----------|
| SSH session | Reports local microphone unavailable; suggests local recording or path input. |
| Termux | Uses `termux-microphone-record` when available. |
| WSL / PulseAudio | Checks `pactl list sources`. |
| Native Linux / macOS | Uses supported recorder commands (`sox`, `arec`, `rec`) where available. |

Node native audio addons are out of scope.

## Gateway auto-TTS

Gateway `/voice` commands are parsed by `ChannelGateway`, not by adapters. Adapters expose capability methods where needed.

Per-chat voice state is profile-local:

```text
~/.estacoda/profiles/<profile-id>/gateway/voice-mode.json
```

Modes:

| Mode | Meaning |
|------|---------|
| `off` | Do not auto-TTS gateway replies for this chat. |
| `voice_only` | Auto-TTS only replies to incoming voice messages that produced a transcript. |
| `all` | Auto-TTS eligible non-command text replies in this chat. |

Commands:

| Command | Behavior |
|---------|----------|
| `/voice on` | Set the chat to `voice_only`. |
| `/voice voice` | Alias for `voice_only`. |
| `/voice all` | Set the chat to `all`. |
| `/voice tts` | Alias for `all`. |
| `/voice off` | Set the chat to `off`. |
| `/voice status` | Report the resolved mode for the chat. |
| `/voice channel` | Discord only; joins the caller's current voice channel when configured and permitted. |
| `/voice leave` | Discord only; leaves the active Discord voice channel. |

Group-chat `/voice` handling follows existing gateway auth, mention, and free-response gating. Unauthorized users cannot mutate per-chat voice state.

### Transcript injection

Successful STT uses exactly:

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

### Auto-TTS behavior

Gateway auto-TTS is opt-in and text-first:

- `voice.autoTts` defaults to `false`.
- If no per-chat override exists, `voice.autoTts: true` maps to `voice_only`, not `all`.
- Text delivery remains primary.
- Auto-TTS is best-effort and fail-open to text.
- Provider and delivery failures log safe warnings and leave text intact.

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

## faster-whisper local STT

Local faster-whisper STT runs through one runtime-owned long-lived Python JSONL worker per runtime/profile. In v0.1.0, `stt.provider: "local"` means managed faster-whisper by default.

Managed paths:

```text
~/.estacoda/python-env
~/.estacoda/cache/huggingface
```

`~/.estacoda/python-env` is the managed virtual environment. `~/.estacoda/cache/huggingface` is the default model cache. The model cache does not live inside the venv.

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
        "gatewayAllowModelDownload": false,
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

`stt.local.engine: "command"` wins and does not use managed faster-whisper.

### Managed environment setup

```bash
estacoda voice setup --stt-provider local
```

When no custom Python binary is provided, setup:

1. checks `~/.estacoda/python-env`
2. creates or repairs it when missing/corrupted
3. installs exactly `faster-whisper==1.2.1`
4. verifies `import faster_whisper`
5. writes local STT config only after setup succeeds

Setup uses curated progress messages, not raw pip logs. EstaCoda does not install arbitrary user packages into the managed environment. System Python is used only to create the venv; system Python, conda envs, project venvs, poetry envs, and uv envs are not modified. pip cache writes during managed setup are constrained under EstaCoda state.

Custom Python:

```bash
estacoda voice setup --stt-provider local --python-binary /path/to/python
```

This skips managed environment check/create and stores the custom path. The operator owns that Python environment, including installing `faster-whisper`.

TTS-only setup remains TTS-only:

```bash
estacoda voice setup --tts-provider openai
```

It does not mutate STT config and does not touch the managed Python environment.

### Runtime phase boundary

- Runtime resolves configured `stt.local.pythonBinary` first, otherwise the managed venv path under `~/.estacoda/python-env`.
- Runtime sets persistent `HF_HOME` / `TRANSFORMERS_CACHE` defaults under `~/.estacoda/cache/huggingface`.
- Runtime does not create the managed environment, install packages, or repair Python in Phase 1.
- Gateway first-use package install is not part of Phase 1.
- A later `voice doctor` command may inspect/repair this path. Gateway first-use install may be allowed later for explicitly configured local STT, but it is not implemented here.

Operational behavior:

- Default model is `base`. Supported presets: `tiny`, `small`, `medium`, `large-v1`, `large-v2`, `large-v3`.
- The worker protocol includes `protocolVersion: 1`.
- Models are cached by `(model, device, computeType)`.
- CUDA/device failures retry once with `device: "cpu"` and `computeType: "int8"` through the same worker.
- Unexpected worker exit restarts once, then marks faster-whisper unavailable for the current runtime.
- `runtime.dispose()` shuts down the worker.
- Default timeout is 300 seconds.
- Default queue depth is 1 unless overridden.
- Queue overflow fails fast.
- The gateway denies first-run model downloads by default before worker startup. Set `gatewayAllowModelDownload: true` only when that side effect is acceptable.
- Local non-gateway faster-whisper allows model downloads by default.
- `hfHome` is passed to the worker when configured. Otherwise EstaCoda defaults `HF_HOME` to `~/.estacoda/cache/huggingface` and preserves an existing `TRANSFORMERS_CACHE` if the process already set one.

The worker file is packaged at:

```text
workers/faster-whisper/faster-whisper-worker.py
```

## Failure modes

| Symptom | Likely cause | Recovery |
|---------|--------------|----------|
| `missing key` | Env var referenced by provider is absent. | Add it to the selected profile `.env` or service environment. |
| `disabled` | `tts.enabled` or `stt.enabled` is `false`. | Enable the provider in profile config if intended. |
| `not implemented` | Deferred provider selected (e.g., Mistral). | Select an implemented provider. |
| `python package missing` | faster-whisper import fails. | Run `estacoda voice setup --stt-provider local`, or repair `~/.estacoda/python-env`. If using `--python-binary`, repair that operator-owned environment. |
| `download required` | Selected model is not cached and downloads are disallowed. | Pre-cache the model or explicitly allow download. |
| `queue full` | faster-whisper queue depth exceeded. | Wait, raise queue depth, or reduce concurrent requests. |
| `timeout` | STT request exceeded timeout. | Check model/device performance and timeout config. |
| Provider unavailable | Network error or provider 5xx. | Check connectivity and provider status. |
| Gateway auto-TTS cap reached | Per-reply or per-hour limit exceeded. | Wait for the hourly window or raise the cap. |
| Missing audio dependency | ffmpeg missing for format normalization. | Install ffmpeg; operation degrades gracefully without it. |

## State, temp, and cache locations

| Path | Purpose |
|------|---------|
| `~/.estacoda/profiles/<profile-id>/temp/audio/` | CLI recordings, auto-TTS temp files, Telegram conversion temps, Discord receive audio. |
| `~/.estacoda/profiles/<profile-id>/audio-cache/` | Profile audio cache and local-command output workspace. |
| `~/.estacoda/profiles/<profile-id>/channel-media/` | Gateway-downloaded channel attachments. |
| `~/.estacoda/profiles/<profile-id>/gateway/logs/voice-stt-preprocess.jsonl` | Gateway STT preprocess audit events. |
| `~/.estacoda/python-env` | Managed Python virtual environment for local faster-whisper STT. |
| `~/.estacoda/cache/huggingface` | Default faster-whisper / Hugging Face model cache. Separate from the venv. |
| `~/.estacoda/cache/pip` | Managed setup pip cache when packages are installed. |
| `hfHome` or Hugging Face cache env | Optional faster-whisper model cache override. |

Audit events do not log full private paths. They use stable path hashes and safe attachment metadata.

## Security boundaries

Gateway STT preprocessing runs before provider dispatch, worker startup, ffmpeg, hosted STT, downloads, or temp writes:

1. Canonicalize `attachment.localPath ?? attachment.path` under allowed media/audio roots.
2. Validate file type and size with audio input validation.
3. Check STT readiness and `stt.enabled !== false`.
4. Reject gateway-triggered faster-whisper first-run downloads unless explicitly allowed.

Allowed roots are profile-local channel media, audio cache, and selected profile temp audio roots used by voice-channel receive paths.

## Related docs

- [Gateway](./gateway.md) — gateway runtime, busy policies, and service management
- [Channels](./channels.md) — channel configuration and maturity
- [Tools](./tools.md) — tool availability and risk classes
