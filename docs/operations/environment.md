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

Rules:
- Do not hardcode secrets in repo files.
- Do not commit real keys.
- Default setup stores pasted secrets in the selected profile `.env` with `0600` permissions.
- Advanced setup can reference an existing environment variable.

## Config Files

**Selected profile:** `~/.estacoda/profiles/<id>/config.json`

Runtime config loads exactly one selected profile config: an explicit `--profile`/`profileId`, the active profile, or `default`. There is no user/project config merge and no credential-pool config surface.

## Runtime State Paths

Default root: `~/.estacoda/`

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
