---
title: "Voice Operations"
description: "Operator runbook for voice setup, readiness, troubleshooting, and validation."
---

# Voice Operations

Voice is optional. Core CLI and gateway text operation should continue to work when voice providers, local audio tooling, Discord voice packages, or live provider credentials are absent.

## CLI Commands

| Command | Purpose |
|---------|---------|
| `estacoda voice status` | Show configured TTS/STT providers and readiness reasons. |
| `estacoda voice setup ...` | Configure TTS/STT provider references and safe env-var names in the selected profile. |
| `estacoda voice mode on` | Enable CLI push-to-talk input. |
| `estacoda voice mode off` | Disable CLI push-to-talk input. |
| `estacoda voice mode tts` | Enable CLI push-to-talk input with best-effort local playback of TTS replies. |
| `estacoda voice mode status` | Show profile-local CLI voice mode state. |

Common setup examples:

```bash
estacoda voice status
estacoda voice setup --tts-provider openai --tts-model gpt-4o-mini-tts --tts-voice alloy --tts-api-key-env VOICE_TOOLS_OPENAI_KEY
estacoda voice setup --tts-provider edge --tts-voice en-US-AriaNeural
estacoda voice setup --stt-provider openai --stt-model gpt-4o-mini-transcribe --stt-api-key-env VOICE_TOOLS_OPENAI_KEY
estacoda voice setup --stt-provider local --stt-model base
estacoda voice setup --stt-provider local --python-binary /path/to/python
estacoda voice mode status
```

`estacoda voice setup --tts-provider openai` is TTS-only. It does not mutate STT config and does not touch the managed Python environment.

CLI voice mode state is profile-local at:

```text
~/.estacoda/profiles/<profile-id>/cli-voice-mode.json
```

Push-to-talk behavior:

- Records local microphone input as 16 kHz mono WAV.
- Writes recorded audio only under selected profile temp audio space.
- Transcribes through configured STT.
- Prints the transcript.
- Injects non-empty transcript text as the next user turn in the current CLI conversation.
- In `tts` mode, local playback is best-effort after a response is available.
- Supported playback commands are `afplay`, `aplay`, `paplay`, and `ffplay`.
- If no local player is available, playback is skipped cleanly.

Microphone detection:

| Environment | Behavior |
|-------------|----------|
| SSH session | Reports local microphone unavailable and suggests local recording/path input. |
| Termux | Uses `termux-microphone-record` when available. |
| WSL/PulseAudio | Checks `pactl list sources`. |
| Native Linux/macOS | Uses supported recorder commands such as `sox`, `arec`, or `rec` where available. |

Node native audio addons are out of scope.

## Gateway Commands

Gateway `/voice` commands are parsed by `ChannelGateway` before runtime routing. Adapters do not parse `/voice` themselves.

| Command | Behavior |
|---------|----------|
| `/voice on` | Set the current chat to `voice_only`. |
| `/voice voice` | Alias for `voice_only`. |
| `/voice all` | Set the current chat to `all`. |
| `/voice tts` | Alias for `all`. |
| `/voice off` | Disable auto-TTS for the current chat. |
| `/voice status` | Report current resolved mode. |
| `/voice channel` | Discord only; joins the caller's current voice channel when configured and permitted. |
| `/voice leave` | Discord only; leaves the active Discord voice channel. |

Voice state is profile-local:

```text
~/.estacoda/profiles/<profile-id>/gateway/voice-mode.json
```

Group-chat command handling follows existing gateway authorization, mention, and free-response gating. Unauthorized users cannot mutate per-chat voice state.

For an incoming Telegram voice message with `/voice on`, the path is: Telegram voice message -> STT transcript -> agent text response -> configured TTS provider -> Telegram voice/audio reply. With Edge TTS, the response text is sent to Microsoft's Edge speech service and Edge returns MP3 (`audio/mpeg`).

## Provider Setup

Implemented hosted TTS providers:

- OpenAI
- ElevenLabs
- MiniMax
- Gemini
- xAI
- Edge

Implemented hosted STT providers:

- OpenAI
- Groq
- xAI

Implemented local STT:

- managed faster-whisper, the default meaning of `stt.provider: "local"` in v0.1.0
- command engine, only when `stt.local.engine: "command"` is configured explicitly

Deferred in v0.1.0:

- local TTS providers `neutts` and `kittentts`
- Mistral TTS/STT

