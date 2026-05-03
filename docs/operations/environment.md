---
title: "Environment Setup"
description: "Development environment, dependencies, and runtime state paths."
---

# Environment Setup

## Prerequisites

- [Bun](https://bun.sh) — EstaCoda is built and run with Bun
- Node.js 22+ — available as fallback for typechecking

## Install

```bash
cd /path/to/EstaCoda
bun install
```

This installs:
- `typescript`
- `@types/node`

There are **zero production dependencies**.

## Core Commands

| Command | Purpose |
|---------|---------|
| `bun run typecheck` | TypeScript type check (`tsc --noEmit`) |
| `bun run smoke` | Run smoke tests |
| `bun run dev` | Start interactive CLI |
| `bun run alpha:harness` | Generate internal alpha run folder |
| `bun run eval:substrate` | Generate eval run scaffold |
| `bun run provider:hardening` | Live provider acceptance sweep |

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

## Bun Lock-in

EstaCoda uses Bun-specific features:
- `bun:sqlite` for session database
- `bun` shebang and execpath in package.json scripts

**Impact:** Smoke tests and runtime execution require Bun. Node execution fails on `bun:` imports.

**Mitigation:** SQLite is already behind a session DB interface (`src/session/`). Full Node compatibility remains deferred until post-MVP.
