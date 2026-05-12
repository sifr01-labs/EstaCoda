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
- Default setup stores pasted secrets in `~/.estacoda/.env` with `0600` permissions.
- Advanced setup can reference an existing environment variable.

## Config Files

**User-level:** `~/.estacoda/config.json`
**Project-level:** `<workspace>/.estacoda/config.json`

These deep-merge, with project-level config as a local overlay. Nested provider, credential-pool, auxiliary-provider, and MCP server entries preserve user-level fields unless explicitly overridden.

## Runtime State Paths

Default root: `~/.estacoda/`

| Path | Purpose |
|------|---------|
| `config.json` | User configuration |
| `.env` | Secrets |
| `trust.json` | Workspace trust grants |
| `sessions.sqlite` | Gateway session database |
| `channel-media/` | Downloaded channel attachments |
| `channel-approvals.json` | Persisted channel approvals |
| `skills/` | Personal skills |
| `SOUL.md` | Agent identity |
| `USER.md` | User preferences |
| `MEMORY.md` | Agent notes |
| `cron/jobs.json` | Scheduled tasks |
| `cron/output/` | Task output files |

**Project-local overlays:**

| Path | Purpose |
|------|---------|
| `<workspace>/.estacoda/skills/` | Project skills |
| `<workspace>/.estacoda/skill-learning.json` | Workflow learning state |
| `<workspace>/.estacoda/config.json` | Project config |

## Runtime Contract

EstaCoda's public runtime contract is:

- Node.js >= 22.18.0
- pnpm via Corepack
- compiled `dist/` for production execution
- `better-sqlite3` behind the internal SQLite adapter
- Bun optional for explicitly named `*:bun` scripts only

Do not add new foundational runtime dependencies on Bun. If Bun is used locally, keep it informational and isolated behind clearly named optional scripts.
