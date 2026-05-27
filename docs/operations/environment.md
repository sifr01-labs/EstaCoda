---
title: "Environment Setup"
description: "Development environment, dependencies, and runtime state paths."
---

# Environment Setup

## Prerequisites

- Node.js >= 22.18.0 — production runtime target
- Corepack / pnpm — source package-manager and script runner
- Bun — optional dev-speed lane only

## Install

```bash
cd /path/to/EstaCoda
corepack enable
pnpm install
```

This installs:
- `typescript`
- `@types/node`
- `tsx`
- `better-sqlite3`
- runtime channel dependencies

Production dependencies are installed through pnpm. SQLite state uses `better-sqlite3` behind EstaCoda's internal storage adapter.

## Core Commands

| Command | Purpose |
|---------|---------|
| `pnpm run typecheck` | TypeScript type check (`tsc --noEmit`) |
| `pnpm run test` | Authoritative Node/Vitest test lane |
| `pnpm run smoke` | Run source-mode smoke tests |
| `pnpm run build` | Compile production `dist/` output |
| `pnpm run start` | Run `dist/index.js` under Node |
| `pnpm run smoke:dist` | Run smoke checks from built `dist/` |
| `pnpm run alpha:harness` | Generate internal alpha run folder |
| `pnpm run eval:substrate` | Generate eval run scaffold |
| `pnpm run provider:hardening` | Live provider acceptance sweep |

## Environment Variables

State isolation:

| Variable | Purpose |
|----------|---------|
| `ESTACODA_HOME` | Override the EstaCoda state home. Defaults to the OS `HOME` with state under `~/.estacoda`. This does not change the operating-system user home. |
| `HOME` | Operating-system user home. EstaCoda uses it for OS-home behavior such as `~` expansion and service-user paths. Do not use `HOME` as the state isolation knob when `ESTACODA_HOME` is available. |

Provider keys (configure at least one):

| Variable | Provider |
|----------|----------|
| `KIMI_API_KEY` | Kimi |
| `DEEPSEEK_API_KEY` | DeepSeek |
| `OPENROUTER_API_KEY` | OpenRouter |
| `OPENAI_API_KEY` | OpenAI |
| `GOOGLE_API_KEY` | Google |
| `ANTHROPIC_API_KEY` | Anthropic |

Telegram:

| Variable | Purpose |
|----------|---------|
| `ESTACODA_TELEGRAM_BOT_TOKEN` | Telegram bot token |

Voice:

| Variable | Purpose |
|----------|---------|
| `VOICE_TOOLS_OPENAI_KEY` | Default OpenAI audio key for TTS/STT. |
| `OPENAI_API_KEY` | OpenAI audio fallback only when the configured OpenAI audio env is the default `VOICE_TOOLS_OPENAI_KEY`. |
| `ELEVENLABS_API_KEY` | ElevenLabs TTS. |
| `MINIMAX_API_KEY` | MiniMax TTS. |
| `GEMINI_API_KEY` | Gemini TTS. |
| `XAI_API_KEY` | xAI native TTS/STT. |
| `GROQ_API_KEY` | Groq STT. |
| `HF_HOME` | Optional faster-whisper/Hugging Face model cache root when `hfHome` is not configured. |
| `TRANSFORMERS_CACHE` | Optional Hugging Face cache env respected by the worker environment. |

Voice credentials are direct environment-variable references only. There are no voice credential pools, gateway brokers, managed fallbacks, `useGateway`, or non-env credential sources.

Rules:
- Do not hardcode secrets in repo files.
- Do not commit real keys.
- Default setup stores pasted secrets in the selected profile `.env` with `0600` permissions.
- Advanced setup can reference an existing environment variable.

## Config Files

**Selected profile:** `~/.estacoda/profiles/<id>/config.json`

Runtime config loads exactly one selected profile config: an explicit `--profile`/`profileId`, the active profile, or `default`. There is no user/project config merge and no credential-pool config surface.

## Runtime State Paths

Default root: `~/.estacoda/` (override with `ESTACODA_HOME`)

EstaCoda keeps two home concepts separate:

| Concept | Controlled by | Used for |
|---------|---------------|----------|
| `stateHomeDir` / `estacodaHomeDir` | explicit home option, then `ESTACODA_HOME`, then `HOME`, then `os.homedir()` | EstaCoda state root, profile config, profile-local `.env`, session database, gateway state/log/cron paths, generated service `ESTACODA_HOME` |
| `osHomeDir` / `serviceUserHomeDir` | `HOME`, then `USERPROFILE`, then `os.homedir()` | OS user home, `~` expansion, systemd user unit path, launchd plist path, generated service `HOME` |

Example split:

```bash
HOME=/home/agent ESTACODA_HOME=/srv/estacoda-state estacoda gateway status
```

Expected paths:

```text
EstaCoda state:
  /srv/estacoda-state/.estacoda/...

OS/service files:
  /home/agent/.config/systemd/user/...
  /home/agent/Library/LaunchAgents/...

Generated service environment:
  ESTACODA_HOME=/srv/estacoda-state
  HOME=/home/agent
```

| Path | Purpose |
|------|---------|
| `active-profile.json` | Active profile pointer |
| `trust.json` | Workspace trust grants |
| `workspace-approvals.json` | Workspace approval grants |
| `sessions.sqlite` | Global session database with `profile_id` scoping |
| `memory/shared/` | Global shared memory |
| `packs/` | Global pack cache |

Profile root: `~/.estacoda/profiles/<id>/`

| Path | Purpose |
|------|---------|
| `config.json` | Selected profile configuration |
| `.env` | Selected profile secrets |
| `auth.json` | Selected profile OAuth auth state |
| `USER.md` | Profile user preferences |
| `SOUL.md` | Profile identity/persona |
| `MEMORY.md` | Profile learned facts |
| `promotions.json` | Profile memory promotion metadata |
| `skills/` | Profile-installed skills |
| `cron/` | Profile cron/flow state |
| `logs/` | Profile logs |
| `gateway/` | Profile gateway state |
| `channel-media/` | Profile channel attachments |
| `audio-cache/` | Profile audio cache |
| `image-cache/` | Profile image cache |
| `temp/` | Profile temporary files |

Voice uses profile-local `temp/audio/` for CLI recordings, auto-TTS temp files, Telegram conversion temps, and Discord voice receive audio. Gateway voice state and STT preprocess audit logs live under the selected profile `gateway/` directory.

**Project-local overlays:**

| Path | Purpose |
|------|---------|
| `AGENTS.md` | Workspace instructions |
| `<workspace>/.estacoda/` | Workspace-local operational artifacts, when a specific subsystem uses them |

Workspace trust is directory action trust only. It does not enable config loading from `<workspace>/.estacoda/config.json`.

## Runtime Contract

EstaCoda's public runtime contract is:

- Node.js >= 22.18.0
- pnpm via Corepack
- compiled `dist/` for production execution
- `better-sqlite3` behind the internal SQLite adapter
- Bun optional for explicitly named `*:bun` scripts only

Do not add new foundational runtime dependencies on Bun. If Bun is used locally, keep it informational and isolated behind clearly named optional scripts.
