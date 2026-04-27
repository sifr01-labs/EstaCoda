# Environment

This file is for coding agents and operators setting up EstaCoda v2 locally. It is intentionally operational, not product-facing.

## Install

```bash
cd /Users/ahnwy/estacoda-v2
/Users/ahnwy/.bun/bin/bun install
```

If Bun is not on the default path, use the absolute binary path above.

## Core Commands

Typecheck:

```bash
cd /Users/ahnwy/estacoda-v2
/Users/ahnwy/.bun/bin/bun run typecheck
```

Smoke tests:

```bash
cd /Users/ahnwy/estacoda-v2
/Users/ahnwy/.bun/bin/bun run smoke
```

Interactive CLI:

```bash
cd /Users/ahnwy/estacoda-v2
/Users/ahnwy/.bun/bin/bun run dev
```

Live provider check:

```bash
cd /Users/ahnwy/estacoda-v2
export KIMI_API_KEY='REDACTED'
/Users/ahnwy/.bun/bin/bun run dev -- doctor --live
```

Telegram status:

```bash
cd /Users/ahnwy/estacoda-v2
/Users/ahnwy/.bun/bin/bun run dev -- telegram status
/Users/ahnwy/.bun/bin/bun run dev -- gateway status
```

Telegram gateway:

```bash
cd /Users/ahnwy/estacoda-v2
export ESTACODA_TELEGRAM_BOT_TOKEN='REDACTED'
/Users/ahnwy/.bun/bin/bun run dev -- gateway start --telegram
```

Internal alpha harness:

```bash
cd /Users/ahnwy/estacoda-v2
/Users/ahnwy/.bun/bin/bun run alpha:harness
```

## Required Environment Variables

Provider variables depend on which routes are configured:

- `KIMI_API_KEY`
- `DEEPSEEK_API_KEY`
- `OPENROUTER_API_KEY`
- `OPENAI_API_KEY`
- `GOOGLE_API_KEY`
- `ANTHROPIC_API_KEY`

Telegram:

- `ESTACODA_TELEGRAM_BOT_TOKEN`

Rules:

- do not hardcode secrets in repo files
- do not commit real keys
- prefer config to reference env var names, not secret values

## Config File Locations

User-level config:

- `~/.estacoda/config.json`

Project-level config:

- `<workspace>/.estacoda/config.json`

These merge, with project-level config acting as a local overlay.

## Runtime State Paths

Default state root:

- `~/.estacoda/`

Important files/directories under it:

- `config.json`
- `trust.json`
- `sessions.sqlite`
- `channel-media/`
- `channel-approvals.json`
- `skills/`
- `SOUL.md`
- `USER.md`
- `MEMORY.md`
- `AGENTS.md`

Project-local overlays:

- `<workspace>/.estacoda/skills/`
- `<workspace>/.estacoda/`

## Vision Route Requirement

Telegram image understanding is not guaranteed by the presence of `vision.analyze` alone.

To get real image understanding:

- configure a vision-capable provider route
- or configure an auxiliary `vision` route
- ensure credentials are valid in the same shell/process that launches the gateway

Without a real vision-capable route:

- image attachments fall back to metadata-only inspection

## Verification Levels

Use these meanings consistently:

- `live-proven`: verified by a real operator run
- `smoke-tested`: verified in `src/smoke.ts`
- `implemented but not live-proven`: code exists, but no fresh operator proof should be assumed
- `intended but not implemented`: design target only
