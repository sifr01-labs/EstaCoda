# Testing

This file is for engineers and coding agents validating the current milestone.

## Install / Bootstrap

```bash
cd /Users/ahnwy/estacoda-v2
/Users/ahnwy/.bun/bin/bun install
```

## Fast Regression Checks

Run these first:

```bash
cd /Users/ahnwy/estacoda-v2
/Users/ahnwy/.bun/bin/bun run typecheck
/Users/ahnwy/.bun/bin/bun run smoke
```

These should stay green before and after most changes.

Evidence level:

- `typecheck`: compile guard only
- `smoke`: `smoke-tested`

## CLI Sanity Checks

```bash
cd /Users/ahnwy/estacoda-v2
/Users/ahnwy/.bun/bin/bun run dev -- doctor --live
/Users/ahnwy/.bun/bin/bun run dev
```

Inside the interactive session, useful checks:

- `/trust`
- file write/read prompt
- `/reset`
- `/skills`
- `/tools`
- `/exit`

Evidence level:

- CLI file edit/read/verify flow: `live-proven`
- broader CLI ergonomics: partial and still needs judgment during live runs

## Alpha Harness

Generate a tracked run folder:

```bash
cd /Users/ahnwy/estacoda-v2
/Users/ahnwy/.bun/bin/bun run alpha:harness
```

Then follow:

- [docs/INTERNAL_ALPHA_RUNBOOK.md](/Users/ahnwy/estacoda-v2/docs/INTERNAL_ALPHA_RUNBOOK.md)

## Telegram Checks

### Setup

```bash
cd /Users/ahnwy/estacoda-v2
/Users/ahnwy/.bun/bin/bun run dev -- telegram status
/Users/ahnwy/.bun/bin/bun run dev -- gateway status
```

### Start gateway

```bash
cd /Users/ahnwy/estacoda-v2
/Users/ahnwy/.bun/bin/bun run dev -- gateway start --telegram
```

Restart the gateway after channel-formatting, progress, approval, or attachment-path changes. The running foreground process will not hot-reload those edits.

### Text checks

Use Telegram bot messages like:

- `Say hello as EstaCoda and tell me in one short paragraph what you can do.`
- `Read the files in the current workspace and tell me what kind of project this is.`

Evidence level:

- Telegram text replies: `live-proven`

### Attachment checks

Document:

- send a text-like document or PDF
- ask for summary/inspection

Image:

- send an image
- ask for image inspection
- this requires a real vision-capable route to be configured
- if no vision route is available, the expected fallback is metadata-only inspection rather than semantic description

Evidence level:

- Telegram document path: `live-proven`
- Telegram image path with Kimi: `live-proven`
- broader provider coverage: `implemented but not live-proven`

## What Smoke Currently Covers

At a high level:

- provider normalization and routing
- tool-call recovery and continuation logic
- provider tool-call extraction
- browser backend basics
- context expansion
- skill execution and package behavior
- session-stable skill visibility
- approvals and strict target-key matching
- Telegram progress compaction
- Telegram approvals and callbacks
- Telegram attachment flows
- Telegram formatter behavior
- vision-backed image path in smoke

## What Still Needs Live Validation

- Telegram image understanding on non-Kimi vision-capable providers
- multi-provider live route pass
- live memory-promotion behavior once implemented
- full operator pass after any major approval/channel changes

## Vision Route Sanity Check

Kimi has now been live-proven for Telegram image understanding. Smoke proves the general runtime path; other providers still need operator proof in the target environment.

## Environment Inputs

Typical env vars:

- `KIMI_API_KEY`
- `DEEPSEEK_API_KEY`
- `OPENROUTER_API_KEY`
- `OPENAI_API_KEY`
- `GOOGLE_API_KEY`
- `ANTHROPIC_API_KEY`
- `ESTACODA_TELEGRAM_BOT_TOKEN`

## Failure Capture Expectations

When a live run fails:

- save screenshots
- save logs
- record exact reproduction steps
- record expected vs actual result
- note whether the failure is:
  - compile-only
  - smoke-only
  - live-provider-only
  - Telegram-only
  - operator-UX-only