Voice credentials are direct environment variables only for providers that require keys. Put real keys in the selected profile `.env` or an environment source for the service process. Do not put raw keys in `config.json`. Edge TTS does not require an API key, but it is not local/offline: synthesis text is sent over the network to Microsoft's Edge speech service and must be treated as an external side effect.

OpenAI audio credential lookup:

1. configured `apiKeyEnv`
2. `VOICE_TOOLS_OPENAI_KEY`
3. `OPENAI_API_KEY`, only when the configured env is the default `VOICE_TOOLS_OPENAI_KEY`

A missing custom OpenAI audio env var does not fall back to `OPENAI_API_KEY`.

## faster-whisper Operations

Local faster-whisper STT uses an EstaCoda-managed Python environment by default. It exists to remove the "which Python did the gateway use?" class of failure without modifying system Python or user-managed virtual environments.

Managed paths:

```text
~/.estacoda/python-env
~/.estacoda/cache/huggingface
```

The first path is the managed virtual environment. The second path is the Hugging Face/model cache. The model cache does not live inside the virtual environment.

Typical local setup:

```bash
estacoda voice setup --stt-provider local --stt-model base
```

When no custom Python binary is provided, setup:

1. checks `~/.estacoda/python-env`
2. creates or repairs it when missing/corrupted
3. installs exactly `faster-whisper==1.2.1`
4. verifies the Python can import `faster_whisper`
5. writes local STT config only after setup succeeds

Progress output is curated milestones, not raw pip logs. Subprocess diagnostics are bounded and redacted.

EstaCoda does not install arbitrary user packages into this environment. pip cache writes for managed setup are constrained under EstaCoda state.

System Python is used only to create the managed venv. System Python, conda envs, project venvs, poetry envs, and uv envs are not modified.

Custom Python escape hatch:

```bash
estacoda voice setup --stt-provider local --python-binary /path/to/python
```

This skips managed environment check/create and stores the custom Python path. The operator owns that Python environment, including installing `faster-whisper` and keeping it compatible.

Command-engine escape hatch:

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

`stt.local.engine: "command"` wins. It does not use managed faster-whisper.

Runtime behavior:

- Runtime resolves configured `stt.local.pythonBinary` first, otherwise the managed venv Python under `~/.estacoda/python-env`.
- Runtime sets persistent `HF_HOME` / `TRANSFORMERS_CACHE` defaults under `~/.estacoda/cache/huggingface` for faster-whisper.
- When local faster-whisper STT is configured without a custom `pythonBinary`, runtime creates or repairs the managed Python environment lazily on first transcription.
- Managed runtime setup installs only the pinned faster-whisper package into `~/.estacoda/python-env`; it does not mutate system Python or operator-owned venvs.
- Managed Python setup failure does not block runtime or gateway startup; only local faster-whisper transcription is unavailable until the environment is repaired.

Future work:

- `voice doctor` may inspect/repair this path later.

The worker file is packaged at:

```text
workers/faster-whisper/faster-whisper-worker.py
```

Operational notes:

- Gateway first-run model downloads inherit `allowModelDownload`. Because `allowModelDownload` defaults to `true`, the first gateway voice message may fetch the configured model files.
- Set `stt.local.fasterWhisper.gatewayAllowModelDownload: false` only when gateway voice messages must use already-cached models.
- Local faster-whisper allows model downloads by default for normal local use.
- Use `hfHome` to override the model cache root when needed.
- Without `hfHome`, EstaCoda defaults the worker cache path to `~/.estacoda/cache/huggingface` unless `TRANSFORMERS_CACHE` is already set in the process environment.
- Missing Python packages should surface as readiness/setup hints, not gateway crashes.
- Runtime disposal shuts down the worker.

Common readiness cases:

| Status | Likely cause | Operator action |
|--------|--------------|-----------------|
| `missing key` | Env var referenced by provider is absent. | Add it to selected profile `.env` or service environment. |
| `disabled` | `tts.enabled` or `stt.enabled` is `false`. | Enable the provider if intended. |
| `not implemented` | Deferred provider selected. | Select an implemented provider. |
| `python package missing` | faster-whisper import fails. | Run `estacoda voice setup --stt-provider local`, or repair `~/.estacoda/python-env`. If using `--python-binary`, repair that operator-owned environment. |
| `venv support missing` | Python reports missing `ensurepip` or venv support. | Install OS venv support, for example `sudo apt install python3.13-venv` or `sudo apt install python3-venv`, then retry local STT setup. |
| `download required` | Selected model is not cached and downloads are disallowed. | Pre-cache the model or explicitly allow download. |
| `queue full` | faster-whisper queue depth exceeded. | Wait, raise queue depth, or reduce concurrent requests. |
| `timeout` | STT request exceeded timeout. | Check model/device performance and timeout config. |

