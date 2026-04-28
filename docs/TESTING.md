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

## MCP Checks

```bash
cd /Users/ahnwy/estacoda-v2
/Users/ahnwy/.bun/bin/bun run dev -- mcp status
/Users/ahnwy/.bun/bin/bun run dev -- mcp reload
```

Interactive CLI:

```bash
cd /Users/ahnwy/estacoda-v2
/Users/ahnwy/.bun/bin/bun run dev
```

Inside the session:

- `/reload-mcp`
- `/workspace.trust.status`
- `/workspace.trust.grant`
- `/tools`
- `/skills`
- `Use the MCP filesystem tools to list the root of the current project and then read package.json.`

Evidence level:

- stdio MCP discovery/registration: `live-proven`
- HTTP MCP discovery/registration: `smoke-tested`
- MCP reload semantics: `live-proven`
- trusted stdio filesystem MCP execution: `live-proven`

## ACP Checks

```bash
cd /Users/ahnwy/estacoda-v2
/Users/ahnwy/.bun/bin/bun run dev -- acp manifest
```

Current evidence level:

- ACP stdio server foundation: `live-proven`
- ACP initialize/session/new/session/prompt/session/load/session/cancel flow: `live-proven`
- real editor/operator ACP integration: basic chat + editor-backed file reads are `live-proven`
- ACP permission handshake in JetBrains: `live-proven`
- ACP shell execution in JetBrains: `live-proven`
- richer terminal/process rendering and broader editor polish: still `implemented but not fully polished`

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

## Evaluation Substrate

Generate an evaluation run folder:

```bash
cd /Users/ahnwy/estacoda-v2
/Users/ahnwy/.bun/bin/bun run eval:substrate
```

Then use:

- [docs/EVALUATION.md](/Users/ahnwy/estacoda-v2/docs/EVALUATION.md)
- `evals/tasks/*.json`

For the live provider acceptance sweep, run:

```bash
cd /Users/ahnwy/estacoda-v2
/Users/ahnwy/.bun/bin/bun run provider:hardening
```

This must run from a shell where the provider credentials are already exported.

Current live result from the batch:

- Kimi: full pass `live-proven`
- OpenAI: full pass `live-proven`
- DeepSeek: full pass `live-proven`
- OpenRouter: runtime/tool path passes, exactness-sensitive checks still partial `live-proven`
- local/Ollama: not accepted in this environment `live-proven`

Evidence level:

- scaffold generation: `implemented but not live-proven`
- automated scoring/evolution: `intended but not implemented`

## CLI Session Checks

```bash
cd /Users/ahnwy/estacoda-v2
/Users/ahnwy/.bun/bin/bun run dev
```

Inside the interactive CLI:

- `/sessions`
- `/search <query>`
- `/switch <session-id>`
- `/reset`
- `/reload-mcp`
- exit and relaunch `bun run dev` to confirm the active workspace session resumes

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

### Session lifecycle checks

Check `gateway status` output for:

- `Session context: ...`
- `Group sessions per user: yes|no`
- `Thread sessions per user: yes|no`
- `Session reset policy: ...`

Useful chat checks:

- send a message, then `/new`, then another message
- restart the gateway, then send another message in the same chat
- confirm the chat stays on the fresh post-`/new` session rather than silently falling back
- change MCP config, then send `/reload-mcp` to confirm the new runtime snapshot sees the latest server state

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
- security approval mode persistence and behavior (`strict` / `adaptive` / `open`)
- adaptive assessor success, malformed-output fallback, and hard-floor bypass behavior
- Telegram progress compaction
- Telegram approvals and callbacks
- Telegram attachment flows
- Telegram formatter behavior
- vision-backed image path in smoke
- persisted channel session context and restart continuity
- Telegram DM/group/thread session-key policy
- gateway auto-reset session lifecycle policy
- stdio MCP discovery, registration, and reload semantics

## What Still Needs Live Validation

- Telegram image understanding on non-Kimi vision-capable providers
- OpenRouter exactness-sensitive task fidelity
- live memory-promotion behavior once implemented
- live MCP server use against real third-party servers, especially remote HTTP servers
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
