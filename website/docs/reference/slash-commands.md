---
title: Slash Commands
description: In-session slash and control command reference.
sidebar_position: 2
---

# Slash Commands

Slash commands are control surfaces available inside an active EstaCoda session. They inspect state, switch models, manage approvals, and manipulate sessions without leaving the conversation. Some slash commands have equivalent CLI forms; behavior differences are noted where they exist.

Not all slash commands are available in all contexts. Gateway remote sessions and CLI local sessions may expose different subsets. Commands that require a TTY or interactive picker degrade gracefully when run non-interactively.

---

## How to use

Type a slash command at the session prompt:

```bash
/status
/model set openai/gpt-4o
/approvals
/exit
```

Bare `/` opens the slash menu.

---

## Session control

### `/sessions` or `/session`

List recent sessions for the active profile.

**State touched:** None (read-only).

**Gateway difference:** Gateway `/sessions` lists recent sessions for the channel user.

### `/switch <session-id>`

Switch the current runtime to an existing session.

**State touched:** SQLite session DB (active session pointer).

**Failure modes:**
- Rejects if the session does not exist in the active profile.
- Rejects if `switchRuntime` is not available in the current context.

### `/reset` or `/new`

Start a fresh session and refresh the skill/config snapshot.

**State touched:** Creates a new session record; old session remains in the DB.

**Failure modes:** Rejects if `refreshRuntime` is not available.

### `/search <query>` or `/find <query>`

Search session history.

**State touched:** None (read-only).

### `/compact [topic]`

Compact the current in-session context through semantic session compression.

**State touched:** SQLite session DB (compaction event written).

**Behavior:** Non-rotating in the CLI implementation. It does not create or adopt a compacted child session. Gateway `/compact` has separate adoption logic and can preserve the parent transcript by switching the channel to a compacted child session.

**Failure modes:** If compaction fails, the original context is preserved.

---

## Model switching

### `/model`

Show the active model and provider without changing saved setup state.

**State touched:** None (read-only).

### `/model <provider>/<model>` or `/model set <provider>/<model>`

Set a session-scoped model override.

**State touched:** SQLite session DB (session model override).

**Behavior:**
- Session-scoped by default. The override persists with the session and is revalidated when a runtime is created.
- Stale or invalid overrides are ignored non-fatally; the runtime falls back to the configured primary route.
- Fallback routes and auxiliary routes are preserved by session switching.
- The picker only presents ready, runnable model choices. Credentialed routes missing required credentials are rejected with terminal setup guidance.

### `/model --global <provider>/<model>` or `/model set --global <provider>/<model>`

Persist the selected route as the profile primary model.

**State touched:**
- `~/.estacoda/profiles/<id>/config.json`
- SQLite session DB (clears session override)

**Behavior:** Requires a trusted workspace. Does not collect credentials inline. Rejected if workspace is not trusted.

### `/model clear`

Clear the session-scoped model override.

**State touched:** SQLite session DB.

**Failure modes:** `/model --global clear` is rejected. Clearing the profile primary route has no product-defined meaning.

---

## Trust and workspace

### `/trust`

Trust the current workspace for proactive local work.

**State touched:** `~/.estacoda/profiles/<id>/trust.json`.

### `/untrust`

Revoke workspace trust.

**State touched:** `~/.estacoda/profiles/<id>/trust.json`.

### `/workspace.trust.status`

Show whether the current workspace is trusted.

**State touched:** None (read-only).

---

## Security and approvals

### `/approvals`

Show current one-time, session, and persistent approvals.

**State touched:** None (read-only).

### `/revoke <approval-id>`

Revoke a persistent approval by ID.

**State touched:** Runtime approval store.

**Failure modes:** Rejects if `revokeApproval` is not available in the current runtime.

### `/security` or `/security debug`

Inspect recent security decisions. `debug` includes detailed audit data.

**State touched:** None (read-only).

### `/yolo`

Toggle session YOLO/open approval mode.

**State touched:** Runtime session state.

**Behavior:** Auto-approves eligible actions for the current session. Hard safety blocks still apply. Optimism is not a provider strategy.

---

## Information

### `/status`

Show runtime, model, context, trust, memory, and skill status.

**State touched:** None (read-only).

### `/tools [filter]`

Browse available tools grouped by toolset.

**State touched:** None (read-only).

### `/skills [filter]`

Browse commands and available skills.

**State touched:** None (read-only).

### `/memory`

Inspect and manage memory curation.

```bash
/memory mode [auto|review|manual]
/memory recent [limit]
/memory review [limit]
/memory populate
/memory edit
```

**State touched:**
- `~/.estacoda/profiles/<id>/config.json` for mode changes
- `USER.md` / `MEMORY.md` for successful populate writes
- `memory-curation.json` for curation history

**Behavior:** Uses the same shared operator path as `estacoda memory ...` and Telegram `/memory ...`. `auto` is the default mode. `populate` runs an explicit curation checkpoint for the active session. `review` shows pending-review records; it is not yet an approve/reject UI.

### `/resume` or `/continue`

Show the latest interrupted-turn resume note.

**State touched:** None (read-only).

---

## Cron

### `/cron <subcommand>`

Manage scheduled tasks from within a session.