## ffmpeg And Channel Voice Delivery

ffmpeg is optional but recommended:

- Local command STT can normalize non-WAV/AIFF input to WAV when ffmpeg is available.
- Telegram voice-hinted non-OGG/Opus audio converts to Opus OGG with:
- WhatsApp voice-hinted non-OGG/Opus audio converts to Opus OGG in the main runtime before bridge delivery.

```bash
ffmpeg -i input -c:a libopus -b:a 24k output.ogg
```

Telegram auto-TTS tries native voice-bubble delivery. Edge TTS returns MP3 (`audio/mpeg`), so Telegram voice-bubble delivery usually needs ffmpeg conversion to OGG/Opus. If ffmpeg is missing or conversion fails, Telegram and WhatsApp fall back to normal audio delivery instead of voice-bubble delivery. WhatsApp fallback captions state that voice-bubble conversion was unavailable.

Existing `.ogg`, `.opus`, and `audio/ogg` artifacts continue to use voice-bubble delivery where the channel supports it. Arbitrary model-emitted `MEDIA:/path` response text is not treated as auto-TTS or a voice conversion request.

## Discord Voice Operations

Discord voice-channel support is disabled unless configured:

```json
{
  "channels": {
    "discord": {
      "voiceChannel": {
        "enabled": true,
        "autoJoinOnCommand": true
      }
    }
  }
}
```

Requirements:

- Optional Discord voice packages installed in the operator environment.
- `GatewayIntentBits.GuildVoiceStates` available to the bot.
- Bot permissions in the target voice channel: `Connect`, `Speak`, and `UseVAD`.

Optional voice packages are intentionally not base dependencies. If they are absent:

- normal Discord text startup still works
- `/voice channel` returns a structured setup error with an install hint

Missing intents or permissions fail before any partial join.

Shutdown behavior:

- `/voice leave` destroys the active connection and is idempotent.
- Adapter stop and gateway shutdown destroy all tracked voice connections best-effort.
- Cleanup failures are caught so normal adapter/client shutdown can continue.

## Logs, Temp Files, And State

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

## Security Checklist

- Keep voice provider keys in env vars only.
- Do not configure deferred providers as production-ready.
- Keep gateway allowlists tight before enabling voice commands in group or guild contexts.
- Treat Discord voice as a remote-control surface.
- If gateway-triggered model downloads are not acceptable, explicitly set `stt.local.fasterWhisper.gatewayAllowModelDownload: false`.
- Keep command-engine STT and custom Python paths as explicit operator-owned escape hatches.
- Do not install arbitrary user packages into the managed Python environment.
- Keep ffmpeg and custom Python dependencies pinned or managed by the operator environment.
- Review `[voice-stt-preprocess]` warnings for denied files, readiness failures, and download denials.

## Validation

Targeted tests for voice work:

```bash
pnpm exec vitest run src/tools/voice-tools.test.ts src/tools/tts-providers.test.ts src/tools/stt-providers.test.ts
pnpm exec vitest run src/channels/voice-transcription.test.ts src/channels/channel-gateway.test.ts src/gateway/voice-state.test.ts
pnpm exec vitest run src/channels/telegram-adapter.test.ts src/channels/discord-adapter.test.ts src/channels/discord-voice-bridge.test.ts
pnpm exec vitest run src/cli/voice-mode.test.ts src/cli/session-loop.test.ts
```

Standard validation:

```bash
pnpm run typecheck
pnpm run test
pnpm run smoke
pnpm run build
pnpm run audit:runtime-imports
pnpm run audit:esm
pnpm run smoke:dist
git diff --check
```

Base CI uses mocks for provider calls, optional Discord voice packages, and faster-whisper behavior when live services or optional packages are absent. Live provider calls, real Discord voice-channel sessions, real microphone input, and real model downloads are operator integration tests, not base CI requirements.