```bash
/cron list
/cron add --schedule <schedule> --command "<prompt>"
/cron edit <job-id> [flags]
/cron show <job-id>
/cron history [job-id]
/cron run <job-id>
/cron pause <job-id>
/cron resume <job-id>
/cron remove <job-id>
/cron tick
```

**State touched:**
- `~/.estacoda/profiles/<id>/cron/jobs.json`
- `~/.estacoda/sessions.sqlite`

**Behavior:** Uses the active profile's CronStore. Manual tick runs due jobs immediately in isolated cron runtimes. Cron add/edit supports the same advanced controls as CLI cron, including skills, scripts, no-agent mode, context chaining, model/tool controls, and trusted contained `--workdir`.

See [Scheduled Jobs](../user-guide/cron.md) for details.

---

## Browser

### `/browser <subcommand>`

Manage local browser/CDP connection.

```bash
/browser status
/browser connect
/browser connect http://127.0.0.1:9222
/browser disconnect
```

**State touched:** Runtime browser state.

**Behavior:** This slash command is the in-session local CDP control surface. It can inspect status, configure a local CDP endpoint, refresh the runtime when available, or disconnect the browser backend for the active profile.

**Cloud browser note:** Browserbase setup and spend approval are CLI commands, not slash commands: use `estacoda browser setup --backend browserbase --cloud-provider browserbase --hybrid-routing`, `estacoda browser approve-cloud`, and `estacoda browser revoke-cloud`.

**Failure modes:** Degrades if no browser backend is configured. Browserbase spend approval is not handled through slash commands.

---

## Workflow

Requires SQLite session persistence. Available when Workflow is wired.

```bash
/workflow begin <objective>
/workflow begin --skill <skillName> <objective>
/workflow status [runId]
/workflow pause <runId> [reason]
/workflow resume <runId>
/workflow interrupt <runId> [reason]
/workflow cancel <runId> [reason]
/workflow steer <runId> <guidance>
/workflow approve <stepId>
/workflow reject <stepId> [reason]
/workflow retry <stepId>
/workflow skip <stepId> [reason]
/workflow checkpoint <runId> <name>
/workflow trace [runId] [limit]
/workflow summarize <runId>
/workflow activate <runId>
/workflow deactivate
```

If `runId` is omitted for `status` and `trace`, the active workflow run is used.

**State touched:** SQLite session DB (`workflow_events`, `workflow_steps`).

**Behavior:**
- `/workflow begin <objective>` creates a conservative one-step workflow run, starts it, and activates it in the current interactive session.
- `/workflow begin --skill <skillName> <objective>` resolves the named skill, compiles its playbook, converts it into a `WorkflowPlan`, creates the run, starts it, and activates it in the current interactive session.
- Successful begin prints `Created workflow: <runId>`, `Started workflow: <runId>`, and `Activated workflow: <runId>`.
- Plain `/workflow begin <objective>` records explicit provenance and does not use playbook conversion.
- `/workflow steer` records an unconsumed `OperatorEvent`. On the next adapter turn, guidance is prefixed to the user text in a structured block. Events are marked consumed and visible in `/workflow trace`.
- `/workflow activate` binds the current session to a workflow run. `/workflow deactivate` clears the binding.

**Failure modes:**
- Missing objectives return usage text.
- Unknown skills return a clear error.
- Steer rejected for terminal-state workflow runs.
- Retry requires `idempotent` or `safeToRetry` and `retryCount < maxRetries`.
- Skip requires the step not started and `allowSkipIfSkippable`.
- Workflow begin does not perform automatic workflow promotion, complex-request detection, Agent Evolution behavior, or automatic workflow creation from normal AgentLoop skill selection. `--skill` is explicit opt-in. `--use-selected-playbook` is not supported.

---

## Handoff

### `/handoff [surface]`

Generate a handoff code to share this session with a channel surface.

**State touched:** `~/.estacoda/profiles/<id>/gateway-state/handoff-codes.json`.

**Behavior:** Currently only `telegram` is supported. Codes expire after 10 minutes.

---

## System

### `/reload-mcp`

Reload MCP configuration and refresh MCP tools for this session.

**State touched:** Runtime tool registry (rebuilt from current config).

**Behavior:** Requires `refreshRuntime`. One-shot CLI commands see current MCP config automatically without manual reload.

### `/doctor`

Run a quick in-session health check.

**State touched:** None (read-only).

### `/clear` or `/cls`

Clear the terminal.

**State touched:** None.

### `/exit` or `/quit`

End the session.

**State touched:** None (ends the process).

---

## Approval prompt aliases

When a CLI tool execution reaches an active approval prompt, these answers are accepted:

- `once` — grant this exact action one time and retry
- `session` — grant matching actions for the current session and retry
- `always` — persist a workspace approval for matching actions and retry
- `deny`, `reject`, `no`, `n` — deny without retry

Slash-style aliases inside the same prompt:

- `/approve once`
- `/approve session`
- `/approve always`
- `/deny`

These normalize into the same choices as the bare answers. Invalid input such as `/approve banana` follows the existing invalid-answer guidance path.

---

## Related docs

- [CLI Commands](./cli-commands.md) — top-level CLI command families
- [Tools Reference](./tools-reference.md) — tool classes and risk boundaries
- [Security and Approvals](../user-guide/security-and-approvals.md) — approval modes and hard safety blocks
